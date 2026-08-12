import {
  extractShellFromModel,
  isShellWallId,
  type BuildingModelV1,
  type Wall,
  type Space,
} from "@aihd/domain";

/** Agent-facing plan point: x = width axis, z = depth (maps to domain Vec2.y). */
export type PlanPointInput = {
  x: number;
  z?: number | null;
  y?: number | null;
};

export function planPointToDomain(
  point: PlanPointInput,
): { ok: true; point: { x: number; y: number } } | { ok: false; error: string; code: string } {
  const depth = point.z ?? point.y;
  if (depth == null || !Number.isFinite(point.x) || !Number.isFinite(depth)) {
    return {
      ok: false,
      error:
        "Plan point requires x and z (preferred) or y (domain plan-depth alias).",
      code: "INVALID_POINT",
    };
  }
  return { ok: true, point: { x: point.x, y: depth } };
}

export function generateWallId(): string {
  return `wall-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function generateSpaceId(): string {
  return `space-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function summarizeWall(
  wall: Wall,
  model?: BuildingModelV1,
): Record<string, unknown> {
  const length =
    Math.round(
      Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) * 100,
    ) / 100;
  return {
    id: wall.id,
    levelId: wall.levelId,
    kind: isShellWallId(wall.id) ? "exterior" : "interior",
    shellWall: isShellWallId(wall.id),
    start: { x: wall.start.x, z: wall.start.y },
    end: { x: wall.end.x, z: wall.end.y },
    length,
    thickness: wall.thickness,
    height: wall.height ?? null,
    materialId: wall.materialId ?? null,
    hostedOpeningCount: model
      ? model.openings.filter((o) => o.wallId === wall.id).length
      : null,
  };
}

export function summarizeSpace(space: Space): Record<string, unknown> {
  let area = 0;
  for (let i = 0; i < space.polygon.length; i++) {
    const a = space.polygon[i]!;
    const b = space.polygon[(i + 1) % space.polygon.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  area = Math.abs(area) / 2;
  return {
    id: space.id,
    name: space.name,
    levelId: space.levelId,
    tags: space.tags,
    polygon: space.polygon.map((p) => ({ x: p.x, z: p.y })),
    areaSqFt: Math.round(area * 10) / 10,
    footprintSpace: space.id === "space-1",
  };
}

export function assertWallInsideFootprint(
  model: BuildingModelV1,
  start: { x: number; y: number },
  end: { x: number; y: number },
): string | null {
  const shell = extractShellFromModel(model);
  if (!shell) return null;
  const hw = shell.width / 2 + 0.05;
  const hd = shell.depth / 2 + 0.05;
  for (const p of [start, end]) {
    if (Math.abs(p.x) > hw || Math.abs(p.y) > hd) {
      return `Wall endpoint (${p.x}, ${p.y}) is outside the building footprint (±${shell.width / 2} × ±${shell.depth / 2}).`;
    }
  }
  return null;
}
