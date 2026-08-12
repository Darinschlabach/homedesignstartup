import { describe, expect, it } from 'vitest';
import { BuildingModelV1Schema } from './building-model';
import { applyDesignOperations, DesignServiceError } from './design-service';
import { buildBuildingGeometry } from './geometry/building-geometry';
import {
  computeExposedLowerRegions,
  uncoveredExposedLowerRegions,
} from './lower-roof';
import { createDefaultTestBuilding, syncShellToModel } from './shell';
import { checkModelIntegrity } from './integrity';
import { runDesignValidators } from './validation';

function twoStory() {
  return applyDesignOperations(createDefaultTestBuilding(), [
    { op: 'createLevel', name: 'Second Floor', height: 9, footprintSource: 'shell' },
  ]);
}

describe('lower-roof exposed regions', () => {
  it('computes a front rectangle for rear-half Level 2', () => {
    const shell = createDefaultTestBuilding().shell!;
    const model = applyDesignOperations(twoStory(), [
      {
        op: 'setLevelFootprint',
        levelId: 'level-2',
        footprint: {
          kind: 'rect',
          center: { x: 0, y: shell.depth / 4 },
          width: shell.width,
          depth: shell.depth / 2,
        },
      },
    ]);

    const regions = computeExposedLowerRegions(model);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.side).toBe('front');
    expect(regions[0]!.footprint.depth).toBeCloseTo(shell.depth / 2, 5);
    expect(regions[0]!.footprint.width).toBeCloseTo(shell.width, 5);
    expect(regions[0]!.suggestedEaveHeight).toBeCloseTo(9, 5);
    expect(regions[0]!.upperEaveHeight).toBeCloseTo(18, 5);

    const warnings = runDesignValidators(model, []).filter(
      (i) => i.code === 'EXPOSED_LOWER_ROOF',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('warning');
  });

  it('computes left+right strips for a narrower centered Level 2', () => {
    const shell = createDefaultTestBuilding().shell!;
    const model = applyDesignOperations(twoStory(), [
      {
        op: 'setLevelFootprint',
        levelId: 'level-2',
        footprint: {
          kind: 'rect',
          center: { x: 0, y: 0 },
          width: shell.width / 2,
          depth: shell.depth,
        },
      },
    ]);

    const regions = computeExposedLowerRegions(model);
    expect(regions.map((r) => r.side).sort()).toEqual(['left', 'right']);
    expect(uncoveredExposedLowerRegions(model)).toHaveLength(2);
  });

  it('creates a durable lower-roof mass covering the front exposed region', () => {
    const shell = createDefaultTestBuilding().shell!;
    const base = applyDesignOperations(twoStory(), [
      {
        op: 'setLevelFootprint',
        levelId: 'level-2',
        footprint: {
          kind: 'rect',
          center: { x: 0, y: shell.depth / 4 },
          width: shell.width,
          depth: shell.depth / 2,
        },
      },
    ]);
    const region = computeExposedLowerRegions(base)[0]!;

    const next = applyDesignOperations(base, [
      {
        op: 'createRoofMass',
        role: 'lower',
        levelId: 'level-1',
        coversExposedRegionId: region.id,
        label: 'front lower',
        generator: {
          type: 'shed',
          origin: { x: region.footprint.center.x, y: region.footprint.center.y },
          width: region.footprint.width,
          depth: region.footprint.depth,
          eaveHeight: region.suggestedEaveHeight,
          pitch: 6,
          overhang: 1.5,
          ridgeDirection: 'width',
          highSide: 'rear',
        },
      },
    ]);

    expect(next.roofAssemblies?.some((a) => a.role === 'lower')).toBe(true);
    expect(uncoveredExposedLowerRegions(next)).toHaveLength(0);
    expect(
      runDesignValidators(next, []).filter((i) => i.code === 'EXPOSED_LOWER_ROOF'),
    ).toEqual([]);

    const geom = buildBuildingGeometry(next);
    expect(geom.roofs.length).toBeGreaterThan(1);

    const synced = syncShellToModel(next, next.shell!);
    expect(synced.roofAssemblies?.some((a) => a.role === 'lower')).toBe(true);
    expect(BuildingModelV1Schema.safeParse(synced).success).toBe(true);
    expect(checkModelIntegrity(synced)).toEqual([]);
  });

  it('rejects a lower roof that overlaps the upper footprint', () => {
    const shell = createDefaultTestBuilding().shell!;
    const base = applyDesignOperations(twoStory(), [
      {
        op: 'setLevelFootprint',
        levelId: 'level-2',
        footprint: {
          kind: 'rect',
          center: { x: 0, y: shell.depth / 4 },
          width: shell.width,
          depth: shell.depth / 2,
        },
      },
    ]);

    try {
      applyDesignOperations(base, [
        {
          op: 'createRoofMass',
          role: 'lower',
          levelId: 'level-1',
          generator: {
            type: 'gable',
            origin: { x: 0, y: 0 },
            width: shell.width,
            depth: shell.depth,
            eaveHeight: 9,
            pitch: 6,
            overhang: 1.5,
            ridgeDirection: 'depth',
          },
        },
      ]);
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DesignServiceError);
      expect((err as DesignServiceError).issues[0]?.code).toBe(
        'LOWER_ROOF_OVERLAPS_UPPER',
      );
    }
  });

  it('covers both side strips with independent lower assemblies', () => {
    const shell = createDefaultTestBuilding().shell!;
    const base = applyDesignOperations(twoStory(), [
      {
        op: 'setLevelFootprint',
        levelId: 'level-2',
        footprint: {
          kind: 'rect',
          center: { x: 0, y: 0 },
          width: shell.width / 2,
          depth: shell.depth,
        },
      },
    ]);
    const regions = computeExposedLowerRegions(base);
    expect(regions).toHaveLength(2);

    const next = applyDesignOperations(
      base,
      regions.map((region) => ({
        op: 'createRoofMass' as const,
        role: 'lower' as const,
        levelId: 'level-1',
        coversExposedRegionId: region.id,
        generator: {
          type: 'gable' as const,
          origin: { x: region.footprint.center.x, y: region.footprint.center.y },
          width: region.footprint.width,
          depth: region.footprint.depth,
          eaveHeight: region.suggestedEaveHeight,
          pitch: 6,
          overhang: 1,
          ridgeDirection: 'depth' as const,
        },
      })),
    );

    expect(next.roofAssemblies?.filter((a) => a.role === 'lower')).toHaveLength(2);
    expect(uncoveredExposedLowerRegions(next)).toHaveLength(0);
    expect(buildBuildingGeometry(next).roofs.length).toBeGreaterThan(2);
  });
});
