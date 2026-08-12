/**
 * Multi-level agent tests.
 * Usage: node ./scripts/run-level-agent-test.mjs <second-story|proportion|partial>
 *
 * second-story: create L2 (agent chooses height), verify, undo to single-story
 * proportion: requires L2 — seeds one if missing, then agent shortens L2 height
 * partial: legacy unsupported-check — prefer run-level-footprint-agent-test.mjs for
 *          supported partial/setback footprint agent coverage
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const repoApps = path.resolve(webRoot, "..");
const envPath = path.join(webRoot, ".env.local");

const mode = process.argv[2] || "second-story";
const PROJECT_ID = "13efe9e0-1cea-40c5-bcf9-4c765dbced8b";
const EMAIL = "darinschlabach07@gmail.com";

const MESSAGES = {
  "second-story":
    "Add a second story to this house. Keep the same footprint and choose a reasonable story height.",
  proportion:
    "The second floor feels too tall. Make it more proportional to the first floor.",
  partial:
    "Make the second story cover only the back half of the house.",
};

function loadEnv() {
  return Object.fromEntries(
    readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
}

function cookieFromSession(env, session) {
  const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  const payload = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: "bearer",
  };
  const b64 = Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return {
    name: `sb-${ref}-auth-token`,
    value: `base64-${b64}`,
  };
}

function snap(model) {
  const levels = model.levels ?? [];
  const slabs = model.slabs ?? [];
  const walls = model.walls ?? [];
  const roofs = model.roofs ?? [];
  const assemblies = model.roofAssemblies ?? [];
  return {
    footprint: model.shell
      ? {
          width: model.shell.width,
          depth: model.shell.depth,
          wallHeight: model.shell.wallHeight,
        }
      : null,
    metaStories: model.meta?.stories ?? null,
    levels: levels.map((l) => ({
      id: l.id,
      name: l.name,
      elevation: l.elevation,
      height: l.height,
      footprintSource: l.footprintSource ?? "shell",
      top: l.elevation + l.height,
    })),
    slabs: slabs.map((s) => ({
      id: s.id,
      levelId: s.levelId,
      thickness: s.thickness,
    })),
    exteriorWallsByLevel: levels.map((l) => ({
      levelId: l.id,
      wallIds: walls
        .filter(
          (w) =>
            w.levelId === l.id &&
            (w.id.startsWith("wall-front") ||
              w.id.startsWith("wall-rear") ||
              w.id.startsWith("wall-left") ||
              w.id.startsWith("wall-right")),
        )
        .map((w) => w.id),
    })),
    roof: {
      roofLevelIds: roofs.map((r) => r.levelId),
      assemblyLevelIds: assemblies.map((a) => a.levelId),
      eaveHeights: assemblies.flatMap((a) =>
        (a.masses ?? [])
          .map((m) => m.generator?.eaveHeight)
          .filter((v) => typeof v === "number"),
      ),
    },
  };
}

function parseSse(text) {
  const eventTypes = [];
  const toolSequence = [];
  let modelEvents = 0;
  let finalText = "";
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    let data = "";
    for (const line of lines) {
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      const t = parsed.type;
      if (t) eventTypes.push(t);
      if (t === "model") modelEvents += 1;
      if (t === "tool" && typeof parsed.name === "string") {
        toolSequence.push({
          name: parsed.name,
          ok: parsed.ok ?? null,
          code: parsed.code ?? null,
        });
      }
      if (t === "text" && typeof parsed.text === "string") finalText += parsed.text;
      if (t === "final" && typeof parsed.response === "string") {
        finalText = parsed.response;
      }
    } catch {
      /* ignore */
    }
  }
  return {
    eventTypes: [...new Set(eventTypes)],
    modelEvents,
    finalText,
    toolSequence,
  };
}

async function auth(env) {
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
  const anon = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data: verified, error: verifyErr } = await anon.auth.verifyOtp({
    type: "email",
    token_hash: linkData.properties.hashed_token,
  });
  if (verifyErr) throw verifyErr;
  return { admin, session: verified.session };
}

async function latestRevision(admin) {
  const { data, error } = await admin
    .from("building_revisions")
    .select("revision,id,reason,model")
    .eq("project_id", PROJECT_ID)
    .order("revision", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function seedSecondStoryIfNeeded(admin, cookie, before) {
  if ((before.model.levels ?? []).length >= 2) {
    return { seeded: false, revision: before };
  }
  const res = await fetch("http://localhost:3000/api/design-agent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${cookie.name}=${cookie.value}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      message:
        "Add a second story with the same footprint. Use a story height equal to the first floor. Do not change the floor plan.",
      projectId: PROJECT_ID,
    }),
  });
  await res.text();
  const after = await latestRevision(admin);
  return { seeded: true, revision: after };
}

async function main() {
  const message = MESSAGES[mode];
  if (!message) {
    console.error("Unknown mode", mode);
    process.exit(1);
  }
  const env = loadEnv();
  const { admin, session } = await auth(env);
  const cookie = cookieFromSession(env, session);
  let before = await latestRevision(admin);
  let seedInfo = { seeded: false };

  if (mode === "proportion") {
    seedInfo = await seedSecondStoryIfNeeded(admin, cookie, before);
    before = seedInfo.revision;
  }

  const beforeSnap = snap(before.model);
  console.log(
    JSON.stringify(
      {
        mode,
        beforeRevision: before.revision,
        seeded: seedInfo.seeded,
        before: beforeSnap,
      },
      null,
      2,
    ),
  );

  const res = await fetch("http://localhost:3000/api/design-agent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${cookie.name}=${cookie.value}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ message, projectId: PROJECT_ID }),
  });
  const bodyText = await res.text();
  const sse = parseSse(bodyText);
  const after = await latestRevision(admin);
  const afterSnap = snap(after.model);

  let undo = null;
  const shouldUndo = mode !== "partial" || after.revision !== before.revision;
  if (shouldUndo && after.revision !== before.revision) {
    const undoRes = await fetch(
      `http://localhost:3000/api/projects/${PROJECT_ID}/revisions/restore`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${cookie.name}=${cookie.value}`,
        },
        body: JSON.stringify({ fromRevision: before.revision }),
      },
    );
    const undoBody = await undoRes.text();
    const afterUndo = await latestRevision(admin);
    const undoSnap = snap(afterUndo.model);
    undo = {
      status: undoRes.status,
      bodyPreview: undoBody.slice(0, 160),
      revisionAfterUndo: afterUndo.revision,
      restoredFrom: before.revision,
      levelsMatchBefore:
        JSON.stringify(undoSnap.levels) === JSON.stringify(beforeSnap.levels),
      footprintMatchBefore:
        JSON.stringify(undoSnap.footprint) ===
        JSON.stringify(beforeSnap.footprint),
    };
  }

  const unsupportedMentioned =
    /not (yet )?supported|unsupported|partial|setback|back half|cannot|can't/i.test(
      sse.finalText,
    );
  const fakedFullSecondStory =
    mode === "partial" &&
    afterSnap.levels.length > beforeSnap.levels.length &&
    afterSnap.levels.every((l) => l.footprintSource === "shell");

  const out = {
    mode,
    status: res.status,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    revisionDelta: after.revision - before.revision,
    modelEvents: sse.modelEvents,
    eventTypes: sse.eventTypes,
    toolSequence: sse.toolSequence,
    seeded: seedInfo.seeded,
    before: beforeSnap,
    after: afterSnap,
    footprintUnchanged:
      JSON.stringify(beforeSnap.footprint) ===
      JSON.stringify(afterSnap.footprint),
    checks: {
      levelCountDelta: afterSnap.levels.length - beforeSnap.levels.length,
      roofOnTopLevel:
        afterSnap.levels.length > 0 &&
        afterSnap.roof.assemblyLevelIds.every(
          (id) => id === afterSnap.levels[afterSnap.levels.length - 1]?.id,
        ),
      unsupportedMentioned,
      fakedFullSecondStory,
    },
    finalText: sse.finalText.slice(0, 2500),
    undo,
  };
  const outPath = path.join(repoApps, `.tmp-level-${mode}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log("wrote", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
