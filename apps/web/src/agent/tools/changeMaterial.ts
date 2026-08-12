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

const changeMaterialParameters = z.object({
  objectId: z.string().min(1),
  materialId: z.string().min(1),
  finish: finishSchema.optional(),
  finishScope: z.enum(["object", "global"]).optional(),
});

export const changeMaterialTool = tool({
  name: "change_material",

  description:
    "Stage assigning a materialId to an existing object (compatibility tool). Prefer apply_material. Optional finish defaults to object-scoped clone so shared materials are not silently mutated. Does NOT commit a revision by itself.",

  parameters: changeMaterialParameters,

  execute: async (args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;

    homeDesignAgentDevLog("change_material_execute_start", {
      tool: "change_material",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "change_material", args, {
        validationFailure: code === "VALIDATION_FAILED" || code === "PROTECTED",
      });
      homeDesignAgentDevLog("change_material_execute_end", {
        tool: "change_material",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "change_material", args)
        : null;
      if (identical) return fail(identical);
      if (!context?.operation) {
        return fail({ error: "Agent operation is not initialized.", code: "NO_OPERATION" });
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
        });
      }
      const objectId = entity.id;
      const objectType = String(entity.type);
      if (OPENING_MATERIAL_TYPES.has(objectType)) {
        return fail({
          error: `Openings do not support materialId (type: ${objectType}).`,
          code: "UNSUPPORTED_OBJECT",
        });
      }
      if ((model.protectedEntityIds ?? []).includes(objectId)) {
        return fail({
          error: `Object is protected: ${objectId}`,
          code: "PROTECTED",
        });
      }
      if (!model.materials.some((m) => m.id === args.materialId)) {
        return fail({
          error: `Material not found: ${args.materialId}`,
          code: "MATERIAL_NOT_FOUND",
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
      const staged = await stageDesignOperations(
        context,
        built.operations,
        `Stage change_material ${objectId} → ${built.resultingMaterialId}`,
      );
      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code,
          validation: staged.validation,
        });
      }

      const afterMaterialId = objectMaterialId(staged.afterModel, objectId);
      recordModifySuccess(
        context.loopSafety,
        objectId,
        { ...args, objectId },
        { materialChanged: beforeMaterialId === afterMaterialId ? 0 : 1 },
        "change_material",
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
          materialId: afterMaterialId ?? null,
          material: materialSnapshot(staged.afterModel, afterMaterialId),
        },
        validation: staged.validation,
        operation: operationMeta(context),
      };

      homeDesignAgentDevLog("change_material_execute_end", {
        tool: "change_material",
        ok: true,
        objectId,
        strategy: built.strategy,
        baseRevision: staged.baseRevision,
        staged: true,
      });

      return result;
    } catch (error) {
      return fail({
        error: error instanceof Error ? error.message : "change_material failed",
        code: "CHANGE_MATERIAL_FAILED",
      });
    }
  },
});
