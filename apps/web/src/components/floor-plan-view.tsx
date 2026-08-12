'use client';

import { useMemo, useRef, useState } from 'react';
import type { BuildingModelV1, BuildingMutation } from '@aihd/domain';
import { buildFloorPlanView } from '@aihd/domain';

export function FloorPlanView(props: {
  model: BuildingModelV1;
  selectedEntityId: string | null;
  onSelect: (id: string | null) => void;
  onMutate: (batch: { mutations: BuildingMutation[]; reason?: string }) => Promise<void>;
}) {
  const view = useMemo(() => buildFloorPlanView(props.model), [props.model]);
  const { minX, minY, maxX, maxY } = view.bounds;
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{
    wallId: string;
    endpoint: 'start' | 'end';
  } | null>(null);

  function clientToWorld(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const local = pt.matrixTransform(ctm.inverse());
    // account for y-flip group
    return { x: local.x, y: minY + maxY - local.y };
  }

  async function onPointerUp(e: React.PointerEvent) {
    if (!drag) return;
    const point = clientToWorld(e.clientX, e.clientY);
    const wallId = drag.wallId;
    const endpoint = drag.endpoint;
    setDrag(null);
    await props.onMutate({
      reason: 'Manual wall edit',
      mutations: [{ op: 'moveWallEndpoint', wallId, endpoint, point }],
    });
  }

  return (
    <svg
      ref={svgRef}
      width="100%"
      height="100%"
      viewBox={`${minX} ${minY} ${width} ${height}`}
      style={{ touchAction: 'none' }}
      onPointerUp={onPointerUp}
    >
      <g transform={`scale(1,-1) translate(0, ${-(minY + maxY)})`}>
        {view.paths
          .filter((p) => p.kind === 'space')
          .map((p) => (
            <path key={p.id} d={p.d} fill="#e4efe9" fillOpacity={0.5} stroke="none" />
          ))}
        {view.paths
          .filter((p) => p.kind === 'wall')
          .map((p) => {
            const wall = props.model.walls.find((w) => w.id === p.id);
            if (!wall) return null;
            const selected = props.selectedEntityId === p.id;
            return (
              <g key={p.id}>
                <path
                  d={p.d}
                  fill="none"
                  stroke={selected ? '#2f5d50' : '#1a1f1c'}
                  strokeWidth={selected ? 0.55 : 0.35}
                  strokeLinecap="square"
                  onClick={() => props.onSelect(p.id)}
                  style={{ cursor: 'pointer' }}
                />
                <circle
                  cx={wall.start.x}
                  cy={wall.start.y}
                  r={0.55}
                  fill="#2f5d50"
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setDrag({ wallId: wall.id, endpoint: 'start' });
                    props.onSelect(wall.id);
                  }}
                />
                <circle
                  cx={wall.end.x}
                  cy={wall.end.y}
                  r={0.55}
                  fill="#2f5d50"
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setDrag({ wallId: wall.id, endpoint: 'end' });
                    props.onSelect(wall.id);
                  }}
                />
              </g>
            );
          })}
        {view.paths
          .filter((p) => p.kind === 'opening')
          .map((p) => (
            <path
              key={p.id}
              d={p.d}
              fill="none"
              stroke="#2f5d50"
              strokeWidth={0.5}
              onClick={() => props.onSelect(p.id)}
            />
          ))}
      </g>
    </svg>
  );
}
