import {
  applyDesignOperations,
  BuildingModelV1Schema,
  checkModelIntegrity,
  DesignServiceError,
  ensureEntities,
  runDesignValidators,
  type BuildingModelV1,
  type DesignOperation,
} from "@aihd/domain";
import { commitRevision } from "@/lib/projects";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import {
  assessOperationCompletion,
  suggestsStructuredPlanning,
  type CompletionReport,
  type OperationRunMetrics,
  type TaskPlan,
} from "../planning/taskPlan";
import { activeDependencyBlocks } from "../planning/mutationGuard";
import { noteValidationFailure } from "../loopSafety";
import {
  assessCapabilityRequest,
  blockedCapabilityForOperations,
  type CapabilityAssessment,
} from "../planning/capabilityPolicy";

/** Serialize mutating stages so parallel tool calls cannot interleave writes. */
class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.tail;
    this.tail = prev.then(() => gate);
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }
}

export type AgentOperationValidation = {
  ok: boolean;
  issues: Array<{
    code: string;
    message: string;
    entityId?: string;
    details?: Record<string, unknown>;
  }>;
};

export type AgentOperationState = {
  operationId: string;
  projectId: string;
  userId: string;
  userMessage: string;
  baseRevision: number;
  baseRevisionId: string;
  /** Immutable snapshot at operation start — used for constraint verification. */
  baseModel: BuildingModelV1;
  workingModel: BuildingModelV1;
  stagedOperations: DesignOperation[];
  dirty: boolean;
  validation: AgentOperationValidation;
  committed: boolean;
  discarded: boolean;
  finalRevision?: number;
  finalRevisionId?: string;
  mutationMutex: AsyncMutex;
  taskPlan?: TaskPlan | null;
  runMetrics: OperationRunMetrics;
  /** Set when check_operation_progress confirms readiness. */
  progressAcknowledged: boolean;
  capabilityAssessment: CapabilityAssessment;
};

export function createAgentOperation(options: {
  operationId: string;
  projectId: string;
  userId: string;
  userMessage: string;
  baseRevision: number;
  baseRevisionId: string;
  baseModel: BuildingModelV1;
}): AgentOperationState {
  const capabilityAssessment = assessCapabilityRequest(options.userMessage);
  const capabilityPlan = capabilityAssessment.blocked.length
    ? {
        objective: options.userMessage,
        constraints: [],
        requiredOutcomes: capabilityAssessment.blocked.map((item, index) => ({
          id: `unsupported-${item.domain}-${index + 1}`,
          description: `Provide requested ${item.requested}`,
          domain: item.domain,
          verification: { type: "manual" as const },
          requirement: "required" as const,
          status: "blocked" as const,
          blockedReason: `UNSUPPORTED_CAPABILITY: ${item.requested}. Supported alternatives: ${item.supportedAlternatives.join(", ")}.`,
        })),
        affectedDomains: [...new Set(capabilityAssessment.blocked.map((item) => item.domain))],
        dependencies: [],
        completionChecks: ["No unsupported geometry mutation is staged."],
        planningRequired: true,
        updatedAt: new Date().toISOString(),
      }
    : null;
  return {
    operationId: options.operationId,
    projectId: options.projectId,
    userId: options.userId,
    userMessage: options.userMessage,
    baseRevision: options.baseRevision,
    baseRevisionId: options.baseRevisionId,
    baseModel: structuredClone(ensureEntities(options.baseModel)),
    workingModel: structuredClone(ensureEntities(options.baseModel)),
    stagedOperations: [],
    dirty: false,
    validation: { ok: true, issues: [] },
    committed: false,
    discarded: false,
    mutationMutex: new AsyncMutex(),
    taskPlan: capabilityPlan,
    runMetrics: {
      renderPreviewSuccessCount: 0,
      inspectProjectCount: 0,
      progressCheckCount: 0,
      validationFailureCount: 0,
      lastValidationCodes: [],
    },
    progressAcknowledged: false,
    capabilityAssessment,
  };
}

export function discardAgentOperation(context: DesignAgentContext): void {
  const op = context.operation;
  if (!op || op.committed) return;
  op.discarded = true;
  op.dirty = false;
  homeDesignAgentDevLog("agent_operation_discarded", {
    operationId: op.operationId,
    projectId: op.projectId,
    baseRevision: op.baseRevision,
    stagedOpCount: op.stagedOperations.length,
  });
}

export type StageSuccess = {
  success: true;
  baseRevision: number;
  staged: true;
  dirty: true;
  stagedOperationCount: number;
  beforeModel: BuildingModelV1;
  afterModel: BuildingModelV1;
  validation: AgentOperationValidation;
};

export type StageFailure = {
  success: false;
  error: string;
  code: string;
  validation?: AgentOperationValidation;
  baseRevision?: number;
};

/**
 * Apply DesignOperations to the server-side working model only.
 * Does not create a building_revisions row.
 */
export async function stageDesignOperations(
  context: DesignAgentContext,
  operations: DesignOperation[],
  reason: string,
): Promise<StageSuccess | StageFailure> {
  const op = context.operation;
  if (!op) {
    return {
      success: false,
      error: "Agent operation state is not initialized.",
      code: "NO_OPERATION",
    };
  }
  if (op.discarded) {
    return {
      success: false,
      error: "Agent operation was discarded.",
      code: "OPERATION_DISCARDED",
      baseRevision: op.baseRevision,
    };
  }
  if (op.committed) {
    return {
      success: false,
      error: "Agent operation already committed.",
      code: "OPERATION_COMMITTED",
      baseRevision: op.baseRevision,
    };
  }
  if (operations.length === 0) {
    return {
      success: false,
      error: "No design operations to stage.",
      code: "NO_OPERATIONS",
      baseRevision: op.baseRevision,
    };
  }

  const blockedCapability = blockedCapabilityForOperations(
    op.capabilityAssessment,
    operations,
  );
  if (blockedCapability) {
    return {
      success: false,
      error: `${blockedCapability.requested} is not supported. Supported alternatives: ${blockedCapability.supportedAlternatives.join(", ")}. Approximation requires explicit user authorization.`,
      code: "UNSUPPORTED_CAPABILITY",
      baseRevision: op.baseRevision,
    };
  }

  return op.mutationMutex.run(async () => {
    const beforeModel = structuredClone(op.workingModel);
    try {
      const afterModel = applyDesignOperations(
        op.workingModel,
        operations,
        reason,
      );
      op.workingModel = afterModel;
      op.stagedOperations.push(...operations);
      op.dirty = true;
      op.validation = { ok: true, issues: [] };

      homeDesignAgentDevLog("agent_operation_stage", {
        operationId: op.operationId,
        projectId: op.projectId,
        baseRevision: op.baseRevision,
        reason,
        stagedOpCount: op.stagedOperations.length,
        ops: operations.map((o) => o.op),
      });

      return {
        success: true as const,
        baseRevision: op.baseRevision,
        staged: true as const,
        dirty: true as const,
        stagedOperationCount: op.stagedOperations.length,
        beforeModel,
        afterModel,
        validation: op.validation,
      };
    } catch (error) {
      if (error instanceof DesignServiceError) {
        op.validation = { ok: false, issues: error.issues };
        op.runMetrics.validationFailureCount += 1;
        const code = error.issues[0]?.code;
        if (code) {
          op.runMetrics.lastValidationCodes = [
            code,
            ...op.runMetrics.lastValidationCodes,
          ].slice(0, 8);
          noteValidationFailure(context.loopSafety, code);
        }
        return {
          success: false as const,
          error: error.message,
          code: "VALIDATION_FAILED",
          validation: op.validation,
          baseRevision: op.baseRevision,
        };
      }
      throw error;
    }
  });
}

export type CommitOperationResult =
  | {
      success: true;
      skipped: true;
      reason: "no_changes" | "already_committed" | "discarded";
      baseRevision: number;
    }
  | {
      success: true;
      skipped: false;
      baseRevision: number;
      revisionAfter: number;
      revisionId: string;
      stagedOperationCount: number;
      liveUpdateEmitted: boolean;
      validation: AgentOperationValidation;
    }
  | {
      success: false;
      error: string;
      code: string;
      validation?: AgentOperationValidation;
      completionReport?: CompletionReport;
      baseRevision?: number;
    };

function validateWorkingModel(model: BuildingModelV1): AgentOperationValidation {
  const parsed = BuildingModelV1Schema.safeParse(model);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        code: "SCHEMA",
        message: `${i.path.join(".")}: ${i.message}`,
      })),
    };
  }
  const designIssues = runDesignValidators(parsed.data, []).filter(
    (i) => (i.severity ?? "error") === "error",
  );
  const integrity = checkModelIntegrity(parsed.data).map((message) => ({
    code: "INTEGRITY",
    message,
  }));
  const issues = [...designIssues, ...integrity];
  return { ok: issues.length === 0, issues };
}

/**
 * Internal finalization: one validation + one commit + one SSE emit.
 * Not a model-facing tool.
 */
export async function commitAgentOperation(
  context: DesignAgentContext,
): Promise<CommitOperationResult> {
  const op = context.operation;
  if (!op) {
    return {
      success: false,
      error: "Agent operation state is not initialized.",
      code: "NO_OPERATION",
    };
  }
  if (op.discarded) {
    return {
      success: true,
      skipped: true,
      reason: "discarded",
      baseRevision: op.baseRevision,
    };
  }
  if (op.committed) {
    return {
      success: true,
      skipped: true,
      reason: "already_committed",
      baseRevision: op.baseRevision,
    };
  }
  if (
    (!op.dirty || op.stagedOperations.length === 0) &&
    op.capabilityAssessment.blocked.length > 0
  ) {
    return {
      success: true,
      skipped: true,
      reason: "no_changes",
      baseRevision: op.baseRevision,
    };
  }

  return op.mutationMutex.run(async () => {
    if (op.committed || op.discarded) {
      return {
        success: true as const,
        skipped: true as const,
        reason: op.committed
          ? ("already_committed" as const)
          : op.discarded
            ? ("discarded" as const)
            : ("no_changes" as const),
        baseRevision: op.baseRevision,
      };
    }

    const validation = validateWorkingModel(op.workingModel);
    op.validation = validation;
    if (!validation.ok) {
      homeDesignAgentDevLog("agent_operation_commit_failed", {
        operationId: op.operationId,
        projectId: op.projectId,
        validation,
      });
      return {
        success: false as const,
        error: "Staged model failed final validation.",
        code: "VALIDATION_FAILED",
        validation,
        baseRevision: op.baseRevision,
      };
    }

    const completionReport = assessOperationCompletion({
      userMessage: op.userMessage,
      plan: op.taskPlan ?? null,
      baseModel: op.baseModel,
      workingModel: op.workingModel,
      stagedOps: op.stagedOperations,
      metrics: op.runMetrics,
      replanSuggested: context.loopSafety?.replanSuggested,
      replanReason: context.loopSafety?.replanReason,
      blockedDependencies: activeDependencyBlocks(context.loopSafety),
    });

    const planningRequired = suggestsStructuredPlanning(op.userMessage);
    const coordinated =
      planningRequired || Boolean(op.taskPlan?.planningRequired);

    if (coordinated && !completionReport.readyToCommit) {
      homeDesignAgentDevLog("agent_operation_commit_incomplete", {
        operationId: op.operationId,
        projectId: op.projectId,
        completionReport,
        hasPlan: Boolean(op.taskPlan),
      });
      const pending = completionReport.pendingOutcomeIds;
      const violations = completionReport.constraintViolations;
      const missing = completionReport.missingChecks;
      const gap = completionReport.gapSummary;
      const parts = [
        pending.length
          ? `Pending outcomes: ${pending.join(", ")}`
          : null,
        violations.length
          ? `Constraint violations: ${violations.join("; ")}`
          : null,
        missing.length ? `Missing checks: ${missing.join("; ")}` : null,
      ].filter(Boolean);
      return {
        success: false as const,
        error:
          parts.length > 0
            ? `Operation materially incomplete — ${parts.join(". ")}`
            : "Operation materially incomplete.",
        code: "INCOMPLETE_OPERATION",
        completionReport,
        gapSummary: gap ?? null,
        baseRevision: op.baseRevision,
      };
    }

    if (!op.dirty || op.stagedOperations.length === 0) {
      return {
        success: true as const,
        skipped: true as const,
        reason: "no_changes" as const,
        baseRevision: op.baseRevision,
      };
    }

    const concise = op.userMessage.replace(/\s+/g, " ").trim().slice(0, 160);
    const reason = `Agent operation ${op.operationId}: ${concise}`;

    try {
      const committed = await commitRevision({
        projectId: op.projectId,
        model: op.workingModel,
        userId: op.userId,
        reason,
      });

      op.committed = true;
      op.finalRevision = committed.revision;
      op.finalRevisionId = committed.id;
      op.dirty = false;

      const liveUpdateEmitted = Boolean(context.emitCommittedModel);
      context.emitCommittedModel?.(op.workingModel, committed.revision);

      homeDesignAgentDevLog("agent_operation_committed", {
        operationId: op.operationId,
        projectId: op.projectId,
        baseRevision: op.baseRevision,
        revisionAfter: committed.revision,
        stagedOperationCount: op.stagedOperations.length,
        liveUpdateEmitted,
      });

      return {
        success: true as const,
        skipped: false as const,
        baseRevision: op.baseRevision,
        revisionAfter: committed.revision,
        revisionId: committed.id,
        stagedOperationCount: op.stagedOperations.length,
        liveUpdateEmitted,
        validation,
      };
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : "Commit failed",
        code: "COMMIT_FAILED",
        baseRevision: op.baseRevision,
      };
    }
  });
}

export function operationMeta(context: DesignAgentContext | undefined) {
  const op = context?.operation;
  if (!op) return null;
  return {
    operationId: op.operationId,
    baseRevision: op.baseRevision,
    baseRevisionId: op.baseRevisionId,
    dirty: op.dirty,
    stagedOperationCount: op.stagedOperations.length,
    committed: op.committed,
    discarded: op.discarded,
    finalRevision: op.finalRevision ?? null,
    hasTaskPlan: Boolean(op.taskPlan),
    progressAcknowledged: op.progressAcknowledged,
  };
}
