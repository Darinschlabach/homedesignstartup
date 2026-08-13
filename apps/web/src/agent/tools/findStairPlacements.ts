import { tool } from "@openai/agents";
import type { RunContext } from "@openai/agents";
import {
  findValidStairPlacements,
  StairOpsError,
} from "@aihd/domain";
import { z } from "zod";
import type { DesignAgentContext } from "../context/agentContext";
import { homeDesignAgentDevLog } from "../devLog";
import { noteDependencyInspect } from "../planning/mutationGuard";
import { loadAgentModel } from "../project/loadAgentModel";

const parameters = z
  .object({
    fromLevelId: z.string().min(1),
    toLevelId: z.string().min(1),
    proposedUpperFootprint: z
      .object({
        centerX: z.number(),
        centerZ: z.number(),
        width: z.number().positive(),
        depth: z.number().positive(),
      })
      .strict(),
    supportedTypes: z
      .array(z.enum(["straight", "lShape"]))
      .min(1)
      .optional()
      .describe("Defaults to every currently supported stair type."),
    widths: z
      .array(z.number().min(3))
      .min(1)
      .max(4)
      .optional()
      .describe("Clear widths to evaluate. Defaults to existing stair width or domain minimum."),
    replacingStairId: z
      .string()
      .min(1)
      .optional()
      .describe("Existing stair being relocated/reconfigured; ignored during candidate evaluation."),
    maxCandidates: z.number().int().min(1).max(24).optional(),
  })
  .strict();

export const findStairPlacementsTool = tool({
  name: "find_stair_placements",
  description:
    "Read-only deterministic stair-fit analysis. Given two levels and a proposed axis-aligned upper footprint, searches supported straight/L-shaped configurations and returns only candidates accepted by strict domain geometry, opening, headroom, footprint, wall, and object validation. Use after a stair blocks a level-footprint edit instead of guessing modify_stair coordinates. It does not choose or stage a design. Returns NO_VALID_STAIR_PLACEMENT when the exhaustive search finds none.",
  parameters,
  execute: async (args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    homeDesignAgentDevLog("find_stair_placements_execute_start", {
      tool: "find_stair_placements",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });
    const loaded = await loadAgentModel(context);
    if (!loaded.success) return loaded;

    try {
      const result = findValidStairPlacements(loaded.model, {
        fromLevelId: args.fromLevelId,
        toLevelId: args.toLevelId,
        proposedUpperFootprint: {
          kind: "rect",
          center: {
            x: args.proposedUpperFootprint.centerX,
            y: args.proposedUpperFootprint.centerZ,
          },
          width: args.proposedUpperFootprint.width,
          depth: args.proposedUpperFootprint.depth,
        },
        supportedTypes: args.supportedTypes,
        widths: args.widths,
        replacingStairId: args.replacingStairId,
        maxCandidates: args.maxCandidates ?? 12,
      });
      noteDependencyInspect(context?.loopSafety, "inspect_stair");
      const response = {
        success: true as const,
        projectId: loaded.projectId,
        revision: loaded.revision,
        modelSource: loaded.source,
        dirty: loaded.dirty,
        ...result,
        nextStep:
          result.status === "CANDIDATES_FOUND"
            ? "Compare the valid candidates against the larger design, choose one, and pass its exact authored parameters to modify_stair/create_stair before retrying the footprint."
            : "No supported straight or L-shaped stair fits the proposed footprint and current obstacles. Report NO_VALID_STAIR_PLACEMENT or revise the proposed footprint/design intent; do not guess coordinates.",
      };
      homeDesignAgentDevLog("find_stair_placements_execute_end", {
        tool: "find_stair_placements",
        ok: true,
        status: result.status,
        candidateCount: result.candidates.length,
        evaluatedCount: result.evaluatedCount,
      });
      return response;
    } catch (error) {
      const response = {
        success: false as const,
        code: error instanceof StairOpsError ? error.code : "STAIR_FIT_ANALYSIS_FAILED",
        error: error instanceof Error ? error.message : "Stair-fit analysis failed",
      };
      homeDesignAgentDevLog("find_stair_placements_execute_end", {
        tool: "find_stair_placements",
        ok: false,
        ...response,
      });
      return response;
    }
  },
});
