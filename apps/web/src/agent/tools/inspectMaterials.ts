import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import type { BuildingModelV1 } from "@aihd/domain";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import { loadAgentModel } from "../project/loadAgentModel";

type MaterialUsage = {
  objectId: string;
  objectType: string;
  source: "wall" | "roof" | "slab" | "entity" | "structure";
};

function compactMaterial(model: BuildingModelV1) {
  const usageByMaterial = new Map<string, MaterialUsage[]>();

  const add = (
    materialId: string | undefined,
    usage: MaterialUsage,
  ) => {
    if (!materialId) return;
    const list = usageByMaterial.get(materialId) ?? [];
    list.push(usage);
    usageByMaterial.set(materialId, list);
  };

  for (const wall of model.walls) {
    add(wall.materialId, {
      objectId: wall.id,
      objectType: "exteriorWall",
      source: "wall",
    });
  }
  for (const roof of model.roofs) {
    add(roof.materialId, {
      objectId: roof.id,
      objectType: "roof",
      source: "roof",
    });
  }
  for (const slab of model.slabs) {
    add(slab.materialId, {
      objectId: slab.id,
      objectType: "floorSlab",
      source: "slab",
    });
  }

  const covered = new Set<string>();
  for (const wall of model.walls) covered.add(wall.id);
  for (const roof of model.roofs) covered.add(roof.id);
  for (const slab of model.slabs) covered.add(slab.id);

  for (const ent of model.entities ?? []) {
    if (covered.has(ent.id)) continue;
    if (!ent.materialId) continue;
    // Openings have no materialId on OpeningSchema; entity-only refs are still reported.
    add(ent.materialId, {
      objectId: ent.id,
      objectType: String(ent.type),
      source: "entity",
    });
  }

  return (model.materials ?? []).map((m) => {
    const usedBy = usageByMaterial.get(m.id) ?? [];
    return {
      id: m.id,
      name: m.name,
      category: m.category,
      color: m.color,
      texture: null as string | null,
      finish: {
        roughness: m.roughness,
        metalness: m.metalness,
      },
      usedByCount: usedBy.length,
      shared: usedBy.length > 1,
      usedBy: usedBy.slice(0, 24),
    };
  });
}

export const inspectMaterialsTool = tool({
  name: "inspect_materials",

  description:
    "Read-only catalog of materials in the latest committed BuildingModelV1: ids, names, categories, colors, finish properties (roughness/metalness), and which objects currently use each material. Existing materials are reusable options — not the full design vocabulary. Use find_material to search by concept, or create_material when nothing fits.",

  parameters: z.object({}),

  execute: async (_args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;

    homeDesignAgentDevLog("inspect_materials_execute_start", {
      tool: "inspect_materials",
      arguments: {},
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const loaded = await loadAgentModel(context);
    if (!loaded.success) {
      homeDesignAgentDevLog("inspect_materials_execute_end", {
        tool: "inspect_materials",
        ok: false,
        resultSummary: loaded,
      });
      return loaded;
    }

    const materials = compactMaterial(loaded.model);
    const result = {
      success: true as const,
      projectId: loaded.projectId,
      revision: loaded.revision,
      revisionId: loaded.revisionId,
      source: "BuildingModelV1" as const,
      materialCount: materials.length,
      materials,
      notes: [
        "Supported fields: id, name, category, color, roughness, metalness.",
        "Textures, normal maps, opacity, and texture scale are NOT supported.",
        "shared=true means multiple objects reference the material — do not globally edit it unless you intend every user to change.",
        "For a unique object finish, apply_material clones by default (finishScope=object).",
        "Existing materials are reusable options; create_material can add new ones into the staged operation.",
      ],
      modelSource: loaded.source,
      dirty: loaded.dirty,
      operationId: loaded.operationId ?? null,
    };

    homeDesignAgentDevLog("inspect_materials_execute_end", {
      tool: "inspect_materials",
      ok: true,
      projectId: loaded.projectId,
      revision: loaded.revision,
      materialCount: materials.length,
      materialIds: materials.map((m) => m.id),
    });

    return result;
  },
});
