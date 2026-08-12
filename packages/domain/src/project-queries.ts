import type { BuildingModelV1 } from './building-model';
import { getEntity, listEntities, resolveSelectedEntity, summarizeEntity } from './entity-index';
import { ensureEntities } from './hydrate-entities';
import { queryDesign } from './design-service';
import { extractShellFromModel } from './shell';
import { buildBuildingGeometry } from './geometry/building-geometry';
import { runDesignValidators } from './validation';
import { isInteriorObjectType } from './project-model';

/** Full agent-facing project state — structured, not Three.js scene graph. */
export function getProjectState(
  model: BuildingModelV1,
  selectedEntityId?: string | null,
) {
  const m = ensureEntities(model);
  const q = queryDesign(m, selectedEntityId);
  const shell = extractShellFromModel(m);
  const interiors = listEntities(m).filter((e) => isInteriorObjectType(String(e.type)));

  return {
    meta: m.meta,
    shell: q.shell,
    levels: q.levels,
    rooms: m.spaces.map((s) => ({
      id: s.id,
      name: s.name,
      levelId: s.levelId,
      tags: s.tags,
      polygon: s.polygon,
    })),
    walls: q.walls,
    openings: q.openings.map((o) => summarizeEntity(o)),
    roof: {
      assembly: q.roofAssembly ? summarizeEntity(q.roofAssembly) : null,
      planes: q.roofPlanes.map((p) => summarizeEntity(p)),
    },
    materials: m.materials,
    constraints: m.constraints,
    designPreferences: m.designPreferences ?? [],
    designHistory: (m.designHistory ?? []).slice(-20),
    protectedEntityIds: q.protectedEntityIds,
    selected: q.selected,
    interiors: interiors.map((e) => summarizeEntity(e)),
    entityCount: q.entityCount,
    footprint: shell
      ? { width: shell.width, depth: shell.depth, wallHeight: shell.wallHeight }
      : null,
  };
}

/** Compact 3D-ready descriptors derived from the project model (not live Three objects). */
export function getScene(model: BuildingModelV1) {
  const geom = buildBuildingGeometry(model);
  const interiors = listEntities(ensureEntities(model))
    .filter((e) => isInteriorObjectType(String(e.type)))
    .map((e) => ({
      id: e.id,
      type: e.type,
      position: [
        Number(e.geometry.x ?? 0),
        Number(e.geometry.y ?? 0) + Number(e.geometry.height ?? 1) / 2,
        Number(e.geometry.z ?? 0),
      ] as [number, number, number],
      size: [
        Number(e.geometry.width ?? 2),
        Number(e.geometry.height ?? 3),
        Number(e.geometry.depth ?? 2),
      ] as [number, number, number],
      rotationY: Number(e.geometry.rotationY ?? 0),
      materialId: e.materialId,
      properties: e.properties,
    }));

  return {
    slab: geom.slab,
    slabs: geom.slabs,
    walls: geom.walls.map((w) => ({
      id: w.id,
      levelId: w.levelId,
      position: w.position,
      size: [w.width, w.height, w.thickness] as [number, number, number],
      rotationY: w.rotationY,
    })),
    roofs: geom.roofs.map((r) => ({
      id: r.id,
      entityId: r.entityId,
      parentEntityId: r.parentEntityId,
      triangleCount: r.positions.length / 9,
    })),
    openings: geom.openings,
    interiors,
    stairs: geom.stairs.map((s) => ({
      id: s.id,
      fromLevelId: s.fromLevelId,
      toLevelId: s.toLevelId,
      riserCount: s.derived.riserCount,
      treadCount: s.derived.treadCount,
      totalRise: s.derived.totalRise,
    })),
  };
}

export function getObject(model: BuildingModelV1, objectId: string) {
  const entity = resolveSelectedEntity(model, objectId) ?? getEntity(model, objectId);
  return entity ? summarizeEntity(entity) : null;
}

export function getRoom(model: BuildingModelV1, roomId: string) {
  const space = model.spaces.find((s) => s.id === roomId);
  if (!space) return null;
  const contents = listEntities(ensureEntities(model)).filter(
    (e) => e.parentId === roomId || e.properties.roomId === roomId,
  );
  return {
    id: space.id,
    name: space.name,
    levelId: space.levelId,
    polygon: space.polygon,
    tags: space.tags,
    contents: contents.map((c) => summarizeEntity(c)),
  };
}

export function getMeasurements(model: BuildingModelV1) {
  const shell = extractShellFromModel(model);
  return {
    units: model.meta.units,
    footprint: shell
      ? {
          widthFt: shell.width,
          depthFt: shell.depth,
          wallHeightFt: shell.wallHeight,
          areaSqFt: shell.width * shell.depth,
        }
      : null,
    openingCount: model.openings.length,
    wallCount: model.walls.length,
    roomCount: model.spaces.length,
  };
}

export function measureDistance(
  a: { x: number; y?: number; z?: number },
  b: { x: number; y?: number; z?: number },
) {
  const dy = (b.y ?? 0) - (a.y ?? 0);
  const dz = (b.z ?? 0) - (a.z ?? 0);
  const dx = b.x - a.x;
  const dist = Math.hypot(dx, dy, dz);
  return {
    distanceFt: Math.round(dist * 100) / 100,
    delta: { x: dx, y: dy, z: dz },
  };
}

function aabbOf(entity: {
  geometry: Record<string, unknown>;
}): { min: [number, number, number]; max: [number, number, number] } | null {
  const x = Number(entity.geometry.x);
  const y = Number(entity.geometry.y ?? 0);
  const z = Number(entity.geometry.z);
  const w = Number(entity.geometry.width);
  const h = Number(entity.geometry.height);
  const d = Number(entity.geometry.depth);
  if (![x, y, z, w, h, d].every((n) => Number.isFinite(n))) return null;
  return {
    min: [x - w / 2, y, z - d / 2],
    max: [x + w / 2, y + h, z + d / 2],
  };
}

function aabbsOverlap(
  a: { min: [number, number, number]; max: [number, number, number] },
  b: { min: [number, number, number]; max: [number, number, number] },
) {
  return (
    a.min[0] <= b.max[0] &&
    a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] &&
    a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] &&
    a.max[2] >= b.min[2]
  );
}

export function detectCollision(model: BuildingModelV1, objectIdA: string, objectIdB: string) {
  const a = getEntity(model, objectIdA);
  const b = getEntity(model, objectIdB);
  if (!a || !b) return { colliding: false, error: 'Object not found' };
  const boxA = aabbOf(a);
  const boxB = aabbOf(b);
  if (!boxA || !boxB) {
    return { colliding: false, note: 'One or both objects lack box geometry' };
  }
  return { colliding: aabbsOverlap(boxA, boxB), a: objectIdA, b: objectIdB };
}

export function checkClearance(
  model: BuildingModelV1,
  objectId: string,
  requiredClearanceFt: number,
) {
  const target = getEntity(model, objectId);
  if (!target) return { ok: false, error: 'Object not found' };
  const box = aabbOf(target);
  if (!box) return { ok: false, error: 'Object lacks measurable box geometry' };

  const expanded = {
    min: [
      box.min[0] - requiredClearanceFt,
      box.min[1],
      box.min[2] - requiredClearanceFt,
    ] as [number, number, number],
    max: [
      box.max[0] + requiredClearanceFt,
      box.max[1],
      box.max[2] + requiredClearanceFt,
    ] as [number, number, number],
  };

  const violators: string[] = [];
  for (const other of listEntities(model)) {
    if (other.id === objectId) continue;
    if (!isInteriorObjectType(String(other.type))) continue;
    const otherBox = aabbOf(other);
    if (otherBox && aabbsOverlap(expanded, otherBox)) violators.push(other.id);
  }

  return {
    ok: violators.length === 0,
    requiredClearanceFt,
    objectId,
    violators,
  };
}

export function validateLayout(model: BuildingModelV1) {
  const issues = runDesignValidators(ensureEntities(model), []);
  const shell = extractShellFromModel(model);
  const notes: string[] = [];
  if (shell && shell.width * shell.depth < 100) {
    notes.push('Very small footprint (<100 sq ft)');
  }
  const collisions: Array<{ a: string; b: string }> = [];
  const interiors = listEntities(model).filter((e) => isInteriorObjectType(String(e.type)));
  for (let i = 0; i < interiors.length; i++) {
    for (let j = i + 1; j < interiors.length; j++) {
      const a = interiors[i]!;
      const b = interiors[j]!;
      const result = detectCollision(model, a.id, b.id);
      if (result.colliding) collisions.push({ a: a.id, b: b.id });
    }
  }
  return {
    ok: issues.length === 0 && collisions.length === 0,
    schemaIssues: issues,
    collisions,
    notes,
  };
}

export function appendDesignHistory(
  model: BuildingModelV1,
  entry: {
    transactionId?: string;
    reason?: string;
    summary?: string;
    operationCount?: number;
  },
): BuildingModelV1 {
  const history = [...(model.designHistory ?? [])];
  history.push({
    id: `hist-${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    ...entry,
  });
  // Cap in-model history; full state is in building_revisions
  return {
    ...model,
    designHistory: history.slice(-50),
  };
}
