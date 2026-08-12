import type { BuildingModelV1, Material, Vec3 } from '../building-model';
import { buildBuildingGeometry, type SlabGeom } from '../geometry/building-geometry';

export interface MeshPrimitive {
  id: string;
  kind: 'box' | 'extrudedPolygon' | 'triangles';
  position: Vec3;
  rotation: Vec3;
  size?: Vec3;
  /** Plan polygon in local XZ as {x,y} where y → world Z (for extrudedPolygon). */
  polygon?: Array<{ x: number; y: number }>;
  /** Holes in the same coordinate system as polygon. */
  holes?: Array<Array<{ x: number; y: number }>>;
  height?: number;
  /** Flat xyz triples for triangle meshes (roof). */
  positions?: number[];
  color: string;
  roughness: number;
  metalness: number;
  selectable: boolean;
  entityType: 'wall' | 'slab' | 'roof' | 'structure' | 'opening' | 'object' | 'stair';
  entityId: string;
}

function materialLookup(model: BuildingModelV1, id?: string): Material | undefined {
  if (!id) return undefined;
  return model.materials.find((m) => m.id === id);
}

function slabToMesh(slab: SlabGeom): MeshPrimitive {
  const hasHoles = Boolean(slab.holes && slab.holes.length > 0 && slab.polygon);
  if (hasHoles && slab.polygon) {
    const cx = slab.position[0];
    const cz = slab.position[2];
    return {
      id: `mesh-${slab.id}`,
      kind: 'extrudedPolygon',
      position: {
        x: slab.position[0],
        y: slab.position[1],
        z: slab.position[2],
      },
      rotation: { x: 0, y: 0, z: 0 },
      // Local plan coords relative to slab center (x → X, y → Z).
      polygon: slab.polygon.map((p) => ({ x: p.x - cx, y: p.z - cz })),
      holes: (slab.holes ?? []).map((hole) =>
        // Opposite winding from outer polygon for ExtrudeGeometry holes.
        [...hole]
          .reverse()
          .map((p) => ({ x: p.x - cx, y: p.z - cz })),
      ),
      height: slab.thickness,
      color: slab.color,
      roughness: slab.roughness ?? 0.92,
      metalness: slab.metalness ?? 0,
      selectable: true,
      entityType: 'slab',
      entityId: slab.id,
    };
  }

  return {
    id: `mesh-${slab.id}`,
    kind: 'box',
    position: {
      x: slab.position[0],
      y: slab.position[1],
      z: slab.position[2],
    },
    rotation: { x: 0, y: 0, z: 0 },
    size: { x: slab.width, y: slab.thickness, z: slab.depth },
    color: slab.color,
    roughness: slab.roughness ?? 0.92,
    metalness: slab.metalness ?? 0,
    selectable: true,
    entityType: 'slab',
    entityId: slab.id,
  };
}

/**
 * Mesh descriptors for export / render_preview.
 * Same geometry source as the live R3F viewport: buildBuildingGeometry.
 */
export function buildSceneMeshes(model: BuildingModelV1): MeshPrimitive[] {
  const geom = buildBuildingGeometry(model);
  const meshes: MeshPrimitive[] = [];

  for (const slab of geom.slabs) {
    meshes.push(slabToMesh(slab));
  }

  for (const wall of geom.walls) {
    meshes.push({
      id: `mesh-${wall.id}`,
      kind: 'box',
      position: {
        x: wall.position[0],
        y: wall.position[1],
        z: wall.position[2],
      },
      rotation: { x: 0, y: wall.rotationY, z: 0 },
      size: { x: wall.width, y: wall.height, z: wall.thickness },
      color: wall.color,
      roughness: wall.roughness ?? 0.88,
      metalness: wall.metalness ?? 0,
      selectable: true,
      entityType: 'wall',
      entityId: wall.id,
    });
  }

  for (const roof of geom.roofs) {
    if (roof.positions.length < 9) continue;
    meshes.push({
      id: `mesh-${roof.id}`,
      kind: 'triangles',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      positions: roof.positions,
      color: roof.color,
      roughness: roof.roughness,
      metalness: roof.metalness,
      selectable: true,
      entityType: 'roof',
      entityId: roof.entityId ?? roof.id,
    });
  }

  for (const opening of geom.openings) {
    meshes.push({
      id: `mesh-${opening.id}`,
      kind: 'box',
      position: {
        x: opening.position[0],
        y: opening.position[1],
        z: opening.position[2],
      },
      rotation: { x: 0, y: opening.rotationY, z: 0 },
      size: {
        x: opening.width,
        y: opening.height,
        z: opening.type === 'window' ? 0.12 : 0.18,
      },
      color: opening.type === 'window' ? '#1a2a32' : '#5c4033',
      roughness: opening.type === 'window' ? 0.15 : 0.7,
      metalness: opening.type === 'window' ? 0.4 : 0.05,
      selectable: true,
      entityType: 'opening',
      entityId: opening.id,
    });
  }

  for (const obj of geom.placedObjects) {
    const ent = (model.entities ?? []).find((e) => e.id === obj.id);
    const mat = materialLookup(model, ent?.materialId);
    meshes.push({
      id: `mesh-${obj.id}`,
      kind: 'box',
      position: {
        x: obj.position[0],
        y: obj.position[1],
        z: obj.position[2],
      },
      rotation: { x: 0, y: obj.rotationY, z: 0 },
      size: { x: obj.size[0], y: obj.size[1], z: obj.size[2] },
      color: obj.color,
      roughness: mat?.roughness ?? 0.85,
      metalness: mat?.metalness ?? 0,
      selectable: true,
      entityType: 'object',
      entityId: obj.id,
    });
  }

  for (const stair of geom.stairs) {
    for (const riser of stair.derived.risers) {
      meshes.push({
        id: `mesh-${riser.id}`,
        kind: 'box',
        position: { ...riser.position },
        rotation: { x: 0, y: riser.rotationYDeg, z: 0 },
        size: {
          x: riser.size.width,
          y: riser.size.height,
          z: riser.size.depth,
        },
        color: stair.color,
        roughness: stair.roughness ?? 0.85,
        metalness: stair.metalness ?? 0,
        selectable: true,
        entityType: 'stair',
        entityId: stair.id,
      });
    }
    for (const tread of stair.derived.treads) {
      meshes.push({
        id: `mesh-${tread.id}`,
        kind: 'box',
        position: { ...tread.position },
        rotation: { x: 0, y: tread.rotationYDeg, z: 0 },
        size: {
          x: tread.size.width,
          y: tread.size.height,
          z: tread.size.depth,
        },
        color: stair.color,
        roughness: stair.roughness ?? 0.85,
        metalness: stair.metalness ?? 0,
        selectable: true,
        entityType: 'stair',
        entityId: stair.id,
      });
    }
  }

  for (const member of model.structure) {
    const mat = materialLookup(model, 'mat-structure');
    const dx = member.end.x - member.start.x;
    const dy = member.end.y - member.start.y;
    const dz = member.end.z - member.start.z;
    const length = Math.hypot(dx, dy, dz) || 0.1;
    meshes.push({
      id: `mesh-${member.id}`,
      kind: 'box',
      position: {
        x: (member.start.x + member.end.x) / 2,
        y: (member.start.y + member.end.y) / 2,
        z: (member.start.z + member.end.z) / 2,
      },
      rotation: {
        x: 0,
        y: (Math.atan2(dz, dx) * 180) / Math.PI,
        z: (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI,
      },
      size: {
        x: length,
        y: member.sectionDepth,
        z: member.sectionWidth,
      },
      color: mat?.color ?? '#8B6914',
      roughness: mat?.roughness ?? 0.75,
      metalness: mat?.metalness ?? 0,
      selectable: true,
      entityType: 'structure',
      entityId: member.id,
    });
  }

  return meshes;
}

export function exportSceneDescriptor(model: BuildingModelV1) {
  const geom = buildBuildingGeometry(model);
  return {
    format: 'aihd-scene-v1' as const,
    meta: model.meta,
    shell: geom.shell,
    meshes: buildSceneMeshes(model),
    materials: model.materials,
    cameras: [
      {
        id: 'default',
        position: { x: 40, y: 30, z: 40 },
        target: { x: 0, y: 5, z: 0 },
        fov: 45,
      },
    ],
  };
}
