/**
 * Domain ops for composed roof masses (authoring).
 * Derived planes/edges are always regenerated via recompileRoofAssembly.
 */
import type { BuildingModelV1 } from './building-model';
import { hydrateEntitiesFromModel } from './hydrate-entities';
import {
  assembliesToLegacyRoofs,
  ensureRoofAssemblies,
  RoofAssemblySchema,
  RoofMassGeneratorSchema,
  type RoofAssembly,
  type RoofMassGenerator,
} from './roof-assembly';
import {
  recompileRoofAssembly,
  RoofIntersectionError,
} from './geometry/roof-intersection';
import {
  findExposedRegion,
  massOutsideLowerFootprint,
  massOverlapsUpperFootprint,
} from './lower-roof';
import { resolveLevelFootprint } from './level-footprint';
import { LevelSchema } from './building-model';
import { levelTopElevation } from './levels';

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function createLowerRoofMass(
  model: BuildingModelV1,
  assemblies: RoofAssembly[],
  input: {
    assemblyId?: string;
    label?: string;
    materialId?: string;
    levelId?: string;
    coversExposedRegionId?: string;
  },
  generator: RoofMassGenerator,
): BuildingModelV1 {
  const region = input.coversExposedRegionId
    ? findExposedRegion(model, input.coversExposedRegionId)
    : null;
  if (input.coversExposedRegionId && !region) {
    throw new RoofIntersectionError(
      'ROOF_MASS_MISSING_GENERATOR',
      `Exposed lower-roof region not found: ${input.coversExposedRegionId}`,
      { coversExposedRegionId: input.coversExposedRegionId },
    );
  }

  const lowerLevelId =
    input.levelId ?? region?.lowerLevelId ?? model.levels[0]?.id ?? 'level-1';
  const lowerLevel = model.levels
    .map((l) => LevelSchema.parse(l))
    .find((l) => l.id === lowerLevelId);
  if (!lowerLevel) {
    throw new RoofIntersectionError(
      'ROOF_MASS_MISSING_GENERATOR',
      `Level not found for lower roof: ${lowerLevelId}`,
      { levelId: lowerLevelId },
    );
  }

  const lowerFp = resolveLevelFootprint(model, lowerLevelId);
  if (lowerFp && massOutsideLowerFootprint(generator, lowerFp)) {
    throw new RoofIntersectionError(
      'LOWER_ROOF_OUTSIDE_FOOTPRINT',
      'Lower roof mass footprint extends outside the lower-story footprint',
      { levelId: lowerLevelId, origin: generator.origin, width: generator.width, depth: generator.depth },
    );
  }

  const upperLevelId = region?.upperLevelId ??
    model.levels
      .map((l) => LevelSchema.parse(l))
      .sort((a, b) => levelTopElevation(b) - levelTopElevation(a))[0]?.id;
  if (upperLevelId && upperLevelId !== lowerLevelId) {
    const upperFp = resolveLevelFootprint(model, upperLevelId);
    if (upperFp && massOverlapsUpperFootprint(generator, upperFp)) {
      throw new RoofIntersectionError(
        'LOWER_ROOF_OVERLAPS_UPPER',
        'Lower roof mass overlaps the upper-story footprint (would cut through upper walls)',
        { upperLevelId, origin: generator.origin },
      );
    }
  }

  const expectedEave = levelTopElevation(lowerLevel);
  if (Math.abs(generator.eaveHeight - expectedEave) > 1.5) {
    throw new RoofIntersectionError(
      'LOWER_ROOF_EAVE',
      `Lower roof eaveHeight ${generator.eaveHeight} ft should be near lower-level wall top ${expectedEave} ft`,
      { eaveHeight: generator.eaveHeight, expectedEave, levelId: lowerLevelId },
    );
  }

  const assemblyId = input.assemblyId ?? genId('roof-lower');
  if (assemblies.some((a) => a.id === assemblyId)) {
    throw new RoofIntersectionError(
      'ROOF_INTERSECT_UNSUPPORTED',
      `Assembly ${assemblyId} already exists. Omit assemblyId to create a new lower-roof assembly.`,
      { assemblyId },
    );
  }

  const massId = genId(`${assemblyId}-mass`);
  const lowerAssembly: RoofAssembly = RoofAssemblySchema.parse({
    id: assemblyId,
    levelId: lowerLevelId,
    source: 'composed',
    role: 'lower',
    coversExposedRegionId: input.coversExposedRegionId,
    materialId: input.materialId ?? model.roofs[0]?.materialId ?? 'mat-roof',
    masses: [
      {
        id: massId,
        label: input.label,
        generator,
        planeIds: [],
      },
    ],
    planes: [],
    edges: [],
  });

  const nextAssemblies = [...assemblies, lowerAssembly];
  try {
    return withRecompiled(model, nextAssemblies);
  } catch (err) {
    if (err instanceof RoofIntersectionError) throw err;
    throw err;
  }
}

function withRecompiled(
  model: BuildingModelV1,
  assemblies: RoofAssembly[],
): BuildingModelV1 {
  const compiled = assemblies.map((a) => {
    if (a.source === 'composed' && (a.masses?.length ?? 0) > 0) {
      return recompileRoofAssembly(a).assembly;
    }
    return RoofAssemblySchema.parse(a);
  });
  const roofs = assembliesToLegacyRoofs(compiled).map((r) => ({
    ...r,
    materialId: r.materialId ?? model.roofs[0]?.materialId ?? 'mat-roof',
  }));
  return hydrateEntitiesFromModel({
    ...model,
    roofAssemblies: compiled,
    roofs,
  });
}

export function createRoofMass(
  model: BuildingModelV1,
  input: {
    assemblyId?: string;
    label?: string;
    generator: RoofMassGenerator;
    materialId?: string;
    /** Owning story. Defaults to top/primary roof bearing level. */
    levelId?: string;
    /** lower = independent assembly covering an exposed lower-story region. */
    role?: 'primary' | 'lower';
    coversExposedRegionId?: string;
  },
): BuildingModelV1 {
  const generator = RoofMassGeneratorSchema.parse(input.generator);
  // Migrate legacy models with empty roofAssemblies from shell.roof first.
  let assemblies = ensureRoofAssemblies(model).map((a) =>
    RoofAssemblySchema.parse(a),
  );

  const asLower =
    input.role === 'lower' || Boolean(input.coversExposedRegionId);

  if (asLower) {
    return createLowerRoofMass(model, assemblies, input, generator);
  }

  let target =
    (input.assemblyId
      ? assemblies.find((a) => a.id === input.assemblyId)
      : undefined) ??
    assemblies.find((a) => a.source === 'composed' && a.role !== 'lower') ??
    assemblies.find((a) => a.source === 'shell') ??
    assemblies[0];

  if (!target) {
    target = {
      id: input.assemblyId ?? genId('roof'),
      levelId: model.levels[0]?.id ?? 'level-1',
      source: 'composed',
      materialId: input.materialId ?? model.roofs[0]?.materialId ?? 'mat-roof',
      masses: [],
      planes: [],
      edges: [],
    };
    assemblies = [...assemblies, target];
  }

  // Adding a secondary mass to a shell assembly promotes it to composed.
  // Preserve independent lower-roof assemblies; drop other shell mirrors.
  const preservedLower = assemblies.filter(
    (a) => a.id !== target!.id && a.role === 'lower',
  );
  if (target.source === 'shell') {
    assemblies = [
      {
        ...target,
        source: 'composed' as const,
        role: target.role ?? 'primary',
        materialId:
          input.materialId ?? target.materialId ?? model.roofs[0]?.materialId ?? 'mat-roof',
      },
      ...preservedLower,
    ];
    target = assemblies[0]!;
  } else {
    target = { ...target, source: 'composed', role: target.role ?? 'primary' };
    assemblies = assemblies.map((a) => (a.id === target!.id ? target! : a));
  }

  if (target.masses.length >= 2) {
    throw new RoofIntersectionError(
      'ROOF_INTERSECT_UNSUPPORTED',
      'At most two interacting roof masses are supported. Delete or modify an existing mass instead of adding a third.',
      { assemblyId: target.id, massCount: target.masses.length },
    );
  }

  // Hip cannot intersect a second mass. When adding a gable/shed wing onto a hip
  // main, convert the main mass to gable (same footprint/pitch/ridge) so the
  // supported pairwise intersection path can run.
  let masses = [...target.masses];
  if (masses.length === 1 && masses[0]?.generator?.type === 'hip') {
    if (generator.type === 'gable' || generator.type === 'shed') {
      const main = masses[0]!;
      masses = [
        {
          ...main,
          label: main.label ?? 'main',
          generator: {
            ...main.generator!,
            type: 'gable',
          },
        },
      ];
    }
  }

  const massId = genId(`${target.id}-mass`);
  const nextMasses = [
    ...masses,
    {
      id: massId,
      label: input.label,
      generator,
      planeIds: [],
    },
  ];

  const nextAssemblies = assemblies.map((a) =>
    a.id === target!.id ? { ...target!, masses: nextMasses } : a,
  );

  try {
    return withRecompiled(model, nextAssemblies);
  } catch (err) {
    if (err instanceof RoofIntersectionError) throw err;
    throw err;
  }
}

export function updateRoofMass(
  model: BuildingModelV1,
  input: {
    assemblyId: string;
    massId: string;
    patch: Partial<RoofMassGenerator> & { label?: string; materialId?: string };
  },
): BuildingModelV1 {
  const assemblies = (model.roofAssemblies ?? []).map((a) =>
    RoofAssemblySchema.parse(a),
  );
  const assembly = assemblies.find((a) => a.id === input.assemblyId);
  if (!assembly) {
    throw new RoofIntersectionError(
      'ROOF_MASS_MISSING_GENERATOR',
      `Assembly not found: ${input.assemblyId}`,
      { assemblyId: input.assemblyId },
    );
  }
  const mass = assembly.masses.find((m) => m.id === input.massId);
  if (!mass?.generator) {
    throw new RoofIntersectionError(
      'ROOF_MASS_MISSING_GENERATOR',
      `Mass not found or missing generator: ${input.massId}`,
      { massId: input.massId },
    );
  }

  const { label, materialId, ...genPatch } = input.patch;
  const generator = RoofMassGeneratorSchema.parse({
    ...mass.generator,
    ...genPatch,
  });

  const nextAssemblies = assemblies.map((a) => {
    if (a.id !== assembly.id) return a;
    return {
      ...a,
      source: 'composed' as const,
      materialId: materialId ?? a.materialId,
      masses: a.masses.map((m) =>
        m.id === mass.id
          ? { ...m, label: label ?? m.label, generator }
          : m,
      ),
    };
  });

  return withRecompiled(model, nextAssemblies);
}

export function deleteRoofMass(
  model: BuildingModelV1,
  input: { assemblyId: string; massId: string },
): BuildingModelV1 {
  const assemblies = (model.roofAssemblies ?? []).map((a) =>
    RoofAssemblySchema.parse(a),
  );
  const assembly = assemblies.find((a) => a.id === input.assemblyId);
  if (!assembly) {
    throw new RoofIntersectionError(
      'ROOF_MASS_MISSING_GENERATOR',
      `Assembly not found: ${input.assemblyId}`,
      { assemblyId: input.assemblyId },
    );
  }

  const nextMasses = assembly.masses.filter((m) => m.id !== input.massId);
  if (nextMasses.length === assembly.masses.length) {
    throw new RoofIntersectionError(
      'ROOF_MASS_MISSING_GENERATOR',
      `Mass not found: ${input.massId}`,
      { massId: input.massId },
    );
  }

  const nextAssemblies = assemblies
    .map((a) => {
      if (a.id !== assembly.id) return a;
      if (nextMasses.length === 0) return null;
      return { ...a, source: 'composed' as const, masses: nextMasses };
    })
    .filter((a): a is RoofAssembly => a != null);

  if (nextAssemblies.length === 0) {
    // Fall back to shell roof
    return hydrateEntitiesFromModel({
      ...model,
      roofAssemblies: [],
    });
  }

  return withRecompiled(model, nextAssemblies);
}
