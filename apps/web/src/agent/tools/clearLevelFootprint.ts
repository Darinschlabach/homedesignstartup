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
import {
  footprintValidationSummary,
  listLevels,
  scrubNulls,
  summarizeLevelFootprint,
} from "./levelFootprintShared";
import { checkLevelFootprintTransition } from "../planning/toolApplicability";

const clearLevelFootprintParameters = z
  .object({
    levelId: z
      .string()
      .min(1)
      .describe("Level whose custom footprint should be cleared back to shell."),
  })
  .strict();

type Args = z.infer<typeof clearLevelFootprintParameters>;

export const clearLevelFootprintTool = tool({
  name: "clear_level_footprint",

  description:
    "Transition an existing custom level footprint back to shell-backed. PRECONDITION: inspect_level_footprint reports state=custom and validTransitions includes clear_level_footprint. A shell-backed level is already in the target state and should not call this tool. Stages only.",

  parameters: clearLevelFootprintParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = scrubNulls(rawArgs as Record<string, unknown>) as Args;

    homeDesignAgentDevLog("clear_level_footprint_execute_start", {
      tool: "clear_level_footprint",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "clear_level_footprint", args, {
        validationFailure: Boolean(code),
      });
      homeDesignAgentDevLog("clear_level_footprint_execute_end", {
        tool: "clear_level_footprint",
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
            "clear_level_footprint",
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

      const beforeLevel = listLevels(loaded.model).find(
        (l) => l.id === args.levelId,
      );
      if (!beforeLevel) {
        return fail({
          error: `Level not found: ${args.levelId}`,
          code: "LEVEL_MISSING",
        });
      }

      const before = summarizeLevelFootprint(loaded.model, beforeLevel);

      const applicability = checkLevelFootprintTransition(
        beforeLevel.footprintSource,
        "clear_level_footprint",
      );
      if (!applicability.applicable) {
        return {
          success: false as const,
          ...applicability,
          staged: false as const,
          projectId: context.projectId,
          levelId: args.levelId,
          footprintSource: beforeLevel.footprintSource,
          before,
          replanSuggested: false,
          nextStep: `Use ${applicability.validTransitions.join(" or ")}.`,
        };
      }

      const operations: DesignOperation[] = [
        { op: "clearLevelFootprint", levelId: args.levelId },
      ];

      const staged = await stageDesignOperations(
        context,
        operations,
        `Stage clear_level_footprint ${args.levelId}`,
      );

      if (!staged.success) {
        const issue = staged.validation?.issues?.[0];
        return fail({
          error: staged.error,
          code: issue?.code ?? staged.code ?? "VALIDATION_FAILED",
          validation: staged.validation,
          conflicts: staged.validation?.issues ?? [],
          before,
          operation: operationMeta(context),
        });
      }

      const afterLevel = listLevels(staged.afterModel).find(
        (l) => l.id === args.levelId,
      );
      const after = afterLevel
        ? summarizeLevelFootprint(staged.afterModel, afterLevel)
        : null;
      const validation = footprintValidationSummary(staged.afterModel);

      recordToolSuccess(context.loopSafety);

      const result = {
        success: true as const,
        staged: true as const,
        cleared: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        levelId: args.levelId,
        before,
        after,
        modelSource: "staged" as const,
        dirty: true as const,
        validation,
        conflicts: validation.errors,
        operation: operationMeta(context),
        nextStep:
          "Level restored to full shell footprint. Walls/slab regenerated to shell bounds. Use inspect_level_footprint / render_preview to confirm.",
      };

      homeDesignAgentDevLog("clear_level_footprint_execute_end", {
        tool: "clear_level_footprint",
        arguments: args,
        ok: true,
        levelId: args.levelId,
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
        error:
          error instanceof Error
            ? error.message
            : "clear_level_footprint failed",
        code: "CLEAR_LEVEL_FOOTPRINT_FAILED",
      });
    }
  },
});
