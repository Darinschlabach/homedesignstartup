import type { BuildingModelV1, Vec2, Wall } from '../building-model';

export interface FloorPlanPath {
  id: string;
  kind: 'wall' | 'space' | 'opening' | 'slab';
  d: string;
  label?: string;
  meta?: Record<string, string | number>;
}

export interface FloorPlanView {
  levelId: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  paths: FloorPlanPath[];
  dimensions: Array<{
    id: string;
    from: Vec2;
    to: Vec2;
    label: string;
  }>;
}

function wallLength(wall: Wall): number {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  return Math.hypot(dx, dy);
}

function polygonToPath(points: Vec2[]): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  return `M ${first!.x} ${first!.y} ${rest.map((p) => `L ${p.x} ${p.y}`).join(' ')} Z`;
}

function linePath(a: Vec2, b: Vec2): string {
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}

function expandBounds(
  bounds: FloorPlanView['bounds'],
  points: Vec2[],
): FloorPlanView['bounds'] {
  let { minX, minY, maxX, maxY } = bounds;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

export function buildFloorPlanView(model: BuildingModelV1, levelId?: string): FloorPlanView {
  const level = model.levels.find((l) => l.id === levelId) ?? model.levels[0]!;
  let bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const paths: FloorPlanPath[] = [];
  const dimensions: FloorPlanView['dimensions'] = [];

  for (const slab of model.slabs.filter((s) => s.levelId === level.id)) {
    bounds = expandBounds(bounds, slab.polygon);
    paths.push({ id: slab.id, kind: 'slab', d: polygonToPath(slab.polygon) });
  }

  for (const space of model.spaces.filter((s) => s.levelId === level.id)) {
    bounds = expandBounds(bounds, space.polygon);
    paths.push({
      id: space.id,
      kind: 'space',
      d: polygonToPath(space.polygon),
      label: space.name,
    });
  }

  for (const wall of model.walls.filter((w) => w.levelId === level.id)) {
    bounds = expandBounds(bounds, [wall.start, wall.end]);
    paths.push({
      id: wall.id,
      kind: 'wall',
      d: linePath(wall.start, wall.end),
      meta: { thickness: wall.thickness, length: wallLength(wall) },
    });
    dimensions.push({
      id: `dim-${wall.id}`,
      from: wall.start,
      to: wall.end,
      label: `${wallLength(wall).toFixed(1)}'`,
    });
  }

  for (const opening of model.openings) {
    const wall = model.walls.find((w) => w.id === opening.wallId);
    if (!wall || wall.levelId !== level.id) continue;
    const x = wall.start.x + (wall.end.x - wall.start.x) * opening.t;
    const y = wall.start.y + (wall.end.y - wall.start.y) * opening.t;
    const marker: Vec2 = { x, y };
    bounds = expandBounds(bounds, [marker]);
    paths.push({
      id: opening.id,
      kind: 'opening',
      d: `M ${x - opening.width / 4} ${y} L ${x + opening.width / 4} ${y}`,
      label: opening.kind,
      meta: { width: opening.width, height: opening.height },
    });
  }

  const pad = 2;
  return {
    levelId: level.id,
    bounds: {
      minX: bounds.minX - pad,
      minY: bounds.minY - pad,
      maxX: bounds.maxX + pad,
      maxY: bounds.maxY + pad,
    },
    paths,
    dimensions,
  };
}

export function floorPlanToSvg(view: FloorPlanView, options?: { width?: number }): string {
  const width = options?.width ?? 800;
  const { minX, minY, maxX, maxY } = view.bounds;
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  const height = Math.round((width * bh) / bw);

  const wallPaths = view.paths
    .filter((p) => p.kind === 'wall')
    .map(
      (p) =>
        `<path data-id="${p.id}" d="${p.d}" fill="none" stroke="#1a1f1c" stroke-width="0.35" stroke-linecap="square"/>`,
    )
    .join('\n');

  const spacePaths = view.paths
    .filter((p) => p.kind === 'space')
    .map(
      (p) =>
        `<path data-id="${p.id}" d="${p.d}" fill="#e4efe9" fill-opacity="0.45" stroke="none"/>`,
    )
    .join('\n');

  const openingPaths = view.paths
    .filter((p) => p.kind === 'opening')
    .map(
      (p) =>
        `<path data-id="${p.id}" d="${p.d}" fill="none" stroke="#2f5d50" stroke-width="0.5"/>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${bw} ${bh}">
  <g transform="scale(1,-1) translate(0, ${-(minY + maxY)})">
    ${spacePaths}
    ${wallPaths}
    ${openingPaths}
  </g>
</svg>`;
}
