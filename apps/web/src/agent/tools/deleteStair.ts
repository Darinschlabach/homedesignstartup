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

const deleteStairParameters = z
  .object({
    stairId: z.string().min(1).describe("Stair to delete."),
  })
  .strict();

type Args = z.infer<typeof deleteStairParameters>;

export const deleteStairTool = tool({
  name: "delete_stair",

  description:
    "Stage deletion of a stair and its stair-owned upper-floor opening (closes the stairwell hole). Returns the previous stair state. Stages only.",

  parameters: deleteStairParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = scrubNulls(rawArgs as Record<string, unknown>) as Args;

    homeDesignAgentDevLog("delete_stair_execute_start", {
      tool: "delete_stair",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "delete_stair", args, {
        validationFailure: Boolean(code),
      });
      homeDesignAgentDevLog("delete_stair_execute_end", {
        tool: "delete_stair",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "delete_stair", args)
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

      const prior = listStairs(loaded.model).find((s) => s.id === args.stairId);
      if (!prior) {
        return fail({
          error: `Stair not found: ${args.stairId}`,
          code: "STAIR_MISSING",
          stairs: listStairs(loaded.model).map(summarizeStairBrief),
        });
      }

      const priorOpening =
        (loaded.model.floorOpenings ?? []).find(
          (o) => o.id === prior.floorOpeningId || o.stairId === prior.id,
        ) ?? null;

      const operations: DesignOperation[] = [
        {
          op: "deleteStair",
          stairId: args.stairId,
          // keepOpening intentionally omitted — agent always closes owned opening
        },
      ];

      const staged = await stageDesignOperations(
        context,
        operations,
        `Stage delete_stair ${args.stairId}`,
      );

      if (!staged.success) {
        const issue = staged.validation?.issues?.[0];
        return fail({
          error: staged.error,
          code: issue?.code ?? staged.code ?? "VALIDATION_FAILED",
          validation: staged.validation,
          conflicts: staged.validation?.issues ?? [],
          priorStair: summarizeStairBrief(prior),
          operation: operationMeta(context),
        });
      }

      const remainingOpenings = staged.afterModel.floorOpenings ?? [];
      const openingRemoved = priorOpening
        ? !remainingOpenings.some((o) => o.id === priorOpening.id)
        : true;

      recordToolSuccess(context.loopSafety);
      noteDependencyDomainAddressed(context.loopSafety, "stairs");

      const result = {
        success: true as const,
        staged: true as const,
        deleted: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        stairId: args.stairId,
        priorStair: summarizeStairDetail(loaded.model, prior),
        priorFloorOpening: priorOpening
          ? {
              id: priorOpening.id,
              levelId: priorOpening.levelId,
              stairId: priorOpening.stairId ?? null,
            }
          : null,
        floorOpeningRemoved: openingRemoved,
        afterStairs: listStairs(staged.afterModel).map(summarizeStairBrief),
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Stair deletion is staged (owned floor opening closed). Use inspect_stair / render_preview to confirm. Runtime commits once at the end.",
      };

      homeDesignAgentDevLog("delete_stair_execute_end", {
        tool: "delete_stair",
        arguments: args,
        ok: true,
        stairId: args.stairId,
        floorOpeningRemoved: openingRemoved,
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
        error: error instanceof Error ? error.message : "delete_stair failed",
        code: "DELETE_STAIR_FAILED",
      });
    }
  },
});
