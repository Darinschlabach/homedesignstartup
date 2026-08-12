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
  summarizeShellOpening,
} from "./openingHelpers";

const deleteOpeningParameters = z
  .object({
    openingId: z
      .string()
      .min(1)
      .describe(
        "Id of the shell opening to delete. Selection aliases (selected/this/it) resolve to the UI selection when available.",
      ),
  })
  .strict();

function resolveRequestedOpeningId(
  raw: string | undefined,
  selectedEntityId: string | null | undefined,
): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return selectedEntityId ?? undefined;
  if (
    ["selected", "selection", "this", "that", "it"].includes(
      trimmed.toLowerCase(),
    )
  ) {
    return selectedEntityId ?? undefined;
  }
  return trimmed;
}

export const deleteOpeningTool = tool({
  name: "delete_opening",

  description:
    "Stage deletion of an existing editable shell opening (window, exterior door, garage door). Rejects protected openings. Returns prior opening state. Does NOT commit a revision by itself.",

  parameters: deleteOpeningParameters,

  execute: async (args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const requestedId = resolveRequestedOpeningId(
      args.openingId,
      context?.selectedEntityId,
    );

    homeDesignAgentDevLog("delete_opening_execute_start", {
      tool: "delete_opening",
      arguments: {
        openingId: requestedId ?? null,
        providedOpeningId: args.openingId ?? null,
      },
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(
        context?.loopSafety,
        "delete_opening",
        { openingId: requestedId ?? args.openingId },
        {
          validationFailure:
            code === "VALIDATION_FAILED" ||
            code === "UNSUPPORTED_TYPE" ||
            code === "PROTECTED" ||
            code === "OPENING_NOT_FOUND" ||
            code === "MISSING_OPENING_ID",
        },
      );
      homeDesignAgentDevLog("delete_opening_execute_end", {
        tool: "delete_opening",
        arguments: { openingId: requestedId ?? args.openingId },
        ok: false,
        ...payload,
      });
      return { success: false as const, ...payload };
    };

    try {
      const blocked = assertLoopNotBlocked(context?.loopSafety);
      if (blocked) return fail(blocked);

      const identical = context?.loopSafety
        ? guardAgainstIdenticalFailure(context.loopSafety, "delete_opening", {
            openingId: requestedId ?? args.openingId,
          })
        : null;
      if (identical) return fail(identical);

      if (!context?.operation) {
        return fail({
          error: "Agent operation is not initialized.",
          code: "NO_OPERATION",
        });
      }

      if (!requestedId) {
        return fail({
          error:
            "openingId is required (or select an entity / use a selection alias).",
          code: "MISSING_OPENING_ID",
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);

      const entity =
        getEntity(loaded.model, requestedId) ??
        resolveSelectedEntity(loaded.model, requestedId);
      const shellOpening =
        findShellOpening(loaded.model, requestedId) ??
        (entity ? findShellOpening(loaded.model, entity.id) : null);

      if (!shellOpening && !entity) {
        return fail({
          error: `Opening not found: ${requestedId}`,
          code: "OPENING_NOT_FOUND",
          openingId: requestedId,
          projectId: loaded.projectId,
          baseRevision: loaded.revision,
          modelSource: loaded.source,
          dirty: loaded.dirty,
        });
      }

      const openingId = shellOpening?.id ?? entity!.id;
      const type = entity
        ? String(entity.type)
        : shellOpening!.type === "door"
          ? "exteriorDoor"
          : shellOpening!.type;

      if (entity && !isOpeningEntityType(type)) {
        return fail({
          error: `delete_opening cannot remove type "${type}". Only shell openings (window / exteriorDoor / garageDoor) are deletable here.`,
          code: "UNSUPPORTED_TYPE",
          openingId,
          type,
          operation: operationMeta(context),
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
          error: `Opening is protected and cannot be deleted: ${openingId}`,
          code: "PROTECTED",
          openingId,
          type,
          operation: operationMeta(context),
        });
      }

      const before = summarizeShellOpening(
        shellOpening,
        extractShellFromModel(loaded.model)?.wallHeight,
      );
      const beforeEntity = entity ? summarizeEntity(entity) : null;

      const operation: DesignOperation = {
        op: "deleteEntity",
        entityId: openingId,
      };

      const staged = await stageDesignOperations(
        context,
        [operation],
        `Stage delete_opening ${openingId}`,
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

      if (
        findShellOpening(staged.afterModel, openingId) ||
        getEntity(staged.afterModel, openingId)
      ) {
        return fail({
          error: "Opening still present after staging deleteEntity.",
          code: "DELETE_FAILED",
          openingId,
        });
      }

      recordToolSuccess(context.loopSafety);

      const result = {
        success: true as const,
        staged: true as const,
        deleted: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        openingId,
        type,
        before,
        beforeEntity,
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Deletion is staged only. Use inspect_wall / render_preview to verify. Runtime commits once at the end.",
      };

      homeDesignAgentDevLog("delete_opening_execute_end", {
        tool: "delete_opening",
        arguments: { openingId },
        ok: true,
        openingId,
        type,
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
        error: error instanceof Error ? error.message : "delete_opening failed",
        code: "DELETE_OPENING_FAILED",
        projectId: context?.projectId,
      });
    }
  },
});
