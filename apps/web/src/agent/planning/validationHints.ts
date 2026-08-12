import type { ValidationIssue } from "@aihd/domain";

export type DependencyHints = {
  affectedObjectIds?: string[];
  affectedLevelIds?: string[];
  dependentToolDomain?: string;
  blockingConstraint?: string;
  suggestedInspectionTargets?: string[];
  replanGuidance?: string;
};

export type EnrichedValidationIssue = ValidationIssue & {
  dependencyHints?: DependencyHints;
};

function pickEntityId(issue: ValidationIssue): string | undefined {
  if (issue.entityId) return issue.entityId;
  const d = issue.details ?? {};
  if (typeof d.stairId === "string") return d.stairId;
  if (typeof d.levelId === "string") return d.levelId;
  if (typeof d.assemblyId === "string") return d.assemblyId;
  return undefined;
}

function pickLevelIds(issue: ValidationIssue): string[] {
  const d = issue.details ?? {};
  const ids: string[] = [];
  if (typeof d.levelId === "string") ids.push(d.levelId);
  if (typeof d.fromLevelId === "string") ids.push(d.fromLevelId);
  if (typeof d.toLevelId === "string") ids.push(d.toLevelId);
  return ids;
}

/** Machine-readable dependency hints — no prescribed design coordinates. */
export function deriveDependencyHints(
  issue: ValidationIssue,
  toolDomain: string,
): DependencyHints | undefined {
  const entityId = pickEntityId(issue);
  const levelIds = pickLevelIds(issue);

  switch (issue.code) {
    case "STAIR_OUTSIDE_UPPER_FOOTPRINT":
    case "STAIR_OUTSIDE_FOOTPRINT":
    case "STAIR_OPENING_OUTSIDE_SLAB":
      return {
        affectedObjectIds: entityId ? [entityId] : undefined,
        affectedLevelIds: levelIds.length ? levelIds : undefined,
        dependentToolDomain: "stairs",
        blockingConstraint: "stair_must_fit_inside_level_footprint",
        suggestedInspectionTargets: [
          "inspect_stair",
          "inspect_level_footprint",
          "inspect_level",
        ],
        replanGuidance:
          "The blocking stair must fit inside the target upper footprint. Inspect the stair and level footprint, then modify or relocate the stair (if user constraints allow) BEFORE retrying the footprint change. Update the task plan dependency order if needed — do not retry footprint mutations until the stair dependency is resolved.",
      };
    case "STAIR_WALL_COLLISION":
    case "STAIR_OBJECT_COLLISION":
    case "STAIR_OPENING_TOO_SMALL":
    case "STAIR_LANDING":
    case "STAIR_RUN_OVERFLOW":
      return {
        affectedObjectIds: entityId ? [entityId] : undefined,
        affectedLevelIds: levelIds.length ? levelIds : undefined,
        dependentToolDomain: "stairs",
        blockingConstraint: "stair_geometry_invalid",
        suggestedInspectionTargets: ["inspect_stair", "inspect_level", "get_measurements"],
        replanGuidance:
          "Inspect stair bounds and available clearance. Reconsider stair type, origin, direction, or available run before retrying the same parameters.",
      };
    case "LEVEL_FOOTPRINT_OUTSIDE_SHELL":
    case "LEVEL_FOOTPRINT_PRIMARY":
    case "LEVEL_FOOTPRINT_WALLS":
    case "LEVEL_FOOTPRINT_SLAB":
      return {
        affectedLevelIds: levelIds.length ? levelIds : undefined,
        dependentToolDomain: "levels",
        blockingConstraint: "level_footprint_invalid",
        suggestedInspectionTargets: [
          "inspect_level_footprint",
          "inspect_footprint",
          "inspect_level",
        ],
        replanGuidance:
          "Inspect shell bounds and the target level footprint. Adjust the planned rectangle or resolve blocking dependents before retrying.",
      };
    case "ROOF_INTERSECT_BURIED":
    case "ROOF_INTERSECT_NO_OVERLAP":
    case "ROOF_INTERSECT_UNSUPPORTED":
    case "ROOF_INTERPENETRATION":
    case "COMPOSED_ROOF_RELAYOUT_REQUIRED":
      return {
        affectedObjectIds: entityId ? [entityId] : undefined,
        dependentToolDomain: "roof",
        blockingConstraint: "roof_mass_incompatible",
        suggestedInspectionTargets: ["inspect_roof_mass", "inspect_roof", "inspect_footprint"],
        replanGuidance:
          "Inspect existing roof masses and footprint relationship. Update mass dimensions, ridge direction, or footprint plan before repeating the same create/modify call.",
      };
    case "WALL_OUTSIDE_FOOTPRINT":
    case "SPACE_OUTSIDE_FOOTPRINT":
    case "OBJECT_OUTSIDE_FOOTPRINT":
      return {
        affectedObjectIds: entityId ? [entityId] : undefined,
        affectedLevelIds: levelIds.length ? levelIds : undefined,
        dependentToolDomain: toolDomain,
        blockingConstraint: "geometry_outside_footprint",
        suggestedInspectionTargets: [
          "inspect_level_footprint",
          "inspect_footprint",
          "get_measurements",
        ],
        replanGuidance:
          "Inspect the blocking entity and active footprint. Resolve or relocate the blocking dependency first, then retry — do not repeat the same failing mutation.",
      };
    case "OPENING_BOUNDS":
    case "OPENING_OVERLAP":
      return {
        affectedObjectIds: entityId ? [entityId] : undefined,
        dependentToolDomain: "openings",
        blockingConstraint: "opening_invalid_on_wall",
        suggestedInspectionTargets: ["inspect_wall", "inspect_project"],
        replanGuidance:
          "Inspect the host wall length and existing openings before adjusting offset or width.",
      };
    default:
      if ((issue.severity ?? "error") === "error") {
        return {
          affectedObjectIds: entityId ? [entityId] : undefined,
          affectedLevelIds: levelIds.length ? levelIds : undefined,
          dependentToolDomain: toolDomain,
        replanGuidance:
          "Inspect related state and the blocking dependency identified in dependencyHints. Resolve the dependency (inspect, relocate, or remove the blocker) before retrying the same mutation domain.",
        };
      }
      return undefined;
  }
}

export function enrichValidationIssues(
  issues: ValidationIssue[],
  toolDomain: string,
): EnrichedValidationIssue[] {
  return issues.map((issue) => ({
    ...issue,
    dependencyHints: deriveDependencyHints(issue, toolDomain),
  }));
}

export function firstEnrichedIssue(
  issues: ValidationIssue[] | undefined,
  toolDomain: string,
): EnrichedValidationIssue | undefined {
  if (!issues?.length) return undefined;
  return enrichValidationIssues(issues, toolDomain)[0];
}
