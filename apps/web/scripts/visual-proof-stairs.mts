/**
 * Visual proof for stair domain geometry via the same render_preview pipeline
 * (buildBuildingGeometry → buildSceneMeshes → Playwright/Three).
 *
 * Usage:
 *   pnpm exec tsx --tsconfig tsconfig.json scripts/visual-proof-stairs.mts
 *
 * Does NOT use agent stair tools. Commits domain createStair ops to the test
 * project so the live viewport can load the same model. Leaves an undoable
 * revision history (restore prior revision to undo).
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  applyDesignOperations,
  buildBuildingGeometry,
  buildSceneMeshes,
  BuildingModelV1Schema,
  type BuildingModelV1,
} from "@aihd/domain";
import { renderBuildingPreview } from "../src/lib/render/renderBuildingPreview.ts";
import type { CameraSnapshot } from "../src/lib/render/cameraPose.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const outDir = path.join(webRoot, ".tmp-stair-visual");
const PROJECT_ID = "13efe9e0-1cea-40c5-bcf9-4c765dbced8b";
const EMAIL = "darinschlabach07@gmail.com";

function loadEnv() {
  return Object.fromEntries(
    readFileSync(path.join(webRoot, ".env.local"), "utf8")
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
}

function ensureTwoStory(model: BuildingModelV1): BuildingModelV1 {
  if (model.levels.some((l) => l.id === "level-2")) return model;
  return applyDesignOperations(model, [
    {
      op: "createLevel",
      name: "Second Floor",
      height: 9,
      footprintSource: "shell",
    },
  ]);
}

function stripStairs(model: BuildingModelV1): BuildingModelV1 {
  const stairs = model.stairs ?? [];
  if (stairs.length === 0) return model;
  return applyDesignOperations(
    model,
    stairs.map((s) => ({ op: "deleteStair" as const, stairId: s.id })),
  );
}

/** Cutaway helper for exterior inspection — not committed. */
function withoutFrontWalls(model: BuildingModelV1): BuildingModelV1 {
  return BuildingModelV1Schema.parse({
    ...model,
    walls: model.walls.filter(
      (w) => !w.id.startsWith("wall-front") && !w.id.startsWith("wall-left"),
    ),
  });
}

async function commitModel(
  admin: ReturnType<typeof createClient>,
  userId: string,
  model: BuildingModelV1,
  reason: string,
) {
  const latest = await admin
    .from("building_revisions")
    .select("revision")
    .eq("project_id", PROJECT_ID)
    .order("revision", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextRevision = (latest.data?.revision ?? 0) + 1;
  const { data, error } = await admin
    .from("building_revisions")
    .insert({
      project_id: PROJECT_ID,
      revision: nextRevision,
      model,
      checksum: `stair-visual-${nextRevision}`,
      created_by: userId,
      reason,
    })
    .select("revision,id")
    .single();
  if (error) throw error;
  return data as { revision: number; id: string };
}

async function renderViews(
  label: string,
  model: BuildingModelV1,
  revision: number,
  views: Array<{
    name: string;
    view: "perspective" | "top" | "left" | "right" | "front" | "current";
    camera?: CameraSnapshot;
    cutaway?: boolean;
  }>,
) {
  const results: Array<Record<string, unknown>> = [];
  for (const v of views) {
    const renderModel = v.cutaway ? withoutFrontWalls(model) : model;
    const rendered = await renderBuildingPreview({
      model: renderModel,
      view: v.view,
      width: 1280,
      height: 720,
      currentCamera: v.camera ?? null,
      projectId: PROJECT_ID,
      revision,
      modelSource: "committed",
    });
    if (!rendered.success) {
      results.push({
        name: v.name,
        ok: false,
        error: rendered.error,
        code: rendered.code,
      });
      continue;
    }
    const dest = path.join(outDir, `${label}-${v.name}.jpg`);
    copyFileSync(rendered.assetPath, dest);
    results.push({
      name: v.name,
      ok: true,
      path: dest,
      view: rendered.view,
      backend: rendered.renderBackend,
    });
  }
  return results;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const env = loadEnv();
  const admin = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: EMAIL,
  });
  if (linkErr) throw linkErr;
  const userId = linkData.user?.id;
  if (!userId) throw new Error("No user id for commit");

  const { data: latestRow, error: loadErr } = await admin
    .from("building_revisions")
    .select("revision,model")
    .eq("project_id", PROJECT_ID)
    .order("revision", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (loadErr) throw loadErr;
  if (!latestRow) throw new Error("No revision on test project");

  const baselineRevision = latestRow.revision as number;
  let model = BuildingModelV1Schema.parse(latestRow.model);
  model = ensureTwoStory(model);
  model = stripStairs(model);

  const l1 = model.levels.find((l) => l.id === "level-1")!;
  const l2 = model.levels.find((l) => l.id === "level-2")!;
  console.log(
    JSON.stringify(
      {
        baselineRevision,
        levels: model.levels.map((l) => ({
          id: l.id,
          elevation: l.elevation,
          height: l.height,
        })),
        rise: l2.elevation - l1.elevation,
      },
      null,
      2,
    ),
  );

  // --- Straight stair ---
  const straight = applyDesignOperations(model, [
    {
      op: "createStair",
      id: "stair-straight-visual",
      type: "straight",
      fromLevelId: "level-1",
      toLevelId: "level-2",
      origin: { x: -6, y: -18 },
      directionDeg: 90,
      width: 3.5,
      availableRun: 12,
    },
  ]);
  const straightGeom = buildBuildingGeometry(straight);
  const straightMeshes = buildSceneMeshes(straight);
  const straightDerived = straightGeom.stairs[0]!.derived;
  const straightMeta = {
    riserCount: straightDerived.riserCount,
    riserHeight: straightDerived.riserHeight,
    treadCount: straightDerived.treadCount,
    treadDepth: straightDerived.treadDepth,
    totalRise: straightDerived.totalRise,
    topElevation: straightDerived.topElevation,
    opening: straight.floorOpenings?.[0]?.polygon ?? null,
    meshCounts: {
      stairs: straightGeom.stairs.length,
      stairBoxes: straightMeshes.filter((m) => m.entityType === "stair").length,
      slabHoles: straightGeom.slabs.filter((s) => (s.holes?.length ?? 0) > 0)
        .length,
      extrudedSlabs: straightMeshes.filter((m) => m.kind === "extrudedPolygon")
        .length,
    },
  };
  console.log("straight", JSON.stringify(straightMeta, null, 2));

  const straightCommit = await commitModel(
    admin,
    userId,
    straight,
    "visual-proof: straight stair L1→L2",
  );

  const straightViews = await renderViews(
    "straight",
    straight,
    straightCommit.revision,
    [
      {
        name: "perspective-cutaway",
        view: "current",
        cutaway: true,
        camera: {
          position: { x: 18, y: 14, z: -8 },
          target: { x: -6, y: 5, z: -12 },
          fov: 42,
        },
      },
      {
        name: "interior-along-run",
        view: "current",
        camera: {
          position: { x: -6, y: 3.5, z: -22 },
          target: { x: -6, y: 6, z: -8 },
          fov: 50,
        },
      },
      {
        name: "top",
        view: "top",
        cutaway: true,
      },
      {
        name: "side",
        view: "current",
        cutaway: true,
        camera: {
          position: { x: 22, y: 8, z: -12 },
          target: { x: -6, y: 4.5, z: -12 },
          fov: 40,
        },
      },
    ],
  );

  // --- L-shaped stair ---
  const cleared = stripStairs(straight);
  const lShape = applyDesignOperations(cleared, [
    {
      op: "createStair",
      id: "stair-l-visual",
      type: "lShape",
      fromLevelId: "level-1",
      toLevelId: "level-2",
      origin: { x: -14, y: -12 },
      directionDeg: 0,
      turn: "left",
      width: 3.5,
      landingSize: 3.5,
      firstFlightRisers: 7,
      targetTreadDepth: 11 / 12,
    },
  ]);
  const lGeom = buildBuildingGeometry(lShape);
  const lDerived = lGeom.stairs[0]!.derived;
  const lMeta = {
    flights: lDerived.flights.length,
    landings: lDerived.landings.length,
    landingElev: lDerived.landings[0]?.elevation ?? null,
    totalRise: lDerived.totalRise,
    topElevation: lDerived.topElevation,
    opening: lShape.floorOpenings?.[0]?.polygon ?? null,
    meshCounts: {
      stairs: lGeom.stairs.length,
      slabHoles: lGeom.slabs.filter((s) => (s.holes?.length ?? 0) > 0).length,
    },
  };
  console.log("lShape", JSON.stringify(lMeta, null, 2));

  const lCommit = await commitModel(
    admin,
    userId,
    lShape,
    "visual-proof: L-shaped stair with landing",
  );

  const lViews = await renderViews("lshape", lShape, lCommit.revision, [
    {
      name: "perspective-cutaway",
      view: "current",
      cutaway: true,
      camera: {
        position: { x: 16, y: 16, z: 10 },
        target: { x: -8, y: 5, z: -6 },
        fov: 42,
      },
    },
    {
      name: "top",
      view: "top",
      cutaway: true,
    },
    {
      name: "interior",
      view: "current",
      camera: {
        position: { x: -4, y: 4, z: -4 },
        target: { x: -12, y: 5, z: -10 },
        fov: 50,
      },
    },
  ]);

  const summary = {
    projectId: PROJECT_ID,
    baselineRevision,
    straightRevision: straightCommit.revision,
    lShapeRevision: lCommit.revision,
    outDir,
    straight: { meta: straightMeta, views: straightViews },
    lShape: { meta: lMeta, views: lViews },
    note: "Live viewport loads latest revision (L-stair). Restore baselineRevision to undo.",
  };
  writeFileSync(
    path.join(outDir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
