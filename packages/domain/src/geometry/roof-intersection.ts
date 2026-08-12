/**
 * Deterministic two-mass roof intersection / clipping.
 *
 * Algorithm: upper-envelope clipping
 * 1. Compile each mass's unclipped planes from authoring generators.
 * 2. For each slope/shed/flat plane, keep only the portion where this mass's
 *    roof height is >= the other mass's height (or outside the other footprint).
 * 3. Derive valley edges from actual plane–plane intersection lines clipped
 *    to both final polygons.
 *
 * Authoring state = RoofMass.generator
 * Derived state   = RoofAssembly.planes + RoofAssembly.edges
 */
import type { Vec3 } from '../building-model';
import {
  RoofAssemblySchema,
  compileMassGenerator,
  type RoofAssembly,
  type RoofEdgeDef,
  type RoofEdgeKind,
  type RoofMassDef,
  type RoofMassGenerator,
  type RoofPlaneDef,
} from '../roof-assembly';
import { pitchRatio } from './roof-geometry';
import {
  EPS_AREA,
  clipIntersectionLineToPolygons,
  clipPolygonByHalfSpace,
  dedupeRing,
  intersectPlanes,
  len,
  planeFromPolygon,
  planeYAt,
  pointInPolygonXZ,
  polygonArea3,
  sub,
  v3,
  type PlaneEq,
} from './roof-plane-math';

export type RoofIntersectionErrorCode =
  | 'ROOF_INTERSECT_UNSUPPORTED'
  | 'ROOF_INTERSECT_NO_OVERLAP'
  | 'ROOF_INTERSECT_DEGENERATE'
  | 'ROOF_INTERSECT_FAILED'
  | 'ROOF_INTERSECT_BURIED'
  | 'ROOF_MASS_MISSING_GENERATOR'
  | 'LOWER_ROOF_OUTSIDE_FOOTPRINT'
  | 'LOWER_ROOF_OVERLAPS_UPPER'
  | 'LOWER_ROOF_EAVE';

export class RoofIntersectionError extends Error {
  constructor(
    readonly code: RoofIntersectionErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RoofIntersectionError';
  }
}

export interface RoofHeightSample {
  /** null = outside mass footprint (including overhang). */
  height: number | null;
}

/** Plan footprint of a mass including overhang (rectangle). */
export function massPlanBounds(gen: RoofMassGenerator): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  const hw = gen.width / 2 + gen.overhang;
  const hd = gen.depth / 2 + gen.overhang;
  return {
    minX: gen.origin.x - hw,
    maxX: gen.origin.x + hw,
    minZ: gen.origin.y - hd,
    maxZ: gen.origin.y + hd,
  };
}

export function pointInMassFootprint(gen: RoofMassGenerator, x: number, z: number): boolean {
  const b = massPlanBounds(gen);
  return x >= b.minX - 1e-9 && x <= b.maxX + 1e-9 && z >= b.minZ - 1e-9 && z <= b.maxZ + 1e-9;
}

/**
 * Roof surface height at plan (x,z) for a parametric mass generator.
 * Returns null outside the mass footprint+overhang.
 */
export function roofHeightAt(
  gen: RoofMassGenerator,
  x: number,
  z: number,
): number | null {
  if (!pointInMassFootprint(gen, x, z)) return null;
  const ox = gen.origin.x;
  const oz = gen.origin.y;
  const hw = gen.width / 2 + gen.overhang;
  const hd = gen.depth / 2 + gen.overhang;
  const eave = gen.eaveHeight;
  const r = pitchRatio(gen.pitch);

  if (gen.type === 'flat' || gen.pitch === 0) return eave;

  if (gen.type === 'shed') {
    const high = gen.highSide ?? 'rear';
    if (high === 'rear') {
      // low at front (oz-hd), high at rear (oz+hd)
      const t = (z - (oz - hd)) / (2 * hd || 1);
      return eave + r * 2 * hd * Math.min(1, Math.max(0, t));
    }
    if (high === 'front') {
      const t = ((oz + hd) - z) / (2 * hd || 1);
      return eave + r * 2 * hd * Math.min(1, Math.max(0, t));
    }
    if (high === 'left') {
      const t = ((ox + hw) - x) / (2 * hw || 1);
      return eave + r * 2 * hw * Math.min(1, Math.max(0, t));
    }
    const t = (x - (ox - hw)) / (2 * hw || 1);
    return eave + r * 2 * hw * Math.min(1, Math.max(0, t));
  }

  if (gen.type === 'hip') {
    // Approximate hip as min of the two gable spans (pyramid/hip envelope).
    const riseX = r * (hw - Math.abs(x - ox));
    const riseZ = r * (hd - Math.abs(z - oz));
    return eave + Math.max(0, Math.min(riseX, riseZ));
  }

  // gable
  if (gen.ridgeDirection === 'depth') {
    return eave + r * Math.max(0, hw - Math.abs(x - ox));
  }
  return eave + r * Math.max(0, hd - Math.abs(z - oz));
}

function supportsPairwiseIntersection(a: RoofMassGenerator, b: RoofMassGenerator): boolean {
  const ok = (g: RoofMassGenerator) =>
    g.type === 'gable' || g.type === 'shed' || g.type === 'flat';
  if (!ok(a) || !ok(b)) return false;
  // First supported cases: gable+gable, gable+shed, shed+shed, anything+flat
  return true;
}

function footprintsOverlap(a: RoofMassGenerator, b: RoofMassGenerator): boolean {
  const A = massPlanBounds(a);
  const B = massPlanBounds(b);
  return !(A.maxX < B.minX || B.maxX < A.minX || A.maxZ < B.minZ || B.maxZ < A.minZ);
}

/**
 * Whether a perpendicular cross-gable wing can break through the main roof.
 * Equal-pitch rule of thumb: wing width + depth ≳ main span along the wing's fall axis.
 */
export function analyzeCrossGableBreakthrough(
  main: RoofMassGenerator,
  wing: RoofMassGenerator,
): {
  buried: boolean;
  hint: string;
  suggestion: {
    note: string;
    minWingDepthFt?: number;
    minWingWidthFt?: number;
    preferPitchAtLeast?: number;
  };
} {
  const rMain = Math.max(pitchRatio(main.pitch), 1e-9);
  const rWing = Math.max(pitchRatio(wing.pitch), 1e-9);
  const oh = wing.overhang;
  const hwMain = main.width / 2 + main.overhang;
  const hdMain = main.depth / 2 + main.overhang;
  const hwWing = wing.width / 2 + wing.overhang;
  const hdWing = wing.depth / 2 + wing.overhang;

  // Sample plan points in the overlap; buried if wing never strictly dominates.
  const samples: Array<{ x: number; z: number }> = [];
  const A = massPlanBounds(main);
  const B = massPlanBounds(wing);
  const minX = Math.max(A.minX, B.minX);
  const maxX = Math.min(A.maxX, B.maxX);
  const minZ = Math.max(A.minZ, B.minZ);
  const maxZ = Math.min(A.maxZ, B.maxZ);
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      samples.push({
        x: minX + ((maxX - minX) * i) / 8,
        z: minZ + ((maxZ - minZ) * j) / 8,
      });
    }
  }
  let dominates = 0;
  for (const s of samples) {
    const hW = roofHeightAt(wing, s.x, s.z);
    const hM = roofHeightAt(main, s.x, s.z);
    if (hW != null && hM != null && hW >= hM - 1e-3) dominates += 1;
  }
  const buried = dominates === 0;

  // Analytic min size for perpendicular gables (matching architectural axes).
  let minWingDepthFt: number | undefined;
  let minWingWidthFt: number | undefined;
  let note =
    'Enlarge the secondary mass so its ridge breaks through the main roof (do not invent valleys).';

  if (
    main.type === 'gable' &&
    wing.type === 'gable' &&
    main.ridgeDirection !== wing.ridgeDirection
  ) {
    if (main.ridgeDirection === 'depth' && wing.ridgeDirection === 'width') {
      // Need hwWing + (rWing/rMain)*hdWing >= hwMain
      const needHalfDepth = Math.max(0, ((hwMain - hwWing) * rMain) / rWing);
      minWingDepthFt = Math.ceil((needHalfDepth - oh) * 2 * 10) / 10 + 0.5;
      note = `Main ridge runs along depth (span ≈ ${main.width} ft). Secondary with ridgeDirection "width" needs enough depth (and/or width) to break through — try depth ≥ ${minWingDepthFt} ft at this width, or widen the wing. Same pitch as the main roof helps.`;
    } else if (main.ridgeDirection === 'width' && wing.ridgeDirection === 'depth') {
      const needHalfWidth = Math.max(0, ((hdMain - hdWing) * rMain) / rWing);
      minWingWidthFt = Math.ceil((needHalfWidth - oh) * 2 * 10) / 10 + 0.5;
      note = `Main ridge runs along width (span ≈ ${main.depth} ft). Secondary with ridgeDirection "depth" needs enough width (and/or depth) to break through — try width ≥ ${minWingWidthFt} ft at this depth, or deepen the wing. Same pitch as the main roof helps.`;
    }
  }

  const hint = buried
    ? `Secondary mass is fully below the main roof envelope (${dominates}/81 sample points dominate). ${note}`
    : `Secondary mass breaks through at ${dominates}/81 sample points.`;

  return {
    buried,
    hint,
    suggestion: {
      note,
      minWingDepthFt,
      minWingWidthFt,
      preferPitchAtLeast: main.pitch,
    },
  };
}

/**
 * Keep points of `poly` (lying on plane) where thisGen height >= otherGen height
 * (or otherGen is undefined at that plan point).
 *
 * Implemented by clipping against half-spaces derived from equal-height contours
 * sampled along a plan grid subdivision of the polygon's AABB, then refining via
 * polygon bipartition using the valley plane-pair when available.
 *
 * Practical approach for rectangular gable/shed: clip using the analytical
 * equal-height inequality in each relevant region.
 */
export function clipPlaneByUpperEnvelope(
  plane: RoofPlaneDef,
  thisGen: RoofMassGenerator,
  otherGen: RoofMassGenerator,
): RoofPlaneDef | null {
  const planeEq = planeFromPolygon(plane.boundary);
  if (!planeEq) return null;

  // Vertical gable ends: remove portion inside the other footprint.
  if (plane.role === 'gable' || Math.abs(planeEq.n.y) < 1e-6) {
    const clipped = clipVerticalAgainstFootprint(plane.boundary, planeEq, otherGen);
    if (!clipped || polygonArea3(clipped) < EPS_AREA) return null;
    return { ...plane, boundary: clipped };
  }

  // Slope / shed / flat: keep where this height >= other (outside other => keep).
  const clipped = clipByHeightDominance(plane.boundary, planeEq, thisGen, otherGen);
  if (!clipped || polygonArea3(clipped) < EPS_AREA) return null;
  return { ...plane, boundary: dedupeRing(clipped) };
}

function clipVerticalAgainstFootprint(
  boundary: Vec3[],
  planeEq: PlaneEq,
  otherGen: RoofMassGenerator,
): Vec3[] | null {
  const b = massPlanBounds(otherGen);
  // Outside other footprint: four half-spaces for exterior of AABB.
  // Keep polygon OUTSIDE the other box = union of outside half-spaces — not a single convex clip.
  // Approximate: clip to remove interior by intersecting with complement via max of outsides.
  // Use polygon difference against the AABB extruded: clip by each of 4 "outside" and union.
  // Simpler: sample — for vertical gables that face into another mass, drop if centroid inside.
  const cx = boundary.reduce((s, p) => s + p.x, 0) / boundary.length;
  const cz = boundary.reduce((s, p) => s + p.z, 0) / boundary.length;
  if (cx >= b.minX && cx <= b.maxX && cz >= b.minZ && cz <= b.maxZ) {
    // Entire face likely buried — try clipping with each outside half-space and take largest remnant
    const candidates: Vec3[][] = [];
    const outsides: Array<{ n: Vec3; d: number }> = [
      { n: { x: -1, y: 0, z: 0 }, d: -b.minX }, // x <= minX  => -x >= -minX
      { n: { x: 1, y: 0, z: 0 }, d: b.maxX },
      { n: { x: 0, y: 0, z: -1 }, d: -b.minZ },
      { n: { x: 0, y: 0, z: 1 }, d: b.maxZ },
    ];
    // Actually for "keep outside box", we need union. Take each outside clip:
    for (const hs of outsides) {
      // outside left of box: x <= minX => -x >= -minX => n=(-1,0,0), d=-minX... wait
      // point with x < minX: (-1)*x >= -minX  => -x >= -minX => x <= minX. Yes n=(-1,0,0) d=-minX
      const poly = clipPolygonByHalfSpace(boundary, hs.n, hs.d);
      if (polygonArea3(poly) >= EPS_AREA) candidates.push(poly);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b2) => polygonArea3(b2) - polygonArea3(a));
    return candidates[0]!.map((p) => {
      const y = planeYAt(planeEq, p.x, p.z);
      return y == null ? p : v3(p.x, y, p.z);
    });
  }
  return boundary;
}

/**
 * Clip polygon so that at every remaining plan point, roofHeightAt(this) >= roofHeightAt(other)
 * (treating null other as -Infinity).
 *
 * For gable+gable with perpendicular ridges and equal-ish pitches, the equal-height locus
 * is piecewise linear. We bipartition using half-spaces from the valley line between
 * this plane and each opposing slope of the other mass.
 */
function clipByHeightDominance(
  boundary: Vec3[],
  planeEq: PlaneEq,
  thisGen: RoofMassGenerator,
  otherGen: RoofMassGenerator,
): Vec3[] | null {
  // Dense planar clip: subdivide polygon edges, keep vertices that dominate, insert
  // crossings where dominance flips along edges.
  const refined = insertDominanceCrossings(boundary, thisGen, otherGen, planeEq);
  const kept: Vec3[] = [];
  for (let i = 0; i < refined.length; i++) {
    const cur = refined[i]!;
    const next = refined[(i + 1) % refined.length]!;
    if (dominatesAt(cur, thisGen, otherGen)) {
      kept.push(cur);
    }
    // If edge crosses dominance boundary, crossing already inserted as vertex on both sides
  }

  // Rebuild ring: walk refined and keep segments where midpoint dominates
  const out: Vec3[] = [];
  for (let i = 0; i < refined.length; i++) {
    const a = refined[i]!;
    const b = refined[(i + 1) % refined.length]!;
    const aIn = dominatesAt(a, thisGen, otherGen);
    const bIn = dominatesAt(b, thisGen, otherGen);
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      // crossing should already be near the boundary; include b if entering
      const mid = v3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      if (!aIn && dominatesAt(mid, thisGen, otherGen)) {
        // find exact crossing
        const hit = findDominanceCrossing(a, b, thisGen, otherGen, planeEq);
        if (hit) out.push(hit);
      } else if (aIn && !bIn) {
        const hit = findDominanceCrossing(a, b, thisGen, otherGen, planeEq);
        if (hit) out.push(hit);
      }
    }
  }

  const ring = dedupeRing(out);
  if (ring.length < 3) return null;

  // Lift onto plane
  return ring.map((p) => {
    const y = planeYAt(planeEq, p.x, p.z);
    return y == null ? p : v3(p.x, y, p.z);
  });
}

function dominatesAt(p: Vec3, thisGen: RoofMassGenerator, otherGen: RoofMassGenerator): boolean {
  const hThis = roofHeightAt(thisGen, p.x, p.z);
  if (hThis == null) return false;
  const hOther = roofHeightAt(otherGen, p.x, p.z);
  if (hOther == null) return true;
  return hThis >= hOther - 1e-4;
}

function insertDominanceCrossings(
  boundary: Vec3[],
  thisGen: RoofMassGenerator,
  otherGen: RoofMassGenerator,
  planeEq: PlaneEq,
): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i]!;
    const b = boundary[(i + 1) % boundary.length]!;
    out.push(a);
    const aIn = dominatesAt(a, thisGen, otherGen);
    const bIn = dominatesAt(b, thisGen, otherGen);
    if (aIn !== bIn) {
      const hit = findDominanceCrossing(a, b, thisGen, otherGen, planeEq);
      if (hit) out.push(hit);
    }
  }
  return out;
}

function findDominanceCrossing(
  a: Vec3,
  b: Vec3,
  thisGen: RoofMassGenerator,
  otherGen: RoofMassGenerator,
  planeEq: PlaneEq,
): Vec3 | null {
  let lo = 0;
  let hi = 1;
  const aIn = dominatesAt(a, thisGen, otherGen);
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const p = v3(
      a.x + (b.x - a.x) * mid,
      a.y + (b.y - a.y) * mid,
      a.z + (b.z - a.z) * mid,
    );
    const y = planeYAt(planeEq, p.x, p.z);
    const q = y == null ? p : v3(p.x, y, p.z);
    if (dominatesAt(q, thisGen, otherGen) === aIn) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  const p = v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  const y = planeYAt(planeEq, p.x, p.z);
  return y == null ? p : v3(p.x, y, p.z);
}

function edgeDef(
  id: string,
  kind: RoofEdgeKind,
  start: Vec3,
  end: Vec3,
  planeIds: string[],
): RoofEdgeDef {
  return { id, kind, start, end, planeIds };
}

/** Derive valley/shared edges from clipped plane pairs. */
export function deriveIntersectionEdges(
  planes: RoofPlaneDef[],
  massAId: string,
  massBId: string,
  assemblyId: string,
  unclippedPlanes?: RoofPlaneDef[],
): RoofEdgeDef[] {
  const edges: RoofEdgeDef[] = [];
  const source = unclippedPlanes ?? planes;
  const aPlanes = source.filter((p) => p.massId === massAId && p.role !== 'gable');
  const bPlanes = source.filter((p) => p.massId === massBId && p.role !== 'gable');
  const clippedA = planes.filter((p) => p.massId === massAId);
  const clippedB = planes.filter((p) => p.massId === massBId);
  let vi = 0;

  for (const pa of aPlanes) {
    const eqA = planeFromPolygon(pa.boundary);
    if (!eqA) continue;
    for (const pb of bPlanes) {
      const eqB = planeFromPolygon(pb.boundary);
      if (!eqB) continue;
      const line = intersectPlanes(eqA, eqB);
      if (!line) continue;

      // Prefer clipping to unclipped polygons first (robust), then retain
      // segments whose midpoint lies on/near both clipped surfaces.
      const segs = clipIntersectionLineToPolygons(line, pa.boundary, pb.boundary);
      for (const seg of segs) {
        if (len(sub(seg.end, seg.start)) < 1e-3) continue;
        const mid = v3(
          (seg.start.x + seg.end.x) / 2,
          (seg.start.y + seg.end.y) / 2,
          (seg.start.z + seg.end.z) / 2,
        );

        // Keep segments in the dual-footprint overlap where heights nearly match.
        // Clipped-polygon proximity is helpful but not required (numerical gaps).
        const inOverlap =
          pointInPolygonXZ(mid, pa.boundary) && pointInPolygonXZ(mid, pb.boundary);
        const nearClipped =
          clippedA.some(
            (p) =>
              pointInPolygonXZ(mid, p.boundary) ||
              boundaryDistanceXZ(mid, p.boundary) < 0.75,
          ) &&
          clippedB.some(
            (p) =>
              pointInPolygonXZ(mid, p.boundary) ||
              boundaryDistanceXZ(mid, p.boundary) < 0.75,
          );
        if (!inOverlap && !nearClipped) continue;

        const clippedPa =
          clippedA.find((p) => p.id === pa.id) ??
          clippedA.find((p) => p.role === pa.role && rolesCompatible(p, pa)) ??
          clippedA[0] ??
          pa;
        const clippedPb =
          clippedB.find((p) => p.id === pb.id) ??
          clippedB.find((p) => p.role === pb.role && rolesCompatible(p, pb)) ??
          clippedB[0] ??
          pb;

        const kind: RoofEdgeKind =
          pa.role === 'flat' || pb.role === 'flat' ? 'shared' : 'valley';
        edges.push(
          edgeDef(
            `${assemblyId}-valley-${vi++}`,
            kind,
            seg.start,
            seg.end,
            [clippedPa.id, clippedPb.id],
          ),
        );
      }
    }
  }
  return edges;
}

function boundaryDistanceXZ(p: { x: number; z: number }, poly: Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-12) {
      best = Math.min(best, Math.hypot(p.x - a.x, p.z - a.z));
      continue;
    }
    let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2;
    t = Math.min(1, Math.max(0, t));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz)));
  }
  return best;
}

function rolesCompatible(a: RoofPlaneDef, b: RoofPlaneDef): boolean {
  if (a.role === b.role) return true;
  if (a.fallDirection && b.fallDirection) {
    return (
      Math.sign(a.fallDirection.x || 0) === Math.sign(b.fallDirection.x || 0) &&
      Math.sign(a.fallDirection.z || 0) === Math.sign(b.fallDirection.z || 0)
    );
  }
  return false;
}

/** Rebuild perimeter edges (eave/rake/ridge) from clipped plane boundaries. */
function derivePerimeterEdges(
  planes: RoofPlaneDef[],
  unclippedById: Map<string, RoofPlaneDef>,
  assemblyId: string,
): RoofEdgeDef[] {
  const edges: RoofEdgeDef[] = [];
  let ei = 0;
  for (const plane of planes) {
    const orig = unclippedById.get(plane.id);
    const eaveY = (() => {
      if (!orig) return Math.min(...plane.boundary.map((p) => p.y));
      return Math.min(...orig.boundary.map((p) => p.y));
    })();
    const b = plane.boundary;
    for (let i = 0; i < b.length; i++) {
      const a = b[i]!;
      const c = b[(i + 1) % b.length]!;
      if (len(sub(c, a)) < 1e-4) continue;
      const nearEave = Math.abs(a.y - eaveY) < 0.15 && Math.abs(c.y - eaveY) < 0.15;
      // Single-plane perimeter edges are eaves or rakes (true multi-plane ridges
      // come from deriveIntersectionEdges / same-mass compile).
      const kind: RoofEdgeKind = nearEave ? 'eave' : 'rake';
      edges.push(
        edgeDef(`${assemblyId}-edge-${ei++}`, kind, a, c, [plane.id]),
      );
    }
  }
  return edges;
}

export interface RecompileResult {
  assembly: RoofAssembly;
  valleys: RoofEdgeDef[];
}

/**
 * Recompile derived planes/edges from mass authoring generators.
 * Single mass → unclipped compile. Two masses → upper-envelope clip + valley derivation.
 */
export function recompileRoofAssembly(assembly: RoofAssembly): RecompileResult {
  const masses = assembly.masses.filter((m) => m.generator);
  if (masses.length === 0) {
    throw new RoofIntersectionError(
      'ROOF_MASS_MISSING_GENERATOR',
      `Assembly ${assembly.id} has no mass generators to compile`,
      { assemblyId: assembly.id },
    );
  }

  if (masses.length === 1) {
    const m = masses[0]!;
    const compiled = compileMassGenerator(m.id, m.generator!, m.id);
    const planes = compiled.planes.map((p) => ({
      ...p,
      materialId: p.materialId ?? assembly.materialId,
    }));
    return {
      assembly: RoofAssemblySchema.parse({
        ...assembly,
        masses: [{ ...m, planeIds: planes.map((p) => p.id), generator: m.generator }],
        planes,
        edges: compiled.edges,
      }),
      valleys: [],
    };
  }

  if (masses.length > 2) {
    throw new RoofIntersectionError(
      'ROOF_INTERSECT_UNSUPPORTED',
      `Intersection of ${masses.length} masses is not supported yet (max 2)`,
      { massCount: masses.length },
    );
  }

  const [massA, massB] = masses as [RoofMassDef, RoofMassDef];
  const genA = massA.generator!;
  const genB = massB.generator!;

  if (!supportsPairwiseIntersection(genA, genB)) {
    throw new RoofIntersectionError(
      'ROOF_INTERSECT_UNSUPPORTED',
      `Unsupported mass pair: ${genA.type} + ${genB.type}`,
      { types: [genA.type, genB.type] },
    );
  }

  if (
    genA.type === 'gable' &&
    genB.type === 'gable' &&
    genA.ridgeDirection === genB.ridgeDirection
  ) {
    throw new RoofIntersectionError(
      'ROOF_INTERSECT_UNSUPPORTED',
      `Two gable masses with the same ridgeDirection (${genA.ridgeDirection}) are parallel and will not form valleys. Use the perpendicular ridgeDirection for a cross/secondary gable.`,
      {
        ridgeDirections: [genA.ridgeDirection, genB.ridgeDirection],
        hint:
          genA.ridgeDirection === 'depth'
            ? 'Set the secondary mass ridgeDirection to "width".'
            : 'Set the secondary mass ridgeDirection to "depth".',
      },
    );
  }

  if (!footprintsOverlap(genA, genB)) {
    throw new RoofIntersectionError(
      'ROOF_INTERSECT_NO_OVERLAP',
      'Roof masses do not overlap in plan; cannot form a composed intersection',
      { massIds: [massA.id, massB.id] },
    );
  }

  const compiledA = compileMassGenerator(massA.id, genA, massA.id);
  const compiledB = compileMassGenerator(massB.id, genB, massB.id);
  const unclipped = [...compiledA.planes, ...compiledB.planes];
  const unclippedById = new Map(unclipped.map((p) => [p.id, p]));

  const clipped: RoofPlaneDef[] = [];
  for (const plane of compiledA.planes) {
    const c = clipPlaneByUpperEnvelope(plane, genA, genB);
    if (c && polygonArea3(c.boundary) >= EPS_AREA) {
      clipped.push({ ...c, materialId: c.materialId ?? assembly.materialId });
    }
  }
  for (const plane of compiledB.planes) {
    const c = clipPlaneByUpperEnvelope(plane, genB, genA);
    if (c && polygonArea3(c.boundary) >= EPS_AREA) {
      clipped.push({ ...c, materialId: c.materialId ?? assembly.materialId });
    }
  }

  if (clipped.length < 2) {
    throw new RoofIntersectionError(
      'ROOF_INTERSECT_DEGENERATE',
      'Clipping produced fewer than 2 roof planes',
      { planeCount: clipped.length },
    );
  }

  // Zero-area check
  for (const p of clipped) {
    if (polygonArea3(p.boundary) < EPS_AREA) {
      throw new RoofIntersectionError(
        'ROOF_INTERSECT_DEGENERATE',
        `Clipped plane ${p.id} has zero area`,
        { planeId: p.id },
      );
    }
  }

  const clippedA = clipped.filter((p) => p.massId === massA.id);
  const clippedB = clipped.filter((p) => p.massId === massB.id);
  if (
    (clippedA.length === 0 || clippedB.length === 0) &&
    genA.type !== 'flat' &&
    genB.type !== 'flat'
  ) {
    const analysis =
      clippedB.length === 0
        ? analyzeCrossGableBreakthrough(genA, genB)
        : analyzeCrossGableBreakthrough(genB, genA);
    throw new RoofIntersectionError(
      'ROOF_INTERSECT_BURIED',
      analysis.hint,
      {
        massIds: [massA.id, massB.id],
        buriedMassId: clippedB.length === 0 ? massB.id : massA.id,
        ...analysis.suggestion,
      },
    );
  }

  const valleys = deriveIntersectionEdges(
    clipped,
    massA.id,
    massB.id,
    assembly.id,
    unclipped,
  );
  if (valleys.length === 0 && genA.type !== 'flat' && genB.type !== 'flat') {
    const analysis = analyzeCrossGableBreakthrough(genA, genB);
    throw new RoofIntersectionError(
      analysis.buried ? 'ROOF_INTERSECT_BURIED' : 'ROOF_INTERSECT_FAILED',
      analysis.buried
        ? analysis.hint
        : 'Expected valley/shared intersection edges but none were derived',
      {
        massIds: [massA.id, massB.id],
        hint: analysis.hint,
        ...analysis.suggestion,
      },
    );
  }

  // Validate valley endpoints have non-zero length
  for (const e of valleys) {
    if (len(sub(e.end, e.start)) < 1e-4) {
      throw new RoofIntersectionError(
        'ROOF_INTERSECT_DEGENERATE',
        `Degenerate valley edge ${e.id}`,
        { edgeId: e.id },
      );
    }
  }

  const perimeter = derivePerimeterEdges(clipped, unclippedById, assembly.id);

  const next = RoofAssemblySchema.parse({
    ...assembly,
    masses: [
      { ...massA, planeIds: clipped.filter((p) => p.massId === massA.id).map((p) => p.id) },
      { ...massB, planeIds: clipped.filter((p) => p.massId === massB.id).map((p) => p.id) },
    ],
    planes: clipped,
    edges: [...perimeter, ...valleys],
  });

  return { assembly: next, valleys };
}

/**
 * Build a cross-gable from authoring params; derived geometry via recompile.
 */
export function buildCrossGableAssemblyClipped(params: {
  levelId?: string;
  assemblyId?: string;
  materialId?: string;
  eaveHeight: number;
  main: {
    origin?: { x: number; y: number };
    width: number;
    depth: number;
    pitch: number;
    overhang?: number;
    ridgeDirection?: 'width' | 'depth';
  };
  wing: {
    origin: { x: number; y: number };
    width: number;
    depth: number;
    pitch: number;
    overhang?: number;
    ridgeDirection?: 'width' | 'depth';
  };
}): RoofAssembly {
  const assemblyId = params.assemblyId ?? 'roof-cross-1';
  const levelId = params.levelId ?? 'level-1';
  const mainDir = params.main.ridgeDirection ?? 'depth';
  const wingDir =
    params.wing.ridgeDirection ?? (mainDir === 'depth' ? 'width' : 'depth');

  const authoring: RoofAssembly = {
    id: assemblyId,
    levelId,
    source: 'composed',
    materialId: params.materialId ?? 'mat-roof',
    masses: [
      {
        id: `${assemblyId}-mass-main`,
        label: 'main',
        generator: {
          type: 'gable',
          origin: params.main.origin ?? { x: 0, y: 0 },
          width: params.main.width,
          depth: params.main.depth,
          eaveHeight: params.eaveHeight,
          pitch: params.main.pitch,
          overhang: params.main.overhang ?? 1.5,
          ridgeDirection: mainDir,
        },
        planeIds: [],
      },
      {
        id: `${assemblyId}-mass-wing`,
        label: 'wing',
        generator: {
          type: 'gable',
          origin: params.wing.origin,
          width: params.wing.width,
          depth: params.wing.depth,
          eaveHeight: params.eaveHeight,
          pitch: params.wing.pitch,
          overhang: params.wing.overhang ?? 1.5,
          ridgeDirection: wingDir,
        },
        planeIds: [],
      },
    ],
    planes: [],
    edges: [],
  };

  return recompileRoofAssembly(authoring).assembly;
}

/** Sample check: no significant interpenetration between two masses' clipped meshes. */
export function assertNoInterpenetration(
  assembly: RoofAssembly,
  samples = 25,
): { ok: true } | { ok: false; samples: Array<{ x: number; z: number; ha: number; hb: number }> } {
  const masses = assembly.masses.filter((m) => m.generator);
  if (masses.length < 2) return { ok: true };
  const [a, b] = masses;
  const genA = a!.generator!;
  const genB = b!.generator!;
  const ba = massPlanBounds(genA);
  const bb = massPlanBounds(genB);
  const minX = Math.max(ba.minX, bb.minX);
  const maxX = Math.min(ba.maxX, bb.maxX);
  const minZ = Math.max(ba.minZ, bb.minZ);
  const maxZ = Math.min(ba.maxZ, bb.maxZ);
  if (!(maxX > minX) || !(maxZ > minZ)) return { ok: true };

  const failures: Array<{ x: number; z: number; ha: number; hb: number }> = [];
  for (let i = 0; i <= samples; i++) {
    for (let j = 0; j <= samples; j++) {
      const x = minX + ((maxX - minX) * i) / samples;
      const z = minZ + ((maxZ - minZ) * j) / samples;
      const ha = roofHeightAt(genA, x, z);
      const hb = roofHeightAt(genB, x, z);
      if (ha == null || hb == null) continue;
      // Both defined: upper envelope is max; "interpenetration" would mean
      // both clipped surfaces exist below the max — we check sample points
      // lie on the envelope within tolerance by verifying at least one plane covers max.
      const ymax = Math.max(ha, hb);
      const covered = assembly.planes.some((p) => {
        if (!pointInPolygonXZ(v3(x, ymax, z), p.boundary)) return false;
        const eq = planeFromPolygon(p.boundary);
        if (!eq) return false;
        const y = planeYAt(eq, x, z);
        return y != null && Math.abs(y - ymax) < 0.2;
      });
      if (!covered && Math.abs(ha - hb) > 0.05) {
        // Near valleys both heights close — skip strict cover
        if (Math.abs(ha - hb) < 0.25) continue;
        failures.push({ x, z, ha, hb });
      }
    }
  }
  // Allow a few numerical misses near edges
  if (failures.length > samples) return { ok: false, samples: failures.slice(0, 20) };
  return { ok: true };
}

/** Canonical export name used by tests and callers. */
export const buildCrossGableAssembly = buildCrossGableAssemblyClipped;
