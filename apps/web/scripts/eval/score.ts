/**
 * Observable metrics + pass/fail heuristics.
 * Does NOT encode expected tool sequences — only user constraints and
 * whether inspect/render happened before mutation when required.
 */
import type { EvalScenario } from "./scenarios.ts";
import type { ModelSnap, SnapDiff } from "./snap.ts";

export type FailureCategory =
  | "AGENT_REASONING"
  | "TOOL_SELECTION"
  | "TOOL_SCHEMA"
  | "DOMAIN_GEOMETRY"
  | "VALIDATION"
  | "RENDERING"
  | "CONTEXT"
  | "UNSUPPORTED_CAPABILITY"
  | "TRANSACTION"
  | "OTHER";

export type ToolCallRecord = {
  name: string;
  ok: boolean | null;
  code: string | null;
  arguments?: unknown;
  resultSummary?: unknown;
};

export type CommitRecord = {
  success: boolean | null;
  skipped: boolean | null;
  reason: string | null;
  stagedOperationCount: number | null;
  revisionAfter: number | null;
  baseRevision: number | null;
  validation: unknown;
  code: string | null;
  completionReport?: unknown;
  continuationAttempt?: number | null;
};

export const INSPECT_TOOLS = new Set([
  "inspect_project",
  "inspect_object",
  "inspect_wall",
  "inspect_footprint",
  "inspect_roof",
  "inspect_roof_mass",
  "inspect_exposed_roof_regions",
  "inspect_level",
  "inspect_level_footprint",
  "inspect_stair",
  "inspect_materials",
  "get_measurements",
  "find_material",
  "render_preview",
]);

/** Planning tools are not mutations — they may precede inspect/mutate. */
export const PLANNING_TOOLS = new Set(["set_task_plan", "check_operation_progress"]);

const MUTATION_PREFIXES = [
  "create_",
  "modify_",
  "delete_",
  "set_",
  "clear_",
  "apply_",
  "change_",
];

export function isInspectTool(name: string): boolean {
  return INSPECT_TOOLS.has(name) || PLANNING_TOOLS.has(name);
}

export function isMutationTool(name: string): boolean {
  if (name === "render_preview") return false;
  if (PLANNING_TOOLS.has(name)) return false;
  return MUTATION_PREFIXES.some((p) => name.startsWith(p));
}

export function isValidationFailure(call: ToolCallRecord): boolean {
  if (call.ok !== false) return false;
  const code = (call.code ?? "").toUpperCase();
  if (!code) return true;
  return /VALID|SCHEMA|INTEGRITY|INTERSECT|OUTSIDE|OVERLAP|PITCH|FOOTPRINT|STAIR|ROOF|WALL|SPACE|OPENING|LEVEL|UNSUPPORTED|LOOP/.test(
    code,
  );
}

export function isSchemaFailure(call: ToolCallRecord): boolean {
  if (call.ok !== false) return false;
  return /SCHEMA|INVALID_|PARSE|TYPE_/.test((call.code ?? "").toUpperCase());
}

export type ScenarioChecks = {
  taskCompleted: boolean;
  correctToolsSelected: boolean | null;
  unnecessaryToolCalls: boolean;
  validationErrors: number;
  successfulRecovery: boolean | null;
  geometryValid: boolean;
  visualRenderUsed: boolean;
  visualRenderWhereAppropriate: boolean | null;
  inspectBeforeMutate: boolean | null;
  userConstraintsRespected: boolean;
  unintendedGeometryChanges: boolean;
  stagedMutationCount: number;
  finalRevisionCount: number;
  oneSse: boolean;
  finalResponseAccurate: boolean | null;
  claimedUnsupported: boolean;
  fakedUnsupported: boolean;
};

export type ScenarioScore = {
  pass: boolean;
  checks: ScenarioChecks;
  failureCategory: FailureCategory | null;
  failureReason: string | null;
  reviewerNotes: string[];
  toolNames: string[];
  renders: Array<{ index: number; arguments?: unknown }>;
  constraintViolations: string[];
};

function firstIndex(tools: ToolCallRecord[], pred: (t: ToolCallRecord) => boolean): number {
  return tools.findIndex(pred);
}

function textClaimsUnsupported(text: string): boolean {
  return /not supported|unsupported|cannot|can't|unable|limitation|don't support|do not support|no spiral|can't add a spiral|curved (glass )?wall/i.test(
    text,
  );
}

function textClaimsSpiralOrCurve(text: string): boolean {
  const lower = text.toLowerCase();
  if (/can't|cannot|unable|not supported|don't support|do not support|won't support/.test(lower)) {
    return false;
  }
  return /added (a )?spiral|created (a )?spiral|installed (a )?spiral|built (a )?spiral|curved glass wall|added a curved/i.test(
    lower,
  );
}

function responseSeemsAccurate(
  scenario: EvalScenario,
  text: string,
  diff: SnapDiff,
  after: ModelSnap,
): boolean | null {
  const t = text.toLowerCase();
  if (!t.trim()) return false;

  if (scenario.id === 9) {
    if (textClaimsSpiralOrCurve(text) && !textClaimsUnsupported(text)) return false;
    if (textClaimsUnsupported(text)) return true;
    return null;
  }

  if (/i added a second (floor|stor)|created a second (floor|stor)/i.test(text) && after.levels.length < 2) {
    return false;
  }
  if (/kept the (overall )?footprint|did not change the footprint/i.test(t) && diff.footprintChanged) {
    return false;
  }
  if (/did not (move|change) the front door/i.test(t) && diff.frontDoorMoved) {
    return false;
  }
  if (/did not change the garage width/i.test(t) && diff.garageWidthChanged) {
    return false;
  }
  if (/without changing (the )?geometry|geometry unchanged/i.test(t) && diff.geometryChanged) {
    return false;
  }
  if (/four[- ]bedroom|4 bedroom/i.test(t) && after.bedroomCount < 4 && scenario.id === 10) {
    return false;
  }
  return true;
}

function unnecessaryCalls(tools: ToolCallRecord[]): boolean {
  const failedByName: Record<string, number> = {};
  for (const t of tools) {
    if (t.ok === false) failedByName[t.name] = (failedByName[t.name] ?? 0) + 1;
  }
  if (Object.values(failedByName).some((n) => n >= 4)) return true;

  let identicalInspectStreak = 0;
  let lastInspect: string | null = null;
  for (const t of tools) {
    if (isInspectTool(t.name) && t.name !== "render_preview") {
      if (t.name === lastInspect) identicalInspectStreak += 1;
      else identicalInspectStreak = 1;
      lastInspect = t.name;
      if (identicalInspectStreak >= 4) return true;
    } else {
      identicalInspectStreak = 0;
      lastInspect = null;
    }
  }
  return false;
}

function constraintViolations(scenario: EvalScenario, diff: SnapDiff, after: ModelSnap): string[] {
  const v: string[] = [];
  switch (scenario.id) {
    case 1:
      if (diff.footprintChanged) v.push("overall footprint changed");
      break;
    case 2:
      if (diff.footprintChanged) v.push("footprint increased/changed");
      break;
    case 3:
      if (diff.footprintChanged) v.push("L1/shell footprint changed");
      if (after.levels.length < 2) v.push("no second level");
      if (after.bedroomCount < 2) v.push(`bedroom count ${after.bedroomCount} < 2`);
      if (after.stairs.length < 1) v.push("no usable staircase");
      break;
    case 4:
      if (diff.footprintChanged || diff.l1FootprintChanged) v.push("first-floor footprint changed");
      break;
    case 6:
      if (diff.l2Smaller === false) v.push("second floor not smaller");
      if (diff.stairRemoved) v.push("existing staircase removed");
      if (diff.frontDoorMoved) v.push("front door moved");
      if (diff.garageWidthChanged) v.push("garage width changed");
      break;
    case 7:
      if (diff.geometryChanged) v.push("geometry changed despite materials-only request");
      break;
    case 10:
      if (diff.footprintChanged) v.push("building footprint changed");
      if (diff.garageWidthChanged || diff.garageOffsetChanged) v.push("garage location/width changed");
      if (after.levels.length < 2) v.push("not two-story");
      if (after.bedroomCount < 4) v.push(`bedroom count ${after.bedroomCount} < 4`);
      break;
    default:
      break;
  }
  return v;
}

function taskCompleted(
  scenario: EvalScenario,
  diff: SnapDiff,
  after: ModelSnap,
  text: string,
  tools: ToolCallRecord[],
  checks: Pick<ScenarioChecks, "inspectBeforeMutate" | "geometryValid" | "oneSse">,
): boolean {
  if (!checks.geometryValid) return false;
  if (!checks.oneSse) return false;
  if (scenario.inspectBeforeMutate && checks.inspectBeforeMutate === false) return false;

  switch (scenario.id) {
    case 1:
      return (
        !diff.footprintChanged &&
        (diff.openingsChanged ||
          diff.roofChanged ||
          diff.materialCatalogChanged ||
          diff.materialBindingsChanged ||
          diff.objectCountDelta !== 0)
      );
    case 2:
      return (
        !diff.footprintChanged &&
        (diff.interiorWallDelta !== 0 || diff.spaceLayoutChanged || diff.spaceCountDelta !== 0)
      );
    case 3:
      return (
        after.levels.length >= 2 &&
        after.bedroomCount >= 2 &&
        after.stairs.length >= 1 &&
        !diff.footprintChanged
      );
    case 4:
      return !diff.footprintChanged && !diff.l1FootprintChanged && (diff.roofChanged || diff.l2Smaller === true || diff.l2AreaAfter !== diff.l2AreaBefore);
    case 5: {
      const inspected = tools.some((t) => isInspectTool(t.name));
      const changed = diff.geometryChanged || diff.materialCatalogChanged;
      const honest = /already|looks good|no change|left (it|the house) as/i.test(text);
      return inspected && (changed || honest);
    }
    case 6:
      return (
        diff.l2Smaller === true &&
        !diff.stairRemoved &&
        !diff.frontDoorMoved &&
        !diff.garageWidthChanged
      );
    case 7:
      return !diff.geometryChanged && (diff.materialCatalogChanged || diff.materialBindingsChanged);
    case 8: {
      const inspected = tools.some((t) => isInspectTool(t.name));
      const changed = diff.geometryChanged || diff.materialCatalogChanged;
      return inspected && (changed || text.trim().length > 40);
    }
    case 9:
      return textClaimsUnsupported(text) && !textClaimsSpiralOrCurve(text) && after.stairs.every((s) => s.type !== "spiral");
    case 10:
      return (
        after.levels.length >= 2 &&
        after.bedroomCount >= 4 &&
        after.stairs.length >= 1 &&
        !diff.footprintChanged &&
        !diff.garageWidthChanged &&
        !diff.garageOffsetChanged &&
        (diff.roofChanged ||
          diff.openingsChanged ||
          diff.l2Smaller === true ||
          diff.materialCatalogChanged ||
          diff.materialBindingsChanged)
      );
    default:
      return false;
  }
}

function classifyFailure(
  scenario: EvalScenario,
  checks: ScenarioChecks,
  tools: ToolCallRecord[],
  violations: string[],
): { category: FailureCategory; reason: string } | null {
  if (checks.taskCompleted && checks.userConstraintsRespected) return null;

  if (scenario.id === 9 && checks.fakedUnsupported) {
    return {
      category: "UNSUPPORTED_CAPABILITY",
      reason: "Agent faked spiral stair and/or curved glass wall instead of refusing.",
    };
  }
  if (scenario.id === 9 && !checks.claimedUnsupported) {
    return {
      category: "UNSUPPORTED_CAPABILITY",
      reason: "Agent did not identify unsupported spiral stair / curved glass wall.",
    };
  }

  if (!checks.oneSse || checks.finalRevisionCount > 1) {
    return { category: "TRANSACTION", reason: "Expected at most one committed revision and one SSE model update." };
  }

  if (tools.some(isSchemaFailure)) {
    return { category: "TOOL_SCHEMA", reason: "Tool schema / argument errors blocked progress." };
  }

  if (checks.validationErrors > 0 && checks.successfulRecovery === false) {
    return { category: "VALIDATION", reason: "Validation errors without successful recovery." };
  }

  if (!checks.geometryValid) {
    return { category: "DOMAIN_GEOMETRY", reason: "Final model failed design validation or integrity." };
  }

  if (scenario.inspectBeforeMutate && checks.inspectBeforeMutate === false) {
    return { category: "CONTEXT", reason: "Mutated before inspecting/rendering the current house." };
  }

  if (scenario.visualAppropriate && checks.visualRenderUsed === false && scenario.id !== 2 && scenario.id !== 6) {
    const inspected = tools.some((t) => isInspectTool(t.name));
    if (!inspected) {
      return { category: "RENDERING", reason: "No visual render or inspection on a visual design request." };
    }
  }

  if (violations.length) {
    const toolNames = tools.filter((t) => t.ok !== false).map((t) => t.name);
    const usedFootprint = toolNames.some((n) => n.includes("footprint") && isMutationTool(n));
    if (scenario.id === 7 && usedFootprint) {
      return { category: "TOOL_SELECTION", reason: "Chose geometry tools on a materials-only request." };
    }
    if (scenario.id === 6 && toolNames.some((n) => n === "modify_opening" || n === "delete_stair")) {
      return { category: "TOOL_SELECTION", reason: "Tools that violate stated constraints were used." };
    }
    return {
      category: "AGENT_REASONING",
      reason: `User constraints violated: ${violations.join("; ")}`,
    };
  }

  if (!checks.taskCompleted) {
    return { category: "AGENT_REASONING", reason: "Request not completed with available tools." };
  }

  return { category: "OTHER", reason: "Failed checks without a more specific category." };
}

export function scoreScenario(options: {
  scenario: EvalScenario;
  tools: ToolCallRecord[];
  commit: CommitRecord | null;
  before: ModelSnap;
  after: ModelSnap;
  diff: SnapDiff;
  finalText: string;
  modelEvents: number;
  revisionDelta: number;
  errorText?: string;
  rateLimitFailure?: boolean;
}): ScenarioScore {
  const { scenario, tools, commit, after, diff, finalText, modelEvents, revisionDelta } = options;

  if (options.rateLimitFailure) {
    return {
      pass: false,
      checks: {
        taskCompleted: false,
        correctToolsSelected: null,
        unnecessaryToolCalls: false,
        validationErrors: 0,
        successfulRecovery: null,
        geometryValid: after.geometryValid,
        visualRenderUsed: tools.some((t) => t.name === "render_preview" && t.ok !== false),
        visualRenderWhereAppropriate: null,
        inspectBeforeMutate: null,
        userConstraintsRespected: true,
        unintendedGeometryChanges: false,
        stagedMutationCount: commit?.stagedOperationCount ?? 0,
        finalRevisionCount: revisionDelta,
        oneSse: revisionDelta === 0 ? modelEvents === 0 : modelEvents === 1,
        finalResponseAccurate: null,
        claimedUnsupported: false,
        fakedUnsupported: false,
      },
      failureCategory: "OTHER",
      failureReason: "OpenAI rate limit (429) — infrastructure, not agent reasoning.",
      reviewerNotes: ["Rate limit failure after retries."],
      toolNames: tools.map((t) => `${t.name}${t.ok === false ? "✗" : ""}`),
      renders: tools
        .filter((t) => t.name === "render_preview")
        .map((t, i) => ({ index: i, arguments: t.arguments })),
      constraintViolations: [],
    };
  }

  const mutationTools = tools.filter((t) => isMutationTool(t.name));
  const successfulMutations = mutationTools.filter((t) => t.ok !== false);
  const validationFails = tools.filter(isValidationFailure);
  const laterSuccessAfterFail = validationFails.some((fail) => {
    const idx = tools.indexOf(fail);
    return tools.slice(idx + 1).some((t) => t.name === fail.name && t.ok !== false);
  });

  const inspectIdx = firstIndex(tools, (t) => isInspectTool(t.name));
  const mutateIdx = firstIndex(tools, (t) => isMutationTool(t.name) && t.ok !== false);
  const inspectBeforeMutate =
    mutateIdx === -1 ? true : inspectIdx !== -1 && inspectIdx < mutateIdx;

  const visualRenderUsed = tools.some((t) => t.name === "render_preview" && t.ok !== false);
  const stagedMutationCount =
    commit?.stagedOperationCount ?? successfulMutations.length;
  const oneSse = revisionDelta === 0 ? modelEvents === 0 : modelEvents === 1 && revisionDelta === 1;

  const claimedUnsupported = textClaimsUnsupported(finalText);
  const fakedUnsupported =
    scenario.id === 9 &&
    (textClaimsSpiralOrCurve(finalText) || after.stairs.some((s) => /spiral/i.test(s.type)));

  const violations = constraintViolations(scenario, diff, after);
  const geometryValid = after.geometryValid;

  const checksBase = {
    inspectBeforeMutate: scenario.inspectBeforeMutate ? inspectBeforeMutate : null,
    geometryValid,
    oneSse,
  };

  const completed = taskCompleted(scenario, diff, after, finalText, tools, checksBase);

  const checks: ScenarioChecks = {
    taskCompleted: completed,
    correctToolsSelected: null,
    unnecessaryToolCalls: unnecessaryCalls(tools),
    validationErrors: validationFails.length,
    successfulRecovery: validationFails.length === 0 ? null : laterSuccessAfterFail || (completed && geometryValid),
    geometryValid,
    visualRenderUsed,
    visualRenderWhereAppropriate: scenario.visualAppropriate ? visualRenderUsed : null,
    inspectBeforeMutate: scenario.inspectBeforeMutate ? inspectBeforeMutate : null,
    userConstraintsRespected: violations.length === 0,
    unintendedGeometryChanges:
      violations.length > 0 ||
      (scenario.id === 7 && diff.geometryChanged) ||
      (scenario.id !== 7 && scenario.id !== 9 && diff.footprintChanged && scenario.id !== 5),
    stagedMutationCount,
    finalRevisionCount: revisionDelta,
    oneSse,
    finalResponseAccurate: responseSeemsAccurate(scenario, finalText, diff, after),
    claimedUnsupported,
    fakedUnsupported,
  };

  const mutationFamilyOk = (() => {
    if (successfulMutations.length === 0) return scenario.id === 9 || completed;
    if (scenario.id === 7) {
      return successfulMutations.every((t) => /material/i.test(t.name));
    }
    if (scenario.id === 2) {
      return successfulMutations.some((t) => /wall|space|opening/i.test(t.name));
    }
    if (scenario.id === 9) {
      return !successfulMutations.some((t) => t.name === "create_stair") || claimedUnsupported;
    }
    return true;
  })();
  checks.correctToolsSelected = mutationFamilyOk;

  const classified = classifyFailure(scenario, checks, tools, violations);
  const reviewerNotes: string[] = [];
  if (scenario.visualAppropriate && !visualRenderUsed) {
    reviewerNotes.push("Visual request but render_preview was not used.");
  }
  if (checks.unnecessaryToolCalls) {
    reviewerNotes.push("Repeated identical inspects or excessive failed retries.");
  }
  if (checks.finalResponseAccurate === false) {
    reviewerNotes.push("Final agent text does not match observable model changes.");
  }
  if (revisionDelta === 0 && completed && scenario.id !== 9) {
    reviewerNotes.push("Task scored complete with no committed revision.");
  }
  if (options.errorText) reviewerNotes.push(`SSE error: ${options.errorText.slice(0, 300)}`);

  const pass =
    checks.taskCompleted &&
    checks.userConstraintsRespected &&
    checks.geometryValid &&
    checks.oneSse &&
    checks.fakedUnsupported === false &&
    (checks.inspectBeforeMutate ?? true) !== false &&
    (checks.finalResponseAccurate ?? true) !== false;

  return {
    pass,
    checks,
    failureCategory: classified?.category ?? null,
    failureReason: classified?.reason ?? null,
    reviewerNotes,
    toolNames: tools.map((t) => `${t.name}${t.ok === false ? "✗" : ""}`),
    renders: tools
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.name === "render_preview")
      .map(({ t, i }) => ({ index: i, arguments: t.arguments })),
    constraintViolations: violations,
  };
}
