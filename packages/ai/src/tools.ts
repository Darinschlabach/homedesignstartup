import { tool } from 'ai';
import { z } from 'zod';
import {
  BuildingMutationBatchSchema,
  BuildingModelV1,
  ConstraintSchema,
  DesignServiceError,
  DesignTransactionSchema,
  ShellOpeningSchema,
  ShellRoofSchema,
  ShellWallFaceSchema,
  addConvenienceOpening,
  appendDesignHistory,
  applyAndValidate,
  applyDesignOperations,
  applyTransaction,
  checkClearance,
  createBayBuilding,
  createRectangularShell,
  detectCollision,
  ensureDesignShell,
  getMeasurements,
  getObject,
  getProjectState,
  getRoom,
  getScene,
  measureDistance,
  queryDesign,
  resolveSelectedEntity,
  summarizeBuilding,
  summarizeEntity,
  validateLayout,
} from '@aihd/domain';

const OpeningPositionSchema = z.enum(['center', 'left', 'right']);

const ConvenienceOpeningArgsSchema = z.object({
  wall: ShellWallFaceSchema,
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  sillHeight: z.number().nonnegative().optional(),
  position: OpeningPositionSchema.optional(),
  offset: z.number().nonnegative().optional(),
  id: z.string().min(1).optional(),
});

function requirePlacement(args: z.infer<typeof ConvenienceOpeningArgsSchema>) {
  if (args.position == null && args.offset == null) {
    throw new Error('Provide position (center|left|right) or offset in feet.');
  }
  return args;
}

function toolError(error: unknown) {
  if (error instanceof DesignServiceError) {
    return { ok: false as const, error: error.message, issues: error.issues };
  }
  return {
    ok: false as const,
    error: error instanceof Error ? error.message : 'Design operation failed',
  };
}

async function commitModelWithHistory(
  ctx: {
    getModel: () => BuildingModelV1;
    commitModel: (model: BuildingModelV1, reason?: string) => Promise<void> | void;
    transactionId?: string;
  },
  model: BuildingModelV1,
  reason: string,
  operationCount = 1,
) {
  const withHistory = appendDesignHistory(model, {
    transactionId: ctx.transactionId,
    reason,
    summary: reason,
    operationCount,
  });
  const next = applyAndValidate(withHistory, [{ op: 'replaceModel', model: withHistory }]);
  await ctx.commitModel(next, reason);
  return summarizeBuilding(next, undefined);
}

export function createDesignTools(ctx: {
  getModel: () => BuildingModelV1;
  commitModel: (model: BuildingModelV1, reason?: string) => Promise<void> | void;
  enqueueJob?: (type: 'render' | 'normalize', payload?: Record<string, unknown>) => Promise<string> | string;
  undoLastChange?: () => Promise<{ model: BuildingModelV1; revision: number } | null> | {
    model: BuildingModelV1;
    revision: number;
  } | null;
  selectedEntityId?: string | null;
  transactionId?: string;
}) {
  const selectedId = () => ctx.selectedEntityId ?? null;

  return {
    // —— Inspect ——
    getProjectState: tool({
      description:
        'Load the complete relevant Project Design Model: shell, rooms, walls, openings, roof, interiors, materials, constraints, preferences, selection.',
      parameters: z.object({}),
      execute: async () => getProjectState(ctx.getModel(), selectedId()),
    }),

    getScene: tool({
      description:
        'Get derived 3D descriptors (slab, walls, roofs, openings, interiors) from the project model — not live Three.js objects.',
      parameters: z.object({}),
      execute: async () => getScene(ctx.getModel()),
    }),

    getRoom: tool({
      description: 'Get a room/space by id including contained objects.',
      parameters: z.object({ roomId: z.string().min(1) }),
      execute: async ({ roomId }) => getRoom(ctx.getModel(), roomId) ?? { error: 'Room not found' },
    }),

    getObject: tool({
      description: 'Get one design entity/object by id (defaults to selected entity).',
      parameters: z.object({ objectId: z.string().min(1).optional() }),
      execute: async ({ objectId }) => {
        const id = objectId ?? selectedId();
        if (!id) return { error: 'No objectId and nothing selected' };
        return getObject(ctx.getModel(), id) ?? { error: 'Object not found' };
      },
    }),

    getMeasurements: tool({
      description: 'Get footprint and count measurements for the current design.',
      parameters: z.object({}),
      execute: async () => getMeasurements(ctx.getModel()),
    }),

    queryDesign: tool({
      description: 'Legacy alias for architectural design context (prefer getProjectState).',
      parameters: z.object({}),
      execute: async () => queryDesign(ctx.getModel(), selectedId()),
    }),

    getBuildingSummary: tool({
      description: 'Compact building summary.',
      parameters: z.object({}),
      execute: async () => summarizeBuilding(ctx.getModel(), selectedId()),
    }),

    // —— Reasoning / dialogue ——
    askClarifyingQuestion: tool({
      description: 'Ask when a required architectural choice is missing. Also write the question in your reply.',
      parameters: z.object({
        question: z.string().min(1),
        options: z.array(z.string()).optional(),
      }),
      execute: async ({ question, options }) => ({ question, options: options ?? [] }),
    }),

    createDesignPlan: tool({
      description:
        'For open-ended creative intent, produce a structured strategy WITHOUT applying it. Then execute with general tools. Never maps to hard-coded style presets.',
      parameters: z.object({
        intent: z.string().min(1),
        preserveFootprint: z.boolean().optional(),
        preservePlumbing: z.boolean().optional(),
        preserveCabinetryLayout: z.boolean().optional(),
        steps: z
          .array(
            z.object({
              goal: z.string(),
              targetEntityIds: z.array(z.string()).optional(),
              suggestedTools: z.array(z.string()).optional(),
            }),
          )
          .min(1),
        notes: z.string().optional(),
      }),
      execute: async (plan) => {
        const selected = resolveSelectedEntity(ctx.getModel(), selectedId());
        return {
          ok: true,
          plan,
          selected: selected ? summarizeEntity(selected) : null,
          next: 'Execute with createObject/moveObject/resizeObject/changeMaterial/applyDesignTransaction/etc. Call protectFootprint if preserveFootprint is true.',
        };
      },
    }),

    // —— General object ops ——
    createObject: tool({
      description:
        'Create a design object/entity (cabinet, countertop, appliance, light, furniture, island, panel, shelf, etc.) with transform in feet.',
      parameters: z.object({
        type: z
          .string()
          .min(1)
          .describe('e.g. baseCabinet, wallCabinet, countertop, island, appliance, light, furniture'),
        id: z.string().optional(),
        parentId: z.string().optional(),
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
      execute: async (object) => {
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'createObject', object },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Created ${object.type}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    deleteObject: tool({
      description: 'Delete an object/entity by id (defaults to selection).',
      parameters: z.object({ objectId: z.string().optional() }),
      execute: async ({ objectId }) => {
        const id = objectId ?? selectedId();
        if (!id) return { ok: false, error: 'No objectId and nothing selected' };
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'deleteEntity', entityId: id },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Deleted ${id}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    duplicateObject: tool({
      description: 'Duplicate an object/entity by id.',
      parameters: z.object({
        objectId: z.string().optional(),
        newId: z.string().optional(),
      }),
      execute: async ({ objectId, newId }) => {
        const id = objectId ?? selectedId();
        if (!id) return { ok: false, error: 'No objectId and nothing selected' };
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'duplicateEntity', entityId: id, newId },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Duplicated ${id}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    moveObject: tool({
      description:
        'Move an object. Use delta x/y/z feet for placed objects, or delta.offset for openings along a wall. Defaults to selection.',
      parameters: z.object({
        objectId: z.string().optional(),
        delta: z.object({
          x: z.number().optional(),
          y: z.number().optional(),
          z: z.number().optional(),
          offset: z.number().optional(),
        }),
      }),
      execute: async ({ objectId, delta }) => {
        const id = objectId ?? selectedId();
        if (!id) return { ok: false, error: 'No objectId and nothing selected' };
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'moveEntity', entityId: id, delta },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Moved ${id}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    rotateObject: tool({
      description: 'Rotate a placed object about Y (degrees). Defaults to selection.',
      parameters: z.object({
        objectId: z.string().optional(),
        rotationY: z.number(),
        absolute: z.boolean().optional().describe('If true, set absolute rotation; else add delta'),
      }),
      execute: async ({ objectId, rotationY, absolute }) => {
        const id = objectId ?? selectedId();
        if (!id) return { ok: false, error: 'No objectId and nothing selected' };
        const ent = resolveSelectedEntity(ctx.getModel(), id);
        if (!ent) return { ok: false, error: 'Object not found' };
        const current = Number(ent.geometry.rotationY ?? 0);
        const nextRot = absolute ? rotationY : current + rotationY;
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            {
              op: 'updateEntity',
              entityId: id,
              patch: { geometry: { rotationY: nextRot } },
            },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Rotated ${id}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    resizeObject: tool({
      description:
        'Resize an object. Dimensions depend on type (width/depth/height, pitch for roofs, length for walls). Defaults to selection.',
      parameters: z.object({
        objectId: z.string().optional(),
        dimensions: z.record(z.number()),
      }),
      execute: async ({ objectId, dimensions }) => {
        const id = objectId ?? selectedId();
        if (!id) return { ok: false, error: 'No objectId and nothing selected' };
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'resizeEntity', entityId: id, dimensions },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Resized ${id}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    changeMaterial: tool({
      description: 'Assign materialId on an object/entity.',
      parameters: z.object({
        objectId: z.string().optional(),
        materialId: z.string().min(1),
      }),
      execute: async ({ objectId, materialId }) => {
        const id = objectId ?? selectedId();
        if (!id) return { ok: false, error: 'No objectId and nothing selected' };
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'setMaterial', entityId: id, materialId },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Material on ${id}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    changeColor: tool({
      description:
        'Upsert a material with a hex color and optionally assign it to an object. Creates/updates materials on the project model.',
      parameters: z.object({
        materialId: z.string().min(1).optional(),
        name: z.string().optional(),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        category: z.enum(['wall', 'roof', 'floor', 'trim', 'structure']).optional(),
        objectId: z.string().optional(),
      }),
      execute: async (input) => {
        const materialId = input.materialId ?? `mat-${Date.now().toString(36)}`;
        let next = applyAndValidate(ctx.getModel(), [
          {
            op: 'upsertMaterial',
            material: {
              id: materialId,
              name: input.name ?? materialId,
              category: input.category ?? 'trim',
              color: input.color,
              roughness: 0.7,
              metalness: 0,
            },
          },
        ]);
        const objectId = input.objectId ?? selectedId();
        if (objectId) {
          next = applyDesignOperations(next, [
            { op: 'setMaterial', entityId: objectId, materialId },
          ]);
        }
        return {
          ok: true,
          materialId,
          summary: await commitModelWithHistory(ctx, next, `Changed color ${input.color}`),
        };
      },
    }),

    changeTexture: tool({
      description:
        'Record a texture/finish preference on an object properties (finishKey). Full texture maps come later; this stores structured finish intent.',
      parameters: z.object({
        objectId: z.string().optional(),
        finishKey: z.string().min(1),
        finishLabel: z.string().optional(),
      }),
      execute: async ({ objectId, finishKey, finishLabel }) => {
        const id = objectId ?? selectedId();
        if (!id) return { ok: false, error: 'No objectId and nothing selected' };
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            {
              op: 'updateEntity',
              entityId: id,
              patch: {
                properties: { finishKey, finishLabel: finishLabel ?? finishKey },
              },
            },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Finish on ${id}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    // —— Cabinetry / kitchen convenience (still general; AI chooses when) ——
    createCabinet: tool({
      description: 'Create a cabinet object (base/wall/tall). General geometry tool — not a style preset.',
      parameters: z.object({
        kind: z.enum(['base', 'wall', 'tall']).default('base'),
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
        width: z.number().positive().optional(),
        depth: z.number().positive().optional(),
        height: z.number().positive().optional(),
        rotationY: z.number().optional(),
        properties: z.record(z.unknown()).optional(),
      }),
      execute: async (input) => {
        const type =
          input.kind === 'wall'
            ? 'wallCabinet'
            : input.kind === 'tall'
              ? 'tallCabinet'
              : 'baseCabinet';
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            {
              op: 'createObject',
              object: {
                type,
                x: input.x,
                y: input.y,
                z: input.z,
                width: input.width,
                depth: input.depth,
                height: input.height,
                rotationY: input.rotationY,
                properties: input.properties,
              },
            },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Created ${type}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    modifyCabinet: tool({
      description: 'Update cabinet geometry/properties by id.',
      parameters: z.object({
        objectId: z.string().min(1),
        geometry: z.record(z.unknown()).optional(),
        properties: z.record(z.unknown()).optional(),
        materialId: z.string().optional(),
      }),
      execute: async ({ objectId, geometry, properties, materialId }) => {
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            {
              op: 'updateEntity',
              entityId: objectId,
              patch: { geometry, properties, materialId },
            },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Modified cabinet ${objectId}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    createPanel: tool({
      description: 'Create a panel object.',
      parameters: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
        width: z.number().positive().optional(),
        depth: z.number().positive().optional(),
        height: z.number().positive().optional(),
        rotationY: z.number().optional(),
        properties: z.record(z.unknown()).optional(),
      }),
      execute: async (object) => {
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'createObject', object: { type: 'panel', ...object } },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, 'Created panel'),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    createShelf: tool({
      description: 'Create a shelf object.',
      parameters: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
        width: z.number().positive().optional(),
        depth: z.number().positive().optional(),
        height: z.number().positive().optional(),
        rotationY: z.number().optional(),
      }),
      execute: async (object) => {
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            {
              op: 'createObject',
              object: { type: 'shelf', height: object.height ?? 0.1, ...object },
            },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, 'Created shelf'),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    createDoor: tool({
      description: 'Create an exterior door opening on a wall, or a cabinetDoor object if cabinetId is set.',
      parameters: z.object({
        wall: ShellWallFaceSchema.optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        position: OpeningPositionSchema.optional(),
        offset: z.number().nonnegative().optional(),
        cabinetId: z.string().optional(),
      }),
      execute: async (input) => {
        try {
          if (input.cabinetId) {
            const next = applyDesignOperations(ctx.getModel(), [
              {
                op: 'createObject',
                object: {
                  type: 'cabinetDoor',
                  parentId: input.cabinetId,
                  width: input.width ?? 1.5,
                  height: input.height ?? 2.5,
                  depth: 0.1,
                  properties: { parentCabinetId: input.cabinetId },
                },
              },
            ]);
            return {
              ok: true,
              summary: await commitModelWithHistory(ctx, next, 'Created cabinet door'),
            };
          }
          if (!input.wall) return { ok: false, error: 'wall is required for exterior doors' };
          const args = requirePlacement({
            wall: input.wall,
            width: input.width,
            height: input.height,
            position: input.position,
            offset: input.offset,
          });
          const next = addConvenienceOpening(ctx.getModel(), {
            type: 'door',
            ...args,
          });
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, 'Created exterior door'),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    createDrawer: tool({
      description: 'Create a drawer object, optionally parented to a cabinet.',
      parameters: z.object({
        cabinetId: z.string().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        depth: z.number().positive().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
      }),
      execute: async (input) => {
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            {
              op: 'createObject',
              object: {
                type: 'drawer',
                parentId: input.cabinetId,
                width: input.width ?? 2,
                height: input.height ?? 0.6,
                depth: input.depth ?? 1.8,
                x: input.x,
                y: input.y,
                z: input.z,
              },
            },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, 'Created drawer'),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    createCountertop: tool({
      description: 'Create a countertop object.',
      parameters: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
        width: z.number().positive().optional(),
        depth: z.number().positive().optional(),
        height: z.number().positive().optional(),
        rotationY: z.number().optional(),
        materialId: z.string().optional(),
      }),
      execute: async (object) => {
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'createObject', object: { type: 'countertop', ...object } },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, 'Created countertop'),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    createBacksplash: tool({
      description: 'Create a backsplash panel object.',
      parameters: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        depth: z.number().positive().optional(),
        rotationY: z.number().optional(),
      }),
      execute: async (object) => {
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            {
              op: 'createObject',
              object: {
                type: 'backsplash',
                height: object.height ?? 1.5,
                depth: object.depth ?? 0.05,
                y: object.y ?? 3,
                ...object,
              },
            },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, 'Created backsplash'),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    createAppliance: tool({
      description: 'Create an appliance object (refrigerator, range, dishwasher, etc. via properties.kind).',
      parameters: z.object({
        kind: z.string().min(1),
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
        width: z.number().positive().optional(),
        depth: z.number().positive().optional(),
        height: z.number().positive().optional(),
        rotationY: z.number().optional(),
      }),
      execute: async (input) => {
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            {
              op: 'createObject',
              object: {
                type: 'appliance',
                x: input.x,
                y: input.y,
                z: input.z,
                width: input.width ?? 3,
                depth: input.depth ?? 2.5,
                height: input.height ?? 3,
                rotationY: input.rotationY,
                properties: { kind: input.kind, plumbingCritical: ['sink', 'dishwasher', 'range'].includes(input.kind) },
              },
            },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Created appliance ${input.kind}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    createLight: tool({
      description: 'Create a light fixture object.',
      parameters: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
        width: z.number().positive().optional(),
        depth: z.number().positive().optional(),
        height: z.number().positive().optional(),
        properties: z.record(z.unknown()).optional(),
      }),
      execute: async (object) => {
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            {
              op: 'createObject',
              object: {
                type: 'light',
                y: object.y ?? 8,
                width: object.width ?? 0.5,
                depth: object.depth ?? 0.5,
                height: object.height ?? 0.5,
                ...object,
              },
            },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, 'Created light'),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    changeDoorStyle: tool({
      description: 'Set doorStyle property on a cabinet or door object (agent-chosen style string, not a preset applicator).',
      parameters: z.object({
        objectId: z.string().optional(),
        doorStyle: z.string().min(1),
      }),
      execute: async ({ objectId, doorStyle }) => {
        const id = objectId ?? selectedId();
        if (!id) return { ok: false, error: 'No objectId and nothing selected' };
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'updateEntity', entityId: id, patch: { properties: { doorStyle } } },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Door style on ${id}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    changeHardware: tool({
      description: 'Set hardware property on a cabinet/door object.',
      parameters: z.object({
        objectId: z.string().optional(),
        hardware: z.string().min(1),
      }),
      execute: async ({ objectId, hardware }) => {
        const id = objectId ?? selectedId();
        if (!id) return { ok: false, error: 'No objectId and nothing selected' };
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'updateEntity', entityId: id, patch: { properties: { hardware } } },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Hardware on ${id}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    changeCabinetMaterial: tool({
      description: 'Assign a material to a cabinet object.',
      parameters: z.object({
        objectId: z.string().min(1),
        materialId: z.string().min(1),
      }),
      execute: async ({ objectId, materialId }) => {
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'setMaterial', entityId: objectId, materialId },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Cabinet material ${objectId}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    changeCountertopMaterial: tool({
      description: 'Assign a material to a countertop object.',
      parameters: z.object({
        objectId: z.string().min(1),
        materialId: z.string().min(1),
      }),
      execute: async ({ objectId, materialId }) => {
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'setMaterial', entityId: objectId, materialId },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Countertop material ${objectId}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    // —— Analysis ——
    measureDistance: tool({
      description: 'Measure distance in feet between two points.',
      parameters: z.object({
        a: z.object({ x: z.number(), y: z.number().optional(), z: z.number().optional() }),
        b: z.object({ x: z.number(), y: z.number().optional(), z: z.number().optional() }),
      }),
      execute: async ({ a, b }) => measureDistance(a, b),
    }),

    checkClearance: tool({
      description: 'Check whether an object has required clearance from other interiors.',
      parameters: z.object({
        objectId: z.string().min(1),
        requiredClearanceFt: z.number().positive().default(3),
      }),
      execute: async ({ objectId, requiredClearanceFt }) =>
        checkClearance(ctx.getModel(), objectId, requiredClearanceFt),
    }),

    detectCollision: tool({
      description: 'Detect AABB collision between two objects.',
      parameters: z.object({
        objectIdA: z.string().min(1),
        objectIdB: z.string().min(1),
      }),
      execute: async ({ objectIdA, objectIdB }) =>
        detectCollision(ctx.getModel(), objectIdA, objectIdB),
    }),

    validateLayout: tool({
      description: 'Validate design schema issues and interior collisions (read-only).',
      parameters: z.object({}),
      execute: async () => validateLayout(ctx.getModel()),
    }),

    // —— Transactions / history ——
    applyDesignTransaction: tool({
      description: 'Apply multiple validated design operations atomically.',
      parameters: DesignTransactionSchema,
      execute: async (transaction) => {
        try {
          const next = applyTransaction(ctx.getModel(), transaction);
          return {
            ok: true,
            summary: await commitModelWithHistory(
              ctx,
              next,
              transaction.reason ?? 'Design transaction',
              transaction.operations.length,
            ),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    protectFootprint: tool({
      description: 'Protect or unprotect footprint so width/depth edits are blocked.',
      parameters: z.object({ protect: z.boolean() }),
      execute: async ({ protect }) => {
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'protectFootprint', protect },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(
              ctx,
              next,
              protect ? 'Protected footprint' : 'Unprotected footprint',
            ),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    setDesignPreference: tool({
      description: 'Store a soft design preference from conversation (not a style preset).',
      parameters: z.object({
        key: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean(), z.record(z.unknown())]),
        notes: z.string().optional(),
      }),
      execute: async (preference) => {
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            {
              op: 'setDesignPreference',
              preference: { ...preference, source: 'ai' },
            },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Preference ${preference.key}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    undoChange: tool({
      description: 'Undo the last AI design turn / revision (restores prior structured model).',
      parameters: z.object({ confirm: z.boolean().default(true) }),
      execute: async () => {
        if (!ctx.undoLastChange) return { ok: false, error: 'Undo unavailable' };
        const result = await ctx.undoLastChange();
        if (!result) return { ok: false, error: 'Nothing to undo' };
        return {
          ok: true,
          revision: result.revision,
          summary: summarizeBuilding(result.model, selectedId()),
        };
      },
    }),

    undoLastChange: tool({
      description: 'Alias of undoChange.',
      parameters: z.object({ confirm: z.boolean().default(true) }),
      execute: async () => {
        if (!ctx.undoLastChange) return { ok: false, error: 'Undo unavailable' };
        const result = await ctx.undoLastChange();
        if (!result) return { ok: false, error: 'Nothing to undo' };
        return {
          ok: true,
          revision: result.revision,
          summary: summarizeBuilding(result.model, selectedId()),
        };
      },
    }),

    renderPreview: tool({
      description:
        'Signal that the live 3D preview should refresh from the project model. Does not call photoreal APIs. Returns current scene descriptors.',
      parameters: z.object({}),
      execute: async () => ({
        ok: true,
        preview: 'live-3d',
        scene: getScene(ctx.getModel()),
        note: 'Client already updates from model SSE; photoreal enqueueRender is separate.',
      }),
    }),

    enqueueRender: tool({
      description: 'Enqueue a photoreal render job (separate from live 3D preview).',
      parameters: z.object({
        camera: z.enum(['front', 'corner', 'aerial']).default('corner'),
      }),
      execute: async ({ camera }) => {
        if (!ctx.enqueueJob) return { queued: false, reason: 'Job runner unavailable' };
        const jobId = await ctx.enqueueJob('render', { camera });
        return { queued: true, jobId };
      },
    }),

    // —— Building shell convenience (still general) ——
    updateBuildingDimensions: tool({
      description: 'Update building width/depth/wallHeight in feet.',
      parameters: z.object({
        width: z.number().positive().optional(),
        depth: z.number().positive().optional(),
        wallHeight: z.number().positive().optional(),
      }),
      execute: async (input) => {
        try {
          const seeded = ensureDesignShell(ctx.getModel());
          const next = applyDesignOperations(seeded, [
            { op: 'updateBuildingDimensions', ...input },
          ]);
          return await commitModelWithHistory(ctx, next, 'Updated building dimensions');
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    updateRoof: tool({
      description: 'Update parametric roof (type, pitch X/12, overhang, ridgeDirection).',
      parameters: z.object({
        type: z.enum(['gable', 'hip']).optional(),
        pitch: z.number().positive().optional(),
        overhang: z.number().nonnegative().optional(),
        ridgeDirection: z.enum(['width', 'depth']).optional(),
        patch: ShellRoofSchema.partial().optional(),
      }),
      execute: async (input) => {
        try {
          const patch = {
            ...(input.patch ?? {}),
            ...(input.type != null ? { type: input.type } : {}),
            ...(input.pitch != null ? { pitch: input.pitch } : {}),
            ...(input.overhang != null ? { overhang: input.overhang } : {}),
            ...(input.ridgeDirection != null ? { ridgeDirection: input.ridgeDirection } : {}),
          };
          const seeded = ensureDesignShell(ctx.getModel());
          const next = applyDesignOperations(seeded, [{ op: 'updateRoof', patch }]);
          return await commitModelWithHistory(ctx, next, 'Updated roof');
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    addWindow: tool({
      description: 'Add a window on a wall with position or offset.',
      parameters: ConvenienceOpeningArgsSchema,
      execute: async (raw) => {
        const args = requirePlacement(raw);
        const next = addConvenienceOpening(ctx.getModel(), { type: 'window', ...args });
        return commitModelWithHistory(ctx, next, 'Added window');
      },
    }),

    addExteriorDoor: tool({
      description: 'Add an exterior door on a wall.',
      parameters: ConvenienceOpeningArgsSchema,
      execute: async (raw) => {
        const args = requirePlacement(raw);
        const next = addConvenienceOpening(ctx.getModel(), { type: 'door', ...args });
        return commitModelWithHistory(ctx, next, 'Added exterior door');
      },
    }),

    addGarageDoor: tool({
      description: 'Add a garage door on a wall.',
      parameters: ConvenienceOpeningArgsSchema,
      execute: async (raw) => {
        const args = requirePlacement(raw);
        const next = addConvenienceOpening(ctx.getModel(), { type: 'garageDoor', ...args });
        return commitModelWithHistory(ctx, next, 'Added garage door');
      },
    }),

    addOpening: tool({
      description: 'Add a fully specified opening.',
      parameters: z.object({ opening: ShellOpeningSchema }),
      execute: async ({ opening }) => {
        const seeded = ensureDesignShell(ctx.getModel());
        const next = applyAndValidate(seeded, [{ op: 'addOpening', opening }]);
        return commitModelWithHistory(ctx, next, `Added ${opening.type}`);
      },
    }),

    updateOpening: tool({
      description: 'Update an opening by id.',
      parameters: z.object({
        openingId: z.string().min(1),
        patch: ShellOpeningSchema.partial().omit({ id: true }),
      }),
      execute: async ({ openingId, patch }) => {
        const seeded = ensureDesignShell(ctx.getModel());
        const next = applyAndValidate(seeded, [{ op: 'updateOpening', openingId, patch }]);
        return commitModelWithHistory(ctx, next, `Updated opening ${openingId}`);
      },
    }),

    removeOpening: tool({
      description: 'Remove an opening by id.',
      parameters: z.object({ openingId: z.string().min(1) }),
      execute: async ({ openingId }) => {
        const seeded = ensureDesignShell(ctx.getModel());
        const next = applyAndValidate(seeded, [{ op: 'removeOpening', openingId }]);
        return commitModelWithHistory(ctx, next, `Removed opening ${openingId}`);
      },
    }),

    createSimpleShell: tool({
      description: 'Replace model with a rectangular shell.',
      parameters: z.object({
        buildingType: z.enum(['home', 'barn', 'shop']),
        name: z.string().optional(),
        width: z.number().positive(),
        depth: z.number().positive(),
        wallHeight: z.number().positive().optional(),
      }),
      execute: async (input) => {
        const next = createRectangularShell(input);
        return commitModelWithHistory(ctx, next, `Created ${input.buildingType} shell`);
      },
    }),

    createBayBarnOrShop: tool({
      description: 'Create a bay barn/shop.',
      parameters: z.object({
        buildingType: z.enum(['barn', 'shop']),
        name: z.string().optional(),
        width: z.number().positive(),
        depth: z.number().positive(),
        bayCount: z.number().int().positive(),
        eaveHeight: z.number().positive().optional(),
      }),
      execute: async (input) => {
        const next = createBayBuilding(input);
        return commitModelWithHistory(
          ctx,
          next,
          `Created ${input.bayCount}-bay ${input.buildingType}`,
        );
      },
    }),

    setConstraints: tool({
      description: 'Replace textual design constraints.',
      parameters: z.object({ constraints: z.array(ConstraintSchema) }),
      execute: async ({ constraints }) => {
        const next = applyAndValidate(ctx.getModel(), [{ op: 'setConstraints', constraints }]);
        return commitModelWithHistory(ctx, next, 'Updated constraints');
      },
    }),

    proposeBuildingMutation: tool({
      description: 'Low-level mutation batch (prefer applyDesignTransaction / general tools).',
      parameters: BuildingMutationBatchSchema,
      execute: async ({ mutations, reason }) => {
        const next = applyAndValidate(ctx.getModel(), mutations);
        await ctx.commitModel(next, reason);
        return { ok: true, summary: summarizeBuilding(next, selectedId()), reason };
      },
    }),

    // Aliases matching agent vocabulary
    updateEntity: tool({
      description: 'Alias of low-level entity patch (prefer resizeObject/moveObject/changeMaterial).',
      parameters: z.object({
        entityId: z.string().optional(),
        patch: z.object({
          geometry: z.record(z.unknown()).optional(),
          properties: z.record(z.unknown()).optional(),
          materialId: z.string().nullable().optional(),
        }),
      }),
      execute: async ({ entityId, patch }) => {
        const id = entityId ?? selectedId();
        if (!id) return { ok: false, error: 'No entityId and nothing selected' };
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'updateEntity', entityId: id, patch },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Updated ${id}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    resizeEntity: tool({
      description: 'Alias of resizeObject.',
      parameters: z.object({
        entityId: z.string().optional(),
        dimensions: z.record(z.number()),
      }),
      execute: async ({ entityId, dimensions }) => {
        const id = entityId ?? selectedId();
        if (!id) return { ok: false, error: 'No entityId and nothing selected' };
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'resizeEntity', entityId: id, dimensions },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Resized ${id}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    moveEntity: tool({
      description: 'Alias of moveObject.',
      parameters: z.object({
        entityId: z.string().optional(),
        delta: z.object({
          x: z.number().optional(),
          y: z.number().optional(),
          z: z.number().optional(),
          offset: z.number().optional(),
        }),
      }),
      execute: async ({ entityId, delta }) => {
        const id = entityId ?? selectedId();
        if (!id) return { ok: false, error: 'No entityId and nothing selected' };
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'moveEntity', entityId: id, delta },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Moved ${id}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    deleteEntity: tool({
      description: 'Alias of deleteObject.',
      parameters: z.object({ entityId: z.string().optional() }),
      execute: async ({ entityId }) => {
        const id = entityId ?? selectedId();
        if (!id) return { ok: false, error: 'No entityId and nothing selected' };
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'deleteEntity', entityId: id },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Deleted ${id}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),

    setMaterial: tool({
      description: 'Alias of changeMaterial.',
      parameters: z.object({
        entityId: z.string().optional(),
        materialId: z.string().min(1),
      }),
      execute: async ({ entityId, materialId }) => {
        const id = entityId ?? selectedId();
        if (!id) return { ok: false, error: 'No entityId and nothing selected' };
        try {
          const next = applyDesignOperations(ctx.getModel(), [
            { op: 'setMaterial', entityId: id, materialId },
          ]);
          return {
            ok: true,
            summary: await commitModelWithHistory(ctx, next, `Material on ${id}`),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    }),
  };
}

export type DesignTools = ReturnType<typeof createDesignTools>;
