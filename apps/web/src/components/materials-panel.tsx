'use client';

import type { BuildingModelV1, BuildingMutation } from '@aihd/domain';
import { Button, Input, Label } from '@aihd/ui';
import { useState } from 'react';

export function MaterialsPanel(props: {
  model: BuildingModelV1;
  onMutate: (batch: { mutations: BuildingMutation[]; reason?: string }) => Promise<void>;
}) {
  const [name, setName] = useState('Custom Siding');
  const [color, setColor] = useState('#C4B8A5');

  async function addMaterial() {
    const id = `mat-${crypto.randomUUID().slice(0, 8)}`;
    await props.onMutate({
      reason: 'Add material',
      mutations: [
        {
          op: 'upsertMaterial',
          material: {
            id,
            name,
            category: 'wall',
            color,
            roughness: 0.8,
            metalness: 0,
          },
        },
      ],
    });
  }

  async function assignToWalls(materialId: string) {
    const mutations: BuildingMutation[] = props.model.walls.map((wall) => ({
      op: 'upsertWall',
      wall: { ...wall, materialId },
    }));
    if (mutations.length === 0) return;
    await props.onMutate({ reason: 'Assign material to walls', mutations });
  }

  return (
    <div style={{ padding: '1rem', display: 'grid', gap: '1rem', maxWidth: 520 }}>
      <div>
        <h3 style={{ marginTop: 0 }}>Materials</h3>
        <p className="muted">Finish assignments drive interactive 3D and photoreal renders.</p>
      </div>
      <div className="stack">
        {props.model.materials.map((m) => (
          <div
            key={m.id}
            style={{
              display: 'flex',
              gap: '0.75rem',
              alignItems: 'center',
              padding: '0.65rem',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              background: '#fff',
            }}
          >
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                background: m.color,
                border: '1px solid #0002',
              }}
            />
            <div style={{ flex: 1 }}>
              <strong>{m.name}</strong>
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                {m.category}
              </div>
            </div>
            {m.category === 'wall' ? (
              <Button variant="secondary" onClick={() => assignToWalls(m.id)}>
                Apply to walls
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      <div className="panel">
        <div className="panel-body stack">
          <div>
            <Label htmlFor="mat-name">New material</Label>
            <Input id="mat-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="mat-color">Color</Label>
            <Input
              id="mat-color"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </div>
          <Button onClick={addMaterial}>Add material</Button>
        </div>
      </div>
    </div>
  );
}
