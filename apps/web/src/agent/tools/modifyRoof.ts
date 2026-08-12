import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  DesignServiceError,
  extractShellFromModel,
  getEntity,
  listEntities,
  roofRise,
  type BuildingModelV1,
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

const modifyRoofParameters = z
  .object({
    type: z
      .enum(["gable", "hip", "shed", "flat"])
      .optional()
      .describe("Parametric roof shape. gable|hip|shed|flat are geometrically supported."),
    pitch: z
      .number()
      .nonnegative()
      .optional()
      .describe("Roof pitch as X-in-12 (e.g. 6 = 6/12). 0 for flat; typically 1–24 for sloped."),
    overhang: z
      .number()
      .nonnegative()
      .optional()
      .describe("Uniform eave overhang in feet."),
    ridgeDirection: z
      .enum(["width", "depth"])
      .optional()
      .describe(
        "Ridge along plan width (x) or depth (z). Changes which faces are gables/hip ends.",
      ),
    highSide: z
      .enum(["front", "rear", "left", "right"])
      .optional()
      .describe("Shed only: which eave is elevated."),
    materialId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional material for roof-1 assembly (also applied to roof planes). Must exist in the model catalog.",
      ),
  })
  .strict();

type Args = z.infer<typeof modifyRoofParameters>;

function scrub<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function roofSnapshot(model: BuildingModelV1) {
  const shell = extractShellFromModel(model);
  if (!shell) return null;
  const roofRow = model.roofs[0];
  const hw = shell.width / 2 + shell.roof.overhang;
  const hd = shell.depth / 2 + shell.roof.overhang;
  const halfSpan =
    shell.roof.type === "hip"
      ? Math.min(hw, hd)
      : shell.roof.ridgeDirection === "width"
        ? hd
        : hw;
  const riseFt = roofRise(halfSpan, shell.roof.pitch);
  return {
    roofId: roofRow?.id ?? "roof-1",
    type: shell.roof.type,
    pitch: shell.roof.pitch,
    pitchLabel: `${shell.roof.pitch}/12`,
    overhangFt: shell.roof.overhang,
    ridgeDirection: shell.roof.ridgeDirection,
    materialId: roofRow?.materialId ?? getEntity(model, "roof-1")?.materialId ?? null,
    eaveHeightFt: round2(shell.wallHeight),
    ridgeHeightFt: round2(shell.wallHeight + riseFt),
    riseFt: round2(riseFt),
    planeIds: listEntities(model)
      .filter((e) => e.type === "roofPlane")
      .map((e) => e.id),
  };
}

export const modifyRoofTool = tool({
  name: "modify_roof",

  description:
    "Stage parametric single-mass BuildingShell roof edits: type (gable|hip|shed|flat), pitch, overhang, ridgeDirection, highSide (shed), materialId. Preserves unspecified fields. For composed/multi-mass roofs (cross-gable, secondary wing), use create_roof_mass / modify_roof_mass instead. Stages only — does not commit a revision.",

  parameters: modifyRoofParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args: Args = {
      type: scrub((rawArgs as Args).type),
      pitch: scrub((rawArgs as Args).pitch as number | null | undefined),
      overhang: scrub((rawArgs as Args).overhang as number | null | undefined),
      ridgeDirection: scrub((rawArgs as Args).ridgeDirection),
      highSide: scrub((rawArgs as Args).highSide),
      materialId: scrub((rawArgs as Args).materialId),
    };

    homeDesignAgentDevLog("modify_roof_execute_start", {
      tool: "modify_roof",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "modify_roof", args, {
        validationFailure: Boolean(code),
      });
      homeDesignAgentDevLog("modify_roof_execute_end", {
        tool: "modify_roof",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "modify_roof", args)
        : null;
      if (identical) return fail(identical);

      if (!context?.operation) {
        return fail({
          error: "Agent operation is not initialized.",
          code: "NO_OPERATION",
        });
      }

      if (
        args.type == null &&
        args.pitch == null &&
        args.overhang == null &&
        args.ridgeDirection == null &&
        args.highSide == null &&
        args.materialId == null
      ) {
        return fail({
          error:
            "Provide at least one of type, pitch, overhang, ridgeDirection, highSide, or materialId.",
          code: "NO_CHANGES",
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) return fail(loaded);

      const shell = extractShellFromModel(loaded.model);
      if (!shell) {
        return fail({
          error: "No parametric BuildingShell roof to modify.",
          code: "NO_SHELL",
        });
      }

      const before = roofSnapshot(loaded.model)!;
      const protectedIds = loaded.model.protectedEntityIds ?? [];
      if (protectedIds.includes("roof-1") || protectedIds.includes(before.roofId)) {
        return fail({
          error: `Roof ${before.roofId} is protected and cannot be modified.`,
          code: "PROTECTED",
          roofId: before.roofId,
        });
      }

      const nextType = args.type ?? shell.roof.type;
      if (args.pitch != null) {
        if (args.pitch < 0 || args.pitch > 24) {
          return fail({
            error: `pitch ${args.pitch}/12 is outside supported range 0–24.`,
            code: "ROOF_PITCH",
            proposed: { pitch: args.pitch },
          });
        }
        if (nextType !== "flat" && args.pitch < 1) {
          return fail({
            error: `pitch ${args.pitch}/12 is invalid for ${nextType} (use flat for 0 pitch).`,
            code: "ROOF_PITCH",
            proposed: { pitch: args.pitch, type: nextType },
          });
        }
      }

      if (args.overhang != null) {
        const maxOverhang = Math.min(shell.width, shell.depth) / 2;
        if (args.overhang > maxOverhang) {
          return fail({
            error: `overhang ${args.overhang}ft exceeds half the shorter footprint side (${maxOverhang}ft).`,
            code: "ROOF_OVERHANG",
            proposed: { overhang: args.overhang, maxOverhangFt: maxOverhang },
          });
        }
      }

      if (
        args.materialId &&
        !loaded.model.materials.some((m) => m.id === args.materialId)
      ) {
        return fail({
          error: `materialId "${args.materialId}" not found in the material catalog.`,
          code: "MATERIAL_NOT_FOUND",
        });
      }

      const operations: DesignOperation[] = [];
      const roofPatch: Record<string, unknown> = {};
      if (args.type != null) roofPatch.type = args.type;
      if (args.pitch != null) roofPatch.pitch = args.pitch;
      if (args.overhang != null) roofPatch.overhang = args.overhang;
      if (args.ridgeDirection != null) roofPatch.ridgeDirection = args.ridgeDirection;
      if (args.highSide != null) roofPatch.highSide = args.highSide;

      if (Object.keys(roofPatch).length > 0) {
        operations.push({
          op: "updateRoof",
          patch: roofPatch as {
            type?: "gable" | "hip" | "shed" | "flat";
            pitch?: number;
            overhang?: number;
            ridgeDirection?: "width" | "depth";
            highSide?: "front" | "rear" | "left" | "right";
          },
        });
      }

      if (args.materialId) {
        operations.push({
          op: "setMaterial",
          entityId: before.roofId,
          materialId: args.materialId,
        });
      }

      const staged = await stageDesignOperations(
        context,
        operations,
        `Stage modify_roof ${before.roofId}`,
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

      const after = roofSnapshot(staged.afterModel);
      if (!after) {
        return fail({
          error: "Roof missing after staging updateRoof.",
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
        roofId: after.roofId,
        before,
        after,
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        capabilitiesNote:
          "Single-mass shell roof updated. For secondary/cross-gable / multi-mass roofs use create_roof_mass / modify_roof_mass / delete_roof_mass (geometry engine derives valleys).",
        nextStep:
          "Roof edit is staged. Use inspect_roof / render_preview to evaluate. Runtime commits once at the end.",
      };

      homeDesignAgentDevLog("modify_roof_execute_end", {
        tool: "modify_roof",
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
        error: error instanceof Error ? error.message : "modify_roof failed",
        code: "MODIFY_ROOF_FAILED",
      });
    }
  },
});
