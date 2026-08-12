import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import { loadAgentModel } from "../project/loadAgentModel";
import {
  listLevels,
  summarizeLevelFootprint,
} from "./levelFootprintShared";

export const inspectLevelFootprintTool = tool({
  name: "inspect_level_footprint",

  description:
    "Read-only inspection of a level's plan footprint (shell vs custom rectangle): centerX/centerZ, width, depth, setbacks vs the level below, exterior wall IDs, slab bounds, spaces inside/outside, stair termination validity, roof bearing, and EXPOSED_LOWER_ROOF warnings. Uses staged state when dirty. Prefer before set/modify/clear_level_footprint.",

  parameters: z
    .object({
      levelId: z.string().min(1).describe("Level id to inspect."),
    })
    .strict(),

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const levelId = String(rawArgs.levelId);

    homeDesignAgentDevLog("inspect_level_footprint_execute_start", {
      tool: "inspect_level_footprint",
      arguments: { levelId },
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const loaded = await loadAgentModel(context);
    if (!loaded.success) {
      homeDesignAgentDevLog("inspect_level_footprint_execute_end", {
        tool: "inspect_level_footprint",
        ok: false,
        resultSummary: { code: loaded.code, error: loaded.error },
      });
      return loaded;
    }

    const levels = listLevels(loaded.model);
    const level = levels.find((l) => l.id === levelId);
    if (!level) {
      const failure = {
        success: false as const,
        error: `Level not found: ${levelId}`,
        code: "LEVEL_MISSING" as const,
        projectId: loaded.projectId,
        revision: loaded.revision,
        modelSource: loaded.source,
        levels: levels.map((l) => ({
          id: l.id,
          name: l.name,
          footprintSource: l.footprintSource,
        })),
      };
      homeDesignAgentDevLog("inspect_level_footprint_execute_end", {
        tool: "inspect_level_footprint",
        ok: false,
        resultSummary: failure,
      });
      return failure;
    }

    const detail = summarizeLevelFootprint(loaded.model, level);
    const result = {
      success: true as const,
      projectId: loaded.projectId,
      revision: loaded.revision,
      revisionId: loaded.revisionId,
      modelSource: loaded.source,
      dirty: loaded.dirty,
      units: "feet" as const,
      coordinateNote:
        "centerX / width along plan X; centerZ / depth along plan depth (domain Vec2.y). Front is typically negative Z.",
      footprint: detail,
      nextStep:
        level.footprintSource === "shell"
          ? "Use set_level_footprint for a custom axis-aligned upper rectangle (cannot customize primary shell footprint by default)."
          : "Use modify_level_footprint to adjust center/size, or clear_level_footprint to restore full shell footprint.",
    };

    homeDesignAgentDevLog("inspect_level_footprint_execute_end", {
      tool: "inspect_level_footprint",
      ok: true,
      resultSummary: {
        levelId: level.id,
        footprintSource: level.footprintSource,
        modelSource: loaded.source,
        exposedWarningCount: Array.isArray(detail.exposedLowerRoof)
          ? (detail.exposedLowerRoof as unknown[]).length
          : 0,
      },
    });
    return result;
  },
});
