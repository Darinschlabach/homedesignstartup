import type {
  PlannedConstraint,
  PlannedDependency,
  PlannedOutcome,
  PlanDomain,
  TaskPlan,
} from "./taskPlan";

export type SupersededItem = {
  id: string;
  reason: string;
};

export type PlanRevisionResult = {
  plan: TaskPlan;
  isRevision: boolean;
  preservedOutcomeIds: string[];
  preservedConstraintIds: string[];
  addedOutcomeIds: string[];
  addedConstraintIds: string[];
  supersededOutcomeIds: string[];
  supersededConstraintIds: string[];
  notes: string[];
};

function uniqueDomains(domains: PlanDomain[]): PlanDomain[] {
  return [...new Set(domains)];
}

function mergeDependencies(
  existing: PlannedDependency[],
  incoming: PlannedDependency[],
): PlannedDependency[] {
  const byId = new Map<string, PlannedDependency>();
  for (const d of existing) byId.set(d.id, d);
  for (const d of incoming) byId.set(d.id, d);
  return [...byId.values()];
}

function mergeCompletionChecks(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])];
}

function outcomeRequirementKey(outcome: PlannedOutcome): string {
  return `${outcome.domain}:${JSON.stringify(outcome.verification)}`;
}

function normalizedOutcomeDescription(description: string): string {
  return description.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Merge a revised plan into an existing one. Preserves objective, constraints, and
 * required outcomes unless explicitly superseded with a reason.
 */
export function mergeTaskPlanRevision(
  existing: TaskPlan,
  incoming: {
    objective: string;
    constraints: PlannedConstraint[];
    requiredOutcomes: PlannedOutcome[];
    affectedDomains: PlanDomain[];
    dependencies: PlannedDependency[];
    completionChecks: string[];
    planningRequired: boolean;
  },
  options: {
    supersedeOutcomes?: SupersededItem[];
    supersedeConstraints?: SupersededItem[];
  } = {},
): PlanRevisionResult {
  const supersedeOutcomes = new Map(
    (options.supersedeOutcomes ?? []).map((s) => [s.id, s.reason]),
  );
  const supersedeConstraints = new Map(
    (options.supersedeConstraints ?? []).map((s) => [s.id, s.reason]),
  );

  const notes: string[] = [];
  const preservedOutcomeIds: string[] = [];
  const preservedConstraintIds: string[] = [];
  const addedOutcomeIds: string[] = [];
  const addedConstraintIds: string[] = [];
  const supersededOutcomeIds: string[] = [];
  const supersededConstraintIds: string[] = [];

  const outcomeById = new Map<string, PlannedOutcome>();

  for (const outcome of existing.requiredOutcomes) {
    if (supersedeOutcomes.has(outcome.id)) {
      outcomeById.set(outcome.id, { ...outcome });
      notes.push(
        `Ignored attempted supersession of required outcome ${outcome.id}; a runtime failure does not remove a user requirement.`,
      );
      continue;
    }
    outcomeById.set(outcome.id, { ...outcome });
    preservedOutcomeIds.push(outcome.id);
  }

  for (const outcome of incoming.requiredOutcomes) {
    const prev = outcomeById.get(outcome.id);
    if (prev) {
      const changedRequirement =
        prev.description !== outcome.description ||
        prev.domain !== outcome.domain ||
        JSON.stringify(prev.verification) !== JSON.stringify(outcome.verification);
      if (changedRequirement) {
        notes.push(
          `Ignored attempted rewrite of required outcome ${outcome.id}; existing requirement and verification were preserved. Add a new outcome id for an additional requirement.`,
        );
      }
      if (!changedRequirement && outcome.status === "satisfied" && prev.status !== "satisfied") {
        outcomeById.set(prev.id, {
          ...prev,
          status: "satisfied",
          blockedReason: undefined,
        });
        notes.push(`Updated existing outcome ${prev.id} to satisfied.`);
      } else if (!changedRequirement && prev.status === "blocked" && outcome.status === "pending") {
        outcomeById.set(prev.id, {
          ...prev,
          status: "pending",
          blockedReason: undefined,
        });
        notes.push(`Reopened blocked outcome ${prev.id} after an explicit repair replan.`);
      }
      continue;
    }
    const semanticMatch = [...outcomeById.values()].find(
      (candidate) =>
        outcomeRequirementKey(candidate) === outcomeRequirementKey(outcome) ||
        normalizedOutcomeDescription(candidate.description) ===
          normalizedOutcomeDescription(outcome.description),
    );
    if (semanticMatch) {
      if (outcome.status === "satisfied" && semanticMatch.status !== "satisfied") {
        outcomeById.set(semanticMatch.id, {
          ...semanticMatch,
          status: "satisfied",
          blockedReason: undefined,
        });
        notes.push(
          `Updated existing outcome ${semanticMatch.id} to satisfied from equivalent revised outcome ${outcome.id}.`,
        );
      } else if (semanticMatch.status === "blocked" && outcome.status === "pending") {
        outcomeById.set(semanticMatch.id, {
          ...semanticMatch,
          status: "pending",
          blockedReason: undefined,
        });
        notes.push(
          `Reopened blocked outcome ${semanticMatch.id} from equivalent repair outcome ${outcome.id}.`,
        );
      }
      if (
        semanticMatch.requirement === "optional" &&
        (outcome.requirement ?? "required") === "required"
      ) {
        outcomeById.set(semanticMatch.id, {
          ...semanticMatch,
          requirement: "required",
        });
        notes.push(
          `Promoted existing optional outcome ${semanticMatch.id} to required because the revised plan identified it as an explicit requirement.`,
        );
        continue;
      }
      notes.push(
        `Merged duplicate outcome ${outcome.id} into existing requirement ${semanticMatch.id}.`,
      );
      continue;
    }
    outcomeById.set(outcome.id, { ...outcome, status: "pending" });
    addedOutcomeIds.push(outcome.id);
  }

  for (const outcome of existing.requiredOutcomes) {
    if (
      !incoming.requiredOutcomes.some((o) => o.id === outcome.id) &&
      !supersedeOutcomes.has(outcome.id) &&
      outcomeById.has(outcome.id)
    ) {
      notes.push(
        `Preserved required outcome ${outcome.id} from the original plan (not omitted silently).`,
      );
    }
  }

  const constraintById = new Map<string, PlannedConstraint>();

  for (const constraint of existing.constraints) {
    if (supersedeConstraints.has(constraint.id)) {
      supersededConstraintIds.push(constraint.id);
      notes.push(
        `Constraint ${constraint.id} superseded: ${supersedeConstraints.get(constraint.id)}`,
      );
      continue;
    }
    constraintById.set(constraint.id, { ...constraint });
    preservedConstraintIds.push(constraint.id);
  }

  for (const constraint of incoming.constraints) {
    if (constraintById.has(constraint.id)) {
      const prev = constraintById.get(constraint.id)!;
      if (
        prev.kind !== constraint.kind ||
        prev.description !== constraint.description ||
        prev.entityId !== constraint.entityId
      ) {
        notes.push(
          `Ignored attempted rewrite of constraint ${constraint.id}; the original user constraint was preserved.`,
        );
      }
      continue;
    }
    constraintById.set(constraint.id, { ...constraint });
    addedConstraintIds.push(constraint.id);
  }

  for (const constraint of existing.constraints) {
    if (
      !incoming.constraints.some((c) => c.id === constraint.id) &&
      !supersedeConstraints.has(constraint.id) &&
      constraintById.has(constraint.id)
    ) {
      notes.push(
        `Preserved constraint ${constraint.id} from the original plan (not omitted silently).`,
      );
    }
  }

  if (incoming.objective.trim() !== existing.objective.trim()) {
    notes.push(
      "Revised plan objective was ignored — the original user objective is preserved on replan.",
    );
  }

  const plan: TaskPlan = {
    objective: existing.objective,
    constraints: [...constraintById.values()],
    requiredOutcomes: [...outcomeById.values()],
    affectedDomains: uniqueDomains([
      ...existing.affectedDomains,
      ...incoming.affectedDomains,
    ]),
    dependencies: mergeDependencies(existing.dependencies, incoming.dependencies),
    completionChecks: mergeCompletionChecks(
      existing.completionChecks,
      incoming.completionChecks,
    ),
    planningRequired: existing.planningRequired || incoming.planningRequired,
    updatedAt: new Date().toISOString(),
  };

  if (addedOutcomeIds.length === 0 && addedConstraintIds.length === 0) {
    notes.push(
      "No new semantic requirements were added. Continue only unresolved required outcomes; do not repeat inspection, replanning, or progress checks for already-satisfied work.",
    );
  }

  return {
    plan,
    isRevision: true,
    preservedOutcomeIds,
    preservedConstraintIds,
    addedOutcomeIds,
    addedConstraintIds,
    supersededOutcomeIds,
    supersededConstraintIds,
    notes,
  };
}
