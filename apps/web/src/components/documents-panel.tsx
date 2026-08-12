'use client';

import { useMemo, useState } from 'react';
import type { BuildingModelV1 } from '@aihd/domain';
import { buildConstructionDocuments, exportDxfLite, runAdvisoryChecks } from '@aihd/domain';
import { Button, Badge } from '@aihd/ui';

export function DocumentsPanel(props: { model: BuildingModelV1; projectId: string }) {
  const docs = useMemo(() => buildConstructionDocuments(props.model), [props.model]);
  const advisories = useMemo(() => runAdvisoryChecks(props.model), [props.model]);
  const [busy, setBusy] = useState(false);

  async function exportDoc(kind: 'pdf' | 'dxf') {
    setBusy(true);
    await fetch(`/api/projects/${props.projectId}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    });
    setBusy(false);
  }

  function downloadDxf() {
    const dxf = exportDxfLite(props.model);
    const blob = new Blob([dxf], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${props.model.meta.name.replace(/\s+/g, '-').toLowerCase()}.dxf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ padding: '1rem', overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <Button variant="secondary" disabled={busy} onClick={() => exportDoc('pdf')}>
          Queue PDF set
        </Button>
        <Button variant="secondary" onClick={downloadDxf}>
          Download DXF
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => exportDoc('dxf')}>
          Queue DXF export
        </Button>
      </div>

      <h3>Advisory checks</h3>
      <div className="stack" style={{ marginBottom: '1.25rem' }}>
        {advisories.map((a) => (
          <div key={a.id} className="message">
            <Badge>{a.severity}</Badge> {a.message}
          </div>
        ))}
      </div>

      <h3>Sheets</h3>
      <div className="stack">
        {docs.sheets.map((sheet) => (
          <article key={sheet.id} className="panel">
            <header className="panel-header">
              {sheet.id} — {sheet.title}
            </header>
            <div className="panel-body">
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' }}>
                {sheet.markdown}
              </pre>
              {sheet.svg ? (
                <div
                  style={{ marginTop: '0.75rem', border: '1px solid var(--color-border)' }}
                  dangerouslySetInnerHTML={{ __html: sheet.svg }}
                />
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
