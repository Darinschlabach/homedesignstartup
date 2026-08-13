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
import { resolveLevelFootprintUpdate } from "../planning/toolApplicability";

const modifyLevelFootprintParameters = z
  .object({
    levelId: z.string().min(1).describe("Custom-footprint level to update."),
    centerX: z.number().optional().describe("New plan center X (feet)."),
    centerZ: z
      .number()
      .optional()
      .describe("New plan center depth (feet); maps to domain center.y."),
    width: z.number().positive().optional().describe("New width in feet."),
    depth: z.number().positive().optional().describe("New depth in feet."),
  })
  .strict();

type Args = z.infer<typeof modifyLevelFootprintParameters>;

export const modifyLevelFootprintTool = tool({
  name: "modify_level_footprint",

  description:
    "Update an existing custom level footprint. PRECONDITION: inspect_level_footprint reports state=custom and validTransitions includes modify_level_footprint. For state=shell use set_level_footprint. Unspecified properties are preserved. Domain regenerates walls/slab and revalidates dependencies. Stages only.",

  parameters: modifyLevelFootprintParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = scrubNulls(rawArgs as Record<string, unknown>) as Args;

    homeDesignAgentDevLog("modify_level_footprint_execute_start", {
      tool: "modify_level_footprint",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      const replan = recordToolFailure(context?.loopSafety, "modify_level_footprint", args, {
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
        "modify_level_footprint",
        enriched?.dependencyHints,
      );
      homeDesignAgentDevLog("modify_level_footprint_execute_end", {
        tool: "modify_level_footprint",
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
        "modify_level_footprint",
      );
      if (domainBlocked) return fail(domainBlocked);

      const identical = context?.loopSafety
        ? guardAgainstIdenticalFailure(
            context.loopSafety,
            "modify_level_footprint",
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

      if (
        args.centerX === undefined &&
        args.centerZ === undefined &&
        args.width === undefined &&
        args.depth === undefined
      ) {
        return fail({
          error: "Provide at least one of centerX, centerZ, width, or depth.",
          code: "NO_PATCH",
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
        });
      }
      const applicability = resolveLevelFootprintUpdate(
        beforeLevel.footprintSource,
        args,
      );
      if (!applicability.applicable) {
        return {
          success: false as const,
          ...applicability,
          levelId: args.levelId,
          footprintSource: beforeLevel.footprintSource,
          before: summarizeLevelFootprint(loaded.model, beforeLevel),
          replanSuggested: false,
          nextStep: `Use ${applicability.validTransitions.join(" or ")}.`,
        };
      }

      const before = summarizeLevelFootprint(loaded.model, beforeLevel);
      const prior = beforeLevel.footprint;
      const patch: {
        center?: { x: number; y: number };
        width?: number;
        depth?: number;
      } = {};
      if (args.centerX !== undefined || args.centerZ !== undefined) {
        patch.center = {
          x: args.centerX ?? prior!.center.x,
          y: args.centerZ ?? prior!.center.y,
        };
      }
      if (args.width !== undefined) patch.width = args.width;
      if (args.depth !== undefined) patch.depth = args.depth;

      const operations: DesignOperation[] = applicability.transition === "set_level_footprint"
        ? [{
            op: "setLevelFootprint",
            levelId: args.levelId,
            footprint: {
              kind: "rect",
              center: {
                x: applicability.rectangle.centerX,
                y: applicability.rectangle.centerZ,
              },
              width: applicability.rectangle.width,
              depth: applicability.rectangle.depth,
            },
          }]
        : [{
            op: "updateLevelFootprint",
            levelId: args.levelId,
            patch,
          }];

      const staged = await stageDesignOperations(
        context,
        operations,
        `Stage modify_level_footprint ${args.levelId}`,
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
        modified: true as const,
        resolvedTransition: applicability.transition,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        levelId: args.levelId,
        before,
        after,
        modelSource: "staged" as const,
        dirty: true as const,
        validation,
        exposedLowerRoof: validation.exposedLowerRoof,
        conflicts: validation.errors,
        operation: operationMeta(context),
        nextStep:
          "Footprint edit is staged. Re-check stairs/spaces/openings against the new bounds. Use render_preview for massing. Runtime commits once at the end.",
      };

      homeDesignAgentDevLog("modify_level_footprint_execute_end", {
        tool: "modify_level_footprint",
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
        error:
          error instanceof Error
            ? error.message
            : "modify_level_footprint failed",
        code: "MODIFY_LEVEL_FOOTPRINT_FAILED",
      });
    }
  },
});
