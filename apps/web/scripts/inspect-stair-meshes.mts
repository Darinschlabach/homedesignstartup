import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import {
  BuildingModelV1Schema,
  buildBuildingGeometry,
  buildSceneMeshes,
} from "@aihd/domain";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const rev = Number(process.argv[2] || 105);
const { data, error } = await admin
  .from("building_revisions")
  .select("revision,model")
  .eq("project_id", "13efe9e0-1cea-40c5-bcf9-4c765dbced8b")
  .eq("revision", rev)
  .maybeSingle();
if (error) throw error;
const model = BuildingModelV1Schema.parse(data!.model);
const geom = buildBuildingGeometry(model);
const meshes = buildSceneMeshes(model);
const stairs = meshes.filter((m) => m.entityType === "stair");
const ys = stairs.map((m) => m.position.y);
const extruded = meshes.filter((m) => m.kind === "extrudedPolygon");
console.log(
  JSON.stringify(
    {
      rev: data!.revision,
      stairsInModel: model.stairs?.length,
      stairMeshes: stairs.length,
      yMin: Math.min(...ys),
      yMax: Math.max(...ys),
      first: stairs[0],
      last: stairs.at(-1),
      extruded: extruded.map((e) => ({
        id: e.id,
        holes: e.holes?.length,
        height: e.height,
        pos: e.position,
        holeSample: e.holes?.[0]?.slice(0, 2),
        polySample: e.polygon?.slice(0, 2),
      })),
      upper: geom.slabs.find((s) => s.levelId === "level-2"),
    },
    null,
    2,
  ),
);
