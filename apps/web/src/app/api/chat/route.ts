import { NextResponse } from 'next/server';
import type { CoreMessage } from 'ai';
import { runDesignTurn } from '@aihd/ai';
import { ChatMessageSchema } from '@aihd/api-client';
import {
  commitRevision,
  getLatestRevision,
  parseModel,
  requireUser,
  restoreRevision,
} from '@/lib/projects';
import { inngest, events } from '@/lib/inngest/client';

function hasKey(value?: string) {
  return Boolean(value && value.trim());
}

export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireUser();
    const body = ChatMessageSchema.parse(await request.json());

    let conversationId = body.conversationId;
    if (!conversationId) {
      const { data } = await supabase
        .from('conversations')
        .insert({ project_id: body.projectId, title: 'Design conversation' })
        .select('id')
        .single();
      conversationId = data?.id;
    }
    if (!conversationId) {
      return NextResponse.json({ error: 'Missing conversation' }, { status: 400 });
    }

    await supabase.from('messages').insert({
      conversation_id: conversationId,
      role: 'user',
      content: body.message,
    });

    const latest = await getLatestRevision(body.projectId);
    if (!latest) {
      return NextResponse.json({ error: 'No building revision' }, { status: 404 });
    }

    let currentModel = parseModel(latest.model);
    let currentRevision = latest.revision;
    const turnBaselineRevision = latest.revision;

    const { data: history } = await supabase
      .from('messages')
      .select('role, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(40);

    const messages: CoreMessage[] = (history ?? [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    if (!hasKey(process.env.ANTHROPIC_API_KEY) && !hasKey(process.env.OPENAI_API_KEY)) {
      const fallback =
        'I can help design once an AI provider key is configured. Meanwhile, edit the floor plan manually.';
      await supabase.from('messages').insert({
        conversation_id: conversationId,
        role: 'assistant',
        content: fallback,
      });
      return sseResponse([{ type: 'text', text: fallback }]);
    }

    const turn = runDesignTurn({
      messages,
      model: currentModel,
      selectedEntityId: body.selectedEntityId ?? null,
      turnBaselineRevision,
      projectId: body.projectId,
      userMessage: body.message,
      onModelDraft: (model) => {
        // Live preview without writing a DB revision per tool.
        currentModel = model;
      },
      commitModel: async (model, reason) => {
        const revision = await commitRevision({
          projectId: body.projectId,
          model,
          userId: user.id,
          reason,
        });
        currentModel = model;
        currentRevision = revision.revision;
      },
      undoLastChange: async () => {
        try {
          const fromRevision =
            currentRevision > turnBaselineRevision
              ? turnBaselineRevision
              : currentRevision - 1;
          const row = await restoreRevision({
            projectId: body.projectId,
            userId: user.id,
            fromRevision,
            reason: 'Undo AI design turn',
          });
          currentModel = parseModel(row.model);
          currentRevision = row.revision;
          return { model: currentModel, revision: currentRevision };
        } catch {
          return null;
        }
      },
      enqueueJob: async (type, payload) => {
        const { data: job } = await supabase
          .from('jobs')
          .insert({
            project_id: body.projectId,
            type: type === 'render' ? 'render' : 'normalize',
            status: 'queued',
            payload: payload ?? {},
            created_by: user.id,
          })
          .select('id')
          .single();
        if (job) {
          try {
            await inngest.send({
              name: type === 'render' ? events.renderRequested : events.normalizeRequested,
              data: { jobId: job.id, projectId: body.projectId, payload },
            });
          } catch {
            // Job row still exists even if the worker bus is not configured.
          }
        }
        return job?.id ?? 'unknown';
      },
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (payload: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };

        try {
          let assistantText = '';
          for await (const event of turn.result.fullStream) {
            if (event.type === 'text-delta') {
              assistantText += event.textDelta;
              send({ type: 'text', text: event.textDelta });
            } else if (event.type === 'step-finish') {
              // After each agent step, push in-memory draft to the client (no DB revision yet).
              if (turn.isDirty()) {
                send({
                  type: 'model',
                  model: turn.getModel(),
                  revision: currentRevision,
                  draft: true,
                });
              }
            } else if (event.type === 'error') {
              const message =
                event.error instanceof Error
                  ? event.error.message
                  : 'The AI provider returned an error.';
              turn.operation.log('provider_error', { message });
              send({ type: 'error', text: message });
            }
          }

          // One atomic revision for the entire agent operation.
          try {
            await turn.flush();
            turn.operation.complete(currentRevision);
          } catch (flushError) {
            const message =
              flushError instanceof Error
                ? flushError.message
                : 'Failed to save design revision.';
            turn.operation.fail(message);
            send({ type: 'error', text: message });
          }

          currentModel = turn.getModel();
          send({
            type: 'model',
            model: currentModel,
            revision: currentRevision,
          });

          await supabase.from('messages').insert({
            conversation_id: conversationId,
            role: 'assistant',
            content: assistantText || 'Updated the design.',
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'The architect chat failed unexpectedly.';
          turn.operation.fail(message);
          send({ type: 'error', text: message });
        } finally {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

function sseResponse(eventsToSend: unknown[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const event of eventsToSend) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
