import {
  WALL_FACE_IDS,
  WALL_ID_TO_FACE,
  extractShellFromModel,
  getEntity,
  wallLengthForFace,
  type BuildingModelV1,
  type ShellOpening,
  type ShellOpeningType,
  type ShellWallFace,
} from "@aihd/domain";

export const OPENING_ENTITY_TYPES = new Set([
  "window",
  "exteriorDoor",
  "garageDoor",
  "opening",
  "door",
]);

export const OPENING_DEFAULTS: Record<
  ShellOpeningType,
  { width: number; height: number; sillHeight: number; idPrefix: string }
> = {
  window: { width: 4, height: 4, sillHeight: 3, idPrefix: "window" },
  door: { width: 3, height: 7, sillHeight: 0, idPrefix: "door" },
  garageDoor: { width: 10, height: 8, sillHeight: 0, idPrefix: "garage" },
};

export function isOpeningEntityType(type: string): boolean {
  return OPENING_ENTITY_TYPES.has(type);
}

export function generateOpeningId(type: ShellOpeningType): string {
  const prefix = OPENING_DEFAULTS[type].idPrefix;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function resolveHostWallFace(options: {
  wall?: string | null;
  hostWallId?: string | null;
  wallId?: string | null;
}):
  | { ok: true; face: ShellWallFace; wallId: string }
  | { ok: false; error: string; code: string } {
  const faceRaw = options.wall?.trim().toLowerCase();
  if (
    faceRaw === "front" ||
    faceRaw === "rear" ||
    faceRaw === "left" ||
    faceRaw === "right"
  ) {
    return {
      ok: true,
      face: faceRaw,
      wallId: WALL_FACE_IDS[faceRaw],
    };
  }

  const wallId = (options.hostWallId ?? options.wallId)?.trim();
  if (!wallId) {
    return {
      ok: false,
      error: "hostWallId (or wall face) is required.",
      code: "MISSING_HOST_WALL",
    };
  }

  const face = WALL_ID_TO_FACE[wallId];
  if (!face) {
    return {
      ok: false,
      error: `Unknown host wall id "${wallId}". Use wall-front / wall-rear / wall-left / wall-right or face front|rear|left|right.`,
      code: "INVALID_HOST_WALL",
    };
  }
  return { ok: true, face, wallId: WALL_FACE_IDS[face] };
}

export function assertHostWallExists(
  model: BuildingModelV1,
  wallId: string,
): { ok: true } | { ok: false; error: string; code: string } {
  const wall = model.walls.find((w) => w.id === wallId);
  const wallEntity = getEntity(model, wallId);
  if (!wall && wallEntity?.type !== "exteriorWall" && wallEntity?.type !== "wall") {
    return {
      ok: false,
      error: `Host wall "${wallId}" does not exist on this model.`,
      code: "INVALID_HOST_WALL",
    };
  }
  return { ok: true };
}

export function findShellOpening(
  model: BuildingModelV1,
  openingId: string,
): ShellOpening | null {
  const shell = extractShellFromModel(model);
  return shell?.openings.find((o) => o.id === openingId) ?? null;
}

export function summarizeShellOpening(
  opening: ShellOpening,
  shellWallHeight?: number,
): Record<string, unknown> {
  return {
    id: opening.id,
    type: opening.type,
    wall: opening.wall,
    hostWallId: WALL_FACE_IDS[opening.wall],
    offset: opening.offset,
    width: opening.width,
    height: opening.height,
    sillHeight: opening.sillHeight,
    headHeight: opening.sillHeight + opening.height,
    wallHeight: shellWallHeight ?? null,
  };
}

export function openingBoundsIssues(options: {
  model: BuildingModelV1;
  face: ShellWallFace;
  width: number;
  height: number;
  offset: number;
  sillHeight: number;
  ignoreOpeningId?: string;
}): string | null {
  const shell = extractShellFromModel(options.model);
  if (!shell) return "Building has no parametric shell for openings.";

  const wallLen = wallLengthForFace(shell, options.face);
  if (!(options.width > 0) || !(options.height > 0)) {
    return "Opening width and height must be positive.";
  }
  if (options.offset < 0) {
    return "Opening offset must be non-negative.";
  }
  if (options.sillHeight < 0) {
    return "Opening sillHeight must be non-negative.";
  }
  if (options.offset + options.width > wallLen + 0.01) {
    return `Opening extends past the ${options.face} wall (${options.offset}+${options.width} > ${wallLen}).`;
  }
  if (options.sillHeight + options.height > shell.wallHeight + 0.01) {
    return `Opening exceeds wall height (sill ${options.sillHeight} + height ${options.height} > ${shell.wallHeight}).`;
  }

  const eps = 0.01;
  for (const other of shell.openings) {
    if (other.wall !== options.face) continue;
    if (options.ignoreOpeningId && other.id === options.ignoreOpeningId) continue;
    const hOverlap =
      options.offset < other.offset + other.width - eps &&
      other.offset < options.offset + options.width - eps;
    const vOverlap =
      options.sillHeight < other.sillHeight + other.height - eps &&
      other.sillHeight < options.sillHeight + options.height - eps;
    if (hOverlap && vOverlap) {
      return `Opening would overlap neighboring opening ${other.id} on the ${options.face} wall.`;
    }
  }
  return null;
}
