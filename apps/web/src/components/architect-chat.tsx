'use client';

import { FormEvent, useState } from 'react';
import type { BuildingModelV1 } from '@aihd/domain';

type Msg = { id: string; role: string; content: string };

export function ArchitectChat(props: {
  projectId: string;
  conversationId: string;
  initialMessages: Msg[];
  selectedEntityId?: string | null;
  onModelUpdated: (model: BuildingModelV1, revision: number) => void;
  /** Defaults to legacy /api/chat. Workspace uses /api/design-agent for the new agent. */
  apiPath?: string;
}) {
  const [messages, setMessages] = useState(props.initialMessages);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || streaming) return;
    const userText = input.trim();
    setInput('');
    const userMsg = { id: crypto.randomUUID(), role: 'user', content: userText };
    setMessages((m) => [...m, userMsg]);
    setStreaming(true);

    const apiPath = props.apiPath ?? '/api/chat';
    const res = await fetch(apiPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: props.projectId,
        conversationId: props.conversationId,
        message: userText,
        selectedEntityId: props.selectedEntityId ?? null,
      }),
    });

    if (!res.ok || !res.body) {
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'Something went wrong talking to the architect. Check API keys and try again.',
        },
      ]);
      setStreaming(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let assistant = '';
    const assistantId = crypto.randomUUID();
    setMessages((m) => [...m, { id: assistantId, role: 'assistant', content: '' }]);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as {
            type: string;
            text?: string;
            model?: BuildingModelV1;
            revision?: number;
          };
          if ((parsed.type === 'text' || parsed.type === 'error') && parsed.text) {
            assistant += parsed.type === 'error' ? `I hit a problem: ${parsed.text}` : parsed.text;
            setMessages((m) =>
              m.map((msg) => (msg.id === assistantId ? { ...msg, content: assistant } : msg)),
            );
          }
          if (parsed.type === 'model' && parsed.model && parsed.revision != null) {
            props.onModelUpdated(parsed.model, parsed.revision);
          }
        } catch {
          // ignore partial JSON
        }
      }
    }

    setStreaming(false);
  }

  return (
    <div className="architect-chat">
      <div className="message-list">
        {messages.length === 0 ? (
          <div className="message muted">
            Tell me about the building you want — size, program, style, site constraints.
          </div>
        ) : null}
        {messages.map((m) => (
          <div key={m.id} className="message" data-role={m.role}>
            {m.content}
          </div>
        ))}
      </div>
      {props.selectedEntityId ? (
        <div className="selection-chip muted">
          Selected: {props.selectedEntityId}
        </div>
      ) : null}
      <form className="composer" onSubmit={onSubmit}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Describe a change…"
          disabled={streaming}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button className="btn btn-primary" type="submit" disabled={streaming}>
          Send
        </button>
      </form>
    </div>
  );
}
