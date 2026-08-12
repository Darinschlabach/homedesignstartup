import type { BuildingModelV1 } from './building-model';
import {
  BuildingShellSchema,
  ShellOpeningSchema,
  addOpening,
  extractShellFromModel,
  createDefaultTestBuilding,
  wallLengthForFace,
  type BuildingShell,
  type ShellOpening,
  type ShellOpeningType,
  type ShellWallFace,
} from './shell';
import { resolveLevelFootprint } from './level-footprint';

export type OpeningPositionHint = 'center' | 'left' | 'right';

const EDGE_INSET_FT = 2;

/** Resolve horizontal offset (feet from wall start) from a position hint or explicit offset. */
export function resolveOpeningOffset(options: {
  wallLength: number;
  width: number;
  position?: OpeningPositionHint;
  offset?: number;
}): number {
  const { wallLength, width, position, offset } = options;
  if (offset != null && Number.isFinite(offset)) {
    return Math.max(0, Math.min(offset, Math.max(0, wallLength - width)));
  }

  const hint = position ?? 'center';
  if (hint === 'center') {
    return Math.max(0, (wallLength - width) / 2);
  }
  if (hint === 'left') {
    return Math.min(EDGE_INSET_FT, Math.max(0, wallLength - width));
  }
  // right
  return Math.max(0, wallLength - width - EDGE_INSET_FT);
}

const DEFAULTS: Record<
  ShellOpeningType,
  { width: number; height: number; sillHeight: number; idPrefix: string }
> = {
  window: { width: 4, height: 4, sillHeight: 3, idPrefix: 'window' },
  door: { width: 3, height: 7, sillHeight: 0, idPrefix: 'door' },
  garageDoor: { width: 10, height: 8, sillHeight: 0, idPrefix: 'garage' },
};

export function newOpeningId(type: ShellOpeningType): string {
  const prefix = DEFAULTS[type].idPrefix;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Ensure the model has a parametric shell before AI shell tools run. */
export function ensureDesignShell(model: BuildingModelV1): BuildingModelV1 {
  if (model.shell || model.walls.length > 0) {
    const shell = extractShellFromModel(model);
    if (shell) {
      // Re-sync so shell stays authoritative when present/inferred
      return model.shell ? model : { ...model, shell };
    }
  }
  return createDefaultTestBuilding({
    buildingType: model.meta.buildingType,
    name: model.meta.name,
  });
}

export function getShellOrThrow(model: BuildingModelV1): BuildingShell {
  const shell = extractShellFromModel(ensureDesignShell(model));
  if (!shell) {
    throw new Error('Building has no parametric shell to edit.');
  }
  return BuildingShellSchema.parse(shell);
}

export function buildConvenienceOpening(input: {
  model: BuildingModelV1;
  type: ShellOpeningType;
  wall: ShellWallFace;
  width?: number;
  height?: number;
  sillHeight?: number;
  position?: OpeningPositionHint;
  offset?: number;
  id?: string;
  levelId?: string;
}): ShellOpening {
  const base = ensureDesignShell(input.model);
  const shell = getShellOrThrow(base);
  const defaults = DEFAULTS[input.type];
  const width = input.width ?? defaults.width;
  const height = input.height ?? defaults.height;
  const sillHeight = input.sillHeight ?? defaults.sillHeight;
  const levelId = input.levelId ?? base.levels[0]?.id;
  const levelFp = levelId ? resolveLevelFootprint(base, levelId) : null;
  const wallLength = levelFp
    ? input.wall === 'front' || input.wall === 'rear'
      ? levelFp.width
      : levelFp.depth
    : wallLengthForFace(shell, input.wall);

  if (input.position == null && input.offset == null) {
    throw new Error('Opening placement requires position (center|left|right) or offset in feet.');
  }

  const offset = resolveOpeningOffset({
    wallLength,
    width,
    position: input.position,
    offset: input.offset,
  });

  return ShellOpeningSchema.parse({
    id: input.id ?? newOpeningId(input.type),
    type: input.type,
    wall: input.wall,
    width,
    height,
    sillHeight,
    offset,
    ...(input.levelId ? { levelId: input.levelId } : {}),
  });
}

export function addConvenienceOpening(
  model: BuildingModelV1,
  input: Omit<Parameters<typeof buildConvenienceOpening>[0], 'model'>,
): BuildingModelV1 {
  const base = ensureDesignShell(model);
  const opening = buildConvenienceOpening({ ...input, model: base });
  return addOpening(base, opening);
}
