/**
 * Footprint agent tests.
 * Usage: node ./scripts/run-footprint-agent-test.mjs <wider|reduce>
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const repoApps = path.resolve(webRoot, "..");
const envPath = path.join(webRoot, ".env.local");

const mode = process.argv[2] || "wider";
const PROJECT_ID = "13efe9e0-1cea-40c5-bcf9-4c765dbced8b";
const EMAIL = "darinschlabach07@gmail.com";

const MESSAGES = {
  wider:
    "Make the house about 4 feet wider in the direction that gives the main living area the most benefit. Keep the front entry and garage relationship as intact as possible.",
  reduce:
    "Reduce the overall footprint slightly without making the main living spaces feel cramped.",
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
  const shell = model.shell;
  return {
    shell: shell
      ? {
          width: shell.width,
          depth: shell.depth,
          wallHeight: shell.wallHeight,
          openings: (shell.openings ?? []).map((o) => ({
            id: o.id,
            type: o.type,
            wall: o.wall,
            offset: o.offset,
            width: o.width,
          })),
          roof: shell.roof,
        }
      : null,
    spaces: (model.spaces ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      polygon: s.polygon,
    })),
    walls: (model.walls ?? []).map((w) => ({
      id: w.id,
      start: w.start,
      end: w.end,
    })),
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
        shell: beforeSnap.shell,
        spaces: beforeSnap.spaces.map((s) => ({ id: s.id, name: s.name })),
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
      shellMatchBefore:
        JSON.stringify(undoSnap.shell) === JSON.stringify(beforeSnap.shell),
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
    before: beforeSnap,
    after: afterSnap,
    delta: {
      width:
        (afterSnap.shell?.width ?? 0) - (beforeSnap.shell?.width ?? 0),
      depth:
        (afterSnap.shell?.depth ?? 0) - (beforeSnap.shell?.depth ?? 0),
      wallHeight:
        (afterSnap.shell?.wallHeight ?? 0) -
        (beforeSnap.shell?.wallHeight ?? 0),
    },
    finalText: sse.finalText.slice(0, 1800),
    undo,
  };
  const outPath = path.join(repoApps, `.tmp-footprint-${mode}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log("wrote", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
