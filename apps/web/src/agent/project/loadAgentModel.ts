import type { BuildingModelV1 } from "@aihd/domain";
import type { DesignAgentContext } from "../context/agentContext";
import { loadLatestCommittedModel } from "./loadCommittedModel";

export type AgentModelSource = "committed" | "staged";

export type LoadAgentModelSuccess = {
  success: true;
  projectId: string;
  /** Base committed revision for this agent operation (or latest if no operation). */
  revision: number;
  revisionId: string;
  model: BuildingModelV1;
  units: BuildingModelV1["meta"]["units"];
  source: AgentModelSource;
  dirty: boolean;
  operationId?: string;
  stagedOperationCount?: number;
};

export type LoadAgentModelFailure = {
  success: false;
  error: string;
  code: string;
  projectId?: string;
};

/**
 * Prefer the server-side staged working model during an active agent operation
 * so the agent can inspect its own uncommitted changes.
 */
export async function loadAgentModel(
  context: DesignAgentContext | undefined,
): Promise<LoadAgentModelSuccess | LoadAgentModelFailure> {
  const op = context?.operation;
  if (op && !op.discarded && !op.committed) {
    return {
      success: true,
      projectId: op.projectId,
      revision: op.baseRevision,
      revisionId: op.baseRevisionId,
      model: op.workingModel,
      units: op.workingModel.meta.units,
      source: op.dirty ? "staged" : "committed",
      dirty: op.dirty,
      operationId: op.operationId,
      stagedOperationCount: op.stagedOperations.length,
    };
  }

  const loaded = await loadLatestCommittedModel(context);
  if (!loaded.success) return loaded;

  return {
    ...loaded,
    source: "committed",
    dirty: false,
  };
}
