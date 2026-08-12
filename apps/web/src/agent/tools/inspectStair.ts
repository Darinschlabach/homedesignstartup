import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import { loadAgentModel } from "../project/loadAgentModel";
import { noteDependencyInspect } from "../planning/mutationGuard";
import {
  listStairs,
  summarizeStairBrief,
  summarizeStairDetail,
} from "./stairShared";

export const inspectStairTool = tool({
  name: "inspect_stair",

  description:
    "Read-only inspection of architectural stairs (type, levels connected, origin/direction/width, derived rise/risers/treads, landing, floor opening, bounds, validation). Prefer before create/modify/delete_stair. Uses staged state when the operation is dirty. Pass stairId, or omit to list all stairs.",

  parameters: z
    .object({
      stairId: z
        .string()
        .min(1)
        .optional()
        .describe("Stair id. Omit to list all stairs."),
    })
    .strict(),

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const stairId =
      rawArgs.stairId == null ? undefined : String(rawArgs.stairId);

    homeDesignAgentDevLog("inspect_stair_execute_start", {
      tool: "inspect_stair",
      arguments: { stairId: stairId ?? null },
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const loaded = await loadAgentModel(context);
    if (!loaded.success) {
      homeDesignAgentDevLog("inspect_stair_execute_end", {
        tool: "inspect_stair",
        ok: false,
        resultSummary: { code: loaded.code, error: loaded.error },
      });
      return loaded;
    }

    const stairs = listStairs(loaded.model);

    if (stairId) {
      const stair = stairs.find((s) => s.id === stairId);
      if (!stair) {
        const failure = {
          success: false as const,
          error: `Stair not found: ${stairId}`,
          code: "STAIR_MISSING" as const,
          projectId: loaded.projectId,
          revision: loaded.revision,
          modelSource: loaded.source,
          stairs: stairs.map(summarizeStairBrief),
        };
        homeDesignAgentDevLog("inspect_stair_execute_end", {
          tool: "inspect_stair",
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
        stair: summarizeStairDetail(loaded.model, stair),
        nextStep:
          "Use create_stair / modify_stair / delete_stair for stair changes. Domain derives tread/riser geometry — do not invent step-by-step meshes.",
      };
      homeDesignAgentDevLog("inspect_stair_execute_end", {
        tool: "inspect_stair",
        ok: true,
        resultSummary: {
          stairId: stair.id,
          type: stair.type,
          modelSource: loaded.source,
        },
      });
      noteDependencyInspect(context?.loopSafety, "inspect_stair");
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
      stairCount: stairs.length,
      stairs: stairs.map((s) => summarizeStairDetail(loaded.model, s)),
      nextStep:
        stairs.length === 0
          ? "No stairs yet. Inspect levels, measure clear space, then create_stair (straight or lShape)."
          : "Inspect a specific stairId before modifying or deleting.",
    };
    homeDesignAgentDevLog("inspect_stair_execute_end", {
      tool: "inspect_stair",
      ok: true,
      resultSummary: {
        stairCount: stairs.length,
        modelSource: loaded.source,
      },
    });
    noteDependencyInspect(context?.loopSafety, "inspect_stair");
    return result;
  },
});
