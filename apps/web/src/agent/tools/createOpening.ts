import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  DesignServiceError,
  extractShellFromModel,
  getEntity,
  resolveOpeningOffset,
  wallLengthForFace,
  type DesignOperation,
  type ShellOpeningType,
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
  OPENING_DEFAULTS,
  assertHostWallExists,
  generateOpeningId,
  openingBoundsIssues,
  resolveHostWallFace,
  summarizeShellOpening,
} from "./openingHelpers";

const createOpeningParameters = z
  .object({
    type: z
      .enum(["window", "door", "garageDoor"])
      .describe(
        "Shell opening type. door = exterior entry door (hydrates as exteriorDoor). Not for interior cabinet doors.",
      ),
    hostWallId: z
      .string()
      .min(1)
      .optional()
      .describe("Host wall id, e.g. wall-front, wall-rear, wall-left, wall-right."),
    wall: z
      .enum(["front", "rear", "left", "right"])
      .optional()
      .describe("Host wall face alias when hostWallId is not provided."),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    offset: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        "Feet from wall start (left when facing from outside). Prefer explicit offset after measuring.",
      ),
    sillHeight: z
      .number()
      .nonnegative()
      .optional()
      .describe("Bottom of opening above finished floor (ft). Windows typically ~3; doors/garage 0."),
    position: z
      .enum(["center", "left", "right"])
      .optional()
      .describe(
        "Optional placement hint when offset is unknown. Ignored when offset is provided.",
      ),
  })
  .strict();

type CreateOpeningArgs = z.infer<typeof createOpeningParameters>;

function scrub<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v;
}

function normalizeArgs(raw: CreateOpeningArgs): CreateOpeningArgs {
  return {
    ...raw,
    hostWallId: scrub(raw.hostWallId as string | null | undefined),
    wall: scrub(raw.wall as CreateOpeningArgs["wall"] | null | undefined),
    position: scrub(raw.position as CreateOpeningArgs["position"] | null | undefined),
  };
}

export const createOpeningTool = tool({
  name: "create_opening",

  description:
    "Stage a NEW shell opening (window, exterior door, or garage door) on a host exterior wall. IDs are generated server-side. Uses BuildingShell openings (not generic DesignEntity create). Does NOT commit a revision by itself — stages into the current agent operation.",

  parameters: createOpeningParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = normalizeArgs(rawArgs as CreateOpeningArgs);

    homeDesignAgentDevLog("create_opening_execute_start", {
      tool: "create_opening",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "create_opening", args, {
        validationFailure:
          code === "VALIDATION_FAILED" ||
          code === "MISSING_HOST_WALL" ||
          code === "INVALID_HOST_WALL" ||
          code === "MISSING_PLACEMENT" ||
          code === "INVALID_DIMENSIONS" ||
          code === "OPENING_BOUNDS" ||
          code === "OPENING_OVERLAP" ||
          code === "PROTECTED" ||
          code === "NO_SHELL",
      });
      homeDesignAgentDevLog("create_opening_execute_end", {
        tool: "create_opening",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "create_opening", args)
        : null;
      if (identical) return fail(identical);

      if (!context?.operation) {
        return fail({
          error: "Agent operation is not initialized.",
          code: "NO_OPERATION",
        });
      }

      const host = resolveHostWallFace({
        wall: args.wall,
        hostWallId: args.hostWallId,
      });
      if (!host.ok) return fail(host);

      if (args.offset == null && args.position == null) {
        return fail({
          error:
            "Placement requires offset (preferred) or position (center|left|right).",
          code: "MISSING_PLACEMENT",
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);

      const shell = extractShellFromModel(loaded.model);
      if (!shell) {
        return fail({
          error: "Building has no parametric shell to host openings.",
          code: "NO_SHELL",
        });
      }

      const wallOk = assertHostWallExists(loaded.model, host.wallId);
      if (!wallOk.ok) return fail(wallOk);

      if ((loaded.model.protectedEntityIds ?? []).includes(host.wallId)) {
        // Footprint-protected walls still allow openings; only block if wall is listed AND
        // an opening-specific lock flag exists. Keep check for explicit opening host locks via properties.
        const wallEntity = getEntity(loaded.model, host.wallId);
        if (wallEntity?.properties?.openingsLocked === true) {
          return fail({
            error: `Host wall ${host.wallId} has openings locked.`,
            code: "PROTECTED",
            hostWallId: host.wallId,
          });
        }
      }

      const type = args.type as ShellOpeningType;
      const defaults = OPENING_DEFAULTS[type];
      const width = args.width ?? defaults.width;
      const height = args.height ?? defaults.height;
      const sillHeight = args.sillHeight ?? defaults.sillHeight;
      const wallLen = wallLengthForFace(shell, host.face);
      const offset =
        args.offset != null
          ? args.offset
          : resolveOpeningOffset({
              wallLength: wallLen,
              width,
              position: args.position,
            });

      const boundsError = openingBoundsIssues({
        model: loaded.model,
        face: host.face,
        width,
        height,
        offset,
        sillHeight,
      });
      if (boundsError) {
        return fail({
          error: boundsError,
          code: boundsError.includes("overlap")
            ? "OPENING_OVERLAP"
            : "OPENING_BOUNDS",
          hostWallId: host.wallId,
          wall: host.face,
          proposed: { width, height, offset, sillHeight },
        });
      }

      const openingId = generateOpeningId(type);
      if ((loaded.model.protectedEntityIds ?? []).includes(openingId)) {
        return fail({
          error: `Generated opening id ${openingId} is protected.`,
          code: "PROTECTED",
          openingId,
        });
      }

      const operation: DesignOperation = {
        op: "createOpening",
        opening: {
          id: openingId,
          type,
          wall: host.face,
          width,
          height,
          sillHeight,
          // Prefer explicit offset path so convenience position does not discard measured offset.
          offset,
        },
      };

      const staged = await stageDesignOperations(
        context,
        [operation],
        `Stage create_opening ${openingId}`,
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

      const afterShell = extractShellFromModel(staged.afterModel);
      const created = afterShell?.openings.find((o) => o.id === openingId);
      if (!created) {
        return fail({
          error: "Opening missing from staged model after createOpening.",
          code: "CREATE_FAILED",
          openingId,
        });
      }

      recordToolSuccess(context.loopSafety);

      const result = {
        success: true as const,
        staged: true as const,
        created: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        openingId,
        type: created.type,
        hostWallId: host.wallId,
        wall: created.wall,
        opening: summarizeShellOpening(created, afterShell?.wallHeight),
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Opening is staged only. Use inspect_wall / inspect_object / get_measurements / render_preview to verify. Runtime commits once at the end.",
      };

      homeDesignAgentDevLog("create_opening_execute_end", {
        tool: "create_opening",
        arguments: args,
        ok: true,
        openingId,
        type: created.type,
        hostWallId: host.wallId,
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
        error: error instanceof Error ? error.message : "create_opening failed",
        code: "CREATE_OPENING_FAILED",
        projectId: context?.projectId,
      });
    }
  },
});
