import type { BuildingModelV1 } from "@aihd/domain";
import type { LoopSafetyState } from "../loopSafety";
import type { AgentOperationState } from "../operation/agentOperation";
import type { CameraSnapshot } from "@/lib/render/cameraPose";

/**
 * Per-run context for the Home Design Agent.
 * Supplied by the API route — tools must not invent projectId.
 * The staged working model lives only on the server in `operation`.
 */
export type DesignAgentContext = {
  userId: string;
  projectId: string;
  operationId: string;
  /** Optional UI selection for richer inspect results. */
  selectedEntityId?: string | null;
  /** Optional live workspace camera for render_preview view=current. */
  cameraSnapshot?: CameraSnapshot | null;
  /** Per-run guards against runaway tool loops. */
  loopSafety?: LoopSafetyState;
  /**
   * Server-side staged transaction for this agent run.
   * Mutations stage here; one final commit creates a single revision.
   */
  operation?: AgentOperationState;
  /**
   * Notify the open workspace after a committed revision
   * (same payload shape the legacy chat SSE uses).
   * Only call after the final agent-operation commit.
   */
  emitCommittedModel?: (model: BuildingModelV1, revision: number) => void;
  /** Optional SSE/tool observability for this run (test harness / UI). */
  emitToolEvent?: (payload: {
    phase: "start" | "end";
    name: string;
    ok?: boolean | null;
    code?: string | null;
    arguments?: unknown;
    resultSummary?: unknown;
  }) => void;
};
