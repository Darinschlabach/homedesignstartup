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
  classifyOutcomeRequirement,
  isContradictoryPreservationOutcome,
  isPreservationOutcome,
  assessOperationCompletion,
  requiresVisualVerification,
  type TaskPlan,
  verifyOutcome,
} from "./taskPlan";

describe("planning and recovery invariants", () => {
  it("allows a general cross-domain outcome to be satisfied by real staged work", () => {
    const result = verifyOutcome(
      {
        id: "general-improvement",
        description: "Make one or more supported design improvements",
        domain: "other",
        verification: { type: "domain_changed", domain: "other" },
        status: "pending",
      },
      {} as Parameters<typeof verifyOutcome>[1],
      [{ op: "updateRoof" }],
      {
        renderPreviewSuccessCount: 0,
        inspectProjectCount: 0,
        progressCheckCount: 0,
        validationFailureCount: 0,
        lastValidationCodes: [],
      },
    );
    expect(result.satisfied).toBe(true);
  });

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

  it("merges a repaired equivalent outcome instead of retaining a stale blocked duplicate", () => {
    const existing: TaskPlan = {
      objective: "Improve upper massing",
      constraints: [],
      requiredOutcomes: [{
        id: "upper-original",
        description: "Adjust the second-story composition",
        domain: "level_footprint",
        verification: { type: "visual_verified" },
        status: "blocked",
        blockedReason: "Stair blocked the first attempt",
      }],
      affectedDomains: ["level_footprint"],
      dependencies: [],
      completionChecks: [],
      planningRequired: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const result = mergeTaskPlanRevision(existing, {
      ...existing,
      requiredOutcomes: [{
        id: "upper-repaired",
        description: "Adjust the second-story composition",
        domain: "level_footprint",
        verification: { type: "domain_changed", domain: "level_footprint" },
        status: "satisfied",
      }],
    });
    expect(result.plan.requiredOutcomes).toHaveLength(1);
    expect(result.plan.requiredOutcomes[0]).toMatchObject({
      id: "upper-original",
      status: "satisfied",
    });
    expect(result.plan.requiredOutcomes[0]?.blockedReason).toBeUndefined();
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

  it("makes conditional design opportunities optional and non-blocking", () => {
    expect(
      classifyOutcomeRequirement(
        "Improve the facade however you think best.",
        "Adjust front openings if needed to improve composition.",
      ),
    ).toBe("optional");
    expect(
      classifyOutcomeRequirement(
        "Make the second-story composition more interesting.",
        "Update the second-story composition, potentially using a setback.",
      ),
    ).toBe("required");
    expect(
      classifyOutcomeRequirement(
        "Make the roof and second story more interesting.",
        "Second-story composition is materially changed, potentially using a setback.",
        "optional",
      ),
    ).toBe("required");

    const report = assessOperationCompletion({
      userMessage: "Coordinate an exterior improvement while preserving the footprint.",
      plan: {
        objective: "Improve exterior",
        constraints: [],
        requiredOutcomes: [{
          id: "roof",
          description: "Improve roof",
          domain: "roof",
          verification: { type: "domain_changed", domain: "roof" },
          requirement: "required",
          status: "pending",
        }, {
          id: "openings",
          description: "Consider openings if helpful",
          domain: "openings",
          verification: { type: "domain_changed", domain: "openings" },
          requirement: "optional",
          status: "pending",
        }],
        affectedDomains: ["roof", "openings"],
        dependencies: [],
        completionChecks: ["Review result"],
        planningRequired: true,
        updatedAt: new Date().toISOString(),
      },
      baseModel: { levels: [] } as never,
      workingModel: { levels: [] } as never,
      stagedOps: [{ op: "updateRoof" }],
      metrics: {
        renderPreviewSuccessCount: 0,
        inspectProjectCount: 0,
        progressCheckCount: 1,
        validationFailureCount: 0,
        lastValidationCodes: [],
      },
    });
    expect(report.readyToCommit).toBe(true);
    expect(report.pendingOutcomeIds).toEqual([]);
    expect(report.outcomes.find((o) => o.id === "openings")?.satisfied).toBe(false);
  });

  it("requires a preview for subjective visual objectives", () => {
    expect(requiresVisualVerification("Make the massing more interesting.")).toBe(true);
    const report = assessOperationCompletion({
      userMessage: "Make the roof composition more interesting.",
      plan: {
        objective: "Improve roof composition",
        constraints: [],
        requiredOutcomes: [{
          id: "roof",
          description: "Change roof",
          domain: "roof",
          verification: { type: "domain_changed", domain: "roof" },
          requirement: "required",
          status: "pending",
        }],
        affectedDomains: ["roof"],
        dependencies: [],
        completionChecks: ["Review"],
        planningRequired: true,
        updatedAt: new Date().toISOString(),
      },
      baseModel: { levels: [] } as never,
      workingModel: { levels: [] } as never,
      stagedOps: [{ op: "updateRoof" }],
      metrics: {
        renderPreviewSuccessCount: 0,
        inspectProjectCount: 0,
        progressCheckCount: 1,
        validationFailureCount: 0,
        lastValidationCodes: [],
      },
    });
    expect(report.readyToCommit).toBe(false);
    expect(report.missingChecks.join(" ")).toContain("render_preview");
  });

  it("recognizes preservation text as constraint-only and separates level footprints", () => {
    expect(isPreservationOutcome("Keep the front door unchanged.")).toBe(true);
    expect(
      isPreservationOutcome("Apply facade changes within the existing footprint."),
    ).toBe(true);
    expect(
      isContradictoryPreservationOutcome(
        "Apply facade changes within the existing footprint.",
        { type: "domain_changed", domain: "footprint" },
      ),
    ).toBe(true);
    const metrics = {
      renderPreviewSuccessCount: 0,
      inspectProjectCount: 0,
      progressCheckCount: 0,
      validationFailureCount: 0,
      lastValidationCodes: [],
    };
    expect(verifyOutcome({
      id: "l2",
      description: "Change upper footprint",
      domain: "level_footprint",
      verification: { type: "domain_changed", domain: "level_footprint" },
      requirement: "required",
      status: "pending",
    }, {} as never, [{ op: "setLevelFootprint" }], metrics)).toEqual({ satisfied: true });
    expect(verifyOutcome({
      id: "shell",
      description: "Change primary footprint",
      domain: "footprint",
      verification: { type: "domain_changed", domain: "footprint" },
      requirement: "required",
      status: "pending",
    }, {} as never, [{ op: "setLevelFootprint" }], metrics)).toMatchObject({ satisfied: false });
  });
});
