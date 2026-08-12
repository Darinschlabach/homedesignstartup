import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import { loadAgentModel } from "../project/loadAgentModel";
import {
  listLevels,
  summarizeLevelBrief,
  summarizeLevelDetail,
} from "./levelShared";

export const inspectLevelTool = tool({
  name: "inspect_level",

  description:
    "Read-only inspection of building stories/levels (elevation, height, footprintSource, walls, spaces, openings, objects, slab, roof relationship). Prefer before create/modify/delete_level. Uses staged state when the operation is dirty. Pass levelId, or omit to list all levels.",

  parameters: z
    .object({
      levelId: z
        .string()
        .min(1)
        .optional()
        .describe("Level id. Omit to list all levels."),
    })
    .strict(),

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const levelId =
      rawArgs.levelId == null ? undefined : String(rawArgs.levelId);

    homeDesignAgentDevLog("inspect_level_execute_start", {
      tool: "inspect_level",
      arguments: { levelId: levelId ?? null },
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const loaded = await loadAgentModel(context);
    if (!loaded.success) {
      homeDesignAgentDevLog("inspect_level_execute_end", {
        tool: "inspect_level",
        ok: false,
        resultSummary: { code: loaded.code, error: loaded.error },
      });
      return loaded;
    }

    const levels = listLevels(loaded.model);

    if (levelId) {
      const level = levels.find((l) => l.id === levelId);
      if (!level) {
        const failure = {
          success: false as const,
          error: `Level not found: ${levelId}`,
          code: "LEVEL_MISSING" as const,
          projectId: loaded.projectId,
          revision: loaded.revision,
          modelSource: loaded.source,
          levels: levels.map(summarizeLevelBrief),
        };
        homeDesignAgentDevLog("inspect_level_execute_end", {
          tool: "inspect_level",
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
        level: summarizeLevelDetail(loaded.model, level),
        nextStep:
          "Use create_level / modify_level / delete_level for story height/stacking. Use set_level_footprint / modify_level_footprint / clear_level_footprint for partial/setback upper footprints. Use create_stair for vertical circulation (straight | lShape).",
      };
      homeDesignAgentDevLog("inspect_level_execute_end", {
        tool: "inspect_level",
        ok: true,
        resultSummary: {
          levelId: level.id,
          elevation: level.elevation,
          height: level.height,
          modelSource: loaded.source,
        },
      });
      return result;
    }

    const result = {
      success: true as const,
      projectId: loaded.projectId,
      revision: loaded.revision,
      revisionId: loaded.revisionId,
      modelSource: loaded.source,
      dirty: loaded.dirty,
      units: "feet" as const,
      levelCount: levels.length,
      levels: levels.map((l) => summarizeLevelDetail(loaded.model, l)),
      nextStep:
        levels.length === 1
          ? "Single-story building. Use create_level with footprintSource shell (same footprint) to add another story."
          : "Inspect a specific levelId before modifying story height/elevation.",
    };
    homeDesignAgentDevLog("inspect_level_execute_end", {
      tool: "inspect_level",
      ok: true,
      resultSummary: {
        levelCount: levels.length,
        modelSource: loaded.source,
      },
    });
    return result;
  },
});
