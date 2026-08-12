import type { BuildingModelV1 } from '../building-model';
import type { DesignOperation } from '../operations';
import { getEntity } from '../entity-index';
import {
  composedRoofFootprintConflict,
  extractShellFromModel,
  isShellWallId,
  wallLengthForFace,
} from '../shell';
import { isInteriorObjectType } from '../project-model';
import { RoofAssemblySchema, type RoofAssembly } from '../roof-assembly';
import {
  assertNoInterpenetration,
  recompileRoofAssembly,
  RoofIntersectionError,
} from '../geometry/roof-intersection';
import { polygonArea3 } from '../geometry/roof-plane-math';
import {
  deriveStairGeometry,
  StairGeometryError,
  STAIR_DEFAULTS,
} from '../geometry/stair-geometry';
import {
  pointInFootprint,
  resolveLevelFootprint,
} from '../level-footprint';
import { LevelFootprintRectSchema } from '../level-footprint-schema';
import {
  isLowerRoofAssembly,
  massOutsideLowerFootprint,
  massOverlapsUpperFootprint,
  uncoveredExposedLowerRegions,
} from '../lower-roof';
import { levelTopElevation } from '../levels';
import { LevelSchema } from '../building-model';

export type ValidationIssue = {
  code: string;
  message: string;
  entityId?: string;
  details?: Record<string, unknown>;
  /** Defaults to error (blocks transactions). Warnings report without blocking. */
  severity?: 'error' | 'warning';
};

export function validatePositiveDimensions(
  model: BuildingModelV1,
  _ops: DesignOperation[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const shell = extractShellFromModel(model);
  if (shell) {
    if (!(shell.width > 0)) issues.push({ code: 'DIM_WIDTH', message: 'Width must be positive' });
    if (!(shell.depth > 0)) issues.push({ code: 'DIM_DEPTH', message: 'Depth must be positive' });
    if (!(shell.wallHeight > 0)) {
      issues.push({ code: 'DIM_HEIGHT', message: 'Wall height must be positive' });
    }
  }
  for (const o of model.openings) {
    if (!(o.width > 0) || !(o.height > 0)) {
      issues.push({
        code: 'OPENING_DIM',
        message: `Opening ${o.id} has non-positive dimensions`,
        entityId: o.id,
      });
    }
  }
  return issues;
}

export function validateRoofPitch(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const shell = extractShellFromModel(model);
  const assemblies: RoofAssembly[] = (model.roofAssemblies ?? []).map((a) =>
    RoofAssemblySchema.parse(a),
  );

  for (const assembly of assemblies) {
    for (const plane of assembly.planes) {
      const pitch = Number(plane.pitch);
      if (!Number.isFinite(pitch) || pitch < 0 || pitch > 24) {
        issues.push({
          code: 'ROOF_PITCH',
          message: `Roof plane ${plane.id} pitch ${pitch}/12 is outside supported range 0–24`,
          entityId: plane.id,
        });
      }
      const role = plane.role;
      if (
        role != null &&
        role !== 'flat' &&
        role !== 'shed' &&
        pitch === 0 &&
        (role === 'slope' || role === 'hipEnd' || role === 'gable' || role === 'wing')
      ) {
        issues.push({
          code: 'ROOF_PITCH',
          message: `Roof plane ${plane.id} (${role}) requires pitch > 0`,
          entityId: plane.id,
        });
      }
    }
  }

  if (assemblies.length === 0) {
    const pitch = shell?.roof.pitch ?? model.roofs[0]?.pitch;
    const type = shell?.roof.type ?? model.roofs[0]?.kind;
    if (pitch != null) {
      if (type === 'flat') {
        if (pitch < 0 || pitch > 24) {
          issues.push({
            code: 'ROOF_PITCH',
            message: `Roof pitch ${pitch}/12 is outside supported range 0–24`,
            entityId: model.roofs[0]?.id ?? 'roof-1',
          });
        }
      } else if (pitch < 1 || pitch > 24) {
        issues.push({
          code: 'ROOF_PITCH',
          message: `Roof pitch ${pitch}/12 is outside supported range 1–24`,
          entityId: model.roofs[0]?.id ?? 'roof-1',
        });
      }
    }
  }
  return issues;
}

export function validateRoofOverhang(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const shell = extractShellFromModel(model);
  if (!shell) return issues;
  // Skip overhang check when composed assemblies own the roof (shell overhang is hint only).
  if ((model.roofAssemblies ?? []).some((a) => a.source === 'composed')) {
    return issues;
  }
  const overhang = shell.roof.overhang;
  if (overhang < 0) {
    issues.push({
      code: 'ROOF_OVERHANG',
      message: 'Roof overhang must be non-negative',
      entityId: 'roof-1',
    });
  }
  const maxOverhang = Math.min(shell.width, shell.depth) / 2;
  if (overhang > maxOverhang + 0.01) {
    issues.push({
      code: 'ROOF_OVERHANG',
      message: `Roof overhang ${overhang}ft exceeds half the shorter footprint side (${maxOverhang}ft)`,
      entityId: 'roof-1',
    });
  }
  return issues;
}

export function validateRoofAssemblies(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const assemblies: RoofAssembly[] = (model.roofAssemblies ?? []).map((a) =>
    RoofAssemblySchema.parse(a),
  );
  const shell = extractShellFromModel(model);

  for (const assembly of assemblies) {
    const planeIds = new Set((assembly.planes ?? []).map((p) => String(p.id)));
    if ((assembly.planes ?? []).length === 0) {
      issues.push({
        code: 'ROOF_ASSEMBLY_EMPTY',
        message: `Roof assembly ${assembly.id} has no planes`,
        entityId: assembly.id,
      });
    }

    for (const plane of assembly.planes ?? []) {
      const boundary = plane.boundary ?? [];
      if (boundary.length < 3) {
        issues.push({
          code: 'ROOF_PLANE_DEGENERATE',
          message: `Roof plane ${plane.id} needs at least 3 boundary vertices`,
          entityId: plane.id,
        });
        continue;
      }
      // Degenerate area check — prefer 3D triangle area so vertical gables are allowed.
      let area3 = 0;
      const origin = boundary[0]!;
      for (let i = 1; i < boundary.length - 1; i++) {
        const b = boundary[i]!;
        const c = boundary[i + 1]!;
        const abx = b.x - origin.x;
        const aby = b.y - origin.y;
        const abz = b.z - origin.z;
        const acx = c.x - origin.x;
        const acy = c.y - origin.y;
        const acz = c.z - origin.z;
        const cx = aby * acz - abz * acy;
        const cy = abz * acx - abx * acz;
        const cz = abx * acy - aby * acx;
        area3 += Math.hypot(cx, cy, cz);
      }
      if (area3 < 1e-6) {
        issues.push({
          code: 'ROOF_PLANE_DEGENERATE',
          message: `Roof plane ${plane.id} has degenerate geometry`,
          entityId: plane.id,
        });
      }
      // Self-intersection (simple segment check on plan xz) — skip near-vertical gables
      const planArea = (() => {
        let a2 = 0;
        for (let i = 0; i < boundary.length; i++) {
          const a = boundary[i]!;
          const b = boundary[(i + 1) % boundary.length]!;
          a2 += a.x * b.z - b.x * a.z;
        }
        return Math.abs(a2);
      })();
      if (
        plane.role !== 'gable' &&
        planArea > 1e-6 &&
        boundary.length >= 4 &&
        planPolygonSelfIntersects(boundary)
      ) {
        issues.push({
          code: 'ROOF_PLANE_SELF_INTERSECT',
          message: `Roof plane ${plane.id} boundary self-intersects in plan`,
          entityId: plane.id,
        });
      }
    }

    for (const edge of assembly.edges ?? []) {
      const len = Math.hypot(
        edge.end.x - edge.start.x,
        edge.end.y - edge.start.y,
        edge.end.z - edge.start.z,
      );
      if (len < 1e-6) {
        issues.push({
          code: 'ROOF_EDGE_DEGENERATE',
          message: `Roof edge ${edge.id} has zero length`,
          entityId: edge.id,
        });
      }
      for (const pid of edge.planeIds ?? []) {
        if (!planeIds.has(pid)) {
          issues.push({
            code: 'ROOF_EDGE_PLANE_REF',
            message: `Roof edge ${edge.id} references missing plane ${pid}`,
            entityId: edge.id,
          });
        }
      }
      if (
        (edge.kind === 'ridge' ||
          edge.kind === 'valley' ||
          edge.kind === 'hip' ||
          edge.kind === 'shared') &&
        (edge.planeIds?.length ?? 0) < 2
      ) {
        issues.push({
          code: 'ROOF_EDGE_RELATION',
          message: `Roof edge ${edge.id} (${edge.kind}) should reference two planes`,
          entityId: edge.id,
        });
      }
    }

    // Mass plane refs
    for (const mass of assembly.masses ?? []) {
      for (const pid of mass.planeIds ?? []) {
        if (!planeIds.has(pid)) {
          issues.push({
            code: 'ROOF_MASS_PLANE_REF',
            message: `Roof mass ${mass.id} references missing plane ${pid}`,
            entityId: mass.id,
          });
        }
      }
    }

    // Disconnected assembly: every plane should share an edge or mass with another when multi-plane
    if ((assembly.planes ?? []).length > 1 && (assembly.edges ?? []).length === 0) {
      issues.push({
        code: 'ROOF_ASSEMBLY_DISCONNECTED',
        message: `Roof assembly ${assembly.id} has multiple planes but no edges`,
        entityId: assembly.id,
      });
    }

    // Footprint relationship: plane centroids should not be wildly outside shell
    if (shell) {
      const margin = Math.max(shell.width, shell.depth);
      for (const plane of assembly.planes ?? []) {
        const boundary = plane.boundary ?? [];
        if (boundary.length === 0) continue;
        const cx = boundary.reduce((s, p) => s + p.x, 0) / boundary.length;
        const cz = boundary.reduce((s, p) => s + p.z, 0) / boundary.length;
        if (Math.abs(cx) > margin || Math.abs(cz) > margin) {
          issues.push({
            code: 'ROOF_FOOTPRINT',
            message: `Roof plane ${plane.id} centroid is far outside the building footprint`,
            entityId: plane.id,
          });
        }
      }
    }

    // Composed: zero-area, valleys, recompile consistency, interpenetration
    if (assembly.source === 'composed' && assembly.masses.length >= 2) {
      for (const plane of assembly.planes) {
        if (polygonArea3(plane.boundary) < 1e-5) {
          issues.push({
            code: 'ROOF_PLANE_DEGENERATE',
            message: `Roof plane ${plane.id} has zero area after clipping`,
            entityId: plane.id,
          });
        }
      }

      const valleys = assembly.edges.filter((e) => e.kind === 'valley' || e.kind === 'shared');
      if (valleys.length === 0) {
        issues.push({
          code: 'ROOF_INTERSECT_FAILED',
          message: `Composed assembly ${assembly.id} is missing valley/shared intersection edges`,
          entityId: assembly.id,
        });
      }
      for (const e of valleys) {
        const dx = e.end.x - e.start.x;
        const dy = e.end.y - e.start.y;
        const dz = e.end.z - e.start.z;
        if (Math.hypot(dx, dy, dz) < 1e-4) {
          issues.push({
            code: 'ROOF_EDGE_DEGENERATE',
            message: `Valley edge ${e.id} has invalid/zero-length endpoints`,
            entityId: e.id,
          });
        }
      }

      try {
        const again = recompileRoofAssembly({
          ...assembly,
          planes: [],
          edges: [],
        }).assembly;
        if (again.planes.length !== assembly.planes.length) {
          issues.push({
            code: 'ROOF_DERIVED_MISMATCH',
            message: `Assembly ${assembly.id} derived plane count does not match recompile from authoring`,
            entityId: assembly.id,
          });
        }
      } catch (err) {
        if (err instanceof RoofIntersectionError) {
          issues.push({
            code: err.code,
            message: err.message,
            entityId: assembly.id,
          });
        } else {
          issues.push({
            code: 'ROOF_INTERSECT_FAILED',
            message: err instanceof Error ? err.message : 'Roof recompile failed',
            entityId: assembly.id,
          });
        }
      }

      const penet = assertNoInterpenetration(assembly, 12);
      if (!penet.ok) {
        issues.push({
          code: 'ROOF_INTERPENETRATION',
          message: `Composed assembly ${assembly.id} has interpenetrating roof surfaces`,
          entityId: assembly.id,
        });
      }
    }
  }

  return issues;
}

/** Detect footprint edits that invalidate composed roof mass layouts. */
export function validateComposedRoofFootprintOps(
  model: BuildingModelV1,
  ops: DesignOperation[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const shell = extractShellFromModel(model);
  if (!shell) return issues;

  for (const op of ops) {
    if (op.op !== 'updateBuildingDimensions') continue;
    const nextW = op.width ?? shell.width;
    const nextD = op.depth ?? shell.depth;
    if (
      Math.abs(nextW - shell.width) < 1e-6 &&
      Math.abs(nextD - shell.depth) < 1e-6
    ) {
      continue;
    }
    const conflict = composedRoofFootprintConflict(model, {
      width: nextW,
      depth: nextD,
    });
    if (conflict) {
      issues.push({
        code: 'COMPOSED_ROOF_RELAYOUT_REQUIRED',
        message: conflict.message,
        entityId: conflict.assemblyId,
      });
    }
  }
  return issues;
}

function planPolygonSelfIntersects(
  boundary: Array<{ x: number; y: number; z: number }>,
): boolean {
  const n = boundary.length;
  const segIntersect = (
    a: { x: number; z: number },
    b: { x: number; z: number },
    c: { x: number; z: number },
    d: { x: number; z: number },
  ) => {
    const cross = (p: { x: number; z: number }, q: { x: number; z: number }, r: { x: number; z: number }) =>
      (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
    const d1 = cross(a, b, c);
    const d2 = cross(a, b, d);
    const d3 = cross(c, d, a);
    const d4 = cross(c, d, b);
    return d1 * d2 < 0 && d3 * d4 < 0;
  };
  for (let i = 0; i < n; i++) {
    const a = boundary[i]!;
    const b = boundary[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1) || (j === 0 && i === n - 1)) {
        continue;
      }
      // Also skip adjacent wrap pairs
      if ((i + 1) % n === j || (j + 1) % n === i) continue;
      const c = boundary[j]!;
      const d = boundary[(j + 1) % n]!;
      if (segIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

export function validateOpeningsInWalls(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const shell = extractShellFromModel(model);
  if (!shell) return issues;
  const primaryId = model.levels[0]?.id;
  for (const o of shell.openings) {
    const wallLen = wallLengthForFace(shell, o.wall);
    const levelId = o.levelId ?? primaryId;
    const storyHeight =
      model.levels.find((l) => l.id === levelId)?.height ?? shell.wallHeight;
    if (o.offset < -0.01) {
      issues.push({
        code: 'OPENING_BOUNDS',
        message: `Opening ${o.id} has negative offset on ${o.wall} wall`,
        entityId: o.id,
      });
    }
    if (o.offset + o.width > wallLen + 0.01) {
      issues.push({
        code: 'OPENING_BOUNDS',
        message: `Opening ${o.id} extends past ${o.wall} wall (${o.offset}+${o.width} > ${wallLen})`,
        entityId: o.id,
      });
    }
    if (o.sillHeight < -0.01) {
      issues.push({
        code: 'OPENING_HEIGHT',
        message: `Opening ${o.id} has negative sill height`,
        entityId: o.id,
      });
    }
    if (o.sillHeight + o.height > storyHeight + 0.01) {
      issues.push({
        code: 'OPENING_HEIGHT',
        message: `Opening ${o.id} exceeds story height (sill ${o.sillHeight} + height ${o.height} > ${storyHeight})`,
        entityId: o.id,
      });
    }
  }
  return issues;
}

/** Reject overlapping openings on the same wall face (horizontal + vertical AABB). */
export function validateOpeningOverlaps(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const shell = extractShellFromModel(model);
  if (!shell) return issues;

  const eps = 0.01;
  const primaryId = model.levels[0]?.id ?? 'level-1';
  const byWall = new Map<string, typeof shell.openings>();
  for (const o of shell.openings) {
    const key = `${o.wall}::${o.levelId ?? primaryId}`;
    const list = byWall.get(key) ?? [];
    list.push(o);
    byWall.set(key, list);
  }

  for (const [wall, openings] of byWall) {
    for (let i = 0; i < openings.length; i++) {
      for (let j = i + 1; j < openings.length; j++) {
        const a = openings[i]!;
        const b = openings[j]!;
        const hOverlap =
          a.offset < b.offset + b.width - eps && b.offset < a.offset + a.width - eps;
        const vOverlap =
          a.sillHeight < b.sillHeight + b.height - eps &&
          b.sillHeight < a.sillHeight + a.height - eps;
        if (hOverlap && vOverlap) {
          issues.push({
            code: 'OPENING_OVERLAP',
            message: `Openings ${a.id} and ${b.id} overlap on the ${wall} wall`,
            entityId: a.id,
          });
        }
      }
    }
  }
  return issues;
}

export function validateLevels(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (model.levels.length < 1) {
    issues.push({ code: 'LEVEL_REQUIRED', message: 'Building must have at least one level' });
    return issues;
  }

  const seen = new Set<string>();
  for (const level of model.levels) {
    if (seen.has(level.id)) {
      issues.push({
        code: 'LEVEL_DUPLICATE_ID',
        message: `Duplicate level id: ${level.id}`,
        entityId: level.id,
      });
    }
    seen.add(level.id);
    if (!(level.height > 0)) {
      issues.push({
        code: 'LEVEL_HEIGHT',
        message: `Level ${level.id} height must be positive`,
        entityId: level.id,
      });
    }
    if (!Number.isFinite(level.elevation)) {
      issues.push({
        code: 'LEVEL_ELEVATION',
        message: `Level ${level.id} elevation is invalid`,
        entityId: level.id,
      });
    }
  }

  // Overlapping story ranges (same footprint stacking): warn/error when ranges intersect.
  const sorted = [...model.levels].sort((a, b) => a.elevation - b.elevation);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      const aTop = a.elevation + a.height;
      const bTop = b.elevation + b.height;
      const overlap = a.elevation < bTop - 1e-6 && b.elevation < aTop - 1e-6;
      if (overlap) {
        issues.push({
          code: 'LEVEL_RANGE_OVERLAP',
          message: `Levels ${a.id} and ${b.id} have overlapping vertical ranges`,
          entityId: a.id,
        });
      }
    }
  }

  const levelIds = new Set(model.levels.map((l) => l.id));
  for (const wall of model.walls) {
    if (!levelIds.has(wall.levelId)) {
      issues.push({
        code: 'LEVEL_REF',
        message: `Wall ${wall.id} references missing level ${wall.levelId}`,
        entityId: wall.id,
      });
    }
  }
  for (const space of model.spaces) {
    if (!levelIds.has(space.levelId)) {
      issues.push({
        code: 'LEVEL_REF',
        message: `Space ${space.id} references missing level ${space.levelId}`,
        entityId: space.id,
      });
    }
  }
  for (const slab of model.slabs) {
    if (!levelIds.has(slab.levelId)) {
      issues.push({
        code: 'LEVEL_REF',
        message: `Slab ${slab.id} references missing level ${slab.levelId}`,
        entityId: slab.id,
      });
    }
  }
  for (const roof of model.roofs) {
    if (!levelIds.has(roof.levelId)) {
      issues.push({
        code: 'LEVEL_REF',
        message: `Roof ${roof.id} references missing level ${roof.levelId}`,
        entityId: roof.id,
      });
    }
  }
  for (const assembly of model.roofAssemblies ?? []) {
    if (!levelIds.has(assembly.levelId)) {
      issues.push({
        code: 'LEVEL_REF',
        message: `Roof assembly ${assembly.id} references missing level ${assembly.levelId}`,
        entityId: assembly.id,
      });
    }
  }
  for (const e of model.entities ?? []) {
    if (e.levelId && !levelIds.has(e.levelId) && e.type !== 'level') {
      issues.push({
        code: 'LEVEL_REF',
        message: `Entity ${e.id} references missing level ${e.levelId}`,
        entityId: e.id,
      });
    }
  }
  for (const o of model.shell?.openings ?? []) {
    if (o.levelId && !levelIds.has(o.levelId)) {
      issues.push({
        code: 'LEVEL_REF',
        message: `Shell opening ${o.id} references missing level ${o.levelId}`,
        entityId: o.id,
      });
    }
  }

  return issues;
}

export function validateParentRefs(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set((model.entities ?? []).map((e) => e.id));
  for (const e of model.entities ?? []) {
    if (e.parentId && !ids.has(e.parentId) && !model.walls.some((w) => w.id === e.parentId)) {
      issues.push({
        code: 'PARENT_REF',
        message: `Entity ${e.id} references missing parent ${e.parentId}`,
        entityId: e.id,
      });
    }
  }
  return issues;
}

export function validateProtectedOps(
  model: BuildingModelV1,
  ops: DesignOperation[],
): ValidationIssue[] {
  const protectedIds = new Set(model.protectedEntityIds ?? []);
  if (protectedIds.size === 0) return [];
  const issues: ValidationIssue[] = [];

  const touchesProtected = (id: string) => protectedIds.has(id);

  for (const op of ops) {
    if (op.op === 'updateBuildingDimensions' && protectedIds.has('shell-1')) {
      // Footprint protection: block width/depth changes, allow wallHeight
      if (op.width != null || op.depth != null) {
        issues.push({
          code: 'PROTECTED',
          message: 'Footprint is protected — width/depth cannot change',
          entityId: 'shell-1',
        });
      }
    }
    if (
      (op.op === 'updateEntity' ||
        op.op === 'moveEntity' ||
        op.op === 'resizeEntity' ||
        op.op === 'deleteEntity' ||
        op.op === 'setMaterial') &&
      'entityId' in op &&
      touchesProtected(op.entityId)
    ) {
      issues.push({
        code: 'PROTECTED',
        message: `Entity ${op.entityId} is protected`,
        entityId: op.entityId,
      });
    }
    if (op.op === 'deleteEntity' && touchesProtected(op.entityId)) {
      issues.push({
        code: 'PROTECTED',
        message: `Cannot delete protected entity ${op.entityId}`,
        entityId: op.entityId,
      });
    }
    if (
      (op.op === 'updateWall' || op.op === 'deleteWall') &&
      touchesProtected(op.wallId)
    ) {
      issues.push({
        code: 'PROTECTED',
        message: `Wall ${op.wallId} is protected`,
        entityId: op.wallId,
      });
    }
    if (
      (op.op === 'updateSpace' || op.op === 'deleteSpace') &&
      touchesProtected(op.spaceId)
    ) {
      issues.push({
        code: 'PROTECTED',
        message: `Space ${op.spaceId} is protected`,
        entityId: op.spaceId,
      });
    }
    if (
      (op.op === 'updateStair' || op.op === 'deleteStair') &&
      touchesProtected(op.stairId)
    ) {
      issues.push({
        code: 'PROTECTED',
        message: `Stair ${op.stairId} is protected`,
        entityId: op.stairId,
      });
    }
  }

  // Exterior walls protected as footprint
  for (const op of ops) {
    if (op.op === 'updateBuildingDimensions') continue;
    if ('entityId' in op && typeof op.entityId === 'string') {
      const ent = getEntity(model, op.entityId);
      if (ent?.type === 'exteriorWall' && protectedIds.has(ent.id)) {
        issues.push({
          code: 'PROTECTED',
          message: `Wall ${ent.id} is protected (footprint)`,
          entityId: ent.id,
        });
      }
    }
  }

  return issues;
}

function wallLength(wall: { start: { x: number; y: number }; end: { x: number; y: number } }) {
  return Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
}

/** True when segments cross in their interiors (T-junctions / shared endpoints allowed). */
function segmentsCrossMidspan(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number },
): boolean {
  const dxA = a2.x - a1.x;
  const dyA = a2.y - a1.y;
  const dxB = b2.x - b1.x;
  const dyB = b2.y - b1.y;
  const denom = dxA * dyB - dyA * dxB;
  if (Math.abs(denom) < 1e-9) return false; // parallel / colinear — not a mid-span X
  const t = ((b1.x - a1.x) * dyB - (b1.y - a1.y) * dxB) / denom;
  const u = ((b1.x - a1.x) * dyA - (b1.y - a1.y) * dxA) / denom;
  const eps = 0.02;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

export function validateWallGeometry(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const eps = 0.01;
  for (const wall of model.walls) {
    if (wallLength(wall) < eps) {
      issues.push({
        code: 'WALL_ZERO_LENGTH',
        message: `Wall ${wall.id} has zero (or near-zero) length`,
        entityId: wall.id,
      });
    }
    if (!(wall.thickness > 0)) {
      issues.push({
        code: 'WALL_THICKNESS',
        message: `Wall ${wall.id} thickness must be positive`,
        entityId: wall.id,
      });
    }
  }
  for (let i = 0; i < model.walls.length; i++) {
    for (let j = i + 1; j < model.walls.length; j++) {
      const a = model.walls[i]!;
      const b = model.walls[j]!;
      // Plan intersections only matter within a story; stacked levels share plan X/Z.
      if (a.levelId !== b.levelId) continue;
      if (segmentsCrossMidspan(a.start, a.end, b.start, b.end)) {
        issues.push({
          code: 'WALL_INTERSECTION',
          message: `Walls ${a.id} and ${b.id} cross mid-span (invalid X intersection)`,
          entityId: a.id,
        });
      }
    }
  }
  return issues;
}

function polygonArea(poly: Array<{ x: number; y: number }>): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function polygonSelfIntersects(poly: Array<{ x: number; y: number }>): boolean {
  const n = poly.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = poly[i]!;
    const a2 = poly[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      if ((j + 1) % n === i || (i + 1) % n === j || Math.abs(i - j) <= 1) continue;
      if (i === 0 && j === n - 1) continue;
      const b1 = poly[j]!;
      const b2 = poly[(j + 1) % n]!;
      if (segmentsCrossMidspan(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

export function validateSpaceGeometry(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const space of model.spaces) {
    if (space.polygon.length < 3) {
      issues.push({
        code: 'SPACE_POLYGON',
        message: `Space ${space.id} polygon needs at least 3 points`,
        entityId: space.id,
      });
      continue;
    }
    const area = Math.abs(polygonArea(space.polygon));
    if (area < 0.5) {
      issues.push({
        code: 'SPACE_AREA',
        message: `Space ${space.id} polygon area is too small (${area.toFixed(2)} sf)`,
        entityId: space.id,
      });
    }
    if (polygonSelfIntersects(space.polygon)) {
      issues.push({
        code: 'SPACE_SELF_INTERSECT',
        message: `Space ${space.id} polygon self-intersects`,
        entityId: space.id,
      });
    }
    const levelFp = resolveLevelFootprint(model, space.levelId);
    if (levelFp) {
      for (const p of space.polygon) {
        if (!pointInFootprint(p, levelFp, 0.05)) {
          issues.push({
            code: 'SPACE_OUTSIDE_FOOTPRINT',
            message: `Space ${space.id} has a vertex outside level ${space.levelId} footprint`,
            entityId: space.id,
          });
          break;
        }
      }
    }
  }
  return issues;
}

export function validateHostedOpenings(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const wallIds = new Set(model.walls.map((w) => w.id));
  for (const opening of model.openings) {
    if (!wallIds.has(opening.wallId)) {
      issues.push({
        code: 'ORPHAN_OPENING',
        message: `Opening ${opening.id} references missing wall ${opening.wallId}`,
        entityId: opening.id,
      });
    }
  }
  return issues;
}

/** Interior walls must remain inside their owning level footprint. */
export function validateInteriorWallsInFootprint(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const wall of model.walls) {
    if (isShellWallId(wall.id)) continue;
    const fp = resolveLevelFootprint(model, wall.levelId);
    if (!fp) continue;
    for (const p of [wall.start, wall.end]) {
      if (!pointInFootprint(p, fp, 0.05)) {
        issues.push({
          code: 'WALL_OUTSIDE_FOOTPRINT',
          message: `Interior wall ${wall.id} has an endpoint outside level ${wall.levelId} footprint`,
          entityId: wall.id,
        });
        break;
      }
    }
  }
  return issues;
}

/** Placed interior objects should remain near/inside their owning level footprint. */
export function validatePlacedObjectsInFootprint(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const e of model.entities ?? []) {
    if (!isInteriorObjectType(String(e.type))) continue;
    const x = Number(e.geometry.x ?? 0);
    const z = Number(e.geometry.z ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const levelId = String(e.levelId ?? model.levels[0]?.id ?? '');
    const fp = resolveLevelFootprint(model, levelId);
    if (!fp) continue;
    // Allow a small exterior margin (porch/yard objects), but flag far outliers.
    const margin = 8;
    const b = {
      minX: fp.center.x - fp.width / 2 - margin,
      maxX: fp.center.x + fp.width / 2 + margin,
      minY: fp.center.y - fp.depth / 2 - margin,
      maxY: fp.center.y + fp.depth / 2 + margin,
    };
    if (x < b.minX || x > b.maxX || z < b.minY || z > b.maxY) {
      issues.push({
        code: 'OBJECT_OUTSIDE_FOOTPRINT',
        message: `Object ${e.id} at (${x}, ${z}) is far outside level ${levelId} footprint after footprint change`,
        entityId: e.id,
      });
    }
  }
  return issues;
}

export function validateStairs(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const levelIds = new Set(model.levels.map((l) => l.id));
  const openingById = new Map((model.floorOpenings ?? []).map((o) => [o.id, o]));

  for (const stair of model.stairs ?? []) {
    if (!levelIds.has(stair.fromLevelId) || !levelIds.has(stair.toLevelId)) {
      issues.push({
        code: 'STAIR_LEVEL_MISSING',
        message: `Stair ${stair.id} references a missing level`,
        entityId: stair.id,
      });
      continue;
    }
    const from = model.levels.find((l) => l.id === stair.fromLevelId)!;
    const to = model.levels.find((l) => l.id === stair.toLevelId)!;
    const rise = to.elevation - from.elevation;
    if (!(rise > 1e-6)) {
      issues.push({
        code: 'STAIR_RISE',
        message: `Stair ${stair.id} requires toLevel above fromLevel`,
        entityId: stair.id,
        details: { rise },
      });
      continue;
    }
    if (stair.width < STAIR_DEFAULTS.minWidth - 1e-6) {
      issues.push({
        code: 'STAIR_WIDTH',
        message: `Stair ${stair.id} width below minimum ${STAIR_DEFAULTS.minWidth} ft`,
        entityId: stair.id,
      });
    }

    try {
      const derived = deriveStairGeometry(model, stair);
      if (derived.riserHeight > (stair.maxRiserHeight ?? STAIR_DEFAULTS.maxRiserHeight) + 1e-6) {
        issues.push({
          code: 'STAIR_RISER',
          message: `Stair ${stair.id} riser height exceeds maximum`,
          entityId: stair.id,
          details: { riserHeight: derived.riserHeight },
        });
      }
      if (
        derived.treadCount > 0 &&
        derived.treadDepth < STAIR_DEFAULTS.minTreadDepth - 1e-6
      ) {
        issues.push({
          code: 'STAIR_TREAD',
          message: `Stair ${stair.id} tread depth below minimum`,
          entityId: stair.id,
          details: { treadDepth: derived.treadDepth },
        });
      }
      if (Math.abs(derived.topElevation - to.elevation) > 1e-4) {
        issues.push({
          code: 'STAIR_TOP_MISMATCH',
          message: `Stair ${stair.id} does not reach toLevel FFE`,
          entityId: stair.id,
        });
      }

      const toFp = resolveLevelFootprint(model, stair.toLevelId);
      if (toFp) {
        // Top of stair must land inside the upper level footprint.
        const topPts = derived.planPolygon;
        const outside = topPts.filter((p) => !pointInFootprint(p, toFp));
        if (outside.length > 0) {
          issues.push({
            code: 'STAIR_OUTSIDE_UPPER_FOOTPRINT',
            message: `Stair ${stair.id} does not terminate inside level ${stair.toLevelId} footprint`,
            entityId: stair.id,
            details: { outsideCount: outside.length, toFootprint: toFp },
          });
        }
      }

      if (stair.floorOpeningId) {
        const opening = openingById.get(stair.floorOpeningId);
        if (opening && toFp) {
          const openOutside = opening.polygon.filter((p) => !pointInFootprint(p, toFp));
          if (openOutside.length > 0) {
            issues.push({
              code: 'STAIR_OPENING_OUTSIDE_SLAB',
              message: `Floor opening for stair ${stair.id} extends outside level ${stair.toLevelId} footprint`,
              entityId: stair.id,
              details: { openingId: opening.id },
            });
          }
        }
      }
    } catch (err) {
      if (err instanceof StairGeometryError) {
        issues.push({
          code: err.code,
          message: err.message,
          entityId: stair.id,
          details: err.details,
        });
      } else {
        issues.push({
          code: 'STAIR_GEOMETRY',
          message: err instanceof Error ? err.message : 'Stair geometry failed',
          entityId: stair.id,
        });
      }
    }

    if (stair.floorOpeningId) {
      const opening = openingById.get(stair.floorOpeningId);
      if (!opening) {
        issues.push({
          code: 'STAIR_OPENING_MISSING',
          message: `Stair ${stair.id} missing floor opening ${stair.floorOpeningId}`,
          entityId: stair.id,
        });
      } else if (opening.levelId !== stair.toLevelId) {
        issues.push({
          code: 'STAIR_OPENING_LEVEL',
          message: `Floor opening for stair ${stair.id} must be on toLevel`,
          entityId: stair.id,
        });
      }
    }
  }

  for (const opening of model.floorOpenings ?? []) {
    if (!levelIds.has(opening.levelId)) {
      issues.push({
        code: 'FLOOR_OPENING_LEVEL',
        message: `Floor opening ${opening.id} references missing level`,
        entityId: opening.id,
      });
    }
    if (opening.polygon.length < 3) {
      issues.push({
        code: 'FLOOR_OPENING_POLYGON',
        message: `Floor opening ${opening.id} needs a valid polygon`,
        entityId: opening.id,
      });
    }
  }

  return issues;
}

export function validateLevelFootprints(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const level of model.levels) {
    if (level.footprintSource === 'custom') {
      if (!level.footprint) {
        issues.push({
          code: 'LEVEL_FOOTPRINT_MISSING',
          message: `Level ${level.id} is custom but has no footprint`,
          entityId: level.id,
        });
        continue;
      }
      try {
        LevelFootprintRectSchema.parse(level.footprint);
      } catch {
        issues.push({
          code: 'LEVEL_FOOTPRINT_INVALID',
          message: `Level ${level.id} has an invalid custom footprint`,
          entityId: level.id,
        });
      }
      const walls = model.walls.filter((w) => w.levelId === level.id);
      if (walls.length < 4) {
        issues.push({
          code: 'LEVEL_FOOTPRINT_WALLS',
          message: `Custom level ${level.id} should have exterior walls regenerated from its footprint`,
          entityId: level.id,
          details: { wallCount: walls.length },
        });
      }
      const slab = model.slabs.find((s) => s.levelId === level.id);
      if (!slab) {
        issues.push({
          code: 'LEVEL_FOOTPRINT_SLAB',
          message: `Custom level ${level.id} is missing a slab`,
          entityId: level.id,
        });
      }
    } else if (level.footprint) {
      issues.push({
        code: 'LEVEL_FOOTPRINT_IGNORED',
        message: `Level ${level.id} is shell-backed; footprint field is ignored`,
        entityId: level.id,
        severity: 'warning',
      });
    }
  }

  for (const uncovered of uncoveredExposedLowerRegions(model)) {
    issues.push({
      code: 'EXPOSED_LOWER_ROOF',
      message:
        'Upper story covers only part of the level below. Exposed region still needs lower roof coverage.',
      entityId: uncovered.upperLevelId,
      severity: 'warning',
      details: {
        regionId: uncovered.id,
        lowerLevelId: uncovered.lowerLevelId,
        upperLevelId: uncovered.upperLevelId,
        side: uncovered.side,
        footprint: uncovered.footprint,
        coverageRatio: uncovered.coverage.coverageRatio,
      },
    });
  }

  return issues;
}

export function validateLowerRoofs(model: BuildingModelV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const assemblies = (model.roofAssemblies ?? []).map((a) =>
    RoofAssemblySchema.parse(a),
  );

  for (const assembly of assemblies) {
    if (!isLowerRoofAssembly(assembly, model)) continue;
    const lowerFp = resolveLevelFootprint(model, assembly.levelId);
    const lowerLevel = model.levels
      .map((l) => LevelSchema.parse(l))
      .find((l) => l.id === assembly.levelId);
    const expectedEave = lowerLevel ? levelTopElevation(lowerLevel) : null;
    const upper = [...model.levels]
      .map((l) => LevelSchema.parse(l))
      .filter((l) => l.id !== assembly.levelId)
      .sort((a, b) => b.elevation - a.elevation)[0];
    const upperFp = upper ? resolveLevelFootprint(model, upper.id) : null;

    for (const mass of assembly.masses ?? []) {
      const gen = mass.generator;
      if (!gen) continue;
      if (lowerFp && massOutsideLowerFootprint(gen, lowerFp)) {
        issues.push({
          code: 'LOWER_ROOF_OUTSIDE_FOOTPRINT',
          message: `Lower roof mass ${mass.id} extends outside level ${assembly.levelId} footprint`,
          entityId: mass.id,
        });
      }
      if (upperFp && massOverlapsUpperFootprint(gen, upperFp)) {
        issues.push({
          code: 'LOWER_ROOF_OVERLAPS_UPPER',
          message: `Lower roof mass ${mass.id} overlaps the upper-story footprint`,
          entityId: mass.id,
        });
      }
      if (
        expectedEave != null &&
        Math.abs(gen.eaveHeight - expectedEave) > 1.5
      ) {
        issues.push({
          code: 'LOWER_ROOF_EAVE',
          message: `Lower roof mass ${mass.id} eaveHeight ${gen.eaveHeight} ft should be near ${expectedEave} ft`,
          entityId: mass.id,
        });
      }
    }
  }

  return issues;
}

export function runDesignValidators(
  model: BuildingModelV1,
  ops: DesignOperation[],
): ValidationIssue[] {
  return [
    ...validateProtectedOps(model, ops),
    ...validatePositiveDimensions(model, ops),
    ...validateRoofPitch(model),
    ...validateRoofOverhang(model),
    ...validateRoofAssemblies(model),
    ...validateLowerRoofs(model),
    ...validateComposedRoofFootprintOps(model, ops),
    ...validateOpeningsInWalls(model),
    ...validateOpeningOverlaps(model),
    ...validateLevels(model),
    ...validateLevelFootprints(model),
    ...validateStairs(model),
    ...validateWallGeometry(model),
    ...validateInteriorWallsInFootprint(model),
    ...validateSpaceGeometry(model),
    ...validatePlacedObjectsInFootprint(model),
    ...validateHostedOpenings(model),
    ...validateParentRefs(model),
  ];
}
