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
  listLevels,
  scrubNulls,
  summarizeLevelBrief,
  summarizeLevelDetail,
} from "./levelShared";

const deleteLevelParameters = z
  .object({
    levelId: z.string().min(1).describe("Level to delete."),
  })
  .strict();

type Args = z.infer<typeof deleteLevelParameters>;

function dependentsForLevel(
  model: Parameters<typeof listLevels>[0],
  levelId: string,
) {
  const wallIds = new Set(
    model.walls.filter((w) => w.levelId === levelId).map((w) => w.id),
  );
  return {
    walls: model.walls
      .filter((w) => w.levelId === levelId)
      .map((w) => ({ id: w.id, shell: isShellWallId(w.id) })),
    spaces: model.spaces
      .filter((s) => s.levelId === levelId)
      .map((s) => ({ id: s.id, name: s.name })),
    slabs: model.slabs
      .filter((s) => s.levelId === levelId)
      .map((s) => ({ id: s.id })),
    openings: model.openings
      .filter((o) => wallIds.has(o.wallId))
      .map((o) => ({ id: o.id, wallId: o.wallId })),
    objects: (model.entities ?? [])
      .filter((e) => e.levelId === levelId && e.type !== "level")
      .map((e) => ({ id: e.id, type: e.type })),
    roofs: model.roofs
      .filter((r) => r.levelId === levelId)
      .map((r) => ({ id: r.id })),
    roofAssemblies: (model.roofAssemblies ?? [])
      .filter((a) => a.levelId === levelId)
      .map((a) => ({ id: a.id })),
  };
}

export const deleteLevelTool = tool({
  name: "delete_level",

  description:
    "Stage deletion of a story. Rejects if it is the last level or still owns geometry — resolve/remove dependents first (no force-delete in this tool). Stages only.",

  parameters: deleteLevelParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = scrubNulls(rawArgs as Record<string, unknown>) as Args;

    homeDesignAgentDevLog("delete_level_execute_start", {
      tool: "delete_level",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "delete_level", args, {
        validationFailure: Boolean(code),
      });
      homeDesignAgentDevLog("delete_level_execute_end", {
        tool: "delete_level",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "delete_level", args)
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

      const levels = listLevels(loaded.model);
      if (levels.length <= 1) {
        return fail({
          error: "Cannot delete the only remaining level.",
          code: "LEVEL_DELETE_LAST",
          levels: levels.map(summarizeLevelBrief),
        });
      }

      const prior = levels.find((l) => l.id === args.levelId);
      if (!prior) {
        return fail({
          error: `Level not found: ${args.levelId}`,
          code: "LEVEL_MISSING",
          levels: levels.map(summarizeLevelBrief),
        });
      }

      const dependents = dependentsForLevel(loaded.model, args.levelId);
      const dependentCount =
        dependents.walls.length +
        dependents.spaces.length +
        dependents.slabs.length +
        dependents.openings.length +
        dependents.objects.length +
        dependents.roofs.length +
        dependents.roofAssemblies.length;

      // Agent tools never pass force — require explicit cleanup first.
      if (dependentCount > 0) {
        return fail({
          error: `Level ${args.levelId} still owns geometry (${dependentCount} refs). Remove or reassign dependents before delete_level.`,
          code: "LEVEL_HAS_DEPENDENTS",
          dependents,
          priorLevel: summarizeLevelDetail(loaded.model, prior),
          nextStep:
            "Delete or move spaces/walls/openings/objects on this level first. Force-delete is not available via agent tools.",
        });
      }

      const operations: DesignOperation[] = [
        {
          op: "deleteLevel",
          levelId: args.levelId,
          // force intentionally omitted — agent must clear dependents first
        },
      ];

      const staged = await stageDesignOperations(
        context,
        operations,
        `Stage delete_level ${args.levelId}`,
      );

      if (!staged.success) {
        const issue = staged.validation?.issues?.[0];
        return fail({
          error: staged.error,
          code: issue?.code ?? staged.code ?? "VALIDATION_FAILED",
          validation: staged.validation,
          conflicts: staged.validation?.issues ?? [],
          dependents: issue?.details ?? dependents,
          priorLevel: summarizeLevelBrief(prior),
          operation: operationMeta(context),
        });
      }

      recordToolSuccess(context.loopSafety);

      const result = {
        success: true as const,
        staged: true as const,
        deleted: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        levelId: args.levelId,
        priorLevel: summarizeLevelBrief(prior),
        afterLevels: listLevels(staged.afterModel).map(summarizeLevelBrief),
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Level deletion is staged. Use inspect_level / render_preview to confirm. Runtime commits once at the end.",
      };

      homeDesignAgentDevLog("delete_level_execute_end", {
        tool: "delete_level",
        arguments: args,
        ok: true,
        levelId: args.levelId,
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
        error: error instanceof Error ? error.message : "delete_level failed",
        code: "DELETE_LEVEL_FAILED",
      });
    }
  },
});
