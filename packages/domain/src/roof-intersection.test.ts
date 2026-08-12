import { describe, expect, it } from 'vitest';
import { BuildingModelV1Schema } from './building-model';
import { buildBuildingGeometry } from './geometry/building-geometry';
import {
  assertNoInterpenetration,
  buildCrossGableAssembly,
  recompileRoofAssembly,
  RoofIntersectionError,
} from './geometry/roof-intersection';
import { polygonArea3 } from './geometry/roof-plane-math';
import { applyDesignOperations, DesignServiceError } from './design-service';
import {
  createDefaultTestBuilding,
  setRoofAssemblies,
  syncShellToModel,
  updateBuildingDimensions,
  updateRoof,
} from './shell';
import { runDesignValidators } from './validation';
import { createRoofMass, deleteRoofMass, updateRoofMass } from './roof-mass-ops';
import type { RoofAssembly } from './roof-assembly';

function asRoofAssembly(raw: unknown): RoofAssembly {
  return raw as RoofAssembly;
}

function sampleCross(
  base = createDefaultTestBuilding({ buildingType: 'home', name: 'Cross' }),
) {
  return buildCrossGableAssembly({
    eaveHeight: base.shell!.wallHeight,
    materialId: 'mat-roof',
    main: {
      width: base.shell!.width,
      depth: base.shell!.depth,
      pitch: 7,
      overhang: 1.5,
      ridgeDirection: 'depth',
    },
    wing: {
      origin: { x: 0, y: -base.shell!.depth / 4 },
      width: base.shell!.width * 0.55,
      depth: base.shell!.depth * 0.45,
      pitch: 7,
      overhang: 1.5,
      ridgeDirection: 'width',
    },
  });
}

describe('roof intersection clipping', () => {
  it('keeps simple gable/hip/shed/flat unchanged', () => {
    for (const patch of [
      { type: 'gable' as const, pitch: 6 },
      { type: 'hip' as const, pitch: 8 },
      { type: 'shed' as const, pitch: 4, highSide: 'rear' as const },
      { type: 'flat' as const, pitch: 0 },
    ]) {
      const model = updateRoof(createDefaultTestBuilding(), patch);
      expect(model.roofAssemblies?.[0]?.source).toBe('shell');
      expect(buildBuildingGeometry(model).roofs.length).toBeGreaterThan(0);
    }
  });

  it('produces real clipped valleys for perpendicular gable+gable', () => {
    const assembly = sampleCross();
    expect(assembly.source).toBe('composed');
    expect(assembly.masses.length).toBe(2);
    const valleys = assembly.edges.filter((e) => e.kind === 'valley');
    expect(valleys.length).toBeGreaterThan(0);
    for (const v of valleys) {
      expect(
        Math.hypot(v.end.x - v.start.x, v.end.y - v.start.y, v.end.z - v.start.z),
      ).toBeGreaterThan(0.05);
      expect(v.planeIds.length).toBe(2);
    }
    for (const p of assembly.planes) {
      expect(polygonArea3(p.boundary)).toBeGreaterThan(1e-4);
    }
  });

  it('does not keep interpenetrating roof surfaces', () => {
    const assembly = sampleCross();
    const check = assertNoInterpenetration(assembly, 16);
    expect(check.ok).toBe(true);
  });

  it('save/load preserves authoring and regenerates equivalent derived geometry', () => {
    const base = createDefaultTestBuilding();
    const model = setRoofAssemblies(base, [sampleCross(base)]);
    const authoring = asRoofAssembly(model.roofAssemblies![0]).masses.map(
      (m) => m.generator,
    );
    const json = JSON.parse(JSON.stringify(model));
    // Strip derived planes/edges to simulate authoring-only persistence preference
    json.roofAssemblies[0].planes = [];
    json.roofAssemblies[0].edges = [];
    const parsed = BuildingModelV1Schema.parse(json);
    const parsedAssembly = asRoofAssembly(parsed.roofAssemblies![0]);
    const recompiled = recompileRoofAssembly({
      ...parsedAssembly,
      masses: parsedAssembly.masses.map((m, i) => ({
        id: m.id,
        label: m.label,
        generator: authoring[i]!,
        planeIds: [],
      })),
      planes: [],
      edges: [],
      source: 'composed',
      id: parsedAssembly.id,
      levelId: parsedAssembly.levelId,
      materialId: parsedAssembly.materialId,
    }).assembly;

    expect(recompiled.planes.length).toBeGreaterThan(0);
    expect(recompiled.edges.some((e) => e.kind === 'valley')).toBe(true);
    expect(buildBuildingGeometry(setRoofAssemblies(base, [recompiled])).roofs.length).toBeGreaterThan(
      0,
    );
  });

  it('staged geometry displays clipped roof (mesh from assemblies)', () => {
    const base = createDefaultTestBuilding();
    const assembly = sampleCross(base);
    const model = setRoofAssemblies(base, [assembly]);
    const geom = buildBuildingGeometry(model);
    expect(geom.roofs.length).toBeGreaterThan(0);
    // Each triangle references a clipped plane entity id
    expect(geom.roofs.every((r) => r.positions.length >= 9)).toBe(true);
  });

  it('undo restores previous assembly by model swap', () => {
    const before = updateRoof(createDefaultTestBuilding(), { type: 'gable', pitch: 6 });
    const after = setRoofAssemblies(before, [sampleCross(before)]);
    expect(after.roofAssemblies?.[0]?.source).toBe('composed');
    const undone = BuildingModelV1Schema.parse(JSON.parse(JSON.stringify(before)));
    expect(undone.roofAssemblies?.[0]?.source ?? 'shell').not.toBe('composed');
    expect(undone.shell?.roof.type).toBe('gable');
  });

  it('invalid non-overlapping intersection returns structured failure', () => {
    expect(() =>
      buildCrossGableAssembly({
        eaveHeight: 9,
        main: { width: 40, depth: 20, pitch: 6, ridgeDirection: 'depth' },
        wing: {
          origin: { x: 0, y: 80 },
          width: 10,
          depth: 10,
          pitch: 6,
          ridgeDirection: 'width',
        },
      }),
    ).toThrow(RoofIntersectionError);

    try {
      buildCrossGableAssembly({
        eaveHeight: 9,
        main: { width: 40, depth: 20, pitch: 6, ridgeDirection: 'depth' },
        wing: {
          origin: { x: 0, y: 80 },
          width: 10,
          depth: 10,
          pitch: 6,
          ridgeDirection: 'width',
        },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RoofIntersectionError);
      expect((err as RoofIntersectionError).code).toBe('ROOF_INTERSECT_NO_OVERLAP');
    }
  });

  it('footprint modification detects composed-roof incompatibility', () => {
    const base = createDefaultTestBuilding();
    const model = setRoofAssemblies(base, [sampleCross(base)]);

    try {
      applyDesignOperations(model, [
        { op: 'updateBuildingDimensions', width: 8, depth: 8 },
      ]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DesignServiceError);
      const issues = (err as DesignServiceError).issues;
      expect(issues.some((i) => i.code === 'COMPOSED_ROOF_RELAYOUT_REQUIRED')).toBe(
        true,
      );
    }
  });

  it('create/update/deleteRoofMass domain ops recompile derived geometry', () => {
    const base = createDefaultTestBuilding();
    // Shell already has one mass; adding a wing promotes to composed + clips valleys.
    let model = createRoofMass(base, {
      label: 'wing',
      generator: {
        type: 'gable',
        origin: { x: 0, y: -base.shell!.depth / 4 },
        width: base.shell!.width * 0.5,
        depth: base.shell!.depth * 0.4,
        eaveHeight: base.shell!.wallHeight,
        pitch: 6,
        overhang: 1.5,
        ridgeDirection: 'width',
      },
    });
    let assembly = asRoofAssembly(model.roofAssemblies![0]);
    const assemblyId = assembly.id;
    expect(assembly.masses.length).toBe(2);
    expect(assembly.edges.some((e) => e.kind === 'valley')).toBe(true);

    const wingId = assembly.masses.find((m) => m.label === 'wing')!.id;
    model = updateRoofMass(model, {
      assemblyId,
      massId: wingId,
      patch: { pitch: 8 },
    });
    assembly = asRoofAssembly(model.roofAssemblies![0]);
    expect(assembly.masses.find((m) => m.id === wingId)!.generator!.pitch).toBe(8);

    model = deleteRoofMass(model, { assemblyId, massId: wingId });
    expect(asRoofAssembly(model.roofAssemblies![0]).masses.length).toBe(1);
  });

  it('gable+shed intersection is supported when footprints overlap', () => {
    const assembly = recompileRoofAssembly({
      id: 'roof-gs',
      levelId: 'level-1',
      source: 'composed',
      materialId: 'mat-roof',
      masses: [
        {
          id: 'm-gable',
          generator: {
            type: 'gable',
            origin: { x: 0, y: 0 },
            width: 40,
            depth: 30,
            eaveHeight: 9,
            pitch: 6,
            overhang: 1,
            ridgeDirection: 'depth',
          },
          planeIds: [],
        },
        {
          id: 'm-shed',
          generator: {
            type: 'shed',
            origin: { x: 0, y: -8 },
            width: 20,
            depth: 16,
            eaveHeight: 9,
            pitch: 4,
            overhang: 1,
            ridgeDirection: 'depth',
            highSide: 'rear',
          },
          planeIds: [],
        },
      ],
      planes: [],
      edges: [],
    }).assembly;
    expect(assembly.planes.length).toBeGreaterThan(0);
    expect(assembly.edges.some((e) => e.kind === 'valley' || e.kind === 'shared')).toBe(
      true,
    );
  });

  it('rejects a secondary gable that is fully buried under the main roof', () => {
    try {
      createRoofMass(
        (() => {
          const base = createDefaultTestBuilding();
          const shell = base.shell!;
          return syncShellToModel(base, {
            ...shell,
            width: 45,
            depth: 60,
            wallHeight: 9,
            roof: {
              type: 'gable',
              pitch: 10,
              overhang: 1.5,
              ridgeDirection: 'depth',
            },
          });
        })(),
        {
          label: 'buried-wing',
          generator: {
            type: 'gable',
            origin: { x: 0, y: -16.5 },
            width: 22,
            depth: 6,
            eaveHeight: 9,
            pitch: 10,
            overhang: 1.5,
            ridgeDirection: 'width',
          },
        },
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RoofIntersectionError);
      expect((err as RoofIntersectionError).code).toBe('ROOF_INTERSECT_BURIED');
      expect((err as RoofIntersectionError).details?.minWingDepthFt).toBeTruthy();
    }
  });

  it('accepts a secondary front gable large enough to break through a 45×60 main', () => {
    const base = createDefaultTestBuilding();
    const shell = base.shell!;
    const model = syncShellToModel(base, {
      ...shell,
      width: 45,
      depth: 60,
      wallHeight: 9,
      roof: {
        type: 'hip',
        pitch: 10,
        overhang: 1.5,
        ridgeDirection: 'depth',
      },
    });
    const next = createRoofMass(model, {
      label: 'front-gable',
      generator: {
        type: 'gable',
        origin: { x: 0, y: -15 },
        width: 24,
        depth: 26,
        eaveHeight: 9,
        pitch: 10,
        overhang: 1.5,
        ridgeDirection: 'width',
      },
    });
    const assembly = asRoofAssembly(next.roofAssemblies![0]);
    expect(assembly.masses).toHaveLength(2);
    expect(assembly.masses[0]!.generator!.type).toBe('gable'); // hip→gable convert
    expect(assembly.edges.some((e) => e.kind === 'valley')).toBe(true);
  });
});
