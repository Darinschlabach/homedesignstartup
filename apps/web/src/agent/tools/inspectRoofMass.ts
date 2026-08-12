import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import { loadAgentModel } from "../project/loadAgentModel";
import {
  findRoofMass,
  listRoofAssemblies,
  summarizeMass,
} from "./roofMassShared";

export const inspectRoofMassTool = tool({
  name: "inspect_roof_mass",

  description:
    "Read-only inspection of one parametric roof mass (authoring generator + related derived planes/edges). Prefer before create/modify/delete_roof_mass. Uses staged state when the operation is dirty. Pass massId, or omit to list all masses.",

  parameters: z
    .object({
      massId: z
        .string()
        .min(1)
        .optional()
        .describe("Roof mass id. Omit to list all masses in roofAssemblies."),
      assemblyId: z
        .string()
        .min(1)
        .optional()
        .describe("Optional assembly filter when listing masses."),
    })
    .strict(),

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const massId =
      rawArgs.massId == null ? undefined : String(rawArgs.massId);
    const assemblyId =
      rawArgs.assemblyId == null ? undefined : String(rawArgs.assemblyId);

    homeDesignAgentDevLog("inspect_roof_mass_execute_start", {
      tool: "inspect_roof_mass",
      arguments: { massId: massId ?? null, assemblyId: assemblyId ?? null },
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const loaded = await loadAgentModel(context);
    if (!loaded.success) {
      homeDesignAgentDevLog("inspect_roof_mass_execute_end", {
        tool: "inspect_roof_mass",
        ok: false,
        resultSummary: { code: loaded.code, error: loaded.error },
      });
      return loaded;
    }

    const assemblies = listRoofAssemblies(loaded.model).filter((a) =>
      assemblyId ? a.id === assemblyId : true,
    );

    if (massId) {
      const found = findRoofMass(loaded.model, massId);
      if (!found) {
        const failure = {
          success: false as const,
          error: `Roof mass not found: ${massId}`,
          code: "MASS_NOT_FOUND" as const,
          projectId: loaded.projectId,
          revision: loaded.revision,
          modelSource: loaded.source,
        };
        homeDesignAgentDevLog("inspect_roof_mass_execute_end", {
          tool: "inspect_roof_mass",
          ok: false,
          resultSummary: failure,
        });
        return failure;
      }
      const mass = summarizeMass(found.assembly, found.mass);
      const result = {
        success: true as const,
        projectId: loaded.projectId,
        revision: loaded.revision,
        revisionId: loaded.revisionId,
        modelSource: loaded.source,
        dirty: loaded.dirty,
        units: "feet" as const,
        mass,
        nextStep:
          "Use create_roof_mass / modify_roof_mass / delete_roof_mass for composed multi-mass work. Use modify_roof only for simple single-mass shell roofs. Never invent valley coordinates.",
      };
      homeDesignAgentDevLog("inspect_roof_mass_execute_end", {
        tool: "inspect_roof_mass",
        ok: true,
        resultSummary: {
          massId,
          type: (mass.generator as { type?: string } | null)?.type ?? null,
          modelSource: loaded.source,
        },
      });
      return result;
    }

    const masses = assemblies.flatMap((a) =>
      a.masses.map((m) => summarizeMass(a, m)),
    );
    const result = {
      success: true as const,
      projectId: loaded.projectId,
      revision: loaded.revision,
      revisionId: loaded.revisionId,
      modelSource: loaded.source,
      dirty: loaded.dirty,
      units: "feet" as const,
      assemblyCount: assemblies.length,
      massCount: masses.length,
      masses,
      capabilities: {
        maxInteractingMasses: 2,
        createTypes: ["gable", "shed", "flat", "hip"],
        note: "Hip is safe as a single mass; hip intersections with a second mass are not supported yet.",
      },
      nextStep:
        masses.length === 0
          ? "No roof masses yet — ensure inspect_roof / shell sync, then create_roof_mass."
          : "Inspect a specific massId or create/modify a secondary mass for composed roofs.",
    };
    homeDesignAgentDevLog("inspect_roof_mass_execute_end", {
      tool: "inspect_roof_mass",
      ok: true,
      resultSummary: {
        massCount: masses.length,
        modelSource: loaded.source,
      },
    });
    return result;
  },
});
