import { z } from 'zod';
import { FloorOpeningSchema, StairSchema } from './stair';
import { LevelFootprintRectSchema } from './level-footprint-schema';

export const BuildingTypeSchema = z.enum(['home', 'barn', 'shop']);
export type BuildingType = z.infer<typeof BuildingTypeSchema>;

export const UnitsSchema = z.enum(['imperial', 'metric']);
export type Units = z.infer<typeof UnitsSchema>;

export const Vec2Schema = z.object({
  x: z.number(),
  y: z.number(),
});
export type Vec2 = z.infer<typeof Vec2Schema>;

export const Vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
export type Vec3 = z.infer<typeof Vec3Schema>;

/**
 * Building story / floor.
 *
 * Vertical convention (Y-up, feet):
 * - elevation = finished floor elevation (FFE) in model/world coordinates
 * - height = story height from FFE to the top of this story's walls
 *   (floor-to-floor for intermediate stories; floor-to-eave for the roof-bearing story)
 *
 * Level 1 is typically elevation 0 for backward compatibility.
 */
export const LevelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Finished floor elevation in model coordinates (feet, Y-up). */
  elevation: z.number().default(0),
  /** Story height from finished floor to top of walls (feet). */
  height: z.number().positive(),
  /**
   * Exterior footprint source for this level.
   * - shell: same rectangular BuildingShell footprint
   * - custom: durable Level.footprint rectangle (partial / setback stories)
   */
  footprintSource: z.enum(['shell', 'custom']).default('shell'),
  /**
   * Required when footprintSource === 'custom'. Ignored for shell levels.
   * Axis-aligned rectangle only (no rotation in this slice).
   */
  footprint: LevelFootprintRectSchema.optional(),
});
export type Level = z.infer<typeof LevelSchema>;

export const SpaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  levelId: z.string().min(1),
  polygon: z.array(Vec2Schema).min(3),
  tags: z.array(z.string()).default([]),
});
export type Space = z.infer<typeof SpaceSchema>;

export const OpeningKindSchema = z.enum(['door', 'window', 'opening', 'garageDoor']);
export type OpeningKind = z.infer<typeof OpeningKindSchema>;

export const OpeningSchema = z.object({
  id: z.string().min(1),
  kind: OpeningKindSchema,
  wallId: z.string().min(1),
  /** Distance along wall from start (0–1), center of opening. */
  t: z.number().min(0).max(1),
  width: z.number().positive(),
  height: z.number().positive(),
  sillHeight: z.number().nonnegative().default(0),
});
export type Opening = z.infer<typeof OpeningSchema>;

export const WallSchema = z.object({
  id: z.string().min(1),
  levelId: z.string().min(1),
  start: Vec2Schema,
  end: Vec2Schema,
  thickness: z.number().positive(),
  height: z.number().positive().optional(),
  materialId: z.string().optional(),
});
export type Wall = z.infer<typeof WallSchema>;

export const RoofKindSchema = z.enum(['gable', 'hip', 'shed', 'flat', 'monitor']);
export type RoofKind = z.infer<typeof RoofKindSchema>;

export const RoofSchema = z.object({
  id: z.string().min(1),
  kind: RoofKindSchema,
  levelId: z.string().min(1),
  footprint: z.array(Vec2Schema).min(3),
  pitch: z.number().nonnegative().default(6),
  overhang: z.number().nonnegative().default(1.5),
  /** Which plan axis the ridge runs along for gable roofs. */
  ridgeDirection: z.enum(['width', 'depth']).default('depth'),
  materialId: z.string().optional(),
});
export type Roof = z.infer<typeof RoofSchema>;

/**
 * Durable composable roof assemblies (planes + edges + masses).
 * Full schema lives in roof-assembly.ts; stored as structured JSON on the model.
 */
export const RoofAssemblyModelSchema = z
  .object({
    id: z.string().min(1),
    levelId: z.string().min(1),
    source: z.enum(['shell', 'composed']).default('shell'),
    materialId: z.string().min(1).optional(),
    masses: z.array(z.unknown()).default([]),
    planes: z.array(z.unknown()).default([]),
    edges: z.array(z.unknown()).default([]),
  })
  .passthrough();

export const SlabSchema = z.object({
  id: z.string().min(1),
  levelId: z.string().min(1),
  polygon: z.array(Vec2Schema).min(3),
  thickness: z.number().positive().default(0.5),
  materialId: z.string().optional(),
});
export type Slab = z.infer<typeof SlabSchema>;

// Stair + floor-opening schemas live in ./stair.ts (imported into BuildingModelV1 below).

export const StructureKindSchema = z.enum(['post', 'beam', 'truss', 'bay']);
export type StructureKind = z.infer<typeof StructureKindSchema>;

export const StructureMemberSchema = z.object({
  id: z.string().min(1),
  kind: StructureKindSchema,
  levelId: z.string().min(1),
  start: Vec3Schema,
  end: Vec3Schema,
  sectionWidth: z.number().positive().default(0.5),
  sectionDepth: z.number().positive().default(0.5),
  label: z.string().optional(),
});
export type StructureMember = z.infer<typeof StructureMemberSchema>;

export const MaterialSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.enum(['wall', 'roof', 'floor', 'trim', 'structure']),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  roughness: z.number().min(0).max(1).default(0.7),
  metalness: z.number().min(0).max(1).default(0),
});
export type Material = z.infer<typeof MaterialSchema>;

export const ConstraintSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  priority: z.enum(['must', 'should', 'nice']).default('should'),
  source: z.enum(['user', 'ai', 'system']).default('user'),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

export const BuildingMetaSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  buildingType: BuildingTypeSchema,
  units: UnitsSchema.default('imperial'),
  stories: z.number().int().positive().default(1),
  siteNotes: z.string().optional(),
});
export type BuildingMeta = z.infer<typeof BuildingMetaSchema>;

/** Lazy import avoided — shell schema lives in shell.ts; use z.lazy via passthrough object. */
export const BuildingModelV1Schema = z.object({
  meta: BuildingMetaSchema,
  levels: z.array(LevelSchema).min(1),
  spaces: z.array(SpaceSchema).default([]),
  walls: z.array(WallSchema).default([]),
  openings: z.array(OpeningSchema).default([]),
  roofs: z.array(RoofSchema).default([]),
  /**
   * Durable roof assemblies (composable planes/edges/masses).
   * source:'shell' assemblies are regenerated from BuildingShell.roof;
   * source:'composed' assemblies survive syncShellToModel.
   */
  roofAssemblies: z.array(RoofAssemblyModelSchema).default([]),
  slabs: z.array(SlabSchema).default([]),
  /**
   * Architectural stairs (authoring). Derived tread/riser meshes are computed —
   * not stored tread-by-tread.
   */
  stairs: z.array(StairSchema).default([]),
  /**
   * Durable holes in floor/slab polygons (e.g. stair wells). Survives save/load,
   * revisions, undo, and staged ops — not a renderer-only cut.
   */
  floorOpenings: z.array(FloorOpeningSchema).default([]),
  structure: z.array(StructureMemberSchema).default([]),
  materials: z.array(MaterialSchema).default([]),
  constraints: z.array(ConstraintSchema).default([]),
  /**
   * Extensible architectural entity graph (dual-written with typed arrays).
   * Optional/default empty so older revisions still parse.
   */
  entities: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.string().min(1),
        parentId: z.string().min(1).optional(),
        levelId: z.string().min(1).optional(),
        geometry: z.record(z.unknown()).default({}),
        properties: z.record(z.unknown()).default({}),
        materialId: z.string().min(1).optional(),
        meta: z.record(z.unknown()).optional(),
      }),
    )
    .default([]),
  /** Entity ids the AI / design ops must not alter (e.g. footprint walls when preserving plan). */
  protectedEntityIds: z.array(z.string().min(1)).default([]),
  /** Soft design preferences captured from conversation (not hard-coded styles). */
  designPreferences: z
    .array(
      z.object({
        id: z.string().min(1),
        key: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean(), z.record(z.unknown())]),
        source: z.enum(['user', 'ai', 'system']).default('user'),
        notes: z.string().optional(),
      }),
    )
    .default([]),
  /** Lightweight design operation history metadata (full snapshots live in building_revisions). */
  designHistory: z
    .array(
      z.object({
        id: z.string().min(1),
        at: z.string().min(1),
        transactionId: z.string().optional(),
        reason: z.string().optional(),
        summary: z.string().optional(),
        operationCount: z.number().int().nonnegative().optional(),
      }),
    )
    .default([]),
  /** Parametric rectangular shell — preferred authoring convenience for live 3D MVP. */
  shell: z
    .object({
      width: z.number().positive(),
      depth: z.number().positive(),
      wallHeight: z.number().positive(),
      wallThickness: z.number().positive().default(0.5),
      roof: z.object({
        type: z.enum(['gable', 'hip', 'shed', 'flat']).default('gable'),
        /** X-in-12; 0 allowed for flat roofs. */
        pitch: z.number().nonnegative().default(6),
        overhang: z.number().nonnegative().default(1.5),
        ridgeDirection: z.enum(['width', 'depth']).default('depth'),
        /** Shed only: elevated eave side. */
        highSide: z.enum(['front', 'rear', 'left', 'right']).optional(),
      }),
      openings: z
        .array(
          z.object({
            id: z.string().min(1),
            type: z.enum(['window', 'door', 'garageDoor']),
            wall: z.enum(['front', 'rear', 'left', 'right']),
            offset: z.number().nonnegative(),
            width: z.number().positive(),
            height: z.number().positive(),
            sillHeight: z.number().nonnegative().default(0),
            /** Owning story; omit for primary level. */
            levelId: z.string().min(1).optional(),
          }),
        )
        .default([]),
    })
    .optional(),
});
export type BuildingModelV1 = z.infer<typeof BuildingModelV1Schema>;

export const BUILDING_MODEL_SCHEMA_VERSION = 1 as const;
