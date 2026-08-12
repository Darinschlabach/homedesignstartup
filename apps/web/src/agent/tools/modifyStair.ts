import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import { DesignServiceError, type DesignOperation } from "@aihd/domain";
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
import { noteDependencyDomainAddressed } from "../planning/mutationGuard";
import {
  listStairs,
  scrubNulls,
  summarizeStairBrief,
  summarizeStairDetail,
} from "./stairShared";

const modifyStairParameters = z
  .object({
    stairId: z.string().min(1).describe("Stair to modify."),
    type: z
      .enum(["straight", "lShape"])
      .optional()
      .describe("Switch between supported geometric types only."),
    fromLevelId: z.string().min(1).optional(),
    toLevelId: z.string().min(1).optional(),
    originX: z.number().optional().describe("Plan X of first riser (feet)."),
    originZ: z
      .number()
      .optional()
      .describe("Plan depth of first riser (feet); maps to domain origin.y."),
    directionDeg: z.number().optional(),
    width: z.number().positive().optional(),
    availableRun: z.number().positive().optional(),
    targetTreadDepth: z.number().positive().optional(),
    maxRiserHeight: z.number().positive().optional(),
    turn: z.enum(["left", "right"]).optional(),
    firstFlightRisers: z.number().int().positive().optional(),
    landingSize: z.number().positive().optional(),
    materialId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  })
  .strict();

type Args = z.infer<typeof modifyStairParameters>;

export const modifyStairTool = tool({
  name: "modify_stair",

  description:
    "Stage safe updates to a stair's placement/configuration (type straight|lShape, origin, direction, width, run, tread/riser targets, L-turn/landing, material). Domain re-derives geometry and refreshes the owned floor opening. Returns structured conflicts on invalid geometry. Stages only.",

  parameters: modifyStairParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = scrubNulls(rawArgs as Record<string, unknown>) as Args;

    homeDesignAgentDevLog("modify_stair_execute_start", {
      tool: "modify_stair",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "modify_stair", args, {
        validationFailure: Boolean(code),
      });
      homeDesignAgentDevLog("modify_stair_execute_end", {
        tool: "modify_stair",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "modify_stair", args)
        : null;
      if (identical) return fail(identical);

      if (!context?.operation) {
        return fail({
          error: "Agent operation is not initialized.",
          code: "NO_OPERATION",
        });
      }

      const {
        stairId,
        originX,
        originZ,
        ...rest
      } = args;

      const hasOrigin = originX !== undefined || originZ !== undefined;
      const hasPatch =
        Object.values(rest).some((v) => v !== undefined) || hasOrigin;
      if (!hasPatch) {
        return fail({
          error: "Provide at least one field to modify.",
          code: "NO_PATCH",
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);

      const before = listStairs(loaded.model).find((s) => s.id === stairId);
      if (!before) {
        return fail({
          error: `Stair not found: ${stairId}`,
          code: "STAIR_MISSING",
          stairs: listStairs(loaded.model).map(summarizeStairBrief),
        });
      }

      const patch: Record<string, unknown> = { ...rest };
      if (hasOrigin) {
        patch.origin = {
          x: originX ?? before.origin.x,
          y: originZ ?? before.origin.y,
        };
      }

      const operations: DesignOperation[] = [
        {
          op: "updateStair",
          stairId,
          patch,
        },
      ];

      const staged = await stageDesignOperations(
        context,
        operations,
        `Stage modify_stair ${stairId}`,
      );

      if (!staged.success) {
        const issue = staged.validation?.issues?.[0];
        return fail({
          error: staged.error,
          code: issue?.code ?? staged.code ?? "VALIDATION_FAILED",
          validation: staged.validation,
          conflicts: staged.validation?.issues ?? [],
          geometryHint: issue?.details ?? null,
          before: summarizeStairBrief(before),
          operation: operationMeta(context),
        });
      }

      const after = listStairs(staged.afterModel).find((s) => s.id === stairId);

      recordToolSuccess(context.loopSafety);
      noteDependencyDomainAddressed(context?.loopSafety, "stairs");

      const result = {
        success: true as const,
        staged: true as const,
        modified: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        stairId,
        before: summarizeStairDetail(loaded.model, before),
        after: after
          ? summarizeStairDetail(staged.afterModel, after)
          : null,
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Stair edit is staged; geometry and floor opening were re-derived. Use inspect_stair / render_preview to evaluate.",
      };

      homeDesignAgentDevLog("modify_stair_execute_end", {
        tool: "modify_stair",
        arguments: args,
        ok: true,
        stairId,
        beforeType: before.type,
        afterType: after?.type ?? null,
        staged: true,
      });

      return result;
    } catch (error) {
      if (error instanceof DesignServiceError) {
        return fail({
          error: error.message,
          code: error.issues[0]?.code ?? "VALIDATION_FAILED",
          validation: { ok: false, issues: error.issues },
          conflicts: error.issues,
        });
      }
      return fail({
        error: error instanceof Error ? error.message : "modify_stair failed",
        code: "MODIFY_STAIR_FAILED",
      });
    }
  },
});
