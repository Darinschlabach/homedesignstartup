'use client';

import type { ViewPreset } from './camera-state';

const PRESETS: { id: ViewPreset; label: string }[] = [
  { id: 'perspective', label: 'Perspective' },
  { id: 'front', label: 'Front' },
  { id: 'rear', label: 'Rear' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
  { id: 'top', label: 'Top' },
];

export function ViewportControls({
  active,
  onPreset,
  onReset,
}: {
  active: ViewPreset;
  onPreset: (preset: ViewPreset) => void;
  onReset: () => void;
}) {
  return (
    <div className="viewport-controls" role="toolbar" aria-label="View controls">
      {PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          className="viewport-control-btn"
          data-active={active === p.id}
          onClick={() => onPreset(p.id)}
        >
          {p.label}
        </button>
      ))}
      <button type="button" className="viewport-control-btn viewport-control-reset" onClick={onReset}>
        Reset
      </button>
    </div>
  );
}
