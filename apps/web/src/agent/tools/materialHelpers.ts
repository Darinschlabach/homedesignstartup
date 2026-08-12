import type { BuildingModelV1, Material } from "@aihd/domain";
import { MATERIAL_CAPABILITIES, materialPublicView } from "@aihd/domain";

export { MATERIAL_CAPABILITIES, materialPublicView };

export function materialSnapshot(
  model: BuildingModelV1,
  materialId: string | undefined,
) {
  if (!materialId) return null;
  const mat = model.materials.find((m) => m.id === materialId);
  if (!mat) return { id: materialId, missing: true as const };
  const usage = countMaterialUsage(model, materialId);
  return {
    ...materialPublicView(mat),
    usedByCount: usage.count,
    shared: usage.count > 1,
    usedBy: usage.objectIds.slice(0, 12),
  };
}

export function countMaterialUsage(
  model: BuildingModelV1,
  materialId: string,
): { count: number; objectIds: string[] } {
  const objectIds: string[] = [];
  for (const wall of model.walls) {
    if (wall.materialId === materialId) objectIds.push(wall.id);
  }
  for (const roof of model.roofs) {
    if (roof.materialId === materialId) objectIds.push(roof.id);
  }
  for (const slab of model.slabs) {
    if (slab.materialId === materialId) objectIds.push(slab.id);
  }
  const covered = new Set(objectIds);
  for (const ent of model.entities ?? []) {
    if (covered.has(ent.id)) continue;
    if (ent.materialId === materialId) objectIds.push(ent.id);
  }
  return { count: objectIds.length, objectIds };
}

export function objectMaterialId(
  model: BuildingModelV1,
  objectId: string,
): string | undefined {
  const wall = model.walls.find((w) => w.id === objectId);
  if (wall?.materialId) return wall.materialId;
  const roof = model.roofs.find((r) => r.id === objectId);
  if (roof?.materialId) return roof.materialId;
  const slab = model.slabs.find((s) => s.id === objectId);
  if (slab?.materialId) return slab.materialId;
  const ent = (model.entities ?? []).find((e) => e.id === objectId);
  return ent?.materialId;
}

export type FinishOverrides = {
  color?: string;
  roughness?: number;
  metalness?: number;
};

/**
 * Build ops to apply a material to one object.
 * Finish overrides default to object-scoped clones so shared materials are not silently mutated.
 * Pass finishScope: 'global' only when the agent intends to change every user of that material.
 */
export function buildApplyMaterialOperations(options: {
  model: BuildingModelV1;
  objectId: string;
  materialId: string;
  finish?: FinishOverrides;
  finishScope?: "object" | "global";
}): {
  operations: import("@aihd/domain").DesignOperation[];
  strategy: "assign" | "clone_for_object" | "global_finish";
  resultingMaterialId: string;
  clonedFrom?: string;
  sharedBefore: boolean;
} {
  const { model, objectId, materialId, finish } = options;
  const finishScope = options.finishScope ?? "object";
  const usage = countMaterialUsage(model, materialId);
  const sharedBefore = usage.count > 1;
  const base = model.materials.find((m) => m.id === materialId);
  if (!base) {
    return {
      operations: [],
      strategy: "assign",
      resultingMaterialId: materialId,
      sharedBefore,
    };
  }

  if (!finish || Object.keys(finish).length === 0) {
    return {
      operations: [
        { op: "setMaterial", entityId: objectId, materialId },
      ],
      strategy: "assign",
      resultingMaterialId: materialId,
      sharedBefore,
    };
  }

  if (finishScope === "global") {
    return {
      operations: [
        {
          op: "setMaterial",
          entityId: objectId,
          materialId,
          finish,
        },
      ],
      strategy: "global_finish",
      resultingMaterialId: materialId,
      sharedBefore,
    };
  }

  // Object-scoped finish: clone so other objects keep the original shared definition.
  const cloneId = `mat-${base.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)}-var-${Math.random().toString(36).slice(2, 7)}`;

  return {
    operations: [
      {
        op: "createMaterial",
        material: {
          id: cloneId,
          name: `${base.name} (object)`,
          category: base.category,
          color: finish.color ?? base.color,
          roughness: finish.roughness ?? base.roughness,
          metalness: finish.metalness ?? base.metalness,
        },
      },
      {
        op: "setMaterial",
        entityId: objectId,
        materialId: cloneId,
      },
    ],
    strategy: "clone_for_object",
    resultingMaterialId: cloneId,
    clonedFrom: materialId,
    sharedBefore,
  };
}

export const OPENING_MATERIAL_TYPES = new Set([
  "window",
  "exteriorDoor",
  "garageDoor",
  "opening",
  "door",
]);

function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9A-Fa-f]{6})$/.exec(color.trim());
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function colorDistance(a: string, b: string): number | null {
  const aa = parseHex(a);
  const bb = parseHex(b);
  if (!aa || !bb) return null;
  const dr = aa[0] - bb[0];
  const dg = aa[1] - bb[1];
  const db = aa[2] - bb[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

const COLOR_HINTS: Record<string, string[]> = {
  white: ["#F5F5F5", "#FFFFFF", "#F5F0E6", "#E7E0D4"],
  black: ["#1A1A1A", "#111111", "#2D2D2D"],
  gray: ["#9CA3AF", "#6B7280", "#4A5560", "#A8A29A"],
  grey: ["#9CA3AF", "#6B7280", "#4A5560", "#A8A29A"],
  warm: ["#C4B8A5", "#D9D2C5", "#A89B8A", "#8B6914"],
  cool: ["#4A5560", "#6B7280", "#9A958C"],
  timber: ["#8B6914", "#A89B8A", "#C4B8A5"],
  wood: ["#8B6914", "#A89B8A", "#C4B8A5"],
  metal: ["#4A5560", "#6B7280", "#9CA3AF"],
  dark: ["#4A5560", "#2D2D2D", "#5c4033"],
  light: ["#F5F0E6", "#D9D2C5", "#C4B8A5", "#E7E0D4"],
};

function tokens(...parts: Array<string | undefined | null>): string[] {
  return parts
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export type FindMaterialQuery = {
  query?: string;
  name?: string;
  category?: string;
  intendedUse?: string;
  color?: string;
  appearance?: string;
  finish?: string;
  roughness?: number;
  metalness?: number;
  limit?: number;
};

export type ScoredMaterial = {
  score: number;
  reasons: string[];
  material: ReturnType<typeof materialPublicView>;
};

export function scoreMaterials(
  materials: Material[],
  q: FindMaterialQuery,
): ScoredMaterial[] {
  const conceptTokens = tokens(
    q.query,
    q.name,
    q.intendedUse,
    q.appearance,
    q.finish,
    q.category,
  );
  const nameTokens = tokens(q.name);
  const categoryHint = q.category?.trim().toLowerCase();
  const colorHint = q.color?.trim();
  const hexColor = colorHint && parseHex(colorHint) ? colorHint : undefined;
  const namedHints =
    colorHint && !hexColor
      ? COLOR_HINTS[colorHint.toLowerCase()] ?? []
      : colorHint
        ? []
        : conceptTokens.flatMap((t) => COLOR_HINTS[t] ?? []);

  const scored: ScoredMaterial[] = [];

  for (const m of materials) {
    let score = 0;
    const reasons: string[] = [];
    const hay = `${m.id} ${m.name} ${m.category}`.toLowerCase();

    if (categoryHint) {
      if (m.category === categoryHint) {
        score += 40;
        reasons.push(`category:${m.category}`);
      } else if (
        hay.includes(categoryHint) ||
        categoryHint.includes(m.category)
      ) {
        score += 18;
        reasons.push(`category-partial:${m.category}`);
      }
    }

    for (const t of nameTokens) {
      if (m.name.toLowerCase().includes(t) || m.id.toLowerCase().includes(t)) {
        score += 22;
        reasons.push(`name:${t}`);
      }
    }

    for (const t of conceptTokens) {
      if (hay.includes(t)) {
        score += 12;
        reasons.push(`concept:${t}`);
      }
      // Soft category/use synonyms — not style presets.
      if (
        (t === "siding" || t === "facade" || t === "cladding" || t === "exterior") &&
        m.category === "wall"
      ) {
        score += 10;
        reasons.push("use:wall");
      }
      if ((t === "roofing" || t === "roof") && m.category === "roof") {
        score += 10;
        reasons.push("use:roof");
      }
      if ((t === "floor" || t === "slab") && m.category === "floor") {
        score += 10;
        reasons.push("use:floor");
      }
      if ((t === "trim" || t === "accent") && m.category === "trim") {
        score += 10;
        reasons.push("use:trim");
      }
      if (
        (t === "timber" || t === "wood" || t === "structure") &&
        m.category === "structure"
      ) {
        score += 8;
        reasons.push("use:structure");
      }
      if ((t === "metal" || t === "metallic") && m.metalness >= 0.2) {
        score += 8;
        reasons.push("finish:metalness");
      }
      if (
        (t === "matte" || t === "rough" || t === "textured") &&
        m.roughness >= 0.7
      ) {
        score += 6;
        reasons.push("finish:rough");
      }
      if ((t === "smooth" || t === "glossy" || t === "gloss") && m.roughness <= 0.4) {
        score += 6;
        reasons.push("finish:smooth");
      }
    }

    if (hexColor) {
      const d = colorDistance(m.color, hexColor);
      if (d != null) {
        const colorScore = Math.max(0, 35 - d / 8);
        if (colorScore > 0) {
          score += colorScore;
          reasons.push(`color-hexΔ:${d.toFixed(0)}`);
        }
      }
    }

    for (const hint of namedHints) {
      const d = colorDistance(m.color, hint);
      if (d != null && d < 90) {
        score += Math.max(0, 18 - d / 10);
        reasons.push(`color-hint:${hint}`);
        break;
      }
    }

    if (typeof q.roughness === "number") {
      const d = Math.abs(m.roughness - q.roughness);
      if (d <= 0.25) {
        score += 12 * (1 - d / 0.25);
        reasons.push("roughness-near");
      }
    }

    if (typeof q.metalness === "number") {
      const d = Math.abs(m.metalness - q.metalness);
      if (d <= 0.25) {
        score += 12 * (1 - d / 0.25);
        reasons.push("metalness-near");
      }
    }

    if (score > 0) {
      scored.push({
        score: Math.round(score * 10) / 10,
        reasons: [...new Set(reasons)].slice(0, 8),
        material: materialPublicView(m),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const limit = Math.min(Math.max(q.limit ?? 8, 1), 24);
  return scored.slice(0, limit);
}
