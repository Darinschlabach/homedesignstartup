import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  reportExposedLowerRegionsWithCoverage,
  type BuildingModelV1,
} from "@aihd/domain";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import { loadAgentModel } from "../project/loadAgentModel";
import { listRoofAssemblies, summarizeMass } from "./roofMassShared";

function summarizeAssemblies(model: BuildingModelV1) {
  return listRoofAssemblies(model).map((a) => ({
    assemblyId: a.id,
    levelId: a.levelId,
    source: a.source,
    role: a.role ?? (a.levelId === model.levels.at(-1)?.id ? "primary" : null),
    coversExposedRegionId: a.coversExposedRegionId ?? null,
    massCount: a.masses.length,
    masses: a.masses.map((m) => summarizeMass(a, m)),
  }));
}

export const inspectExposedRoofRegionsTool = tool({
  name: "inspect_exposed_roof_regions",

  description:
    "Read-only: list lower-story plan rectangles left uncovered by a partial/setback upper story, plus whether existing lower roof masses cover them. Includes suggested origin/size/eaveHeight (not roof type). Use before create_roof_mass with role=lower. Uses staged state when dirty.",

  parameters: z
    .object({
      lowerLevelId: z.string().min(1).optional(),
      upperLevelId: z.string().min(1).optional(),
    })
    .strict(),

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const lowerLevelId =
      rawArgs.lowerLevelId == null ? undefined : String(rawArgs.lowerLevelId);
    const upperLevelId =
      rawArgs.upperLevelId == null ? undefined : String(rawArgs.upperLevelId);

    homeDesignAgentDevLog("inspect_exposed_roof_regions_execute_start", {
      tool: "inspect_exposed_roof_regions",
      arguments: { lowerLevelId: lowerLevelId ?? null, upperLevelId: upperLevelId ?? null },
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const loaded = await loadAgentModel(context);
    if (!loaded.success) {
      homeDesignAgentDevLog("inspect_exposed_roof_regions_execute_end", {
        tool: "inspect_exposed_roof_regions",
        ok: false,
        resultSummary: { code: loaded.code, error: loaded.error },
      });
      return loaded;
    }

    const all = reportExposedLowerRegionsWithCoverage(loaded.model).filter((r) => {
      if (lowerLevelId && r.lowerLevelId !== lowerLevelId) return false;
      if (upperLevelId && r.upperLevelId !== upperLevelId) return false;
      return true;
    });

    const regions = all.map((r) => ({
      regionId: r.id,
      lowerLevelId: r.lowerLevelId,
      upperLevelId: r.upperLevelId,
      side: r.side,
      centerX: r.footprint.center.x,
      centerZ: r.footprint.center.y,
      width: r.footprint.width,
      depth: r.footprint.depth,
      suggestedEaveHeight: r.suggestedEaveHeight,
      upperEaveHeight: r.upperEaveHeight,
      coverage: r.coverage,
      note: r.coverage.covered
        ? "This region already has lower-roof mass coverage."
        : "Uncovered. Use create_roof_mass with role=lower, this regionId, origin/size near these dimensions, and eaveHeight ≈ suggestedEaveHeight. YOU choose type/pitch — no style preset.",
    }));

    const result = {
      success: true as const,
      projectId: loaded.projectId,
      revision: loaded.revision,
      revisionId: loaded.revisionId,
      modelSource: loaded.source,
      dirty: loaded.dirty,
      units: "feet" as const,
      coordinateNote:
        "centerX / width along plan X; centerZ / depth along plan depth (domain origin.y). Front is typically negative Z.",
      uncoveredCount: regions.filter((r) => !r.coverage.covered).length,
      regions,
      roofAssemblies: summarizeAssemblies(loaded.model),
      capabilities: {
        lowerRoofTypes: ["gable", "shed", "flat", "hip"],
        lowerRoofsAreIndependentAssemblies: true,
        interactingMassesPerAssembly: 2,
        note:
          "Lower roofs are separate composed assemblies (role=lower) and do not consume the primary two-mass intersection budget. Do not add lower roofs as a second mass on the upper assembly unless they intentionally intersect. Hip is single-mass only. No automatic shed-over-setback mapping.",
      },
      nextStep:
        regions.length === 0
          ? "No exposed lower-story regions. Upper footprint matches (or covers) the level below."
          : regions.some((r) => !r.coverage.covered)
            ? "Create lower roof mass(es) with create_roof_mass role=lower. Inspect_roof_mass / render_preview after staging. If two-mass intersection on the PRIMARY assembly cannot represent the intent, report that limitation — do not fake coverage."
            : "All exposed regions appear covered. Use render_preview to visually confirm.",
    };

    homeDesignAgentDevLog("inspect_exposed_roof_regions_execute_end", {
      tool: "inspect_exposed_roof_regions",
      ok: true,
      resultSummary: {
        regionCount: regions.length,
        uncoveredCount: result.uncoveredCount,
        modelSource: loaded.source,
      },
    });
    return result;
  },
});
