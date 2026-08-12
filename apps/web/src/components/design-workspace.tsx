'use client';

import { useMemo, useState } from 'react';
import type { BuildingModelV1 } from '@aihd/domain';
import { ArchitectChat } from '@/components/architect-chat';
import { FloorPlanView } from '@/components/floor-plan-view';
import { Scene3DView } from '@/components/scene-3d-view';
import { DocumentsPanel } from '@/components/documents-panel';
import { MaterialsPanel } from '@/components/materials-panel';
import { Button } from '@aihd/ui';

type Tab = 'plan' | '3d' | 'docs' | 'materials';

export function DesignWorkspace(props: {
  projectId: string;
  projectName: string;
  conversationId: string;
  initialModel: BuildingModelV1;
  initialRevision: number;
  initialMessages: Array<{ id: string; role: string; content: string }>;
}) {
  const [model, setModel] = useState(props.initialModel);
  const [revision, setRevision] = useState(props.initialRevision);
  const [tab, setTab] = useState<Tab>('plan');
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [redoModel, setRedoModel] = useState<{
    model: BuildingModelV1;
    revision: number;
  } | null>(null);

  const tabs = useMemo(
    () =>
      [
        { id: 'plan' as const, label: 'Floor plan' },
        { id: '3d' as const, label: '3D' },
        { id: 'materials' as const, label: 'Materials' },
        { id: 'docs' as const, label: 'Documents' },
      ] as const,
    [],
  );

  async function applyBatch(batch: {
    mutations: Parameters<typeof import('@aihd/domain').applyAndValidate>[1];
    reason?: string;
  }) {
    const res = await fetch(`/api/projects/${props.projectId}/mutations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { model: BuildingModelV1; revision: number };
    setRedoModel(null);
    setModel(data.model);
    setRevision(data.revision);
  }

  async function requestRender() {
    await fetch(`/api/projects/${props.projectId}/render`, { method: 'POST' });
  }

  async function undo() {
    if (undoBusy || revision <= 1) return;
    setUndoBusy(true);
    try {
      setRedoModel({ model, revision });
      const res = await fetch(`/api/projects/${props.projectId}/revisions/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Undo' }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { model: BuildingModelV1; revision: number };
      setModel(data.model);
      setRevision(data.revision);
    } finally {
      setUndoBusy(false);
    }
  }

  async function redo() {
    if (!redoModel || undoBusy) return;
    setUndoBusy(true);
    try {
      await applyBatch({
        reason: 'Redo',
        mutations: [{ op: 'replaceModel', model: redoModel.model }],
      });
      setRedoModel(null);
    } finally {
      setUndoBusy(false);
    }
  }

  return (
    <div className="workspace">
      <aside className="chat-pane">
        <div className="chat-pane-header">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.5rem',
            }}
          >
            <div className="muted" style={{ fontSize: '0.8rem' }}>
              Revision {revision}
            </div>
            <div className="revision-actions">
              <button
                type="button"
                className="viewport-control-btn"
                disabled={undoBusy || revision <= 1}
                onClick={undo}
                title="Undo last change"
              >
                Undo
              </button>
              <button
                type="button"
                className="viewport-control-btn"
                disabled={undoBusy || !redoModel}
                onClick={redo}
                title="Redo"
              >
                Redo
              </button>
            </div>
          </div>
          <h2 style={{ margin: '0.15rem 0 0', fontSize: '1.25rem' }}>{props.projectName}</h2>
        </div>
        <ArchitectChat
          projectId={props.projectId}
          conversationId={props.conversationId}
          initialMessages={props.initialMessages}
          selectedEntityId={selectedEntityId}
          apiPath="/api/design-agent"
          onModelUpdated={(next, nextRevision) => {
            // Apply committed revision from agent SSE — read-only client update (no re-commit).
            setRedoModel(null);
            setModel(next);
            setRevision(nextRevision);
          }}
        />
      </aside>
      <section className="view-pane">
        <div className="view-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className="view-tab"
              data-active={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <div style={{ marginLeft: 'auto' }}>
            <Button variant="secondary" onClick={requestRender}>
              Queue render
            </Button>
          </div>
        </div>
        <div className="view-canvas">
          {tab === 'plan' ? (
            <FloorPlanView
              model={model}
              selectedEntityId={selectedEntityId}
              onSelect={setSelectedEntityId}
              onMutate={applyBatch}
            />
          ) : null}
          {tab === '3d' ? (
            <Scene3DView
              model={model}
              selectedEntityId={selectedEntityId}
              onSelect={setSelectedEntityId}
              onMutate={applyBatch}
            />
          ) : null}
          {tab === 'materials' ? (
            <MaterialsPanel model={model} onMutate={applyBatch} />
          ) : null}
          {tab === 'docs' ? <DocumentsPanel model={model} projectId={props.projectId} /> : null}
        </div>
      </section>
    </div>
  );
}
