import { describe, expect, it } from 'vitest';
import {
  addConvenienceOpening,
  applyAndValidate,
  applyDesignOperations,
  buildBuildingGeometry,
  buildFloorPlanView,
  buildConstructionDocuments,
  buildSceneMeshes,
  createBayBuilding,
  createDefaultTestBuilding,
  createRectangularShell,
  summarizeBuilding,
  updateBuildingDimensions,
  updateRoof,
  validateModel,
} from './index';

describe('BuildingModelV1', () => {
  it('creates a rectangular home shell with parametric shell', () => {
    const model = createRectangularShell({
      buildingType: 'home',
      width: 40,
      depth: 30,
    });
    expect(model.walls).toHaveLength(4);
    expect(model.shell?.width).toBe(40);
    expect(model.meta.version).toBe(1);
    const summary = summarizeBuilding(model);
    expect(summary.approximateFootprintSqFt).toBe(1200);
  });

  it('updates dimensions through shell sync', () => {
    const model = createDefaultTestBuilding();
    const next = updateBuildingDimensions(model, { width: 48, depth: 72, wallHeight: 10 });
    expect(next.shell?.width).toBe(48);
    expect(next.shell?.depth).toBe(72);
    expect(next.shell?.wallHeight).toBe(10);
    expect(next.levels[0]?.height).toBe(10);
    const geom = buildBuildingGeometry(next);
    expect(geom.walls[0]?.height).toBe(10);
  });

  it('updates roof pitch through shell sync', () => {
    const model = createDefaultTestBuilding();
    const next = updateRoof(model, { pitch: 8, type: 'hip' });
    expect(next.shell?.roof.pitch).toBe(8);
    expect(next.shell?.roof.type).toBe('hip');
    expect(next.roofs[0]?.pitch).toBe(8);
    expect(buildBuildingGeometry(next).roofs.length).toBeGreaterThan(0);
  });

  it('applies high-level dimension mutation', () => {
    const model = createDefaultTestBuilding();
    const next = applyAndValidate(model, [
      { op: 'updateBuildingDimensions', width: 36, depth: 48 },
    ]);
    expect(next.shell?.width).toBe(36);
  });

  it('builds barn bay structure', () => {
    const barn = createBayBuilding({
      buildingType: 'barn',
      width: 40,
      depth: 60,
      bayCount: 4,
    });
    expect(barn.structure.length).toBeGreaterThan(0);
    expect(buildSceneMeshes(barn).length).toBeGreaterThan(0);
  });

  it('produces floor plan and CD set', () => {
    const model = createRectangularShell({ buildingType: 'home', width: 32, depth: 24 });
    const plan = buildFloorPlanView(model);
    expect(plan.paths.some((p) => p.kind === 'wall')).toBe(true);
    const docs = buildConstructionDocuments(model);
    expect(docs.sheets.length).toBeGreaterThanOrEqual(3);
    expect(docs.advisories.some((a) => a.code === 'NOT_STAMPED')).toBe(true);
  });

  it('default test building includes openings', () => {
    const model = createDefaultTestBuilding();
    expect(model.shell?.openings.length).toBe(4);
    expect(buildBuildingGeometry(model).openings.length).toBe(4);
  });

  it('hydrates entities from shell including roof planes', () => {
    const model = createDefaultTestBuilding();
    expect(model.entities?.length).toBeGreaterThan(0);
    expect(model.entities?.some((e) => e.type === 'roofPlane')).toBe(true);
    expect(model.entities?.some((e) => e.type === 'exteriorWall')).toBe(true);
    expect(model.protectedEntityIds ?? []).toEqual([]);
  });

  it('applies design transaction to steepen roof', () => {
    const model = createDefaultTestBuilding();
    const next = applyDesignOperations(model, [
      { op: 'updateRoof', patch: { pitch: 10 } },
    ]);
    expect(next.shell?.roof.pitch).toBe(10);
    expect(next.entities?.find((e) => e.type === 'roofAssembly')?.geometry.pitch).toBe(10);
  });

  it('protects footprint from width changes', () => {
    const model = createDefaultTestBuilding();
    const protectedModel = applyDesignOperations(model, [{ op: 'protectFootprint', protect: true }]);
    expect(() =>
      applyDesignOperations(protectedModel, [
        { op: 'updateBuildingDimensions', width: 80 },
      ]),
    ).toThrow();
  });

  it('creates interior cabinet via design transaction and preserves it across shell sync', () => {
    const model = createDefaultTestBuilding();
    const withCabinet = applyDesignOperations(model, [
      {
        op: 'createObject',
        object: { type: 'baseCabinet', x: 0, z: -10, width: 3, depth: 2, height: 3 },
      },
    ]);
    expect(withCabinet.entities?.some((e) => e.type === 'baseCabinet')).toBe(true);
    const resized = updateBuildingDimensions(withCabinet, { width: 42 });
    expect(resized.entities?.some((e) => e.type === 'baseCabinet')).toBe(true);
    expect(buildBuildingGeometry(resized).placedObjects.length).toBeGreaterThan(0);
  });

  it('creates a new material and applies it to a wall with visible geometry color', () => {
    const model = createDefaultTestBuilding();
    const withMat = applyDesignOperations(model, [
      {
        op: 'createMaterial',
        material: {
          id: 'mat-warm-clapboard',
          name: 'Warm Clapboard',
          category: 'wall',
          color: '#B8A48A',
          roughness: 0.9,
          metalness: 0,
        },
      },
    ]);
    expect(withMat.materials.some((m) => m.id === 'mat-warm-clapboard')).toBe(true);

    const applied = applyDesignOperations(withMat, [
      {
        op: 'setMaterial',
        entityId: 'wall-front',
        materialId: 'mat-warm-clapboard',
      },
    ]);
    expect(applied.walls.find((w) => w.id === 'wall-front')?.materialId).toBe(
      'mat-warm-clapboard',
    );
    const geom = buildBuildingGeometry(applied);
    expect(geom.walls.find((w) => w.id === 'wall-front')?.color).toBe('#B8A48A');
    expect(geom.walls.find((w) => w.id === 'wall-rear')?.color).not.toBe('#B8A48A');
  });
});
