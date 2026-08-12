import { tool } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import {
  extractShellFromModel,
  isShellWallId,
  wallLengthForFace,
  WALL_FACE_IDS,
  type ShellWallFace,
} from "@aihd/domain";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import { loadAgentModel } from "../project/loadAgentModel";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function wallLength(start: { x: number; y: number }, end: { x: number; y: number }) {
  return round2(Math.hypot(end.x - start.x, end.y - start.y));
}

export const inspectFootprintTool = tool({
  name: "inspect_footprint",

  description:
    "Read-only inspection of the parametric BuildingShell footprint: overall width/depth (feet), exterior shell segments, corners, openings per face, protection, affected interior walls/spaces, and roof relationship. Prefer this before modify_footprint.",

  parameters: z.object({}).strict(),

  execute: async (_args, runContext?: RunContext<DesignAgentContext>) => {
    const context = runContext?.context;

    homeDesignAgentDevLog("inspect_footprint_execute_start", {
      tool: "inspect_footprint",
      arguments: {},
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    const loaded = await loadAgentModel(context);
    if (!loaded.success) {
      homeDesignAgentDevLog("inspect_footprint_execute_end", {
        tool: "inspect_footprint",
        ok: false,
        resultSummary: { code: loaded.code, error: loaded.error },
      });
      return loaded;
    }

    const shell = extractShellFromModel(loaded.model);
    if (!shell) {
      const failure = {
        success: false as const,
        error: "No parametric BuildingShell footprint is present on this model.",
        code: "NO_SHELL" as const,
        projectId: loaded.projectId,
        revision: loaded.revision,
        modelSource: loaded.source,
      };
      homeDesignAgentDevLog("inspect_footprint_execute_end", {
        tool: "inspect_footprint",
        ok: false,
        resultSummary: failure,
      });
      return failure;
    }

    const hw = shell.width / 2;
    const hd = shell.depth / 2;
    const corners = [
      { x: -hw, z: -hd, label: "front-left" },
      { x: hw, z: -hd, label: "front-right" },
      { x: hw, z: hd, label: "rear-right" },
      { x: -hw, z: hd, label: "rear-left" },
    ];

    const protectedIds = new Set(loaded.model.protectedEntityIds ?? []);
    const footprintProtected = protectedIds.has("shell-1");

    const faces: ShellWallFace[] = ["front", "rear", "left", "right"];
    const segments = faces.map((face) => {
      const wallId = WALL_FACE_IDS[face];
      const wall = loaded.model.walls.find((w) => w.id === wallId);
      const length = wallLengthForFace(shell, face);
      const openings = (shell.openings ?? [])
        .filter((o) => o.wall === face)
        .map((o) => ({
          id: o.id,
          type: o.type,
          offsetFt: o.offset,
          widthFt: o.width,
          heightFt: o.height,
          sillHeightFt: o.sillHeight,
          headHeightFt: o.sillHeight + o.height,
          remainingClearanceFt: round2(length - (o.offset + o.width)),
        }));
      return {
        id: wallId,
        face,
        lengthFt: round2(length),
        heightFt: wall?.height ?? shell.wallHeight,
        thicknessFt: wall?.thickness ?? shell.wallThickness,
        start: wall
          ? { x: wall.start.x, z: wall.start.y }
          : null,
        end: wall ? { x: wall.end.x, z: wall.end.y } : null,
        materialId: wall?.materialId ?? null,
        protected: protectedIds.has(wallId),
        openings,
        openingCount: openings.length,
      };
    });

    const interiorWalls = loaded.model.walls
      .filter((w) => !isShellWallId(w.id))
      .map((w) => ({
        id: w.id,
        lengthFt: wallLength(w.start, w.end),
        start: { x: w.start.x, z: w.start.y },
        end: { x: w.end.x, z: w.end.y },
        nearBoundary:
          Math.abs(Math.abs(w.start.x) - hw) < 0.25 ||
          Math.abs(Math.abs(w.end.x) - hw) < 0.25 ||
          Math.abs(Math.abs(w.start.y) - hd) < 0.25 ||
          Math.abs(Math.abs(w.end.y) - hd) < 0.25,
      }));

    const spaces = loaded.model.spaces.map((s) => {
      let area = 0;
      for (let i = 0; i < s.polygon.length; i++) {
        const a = s.polygon[i]!;
        const b = s.polygon[(i + 1) % s.polygon.length]!;
        area += a.x * b.y - b.x * a.y;
      }
      area = Math.abs(area) / 2;
      const outside = s.polygon.some(
        (p) => Math.abs(p.x) > hw + 0.05 || Math.abs(p.y) > hd + 0.05,
      );
      return {
        id: s.id,
        name: s.name,
        tags: s.tags,
        footprintSpace: s.id === "space-1",
        areaSqFt: round2(area),
        polygon: s.polygon.map((p) => ({ x: p.x, z: p.y })),
        outsideFootprint: outside,
        protected: protectedIds.has(s.id),
      };
    });

    const roof = shell.roof;
    const warnings: string[] = [];
    if (footprintProtected) {
      warnings.push(
        "Footprint is protected (shell-1): width/depth changes will be rejected; wallHeight-only may still be allowed.",
      );
    }
    for (const seg of segments) {
      for (const o of seg.openings) {
        if (o.remainingClearanceFt < 0.5) {
          warnings.push(
            `Opening ${o.id} on ${seg.face} has only ${o.remainingClearanceFt}ft clearance to wall end — shrinking this axis may fail OPENING_BOUNDS.`,
          );
        }
      }
    }
    for (const s of spaces) {
      if (s.outsideFootprint) {
        warnings.push(`Space ${s.id} currently has vertices outside the footprint.`);
      }
    }

    const result = {
      success: true as const,
      projectId: loaded.projectId,
      revision: loaded.revision,
      revisionId: loaded.revisionId,
      modelSource: loaded.source,
      dirty: loaded.dirty,
      units: "feet" as const,
      orientation: {
        plan: "building-centered origin",
        x: "width axis (left negative → right positive)",
        z: "depth axis (front negative → rear positive)",
        frontFace: "wall-front at z = -depth/2",
        note: "Rectangular shell resizes are center-anchored (both sides move). Choose width vs depth axis — not left/right grow direction.",
      },
      footprint: {
        widthFt: shell.width,
        depthFt: shell.depth,
        wallHeightFt: shell.wallHeight,
        wallThicknessFt: shell.wallThickness,
        areaSqFt: round2(shell.width * shell.depth),
        halfWidthFt: round2(hw),
        halfDepthFt: round2(hd),
      },
      corners,
      segments,
      shellOpeningCount: shell.openings.length,
      interiorWallsAffected: interiorWalls,
      spacesAffected: spaces,
      roof: {
        type: roof.type,
        pitch: roof.pitch,
        overhangFt: roof.overhang,
        ridgeDirection: roof.ridgeDirection,
        regeneratesFromShell: true,
        note: "Roof regenerates from shell params. Composed multi-mass roofs use create_roof_mass / modify_roof_mass.",
      },
      protection: {
        footprintProtected,
        protectedEntityIds: loaded.model.protectedEntityIds ?? [],
        widthDepthEditable: !footprintProtected,
        wallHeightEditable: true,
      },
      warnings,
      nextStep:
        "If changing exterior size, use modify_footprint (width/depth/wallHeight). Coordinate interior walls/spaces/openings in the same operation if validation conflicts appear.",
    };

    homeDesignAgentDevLog("inspect_footprint_execute_end", {
      tool: "inspect_footprint",
      ok: true,
      resultSummary: {
        widthFt: shell.width,
        depthFt: shell.depth,
        wallHeightFt: shell.wallHeight,
        segmentCount: segments.length,
        openingCount: shell.openings.length,
        footprintProtected,
        warningCount: warnings.length,
        modelSource: loaded.source,
      },
    });

    return result;
  },
});
