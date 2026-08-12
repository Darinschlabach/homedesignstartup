import type { BuildingShell } from './shell';
import type { DesignEntity } from './entities';
import { roofRise } from './geometry/roof-geometry';

type Vec3 = [number, number, number];

function plane(
  id: string,
  parentId: string,
  levelId: string,
  corners: Vec3[],
  props: Record<string, unknown>,
  materialId?: string,
  aliases?: string[],
): DesignEntity {
  return {
    id,
    type: 'roofPlane',
    parentId,
    levelId,
    geometry: {
      vertices: corners.map(([x, y, z]) => ({ x, y, z })),
      pitch: props.pitch,
      role: props.role,
    },
    properties: props,
    materialId,
    meta: aliases ? { aliases } : undefined,
  };
}

/**
 * Generate roofPlane (+ optional ridge) entities from a parametric shell roof.
 * Used by hydrate and as the extensible roof foundation (no CSG).
 */
export function generateRoofEntitiesFromShell(
  shell: BuildingShell,
  options: { roofAssemblyId?: string; levelId?: string; materialId?: string } = {},
): DesignEntity[] {
  const assemblyId = options.roofAssemblyId ?? 'roof-1';
  const levelId = options.levelId ?? 'level-1';
  const materialId = options.materialId ?? 'mat-roof';
  const hw = shell.width / 2 + shell.roof.overhang;
  const hd = shell.depth / 2 + shell.roof.overhang;
  const eaveY = shell.wallHeight;
  const pitch = shell.roof.pitch;
  const entities: DesignEntity[] = [];

  entities.push({
    id: assemblyId,
    type: 'roofAssembly',
    levelId,
    geometry: {
      footprint: [
        { x: -shell.width / 2, y: -shell.depth / 2 },
        { x: shell.width / 2, y: -shell.depth / 2 },
        { x: shell.width / 2, y: shell.depth / 2 },
        { x: -shell.width / 2, y: shell.depth / 2 },
      ],
      overhang: shell.roof.overhang,
      pitch,
      ridgeDirection: shell.roof.ridgeDirection,
    },
    properties: {
      generator: shell.roof.type,
      kind: shell.roof.type,
    },
    materialId,
  });

  if (shell.roof.type === 'flat' || shell.roof.pitch === 0) {
    const fl: Vec3 = [-hw, eaveY, -hd];
    const fr: Vec3 = [hw, eaveY, -hd];
    const br: Vec3 = [hw, eaveY, hd];
    const bl: Vec3 = [-hw, eaveY, hd];
    entities.push(
      plane(
        'roof-plane-flat',
        assemblyId,
        levelId,
        [fl, fr, br, bl],
        { pitch: 0, role: 'flat', face: 'top' },
        materialId,
        ['flat-a', 'flat-b'],
      ),
    );
    return entities;
  }

  if (shell.roof.type === 'shed') {
    const high = shell.roof.highSide ?? 'rear';
    const span = high === 'front' || high === 'rear' ? hd * 2 : hw * 2;
    const rise = roofRise(span, pitch);
    const fl: Vec3 = [-hw, eaveY, -hd];
    const fr: Vec3 = [hw, eaveY, -hd];
    const br: Vec3 = [hw, eaveY, hd];
    const bl: Vec3 = [-hw, eaveY, hd];
    let corners: Vec3[];
    if (high === 'rear') {
      corners = [fl, fr, [br[0], eaveY + rise, br[2]], [bl[0], eaveY + rise, bl[2]]];
    } else if (high === 'front') {
      corners = [[fl[0], eaveY + rise, fl[2]], [fr[0], eaveY + rise, fr[2]], br, bl];
    } else if (high === 'left') {
      corners = [[fl[0], eaveY + rise, fl[2]], fr, br, [bl[0], eaveY + rise, bl[2]]];
    } else {
      corners = [fl, [fr[0], eaveY + rise, fr[2]], [br[0], eaveY + rise, br[2]], bl];
    }
    entities.push(
      plane(
        'roof-plane-shed',
        assemblyId,
        levelId,
        corners,
        { pitch, role: 'shed', face: high },
        materialId,
        ['shed-a', 'shed-b'],
      ),
    );
    return entities;
  }

  if (shell.roof.type === 'hip') {
    const rise = roofRise(Math.min(hw, hd), pitch);
    const fl: Vec3 = [-hw, eaveY, -hd];
    const fr: Vec3 = [hw, eaveY, -hd];
    const br: Vec3 = [hw, eaveY, hd];
    const bl: Vec3 = [-hw, eaveY, hd];

    if (shell.roof.ridgeDirection === 'depth') {
      const rz = Math.max(0.01, hd - Math.min(hw, hd));
      const peakF: Vec3 = [0, eaveY + rise, -rz];
      const peakB: Vec3 = [0, eaveY + rise, rz];
      entities.push(
        plane('roof-plane-front', assemblyId, levelId, [fl, fr, peakF], { pitch, role: 'hipEnd', face: 'front' }, materialId, ['hip-front']),
        plane('roof-plane-rear', assemblyId, levelId, [br, bl, peakB], { pitch, role: 'hipEnd', face: 'rear' }, materialId, ['hip-rear']),
        plane('roof-plane-left', assemblyId, levelId, [fl, peakF, peakB, bl], { pitch, role: 'slope', face: 'left' }, materialId, ['hip-left-a', 'hip-left-b']),
        plane('roof-plane-right', assemblyId, levelId, [fr, br, peakB, peakF], { pitch, role: 'slope', face: 'right' }, materialId, ['hip-right-a', 'hip-right-b']),
      );
      entities.push({
        id: 'ridge-1',
        type: 'ridge',
        parentId: assemblyId,
        levelId,
        geometry: { start: { x: peakF[0], y: peakF[1], z: peakF[2] }, end: { x: peakB[0], y: peakB[1], z: peakB[2] } },
        properties: {},
      });
    } else {
      const rx = Math.max(0.01, hw - Math.min(hw, hd));
      const peakL: Vec3 = [-rx, eaveY + rise, 0];
      const peakR: Vec3 = [rx, eaveY + rise, 0];
      entities.push(
        plane('roof-plane-left', assemblyId, levelId, [bl, fl, peakL], { pitch, role: 'hipEnd', face: 'left' }, materialId, ['hip-left']),
        plane('roof-plane-right', assemblyId, levelId, [fr, br, peakR], { pitch, role: 'hipEnd', face: 'right' }, materialId, ['hip-right']),
        plane('roof-plane-front', assemblyId, levelId, [fl, fr, peakR, peakL], { pitch, role: 'slope', face: 'front' }, materialId, ['hip-front-a', 'hip-front-b']),
        plane('roof-plane-rear', assemblyId, levelId, [br, bl, peakL, peakR], { pitch, role: 'slope', face: 'rear' }, materialId, ['hip-rear-a', 'hip-rear-b']),
      );
      entities.push({
        id: 'ridge-1',
        type: 'ridge',
        parentId: assemblyId,
        levelId,
        geometry: { start: { x: peakL[0], y: peakL[1], z: peakL[2] }, end: { x: peakR[0], y: peakR[1], z: peakR[2] } },
        properties: {},
      });
    }
    return entities;
  }

  // Gable
  if (shell.roof.ridgeDirection === 'width') {
    const rise = roofRise(hd, pitch);
    const peakL: Vec3 = [-hw, eaveY + rise, 0];
    const peakR: Vec3 = [hw, eaveY + rise, 0];
    const fl: Vec3 = [-hw, eaveY, -hd];
    const fr: Vec3 = [hw, eaveY, -hd];
    const br: Vec3 = [hw, eaveY, hd];
    const bl: Vec3 = [-hw, eaveY, hd];
    entities.push(
      plane('roof-plane-front', assemblyId, levelId, [fl, fr, peakR, peakL], { pitch, role: 'slope', face: 'front' }, materialId, ['roof-south', 'roof-south-2']),
      plane('roof-plane-rear', assemblyId, levelId, [bl, peakL, peakR, br], { pitch, role: 'slope', face: 'rear' }, materialId, ['roof-north', 'roof-north-2']),
      plane('roof-plane-gable-left', assemblyId, levelId, [fl, peakL, bl], { pitch, role: 'gable', face: 'left' }, materialId, ['gable-west']),
      plane('roof-plane-gable-right', assemblyId, levelId, [fr, br, peakR], { pitch, role: 'gable', face: 'right' }, materialId, ['gable-east']),
    );
    entities.push({
      id: 'ridge-1',
      type: 'ridge',
      parentId: assemblyId,
      levelId,
      geometry: { start: { x: peakL[0], y: peakL[1], z: peakL[2] }, end: { x: peakR[0], y: peakR[1], z: peakR[2] } },
      properties: {},
    });
  } else {
    const rise = roofRise(hw, pitch);
    const peakF: Vec3 = [0, eaveY + rise, -hd];
    const peakB: Vec3 = [0, eaveY + rise, hd];
    const fl: Vec3 = [-hw, eaveY, -hd];
    const fr: Vec3 = [hw, eaveY, -hd];
    const br: Vec3 = [hw, eaveY, hd];
    const bl: Vec3 = [-hw, eaveY, hd];
    entities.push(
      plane('roof-plane-left', assemblyId, levelId, [fl, peakF, peakB, bl], { pitch, role: 'slope', face: 'left' }, materialId, ['roof-west', 'roof-west-2']),
      plane('roof-plane-right', assemblyId, levelId, [fr, br, peakB, peakF], { pitch, role: 'slope', face: 'right' }, materialId, ['roof-east', 'roof-east-2']),
      plane('roof-plane-gable-front', assemblyId, levelId, [fl, fr, peakF], { pitch, role: 'gable', face: 'front' }, materialId, ['gable-front']),
      plane('roof-plane-gable-rear', assemblyId, levelId, [bl, peakB, br], { pitch, role: 'gable', face: 'rear' }, materialId, ['gable-rear']),
    );
    entities.push({
      id: 'ridge-1',
      type: 'ridge',
      parentId: assemblyId,
      levelId,
      geometry: { start: { x: peakF[0], y: peakF[1], z: peakF[2] }, end: { x: peakB[0], y: peakB[1], z: peakB[2] } },
      properties: {},
    });
  }

  return entities;
}
