import type { BuildingModelV1 } from "@aihd/domain";

export type OutcomeStatus = "pending" | "satisfied" | "blocked";

export type PlanDomain =
  | "levels"
  | "spaces"
  | "stairs"
  | "roof"
  | "footprint"
  | "openings"
  | "materials"
  | "walls"
  | "visual"
  | "other";

export type ConstraintKind =
  | "footprint_unchanged"
  | "garage_width_unchanged"
  | "garage_location_unchanged"
  | "front_door_unchanged"
  | "geometry_unchanged"
  | "preserve_stair";

export type OutcomeVerification =
  | { type: "min_level_count"; min: number }
  | { type: "partial_upper_level" }
  | { type: "min_space_count"; min: number }
  | { type: "min_spaces_with_tag"; tag: string; min: number }
  | { type: "vertical_circulation" }
  | { type: "domain_changed"; domain: PlanDomain }
  | { type: "visual_verified" }
  | { type: "manual" };

export type PlannedConstraint = {
  id: string;
  kind: ConstraintKind;
  description: string;
  entityId?: string;
};

export type ConstraintIntentClassification = {
  supported: boolean;
  deterministic: boolean;
  reason?: string;
};

export function isContradictoryPreservationOutcome(
  description: string,
  verification: OutcomeVerification,
): boolean {
  if (verification.type !== "domain_changed") return false;
  return /\b(?:unchanged|preserv(?:e|ed|ing)|remain(?:s|ed)?\s+(?:the\s+)?same|do not change|don't change|without changing)\b/i.test(
    description,
  );
}

/**
 * Deterministic preservation constraints must be grounded in an explicit user
 * request. In particular, geometry_unchanged is universal and cannot be inferred
 * from a subjective visual objective merely because it uses words like "keep".
 */
export function classifyConstraintIntent(
  userMessage: string,
  kind: ConstraintKind,
): ConstraintIntentClassification {
  if (kind !== "geometry_unchanged") {
    return { supported: true, deterministic: true };
  }

  const message = userMessage.toLowerCase();
  const explicitlyNamesGeometry = /\bgeometry\b/.test(message);
  const explicitlyPreserves =
    /\b(?:without|do not|don't|must not|never)\b[^.!?;]{0,80}\b(?:change|changing|alter|altering|modify|modifying|touch|touching)\b/.test(
      message,
    ) ||
    /\b(?:keep|preserve)\b[^.!?;]{0,80}\bgeometry\b[^.!?;]{0,40}\b(?:unchanged|same|intact)\b/.test(
      message,
    ) ||
    /\bgeometry\b[^.!?;]{0,40}\b(?:unchanged|the same|intact)\b/.test(message);

  if (explicitlyNamesGeometry && explicitlyPreserves) {
    return { supported: true, deterministic: true };
  }

  return {
    supported: false,
    deterministic: false,
    reason:
      "geometry_unchanged requires an explicit user instruction preserving geometry; subjective visual or massing objectives must use manual/visual outcomes instead.",
  };
}

export type PlannedOutcome = {
  id: string;
  description: string;
  domain: PlanDomain;
  verification: OutcomeVerification;
  status: OutcomeStatus;
  blockedReason?: string;
};

export type PlannedDependency = {
  id: string;
  description: string;
  before: string[];
  after: string[];
};

export type TaskPlan = {
  objective: string;
  constraints: PlannedConstraint[];
  requiredOutcomes: PlannedOutcome[];
  affectedDomains: PlanDomain[];
  dependencies: PlannedDependency[];
  completionChecks: string[];
  /** Set false only for trivial requests incorrectly routed through planning. */
  planningRequired: boolean;
  updatedAt: string;
};

export type OperationRunMetrics = {
  renderPreviewSuccessCount: number;
  inspectProjectCount: number;
  progressCheckCount: number;
  validationFailureCount: number;
  lastValidationCodes: string[];
};

export type CompletionReport = {
  readyToCommit: boolean;
  planningRequired: boolean;
  hasPlan: boolean;
  objective: string | null;
  constraints: Array<{
    id: string;
    description: string;
    ok: boolean;
    violation?: string;
  }>;
  outcomes: Array<{
    id: string;
    description: string;
    domain: PlanDomain;
    status: OutcomeStatus;
    satisfied: boolean;
    reason?: string;
    blockedReason?: string;
  }>;
  pendingOutcomeIds: string[];
  blockedOutcomeIds: string[];
  constraintViolations: string[];
  missingChecks: string[];
  replanSuggested: boolean;
  replanReason?: string;
  turnEfficiencyNotes: string[];
  gapSummary?: CompletionGapSummary;
};

export type CompletionGapSummary = {
  unsatisfiedOutcomes: Array<{
    id: string;
    description: string;
    reason?: string;
  }>;
  violatedConstraints: Array<{
    id: string;
    description: string;
    violation?: string;
  }>;
  blockedDependencies: string[];
  completedOutcomes: Array<{
    id: string;
    description: string;
  }>;
  repairGuidance: string;
};

const DOMAIN_OPS: Record<PlanDomain, string[]> = {
  levels: ["createLevel", "updateLevel", "deleteLevel", "setLevelFootprint", "updateLevelFootprint", "clearLevelFootprint"],
  spaces: ["createSpace", "updateSpace", "deleteSpace"],
  stairs: ["createStair", "updateStair", "deleteStair"],
  roof: ["updateRoof", "createRoofMass", "updateRoofMass", "deleteRoofMass", "createRoofPlane"],
  footprint: ["updateBuildingDimensions"],
  openings: ["createOpening", "updateOpening", "deleteOpening"],
  materials: ["createMaterial", "setMaterial"],
  walls: ["createWall", "updateWall", "deleteWall"],
  visual: [],
  other: [],
};

/** Generic complexity heuristic — not scenario-specific. */
export function suggestsStructuredPlanning(userMessage: string): boolean {
  const m = userMessage.trim();
  if (m.length < 70) return false;

  const constraintMarkers =
    (m.match(
      /\b(without|keep|don't|do not|preserve|unchanged|same|must not|cannot change|do not move|don't move|don't change)\b/gi,
    ) ?? []).length;
  const conjunctions = (m.match(/\band\b/gi) ?? []).length;
  const clauses = (m.match(/[,;]/g) ?? []).length;

  if (constraintMarkers >= 2) return true;
  if (constraintMarkers >= 1 && (conjunctions >= 2 || clauses >= 1)) return true;
  if (m.length >= 140 && conjunctions >= 2) return true;
  return false;
}

function shellOpening(
  model: BuildingModelV1,
  type: string,
  wall?: string,
) {
  const openings = model.shell?.openings ?? [];
  if (wall) {
    return openings.find((o) => o.type === type && o.wall === wall) ?? null;
  }
  return openings.find((o) => o.type === type) ?? null;
}

function spacesWithTag(model: BuildingModelV1, tag: string): number {
  return (model.spaces ?? []).filter((s) =>
    (s.tags ?? []).some((t) => t.toLowerCase() === tag.toLowerCase()),
  ).length;
}

function hasVerticalCirculation(model: BuildingModelV1): boolean {
  const levels = model.levels ?? [];
  if (levels.length < 2) return true;
  const levelIds = new Set(levels.map((l) => l.id));
  return (model.stairs ?? []).some(
    (s) =>
      levelIds.has(s.fromLevelId) &&
      levelIds.has(s.toLevelId) &&
      s.fromLevelId !== s.toLevelId,
  );
}

function hasPartialUpperLevel(model: BuildingModelV1): boolean {
  const shell = model.shell;
  if (!shell || model.levels.length < 2) return false;
  const baseArea = shell.width * shell.depth;
  const lowestElevation = Math.min(...model.levels.map((level) => level.elevation));
  return model.levels.some((level) => {
    if (level.elevation <= lowestElevation || level.footprintSource !== "custom") {
      return false;
    }
    const footprint = level.footprint;
    return Boolean(
      footprint &&
        footprint.width * footprint.depth < baseArea - 1e-6,
    );
  });
}

/** When levels were added, the plan must address circulation and the model must have stairs. */
function implicitMultiLevelChecks(
  baseModel: BuildingModelV1,
  workingModel: BuildingModelV1,
  plan: TaskPlan | null,
): string[] {
  const missing: string[] = [];
  const baseLevels = baseModel.levels?.length ?? 1;
  const workLevels = workingModel.levels?.length ?? 1;
  if (workLevels < 2 || baseLevels >= workLevels) return missing;

  const planHasCirc = plan?.requiredOutcomes.some(
    (o) => o.verification.type === "vertical_circulation",
  );
  if (!planHasCirc) {
    missing.push(
      "Plan must include a vertical_circulation outcome when adding upper levels.",
    );
  }
  if (!hasVerticalCirculation(workingModel)) {
    missing.push(
      "Multi-level model lacks vertical circulation between distinct levels.",
    );
  }
  return missing;
}

function domainChanged(
  stagedOps: Array<{ op: string }>,
  domain: PlanDomain,
): boolean {
  const allowed = DOMAIN_OPS[domain] ?? [];
  if (allowed.length === 0) return false;
  return stagedOps.some((o) => allowed.includes(o.op));
}

export function verifyConstraint(
  constraint: PlannedConstraint,
  baseModel: BuildingModelV1,
  workingModel: BuildingModelV1,
): { ok: boolean; violation?: string } {
  const baseShell = baseModel.shell;
  const workShell = workingModel.shell;

  switch (constraint.kind) {
    case "footprint_unchanged": {
      if (!baseShell || !workShell) return { ok: true };
      const same =
        baseShell.width === workShell.width &&
        baseShell.depth === workShell.depth;
      return same
        ? { ok: true }
        : {
            ok: false,
            violation: `Footprint changed (${baseShell.width}×${baseShell.depth} → ${workShell.width}×${workShell.depth}).`,
          };
    }
    case "garage_width_unchanged": {
      const before = shellOpening(baseModel, "garageDoor", "front");
      const after = shellOpening(workingModel, "garageDoor", "front");
      if (!before || !after) return { ok: true };
      return before.width === after.width
        ? { ok: true }
        : {
            ok: false,
            violation: `Garage width changed (${before.width} → ${after.width} ft).`,
          };
    }
    case "garage_location_unchanged": {
      const before = shellOpening(baseModel, "garageDoor", "front");
      const after = shellOpening(workingModel, "garageDoor", "front");
      if (!before || !after) return { ok: true };
      const same =
        before.offset === after.offset &&
        before.width === after.width &&
        before.wall === after.wall;
      return same
        ? { ok: true }
        : { ok: false, violation: "Garage door location or width changed." };
    }
    case "front_door_unchanged": {
      const before =
        shellOpening(baseModel, "door", "front") ??
        baseModel.shell?.openings?.find((o) => o.id === "door-front") ??
        null;
      const after =
        shellOpening(workingModel, "door", "front") ??
        workingModel.shell?.openings?.find((o) => o.id === "door-front") ??
        null;
      if (!before || !after) return { ok: true };
      const same =
        before.offset === after.offset &&
        before.width === after.width &&
        before.wall === after.wall;
      return same
        ? { ok: true }
        : { ok: false, violation: "Front door position or size changed." };
    }
    case "geometry_unchanged": {
      const fp = JSON.stringify({
        shell: baseShell
          ? { w: baseShell.width, d: baseShell.depth, h: baseShell.wallHeight }
          : null,
        walls: (baseModel.walls ?? []).map((w) => [w.id, w.start, w.end]),
        spaces: (baseModel.spaces ?? []).map((s) => [s.id, s.polygon]),
        levels: (baseModel.levels ?? []).map((l) => [l.id, l.footprintSource, l.footprint]),
        stairs: (baseModel.stairs ?? []).map((s) => [s.id, s.origin, s.type]),
      });
      const fw = JSON.stringify({
        shell: workShell
          ? { w: workShell.width, d: workShell.depth, h: workShell.wallHeight }
          : null,
        walls: (workingModel.walls ?? []).map((w) => [w.id, w.start, w.end]),
        spaces: (workingModel.spaces ?? []).map((s) => [s.id, s.polygon]),
        levels: (workingModel.levels ?? []).map((l) => [l.id, l.footprintSource, l.footprint]),
        stairs: (workingModel.stairs ?? []).map((s) => [s.id, s.origin, s.type]),
      });
      return fp === fw
        ? { ok: true }
        : { ok: false, violation: "Building geometry changed." };
    }
    case "preserve_stair": {
      const baseStairs = baseModel.stairs ?? [];
      if (baseStairs.length === 0) return { ok: true };
      const workById = new Map((workingModel.stairs ?? []).map((s) => [s.id, s]));
      for (const s of baseStairs) {
        if (constraint.entityId && s.id !== constraint.entityId) continue;
        const w = workById.get(s.id);
        if (!w) {
          return { ok: false, violation: `Stair ${s.id} was removed.` };
        }
        if (
          w.origin.x !== s.origin.x ||
          w.origin.y !== s.origin.y ||
          w.type !== s.type ||
          w.width !== s.width
        ) {
          return {
            ok: false,
            violation: `Stair ${s.id} was moved or reconfigured.`,
          };
        }
      }
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}

export function verifyOutcome(
  outcome: PlannedOutcome,
  workingModel: BuildingModelV1,
  stagedOps: Array<{ op: string }>,
  metrics: OperationRunMetrics,
): { satisfied: boolean; reason?: string } {
  if (outcome.status === "blocked") {
    return { satisfied: false, reason: outcome.blockedReason ?? "Blocked." };
  }
  const v = outcome.verification;
  switch (v.type) {
    case "min_level_count":
      return (workingModel.levels?.length ?? 0) >= v.min
        ? { satisfied: true }
        : {
            satisfied: false,
            reason: `Level count ${workingModel.levels?.length ?? 0} < ${v.min}.`,
          };
    case "partial_upper_level":
      return hasPartialUpperLevel(workingModel)
        ? { satisfied: true }
        : {
            satisfied: false,
            reason:
              "No upper level has a custom footprint materially smaller than the first-floor shell footprint.",
          };
    case "min_space_count":
      return (workingModel.spaces?.length ?? 0) >= v.min
        ? { satisfied: true }
        : {
            satisfied: false,
            reason: `Space count ${workingModel.spaces?.length ?? 0} < ${v.min}.`,
          };
    case "min_spaces_with_tag": {
      const n = spacesWithTag(workingModel, v.tag);
      return n >= v.min
        ? { satisfied: true }
        : {
            satisfied: false,
            reason: `Spaces tagged "${v.tag}": ${n} < ${v.min}.`,
          };
    }
    case "vertical_circulation":
      return hasVerticalCirculation(workingModel)
        ? { satisfied: true }
        : {
            satisfied: false,
            reason:
              "Multi-level building lacks vertical circulation between distinct levels.",
          };
    case "domain_changed":
      return domainChanged(stagedOps, v.domain)
        ? { satisfied: true }
        : {
            satisfied: false,
            reason: `No staged changes in domain "${v.domain}".`,
          };
    case "visual_verified":
      if (metrics.renderPreviewSuccessCount === 0) {
        return {
          satisfied: false,
          reason: "No successful render_preview this operation.",
        };
      }
      if (
        outcome.domain !== "visual" &&
        outcome.domain !== "other" &&
        !domainChanged(stagedOps, outcome.domain)
      ) {
        return {
          satisfied: false,
          reason: `Visual inspection occurred, but no staged changes were made in outcome domain "${outcome.domain}".`,
        };
      }
      return { satisfied: true };
    case "manual":
      if (outcome.status !== "satisfied") {
        return { satisfied: false, reason: "Manual outcome not marked satisfied." };
      }
      if (
        outcome.domain !== "visual" &&
        outcome.domain !== "other" &&
        !domainChanged(stagedOps, outcome.domain)
      ) {
        return {
          satisfied: false,
          reason: `Manual outcome was marked satisfied, but no staged changes were made in outcome domain "${outcome.domain}".`,
        };
      }
      return { satisfied: true };
    default:
      return { satisfied: false, reason: "Unknown verification type." };
  }
}

export function assessOperationCompletion(options: {
  userMessage: string;
  plan: TaskPlan | null;
  baseModel: BuildingModelV1;
  workingModel: BuildingModelV1;
  stagedOps: Array<{ op: string }>;
  metrics: OperationRunMetrics;
  replanSuggested?: boolean;
  replanReason?: string;
  blockedDependencies?: string[];
}): CompletionReport {
  const planningRequired = suggestsStructuredPlanning(options.userMessage);
  const turnEfficiencyNotes: string[] = [];
  if (options.metrics.inspectProjectCount > 2) {
    turnEfficiencyNotes.push(
      "Consider narrower inspect tools — inspect_project was called repeatedly.",
    );
  }
  if (options.metrics.progressCheckCount === 0 && planningRequired && options.plan) {
    turnEfficiencyNotes.push(
      "Call check_operation_progress before finishing coordinated requests.",
    );
  }

  if (!options.plan) {
    const missingChecks: string[] = [];
    if (planningRequired) {
      missingChecks.push("Structured task plan was not created.");
    }
    const implicit = implicitMultiLevelChecks(
      options.baseModel,
      options.workingModel,
      null,
    );
    return {
      readyToCommit: !planningRequired && implicit.length === 0,
      planningRequired,
      hasPlan: false,
      objective: null,
      constraints: [],
      outcomes: [],
      pendingOutcomeIds: [],
      blockedOutcomeIds: [],
      constraintViolations: [],
      missingChecks: [...missingChecks, ...implicit],
      replanSuggested: Boolean(options.replanSuggested),
      replanReason: options.replanReason,
      turnEfficiencyNotes,
    };
  }

  const constraintResults = options.plan.constraints.map((c) => {
    const result = verifyConstraint(c, options.baseModel, options.workingModel);
    return {
      id: c.id,
      description: c.description,
      ok: result.ok,
      violation: result.violation,
    };
  });

  const outcomeResults = options.plan.requiredOutcomes.map((o) => {
    const check = verifyOutcome(o, options.workingModel, options.stagedOps, options.metrics);
    const status: OutcomeStatus = o.status === "blocked"
      ? "blocked"
      : check.satisfied
        ? "satisfied"
        : "pending";
    return {
      id: o.id,
      description: o.description,
      domain: o.domain,
      status,
      satisfied: check.satisfied,
      reason: check.reason,
      blockedReason: o.blockedReason,
    };
  });

  const pendingOutcomeIds = outcomeResults
    .filter((o) => !o.satisfied && o.status !== "blocked")
    .map((o) => o.id);
  const blockedOutcomeIds = outcomeResults
    .filter((o) => o.status === "blocked")
    .map((o) => o.id);
  const constraintViolations = constraintResults
    .filter((c) => !c.ok)
    .map((c) => c.violation ?? c.description);

  const missingChecks: string[] = [];
  if (options.plan.planningRequired && options.metrics.progressCheckCount === 0) {
    missingChecks.push("check_operation_progress was not called.");
  }
  missingChecks.push(
    ...implicitMultiLevelChecks(
      options.baseModel,
      options.workingModel,
      options.plan,
    ),
  );
  missingChecks.push(...(options.blockedDependencies ?? []));

  const readyToCommit =
    pendingOutcomeIds.length === 0 &&
    blockedOutcomeIds.length === 0 &&
    constraintViolations.length === 0 &&
    missingChecks.length === 0;

  return {
    readyToCommit,
    planningRequired: options.plan.planningRequired,
    hasPlan: true,
    objective: options.plan.objective,
    constraints: constraintResults,
    outcomes: outcomeResults,
    pendingOutcomeIds,
    blockedOutcomeIds,
    constraintViolations,
    missingChecks,
    replanSuggested: Boolean(options.replanSuggested),
    replanReason: options.replanReason,
    turnEfficiencyNotes,
    gapSummary: buildCompletionGapSummary({
      constraintResults,
      outcomeResults,
      missingChecks,
      replanReason: options.replanReason,
    }),
  };
}

export function buildCompletionGapSummary(input: {
  constraintResults: Array<{
    id: string;
    description: string;
    ok: boolean;
    violation?: string;
  }>;
  outcomeResults: Array<{
    id: string;
    description: string;
    status: OutcomeStatus;
    satisfied: boolean;
    reason?: string;
    blockedReason?: string;
  }>;
  missingChecks: string[];
  replanReason?: string;
}): CompletionGapSummary {
  const unsatisfiedOutcomes = input.outcomeResults
    .filter((o) => !o.satisfied)
    .map((o) => ({
      id: o.id,
      description: o.description,
      reason: o.blockedReason ?? o.reason,
    }));

  const violatedConstraints = input.constraintResults
    .filter((c) => !c.ok)
    .map((c) => ({
      id: c.id,
      description: c.description,
      violation: c.violation,
    }));

  const completedOutcomes = input.outcomeResults
    .filter((o) => o.satisfied)
    .map((o) => ({ id: o.id, description: o.description }));

  const blockedDependencies = [
    ...input.missingChecks,
    ...(input.replanReason ? [input.replanReason] : []),
  ];

  const repairParts: string[] = [
    "Repair ONLY the remaining gaps while preserving completed staged work.",
    "Do NOT replace the task plan from scratch — revise/merge with set_task_plan if needed.",
  ];
  if (violatedConstraints.length) {
    repairParts.push(
      `Fix constraint violations: ${violatedConstraints.map((c) => c.description).join("; ")}.`,
    );
  }
  if (unsatisfiedOutcomes.length) {
    repairParts.push(
      `Complete pending outcomes: ${unsatisfiedOutcomes.map((o) => o.description).join("; ")}.`,
    );
  }
  if (blockedDependencies.length) {
    repairParts.push(
      `Resolve blocked dependencies before retrying failed mutations.`,
    );
  }

  return {
    unsatisfiedOutcomes,
    violatedConstraints,
    blockedDependencies,
    completedOutcomes,
    repairGuidance: repairParts.join(" "),
  };
}

export function summarizePlan(plan: TaskPlan) {
  return {
    objective: plan.objective,
    constraints: plan.constraints.map((c) => ({
      id: c.id,
      kind: c.kind,
      description: c.description,
    })),
    requiredOutcomes: plan.requiredOutcomes.map((o) => ({
      id: o.id,
      description: o.description,
      domain: o.domain,
      verification: o.verification,
      status: o.status,
    })),
    affectedDomains: plan.affectedDomains,
    dependencies: plan.dependencies,
    completionChecks: plan.completionChecks,
  };
}
