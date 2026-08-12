import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  DesignServiceError,
  isShellWallId,
  type DesignOperation,
} from "@aihd/domain";
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
import { summarizeWall } from "./wallSpaceHelpers";

const deleteWallParameters = z
  .object({
    wallId: z.string().min(1),
  })
  .strict();

export const deleteWallTool = tool({
  name: "delete_wall",

  description:
    "Stage deletion of an editable interior wall. Rejects shell footprint walls, protected walls, and walls that still host openings. Returns prior wall state. Stages only.",

  parameters: deleteWallParameters,

  execute: async (args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const wallId = args.wallId.trim();

    homeDesignAgentDevLog("delete_wall_execute_start", {
      tool: "delete_wall",
      arguments: { wallId },
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      recordToolFailure(context?.loopSafety, "delete_wall", { wallId }, {
        validationFailure: true,
      });
      homeDesignAgentDevLog("delete_wall_execute_end", {
        tool: "delete_wall",
        arguments: { wallId },
        ok: false,
        ...payload,
      });
      return { success: false as const, ...payload };
    };

    try {
      const blocked = assertLoopNotBlocked(context?.loopSafety);
      if (blocked) return fail(blocked);
      const identical = context?.loopSafety
        ? guardAgainstIdenticalFailure(context.loopSafety, "delete_wall", {
            wallId,
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

      const wall = loaded.model.walls.find((w) => w.id === wallId);
      if (!wall) {
        return fail({
          error: `Wall not found: ${wallId}`,
          code: "WALL_NOT_FOUND",
          wallId,
        });
      }

      if (isShellWallId(wallId)) {
        return fail({
          error: `Cannot delete shell footprint wall ${wallId}.`,
          code: "SHELL_WALL",
          wallId,
        });
      }

      if ((loaded.model.protectedEntityIds ?? []).includes(wallId)) {
        return fail({
          error: `Wall is protected: ${wallId}`,
          code: "PROTECTED",
          wallId,
        });
      }

      const hostedOpenings = loaded.model.openings.filter(
        (o) => o.wallId === wallId,
      );
      if (hostedOpenings.length > 0) {
        return fail({
          error: `Cannot delete wall ${wallId}: ${hostedOpenings.length} hosted opening(s) would be orphaned.`,
          code: "HOSTED_OPENINGS",
          wallId,
          hostedOpenings: hostedOpenings.map((o) => ({
            id: o.id,
            kind: o.kind,
          })),
        });
      }

      const before = summarizeWall(wall, loaded.model);
      const operation: DesignOperation = { op: "deleteWall", wallId };
      const staged = await stageDesignOperations(
        context,
        [operation],
        `Stage delete_wall ${wallId}`,
      );
      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code,
          validation: staged.validation,
          operation: operationMeta(context),
        });
      }

      if (staged.afterModel.walls.some((w) => w.id === wallId)) {
        return fail({
          error: "Wall still present after staging deleteWall.",
          code: "DELETE_FAILED",
          wallId,
        });
      }

      recordToolSuccess(context.loopSafety);
      const result = {
        success: true as const,
        staged: true as const,
        deleted: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        wallId,
        before,
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
      };
      homeDesignAgentDevLog("delete_wall_execute_end", {
        tool: "delete_wall",
        arguments: { wallId },
        ok: true,
        wallId,
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
        error: error instanceof Error ? error.message : "delete_wall failed",
        code: "DELETE_WALL_FAILED",
      });
    }
  },
});
