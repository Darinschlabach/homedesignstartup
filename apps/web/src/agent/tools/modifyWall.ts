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
import {
  assertWallInsideFootprint,
  planPointToDomain,
  summarizeWall,
} from "./wallSpaceHelpers";

const planPoint = z
  .object({
    x: z.number(),
    z: z.number().optional(),
    y: z.number().optional(),
  })
  .strict();

const modifyWallParameters = z
  .object({
    wallId: z.string().min(1),
    start: planPoint.optional(),
    end: planPoint.optional(),
    height: z.number().positive().optional(),
    thickness: z.number().positive().optional(),
    materialId: z.string().min(1).optional(),
  })
  .strict();

type Args = z.infer<typeof modifyWallParameters>;

function scrub<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v;
}

export const modifyWallTool = tool({
  name: "modify_wall",

  description:
    "Stage safe edits to an existing wall (start/end, height, thickness, material). Preserves unspecified fields. Shell footprint wall endpoints cannot be moved. Hosted openings stay attached by wallId (parametric t). Stages only.",

  parameters: modifyWallParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args: Args = {
      ...(rawArgs as Args),
      wallId: ((rawArgs as Args).wallId ?? "").trim(),
      materialId: scrub((rawArgs as Args).materialId),
    };

    homeDesignAgentDevLog("modify_wall_execute_start", {
      tool: "modify_wall",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      recordToolFailure(context?.loopSafety, "modify_wall", { wallId: args.wallId }, {
        validationFailure: true,
      });
      homeDesignAgentDevLog("modify_wall_execute_end", {
        tool: "modify_wall",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "modify_wall", args)
        : null;
      if (identical) return fail(identical);
      if (!context?.operation) {
        return fail({
          error: "Agent operation is not initialized.",
          code: "NO_OPERATION",
        });
      }
      if (!args.wallId) {
        return fail({ error: "wallId is required.", code: "MISSING_WALL_ID" });
      }
      if (
        args.start == null &&
        args.end == null &&
        args.height == null &&
        args.thickness == null &&
        args.materialId == null
      ) {
        return fail({
          error: "Provide at least one field to modify.",
          code: "NO_CHANGES",
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);

      const wall = loaded.model.walls.find((w) => w.id === args.wallId);
      if (!wall) {
        return fail({
          error: `Wall not found: ${args.wallId}`,
          code: "WALL_NOT_FOUND",
          wallId: args.wallId,
        });
      }

      if ((loaded.model.protectedEntityIds ?? []).includes(args.wallId)) {
        return fail({
          error: `Wall is protected: ${args.wallId}`,
          code: "PROTECTED",
          wallId: args.wallId,
        });
      }

      if (isShellWallId(args.wallId) && (args.start != null || args.end != null)) {
        return fail({
          error:
            "Cannot move shell exterior wall endpoints with modify_wall (footprint stays parametric).",
          code: "SHELL_WALL",
          wallId: args.wallId,
        });
      }

      let start = wall.start;
      let end = wall.end;
      if (args.start) {
        const p = planPointToDomain(args.start);
        if (!p.ok) return fail(p);
        start = p.point;
      }
      if (args.end) {
        const p = planPointToDomain(args.end);
        if (!p.ok) return fail(p);
        end = p.point;
      }
      if (Math.hypot(end.x - start.x, end.y - start.y) < 0.01) {
        return fail({
          error: "Resulting wall length would be zero.",
          code: "WALL_ZERO_LENGTH",
        });
      }
      if (args.start || args.end) {
        const outside = assertWallInsideFootprint(loaded.model, start, end);
        if (outside) return fail({ error: outside, code: "OUTSIDE_FOOTPRINT" });
      }
      if (
        args.materialId &&
        !loaded.model.materials.some((m) => m.id === args.materialId)
      ) {
        return fail({
          error: `materialId "${args.materialId}" not found.`,
          code: "MATERIAL_NOT_FOUND",
        });
      }

      const before = summarizeWall(wall, loaded.model);
      const hostedOpenings = loaded.model.openings
        .filter((o) => o.wallId === args.wallId)
        .map((o) => o.id);

      const operation: DesignOperation = {
        op: "updateWall",
        wallId: args.wallId,
        patch: {
          ...(args.start || args.end ? { start, end } : {}),
          ...(args.height != null ? { height: args.height } : {}),
          ...(args.thickness != null ? { thickness: args.thickness } : {}),
          ...(args.materialId != null ? { materialId: args.materialId } : {}),
        },
      };

      const staged = await stageDesignOperations(
        context,
        [operation],
        `Stage modify_wall ${args.wallId}`,
      );
      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code,
          validation: staged.validation,
          hostedOpenings,
          operation: operationMeta(context),
        });
      }

      const after = staged.afterModel.walls.find((w) => w.id === args.wallId);
      if (!after) {
        return fail({
          error: "Wall missing after modify.",
          code: "MODIFY_FAILED",
        });
      }

      recordToolSuccess(context.loopSafety);
      const result = {
        success: true as const,
        staged: true as const,
        modified: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        wallId: args.wallId,
        before,
        after: summarizeWall(after, staged.afterModel),
        hostedOpenings,
        openingsNote:
          hostedOpenings.length > 0
            ? "Hosted openings remain attached by wallId (parametric t along the wall)."
            : null,
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
      };
      homeDesignAgentDevLog("modify_wall_execute_end", {
        tool: "modify_wall",
        arguments: args,
        ok: true,
        wallId: args.wallId,
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
        error: error instanceof Error ? error.message : "modify_wall failed",
        code: "MODIFY_WALL_FAILED",
      });
    }
  },
});
