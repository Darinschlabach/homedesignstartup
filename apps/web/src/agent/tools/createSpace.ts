import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  DesignServiceError,
  extractShellFromModel,
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
  generateSpaceId,
  planPointToDomain,
  summarizeSpace,
} from "./wallSpaceHelpers";

const planPoint = z
  .object({
    x: z.number(),
    z: z.number().optional(),
    y: z.number().optional(),
  })
  .strict();

const createSpaceParameters = z
  .object({
    name: z.string().min(1),
    levelId: z.string().min(1).optional(),
    polygon: z
      .array(planPoint)
      .min(3)
      .describe("Room boundary in plan (x/z). Maps to domain space polygon x/y."),
    tags: z
      .array(z.string())
      .optional()
      .describe('Optional category tags, e.g. "living", "office", "dining".'),
  })
  .strict();

type Args = z.infer<typeof createSpaceParameters>;

function scrub<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v;
}

export const createSpaceTool = tool({
  name: "create_space",

  description:
    "Stage a NEW room/space with a named boundary polygon on a level. Uses BuildingModelV1.spaces (not a separate room system). space-1 remains the shell footprint space when a shell exists — create additional spaces for rooms. Stages only.",

  parameters: createSpaceParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args: Args = {
      ...(rawArgs as Args),
      levelId: scrub((rawArgs as Args).levelId),
      tags: scrub((rawArgs as Args).tags) ?? [],
    };

    homeDesignAgentDevLog("create_space_execute_start", {
      tool: "create_space",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      recordToolFailure(context?.loopSafety, "create_space", args, {
        validationFailure: true,
      });
      homeDesignAgentDevLog("create_space_execute_end", {
        tool: "create_space",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "create_space", args)
        : null;
      if (identical) return fail(identical);
      if (!context?.operation) {
        return fail({
          error: "Agent operation is not initialized.",
          code: "NO_OPERATION",
        });
      }

      const polygon: Array<{ x: number; y: number }> = [];
      for (const p of args.polygon) {
        const mapped = planPointToDomain(p);
        if (!mapped.ok) return fail(mapped);
        polygon.push(mapped.point);
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);

      if (args.levelId && !loaded.model.levels.some((l) => l.id === args.levelId)) {
        return fail({
          error: `levelId "${args.levelId}" not found.`,
          code: "INVALID_LEVEL",
        });
      }

      const shell = extractShellFromModel(loaded.model);
      if (shell) {
        const hw = shell.width / 2 + 0.05;
        const hd = shell.depth / 2 + 0.05;
        for (const p of polygon) {
          if (Math.abs(p.x) > hw || Math.abs(p.y) > hd) {
            return fail({
              error: `Space vertex (${p.x}, ${p.y}) is outside the building footprint.`,
              code: "SPACE_OUTSIDE_FOOTPRINT",
            });
          }
        }
      }

      const spaceId = generateSpaceId();
      const operation: DesignOperation = {
        op: "createSpace",
        space: {
          id: spaceId,
          name: args.name,
          levelId: args.levelId,
          polygon,
          tags: args.tags,
        },
      };

      const staged = await stageDesignOperations(
        context,
        [operation],
        `Stage create_space ${spaceId}`,
      );
      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code,
          validation: staged.validation,
          operation: operationMeta(context),
        });
      }

      const space = staged.afterModel.spaces.find((s) => s.id === spaceId);
      if (!space) {
        return fail({
          error: "Space missing after staging createSpace.",
          code: "CREATE_FAILED",
          spaceId,
        });
      }

      recordToolSuccess(context.loopSafety);
      const result = {
        success: true as const,
        staged: true as const,
        created: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        spaceId,
        space: summarizeSpace(space),
        architectureNote:
          "Spaces are BuildingModelV1.spaces. Shell sync preserves non-space-1 rooms; space-1 tracks the footprint.",
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
      };
      homeDesignAgentDevLog("create_space_execute_end", {
        tool: "create_space",
        arguments: args,
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
        error: error instanceof Error ? error.message : "create_space failed",
        code: "CREATE_SPACE_FAILED",
      });
    }
  },
});
