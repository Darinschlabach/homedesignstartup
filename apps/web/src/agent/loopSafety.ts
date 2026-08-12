/**
 * Per-run loop safety for the Home Design Agent.
 * Prevents runaway tool retries and meaningless micro-edits without encoding design choices.
 */

export const HOME_DESIGN_AGENT_MAX_TURNS = 18;

const MAX_IDENTICAL_FAILURES = 2;
const MAX_CONSECUTIVE_VALIDATION_FAILURES = 5;
const MAX_SUCCESSFUL_MODS_PER_OBJECT = 4;
/** Absolute feet — smaller successful changes are treated as meaningless noise. */
const MIN_MEANINGFUL_DELTA_FT = 0.05;
const MAX_NEAR_DUPLICATE_SUCCESS_MODS = 2;

export type DomainRetrySuppression = {
  toolDomain: string;
  blockingConstraint: string;
  failureCount: number;
  suppressed: boolean;
  suggestedDependentDomain?: string;
  reason?: string;
};

export type LoopSafetyState = {
  failedCallCounts: Record<string, number>;
  consecutiveValidationFailures: number;
  successfulModsByObject: Record<
    string,
    Array<{ fingerprint: string; deltas: Record<string, number> }>
  >;
  blocked: boolean;
  blockReason?: string;
  lastValidationCode?: string;
  sameValidationCodeStreak: number;
  replanSuggested: boolean;
  replanReason?: string;
  /** Pause a failing mutation domain until its blocking dependency is addressed. */
  domainRetrySuppressions: Record<string, DomainRetrySuppression>;
  /** Domains successfully inspected or mutated after a dependency failure. */
  dependencyDomainsAddressed: string[];
  /** Read-only investigation performed after a dependency failure. */
  dependencyDomainsInspected: string[];
};

export function createLoopSafetyState(): LoopSafetyState {
  return {
    failedCallCounts: {},
    consecutiveValidationFailures: 0,
    successfulModsByObject: {},
    blocked: false,
    sameValidationCodeStreak: 0,
    replanSuggested: false,
    domainRetrySuppressions: {},
    dependencyDomainsAddressed: [],
    dependencyDomainsInspected: [],
  };
}

export function toolCallFingerprint(
  toolName: string,
  args: unknown,
): string {
  return `${toolName}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export type LoopGuardFailure = {
  success: false;
  error: string;
  code:
    | "LOOP_BLOCKED"
    | "IDENTICAL_FAILURE_REPEAT"
    | "VALIDATION_LOOP"
    | "TINY_DELTA"
    | "MODIFY_LIMIT"
    | "NEAR_DUPLICATE_MODIFY"
    | "DEPENDENCY_RETRY_SUPPRESSED";
};

export function assertLoopNotBlocked(
  state: LoopSafetyState | undefined,
): LoopGuardFailure | null {
  if (state?.blocked) {
    return {
      success: false,
      error:
        state.blockReason ??
        "This run was stopped to prevent a runaway tool loop. Ask the user how to proceed.",
      code: "LOOP_BLOCKED",
    };
  }
  return null;
}

export function guardAgainstIdenticalFailure(
  state: LoopSafetyState,
  toolName: string,
  args: unknown,
): LoopGuardFailure | null {
  const blocked = assertLoopNotBlocked(state);
  if (blocked) return blocked;

  const fp = toolCallFingerprint(toolName, args);
  const count = state.failedCallCounts[fp] ?? 0;
  if (count >= MAX_IDENTICAL_FAILURES) {
    state.blocked = true;
    state.blockReason = `Identical failing ${toolName} call repeated ${count} times. Stopping to avoid a runaway loop.`;
    return {
      success: false,
      error: state.blockReason,
      code: "IDENTICAL_FAILURE_REPEAT",
    };
  }
  return null;
}

export function noteValidationFailure(
  state: LoopSafetyState | undefined,
  validationCode?: string,
): { replanSuggested: boolean; replanReason?: string } | null {
  if (!state || !validationCode) return null;

  if (state.lastValidationCode === validationCode) {
    state.sameValidationCodeStreak += 1;
  } else {
    state.lastValidationCode = validationCode;
    state.sameValidationCodeStreak = 1;
  }

  state.replanSuggested = true;
  state.replanReason =
    state.sameValidationCodeStreak >= 2
      ? `Validation code ${validationCode} failed ${state.sameValidationCodeStreak} times. Stop tweaking identical parameters — inspect blocking dependencies, update the task plan order, then retry with a different approach.`
      : `Validation failed (${validationCode}). Inspect related state, update the task plan if dependencies were wrong, then continue.`;

  return {
    replanSuggested: state.replanSuggested,
    replanReason: state.replanReason,
  };
}

export function recordToolFailure(
  state: LoopSafetyState | undefined,
  toolName: string,
  args: unknown,
  options?: { validationFailure?: boolean; validationCode?: string },
): { replanSuggested: boolean; replanReason?: string } | null {
  if (!state) return null;
  const fp = toolCallFingerprint(toolName, args);
  state.failedCallCounts[fp] = (state.failedCallCounts[fp] ?? 0) + 1;

  let replan: { replanSuggested: boolean; replanReason?: string } | null = null;
  if (options?.validationFailure) {
    state.consecutiveValidationFailures += 1;
    replan = noteValidationFailure(state, options.validationCode);
    if (state.consecutiveValidationFailures >= MAX_CONSECUTIVE_VALIDATION_FAILURES) {
      state.blocked = true;
      state.blockReason = `Validation failed ${state.consecutiveValidationFailures} times in a row. Stopping further modifications this turn.`;
    }
  }
  return replan;
}

export function recordToolSuccess(state: LoopSafetyState | undefined): void {
  if (!state) return;
  state.consecutiveValidationFailures = 0;
}

export type NumericPatch = {
  width?: number;
  height?: number;
  depth?: number;
  offset?: number;
  sillHeight?: number;
  x?: number;
  y?: number;
  z?: number;
  rotationY?: number;
};

export function extractCurrentNumericGeometry(
  geometry: Record<string, unknown>,
): NumericPatch {
  const num = (key: string) =>
    typeof geometry[key] === "number" ? (geometry[key] as number) : undefined;
  return {
    width: num("width"),
    height: num("height"),
    depth: num("depth"),
    offset: num("offset"),
    sillHeight: num("sillHeight"),
    x: num("x"),
    y: num("y"),
    z: num("z"),
    rotationY: num("rotationY"),
  };
}

export function proposedNumericPatch(args: {
  width?: number;
  height?: number;
  depth?: number;
  position?: { x?: number; y?: number; z?: number };
  rotationY?: number;
  /** When true, position.x/y map to opening offset/sillHeight. */
  opening?: boolean;
}): NumericPatch {
  const patch: NumericPatch = {};
  if (args.width !== undefined) patch.width = args.width;
  if (args.height !== undefined) patch.height = args.height;
  if (args.depth !== undefined) patch.depth = args.depth;
  if (args.rotationY !== undefined) patch.rotationY = args.rotationY;
  if (args.position) {
    if (args.opening) {
      if (args.position.x !== undefined) patch.offset = args.position.x;
      if (args.position.y !== undefined) patch.sillHeight = args.position.y;
    } else {
      if (args.position.x !== undefined) patch.x = args.position.x;
      if (args.position.y !== undefined) patch.y = args.position.y;
      if (args.position.z !== undefined) patch.z = args.position.z;
    }
  }
  return patch;
}

export function computeDeltas(
  before: NumericPatch,
  proposed: NumericPatch,
): Record<string, number> {
  const deltas: Record<string, number> = {};
  for (const key of Object.keys(proposed) as Array<keyof NumericPatch>) {
    const next = proposed[key];
    if (typeof next !== "number") continue;
    const prev = before[key];
    if (typeof prev !== "number") {
      deltas[key] = next;
      continue;
    }
    deltas[key] = next - prev;
  }
  return deltas;
}

export function guardModifyObject(
  state: LoopSafetyState,
  objectId: string,
  before: NumericPatch,
  proposed: NumericPatch,
  rawArgs: unknown,
): LoopGuardFailure | null {
  const identical = guardAgainstIdenticalFailure(state, "modify_object", rawArgs);
  if (identical) return identical;

  const history = state.successfulModsByObject[objectId] ?? [];
  if (history.length >= MAX_SUCCESSFUL_MODS_PER_OBJECT) {
    state.blocked = true;
    state.blockReason = `Already made ${history.length} successful modifications to ${objectId} this turn. Stop and report the result or ask the user.`;
    return {
      success: false,
      error: state.blockReason,
      code: "MODIFY_LIMIT",
    };
  }

  const deltas = computeDeltas(before, proposed);
  const deltaValues = Object.values(deltas);
  if (deltaValues.length === 0) {
    return {
      success: false,
      error: "No numeric geometry change detected.",
      code: "TINY_DELTA",
    };
  }

  const maxAbs = Math.max(...deltaValues.map((d) => Math.abs(d)));
  if (maxAbs < MIN_MEANINGFUL_DELTA_FT) {
    return {
      success: false,
      error: `Proposed change is too small to be meaningful (max |Δ|=${maxAbs.toFixed(4)} ft). Choose a clearer adjustment or stop.`,
      code: "TINY_DELTA",
    };
  }

  const nearDupes = history.filter((h) => {
    const keys = new Set([
      ...Object.keys(h.deltas),
      ...Object.keys(deltas),
    ]);
    let maxDiff = 0;
    for (const key of keys) {
      const a = h.deltas[key] ?? 0;
      const b = deltas[key] ?? 0;
      maxDiff = Math.max(maxDiff, Math.abs(a - b));
    }
    // Same direction/magnitude within a tiny band → near-duplicate refine.
    return maxDiff < MIN_MEANINGFUL_DELTA_FT;
  }).length;

  if (nearDupes >= MAX_NEAR_DUPLICATE_SUCCESS_MODS) {
    state.blocked = true;
    state.blockReason = `Repeated near-identical modifications to ${objectId}. Stopping micro-refinements this turn.`;
    return {
      success: false,
      error: state.blockReason,
      code: "NEAR_DUPLICATE_MODIFY",
    };
  }

  if (state.consecutiveValidationFailures >= MAX_CONSECUTIVE_VALIDATION_FAILURES) {
    return {
      success: false,
      error:
        state.blockReason ??
        "Validation has failed repeatedly. Stop modifying and report the issue.",
      code: "VALIDATION_LOOP",
    };
  }

  return null;
}

export function recordModifySuccess(
  state: LoopSafetyState | undefined,
  objectId: string,
  rawArgs: unknown,
  deltas: Record<string, number>,
  toolName = "modify_object",
): void {
  if (!state) return;
  recordToolSuccess(state);
  const list = state.successfulModsByObject[objectId] ?? [];
  list.push({
    fingerprint: toolCallFingerprint(toolName, rawArgs),
    deltas,
  });
  state.successfulModsByObject[objectId] = list;
}
