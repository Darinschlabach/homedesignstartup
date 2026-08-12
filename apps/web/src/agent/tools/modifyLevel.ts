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
import {
  listLevels,
  scrubNulls,
  summarizeLevelBrief,
  summarizeLevelDetail,
} from "./levelShared";

const modifyLevelParameters = z
  .object({
    levelId: z.string().min(1).describe("Level to modify."),
    name: z.string().min(1).optional(),
    elevation: z
      .number()
      .optional()
      .describe("Finished floor elevation (world Y, feet)."),
    height: z
      .number()
      .positive()
      .optional()
      .describe("Story height in feet (FFE to top of walls)."),
  })
  .strict();

type Args = z.infer<typeof modifyLevelParameters>;

export const modifyLevelTool = tool({
  name: "modify_level",

  description:
    "Stage safe updates to a level's name, elevation, and/or height. Domain regenerates that story's shell walls/slab and updates roof bearing. Immediately stacked stories shift when this level's top moves. Does not convert shell→custom footprints. Stages only.",

  parameters: modifyLevelParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = scrubNulls(rawArgs as Record<string, unknown>) as Args;

    homeDesignAgentDevLog("modify_level_execute_start", {
      tool: "modify_level",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "modify_level", args, {
        validationFailure: Boolean(code),
      });
      homeDesignAgentDevLog("modify_level_execute_end", {
        tool: "modify_level",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "modify_level", args)
        : null;
      if (identical) return fail(identical);

      if (!context?.operation) {
        return fail({
          error: "Agent operation is not initialized.",
          code: "NO_OPERATION",
        });
      }

      if (
        args.name === undefined &&
        args.elevation === undefined &&
        args.height === undefined
      ) {
        return fail({
          error: "Provide at least one of name, elevation, or height.",
          code: "NO_PATCH",
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);

      const before = listLevels(loaded.model).find((l) => l.id === args.levelId);
      if (!before) {
        return fail({
          error: `Level not found: ${args.levelId}`,
          code: "LEVEL_MISSING",
          levels: listLevels(loaded.model).map(summarizeLevelBrief),
        });
      }

      const operations: DesignOperation[] = [
        {
          op: "updateLevel",
          levelId: args.levelId,
          patch: {
            name: args.name,
            elevation: args.elevation,
            height: args.height,
          },
        },
      ];

      const staged = await stageDesignOperations(
        context,
        operations,
        `Stage modify_level ${args.levelId}`,
      );

      if (!staged.success) {
        const issue = staged.validation?.issues?.[0];
        return fail({
          error: staged.error,
          code: issue?.code ?? staged.code ?? "VALIDATION_FAILED",
          validation: staged.validation,
          conflicts: staged.validation?.issues ?? [],
          geometryHint: issue?.details ?? null,
          before: summarizeLevelBrief(before),
          operation: operationMeta(context),
        });
      }

      const after = listLevels(staged.afterModel).find(
        (l) => l.id === args.levelId,
      );

      recordToolSuccess(context.loopSafety);

      const result = {
        success: true as const,
        staged: true as const,
        modified: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        levelId: args.levelId,
        before: summarizeLevelBrief(before),
        after: after ? summarizeLevelDetail(staged.afterModel, after) : null,
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Level edit is staged. Geometry for this story (and stacked stories / roof) was regenerated. Use inspect_level / render_preview to evaluate.",
      };

      homeDesignAgentDevLog("modify_level_execute_end", {
        tool: "modify_level",
        arguments: args,
        ok: true,
        levelId: args.levelId,
        beforeHeight: before.height,
        afterHeight: after?.height ?? null,
        staged: true,
      });

      return result;
    } catch (error) {
      if (error instanceof DesignServiceError) {
        return fail({
          error: error.message,
          code: error.issues[0]?.code ?? "VALIDATION_FAILED",
          validation: { ok: false, issues: error.issues },
          conflicts: error.issues,
        });
      }
      return fail({
        error: error instanceof Error ? error.message : "modify_level failed",
        code: "MODIFY_LEVEL_FAILED",
      });
    }
  },
});
