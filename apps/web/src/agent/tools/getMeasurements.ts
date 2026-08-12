import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  checkClearance,
  extractShellFromModel,
  getEntity,
  getObject,
  listEntities,
  measureDistance,
  resolveSelectedEntity,
  WALL_ID_TO_FACE,
  wallLengthForFace,
  type ShellWallFace,
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

function pointForEntity(entity: {
  geometry: Record<string, unknown>;
  type: string;
  properties: Record<string, unknown>;
  parentId?: string;
}): { x: number; y?: number; z?: number } | null {
  const g = entity.geometry;
  if (
    typeof g.x === "number" &&
    (typeof g.z === "number" || typeof g.y === "number")
  ) {
    return {
      x: g.x,
      y: typeof g.y === "number" ? g.y : 0,
      z: typeof g.z === "number" ? g.z : typeof g.y === "number" ? g.y : 0,
    };
  }
  // Openings: approximate along-wall position using offset as 1D measure (caller may prefer opening_spacing).
  if (OPENING_TYPES.has(String(entity.type)) && typeof g.offset === "number") {
    return { x: g.offset, y: typeof g.sillHeight === "number" ? g.sillHeight : 0, z: 0 };
  }
  return null;
}

export const getMeasurementsTool = tool({
  name: "get_measurements",

  description:
    "Read-only measurements from the latest committed BuildingModelV1. Use for object dimensions, wall length, distance between objects, opening spacing on a wall, or clearance checks. Does not invent geometry — returns only values available from the model/helpers.",

  parameters: z.object({
    query: z.enum([
      "object_dimensions",
      "wall_length",
      "distance",
      "opening_spacing",
      "clearance",
    ]),
    objectId: z.string().min(1).optional(),
    wallId: z.string().min(1).optional(),
    objectIdA: z.string().min(1).optional(),
    objectIdB: z.string().min(1).optional(),
    requiredClearanceFt: z.number().positive().optional(),
  }),

  execute: async (args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;

    homeDesignAgentDevLog("get_measurements_execute_start", {
      tool: "get_measurements",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const loaded = await loadAgentModel(context);
    if (!loaded.success) {
      homeDesignAgentDevLog("get_measurements_execute_end", {
        tool: "get_measurements",
        arguments: args,
        ok: false,
        resultSummary: { code: loaded.code, error: loaded.error },
      });
      return loaded;
    }

    const units = loaded.units;
    const resolveId = (id?: string) => {
      const raw = id?.trim();
      if (
        !raw ||
        ["selected", "selection", "this", "that", "it"].includes(raw.toLowerCase())
      ) {
        return context?.selectedEntityId ?? undefined;
      }
      return raw;
    };
    const objectId = resolveId(args.objectId);
    const objectIdA = resolveId(args.objectIdA);
    const objectIdB = resolveId(args.objectIdB);

    const fail = (error: string, code: string) => {
      const failure = {
        success: false as const,
        error,
        code,
        projectId: loaded.projectId,
        revision: loaded.revision,
        units,
      };
      homeDesignAgentDevLog("get_measurements_execute_end", {
        tool: "get_measurements",
        arguments: args,
        ok: false,
        resultSummary: failure,
      });
      return failure;
    };

    let result: Record<string, unknown>;

    if (args.query === "object_dimensions") {
      if (!objectId) {
        return fail(
          "objectId is required for object_dimensions (or select an entity).",
          "MISSING_ARGS",
        );
      }
      const obj = getObject(loaded.model, objectId);
      if (!obj) return fail(`Object not found: ${objectId}`, "OBJECT_NOT_FOUND");
      result = {
        success: true,
        query: args.query,
        projectId: loaded.projectId,
        revision: loaded.revision,
        units,
        objectId: obj.id,
        type: obj.type,
        dimensions: {
          width: obj.geometry.width ?? null,
          height: obj.geometry.height ?? null,
          depth: obj.geometry.depth ?? null,
          sillHeight: obj.geometry.sillHeight ?? null,
          offset: obj.geometry.offset ?? null,
        },
        position: {
          x: obj.geometry.x ?? null,
          y: obj.geometry.y ?? null,
          z: obj.geometry.z ?? null,
          offset: obj.geometry.offset ?? null,
        },
        rotationY: obj.geometry.rotationY ?? null,
      };
    } else if (args.query === "wall_length") {
      if (!args.wallId) {
        return fail("wallId is required for wall_length.", "MISSING_ARGS");
      }
      const wall =
        loaded.model.walls.find((w) => w.id === args.wallId) ??
        getEntity(loaded.model, args.wallId);
      if (!wall) return fail(`Wall not found: ${args.wallId}`, "WALL_NOT_FOUND");
      const face =
        ("properties" in wall
          ? (wall.properties.face as ShellWallFace | undefined)
          : undefined) ?? WALL_ID_TO_FACE[args.wallId];
      const shell = extractShellFromModel(loaded.model);
      const lengthFt =
        shell && face
          ? wallLengthForFace(shell, face)
          : "start" in wall && "end" in wall
            ? Math.round(
                Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) *
                  100,
              ) / 100
            : null;
      if (lengthFt == null) {
        return fail("Wall length is not available for this wall.", "NO_MEASUREMENT");
      }
      result = {
        success: true,
        query: args.query,
        projectId: loaded.projectId,
        revision: loaded.revision,
        units,
        wallId: args.wallId,
        face: face ?? null,
        lengthFt,
      };
    } else if (args.query === "distance") {
      if (!objectIdA || !objectIdB) {
        return fail(
          "objectIdA and objectIdB are required for distance.",
          "MISSING_ARGS",
        );
      }
      const a =
        resolveSelectedEntity(loaded.model, objectIdA) ??
        getEntity(loaded.model, objectIdA);
      const b =
        resolveSelectedEntity(loaded.model, objectIdB) ??
        getEntity(loaded.model, objectIdB);
      if (!a || !b) {
        return fail("One or both objects were not found.", "OBJECT_NOT_FOUND");
      }
      const pa = pointForEntity(a);
      const pb = pointForEntity(b);
      if (!pa || !pb) {
        return fail(
          "Distance could not be computed — objects lack comparable position geometry. For openings on a wall, use opening_spacing.",
          "NO_MEASUREMENT",
        );
      }
      const measured = measureDistance(pa, pb);
      result = {
        success: true,
        query: args.query,
        projectId: loaded.projectId,
        revision: loaded.revision,
        units,
        objectIdA: a.id,
        objectIdB: b.id,
        ...measured,
        note: OPENING_TYPES.has(String(a.type)) || OPENING_TYPES.has(String(b.type))
          ? "Opening distance uses offset/sill coordinates when free 3D pose is unavailable."
          : undefined,
      };
    } else if (args.query === "opening_spacing") {
      if (!args.wallId) {
        return fail("wallId is required for opening_spacing.", "MISSING_ARGS");
      }
      const face = WALL_ID_TO_FACE[args.wallId];
      const shell = extractShellFromModel(loaded.model);
      const lengthFt =
        shell && face ? wallLengthForFace(shell, face) : null;
      if (lengthFt == null) {
        return fail("Wall length unavailable for opening spacing.", "NO_MEASUREMENT");
      }
      const openings = listEntities(loaded.model)
        .filter((e) => {
          if (!OPENING_TYPES.has(String(e.type))) return false;
          if (e.parentId === args.wallId) return true;
          if (face && e.properties.wall === face) return true;
          return false;
        })
        .map((e) => ({
          id: e.id,
          type: e.type,
          offsetFt: Number(e.geometry.offset ?? NaN),
          widthFt: Number(e.geometry.width ?? NaN),
        }))
        .filter((o) => Number.isFinite(o.offsetFt) && Number.isFinite(o.widthFt))
        .sort((a, b) => a.offsetFt - b.offsetFt);

      const gaps: Array<Record<string, unknown>> = [];
      if (openings[0]) {
        gaps.push({
          from: "wall-start",
          to: openings[0].id,
          gapFt: openings[0].offsetFt,
        });
      }
      for (let i = 0; i < openings.length - 1; i++) {
        const a = openings[i]!;
        const b = openings[i + 1]!;
        gaps.push({
          from: a.id,
          to: b.id,
          gapFt: Math.round((b.offsetFt - (a.offsetFt + a.widthFt)) * 100) / 100,
        });
      }
      if (openings.length > 0) {
        const last = openings[openings.length - 1]!;
        gaps.push({
          from: last.id,
          to: "wall-end",
          gapFt:
            Math.round((lengthFt - (last.offsetFt + last.widthFt)) * 100) / 100,
        });
      }

      // Optional focus on one opening
      let focus: Record<string, unknown> | null = null;
      if (objectId) {
        const target = openings.find((o) => o.id === objectId);
        if (target) {
          focus = {
            objectId: target.id,
            spaceBeforeFt: target.offsetFt,
            spaceAfterFt: Math.max(
              0,
              Math.round((lengthFt - (target.offsetFt + target.widthFt)) * 100) /
                100,
            ),
            widthFt: target.widthFt,
            wallLengthFt: lengthFt,
          };
        }
      }

      result = {
        success: true,
        query: args.query,
        projectId: loaded.projectId,
        revision: loaded.revision,
        units,
        wallId: args.wallId,
        wallLengthFt: lengthFt,
        openings,
        gaps,
        focus,
      };
    } else {
      // clearance
      if (!objectId) {
        return fail(
          "objectId is required for clearance (or select an entity).",
          "MISSING_ARGS",
        );
      }
      const required = args.requiredClearanceFt ?? 0.5;
      const clearance = checkClearance(loaded.model, objectId, required);
      result = {
        success: true,
        query: args.query,
        projectId: loaded.projectId,
        revision: loaded.revision,
        units,
        ...clearance,
      };
    }

    homeDesignAgentDevLog("get_measurements_execute_end", {
      tool: "get_measurements",
      arguments: args,
      ok: true,
      resultSummary: {
        query: args.query,
        projectId: loaded.projectId,
        revision: loaded.revision,
        units,
      },
    });

    return result;
  },
});
