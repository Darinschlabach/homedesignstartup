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
import { planPointToDomain, summarizeSpace } from "./wallSpaceHelpers";

const planPoint = z
  .object({
    x: z.number(),
    z: z.number().optional(),
    y: z.number().optional(),
  })
  .strict();

const modifySpaceParameters = z
  .object({
    spaceId: z.string().min(1),
    name: z.string().min(1).optional(),
    levelId: z.string().min(1).optional(),
    polygon: z.array(planPoint).min(3).optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

type Args = z.infer<typeof modifySpaceParameters>;

function scrub<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v;
}

export const modifySpaceTool = tool({
  name: "modify_space",

  description:
    "Stage edits to an existing space (name, polygon, tags, level). Preserves unspecified fields. Stages only.",

  parameters: modifySpaceParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args: Args = {
      ...(rawArgs as Args),
      spaceId: ((rawArgs as Args).spaceId ?? "").trim(),
      name: scrub((rawArgs as Args).name),
      levelId: scrub((rawArgs as Args).levelId),
      tags: scrub((rawArgs as Args).tags),
    };

    homeDesignAgentDevLog("modify_space_execute_start", {
      tool: "modify_space",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      recordToolFailure(
        context?.loopSafety,
        "modify_space",
        { spaceId: args.spaceId },
        { validationFailure: true },
      );
      homeDesignAgentDevLog("modify_space_execute_end", {
        tool: "modify_space",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "modify_space", args)
        : null;
      if (identical) return fail(identical);
      if (!context?.operation) {
        return fail({
          error: "Agent operation is not initialized.",
          code: "NO_OPERATION",
        });
      }
      if (!args.spaceId) {
        return fail({
          error: "spaceId is required.",
          code: "MISSING_SPACE_ID",
        });
      }
      if (
        args.name == null &&
        args.levelId == null &&
        args.polygon == null &&
        args.tags == null
      ) {
        return fail({
          error: "Provide at least one field to modify.",
          code: "NO_CHANGES",
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);

      const space = loaded.model.spaces.find((s) => s.id === args.spaceId);
      if (!space) {
        return fail({
          error: `Space not found: ${args.spaceId}`,
          code: "SPACE_NOT_FOUND",
          spaceId: args.spaceId,
        });
      }

      if ((loaded.model.protectedEntityIds ?? []).includes(args.spaceId)) {
        // Allow renaming protected space-1 but not deleting; polygon edits of footprint space are ok if they stay valid —
        // still respect protected for geometry if footprint protect is on.
        if (args.polygon || args.levelId) {
          return fail({
            error: `Space ${args.spaceId} is protected; cannot change polygon/level.`,
            code: "PROTECTED",
            spaceId: args.spaceId,
          });
        }
      }

      let polygon: Array<{ x: number; y: number }> | undefined;
      if (args.polygon) {
        polygon = [];
        for (const p of args.polygon) {
          const mapped = planPointToDomain(p);
          if (!mapped.ok) return fail(mapped);
          polygon.push(mapped.point);
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
      }

      if (args.levelId && !loaded.model.levels.some((l) => l.id === args.levelId)) {
        return fail({
          error: `levelId "${args.levelId}" not found.`,
          code: "INVALID_LEVEL",
        });
      }

      const before = summarizeSpace(space);
      const operation: DesignOperation = {
        op: "updateSpace",
        spaceId: args.spaceId,
        patch: {
          ...(args.name != null ? { name: args.name } : {}),
          ...(args.levelId != null ? { levelId: args.levelId } : {}),
          ...(polygon ? { polygon } : {}),
          ...(args.tags ? { tags: args.tags } : {}),
        },
      };

      const staged = await stageDesignOperations(
        context,
        [operation],
        `Stage modify_space ${args.spaceId}`,
      );
      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code,
          validation: staged.validation,
          operation: operationMeta(context),
        });
      }

      const after = staged.afterModel.spaces.find((s) => s.id === args.spaceId);
      if (!after) {
        return fail({
          error: "Space missing after modify.",
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
        spaceId: args.spaceId,
        before,
        after: summarizeSpace(after),
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
      };
      homeDesignAgentDevLog("modify_space_execute_end", {
        tool: "modify_space",
        arguments: args,
        ok: true,
        spaceId: args.spaceId,
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
        error: error instanceof Error ? error.message : "modify_space failed",
        code: "MODIFY_SPACE_FAILED",
      });
    }
  },
});
