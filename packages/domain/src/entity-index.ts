import type { BuildingModelV1 } from './building-model';
import type { DesignEntity, EntityType } from './entities';

export function getEntity(model: BuildingModelV1, id: string): DesignEntity | undefined {
  return (model.entities ?? []).find((e) => e.id === id);
}

export function listEntitiesByType(model: BuildingModelV1, type: EntityType): DesignEntity[] {
  return (model.entities ?? []).filter((e) => e.type === type);
}

export function listEntities(model: BuildingModelV1): DesignEntity[] {
  return model.entities ?? [];
}

/** Resolve a UI/3D selection id to a design entity (handles legacy aliases). */
export function resolveSelectedEntity(
  model: BuildingModelV1,
  selectedEntityId: string | null | undefined,
): DesignEntity | null {
  if (!selectedEntityId) return null;
  const direct = getEntity(model, selectedEntityId);
  if (direct) return direct;

  // Roof surface meshes may use plane ids; also accept assembly id
  const planes = listEntitiesByType(model, 'roofPlane');
  const plane = planes.find(
    (p) =>
      p.id === selectedEntityId ||
      p.properties.surfaceId === selectedEntityId ||
      (Array.isArray(p.meta?.aliases) &&
        (p.meta!.aliases as string[]).includes(selectedEntityId)),
  );
  if (plane) return plane;

  // Typed-array fallbacks before entities were hydrated
  const wall = model.walls.find((w) => w.id === selectedEntityId);
  if (wall) {
    return {
      id: wall.id,
      type: 'exteriorWall',
      levelId: wall.levelId,
      geometry: {
        start: wall.start,
        end: wall.end,
        thickness: wall.thickness,
        height: wall.height,
      },
      properties: {},
      materialId: wall.materialId,
    };
  }
  const opening = model.openings.find((o) => o.id === selectedEntityId);
  if (opening) {
    return {
      id: opening.id,
      type:
        opening.kind === 'window'
          ? 'window'
          : opening.kind === 'garageDoor'
            ? 'garageDoor'
            : opening.kind === 'door'
              ? 'exteriorDoor'
              : 'opening',
      parentId: opening.wallId,
      geometry: {
        width: opening.width,
        height: opening.height,
        sillHeight: opening.sillHeight,
        t: opening.t,
      },
      properties: { kind: opening.kind },
    };
  }
  const slab = model.slabs.find((s) => s.id === selectedEntityId);
  if (slab) {
    return {
      id: slab.id,
      type: 'floorSlab',
      levelId: slab.levelId,
      geometry: { polygon: slab.polygon, thickness: slab.thickness },
      properties: {},
      materialId: slab.materialId,
    };
  }
  const roof = model.roofs.find((r) => r.id === selectedEntityId);
  if (roof) {
    return {
      id: roof.id,
      type: 'roofAssembly',
      levelId: roof.levelId,
      geometry: {
        footprint: roof.footprint,
        pitch: roof.pitch,
        overhang: roof.overhang,
        ridgeDirection: roof.ridgeDirection,
      },
      properties: { kind: roof.kind },
      materialId: roof.materialId,
    };
  }

  return null;
}

export function summarizeEntity(entity: DesignEntity) {
  return {
    id: entity.id,
    type: entity.type,
    parentId: entity.parentId,
    levelId: entity.levelId,
    materialId: entity.materialId,
    geometry: entity.geometry,
    properties: entity.properties,
  };
}
