import { describe, expect, it } from "vitest";
import { createLoopSafetyState } from "../loopSafety";
import {
  activeDependencyBlocks,
  guardSuppressedMutationDomain,
  noteDependencyDomainAddressed,
  noteDependencyInspect,
  noteDependencyValidationFailure,
} from "./mutationGuard";
import { mergeTaskPlanRevision } from "./planRevision";
import { deriveDependencyHints } from "./validationHints";
import {
  classifyConstraintIntent,
  isContradictoryPreservationOutcome,
  type TaskPlan,
  verifyOutcome,
} from "./taskPlan";

describe("planning and recovery invariants", () => {
  it("does not convert a subjective visual objective into geometry_unchanged", () => {
    expect(
      classifyConstraintIntent(
        "Keep the composition visually balanced and verify it from a preview.",
        "geometry_unchanged",
      ).supported,
    ).toBe(false);

    expect(
      classifyConstraintIntent(
        "Improve the materials without changing the geometry.",
        "geometry_unchanged",
      ).supported,
    ).toBe(true);
  });

  it("preserves original outcomes when a replan omits or attempts to rewrite them", () => {
    const existing: TaskPlan = {
      objective: "Coordinate a multi-domain design update",
      constraints: [],
      requiredOutcomes: [
        {
          id: "circulation",
          description: "Provide usable vertical circulation",
          domain: "stairs",
          verification: { type: "vertical_circulation" },
          status: "pending",
        },
        {
          id: "visual",
          description: "Verify the staged composition visually",
          domain: "visual",
          verification: { type: "visual_verified" },
          status: "pending",
        },
      ],
      affectedDomains: ["stairs", "visual"],
      dependencies: [],
      completionChecks: ["Check circulation and preview"],
      planningRequired: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const result = mergeTaskPlanRevision(existing, {
      objective: "A narrower retry objective",
      constraints: [],
      requiredOutcomes: [
        {
          id: "circulation",
          description: "Replace the earlier requirement",
          domain: "other",
          verification: { type: "manual" },
          status: "pending",
        },
      ],
      affectedDomains: ["other"],
      dependencies: [],
      completionChecks: ["Retry"],
      planningRequired: true,
    });

    expect(result.plan.requiredOutcomes).toHaveLength(2);
    expect(result.plan.requiredOutcomes[0]).toMatchObject({
      id: "circulation",
      description: "Provide usable vertical circulation",
      domain: "stairs",
      verification: { type: "vertical_circulation" },
    });
    expect(result.plan.requiredOutcomes[1]?.id).toBe("visual");
    expect(result.notes.join(" ")).toContain("Ignored attempted rewrite");
    expect(result.notes.join(" ")).toContain("not omitted silently");
  });

  it("suppresses retries until the blocking dependency is changed, not merely inspected", () => {
    const state = createLoopSafetyState();
    const result = noteDependencyValidationFailure(state, "set_level_footprint", {
      dependentToolDomain: "stairs",
      blockingConstraint: "stair_must_fit_inside_level_footprint",
      suggestedInspectionTargets: ["inspect_stair"],
      replanGuidance: "Move the blocking stair before retrying.",
    });

    expect(result?.domainSuppressed).toBe(true);
    expect(guardSuppressedMutationDomain(state, "set_level_footprint")?.code).toBe(
      "DEPENDENCY_RETRY_SUPPRESSED",
    );
    expect(activeDependencyBlocks(state)).toHaveLength(1);

    noteDependencyInspect(state, "inspect_stair");
    expect(state.dependencyDomainsInspected).toContain("stairs");
    expect(guardSuppressedMutationDomain(state, "set_level_footprint")?.code).toBe(
      "DEPENDENCY_RETRY_SUPPRESSED",
    );

    noteDependencyDomainAddressed(state, "stairs");
    expect(guardSuppressedMutationDomain(state, "set_level_footprint")).toBeNull();
    expect(activeDependencyBlocks(state)).toEqual([]);
  });

  it("does not let a continuation supersede requirements or add semantic duplicates", () => {
    const existing: TaskPlan = {
      objective: "Complete coordinated work",
      constraints: [],
      requiredOutcomes: [
        {
          id: "stair",
          description: "Provide circulation",
          domain: "stairs",
          verification: { type: "vertical_circulation" },
          status: "pending",
        },
      ],
      affectedDomains: ["stairs"],
      dependencies: [],
      completionChecks: ["Verify circulation"],
      planningRequired: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const result = mergeTaskPlanRevision(
      existing,
      {
        objective: existing.objective,
        constraints: [],
        requiredOutcomes: [
          {
            id: "retry-stair",
            description: "Retry circulation",
            domain: "stairs",
            verification: { type: "vertical_circulation" },
            status: "pending",
          },
        ],
        affectedDomains: ["stairs"],
        dependencies: [],
        completionChecks: ["Retry"],
        planningRequired: true,
      },
      { supersedeOutcomes: [{ id: "stair", reason: "A tool failed" }] },
    );

    expect(result.plan.requiredOutcomes).toEqual(existing.requiredOutcomes);
    expect(result.notes.join(" ")).toContain("Ignored attempted supersession");
    expect(result.notes.join(" ")).toContain("Merged duplicate outcome");
  });

  it("requires a visual outcome's model domain to change as well as render", () => {
    const outcome = {
      id: "upper-composition",
      description: "Visually improve the upper-story composition",
      domain: "levels" as const,
      verification: { type: "visual_verified" as const },
      status: "pending" as const,
    };
    const metrics = {
      renderPreviewSuccessCount: 1,
      inspectProjectCount: 0,
      progressCheckCount: 0,
      validationFailureCount: 0,
      lastValidationCodes: [],
    };

    expect(verifyOutcome(outcome, {} as never, [{ op: "modify_roof" }], metrics))
      .toMatchObject({ satisfied: false });
    expect(
      verifyOutcome(outcome, {} as never, [{ op: "setLevelFootprint" }], metrics),
    ).toEqual({ satisfied: true });
  });

  it("requires manual model-domain outcomes to have a matching mutation", () => {
    const outcome = {
      id: "upper-composition",
      description: "Improve the upper-story composition",
      domain: "levels" as const,
      verification: { type: "manual" as const },
      status: "satisfied" as const,
    };
    const metrics = {
      renderPreviewSuccessCount: 0,
      inspectProjectCount: 0,
      progressCheckCount: 0,
      validationFailureCount: 0,
      lastValidationCodes: [],
    };

    expect(verifyOutcome(outcome, {} as never, [{ op: "updateRoof" }], metrics))
      .toMatchObject({ satisfied: false });
    expect(verifyOutcome(outcome, {} as never, [{ op: "setLevelFootprint" }], metrics))
      .toEqual({ satisfied: true });
  });

  it("classifies a stair opening outside an upper slab as a stair dependency", () => {
    expect(
      deriveDependencyHints(
        { code: "STAIR_OPENING_OUTSIDE_SLAB", message: "outside", entityId: "stair-1" },
        "levels",
      ),
    ).toMatchObject({
      dependentToolDomain: "stairs",
      blockingConstraint: "stair_must_fit_inside_level_footprint",
    });
  });

  it("rejects preservation requirements verified by changing the preserved domain", () => {
    expect(
      isContradictoryPreservationOutcome("Footprint remains unchanged.", {
        type: "domain_changed",
        domain: "footprint",
      }),
    ).toBe(true);
    expect(
      isContradictoryPreservationOutcome("Footprint is materially changed.", {
        type: "domain_changed",
        domain: "footprint",
      }),
    ).toBe(false);
  });
});
