import type { BuildingModelV1 } from '../building-model';
import { LevelSchema } from '../building-model';
import {
  createDefaultTestBuilding,
  extractShellFromModel,
  isShellWallId,
  parseShellWallId,
  type BuildingShell,
} from '../shell';
import {
  buildRoofSurfaces,
  buildRoofSurfacesFromAssemblies,
  placeOpenings,
  type OpeningPlacement,
  type RoofSurface,
} from './roof-geometry';
import { ensureRoofAssemblies, RoofAssemblySchema } from '../roof-assembly';
import { isInteriorObjectType } from '../project-model';
import {
  levelFinishedFloorElevation,
  levelTopElevation,
} from '../levels';
import { topRoofBearingLevel } from '../level-footprint';
import {
  deriveStairGeometry,
  type DerivedStairGeometry,
} from './stair-geometry';

export interface WallSegmentGeom {
  id: string;
  face?: 'front' | 'rear' | 'left' | 'right' | 'interior';
  levelId?: string;
  position: [number, number, number];
  rotationY: number;
  width: number;
  height: number;
  thickness: number;
  color: string;
  materialId?: string;
  roughness?: number;
  metalness?: number;
}

export interface SlabGeom {
  id: string;
  levelId?: string;
  width: number;
  depth: number;
  thickness: number;
  position: [number, number, number];
  color: string;
  materialId?: string;
  roughness?: number;
  metalness?: number;
  /**
   * Optional plan outline in world XZ (x,z). When present with holes, renderer
   * uses extruded shape instead of a solid box.
   */
  polygon?: Array<{ x: number; z: number }>;
  /** Holes in the same coordinate system as polygon (from floorOpenings). */
  holes?: Array<Array<{ x: number; z: number }>>;
}

export interface StairGeom {
  id: string;
  fromLevelId: string;
  toLevelId: string;
  color: string;
  materialId?: string;
  roughness?: number;
  metalness?: number;
  derived: DerivedStairGeometry;
}

export interface PlacedObjectGeom {
  id: string;
  type: string;
  levelId?: string;
  position: [number, number, number];
  size: [number, number, number];
  rotationY: number;
  color: string;
}

export interface BuildingGeometry {
  shell: BuildingShell;
  /** Primary / lowest slab (compat). Prefer `slabs`. */
  slab: SlabGeom;
  slabs: SlabGeom[];
  walls: WallSegmentGeom[];
  roofs: RoofSurface[];
  openings: OpeningPlacement[];
  placedObjects: PlacedObjectGeom[];
  stairs: StairGeom[];
}

function materialColor(model: BuildingModelV1, id: string, fallback: string): string {
  return model.materials.find((m) => m.id === id)?.color ?? fallback;
}

function resolveObjectMaterialId(
  model: BuildingModelV1,
  objectId: string,
  fallback: string,
): string {
  const wall = model.walls.find((w) => w.id === objectId);
  if (wall?.materialId) return wall.materialId;
  const roof = model.roofs.find((r) => r.id === objectId);
  if (roof?.materialId) return roof.materialId;
  const slab = model.slabs.find((s) => s.id === objectId);
  if (slab?.materialId) return slab.materialId;
  const ent = (model.entities ?? []).find((e) => e.id === objectId);
  if (ent?.materialId) return ent.materialId;
  return fallback;
}

function materialFinish(
  model: BuildingModelV1,
  materialId: string,
  fallbacks: { color: string; roughness: number; metalness: number },
) {
  const mat = model.materials.find((m) => m.id === materialId);
  return {
    materialId,
    color: mat?.color ?? fallbacks.color,
    roughness: mat?.roughness ?? fallbacks.roughness,
    metalness: mat?.metalness ?? fallbacks.metalness,
  };
}

function levelHeight(model: BuildingModelV1, levelId: string, fallback: number): number {
  return model.levels.find((l) => l.id === levelId)?.height ?? fallback;
}

/**
 * Pure geometry descriptor for the live 3D engine.
 * Internal units = feet. Prefer model.shell; otherwise infer or use test default.
 *
 * Vertical placement uses Level.elevation (finished floor) so multi-story
 * walls/slabs/openings/objects stack correctly. Level 1 at elevation 0 is unchanged.
 */
export function buildBuildingGeometry(model: BuildingModelV1): BuildingGeometry {
  const shell =
    extractShellFromModel(model) ??
    createDefaultTestBuilding({
      buildingType: model.meta.buildingType,
      name: model.meta.name,
    }).shell!;

  const roofMatId =
    model.roofs[0]?.materialId ??
    resolveObjectMaterialId(model, 'roof-1', 'mat-roof');
  const roofFinish = materialFinish(model, roofMatId, {
    color: '#4A5560',
    roughness: 0.5,
    metalness: 0.25,
  });
  const hw = shell.width / 2;
  const hd = shell.depth / 2;
  const t = shell.wallThickness;
  const fallbackH = shell.wallHeight;

  const walls: WallSegmentGeom[] = [];

  // Exterior + interior walls from model.walls (authoritative after sync).
  for (const wall of model.walls) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const length = Math.hypot(dx, dy);
    if (!(length > 0.01)) continue;

    const elev = levelFinishedFloorElevation(model, wall.levelId);
    const wallH = wall.height ?? levelHeight(model, wall.levelId, fallbackH);
    const wallT = wall.thickness > 0 ? wall.thickness : t;
    const materialId = resolveObjectMaterialId(model, wall.id, 'mat-wall');
    const finish = materialFinish(model, materialId, {
      color: isShellWallId(wall.id) ? '#D9D2C5' : '#C9C2B4',
      roughness: isShellWallId(wall.id) ? 0.88 : 0.9,
      metalness: 0,
    });

    const parsed = parseShellWallId(wall.id);
    const face: WallSegmentGeom['face'] = parsed
      ? parsed.face
      : isShellWallId(wall.id)
        ? 'front'
        : 'interior';

    walls.push({
      id: wall.id,
      face,
      levelId: wall.levelId,
      position: [
        (wall.start.x + wall.end.x) / 2,
        elev + wallH / 2,
        (wall.start.y + wall.end.y) / 2,
      ],
      rotationY: (Math.atan2(dy, dx) * 180) / Math.PI,
      width: length,
      height: wallH,
      thickness: wallT,
      color: finish.color,
      materialId: finish.materialId,
      roughness: finish.roughness,
      metalness: finish.metalness,
    });
  }

  // Fallback: if model has no walls yet, emit primary shell walls at Y=0.
  if (walls.length === 0) {
    const h = fallbackH;
    const defs: Array<{
      id: string;
      face: WallSegmentGeom['face'];
      position: [number, number, number];
      rotationY: number;
      width: number;
    }> = [
      {
        id: 'wall-front',
        face: 'front',
        position: [0, h / 2, -hd],
        rotationY: 0,
        width: shell.width,
      },
      {
        id: 'wall-right',
        face: 'right',
        position: [hw, h / 2, 0],
        rotationY: 90,
        width: shell.depth,
      },
      {
        id: 'wall-rear',
        face: 'rear',
        position: [0, h / 2, hd],
        rotationY: 0,
        width: shell.width,
      },
      {
        id: 'wall-left',
        face: 'left',
        position: [-hw, h / 2, 0],
        rotationY: 90,
        width: shell.depth,
      },
    ];
    for (const w of defs) {
      const materialId = resolveObjectMaterialId(model, w.id, 'mat-wall');
      const finish = materialFinish(model, materialId, {
        color: '#D9D2C5',
        roughness: 0.88,
        metalness: 0,
      });
      walls.push({
        ...w,
        height: h,
        thickness: t,
        color: finish.color,
        materialId: finish.materialId,
        roughness: finish.roughness,
        metalness: finish.metalness,
      });
    }
  }

  const slabs: SlabGeom[] = [];
  const slabSources =
    model.slabs.length > 0
      ? model.slabs
      : [
          {
            id: 'slab-1',
            levelId: model.levels[0]?.id ?? 'level-1',
            polygon: [
              { x: -hw, y: -hd },
              { x: hw, y: -hd },
              { x: hw, y: hd },
              { x: -hw, y: hd },
            ],
            thickness: 0.5,
            materialId: 'mat-floor',
          },
        ];

  for (const slab of slabSources) {
    const elev = levelFinishedFloorElevation(model, slab.levelId);
    const thickness = slab.thickness > 0 ? slab.thickness : 0.5;
    const xs = slab.polygon.map((p) => p.x);
    const ys = slab.polygon.map((p) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const depth = Math.max(...ys) - Math.min(...ys);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cz = (Math.max(...ys) + Math.min(...ys)) / 2;
    const materialId = resolveObjectMaterialId(model, slab.id, 'mat-floor');
    const finish = materialFinish(model, materialId, {
      color: '#A8A29A',
      roughness: 0.92,
      metalness: 0,
    });
    const holes = (model.floorOpenings ?? [])
      .filter(
        (o) =>
          o.levelId === slab.levelId &&
          (o.slabId == null || o.slabId === slab.id),
      )
      .map((o) => o.polygon.map((p) => ({ x: p.x, z: p.y })));
    const polygon = slab.polygon.map((p) => ({ x: p.x, z: p.y }));
    slabs.push({
      id: slab.id,
      levelId: slab.levelId,
      width: width > 0 ? width : shell.width,
      depth: depth > 0 ? depth : shell.depth,
      thickness,
      // Top of slab at finished floor elevation.
      position: [cx, elev - thickness / 2, cz],
      color: finish.color,
      materialId: finish.materialId,
      roughness: finish.roughness,
      metalness: finish.metalness,
      polygon,
      holes: holes.length > 0 ? holes : undefined,
    });
  }

  const stairs: StairGeom[] = [];
  for (const stair of model.stairs ?? []) {
    try {
      const derived = deriveStairGeometry(model, stair);
      // Prefer explicit stair material; otherwise a distinct warm neutral so
      // treads/risers are readable against floor slabs (not mat-floor).
      const finish = stair.materialId
        ? materialFinish(model, stair.materialId, {
            color: '#8B7355',
            roughness: 0.85,
            metalness: 0,
          })
        : {
            materialId: undefined as string | undefined,
            color: '#8B7355',
            roughness: 0.85,
            metalness: 0,
          };
      stairs.push({
        id: stair.id,
        fromLevelId: stair.fromLevelId,
        toLevelId: stair.toLevelId,
        color: finish.color,
        materialId: finish.materialId,
        roughness: finish.roughness,
        metalness: finish.metalness,
        derived,
      });
    } catch {
      // Invalid stairs are rejected by ops/validators; skip render rather than crash.
    }
  }

  const placedObjects: PlacedObjectGeom[] = (model.entities ?? [])
    .filter((e) => isInteriorObjectType(String(e.type)))
    .map((e) => {
      const width = Number(e.geometry.width ?? 2);
      const height = Number(e.geometry.height ?? 3);
      const depth = Number(e.geometry.depth ?? 2);
      const x = Number(e.geometry.x ?? 0);
      /** Height above finished floor of the entity's level (L1 elev=0 → unchanged). */
      const localY = Number(e.geometry.y ?? 0);
      const z = Number(e.geometry.z ?? 0);
      const elev = levelFinishedFloorElevation(model, e.levelId);
      const color =
        e.type === 'countertop'
          ? materialColor(model, e.materialId ?? 'mat-floor', '#9CA3AF')
          : e.type === 'appliance'
            ? materialColor(model, e.materialId ?? 'mat-structure', '#4B5563')
            : materialColor(model, e.materialId ?? 'mat-trim', '#E7E0D4');
      return {
        id: e.id,
        type: String(e.type),
        levelId: e.levelId,
        position: [x, elev + localY + height / 2, z] as [number, number, number],
        size: [width, height, depth] as [number, number, number],
        rotationY: Number(e.geometry.rotationY ?? 0),
        color,
      };
    });

  const roofLevel = topRoofBearingLevel(model);
  const eaveY = levelTopElevation(LevelSchema.parse(roofLevel));

  return {
    shell,
    slab: slabs[0]!,
    slabs,
    walls,
    roofs: (() => {
      const assemblies = ensureRoofAssemblies(model).map((a) =>
        RoofAssemblySchema.parse(a),
      );
      if (assemblies.length > 0) {
        return buildRoofSurfacesFromAssemblies(assemblies, {
          color: roofFinish.color,
          roughness: roofFinish.roughness,
          metalness: roofFinish.metalness,
        });
      }
      return buildRoofSurfaces(shell, eaveY).map((r) => ({
        ...r,
        color: roofFinish.color,
        roughness: roofFinish.roughness,
        metalness: roofFinish.metalness,
      }));
    })(),
    openings: placeOpenings(shell, {
      levelElevation: (levelId) => levelFinishedFloorElevation(model, levelId),
      primaryLevelId: model.levels[0]?.id ?? 'level-1',
    }),
    placedObjects,
    stairs,
  };
}
