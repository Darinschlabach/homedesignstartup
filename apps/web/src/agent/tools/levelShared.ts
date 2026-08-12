/**
 * Shared helpers for level agent tools.
 */
import {
  isShellWallId,
  LevelSchema,
  topShellLevel,
  type BuildingModelV1,
  type Level,
} from "@aihd/domain";

export function scrubNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

export function listLevels(model: BuildingModelV1): Level[] {
  return model.levels.map((l) => LevelSchema.parse(l));
}

export function summarizeLevelBrief(level: Level): Record<string, unknown> {
  return {
    id: level.id,
    name: level.name,
    elevation: level.elevation,
    height: level.height,
    footprintSource: level.footprintSource,
    topElevation: level.elevation + level.height,
  };
}

export function summarizeLevelDetail(
  model: BuildingModelV1,
  level: Level,
): Record<string, unknown> {
  const exteriorWalls = model.walls.filter(
    (w) => w.levelId === level.id && isShellWallId(w.id),
  );
  const interiorWalls = model.walls.filter(
    (w) => w.levelId === level.id && !isShellWallId(w.id),
  );
  const spaces = model.spaces.filter((s) => s.levelId === level.id);
  const slabs = model.slabs.filter((s) => s.levelId === level.id);
  const wallIds = new Set(
    model.walls.filter((w) => w.levelId === level.id).map((w) => w.id),
  );
  const openings = model.openings.filter((o) => wallIds.has(o.wallId));
  const shellOpenings = (model.shell?.openings ?? []).filter(
    (o) => (o.levelId ?? model.levels[0]?.id) === level.id,
  );
  const objects = (model.entities ?? []).filter(
    (e) => e.levelId === level.id && e.type !== "level",
  );
  const roofAssemblies = (model.roofAssemblies ?? []).filter(
    (a) => a.levelId === level.id,
  );
  const roofs = model.roofs.filter((r) => r.levelId === level.id);
  const roofTop = topShellLevel(model);
  const roofAssociated =
    roofTop.id === level.id ||
    roofAssemblies.length > 0 ||
    roofs.length > 0;

  return {
    ...summarizeLevelBrief(level),
    exteriorWalls: exteriorWalls.map((w) => ({
      id: w.id,
      height: w.height ?? level.height,
      start: w.start,
      end: w.end,
    })),
    interiorWalls: interiorWalls.map((w) => ({
      id: w.id,
      height: w.height ?? level.height,
      start: w.start,
      end: w.end,
    })),
    spaces: spaces.map((s) => ({
      id: s.id,
      name: s.name,
      tags: s.tags,
      vertexCount: s.polygon.length,
    })),
    openings: {
      model: openings.map((o) => ({
        id: o.id,
        kind: o.kind,
        wallId: o.wallId,
        width: o.width,
        height: o.height,
        sillHeight: o.sillHeight,
      })),
      shell: shellOpenings.map((o) => ({
        id: o.id,
        type: o.type,
        wall: o.wall,
        width: o.width,
        height: o.height,
        sillHeight: o.sillHeight,
        levelId: o.levelId ?? model.levels[0]?.id ?? null,
      })),
    },
    placedObjects: objects.map((e) => ({
      id: e.id,
      type: e.type,
      x: e.geometry.x ?? null,
      y: e.geometry.y ?? null,
      z: e.geometry.z ?? null,
    })),
    slabs: slabs.map((s) => ({
      id: s.id,
      thickness: s.thickness,
      materialId: s.materialId ?? null,
    })),
    roof: {
      associatedWithThisLevel: roofAssociated,
      isRoofBearingStory: roofTop.id === level.id,
      roofBearingLevelId: roofTop.id,
      assemblyIds: roofAssemblies.map((a) => a.id),
      roofIds: roofs.map((r) => r.id),
      note: roofTop.id === level.id
        ? "Roof eaves bear on the top of this level."
        : `Roof currently bears on ${roofTop.id} (elevation ${roofTop.elevation + roofTop.height}).`,
    },
    constraints: {
      footprintSource: level.footprintSource,
      supportedFootprintSources: ["shell", "custom"],
      unsupported: [
        "rotated footprints",
        "freeform footprint polygons",
        "automatic lower-roof masses for exposed regions",
        "force-delete of levels with dependents via agent tools",
      ],
      note: "create_level adds shell-backed stories. Use inspect_level_footprint / set_level_footprint / modify_level_footprint / clear_level_footprint for axis-aligned partial/setback upper stories. Use create_stair for vertical circulation.",
    },
  };
}
