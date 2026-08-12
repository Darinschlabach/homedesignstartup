import { createClient } from "@supabase/supabase-js";
import { readFileSync, copyFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { BuildingModelV1Schema, type BuildingModelV1 } from "@aihd/domain";
import { renderBuildingPreview } from "../src/lib/render/renderBuildingPreview.ts";

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
    walls: [],
    roofs: [],
    roofAssemblies: [],
    openings: [],
    shell: model.shell ? { ...model.shell, openings: [] } : model.shell,
  });
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const env = loadEnv();
  const admin = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  async function load(rev: number) {
    const { data } = await admin
      .from("building_revisions")
      .select("revision,model")
      .eq("project_id", PROJECT_ID)
      .eq("revision", rev)
      .maybeSingle();
    return BuildingModelV1Schema.parse(data!.model);
  }

  const shots = [
    {
      label: "straight",
      rev: 105,
      name: "top-plan",
      model: cutaway(await load(105)),
      camera: {
        position: { x: -6, y: 55, z: -12.01 },
        target: { x: -6, y: 0, z: -12 },
        fov: 28,
      },
    },
    {
      label: "straight",
      rev: 105,
      name: "perspective-high",
      model: cutaway(await load(105)),
      camera: {
        position: { x: 8, y: 22, z: -32 },
        target: { x: -6, y: 3, z: -10 },
        fov: 36,
      },
    },
    {
      label: "lshape",
      rev: 106,
      name: "top-plan",
      model: cutaway(await load(106)),
      camera: {
        position: { x: -9, y: 55, z: -9.01 },
        target: { x: -9, y: 0, z: -9 },
        fov: 28,
      },
    },
    {
      label: "lshape",
      rev: 106,
      name: "side-profile",
      model: cutaway(await load(106)),
      camera: {
        position: { x: 18, y: 8, z: -9 },
        target: { x: -9, y: 4.5, z: -9 },
        fov: 36,
      },
    },
  ] as const;

  for (const s of shots) {
    const rendered = await renderBuildingPreview({
      model: s.model,
      view: "current",
      width: 1400,
      height: 900,
      currentCamera: s.camera,
      projectId: PROJECT_ID,
      revision: s.rev,
      modelSource: "committed",
    });
    if (!rendered.success) {
      console.log(s.label, s.name, "FAIL", rendered.error);
      continue;
    }
    const dest = path.join(outDir, `${s.label}-${s.name}.jpg`);
    copyFileSync(rendered.assetPath, dest);
    console.log(s.label, s.name, "OK", dest);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
