import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  DesignServiceError,
  getEntity,
  resolveSelectedEntity,
  summarizeEntity,
  type DesignOperation,
} from "@aihd/domain";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import {
  computeDeltas,
  extractCurrentNumericGeometry,
  guardModifyObject,
  proposedNumericPatch,
  recordModifySuccess,
  recordToolFailure,
} from "../loopSafety";
import {
  operationMeta,
  stageDesignOperations,
} from "../operation/agentOperation";
import { loadAgentModel } from "../project/loadAgentModel";

const OPENING_TYPES = new Set([
  "window",
  "exteriorDoor",
  "garageDoor",
  "opening",
  "door",
]);

const modifyObjectParameters = z.object({
  objectId: z.string().min(1),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  depth: z.number().positive().optional(),
  position: z
    .object({
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
    })
    .optional(),
  rotationY: z.number().optional(),
  materialId: z.string().min(1).optional(),
});

type ModifyArgs = z.infer<typeof modifyObjectParameters>;

function isOpeningType(type: string): boolean {
  return OPENING_TYPES.has(type);
}

function buildOperations(
  entityType: string,
  args: ModifyArgs,
): { operations: DesignOperation[]; error?: string } {
  const operations: DesignOperation[] = [];
  const geometry: Record<string, number> = {};

  if (args.width !== undefined) geometry.width = args.width;
  if (args.height !== undefined) geometry.height = args.height;

  if (isOpeningType(entityType)) {
    if (args.depth !== undefined) {
      return {
        operations: [],
        error: `Openings do not support depth edits (object type: ${entityType}).`,
      };
    }
    if (args.rotationY !== undefined) {
      return {
        operations: [],
        error: `Openings do not support rotationY edits (object type: ${entityType}).`,
      };
    }
    if (args.position) {
      if (args.position.z !== undefined) {
        return {
          operations: [],
          error: "Openings do not support z position. Use offset via position.x if needed.",
        };
      }
      if (args.position.x !== undefined) geometry.offset = args.position.x;
      if (args.position.y !== undefined) geometry.sillHeight = args.position.y;
    }
  } else {
    if (args.depth !== undefined) geometry.depth = args.depth;
    if (args.rotationY !== undefined) geometry.rotationY = args.rotationY;
    if (args.position) {
      if (args.position.x !== undefined) geometry.x = args.position.x;
      if (args.position.y !== undefined) geometry.y = args.position.y;
      if (args.position.z !== undefined) geometry.z = args.position.z;
    }
  }

  if (Object.keys(geometry).length > 0) {
    operations.push({
      op: "updateEntity",
      entityId: args.objectId,
      patch: { geometry },
    });
  }

  if (args.materialId !== undefined) {
    operations.push({
      op: "setMaterial",
      entityId: args.objectId,
      materialId: args.materialId,
    });
  }

  if (operations.length === 0) {
    return {
      operations: [],
      error:
        "No supported modifications provided. Supply width, height, depth, position, rotationY, and/or materialId.",
    };
  }

  return { operations };
}

export const modifyObjectTool = tool({
  name: "modify_object",

  description:
    "Stage a modification to an existing object in the agent operation working model (size, position, rotationY, materialId). Openings use width/height and wall offset/sill via position.x/position.y. Does not create/delete objects and does NOT commit a permanent revision by itself — the run commits once at the end.",

  parameters: modifyObjectParameters,

  execute: async (args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;

    homeDesignAgentDevLog("modify_object_execute_start", {
      tool: "modify_object",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "modify_object", args, {
        validationFailure: code === "VALIDATION_FAILED",
      });
      homeDesignAgentDevLog("modify_object_execute_end", {
        tool: "modify_object",
        arguments: args,
        ok: false,
        ...payload,
      });
      return { success: false as const, ...payload };
    };

    try {
      if (!context?.operation) {
        return fail({
          error: "Agent operation is not initialized.",
          code: "NO_OPERATION",
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);
      const model = loaded.model;
      const baseRevision = loaded.revision;

      const entity =
        getEntity(model, args.objectId) ??
        resolveSelectedEntity(model, args.objectId);

      if (!entity) {
        return fail({
          error: `Object not found: ${args.objectId}`,
          code: "OBJECT_NOT_FOUND",
          projectId: context.projectId,
          objectId: args.objectId,
          baseRevision,
        });
      }

      const objectId = entity.id;
      const requestArgs = { ...args, objectId };
      const opening = isOpeningType(String(entity.type));
      const beforeNumeric = extractCurrentNumericGeometry(
        (entity.geometry ?? {}) as Record<string, unknown>,
      );
      const proposed = proposedNumericPatch({
        width: args.width,
        height: args.height,
        depth: args.depth,
        position: args.position,
        rotationY: args.rotationY,
        opening,
      });

      if (context.loopSafety) {
        const guard = guardModifyObject(
          context.loopSafety,
          objectId,
          beforeNumeric,
          proposed,
          requestArgs,
        );
        if (guard) {
          return fail({
            error: guard.error,
            code: guard.code,
            projectId: context.projectId,
            objectId,
            objectType: entity.type,
            baseRevision,
            before: summarizeEntity(entity),
          });
        }
      }

      if ((model.protectedEntityIds ?? []).includes(objectId)) {
        return fail({
          error: `Object is protected and cannot be modified: ${objectId}`,
          code: "PROTECTED",
          projectId: context.projectId,
          objectId,
          objectType: entity.type,
          baseRevision,
          before: summarizeEntity(entity),
        });
      }

      const built = buildOperations(String(entity.type), requestArgs);
      if (built.error) {
        return fail({
          error: built.error,
          code: "UNSUPPORTED_EDIT",
          projectId: context.projectId,
          objectId,
          objectType: entity.type,
          baseRevision,
          before: summarizeEntity(entity),
        });
      }

      const staged = await stageDesignOperations(
        context,
        built.operations,
        `Stage modify_object ${objectId}`,
      );
      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code,
          projectId: context.projectId,
          objectId,
          objectType: entity.type,
          baseRevision,
          before: summarizeEntity(entity),
          validation: staged.validation,
        });
      }

      const afterEntity =
        getEntity(staged.afterModel, objectId) ??
        resolveSelectedEntity(staged.afterModel, objectId);

      const deltas = computeDeltas(beforeNumeric, proposed);
      recordModifySuccess(context.loopSafety, objectId, requestArgs, deltas);

      const result = {
        success: true as const,
        staged: true as const,
        projectId: context.projectId,
        objectId,
        objectType: entity.type,
        baseRevision,
        before: summarizeEntity(entity),
        after: afterEntity ? summarizeEntity(afterEntity) : null,
        validation: staged.validation,
        operation: operationMeta(context),
      };

      homeDesignAgentDevLog("modify_object_execute_end", {
        tool: "modify_object",
        arguments: requestArgs,
        ok: true,
        projectId: context.projectId,
        objectId,
        objectType: entity.type,
        baseRevision,
        staged: true,
        validation: result.validation,
        before: result.before,
        after: result.after,
        operation: result.operation,
      });

      return result;
    } catch (error) {
      if (error instanceof DesignServiceError) {
        return fail({
          error: error.message,
          code: "VALIDATION_FAILED",
          validation: { ok: false, issues: error.issues },
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      return fail({
        error: message,
        code: /unauthor/i.test(message) ? "UNAUTHORIZED" : "MODIFY_FAILED",
        projectId: context?.projectId,
      });
    }
  },
});
