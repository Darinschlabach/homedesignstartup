'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label } from '@aihd/ui';

export function NewProjectButton({
  workspaceId,
  withIcon = false,
}: {
  workspaceId?: string | null;
  withIcon?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [buildingType, setBuildingType] = useState<'home' | 'barn' | 'shop'>('home');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!workspaceId) {
      setError('No workspace available yet. Refresh and try again.');
      return;
    }
    setLoading(true);
    setError(null);
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, buildingType, workspaceId }),
    });
    setLoading(false);
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(payload?.error || 'Could not create project.');
      return;
    }
    const data = (await res.json()) as { id: string };
    setOpen(false);
    router.push(`/app/projects/${data.id}`);
    router.refresh();
  }

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} disabled={!workspaceId}>
        {withIcon ? (
          <span aria-hidden style={{ fontSize: '1.15rem', lineHeight: 1, marginRight: 2 }}>
            +
          </span>
        ) : null}
        New project
      </Button>
      {open ? (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="modal-card"
            role="dialog"
            aria-labelledby="new-project-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="new-project-title">New project</h2>
            <form className="stack" onSubmit={onSubmit}>
              <div>
                <Label htmlFor="project-name">Project name</Label>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Modern Farmhouse"
                  required
                />
              </div>
              <div>
                <Label htmlFor="building-type">Building type</Label>
                <select
                  id="building-type"
                  className="input"
                  value={buildingType}
                  onChange={(e) => setBuildingType(e.target.value as 'home' | 'barn' | 'shop')}
                >
                  <option value="home">Home</option>
                  <option value="barn">Barn</option>
                  <option value="shop">Shop</option>
                </select>
              </div>
              {error ? <p className="auth-error">{error}</p> : null}
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={loading}>
                  {loading ? 'Creating…' : 'Create'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
