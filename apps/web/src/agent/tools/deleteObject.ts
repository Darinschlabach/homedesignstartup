import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  DesignServiceError,
  getEntity,
  isInteriorObjectType,
  listEntities,
  resolveSelectedEntity,
  summarizeEntity,
  type DesignOperation,
} from "@aihd/domain";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import {
  assertLoopNotBlocked,
  guardAgainstIdenticalFailure,
  recordToolFailure,
  recordToolSuccess,
} from "../loopSafety";
import {
  operationMeta,
  stageDesignOperations,
} from "../operation/agentOperation";
import { loadAgentModel } from "../project/loadAgentModel";

const SHELL_OR_OPENING_TYPES = new Set([
  "window",
  "exteriorDoor",
  "garageDoor",
  "opening",
  "door",
  "exteriorWall",
  "interiorWall",
  "wall",
  "floorSlab",
  "slab",
  "shell",
  "level",
  "space",
  "roofAssembly",
  "roofPlane",
  "ridge",
  "roof",
]);

const deleteObjectParameters = z
  .object({
    objectId: z
      .string()
      .min(1)
      .describe(
        "Id of the placed object to delete. Selection aliases (selected/this/it) resolve to the UI selection when available.",
      ),
  })
  .strict();

function resolveRequestedObjectId(
  raw: string | undefined,
  selectedEntityId: string | null | undefined,
): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return selectedEntityId ?? undefined;
  if (
    ["selected", "selection", "this", "that", "it"].includes(
      trimmed.toLowerCase(),
    )
  ) {
    return selectedEntityId ?? undefined;
  }
  return trimmed;
}

function findDependents(
  model: Parameters<typeof listEntities>[0],
  objectId: string,
) {
  return listEntities(model)
    .filter(
      (e) =>
        e.id !== objectId &&
        (e.parentId === objectId ||
          e.properties?.roomId === objectId ||
          (typeof e.properties?.parentId === "string" &&
            e.properties.parentId === objectId)),
    )
    .map((e) => ({
      id: e.id,
      type: e.type,
      parentId: e.parentId ?? null,
    }));
}

export const deleteObjectTool = tool({
  name: "delete_object",

  description:
    "Stage deletion of a supported placed object (furniture, cabinets, appliances, lights, etc.) from the current agent operation working model. Cannot delete walls, windows, doors, roof, or footprint — use delete_opening for shell openings. Does NOT commit a revision by itself.",

  parameters: deleteObjectParameters,

  execute: async (args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const requestedId = resolveRequestedObjectId(
      args.objectId,
      context?.selectedEntityId,
    );

    homeDesignAgentDevLog("delete_object_execute_start", {
      tool: "delete_object",
      arguments: {
        objectId: requestedId ?? null,
        providedObjectId: args.objectId ?? null,
      },
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(
        context?.loopSafety,
        "delete_object",
        { objectId: requestedId ?? args.objectId },
        {
          validationFailure:
            code === "VALIDATION_FAILED" ||
            code === "UNSUPPORTED_TYPE" ||
            code === "PROTECTED" ||
            code === "HAS_DEPENDENTS" ||
            code === "OBJECT_NOT_FOUND" ||
            code === "MISSING_OBJECT_ID",
        },
      );
      homeDesignAgentDevLog("delete_object_execute_end", {
        tool: "delete_object",
        arguments: { objectId: requestedId ?? args.objectId },
        ok: false,
        ...payload,
      });
      return { success: false as const, ...payload };
    };

    try {
      const blocked = assertLoopNotBlocked(context?.loopSafety);
      if (blocked) return fail(blocked);

      const identical = context?.loopSafety
        ? guardAgainstIdenticalFailure(context.loopSafety, "delete_object", {
            objectId: requestedId ?? args.objectId,
          })
        : null;
      if (identical) return fail(identical);

      if (!context?.operation) {
        return fail({
          error: "Agent operation is not initialized.",
          code: "NO_OPERATION",
        });
      }

      if (!requestedId) {
        return fail({
          error:
            "objectId is required (or select an entity / use a selection alias).",
          code: "MISSING_OBJECT_ID",
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);

      const entity =
        getEntity(loaded.model, requestedId) ??
        resolveSelectedEntity(loaded.model, requestedId);

      if (!entity) {
        return fail({
          error: `Object not found: ${requestedId}`,
          code: "OBJECT_NOT_FOUND",
          objectId: requestedId,
          projectId: loaded.projectId,
          baseRevision: loaded.revision,
          modelSource: loaded.source,
          dirty: loaded.dirty,
        });
      }

      const objectId = entity.id;
      const type = String(entity.type);

      if (!isInteriorObjectType(type) || SHELL_OR_OPENING_TYPES.has(type)) {
        return fail({
          error: `delete_object cannot remove type "${type}". Only placed interior/FF&E objects are deletable here. Use delete_opening for windows/doors; wall/roof/footprint tools come later.`,
          code: "UNSUPPORTED_TYPE",
          objectId,
          type,
          operation: operationMeta(context),
        });
      }

      if ((loaded.model.protectedEntityIds ?? []).includes(objectId)) {
        return fail({
          error: `Object is protected and cannot be deleted: ${objectId}`,
          code: "PROTECTED",
          objectId,
          type,
          operation: operationMeta(context),
        });
      }

      const dependents = findDependents(loaded.model, objectId);
      if (dependents.length > 0) {
        return fail({
          error: `Cannot delete ${objectId} because ${dependents.length} dependent entity(ies) still reference it. Remove or reparent dependents first.`,
          code: "HAS_DEPENDENTS",
          objectId,
          dependents,
          operation: operationMeta(context),
        });
      }

      const before = summarizeEntity(entity);
      const operation: DesignOperation = {
        op: "deleteEntity",
        entityId: objectId,
      };

      const staged = await stageDesignOperations(
        context,
        [operation],
        `Stage delete_object ${objectId}`,
      );

      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code,
          validation: staged.validation,
          objectId,
          operation: operationMeta(context),
        });
      }

      if (getEntity(staged.afterModel, objectId)) {
        return fail({
          error: "Object still present after staging deleteEntity.",
          code: "DELETE_FAILED",
          objectId,
        });
      }

      recordToolSuccess(context.loopSafety);

      const result = {
        success: true as const,
        staged: true as const,
        deleted: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        objectId,
        type,
        before,
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Deletion is staged only. Use inspect_project / render_preview to verify. Runtime commits once at the end.",
      };

      homeDesignAgentDevLog("delete_object_execute_end", {
        tool: "delete_object",
        arguments: { objectId },
        ok: true,
        objectId,
        type,
        baseRevision: staged.baseRevision,
        staged: true,
        operation: result.operation,
      });

      return result;
    } catch (error) {
      if (error instanceof DesignServiceError) {
        return fail({
          error: error.message,
          code: "VALIDATION_FAILED",
          validation: { ok: false, issues: error.issues },
          projectId: context?.projectId,
        });
      }
      return fail({
        error: error instanceof Error ? error.message : "delete_object failed",
        code: "DELETE_OBJECT_FAILED",
        projectId: context?.projectId,
      });
    }
  },
});
