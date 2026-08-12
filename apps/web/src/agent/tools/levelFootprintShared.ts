/**
 * Shared helpers for level-footprint agent tools.
 */
import {
  deriveStairGeometry,
  exposedFootprintRegions,
  footprintBounds,
  footprintContainsFootprint,
  isShellWallId,
  LevelSchema,
  pointInFootprint,
  primaryLevel,
  reportExposedLowerRoofRegions,
  resolveLevelFootprint,
  runDesignValidators,
  topRoofBearingLevel,
  type BuildingModelV1,
  type Level,
  type LevelFootprintRect,
} from "@aihd/domain";

export function scrubNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

export function listLevels(model: BuildingModelV1): Level[] {
  return model.levels.map((l) => LevelSchema.parse(l));
}

/** Agent plan axes: x = width, z = depth (domain Vec2.y). */
export function footprintToAgentAxes(fp: LevelFootprintRect) {
  return {
    centerX: fp.center.x,
    centerZ: fp.center.y,
    width: fp.width,
    depth: fp.depth,
  };
}

export function setbacksRelativeToLower(
  lower: LevelFootprintRect,
  upper: LevelFootprintRect,
) {
  const L = footprintBounds(lower);
  const U = footprintBounds(upper);
  return {
    front: Math.max(0, U.minY - L.minY),
    rear: Math.max(0, L.maxY - U.maxY),
    left: Math.max(0, U.minX - L.minX),
    right: Math.max(0, L.maxX - U.maxX),
  };
}

function lowerLevelFor(model: BuildingModelV1, level: Level): Level | null {
  const sorted = listLevels(model).sort((a, b) => a.elevation - b.elevation);
  const idx = sorted.findIndex((l) => l.id === level.id);
  if (idx <= 0) return null;
  return sorted[idx - 1] ?? null;
}

export function summarizeLevelFootprint(
  model: BuildingModelV1,
  level: Level,
): Record<string, unknown> {
  const fp = resolveLevelFootprint(model, level.id);
  const lower = lowerLevelFor(model, level);
  const lowerFp = lower ? resolveLevelFootprint(model, lower.id) : null;
  const exteriorWalls = model.walls.filter(
    (w) => w.levelId === level.id && isShellWallId(w.id),
  );
  const slab = model.slabs.find((s) => s.levelId === level.id);
  const spaces = model.spaces.filter((s) => s.levelId === level.id);
  const spacesContained =
    fp == null
      ? []
      : spaces.map((s) => {
          const outside = s.polygon.filter((p) => !pointInFootprint(p, fp, 0.05));
          return {
            id: s.id,
            name: s.name,
            fullyInsideFootprint: outside.length === 0,
            outsideVertexCount: outside.length,
          };
        });

  const stairs = (model.stairs ?? []).filter(
    (s) => s.toLevelId === level.id || s.fromLevelId === level.id,
  );
  const stairRelationship = stairs.map((stair) => {
    let terminatesInsideUpper: boolean | null = null;
    let geometryError: string | null = null;
    if (fp && stair.toLevelId === level.id) {
      try {
        const derived = deriveStairGeometry(model, stair);
        terminatesInsideUpper = derived.planPolygon.every((p) =>
          pointInFootprint(p, fp),
        );
      } catch (err) {
        geometryError = err instanceof Error ? err.message : "geometry failed";
        terminatesInsideUpper = false;
      }
    }
    return {
      id: stair.id,
      type: stair.type,
      fromLevelId: stair.fromLevelId,
      toLevelId: stair.toLevelId,
      floorOpeningId: stair.floorOpeningId ?? null,
      terminatesInsideThisFootprint: terminatesInsideUpper,
      geometryError,
    };
  });

  const roofBearing = topRoofBearingLevel(model);
  const roofAssemblies = (model.roofAssemblies ?? []).filter(
    (a) => a.levelId === level.id,
  );
  const exposed = reportExposedLowerRoofRegions(model).filter(
    (r) => r.upperLevelId === level.id || r.lowerLevelId === level.id,
  );

  let relationshipToLower: Record<string, unknown> | null = null;
  if (lower && lowerFp && fp) {
    const setbacks = setbacksRelativeToLower(lowerFp, fp);
    relationshipToLower = {
      lowerLevelId: lower.id,
      lowerLevelName: lower.name,
      lowerFootprint: footprintToAgentAxes(lowerFp),
      fullyInsideLower: footprintContainsFootprint(lowerFp, fp),
      setbacksFeet: setbacks,
      exposedRegionCount: exposedFootprintRegions(lowerFp, fp).length,
      note:
        setbacks.front + setbacks.rear + setbacks.left + setbacks.right > 1e-4
          ? "Upper footprint is set back from the level below on one or more sides."
          : "Upper footprint matches the level below (no setbacks).",
    };
  }

  const footprintAgent = fp ? footprintToAgentAxes(fp) : null;

  return {
    levelId: level.id,
    name: level.name,
    elevation: level.elevation,
    height: level.height,
    footprintSource: level.footprintSource,
    footprint: footprintAgent,
    /** Durable custom rect when present (null for shell-backed). */
    customFootprint: level.footprintSource === "custom" && level.footprint
      ? footprintToAgentAxes(level.footprint)
      : null,
    relationshipToLower,
    exteriorWallIds: exteriorWalls.map((w) => w.id),
    exteriorWalls: exteriorWalls.map((w) => ({
      id: w.id,
      start: { x: w.start.x, z: w.start.y },
      end: { x: w.end.x, z: w.end.y },
    })),
    slab: slab
      ? {
          id: slab.id,
          thickness: slab.thickness,
          vertexCount: slab.polygon.length,
          bounds: {
            minX: Math.min(...slab.polygon.map((p) => p.x)),
            maxX: Math.max(...slab.polygon.map((p) => p.x)),
            minZ: Math.min(...slab.polygon.map((p) => p.y)),
            maxZ: Math.max(...slab.polygon.map((p) => p.y)),
          },
        }
      : null,
    spacesContained,
    stairs: stairRelationship,
    roof: {
      isRoofBearingStory: roofBearing.id === level.id,
      roofBearingLevelId: roofBearing.id,
      assemblyIds: roofAssemblies.map((a) => a.id),
      assemblyFootprints: roofAssemblies.flatMap((a) => {
        const masses = Array.isArray(a.masses) ? a.masses : [];
        return masses.flatMap((raw) => {
          const m = raw as { generator?: {
            origin: { x: number; y: number };
            width: number;
            depth: number;
            eaveHeight: number;
          } };
          const g = m.generator;
          if (!g) return [];
          return [
            {
              originX: g.origin.x,
              originZ: g.origin.y,
              width: g.width,
              depth: g.depth,
              eaveHeight: g.eaveHeight,
            },
          ];
        });
      }),
      note:
        roofBearing.id === level.id
          ? "Upper roof mass currently bears on this level's footprint."
          : `Roof currently bears on ${roofBearing.id}.`,
    },
    exposedLowerRoof: exposed.map((e) => ({
      code: "EXPOSED_LOWER_ROOF",
      severity: "warning" as const,
      lowerLevelId: e.lowerLevelId,
      upperLevelId: e.upperLevelId,
      regionCount: e.regions.length,
      regions: e.regions.map((r) => footprintToAgentAxes(r)),
      note: e.note,
    })),
    constraints: {
      supported: ["axis-aligned rectangular custom footprints"],
      unsupported: [
        "rotated footprints",
        "freeform polygons",
        "automatic lower-roof mass generation for exposed regions",
      ],
      note:
        "Use set_level_footprint / modify_level_footprint / clear_level_footprint. Domain regenerates exterior walls and slab. EXPOSED_LOWER_ROOF means lower areas still need lower-roof coverage — do not claim they are fully roofed.",
    },
    isPrimary: primaryLevel(model).id === level.id,
  };
}

/** Non-blocking warnings + blocking errors for footprint edits. */
export function footprintValidationSummary(model: BuildingModelV1) {
  const all = runDesignValidators(model, []);
  const errors = all.filter((i) => (i.severity ?? "error") === "error");
  const warnings = all.filter((i) => i.severity === "warning");
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    exposedLowerRoof: warnings.filter((w) => w.code === "EXPOSED_LOWER_ROOF"),
  };
}
