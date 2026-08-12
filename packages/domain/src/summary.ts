import type { BuildingModelV1 } from './building-model';
import { extractShellFromModel, WALL_ID_TO_FACE } from './shell';
import { listEntitiesByType, resolveSelectedEntity, summarizeEntity } from './entity-index';

export interface BuildingSummary {
  name: string;
  buildingType: string;
  units: string;
  stories: number;
  levelCount: number;
  wallCount: number;
  spaceCount: number;
  openingCount: number;
  roofCount: number;
  structureCount: number;
  entityCount: number;
  constraintTexts: string[];
  approximateFootprintSqFt: number;
  spaces: Array<{ id: string; name: string; areaApprox: number }>;
  shell?: {
    width: number;
    depth: number;
    wallHeight: number;
    roof: {
      type: string;
      pitch: number;
      overhang: number;
      ridgeDirection: string;
    };
  };
  openings: Array<{
    id: string;
    type: string;
    wall: string;
    width: number;
    height: number;
    offset: number;
    sillHeight: number;
  }>;
  roofPlanes: Array<{ id: string; pitch?: unknown; role?: unknown; face?: unknown }>;
  protectedEntityIds: string[];
  selected?: ReturnType<typeof summarizeEntity> | null;
}

function polygonArea(points: Array<{ x: number; y: number }>): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

export function summarizeBuilding(
  model: BuildingModelV1,
  selectedEntityId?: string | null,
): BuildingSummary {
  const spaces = model.spaces.map((s) => ({
    id: s.id,
    name: s.name,
    areaApprox: Math.round(polygonArea(s.polygon) * 10) / 10,
  }));

  const footprint =
    model.slabs[0] != null
      ? polygonArea(model.slabs[0].polygon)
      : spaces.reduce((acc, s) => acc + s.areaApprox, 0);

  const shell = extractShellFromModel(model);

  const openings =
    shell?.openings.map((o) => ({
      id: o.id,
      type: o.type,
      wall: o.wall,
      width: o.width,
      height: o.height,
      offset: o.offset,
      sillHeight: o.sillHeight,
    })) ??
    model.openings.map((o) => ({
      id: o.id,
      type: o.kind,
      wall: WALL_ID_TO_FACE[o.wallId] ?? o.wallId,
      width: o.width,
      height: o.height,
      offset: 0,
      sillHeight: o.sillHeight,
    }));

  const selected = resolveSelectedEntity(model, selectedEntityId);

  return {
    name: model.meta.name,
    buildingType: model.meta.buildingType,
    units: model.meta.units,
    stories: model.meta.stories,
    levelCount: model.levels.length,
    wallCount: model.walls.length,
    spaceCount: model.spaces.length,
    openingCount: openings.length,
    roofCount: model.roofs.length,
    structureCount: model.structure.length,
    entityCount: model.entities?.length ?? 0,
    constraintTexts: model.constraints.map((c) => c.text),
    approximateFootprintSqFt: Math.round(footprint * 10) / 10,
    spaces,
    shell: shell
      ? {
          width: shell.width,
          depth: shell.depth,
          wallHeight: shell.wallHeight,
          roof: {
            type: shell.roof.type,
            pitch: shell.roof.pitch,
            overhang: shell.roof.overhang,
            ridgeDirection: shell.roof.ridgeDirection,
          },
        }
      : undefined,
    openings,
    roofPlanes: listEntitiesByType(model, 'roofPlane').map((p) => ({
      id: p.id,
      pitch: p.geometry.pitch,
      role: p.properties.role ?? p.geometry.role,
      face: p.properties.face,
    })),
    protectedEntityIds: model.protectedEntityIds ?? [],
    selected: selected ? summarizeEntity(selected) : null,
  };
}
