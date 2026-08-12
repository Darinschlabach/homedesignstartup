import type { BuildingModelV1, Level } from './building-model';
import { LevelSchema } from './building-model';

/** Finished floor elevation for a level id (defaults to 0). */
export function levelFinishedFloorElevation(
  model: BuildingModelV1,
  levelId: string | undefined | null,
): number {
  if (!levelId) return model.levels[0]?.elevation ?? 0;
  return model.levels.find((l) => l.id === levelId)?.elevation ?? 0;
}

/** Top of walls / eave bearing elevation for a level (FFE + story height). */
export function levelTopElevation(level: Level): number {
  return level.elevation + level.height;
}

export function findLevel(
  model: BuildingModelV1,
  levelId: string,
): Level | undefined {
  return model.levels.find((l) => l.id === levelId);
}

export function primaryLevel(model: BuildingModelV1): Level {
  const first = model.levels[0];
  if (first) return LevelSchema.parse(first);
  return LevelSchema.parse({
    id: 'level-1',
    name: 'Main Floor',
    elevation: 0,
    height: model.shell?.wallHeight ?? 9,
    footprintSource: 'shell',
  });
}

/** Highest shell-footprint level (by elevation); used for roof bearing. */
export function topShellLevel(model: BuildingModelV1): Level {
  const shellLevels = model.levels
    .map((l) => LevelSchema.parse(l))
    .filter((l) => l.footprintSource === 'shell');
  const pool = shellLevels.length > 0 ? shellLevels : model.levels.map((l) => LevelSchema.parse(l));
  return pool.reduce((best, l) =>
    levelTopElevation(l) > levelTopElevation(best) ? l : best,
  );
}

export function nextLevelId(model: BuildingModelV1): string {
  let n = model.levels.length + 1;
  const ids = new Set(model.levels.map((l) => l.id));
  while (ids.has(`level-${n}`)) n += 1;
  return `level-${n}`;
}

/** Default stacked elevation: directly above the current topmost level. */
export function defaultStackedElevation(model: BuildingModelV1): number {
  if (model.levels.length === 0) return 0;
  return Math.max(...model.levels.map((l) => levelTopElevation(LevelSchema.parse(l))));
}

export function normalizeLevels(levels: Level[]): Level[] {
  return levels.map((l) => LevelSchema.parse(l));
}
