import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import { mergeTaskPlanRevision } from "../planning/planRevision";
import {
  suggestsStructuredPlanning,
  classifyConstraintIntent,
  classifyOutcomeRequirement,
  isContradictoryPreservationOutcome,
  isPreservationOutcome,
  summarizePlan,
  type ConstraintKind,
  type OutcomeVerification,
  type PlanDomain,
  type PlannedConstraint,
  type PlannedDependency,
  type PlannedOutcome,
  type TaskPlan,
} from "../planning/taskPlan";
import { operationMeta } from "../operation/agentOperation";

const CONSTRAINT_KIND_GUIDANCE =
  "Deterministic constraint kinds verify exact model preservation. Use ONLY when the user explicitly asked to preserve that property. Subjective design goals (balanced massing, not top-heavy, more interesting look) belong in requiredOutcomes as manual or visual_verified — NOT as geometry_unchanged or other deterministic constraints.";

const constraintKindSchema = z.enum([
  "footprint_unchanged",
  "garage_width_unchanged",
  "garage_location_unchanged",
  "front_door_unchanged",
  "geometry_unchanged",
  "preserve_stair",
]);

const planDomainSchema = z.enum([
  "levels",
  "level_footprint",
  "spaces",
  "stairs",
  "roof",
  "footprint",
  "openings",
  "materials",
  "walls",
  "visual",
  "other",
]);

const verificationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("min_level_count"), min: z.number().int().positive() }),
  z.object({ type: z.literal("partial_upper_level") }),
  z.object({ type: z.literal("min_space_count"), min: z.number().int().positive() }),
  z.object({
    type: z.literal("min_spaces_with_tag"),
    tag: z.string().min(1),
    min: z.number().int().positive(),
  }),
  z.object({ type: z.literal("vertical_circulation") }),
  z.object({ type: z.literal("domain_changed"), domain: planDomainSchema }),
  z.object({ type: z.literal("visual_verified") }),
  z.object({ type: z.literal("manual") }),
]);

const setTaskPlanParameters = z
  .object({
    objective: z
      .string()
      .min(1)
      .describe(
        "Concise restatement of the user objective. On replan, this field is ignored — the original objective is preserved.",
      ),
    constraints: z
      .array(
        z
          .object({
            id: z.string().min(1),
            kind: constraintKindSchema.describe(
              "footprint_unchanged: user said do not change building shell footprint. " +
                "garage_width_unchanged / garage_location_unchanged: user said keep garage size/location. " +
                "front_door_unchanged: user said do not move front door. " +
                "preserve_stair: user said keep existing stair location/configuration. " +
                "geometry_unchanged: user said do not change ANY building geometry — rare; never use for subjective massing/visual goals.",
            ),
            description: z.string().min(1),
            entityId: z.string().min(1).nullable().optional(),
          })
          .strict(),
      )
      .default([]),
    requiredOutcomes: z
      .array(
        z
          .object({
            id: z.string().min(1),
            description: z.string().min(1),
            domain: planDomainSchema,
            requirement: z
              .enum(["required", "optional"])
              .default("required")
              .describe(
                "required only for explicit user requirements; optional for conditional or agent-generated design opportunities and never commit-blocking.",
              ),
            verification: verificationSchema.describe(
              "Use vertical_circulation when multi-level access is required. " +
                "Use visual_verified or manual for subjective design goals (balanced massing, not top-heavy, more interesting exterior). " +
                "Use partial_upper_level when the user requires a partial, reduced, or setback upper story; min_level_count alone does not verify that geometry. " +
                "Use domain_changed when a domain must be materially edited. Use level_footprint for per-story custom/setback footprints; footprint means only the primary BuildingShell.",
            ),
          })
          .strict(),
      )
      .min(1),
    affectedDomains: z.array(planDomainSchema).min(1),
    dependencies: z
      .array(
        z
          .object({
            id: z.string().min(1),
            description: z.string().min(1),
            before: z.array(z.string()).default([]),
            after: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .default([]),
    completionChecks: z.array(z.string().min(1)).min(1),
    planningRequired: z.boolean().default(true),
    supersedeOutcomes: z
      .array(
        z
          .object({
            id: z.string().min(1),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .nullable()
      .optional()
      .describe(
        "When revising a plan, mark outcomes no longer applicable as blocked with a reason. Omitted outcomes are preserved — never silently removed.",
      ),
    supersedeConstraints: z
      .array(
        z
          .object({
            id: z.string().min(1),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .nullable()
      .optional()
      .describe(
        "When revising a plan, explicitly supersede constraints that no longer apply. Omitted constraints are preserved.",
      ),
  })
  .strict();

type Args = z.infer<typeof setTaskPlanParameters>;

export const setTaskPlanTool = tool({
  name: "set_task_plan",

  description:
    "Create or REVISE (merge) the structured task plan for this operation BEFORE staging mutations on coordinated requests. " +
    "Derive objective, constraints, required outcomes, domains, dependencies, and completion checks from the user message — do not use canned presets. " +
    CONSTRAINT_KIND_GUIDANCE +
    " When a plan already exists, calling this tool MERGES into the existing plan: original objective, constraints, and required outcomes are preserved unless explicitly superseded. " +
    "Never silently drop vertical_circulation or other required outcomes on replan. " +
    "Do not create outcomes for preservation constraints. Mark conditional or agent-generated opportunities optional. " +
    "For trivial single-domain edits, skip this tool. After major edits, use check_operation_progress before finishing.",

  parameters: setTaskPlanParameters,

  execute: async (rawArgs, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const args = rawArgs as Args;
    const op = context?.operation;

    homeDesignAgentDevLog("set_task_plan_execute", {
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
      objective: args.objective,
      outcomeCount: args.requiredOutcomes.length,
      isRevision: Boolean(op?.taskPlan),
    });

    if (!op) {
      return {
        success: false,
        error: "Agent operation is not initialized.",
        code: "NO_OPERATION",
      };
    }

    const rejectedOutcomes: Array<{ id: string; reason: string }> = [];
    const incomingOutcomes: PlannedOutcome[] = args.requiredOutcomes.flatMap(
      (o): PlannedOutcome[] => {
        if (
          isPreservationOutcome(o.description) ||
          isContradictoryPreservationOutcome(
            o.description,
            o.verification as OutcomeVerification,
          )
        ) {
          rejectedOutcomes.push({
            id: o.id,
            reason:
              "A preservation requirement is verified by a deterministic constraint, not by a mutation outcome.",
          });
          return [];
        }
        return [{
          id: o.id,
          description: o.description,
          domain: o.domain as PlanDomain,
          verification: o.verification as OutcomeVerification,
          requirement: classifyOutcomeRequirement(
            op.userMessage,
            o.description,
            o.requirement,
          ),
          status: "pending",
        }];
      },
    );

    const rejectedConstraints: Array<{ id: string; kind: string; reason: string }> = [];
    const incomingConstraints: PlannedConstraint[] = args.constraints.flatMap(
      (c): PlannedConstraint[] => {
        const classification = classifyConstraintIntent(op.userMessage, c.kind as ConstraintKind);
        if (!classification.supported) {
          rejectedConstraints.push({
            id: c.id,
            kind: c.kind,
            reason: classification.reason ?? "Constraint is not grounded in the user request.",
          });
          return [];
        }
        return [{
        id: c.id,
        kind: c.kind as ConstraintKind,
        description: c.description,
        entityId: c.entityId ?? undefined,
        }];
      },
    );

    const incomingPartial = {
      objective: args.objective,
      constraints: incomingConstraints,
      requiredOutcomes: incomingOutcomes,
      affectedDomains: args.affectedDomains as PlanDomain[],
      dependencies: args.dependencies.map(
        (d): PlannedDependency => ({
          id: d.id,
          description: d.description,
          before: d.before,
          after: d.after,
        }),
      ),
      completionChecks: args.completionChecks,
      planningRequired: args.planningRequired,
    };

    let plan: TaskPlan;
    let revisionNotes: string[] = [];
    const hadExistingPlan = Boolean(op.taskPlan);

    if (op.taskPlan) {
      const merged = mergeTaskPlanRevision(op.taskPlan, incomingPartial, {
        supersedeOutcomes: args.supersedeOutcomes ?? undefined,
        supersedeConstraints: args.supersedeConstraints ?? undefined,
      });
      plan = merged.plan;
      revisionNotes = merged.notes;
    } else {
      plan = {
        ...incomingPartial,
        updatedAt: new Date().toISOString(),
      };
    }

    op.taskPlan = plan;
    op.progressAcknowledged = false;

    const userMessage = op.userMessage;
    const suggested = suggestsStructuredPlanning(userMessage);

    return {
      success: true,
      planned: true,
      revised: hadExistingPlan,
      isRevision: hadExistingPlan,
      revisionNotes,
      rejectedConstraints,
      rejectedOutcomes,
      suggestedPlanningForRequest: suggested,
      plan: summarizePlan(plan),
      constraintKindGuidance: CONSTRAINT_KIND_GUIDANCE,
      nextStep:
        "Execute mutations in dependency order. After validation failures, inspect blocking dependencies (see dependencyHints) and resolve them BEFORE retrying the blocked mutation. Revise the plan with set_task_plan only to merge order/notes — never drop required outcomes silently. Call check_operation_progress before finishing.",
      operation: operationMeta(context),
    };
  },
});
