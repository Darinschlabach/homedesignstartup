/**
 * Shared helpers for stair agent tools.
 */
import {
  deriveStairGeometry,
  StairGeometryError,
  StairSchema,
  STAIR_DEFAULTS,
  runDesignValidators,
  type BuildingModelV1,
  type Stair,
} from "@aihd/domain";

export function scrubNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

export function listStairs(model: BuildingModelV1): Stair[] {
  return (model.stairs ?? []).map((s) => StairSchema.parse(s));
}

export function summarizeStairBrief(stair: Stair): Record<string, unknown> {
  return {
    id: stair.id,
    name: stair.name ?? null,
    type: stair.type,
    fromLevelId: stair.fromLevelId,
    toLevelId: stair.toLevelId,
    origin: {
      x: stair.origin.x,
      /** Plan depth (agent z); domain stores as Vec2.y. */
      z: stair.origin.y,
    },
    directionDeg: stair.directionDeg,
    width: stair.width,
    floorOpeningId: stair.floorOpeningId ?? null,
  };
}

export function summarizeStairDetail(
  model: BuildingModelV1,
  stair: Stair,
): Record<string, unknown> {
  const opening = stair.floorOpeningId
    ? (model.floorOpenings ?? []).find((o) => o.id === stair.floorOpeningId)
    : (model.floorOpenings ?? []).find((o) => o.stairId === stair.id);

  let derived: Record<string, unknown> | null = null;
  let geometryError: Record<string, unknown> | null = null;
  try {
    const d = deriveStairGeometry(model, stair);
    derived = {
      totalRise: d.totalRise,
      riserCount: d.riserCount,
      riserHeight: d.riserHeight,
      treadCount: d.treadCount,
      treadDepth: d.treadDepth,
      width: d.width,
      bottomElevation: d.bottomElevation,
      topElevation: d.topElevation,
      flights: d.flights.map((f) => ({
        id: f.id,
        riserCount: f.riserCount,
        treadCount: f.treadCount,
        treadDepth: f.treadDepth,
        runLength: f.runLength,
        startElevation: f.startElevation,
        directionDeg: f.directionDeg,
        origin: { x: f.origin.x, z: f.origin.y },
      })),
      landings: d.landings.map((l) => ({
        id: l.id,
        elevation: l.elevation,
        center: { x: l.center.x, z: l.center.y },
        sizeX: l.sizeX,
        sizeY: l.sizeY,
      })),
      bounds: {
        minX: d.bounds.minX,
        maxX: d.bounds.maxX,
        minZ: d.bounds.minY,
        maxZ: d.bounds.maxY,
      },
      planPolygon: d.planPolygon.map((p) => ({ x: p.x, z: p.y })),
    };
  } catch (err) {
    if (err instanceof StairGeometryError) {
      geometryError = {
        code: err.code,
        message: err.message,
        details: err.details ?? null,
      };
    } else {
      geometryError = {
        code: "STAIR_GEOMETRY",
        message: err instanceof Error ? err.message : "Stair geometry failed",
      };
    }
  }

  const validationIssues = runDesignValidators(model, []).filter(
    (i) =>
      i.entityId === stair.id ||
      i.code.startsWith("STAIR_") ||
      i.code.startsWith("FLOOR_OPENING"),
  );

  const from = model.levels.find((l) => l.id === stair.fromLevelId);
  const to = model.levels.find((l) => l.id === stair.toLevelId);

  return {
    ...summarizeStairBrief(stair),
    availableRun: stair.availableRun ?? null,
    targetTreadDepth: stair.targetTreadDepth ?? null,
    maxRiserHeight: stair.maxRiserHeight ?? null,
    defaultsApplied: {
      maxRiserHeight: stair.maxRiserHeight ?? STAIR_DEFAULTS.maxRiserHeight,
      targetTreadDepth: stair.targetTreadDepth ?? STAIR_DEFAULTS.targetTreadDepth,
      minWidth: STAIR_DEFAULTS.minWidth,
      minHeadroom: STAIR_DEFAULTS.minHeadroom,
      minTreadDepth: STAIR_DEFAULTS.minTreadDepth,
    },
    turn: stair.turn ?? null,
    firstFlightRisers: stair.firstFlightRisers ?? null,
    landingSize: stair.landingSize ?? null,
    materialId: stair.materialId ?? null,
    levels: {
      from: from
        ? {
            id: from.id,
            name: from.name,
            elevation: from.elevation,
            height: from.height,
          }
        : null,
      to: to
        ? {
            id: to.id,
            name: to.name,
            elevation: to.elevation,
            height: to.height,
          }
        : null,
    },
    derived,
    geometryError,
    floorOpening: opening
      ? {
          id: opening.id,
          levelId: opening.levelId,
          slabId: opening.slabId ?? null,
          stairId: opening.stairId ?? null,
          label: opening.label ?? null,
          polygon: opening.polygon.map((p) => ({ x: p.x, z: p.y })),
        }
      : null,
    validation: {
      ok: validationIssues.length === 0 && geometryError == null,
      issues: validationIssues,
    },
    clearance: {
      minHeadroomFt: STAIR_DEFAULTS.minHeadroom,
      note:
        "Headroom is enforced through the stairwell opening to the upper-story ceiling; under solid slab soffit outside the opening is also checked.",
    },
    constraints: {
      supportedTypes: ["straight", "lShape"],
      unsupported: [
        "U-shaped",
        "spiral",
        "curved",
        "winder",
        "style presets (modern/farmhouse stair packages)",
      ],
      note: "Agent chooses placement/configuration; domain derives riser/tread math and floor openings.",
    },
  };
}
