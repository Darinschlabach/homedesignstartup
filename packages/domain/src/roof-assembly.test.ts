import { describe, expect, it } from 'vitest';
import { BuildingModelV1Schema } from './building-model';
import { buildBuildingGeometry } from './geometry/building-geometry';
import { applyDesignOperations } from './design-service';
import {
  buildCrossGableAssembly,
  ensureRoofAssemblies,
  compileShellRoofAssembly,
} from './index';
import {
  createDefaultTestBuilding,
  setRoofAssemblies,
  syncShellToModel,
  updateBuildingDimensions,
  updateRoof,
} from './shell';
import { runDesignValidators } from './validation';
import type { RoofAssembly } from './roof-assembly';

function roofAssemblyAt(
  model: { roofAssemblies?: unknown[] },
  index = 0,
): RoofAssembly | undefined {
  return model.roofAssemblies?.[index] as RoofAssembly | undefined;
}

describe('roof assemblies', () => {
  it('compiles and renders existing gable shell roofs', () => {
    const model = updateRoof(createDefaultTestBuilding(), {
      type: 'gable',
      pitch: 6,
      overhang: 1.5,
      ridgeDirection: 'depth',
    });
    expect(model.roofAssemblies?.length).toBe(1);
    expect(model.roofAssemblies?.[0]?.source).toBe('shell');
    expect(model.roofAssemblies?.[0]?.planes.length).toBeGreaterThanOrEqual(2);
    const geom = buildBuildingGeometry(model);
    expect(geom.roofs.length).toBeGreaterThan(0);
    expect(geom.roofs.every((r) => r.positions.length >= 9)).toBe(true);
  });

  it('compiles and renders existing hip shell roofs', () => {
    const model = updateRoof(createDefaultTestBuilding(), {
      type: 'hip',
      pitch: 8,
      overhang: 1.5,
      ridgeDirection: 'depth',
    });
    expect(roofAssemblyAt(model)?.masses[0]?.generator?.type).toBe('hip');
    const geom = buildBuildingGeometry(model);
    expect(geom.roofs.length).toBeGreaterThan(0);
  });

  it('renders shed roofs', () => {
    const model = updateRoof(createDefaultTestBuilding(), {
      type: 'shed',
      pitch: 4,
      overhang: 1,
      highSide: 'rear',
    });
    expect(model.shell?.roof.type).toBe('shed');
    expect(roofAssemblyAt(model)?.planes.some((p) => p.role === 'shed')).toBe(
      true,
    );
    const geom = buildBuildingGeometry(model);
    expect(geom.roofs.length).toBeGreaterThan(0);
  });

  it('renders flat roofs', () => {
    const model = updateRoof(createDefaultTestBuilding(), {
      type: 'flat',
      pitch: 0,
      overhang: 0.5,
    });
    expect(roofAssemblyAt(model)?.planes[0]?.pitch).toBe(0);
    const geom = buildBuildingGeometry(model);
    expect(geom.roofs.length).toBeGreaterThan(0);
    const issues = runDesignValidators(model, []);
    expect(issues.filter((i) => i.code === 'ROOF_PITCH')).toEqual([]);
  });

  it('builds cross-gable with two masses and valley edges', () => {
    const base = createDefaultTestBuilding({ buildingType: 'home', name: 'Cross Gable' });
    const assembly = buildCrossGableAssembly({
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

    expect(assembly.source).toBe('composed');
    expect(assembly.masses.length).toBe(2);
    expect(assembly.edges.some((e) => e.kind === 'valley')).toBe(true);
    expect(assembly.planes.length).toBeGreaterThanOrEqual(6);

    const model = setRoofAssemblies(base, [assembly]);
    const geom = buildBuildingGeometry(model);
    expect(geom.roofs.length).toBeGreaterThan(0);

    const issues = runDesignValidators(model, []);
    const roofIssues = issues.filter((i) => i.code.startsWith('ROOF_'));
    expect(roofIssues).toEqual([]);
  });

  it('allows wall-height sync while preserving composed clipped roof', () => {
    const base = createDefaultTestBuilding();
    const assembly = buildCrossGableAssembly({
      eaveHeight: base.shell!.wallHeight,
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
    const withCross = setRoofAssemblies(base, [assembly]);
    const taller = updateBuildingDimensions(withCross, {
      wallHeight: base.shell!.wallHeight + 1,
    });
    expect(taller.roofAssemblies?.[0]?.source).toBe('composed');
    expect(roofAssemblyAt(taller)?.edges.some((e) => e.kind === 'valley')).toBe(
      true,
    );
  });

  it('round-trips roof assemblies through BuildingModelV1Schema (save/load)', () => {
    const base = createDefaultTestBuilding();
    const assembly = buildCrossGableAssembly({
      eaveHeight: 9,
      main: { width: 40, depth: 50, pitch: 6, ridgeDirection: 'depth' },
      wing: {
        origin: { x: 0, y: -10 },
        width: 20,
        depth: 18,
        pitch: 6,
        ridgeDirection: 'width',
      },
    });
    const model = setRoofAssemblies(base, [assembly]);
    const json = JSON.parse(JSON.stringify(model));
    const parsed = BuildingModelV1Schema.parse(json);
    expect(parsed.roofAssemblies?.length).toBe(1);
    expect(roofAssemblyAt(parsed)?.edges.some((e) => e.kind === 'valley')).toBe(
      true,
    );
    const remeshed = buildBuildingGeometry(parsed);
    expect(remeshed.roofs.length).toBeGreaterThan(0);
  });

  it('revision-style undo restores prior roof by swapping models', () => {
    const before = updateRoof(createDefaultTestBuilding(), {
      type: 'gable',
      pitch: 6,
    });
    const after = updateRoof(before, { type: 'hip', pitch: 10 });
    expect(after.shell?.roof.type).toBe('hip');
    // Undo = restore prior revision model
    const undone = BuildingModelV1Schema.parse(JSON.parse(JSON.stringify(before)));
    expect(undone.shell?.roof.type).toBe('gable');
    expect(undone.shell?.roof.pitch).toBe(6);
    expect(buildBuildingGeometry(undone).roofs.length).toBeGreaterThan(0);
  });

  it('stages setRoofAssemblies through design transactions', () => {
    const base = createDefaultTestBuilding();
    const assembly = compileShellRoofAssembly({
      width: base.shell!.width,
      depth: base.shell!.depth,
      wallHeight: base.shell!.wallHeight,
      roof: { type: 'shed', pitch: 3, overhang: 1, ridgeDirection: 'depth', highSide: 'rear' },
    });
    // Force composed so sync would preserve it
    const composed = { ...assembly, source: 'composed' as const, id: 'roof-shed-authored' };
    const result = applyDesignOperations(base, [
      { op: 'setRoofAssemblies', assemblies: [composed] },
    ]);
    expect(result.roofAssemblies?.[0]?.id).toBe('roof-shed-authored');
    expect(buildBuildingGeometry(result).roofs.length).toBeGreaterThan(0);
  });

  it('migrates legacy models without roofAssemblies', () => {
    const legacy = createDefaultTestBuilding();
    const stripped = {
      ...legacy,
      roofAssemblies: [],
    };
    const ensured = ensureRoofAssemblies(stripped);
    expect(ensured.length).toBe(1);
    expect(ensured[0]?.source).toBe('shell');
    const hydrated = syncShellToModel(stripped, stripped.shell!);
    expect(hydrated.roofAssemblies?.length).toBe(1);
  });
});
