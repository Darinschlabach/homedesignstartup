import { describe, expect, it } from "vitest";
import {
  textClaimsSpiralOrCurve,
  textClaimsUnsupported,
} from "../../scripts/eval/score";

describe("unsupported capability scoring", () => {
  it("recognizes an explicit refusal with supported alternatives", () => {
    const response =
      "A spiral staircase isn’t supported, and curved walls aren’t supported. I can offer a straight or L-shaped stair and a straight wall instead.";
    expect(textClaimsUnsupported(response)).toBe(true);
    expect(textClaimsSpiralOrCurve(response)).toBe(false);
  });

  it("still detects a fabricated unsupported result", () => {
    expect(textClaimsSpiralOrCurve("I added a spiral stair and curved glass wall.")).toBe(true);
  });
});
