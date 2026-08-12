import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  DesignServiceError,
  extractShellFromModel,
  findExposedRegion,
  type DesignOperation,
} from "@aihd/domain";
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
  listRoofAssemblies,
  scrubNulls,
  summarizeMass,
} from "./roofMassShared";

const createRoofMassParameters = z
  .object({
    label: z.string().min(1).optional().describe("Optional human label, e.g. wing / porch."),
    assemblyId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Target assembly. Omit to use/promote the existing shell or composed assembly.",
      ),
    type: z
      .enum(["gable", "shed", "flat", "hip"])
      .describe(
        "Mass generator type. Hip is single-mass safe; hip intersections with a second mass are unsupported.",
      ),
    originX: z
      .number()
      .describe("Plan center X (width axis, feet). Building center is 0."),
    originZ: z
      .number()
      .describe(
        "Plan center Z (depth axis, feet; maps to generator origin.y). Front is negative Z.",
      ),
    width: z.number().positive().describe("Mass footprint width in feet."),
    depth: z.number().positive().describe("Mass footprint depth in feet."),
    pitch: z
      .number()
      .nonnegative()
      .describe("Pitch as X-in-12. Use 0 for flat."),
    ridgeDirection: z
      .enum(["width", "depth"])
      .optional()
      .describe(
        "Ridge along width (x) or depth (z). Default depth. For a secondary/cross gable, use the direction PERPENDICULAR to the main mass ridge.",
      ),
    eaveHeight: z
      .number()
      .nonnegative()
      .optional()
      .describe("Eave height in feet. Defaults to current wall height."),
    overhang: z
      .number()
      .nonnegative()
      .optional()
      .describe("Uniform overhang in feet. Default 1.5."),
    highSide: z
      .enum(["front", "rear", "left", "right"])
      .optional()
      .describe("Shed only: elevated eave side."),
    materialId: z.string().min(1).optional(),
    levelId: z
      .string()
      .min(1)
      .optional()
      .describe("Owning story. For lower roofs use the lower level id (usually level-1)."),
    role: z
      .enum(["primary", "lower"])
      .optional()
      .describe(
        'Use "lower" for exposed first-floor / setback coverage (creates an independent assembly). Omit/primary to add a mass to the main/upper roof assembly (max 2 interacting masses).',
      ),
    exposedRegionId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional id from inspect_exposed_roof_regions. Marks coverage intent; still pass origin/width/depth/eave yourself.",
      ),
  })
  .strict();

type Args = z.infer<typeof createRoofMassParameters>;

export const createRoofMassTool = tool({
  name: "create_roof_mass",

  description:
    "Stage a parametric roof mass (gable/shed/flat/hip). Geometry engine recompiles clipped planes and valleys — never pass valley coordinates or raw plane polygons. role=lower creates an independent assembly covering an exposed lower-story rectangle (use inspect_exposed_roof_regions). Omitting role adds to the primary/upper assembly (max 2 interacting masses). For a secondary/cross gable on the primary roof, set ridgeDirection perpendicular to the main mass AND size the wing so it breaks through. Stages only.",

  parameters: createRoofMassParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = scrubNulls(rawArgs as Record<string, unknown>) as Args;

    homeDesignAgentDevLog("create_roof_mass_execute_start", {
      tool: "create_roof_mass",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (payload: Record<string, unknown>) => {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      recordToolFailure(context?.loopSafety, "create_roof_mass", args, {
        validationFailure: Boolean(code),
      });
      homeDesignAgentDevLog("create_roof_mass_execute_end", {
        tool: "create_roof_mass",
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
        ? guardAgainstIdenticalFailure(context.loopSafety, "create_roof_mass", args)
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

      const shell = extractShellFromModel(loaded.model);
      if (!shell) {
        return fail({
          error: "No BuildingShell present; cannot author roof masses.",
          code: "NO_SHELL",
        });
      }

      if (args.type === "flat" && args.pitch !== 0) {
        return fail({
          error: "flat roof masses require pitch 0.",
          code: "ROOF_PITCH",
        });
      }
      if (args.type !== "flat" && (args.pitch < 1 || args.pitch > 24)) {
        return fail({
          error: `pitch ${args.pitch}/12 is outside supported range 1–24 for ${args.type}.`,
          code: "ROOF_PITCH",
        });
      }
      if (args.type === "shed" && !args.highSide) {
        return fail({
          error: "shed masses require highSide (front|rear|left|right).",
          code: "ROOF_SHED_HIGHSIDE",
        });
      }
      if (
        args.materialId &&
        !loaded.model.materials.some((m) => m.id === args.materialId)
      ) {
        return fail({
          error: `materialId "${args.materialId}" not found.`,
          code: "MATERIAL_NOT_FOUND",
        });
      }

      const beforeMasses = listRoofAssemblies(loaded.model).flatMap((a) =>
        a.masses.map((m) => ({ assemblyId: a.id, massId: m.id, label: m.label })),
      );

      const asLower = args.role === "lower" || Boolean(args.exposedRegionId);
      const exposed = args.exposedRegionId
        ? findExposedRegion(loaded.model, args.exposedRegionId)
        : null;
      const operations: DesignOperation[] = [
        {
          op: "createRoofMass",
          assemblyId: args.assemblyId,
          label: args.label,
          materialId: args.materialId,
          levelId: args.levelId,
          role: asLower ? "lower" : args.role,
          coversExposedRegionId: args.exposedRegionId,
          generator: {
            type: args.type,
            origin: { x: args.originX, y: args.originZ },
            width: args.width,
            depth: args.depth,
            pitch: args.type === "flat" ? 0 : args.pitch,
            overhang: args.overhang ?? 1.5,
            ridgeDirection: args.ridgeDirection ?? "depth",
            eaveHeight:
              args.eaveHeight ??
              exposed?.suggestedEaveHeight ??
              (asLower
                ? (loaded.model.levels[0]?.elevation ?? 0) +
                  (loaded.model.levels[0]?.height ?? shell.wallHeight)
                : shell.wallHeight),
            highSide: args.highSide,
          },
        },
      ];

      const staged = await stageDesignOperations(
        context,
        operations,
        `Stage create_roof_mass ${args.type}`,
      );

      if (!staged.success) {
        const issue = staged.validation?.issues?.[0];
        return fail({
          error: staged.error,
          code: issue?.code ?? staged.code ?? "VALIDATION_FAILED",
          validation: staged.validation,
          conflicts: staged.validation?.issues ?? [],
          geometryHint: issue?.details ?? null,
          beforeMasses,
          operation: operationMeta(context),
          limitationNote:
            "If ROOF_INTERSECT_BURIED: enlarge wing depth/width (and match pitch) using geometryHint, then retry create_roof_mass. If ROOF_INTERSECT_UNSUPPORTED or >2 masses, choose a supported two-mass design. Never invent valleys.",
        });
      }

      const afterAssemblies = listRoofAssemblies(staged.afterModel);
      const created = afterAssemblies
        .flatMap((a) => a.masses.map((m) => ({ assembly: a, mass: m })))
        .find(
          (entry) =>
            !beforeMasses.some(
              (b) =>
                b.massId === entry.mass.id && b.assemblyId === entry.assembly.id,
            ),
        );

      recordToolSuccess(context.loopSafety);

      const summary = created
        ? summarizeMass(created.assembly, created.mass)
        : null;

      const result = {
        success: true as const,
        staged: true as const,
        created: true as const,
        projectId: context.projectId,
        baseRevision: staged.baseRevision,
        massId: created?.mass.id ?? null,
        assemblyId: created?.assembly.id ?? null,
        mass: summary,
        derived: {
          valleyCount:
            created?.assembly.edges.filter((e) => e.kind === "valley").length ??
            0,
          planeCount: created?.assembly.planes.length ?? 0,
        },
        modelSource: "staged" as const,
        dirty: true as const,
        validation: staged.validation,
        operation: operationMeta(context),
        nextStep: asLower
          ? "Lower roof mass is staged as an independent assembly. Use inspect_exposed_roof_regions / inspect_roof_mass / render_preview. Do not claim remaining uncovered regions are roofed. Runtime commits once at the end."
          : "Roof mass is staged. Use inspect_roof_mass / render_preview to evaluate clipped valleys. Runtime commits once at the end.",
      };

      homeDesignAgentDevLog("create_roof_mass_execute_end", {
        tool: "create_roof_mass",
        arguments: args,
        ok: true,
        massId: result.massId,
        assemblyId: result.assemblyId,
        valleyCount: result.derived.valleyCount,
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
        error: error instanceof Error ? error.message : "create_roof_mass failed",
        code: "CREATE_ROOF_MASS_FAILED",
      });
    }
  },
});
