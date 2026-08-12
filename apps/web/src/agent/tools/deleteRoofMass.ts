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
  listRoofAssemblies,
  scrubNulls,
  summarizeMass,
} from "./roofMassShared";

const deleteRoofMassParameters = z
  .object({
    massId: z.string().min(1).describe("Roof mass id to delete."),
    assemblyId: z
      .string()
      .min(1)
      .optional()
      .describe("Optional assembly id (resolved from massId when omitted)."),
  })
  .strict();

type Args = z.infer<typeof deleteRoofMassParameters>;

export const deleteRoofMassTool = tool({
  name: "delete_roof_mass",

  description:
    "Stage deletion of one composed roof mass. Recompiles remaining masses. If the last mass is removed, falls back to the parametric shell roof. Rejects missing ids. Stages only.",

  parameters: deleteRoofMassParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = scrubNulls(rawArgs as Record<string, unknown>) as Args;

    homeDesignAgentDevLog("delete_roof_mass_execute_start", {
      tool: "delete_roof_mass",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "delete_roof_mass", args, {
        validationFailure: Boolean(code),
      });
      homeDesignAgentDevLog("delete_roof_mass_execute_end", {
        tool: "delete_roof_mass",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "delete_roof_mass", args)
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

      // Shell-only single mass: deleting it empties composed SoT and falls back to shell —
      // allowed, but warn when it's the only mass on a shell-origin assembly that still
      // mirrors the building roof.
      const prior = summarizeMass(found.assembly, found.mass);
      const remainingBefore = found.assembly.masses.length - 1;

      const operations: DesignOperation[] = [
        {
          op: "deleteRoofMass",
          assemblyId: found.assembly.id,
          massId: found.mass.id,
        },
      ];

      const staged = await stageDesignOperations(
        context,
        operations,
        `Stage delete_roof_mass ${args.massId}`,
      );

      if (!staged.success) {
        return fail({
          error: staged.error,
          code: staged.code ?? "VALIDATION_FAILED",
          validation: staged.validation,
          conflicts: staged.validation?.issues ?? [],
          prior,
          operation: operationMeta(context),
        });
      }

      recordToolSuccess(context.loopSafety);
      const afterAssemblies = listRoofAssemblies(staged.afterModel);
      const afterMasses = afterAssemblies.flatMap((a) =>
        a.masses.map((m) => ({ assemblyId: a.id, massId: m.id, label: m.label })),
      );

      const result = {
        success: true as const,
        staged: true as const,
        deleted: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        deletedMassId: args.massId,
        prior,
        remainingMassCountBeforeDelete: remainingBefore,
        afterMasses,
        fellBackToShell: afterAssemblies.length === 0 || afterMasses.length === 0,
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Mass deletion staged. Inspect/render staged roof state. Runtime commits once at the end.",
      };

      homeDesignAgentDevLog("delete_roof_mass_execute_end", {
        tool: "delete_roof_mass",
        arguments: args,
        ok: true,
        deletedMassId: args.massId,
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
        error: error instanceof Error ? error.message : "delete_roof_mass failed",
        code: "DELETE_ROOF_MASS_FAILED",
      });
    }
  },
});
