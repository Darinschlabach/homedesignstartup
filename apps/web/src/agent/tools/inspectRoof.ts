import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  extractShellFromModel,
  getEntity,
  listEntities,
  roofRise,
  type BuildingModelV1,
} from "@aihd/domain";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import { loadAgentModel } from "../project/loadAgentModel";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function summarizeRoof(model: BuildingModelV1) {
  const shell = extractShellFromModel(model);
  if (!shell) return null;

  const roofRow = model.roofs[0];
  const assembly = getEntity(model, roofRow?.id ?? "roof-1");
  const planes = listEntities(model).filter((e) => e.type === "roofPlane");
  const ridge = getEntity(model, "ridge-1");
  const protectedIds = new Set(model.protectedEntityIds ?? []);

  const hw = shell.width / 2 + shell.roof.overhang;
  const hd = shell.depth / 2 + shell.roof.overhang;
  const halfSpanForRise =
    shell.roof.type === "hip"
      ? Math.min(hw, hd)
      : shell.roof.ridgeDirection === "width"
        ? hd
        : hw;
  const riseFt = roofRise(halfSpanForRise, shell.roof.pitch);
  const eaveHeightFt = shell.wallHeight;
  const ridgeHeightFt = eaveHeightFt + riseFt;

  return {
    roofId: roofRow?.id ?? "roof-1",
    type: shell.roof.type,
    pitch: shell.roof.pitch,
    pitchLabel: `${shell.roof.pitch}/12`,
    overhangFt: shell.roof.overhang,
    ridgeDirection: shell.roof.ridgeDirection,
    materialId: roofRow?.materialId ?? assembly?.materialId ?? "mat-roof",
    footprintRelationship: {
      shellWidthFt: shell.width,
      shellDepthFt: shell.depth,
      wallHeightFt: shell.wallHeight,
      note: "Roof is regenerated from the rectangular BuildingShell footprint + roof params.",
    },
    dimensions: {
      eaveHeightFt: round2(eaveHeightFt),
      ridgeHeightFt: round2(ridgeHeightFt),
      riseFt: round2(riseFt),
      halfSpanFt: round2(halfSpanForRise),
      units: "feet" as const,
    },
    ridge: ridge
      ? {
          id: ridge.id,
          start: ridge.geometry.start ?? null,
          end: ridge.geometry.end ?? null,
        }
      : null,
    planes: planes.map((p) => ({
      id: p.id,
      role: p.properties?.role ?? null,
      face: p.properties?.face ?? null,
      pitch: p.geometry?.pitch ?? shell.roof.pitch,
      materialId: p.materialId ?? null,
      protected: protectedIds.has(p.id),
    })),
    gables:
      shell.roof.type === "gable"
        ? planes
            .filter((p) => p.properties?.role === "gable")
            .map((p) => ({ id: p.id, face: p.properties?.face ?? null }))
        : [],
    hips:
      shell.roof.type === "hip"
        ? planes.map((p) => ({
            id: p.id,
            role: p.properties?.role ?? null,
            face: p.properties?.face ?? null,
          }))
        : [],
    valleys: [] as Array<{ id: string }>,
    protection: {
      assemblyProtected: protectedIds.has(roofRow?.id ?? "roof-1"),
      protectedEntityIds: [...protectedIds].filter(
        (id) =>
          id === "roof-1" ||
          id.startsWith("roof-plane-") ||
          id === "ridge-1",
      ),
    },
    capabilities: {
      supportedTypes: ["gable", "hip", "shed", "flat"],
      supportedFields: ["type", "pitch", "overhang", "ridgeDirection", "highSide"],
      pitchRange: { min: 0, max: 24, unit: "X/12", note: "0 allowed for flat; 1–24 for sloped" },
      materialVia: "apply_material / change_material on roof-1 or roof planes",
      assemblyModel: {
        durable: true,
        sources: ["shell", "composed"],
        note: "Composed multi-mass assemblies (e.g. cross-gable) survive syncShellToModel via model.roofAssemblies.",
      },
    },
    assemblies: (model.roofAssemblies ?? []).map((raw) => {
      const a = raw as {
        id: string;
        source: string;
        masses?: unknown[];
        planes?: unknown[];
        edges?: Array<{ kind: string }>;
      };
      return {
        id: a.id,
        source: a.source,
        massCount: a.masses?.length ?? 0,
        planeCount: a.planes?.length ?? 0,
        edgeKinds: [...new Set((a.edges ?? []).map((e) => e.kind))],
        valleyCount: (a.edges ?? []).filter((e) => e.kind === "valley").length,
      };
    }),
    unsupported: [
      "monitor roofs (enum exists but no geometry generator)",
      "dormers",
      "more than two interacting roof masses",
      "hip + second-mass intersections without converting the hip main to gable",
      "asymmetric per-plane pitches within a single shell mass",
      "create_roof / delete_roof as agent tools (use modify_roof for single-mass; create_roof_mass for composed)",
    ],
  };
}

export const inspectRoofTool = tool({
  name: "inspect_roof",

  description:
    "Read-only inspection of the parametric BuildingShell roof (gable/hip): type, pitch, overhang, ridge direction, rise/ridge heights, planes, materials, protection, and explicit unsupported capabilities. Prefer before modify_roof.",

  parameters: z.object({}).strict(),

  execute: async (_args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;

    homeDesignAgentDevLog("inspect_roof_execute_start", {
      tool: "inspect_roof",
      arguments: {},
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const loaded = await loadAgentModel(context);
    if (!loaded.success) {
      homeDesignAgentDevLog("inspect_roof_execute_end", {
        tool: "inspect_roof",
        ok: false,
        resultSummary: { code: loaded.code, error: loaded.error },
      });
      return loaded;
    }

    const roof = summarizeRoof(loaded.model);
    if (!roof) {
      const failure = {
        success: false as const,
        error: "No parametric BuildingShell roof is present on this model.",
        code: "NO_SHELL" as const,
        projectId: loaded.projectId,
        revision: loaded.revision,
        modelSource: loaded.source,
      };
      homeDesignAgentDevLog("inspect_roof_execute_end", {
        tool: "inspect_roof",
        ok: false,
        resultSummary: failure,
      });
      return failure;
    }

    const result = {
      success: true as const,
      projectId: loaded.projectId,
      revision: loaded.revision,
      revisionId: loaded.revisionId,
      modelSource: loaded.source,
      dirty: loaded.dirty,
      units: "feet" as const,
      roof,
      nextStep:
        "Simple one-mass roof: modify_roof. Composed / secondary gable / shed wing: inspect_roof_mass + create_roof_mass / modify_roof_mass. Materials: apply_material on roof-1. Never invent valleys.",
    };

    homeDesignAgentDevLog("inspect_roof_execute_end", {
      tool: "inspect_roof",
      ok: true,
      resultSummary: {
        type: roof.type,
        pitch: roof.pitch,
        overhangFt: roof.overhangFt,
        ridgeDirection: roof.ridgeDirection,
        planeCount: roof.planes.length,
        modelSource: loaded.source,
      },
    });

    return result;
  },
});
