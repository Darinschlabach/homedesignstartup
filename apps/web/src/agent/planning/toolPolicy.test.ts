import { describe, expect, it } from "vitest";
import {
  assessCapabilityRequest,
  blockedCapabilityForOperations,
  capabilityBoundaryPrompt,
} from "./capabilityPolicy";
import {
  checkLevelFootprintTransition,
  resolveLevelFootprintUpdate,
  validLevelFootprintTransitions,
} from "./toolApplicability";

describe("deterministic tool applicability", () => {
  it("routes shell levels only to set_level_footprint", () => {
    expect(validLevelFootprintTransitions("shell")).toEqual([
      "set_level_footprint",
    ]);
    expect(
      checkLevelFootprintTransition("shell", "modify_level_footprint"),
    ).toMatchObject({
      applicable: false,
      code: "TOOL_NOT_APPLICABLE",
      validTransitions: ["set_level_footprint"],
    });
  });

  it("routes custom levels to modify or clear", () => {
    expect(validLevelFootprintTransitions("custom")).toEqual([
      "modify_level_footprint",
      "clear_level_footprint",
    ]);
    expect(
      checkLevelFootprintTransition("custom", "modify_level_footprint"),
    ).toMatchObject({ applicable: true });
  });

  it("returns an actionable transition without asking for a replan", () => {
    const result = checkLevelFootprintTransition(
      "shell",
      "modify_level_footprint",
    );
    expect(result.applicable).toBe(false);
    if (!result.applicable) {
      expect(result.reason).toContain("set_level_footprint");
      expect(result.code).toBe("TOOL_NOT_APPLICABLE");
    }
  });

  it("resolves a complete shell-level update to the valid set transition", () => {
    expect(
      resolveLevelFootprintUpdate("shell", {
        centerX: 0,
        centerZ: 8,
        width: 32,
        depth: 40,
      }),
    ).toMatchObject({
      applicable: true,
      transition: "set_level_footprint",
    });
    expect(resolveLevelFootprintUpdate("shell", { width: 32 })).toMatchObject({
      applicable: false,
      code: "TOOL_NOT_APPLICABLE",
      requiredArguments: ["centerX", "centerZ", "depth"],
    });
  });
});

describe("unsupported capability boundary", () => {
  it("blocks explicitly requested unsupported geometry structurally", () => {
    const assessment = assessCapabilityRequest(
      "Create a helical spiral staircase and an arced glass wall.",
    );
    expect(assessment.blocked.map((item) => item.domain)).toEqual([
      "stairs",
      "walls",
    ]);
    expect(capabilityBoundaryPrompt(assessment)).toContain(
      "Do not call mutation tools",
    );
    expect(
      blockedCapabilityForOperations(assessment, [{ op: "createStair" }])?.code,
    ).toBe("UNSUPPORTED_CAPABILITY");
  });

  it("requires explicit permission before supported approximation", () => {
    expect(
      assessCapabilityRequest("Build a curved wall; a segmented approximation is okay."),
    ).toMatchObject({ approximationAuthorized: true, blocked: [] });
    expect(
      assessCapabilityRequest("Build a curved wall and choose what works best."),
    ).toMatchObject({ approximationAuthorized: false });
  });

  it("rejects the corresponding mutation before it can create a revision", () => {
    const assessment = assessCapabilityRequest("Create a spiral staircase.");
    const preflight = blockedCapabilityForOperations(assessment, [
      { op: "createStair" },
    ]);

    expect(preflight).toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      domain: "stairs",
    });
    // The production stage boundary evaluates this preflight before applying ops;
    // a refusal therefore has no staged operation to commit.
    expect(blockedCapabilityForOperations(assessment, [])).toBeNull();
  });

  it("allows alternatives to be offered without executing them", () => {
    const assessment = assessCapabilityRequest("Use a freeform upper footprint.");
    expect(assessment.blocked[0]?.supportedAlternatives).toContain(
      "axis-aligned rectangular footprint",
    );
    expect(blockedCapabilityForOperations(assessment, [])).toBeNull();
  });
});
