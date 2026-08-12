import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  DesignServiceError,
  extractShellFromModel,
  isShellWallId,
  wallLengthForFace,
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

const modifyFootprintParameters = z
  .object({
    width: z
      .number()
      .positive()
      .optional()
      .describe("Overall building width in feet (x axis). Center-anchored resize."),
    depth: z
      .number()
      .positive()
      .optional()
      .describe("Overall building depth in feet (z axis). Center-anchored resize."),
    wallHeight: z
      .number()
      .positive()
      .optional()
      .describe("Exterior wall height in feet."),
  })
  .strict();

type Args = z.infer<typeof modifyFootprintParameters>;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function footprintSummary(model: Parameters<typeof extractShellFromModel>[0]) {
  const shell = extractShellFromModel(model);
  if (!shell) return null;
  return {
    widthFt: shell.width,
    depthFt: shell.depth,
    wallHeightFt: shell.wallHeight,
    wallThicknessFt: shell.wallThickness,
    areaSqFt: round2(shell.width * shell.depth),
    roof: {
      type: shell.roof.type,
      pitch: shell.roof.pitch,
      overhangFt: shell.roof.overhang,
      ridgeDirection: shell.roof.ridgeDirection,
    },
    openings: shell.openings.map((o) => ({
      id: o.id,
      type: o.type,
      wall: o.wall,
      offsetFt: o.offset,
      widthFt: o.width,
      heightFt: o.height,
      sillHeightFt: o.sillHeight,
      clearanceFt: round2(
        wallLengthForFace(shell, o.wall) - (o.offset + o.width),
      ),
    })),
    spaces: model.spaces.map((s) => ({
      id: s.id,
      name: s.name,
      polygon: s.polygon,
    })),
    interiorWalls: model.walls
      .filter((w) => !isShellWallId(w.id))
      .map((w) => ({
        id: w.id,
        start: w.start,
        end: w.end,
      })),
    interiorWallIds: model.walls
      .filter((w) => !isShellWallId(w.id))
      .map((w) => w.id),
    spaceIds: model.spaces.map((s) => s.id),
  };
}

function predictConflicts(
  before: NonNullable<ReturnType<typeof footprintSummary>>,
  args: Args,
): Array<{ code: string; message: string; entityId?: string }> {
  const nextW = args.width ?? before.widthFt;
  const nextD = args.depth ?? before.depthFt;
  const nextH = args.wallHeight ?? before.wallHeightFt;
  const conflicts: Array<{ code: string; message: string; entityId?: string }> =
    [];

  if (!(nextW > 0) || !(nextD > 0) || !(nextH > 0)) {
    conflicts.push({
      code: "DIM_INVALID",
      message: "Footprint dimensions must be positive.",
    });
  }

  const wallLen = (face: "front" | "rear" | "left" | "right") =>
    face === "front" || face === "rear" ? nextW : nextD;

  for (const o of before.openings) {
    const len = wallLen(o.wall as "front" | "rear" | "left" | "right");
    if (o.offsetFt + o.widthFt > len + 0.01) {
      conflicts.push({
        code: "OPENING_BOUNDS",
        message: `Opening ${o.id} on ${o.wall} would extend past the wall after resize (offset ${o.offsetFt}+${o.widthFt} > ${len}). Adjust openings first or choose a larger dimension.`,
        entityId: o.id,
      });
    }
    if (o.sillHeightFt + o.heightFt > nextH + 0.01) {
      conflicts.push({
        code: "OPENING_HEIGHT",
        message: `Opening ${o.id} would exceed wall height ${nextH}ft after resize.`,
        entityId: o.id,
      });
    }
  }

  const hw = nextW / 2 + 0.05;
  const hd = nextD / 2 + 0.05;
  for (const s of before.spaces) {
    if (s.id === "space-1") continue; // regenerated with footprint
    for (const p of s.polygon) {
      if (Math.abs(p.x) > hw || Math.abs(p.y) > hd) {
        conflicts.push({
          code: "SPACE_OUTSIDE_FOOTPRINT",
          message: `Space ${s.id} (${s.name}) would fall outside the new footprint. Shrink/reshape that space in the same operation before or after adjusting dimensions.`,
          entityId: s.id,
        });
        break;
      }
    }
  }
  for (const w of before.interiorWalls) {
    for (const p of [w.start, w.end]) {
      if (Math.abs(p.x) > hw || Math.abs(p.y) > hd) {
        conflicts.push({
          code: "WALL_OUTSIDE_FOOTPRINT",
          message: `Interior wall ${w.id} would fall outside the new footprint. Move or shorten it in the same operation.`,
          entityId: w.id,
        });
        break;
      }
    }
  }

  return conflicts;
}

export const modifyFootprintTool = tool({
  name: "modify_footprint",

  description:
    "Stage a rectangular BuildingShell footprint change (overall width and/or depth and/or wallHeight in feet). Resizes are center-anchored. Shell sync regenerates exterior walls/roof; interior walls/extra spaces are preserved and must remain valid. Does NOT invent freeform footprint polygons. Stages only — does not commit a revision.",

  parameters: modifyFootprintParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = rawArgs as Args;

    homeDesignAgentDevLog("modify_footprint_execute_start", {
      tool: "modify_footprint",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "modify_footprint", args, {
        validationFailure: Boolean(code),
      });
      homeDesignAgentDevLog("modify_footprint_execute_end", {
        tool: "modify_footprint",
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
        ? guardAgainstIdenticalFailure(
            context.loopSafety,
            "modify_footprint",
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

      if (args.width == null && args.depth == null && args.wallHeight == null) {
        return fail({
          error: "Provide at least one of width, depth, or wallHeight.",
          code: "NO_CHANGES",
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);

      const before = footprintSummary(loaded.model);
      if (!before) {
        return fail({
          error: "No parametric BuildingShell footprint to modify.",
          code: "NO_SHELL",
        });
      }

      const protectedIds = loaded.model.protectedEntityIds ?? [];
      if (
        protectedIds.includes("shell-1") &&
        (args.width != null || args.depth != null)
      ) {
        return fail({
          error:
            "Footprint is protected — width/depth cannot change. wallHeight-only edits may still be allowed.",
          code: "PROTECTED",
          protection: { footprintProtected: true, protectedEntityIds: protectedIds },
        });
      }

      const predicted = predictConflicts(before, args);
      if (predicted.length > 0) {
        return fail({
          error:
            "Requested footprint change would invalidate existing geometry. Inspect openings/spaces and adapt before retrying.",
          code: "FOOTPRINT_CONFLICT",
          conflicts: predicted,
          before,
          proposed: {
            widthFt: args.width ?? before.widthFt,
            depthFt: args.depth ?? before.depthFt,
            wallHeightFt: args.wallHeight ?? before.wallHeightFt,
          },
        });
      }

      const operation: DesignOperation = {
        op: "updateBuildingDimensions",
        ...(args.width != null ? { width: args.width } : {}),
        ...(args.depth != null ? { depth: args.depth } : {}),
        ...(args.wallHeight != null ? { wallHeight: args.wallHeight } : {}),
      };

      const staged = await stageDesignOperations(
        context,
        [operation],
        `Stage modify_footprint ${[
          args.width != null ? `w=${args.width}` : null,
          args.depth != null ? `d=${args.depth}` : null,
          args.wallHeight != null ? `h=${args.wallHeight}` : null,
        ]
          .filter(Boolean)
          .join(" ")}`,
      );

      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code ?? "VALIDATION_FAILED",
          validation: staged.validation,
          conflicts: staged.validation?.issues ?? [],
          before,
          operation: operationMeta(context),
        });
      }

      const after = footprintSummary(staged.afterModel);
      recordToolSuccess(context.loopSafety);

      const result = {
        success: true as const,
        staged: true as const,
        modified: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        before,
        after,
        delta: after
          ? {
              widthFt: round2(after.widthFt - before.widthFt),
              depthFt: round2(after.depthFt - before.depthFt),
              wallHeightFt: round2(after.wallHeightFt - before.wallHeightFt),
              areaSqFt: round2(after.areaSqFt - before.areaSqFt),
            }
          : null,
        resizeMode: "center-anchored-rectangular" as const,
        roofNote:
          "Roof regenerated from shell dimensions via existing syncShellToModel behavior.",
        dependencyNote:
          "Exterior walls/openings remapped by shell sync. Interior walls and extra spaces were preserved in absolute coordinates — update them in this same operation if they should grow/shrink with the footprint.",
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Footprint change is staged. Use inspect_footprint / inspect_wall / render_preview, then adjust spaces/interior walls/openings if needed. Runtime commits once at the end.",
      };

      homeDesignAgentDevLog("modify_footprint_execute_end", {
        tool: "modify_footprint",
        arguments: args,
        ok: true,
        before,
        after,
        baseRevision: staged.baseRevision,
        staged: true,
      });

      return result;
    } catch (error) {
      if (error instanceof DesignServiceError) {
        return fail({
          error: error.message,
          code: "VALIDATION_FAILED",
          validation: { ok: false, issues: error.issues },
          conflicts: error.issues,
        });
      }
      return fail({
        error:
          error instanceof Error ? error.message : "modify_footprint failed",
        code: "MODIFY_FOOTPRINT_FAILED",
      });
    }
  },
});
