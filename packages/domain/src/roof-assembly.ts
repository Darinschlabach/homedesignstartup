import { z } from 'zod';
import { Vec2Schema, Vec3Schema, type Vec2, type Vec3 } from './building-model';
import { roofRise, pitchRatio } from './geometry/roof-geometry';

/** Roof edge classification for topology / validation (not style presets). */
export const RoofEdgeKindSchema = z.enum([
  'ridge',
  'valley',
  'hip',
  'eave',
  'rake',
  'shared',
]);
export type RoofEdgeKind = z.infer<typeof RoofEdgeKindSchema>;

export const RoofPlaneRoleSchema = z.enum([
  'slope',
  'hipEnd',
  'gable',
  'shed',
  'flat',
  'wing',
]);
export type RoofPlaneRole = z.infer<typeof RoofPlaneRoleSchema>;

export const RoofMassGeneratorTypeSchema = z.enum([
  'gable',
  'hip',
  'shed',
  'flat',
]);
export type RoofMassGeneratorType = z.infer<typeof RoofMassGeneratorTypeSchema>;

export const RoofHighSideSchema = z.enum(['front', 'rear', 'left', 'right']);
export type RoofHighSide = z.infer<typeof RoofHighSideSchema>;

/**
 * Parametric recipe for one rectangular roof mass.
 * This is geometric capability — not a named architectural style.
 */
export const RoofMassGeneratorSchema = z.object({
  type: RoofMassGeneratorTypeSchema,
  /** Plan center (x = width axis, y = depth axis). */
  origin: Vec2Schema,
  width: z.number().positive(),
  depth: z.number().positive(),
  eaveHeight: z.number().nonnegative(),
  /** X-in-12 pitch. 0 allowed for flat. */
  pitch: z.number().nonnegative().default(6),
  overhang: z.number().nonnegative().default(1.5),
  ridgeDirection: z.enum(['width', 'depth']).default('depth'),
  /** Shed only: elevated eave side. */
  highSide: RoofHighSideSchema.optional(),
});
export type RoofMassGenerator = z.infer<typeof RoofMassGeneratorSchema>;

export const RoofPlaneDefSchema = z.object({
  id: z.string().min(1),
  /** Closed boundary in world feet (Y up). */
  boundary: z.array(Vec3Schema).min(3),
  pitch: z.number().nonnegative(),
  fallDirection: z
    .object({
      x: z.number(),
      z: z.number(),
    })
    .optional(),
  materialId: z.string().min(1).optional(),
  massId: z.string().min(1).optional(),
  role: RoofPlaneRoleSchema.optional(),
});
export type RoofPlaneDef = z.infer<typeof RoofPlaneDefSchema>;

export const RoofEdgeDefSchema = z.object({
  id: z.string().min(1),
  kind: RoofEdgeKindSchema,
  start: Vec3Schema,
  end: Vec3Schema,
  /** 1 for eave/rake; 2 for ridge/valley/hip/shared. */
  planeIds: z.array(z.string().min(1)).min(1).max(2),
});
export type RoofEdgeDef = z.infer<typeof RoofEdgeDefSchema>;

export const RoofMassDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  generator: RoofMassGeneratorSchema.optional(),
  planeIds: z.array(z.string().min(1)).default([]),
});
export type RoofMassDef = z.infer<typeof RoofMassDefSchema>;

/**
 * Durable roof assembly.
 * - source:'shell' — regenerated from BuildingShell.roof on sync
 * - source:'composed' — survives syncShellToModel (multi-mass / cross-gable)
 */
export const RoofAssemblySchema = z.object({
  id: z.string().min(1),
  levelId: z.string().min(1),
  source: z.enum(['shell', 'composed']).default('shell'),
  /**
   * primary — roof on the top story / main massing (default)
   * lower — roof covering exposed lower-story regions under a partial upper floor
   */
  role: z.enum(['primary', 'lower']).optional(),
  /** When role is lower, optional id from computeExposedLowerRegions. */
  coversExposedRegionId: z.string().min(1).optional(),
  materialId: z.string().min(1).optional(),
  masses: z.array(RoofMassDefSchema).default([]),
  planes: z.array(RoofPlaneDefSchema).default([]),
  edges: z.array(RoofEdgeDefSchema).default([]),
});
export type RoofAssembly = z.infer<typeof RoofAssemblySchema>;

export const RoofAssembliesSchema = z.array(RoofAssemblySchema).default([]);

type V3 = Vec3;

function v3(x: number, y: number, z: number): V3 {
  return { x, y, z };
}

function edge(
  id: string,
  kind: RoofEdgeKind,
  start: V3,
  end: V3,
  planeIds: string[],
): RoofEdgeDef {
  return { id, kind, start, end, planeIds };
}

function planeDef(
  id: string,
  boundary: V3[],
  pitch: number,
  role: RoofPlaneRole,
  massId: string,
  fallDirection?: { x: number; z: number },
): RoofPlaneDef {
  return {
    id,
    boundary,
    pitch,
    role,
    massId,
    ...(fallDirection ? { fallDirection } : {}),
  };
}

export interface CompileMassResult {
  mass: RoofMassDef;
  planes: RoofPlaneDef[];
  edges: RoofEdgeDef[];
}

/**
 * Compile one rectangular mass generator into planes + classified edges.
 */
export function compileMassGenerator(
  massId: string,
  generator: RoofMassGenerator,
  idPrefix = massId,
): CompileMassResult {
  const gen = RoofMassGeneratorSchema.parse(generator);
  const ox = gen.origin.x;
  const oz = gen.origin.y;
  const hw = gen.width / 2 + gen.overhang;
  const hd = gen.depth / 2 + gen.overhang;
  const eaveY = gen.eaveHeight;
  const pitch = gen.pitch;

  const fl = v3(ox - hw, eaveY, oz - hd);
  const fr = v3(ox + hw, eaveY, oz - hd);
  const br = v3(ox + hw, eaveY, oz + hd);
  const bl = v3(ox - hw, eaveY, oz + hd);

  const planes: RoofPlaneDef[] = [];
  const edges: RoofEdgeDef[] = [];
  const planeIds: string[] = [];

  if (gen.type === 'flat' || pitch === 0) {
    const id = `${idPrefix}-plane-flat`;
    planeIds.push(id);
    planes.push(planeDef(id, [fl, fr, br, bl], 0, 'flat', massId));
    edges.push(
      edge(`${idPrefix}-eave-front`, 'eave', fl, fr, [id]),
      edge(`${idPrefix}-eave-right`, 'eave', fr, br, [id]),
      edge(`${idPrefix}-eave-rear`, 'eave', br, bl, [id]),
      edge(`${idPrefix}-eave-left`, 'eave', bl, fl, [id]),
    );
  } else if (gen.type === 'shed') {
    const high = gen.highSide ?? 'rear';
    const rise = roofRise(
      high === 'front' || high === 'rear' ? gen.depth + 2 * gen.overhang : gen.width + 2 * gen.overhang,
      pitch,
    );
    const id = `${idPrefix}-plane-shed`;
    planeIds.push(id);
    let boundary: V3[];
    let fall: { x: number; z: number };
    if (high === 'rear') {
      boundary = [
        fl,
        fr,
        v3(br.x, eaveY + rise, br.z),
        v3(bl.x, eaveY + rise, bl.z),
      ];
      fall = { x: 0, z: -1 };
    } else if (high === 'front') {
      boundary = [
        v3(fl.x, eaveY + rise, fl.z),
        v3(fr.x, eaveY + rise, fr.z),
        br,
        bl,
      ];
      fall = { x: 0, z: 1 };
    } else if (high === 'left') {
      boundary = [
        v3(fl.x, eaveY + rise, fl.z),
        fr,
        br,
        v3(bl.x, eaveY + rise, bl.z),
      ];
      fall = { x: 1, z: 0 };
    } else {
      boundary = [
        fl,
        v3(fr.x, eaveY + rise, fr.z),
        v3(br.x, eaveY + rise, br.z),
        bl,
      ];
      fall = { x: -1, z: 0 };
    }
    planes.push(planeDef(id, boundary, pitch, 'shed', massId, fall));
    for (let i = 0; i < boundary.length; i++) {
      const a = boundary[i]!;
      const b = boundary[(i + 1) % boundary.length]!;
      // Shed has a single plane — horizontal edges are eaves (high or low), sloping are rakes.
      const kind: RoofEdgeKind =
        Math.abs(a.y - b.y) < 1e-6 ? 'eave' : 'rake';
      edges.push(edge(`${idPrefix}-edge-${i}`, kind, a, b, [id]));
    }
  } else if (gen.type === 'hip') {
    const rise = roofRise(Math.min(hw, hd), pitch);
    if (gen.ridgeDirection === 'depth') {
      const rz = Math.max(0.01, hd - Math.min(hw, hd));
      const peakF = v3(ox, eaveY + rise, oz - rz);
      const peakB = v3(ox, eaveY + rise, oz + rz);
      const front = `${idPrefix}-plane-front`;
      const rear = `${idPrefix}-plane-rear`;
      const left = `${idPrefix}-plane-left`;
      const right = `${idPrefix}-plane-right`;
      planeIds.push(front, rear, left, right);
      planes.push(
        planeDef(front, [fl, fr, peakF], pitch, 'hipEnd', massId, { x: 0, z: -1 }),
        planeDef(rear, [br, bl, peakB], pitch, 'hipEnd', massId, { x: 0, z: 1 }),
        planeDef(left, [fl, peakF, peakB, bl], pitch, 'slope', massId, { x: -1, z: 0 }),
        planeDef(right, [fr, br, peakB, peakF], pitch, 'slope', massId, { x: 1, z: 0 }),
      );
      edges.push(
        edge(`${idPrefix}-ridge`, 'ridge', peakF, peakB, [left, right]),
        edge(`${idPrefix}-hip-fl`, 'hip', fl, peakF, [front, left]),
        edge(`${idPrefix}-hip-fr`, 'hip', fr, peakF, [front, right]),
        edge(`${idPrefix}-hip-bl`, 'hip', bl, peakB, [rear, left]),
        edge(`${idPrefix}-hip-br`, 'hip', br, peakB, [rear, right]),
        edge(`${idPrefix}-eave-front`, 'eave', fl, fr, [front]),
        edge(`${idPrefix}-eave-rear`, 'eave', br, bl, [rear]),
        edge(`${idPrefix}-eave-left`, 'eave', bl, fl, [left]),
        edge(`${idPrefix}-eave-right`, 'eave', fr, br, [right]),
      );
    } else {
      const rx = Math.max(0.01, hw - Math.min(hw, hd));
      const peakL = v3(ox - rx, eaveY + rise, oz);
      const peakR = v3(ox + rx, eaveY + rise, oz);
      const left = `${idPrefix}-plane-left`;
      const right = `${idPrefix}-plane-right`;
      const front = `${idPrefix}-plane-front`;
      const rear = `${idPrefix}-plane-rear`;
      planeIds.push(left, right, front, rear);
      planes.push(
        planeDef(left, [bl, fl, peakL], pitch, 'hipEnd', massId, { x: -1, z: 0 }),
        planeDef(right, [fr, br, peakR], pitch, 'hipEnd', massId, { x: 1, z: 0 }),
        planeDef(front, [fl, fr, peakR, peakL], pitch, 'slope', massId, { x: 0, z: -1 }),
        planeDef(rear, [br, bl, peakL, peakR], pitch, 'slope', massId, { x: 0, z: 1 }),
      );
      edges.push(
        edge(`${idPrefix}-ridge`, 'ridge', peakL, peakR, [front, rear]),
        edge(`${idPrefix}-hip-fl`, 'hip', fl, peakL, [front, left]),
        edge(`${idPrefix}-hip-fr`, 'hip', fr, peakR, [front, right]),
        edge(`${idPrefix}-hip-bl`, 'hip', bl, peakL, [rear, left]),
        edge(`${idPrefix}-hip-br`, 'hip', br, peakR, [rear, right]),
        edge(`${idPrefix}-eave-front`, 'eave', fl, fr, [front]),
        edge(`${idPrefix}-eave-rear`, 'eave', br, bl, [rear]),
        edge(`${idPrefix}-eave-left`, 'eave', bl, fl, [left]),
        edge(`${idPrefix}-eave-right`, 'eave', fr, br, [right]),
      );
    }
  } else {
    // gable
    if (gen.ridgeDirection === 'width') {
      const rise = roofRise(hd, pitch);
      const peakL = v3(ox - hw, eaveY + rise, oz);
      const peakR = v3(ox + hw, eaveY + rise, oz);
      const front = `${idPrefix}-plane-front`;
      const rear = `${idPrefix}-plane-rear`;
      const gableL = `${idPrefix}-plane-gable-left`;
      const gableR = `${idPrefix}-plane-gable-right`;
      planeIds.push(front, rear, gableL, gableR);
      planes.push(
        planeDef(front, [fl, fr, peakR, peakL], pitch, 'slope', massId, { x: 0, z: -1 }),
        planeDef(rear, [bl, peakL, peakR, br], pitch, 'slope', massId, { x: 0, z: 1 }),
        planeDef(gableL, [fl, peakL, bl], pitch, 'gable', massId),
        planeDef(gableR, [fr, br, peakR], pitch, 'gable', massId),
      );
      edges.push(
        edge(`${idPrefix}-ridge`, 'ridge', peakL, peakR, [front, rear]),
        edge(`${idPrefix}-eave-front`, 'eave', fl, fr, [front]),
        edge(`${idPrefix}-eave-rear`, 'eave', br, bl, [rear]),
        edge(`${idPrefix}-rake-fl`, 'rake', fl, peakL, [front, gableL]),
        edge(`${idPrefix}-rake-bl`, 'rake', bl, peakL, [rear, gableL]),
        edge(`${idPrefix}-rake-fr`, 'rake', fr, peakR, [front, gableR]),
        edge(`${idPrefix}-rake-br`, 'rake', br, peakR, [rear, gableR]),
      );
    } else {
      const rise = roofRise(hw, pitch);
      const peakF = v3(ox, eaveY + rise, oz - hd);
      const peakB = v3(ox, eaveY + rise, oz + hd);
      const left = `${idPrefix}-plane-left`;
      const right = `${idPrefix}-plane-right`;
      const gableF = `${idPrefix}-plane-gable-front`;
      const gableR = `${idPrefix}-plane-gable-rear`;
      planeIds.push(left, right, gableF, gableR);
      planes.push(
        planeDef(left, [fl, peakF, peakB, bl], pitch, 'slope', massId, { x: -1, z: 0 }),
        planeDef(right, [fr, br, peakB, peakF], pitch, 'slope', massId, { x: 1, z: 0 }),
        planeDef(gableF, [fl, fr, peakF], pitch, 'gable', massId),
        planeDef(gableR, [bl, peakB, br], pitch, 'gable', massId),
      );
      edges.push(
        edge(`${idPrefix}-ridge`, 'ridge', peakF, peakB, [left, right]),
        edge(`${idPrefix}-eave-left`, 'eave', bl, fl, [left]),
        edge(`${idPrefix}-eave-right`, 'eave', fr, br, [right]),
        edge(`${idPrefix}-rake-fl`, 'rake', fl, peakF, [left, gableF]),
        edge(`${idPrefix}-rake-fr`, 'rake', fr, peakF, [right, gableF]),
        edge(`${idPrefix}-rake-bl`, 'rake', bl, peakB, [left, gableR]),
        edge(`${idPrefix}-rake-br`, 'rake', br, peakB, [right, gableR]),
      );
    }
  }

  return {
    mass: {
      id: massId,
      generator: gen,
      planeIds,
    },
    planes,
    edges,
  };
}

export interface ShellRoofCompileInput {
  width: number;
  depth: number;
  wallHeight: number;
  /** Plan origin of the roof mass (defaults to building center). */
  origin?: { x: number; y: number };
  roof: {
    type: 'gable' | 'hip' | 'shed' | 'flat';
    pitch: number;
    overhang: number;
    ridgeDirection: 'width' | 'depth';
    highSide?: RoofHighSide;
  };
  levelId?: string;
  assemblyId?: string;
  materialId?: string;
}

/** Compile BuildingShell.roof into a source:'shell' RoofAssembly. */
export function compileShellRoofAssembly(input: ShellRoofCompileInput): RoofAssembly {
  const assemblyId = input.assemblyId ?? 'roof-1';
  const levelId = input.levelId ?? 'level-1';
  const massId = `${assemblyId}-mass-main`;
  const compiled = compileMassGenerator(massId, {
    type: input.roof.type,
    origin: input.origin ?? { x: 0, y: 0 },
    width: input.width,
    depth: input.depth,
    eaveHeight: input.wallHeight,
    pitch: input.roof.type === 'flat' ? 0 : input.roof.pitch,
    overhang: input.roof.overhang,
    ridgeDirection: input.roof.ridgeDirection,
    highSide: input.roof.highSide,
  }, assemblyId === 'roof-1' ? 'roof' : assemblyId);

  // Stable plane ids for legacy roof-1 selection (roof-plane-front, …).
  const planes = compiled.planes.map((p) => {
    let id = p.id;
    if (assemblyId === 'roof-1' && p.id.includes('-plane-')) {
      id = `roof-plane-${p.id.split('-plane-')[1]}`;
    }
    return { ...p, id, massId: compiled.mass.id };
  });

  const idMap = new Map(compiled.planes.map((p, i) => [p.id, planes[i]!.id]));
  const edges = compiled.edges.map((e) => ({
    ...e,
    id:
      assemblyId === 'roof-1'
        ? e.id.replace(/^roof-mass-main-/, 'roof-').replace(/^roof-/, 'roof-')
        : e.id,
    planeIds: e.planeIds.map((pid) => idMap.get(pid) ?? pid),
  }));

  return RoofAssemblySchema.parse({
    id: assemblyId,
    levelId,
    source: 'shell',
    materialId: input.materialId ?? 'mat-roof',
    masses: [{ ...compiled.mass, planeIds: planes.map((p) => p.id) }],
    planes,
    edges,
  });
}

export interface CrossGableParams {
  levelId?: string;
  assemblyId?: string;
  materialId?: string;
  eaveHeight: number;
  main: {
    origin?: Vec2;
    width: number;
    depth: number;
    pitch: number;
    overhang?: number;
    ridgeDirection?: 'width' | 'depth';
  };
  wing: {
    origin: Vec2;
    width: number;
    depth: number;
    pitch: number;
    overhang?: number;
    ridgeDirection?: 'width' | 'depth';
  };
}

/** Ensure assemblies exist; migrate from shell when empty. Recompiles composed from authoring. */
export function ensureRoofAssemblies(model: {
  roofAssemblies?: unknown[];
  roofs?: Array<{
    id: string;
    kind: string;
    levelId: string;
    footprint: Vec2[];
    pitch: number;
    overhang: number;
    ridgeDirection: 'width' | 'depth';
    materialId?: string;
  }>;
  shell?: {
    width: number;
    depth: number;
    wallHeight: number;
    roof: {
      type: 'gable' | 'hip' | 'shed' | 'flat';
      pitch: number;
      overhang: number;
      ridgeDirection: 'width' | 'depth';
      highSide?: RoofHighSide;
    };
  };
  levels: Array<{ id: string }>;
}): RoofAssembly[] {
  const existing = model.roofAssemblies ?? [];
  if (existing.length > 0) {
    return existing.map((a) => RoofAssemblySchema.parse(a));
  }
  if (model.shell) {
    return [
      compileShellRoofAssembly({
        width: model.shell.width,
        depth: model.shell.depth,
        wallHeight: model.shell.wallHeight,
        roof: model.shell.roof,
        levelId: model.levels[0]?.id ?? 'level-1',
        assemblyId: model.roofs?.[0]?.id ?? 'roof-1',
        materialId: model.roofs?.[0]?.materialId ?? 'mat-roof',
      }),
    ];
  }
  return [];
}

export function hasComposedRoofAssemblies(
  assemblies: unknown[] | undefined,
): boolean {
  return (assemblies ?? []).some((a) => {
    if (!a || typeof a !== 'object') return false;
    return (a as { source?: string }).source === 'composed';
  });
}

/** Legacy roofs[] mirror from assemblies (first mass footprint). */
export function assembliesToLegacyRoofs(
  assemblies: RoofAssembly[],
): Array<{
  id: string;
  kind: 'gable' | 'hip' | 'shed' | 'flat' | 'monitor';
  levelId: string;
  footprint: Vec2[];
  pitch: number;
  overhang: number;
  ridgeDirection: 'width' | 'depth';
  materialId?: string;
}> {
  return assemblies.map((a) => {
    const gen = a.masses[0]?.generator;
    const kind = (gen?.type ?? 'gable') as 'gable' | 'hip' | 'shed' | 'flat';
    const ox = gen?.origin.x ?? 0;
    const oz = gen?.origin.y ?? 0;
    const hw = (gen?.width ?? 20) / 2;
    const hd = (gen?.depth ?? 20) / 2;
    return {
      id: a.id,
      kind,
      levelId: a.levelId,
      footprint: [
        { x: ox - hw, y: oz - hd },
        { x: ox + hw, y: oz - hd },
        { x: ox + hw, y: oz + hd },
        { x: ox - hw, y: oz + hd },
      ],
      pitch: gen?.pitch ?? 6,
      overhang: gen?.overhang ?? 1.5,
      ridgeDirection: gen?.ridgeDirection ?? 'depth',
      materialId: a.materialId,
    };
  });
}

/** Fan-triangulate a roof plane boundary into flat xyz triples. */
export function triangulateRoofPlane(plane: RoofPlaneDef): number[] {
  const pts = plane.boundary;
  if (pts.length < 3) return [];
  const positions: number[] = [];
  const a = pts[0]!;
  for (let i = 1; i < pts.length - 1; i++) {
    const b = pts[i]!;
    const c = pts[i + 1]!;
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
  return positions;
}

export { pitchRatio, roofRise };
