'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input } from '@aihd/ui';

export function CreateProjectForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [buildingType, setBuildingType] = useState<'home' | 'barn' | 'shop'>('home');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, buildingType, workspaceId }),
    });
    setLoading(false);
    if (!res.ok) return;
    const data = (await res.json()) as { id: string };
    router.push(`/app/projects/${data.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      <Input
        placeholder="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        style={{ width: 180 }}
      />
      <select
        className="input"
        value={buildingType}
        onChange={(e) => setBuildingType(e.target.value as 'home' | 'barn' | 'shop')}
        style={{ width: 120 }}
      >
        <option value="home">Home</option>
        <option value="barn">Barn</option>
        <option value="shop">Shop</option>
      </select>
      <Button type="submit" disabled={loading}>
        {loading ? 'Creating…' : 'New project'}
      </Button>
    </form>
  );
}
