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
import { summarizeSpace } from "./wallSpaceHelpers";

const deleteSpaceParameters = z
  .object({
    spaceId: z.string().min(1),
  })
  .strict();

export const deleteSpaceTool = tool({
  name: "delete_space",

  description:
    "Stage deletion of a room/space. Rejects shell footprint space-1 (when a parametric shell is present) and protected spaces. Returns prior space state. Stages only.",

  parameters: deleteSpaceParameters,

  execute: async (args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const spaceId = args.spaceId.trim();

    homeDesignAgentDevLog("delete_space_execute_start", {
      tool: "delete_space",
      arguments: { spaceId },
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      recordToolFailure(context?.loopSafety, "delete_space", { spaceId }, {
        validationFailure: true,
      });
      homeDesignAgentDevLog("delete_space_execute_end", {
        tool: "delete_space",
        arguments: { spaceId },
        ok: false,
        ...payload,
      });
      return { success: false as const, ...payload };
    };

    try {
      const blocked = assertLoopNotBlocked(context?.loopSafety);
      if (blocked) return fail(blocked);
      const identical = context?.loopSafety
        ? guardAgainstIdenticalFailure(context.loopSafety, "delete_space", {
            spaceId,
          })
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

      const space = loaded.model.spaces.find((s) => s.id === spaceId);
      if (!space) {
        return fail({
          error: `Space not found: ${spaceId}`,
          code: "SPACE_NOT_FOUND",
          spaceId,
        });
      }

      if (spaceId === "space-1" && loaded.model.shell) {
        return fail({
          error:
            "Cannot delete space-1 while a parametric shell is present (footprint space).",
          code: "SHELL_SPACE",
          spaceId,
        });
      }

      if ((loaded.model.protectedEntityIds ?? []).includes(spaceId)) {
        return fail({
          error: `Space is protected: ${spaceId}`,
          code: "PROTECTED",
          spaceId,
        });
      }

      const before = summarizeSpace(space);
      const operation: DesignOperation = { op: "deleteSpace", spaceId };
      const staged = await stageDesignOperations(
        context,
        [operation],
        `Stage delete_space ${spaceId}`,
      );
      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code,
          validation: staged.validation,
          operation: operationMeta(context),
        });
      }

      if (staged.afterModel.spaces.some((s) => s.id === spaceId)) {
        return fail({
          error: "Space still present after staging deleteSpace.",
          code: "DELETE_FAILED",
          spaceId,
        });
      }

      recordToolSuccess(context.loopSafety);
      const result = {
        success: true as const,
        staged: true as const,
        deleted: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        spaceId,
        before,
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
      };
      homeDesignAgentDevLog("delete_space_execute_end", {
        tool: "delete_space",
        arguments: { spaceId },
        ok: true,
        spaceId,
        staged: true,
      });
      return result;
    } catch (error) {
      if (error instanceof DesignServiceError) {
        return fail({
          error: error.message,
          code: "VALIDATION_FAILED",
          validation: { ok: false, issues: error.issues },
        });
      }
      return fail({
        error: error instanceof Error ? error.message : "delete_space failed",
        code: "DELETE_SPACE_FAILED",
      });
    }
  },
});
