/**
 * Domain ops for architectural stairs + owned floor openings.
 * Not agent-facing yet — staged via DesignOperation only.
 */
import type { BuildingModelV1 } from './building-model';
import { findLevel } from './levels';
import type { FloorOpening, Stair } from './stair';
import { FloorOpeningSchema, StairSchema } from './stair';
import {
  assertStairHeadroom,
  deriveStairGeometry,
  floorOpeningForStair,
  StairGeometryError,
  STAIR_DEFAULTS,
  type DerivedStairGeometry,
} from './geometry/stair-geometry';
import {
  footprintCornersFromRect,
  pointInFootprint,
  resolveLevelFootprint,
} from './level-footprint';
import { hydrateEntitiesFromModel } from './hydrate-entities';

export class StairOpsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StairOpsError';
  }
}

export type CreateStairInput = {
  id?: string;
  name?: string;
  type?: Stair['type'];
  fromLevelId: string;
  toLevelId: string;
  origin: Stair['origin'];
  directionDeg?: number;
  width: number;
  targetTreadDepth?: number;
  maxRiserHeight?: number;
  availableRun?: number;
  turn?: Stair['turn'];
  firstFlightRisers?: number;
  landingSize?: number;
  materialId?: string;
};

export type UpdateStairInput = {
  stairId: string;
  patch: Partial<
    Omit<Stair, 'id' | 'floorOpeningId'> & { floorOpeningId?: string }
  >;
};

export type DeleteStairInput = {
  stairId: string;
  /** When true, leave a manually authored floor opening that is not stair-owned. */
  keepOpening?: boolean;
};

function nextStairId(model: BuildingModelV1): string {
  const used = new Set((model.stairs ?? []).map((s) => s.id));
  let n = (model.stairs ?? []).length + 1;
  while (used.has(`stair-${n}`)) n += 1;
  return `stair-${n}`;
}

function resolveSlabForLevel(model: BuildingModelV1, levelId: string) {
  return model.slabs.find((s) => s.levelId === levelId);
}

function pointInPolygon(point: { x: number; y: number }, poly: Array<{ x: number; y: number }>): boolean {
  // Ray casting
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x;
    const yi = poly[i]!.y;
    const xj = poly[j]!.x;
    const yj = poly[j]!.y;
    const intersect =
      yi > point.y !== yj > point.y &&
      yj !== yi &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonContainsPolygon(
  outer: Array<{ x: number; y: number }>,
  inner: Array<{ x: number; y: number }>,
): boolean {
  return inner.every((p) => pointInPolygon(p, outer));
}

function segmentsIntersect(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number },
): boolean {
  const cross = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

function assertStairFitsFootprint(
  model: BuildingModelV1,
  stair: Stair,
  derived: DerivedStairGeometry,
): void {
  const fromFp = resolveLevelFootprint(model, stair.fromLevelId);
  if (fromFp) {
    const fromPoly = footprintCornersFromRect(fromFp);
    if (!polygonContainsPolygon(fromPoly, derived.planPolygon)) {
      throw new StairOpsError(
        'STAIR_OUTSIDE_FOOTPRINT',
        'Stair plan bounds extend outside the from-level footprint',
        { bounds: derived.bounds, levelId: stair.fromLevelId },
      );
    }
  }

  const toFp = resolveLevelFootprint(model, stair.toLevelId);
  if (toFp) {
    const outside = derived.planPolygon.filter((p) => !pointInFootprint(p, toFp));
    if (outside.length > 0) {
      throw new StairOpsError(
        'STAIR_OUTSIDE_UPPER_FOOTPRINT',
        `Stair does not terminate inside level ${stair.toLevelId} footprint`,
        {
          bounds: derived.bounds,
          toLevelId: stair.toLevelId,
          outsideCount: outside.length,
          toFootprint: toFp,
        },
      );
    }
  }
}

function assertStairWallClearance(
  model: BuildingModelV1,
  derived: DerivedStairGeometry,
  fromLevelId: string,
): void {
  const poly = derived.planPolygon;
  for (const wall of model.walls) {
    if (wall.levelId !== fromLevelId) continue;
    // Skip thin checks — look for wall centerline crossing the stair plan.
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      if (segmentsIntersect(wall.start, wall.end, a, b)) {
        // Exterior shell walls often bound the stair; only flag interior walls
        // or when the wall clearly crosses the interior of the stair rectangle.
        const mid = {
          x: (wall.start.x + wall.end.x) / 2,
          y: (wall.start.y + wall.end.y) / 2,
        };
        if (pointInPolygon(mid, poly)) {
          throw new StairOpsError(
            'STAIR_WALL_COLLISION',
            `Stair collides with wall ${wall.id}`,
            { wallId: wall.id, stairId: derived.stairId },
          );
        }
      }
    }
  }

  for (const e of model.entities ?? []) {
    if (e.levelId !== fromLevelId) continue;
    const type = String(e.type);
    if (!['furniture', 'island', 'baseCabinet', 'appliance', 'tallCabinet'].includes(type)) {
      continue;
    }
    const x = Number(e.geometry.x ?? NaN);
    const z = Number(e.geometry.z ?? NaN);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    if (pointInPolygon({ x, y: z }, poly)) {
      throw new StairOpsError(
        'STAIR_OBJECT_COLLISION',
        `Stair collides with placed object ${e.id}`,
        { objectId: e.id, stairId: derived.stairId },
      );
    }
  }
}

function assertOpeningContainsStair(
  opening: FloorOpening,
  derived: DerivedStairGeometry,
): void {
  if (!polygonContainsPolygon(opening.polygon, derived.planPolygon)) {
    throw new StairOpsError(
      'STAIR_OPENING_TOO_SMALL',
      'Floor opening does not contain the stair plan path',
      {
        openingId: opening.id,
        stairId: derived.stairId,
        openingBounds: opening.polygon,
        stairBounds: derived.bounds,
      },
    );
  }
}

function assertLanding(stair: Stair, derived: DerivedStairGeometry): void {
  if (stair.type !== 'lShape') return;
  const landing = derived.landings[0];
  if (!landing) {
    throw new StairOpsError('STAIR_LANDING', 'L-shaped stair is missing a landing');
  }
  const min = stair.width;
  if (landing.sizeX < min - 1e-6 || landing.sizeY < min - 1e-6) {
    throw new StairOpsError(
      'STAIR_LANDING',
      `Landing ${landing.sizeX.toFixed(2)}×${landing.sizeY.toFixed(2)} ft is smaller than stair width ${min} ft`,
      { landing, min },
    );
  }
}

function validateDerived(
  model: BuildingModelV1,
  stair: Stair,
  derived: DerivedStairGeometry,
  opening: FloorOpening,
): void {
  assertStairFitsFootprint(model, stair, derived);
  assertLanding(stair, derived);
  assertOpeningContainsStair(opening, derived);
  try {
    assertStairHeadroom(model, derived, opening.polygon);
  } catch (err) {
    if (err instanceof StairGeometryError) {
      throw new StairOpsError(err.code, err.message, err.details);
    }
    throw err;
  }
  assertStairWallClearance(model, derived, stair.fromLevelId);

  if (stair.availableRun != null && stair.type === 'straight') {
    const need = derived.treadCount * derived.treadDepth;
    if (need > stair.availableRun + 1e-4) {
      throw new StairOpsError(
        'STAIR_RUN_OVERFLOW',
        `Stair run ${need.toFixed(3)} ft exceeds availableRun ${stair.availableRun} ft`,
        { need, availableRun: stair.availableRun },
      );
    }
  }
}

function upsertOpening(
  openings: FloorOpening[],
  opening: FloorOpening,
): FloorOpening[] {
  const next = openings.filter((o) => o.id !== opening.id && o.stairId !== opening.stairId);
  next.push(FloorOpeningSchema.parse(opening));
  return next;
}

function removeOwnedOpening(
  openings: FloorOpening[],
  stair: Stair,
  keepOpening?: boolean,
): FloorOpening[] {
  if (keepOpening) {
    return openings.map((o) =>
      o.stairId === stair.id || o.id === stair.floorOpeningId
        ? { ...o, stairId: undefined }
        : o,
    );
  }
  return openings.filter(
    (o) => o.stairId !== stair.id && o.id !== stair.floorOpeningId,
  );
}

/**
 * Create a stair and its upper-slab floor opening. Geometry is derived from
 * level elevations + authoring params (not tread-by-tread authoring).
 */
export function createStair(
  model: BuildingModelV1,
  input: CreateStairInput,
): BuildingModelV1 {
  if (!findLevel(model, input.fromLevelId)) {
    throw new StairOpsError(
      'STAIR_LEVEL_MISSING',
      `fromLevelId not found: ${input.fromLevelId}`,
    );
  }
  if (!findLevel(model, input.toLevelId)) {
    throw new StairOpsError(
      'STAIR_LEVEL_MISSING',
      `toLevelId not found: ${input.toLevelId}`,
    );
  }
  if (input.fromLevelId === input.toLevelId) {
    throw new StairOpsError(
      'STAIR_SAME_LEVEL',
      'fromLevelId and toLevelId must differ',
    );
  }

  const id = input.id ?? nextStairId(model);
  if ((model.stairs ?? []).some((s) => s.id === id)) {
    throw new StairOpsError('STAIR_DUPLICATE_ID', `Stair id already exists: ${id}`);
  }

  const protectedIds = new Set(model.protectedEntityIds ?? []);
  if (protectedIds.has(id)) {
    throw new StairOpsError(
      'STAIR_PROTECTED',
      `Cannot create stair with protected id ${id}`,
    );
  }

  const type = input.type ?? 'straight';
  if (type === 'lShape' && !input.turn) {
    // default turn applied in schema / derive
  }

  const stairDraft = StairSchema.parse({
    id,
    name: input.name,
    type,
    fromLevelId: input.fromLevelId,
    toLevelId: input.toLevelId,
    origin: input.origin,
    directionDeg: input.directionDeg ?? 0,
    width: input.width,
    targetTreadDepth: input.targetTreadDepth,
    maxRiserHeight: input.maxRiserHeight,
    availableRun: input.availableRun,
    turn: input.turn ?? (type === 'lShape' ? 'left' : undefined),
    firstFlightRisers: input.firstFlightRisers,
    landingSize: input.landingSize,
    materialId: input.materialId,
  });

  let derived: DerivedStairGeometry;
  try {
    derived = deriveStairGeometry(model, stairDraft);
  } catch (err) {
    if (err instanceof StairGeometryError) {
      throw new StairOpsError(err.code, err.message, err.details);
    }
    throw err;
  }

  const upperSlab = resolveSlabForLevel(model, stairDraft.toLevelId);
  const opening = floorOpeningForStair(stairDraft, derived, {
    openingId: `${id}-opening`,
    slabId: upperSlab?.id,
  });

  const stair: Stair = { ...stairDraft, floorOpeningId: opening.id };
  validateDerived(model, stair, derived, opening);

  if (stair.width < STAIR_DEFAULTS.minWidth) {
    throw new StairOpsError('STAIR_WIDTH', 'Stair width below minimum');
  }

  const next: BuildingModelV1 = {
    ...model,
    stairs: [...(model.stairs ?? []), stair],
    floorOpenings: upsertOpening(model.floorOpenings ?? [], opening),
  };
  return hydrateEntitiesFromModel(next);
}

export function updateStair(
  model: BuildingModelV1,
  input: UpdateStairInput,
): BuildingModelV1 {
  const existing = (model.stairs ?? []).find((s) => s.id === input.stairId);
  if (!existing) {
    throw new StairOpsError('STAIR_MISSING', `Stair not found: ${input.stairId}`);
  }
  if ((model.protectedEntityIds ?? []).includes(input.stairId)) {
    throw new StairOpsError(
      'STAIR_PROTECTED',
      `Stair ${input.stairId} is protected`,
    );
  }

  const merged = StairSchema.parse({
    ...existing,
    ...input.patch,
    id: existing.id,
    floorOpeningId: existing.floorOpeningId,
  });

  let derived: DerivedStairGeometry;
  try {
    derived = deriveStairGeometry(model, merged);
  } catch (err) {
    if (err instanceof StairGeometryError) {
      throw new StairOpsError(err.code, err.message, err.details);
    }
    throw err;
  }

  const upperSlab = resolveSlabForLevel(model, merged.toLevelId);
  const opening = floorOpeningForStair(merged, derived, {
    openingId: existing.floorOpeningId ?? `${merged.id}-opening`,
    slabId: upperSlab?.id,
  });
  const stair: Stair = { ...merged, floorOpeningId: opening.id };
  validateDerived(model, stair, derived, opening);

  const next: BuildingModelV1 = {
    ...model,
    stairs: (model.stairs ?? []).map((s) => (s.id === stair.id ? stair : s)),
    floorOpenings: upsertOpening(model.floorOpenings ?? [], opening),
  };
  return hydrateEntitiesFromModel(next);
}

export function deleteStair(
  model: BuildingModelV1,
  input: DeleteStairInput,
): BuildingModelV1 {
  const existing = (model.stairs ?? []).find((s) => s.id === input.stairId);
  if (!existing) {
    throw new StairOpsError('STAIR_MISSING', `Stair not found: ${input.stairId}`);
  }
  if ((model.protectedEntityIds ?? []).includes(input.stairId)) {
    throw new StairOpsError(
      'STAIR_PROTECTED',
      `Stair ${input.stairId} is protected`,
    );
  }

  const next: BuildingModelV1 = {
    ...model,
    stairs: (model.stairs ?? []).filter((s) => s.id !== input.stairId),
    floorOpenings: removeOwnedOpening(
      model.floorOpenings ?? [],
      existing,
      input.keepOpening,
    ),
  };
  return hydrateEntitiesFromModel(next);
}

/** Inspect helper for tests / future agent tools. */
export function inspectStairGeometry(
  model: BuildingModelV1,
  stairId: string,
): DerivedStairGeometry {
  const stair = (model.stairs ?? []).find((s) => s.id === stairId);
  if (!stair) {
    throw new StairOpsError('STAIR_MISSING', `Stair not found: ${stairId}`);
  }
  try {
    return deriveStairGeometry(model, stair);
  } catch (err) {
    if (err instanceof StairGeometryError) {
      throw new StairOpsError(err.code, err.message, err.details);
    }
    throw err;
  }
}
