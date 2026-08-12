import { tool } from "@openai/agents";
import { z } from "zod";
import { getProjectState, getScene, extractShellFromModel } from "@aihd/domain";
import type { BuildingModelV1 } from "@aihd/domain";
import type { RunContext } from "@openai/agents";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import { loadAgentModel } from "../project/loadAgentModel";
import { createClient } from "@/lib/supabase/server";

type InspectSuccess = {
  success: true;
  projectId: string;
  revision: number;
  revisionId: string;
  source: "BuildingModelV1";
  buildingType: string;
  name: string;
  units: string;
  footprint: { width: number; depth: number; wallHeight: number } | null;
  levels: Array<{ id: string; name?: string; elevation?: number; height?: number }>;
  rooms: Array<{ id: string; name: string; levelId?: string; tags?: string[] }>;
  walls: Array<{ id: string; face?: unknown; lengthApprox?: number }>;
  openings: {
    windows: Array<Record<string, unknown>>;
    doors: Array<Record<string, unknown>>;
    garageDoors: Array<Record<string, unknown>>;
    other: Array<Record<string, unknown>>;
  };
  entities: Array<Record<string, unknown>>;
  interiors: Array<Record<string, unknown>>;
  materials: Array<{ id: string; name?: string; category?: string; color?: string }>;
  constraints: BuildingModelV1["constraints"];
  protectedEntityIds: string[];
  selected: Record<string, unknown> | null;
  scene: {
    wallCount: number;
    openingCount: number;
    roofCount: number;
    interiorCount: number;
  };
  entityCount: number;
};

type InspectFailure = {
  success: false;
  error: string;
  code:
    | "MISSING_CONTEXT"
    | "UNAUTHORIZED"
    | "PROJECT_NOT_FOUND"
    | "NO_REVISION"
    | "INVALID_MODEL"
    | "NO_GEOMETRY"
    | "INSPECT_FAILED";
  projectId?: string;
};

function hasPersistedGeometry(model: BuildingModelV1): boolean {
  const shell = extractShellFromModel(model);
  if (shell && (shell.width > 0 || shell.depth > 0)) return true;
  if (model.walls.length > 0) return true;
  if (model.openings.length > 0) return true;
  if ((model.entities ?? []).some((e) => e.type !== "level")) return true;
  if (model.spaces.length > 0) return true;
  return false;
}

function compactOpening(summary: Record<string, unknown>) {
  return {
    id: summary.id,
    type: summary.type,
    parentId: summary.parentId,
    materialId: summary.materialId,
    geometry: summary.geometry,
    properties: summary.properties,
  };
}

function partitionOpenings(openings: unknown[]) {
  const windows: Array<Record<string, unknown>> = [];
  const doors: Array<Record<string, unknown>> = [];
  const garageDoors: Array<Record<string, unknown>> = [];
  const other: Array<Record<string, unknown>> = [];

  for (const raw of openings) {
    const o = compactOpening((raw ?? {}) as Record<string, unknown>);
    const type = String(o.type ?? "");
    if (type === "window") windows.push(o);
    else if (type === "exteriorDoor" || type === "door") doors.push(o);
    else if (type === "garageDoor") garageDoors.push(o);
    else other.push(o);
  }

  return { windows, doors, garageDoors, other };
}

function buildCompactInspectResult(options: {
  projectId: string;
  revision: number;
  revisionId: string;
  model: BuildingModelV1;
  selectedEntityId?: string | null;
}): InspectSuccess {
  const { projectId, revision, revisionId, model, selectedEntityId } = options;
  const state = getProjectState(model, selectedEntityId);
  const scene = getScene(model);
  const openings = partitionOpenings(state.openings as Array<Record<string, unknown>>);

  return {
    success: true,
    projectId,
    revision,
    revisionId,
    source: "BuildingModelV1",
    buildingType: state.meta.buildingType,
    name: state.meta.name,
    units: state.meta.units,
    footprint: state.footprint,
    levels: state.levels.map((l) => ({
      id: l.id,
      name: l.name,
      elevation: l.elevation,
      height: l.height,
    })),
    rooms: state.rooms.map((r) => ({
      id: r.id,
      name: r.name,
      levelId: r.levelId,
      tags: r.tags,
    })),
    walls: state.walls,
    openings,
    entities: (model.entities ?? []).map((e) => ({
      id: e.id,
      type: e.type,
      parentId: e.parentId,
      levelId: e.levelId,
      materialId: e.materialId,
      geometry: e.geometry,
      properties: e.properties,
    })),
    interiors: state.interiors as Array<Record<string, unknown>>,
    materials: state.materials.map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      color: m.color,
    })),
    constraints: state.constraints,
    protectedEntityIds: state.protectedEntityIds,
    selected: (state.selected as Record<string, unknown> | null) ?? null,
    scene: {
      wallCount: scene.walls.length,
      openingCount: scene.openings.length,
      roofCount: scene.roofs.length,
      interiorCount: scene.interiors.length,
    },
    entityCount: state.entityCount,
  };
}

export function summarizeInspectResultForLog(result: InspectSuccess | InspectFailure) {
  if (!result.success) {
    return {
      success: false,
      code: result.code,
      error: result.error,
      projectId: result.projectId,
    };
  }

  return {
    success: true,
    projectId: result.projectId,
    revision: result.revision,
    source: result.source,
    buildingType: result.buildingType,
    footprint: result.footprint,
    levelCount: result.levels.length,
    roomCount: result.rooms.length,
    wallCount: result.walls.length,
    windowCount: result.openings.windows.length,
    doorCount: result.openings.doors.length,
    entityCount: result.entityCount,
    materialCount: result.materials.length,
    protectedCount: result.protectedEntityIds.length,
  };
}

export const inspectProjectTool = tool({
  name: "inspect_project",

  description:
    "Inspect the current real project design (BuildingModelV1 from the latest revision). Read-only. Use before recommending or planning changes.",

  parameters: z.object({}),

  execute: async (args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const projectId = context?.projectId;

    homeDesignAgentDevLog("inspect_project_execute_start", {
      tool: "inspect_project",
      arguments: args ?? {},
      projectId: projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const fail = (failure: InspectFailure) => {
      homeDesignAgentDevLog("inspect_project_execute_end", {
        tool: "inspect_project",
        arguments: args ?? {},
        ok: false,
        resultSummary: summarizeInspectResultForLog(failure),
      });
      return failure;
    };

    try {
      if (!context?.projectId || !context.userId) {
        return fail({
          success: false,
          error: "Agent context is missing projectId or userId.",
          code: "MISSING_CONTEXT",
        });
      }

      const supabase = await createClient();
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id, name, building_type")
        .eq("id", context.projectId)
        .maybeSingle();

      if (projectError) {
        return fail({
          success: false,
          error: projectError.message || "Failed to load project.",
          code: "UNAUTHORIZED",
          projectId: context.projectId,
        });
      }

      if (!project) {
        return fail({
          success: false,
          error: `Project not found or access denied: ${context.projectId}`,
          code: "PROJECT_NOT_FOUND",
          projectId: context.projectId,
        });
      }

      const loaded = await loadAgentModel(context);
      if (!loaded.success) {
        return fail({
          success: false,
          error: loaded.error,
          code: loaded.code as InspectFailure["code"],
          projectId: context.projectId,
        });
      }

      const model = loaded.model;

      if (!hasPersistedGeometry(model)) {
        return fail({
          success: false,
          error:
            "Project has no persisted design geometry. A default viewer building may appear in 3D but is not saved — do not treat it as project data.",
          code: "NO_GEOMETRY",
          projectId: context.projectId,
        });
      }

      const result = {
        ...buildCompactInspectResult({
          projectId: context.projectId,
          revision: loaded.revision,
          revisionId: loaded.revisionId,
          model,
          selectedEntityId: context.selectedEntityId,
        }),
        modelSource: loaded.source,
        dirty: loaded.dirty,
        operationId: loaded.operationId ?? null,
      };

      if (context.operation) {
        context.operation.runMetrics.inspectProjectCount += 1;
      }

      homeDesignAgentDevLog("inspect_project_execute_end", {
        tool: "inspect_project",
        arguments: args ?? {},
        ok: true,
        resultSummary: summarizeInspectResultForLog(result),
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unauthorized = /unauthor/i.test(message);
      return fail({
        success: false,
        error: message,
        code: unauthorized ? "UNAUTHORIZED" : "INSPECT_FAILED",
        projectId,
      });
    }
  },
});
