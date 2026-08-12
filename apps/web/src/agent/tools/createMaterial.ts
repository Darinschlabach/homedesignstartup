import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  generateMaterialId,
  MATERIAL_CAPABILITIES,
  materialPublicView,
  type DesignOperation,
} from "@aihd/domain";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import {
  assertLoopNotBlocked,
  guardAgainstIdenticalFailure,
  recordToolFailure,
} from "../loopSafety";
import {
  operationMeta,
  stageDesignOperations,
} from "../operation/agentOperation";
import { loadAgentModel } from "../project/loadAgentModel";

const createMaterialParameters = z.object({
  name: z.string().min(1),
  category: z.enum(["wall", "roof", "floor", "trim", "structure"]),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .describe("Base color as #RRGGBB"),
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  id: z
    .string()
    .min(1)
    .optional()
    .describe("Optional material id; generated if omitted"),
});

export const createMaterialTool = tool({
  name: "create_material",

  description:
    "Stage a NEW material definition into the current agent operation working model. Supported fields: id (optional), name, category, color, roughness, metalness. Does NOT create a permanent revision by itself — the run commits once at the end. Textures/opacity/normal maps are NOT supported.",

  parameters: createMaterialParameters,

  execute: async (args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;

    homeDesignAgentDevLog("create_material_execute_start", {
      tool: "create_material",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "create_material", args, {
        validationFailure:
          code === "VALIDATION_FAILED" || code === "MATERIAL_EXISTS",
      });
      homeDesignAgentDevLog("create_material_execute_end", {
        tool: "create_material",
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
        ? guardAgainstIdenticalFailure(
            context.loopSafety,
            "create_material",
            args,
          )
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

      const materialId = args.id?.trim() || generateMaterialId(args.name);
      if (loaded.model.materials.some((m) => m.id === materialId)) {
        return fail({
          error: `Material id already exists: ${materialId}`,
          code: "MATERIAL_EXISTS",
          materialId,
          capabilities: MATERIAL_CAPABILITIES,
          operation: operationMeta(context),
        });
      }

      const operation: DesignOperation = {
        op: "createMaterial",
        material: {
          id: materialId,
          name: args.name,
          category: args.category,
          color: args.color,
          ...(args.roughness != null ? { roughness: args.roughness } : {}),
          ...(args.metalness != null ? { metalness: args.metalness } : {}),
        },
      };

      const staged = await stageDesignOperations(
        context,
        [operation],
        `Stage create_material ${materialId}`,
      );

      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code,
          validation: staged.validation,
          operation: operationMeta(context),
          capabilities: MATERIAL_CAPABILITIES,
        });
      }

      const created = staged.afterModel.materials.find((m) => m.id === materialId);
      if (!created) {
        return fail({
          error: "Material missing after staging createMaterial.",
          code: "CREATE_FAILED",
        });
      }

      const result = {
        success: true as const,
        staged: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        material: materialPublicView(created),
        savedProperties: {
          id: created.id,
          name: created.name,
          category: created.category,
          color: created.color,
          roughness: created.roughness,
          metalness: created.metalness,
        },
        capabilities: MATERIAL_CAPABILITIES,
        unsupportedNotStored: MATERIAL_CAPABILITIES.unsupportedFields,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Use apply_material with this material.id. Changes remain staged until the agent operation commits once.",
      };

      homeDesignAgentDevLog("create_material_execute_end", {
        tool: "create_material",
        arguments: { ...args, id: materialId },
        ok: true,
        materialId: created.id,
        baseRevision: staged.baseRevision,
        staged: true,
        operation: result.operation,
      });

      return result;
    } catch (error) {
      return fail({
        error:
          error instanceof Error ? error.message : "create_material failed",
        code: "CREATE_MATERIAL_FAILED",
        projectId: context?.projectId,
      });
    }
  },
});
