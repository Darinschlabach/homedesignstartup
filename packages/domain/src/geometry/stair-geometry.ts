/**
 * Deterministic stair geometry from architectural authoring + level elevations.
 *
 * Units: feet. Residential defaults follow common IRC-like limits:
 * - max riser ≈ 7.75" (0.645833 ft)
 * - min tread ≈ 10" (0.833333 ft)
 * - min width ≈ 36" (3 ft)
 * - min headroom ≈ 80" (6.6667 ft)
 *
 * The language model must NOT invent tread coordinates — only authoring params.
 */
import type { BuildingModelV1, Vec2, Vec3 } from '../building-model';
import { findLevel, levelFinishedFloorElevation } from '../levels';
import type { FloorOpening, Stair, StairTurn } from '../stair';
import { FloorOpeningSchema, StairSchema } from '../stair';

export const STAIR_DEFAULTS = {
  maxRiserHeight: 7.75 / 12,
  minRiserHeight: 4 / 12,
  targetTreadDepth: 11 / 12,
  minTreadDepth: 10 / 12,
  minWidth: 3,
  minHeadroom: 80 / 12,
  openingMargin: 0.25,
} as const;

export type StairFlightDef = {
  id: string;
  /** Bottom elevation of this flight (FFE of first riser). */
  startElevation: number;
  riserCount: number;
  riserHeight: number;
  treadCount: number;
  treadDepth: number;
  /** Plan start of first tread nosing line. */
  origin: Vec2;
  directionDeg: number;
  width: number;
  runLength: number;
};

export type StairLandingDef = {
  id: string;
  elevation: number;
  /** Plan center of landing rectangle. */
  center: Vec2;
  sizeX: number;
  sizeY: number;
  rotationDeg: number;
};

export type StairTreadMesh = {
  id: string;
  /** World-space box center. */
  position: Vec3;
  size: { width: number; height: number; depth: number };
  rotationYDeg: number;
};

export type StairRiserMesh = {
  id: string;
  position: Vec3;
  size: { width: number; height: number; depth: number };
  rotationYDeg: number;
};

export type DerivedStairGeometry = {
  stairId: string;
  fromLevelId: string;
  toLevelId: string;
  totalRise: number;
  riserCount: number;
  riserHeight: number;
  treadCount: number;
  treadDepth: number;
  width: number;
  flights: StairFlightDef[];
  landings: StairLandingDef[];
  /** Plan outline of the full stair (for opening / collision). */
  planPolygon: Vec2[];
  /** Bounding AABB in plan. */
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  treads: StairTreadMesh[];
  risers: StairRiserMesh[];
  /** Top of stair reaches toLevel FFE. */
  topElevation: number;
  bottomElevation: number;
};

export class StairGeometryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StairGeometryError';
  }
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function directionVector(directionDeg: number): { x: number; y: number } {
  const r = degToRad(directionDeg);
  return { x: Math.cos(r), y: Math.sin(r) };
}

function perpLeft(directionDeg: number): { x: number; y: number } {
  return directionVector(directionDeg + 90);
}

function add2(a: Vec2, b: Vec2, s = 1): Vec2 {
  return { x: a.x + b.x * s, y: a.y + b.y * s };
}

function rotateTurn(directionDeg: number, turn: StairTurn): number {
  return turn === 'left' ? directionDeg + 90 : directionDeg - 90;
}

function computeRiserCount(totalRise: number, maxRiser: number): number {
  if (!(totalRise > 0)) {
    throw new StairGeometryError('STAIR_RISE', 'Total rise must be positive', {
      totalRise,
    });
  }
  return Math.max(1, Math.ceil(totalRise / maxRiser - 1e-9));
}

function flightMeshes(
  flight: StairFlightDef,
  stairId: string,
  flightIndex: number,
): { treads: StairTreadMesh[]; risers: StairRiserMesh[] } {
  const dir = directionVector(flight.directionDeg);
  const left = perpLeft(flight.directionDeg);
  const treads: StairTreadMesh[] = [];
  const risers: StairRiserMesh[] = [];
  const treadThickness = Math.min(0.125, flight.riserHeight * 0.35);

  for (let i = 0; i < flight.riserCount; i++) {
    const elevBottom = flight.startElevation + i * flight.riserHeight;
    const along = i * flight.treadDepth;
    // Riser face at the start of each step
    const riserCenter = add2(
      add2(flight.origin, dir, along),
      left,
      0,
    );
    risers.push({
      id: `${stairId}-f${flightIndex}-riser-${i}`,
      position: {
        x: riserCenter.x + dir.x * 0.04,
        y: elevBottom + flight.riserHeight / 2,
        z: riserCenter.y + dir.y * 0.04,
      },
      size: {
        width: flight.width,
        height: flight.riserHeight,
        depth: 0.08,
      },
      rotationYDeg: -flight.directionDeg,
    });

    if (i < flight.treadCount) {
      const treadCenter = add2(
        add2(flight.origin, dir, along + flight.treadDepth / 2),
        left,
        0,
      );
      treads.push({
        id: `${stairId}-f${flightIndex}-tread-${i}`,
        position: {
          x: treadCenter.x,
          y: elevBottom + flight.riserHeight + treadThickness / 2,
          z: treadCenter.y,
        },
        size: {
          width: flight.width,
          height: treadThickness,
          depth: flight.treadDepth,
        },
        rotationYDeg: -flight.directionDeg,
      });
    }
  }

  return { treads, risers };
}

function polygonBounds(poly: Vec2[]) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function rectPolygon(
  origin: Vec2,
  directionDeg: number,
  run: number,
  width: number,
): Vec2[] {
  const dir = directionVector(directionDeg);
  const left = perpLeft(directionDeg);
  const hw = width / 2;
  const p0 = add2(origin, left, -hw);
  const p1 = add2(origin, left, hw);
  const p2 = add2(add2(origin, dir, run), left, hw);
  const p3 = add2(add2(origin, dir, run), left, -hw);
  return [p0, p1, p2, p3];
}

function mergePolygons(polys: Vec2[][]): Vec2[] {
  // Axis-aligned bounding outline for opening / bounds (MVP).
  const all = polys.flat();
  const b = polygonBounds(all);
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
}

/**
 * Derive full stair geometry for a stair authoring record + building levels.
 */
export function deriveStairGeometry(
  model: BuildingModelV1,
  stairInput: Stair,
): DerivedStairGeometry {
  const stair = StairSchema.parse(stairInput);
  const from = findLevel(model, stair.fromLevelId);
  const to = findLevel(model, stair.toLevelId);
  if (!from) {
    throw new StairGeometryError(
      'STAIR_LEVEL_MISSING',
      `fromLevelId not found: ${stair.fromLevelId}`,
    );
  }
  if (!to) {
    throw new StairGeometryError(
      'STAIR_LEVEL_MISSING',
      `toLevelId not found: ${stair.toLevelId}`,
    );
  }

  const bottomElevation = from.elevation;
  const topElevation = to.elevation;
  const totalRise = topElevation - bottomElevation;
  if (!(totalRise > 1e-6)) {
    throw new StairGeometryError(
      'STAIR_RISE',
      'toLevel must be above fromLevel (positive total rise)',
      { fromElevation: bottomElevation, toElevation: topElevation },
    );
  }

  if (stair.width < STAIR_DEFAULTS.minWidth - 1e-6) {
    throw new StairGeometryError(
      'STAIR_WIDTH',
      `Stair width ${stair.width} ft is below minimum ${STAIR_DEFAULTS.minWidth} ft`,
      { width: stair.width, minWidth: STAIR_DEFAULTS.minWidth },
    );
  }

  const maxRiser = stair.maxRiserHeight ?? STAIR_DEFAULTS.maxRiserHeight;
  const targetTread = stair.targetTreadDepth ?? STAIR_DEFAULTS.targetTreadDepth;
  const riserCount = computeRiserCount(totalRise, maxRiser);
  const riserHeight = totalRise / riserCount;
  if (riserHeight < STAIR_DEFAULTS.minRiserHeight - 1e-6) {
    throw new StairGeometryError(
      'STAIR_RISER',
      `Derived riser height ${riserHeight.toFixed(4)} ft is below minimum`,
      { riserHeight, min: STAIR_DEFAULTS.minRiserHeight },
    );
  }
  if (riserHeight > maxRiser + 1e-6) {
    throw new StairGeometryError(
      'STAIR_RISER',
      `Derived riser height ${riserHeight.toFixed(4)} ft exceeds max ${maxRiser}`,
      { riserHeight, maxRiser },
    );
  }

  const treadCount = Math.max(0, riserCount - 1);

  if (stair.type === 'straight') {
    let treadDepth = targetTread;
    if (stair.availableRun != null && treadCount > 0) {
      treadDepth = stair.availableRun / treadCount;
    }
    if (treadCount > 0 && treadDepth < STAIR_DEFAULTS.minTreadDepth - 1e-6) {
      throw new StairGeometryError(
        'STAIR_TREAD',
        `Derived tread depth ${treadDepth.toFixed(4)} ft is below minimum ${STAIR_DEFAULTS.minTreadDepth}`,
        {
          treadDepth,
          min: STAIR_DEFAULTS.minTreadDepth,
          availableRun: stair.availableRun ?? null,
        },
      );
    }
    const runLength = treadCount * treadDepth;
    const flight: StairFlightDef = {
      id: `${stair.id}-flight-0`,
      startElevation: bottomElevation,
      riserCount,
      riserHeight,
      treadCount,
      treadDepth,
      origin: { ...stair.origin },
      directionDeg: stair.directionDeg,
      width: stair.width,
      runLength,
    };
    const meshes = flightMeshes(flight, stair.id, 0);
    const planPolygon = rectPolygon(
      stair.origin,
      stair.directionDeg,
      Math.max(runLength, 0.5),
      stair.width,
    );
    return {
      stairId: stair.id,
      fromLevelId: stair.fromLevelId,
      toLevelId: stair.toLevelId,
      totalRise,
      riserCount,
      riserHeight,
      treadCount,
      treadDepth,
      width: stair.width,
      flights: [flight],
      landings: [],
      planPolygon,
      bounds: polygonBounds(planPolygon),
      treads: meshes.treads,
      risers: meshes.risers,
      topElevation,
      bottomElevation,
    };
  }

  // L-shaped
  const turn = stair.turn ?? 'left';
  const landingSize = stair.landingSize ?? stair.width;
  let firstRisers =
    stair.firstFlightRisers ?? Math.max(1, Math.floor(riserCount / 2));
  if (firstRisers >= riserCount) {
    firstRisers = Math.max(1, riserCount - 1);
  }
  const secondRisers = riserCount - firstRisers;
  if (secondRisers < 1) {
    throw new StairGeometryError(
      'STAIR_L_SPLIT',
      'L-shaped stair needs at least one riser on each flight',
      { riserCount, firstRisers },
    );
  }

  // Intermediate treads before the landing; landing deck is the walking surface after firstRisers.
  const firstTreads = Math.max(0, firstRisers - 1);
  // Upper floor acts as the final landing after the last riser.
  const secondTreads = Math.max(0, secondRisers - 1);

  let treadDepth = targetTread;
  // availableRun for L applies to combined flight runs (not landing)
  if (stair.availableRun != null) {
    const totalTreads = firstTreads + secondTreads;
    if (totalTreads > 0) {
      treadDepth = stair.availableRun / totalTreads;
    }
  }
  if (treadDepth < STAIR_DEFAULTS.minTreadDepth - 1e-6) {
    throw new StairGeometryError(
      'STAIR_TREAD',
      `Derived tread depth ${treadDepth.toFixed(4)} ft is below minimum`,
      { treadDepth, min: STAIR_DEFAULTS.minTreadDepth },
    );
  }

  const firstRun = firstTreads * treadDepth;
  const secondRun = secondTreads * treadDepth;
  const dir1 = stair.directionDeg;
  const dir2 = rotateTurn(dir1, turn);

  const flight1: StairFlightDef = {
    id: `${stair.id}-flight-0`,
    startElevation: bottomElevation,
    riserCount: firstRisers,
    riserHeight,
    treadCount: firstTreads,
    treadDepth,
    origin: { ...stair.origin },
    directionDeg: dir1,
    width: stair.width,
    runLength: firstRun,
  };

  // Landing at top of first flight
  const landingElev = bottomElevation + firstRisers * riserHeight;
  const landingOrigin = add2(stair.origin, directionVector(dir1), firstRun);
  const landCenter = add2(
    add2(landingOrigin, directionVector(dir1), landingSize / 2),
    perpLeft(dir1),
    0,
  );

  const secondOrigin = add2(landingOrigin, directionVector(dir1), landingSize);
  // For a left turn, second flight leaves the far side of landing along dir2.
  // Offset so the flight is centered on the landing width.
  const secondOriginCentered = add2(secondOrigin, perpLeft(dir2), 0);

  const flight2: StairFlightDef = {
    id: `${stair.id}-flight-1`,
    startElevation: landingElev,
    riserCount: secondRisers,
    riserHeight,
    treadCount: secondTreads,
    treadDepth,
    origin: secondOriginCentered,
    directionDeg: dir2,
    width: stair.width,
    runLength: Math.max(secondRun, 0.01),
  };

  const landing: StairLandingDef = {
    id: `${stair.id}-landing`,
    elevation: landingElev,
    center: landCenter,
    sizeX: landingSize,
    sizeY: landingSize,
    rotationDeg: -dir1,
  };

  const m1 = flightMeshes(flight1, stair.id, 0);
  const m2 = flightMeshes(flight2, stair.id, 1);
  const poly1 = rectPolygon(stair.origin, dir1, firstRun + landingSize, stair.width);
  const poly2 = rectPolygon(
    secondOriginCentered,
    dir2,
    Math.max(secondRun, landingSize * 0.5),
    stair.width,
  );
  const planPolygon = mergePolygons([poly1, poly2]);

  // Landing mesh as a thick tread
  const landingMesh: StairTreadMesh = {
    id: `${stair.id}-landing-deck`,
    position: {
      x: landCenter.x,
      y: landingElev + 0.06,
      z: landCenter.y,
    },
    size: {
      width: landingSize,
      height: 0.12,
      depth: landingSize,
    },
    rotationYDeg: -dir1,
  };

  return {
    stairId: stair.id,
    fromLevelId: stair.fromLevelId,
    toLevelId: stair.toLevelId,
    totalRise,
    riserCount,
    riserHeight,
    treadCount: firstTreads + secondTreads,
    treadDepth,
    width: stair.width,
    flights: [flight1, flight2],
    landings: [landing],
    planPolygon,
    bounds: polygonBounds(planPolygon),
    treads: [...m1.treads, landingMesh, ...m2.treads],
    risers: [...m1.risers, ...m2.risers],
    topElevation,
    bottomElevation,
  };
}

/** Build / refresh the upper-slab floor opening polygon for a derived stair. */
export function floorOpeningForStair(
  stair: Stair,
  derived: DerivedStairGeometry,
  options?: { openingId?: string; slabId?: string },
): FloorOpening {
  const m = STAIR_DEFAULTS.openingMargin;
  const b = derived.bounds;
  const polygon: Vec2[] = [
    { x: b.minX - m, y: b.minY - m },
    { x: b.maxX + m, y: b.minY - m },
    { x: b.maxX + m, y: b.maxY + m },
    { x: b.minX - m, y: b.maxY + m },
  ];
  return FloorOpeningSchema.parse({
    id: options?.openingId ?? stair.floorOpeningId ?? `${stair.id}-opening`,
    levelId: stair.toLevelId,
    slabId: options?.slabId,
    polygon,
    stairId: stair.id,
    label: `Stair opening (${stair.id})`,
  });
}

export function assertStairHeadroom(
  model: BuildingModelV1,
  derived: DerivedStairGeometry,
  openingPolygon?: Vec2[],
): void {
  const toLevel = findLevel(model, derived.toLevelId);
  if (!toLevel) return;
  const slab = model.slabs.find((s) => s.levelId === derived.toLevelId);
  const slabThickness = slab?.thickness ?? 0.5;
  const soffit = toLevel.elevation - slabThickness;
  // Open stairwell: clearance continues through the floor opening to the
  // upper-story ceiling. Under solid slab (outside the opening), use soffit.
  const upperCeiling = toLevel.elevation + toLevel.height;

  const pointInPoly = (point: Vec2, poly: Vec2[]): boolean => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i]!.x;
      const yi = poly[i]!.y;
      const xj = poly[j]!.x;
      const yj = poly[j]!.y;
      if (yi === yj) continue;
      const intersect =
        yi > point.y !== yj > point.y &&
        point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  };

  for (const tread of derived.treads) {
    const walkingY = tread.position.y + tread.size.height / 2;
    const planPt = { x: tread.position.x, y: tread.position.z };
    const inOpening =
      openingPolygon != null &&
      openingPolygon.length >= 3 &&
      pointInPoly(planPt, openingPolygon);
    const clearTo = inOpening ? upperCeiling : soffit;
    const headroom = clearTo - walkingY;
    if (headroom < STAIR_DEFAULTS.minHeadroom - 1e-3) {
      throw new StairGeometryError(
        'STAIR_HEADROOM',
        `Headroom ${headroom.toFixed(3)} ft below minimum ${STAIR_DEFAULTS.minHeadroom} ft at tread ${tread.id}`,
        {
          headroom,
          min: STAIR_DEFAULTS.minHeadroom,
          treadId: tread.id,
          inOpening,
        },
      );
    }
  }
}

export function stairTotalRiseBetweenLevels(
  model: BuildingModelV1,
  fromLevelId: string,
  toLevelId: string,
): number {
  return (
    levelFinishedFloorElevation(model, toLevelId) -
    levelFinishedFloorElevation(model, fromLevelId)
  );
}
