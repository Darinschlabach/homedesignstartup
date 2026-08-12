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
      outcomeById.set(outcome.id, {
        ...outcome,
        status: "blocked",
        blockedReason: supersedeOutcomes.get(outcome.id),
      });
      supersededOutcomeIds.push(outcome.id);
      notes.push(
        `Outcome ${outcome.id} marked blocked (superseded): ${supersedeOutcomes.get(outcome.id)}`,
      );
      continue;
    }
    outcomeById.set(outcome.id, { ...outcome });
    preservedOutcomeIds.push(outcome.id);
  }

  for (const outcome of incoming.requiredOutcomes) {
    const prev = outcomeById.get(outcome.id);
    if (prev) {
      outcomeById.set(outcome.id, {
        ...prev,
        description: outcome.description,
        domain: outcome.domain,
        verification: outcome.verification,
      });
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
      constraintById.set(constraint.id, {
        ...constraintById.get(constraint.id)!,
        kind: constraint.kind,
        description: constraint.description,
        entityId: constraint.entityId,
      });
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
