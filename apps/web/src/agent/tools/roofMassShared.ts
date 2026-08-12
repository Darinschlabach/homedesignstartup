/**
 * Shared helpers for roof-mass agent tools.
 */
import {
  RoofAssemblySchema,
  type BuildingModelV1,
  type RoofAssembly,
  type RoofMassDef,
} from "@aihd/domain";

export function listRoofAssemblies(model: BuildingModelV1): RoofAssembly[] {
  return (model.roofAssemblies ?? []).map((a) => RoofAssemblySchema.parse(a));
}

export function findRoofMass(
  model: BuildingModelV1,
  massId: string,
): { assembly: RoofAssembly; mass: RoofMassDef } | null {
  for (const assembly of listRoofAssemblies(model)) {
    const mass = assembly.masses.find((m) => m.id === massId);
    if (mass) return { assembly, mass };
  }
  return null;
}

export function summarizeMass(
  assembly: RoofAssembly,
  mass: RoofMassDef,
): Record<string, unknown> {
  const gen = mass.generator;
  const planeIds = mass.planeIds?.length
    ? mass.planeIds
    : assembly.planes.filter((p) => p.massId === mass.id).map((p) => p.id);
  const relatedEdges = assembly.edges.filter((e) =>
    e.planeIds.some((pid) => planeIds.includes(pid)),
  );
  return {
    massId: mass.id,
    assemblyId: assembly.id,
    assemblySource: assembly.source,
    label: mass.label ?? null,
    generator: gen
      ? {
          type: gen.type,
          origin: gen.origin,
          widthFt: gen.width,
          depthFt: gen.depth,
          pitch: gen.pitch,
          pitchLabel: `${gen.pitch}/12`,
          ridgeDirection: gen.ridgeDirection,
          eaveHeightFt: gen.eaveHeight,
          overhangFt: gen.overhang,
          highSide: gen.highSide ?? null,
        }
      : null,
    materialId: assembly.materialId ?? null,
    derived: {
      planeIds,
      edges: relatedEdges.map((e) => ({
        id: e.id,
        kind: e.kind,
        planeIds: e.planeIds,
        start: e.start,
        end: e.end,
      })),
      valleyEdges: relatedEdges
        .filter((e) => e.kind === "valley" || e.kind === "shared")
        .map((e) => e.id),
      ridgeEdges: relatedEdges.filter((e) => e.kind === "ridge").map((e) => e.id),
    },
    limitations: {
      maxInteractingMasses: 2,
      supportedPairwiseIntersections: [
        "gable+gable",
        "gable+shed",
        "shed+shed",
        "any+flat",
      ],
      unsupported: [
        ">2 interacting masses",
        "dormers",
        "hip–hip / hip–gable complex intersections",
        "manual valley coordinates",
        "raw roof-plane polygon authoring via these tools",
      ],
      note: "Geometry engine regenerates clipped planes and valleys from mass generators. Do not specify valley coordinates.",
    },
  };
}

export function scrubNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}
