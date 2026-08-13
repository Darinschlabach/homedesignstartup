import { describe, expect, it } from 'vitest';
import { applyDesignOperations } from './design-service';
import { footprintBounds, pointInFootprint } from './level-footprint';
import { createDefaultTestBuilding } from './shell';
import { findValidStairPlacements } from './stair-fit';

function twoStoryBuilding() {
  return applyDesignOperations(createDefaultTestBuilding(), [
    {
      op: 'createLevel',
      name: 'Second Floor',
      height: 9,
      footprintSource: 'shell',
    },
  ]);
}

const rearUpper = {
  kind: 'rect' as const,
  center: { x: 0, y: 12 },
  width: 30,
  depth: 30,
};

describe('deterministic stair-fit analysis', () => {
  it('finds a valid straight candidate with derived geometry', () => {
    const result = findValidStairPlacements(twoStoryBuilding(), {
      fromLevelId: 'level-1',
      toLevelId: 'level-2',
      proposedUpperFootprint: rearUpper,
      supportedTypes: ['straight'],
      widths: [3.5],
      directionsDeg: [90],
      maxCandidates: 2,
    });
    expect(result.status).toBe('CANDIDATES_FOUND');
    expect(result.candidates[0]).toMatchObject({
      type: 'straight',
      width: 3.5,
      clearance: {
        footprint: 'clear',
        walls: 'clear',
        objects: 'clear',
        headroom: 'clear',
      },
    });
    expect(result.candidates[0]!.derived.riserCount).toBeGreaterThan(1);
    expect(result.candidates[0]!.derived.treadDepth).toBeGreaterThan(0);
  });

  it('finds a valid L-shaped candidate with landing and turn data', () => {
    const result = findValidStairPlacements(twoStoryBuilding(), {
      fromLevelId: 'level-1',
      toLevelId: 'level-2',
      proposedUpperFootprint: { ...rearUpper, width: 24, depth: 24 },
      supportedTypes: ['lShape'],
      widths: [3.5],
      directionsDeg: [0, 90],
      maxCandidates: 2,
    });
    const candidate = result.candidates[0]!;
    expect(candidate.type).toBe('lShape');
    expect(candidate.turn === 'left' || candidate.turn === 'right').toBe(true);
    expect(candidate.landingSize).toBe(3.5);
    expect(candidate.derived.flights).toHaveLength(2);
  });

  it('keeps candidates inside a proposed custom upper footprint', () => {
    const result = findValidStairPlacements(twoStoryBuilding(), {
      fromLevelId: 'level-1',
      toLevelId: 'level-2',
      proposedUpperFootprint: rearUpper,
      supportedTypes: ['straight'],
      directionsDeg: [0, 90, 180, 270],
      maxCandidates: 4,
    });
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      for (const point of candidate.requiredFloorOpening.polygon) {
        expect(pointInFootprint(point, rearUpper)).toBe(true);
      }
    }
  });

  it('rejects candidates blocked by walls', () => {
    const base = twoStoryBuilding();
    const model = {
      ...base,
      walls: [
        ...base.walls,
        {
          id: 'blocking-wall',
          levelId: 'level-1',
          start: { x: -2, y: 0 },
          end: { x: 2, y: 0 },
          thickness: 0.5,
          height: 9,
        },
      ],
    };
    const result = findValidStairPlacements(model, {
      fromLevelId: 'level-1',
      toLevelId: 'level-2',
      proposedUpperFootprint: {
        kind: 'rect',
        center: { x: 0, y: 0 },
        width: 4,
        depth: 16,
      },
      supportedTypes: ['straight'],
      widths: [3],
      directionsDeg: [90],
      gridStep: 0.5,
    });
    expect(result.status).toBe('NO_VALID_STAIR_PLACEMENT');
    expect(result.rejectedByCode.STAIR_WALL_COLLISION).toBeGreaterThan(0);
  });

  it('rejects candidates blocked by placed objects', () => {
    const base = twoStoryBuilding();
    const model = {
      ...base,
      entities: [
        ...(base.entities ?? []),
        {
          id: 'blocking-island',
          type: 'island',
          levelId: 'level-1',
          geometry: { x: 0, y: 0, z: 0, width: 3, depth: 3, height: 3 },
          properties: {},
        },
      ],
    };
    const result = findValidStairPlacements(model, {
      fromLevelId: 'level-1',
      toLevelId: 'level-2',
      proposedUpperFootprint: {
        kind: 'rect',
        center: { x: 0, y: 0 },
        width: 4,
        depth: 16,
      },
      supportedTypes: ['straight'],
      widths: [3],
      directionsDeg: [90],
      gridStep: 0.5,
    });
    expect(result.status).toBe('NO_VALID_STAIR_PLACEMENT');
    expect(result.rejectedByCode.STAIR_OBJECT_COLLISION).toBeGreaterThan(0);
  });

  it('returns NO_VALID_STAIR_PLACEMENT when geometry cannot fit', () => {
    const result = findValidStairPlacements(twoStoryBuilding(), {
      fromLevelId: 'level-1',
      toLevelId: 'level-2',
      proposedUpperFootprint: {
        kind: 'rect',
        center: { x: 0, y: 0 },
        width: 3,
        depth: 3,
      },
      supportedTypes: ['straight', 'lShape'],
      widths: [3],
      gridStep: 1,
    });
    expect(result.status).toBe('NO_VALID_STAIR_PLACEMENT');
    expect(result.candidates).toEqual([]);
    expect(result.search.exhaustive).toBe(true);
  });

  it('returns a required floor opening wholly inside the upper slab', () => {
    const result = findValidStairPlacements(twoStoryBuilding(), {
      fromLevelId: 'level-1',
      toLevelId: 'level-2',
      proposedUpperFootprint: rearUpper,
      supportedTypes: ['straight'],
      maxCandidates: 1,
    });
    const opening = result.candidates[0]!.requiredFloorOpening;
    const bounds = footprintBounds(rearUpper);
    expect(opening.levelId).toBe('level-2');
    expect(
      opening.polygon.every(
        (point) =>
          point.x >= bounds.minX &&
          point.x <= bounds.maxX &&
          point.y >= bounds.minY &&
          point.y <= bounds.maxY,
      ),
    ).toBe(true);
  });
});
