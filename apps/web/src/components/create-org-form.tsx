'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Panel } from '@aihd/ui';

export function CreateOrgForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, slug }),
    });
    if (!res.ok) {
      setError(await res.text());
      return;
    }
    router.refresh();
  }

  return (
    <Panel title="Create organization">
      <form className="stack" onSubmit={onSubmit}>
        <div>
          <Label htmlFor="org-name">Name</Label>
          <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="org-slug">Slug</Label>
          <Input
            id="org-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            pattern="[a-z0-9-]+"
            required
          />
        </div>
        {error ? <p style={{ color: 'var(--color-danger)' }}>{error}</p> : null}
        <Button type="submit">Create</Button>
      </form>
    </Panel>
  );
}
