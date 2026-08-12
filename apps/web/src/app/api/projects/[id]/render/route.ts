import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/projects';
import { inngest, events } from '@/lib/inngest/client';

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: projectId } = await context.params;
    const { supabase, user } = await requireUser();

    const { data: job, error } = await supabase
      .from('jobs')
      .insert({
        project_id: projectId,
        type: 'render',
        status: 'queued',
        payload: { camera: 'corner' },
        created_by: user.id,
      })
      .select('*')
      .single();

    if (error) throw error;

    await inngest.send({
      name: events.renderRequested,
      data: { jobId: job.id, projectId, payload: job.payload },
    });

    return NextResponse.json(job, { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
