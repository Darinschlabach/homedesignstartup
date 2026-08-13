import type { BuildingModelV1, Vec2 } from './building-model';
import { deriveStairGeometry, STAIR_DEFAULTS } from './geometry/stair-geometry';
import { footprintBounds, resolveLevelFootprint } from './level-footprint';
import { LevelFootprintRectSchema, type LevelFootprintRect } from './level-footprint-schema';
import type { FloorOpening, Stair, StairTurn, StairType } from './stair';
import { createStair, StairOpsError } from './stair-ops';
import { runDesignValidators } from './validation';

export type StairPlacementSearchInput = {
  fromLevelId: string;
  toLevelId: string;
  proposedUpperFootprint: LevelFootprintRect;
  supportedTypes?: StairType[];
  widths?: number[];
  directionsDeg?: number[];
  gridStep?: number;
  maxCandidates?: number;
  /** Existing connecting stair to ignore while evaluating its replacement. */
  replacingStairId?: string;
};

export type StairPlacementCandidate = {
  type: StairType;
  origin: Vec2;
  directionDeg: number;
  width: number;
  availableRun: number;
  turn?: StairTurn;
  firstFlightRisers?: number;
  landingSize?: number;
  derived: {
    totalRise: number;
    riserCount: number;
    riserHeight: number;
    treadCount: number;
    treadDepth: number;
    flights: Array<{
      directionDeg: number;
      riserCount: number;
      treadCount: number;
      runLength: number;
    }>;
  };
  requiredFloorOpening: FloorOpening;
  clearance: {
    footprint: 'clear';
    walls: 'clear';
    objects: 'clear';
    headroom: 'clear';
  };
  validBecause: string[];
};

export type StairPlacementSearchResult = {
  status: 'CANDIDATES_FOUND' | 'NO_VALID_STAIR_PLACEMENT';
  candidates: StairPlacementCandidate[];
  evaluatedCount: number;
  rejectedByCode: Record<string, number>;
  search: {
    fromLevelId: string;
    toLevelId: string;
    proposedUpperFootprint: LevelFootprintRect;
    supportedTypes: StairType[];
    widths: number[];
    directionsDeg: number[];
    gridStep: number;
    exhaustive: boolean;
  };
};

function uniqueFinite(values: number[]): number[] {
  return [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
}

function gridValues(min: number, max: number, step: number): number[] {
  if (min > max) return [];
  const values = [min, max, (min + max) / 2];
  const first = Math.ceil(min / step) * step;
  for (let value = first; value <= max + 1e-6; value += step) values.push(value);
  return uniqueFinite(values.map((value) => Math.round(value * 1000) / 1000));
}

function modelForSearch(
  model: BuildingModelV1,
  input: StairPlacementSearchInput,
): BuildingModelV1 {
  const proposed = LevelFootprintRectSchema.parse(input.proposedUpperFootprint);
  const connectingIds = new Set(
    (model.stairs ?? [])
      .filter(
        (stair) =>
          stair.id === input.replacingStairId ||
          (stair.fromLevelId === input.fromLevelId && stair.toLevelId === input.toLevelId),
      )
      .map((stair) => stair.id),
  );
  const openingIds = new Set(
    (model.stairs ?? [])
      .filter((stair) => connectingIds.has(stair.id))
      .map((stair) => stair.floorOpeningId)
      .filter((id): id is string => Boolean(id)),
  );
  return {
    ...model,
    levels: model.levels.map((level) =>
      level.id === input.toLevelId
        ? { ...level, footprintSource: 'custom' as const, footprint: proposed }
        : level,
    ),
    stairs: (model.stairs ?? []).filter((stair) => !connectingIds.has(stair.id)),
    floorOpenings: (model.floorOpenings ?? []).filter(
      (opening) => !openingIds.has(opening.id) && !connectingIds.has(opening.stairId ?? ''),
    ),
  };
}

function candidateFromModel(
  model: BuildingModelV1,
  stair: Stair,
): StairPlacementCandidate {
  const derived = deriveStairGeometry(model, stair);
  const opening = model.floorOpenings.find((item) => item.id === stair.floorOpeningId)!;
  return {
    type: stair.type,
    origin: stair.origin,
    directionDeg: stair.directionDeg,
    width: stair.width,
    availableRun: derived.flights.reduce((sum, flight) => sum + flight.runLength, 0),
    ...(stair.type === 'lShape'
      ? {
          turn: stair.turn ?? 'left',
          firstFlightRisers: derived.flights[0]?.riserCount,
          landingSize: stair.landingSize ?? stair.width,
        }
      : {}),
    derived: {
      totalRise: derived.totalRise,
      riserCount: derived.riserCount,
      riserHeight: derived.riserHeight,
      treadCount: derived.treadCount,
      treadDepth: derived.treadDepth,
      flights: derived.flights.map((flight) => ({
        directionDeg: flight.directionDeg,
        riserCount: flight.riserCount,
        treadCount: flight.treadCount,
        runLength: flight.runLength,
      })),
    },
    requiredFloorOpening: opening,
    clearance: {
      footprint: 'clear',
      walls: 'clear',
      objects: 'clear',
      headroom: 'clear',
    },
    validBecause: [
      'Derived riser, tread, landing, and headroom requirements pass strict stair validation.',
      'Full stair plan and required floor opening lie inside both applicable level footprints.',
      'No blocking wall or placed-object collision was detected.',
    ],
  };
}

/**
 * Deterministically enumerate supported stair configurations and validate each
 * through the same strict stair operation used for persisted model mutations.
 */
export function findValidStairPlacements(
  model: BuildingModelV1,
  rawInput: StairPlacementSearchInput,
): StairPlacementSearchResult {
  const input = {
    ...rawInput,
    proposedUpperFootprint: LevelFootprintRectSchema.parse(rawInput.proposedUpperFootprint),
  };
  if (!model.levels.some((level) => level.id === input.fromLevelId)) {
    throw new StairOpsError('STAIR_LEVEL_MISSING', `fromLevelId not found: ${input.fromLevelId}`);
  }
  if (!model.levels.some((level) => level.id === input.toLevelId)) {
    throw new StairOpsError('STAIR_LEVEL_MISSING', `toLevelId not found: ${input.toLevelId}`);
  }
  const fromFootprint = resolveLevelFootprint(model, input.fromLevelId);
  if (!fromFootprint) {
    throw new StairOpsError('LEVEL_FOOTPRINT_MISSING', `No footprint for ${input.fromLevelId}`);
  }

  const supportedTypes: StairType[] = [
    ...new Set<StairType>(input.supportedTypes ?? ['straight', 'lShape']),
  ];
  const existing = (model.stairs ?? []).find((stair) => stair.id === input.replacingStairId);
  const widths = uniqueFinite(
    (input.widths ?? [existing?.width ?? STAIR_DEFAULTS.minWidth]).filter(
      (width) => width >= STAIR_DEFAULTS.minWidth - 1e-6,
    ),
  );
  const directionsDeg = uniqueFinite(input.directionsDeg ?? [0, 90, 180, 270]);
  const gridStep = input.gridStep && input.gridStep > 0 ? input.gridStep : 1;
  const maxCandidates = Math.max(1, input.maxCandidates ?? 24);
  const upperBounds = footprintBounds(input.proposedUpperFootprint);
  const lowerBounds = footprintBounds(fromFootprint);
  const bounds = {
    minX: Math.max(upperBounds.minX, lowerBounds.minX),
    maxX: Math.min(upperBounds.maxX, lowerBounds.maxX),
    minY: Math.max(upperBounds.minY, lowerBounds.minY),
    maxY: Math.min(upperBounds.maxY, lowerBounds.maxY),
  };
  const xs = gridValues(bounds.minX, bounds.maxX, gridStep);
  const ys = gridValues(bounds.minY, bounds.maxY, gridStep);
  const base = modelForSearch(model, input);
  const candidates: StairPlacementCandidate[] = [];
  const rejectedByCode: Record<string, number> = {};
  let evaluatedCount = 0;
  let exhausted = true;

  outer: for (const type of supportedTypes) {
    const turns: Array<StairTurn | undefined> = type === 'lShape' ? ['left', 'right'] : [undefined];
    for (const width of widths) {
      for (const directionDeg of directionsDeg) {
        for (const turn of turns) {
          for (const x of xs) {
            for (const y of ys) {
              evaluatedCount += 1;
              try {
                const withCandidate = createStair(base, {
                  id: '__stair_fit_candidate__',
                  type,
                  fromLevelId: input.fromLevelId,
                  toLevelId: input.toLevelId,
                  origin: { x, y },
                  directionDeg,
                  width,
                  ...(type === 'lShape'
                    ? { turn, landingSize: width }
                    : {}),
                });
                const stair = withCandidate.stairs.find(
                  (item) => item.id === '__stair_fit_candidate__',
                )!;
                const validationIssue = runDesignValidators(withCandidate, []).find(
                  (issue) =>
                    (issue.severity ?? 'error') === 'error' &&
                    (issue.entityId === stair.id ||
                      issue.code.startsWith('STAIR_') ||
                      issue.code.startsWith('FLOOR_OPENING')),
                );
                if (validationIssue) {
                  rejectedByCode[validationIssue.code] =
                    (rejectedByCode[validationIssue.code] ?? 0) + 1;
                  continue;
                }
                candidates.push(candidateFromModel(withCandidate, stair));
                if (candidates.length >= maxCandidates) {
                  exhausted = false;
                  break outer;
                }
              } catch (error) {
                const code = error instanceof StairOpsError ? error.code : 'STAIR_GEOMETRY';
                rejectedByCode[code] = (rejectedByCode[code] ?? 0) + 1;
              }
            }
          }
        }
      }
    }
  }

  return {
    status: candidates.length > 0 ? 'CANDIDATES_FOUND' : 'NO_VALID_STAIR_PLACEMENT',
    candidates,
    evaluatedCount,
    rejectedByCode,
    search: {
      fromLevelId: input.fromLevelId,
      toLevelId: input.toLevelId,
      proposedUpperFootprint: input.proposedUpperFootprint,
      supportedTypes,
      widths,
      directionsDeg,
      gridStep,
      exhaustive: exhausted,
    },
  };
}
