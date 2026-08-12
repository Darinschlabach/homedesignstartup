/**
 * Exposed lower-story regions + lower-roof coverage against RoofAssembly masses.
 *
 * Rectangular subset only (no general polygon boolean).
 * Lower roofs are durable composed assemblies (role:'lower'), not renderer-only.
 */
import type { BuildingModelV1, Vec2 } from './building-model';
import { LevelSchema } from './building-model';
import {
  RoofAssemblySchema,
  type RoofAssembly,
  type RoofMassGenerator,
} from './roof-assembly';
import {
  exposedFootprintRegions,
  footprintBounds,
  footprintContainsFootprint,
  resolveLevelFootprint,
  shellAsFootprint,
  type LevelFootprintRect,
} from './level-footprint';
import { extractShellFromModel } from './shell';
import { levelTopElevation, primaryLevel } from './levels';

export type ExposedRegionSide = 'front' | 'rear' | 'left' | 'right' | 'full';

export type ExposedLowerRegion = {
  id: string;
  lowerLevelId: string;
  upperLevelId: string;
  side: ExposedRegionSide;
  footprint: LevelFootprintRect;
  /** Suggested eave = lower level wall top (FFE + height). */
  suggestedEaveHeight: number;
  /** Upper-story eave / roof bearing elevation. */
  upperEaveHeight: number;
};

export type ExposedRegionCoverage = {
  covered: boolean;
  coverageRatio: number;
  coveringMassIds: string[];
  coveringAssemblyIds: string[];
};

export type ExposedLowerRegionReport = ExposedLowerRegion & {
  coverage: ExposedRegionCoverage;
};

const COVER_RATIO = 0.65;

export function rectIntersectionArea(
  a: ReturnType<typeof footprintBounds>,
  b: ReturnType<typeof footprintBounds>,
): number {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const d = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  if (w <= 0 || d <= 0) return 0;
  return w * d;
}

export function classifyExposedSide(
  lower: LevelFootprintRect,
  region: LevelFootprintRect,
): ExposedRegionSide {
  const L = footprintBounds(lower);
  const R = footprintBounds(region);
  const fullW = Math.abs(R.maxX - R.minX - (L.maxX - L.minX)) < 0.05;
  const fullD = Math.abs(R.maxY - R.minY - (L.maxY - L.minY)) < 0.05;
  if (fullW && fullD) return 'full';
  if (fullW && Math.abs(R.minY - L.minY) < 0.1) return 'front';
  if (fullW && Math.abs(R.maxY - L.maxY) < 0.1) return 'rear';
  if (fullD && Math.abs(R.minX - L.minX) < 0.1) return 'left';
  if (fullD && Math.abs(R.maxX - L.maxX) < 0.1) return 'right';
  return 'full';
}

export function exposedRegionId(
  lowerLevelId: string,
  upperLevelId: string,
  side: ExposedRegionSide,
  index: number,
): string {
  return `exposed:${lowerLevelId}:${upperLevelId}:${side}:${index}`;
}

/**
 * Deterministic exposed rectangles of a lower level not covered by the upper
 * story footprint. Axis-aligned only.
 */
export function computeExposedLowerRegions(
  model: BuildingModelV1,
  lowerLevelId?: string,
  upperLevelId?: string,
): ExposedLowerRegion[] {
  const shell = extractShellFromModel(model);
  if (!shell) return [];
  const sorted = [...model.levels]
    .map((l) => LevelSchema.parse(l))
    .sort((a, b) => a.elevation - b.elevation);

  const out: ExposedLowerRegion[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const lower = sorted[i]!;
    const upper = sorted[i + 1]!;
    if (lowerLevelId && lower.id !== lowerLevelId) continue;
    if (upperLevelId && upper.id !== upperLevelId) continue;
    if (upper.footprintSource !== 'custom' || !upper.footprint) continue;

    const lowerFp =
      resolveLevelFootprint(model, lower.id) ?? shellAsFootprint(shell);
    const upperFp = upper.footprint;
    if (!footprintContainsFootprint(lowerFp, upperFp) && !footprintContainsFootprint(upperFp, lowerFp)) {
      // Still report residual strips when upper is inside; if wildly outside, treat as full lower.
    }
    const regions = exposedFootprintRegions(lowerFp, upperFp);
    const suggestedEaveHeight = levelTopElevation(lower);
    const upperEaveHeight = levelTopElevation(upper);
    regions.forEach((fp, index) => {
      const side = classifyExposedSide(lowerFp, fp);
      out.push({
        id: exposedRegionId(lower.id, upper.id, side, index),
        lowerLevelId: lower.id,
        upperLevelId: upper.id,
        side,
        footprint: fp,
        suggestedEaveHeight,
        upperEaveHeight,
      });
    });
  }
  return out;
}

export function isLowerRoofAssembly(
  assembly: RoofAssembly,
  model: BuildingModelV1,
): boolean {
  if (assembly.role === 'lower') return true;
  if (assembly.role === 'primary') return false;
  const topId =
    [...model.levels]
      .map((l) => LevelSchema.parse(l))
      .sort((a, b) => levelTopElevation(b) - levelTopElevation(a))[0]?.id ??
    primaryLevel(model).id;
  return assembly.levelId !== topId;
}

function massFootprintNoOverhang(gen: RoofMassGenerator): ReturnType<typeof footprintBounds> {
  const hw = gen.width / 2;
  const hd = gen.depth / 2;
  return {
    minX: gen.origin.x - hw,
    maxX: gen.origin.x + hw,
    minY: gen.origin.y - hd,
    maxY: gen.origin.y + hd,
  };
}

export function coverageOfRegionByMasses(
  region: LevelFootprintRect,
  assemblies: RoofAssembly[],
): ExposedRegionCoverage {
  const regionB = footprintBounds(region);
  const regionArea = Math.max(1e-6, region.width * region.depth);
  let coveredArea = 0;
  const coveringMassIds: string[] = [];
  const coveringAssemblyIds: string[] = [];

  for (const assembly of assemblies) {
    for (const mass of assembly.masses ?? []) {
      const gen = mass.generator;
      if (!gen) continue;
      const mb = massFootprintNoOverhang(gen);
      const inter = rectIntersectionArea(regionB, mb);
      if (inter / regionArea < 0.05) continue;
      coveredArea += inter;
      coveringMassIds.push(mass.id);
      if (!coveringAssemblyIds.includes(assembly.id)) {
        coveringAssemblyIds.push(assembly.id);
      }
    }
  }

  const coverageRatio = Math.min(1, coveredArea / regionArea);
  return {
    covered: coverageRatio >= COVER_RATIO,
    coverageRatio,
    coveringMassIds,
    coveringAssemblyIds,
  };
}

export function reportExposedLowerRegionsWithCoverage(
  model: BuildingModelV1,
): ExposedLowerRegionReport[] {
  const assemblies = (model.roofAssemblies ?? []).map((a) =>
    RoofAssemblySchema.parse(a),
  );
  const lowerAssemblies = assemblies.filter((a) => isLowerRoofAssembly(a, model));
  return computeExposedLowerRegions(model).map((region) => ({
    ...region,
    coverage: coverageOfRegionByMasses(region.footprint, lowerAssemblies),
  }));
}

/** Uncovered exposed regions (still need lower-roof treatment). */
export function uncoveredExposedLowerRegions(
  model: BuildingModelV1,
): ExposedLowerRegionReport[] {
  return reportExposedLowerRegionsWithCoverage(model).filter((r) => !r.coverage.covered);
}

export function findExposedRegion(
  model: BuildingModelV1,
  regionId: string,
): ExposedLowerRegion | null {
  return computeExposedLowerRegions(model).find((r) => r.id === regionId) ?? null;
}

export function massOverlapsUpperFootprint(
  gen: RoofMassGenerator,
  upper: LevelFootprintRect,
  eps = 0.75,
): boolean {
  const mb = massFootprintNoOverhang(gen);
  const ub = footprintBounds(upper);
  const inter = rectIntersectionArea(mb, {
    minX: ub.minX + eps,
    maxX: ub.maxX - eps,
    minY: ub.minY + eps,
    maxY: ub.maxY - eps,
  });
  return inter > 1;
}

export function massOutsideLowerFootprint(
  gen: RoofMassGenerator,
  lower: LevelFootprintRect,
  eps = 0.5,
): boolean {
  const mb = massFootprintNoOverhang(gen);
  const lb = footprintBounds(lower);
  return (
    mb.minX < lb.minX - eps ||
    mb.maxX > lb.maxX + eps ||
    mb.minY < lb.minY - eps ||
    mb.maxY > lb.maxY + eps
  );
}

export function pointInRect(
  p: Vec2,
  b: ReturnType<typeof footprintBounds>,
  eps = 1e-6,
): boolean {
  return (
    p.x >= b.minX - eps &&
    p.x <= b.maxX + eps &&
    p.y >= b.minY - eps &&
    p.y <= b.maxY + eps
  );
}
