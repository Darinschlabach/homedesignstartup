import { describe, expect, it } from 'vitest';
import { BuildingModelV1Schema } from './building-model';
import { applyDesignOperations, DesignServiceError } from './design-service';
import { buildBuildingGeometry } from './geometry/building-geometry';
import type { RoofAssembly } from './roof-assembly';
import { createLevel, deleteLevel, LevelOpsError, updateLevel } from './level-ops';
import { createDefaultTestBuilding } from './shell';
import { runDesignValidators } from './validation';
import { checkModelIntegrity } from './integrity';

describe('multi-level domain foundation', () => {
  it('keeps single-story geometry at elevation 0 unchanged', () => {
    const model = createDefaultTestBuilding();
    const geom = buildBuildingGeometry(model);
    expect(model.levels).toHaveLength(1);
    expect(model.levels[0]!.elevation).toBe(0);
    expect(geom.slabs).toHaveLength(1);
    expect(geom.slab.position[1]).toBeCloseTo(-0.25, 5);
    const front = geom.walls.find((w) => w.id === 'wall-front');
    expect(front?.position[1]).toBeCloseTo(model.shell!.wallHeight / 2, 5);
    const roofYs = geom.roofs.flatMap((r) => {
      const ys: number[] = [];
      for (let i = 1; i < r.positions.length; i += 3) ys.push(r.positions[i]!);
      return ys;
    });
    expect(Math.min(...roofYs)).toBeGreaterThanOrEqual(model.shell!.wallHeight - 0.05);
  });

  it('createLevel stacks a same-footprint second story with separate slab/walls/roof', () => {
    const base = createDefaultTestBuilding();
    const l1Height = base.shell!.wallHeight;

    const two = applyDesignOperations(base, [
      {
        op: 'createLevel',
        name: 'Second Floor',
        height: 9,
        footprintSource: 'shell',
      },
      {
        op: 'createSpace',
        space: {
          id: 'space-l2',
          name: 'Upstairs',
          levelId: 'level-2',
          polygon: [
            { x: -10, y: -10 },
            { x: 10, y: -10 },
            { x: 10, y: 10 },
            { x: -10, y: 10 },
          ],
          tags: ['upper'],
        },
      },
      {
        op: 'createOpening',
        opening: {
          id: 'window-l2-front',
          wall: 'front',
          type: 'window',
          width: 4,
          height: 4,
          sillHeight: 3,
          position: 'center',
          levelId: 'level-2',
        },
      },
      {
        op: 'createObject',
        object: {
          id: 'sofa-l2',
          type: 'furniture',
          levelId: 'level-2',
          x: 0,
          y: 0,
          z: 0,
          width: 7,
          depth: 3,
          height: 3,
        },
      },
    ]);

    expect(two.levels).toHaveLength(2);
    expect(two.levels[0]!.elevation).toBe(0);
    expect(two.levels[0]!.height).toBe(l1Height);
    expect(two.levels[1]!.id).toBe('level-2');
    expect(two.levels[1]!.elevation).toBe(l1Height);
    expect(two.levels[1]!.height).toBe(9);
    expect(two.meta.stories).toBeGreaterThanOrEqual(2);

    expect(two.slabs.map((s) => s.levelId).sort()).toEqual(['level-1', 'level-2']);
    expect(two.walls.some((w) => w.id === 'wall-front' && w.levelId === 'level-1')).toBe(
      true,
    );
    expect(
      two.walls.some((w) => w.id === 'wall-front__level-2' && w.levelId === 'level-2'),
    ).toBe(true);
    expect(two.spaces.some((s) => s.id === 'space-l2' && s.levelId === 'level-2')).toBe(
      true,
    );
    expect(two.shell!.openings.some((o) => o.id === 'window-l2-front' && o.levelId === 'level-2')).toBe(
      true,
    );

    const roofLevelId = two.roofs[0]?.levelId;
    expect(roofLevelId).toBe('level-2');
    const assembly = two.roofAssemblies?.[0] as RoofAssembly | undefined;
    expect(assembly?.levelId).toBe('level-2');
    const eave = assembly?.masses[0]?.generator?.eaveHeight;
    expect(eave).toBeCloseTo(l1Height + 9, 5);

    const geom = buildBuildingGeometry(two);
    expect(geom.slabs).toHaveLength(2);
    const slab1 = geom.slabs.find((s) => s.levelId === 'level-1')!;
    const slab2 = geom.slabs.find((s) => s.levelId === 'level-2')!;
    expect(slab1.position[1]).toBeCloseTo(-0.25, 5);
    expect(slab2.position[1]).toBeCloseTo(l1Height - 0.25, 5);

    const wallL1 = geom.walls.find((w) => w.id === 'wall-front')!;
    const wallL2 = geom.walls.find((w) => w.id === 'wall-front__level-2')!;
    expect(wallL1.position[1]).toBeCloseTo(l1Height / 2, 5);
    expect(wallL2.position[1]).toBeCloseTo(l1Height + 9 / 2, 5);
    expect(wallL2.position[1]).toBeGreaterThan(wallL1.position[1] + 1);

    const openingL2 = geom.openings.find((o) => o.id === 'window-l2-front')!;
    expect(openingL2.position[1]).toBeCloseTo(l1Height + 3 + 2, 5);

    const sofa = geom.placedObjects.find((o) => o.id === 'sofa-l2')!;
    expect(sofa.position[1]).toBeCloseTo(l1Height + 1.5, 5);

    const roofYs = geom.roofs.flatMap((r) => {
      const ys: number[] = [];
      for (let i = 1; i < r.positions.length; i += 3) ys.push(r.positions[i]!);
      return ys;
    });
    expect(Math.min(...roofYs)).toBeGreaterThanOrEqual(l1Height + 9 - 0.05);

    expect(runDesignValidators(two, [])).toEqual([]);
    expect(checkModelIntegrity(two)).toEqual([]);

    // Round-trip serialization preserves levels.
    const parsed = BuildingModelV1Schema.parse(JSON.parse(JSON.stringify(two)));
    expect(parsed.levels).toHaveLength(2);
    expect(parsed.slabs).toHaveLength(2);
  });

  it('rejects deleting a level that still owns geometry without force', () => {
    const two = createLevel(createDefaultTestBuilding(), {
      name: 'Second Floor',
      height: 9,
    });
    expect(() => deleteLevel(two, { levelId: 'level-2' })).toThrow(LevelOpsError);
    const restored = deleteLevel(two, { levelId: 'level-2', force: true });
    expect(restored.levels).toHaveLength(1);
    expect(restored.slabs).toHaveLength(1);
    expect(restored.roofs[0]?.levelId).toBe(restored.levels[0]!.id);
  });

  it('updateLevel can change upper-story height and keep L1 at elevation 0', () => {
    const two = createLevel(createDefaultTestBuilding(), {
      name: 'Second Floor',
      height: 9,
    });
    const updated = updateLevel(two, {
      levelId: 'level-2',
      patch: { height: 10, name: 'Upper' },
    });
    expect(updated.levels[0]!.elevation).toBe(0);
    expect(updated.levels[1]!.height).toBe(10);
    expect(updated.levels[1]!.name).toBe('Upper');
    const geom = buildBuildingGeometry(updated);
    const wallL2 = geom.walls.find((w) => w.id === 'wall-front__level-2')!;
    expect(wallL2.height).toBe(10);
  });

  it('rejects custom footprintSource for now', () => {
    expect(() =>
      createLevel(createDefaultTestBuilding(), {
        name: 'Partial',
        footprintSource: 'custom',
      }),
    ).toThrow(LevelOpsError);
  });

  it('staged design ops can include createLevel (agent-operation compatible)', () => {
    const base = createDefaultTestBuilding();
    const next = applyDesignOperations(base, [
      { op: 'createLevel', name: 'Second Floor', height: 9 },
    ]);
    expect(next.levels).toHaveLength(2);
    // Simulate undo by re-applying from base snapshot identity
    expect(base.levels).toHaveLength(1);
    expect(base.levels[0]!.elevation).toBe(0);
  });

  it('overlapping level ranges fail validation', () => {
    const bad = {
      ...createDefaultTestBuilding(),
      levels: [
        { id: 'level-1', name: 'Main', elevation: 0, height: 10, footprintSource: 'shell' as const },
        { id: 'level-2', name: 'Bad', elevation: 5, height: 9, footprintSource: 'shell' as const },
      ],
    };
    const issues = runDesignValidators(bad, []);
    expect(issues.some((i) => i.code === 'LEVEL_RANGE_OVERLAP')).toBe(true);
  });

  it('rejects invalid createLevel via DesignServiceError', () => {
    try {
      applyDesignOperations(createDefaultTestBuilding(), [
        { op: 'createLevel', name: 'X', id: 'level-1' },
      ]);
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DesignServiceError);
      expect((err as DesignServiceError).issues[0]?.code).toBe('LEVEL_DUPLICATE_ID');
    }
  });
});
