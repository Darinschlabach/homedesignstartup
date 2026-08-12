import { z } from 'zod';
import {
  BuildingModelV1,
  BuildingModelV1Schema,
  ConstraintSchema,
  LevelSchema,
  MaterialSchema,
  OpeningSchema,
  RoofSchema,
  SlabSchema,
  SpaceSchema,
  StructureMemberSchema,
  Vec2Schema,
  WallSchema,
} from './building-model';
import {
  BuildingShellSchema,
  ShellOpeningSchema,
  ShellRoofSchema,
  addOpening as addShellOpeningFn,
  removeOpening as removeShellOpeningFn,
  syncShellToModel,
  updateBuildingDimensions as updateDimsFn,
  updateOpening as updateShellOpeningFn,
  updateRoof as updateRoofFn,
} from './shell';
import { DesignTransactionSchema } from './operations';
import { applyTransaction } from './design-service';
import { checkModelIntegrity } from './integrity';

const ReplaceModelOp = z.object({
  op: z.literal('replaceModel'),
  model: BuildingModelV1Schema,
});

const UpsertWallOp = z.object({
  op: z.literal('upsertWall'),
  wall: WallSchema,
});

const DeleteWallOp = z.object({
  op: z.literal('deleteWall'),
  wallId: z.string().min(1),
});

const UpsertSpaceOp = z.object({
  op: z.literal('upsertSpace'),
  space: SpaceSchema,
});

const DeleteSpaceOp = z.object({
  op: z.literal('deleteSpace'),
  spaceId: z.string().min(1),
});

const UpsertOpeningOp = z.object({
  op: z.literal('upsertOpening'),
  opening: OpeningSchema,
});

const DeleteOpeningOp = z.object({
  op: z.literal('deleteOpening'),
  openingId: z.string().min(1),
});

const UpsertLevelOp = z.object({
  op: z.literal('upsertLevel'),
  level: LevelSchema,
});

const UpsertRoofOp = z.object({
  op: z.literal('upsertRoof'),
  roof: RoofSchema,
});

const UpsertSlabOp = z.object({
  op: z.literal('upsertSlab'),
  slab: SlabSchema,
});

const UpsertStructureOp = z.object({
  op: z.literal('upsertStructure'),
  member: StructureMemberSchema,
});

const DeleteStructureOp = z.object({
  op: z.literal('deleteStructure'),
  memberId: z.string().min(1),
});

const UpsertMaterialOp = z.object({
  op: z.literal('upsertMaterial'),
  material: MaterialSchema,
});

const SetConstraintsOp = z.object({
  op: z.literal('setConstraints'),
  constraints: z.array(ConstraintSchema),
});

const MoveWallEndpointOp = z.object({
  op: z.literal('moveWallEndpoint'),
  wallId: z.string().min(1),
  endpoint: z.enum(['start', 'end']),
  point: Vec2Schema,
});

const UpdateMetaOp = z.object({
  op: z.literal('updateMeta'),
  patch: z
    .object({
      name: z.string().min(1).optional(),
      stories: z.number().int().positive().optional(),
      siteNotes: z.string().optional(),
      units: z.enum(['imperial', 'metric']).optional(),
    })
    .strict(),
});

/** High-level parametric shell ops — preferred for AI + live 3D engine. */
const UpdateBuildingDimensionsOp = z.object({
  op: z.literal('updateBuildingDimensions'),
  width: z.number().positive().optional(),
  depth: z.number().positive().optional(),
  wallHeight: z.number().positive().optional(),
  wallThickness: z.number().positive().optional(),
});

const UpdateRoofOp = z.object({
  op: z.literal('updateRoof'),
  patch: ShellRoofSchema.partial(),
});

const AddOpeningOp = z.object({
  op: z.literal('addOpening'),
  opening: ShellOpeningSchema,
});

const UpdateShellOpeningOp = z.object({
  op: z.literal('updateOpening'),
  openingId: z.string().min(1),
  patch: ShellOpeningSchema.partial().omit({ id: true }),
});

const RemoveOpeningOp = z.object({
  op: z.literal('removeOpening'),
  openingId: z.string().min(1),
});

const SetShellOp = z.object({
  op: z.literal('setShell'),
  shell: BuildingShellSchema,
});

const ApplyDesignTransactionOp = z.object({
  op: z.literal('applyDesignTransaction'),
  transaction: DesignTransactionSchema,
});

const SetProtectedEntitiesOp = z.object({
  op: z.literal('setProtectedEntities'),
  entityIds: z.array(z.string().min(1)),
  mode: z.enum(['replace', 'add', 'remove']).default('replace'),
});

export const BuildingMutationSchema = z.discriminatedUnion('op', [
  ReplaceModelOp,
  UpsertWallOp,
  DeleteWallOp,
  UpsertSpaceOp,
  DeleteSpaceOp,
  UpsertOpeningOp,
  DeleteOpeningOp,
  UpsertLevelOp,
  UpsertRoofOp,
  UpsertSlabOp,
  UpsertStructureOp,
  DeleteStructureOp,
  UpsertMaterialOp,
  SetConstraintsOp,
  MoveWallEndpointOp,
  UpdateMetaOp,
  UpdateBuildingDimensionsOp,
  UpdateRoofOp,
  AddOpeningOp,
  UpdateShellOpeningOp,
  RemoveOpeningOp,
  SetShellOp,
  ApplyDesignTransactionOp,
  SetProtectedEntitiesOp,
]);

export type BuildingMutation = z.infer<typeof BuildingMutationSchema>;

export const BuildingMutationBatchSchema = z.object({
  mutations: z.array(BuildingMutationSchema).min(1).max(100),
  reason: z.string().optional(),
});
export type BuildingMutationBatch = z.infer<typeof BuildingMutationBatchSchema>;

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const idx = items.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...items, item];
  const next = [...items];
  next[idx] = item;
  return next;
}

function deleteById<T extends { id: string }>(items: T[], id: string): T[] {
  return items.filter((x) => x.id !== id);
}

export function applyMutation(model: BuildingModelV1, mutation: BuildingMutation): BuildingModelV1 {
  switch (mutation.op) {
    case 'replaceModel':
      return mutation.model;
    case 'upsertWall':
      return { ...model, walls: upsertById(model.walls, mutation.wall) };
    case 'deleteWall':
      return {
        ...model,
        walls: deleteById(model.walls, mutation.wallId),
        openings: model.openings.filter((o) => o.wallId !== mutation.wallId),
      };
    case 'upsertSpace':
      return { ...model, spaces: upsertById(model.spaces, mutation.space) };
    case 'deleteSpace':
      return { ...model, spaces: deleteById(model.spaces, mutation.spaceId) };
    case 'upsertOpening':
      return { ...model, openings: upsertById(model.openings, mutation.opening) };
    case 'deleteOpening':
      return { ...model, openings: deleteById(model.openings, mutation.openingId) };
    case 'upsertLevel':
      return { ...model, levels: upsertById(model.levels, mutation.level) };
    case 'upsertRoof':
      return { ...model, roofs: upsertById(model.roofs, mutation.roof) };
    case 'upsertSlab':
      return { ...model, slabs: upsertById(model.slabs, mutation.slab) };
    case 'upsertStructure':
      return { ...model, structure: upsertById(model.structure, mutation.member) };
    case 'deleteStructure':
      return { ...model, structure: deleteById(model.structure, mutation.memberId) };
    case 'upsertMaterial':
      return { ...model, materials: upsertById(model.materials, mutation.material) };
    case 'setConstraints':
      return { ...model, constraints: mutation.constraints };
    case 'moveWallEndpoint': {
      const walls = model.walls.map((w) => {
        if (w.id !== mutation.wallId) return w;
        return mutation.endpoint === 'start'
          ? { ...w, start: mutation.point }
          : { ...w, end: mutation.point };
      });
      return { ...model, walls };
    }
    case 'updateMeta':
      return { ...model, meta: { ...model.meta, ...mutation.patch } };
    case 'updateBuildingDimensions':
      return updateDimsFn(model, {
        width: mutation.width,
        depth: mutation.depth,
        wallHeight: mutation.wallHeight,
        wallThickness: mutation.wallThickness,
      });
    case 'updateRoof':
      return updateRoofFn(model, mutation.patch);
    case 'addOpening':
      return addShellOpeningFn(model, mutation.opening);
    case 'updateOpening':
      return updateShellOpeningFn(model, mutation.openingId, mutation.patch);
    case 'removeOpening':
      return removeShellOpeningFn(model, mutation.openingId);
    case 'setShell':
      return syncShellToModel(model, mutation.shell);
    case 'applyDesignTransaction':
      return applyTransaction(model, mutation.transaction);
    case 'setProtectedEntities':
      return applyTransaction(model, {
        reason: 'Set protected entities',
        operations: [
          {
            op: 'setProtectedEntities',
            entityIds: mutation.entityIds,
            mode: mutation.mode,
          },
        ],
      });
    default: {
      const _exhaustive: never = mutation;
      return _exhaustive;
    }
  }
}

export function applyMutations(
  model: BuildingModelV1,
  mutations: BuildingMutation[],
): BuildingModelV1 {
  return mutations.reduce((acc, m) => applyMutation(acc, m), model);
}

export function validateModel(model: unknown): BuildingModelV1 {
  return BuildingModelV1Schema.parse(model);
}

export class MutationValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = 'MutationValidationError';
  }
}

export function applyAndValidate(
  model: BuildingModelV1,
  mutations: BuildingMutation[],
): BuildingModelV1 {
  const next = applyMutations(model, mutations);
  const parsed = BuildingModelV1Schema.safeParse(next);
  if (!parsed.success) {
    throw new MutationValidationError(
      'Building model failed validation after mutations',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  const integrity = checkModelIntegrity(parsed.data);
  if (integrity.length > 0) {
    throw new MutationValidationError('Building model failed integrity checks', integrity);
  }
  return parsed.data;
}

export { checkModelIntegrity } from './integrity';
