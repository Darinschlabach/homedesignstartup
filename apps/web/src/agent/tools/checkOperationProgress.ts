import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import {
  assessOperationCompletion,
  suggestsStructuredPlanning,
  summarizePlan,
  type OutcomeStatus,
} from "../planning/taskPlan";
import { activeDependencyBlocks } from "../planning/mutationGuard";
import { operationMeta } from "../operation/agentOperation";
import { loadAgentModel } from "../project/loadAgentModel";

const checkOperationProgressParameters = z
  .object({
    markOutcomeSatisfied: z
      .array(
        z.object({
          outcomeId: z.string().min(1),
          status: z.enum(["satisfied", "blocked"]),
          blockedReason: z.string().nullable().optional(),
        }),
      )
      .nullable()
      .optional(),
  })
  .strict();

type Args = z.infer<typeof checkOperationProgressParameters>;

export const checkOperationProgressTool = tool({
  name: "check_operation_progress",

  description:
    "Read-only completion verification for the current staged operation. Compares the task plan, user constraints, and staged model state. Call before finishing coordinated requests. Returns pending/blocked outcomes, constraint violations, and whether commit is allowed. Optionally mark manual outcomes satisfied/blocked.",

  parameters: checkOperationProgressParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = (rawArgs ?? {}) as Args;
    const op = context?.operation;

    homeDesignAgentDevLog("check_operation_progress_execute", {
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    if (!op) {
      return {
        success: false,
        error: "Agent operation is not initialized.",
        code: "NO_OPERATION",
      };
    }

    if (args.markOutcomeSatisfied?.length && op.taskPlan) {
      for (const mark of args.markOutcomeSatisfied) {
        const outcome = op.taskPlan.requiredOutcomes.find(
          (o) => o.id === mark.outcomeId,
        );
        if (!outcome) continue;
        if (outcome.verification.type !== "manual" && mark.status === "satisfied") {
          continue;
        }
        outcome.status = mark.status as OutcomeStatus;
        outcome.blockedReason =
          mark.status === "blocked" ? mark.blockedReason ?? undefined : undefined;
      }
      op.taskPlan.updatedAt = new Date().toISOString();
    }

    const loaded = await loadAgentModel(context);
    if (!loaded.success) {
      return {
        success: false,
        error: loaded.error,
        code: loaded.code,
        projectId: loaded.projectId,
      };
    }

    op.runMetrics.progressCheckCount += 1;
    op.progressAcknowledged = true;

    const report = assessOperationCompletion({
      userMessage: op.userMessage,
      plan: op.taskPlan ?? null,
      baseModel: op.baseModel,
      workingModel: loaded.model,
      stagedOps: op.stagedOperations,
      metrics: op.runMetrics,
      replanSuggested: context?.loopSafety?.replanSuggested,
      replanReason: context?.loopSafety?.replanReason,
      blockedDependencies: activeDependencyBlocks(context?.loopSafety),
    });

    return {
      success: true,
      readyToCommit: report.readyToCommit,
      planningRequired: report.planningRequired,
      suggestedPlanningForRequest: suggestsStructuredPlanning(op.userMessage),
      hasPlan: report.hasPlan,
      plan: op.taskPlan ? summarizePlan(op.taskPlan) : null,
      progress: report,
      modelSource: loaded.source,
      dirty: op.dirty,
      stagedOperationCount: op.stagedOperations.length,
      operation: operationMeta(context),
      nextStep: report.readyToCommit
        ? "All planned outcomes and constraints are satisfied. You may finish — the runtime will commit once."
        : report.replanSuggested
          ? "Validation failures suggest replanning: inspect blocking dependencies, update order of operations, then continue."
          : "Continue working on pending outcomes or resolve constraint violations before finishing.",
    };
  },
});
