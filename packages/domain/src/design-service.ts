import type { BuildingModelV1 } from './building-model';
import { BuildingModelV1Schema, MaterialSchema } from './building-model';
import { DesignEntitySchema, type DesignEntity } from './entities';
import { getEntity, listEntities, listEntitiesByType, resolveSelectedEntity, summarizeEntity } from './entity-index';
import { hydrateEntitiesFromModel, ensureEntities } from './hydrate-entities';
import type { DesignOperation, DesignTransaction } from './operations';
import { DesignTransactionSchema } from './operations';
import { runDesignValidators, type ValidationIssue } from './validation';
import {
  addOpening,
  composedRoofFootprintConflict,
  extractShellFromModel,
  setRoofAssemblies,
  syncShellToModel,
  updateBuildingDimensions,
  updateRoof,
  updateOpening,
  removeOpening,
  WALL_FACE_IDS,
  isShellWallId,
} from './shell';
import { RoofAssemblySchema } from './roof-assembly';
import {
  createRoofMass,
  deleteRoofMass,
  updateRoofMass,
} from './roof-mass-ops';
import { RoofIntersectionError } from './geometry/roof-intersection';
import {
  createLevel,
  deleteLevel,
  LevelOpsError,
  updateLevel,
} from './level-ops';
import {
  clearLevelFootprint,
  LevelFootprintError,
  setLevelFootprint,
  updateLevelFootprint,
} from './level-footprint-ops';
import {
  createStair,
  deleteStair,
  StairOpsError,
  updateStair,
} from './stair-ops';
import { RoofMassGeneratorSchema } from './roof-assembly';
import { addConvenienceOpening, newOpeningId } from './opening-helpers';
import { ShellOpeningSchema } from './shell';
import { checkModelIntegrity } from './integrity';
import { generateMaterialId } from './material-capabilities';
import type { Space, Wall } from './building-model';

export class DesignServiceError extends Error {
  constructor(
    message: string,
    readonly issues: ValidationIssue[],
  ) {
    super(message);
    this.name = 'DesignServiceError';
  }
}

export interface DesignQueryResult {
  meta: BuildingModelV1['meta'];
  shell?: BuildingModelV1['shell'];
  levels: BuildingModelV1['levels'];
  spaces: Array<{ id: string; name: string }>;
  walls: Array<{ id: string; face?: unknown; lengthApprox?: number }>;
  openings: DesignEntity[];
  roofPlanes: DesignEntity[];
  roofAssembly?: DesignEntity;
  materials: BuildingModelV1['materials'];
  constraints: BuildingModelV1['constraints'];
  protectedEntityIds: string[];
  selected?: ReturnType<typeof summarizeEntity> | null;
  entityCount: number;
}

export function queryDesign(
  model: BuildingModelV1,
  selectedEntityId?: string | null,
): DesignQueryResult {
  const m = ensureEntities(model);
  const shell = extractShellFromModel(m);
  const selected = resolveSelectedEntity(m, selectedEntityId);

  return {
    meta: m.meta,
    shell: m.shell ?? shell ?? undefined,
    levels: m.levels,
    spaces: m.spaces.map((s) => ({ id: s.id, name: s.name })),
    walls: m.walls.map((w) => {
      const len = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
      const ent = getEntity(m, w.id);
      return {
        id: w.id,
        face: ent?.properties.face,
        lengthApprox: Math.round(len * 100) / 100,
      };
    }),
    openings: listEntities(m).filter((e) =>
      ['window', 'exteriorDoor', 'garageDoor', 'opening'].includes(String(e.type)),
    ),
    roofPlanes: listEntitiesByType(m, 'roofPlane'),
    roofAssembly: listEntitiesByType(m, 'roofAssembly')[0],
    materials: m.materials,
    constraints: m.constraints,
    protectedEntityIds: m.protectedEntityIds ?? [],
    selected: selected ? summarizeEntity(selected) : null,
    entityCount: (m.entities ?? []).length,
  };
}

function upsertEntity(entities: DesignEntity[], entity: DesignEntity): DesignEntity[] {
  const idx = entities.findIndex((e) => e.id === entity.id);
  if (idx === -1) return [...entities, entity];
  const next = [...entities];
  next[idx] = entity;
  return next;
}

function applyOne(model: BuildingModelV1, op: DesignOperation): BuildingModelV1 {
  switch (op.op) {
    case 'queryDesign':
      return model;
    case 'createEntity': {
      const entity = DesignEntitySchema.parse(op.entity);
      return {
        ...model,
        entities: upsertEntity(model.entities ?? [], entity),
      };
    }
    case 'updateEntity': {
      const entities = (model.entities ?? []).map((e) => {
        if (e.id !== op.entityId) return e;
        return DesignEntitySchema.parse({
          ...e,
          geometry: op.patch.geometry ? { ...e.geometry, ...op.patch.geometry } : e.geometry,
          properties: op.patch.properties
            ? { ...e.properties, ...op.patch.properties }
            : e.properties,
          materialId:
            op.patch.materialId === null
              ? undefined
              : (op.patch.materialId ?? e.materialId),
          parentId:
            op.patch.parentId === null ? undefined : (op.patch.parentId ?? e.parentId),
          levelId: op.patch.levelId === null ? undefined : (op.patch.levelId ?? e.levelId),
          meta: op.patch.meta ? { ...e.meta, ...op.patch.meta } : e.meta,
        });
      });
      let next: BuildingModelV1 = { ...model, entities };

      // Mirror pitch changes onto shell / roof assembly when editing roof planes
      const ent = entities.find((e) => e.id === op.entityId);
      if (ent && (ent.type === 'roofPlane' || ent.type === 'roofAssembly')) {
        const pitch =
          typeof op.patch.geometry?.pitch === 'number'
            ? op.patch.geometry.pitch
            : typeof ent.geometry.pitch === 'number'
              ? ent.geometry.pitch
              : undefined;
        if (pitch != null) {
          next = updateRoof(next, { pitch });
        }
      }

      // Mirror opening geometry onto shell openings
      if (
        ent &&
        ['window', 'exteriorDoor', 'garageDoor', 'opening'].includes(String(ent.type))
      ) {
        const width =
          typeof op.patch.geometry?.width === 'number'
            ? op.patch.geometry.width
            : undefined;
        const height =
          typeof op.patch.geometry?.height === 'number'
            ? op.patch.geometry.height
            : undefined;
        const offset =
          typeof op.patch.geometry?.offset === 'number'
            ? op.patch.geometry.offset
            : undefined;
        const sillHeight =
          typeof op.patch.geometry?.sillHeight === 'number'
            ? op.patch.geometry.sillHeight
            : undefined;
        next = updateOpening(next, op.entityId, {
          ...(width != null ? { width } : {}),
          ...(height != null ? { height } : {}),
          ...(offset != null ? { offset } : {}),
          ...(sillHeight != null ? { sillHeight } : {}),
        });
      }

      return next;
    }
    case 'moveEntity': {
      const ent = getEntity(model, op.entityId);
      if (!ent) return model;
      if (
        ['window', 'exteriorDoor', 'garageDoor', 'opening'].includes(String(ent.type)) &&
        op.delta.offset != null
      ) {
        const current = Number(ent.geometry.offset ?? 0);
        return updateOpening(model, op.entityId, {
          offset: Math.max(0, current + op.delta.offset),
        });
      }
      const entities = (model.entities ?? []).map((e) => {
        if (e.id !== op.entityId) return e;
        const geometry = { ...e.geometry };
        if (op.delta.offset != null && typeof geometry.offset === 'number') {
          geometry.offset = Math.max(0, geometry.offset + op.delta.offset);
        }
        if (op.delta.x != null) {
          geometry.x = Number(geometry.x ?? 0) + op.delta.x;
        }
        if (op.delta.y != null) {
          geometry.y = Number(geometry.y ?? 0) + op.delta.y;
        }
        if (op.delta.z != null) {
          geometry.z = Number(geometry.z ?? 0) + op.delta.z;
        }
        return { ...e, geometry };
      });
      return { ...model, entities };
    }
    case 'resizeEntity': {
      const ent = getEntity(model, op.entityId);
      if (!ent) return model;
      if (ent.type === 'shell' || op.entityId === 'shell-1') {
        return updateBuildingDimensions(model, {
          width: op.dimensions.width,
          depth: op.dimensions.depth,
          wallHeight: op.dimensions.wallHeight ?? op.dimensions.height,
        });
      }
      if (['window', 'exteriorDoor', 'garageDoor', 'opening'].includes(String(ent.type))) {
        return updateOpening(model, op.entityId, {
          width: op.dimensions.width,
          height: op.dimensions.height,
          sillHeight: op.dimensions.sillHeight,
        });
      }
      if (ent.type === 'roofPlane' || ent.type === 'roofAssembly') {
        if (op.dimensions.pitch != null) {
          return updateRoof(model, { pitch: op.dimensions.pitch });
        }
      }
      // Exterior wall length via shell width/depth when face known
      if (ent.type === 'exteriorWall' && op.dimensions.length != null) {
        const face = ent.properties.face;
        const shell = extractShellFromModel(model);
        if (shell && (face === 'front' || face === 'rear')) {
          return updateBuildingDimensions(model, { width: op.dimensions.length });
        }
        if (shell && (face === 'left' || face === 'right')) {
          return updateBuildingDimensions(model, { depth: op.dimensions.length });
        }
      }
      return applyOne(model, {
        op: 'updateEntity',
        entityId: op.entityId,
        patch: { geometry: { ...ent.geometry, ...op.dimensions } },
      });
    }
    case 'deleteEntity': {
      if (['window', 'exteriorDoor', 'garageDoor', 'opening'].includes(
        String(getEntity(model, op.entityId)?.type),
      )) {
        return removeOpening(model, op.entityId);
      }
      const wall = model.walls.find((w) => w.id === op.entityId);
      if (wall) {
        return applyOne(model, { op: 'deleteWall', wallId: op.entityId });
      }
      const space = model.spaces.find((s) => s.id === op.entityId);
      if (space) {
        return applyOne(model, { op: 'deleteSpace', spaceId: op.entityId });
      }
      return {
        ...model,
        entities: (model.entities ?? []).filter((e) => e.id !== op.entityId),
      };
    }
    case 'duplicateEntity': {
      const ent = getEntity(model, op.entityId);
      if (!ent) return model;
      const newId = op.newId ?? `${ent.id}-copy-${Date.now().toString(36)}`;
      if (['window', 'exteriorDoor', 'garageDoor'].includes(String(ent.type))) {
        const type =
          ent.type === 'window'
            ? 'window'
            : ent.type === 'garageDoor'
              ? 'garageDoor'
              : 'door';
        const wall = (ent.properties.wall as 'front' | 'rear' | 'left' | 'right') ?? 'front';
        return addConvenienceOpening(model, {
          type,
          wall,
          width: Number(ent.geometry.width ?? 3),
          height: Number(ent.geometry.height ?? 7),
          sillHeight: Number(ent.geometry.sillHeight ?? 0),
          offset: Number(ent.geometry.offset ?? 0) + Number(ent.geometry.width ?? 3) + 1,
          id: newId,
        });
      }
      const copy = DesignEntitySchema.parse({
        ...ent,
        id: newId,
        geometry: {
          ...ent.geometry,
          x: Number(ent.geometry.x ?? 0) + Number(ent.geometry.width ?? 2) + 0.5,
        },
      });
      return { ...model, entities: [...(model.entities ?? []), copy] };
    }
    case 'setMaterial': {
      const materialExists = model.materials.some((m) => m.id === op.materialId);
      if (!materialExists) {
        throw new DesignServiceError('Unknown material', [
          {
            code: 'UNKNOWN_MATERIAL',
            message: `Material not found: ${op.materialId}`,
            entityId: op.entityId,
          },
        ]);
      }

      let materials = model.materials;
      if (op.finish) {
        materials = model.materials.map((m) => {
          if (m.id !== op.materialId) return m;
          return {
            ...m,
            ...(op.finish!.color != null ? { color: op.finish!.color } : {}),
            ...(op.finish!.roughness != null
              ? { roughness: op.finish!.roughness }
              : {}),
            ...(op.finish!.metalness != null
              ? { metalness: op.finish!.metalness }
              : {}),
          };
        });
      }

      const entities = (model.entities ?? []).map((e) =>
        e.id === op.entityId ? { ...e, materialId: op.materialId } : e,
      );

      const target = entities.find((e) => e.id === op.entityId);
      const isRoofTarget =
        target?.type === 'roofAssembly' ||
        target?.type === 'roofPlane' ||
        model.roofs.some((r) => r.id === op.entityId);

      return {
        ...model,
        materials,
        entities,
        walls: model.walls.map((w) =>
          w.id === op.entityId ? { ...w, materialId: op.materialId } : w,
        ),
        roofs: isRoofTarget
          ? model.roofs.map((r) => ({ ...r, materialId: op.materialId }))
          : model.roofs.map((r) =>
              r.id === op.entityId ? { ...r, materialId: op.materialId } : r,
            ),
        slabs: model.slabs.map((s) =>
          s.id === op.entityId ? { ...s, materialId: op.materialId } : s,
        ),
      };
    }
    case 'createMaterial': {
      const requestedId = op.material.id?.trim();
      const id = requestedId && requestedId.length > 0
        ? requestedId
        : generateMaterialId(op.material.name);
      if (model.materials.some((m) => m.id === id)) {
        throw new DesignServiceError('Material already exists', [
          {
            code: 'MATERIAL_EXISTS',
            message: `Material id already exists: ${id}`,
          },
        ]);
      }
      const material = MaterialSchema.parse({
        id,
        name: op.material.name,
        category: op.material.category,
        color: op.material.color,
        roughness: op.material.roughness ?? 0.7,
        metalness: op.material.metalness ?? 0,
      });
      return {
        ...model,
        materials: [...model.materials, material],
      };
    }
    case 'createWall': {
      const id = op.wall.id ?? `wall-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const levelId = op.wall.levelId ?? model.levels[0]?.id ?? 'level-1';
      const kind =
        op.wall.kind ??
        (isShellWallId(id) ? 'exterior' : 'interior');
      const thickness =
        op.wall.thickness ??
        extractShellFromModel(model)?.wallThickness ??
        0.5;
      const height =
        op.wall.height ??
        model.levels.find((l) => l.id === levelId)?.height ??
        extractShellFromModel(model)?.wallHeight;
      const wall: Wall = {
        id,
        levelId,
        start: op.wall.start,
        end: op.wall.end,
        thickness,
        height,
        materialId: op.wall.materialId,
      };
      const entity: DesignEntity = {
        id,
        type: kind === 'exterior' ? 'exteriorWall' : 'interiorWall',
        levelId,
        geometry: {
          start: wall.start,
          end: wall.end,
          thickness: wall.thickness,
          height: wall.height,
        },
        properties: {
          exterior: kind === 'exterior',
          kind,
        },
        materialId: wall.materialId,
      };
      return {
        ...model,
        walls: [...model.walls.filter((w) => w.id !== id), wall],
        entities: upsertEntity(model.entities ?? [], entity),
      };
    }
    case 'updateWall': {
      const existing = model.walls.find((w) => w.id === op.wallId);
      if (!existing) return model;
      if (
        isShellWallId(op.wallId) &&
        (op.patch.start != null || op.patch.end != null)
      ) {
        throw new DesignServiceError('Cannot move shell footprint wall endpoints', [
          {
            code: 'SHELL_WALL',
            message: `Wall ${op.wallId} is part of the parametric shell footprint. Endpoint edits would desync the shell — use footprint/dimension tools later, or edit interior walls only.`,
            entityId: op.wallId,
          },
        ]);
      }
      const nextWall: Wall = {
        ...existing,
        ...(op.patch.start ? { start: op.patch.start } : {}),
        ...(op.patch.end ? { end: op.patch.end } : {}),
        ...(op.patch.thickness != null ? { thickness: op.patch.thickness } : {}),
        ...(op.patch.height != null ? { height: op.patch.height } : {}),
        ...(op.patch.levelId != null ? { levelId: op.patch.levelId } : {}),
        ...(op.patch.materialId !== undefined
          ? { materialId: op.patch.materialId ?? undefined }
          : {}),
      };
      const isShell = isShellWallId(op.wallId);
      const entityType = isShell ? 'exteriorWall' : 'interiorWall';
      const priorEntity = getEntity(model, op.wallId);
      const entity: DesignEntity = {
        id: op.wallId,
        type: entityType,
        levelId: nextWall.levelId,
        geometry: {
          start: nextWall.start,
          end: nextWall.end,
          thickness: nextWall.thickness,
          height: nextWall.height,
        },
        properties: {
          ...(priorEntity?.properties ?? {}),
          exterior: isShell,
          kind: isShell ? 'exterior' : 'interior',
        },
        materialId: nextWall.materialId,
      };
      // Hosted openings stay by wallId + parametric t; geometry length may change —
      // shell openings are remapped on sync; freeform openings keep t.
      return {
        ...model,
        walls: model.walls.map((w) => (w.id === op.wallId ? nextWall : w)),
        entities: upsertEntity(model.entities ?? [], entity),
      };
    }
    case 'deleteWall': {
      if (isShellWallId(op.wallId)) {
        throw new DesignServiceError('Cannot delete shell footprint wall', [
          {
            code: 'SHELL_WALL',
            message: `Wall ${op.wallId} is part of the parametric shell footprint and cannot be deleted with deleteWall`,
            entityId: op.wallId,
          },
        ]);
      }
      const hosted = model.openings.filter((o) => o.wallId === op.wallId);
      if (hosted.length > 0) {
        throw new DesignServiceError('Wall hosts openings', [
          {
            code: 'HOSTED_OPENINGS',
            message: `Cannot delete wall ${op.wallId}: ${hosted.length} hosted opening(s) would be orphaned (${hosted.map((o) => o.id).join(', ')}). Remove or rehost openings first.`,
            entityId: op.wallId,
          },
        ]);
      }
      const hostedEntities = (model.entities ?? []).filter(
        (e) =>
          e.parentId === op.wallId &&
          ['window', 'exteriorDoor', 'garageDoor', 'opening', 'door'].includes(
            String(e.type),
          ),
      );
      if (hostedEntities.length > 0) {
        throw new DesignServiceError('Wall hosts openings', [
          {
            code: 'HOSTED_OPENINGS',
            message: `Cannot delete wall ${op.wallId}: hosted opening entities remain (${hostedEntities.map((e) => e.id).join(', ')})`,
            entityId: op.wallId,
          },
        ]);
      }
      return {
        ...model,
        walls: model.walls.filter((w) => w.id !== op.wallId),
        entities: (model.entities ?? []).filter((e) => e.id !== op.wallId),
      };
    }
    case 'createSpace': {
      const id =
        op.space.id ??
        `space-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const levelId = op.space.levelId ?? model.levels[0]?.id ?? 'level-1';
      const space: Space = {
        id,
        name: op.space.name,
        levelId,
        polygon: op.space.polygon,
        tags: op.space.tags ?? [],
      };
      const entity: DesignEntity = {
        id,
        type: 'space',
        levelId,
        geometry: { polygon: space.polygon },
        properties: { name: space.name, tags: space.tags },
      };
      return {
        ...model,
        spaces: [...model.spaces.filter((s) => s.id !== id), space],
        entities: upsertEntity(model.entities ?? [], entity),
      };
    }
    case 'updateSpace': {
      const existing = model.spaces.find((s) => s.id === op.spaceId);
      if (!existing) return model;
      const nextSpace: Space = {
        ...existing,
        ...(op.patch.name != null ? { name: op.patch.name } : {}),
        ...(op.patch.levelId != null ? { levelId: op.patch.levelId } : {}),
        ...(op.patch.polygon ? { polygon: op.patch.polygon } : {}),
        ...(op.patch.tags ? { tags: op.patch.tags } : {}),
      };
      const entity: DesignEntity = {
        id: op.spaceId,
        type: 'space',
        levelId: nextSpace.levelId,
        geometry: { polygon: nextSpace.polygon },
        properties: { name: nextSpace.name, tags: nextSpace.tags },
      };
      return {
        ...model,
        spaces: model.spaces.map((s) => (s.id === op.spaceId ? nextSpace : s)),
        entities: upsertEntity(model.entities ?? [], entity),
      };
    }
    case 'deleteSpace': {
      if (op.spaceId === 'space-1' && model.shell) {
        throw new DesignServiceError('Cannot delete shell footprint space', [
          {
            code: 'SHELL_SPACE',
            message:
              'space-1 is the shell footprint space and cannot be deleted while a parametric shell is present. Rename or reshape it with updateSpace instead.',
            entityId: op.spaceId,
          },
        ]);
      }
      return {
        ...model,
        spaces: model.spaces.filter((s) => s.id !== op.spaceId),
        entities: (model.entities ?? []).filter((e) => e.id !== op.spaceId),
      };
    }
    case 'createOpening': {
      const opening = ShellOpeningSchema.parse({
        id: op.opening.id ?? newOpeningId(op.opening.type),
        type: op.opening.type,
        wall: op.opening.wall,
        width: op.opening.width,
        height: op.opening.height,
        sillHeight: op.opening.sillHeight ?? (op.opening.type === 'window' ? 3 : 0),
        offset: op.opening.offset ?? 0,
        ...(op.opening.levelId ? { levelId: op.opening.levelId } : {}),
      });
      if (op.opening.position) {
        return addConvenienceOpening(model, {
          type: opening.type,
          wall: opening.wall,
          width: opening.width,
          height: opening.height,
          sillHeight: opening.sillHeight,
          position: op.opening.position,
          id: opening.id,
          levelId: opening.levelId,
        });
      }
      return addOpening(model, opening);
    }
    case 'createRoofPlane': {
      const id = op.plane.id ?? `roof-plane-${Date.now().toString(36)}`;
      const entity: DesignEntity = {
        id,
        type: 'roofPlane',
        parentId: op.plane.parentId ?? model.roofs[0]?.id ?? 'roof-1',
        levelId: model.levels[0]?.id,
        geometry: {
          vertices: op.plane.vertices,
          pitch: op.plane.pitch,
          role: op.plane.role,
        },
        properties: { face: op.plane.face, role: op.plane.role },
        materialId: op.plane.materialId ?? 'mat-roof',
      };
      return {
        ...model,
        entities: upsertEntity(model.entities ?? [], entity),
      };
    }
    case 'setProtectedEntities': {
      const current = new Set(model.protectedEntityIds ?? []);
      if (op.mode === 'replace') {
        return { ...model, protectedEntityIds: [...op.entityIds] };
      }
      if (op.mode === 'add') {
        for (const id of op.entityIds) current.add(id);
      } else {
        for (const id of op.entityIds) current.delete(id);
      }
      return { ...model, protectedEntityIds: [...current] };
    }
    case 'protectFootprint': {
      const shellWallIds = model.walls.filter((w) => isShellWallId(w.id)).map((w) => w.id);
      if (!op.protect) {
        const remove = new Set([
          'shell-1',
          ...shellWallIds,
          ...(model.slabs.map((s) => s.id) ?? []),
          'space-1',
        ]);
        return {
          ...model,
          protectedEntityIds: (model.protectedEntityIds ?? []).filter((id) => !remove.has(id)),
        };
      }
      const ids = new Set(model.protectedEntityIds ?? []);
      ids.add('shell-1');
      for (const id of shellWallIds) ids.add(id);
      for (const s of model.slabs) ids.add(s.id);
      ids.add('space-1');
      return { ...model, protectedEntityIds: [...ids] };
    }
    case 'updateBuildingDimensions': {
      const shell = extractShellFromModel(model);
      if (shell) {
        const nextW = op.width ?? shell.width;
        const nextD = op.depth ?? shell.depth;
        const footprintChanged =
          Math.abs(nextW - shell.width) > 1e-6 || Math.abs(nextD - shell.depth) > 1e-6;
        if (footprintChanged) {
          const conflict = composedRoofFootprintConflict(model, {
            width: nextW,
            depth: nextD,
          });
          if (conflict) {
            throw new DesignServiceError(conflict.message, [
              {
                code: 'COMPOSED_ROOF_RELAYOUT_REQUIRED',
                message: conflict.message,
                entityId: conflict.assemblyId,
              },
            ]);
          }
        }
      }
      return updateBuildingDimensions(model, {
        width: op.width,
        depth: op.depth,
        wallHeight: op.wallHeight,
      });
    }
    case 'updateRoof': {
      const multi = (model.roofAssemblies ?? []).some(
        (a) =>
          (a as { source?: string }).source === 'composed' &&
          ((a as { masses?: unknown[] }).masses?.length ?? 0) > 1,
      );
      if (multi) {
        throw new DesignServiceError(
          'Composed multi-mass roof is present. Use modify_roof_mass / create_roof_mass / delete_roof_mass instead of modify_roof.',
          [
            {
              code: 'USE_ROOF_MASS_TOOLS',
              message:
                'Composed multi-mass roof is present. Use modify_roof_mass / create_roof_mass / delete_roof_mass instead of modify_roof.',
            },
          ],
        );
      }
      return updateRoof(model, op.patch);
    }
    case 'setRoofAssemblies':
      try {
        return setRoofAssemblies(
          model,
          (op.assemblies as unknown[]).map((a) => RoofAssemblySchema.parse(a)),
        );
      } catch (err) {
        if (err instanceof RoofIntersectionError) {
          throw new DesignServiceError(err.message, [
            {
              code: err.code,
              message: err.message,
              details: err.details,
            },
          ]);
        }
        throw err;
      }
    case 'createRoofMass':
      try {
        return createRoofMass(model, {
          assemblyId: op.assemblyId,
          label: op.label,
          generator: RoofMassGeneratorSchema.parse(op.generator),
          materialId: op.materialId,
          levelId: op.levelId,
          role: op.role,
          coversExposedRegionId: op.coversExposedRegionId,
        });
      } catch (err) {
        if (err instanceof RoofIntersectionError) {
          throw new DesignServiceError(err.message, [
            {
              code: err.code,
              message: err.message,
              details: err.details,
            },
          ]);
        }
        throw err;
      }
    case 'updateRoofMass':
      try {
        return updateRoofMass(model, {
          assemblyId: op.assemblyId,
          massId: op.massId,
          patch: op.patch as Partial<import('./roof-assembly').RoofMassGenerator> & {
            label?: string;
            materialId?: string;
          },
        });
      } catch (err) {
        if (err instanceof RoofIntersectionError) {
          throw new DesignServiceError(err.message, [
            {
              code: err.code,
              message: err.message,
              details: err.details,
            },
          ]);
        }
        throw err;
      }
    case 'deleteRoofMass':
      try {
        return deleteRoofMass(model, {
          assemblyId: op.assemblyId,
          massId: op.massId,
        });
      } catch (err) {
        if (err instanceof RoofIntersectionError) {
          throw new DesignServiceError(err.message, [
            {
              code: err.code,
              message: err.message,
              details: err.details,
            },
          ]);
        }
        throw err;
      }
    case 'createLevel':
      try {
        return createLevel(model, {
          id: op.id,
          name: op.name,
          elevation: op.elevation,
          aboveLevelId: op.aboveLevelId,
          height: op.height,
          footprintSource: op.footprintSource,
        });
      } catch (err) {
        if (err instanceof LevelOpsError) {
          throw new DesignServiceError(err.message, [
            { code: err.code, message: err.message, details: err.details },
          ]);
        }
        throw err;
      }
    case 'updateLevel':
      try {
        return updateLevel(model, {
          levelId: op.levelId,
          patch: op.patch,
        });
      } catch (err) {
        if (err instanceof LevelOpsError) {
          throw new DesignServiceError(err.message, [
            { code: err.code, message: err.message, details: err.details },
          ]);
        }
        throw err;
      }
    case 'deleteLevel':
      try {
        return deleteLevel(model, {
          levelId: op.levelId,
          force: op.force,
        });
      } catch (err) {
        if (err instanceof LevelOpsError) {
          throw new DesignServiceError(err.message, [
            { code: err.code, message: err.message, details: err.details },
          ]);
        }
        throw err;
      }
    case 'setLevelFootprint':
      try {
        return setLevelFootprint(model, {
          levelId: op.levelId,
          footprint: {
            kind: 'rect',
            center: op.footprint.center,
            width: op.footprint.width,
            depth: op.footprint.depth,
          },
          allowPrimary: op.allowPrimary,
        });
      } catch (err) {
        if (err instanceof LevelFootprintError) {
          throw new DesignServiceError(err.message, [
            { code: err.code, message: err.message, details: err.details },
          ]);
        }
        throw err;
      }
    case 'updateLevelFootprint':
      try {
        return updateLevelFootprint(model, {
          levelId: op.levelId,
          patch: op.patch,
        });
      } catch (err) {
        if (err instanceof LevelFootprintError) {
          throw new DesignServiceError(err.message, [
            { code: err.code, message: err.message, details: err.details },
          ]);
        }
        throw err;
      }
    case 'clearLevelFootprint':
      try {
        return clearLevelFootprint(model, op.levelId);
      } catch (err) {
        if (err instanceof LevelFootprintError) {
          throw new DesignServiceError(err.message, [
            { code: err.code, message: err.message, details: err.details },
          ]);
        }
        throw err;
      }
    case 'createStair':
      try {
        return createStair(model, {
          id: op.id,
          name: op.name,
          type: op.type,
          fromLevelId: op.fromLevelId,
          toLevelId: op.toLevelId,
          origin: op.origin,
          directionDeg: op.directionDeg,
          width: op.width,
          targetTreadDepth: op.targetTreadDepth,
          maxRiserHeight: op.maxRiserHeight,
          availableRun: op.availableRun,
          turn: op.turn,
          firstFlightRisers: op.firstFlightRisers,
          landingSize: op.landingSize,
          materialId: op.materialId,
        });
      } catch (err) {
        if (err instanceof StairOpsError) {
          throw new DesignServiceError(err.message, [
            { code: err.code, message: err.message, details: err.details },
          ]);
        }
        throw err;
      }
    case 'updateStair':
      try {
        return updateStair(model, {
          stairId: op.stairId,
          patch: op.patch,
        });
      } catch (err) {
        if (err instanceof StairOpsError) {
          throw new DesignServiceError(err.message, [
            { code: err.code, message: err.message, details: err.details },
          ]);
        }
        throw err;
      }
    case 'deleteStair':
      try {
        return deleteStair(model, {
          stairId: op.stairId,
          keepOpening: op.keepOpening,
        });
      } catch (err) {
        if (err instanceof StairOpsError) {
          throw new DesignServiceError(err.message, [
            { code: err.code, message: err.message, details: err.details },
          ]);
        }
        throw err;
      }
    case 'setDesignPreference': {
      const pref = {
        id: op.preference.id ?? `pref-${Date.now().toString(36)}`,
        key: op.preference.key,
        value: op.preference.value,
        source: op.preference.source ?? 'ai',
        notes: op.preference.notes,
      };
      const existing = [...(model.designPreferences ?? [])];
      const idx = existing.findIndex((p) => p.key === pref.key);
      if (idx >= 0) existing[idx] = pref;
      else existing.push(pref);
      return { ...model, designPreferences: existing };
    }
    case 'createObject': {
      const id = op.object.id ?? `obj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const defaults =
        op.object.type === 'wallCabinet'
          ? { width: 2.5, depth: 1, height: 2.5, y: 4.5 }
          : op.object.type === 'countertop'
            ? { width: 2.5, depth: 2, height: 0.125, y: 3 }
            : op.object.type === 'island'
              ? { width: 8, depth: 3.5, height: 3, y: 0 }
              : { width: 2.5, depth: 2, height: 3, y: 0 };
      const entity: DesignEntity = {
        id,
        type: op.object.type,
        parentId: op.object.parentId,
        levelId: op.object.levelId ?? model.levels[0]?.id,
        geometry: {
          x: op.object.x ?? 0,
          y: op.object.y ?? defaults.y,
          z: op.object.z ?? 0,
          width: op.object.width ?? defaults.width,
          depth: op.object.depth ?? defaults.depth,
          height: op.object.height ?? defaults.height,
          rotationY: op.object.rotationY ?? 0,
        },
        properties: op.object.properties ?? {},
        materialId: op.object.materialId,
      };
      return {
        ...model,
        entities: upsertEntity(model.entities ?? [], DesignEntitySchema.parse(entity)),
      };
    }
    default: {
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}

/**
 * Apply a design transaction atomically: all ops or throw.
 * Re-hydrates entities and runs modular validators before accepting.
 */
export function applyTransaction(
  model: BuildingModelV1,
  transaction: DesignTransaction,
): BuildingModelV1 {
  const tx = DesignTransactionSchema.parse(transaction);
  let current = ensureEntities(model);

  // Pre-check protection against the starting model
  const preIssues = runDesignValidators(current, tx.operations).filter(
    (i) => i.code === 'PROTECTED',
  );
  if (preIssues.length > 0) {
    throw new DesignServiceError('Protected entities block this transaction', preIssues);
  }

  for (const op of tx.operations) {
    current = applyOne(current, op);
  }

  // Re-hydrate when shell-backed so entities stay consistent
  if (current.shell) {
    current = hydrateEntitiesFromModel(current);
  }

  const parsed = BuildingModelV1Schema.safeParse(current);
  if (!parsed.success) {
    throw new DesignServiceError(
      'Model failed schema validation after transaction',
      parsed.error.issues.map((i) => ({
        code: 'SCHEMA',
        message: `${i.path.join('.')}: ${i.message}`,
      })),
    );
  }

  const issues = runDesignValidators(parsed.data, tx.operations).filter(
    (i) => (i.severity ?? 'error') === 'error',
  );
  if (issues.length > 0) {
    throw new DesignServiceError('Design validation failed', issues);
  }

  const integrity = checkModelIntegrity(parsed.data);
  if (integrity.length > 0) {
    throw new DesignServiceError(
      'Model integrity failed',
      integrity.map((message) => ({ code: 'INTEGRITY', message })),
    );
  }

  return parsed.data;
}

export function applyDesignOperations(
  model: BuildingModelV1,
  operations: DesignOperation[],
  reason?: string,
): BuildingModelV1 {
  return applyTransaction(model, { operations, reason });
}

// Re-export for callers that need wall face constants
export { WALL_FACE_IDS };
