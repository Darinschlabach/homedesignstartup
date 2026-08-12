import type { BuildingModelV1 } from './building-model';
import { DesignEntitySchema, openingEntityType, type DesignEntity } from './entities';
import { generateRoofEntitiesFromShell } from './roof-entities';
import { generateRoofEntitiesFromAssemblies } from './roof-entities-from-assembly';
import {
  ensureRoofAssemblies,
  RoofAssemblySchema,
  type RoofAssembly,
} from './roof-assembly';
import { extractShellFromModel, WALL_ID_TO_FACE, isShellWallId } from './shell';
import { isInteriorObjectType } from './project-model';

const REGENERATED_TYPES = new Set([
  'level',
  'space',
  'exteriorWall',
  'interiorWall',
  'floorSlab',
  'floorOpening',
  'stair',
  'shell',
  'roofAssembly',
  'roofPlane',
  'ridge',
  'window',
  'exteriorDoor',
  'garageDoor',
  'opening',
  'column',
  'beam',
]);

/**
 * Project typed arrays + shell into entities[].
 * Preserves agent-created interiors and other non-regenerated entities.
 * Roof entities are hydrated from durable roofAssemblies (migrated from shell when empty).
 */
export function hydrateEntitiesFromModel(model: BuildingModelV1): BuildingModelV1 {
  const entities: DesignEntity[] = [];
  const shell = extractShellFromModel(model);
  const levelId = model.levels[0]?.id ?? 'level-1';

  const assemblies: RoofAssembly[] = ensureRoofAssemblies(model).map((a) =>
    RoofAssemblySchema.parse(a),
  );

  const preserved = (model.entities ?? []).filter((e) => {
    if (isInteriorObjectType(String(e.type))) return true;
    if (!REGENERATED_TYPES.has(String(e.type))) return true;
    return false;
  });

  for (const level of model.levels) {
    entities.push({
      id: level.id,
      type: 'level',
      geometry: { elevation: level.elevation, height: level.height },
      properties: { name: level.name },
    });
  }

  for (const space of model.spaces) {
    entities.push({
      id: space.id,
      type: 'space',
      levelId: space.levelId,
      geometry: { polygon: space.polygon },
      properties: { name: space.name, tags: space.tags },
    });
  }

  for (const wall of model.walls) {
    const face = WALL_ID_TO_FACE[wall.id];
    const isShell = isShellWallId(wall.id);
    entities.push({
      id: wall.id,
      type: isShell || face ? 'exteriorWall' : 'interiorWall',
      levelId: wall.levelId,
      geometry: {
        start: wall.start,
        end: wall.end,
        thickness: wall.thickness,
        height: wall.height ?? model.levels.find((l) => l.id === wall.levelId)?.height,
      },
      properties: face
        ? { face, exterior: true }
        : { exterior: isShell, kind: isShell ? 'exterior' : 'interior' },
      materialId: wall.materialId,
    });
  }

  for (const opening of model.openings) {
    const shellOpening = shell?.openings.find((o) => o.id === opening.id);
    entities.push({
      id: opening.id,
      type: openingEntityType(opening.kind),
      parentId: opening.wallId,
      levelId,
      geometry: {
        width: opening.width,
        height: opening.height,
        sillHeight: opening.sillHeight,
        t: opening.t,
        offset: shellOpening?.offset,
      },
      properties: {
        kind: opening.kind,
        wall: shellOpening?.wall ?? WALL_ID_TO_FACE[opening.wallId],
      },
    });
  }

  for (const slab of model.slabs) {
    entities.push({
      id: slab.id,
      type: 'floorSlab',
      levelId: slab.levelId,
      geometry: { polygon: slab.polygon, thickness: slab.thickness },
      properties: {},
      materialId: slab.materialId,
    });
  }

  for (const opening of model.floorOpenings ?? []) {
    entities.push({
      id: opening.id,
      type: 'floorOpening',
      levelId: opening.levelId,
      parentId: opening.slabId,
      geometry: { polygon: opening.polygon },
      properties: {
        stairId: opening.stairId,
        label: opening.label,
      },
    });
  }

  for (const stair of model.stairs ?? []) {
    entities.push({
      id: stair.id,
      type: 'stair',
      levelId: stair.fromLevelId,
      geometry: {
        origin: stair.origin,
        directionDeg: stair.directionDeg,
        width: stair.width,
        type: stair.type,
      },
      properties: {
        name: stair.name,
        fromLevelId: stair.fromLevelId,
        toLevelId: stair.toLevelId,
        floorOpeningId: stair.floorOpeningId,
        turn: stair.turn,
        availableRun: stair.availableRun,
        targetTreadDepth: stair.targetTreadDepth,
        maxRiserHeight: stair.maxRiserHeight,
      },
      materialId: stair.materialId,
    });
  }

  for (const member of model.structure) {
    entities.push({
      id: member.id,
      type: member.kind === 'post' ? 'column' : member.kind === 'beam' ? 'beam' : 'beam',
      levelId: member.levelId,
      geometry: {
        start: member.start,
        end: member.end,
        sectionWidth: member.sectionWidth,
        sectionDepth: member.sectionDepth,
      },
      properties: { kind: member.kind, label: member.label },
    });
  }

  if (shell) {
    entities.push({
      id: 'shell-1',
      type: 'shell',
      levelId,
      geometry: {
        width: shell.width,
        depth: shell.depth,
        wallHeight: shell.wallHeight,
        wallThickness: shell.wallThickness,
      },
      properties: { roof: shell.roof },
    });
  }

  if (assemblies.length > 0) {
    entities.push(...generateRoofEntitiesFromAssemblies(assemblies));
  } else if (shell) {
    entities.push(
      ...generateRoofEntitiesFromShell(shell, {
        roofAssemblyId: model.roofs[0]?.id ?? 'roof-1',
        levelId,
        materialId: model.roofs[0]?.materialId ?? 'mat-roof',
      }),
    );
  } else {
    for (const roof of model.roofs) {
      entities.push({
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
      });
    }
  }

  const parsed = [...entities, ...preserved].map((e) => DesignEntitySchema.parse(e));
  const byId = new Map<string, DesignEntity>();
  for (const e of parsed) byId.set(e.id, e);
  for (const e of preserved) {
    if (!entities.some((r) => r.id === e.id)) byId.set(e.id, DesignEntitySchema.parse(e));
  }

  return {
    ...model,
    roofAssemblies: assemblies,
    entities: [...byId.values()],
  };
}

export function ensureEntities(model: BuildingModelV1): BuildingModelV1 {
  if (model.entities && model.entities.length > 0) return model;
  return hydrateEntitiesFromModel(model);
}
