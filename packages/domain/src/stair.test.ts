import { describe, expect, it } from 'vitest';
import { BuildingModelV1Schema } from './building-model';
import { applyDesignOperations, DesignServiceError } from './design-service';
import { buildBuildingGeometry } from './geometry/building-geometry';
import { deriveStairGeometry, STAIR_DEFAULTS } from './geometry/stair-geometry';
import { createDefaultTestBuilding } from './shell';
import { inspectStairGeometry } from './stair-ops';
import { checkModelIntegrity } from './integrity';
import { runDesignValidators } from './validation';

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

describe('stair domain foundation', () => {
  it('derives straight stair geometry from level rise (not tread-by-tread authoring)', () => {
    const base = twoStoryBuilding();
    const l1 = base.levels.find((l) => l.id === 'level-1')!;
    const l2 = base.levels.find((l) => l.id === 'level-2')!;
    expect(l2.elevation - l1.elevation).toBe(9);

    const withStair = applyDesignOperations(base, [
      {
        op: 'createStair',
        id: 'stair-straight',
        type: 'straight',
        fromLevelId: 'level-1',
        toLevelId: 'level-2',
        origin: { x: -6, y: -18 },
        directionDeg: 90,
        width: 3.5,
        availableRun: 12,
      },
    ]);

    const stair = withStair.stairs!.find((s) => s.id === 'stair-straight')!;
    expect(stair).toBeTruthy();
    expect(stair.floorOpeningId).toBe('stair-straight-opening');

    const derived = inspectStairGeometry(withStair, 'stair-straight');
    expect(derived.totalRise).toBeCloseTo(9, 5);
    expect(derived.riserCount).toBe(Math.ceil(9 / STAIR_DEFAULTS.maxRiserHeight - 1e-9));
    expect(derived.riserHeight).toBeCloseTo(9 / derived.riserCount, 5);
    expect(derived.riserHeight).toBeLessThanOrEqual(STAIR_DEFAULTS.maxRiserHeight + 1e-6);
    expect(derived.treadCount).toBe(derived.riserCount - 1);
    expect(derived.treadDepth).toBeCloseTo(12 / derived.treadCount, 5);
    expect(derived.treadDepth).toBeGreaterThanOrEqual(STAIR_DEFAULTS.minTreadDepth - 1e-6);
    expect(derived.topElevation).toBeCloseTo(l2.elevation, 5);
    expect(derived.bottomElevation).toBeCloseTo(l1.elevation, 5);
    expect(derived.flights).toHaveLength(1);
    expect(derived.landings).toHaveLength(0);
    expect(derived.treads.length).toBe(derived.treadCount);
    expect(derived.risers.length).toBe(derived.riserCount);

    const opening = withStair.floorOpenings!.find((o) => o.id === stair.floorOpeningId);
    expect(opening).toBeTruthy();
    expect(opening!.levelId).toBe('level-2');
    expect(opening!.stairId).toBe('stair-straight');
    expect(opening!.polygon.length).toBeGreaterThanOrEqual(3);

    const geom = buildBuildingGeometry(withStair);
    expect(geom.stairs).toHaveLength(1);
    expect(geom.stairs[0]!.derived.riserCount).toBe(derived.riserCount);
    const upperSlab = geom.slabs.find((s) => s.levelId === 'level-2');
    expect(upperSlab?.holes?.length).toBe(1);
    expect(upperSlab?.polygon?.length).toBeGreaterThanOrEqual(3);

    // Top of last riser / walking surface reaches L2 FFE.
    const lastRiser = derived.risers[derived.risers.length - 1]!;
    expect(
      lastRiser.position.y + lastRiser.size.height / 2,
    ).toBeCloseTo(l2.elevation, 3);
  });

  it('round-trips straight stair + opening through schema / JSON', () => {
    const withStair = applyDesignOperations(twoStoryBuilding(), [
      {
        op: 'createStair',
        id: 'stair-straight',
        type: 'straight',
        fromLevelId: 'level-1',
        toLevelId: 'level-2',
        origin: { x: -6, y: -18 },
        directionDeg: 90,
        width: 3.5,
        availableRun: 12,
      },
    ]);
    const parsed = BuildingModelV1Schema.parse(JSON.parse(JSON.stringify(withStair)));
    expect(parsed.stairs).toHaveLength(1);
    expect(parsed.floorOpenings).toHaveLength(1);
    expect(checkModelIntegrity(parsed)).toEqual([]);
    expect(runDesignValidators(parsed, []).filter((i) => i.code.startsWith('STAIR'))).toEqual(
      [],
    );
    const again = deriveStairGeometry(parsed, parsed.stairs![0]!);
    expect(again.totalRise).toBe(9);
  });

  it('staged createStair then deleteStair removes owned floor opening', () => {
    const base = twoStoryBuilding();
    const created = applyDesignOperations(base, [
      {
        op: 'createStair',
        id: 'stair-a',
        type: 'straight',
        fromLevelId: 'level-1',
        toLevelId: 'level-2',
        origin: { x: -6, y: -18 },
        directionDeg: 90,
        width: 3.5,
        availableRun: 12,
      },
    ]);
    expect(created.stairs).toHaveLength(1);
    expect(created.floorOpenings).toHaveLength(1);

    const deleted = applyDesignOperations(created, [
      { op: 'deleteStair', stairId: 'stair-a' },
    ]);
    expect(deleted.stairs).toHaveLength(0);
    expect(deleted.floorOpenings).toHaveLength(0);

    // Undo simulation: restore prior JSON snapshot
    const restored = BuildingModelV1Schema.parse(JSON.parse(JSON.stringify(created)));
    expect(restored.stairs).toHaveLength(1);
    expect(restored.floorOpenings).toHaveLength(1);
  });

  it('rejects unsafe rise / same-level / missing levels with structured conflicts', () => {
    const base = twoStoryBuilding();
    expect(() =>
      applyDesignOperations(base, [
        {
          op: 'createStair',
          fromLevelId: 'level-2',
          toLevelId: 'level-1',
          origin: { x: 0, y: 0 },
          width: 3.5,
        },
      ]),
    ).toThrow(DesignServiceError);

    expect(() =>
      applyDesignOperations(base, [
        {
          op: 'createStair',
          fromLevelId: 'level-1',
          toLevelId: 'level-1',
          origin: { x: 0, y: 0 },
          width: 3.5,
        },
      ]),
    ).toThrow(DesignServiceError);

    expect(() =>
      applyDesignOperations(base, [
        {
          op: 'createStair',
          fromLevelId: 'level-1',
          toLevelId: 'level-2',
          origin: { x: 0, y: 0 },
          width: 2,
        },
      ]),
    ).toThrow(DesignServiceError);

    expect(() =>
      applyDesignOperations(base, [
        {
          op: 'createStair',
          fromLevelId: 'level-1',
          toLevelId: 'level-2',
          origin: { x: -6, y: -18 },
          directionDeg: 90,
          width: 3.5,
          availableRun: 4,
        },
      ]),
    ).toThrow(DesignServiceError);
  });

  it('creates L-shaped stair with landing and upper opening', () => {
    const withStair = applyDesignOperations(twoStoryBuilding(), [
      {
        op: 'createStair',
        id: 'stair-l',
        type: 'lShape',
        fromLevelId: 'level-1',
        toLevelId: 'level-2',
        origin: { x: -14, y: -12 },
        directionDeg: 0,
        turn: 'left',
        width: 3.5,
        landingSize: 3.5,
        firstFlightRisers: 7,
        targetTreadDepth: 11 / 12,
      },
    ]);

    const derived = inspectStairGeometry(withStair, 'stair-l');
    expect(derived.totalRise).toBeCloseTo(9, 5);
    expect(derived.flights).toHaveLength(2);
    expect(derived.landings).toHaveLength(1);
    expect(derived.landings[0]!.elevation).toBeCloseTo(
      derived.bottomElevation + 7 * derived.riserHeight,
      5,
    );
    expect(derived.topElevation).toBeCloseTo(9, 5);
    expect(withStair.floorOpenings).toHaveLength(1);
    expect(withStair.floorOpenings![0]!.levelId).toBe('level-2');

    const geom = buildBuildingGeometry(withStair);
    expect(geom.stairs[0]!.derived.landings).toHaveLength(1);
    const upper = geom.slabs.find((s) => s.levelId === 'level-2');
    expect(upper?.holes?.length).toBe(1);
  });

  it('updateStair refreshes the owned floor opening', () => {
    const created = applyDesignOperations(twoStoryBuilding(), [
      {
        op: 'createStair',
        id: 'stair-u',
        type: 'straight',
        fromLevelId: 'level-1',
        toLevelId: 'level-2',
        origin: { x: -6, y: -18 },
        directionDeg: 90,
        width: 3.5,
        availableRun: 12,
      },
    ]);
    const before = created.floorOpenings![0]!.polygon.map((p) => ({ ...p }));
    const updated = applyDesignOperations(created, [
      {
        op: 'updateStair',
        stairId: 'stair-u',
        patch: { origin: { x: -4, y: -18 }, width: 4 },
      },
    ]);
    expect(updated.stairs![0]!.width).toBe(4);
    expect(updated.floorOpenings).toHaveLength(1);
    expect(updated.floorOpenings![0]!.polygon).not.toEqual(before);
  });
});
