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

const createLevelParameters = z
  .object({
    name: z
      .string()
      .min(1)
      .describe('Story name, e.g. "Second Floor" / "Upper Level".'),
    height: z
      .number()
      .positive()
      .optional()
      .describe(
        "Story height in feet (FFE to top of walls). Defaults to primary level height. Choose based on project proportions — no fixed preset.",
      ),
    aboveLevelId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Place the new story directly above this level. Domain derives elevation = above.elevation + above.height. Prefer this over manual elevation math.",
      ),
    elevation: z
      .number()
      .optional()
      .describe(
        "Absolute finished floor elevation (world Y, feet). Prefer aboveLevelId when stacking. If omitted and aboveLevelId omitted, stacks above the current top level.",
      ),
    footprintSource: z
      .enum(["shell"])
      .optional()
      .describe(
        'Only "shell" is supported (same rectangular BuildingShell footprint). Custom/partial upper footprints are not available.',
      ),
  })
  .strict();

type Args = z.infer<typeof createLevelParameters>;

export const createLevelTool = tool({
  name: "create_level",

  description:
    "Stage a new shell-backed story with the SAME rectangular BuildingShell footprint. Prefer aboveLevelId so the domain derives elevation. Generates walls/slab for the new level and moves the roof to the top story. Does NOT support partial/setback footprints. Stages only.",

  parameters: createLevelParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = scrubNulls(rawArgs as Record<string, unknown>) as Args;

    homeDesignAgentDevLog("create_level_execute_start", {
      tool: "create_level",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "create_level", args, {
        validationFailure: Boolean(code),
      });
      homeDesignAgentDevLog("create_level_execute_end", {
        tool: "create_level",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "create_level", args)
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

      if (args.aboveLevelId) {
        const above = listLevels(loaded.model).find(
          (l) => l.id === args.aboveLevelId,
        );
        if (!above) {
          return fail({
            error: `aboveLevelId not found: ${args.aboveLevelId}`,
            code: "LEVEL_ABOVE_MISSING",
            levels: listLevels(loaded.model).map(summarizeLevelBrief),
          });
        }
      }

      const beforeLevels = listLevels(loaded.model).map(summarizeLevelBrief);

      const operations: DesignOperation[] = [
        {
          op: "createLevel",
          name: args.name,
          height: args.height,
          aboveLevelId: args.aboveLevelId,
          elevation: args.aboveLevelId ? undefined : args.elevation,
          footprintSource: "shell",
        },
      ];

      const staged = await stageDesignOperations(
        context,
        operations,
        `Stage create_level ${args.name}`,
      );

      if (!staged.success) {
        const issue = staged.validation?.issues?.[0];
        return fail({
          error: staged.error,
          code: issue?.code ?? staged.code ?? "VALIDATION_FAILED",
          validation: staged.validation,
          conflicts: staged.validation?.issues ?? [],
          geometryHint: issue?.details ?? null,
          beforeLevels,
          operation: operationMeta(context),
          limitationNote:
            "Only same-footprint shell stories are supported. Partial/setback second stories are not available.",
        });
      }

      const afterLevels = listLevels(staged.afterModel);
      const created = afterLevels.find(
        (l) => !beforeLevels.some((b) => b.id === l.id),
      );

      recordToolSuccess(context.loopSafety);

      const result = {
        success: true as const,
        staged: true as const,
        created: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        levelId: created?.id ?? null,
        level: created
          ? summarizeLevelDetail(staged.afterModel, created)
          : null,
        beforeLevels,
        afterLevels: afterLevels.map(summarizeLevelBrief),
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Level is staged. Use inspect_level / render_preview (front + perspective) to evaluate. Runtime commits once at the end.",
      };

      homeDesignAgentDevLog("create_level_execute_end", {
        tool: "create_level",
        arguments: args,
        ok: true,
        levelId: result.levelId,
        elevation: created?.elevation ?? null,
        height: created?.height ?? null,
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
        error: error instanceof Error ? error.message : "create_level failed",
        code: "CREATE_LEVEL_FAILED",
      });
    }
  },
});
