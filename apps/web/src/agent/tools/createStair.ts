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
import { noteDependencyDomainAddressed } from "../planning/mutationGuard";
import {
  listStairs,
  scrubNulls,
  summarizeStairBrief,
  summarizeStairDetail,
} from "./stairShared";

const createStairParameters = z
  .object({
    fromLevelId: z
      .string()
      .min(1)
      .describe("Lower finished floor (stair starts here)."),
    toLevelId: z
      .string()
      .min(1)
      .describe("Upper finished floor (stair ends here). Must be above fromLevel."),
    type: z
      .enum(["straight", "lShape"])
      .describe(
        'Geometric stair configuration. Only "straight" and "lShape" are supported.',
      ),
    originX: z
      .number()
      .describe(
        "Plan X of the first riser (feet). Building center is 0; positive X is right.",
      ),
    originZ: z
      .number()
      .describe(
        "Plan depth of the first riser (feet). Maps to domain origin.y; front is typically negative Z.",
      ),
    directionDeg: z
      .number()
      .optional()
      .describe(
        "Run direction in degrees from +X toward +Z (CCW). 0 = +X, 90 = +Z (rear). Default 0.",
      ),
    width: z
      .number()
      .positive()
      .describe("Clear stair width in feet (typically ≥ 3)."),
    availableRun: z
      .number()
      .positive()
      .optional()
      .describe(
        "Horizontal run available for treads (feet), excluding landings. When set, tread depth is derived to fit.",
      ),
    targetTreadDepth: z
      .number()
      .positive()
      .optional()
      .describe("Preferred tread depth in feet (default ≈ 11\"). Optional."),
    maxRiserHeight: z
      .number()
      .positive()
      .optional()
      .describe("Maximum riser height in feet (default ≈ 7.75\"). Optional."),
    turn: z
      .enum(["left", "right"])
      .optional()
      .describe('L-shaped only: turn after first flight / landing. Default "left".'),
    firstFlightRisers: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "L-shaped only: risers on the first flight; remaining go on the second.",
      ),
    landingSize: z
      .number()
      .positive()
      .optional()
      .describe(
        "L-shaped only: landing edge length in feet (defaults to stair width).",
      ),
    materialId: z
      .string()
      .min(1)
      .optional()
      .describe("Optional material id for stair meshes."),
    name: z.string().min(1).optional().describe("Optional display name."),
  })
  .strict();

type Args = z.infer<typeof createStairParameters>;

export const createStairTool = tool({
  name: "create_stair",

  description:
    "Stage an architectural stair between two levels (straight or L-shaped). You choose placement/configuration; the domain derives rise, riser count/height, tread depth, landing, and the upper-floor opening. Do NOT invent tread-by-tread meshes. IDs are generated server-side. Stages only — unsupported: spiral, U-shaped, curved, winders.",

  parameters: createStairParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = scrubNulls(rawArgs as Record<string, unknown>) as Args;

    homeDesignAgentDevLog("create_stair_execute_start", {
      tool: "create_stair",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "create_stair", args, {
        validationFailure: Boolean(code),
      });
      homeDesignAgentDevLog("create_stair_execute_end", {
        tool: "create_stair",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "create_stair", args)
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

      const levelIds = new Set(loaded.model.levels.map((l) => l.id));
      if (!levelIds.has(args.fromLevelId) || !levelIds.has(args.toLevelId)) {
        return fail({
          error: "fromLevelId and toLevelId must reference existing levels.",
          code: "STAIR_LEVEL_MISSING",
          levels: loaded.model.levels.map((l) => ({
            id: l.id,
            name: l.name,
            elevation: l.elevation,
            height: l.height,
          })),
        });
      }

      const beforeStairs = listStairs(loaded.model).map(summarizeStairBrief);

      const operations: DesignOperation[] = [
        {
          op: "createStair",
          name: args.name,
          type: args.type,
          fromLevelId: args.fromLevelId,
          toLevelId: args.toLevelId,
          origin: { x: args.originX, y: args.originZ },
          directionDeg: args.directionDeg,
          width: args.width,
          availableRun: args.availableRun,
          targetTreadDepth: args.targetTreadDepth,
          maxRiserHeight: args.maxRiserHeight,
          turn: args.turn,
          firstFlightRisers: args.firstFlightRisers,
          landingSize: args.landingSize,
          materialId: args.materialId,
        },
      ];

      const staged = await stageDesignOperations(
        context,
        operations,
        `Stage create_stair ${args.type} ${args.fromLevelId}→${args.toLevelId}`,
      );

      if (!staged.success) {
        const issue = staged.validation?.issues?.[0];
        return fail({
          error: staged.error,
          code: issue?.code ?? staged.code ?? "VALIDATION_FAILED",
          validation: staged.validation,
          conflicts: staged.validation?.issues ?? [],
          geometryHint: issue?.details ?? null,
          beforeStairs,
          operation: operationMeta(context),
          limitationNote:
            "Supported types: straight, lShape. Spiral / U-shaped / curved / winders are not available. Domain derives tread/riser math — adjust placement, width, or availableRun and retry.",
        });
      }

      const afterStairs = listStairs(staged.afterModel);
      const created = afterStairs.find(
        (s) => !beforeStairs.some((b) => b.id === s.id),
      );

      recordToolSuccess(context.loopSafety);
      noteDependencyDomainAddressed(context?.loopSafety, "stairs");

      const result = {
        success: true as const,
        staged: true as const,
        created: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        stairId: created?.id ?? null,
        stair: created
          ? summarizeStairDetail(staged.afterModel, created)
          : null,
        beforeStairs,
        afterStairs: afterStairs.map(summarizeStairBrief),
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep:
          "Stair is staged with derived geometry and upper-floor opening. Use inspect_stair / render_preview (perspective + top) to evaluate. Runtime commits once at the end.",
      };

      homeDesignAgentDevLog("create_stair_execute_end", {
        tool: "create_stair",
        arguments: args,
        ok: true,
        stairId: result.stairId,
        type: args.type,
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
        error: error instanceof Error ? error.message : "create_stair failed",
        code: "CREATE_STAIR_FAILED",
      });
    }
  },
});
