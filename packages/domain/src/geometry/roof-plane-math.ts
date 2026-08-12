/**
 * Roof plane mathematics — infinite planes, line intersections, polygon clipping.
 * Deterministic geometry helpers (no AI). Units: feet, Y up.
 */
import type { Vec3 } from '../building-model';

export type Vec3Tuple = [number, number, number];

export interface PlaneEq {
  /** Unit normal. */
  n: Vec3;
  /** Plane: n·p = d */
  d: number;
}

const EPS = 1e-7;
const EPS_AREA = 1e-5;

export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function len(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function normalize(a: Vec3): Vec3 {
  const L = len(a);
  if (L < EPS) return { x: 0, y: 1, z: 0 };
  return scale(a, 1 / L);
}

export function planeFromPoints(a: Vec3, b: Vec3, c: Vec3): PlaneEq | null {
  const n = normalize(cross(sub(b, a), sub(c, a)));
  if (len(n) < EPS) return null;
  return { n, d: dot(n, a) };
}

export function planeFromPolygon(pts: Vec3[]): PlaneEq | null {
  if (pts.length < 3) return null;
  // Use Newell's method for robustness
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    nx += (p.y - q.y) * (p.z + q.z);
    ny += (p.z - q.z) * (p.x + q.x);
    nz += (p.x - q.x) * (p.y + q.y);
  }
  const n = normalize({ x: nx, y: ny, z: nz });
  if (len(n) < EPS) return null;
  return { n, d: dot(n, pts[0]!) };
}

export function pointOnPlane(plane: PlaneEq, p: Vec3): number {
  return dot(plane.n, p) - plane.d;
}

export function projectPointToPlane(plane: PlaneEq, p: Vec3): Vec3 {
  const dist = pointOnPlane(plane, p);
  return sub(p, scale(plane.n, dist));
}

/** Y on plane at plan (x,z), or null if plane is vertical. */
export function planeYAt(plane: PlaneEq, x: number, z: number): number | null {
  if (Math.abs(plane.n.y) < EPS) return null;
  return (plane.d - plane.n.x * x - plane.n.z * z) / plane.n.y;
}

export interface PlaneIntersectionLine {
  point: Vec3;
  direction: Vec3;
}

/** Intersection line of two non-parallel planes. */
export function intersectPlanes(
  a: PlaneEq,
  b: PlaneEq,
): PlaneIntersectionLine | null {
  const direction = cross(a.n, b.n);
  const dirLen = len(direction);
  if (dirLen < EPS) return null; // parallel / coincident

  // Solve for a point on both planes:
  // Find largest component of direction for stable basis
  const abs = { x: Math.abs(direction.x), y: Math.abs(direction.y), z: Math.abs(direction.z) };
  let point: Vec3;
  if (abs.y >= abs.x && abs.y >= abs.z) {
    // set y=0
    const det = a.n.x * b.n.z - a.n.z * b.n.x;
    if (Math.abs(det) < EPS) return null;
    const x = (a.d * b.n.z - b.d * a.n.z) / det;
    const z = (a.n.x * b.d - b.n.x * a.d) / det;
    point = { x, y: 0, z };
  } else if (abs.z >= abs.x) {
    // set z=0
    const det = a.n.x * b.n.y - a.n.y * b.n.x;
    if (Math.abs(det) < EPS) return null;
    const x = (a.d * b.n.y - b.d * a.n.y) / det;
    const y = (a.n.x * b.d - b.n.x * a.d) / det;
    point = { x, y, z: 0 };
  } else {
    // set x=0
    const det = a.n.y * b.n.z - a.n.z * b.n.y;
    if (Math.abs(det) < EPS) return null;
    const y = (a.d * b.n.z - b.d * a.n.z) / det;
    const z = (a.n.y * b.d - b.n.y * a.d) / det;
    point = { x: 0, y, z };
  }

  // Project point onto both planes for numerical cleanliness
  point = projectPointToPlane(a, point);
  point = projectPointToPlane(b, point);

  return { point, direction: scale(direction, 1 / dirLen) };
}

/** Clip a 3D polygon by a half-space n·p >= d (Sutherland–Hodgman). */
export function clipPolygonByHalfSpace(
  polygon: Vec3[],
  n: Vec3,
  d: number,
  eps = EPS,
): Vec3[] {
  if (polygon.length < 3) return [];
  const out: Vec3[] = [];
  const inside = (p: Vec3) => dot(n, p) - d >= -eps;

  for (let i = 0; i < polygon.length; i++) {
    const cur = polygon[i]!;
    const prev = polygon[(i + polygon.length - 1) % polygon.length]!;
    const curIn = inside(cur);
    const prevIn = inside(prev);

    if (curIn) {
      if (!prevIn) {
        const t = intersectSegmentPlane(prev, cur, n, d);
        if (t) out.push(t);
      }
      out.push(cur);
    } else if (prevIn) {
      const t = intersectSegmentPlane(prev, cur, n, d);
      if (t) out.push(t);
    }
  }

  return dedupeRing(out);
}

function intersectSegmentPlane(
  a: Vec3,
  b: Vec3,
  n: Vec3,
  d: number,
): Vec3 | null {
  const da = dot(n, a) - d;
  const db = dot(n, b) - d;
  if (Math.abs(da - db) < EPS) return null;
  const t = da / (da - db);
  if (t < -EPS || t > 1 + EPS) return null;
  return add(a, scale(sub(b, a), Math.min(1, Math.max(0, t))));
}

/** Clip polygon to the interior of another convex polygon (plan xz), then lift Y via plane. */
export function clipPolygonToPlanConvex(
  polygon: Vec3[],
  clipRing: Array<{ x: number; z: number }>,
  liftPlane: PlaneEq,
): Vec3[] {
  if (polygon.length < 3 || clipRing.length < 3) return [];

  // Convert clip ring to half-spaces in XZ (assume CCW)
  let area = 0;
  for (let i = 0; i < clipRing.length; i++) {
    const a = clipRing[i]!;
    const b = clipRing[(i + 1) % clipRing.length]!;
    area += a.x * b.z - b.x * a.z;
  }
  const ccw = area >= 0;

  let poly = polygon.map((p) => ({ ...p }));
  for (let i = 0; i < clipRing.length; i++) {
    const a = clipRing[i]!;
    const b = clipRing[(i + 1) % clipRing.length]!;
    // inward normal in XZ
    const edge = { x: b.x - a.x, z: b.z - a.z };
    const inward = ccw
      ? { x: -edge.z, y: 0, z: edge.x }
      : { x: edge.z, y: 0, z: -edge.x };
    const n = normalize(inward);
    const d = n.x * a.x + n.z * a.z;
    poly = clipPolygonByHalfSpace(poly, n, d);
    if (poly.length < 3) return [];
  }

  // Lift onto roof plane
  return poly.map((p) => {
    const y = planeYAt(liftPlane, p.x, p.z);
    return y == null ? projectPointToPlane(liftPlane, p) : v3(p.x, y, p.z);
  });
}

export function polygonArea3(pts: Vec3[]): number {
  if (pts.length < 3) return 0;
  let area = 0;
  const o = pts[0]!;
  for (let i = 1; i < pts.length - 1; i++) {
    area += len(cross(sub(pts[i]!, o), sub(pts[i + 1]!, o))) * 0.5;
  }
  return area;
}

export function polygonPlanArea(pts: Vec3[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) * 0.5;
}

export function dedupeRing(pts: Vec3[], eps = 1e-5): Vec3[] {
  if (pts.length === 0) return [];
  const out: Vec3[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || len(sub(p, last)) > eps) out.push(p);
  }
  if (out.length > 1 && len(sub(out[0]!, out[out.length - 1]!)) <= eps) {
    out.pop();
  }
  return out;
}

/** Clip infinite intersection line to both polygons; return segments. */
export function clipIntersectionLineToPolygons(
  line: PlaneIntersectionLine,
  polyA: Vec3[],
  polyB: Vec3[],
): Array<{ start: Vec3; end: Vec3 }> {
  const paramsA = lineParamsInsidePolygon(line, polyA);
  const paramsB = lineParamsInsidePolygon(line, polyB);
  const intervals = intersectIntervals(paramsA, paramsB);
  return intervals
    .filter(([t0, t1]) => t1 - t0 > 1e-4)
    .map(([t0, t1]) => ({
      start: add(line.point, scale(line.direction, t0)),
      end: add(line.point, scale(line.direction, t1)),
    }));
}

function lineParamsInsidePolygon(
  line: PlaneIntersectionLine,
  poly: Vec3[],
): Array<[number, number]> {
  // Project polygon edges onto line parameter; find overlapping range where line is inside poly.
  // Use plan xz containment sampling along candidate t from polygon edge intersections.
  const plane = planeFromPolygon(poly);
  if (!plane) return [];

  const ts: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const hit = segmentLineClosest(a, b, line);
    if (hit != null) ts.push(hit);
  }

  // Also project vertices
  for (const p of poly) {
    ts.push(dot(sub(p, line.point), line.direction));
  }
  ts.sort((a, b) => a - b);

  const unique: number[] = [];
  for (const t of ts) {
    if (unique.length === 0 || Math.abs(t - unique[unique.length - 1]!) > 1e-5) {
      unique.push(t);
    }
  }

  const intervals: Array<[number, number]> = [];
  for (let i = 0; i < unique.length - 1; i++) {
    const t0 = unique[i]!;
    const t1 = unique[i + 1]!;
    const mid = add(line.point, scale(line.direction, (t0 + t1) / 2));
    if (pointInPolygonXZ(mid, poly)) {
      intervals.push([t0, t1]);
    }
  }
  return mergeIntervals(intervals);
}

function segmentLineClosest(
  a: Vec3,
  b: Vec3,
  line: PlaneIntersectionLine,
): number | null {
  // Intersect segment with the line if coplanar (both on same roof planes ideally).
  const ab = sub(b, a);
  const abxdir = cross(ab, line.direction);
  if (len(abxdir) < EPS) {
    // parallel — project endpoints
    return null;
  }
  // Solve a + s*ab = line.point + t*dir in least squares (3D)
  // Use cross method: s = ((p-a) × dir) · (ab × dir) / |ab × dir|^2
  const ap = sub(line.point, a);
  const den = dot(abxdir, abxdir);
  const s = dot(cross(ap, line.direction), abxdir) / den;
  if (s < -EPS || s > 1 + EPS) return null;
  const hit = add(a, scale(ab, Math.min(1, Math.max(0, s))));
  return dot(sub(hit, line.point), line.direction);
}

export function pointInPolygonXZ(p: Vec3, poly: Vec3[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    const intersect =
      pi.z > p.z !== pj.z > p.z &&
      p.x <
        ((pj.x - pi.x) * (p.z - pi.z)) / (pj.z - pi.z + (pj.z === pi.z ? EPS : 0)) +
          pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = out[out.length - 1]!;
    if (cur[0] <= last[1] + 1e-5) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      out.push(cur);
    }
  }
  return out;
}

function intersectIntervals(
  a: Array<[number, number]>,
  b: Array<[number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const A = a[i]!;
    const B = b[j]!;
    const lo = Math.max(A[0], B[0]);
    const hi = Math.min(A[1], B[1]);
    if (hi > lo) out.push([lo, hi]);
    if (A[1] < B[1]) i++;
    else j++;
  }
  return out;
}

export { EPS, EPS_AREA };
