import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  getEntity,
  MATERIAL_CAPABILITIES,
  resolveSelectedEntity,
  summarizeEntity,
} from "@aihd/domain";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import {
  assertLoopNotBlocked,
  guardAgainstIdenticalFailure,
  recordModifySuccess,
  recordToolFailure,
} from "../loopSafety";
import {
  operationMeta,
  stageDesignOperations,
} from "../operation/agentOperation";
import { loadAgentModel } from "../project/loadAgentModel";
import {
  buildApplyMaterialOperations,
  materialSnapshot,
  objectMaterialId,
  OPENING_MATERIAL_TYPES,
} from "./materialHelpers";

const finishSchema = z
  .object({
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    roughness: z.number().min(0).max(1).optional(),
    metalness: z.number().min(0).max(1).optional(),
  })
  .strict();

const applyMaterialParameters = z.object({
  objectId: z.string().min(1),
  materialId: z.string().min(1),
  finish: finishSchema
    .optional()
    .describe(
      "Optional color/roughness/metalness. By default these create a cloned object-specific material so shared materials are not silently changed. Use finishScope=global to edit the shared definition.",
    ),
  finishScope: z
    .enum(["object", "global"])
    .optional()
    .describe(
      "object (default): clone material when finish is provided. global: mutate the shared catalog entry for all users of materialId.",
    ),
});

export const applyMaterialTool = tool({
  name: "apply_material",

  description:
    "Stage applying a material to an existing editable object in the agent operation working model. Material may be existing, found, or newly created. Optional finish defaults to object-scoped clone (does not silently mutate shared materials). Does NOT commit a revision by itself.",

  parameters: applyMaterialParameters,

  execute: async (args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;

    homeDesignAgentDevLog("apply_material_execute_start", {
      tool: "apply_material",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "apply_material", args, {
        validationFailure: code === "VALIDATION_FAILED" || code === "PROTECTED",
      });
      homeDesignAgentDevLog("apply_material_execute_end", {
        tool: "apply_material",
        arguments: args,
        ok: false,
        ...payload,
      });
      return { success: false as const, ...payload };
    };

    try {
      const blocked = assertLoopNotBlocked(context?.loopSafety);
      if (blocked) return fail(blocked);

      const identical = context?.loopSafety
        ? guardAgainstIdenticalFailure(context.loopSafety, "apply_material", args)
        : null;
      if (identical) return fail(identical);

      if (!context?.operation) {
        return fail({
          error: "Agent operation is not initialized.",
          code: "NO_OPERATION",
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);
      const model = loaded.model;

      const entity =
        getEntity(model, args.objectId) ??
        resolveSelectedEntity(model, args.objectId);
      if (!entity) {
        return fail({
          error: `Object not found: ${args.objectId}`,
          code: "OBJECT_NOT_FOUND",
          objectId: args.objectId,
          operation: operationMeta(context),
        });
      }

      const objectId = entity.id;
      const objectType = String(entity.type);
      if (OPENING_MATERIAL_TYPES.has(objectType)) {
        return fail({
          error: `Openings do not support materialId (type: ${objectType}).`,
          code: "UNSUPPORTED_OBJECT",
          objectId,
          objectType,
        });
      }
      if ((model.protectedEntityIds ?? []).includes(objectId)) {
        return fail({
          error: `Object is protected: ${objectId}`,
          code: "PROTECTED",
          objectId,
          objectType,
        });
      }

      const material = model.materials.find((m) => m.id === args.materialId);
      if (!material) {
        return fail({
          error: `Material not found: ${args.materialId}`,
          code: "MATERIAL_NOT_FOUND",
          materialId: args.materialId,
          availableMaterialIds: model.materials.map((m) => m.id),
          capabilities: MATERIAL_CAPABILITIES,
        });
      }

      const beforeMaterialId = objectMaterialId(model, objectId);
      const built = buildApplyMaterialOperations({
        model,
        objectId,
        materialId: args.materialId,
        finish: args.finish,
        finishScope: args.finishScope,
      });
      if (built.operations.length === 0) {
        return fail({
          error: "Could not build material operations.",
          code: "UNSUPPORTED_EDIT",
        });
      }

      const staged = await stageDesignOperations(
        context,
        built.operations,
        `Stage apply_material ${objectId} → ${built.resultingMaterialId}`,
      );
      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code,
          validation: staged.validation,
          operation: operationMeta(context),
        });
      }

      const afterEntity =
        getEntity(staged.afterModel, objectId) ??
        resolveSelectedEntity(staged.afterModel, objectId);
      const afterMaterialId = objectMaterialId(staged.afterModel, objectId);

      recordModifySuccess(
        context.loopSafety,
        objectId,
        { ...args, objectId },
        { materialChanged: beforeMaterialId === afterMaterialId ? 0 : 1 },
        "apply_material",
      );

      const result = {
        success: true as const,
        staged: true as const,
        projectId: context.projectId,
        objectId,
        objectType,
        materialId: afterMaterialId,
        strategy: built.strategy,
        clonedFrom: built.clonedFrom ?? null,
        sharedMaterialBefore: built.sharedBefore,
        baseRevision: staged.baseRevision,
        before: {
          object: summarizeEntity(entity),
          materialId: beforeMaterialId ?? null,
          material: materialSnapshot(model, beforeMaterialId),
        },
        after: {
          object: afterEntity ? summarizeEntity(afterEntity) : null,
          materialId: afterMaterialId ?? null,
          material: materialSnapshot(staged.afterModel, afterMaterialId),
        },
        finishApplied: args.finish ?? null,
        finishScope: args.finishScope ?? (args.finish ? "object" : null),
        capabilities: MATERIAL_CAPABILITIES,
        validation: staged.validation,
        operation: operationMeta(context),
      };

      homeDesignAgentDevLog("apply_material_execute_end", {
        tool: "apply_material",
        ok: true,
        objectId,
        strategy: built.strategy,
        resultingMaterialId: afterMaterialId,
        baseRevision: staged.baseRevision,
        staged: true,
        operation: result.operation,
      });

      return result;
    } catch (error) {
      return fail({
        error: error instanceof Error ? error.message : "apply_material failed",
        code: "APPLY_MATERIAL_FAILED",
        projectId: context?.projectId,
      });
    }
  },
});
