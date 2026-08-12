import type { BuildingModelV1, Level } from './building-model';
import { LevelSchema } from './building-model';
import {
  defaultStackedElevation,
  findLevel,
  nextLevelId,
  normalizeLevels,
  primaryLevel,
} from './levels';
import { syncShellToModel } from './shell';

export type LevelOpsErrorCode =
  | 'NO_SHELL'
  | 'LEVEL_FOOTPRINT_UNSUPPORTED'
  | 'LEVEL_DUPLICATE_ID'
  | 'LEVEL_HEIGHT'
  | 'LEVEL_MISSING'
  | 'LEVEL_ABOVE_MISSING'
  | 'LEVEL_DELETE_LAST'
  | 'LEVEL_HAS_DEPENDENTS';

export class LevelOpsError extends Error {
  constructor(
    readonly code: LevelOpsErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LevelOpsError';
  }
}

export type CreateLevelInput = {
  id?: string;
  name: string;
  /** Finished floor elevation. Defaults to stacking above the current top level. */
  elevation?: number;
  /**
   * Place the new story directly above this level.
   * Derives elevation = above.elevation + above.height (preferred over manual Y math).
   */
  aboveLevelId?: string;
  /** Story height (feet). Defaults to primary level height / shell.wallHeight. */
  height?: number;
  /**
   * Same rectangular BuildingShell footprint (supported).
   * 'custom' is rejected until partial stories are implemented.
   */
  footprintSource?: 'shell' | 'custom';
};

export type UpdateLevelInput = {
  levelId: string;
  patch: {
    name?: string;
    elevation?: number;
    height?: number;
  };
};

export type DeleteLevelInput = {
  levelId: string;
  /**
   * When true, also remove walls/spaces/slabs/openings/objects owned by the level.
   * Roofs are reassigned to the new top shell level when possible.
   */
  force?: boolean;
};

function requireShell(model: BuildingModelV1) {
  if (!model.shell) {
    throw new LevelOpsError('NO_SHELL', 'BuildingShell is required for level operations');
  }
  return model.shell;
}

/**
 * Add a story. First supported subset: same rectangular shell footprint.
 * Regenerates exterior walls/slabs and lifts the roof to the new top story.
 */
export function createLevel(
  model: BuildingModelV1,
  input: CreateLevelInput,
): BuildingModelV1 {
  const shell = requireShell(model);
  const footprintSource = input.footprintSource ?? 'shell';
  if (footprintSource !== 'shell') {
    throw new LevelOpsError(
      'LEVEL_FOOTPRINT_UNSUPPORTED',
      'Only footprintSource "shell" (same rectangular footprint) is supported for multi-story levels right now.',
    );
  }

  const id = input.id ?? nextLevelId(model);
  if (model.levels.some((l) => l.id === id)) {
    throw new LevelOpsError(
      'LEVEL_DUPLICATE_ID',
      `Level id already exists: ${id}`,
    );
  }

  const primary = primaryLevel(model);
  const height = input.height ?? primary.height ?? shell.wallHeight;
  if (!(height > 0)) {
    throw new LevelOpsError('LEVEL_HEIGHT', 'Level height must be positive');
  }

  let elevation: number;
  if (input.aboveLevelId) {
    const above = findLevel(model, input.aboveLevelId);
    if (!above) {
      throw new LevelOpsError(
        'LEVEL_ABOVE_MISSING',
        `aboveLevelId not found: ${input.aboveLevelId}`,
      );
    }
    elevation = above.elevation + above.height;
  } else if (input.elevation !== undefined) {
    elevation = input.elevation;
  } else {
    elevation = defaultStackedElevation(model);
  }

  const level = LevelSchema.parse({
    id,
    name: input.name,
    elevation,
    height,
    footprintSource: 'shell',
  });

  const levels = normalizeLevels([...model.levels, level]);
  const withLevel: BuildingModelV1 = {
    ...model,
    levels,
    meta: { ...model.meta, stories: Math.max(model.meta.stories, levels.length) },
  };

  return syncShellToModel(withLevel, shell);
}

export function updateLevel(
  model: BuildingModelV1,
  input: UpdateLevelInput,
): BuildingModelV1 {
  const shell = requireShell(model);
  const existing = findLevel(model, input.levelId);
  if (!existing) {
    throw new LevelOpsError('LEVEL_MISSING', `Level not found: ${input.levelId}`);
  }

  const nextHeight = input.patch.height ?? existing.height;
  if (!(nextHeight > 0)) {
    throw new LevelOpsError('LEVEL_HEIGHT', 'Level height must be positive');
  }

  const updated: Level = LevelSchema.parse({
    ...existing,
    name: input.patch.name ?? existing.name,
    elevation:
      input.patch.elevation !== undefined
        ? input.patch.elevation
        : existing.elevation,
    height: nextHeight,
  });

  const oldTop = existing.elevation + existing.height;
  const elevDelta = updated.elevation - existing.elevation;
  const heightDelta = updated.height - existing.height;
  const stackDelta = elevDelta + heightDelta;

  // Keep immediately stacked stories sitting on this level's top.
  const levels = model.levels.map((l) => {
    if (l.id === updated.id) return updated;
    if (Math.abs(l.elevation - oldTop) < 1e-6) {
      return LevelSchema.parse({ ...l, elevation: l.elevation + stackDelta });
    }
    return l;
  });
  let next: BuildingModelV1 = { ...model, levels: normalizeLevels(levels) };

  // Primary level height remains the shell.wallHeight authoring knob.
  if (updated.id === primaryLevel(model).id && input.patch.height !== undefined) {
    next = syncShellToModel(next, { ...shell, wallHeight: updated.height });
  } else {
    next = syncShellToModel(next, shell);
  }

  return next;
}

function levelOwnsGeometry(model: BuildingModelV1, levelId: string): string[] {
  const owned: string[] = [];
  for (const w of model.walls) {
    if (w.levelId === levelId) owned.push(`wall:${w.id}`);
  }
  for (const s of model.spaces) {
    if (s.levelId === levelId) owned.push(`space:${s.id}`);
  }
  for (const s of model.slabs) {
    if (s.levelId === levelId) owned.push(`slab:${s.id}`);
  }
  for (const r of model.roofs) {
    if (r.levelId === levelId) owned.push(`roof:${r.id}`);
  }
  for (const a of model.roofAssemblies ?? []) {
    if (a.levelId === levelId) owned.push(`roofAssembly:${a.id}`);
  }
  for (const e of model.entities ?? []) {
    if (e.levelId === levelId && e.type !== 'level') owned.push(`entity:${e.id}`);
  }
  for (const s of model.stairs ?? []) {
    if (s.fromLevelId === levelId || s.toLevelId === levelId) {
      owned.push(`stair:${s.id}`);
    }
  }
  for (const o of model.floorOpenings ?? []) {
    if (o.levelId === levelId) owned.push(`floorOpening:${o.id}`);
  }
  return owned;
}

export function deleteLevel(
  model: BuildingModelV1,
  input: DeleteLevelInput,
): BuildingModelV1 {
  const shell = requireShell(model);
  if (model.levels.length <= 1) {
    throw new LevelOpsError('LEVEL_DELETE_LAST', 'Cannot delete the only level');
  }
  const existing = findLevel(model, input.levelId);
  if (!existing) {
    throw new LevelOpsError('LEVEL_MISSING', `Level not found: ${input.levelId}`);
  }

  const owned = levelOwnsGeometry(model, input.levelId);
  if (owned.length > 0 && !input.force) {
    throw new LevelOpsError(
      'LEVEL_HAS_DEPENDENTS',
      `Level ${input.levelId} still owns geometry (${owned.length} refs). Pass force: true to remove dependents.`,
      { owned: owned.slice(0, 40) },
    );
  }

  const remainingLevels = normalizeLevels(
    model.levels.filter((l) => l.id !== input.levelId),
  );
  const fallbackLevelId = remainingLevels[0]!.id;
  const deletedWasPrimary = primaryLevel(model).id === input.levelId;

  const next: BuildingModelV1 = {
    ...model,
    levels: remainingLevels,
    meta: {
      ...model.meta,
      stories: Math.max(1, remainingLevels.length),
    },
    walls: model.walls.filter((w) => w.levelId !== input.levelId),
    spaces: model.spaces.filter((s) => s.levelId !== input.levelId),
    slabs: model.slabs.filter((s) => s.levelId !== input.levelId),
    openings: model.openings.filter((o) => {
      const wall = model.walls.find((w) => w.id === o.wallId);
      return wall?.levelId !== input.levelId;
    }),
    roofs: model.roofs.map((r) =>
      r.levelId === input.levelId ? { ...r, levelId: fallbackLevelId } : r,
    ),
    roofAssemblies: (model.roofAssemblies ?? []).map((a) =>
      a.levelId === input.levelId ? { ...a, levelId: fallbackLevelId } : a,
    ),
    entities: (model.entities ?? []).filter(
      (e) => e.levelId !== input.levelId || e.type === 'level',
    ),
    structure: model.structure.filter((s) => s.levelId !== input.levelId),
    stairs: (model.stairs ?? []).filter(
      (s) => s.fromLevelId !== input.levelId && s.toLevelId !== input.levelId,
    ),
    floorOpenings: (() => {
      const remainingStairIds = new Set(
        (model.stairs ?? [])
          .filter(
            (s) =>
              s.fromLevelId !== input.levelId && s.toLevelId !== input.levelId,
          )
          .map((s) => s.id),
      );
      return (model.floorOpenings ?? []).filter((o) => {
        if (o.levelId === input.levelId) return false;
        if (o.stairId && !remainingStairIds.has(o.stairId)) return false;
        return true;
      });
    })(),
    shell: {
      ...shell,
      openings: shell.openings.filter(
        (o) => (o.levelId ?? primaryLevel(model).id) !== input.levelId,
      ),
      ...(deletedWasPrimary
        ? { wallHeight: remainingLevels[0]!.height }
        : {}),
    },
  };

  return syncShellToModel(next, next.shell!);
}
