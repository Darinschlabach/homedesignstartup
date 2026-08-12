import { z } from 'zod';
import { DesignEntitySchema, type DesignEntity } from './entities';
import { ShellRoofSchema, ShellWallFaceSchema } from './shell';

/** Atomic design operations applied through DesignService transactions. */
export const DesignOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('queryDesign'),
  }),
  z.object({
    op: z.literal('createEntity'),
    entity: DesignEntitySchema,
  }),
  z.object({
    op: z.literal('updateEntity'),
    entityId: z.string().min(1),
    patch: z
      .object({
        geometry: z.record(z.unknown()).optional(),
        properties: z.record(z.unknown()).optional(),
        materialId: z.string().nullable().optional(),
        parentId: z.string().nullable().optional(),
        levelId: z.string().nullable().optional(),
        meta: z.record(z.unknown()).optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal('moveEntity'),
    entityId: z.string().min(1),
    /** Displacement in feet (plan X/Y or 3D). */
    delta: z.object({
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      offset: z.number().optional(),
    }),
  }),
  z.object({
    op: z.literal('resizeEntity'),
    entityId: z.string().min(1),
    dimensions: z.record(z.number()),
  }),
  z.object({
    op: z.literal('deleteEntity'),
    entityId: z.string().min(1),
  }),
  z.object({
    op: z.literal('duplicateEntity'),
    entityId: z.string().min(1),
    newId: z.string().min(1).optional(),
  }),
  z.object({
    op: z.literal('setMaterial'),
    entityId: z.string().min(1),
    materialId: z.string().min(1),
    /** Optional structured finish overrides on the assigned material catalog entry (shared). */
    finish: z
      .object({
        color: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional(),
        roughness: z.number().min(0).max(1).optional(),
        metalness: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
  }),
  z.object({
    op: z.literal('createMaterial'),
    material: z
      .object({
        id: z.string().min(1).optional(),
        name: z.string().min(1),
        category: z.enum(['wall', 'roof', 'floor', 'trim', 'structure']),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        roughness: z.number().min(0).max(1).optional(),
        metalness: z.number().min(0).max(1).optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal('createWall'),
    wall: z.object({
      id: z.string().min(1).optional(),
      levelId: z.string().min(1).optional(),
      /** Plan coords: x = width axis, y = depth axis (not elevation). */
      start: z.object({ x: z.number(), y: z.number() }),
      end: z.object({ x: z.number(), y: z.number() }),
      thickness: z.number().positive().optional(),
      height: z.number().positive().optional(),
      materialId: z.string().optional(),
      /** interior = freeform partition; exterior reserved for shell/footprint walls. */
      kind: z.enum(['interior', 'exterior']).optional(),
    }),
  }),
  z.object({
    op: z.literal('updateWall'),
    wallId: z.string().min(1),
    patch: z
      .object({
        start: z.object({ x: z.number(), y: z.number() }).optional(),
        end: z.object({ x: z.number(), y: z.number() }).optional(),
        thickness: z.number().positive().optional(),
        height: z.number().positive().optional(),
        materialId: z.string().nullable().optional(),
        levelId: z.string().min(1).optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal('deleteWall'),
    wallId: z.string().min(1),
  }),
  z.object({
    op: z.literal('createSpace'),
    space: z.object({
      id: z.string().min(1).optional(),
      name: z.string().min(1),
      levelId: z.string().min(1).optional(),
      polygon: z.array(z.object({ x: z.number(), y: z.number() })).min(3),
      tags: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    op: z.literal('updateSpace'),
    spaceId: z.string().min(1),
    patch: z
      .object({
        name: z.string().min(1).optional(),
        levelId: z.string().min(1).optional(),
        polygon: z.array(z.object({ x: z.number(), y: z.number() })).min(3).optional(),
        tags: z.array(z.string()).optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal('deleteSpace'),
    spaceId: z.string().min(1),
  }),
  z.object({
    op: z.literal('createOpening'),
    opening: z.object({
      id: z.string().min(1).optional(),
      wall: ShellWallFaceSchema,
      type: z.enum(['window', 'door', 'garageDoor']),
      width: z.number().positive(),
      height: z.number().positive(),
      offset: z.number().nonnegative().optional(),
      position: z.enum(['center', 'left', 'right']).optional(),
      sillHeight: z.number().nonnegative().optional(),
      /** Owning story for multi-level shell openings. Defaults to primary level. */
      levelId: z.string().min(1).optional(),
    }),
  }),
  z.object({
    op: z.literal('createRoofPlane'),
    plane: z.object({
      id: z.string().min(1).optional(),
      parentId: z.string().min(1).optional(),
      pitch: z.number().positive(),
      role: z.string().optional(),
      face: z.string().optional(),
      vertices: z
        .array(z.object({ x: z.number(), y: z.number(), z: z.number() }))
        .min(3),
      materialId: z.string().optional(),
    }),
  }),
  z.object({
    op: z.literal('setProtectedEntities'),
    entityIds: z.array(z.string().min(1)),
    mode: z.enum(['replace', 'add', 'remove']).default('replace'),
  }),
  z.object({
    op: z.literal('protectFootprint'),
    protect: z.boolean(),
  }),
  z.object({
    op: z.literal('updateBuildingDimensions'),
    width: z.number().positive().optional(),
    depth: z.number().positive().optional(),
    wallHeight: z.number().positive().optional(),
  }),
  z.object({
    op: z.literal('updateRoof'),
    patch: ShellRoofSchema.partial(),
  }),
  z.object({
    op: z.literal('setRoofAssemblies'),
    assemblies: z.array(z.unknown()).min(1),
  }),
  z.object({
    op: z.literal('createRoofMass'),
    assemblyId: z.string().min(1).optional(),
    label: z.string().optional(),
    materialId: z.string().min(1).optional(),
    levelId: z.string().min(1).optional(),
    role: z.enum(['primary', 'lower']).optional(),
    coversExposedRegionId: z.string().min(1).optional(),
    generator: z.record(z.unknown()),
  }),
  z.object({
    op: z.literal('updateRoofMass'),
    assemblyId: z.string().min(1),
    massId: z.string().min(1),
    patch: z.record(z.unknown()),
  }),
  z.object({
    op: z.literal('deleteRoofMass'),
    assemblyId: z.string().min(1),
    massId: z.string().min(1),
  }),
  z.object({
    op: z.literal('createLevel'),
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    elevation: z.number().optional(),
    aboveLevelId: z.string().min(1).optional(),
    height: z.number().positive().optional(),
    footprintSource: z.enum(['shell', 'custom']).optional(),
  }),
  z.object({
    op: z.literal('updateLevel'),
    levelId: z.string().min(1),
    patch: z
      .object({
        name: z.string().min(1).optional(),
        elevation: z.number().optional(),
        height: z.number().positive().optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal('deleteLevel'),
    levelId: z.string().min(1),
    force: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('setLevelFootprint'),
    levelId: z.string().min(1),
    footprint: z.object({
      kind: z.literal('rect').optional(),
      center: z.object({ x: z.number(), y: z.number() }),
      width: z.number().positive(),
      depth: z.number().positive(),
    }),
    allowPrimary: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('updateLevelFootprint'),
    levelId: z.string().min(1),
    patch: z
      .object({
        center: z.object({ x: z.number(), y: z.number() }).optional(),
        width: z.number().positive().optional(),
        depth: z.number().positive().optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal('clearLevelFootprint'),
    levelId: z.string().min(1),
  }),
  z.object({
    op: z.literal('createStair'),
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    type: z.enum(['straight', 'lShape']).optional(),
    fromLevelId: z.string().min(1),
    toLevelId: z.string().min(1),
    origin: z.object({ x: z.number(), y: z.number() }),
    directionDeg: z.number().optional(),
    width: z.number().positive(),
    targetTreadDepth: z.number().positive().optional(),
    maxRiserHeight: z.number().positive().optional(),
    availableRun: z.number().positive().optional(),
    turn: z.enum(['left', 'right']).optional(),
    firstFlightRisers: z.number().int().positive().optional(),
    landingSize: z.number().positive().optional(),
    materialId: z.string().min(1).optional(),
  }),
  z.object({
    op: z.literal('updateStair'),
    stairId: z.string().min(1),
    patch: z
      .object({
        name: z.string().min(1).optional(),
        type: z.enum(['straight', 'lShape']).optional(),
        fromLevelId: z.string().min(1).optional(),
        toLevelId: z.string().min(1).optional(),
        origin: z.object({ x: z.number(), y: z.number() }).optional(),
        directionDeg: z.number().optional(),
        width: z.number().positive().optional(),
        targetTreadDepth: z.number().positive().optional(),
        maxRiserHeight: z.number().positive().optional(),
        availableRun: z.number().positive().optional(),
        turn: z.enum(['left', 'right']).optional(),
        firstFlightRisers: z.number().int().positive().optional(),
        landingSize: z.number().positive().optional(),
        materialId: z.string().min(1).optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal('deleteStair'),
    stairId: z.string().min(1),
    keepOpening: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('setDesignPreference'),
    preference: z.object({
      id: z.string().min(1).optional(),
      key: z.string().min(1),
      value: z.union([z.string(), z.number(), z.boolean(), z.record(z.unknown())]),
      source: z.enum(['user', 'ai', 'system']).default('ai'),
      notes: z.string().optional(),
    }),
  }),
  z.object({
    op: z.literal('createObject'),
    object: z.object({
      id: z.string().min(1).optional(),
      type: z.string().min(1),
      parentId: z.string().optional(),
      levelId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      width: z.number().positive().optional(),
      depth: z.number().positive().optional(),
      height: z.number().positive().optional(),
      rotationY: z.number().optional(),
      materialId: z.string().optional(),
      properties: z.record(z.unknown()).optional(),
    }),
  }),
]);

export type DesignOperation = z.infer<typeof DesignOperationSchema>;

export const DesignTransactionSchema = z.object({
  id: z.string().min(1).optional(),
  reason: z.string().optional(),
  operations: z.array(DesignOperationSchema).min(1).max(100),
});
export type DesignTransaction = z.infer<typeof DesignTransactionSchema>;
