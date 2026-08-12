/**
 * Re-render stair visual proofs from committed revisions 105 (straight) / 106 (L)
 * with fixed materials, hole winding, and tighter cameras.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, mkdirSync, copyFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  BuildingModelV1Schema,
  buildBuildingGeometry,
  type BuildingModelV1,
} from "@aihd/domain";
import { renderBuildingPreview } from "../src/lib/render/renderBuildingPreview.ts";
import type { CameraSnapshot } from "../src/lib/render/cameraPose.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const outDir = path.join(webRoot, ".tmp-stair-visual");
const PROJECT_ID = "13efe9e0-1cea-40c5-bcf9-4c765dbced8b";

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

function cutaway(model: BuildingModelV1): BuildingModelV1 {
  return BuildingModelV1Schema.parse({
    ...model,
    // Full cutaway for inspection — walls/roof hide the stair in exterior shots.
    walls: [],
    roofs: [],
    roofAssemblies: [],
    openings: [],
    shell: model.shell
      ? { ...model.shell, openings: [] }
      : model.shell,
  });
}

async function loadRev(admin: ReturnType<typeof createClient>, rev: number) {
  const { data, error } = await admin
    .from("building_revisions")
    .select("revision,model")
    .eq("project_id", PROJECT_ID)
    .eq("revision", rev)
    .maybeSingle();
  if (error) throw error;
  return {
    revision: data!.revision as number,
    model: BuildingModelV1Schema.parse(data!.model),
  };
}

async function shoot(
  label: string,
  model: BuildingModelV1,
  revision: number,
  shots: Array<{
    name: string;
    view: "perspective" | "top" | "current";
    camera?: CameraSnapshot;
    useCutaway?: boolean;
  }>,
) {
  const out: Array<Record<string, unknown>> = [];
  for (const s of shots) {
    const m = s.useCutaway ? cutaway(model) : model;
    const rendered = await renderBuildingPreview({
      model: m,
      view: s.view,
      width: 1400,
      height: 900,
      currentCamera: s.camera ?? null,
      projectId: PROJECT_ID,
      revision,
      modelSource: "committed",
    });
    if (!rendered.success) {
      out.push({ name: s.name, ok: false, error: rendered.error });
      continue;
    }
    const dest = path.join(outDir, `${label}-${s.name}.jpg`);
    copyFileSync(rendered.assetPath, dest);
    out.push({ name: s.name, ok: true, path: dest, backend: rendered.renderBackend });
  }
  return out;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const env = loadEnv();
  const admin = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const straight = await loadRev(admin, 105);
  const lshape = await loadRev(admin, 106);
  const sg = buildBuildingGeometry(straight.model);
  const lg = buildBuildingGeometry(lshape.model);
  console.log(
    "colors",
    sg.stairs[0]?.color,
    lg.stairs[0]?.color,
    "holes",
    sg.slabs.find((s) => s.levelId === "level-2")?.holes?.length,
    lg.slabs.find((s) => s.levelId === "level-2")?.holes?.length,
  );

  // Straight stair AABB ~ x=-8..-4, z=-18..-6, y=0..9
  const straightViews = await shoot(
    "straight",
    straight.model,
    straight.revision,
    [
      {
        name: "perspective-cutaway",
        view: "current",
        useCutaway: true,
        camera: {
          position: { x: 12, y: 11, z: -28 },
          target: { x: -6, y: 4.5, z: -12 },
          fov: 40,
        },
      },
      {
        name: "side",
        view: "current",
        useCutaway: true,
        camera: {
          position: { x: 16, y: 6, z: -12 },
          target: { x: -6, y: 4.5, z: -12 },
          fov: 38,
        },
      },
      {
        name: "top",
        view: "current",
        useCutaway: true,
        camera: {
          position: { x: -6, y: 42, z: -12 },
          target: { x: -6, y: 0, z: -12 },
          fov: 35,
        },
      },
      {
        name: "interior-along-run",
        view: "current",
        camera: {
          position: { x: -6, y: 2.8, z: -24 },
          target: { x: -6, y: 6.5, z: -8 },
          fov: 48,
        },
      },
    ],
  );

  // L stair around x=-14..-3, z=-14..-6
  const lViews = await shoot("lshape", lshape.model, lshape.revision, [
    {
      name: "perspective-cutaway",
      view: "current",
      useCutaway: true,
      camera: {
        position: { x: 8, y: 14, z: -28 },
        target: { x: -9, y: 4.5, z: -9 },
        fov: 40,
      },
    },
    {
      name: "top",
      view: "current",
      useCutaway: true,
      camera: {
        position: { x: -9, y: 40, z: -9 },
        target: { x: -9, y: 0, z: -9 },
        fov: 35,
      },
    },
    {
      name: "interior",
      view: "current",
      camera: {
        position: { x: -2, y: 3.5, z: -2 },
        target: { x: -11, y: 5, z: -10 },
        fov: 48,
      },
    },
  ]);

  const summary = { straightViews, lViews, outDir };
  writeFileSync(path.join(outDir, "summary-v2.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
