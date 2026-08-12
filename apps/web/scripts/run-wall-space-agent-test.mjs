/**
 * Wall/space agent tests.
 * Usage: node ./scripts/run-wall-space-agent-test.mjs <modify|create|delete>
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const repoApps = path.resolve(webRoot, "..");
const envPath = path.join(webRoot, ".env.local");

const mode = process.argv[2] || "modify";
const PROJECT_ID = "13efe9e0-1cea-40c5-bcf9-4c765dbced8b";
const EMAIL = "darinschlabach07@gmail.com";

const MESSAGES = {
  modify:
    "Make the main living area about 2 feet wider without changing the overall building footprint. Adjust the adjacent interior wall however you think makes the most sense.",
  create:
    "Create a small office off the main living area wherever it fits best without changing the exterior footprint.",
  delete:
    "Open up the connection between the living and dining areas if it improves the plan, but keep the exterior walls untouched.",
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
  const walls = (model.walls ?? []).map((w) => ({
    id: w.id,
    start: w.start,
    end: w.end,
    thickness: w.thickness,
    height: w.height ?? null,
  }));
  const spaces = (model.spaces ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    tags: s.tags ?? [],
    polygon: s.polygon,
  }));
  return {
    walls,
    spaces,
    wallIds: walls.map((w) => w.id).sort(),
    spaceIds: spaces.map((s) => s.id).sort(),
    shell: model.shell
      ? {
          width: model.shell.width,
          depth: model.shell.depth,
          wallHeight: model.shell.wallHeight,
        }
      : null,
  };
}

function diff(before, after) {
  const bw = new Set(before.wallIds);
  const aw = new Set(after.wallIds);
  const bs = new Set(before.spaceIds);
  const as = new Set(after.spaceIds);
  return {
    wallsAdded: [...aw].filter((id) => !bw.has(id)),
    wallsRemoved: [...bw].filter((id) => !aw.has(id)),
    wallsModified: after.walls
      .filter((w) => bw.has(w.id))
      .filter((w) => {
        const prev = before.walls.find((x) => x.id === w.id);
        return JSON.stringify(prev) !== JSON.stringify(w);
      })
      .map((w) => w.id),
    spacesAdded: [...as].filter((id) => !bs.has(id)),
    spacesRemoved: [...bs].filter((id) => !as.has(id)),
    spacesModified: after.spaces
      .filter((s) => bs.has(s.id))
      .filter((s) => {
        const prev = before.spaces.find((x) => x.id === s.id);
        return JSON.stringify(prev) !== JSON.stringify(s);
      })
      .map((s) => s.id),
    footprintUnchanged:
      JSON.stringify(before.shell) === JSON.stringify(after.shell),
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

function parseSse(text) {
  const eventTypes = [];
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
      if (t === "text" && typeof parsed.text === "string") finalText += parsed.text;
      if (t === "final" && typeof parsed.response === "string") {
        finalText = parsed.response;
      }
    } catch {
      /* ignore */
    }
  }
  return { eventTypes: [...new Set(eventTypes)], modelEvents, finalText };
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
  const before = await latestRevision(admin);
  const beforeSnap = snap(before.model);
  console.log(
    JSON.stringify(
      {
        mode,
        beforeRevision: before.revision,
        walls: beforeSnap.wallIds,
        spaces: beforeSnap.spaces.map((s) => ({ id: s.id, name: s.name })),
        shell: beforeSnap.shell,
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
  const d = diff(beforeSnap, afterSnap);

  let undo = null;
  if (after.revision !== before.revision) {
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
      wallIdsMatchBefore:
        JSON.stringify(undoSnap.wallIds) === JSON.stringify(beforeSnap.wallIds),
      spaceIdsMatchBefore:
        JSON.stringify(undoSnap.spaceIds) ===
        JSON.stringify(beforeSnap.spaceIds),
      wallsMatchBefore:
        JSON.stringify(undoSnap.walls) === JSON.stringify(beforeSnap.walls),
      spacesMatchBefore:
        JSON.stringify(undoSnap.spaces) === JSON.stringify(beforeSnap.spaces),
    };
  }

  const out = {
    mode,
    status: res.status,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    revisionDelta: after.revision - before.revision,
    modelEvents: sse.modelEvents,
    eventTypes: sse.eventTypes,
    diff: d,
    before: {
      walls: beforeSnap.walls,
      spaces: beforeSnap.spaces,
      shell: beforeSnap.shell,
    },
    after: {
      walls: afterSnap.walls,
      spaces: afterSnap.spaces,
      shell: afterSnap.shell,
    },
    finalText: sse.finalText.slice(0, 1500),
    undo,
  };
  const outPath = path.join(repoApps, `.tmp-wall-space-${mode}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log("wrote", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
