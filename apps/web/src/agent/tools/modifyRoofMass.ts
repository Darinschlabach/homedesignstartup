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
  findRoofMass,
  scrubNulls,
  summarizeMass,
} from "./roofMassShared";

const modifyRoofMassParameters = z
  .object({
    massId: z.string().min(1).describe("Roof mass id to modify."),
    assemblyId: z
      .string()
      .min(1)
      .optional()
      .describe("Optional assembly id (resolved from massId when omitted)."),
    label: z.string().min(1).optional(),
    originX: z.number().optional().describe("Plan center X (width axis)."),
    originZ: z
      .number()
      .optional()
      .describe("Plan center Z (depth axis; generator origin.y)."),
    width: z.number().positive().optional(),
    depth: z.number().positive().optional(),
    pitch: z.number().nonnegative().optional(),
    ridgeDirection: z.enum(["width", "depth"]).optional(),
    eaveHeight: z.number().nonnegative().optional(),
    overhang: z.number().nonnegative().optional(),
    highSide: z.enum(["front", "rear", "left", "right"]).optional(),
    materialId: z.string().min(1).optional(),
  })
  .strict();

type Args = z.infer<typeof modifyRoofMassParameters>;

export const modifyRoofMassTool = tool({
  name: "modify_roof_mass",

  description:
    "Stage updates to one parametric roof mass (origin, size, pitch, ridgeDirection, eaveHeight, overhang, highSide, material). Preserves unspecified fields. Geometry engine recompiles clipped planes/valleys. Stages only.",

  parameters: modifyRoofMassParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = scrubNulls(rawArgs as Record<string, unknown>) as Args;

    homeDesignAgentDevLog("modify_roof_mass_execute_start", {
      tool: "modify_roof_mass",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "modify_roof_mass", args, {
        validationFailure: Boolean(code),
      });
      homeDesignAgentDevLog("modify_roof_mass_execute_end", {
        tool: "modify_roof_mass",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "modify_roof_mass", args)
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

      const found = findRoofMass(loaded.model, args.massId);
      if (!found) {
        return fail({
          error: `Roof mass not found: ${args.massId}`,
          code: "MASS_NOT_FOUND",
        });
      }
      if (args.assemblyId && args.assemblyId !== found.assembly.id) {
        return fail({
          error: `massId ${args.massId} belongs to assembly ${found.assembly.id}, not ${args.assemblyId}`,
          code: "ASSEMBLY_MISMATCH",
        });
      }

      const patch: Record<string, unknown> = {};
      if (args.label != null) patch.label = args.label;
      if (args.materialId != null) patch.materialId = args.materialId;
      if (args.width != null) patch.width = args.width;
      if (args.depth != null) patch.depth = args.depth;
      if (args.pitch != null) patch.pitch = args.pitch;
      if (args.ridgeDirection != null) patch.ridgeDirection = args.ridgeDirection;
      if (args.eaveHeight != null) patch.eaveHeight = args.eaveHeight;
      if (args.overhang != null) patch.overhang = args.overhang;
      if (args.highSide != null) patch.highSide = args.highSide;
      if (args.originX != null || args.originZ != null) {
        const ox = args.originX ?? found.mass.generator?.origin.x ?? 0;
        const oz = args.originZ ?? found.mass.generator?.origin.y ?? 0;
        patch.origin = { x: ox, y: oz };
      }

      if (Object.keys(patch).length === 0) {
        return fail({
          error: "Provide at least one field to modify.",
          code: "NO_CHANGES",
        });
      }

      if (
        args.materialId &&
        !loaded.model.materials.some((m) => m.id === args.materialId)
      ) {
        return fail({
          error: `materialId "${args.materialId}" not found.`,
          code: "MATERIAL_NOT_FOUND",
        });
      }

      const before = summarizeMass(found.assembly, found.mass);
      const operations: DesignOperation[] = [
        {
          op: "updateRoofMass",
          assemblyId: found.assembly.id,
          massId: found.mass.id,
          patch,
        },
      ];

      const staged = await stageDesignOperations(
        context,
        operations,
        `Stage modify_roof_mass ${args.massId}`,
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

      const afterFound = findRoofMass(staged.afterModel, args.massId);
      if (!afterFound) {
        return fail({
          error: "Mass missing after staged update.",
          code: "MODIFY_FAILED",
        });
      }

      recordToolSuccess(context.loopSafety);
      const after = summarizeMass(afterFound.assembly, afterFound.mass);

      const result = {
        success: true as const,
        staged: true as const,
        modified: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        massId: args.massId,
        before,
        after,
        derived: {
          valleyCount: afterFound.assembly.edges.filter((e) => e.kind === "valley")
            .length,
          planeCount: afterFound.assembly.planes.length,
        },
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Mass update staged and recompiled. Inspect/render staged state before finishing.",
      };

      homeDesignAgentDevLog("modify_roof_mass_execute_end", {
        tool: "modify_roof_mass",
        arguments: args,
        ok: true,
        massId: args.massId,
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
        error: error instanceof Error ? error.message : "modify_roof_mass failed",
        code: "MODIFY_ROOF_MASS_FAILED",
      });
    }
  },
});
