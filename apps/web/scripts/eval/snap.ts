import {
  checkModelIntegrity,
  isShellWallId,
  runDesignValidators,
  type BuildingModelV1,
} from "@aihd/domain";

export type ShellOpeningSnap = {
  id: string;
  type: string;
  wall: string;
  offset: number | null;
  width: number;
  height: number;
  levelId?: string;
};

export type LevelSnap = {
  id: string;
  name?: string;
  elevation: number;
  height: number;
  footprintSource: string;
  footprint: {
    centerX: number;
    centerZ: number;
    width: number;
    depth: number;
    area: number;
  } | null;
};

export type SpaceSnap = {
  id: string;
  name: string;
  levelId: string;
  tags: string[];
  area: number;
};

export type StairSnap = {
  id: string;
  name?: string;
  type: string;
  fromLevelId: string;
  toLevelId: string;
  origin: { x: number; y: number };
  directionDeg: number;
  width: number;
};

export type RoofMassSnap = {
  assemblyId: string;
  role: string | null;
  source: string;
  massId: string;
  type: string | null;
  width: number | null;
  depth: number | null;
};

export type MaterialSnap = {
  id: string;
  name: string;
  category: string;
  color: string;
  roughness: number;
  metalness: number;
};

export type ModelSnap = {
  stories: number;
  footprint: { width: number; depth: number; wallHeight: number } | null;
  shellRoof: { type: string; pitch: number; overhang: number } | null;
  shellOpenings: ShellOpeningSnap[];
  frontDoor: ShellOpeningSnap | null;
  garageDoor: ShellOpeningSnap | null;
  levels: LevelSnap[];
  spaces: SpaceSnap[];
  bedroomCount: number;
  interiorWallCount: number;
  wallCount: number;
  stairs: StairSnap[];
  roofMasses: RoofMassSnap[];
  materials: MaterialSnap[];
  materialBindingFingerprint: string;
  objectCount: number;
  geometryFingerprint: string;
  validationErrors: Array<{ code: string; message: string }>;
  integrity: string[];
  geometryValid: boolean;
};

function polygonArea(poly: Array<{ x: number; y: number }>): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function isBedroom(space: { name: string; tags?: string[] }): boolean {
  if (/bed/i.test(space.name)) return true;
  return (space.tags ?? []).some((t) => /bed/i.test(t));
}

function shellOpeningSnap(
  o: NonNullable<BuildingModelV1["shell"]>["openings"][number],
): ShellOpeningSnap {
  return {
    id: o.id,
    type: o.type,
    wall: o.wall,
    offset: typeof o.offset === "number" ? o.offset : null,
    width: o.width,
    height: o.height,
    levelId: o.levelId,
  };
}

export function snapModel(model: BuildingModelV1): ModelSnap {
  const shell = model.shell;
  const openings = (shell?.openings ?? []).map(shellOpeningSnap);
  const frontDoor =
    openings.find((o) => o.id === "door-front") ??
    openings.find((o) => o.type === "door" && o.wall === "front") ??
    null;
  const garageDoor =
    openings.find((o) => o.id === "garage-front") ??
    openings.find((o) => o.type === "garageDoor") ??
    null;

  const levels: LevelSnap[] = (model.levels ?? []).map((l) => {
    const fp = l.footprint;
    return {
      id: l.id,
      name: l.name,
      elevation: l.elevation,
      height: l.height,
      footprintSource: l.footprintSource ?? "shell",
      footprint: fp
        ? {
            centerX: fp.center?.x ?? 0,
            centerZ: fp.center?.y ?? 0,
            width: fp.width,
            depth: fp.depth,
            area: fp.width * fp.depth,
          }
        : null,
    };
  });

  const spaces: SpaceSnap[] = (model.spaces ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    levelId: s.levelId,
    tags: s.tags ?? [],
    area: polygonArea(s.polygon ?? []),
  }));

  const stairs: StairSnap[] = (model.stairs ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    fromLevelId: s.fromLevelId,
    toLevelId: s.toLevelId,
    origin: { x: s.origin.x, y: s.origin.y },
    directionDeg: s.directionDeg ?? 0,
    width: s.width,
  }));

  const roofMasses: RoofMassSnap[] = [];
  for (const a of model.roofAssemblies ?? []) {
    for (const m of a.masses ?? []) {
      const gen = (m as { generator?: Record<string, unknown>; id?: string }).generator;
      roofMasses.push({
        assemblyId: a.id,
        role: typeof a.role === "string" ? a.role : null,
        source: a.source,
        massId: (m as { id?: string }).id ?? "?",
        type: typeof gen?.type === "string" ? gen.type : null,
        width: typeof gen?.width === "number" ? gen.width : null,
        depth: typeof gen?.depth === "number" ? gen.depth : null,
      });
    }
  }

  const materials: MaterialSnap[] = (model.materials ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    category: m.category,
    color: m.color,
    roughness: m.roughness ?? 0.7,
    metalness: m.metalness ?? 0,
  }));

  const PLACED_OBJECT_TYPES = new Set([
    "furniture",
    "baseCabinet",
    "wallCabinet",
    "tallCabinet",
    "cabinet",
    "panel",
    "shelf",
    "cabinetDoor",
    "drawer",
    "countertop",
    "backsplash",
    "appliance",
    "sink",
    "faucet",
    "light",
    "island",
    "porch",
    "deck",
  ]);

  const interiorWallCount = (model.walls ?? []).filter((w) => !isShellWallId(w.id)).length;

  const geometryFingerprint = JSON.stringify({
    footprint: shell
      ? { width: shell.width, depth: shell.depth, wallHeight: shell.wallHeight }
      : null,
    openings: openings.map((o) => ({
      id: o.id,
      type: o.type,
      wall: o.wall,
      offset: o.offset,
      width: o.width,
      height: o.height,
      levelId: o.levelId ?? null,
    })),
    levels: levels.map((l) => ({
      id: l.id,
      elevation: l.elevation,
      height: l.height,
      footprintSource: l.footprintSource,
      footprint: l.footprint,
    })),
    walls: (model.walls ?? []).map((w) => ({
      id: w.id,
      levelId: w.levelId,
      start: w.start,
      end: w.end,
      thickness: w.thickness,
    })),
    spaces: spaces.map((s) => ({
      id: s.id,
      levelId: s.levelId,
      polygon: (model.spaces ?? []).find((x) => x.id === s.id)?.polygon,
    })),
    stairs: stairs.map((s) => ({
      id: s.id,
      type: s.type,
      origin: s.origin,
      directionDeg: s.directionDeg,
      width: s.width,
      fromLevelId: s.fromLevelId,
      toLevelId: s.toLevelId,
    })),
    roof: shell?.roof
      ? {
          type: shell.roof.type,
          pitch: shell.roof.pitch,
          overhang: shell.roof.overhang,
          ridgeDirection: shell.roof.ridgeDirection,
        }
      : null,
    roofMasses,
    objects: (model.entities ?? [])
      .filter((e) => PLACED_OBJECT_TYPES.has(String(e.type)))
      .map((e) => ({
        id: e.id,
        type: e.type,
        geometry: e.geometry ?? null,
        levelId: e.levelId ?? null,
      })),
  });

  const materialBindingFingerprint = JSON.stringify({
    walls: (model.walls ?? []).map((w) => [w.id, w.materialId ?? null]),
    roof: (model.roofAssemblies ?? []).find((a) => a.source === "shell")?.materialId ?? null,
    assemblies: (model.roofAssemblies ?? []).map((a) => [a.id, a.materialId ?? null]),
    entities: (model.entities ?? []).map((e) => [e.id, e.materialId ?? null]),
    openings: (model.openings ?? []).map((o) => [o.id, (o as { materialId?: string }).materialId ?? null]),
  });

  const validationErrors = runDesignValidators(model, [])
    .filter((i) => (i.severity ?? "error") === "error")
    .map((i) => ({ code: i.code, message: i.message }));
  const integrity = checkModelIntegrity(model);

  return {
    stories: model.meta?.stories ?? (model.levels?.length || 1),
    footprint: shell
      ? { width: shell.width, depth: shell.depth, wallHeight: shell.wallHeight }
      : null,
    shellRoof: shell?.roof
      ? {
          type: shell.roof.type,
          pitch: shell.roof.pitch,
          overhang: shell.roof.overhang,
        }
      : null,
    shellOpenings: openings,
    frontDoor,
    garageDoor,
    levels,
    spaces,
    bedroomCount: spaces.filter((s) => isBedroom(s)).length,
    interiorWallCount,
    wallCount: (model.walls ?? []).length,
    stairs,
    roofMasses,
    materials,
    materialBindingFingerprint,
    objectCount: (model.entities ?? []).filter((e) =>
      PLACED_OBJECT_TYPES.has(String(e.type)),
    ).length,
    geometryFingerprint,
    validationErrors,
    integrity,
    geometryValid: validationErrors.length === 0 && integrity.length === 0,
  };
}

export type SnapDiff = {
  footprintChanged: boolean;
  l1FootprintChanged: boolean;
  l2AreaBefore: number | null;
  l2AreaAfter: number | null;
  l2Smaller: boolean | null;
  storiesBefore: number;
  storiesAfter: number;
  addedLevel: boolean;
  frontDoorMoved: boolean;
  garageWidthChanged: boolean;
  garageOffsetChanged: boolean;
  stairRemoved: boolean;
  stairMoved: boolean;
  stairCountDelta: number;
  bedroomDelta: number;
  interiorWallDelta: number;
  spaceCountDelta: number;
  materialCatalogChanged: boolean;
  materialBindingsChanged: boolean;
  materialAssignmentHint: boolean;
  spaceLayoutChanged: boolean;
  geometryChanged: boolean;
  roofChanged: boolean;
  roofMassChanged: boolean;
  openingsChanged: boolean;
  objectCountDelta: number;
};

function levelArea(snap: ModelSnap, id: string): number | null {
  const l = snap.levels.find((x) => x.id === id);
  if (!l) return null;
  if (l.footprint) return l.footprint.area;
  if (snap.footprint) return snap.footprint.width * snap.footprint.depth;
  return null;
}

function openingKey(o: ShellOpeningSnap | null): string | null {
  if (!o) return null;
  return `${o.id}|${o.wall}|${o.offset}|${o.width}|${o.height}|${o.levelId ?? ""}`;
}

export function diffSnaps(before: ModelSnap, after: ModelSnap): SnapDiff {
  const l2Before = levelArea(before, "level-2");
  const l2After = levelArea(after, "level-2");
  const stairBefore = before.stairs[0] ?? null;
  const stairAfter =
    after.stairs.find((s) => s.id === stairBefore?.id) ?? after.stairs[0] ?? null;

  const materialCatalogChanged =
    JSON.stringify(before.materials) !== JSON.stringify(after.materials);

  return {
    footprintChanged:
      JSON.stringify(before.footprint) !== JSON.stringify(after.footprint),
    l1FootprintChanged: (() => {
      const pick = (s: ModelSnap) => {
        const l = s.levels.find((x) => x.id === "level-1");
        return l
          ? { footprintSource: l.footprintSource, footprint: l.footprint, height: l.height }
          : null;
      };
      return JSON.stringify(pick(before)) !== JSON.stringify(pick(after));
    })(),
    l2AreaBefore: l2Before,
    l2AreaAfter: l2After,
    l2Smaller:
      l2Before != null && l2After != null ? l2After < l2Before - 0.5 : null,
    storiesBefore: before.levels.length,
    storiesAfter: after.levels.length,
    addedLevel: after.levels.length > before.levels.length,
    frontDoorMoved: openingKey(before.frontDoor) !== openingKey(after.frontDoor),
    garageWidthChanged: (before.garageDoor?.width ?? null) !== (after.garageDoor?.width ?? null),
    garageOffsetChanged:
      (before.garageDoor?.offset ?? null) !== (after.garageDoor?.offset ?? null),
    stairRemoved: before.stairs.length > 0 && after.stairs.length === 0,
    stairMoved: Boolean(
      stairBefore &&
        stairAfter &&
        (stairBefore.origin.x !== stairAfter.origin.x ||
          stairBefore.origin.y !== stairAfter.origin.y ||
          stairBefore.directionDeg !== stairAfter.directionDeg ||
          stairBefore.width !== stairAfter.width ||
          stairBefore.type !== stairAfter.type),
    ),
    stairCountDelta: after.stairs.length - before.stairs.length,
    bedroomDelta: after.bedroomCount - before.bedroomCount,
    interiorWallDelta: after.interiorWallCount - before.interiorWallCount,
    spaceCountDelta: after.spaces.length - before.spaces.length,
    materialCatalogChanged,
    materialBindingsChanged:
      before.materialBindingFingerprint !== after.materialBindingFingerprint,
    materialAssignmentHint:
      materialCatalogChanged ||
      before.materialBindingFingerprint !== after.materialBindingFingerprint,
    spaceLayoutChanged: JSON.stringify(before.spaces) !== JSON.stringify(after.spaces),
    geometryChanged: before.geometryFingerprint !== after.geometryFingerprint,
    roofChanged:
      JSON.stringify(before.shellRoof) !== JSON.stringify(after.shellRoof) ||
      JSON.stringify(before.roofMasses) !== JSON.stringify(after.roofMasses),
    roofMassChanged: JSON.stringify(before.roofMasses) !== JSON.stringify(after.roofMasses),
    openingsChanged:
      JSON.stringify(before.shellOpenings) !== JSON.stringify(after.shellOpenings),
    objectCountDelta: after.objectCount - before.objectCount,
  };
}
