import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  getEntity,
  getObject,
  listEntities,
  resolveSelectedEntity,
  extractShellFromModel,
  WALL_ID_TO_FACE,
  wallLengthForFace,
} from "@aihd/domain";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import { loadAgentModel } from "../project/loadAgentModel";

const OPENING_TYPES = new Set([
  "window",
  "exteriorDoor",
  "garageDoor",
  "opening",
  "door",
]);

export const inspectObjectTool = tool({
  name: "inspect_object",

  description:
    "Read-only detailed inspection of one object/entity from the current agent working model (staged when dirty, otherwise committed). Prefer this over inspect_project when you need specifics about a single object. Omit objectId to use the UI selection; do not pass the literal string 'selected'. Returns OBJECT_NOT_FOUND if the id is absent from the staged/committed model.",

  parameters: z.object({
    objectId: z
      .string()
      .min(1)
      .optional()
      .describe("Object id. If omitted, uses the currently selected entity from run context when available."),
  }),

  execute: async (args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;
    const rawId = args.objectId?.trim();
    const looksLikeSelectionAlias =
      !rawId ||
      ["selected", "selection", "this", "that", "it"].includes(
        rawId.toLowerCase(),
      );
    const objectId = looksLikeSelectionAlias
      ? (context?.selectedEntityId ?? undefined)
      : rawId;

    homeDesignAgentDevLog("inspect_object_execute_start", {
      tool: "inspect_object",
      arguments: { objectId: objectId ?? null, providedObjectId: args.objectId ?? null },
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    if (!objectId) {
      const failure = {
        success: false as const,
        error:
          "No objectId provided and no selectedEntityId in agent context. Ask the user to select an object or supply an id.",
        code: "MISSING_OBJECT_ID" as const,
        projectId: context?.projectId,
      };
      homeDesignAgentDevLog("inspect_object_execute_end", {
        tool: "inspect_object",
        arguments: args,
        ok: false,
        resultSummary: failure,
      });
      return failure;
    }

    const loaded = await loadAgentModel(context);
    if (!loaded.success) {
      homeDesignAgentDevLog("inspect_object_execute_end", {
        tool: "inspect_object",
        arguments: { objectId },
        ok: false,
        resultSummary: { code: loaded.code, error: loaded.error },
      });
      return loaded;
    }

    const resolved =
      resolveSelectedEntity(loaded.model, objectId) ??
      getEntity(loaded.model, objectId);
    const summary = getObject(loaded.model, objectId);

    if (!resolved && !summary) {
      const failure = {
        success: false as const,
        error: `Object not found in ${loaded.source} model: ${objectId}${loaded.dirty ? " (staged working model — it may have been deleted in this operation)" : ""}`,
        code: "OBJECT_NOT_FOUND" as const,
        objectId,
        projectId: loaded.projectId,
        revision: loaded.revision,
        modelSource: loaded.source,
        dirty: loaded.dirty,
      };
      homeDesignAgentDevLog("inspect_object_execute_end", {
        tool: "inspect_object",
        arguments: { objectId },
        ok: false,
        resultSummary: failure,
      });
      return failure;
    }

    const id = resolved?.id ?? summary!.id;
    const type = String(resolved?.type ?? summary!.type);
    const geometry = (resolved?.geometry ?? summary!.geometry ?? {}) as Record<
      string,
      unknown
    >;
    const properties = (resolved?.properties ??
      summary!.properties ??
      {}) as Record<string, unknown>;
    const materialId = resolved?.materialId ?? summary!.materialId;
    const material = loaded.model.materials.find((m) => m.id === materialId);

    const related = listEntities(loaded.model)
      .filter(
        (e) =>
          e.id !== id &&
          (e.parentId === id ||
            e.id === resolved?.parentId ||
            (OPENING_TYPES.has(String(e.type)) &&
              (e.parentId === id || e.properties.wall === properties.wall))),
      )
      .map((e) => ({
        id: e.id,
        type: e.type,
        geometry: e.geometry,
        properties: e.properties,
      }));

    // For openings, include host wall clearance context if available.
    let hostWall: Record<string, unknown> | null = null;
    if (OPENING_TYPES.has(type)) {
      const wallId =
        resolved?.parentId ??
        (typeof properties.wall === "string"
          ? `wall-${properties.wall}`
          : undefined);
      const shell = extractShellFromModel(loaded.model);
      const face =
        (typeof properties.wall === "string"
          ? properties.wall
          : wallId
            ? WALL_ID_TO_FACE[wallId]
            : undefined) as "front" | "rear" | "left" | "right" | undefined;
      const wallLength =
        shell && face ? wallLengthForFace(shell, face) : undefined;
      const width = Number(geometry.width ?? 0);
      const offset = Number(geometry.offset ?? 0);
      hostWall = {
        wallId: wallId ?? null,
        face: face ?? null,
        wallLengthFt: wallLength ?? null,
        spaceBeforeFt:
          wallLength != null && Number.isFinite(offset) ? offset : null,
        spaceAfterFt:
          wallLength != null && Number.isFinite(offset) && Number.isFinite(width)
            ? Math.max(0, wallLength - offset - width)
            : null,
      };
    }

    const result = {
      success: true as const,
      projectId: loaded.projectId,
      revision: loaded.revision,
      revisionId: loaded.revisionId,
      source: "BuildingModelV1" as const,
      units: loaded.units,
      object: {
        id,
        type,
        subtype: properties.kind ?? properties.subtype ?? null,
        dimensions: {
          width: geometry.width ?? null,
          height: geometry.height ?? null,
          depth: geometry.depth ?? null,
          sillHeight: geometry.sillHeight ?? null,
          offset: geometry.offset ?? null,
        },
        position: {
          x: geometry.x ?? null,
          y: geometry.y ?? null,
          z: geometry.z ?? null,
          offset: geometry.offset ?? null,
          t: geometry.t ?? null,
        },
        rotation: {
          rotationY: geometry.rotationY ?? null,
        },
        parentId: resolved?.parentId ?? summary!.parentId ?? null,
        levelId: resolved?.levelId ?? summary!.levelId ?? null,
        material: material
          ? {
              id: material.id,
              name: material.name,
              category: material.category,
              color: material.color,
            }
          : materialId
            ? { id: materialId }
            : null,
        properties,
        protected: (loaded.model.protectedEntityIds ?? []).includes(id),
        hostWall,
        related,
      },
    };

    homeDesignAgentDevLog("inspect_object_execute_end", {
      tool: "inspect_object",
      arguments: args,
      ok: true,
      resultSummary: {
        projectId: result.projectId,
        revision: result.revision,
        objectId: result.object.id,
        type: result.object.type,
        dimensions: result.object.dimensions,
        protected: result.object.protected,
      },
    });

    return result;
  },
});
