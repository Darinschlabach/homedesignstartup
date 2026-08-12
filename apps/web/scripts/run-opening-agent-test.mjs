/**
 * One-shot design-agent opening test helper (auth + SSE + optional undo).
 * Usage: node ./scripts/run-opening-agent-test.mjs <create|modify|delete>
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const repoApps = path.resolve(webRoot, "..");
const envPath = path.join(webRoot, ".env.local");

const mode = process.argv[2] || "create";
const PROJECT_ID = "13efe9e0-1cea-40c5-bcf9-4c765dbced8b";
const EMAIL = "darinschlabach07@gmail.com";

const MESSAGES = {
  create:
    "Add another front window wherever you think it would improve the elevation, but do not change the wall or roof.",
  modify:
    "The front windows feel inconsistent. Improve their spacing and proportions without changing the wall or roof.",
  delete:
    "Remove the front opening that contributes least to the composition, but do not remove the main entry door.",
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

function openingSnapshot(model) {
  const shell = model.shell ?? {};
  const openings = (shell.openings ?? []).map((o) => ({
    id: o.id,
    type: o.type,
    wall: o.wall,
    offset: o.offset,
    width: o.width,
    height: o.height,
    sillHeight: o.sillHeight,
  }));
  const entities = (model.entities ?? [])
    .filter((e) =>
      ["window", "exteriorDoor", "garageDoor", "opening"].includes(e.type),
    )
    .map((e) => ({
      id: e.id,
      type: e.type,
      parentId: e.parentId ?? null,
      geometry: e.geometry ?? null,
    }));
  return { openings, entities, openingIds: openings.map((o) => o.id).sort() };
}

function diffOpenings(before, after) {
  const b = new Set(before.openingIds);
  const a = new Set(after.openingIds);
  const added = [...a].filter((id) => !b.has(id));
  const removed = [...b].filter((id) => !a.has(id));
  const modified = after.openings
    .filter((o) => b.has(o.id))
    .filter((o) => {
      const prev = before.openings.find((x) => x.id === o.id);
      if (!prev) return false;
      return JSON.stringify(prev) !== JSON.stringify(o);
    });
  return { added, removed, modified };
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
  const tokenHash = linkData.properties.hashed_token;
  const anon = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data: verified, error: verifyErr } = await anon.auth.verifyOtp({
    type: "email",
    token_hash: tokenHash,
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
  const events = [];
  let eventTypes = [];
  let modelEvents = 0;
  let finalText = "";
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    let event = "message";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) continue;
    try {
      const parsed = JSON.parse(data);
      events.push({ event, data: parsed });
      const t = parsed.type || event;
      eventTypes.push(t);
      if (t === "model") modelEvents += 1;
      if (t === "text" && typeof parsed.text === "string") finalText += parsed.text;
      if (t === "final" && typeof parsed.response === "string") finalText = parsed.response;
    } catch {
      events.push({ event, data });
    }
  }
  return { events, eventTypes: [...new Set(eventTypes)], modelEvents, finalText };
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
  const beforeSnap = openingSnapshot(before.model);

  console.log(
    JSON.stringify(
      {
        mode,
        beforeRevision: before.revision,
        openingCount: beforeSnap.openings.length,
        openings: beforeSnap.openings,
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
    body: JSON.stringify({
      message,
      projectId: PROJECT_ID,
    }),
  });

  const bodyText = await res.text();
  const sse = parseSse(bodyText);
  const after = await latestRevision(admin);
  const afterSnap = openingSnapshot(after.model);
  const diff = diffOpenings(beforeSnap, afterSnap);

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
    const undoSnap = openingSnapshot(afterUndo.model);
    undo = {
      status: undoRes.status,
      bodyPreview: undoBody.slice(0, 180),
      revisionAfterUndo: afterUndo.revision,
      restoredFrom: before.revision,
      openingIdsMatchBefore:
        JSON.stringify(undoSnap.openingIds) === JSON.stringify(beforeSnap.openingIds),
      openingsMatchBefore:
        JSON.stringify(undoSnap.openings) === JSON.stringify(beforeSnap.openings),
      addedGone: diff.added.every((id) => !undoSnap.openingIds.includes(id)),
      removedRestored: diff.removed.every((id) => undoSnap.openingIds.includes(id)),
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
    diff,
    beforeOpenings: beforeSnap.openings,
    afterOpenings: afterSnap.openings,
    finalText: sse.finalText.slice(0, 1200),
    undo,
    bodyPreview: bodyText.slice(0, 400),
  };

  const outPath = path.join(repoApps, `.tmp-opening-${mode}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log("wrote", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
