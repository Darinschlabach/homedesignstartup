import type { LoopGuardFailure, LoopSafetyState } from "../loopSafety";
import type { DependencyHints } from "./validationHints";

/** Map mutation tool names to planning domains for retry suppression. */
export const MUTATION_TOOL_DOMAINS: Record<string, string> = {
  create_level: "levels",
  modify_level: "levels",
  delete_level: "levels",
  set_level_footprint: "levels",
  modify_level_footprint: "levels",
  clear_level_footprint: "levels",
  create_stair: "stairs",
  modify_stair: "stairs",
  delete_stair: "stairs",
  create_wall: "walls",
  modify_wall: "walls",
  delete_wall: "walls",
  create_space: "spaces",
  modify_space: "spaces",
  delete_space: "spaces",
  create_opening: "openings",
  modify_opening: "openings",
  delete_opening: "openings",
  modify_footprint: "footprint",
  modify_roof: "roof",
  create_roof_mass: "roof",
  modify_roof_mass: "roof",
  delete_roof_mass: "roof",
  create_object: "other",
  modify_object: "other",
  delete_object: "other",
};

/** Inspect tools that satisfy dependency investigation before retrying a blocked domain. */
export const DEPENDENCY_INSPECT_TOOLS: Record<string, string> = {
  inspect_stair: "stairs",
  inspect_level: "levels",
  inspect_level_footprint: "levels",
  inspect_footprint: "footprint",
  inspect_roof: "roof",
  inspect_roof_mass: "roof",
  inspect_wall: "walls",
  inspect_object: "other",
  get_measurements: "other",
};

export function mutationDomainForTool(toolName: string): string {
  return MUTATION_TOOL_DOMAINS[toolName] ?? "other";
}

function suppressionKey(toolDomain: string, blockingConstraint: string): string {
  return `${toolDomain}::${blockingConstraint}`;
}

/**
 * Block further mutations in a domain after repeated failures on the same blocking dependency.
 */
export function guardSuppressedMutationDomain(
  state: LoopSafetyState | undefined,
  toolName: string,
): LoopGuardFailure | null {
  if (!state) return null;
  const toolDomain = mutationDomainForTool(toolName);
  const active = state.domainRetrySuppressions[toolDomain];
  if (!active?.suppressed) return null;

  const addressed = state.dependencyDomainsAddressed.includes(
    active.suggestedDependentDomain ?? "",
  );
  if (addressed) return null;

  return {
    success: false,
    error:
      active.reason ??
      `Further ${toolDomain} mutations are paused until the blocking dependency (${active.blockingConstraint}) is inspected or changed.`,
    code: "DEPENDENCY_RETRY_SUPPRESSED",
  };
}

export function noteDependencyValidationFailure(
  state: LoopSafetyState | undefined,
  toolName: string,
  hints?: DependencyHints | null,
): {
  domainSuppressed: boolean;
  suppressionReason?: string;
  replanGuidance?: string;
} | null {
  if (!state || !hints?.blockingConstraint) return null;

  const toolDomain = mutationDomainForTool(toolName);
  const key = suppressionKey(toolDomain, hints.blockingConstraint);
  const prev = state.domainRetrySuppressions[toolDomain];
  const sameKey =
    prev?.blockingConstraint === hints.blockingConstraint
      ? prev
      : {
          toolDomain,
          blockingConstraint: hints.blockingConstraint,
          failureCount: 0,
          suppressed: false,
          suggestedDependentDomain: hints.dependentToolDomain,
          reason: undefined as string | undefined,
        };

  sameKey.failureCount += 1;
  sameKey.suggestedDependentDomain =
    hints.dependentToolDomain ?? sameKey.suggestedDependentDomain;

  if (sameKey.suggestedDependentDomain) {
    state.dependencyDomainsAddressed = state.dependencyDomainsAddressed.filter(
      (domain) => domain !== sameKey.suggestedDependentDomain,
    );
    state.dependencyDomainsInspected = state.dependencyDomainsInspected.filter(
      (domain) => domain !== sameKey.suggestedDependentDomain,
    );
  }

  if (sameKey.failureCount >= 1) {
    sameKey.suppressed = true;
    const dep = hints.dependentToolDomain ?? "blocking";
    sameKey.reason =
      `${toolDomain} mutations failed ${sameKey.failureCount} times because of ${hints.blockingConstraint}. ` +
      `Inspect or change the ${dep} dependency (see dependencyHints.suggestedInspectionTargets) before retrying ${toolName}.`;
  }

  state.domainRetrySuppressions[toolDomain] = sameKey;

  return {
    domainSuppressed: sameKey.suppressed,
    suppressionReason: sameKey.reason,
    replanGuidance: hints.replanGuidance,
  };
}

export function noteDependencyDomainAddressed(
  state: LoopSafetyState | undefined,
  domain: string,
): void {
  if (!state || !domain) return;
  if (!state.dependencyDomainsAddressed.includes(domain)) {
    state.dependencyDomainsAddressed.push(domain);
  }
  for (const [toolDomain, entry] of Object.entries(state.domainRetrySuppressions)) {
    if (entry.suppressed && entry.suggestedDependentDomain === domain) {
      state.domainRetrySuppressions[toolDomain] = {
        ...entry,
        suppressed: false,
        failureCount: 0,
        reason: undefined,
      };
    }
  }
}

export function noteDependencyInspect(
  state: LoopSafetyState | undefined,
  toolName: string,
): void {
  const domain = DEPENDENCY_INSPECT_TOOLS[toolName];
  if (!state || !domain) return;
  if (!state.dependencyDomainsInspected.includes(domain)) {
    state.dependencyDomainsInspected.push(domain);
  }
}

/** Require fresh geometric evidence before mutating a blocking dependency. */
export function guardDependencyRepairInspection(
  state: LoopSafetyState | undefined,
  toolName: string,
): LoopGuardFailure | null {
  if (!state) return null;
  const domain = mutationDomainForTool(toolName);
  const active = Object.values(state.domainRetrySuppressions).find(
    (entry) => entry.suppressed && entry.suggestedDependentDomain === domain,
  );
  if (!active || state.dependencyDomainsInspected.includes(domain)) return null;
  return {
    success: false,
    code: "DEPENDENCY_RETRY_SUPPRESSED",
    error:
      `Inspect the blocking ${domain} geometry after the validation failure before changing it. ` +
      "Use the returned derived bounds, floor opening, and level bounds to choose valid parameters; do not guess.",
  };
}

export function activeDependencyBlocks(
  state: LoopSafetyState | undefined,
): string[] {
  if (!state) return [];
  return Object.values(state.domainRetrySuppressions)
    .filter((entry) => entry.suppressed)
    .map(
      (entry) =>
        entry.reason ??
        `${entry.toolDomain} is blocked by ${entry.blockingConstraint} until ${entry.suggestedDependentDomain ?? "the dependent geometry"} is changed.`,
    );
}
