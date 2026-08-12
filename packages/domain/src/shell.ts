import { z } from 'zod';
import type { BuildingModelV1, Material, Opening, Roof, Wall } from './building-model';
import { LevelSchema } from './building-model';
import { hydrateEntitiesFromModel } from './hydrate-entities';
import {
  assembliesToLegacyRoofs,
  compileShellRoofAssembly,
  hasComposedRoofAssemblies,
  RoofAssemblySchema,
  type RoofAssembly,
} from './roof-assembly';
import { recompileRoofAssembly, massPlanBounds } from './geometry/roof-intersection';
import {
  normalizeLevels,
  levelTopElevation,
} from './levels';
import {
  footprintCornersFromRect,
  pruneInteriorForCustomFootprints,
  regenerateCustomLevelGeometry,
  resolveLevelFootprint,
  topRoofBearingLevel,
} from './level-footprint';

/** User-facing wall faces for a rectangular shell (plan view, Y forward/rear). */
export const ShellWallFaceSchema = z.enum(['front', 'rear', 'left', 'right']);
export type ShellWallFace = z.infer<typeof ShellWallFaceSchema>;

export const ShellOpeningTypeSchema = z.enum(['window', 'door', 'garageDoor']);
export type ShellOpeningType = z.infer<typeof ShellOpeningTypeSchema>;

export const ShellOpeningSchema = z.object({
  id: z.string().min(1),
  type: ShellOpeningTypeSchema,
  wall: ShellWallFaceSchema,
  /** Horizontal distance in feet from the wall's start corner (left when facing the wall from outside). */
  offset: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
  /** Bottom of opening above finished floor, feet. Doors/garage typically 0. */
  sillHeight: z.number().nonnegative().default(0),
  /**
   * Owning story. Omit/undefined = primary level (levels[0]).
   * Required for openings on upper stories of a shared-footprint multi-level building.
   */
  levelId: z.string().min(1).optional(),
});
export type ShellOpening = z.infer<typeof ShellOpeningSchema>;

export const ShellRoofTypeSchema = z.enum(['gable', 'hip', 'shed', 'flat']);
export type ShellRoofType = z.infer<typeof ShellRoofTypeSchema>;

export const RidgeDirectionSchema = z.enum(['width', 'depth']);
export type RidgeDirection = z.infer<typeof RidgeDirectionSchema>;

export const ShellRoofHighSideSchema = z.enum(['front', 'rear', 'left', 'right']);
export type ShellRoofHighSide = z.infer<typeof ShellRoofHighSideSchema>;

export const ShellRoofSchema = z.object({
  type: ShellRoofTypeSchema.default('gable'),
  /** Rise over run, e.g. 6 means 6/12. 0 allowed for flat. */
  pitch: z.number().nonnegative().default(6),
  overhang: z.number().nonnegative().default(1.5),
  ridgeDirection: RidgeDirectionSchema.default('depth'),
  /** Shed only: which eave is elevated. */
  highSide: ShellRoofHighSideSchema.optional(),
});
export type ShellRoof = z.infer<typeof ShellRoofSchema>;

/**
 * Parametric rectangular building shell — source of truth for MVP live 3D.
 * Segment walls/roofs/openings are regenerated from this via syncShellToModel.
 * Units: feet (1 Three.js unit = 1 foot).
 */
export const BuildingShellSchema = z.object({
  width: z.number().positive(),
  depth: z.number().positive(),
  wallHeight: z.number().positive(),
  wallThickness: z.number().positive().default(0.5),
  roof: ShellRoofSchema.default({
    type: 'gable',
    pitch: 6,
    overhang: 1.5,
    ridgeDirection: 'depth',
  }),
  openings: z.array(ShellOpeningSchema).default([]),
});
export type BuildingShell = z.infer<typeof BuildingShellSchema>;

export const WALL_FACE_IDS: Record<ShellWallFace, string> = {
  front: 'wall-front',
  right: 'wall-right',
  rear: 'wall-rear',
  left: 'wall-left',
};

export const WALL_ID_TO_FACE: Record<string, ShellWallFace> = {
  'wall-front': 'front',
  'wall-right': 'right',
  'wall-rear': 'rear',
  'wall-left': 'left',
  // Legacy factory ids from createRectangularShell
  'wall-1': 'front',
  'wall-2': 'right',
  'wall-3': 'rear',
  'wall-4': 'left',
};

const PRIMARY_SHELL_WALL_IDS = new Set<string>([
  ...Object.values(WALL_FACE_IDS),
  'wall-1',
  'wall-2',
  'wall-3',
  'wall-4',
]);

const SHELL_WALL_ID_RE =
  /^(wall-front|wall-right|wall-rear|wall-left|wall-[1-4])(?:__(.+))?$/;

/** Base face wall id for the primary level (no suffix). */
export function shellWallIdForFace(face: ShellWallFace): string {
  return WALL_FACE_IDS[face];
}

/**
 * Exterior shell wall id for a given level.
 * Primary level keeps classic ids (wall-front, …). Upper levels use wall-front__level-2.
 */
export function shellWallIdForLevel(
  face: ShellWallFace,
  levelId: string,
  primaryLevelId: string,
): string {
  const base = WALL_FACE_IDS[face];
  return levelId === primaryLevelId ? base : `${base}__${levelId}`;
}

export function parseShellWallId(wallId: string): {
  face: ShellWallFace;
  levelSuffix: string | null;
} | null {
  const m = SHELL_WALL_ID_RE.exec(wallId);
  if (!m) return null;
  const base = m[1]!;
  const face =
    WALL_ID_TO_FACE[base] ??
    (base === 'wall-1'
      ? 'front'
      : base === 'wall-2'
        ? 'right'
        : base === 'wall-3'
          ? 'rear'
          : base === 'wall-4'
            ? 'left'
            : null);
  if (!face) return null;
  return { face, levelSuffix: m[2] ?? null };
}

/** True when wall id belongs to the parametric rectangular shell footprint (any story). */
export function isShellWallId(wallId: string): boolean {
  return PRIMARY_SHELL_WALL_IDS.has(wallId) || SHELL_WALL_ID_RE.test(wallId);
}

/** True for classic primary-level shell wall ids only. */
export function isPrimaryShellWallId(wallId: string): boolean {
  return PRIMARY_SHELL_WALL_IDS.has(wallId);
}

function openingKindFromShell(type: ShellOpeningType): Opening['kind'] {
  if (type === 'garageDoor') return 'garageDoor';
  if (type === 'window') return 'window';
  return 'door';
}

function shellTypeFromOpening(kind: Opening['kind']): ShellOpeningType {
  if (kind === 'garageDoor') return 'garageDoor';
  if (kind === 'window') return 'window';
  return 'door';
}

export function wallLengthForFace(shell: BuildingShell, face: ShellWallFace): number {
  return face === 'front' || face === 'rear' ? shell.width : shell.depth;
}

/** Build four exterior walls for a shell centered at origin (plan XY). */
export function shellWallSegments(
  shell: BuildingShell,
  levelId: string,
  options?: { primaryLevelId?: string; wallHeight?: number },
): Wall[] {
  const hw = shell.width / 2;
  const hd = shell.depth / 2;
  const t = shell.wallThickness;
  const h = options?.wallHeight ?? shell.wallHeight;
  const primaryLevelId = options?.primaryLevelId ?? levelId;
  const idFor = (face: ShellWallFace) =>
    shellWallIdForLevel(face, levelId, primaryLevelId);

  return [
    {
      id: idFor('front'),
      levelId,
      start: { x: -hw, y: -hd },
      end: { x: hw, y: -hd },
      thickness: t,
      height: h,
      materialId: 'mat-wall',
    },
    {
      id: idFor('right'),
      levelId,
      start: { x: hw, y: -hd },
      end: { x: hw, y: hd },
      thickness: t,
      height: h,
      materialId: 'mat-wall',
    },
    {
      id: idFor('rear'),
      levelId,
      start: { x: hw, y: hd },
      end: { x: -hw, y: hd },
      thickness: t,
      height: h,
      materialId: 'mat-wall',
    },
    {
      id: idFor('left'),
      levelId,
      start: { x: -hw, y: hd },
      end: { x: -hw, y: -hd },
      thickness: t,
      height: h,
      materialId: 'mat-wall',
    },
  ];
}

function footprintCorners(shell: BuildingShell) {
  const hw = shell.width / 2;
  const hd = shell.depth / 2;
  return [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ];
}

/**
 * Regenerate walls, slabs, spaces, roof, and openings from shell params.
 * Preserves meta, materials, constraints, structure, non-shell walls/spaces,
 * and additional levels (does not collapse multi-story levels to one).
 *
 * Exterior-wall strategy:
 * - footprintSource:'shell' → same rectangular BuildingShell footprint
 * - footprintSource:'custom' → durable Level.footprint rectangle (not overwritten
 *   by shell dimensions; walls/slab regenerated from that footprint)
 */
export function syncShellToModel(model: BuildingModelV1, shell: BuildingShell): BuildingModelV1 {
  const rawLevels =
    model.levels.length > 0
      ? normalizeLevels(model.levels)
      : [
          LevelSchema.parse({
            id: 'level-1',
            name: 'Main Floor',
            elevation: 0,
            height: shell.wallHeight,
            footprintSource: 'shell',
          }),
        ];

  // Primary level story height tracks shell.wallHeight (single authoring knob for L1).
  const primary = { ...rawLevels[0]!, height: shell.wallHeight };
  // Primary stays shell-backed (strip accidental custom footprint).
  const primaryClean = LevelSchema.parse({
    id: primary.id,
    name: primary.name,
    elevation: primary.elevation,
    height: primary.height,
    footprintSource: 'shell',
  });
  const levels = [primaryClean, ...rawLevels.slice(1)];
  const primaryLevelId = primaryClean.id;
  const shellLevels = levels.filter((l) => l.footprintSource === 'shell');
  const corners = footprintCorners(shell);

  const shellWalls: Wall[] = shellLevels.flatMap((lvl) =>
    shellWallSegments(shell, lvl.id, {
      primaryLevelId,
      wallHeight: lvl.height,
    }),
  );

  const customGeom = regenerateCustomLevelGeometry({ ...model, levels }, shell);
  const customWallIds = new Set(customGeom.walls.map((w) => w.id));
  const shellWallIds = new Set(shellWalls.map((w) => w.id));

  // Preserve freeform / interior walls (not shell-regenerated, not custom exterior),
  // then prune interiors that conflict with custom upper footprints.
  const candidatePreserved = model.walls.filter(
    (w) =>
      !shellWallIds.has(w.id) &&
      !customWallIds.has(w.id) &&
      !isShellWallId(w.id),
  );
  const pruned = pruneInteriorForCustomFootprints(
    { ...model, levels, walls: [...shellWalls, ...customGeom.walls, ...candidatePreserved] },
    customGeom.walls,
  );
  const walls = pruned.walls;

  // Materialize openings for shell-backed levels (full shell wall lengths)
  // and custom-footprint levels (that level's footprint wall lengths).
  const levelById = new Map(levels.map((l) => [l.id, l]));
  const materializeOpening = (o: (typeof shell.openings)[number]): Opening | null => {
    const openingLevelId = o.levelId ?? primaryLevelId;
    const level = levelById.get(openingLevelId);
    if (!level) return null;

    let wallLen: number;
    if (level.footprintSource === 'custom' && level.footprint) {
      const fp = level.footprint;
      wallLen =
        o.wall === 'front' || o.wall === 'rear' ? fp.width : fp.depth;
    } else if (level.footprintSource === 'shell') {
      wallLen = wallLengthForFace(shell, o.wall);
    } else {
      return null;
    }

    const centerAlong = o.offset + o.width / 2;
    const t = wallLen > 0 ? Math.min(1, Math.max(0, centerAlong / wallLen)) : 0.5;
    return {
      id: o.id,
      kind: openingKindFromShell(o.type),
      wallId: shellWallIdForLevel(o.wall, openingLevelId, primaryLevelId),
      t,
      width: o.width,
      height: o.height,
      sillHeight: o.sillHeight,
    };
  };

  const shellOpenings: Opening[] = shell.openings
    .map(materializeOpening)
    .filter((o): o is Opening => o != null);
  const shellOpeningIds = new Set(shellOpenings.map((o) => o.id));
  const preservedOpenings = model.openings.filter(
    (o) => !isShellWallId(o.wallId) && !shellOpeningIds.has(o.id),
  );
  // Also keep openings on custom exterior walls that were not re-materialized from shell.
  const customWallOpeningHosts = model.openings.filter(
    (o) => customWallIds.has(o.wallId) && !shellOpeningIds.has(o.id),
  );
  const openings = [
    ...shellOpenings,
    ...preservedOpenings,
    ...customWallOpeningHosts.filter(
      (o) => !preservedOpenings.some((p) => p.id === o.id),
    ),
  ];

  const roofLevel = topRoofBearingLevel({ ...model, levels });
  const eaveHeight = levelTopElevation(roofLevel);
  const roofFp =
    resolveLevelFootprint({ ...model, levels }, roofLevel.id) ??
    ({
      kind: 'rect' as const,
      center: { x: 0, y: 0 },
      width: shell.width,
      depth: shell.depth,
    });
  const roofCorners = footprintCornersFromRect(roofFp);

  const roof: Roof = {
    id: 'roof-1',
    kind: shell.roof.type,
    levelId: roofLevel.id,
    footprint: roofCorners.map((c) => ({ ...c })),
    pitch: shell.roof.pitch,
    overhang: shell.roof.overhang,
    ridgeDirection: shell.roof.ridgeDirection,
    materialId: model.roofs[0]?.materialId ?? 'mat-roof',
  };

  const priorAssemblies = (model.roofAssemblies ?? []).map((a) =>
    RoofAssemblySchema.parse(a),
  );
  const lowerAssemblies = priorAssemblies.filter((a) => a.role === 'lower');
  const primaryComposed = priorAssemblies.filter(
    (a) => a.source === 'composed' && a.role !== 'lower',
  );

  const recompileLower = (assembly: RoofAssembly): RoofAssembly => {
    const owning =
      levels.find((l) => l.id === assembly.levelId) ?? levels[0]!;
    const targetEave = levelTopElevation(owning);
    const eaveValues = assembly.masses
      .map((m) => m.generator?.eaveHeight)
      .filter((v): v is number => typeof v === 'number');
    const ref = eaveValues.length > 0 ? Math.min(...eaveValues) : targetEave;
    const delta = targetEave - ref;
    const adjusted = {
      ...assembly,
      role: 'lower' as const,
      levelId: owning.id,
      masses: assembly.masses.map((m) => {
        if (!m.generator || Math.abs(delta) < 1e-6) return m;
        return {
          ...m,
          generator: {
            ...m.generator,
            eaveHeight: m.generator.eaveHeight + delta,
          },
        };
      }),
    };
    return recompileRoofAssembly(adjusted).assembly;
  };

  let roofAssemblies: RoofAssembly[];
  if (hasComposedRoofAssemblies(primaryComposed)) {
    const primary = primaryComposed.map((assembly) => {
      const eaveValues = assembly.masses
        .map((m) => m.generator?.eaveHeight)
        .filter((v): v is number => typeof v === 'number');
      const ref = eaveValues.length > 0 ? Math.min(...eaveValues) : eaveHeight;
      const delta = eaveHeight - ref;
      const adjusted = {
        ...assembly,
        role: assembly.role ?? ('primary' as const),
        levelId: roofLevel.id,
        masses: assembly.masses.map((m) => {
          if (!m.generator) return m;
          return {
            ...m,
            generator: {
              ...m.generator,
              eaveHeight: m.generator.eaveHeight + delta,
            },
          };
        }),
      };
      return recompileRoofAssembly(adjusted).assembly;
    });
    roofAssemblies = [...primary, ...lowerAssemblies.map(recompileLower)];
  } else {
    roofAssemblies = [
      compileShellRoofAssembly({
        width: roofFp.width,
        depth: roofFp.depth,
        wallHeight: eaveHeight,
        origin: { ...roofFp.center },
        roof: {
          type: shell.roof.type,
          pitch: shell.roof.pitch,
          overhang: shell.roof.overhang,
          ridgeDirection: shell.roof.ridgeDirection,
          highSide: shell.roof.highSide,
        },
        levelId: roofLevel.id,
        assemblyId: roof.id,
        materialId: roof.materialId,
      }),
      ...lowerAssemblies.map(recompileLower),
    ];
  }

  const legacyFromAssemblies = assembliesToLegacyRoofs(roofAssemblies);
  const roofs: Roof[] =
    legacyFromAssemblies.length > 0
      ? legacyFromAssemblies.map((r) => ({
          ...r,
          levelId: roofLevel.id,
          materialId: r.materialId ?? roof.materialId,
        }))
      : [roof];

  const footprintSpace = {
    id: 'space-1',
    name:
      model.spaces.find((s) => s.id === 'space-1')?.name ??
      (model.meta.buildingType === 'home' ? 'Open Plan' : 'Main Bay'),
    levelId: primaryLevelId,
    polygon: corners.map((c) => ({ ...c })),
    tags:
      model.spaces.find((s) => s.id === 'space-1')?.tags ??
      [model.meta.buildingType],
  };
  const preservedSpaces = pruned.spaces.filter((s) => s.id !== 'space-1');
  const spaces = [footprintSpace, ...preservedSpaces];

  const priorSlabByLevel = new Map(model.slabs.map((s) => [s.levelId, s]));
  const shellSlabs = shellLevels.map((lvl, index) => {
    const prior = priorSlabByLevel.get(lvl.id);
    return {
      id: prior?.id ?? (index === 0 ? 'slab-1' : `slab-${lvl.id}`),
      levelId: lvl.id,
      polygon: corners.map((c) => ({ ...c })),
      thickness: prior?.thickness ?? 0.5,
      materialId: prior?.materialId ?? model.slabs[0]?.materialId ?? 'mat-floor',
    };
  });
  const shellLevelIds = new Set(shellLevels.map((l) => l.id));
  const customLevelIds = new Set(customGeom.slabs.map((s) => s.levelId));
  // Preserve any other non-shell/non-custom slabs (should be rare).
  const otherSlabs = model.slabs.filter(
    (s) => !shellLevelIds.has(s.levelId) && !customLevelIds.has(s.levelId),
  );

  const next: BuildingModelV1 = {
    ...model,
    shell,
    meta: {
      ...model.meta,
      stories: Math.max(model.meta.stories, levels.length),
    },
    levels,
    walls,
    openings,
    roofs,
    roofAssemblies,
    slabs: [...shellSlabs, ...customGeom.slabs, ...otherSlabs],
    spaces,
  };

  return hydrateEntitiesFromModel(next);
}

/** Infer a shell from an existing rectangular wall model when shell is missing. */
export function extractShellFromModel(model: BuildingModelV1): BuildingShell | null {
  if (model.shell) return BuildingShellSchema.parse(model.shell);
  if (model.walls.length < 4) return null;

  const xs = model.walls.flatMap((w) => [w.start.x, w.end.x]);
  const ys = model.walls.flatMap((w) => [w.start.y, w.end.y]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const depth = maxY - minY;
  if (!(width > 0) || !(depth > 0)) return null;

  const wallHeight =
    model.walls.find((w) => w.height)?.height ?? model.levels[0]?.height ?? 9;
  const wallThickness = model.walls[0]?.thickness ?? 0.5;
  const roofEntity = model.roofs[0];

  const primaryId = model.levels[0]?.id ?? 'level-1';
  const openings: ShellOpening[] = model.openings
    .map((o) => {
      const parsed = parseShellWallId(o.wallId);
      if (!parsed && !WALL_ID_TO_FACE[o.wallId]) return null;
      const face = parsed?.face ?? WALL_ID_TO_FACE[o.wallId]!;
      const wallLen = face === 'front' || face === 'rear' ? width : depth;
      const center = o.t * wallLen;
      const levelId =
        parsed?.levelSuffix != null
          ? parsed.levelSuffix
          : model.walls.find((w) => w.id === o.wallId)?.levelId;
      return {
        id: o.id,
        type: shellTypeFromOpening(o.kind),
        wall: face,
        offset: Math.max(0, center - o.width / 2),
        width: o.width,
        height: o.height,
        sillHeight: o.sillHeight,
        ...(levelId && levelId !== primaryId ? { levelId } : {}),
      };
    })
    .filter((o): o is ShellOpening => o != null);

  return BuildingShellSchema.parse({
    width,
    depth,
    wallHeight,
    wallThickness,
    roof: {
      type: roofEntity?.kind === 'hip' ? 'hip' : 'gable',
      pitch: roofEntity?.pitch ?? 6,
      overhang: roofEntity?.overhang ?? 1.5,
      ridgeDirection: roofEntity?.ridgeDirection ?? 'depth',
    },
    openings,
  });
}

export function ensureShell(model: BuildingModelV1): BuildingModelV1 {
  if (model.shell) return syncShellToModel(model, model.shell);
  const inferred = extractShellFromModel(model);
  if (!inferred) return model;
  return syncShellToModel(model, inferred);
}

const DEFAULT_MATERIALS: Material[] = [
  {
    id: 'mat-wall',
    name: 'Exterior Wall',
    category: 'wall',
    color: '#D9D2C5',
    roughness: 0.88,
    metalness: 0,
  },
  {
    id: 'mat-roof',
    name: 'Roof',
    category: 'roof',
    color: '#4A5560',
    roughness: 0.5,
    metalness: 0.25,
  },
  {
    id: 'mat-floor',
    name: 'Slab',
    category: 'floor',
    color: '#A8A29A',
    roughness: 0.92,
    metalness: 0,
  },
  {
    id: 'mat-structure',
    name: 'Timber',
    category: 'structure',
    color: '#8B6914',
    roughness: 0.75,
    metalness: 0,
  },
  {
    id: 'mat-trim',
    name: 'Trim',
    category: 'trim',
    color: '#F5F0E6',
    roughness: 0.7,
    metalness: 0,
  },
];

/** Default 40×60×9 test building with door, windows, and garage door. */
export function createDefaultTestBuilding(options?: {
  buildingType?: BuildingModelV1['meta']['buildingType'];
  name?: string;
}): BuildingModelV1 {
  const buildingType = options?.buildingType ?? 'home';
  const name = options?.name ?? 'Test Building';

  const shell = BuildingShellSchema.parse({
    width: 40,
    depth: 60,
    wallHeight: 9,
    wallThickness: 0.5,
    roof: {
      type: 'gable',
      pitch: 6,
      overhang: 1.5,
      ridgeDirection: 'depth',
    },
    openings: [
      {
        id: 'door-front',
        type: 'door',
        wall: 'front',
        offset: 8,
        width: 3,
        height: 7,
        sillHeight: 0,
      },
      {
        id: 'window-front-1',
        type: 'window',
        wall: 'front',
        offset: 14,
        width: 4,
        height: 4,
        sillHeight: 3,
      },
      {
        id: 'window-front-2',
        type: 'window',
        wall: 'front',
        offset: 22,
        width: 4,
        height: 4,
        sillHeight: 3,
      },
      {
        id: 'garage-front',
        type: 'garageDoor',
        wall: 'front',
        offset: 28,
        width: 10,
        height: 8,
        sillHeight: 0,
      },
    ],
  });

  const base: BuildingModelV1 = {
    meta: {
      version: 1,
      name,
      buildingType,
      units: 'imperial',
      stories: 1,
    },
    levels: [
      {
        id: 'level-1',
        name: 'Main Floor',
        elevation: 0,
        height: shell.wallHeight,
        footprintSource: 'shell',
      },
    ],
    spaces: [],
    walls: [],
    openings: [],
    roofs: [],
    roofAssemblies: [],
    slabs: [],
    stairs: [],
    floorOpenings: [],
    structure: [],
    materials: DEFAULT_MATERIALS,
    constraints: [],
    entities: [],
    protectedEntityIds: [],
    designPreferences: [],
    designHistory: [],
    shell,
  };

  return syncShellToModel(base, shell);
}

function compactDefined<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export function updateBuildingDimensions(
  model: BuildingModelV1,
  patch: Partial<Pick<BuildingShell, 'width' | 'depth' | 'wallHeight' | 'wallThickness'>>,
): BuildingModelV1 {
  const shell = extractShellFromModel(model) ?? createDefaultTestBuilding().shell!;
  return syncShellToModel(model, { ...shell, ...compactDefined(patch) });
}

/**
 * Returns conflict info when composed roof masses are incompatible with a new footprint.
 * Compatible = every mass footprint stays within shell+overhang tolerance and pairwise
 * overlaps remain for multi-mass assemblies.
 */
export function composedRoofFootprintConflict(
  model: BuildingModelV1,
  nextShell: Pick<BuildingShell, 'width' | 'depth'>,
): { assemblyId: string; message: string } | null {
  const assemblies = (model.roofAssemblies ?? [])
    .map((a) => {
      try {
        return RoofAssemblySchema.parse(a);
      } catch {
        return null;
      }
    })
    .filter((a): a is RoofAssembly => a != null && a.source === 'composed');

  const shellMinX = -nextShell.width / 2;
  const shellMaxX = nextShell.width / 2;
  const shellMinZ = -nextShell.depth / 2;
  const shellMaxZ = nextShell.depth / 2;
  const margin = 4;

  for (const assembly of assemblies) {
    const gens = assembly.masses.map((m) => m.generator).filter(Boolean);
    for (const gen of gens) {
      const b = massPlanBounds(gen!);
      const outside =
        b.minX < shellMinX - margin ||
        b.maxX > shellMaxX + margin ||
        b.minZ < shellMinZ - margin ||
        b.maxZ > shellMaxZ + margin;
      if (outside) {
        return {
          assemblyId: assembly.id,
          message: `Composed roof mass extends outside the new ${nextShell.width}×${nextShell.depth}ft footprint; relayout required`,
        };
      }
    }
    if (gens.length >= 2) {
      const a = massPlanBounds(gens[0]!);
      const b = massPlanBounds(gens[1]!);
      const overlap =
        !(a.maxX < b.minX || b.maxX < a.minX || a.maxZ < b.minZ || b.maxZ < a.minZ);
      if (!overlap) {
        return {
          assemblyId: assembly.id,
          message:
            'Composed roof masses no longer overlap after footprint change; relayout required',
        };
      }
    }
  }
  return null;
}

export function updateRoof(
  model: BuildingModelV1,
  patch: Partial<ShellRoof>,
): BuildingModelV1 {
  const shell = extractShellFromModel(model) ?? createDefaultTestBuilding().shell!;
  // Parametric shell roof edits clear single-mass composed mirrors so shell becomes SoT.
  // Multi-mass composed roofs must be edited via roof-mass ops (enforced in design-service).
  const cleared = {
    ...model,
    roofAssemblies: (model.roofAssemblies ?? []).filter((a) => a.source !== 'composed'),
  };
  return syncShellToModel(cleared, {
    ...shell,
    roof: { ...shell.roof, ...compactDefined(patch) },
  });
}

/**
 * Replace durable roof assemblies. Use source:'composed' for multi-mass roofs
 * that must survive subsequent shell dimension/opening syncs.
 * Composed assemblies are recompiled so derived planes/edges match authoring masses.
 */
export function setRoofAssemblies(
  model: BuildingModelV1,
  assemblies: RoofAssembly[],
): BuildingModelV1 {
  const parsed = assemblies.map((a) => {
    const base = RoofAssemblySchema.parse(a);
    if (base.source === 'composed' && base.masses.some((m) => m.generator)) {
      return recompileRoofAssembly(base).assembly;
    }
    return base;
  });
  const roofs = assembliesToLegacyRoofs(parsed).map((r) => ({
    ...r,
    materialId: r.materialId ?? model.roofs[0]?.materialId ?? 'mat-roof',
  }));
  return hydrateEntitiesFromModel({
    ...model,
    roofAssemblies: parsed,
    roofs,
  });
}

export function addOpening(
  model: BuildingModelV1,
  opening: ShellOpening,
): BuildingModelV1 {
  const shell = extractShellFromModel(model) ?? createDefaultTestBuilding().shell!;
  const openings = [...shell.openings.filter((o) => o.id !== opening.id), opening];
  return syncShellToModel(model, { ...shell, openings });
}

export function updateOpening(
  model: BuildingModelV1,
  openingId: string,
  patch: Partial<Omit<ShellOpening, 'id'>>,
): BuildingModelV1 {
  const shell = extractShellFromModel(model) ?? createDefaultTestBuilding().shell!;
  const openings = shell.openings.map((o) =>
    o.id === openingId
      ? ShellOpeningSchema.parse({ ...o, ...compactDefined(patch), id: o.id })
      : o,
  );
  return syncShellToModel(model, { ...shell, openings });
}

export function removeOpening(model: BuildingModelV1, openingId: string): BuildingModelV1 {
  const shell = extractShellFromModel(model) ?? createDefaultTestBuilding().shell!;
  return syncShellToModel(model, {
    ...shell,
    openings: shell.openings.filter((o) => o.id !== openingId),
  });
}
