import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  extractShellFromModel,
  getEntity,
  listEntities,
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

function wallLengthFromGeometry(start?: { x: number; y: number }, end?: { x: number; y: number }) {
  if (!start || !end) return null;
  return Math.round(Math.hypot(end.x - start.x, end.y - start.y) * 100) / 100;
}

export const inspectWallTool = tool({
  name: "inspect_wall",

  description:
    "Read-only detailed inspection of one wall from the latest committed BuildingModelV1, including hosted openings and spacing. Prefer this when asking about room around a window/door on a wall.",

  parameters: z.object({
    wallId: z.string().min(1),
  }),

  execute: async (args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;

    homeDesignAgentDevLog("inspect_wall_execute_start", {
      tool: "inspect_wall",
      arguments: args,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const loaded = await loadAgentModel(context);
    if (!loaded.success) {
      homeDesignAgentDevLog("inspect_wall_execute_end", {
        tool: "inspect_wall",
        arguments: args,
        ok: false,
        resultSummary: { code: loaded.code, error: loaded.error },
      });
      return loaded;
    }

    const wallEntity =
      getEntity(loaded.model, args.wallId) ??
      resolveSelectedEntity(loaded.model, args.wallId);
    const wallRow = loaded.model.walls.find((w) => w.id === args.wallId);

    if (!wallEntity && !wallRow) {
      const failure = {
        success: false as const,
        error: `Wall not found: ${args.wallId}`,
        code: "WALL_NOT_FOUND" as const,
        projectId: loaded.projectId,
        revision: loaded.revision,
      };
      homeDesignAgentDevLog("inspect_wall_execute_end", {
        tool: "inspect_wall",
        arguments: args,
        ok: false,
        resultSummary: failure,
      });
      return failure;
    }

    const wallId = wallEntity?.id ?? wallRow!.id;
    const face =
      (wallEntity?.properties.face as ShellWallFace | undefined) ??
      WALL_ID_TO_FACE[wallId];
    const shell = extractShellFromModel(loaded.model);
    const start = wallRow?.start ??
      (wallEntity?.geometry.start as { x: number; y: number } | undefined);
    const end = wallRow?.end ??
      (wallEntity?.geometry.end as { x: number; y: number } | undefined);
    const lengthFt =
      (shell && face ? wallLengthForFace(shell, face) : null) ??
      wallLengthFromGeometry(start, end);
    const height =
      wallRow?.height ??
      (typeof wallEntity?.geometry.height === "number"
        ? wallEntity.geometry.height
        : shell?.wallHeight ?? null);
    const thickness =
      wallRow?.thickness ??
      (typeof wallEntity?.geometry.thickness === "number"
        ? wallEntity.geometry.thickness
        : shell?.wallThickness ?? null);
    const materialId = wallRow?.materialId ?? wallEntity?.materialId;
    const material = loaded.model.materials.find((m) => m.id === materialId);

    const openings = listEntities(loaded.model)
      .filter((e) => {
        if (!OPENING_TYPES.has(String(e.type))) return false;
        if (e.parentId === wallId) return true;
        if (face && e.properties.wall === face) return true;
        return false;
      })
      .map((e) => {
        const width = Number(e.geometry.width ?? 0);
        const offset = Number(e.geometry.offset ?? 0);
        return {
          id: e.id,
          type: e.type,
          subtype: e.properties.kind ?? null,
          widthFt: Number.isFinite(width) ? width : null,
          heightFt:
            typeof e.geometry.height === "number" ? e.geometry.height : null,
          sillHeightFt:
            typeof e.geometry.sillHeight === "number"
              ? e.geometry.sillHeight
              : null,
          offsetFt: Number.isFinite(offset) ? offset : null,
          spaceBeforeFt:
            lengthFt != null && Number.isFinite(offset) ? offset : null,
          spaceAfterFt:
            lengthFt != null && Number.isFinite(offset) && Number.isFinite(width)
              ? Math.max(0, lengthFt - offset - width)
              : null,
          protected: (loaded.model.protectedEntityIds ?? []).includes(e.id),
        };
      })
      .sort((a, b) => (a.offsetFt ?? 0) - (b.offsetFt ?? 0));

    const spacing: Array<Record<string, unknown>> = [];
    if (lengthFt != null && openings.length > 0) {
      const first = openings[0]!;
      if (first.offsetFt != null) {
        spacing.push({
          from: "wall-start",
          to: first.id,
          gapFt: first.offsetFt,
        });
      }
      for (let i = 0; i < openings.length - 1; i++) {
        const a = openings[i]!;
        const b = openings[i + 1]!;
        if (a.offsetFt != null && a.widthFt != null && b.offsetFt != null) {
          spacing.push({
            from: a.id,
            to: b.id,
            gapFt: Math.round((b.offsetFt - (a.offsetFt + a.widthFt)) * 100) / 100,
          });
        }
      }
      const last = openings[openings.length - 1]!;
      if (last.offsetFt != null && last.widthFt != null) {
        spacing.push({
          from: last.id,
          to: "wall-end",
          gapFt:
            Math.round((lengthFt - (last.offsetFt + last.widthFt)) * 100) / 100,
        });
      }
    }

    const result = {
      success: true as const,
      projectId: loaded.projectId,
      revision: loaded.revision,
      revisionId: loaded.revisionId,
      source: "BuildingModelV1" as const,
      units: loaded.units,
      wall: {
        id: wallId,
        face: face ?? null,
        levelId: wallRow?.levelId ?? wallEntity?.levelId ?? null,
        start: start ?? null,
        end: end ?? null,
        lengthFt,
        heightFt: height,
        thicknessFt: thickness,
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
        protected: (loaded.model.protectedEntityIds ?? []).includes(wallId),
        constraints: (loaded.model.constraints ?? []).filter(
          (c) =>
            c.id.includes(wallId) ||
            c.text.toLowerCase().includes(String(face ?? wallId).toLowerCase()),
        ),
        openings,
        spacing,
      },
    };

    homeDesignAgentDevLog("inspect_wall_execute_end", {
      tool: "inspect_wall",
      arguments: args,
      ok: true,
      resultSummary: {
        projectId: result.projectId,
        revision: result.revision,
        wallId: result.wall.id,
        lengthFt: result.wall.lengthFt,
        openingCount: result.wall.openings.length,
      },
    });

    return result;
  },
});
