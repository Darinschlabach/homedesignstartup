import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  DesignServiceError,
  extractShellFromModel,
  getEntity,
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
  generateWallId,
  planPointToDomain,
  summarizeWall,
} from "./wallSpaceHelpers";

const planPoint = z
  .object({
    x: z.number(),
    z: z
      .number()
      .optional()
      .describe("Plan depth (preferred). Maps to domain wall Vec2.y."),
    y: z
      .number()
      .optional()
      .describe("Alias for plan depth (domain Vec2.y). Prefer z."),
  })
  .strict();

const createWallParameters = z
  .object({
    levelId: z.string().min(1).optional(),
    start: planPoint,
    end: planPoint,
    height: z.number().positive().optional(),
    thickness: z.number().positive().optional(),
    materialId: z.string().min(1).optional(),
    kind: z
      .enum(["interior", "exterior"])
      .optional()
      .describe(
        "Default interior. Exterior shell footprint walls are not created here.",
      ),
  })
  .strict();

type Args = z.infer<typeof createWallParameters>;

function scrub<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v;
}

export const createWallTool = tool({
  name: "create_wall",

  description:
    "Stage a NEW interior wall segment (plan start/end). Default kind=interior. Does NOT create or move shell exterior footprint walls. IDs are server-generated. Stages only — does not commit a revision.",

  parameters: createWallParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args: Args = {
      ...(rawArgs as Args),
      levelId: scrub((rawArgs as Args).levelId),
      materialId: scrub((rawArgs as Args).materialId),
      kind: scrub((rawArgs as Args).kind) ?? "interior",
    };

    homeDesignAgentDevLog("create_wall_execute_start", {
      tool: "create_wall",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "create_wall", args, {
        validationFailure: Boolean(code),
      });
      homeDesignAgentDevLog("create_wall_execute_end", {
        tool: "create_wall",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "create_wall", args)
        : null;
      if (identical) return fail(identical);
      if (!context?.operation) {
        return fail({
          error: "Agent operation is not initialized.",
          code: "NO_OPERATION",
        });
      }

      if (args.kind === "exterior") {
        return fail({
          error:
            "create_wall cannot author exterior/shell footprint walls. Use interior partitions, or wait for footprint tools.",
          code: "SHELL_WALL",
        });
      }

      const start = planPointToDomain(args.start);
      if (!start.ok) return fail(start);
      const end = planPointToDomain(args.end);
      if (!end.ok) return fail(end);

      const length = Math.hypot(
        end.point.x - start.point.x,
        end.point.y - start.point.y,
      );
      if (!(length > 0.01)) {
        return fail({
          error: "Wall length must be greater than zero.",
          code: "WALL_ZERO_LENGTH",
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);

      if (args.levelId && !loaded.model.levels.some((l) => l.id === args.levelId)) {
        return fail({
          error: `levelId "${args.levelId}" not found.`,
          code: "INVALID_LEVEL",
        });
      }

      if (args.materialId && !loaded.model.materials.some((m) => m.id === args.materialId)) {
        return fail({
          error: `materialId "${args.materialId}" not found.`,
          code: "MATERIAL_NOT_FOUND",
        });
      }

      const outside = assertWallInsideFootprint(
        loaded.model,
        start.point,
        end.point,
      );
      if (outside) {
        return fail({ error: outside, code: "OUTSIDE_FOOTPRINT" });
      }

      const shell = extractShellFromModel(loaded.model);
      const wallId = generateWallId();
      const operation: DesignOperation = {
        op: "createWall",
        wall: {
          id: wallId,
          levelId: args.levelId,
          start: start.point,
          end: end.point,
          thickness: args.thickness ?? shell?.wallThickness ?? 0.5,
          height: args.height ?? shell?.wallHeight,
          materialId: args.materialId,
          kind: "interior",
        },
      };

      const staged = await stageDesignOperations(
        context,
        [operation],
        `Stage create_wall ${wallId}`,
      );
      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code,
          validation: staged.validation,
          operation: operationMeta(context),
        });
      }

      const wall = staged.afterModel.walls.find((w) => w.id === wallId);
      if (!wall) {
        return fail({
          error: "Wall missing after staging createWall.",
          code: "CREATE_FAILED",
          wallId,
        });
      }

      recordToolSuccess(context.loopSafety);
      const result = {
        success: true as const,
        staged: true as const,
        created: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        wallId,
        wall: summarizeWall(wall, staged.afterModel),
        entity: getEntity(staged.afterModel, wallId)
          ? {
              id: wallId,
              type: String(getEntity(staged.afterModel, wallId)!.type),
            }
          : null,
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Wall is staged only. Inspect / render_preview as needed. Runtime commits once at the end.",
      };
      homeDesignAgentDevLog("create_wall_execute_end", {
        tool: "create_wall",
        arguments: args,
        ok: true,
        wallId,
        baseRevision: staged.baseRevision,
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
        error: error instanceof Error ? error.message : "create_wall failed",
        code: "CREATE_WALL_FAILED",
      });
    }
  },
});
