import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import { MATERIAL_CAPABILITIES } from "@aihd/domain";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import { loadAgentModel } from "../project/loadAgentModel";
import { scoreMaterials } from "./materialHelpers";

export const findMaterialTool = tool({
  name: "find_material",

  description:
    "Search existing project materials by soft concepts (name, category, intended use, color, appearance, finish, roughness, metalness). Returns ranked matches to help reuse a good existing material. Does not require exact name match. Does not encode style presets. If nothing fits, use create_material.",

  parameters: z.object({
    query: z
      .string()
      .min(1)
      .optional()
      .describe("Free-text material concept, e.g. 'warm matte facade cladding'"),
    name: z.string().min(1).optional(),
    category: z
      .enum(["wall", "roof", "floor", "trim", "structure"])
      .optional(),
    intendedUse: z
      .string()
      .min(1)
      .optional()
      .describe("e.g. front facade, roof, trim accent"),
    color: z
      .string()
      .min(1)
      .optional()
      .describe("Hex #RRGGBB or a color word like warm/light/dark/metal"),
    appearance: z.string().min(1).optional(),
    finish: z.string().min(1).optional(),
    roughness: z.number().min(0).max(1).optional(),
    metalness: z.number().min(0).max(1).optional(),
    limit: z.number().int().min(1).max(24).optional(),
  }),

  execute: async (args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;

    homeDesignAgentDevLog("find_material_execute_start", {
      tool: "find_material",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const loaded = await loadAgentModel(context);
    if (!loaded.success) {
      homeDesignAgentDevLog("find_material_execute_end", {
        tool: "find_material",
        ok: false,
        resultSummary: loaded,
      });
      return loaded;
    }

    const hasCriteria = Object.values(args).some(
      (v) => v !== undefined && v !== null && v !== "",
    );
    if (!hasCriteria) {
      const failure = {
        success: false as const,
        error:
          "Provide at least one search criterion (query, name, category, color, appearance, finish, roughness, or metalness).",
        code: "MISSING_QUERY" as const,
      };
      homeDesignAgentDevLog("find_material_execute_end", {
        tool: "find_material",
        ok: false,
        resultSummary: failure,
      });
      return failure;
    }

    const matches = scoreMaterials(loaded.model.materials ?? [], args);
    const result = {
      success: true as const,
      projectId: loaded.projectId,
      revision: loaded.revision,
      revisionId: loaded.revisionId,
      source: "BuildingModelV1" as const,
      matchCount: matches.length,
      matches,
      catalogSize: loaded.model.materials.length,
      capabilities: MATERIAL_CAPABILITIES,
      notes: [
        "Matches are ranked suggestions only — you decide whether any fit the design intent.",
        "Existing materials are reusable options, not the full design vocabulary.",
        "If no match is good enough, create_material a new valid material.",
      ],
    };

    homeDesignAgentDevLog("find_material_execute_end", {
      tool: "find_material",
      ok: true,
      projectId: loaded.projectId,
      revision: loaded.revision,
      matchCount: matches.length,
      topIds: matches.slice(0, 5).map((m) => m.material.id),
    });

    return result;
  },
});
