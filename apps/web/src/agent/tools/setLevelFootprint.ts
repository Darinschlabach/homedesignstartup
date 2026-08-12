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
import { firstEnrichedIssue } from "../planning/validationHints";
import {
  guardSuppressedMutationDomain,
  noteDependencyValidationFailure,
} from "../planning/mutationGuard";
import { loadAgentModel } from "../project/loadAgentModel";
import {
  footprintValidationSummary,
  listLevels,
  scrubNulls,
  summarizeLevelFootprint,
} from "./levelFootprintShared";

const setLevelFootprintParameters = z
  .object({
    levelId: z
      .string()
      .min(1)
      .describe("Upper level to give a custom footprint (not the primary shell level)."),
    centerX: z
      .number()
      .describe("Plan center X (feet). Building center is 0."),
    centerZ: z
      .number()
      .describe(
        "Plan center depth (feet). Maps to domain center.y; front is typically negative Z.",
      ),
    width: z.number().positive().describe("Footprint width in feet (X axis)."),
    depth: z
      .number()
      .positive()
      .describe("Footprint depth in feet (plan Z / domain Y)."),
  })
  .strict();

type Args = z.infer<typeof setLevelFootprintParameters>;

export const setLevelFootprintTool = tool({
  name: "set_level_footprint",

  description:
    "Stage a custom axis-aligned rectangular footprint for an upper level (footprintSource custom). Domain regenerates that level's exterior walls and slab; roof bearing follows the top footprint. Does not invent lower roofs for exposed Level-1 regions — EXPOSED_LOWER_ROOF warnings are returned. Does not support rotation or freeform polygons. Stages only.",

  parameters: setLevelFootprintParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = scrubNulls(rawArgs as Record<string, unknown>) as Args;

    homeDesignAgentDevLog("set_level_footprint_execute_start", {
      tool: "set_level_footprint",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      const replan = recordToolFailure(context?.loopSafety, "set_level_footprint", args, {
        validationFailure: Boolean(code),
        validationCode: code,
      });
      const enriched = firstEnrichedIssue(
        (payload.validation as { issues?: Array<{ code: string; message: string; entityId?: string; details?: Record<string, unknown> }> })?.issues ??
          (payload.conflicts as Array<{ code: string; message: string; entityId?: string; details?: Record<string, unknown> }> | undefined),
        "levels",
      );
      const dependencySuppression = noteDependencyValidationFailure(
        context?.loopSafety,
        "set_level_footprint",
        enriched?.dependencyHints,
      );
      homeDesignAgentDevLog("set_level_footprint_execute_end", {
        tool: "set_level_footprint",
        arguments: args,
        ok: false,
        ...payload,
      });
      return {
        success: false as const,
        ...payload,
        dependencyHints: enriched?.dependencyHints ?? null,
        dependencyRetrySuppressed: dependencySuppression?.domainSuppressed ?? false,
        dependencySuppressionReason: dependencySuppression?.suppressionReason ?? null,
        replanSuggested: replan?.replanSuggested ?? context?.loopSafety?.replanSuggested ?? false,
        replanReason: replan?.replanReason ?? context?.loopSafety?.replanReason ?? null,
      };
    };

    try {
      const blocked = assertLoopNotBlocked(context?.loopSafety);
      if (blocked) return fail(blocked);

      const domainBlocked = guardSuppressedMutationDomain(
        context?.loopSafety,
        "set_level_footprint",
      );
      if (domainBlocked) return fail(domainBlocked);

      const identical = context?.loopSafety
        ? guardAgainstIdenticalFailure(
            context.loopSafety,
            "set_level_footprint",
            args,
          )
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

      const beforeLevel = listLevels(loaded.model).find(
        (l) => l.id === args.levelId,
      );
      if (!beforeLevel) {
        return fail({
          error: `Level not found: ${args.levelId}`,
          code: "LEVEL_MISSING",
          levels: listLevels(loaded.model).map((l) => ({
            id: l.id,
            name: l.name,
            footprintSource: l.footprintSource,
          })),
        });
      }

      const before = summarizeLevelFootprint(loaded.model, beforeLevel);

      const operations: DesignOperation[] = [
        {
          op: "setLevelFootprint",
          levelId: args.levelId,
          footprint: {
            kind: "rect",
            center: { x: args.centerX, y: args.centerZ },
            width: args.width,
            depth: args.depth,
          },
        },
      ];

      const staged = await stageDesignOperations(
        context,
        operations,
        `Stage set_level_footprint ${args.levelId}`,
      );

      if (!staged.success) {
        const issue = staged.validation?.issues?.[0];
        const enriched = firstEnrichedIssue(staged.validation?.issues, "levels");
        return fail({
          error: staged.error,
          code: issue?.code ?? staged.code ?? "VALIDATION_FAILED",
          validation: staged.validation,
          conflicts: staged.validation?.issues ?? [],
          geometryHint: issue?.details ?? null,
          before,
          operation: operationMeta(context),
          recoveryHint: enriched?.dependencyHints?.replanGuidance ?? null,
          limitation:
            issue?.code === "LEVEL_FOOTPRINT_OUTSIDE_SHELL" ||
            issue?.code === "LEVEL_FOOTPRINT_PRIMARY"
              ? {
                  code: issue.code,
                  message: issue.message,
                  note: "Axis-aligned custom footprints must lie inside the BuildingShell; the primary level stays shell-backed.",
                }
              : null,
        });
      }

      const afterLevel = listLevels(staged.afterModel).find(
        (l) => l.id === args.levelId,
      );
      const after = afterLevel
        ? summarizeLevelFootprint(staged.afterModel, afterLevel)
        : null;
      const validation = footprintValidationSummary(staged.afterModel);

      recordToolSuccess(context.loopSafety);

      const result = {
        success: true as const,
        staged: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        levelId: args.levelId,
        before,
        after,
        modelSource: "staged" as const,
        dirty: true as const,
        validation,
        exposedLowerRoof: validation.exposedLowerRoof,
        operation: operationMeta(context),
        nextStep:
          "Custom footprint is staged; exterior walls/slab regenerated. If set_level_footprint fails with STAIR_OUTSIDE_UPPER_FOOTPRINT: first modify_stair so the stair lands inside the planned rectangle (while L2 is still full-shell), then retry set_level_footprint. EXPOSED_LOWER_ROOF warnings mean lower areas still need lower-roof coverage — do not claim they are fully roofed. Use render_preview for massing.",
      };

      homeDesignAgentDevLog("set_level_footprint_execute_end", {
        tool: "set_level_footprint",
        arguments: args,
        ok: true,
        levelId: args.levelId,
        staged: true,
        exposedWarningCount: validation.exposedLowerRoof.length,
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
        error:
          error instanceof Error ? error.message : "set_level_footprint failed",
        code: "SET_LEVEL_FOOTPRINT_FAILED",
      });
    }
  },
});
