import { describe, expect, it } from 'vitest';
import { BuildingModelV1Schema } from './building-model';
import { applyDesignOperations, DesignServiceError } from './design-service';
import { buildBuildingGeometry } from './geometry/building-geometry';
import {
  footprintBounds,
  reportExposedLowerRoofRegions,
  resolveLevelFootprint,
} from './level-footprint';
import { createDefaultTestBuilding, syncShellToModel } from './shell';
import { checkModelIntegrity } from './integrity';
import { runDesignValidators } from './validation';
import type { RoofAssembly } from './roof-assembly';

function twoStoryShell() {
  return applyDesignOperations(createDefaultTestBuilding(), [
    {
      op: 'createLevel',
      name: 'Second Floor',
      height: 9,
      footprintSource: 'shell',
    },
  ]);
}

describe('partial / setback upper-level footprints', () => {
  it('TEST 1: Level 2 covers only the back half of Level 1', () => {
    const base = twoStoryShell();
    const shell = base.shell!;
    // Shell is 40×60 centered at origin → rear half: y ∈ [0, 30]
    const rearHalf = {
      kind: 'rect' as const,
      center: { x: 0, y: 15 },
      width: shell.width,
      depth: shell.depth / 2,
    };

    const model = applyDesignOperations(base, [
      {
        op: 'setLevelFootprint',
        levelId: 'level-2',
        footprint: rearHalf,
      },
      {
        op: 'createOpening',
        opening: {
          id: 'window-l2-rear',
          wall: 'rear',
          type: 'window',
          width: 4,
          height: 4,
          sillHeight: 3,
          position: 'center',
          levelId: 'level-2',
        },
      },
    ]);

    const l2 = model.levels.find((l) => l.id === 'level-2')!;
    expect(l2.footprintSource).toBe('custom');
    expect(l2.footprint?.depth).toBe(30);
    expect(l2.footprint?.center.y).toBe(15);

    const l2Walls = model.walls.filter((w) => w.levelId === 'level-2');
    expect(l2Walls).toHaveLength(4);
    expect(l2Walls.every((w) => w.id.includes('level-2') || w.id.startsWith('wall-'))).toBe(
      true,
    );
    expect(l2Walls.some((w) => w.id === 'wall-front')).toBe(false);

    const b = footprintBounds(rearHalf);
    const front = l2Walls.find((w) => w.id === 'wall-front__level-2')!;
    expect(front.start.y).toBeCloseTo(b.minY, 5);
    expect(front.end.y).toBeCloseTo(b.minY, 5);

    const slab2 = model.slabs.find((s) => s.levelId === 'level-2')!;
    const ys = slab2.polygon.map((p) => p.y);
    expect(Math.min(...ys)).toBeCloseTo(0, 5);
    expect(Math.max(...ys)).toBeCloseTo(30, 5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(shell.depth - 1);

    const opening = model.openings.find((o) => o.id === 'window-l2-rear')!;
    expect(opening.wallId).toBe('wall-rear__level-2');

    const roofAsm = model.roofAssemblies?.[0] as RoofAssembly | undefined;
    expect(roofAsm?.levelId).toBe('level-2');
    const gen = roofAsm?.masses[0]?.generator;
    expect(gen?.width).toBeCloseTo(rearHalf.width, 5);
    expect(gen?.depth).toBeCloseTo(rearHalf.depth, 5);
    expect(gen?.origin.y).toBeCloseTo(rearHalf.center.y, 5);

    const exposed = reportExposedLowerRoofRegions(model);
    expect(exposed).toHaveLength(1);
    expect(exposed[0]!.regions.length).toBeGreaterThan(0);

    const warnings = runDesignValidators(model, []).filter(
      (i) => i.code === 'EXPOSED_LOWER_ROOF',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('warning');

    const geom = buildBuildingGeometry(model);
    expect(geom.slabs.filter((s) => s.id.includes('level-2') || s.levelId === 'level-2').length).toBeGreaterThan(0);
    expect(BuildingModelV1Schema.safeParse(model).success).toBe(true);
    expect(checkModelIntegrity(model)).toEqual([]);
  });

  it('TEST 2: Level 2 centered but narrower than Level 1 (side setbacks)', () => {
    const base = twoStoryShell();
    const shell = base.shell!;
    const narrow = {
      kind: 'rect' as const,
      center: { x: 0, y: 0 },
      width: shell.width / 2,
      depth: shell.depth,
    };

    const model = applyDesignOperations(base, [
      { op: 'setLevelFootprint', levelId: 'level-2', footprint: narrow },
    ]);

    const fp = resolveLevelFootprint(model, 'level-2')!;
    expect(fp.width).toBe(20);
    expect(fp.depth).toBe(60);

    const left = model.walls.find((w) => w.id === 'wall-left__level-2')!;
    const right = model.walls.find((w) => w.id === 'wall-right__level-2')!;
    expect(left.start.x).toBeCloseTo(-10, 5);
    expect(right.start.x).toBeCloseTo(10, 5);

    const slab1 = model.slabs.find((s) => s.levelId === 'level-1')!;
    const slab2 = model.slabs.find((s) => s.levelId === 'level-2')!;
    const w1 = Math.max(...slab1.polygon.map((p) => p.x)) - Math.min(...slab1.polygon.map((p) => p.x));
    const w2 = Math.max(...slab2.polygon.map((p) => p.x)) - Math.min(...slab2.polygon.map((p) => p.x));
    expect(w2).toBeCloseTo(20, 5);
    expect(w1).toBeCloseTo(40, 5);

    const exposed = reportExposedLowerRoofRegions(model);
    expect(exposed[0]!.regions.length).toBe(2); // left + right strips

    const geom = buildBuildingGeometry(model);
    expect(geom.walls.some((w) => w.id === 'wall-left__level-2')).toBe(true);
    expect(geom.roofs.length).toBeGreaterThan(0);
  });

  it('TEST 3: stair terminating outside Level 2 footprint fails structured validation', () => {
    const base = twoStoryShell();
    const model = applyDesignOperations(base, [
      {
        op: 'setLevelFootprint',
        levelId: 'level-2',
        footprint: {
          kind: 'rect',
          center: { x: 0, y: 15 },
          width: 40,
          depth: 30,
        },
      },
    ]);

    // Stair near the front of the building — outside the rear-half L2.
    try {
      applyDesignOperations(model, [
        {
          op: 'createStair',
          id: 'stair-front',
          type: 'straight',
          fromLevelId: 'level-1',
          toLevelId: 'level-2',
          origin: { x: -6, y: -18 },
          directionDeg: 90,
          width: 3.5,
          availableRun: 12,
        },
      ]);
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DesignServiceError);
      const codes = (err as DesignServiceError).issues.map((i) => i.code);
      expect(codes).toContain('STAIR_OUTSIDE_UPPER_FOOTPRINT');
    }
  });

  it('TEST 4: save/load, sync, undo, and full-footprint levels remain unchanged', () => {
    const base = twoStoryShell();
    const beforeL1Walls = base.walls.filter((w) => w.levelId === 'level-1');
    const beforeL1Slab = base.slabs.find((s) => s.levelId === 'level-1')!;

    const withCustom = applyDesignOperations(base, [
      {
        op: 'setLevelFootprint',
        levelId: 'level-2',
        footprint: {
          kind: 'rect',
          center: { x: 0, y: 10 },
          width: 30,
          depth: 40,
        },
      },
    ]);

    // Round-trip through schema (save/load)
    const loaded = BuildingModelV1Schema.parse(JSON.parse(JSON.stringify(withCustom)));
    expect(loaded.levels.find((l) => l.id === 'level-2')!.footprintSource).toBe('custom');
    expect(loaded.levels.find((l) => l.id === 'level-2')!.footprint?.width).toBe(30);

    // syncShellToModel must not overwrite custom footprint
    const synced = syncShellToModel(loaded, loaded.shell!);
    expect(synced.levels.find((l) => l.id === 'level-2')!.footprint).toEqual(
      loaded.levels.find((l) => l.id === 'level-2')!.footprint,
    );
    expect(synced.levels.find((l) => l.id === 'level-2')!.footprintSource).toBe('custom');

    // L1 full footprint unchanged
    const afterL1Walls = synced.walls.filter((w) => w.levelId === 'level-1');
    expect(afterL1Walls.map((w) => w.id).sort()).toEqual(
      beforeL1Walls.map((w) => w.id).sort(),
    );
    const afterL1Slab = synced.slabs.find((s) => s.levelId === 'level-1')!;
    expect(afterL1Slab.polygon).toEqual(beforeL1Slab.polygon);

    // Clear restores shell-backed L2 (undo-style restore of prior footprint mode)
    const cleared = applyDesignOperations(synced, [
      { op: 'clearLevelFootprint', levelId: 'level-2' },
    ]);
    expect(cleared.levels.find((l) => l.id === 'level-2')!.footprintSource).toBe('shell');
    expect(cleared.levels.find((l) => l.id === 'level-2')!.footprint).toBeUndefined();
    expect(cleared.walls.some((w) => w.id === 'wall-front__level-2')).toBe(true);
    const slab2 = cleared.slabs.find((s) => s.levelId === 'level-2')!;
    const depth =
      Math.max(...slab2.polygon.map((p) => p.y)) - Math.min(...slab2.polygon.map((p) => p.y));
    expect(depth).toBeCloseTo(60, 5);

    // Full-footprint two-story building still validates cleanly (no custom warnings)
    const fullShell = twoStoryShell();
    const issues = runDesignValidators(fullShell, []).filter(
      (i) => (i.severity ?? 'error') === 'error',
    );
    expect(issues).toEqual([]);
    expect(checkModelIntegrity(fullShell)).toEqual([]);
  });

  it('rejects custom footprint outside the BuildingShell', () => {
    try {
      applyDesignOperations(twoStoryShell(), [
        {
          op: 'setLevelFootprint',
          levelId: 'level-2',
          footprint: {
            kind: 'rect',
            center: { x: 0, y: 0 },
            width: 80,
            depth: 60,
          },
        },
      ]);
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DesignServiceError);
      expect((err as DesignServiceError).issues[0]?.code).toBe(
        'LEVEL_FOOTPRINT_OUTSIDE_SHELL',
      );
    }
  });

  it('rejects custom footprint on the primary level by default', () => {
    try {
      applyDesignOperations(createDefaultTestBuilding(), [
        {
          op: 'setLevelFootprint',
          levelId: 'level-1',
          footprint: {
            kind: 'rect',
            center: { x: 0, y: 0 },
            width: 20,
            depth: 30,
          },
        },
      ]);
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DesignServiceError);
      expect((err as DesignServiceError).issues[0]?.code).toBe('LEVEL_FOOTPRINT_PRIMARY');
    }
  });
});
