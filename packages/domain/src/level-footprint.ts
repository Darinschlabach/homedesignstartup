/**
 * Per-level footprint geometry (axis-aligned rectangles).
 *
 * footprintSource:'shell'  → BuildingShell rectangle (shared)
 * footprintSource:'custom' → Level.footprint (durable, not overwritten by shell sync)
 */
import type { BuildingModelV1, Level, Vec2, Wall } from './building-model';
import { LevelSchema } from './building-model';
import {
  LevelFootprintRectSchema,
  type LevelFootprintRect,
} from './level-footprint-schema';
import {
  findLevel,
  levelTopElevation,
  normalizeLevels,
  primaryLevel,
} from './levels';
import {
  extractShellFromModel,
  isShellWallId,
  shellWallIdForLevel,
  type BuildingShell,
  type ShellWallFace,
} from './shell';

export {
  LevelFootprintRectSchema,
  type LevelFootprintRect,
} from './level-footprint-schema';

export type LevelFootprint = LevelFootprintRect;

export class LevelFootprintError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LevelFootprintError';
  }
}

export function footprintCornersFromRect(fp: LevelFootprintRect): Vec2[] {
  const hw = fp.width / 2;
  const hd = fp.depth / 2;
  const cx = fp.center.x;
  const cy = fp.center.y;
  return [
    { x: cx - hw, y: cy - hd },
    { x: cx + hw, y: cy - hd },
    { x: cx + hw, y: cy + hd },
    { x: cx - hw, y: cy + hd },
  ];
}

export function footprintBounds(fp: LevelFootprintRect) {
  const hw = fp.width / 2;
  const hd = fp.depth / 2;
  return {
    minX: fp.center.x - hw,
    maxX: fp.center.x + hw,
    minY: fp.center.y - hd,
    maxY: fp.center.y + hd,
  };
}

/** Shell rectangle centered at origin. */
export function shellAsFootprint(shell: BuildingShell): LevelFootprintRect {
  return LevelFootprintRectSchema.parse({
    kind: 'rect',
    center: { x: 0, y: 0 },
    width: shell.width,
    depth: shell.depth,
  });
}

/** Resolve the durable plan footprint for a level. */
export function resolveLevelFootprint(
  model: BuildingModelV1,
  levelId: string,
): LevelFootprintRect | null {
  const level = findLevel(model, levelId);
  if (!level) return null;
  if (level.footprintSource === 'custom' && level.footprint) {
    return LevelFootprintRectSchema.parse(level.footprint);
  }
  const shell = extractShellFromModel(model);
  if (!shell) return null;
  return shellAsFootprint(shell);
}

export function pointInFootprint(
  point: Vec2,
  fp: LevelFootprintRect,
  eps = 1e-6,
): boolean {
  const b = footprintBounds(fp);
  return (
    point.x >= b.minX - eps &&
    point.x <= b.maxX + eps &&
    point.y >= b.minY - eps &&
    point.y <= b.maxY + eps
  );
}

/** True when inner is entirely inside outer (axis-aligned). */
export function footprintContainsFootprint(
  outer: LevelFootprintRect,
  inner: LevelFootprintRect,
  eps = 1e-6,
): boolean {
  const o = footprintBounds(outer);
  const i = footprintBounds(inner);
  return (
    i.minX >= o.minX - eps &&
    i.maxX <= o.maxX + eps &&
    i.minY >= o.minY - eps &&
    i.maxY <= o.maxY + eps
  );
}

/**
 * Exposed axis-aligned regions of a lower footprint not covered by an upper one.
 * First-slice: up to 4 residual rectangles (front/rear/left/right strips).
 */
export function exposedFootprintRegions(
  lower: LevelFootprintRect,
  upper: LevelFootprintRect,
): LevelFootprintRect[] {
  if (!footprintContainsFootprint(lower, upper)) {
    return [lower];
  }
  const L = footprintBounds(lower);
  const U = footprintBounds(upper);
  const regions: LevelFootprintRect[] = [];

  if (U.minY - L.minY > 1e-4) {
    const depth = U.minY - L.minY;
    regions.push(
      LevelFootprintRectSchema.parse({
        kind: 'rect',
        center: { x: (L.minX + L.maxX) / 2, y: L.minY + depth / 2 },
        width: L.maxX - L.minX,
        depth,
      }),
    );
  }
  if (L.maxY - U.maxY > 1e-4) {
    const depth = L.maxY - U.maxY;
    regions.push(
      LevelFootprintRectSchema.parse({
        kind: 'rect',
        center: { x: (L.minX + L.maxX) / 2, y: L.maxY - depth / 2 },
        width: L.maxX - L.minX,
        depth,
      }),
    );
  }
  if (U.minX - L.minX > 1e-4) {
    const width = U.minX - L.minX;
    regions.push(
      LevelFootprintRectSchema.parse({
        kind: 'rect',
        center: { x: L.minX + width / 2, y: (U.minY + U.maxY) / 2 },
        width,
        depth: U.maxY - U.minY,
      }),
    );
  }
  if (L.maxX - U.maxX > 1e-4) {
    const width = L.maxX - U.maxX;
    regions.push(
      LevelFootprintRectSchema.parse({
        kind: 'rect',
        center: { x: L.maxX - width / 2, y: (U.minY + U.maxY) / 2 },
        width,
        depth: U.maxY - U.minY,
      }),
    );
  }

  return regions;
}

export function customFootprintWallSegments(
  footprint: LevelFootprintRect,
  levelId: string,
  options: {
    primaryLevelId: string;
    wallHeight: number;
    wallThickness: number;
    materialId?: string;
  },
): Wall[] {
  const b = footprintBounds(footprint);
  const t = options.wallThickness;
  const h = options.wallHeight;
  const materialId = options.materialId ?? 'mat-wall';
  const idFor = (face: ShellWallFace) =>
    shellWallIdForLevel(face, levelId, options.primaryLevelId);

  return [
    {
      id: idFor('front'),
      levelId,
      start: { x: b.minX, y: b.minY },
      end: { x: b.maxX, y: b.minY },
      thickness: t,
      height: h,
      materialId,
    },
    {
      id: idFor('right'),
      levelId,
      start: { x: b.maxX, y: b.minY },
      end: { x: b.maxX, y: b.maxY },
      thickness: t,
      height: h,
      materialId,
    },
    {
      id: idFor('rear'),
      levelId,
      start: { x: b.maxX, y: b.maxY },
      end: { x: b.minX, y: b.maxY },
      thickness: t,
      height: h,
      materialId,
    },
    {
      id: idFor('left'),
      levelId,
      start: { x: b.minX, y: b.maxY },
      end: { x: b.minX, y: b.minY },
      thickness: t,
      height: h,
      materialId,
    },
  ];
}

export type ExposedLowerRoofReport = {
  lowerLevelId: string;
  upperLevelId: string;
  regions: LevelFootprintRect[];
  note: string;
};

/**
 * Detect Level N regions not covered by a higher custom footprint that would
 * normally need a lower roof. First slice reports explicitly — does not auto-build.
 */
export function reportExposedLowerRoofRegions(
  model: BuildingModelV1,
): ExposedLowerRoofReport[] {
  const shell = extractShellFromModel(model);
  if (!shell) return [];
  const reports: ExposedLowerRoofReport[] = [];
  const sorted = [...model.levels]
    .map((l) => LevelSchema.parse(l))
    .sort((a, b) => a.elevation - b.elevation);

  for (let i = 0; i < sorted.length - 1; i++) {
    const lower = sorted[i]!;
    const upper = sorted[i + 1]!;
    if (upper.footprintSource !== 'custom' || !upper.footprint) continue;
    const lowerFp =
      resolveLevelFootprint(model, lower.id) ?? shellAsFootprint(shell);
    const upperFp = LevelFootprintRectSchema.parse(upper.footprint);
    const regions = exposedFootprintRegions(lowerFp, upperFp);
    if (regions.length === 0) continue;
    reports.push({
      lowerLevelId: lower.id,
      upperLevelId: upper.id,
      regions,
      note:
        'Upper story covers only part of the level below. Exposed regions need lower roof coverage — automatic lower-roof masses are not generated in this slice.',
    });
  }
  return reports;
}

/** Highest story by top elevation — roof bearing for shell or custom. */
export function topRoofBearingLevel(model: BuildingModelV1): Level {
  const levels = model.levels.map((l) => LevelSchema.parse(l));
  if (levels.length === 0) {
    return primaryLevel(model);
  }
  return levels.reduce((best, l) =>
    levelTopElevation(l) > levelTopElevation(best) ? l : best,
  );
}

/** Regenerate custom-level exterior walls + slabs (called from syncShellToModel). */
export function regenerateCustomLevelGeometry(
  model: BuildingModelV1,
  shell: BuildingShell,
): { walls: Wall[]; slabs: BuildingModelV1['slabs'] } {
  const primaryLevelId = primaryLevel(model).id;
  const customLevels = model.levels
    .map((l) => LevelSchema.parse(l))
    .filter((l) => l.footprintSource === 'custom' && l.footprint);

  const customWalls = customLevels.flatMap((lvl) => {
    const fp = LevelFootprintRectSchema.parse(lvl.footprint!);
    return customFootprintWallSegments(fp, lvl.id, {
      primaryLevelId,
      wallHeight: lvl.height,
      wallThickness: shell.wallThickness,
    });
  });

  const priorSlabByLevel = new Map(model.slabs.map((s) => [s.levelId, s]));
  const customSlabs = customLevels.map((lvl) => {
    const fp = LevelFootprintRectSchema.parse(lvl.footprint!);
    const prior = priorSlabByLevel.get(lvl.id);
    return {
      id: prior?.id ?? `slab-${lvl.id}`,
      levelId: lvl.id,
      polygon: footprintCornersFromRect(fp),
      thickness: prior?.thickness ?? 0.5,
      materialId: prior?.materialId ?? model.slabs[0]?.materialId ?? 'mat-floor',
    };
  });

  return { walls: customWalls, slabs: customSlabs };
}

/** Interior wall mid-span cross (same criterion as validation WALL_INTERSECTION). */
function wallsCrossMidspan(
  a: Wall,
  b: Wall,
): boolean {
  const dxA = a.end.x - a.start.x;
  const dyA = a.end.y - a.start.y;
  const dxB = b.end.x - b.start.x;
  const dyB = b.end.y - b.start.y;
  const denom = dxA * dyB - dyA * dxB;
  if (Math.abs(denom) < 1e-9) return false;
  const t = ((b.start.x - a.start.x) * dyB - (b.start.y - a.start.y) * dxB) / denom;
  const u = ((b.start.x - a.start.x) * dyA - (b.start.y - a.start.y) * dxA) / denom;
  const eps = 0.02;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

/**
 * Drop interior walls / spaces on custom-footprint levels that fall outside the
 * new rectangle or cross its regenerated exterior walls. Sync owns exterior
 * regeneration; this keeps staged custom footprints from failing on stale
 * full-shell interiors.
 */
export function pruneInteriorForCustomFootprints(
  model: BuildingModelV1,
  customExteriorWalls: Wall[],
): Pick<BuildingModelV1, 'walls' | 'spaces'> {
  const customByLevel = new Map(
    model.levels
      .map((l) => LevelSchema.parse(l))
      .filter((l) => l.footprintSource === 'custom' && l.footprint)
      .map((l) => [l.id, LevelFootprintRectSchema.parse(l.footprint!)] as const),
  );
  if (customByLevel.size === 0) {
    return { walls: model.walls, spaces: model.spaces };
  }

  const exteriorByLevel = new Map<string, Wall[]>();
  for (const w of customExteriorWalls) {
    const list = exteriorByLevel.get(w.levelId) ?? [];
    list.push(w);
    exteriorByLevel.set(w.levelId, list);
  }

  const walls = model.walls.filter((w) => {
    const fp = customByLevel.get(w.levelId);
    if (!fp) return true;
    // Exterior walls for this level are replaced by regenerateCustomLevelGeometry.
    if (isShellWallId(w.id)) return true;
    if (!pointInFootprint(w.start, fp, 0.05) || !pointInFootprint(w.end, fp, 0.05)) {
      return false;
    }
    const exterior = exteriorByLevel.get(w.levelId) ?? [];
    for (const ew of exterior) {
      if (wallsCrossMidspan(w, ew)) return false;
    }
    return true;
  });

  const spaces = model.spaces.filter((s) => {
    const fp = customByLevel.get(s.levelId);
    if (!fp) return true;
    return s.polygon.every((p) => pointInFootprint(p, fp, 0.05));
  });

  return { walls, spaces };
}

function requireShell(model: BuildingModelV1) {
  const shell = extractShellFromModel(model);
  if (!shell) {
    throw new LevelFootprintError('NO_SHELL', 'BuildingShell is required');
  }
  return shell;
}

function assertFootprintInsideShell(
  shell: BuildingShell,
  footprint: LevelFootprintRect,
) {
  const shellFp = shellAsFootprint(shell);
  if (!footprintContainsFootprint(shellFp, footprint)) {
    throw new LevelFootprintError(
      'LEVEL_FOOTPRINT_OUTSIDE_SHELL',
      'Custom level footprint must lie within the BuildingShell rectangle',
      {
        shell: { width: shell.width, depth: shell.depth },
        footprint,
      },
    );
  }
}

export type SetLevelFootprintInput = {
  levelId: string;
  footprint: LevelFootprintRect;
  allowPrimary?: boolean;
};

/**
 * Apply custom footprint to a level record (does not sync).
 * Callers should run syncShellToModel afterward.
 */
export function applyCustomFootprintToLevels(
  model: BuildingModelV1,
  input: SetLevelFootprintInput,
): BuildingModelV1 {
  const shell = requireShell(model);
  const existing = findLevel(model, input.levelId);
  if (!existing) {
    throw new LevelFootprintError(
      'LEVEL_MISSING',
      `Level not found: ${input.levelId}`,
    );
  }

  const primary = primaryLevel(model);
  if (existing.id === primary.id && !input.allowPrimary) {
    throw new LevelFootprintError(
      'LEVEL_FOOTPRINT_PRIMARY',
      'Primary level must remain footprintSource "shell". Set a custom footprint on an upper story.',
    );
  }

  const footprint = LevelFootprintRectSchema.parse(input.footprint);
  assertFootprintInsideShell(shell, footprint);

  const updated = LevelSchema.parse({
    ...existing,
    footprintSource: 'custom',
    footprint,
  });

  const levels = normalizeLevels(
    model.levels.map((l) => (l.id === updated.id ? updated : l)),
  );
  return { ...model, levels };
}

export type UpdateLevelFootprintInput = {
  levelId: string;
  patch: Partial<{
    center: Vec2;
    width: number;
    depth: number;
  }>;
};

export function applyUpdateCustomFootprint(
  model: BuildingModelV1,
  input: UpdateLevelFootprintInput,
): BuildingModelV1 {
  const existing = findLevel(model, input.levelId);
  if (!existing) {
    throw new LevelFootprintError(
      'LEVEL_MISSING',
      `Level not found: ${input.levelId}`,
    );
  }
  if (existing.footprintSource !== 'custom' || !existing.footprint) {
    throw new LevelFootprintError(
      'LEVEL_FOOTPRINT_NOT_CUSTOM',
      `Level ${input.levelId} is not a custom-footprint level. Use setLevelFootprint first.`,
    );
  }

  const prior = LevelFootprintRectSchema.parse(existing.footprint);
  const next = LevelFootprintRectSchema.parse({
    kind: 'rect',
    center: input.patch.center ?? prior.center,
    width: input.patch.width ?? prior.width,
    depth: input.patch.depth ?? prior.depth,
  });

  return applyCustomFootprintToLevels(model, {
    levelId: input.levelId,
    footprint: next,
    allowPrimary: existing.id === primaryLevel(model).id,
  });
}

export function applyClearCustomFootprint(
  model: BuildingModelV1,
  levelId: string,
): BuildingModelV1 {
  const existing = findLevel(model, levelId);
  if (!existing) {
    throw new LevelFootprintError('LEVEL_MISSING', `Level not found: ${levelId}`);
  }

  const cleaned = {
    id: existing.id,
    name: existing.name,
    elevation: existing.elevation,
    height: existing.height,
    footprintSource: 'shell' as const,
  };

  const levels = normalizeLevels(
    model.levels.map((l) =>
      l.id === levelId ? LevelSchema.parse(cleaned) : l,
    ),
  );
  return { ...model, levels };
}
