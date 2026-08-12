import type { BuildingShell, ShellWallFace } from '../shell';
import { wallLengthForFace } from '../shell';

export type Vec3Tuple = [number, number, number];

export interface RoofSurface {
  /** Unique mesh triangle id (React key). */
  id: string;
  /** Stable design entity id for selection / AI. */
  entityId: string;
  /** Parent roof assembly entity id. */
  parentEntityId: string;
  /** Triangle list as flat xyz triples (world feet). */
  positions: number[];
  color: string;
  roughness: number;
  metalness: number;
}

/** Pitch ratio: rise/run for an X/12 pitch is pitch/12. */
export function pitchRatio(pitch: number): number {
  return pitch / 12;
}

export function roofRise(halfSpan: number, pitch: number): number {
  return halfSpan * pitchRatio(pitch);
}

const ROOF_ASSEMBLY_ID = 'roof-1';

/** Map legacy mesh keys → roofPlane entity ids. */
const MESH_TO_ENTITY: Record<string, string> = {
  'hip-front': 'roof-plane-front',
  'hip-rear': 'roof-plane-rear',
  'hip-left-a': 'roof-plane-left',
  'hip-left-b': 'roof-plane-left',
  'hip-right-a': 'roof-plane-right',
  'hip-right-b': 'roof-plane-right',
  'hip-left': 'roof-plane-left',
  'hip-right': 'roof-plane-right',
  'hip-front-a': 'roof-plane-front',
  'hip-front-b': 'roof-plane-front',
  'hip-rear-a': 'roof-plane-rear',
  'hip-rear-b': 'roof-plane-rear',
  'roof-south': 'roof-plane-front',
  'roof-south-2': 'roof-plane-front',
  'roof-north': 'roof-plane-rear',
  'roof-north-2': 'roof-plane-rear',
  'gable-west': 'roof-plane-gable-left',
  'gable-east': 'roof-plane-gable-right',
  'roof-west': 'roof-plane-left',
  'roof-west-2': 'roof-plane-left',
  'roof-east': 'roof-plane-right',
  'roof-east-2': 'roof-plane-right',
  'gable-front': 'roof-plane-gable-front',
  'gable-rear': 'roof-plane-gable-rear',
  'flat-a': 'roof-plane-flat',
  'flat-b': 'roof-plane-flat',
  'shed-a': 'roof-plane-shed',
  'shed-b': 'roof-plane-shed',
};

/**
 * Build gable or hip roof triangle meshes.
 * Plan axes: X = width, Z = depth (Y up in Three.js).
 */
export function buildRoofSurfaces(shell: BuildingShell, wallHeight: number): RoofSurface[] {
  const hw = shell.width / 2 + shell.roof.overhang;
  const hd = shell.depth / 2 + shell.roof.overhang;
  const eaveY = wallHeight;
  const color = '#4A5560';

  if (shell.roof.type === 'hip') {
    const rise = roofRise(Math.min(hw, hd), shell.roof.pitch);
    const fl: Vec3Tuple = [-hw, eaveY, -hd];
    const fr: Vec3Tuple = [hw, eaveY, -hd];
    const br: Vec3Tuple = [hw, eaveY, hd];
    const bl: Vec3Tuple = [-hw, eaveY, hd];

    if (shell.roof.ridgeDirection === 'depth') {
      const rz = Math.max(0.01, hd - Math.min(hw, hd));
      const peakF: Vec3Tuple = [0, eaveY + rise, -rz];
      const peakB: Vec3Tuple = [0, eaveY + rise, rz];
      return [
        tris('hip-front', [fl, fr, peakF], color),
        tris('hip-rear', [br, bl, peakB], color),
        tris('hip-left-a', [fl, peakF, peakB], color),
        tris('hip-left-b', [fl, peakB, bl], color),
        tris('hip-right-a', [fr, br, peakB], color),
        tris('hip-right-b', [fr, peakB, peakF], color),
      ];
    }

    const rx = Math.max(0.01, hw - Math.min(hw, hd));
    const peakL: Vec3Tuple = [-rx, eaveY + rise, 0];
    const peakR: Vec3Tuple = [rx, eaveY + rise, 0];
    return [
      tris('hip-left', [bl, fl, peakL], color),
      tris('hip-right', [fr, br, peakR], color),
      tris('hip-front-a', [fl, fr, peakR], color),
      tris('hip-front-b', [fl, peakR, peakL], color),
      tris('hip-rear-a', [br, bl, peakL], color),
      tris('hip-rear-b', [br, peakL, peakR], color),
    ];
  }

  if (shell.roof.type === 'flat' || shell.roof.pitch === 0) {
    const fl: Vec3Tuple = [-hw, eaveY, -hd];
    const fr: Vec3Tuple = [hw, eaveY, -hd];
    const br: Vec3Tuple = [hw, eaveY, hd];
    const bl: Vec3Tuple = [-hw, eaveY, hd];
    return [
      tris('flat-a', [fl, fr, br], color),
      tris('flat-b', [fl, br, bl], color),
    ];
  }

  if (shell.roof.type === 'shed') {
    const high = shell.roof.highSide ?? 'rear';
    const span =
      high === 'front' || high === 'rear' ? hd * 2 : hw * 2;
    const rise = roofRise(span, shell.roof.pitch);
    const fl: Vec3Tuple = [-hw, eaveY, -hd];
    const fr: Vec3Tuple = [hw, eaveY, -hd];
    const br: Vec3Tuple = [hw, eaveY, hd];
    const bl: Vec3Tuple = [-hw, eaveY, hd];
    let a: Vec3Tuple[];
    let b: Vec3Tuple[];
    if (high === 'rear') {
      a = [fl, fr, [br[0], eaveY + rise, br[2]]];
      b = [fl, [br[0], eaveY + rise, br[2]], [bl[0], eaveY + rise, bl[2]]];
    } else if (high === 'front') {
      a = [[fl[0], eaveY + rise, fl[2]], [fr[0], eaveY + rise, fr[2]], br];
      b = [[fl[0], eaveY + rise, fl[2]], br, bl];
    } else if (high === 'left') {
      a = [[fl[0], eaveY + rise, fl[2]], fr, br];
      b = [[fl[0], eaveY + rise, fl[2]], br, [bl[0], eaveY + rise, bl[2]]];
    } else {
      a = [fl, [fr[0], eaveY + rise, fr[2]], [br[0], eaveY + rise, br[2]]];
      b = [fl, [br[0], eaveY + rise, br[2]], bl];
    }
    return [tris('shed-a', a, color), tris('shed-b', b, color)];
  }

  if (shell.roof.ridgeDirection === 'width') {
    const rise = roofRise(hd, shell.roof.pitch);
    const peakL: Vec3Tuple = [-hw, eaveY + rise, 0];
    const peakR: Vec3Tuple = [hw, eaveY + rise, 0];
    const fl: Vec3Tuple = [-hw, eaveY, -hd];
    const fr: Vec3Tuple = [hw, eaveY, -hd];
    const br: Vec3Tuple = [hw, eaveY, hd];
    const bl: Vec3Tuple = [-hw, eaveY, hd];
    return [
      tris('roof-south', [fl, fr, peakR], color),
      tris('roof-south-2', [fl, peakR, peakL], color),
      tris('roof-north', [bl, peakL, peakR], color),
      tris('roof-north-2', [bl, peakR, br], color),
      tris('gable-west', [fl, peakL, bl], color),
      tris('gable-east', [fr, br, peakR], color),
    ];
  }

  const rise = roofRise(hw, shell.roof.pitch);
  const peakF: Vec3Tuple = [0, eaveY + rise, -hd];
  const peakB: Vec3Tuple = [0, eaveY + rise, hd];
  const fl: Vec3Tuple = [-hw, eaveY, -hd];
  const fr: Vec3Tuple = [hw, eaveY, -hd];
  const br: Vec3Tuple = [hw, eaveY, hd];
  const bl: Vec3Tuple = [-hw, eaveY, hd];

  return [
    tris('roof-west', [fl, peakF, peakB], color),
    tris('roof-west-2', [fl, peakB, bl], color),
    tris('roof-east', [fr, br, peakB], color),
    tris('roof-east-2', [fr, peakB, peakF], color),
    tris('gable-front', [fl, fr, peakF], color),
    tris('gable-rear', [bl, peakB, br], color),
  ];
}

/**
 * Mesh durable roof assemblies by fan-triangulating each plane boundary.
 */
export function buildRoofSurfacesFromAssemblies(
  assemblies: Array<{
    id: string;
    planes: Array<{ id: string; boundary: Array<{ x: number; y: number; z: number }> }>;
  }>,
  finish: { color: string; roughness?: number; metalness?: number } = {
    color: '#4A5560',
  },
): RoofSurface[] {
  const color = finish.color;
  const roughness = finish.roughness ?? 0.5;
  const metalness = finish.metalness ?? 0.25;
  const out: RoofSurface[] = [];

  for (const assembly of assemblies) {
    for (const plane of assembly.planes) {
      const pts = plane.boundary;
      if (pts.length < 3) continue;
      const a = pts[0]!;
      for (let i = 1; i < pts.length - 1; i++) {
        const b = pts[i]!;
        const c = pts[i + 1]!;
        out.push({
          id: `${plane.id}-t${i}`,
          entityId: plane.id,
          parentEntityId: assembly.id,
          positions: [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z],
          color,
          roughness,
          metalness,
        });
      }
    }
  }
  return out;
}

function tris(meshId: string, corners: Vec3Tuple[], color: string): RoofSurface {
  const entityId = MESH_TO_ENTITY[meshId] ?? meshId;
  if (corners.length < 3) {
    return {
      id: meshId,
      entityId,
      parentEntityId: ROOF_ASSEMBLY_ID,
      positions: [],
      color,
      roughness: 0.5,
      metalness: 0.25,
    };
  }
  const [a, b, c] = corners;
  return {
    id: meshId,
    entityId,
    parentEntityId: ROOF_ASSEMBLY_ID,
    positions: [...a!, ...b!, ...c!],
    color,
    roughness: 0.5,
    metalness: 0.25,
  };
}

export interface OpeningPlacement {
  id: string;
  type: 'window' | 'door' | 'garageDoor';
  face: ShellWallFace;
  position: Vec3Tuple;
  rotationY: number;
  width: number;
  height: number;
}

export function placeOpenings(
  shell: BuildingShell,
  options?: {
    levelElevation?: (levelId: string | undefined) => number;
    primaryLevelId?: string;
  },
): OpeningPlacement[] {
  const primaryLevelId = options?.primaryLevelId ?? 'level-1';
  const elevOf = options?.levelElevation ?? (() => 0);

  return shell.openings.map((o) => {
    const wallLen = wallLengthForFace(shell, o.wall);
    const along = Math.min(wallLen, Math.max(0, o.offset + o.width / 2));
    const elev = elevOf(o.levelId ?? primaryLevelId);
    const y = elev + o.sillHeight + o.height / 2;
    const hw = shell.width / 2;
    const hd = shell.depth / 2;
    const push = shell.wallThickness / 2 + 0.02;

    let position: Vec3Tuple = [0, y, 0];
    let rotationY = 0;

    switch (o.wall) {
      case 'front':
        position = [-hw + along, y, -hd - push];
        rotationY = 0;
        break;
      case 'rear':
        position = [hw - along, y, hd + push];
        rotationY = 180;
        break;
      case 'right':
        position = [hw + push, y, -hd + along];
        rotationY = -90;
        break;
      case 'left':
        position = [-hw - push, y, hd - along];
        rotationY = 90;
        break;
    }

    return {
      id: o.id,
      type: o.type,
      face: o.wall,
      position,
      rotationY,
      width: o.width,
      height: o.height,
    };
  });
}
