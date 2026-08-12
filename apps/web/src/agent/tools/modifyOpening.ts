import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  DesignServiceError,
  extractShellFromModel,
  getEntity,
  resolveSelectedEntity,
  summarizeEntity,
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
  findShellOpening,
  isOpeningEntityType,
  openingBoundsIssues,
  summarizeShellOpening,
} from "./openingHelpers";

const modifyOpeningParameters = z
  .object({
    openingId: z.string().min(1).describe("Id of the shell opening to modify."),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    offset: z
      .number()
      .nonnegative()
      .optional()
      .describe("Absolute feet from wall start (not a delta)."),
    sillHeight: z.number().nonnegative().optional(),
  })
  .strict();

type ModifyOpeningArgs = z.infer<typeof modifyOpeningParameters>;

function scrub<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v;
}

function normalizeArgs(raw: ModifyOpeningArgs): ModifyOpeningArgs {
  return {
    ...raw,
    openingId: raw.openingId.trim(),
  };
}

export const modifyOpeningTool = tool({
  name: "modify_opening",

  description:
    "Stage safe geometry edits on an existing shell opening (width, height, offset, sillHeight). Preserves unspecified fields. Does not move openings to another wall. Does NOT commit a revision by itself.",

  parameters: modifyOpeningParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = normalizeArgs({
      ...(rawArgs as ModifyOpeningArgs),
      openingId: scrub((rawArgs as ModifyOpeningArgs).openingId) ?? "",
    });

    homeDesignAgentDevLog("modify_opening_execute_start", {
      tool: "modify_opening",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(
        context?.loopSafety,
        "modify_opening",
        { openingId: args.openingId },
        {
          validationFailure:
            code === "VALIDATION_FAILED" ||
            code === "OPENING_NOT_FOUND" ||
            code === "UNSUPPORTED_TYPE" ||
            code === "PROTECTED" ||
            code === "NO_CHANGES" ||
            code === "OPENING_BOUNDS" ||
            code === "OPENING_OVERLAP",
        },
      );
      homeDesignAgentDevLog("modify_opening_execute_end", {
        tool: "modify_opening",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "modify_opening", {
            openingId: args.openingId,
            width: args.width,
            height: args.height,
            offset: args.offset,
            sillHeight: args.sillHeight,
          })
        : null;
      if (identical) return fail(identical);

      if (!context?.operation) {
        return fail({
          error: "Agent operation is not initialized.",
          code: "NO_OPERATION",
        });
      }

      if (!args.openingId) {
        return fail({
          error: "openingId is required.",
          code: "MISSING_OPENING_ID",
        });
      }

      if (
        args.width == null &&
        args.height == null &&
        args.offset == null &&
        args.sillHeight == null
      ) {
        return fail({
          error:
            "Provide at least one of width, height, offset, or sillHeight to modify.",
          code: "NO_CHANGES",
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);

      const entity =
        getEntity(loaded.model, args.openingId) ??
        resolveSelectedEntity(loaded.model, args.openingId);
      const shellOpening =
        findShellOpening(loaded.model, args.openingId) ??
        (entity ? findShellOpening(loaded.model, entity.id) : null);

      if (!shellOpening && !entity) {
        return fail({
          error: `Opening not found: ${args.openingId}`,
          code: "OPENING_NOT_FOUND",
          openingId: args.openingId,
        });
      }

      const openingId = shellOpening?.id ?? entity!.id;
      const entityType = entity ? String(entity.type) : shellOpening!.type;

      if (entity && !isOpeningEntityType(entityType)) {
        return fail({
          error: `modify_opening only edits shell openings. Entity ${openingId} has type "${entityType}".`,
          code: "UNSUPPORTED_TYPE",
          openingId,
          type: entityType,
        });
      }

      if (!shellOpening) {
        return fail({
          error: `Opening ${openingId} is not present on the parametric shell.`,
          code: "OPENING_NOT_FOUND",
          openingId,
        });
      }

      if ((loaded.model.protectedEntityIds ?? []).includes(openingId)) {
        return fail({
          error: `Opening is protected and cannot be modified: ${openingId}`,
          code: "PROTECTED",
          openingId,
        });
      }

      const next = {
        width: args.width ?? shellOpening.width,
        height: args.height ?? shellOpening.height,
        offset: args.offset ?? shellOpening.offset,
        sillHeight: args.sillHeight ?? shellOpening.sillHeight,
      };

      const boundsError = openingBoundsIssues({
        model: loaded.model,
        face: shellOpening.wall,
        width: next.width,
        height: next.height,
        offset: next.offset,
        sillHeight: next.sillHeight,
        ignoreOpeningId: openingId,
      });
      if (boundsError) {
        return fail({
          error: boundsError,
          code: boundsError.includes("overlap")
            ? "OPENING_OVERLAP"
            : "OPENING_BOUNDS",
          openingId,
          proposed: next,
        });
      }

      const geometry: Record<string, number> = {};
      if (args.width != null) geometry.width = args.width;
      if (args.height != null) geometry.height = args.height;
      if (args.offset != null) geometry.offset = args.offset;
      if (args.sillHeight != null) geometry.sillHeight = args.sillHeight;

      const operation: DesignOperation = {
        op: "updateEntity",
        entityId: openingId,
        patch: { geometry },
      };

      const before = summarizeShellOpening(
        shellOpening,
        extractShellFromModel(loaded.model)?.wallHeight,
      );

      const staged = await stageDesignOperations(
        context,
        [operation],
        `Stage modify_opening ${openingId}`,
      );

      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code,
          validation: staged.validation,
          openingId,
          operation: operationMeta(context),
        });
      }

      const afterOpening = findShellOpening(staged.afterModel, openingId);
      if (!afterOpening) {
        return fail({
          error: "Opening missing after staged modify.",
          code: "MODIFY_FAILED",
          openingId,
        });
      }

      recordToolSuccess(context.loopSafety);

      const afterEntity = getEntity(staged.afterModel, openingId);

      const result = {
        success: true as const,
        staged: true as const,
        modified: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        openingId,
        type: afterOpening.type,
        before,
        after: summarizeShellOpening(
          afterOpening,
          extractShellFromModel(staged.afterModel)?.wallHeight,
        ),
        entity: afterEntity ? summarizeEntity(afterEntity) : null,
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Opening edit is staged only. Use inspect_wall / render_preview as needed. Runtime commits once at the end.",
      };

      homeDesignAgentDevLog("modify_opening_execute_end", {
        tool: "modify_opening",
        arguments: args,
        ok: true,
        openingId,
        baseRevision: staged.baseRevision,
        staged: true,
        operation: result.operation,
      });

      return result;
    } catch (error) {
      if (error instanceof DesignServiceError) {
        return fail({
          error: error.message,
          code: "VALIDATION_FAILED",
          validation: { ok: false, issues: error.issues },
          projectId: context?.projectId,
        });
      }
      return fail({
        error: error instanceof Error ? error.message : "modify_opening failed",
        code: "MODIFY_OPENING_FAILED",
        projectId: context?.projectId,
      });
    }
  },
});
