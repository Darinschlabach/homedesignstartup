/**
 * Roof-mass agent tests.
 * Usage: node ./scripts/run-roof-mass-agent-test.mjs <secondary|improve>
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const repoApps = path.resolve(webRoot, "..");
const envPath = path.join(webRoot, ".env.local");

const mode = process.argv[2] || "secondary";
const PROJECT_ID = "13efe9e0-1cea-40c5-bcf9-4c765dbced8b";
const EMAIL = "darinschlabach07@gmail.com";

const MESSAGES = {
  secondary:
    "Add a secondary gable over the front portion of the house wherever you think it improves the architecture. Keep the current footprint.",
  improve:
    "The roof composition still feels too simple. Improve it however you think looks best without changing the floor plan or footprint.",
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
  const assemblies = model.roofAssemblies ?? [];
  return {
    footprint: shell
      ? { width: shell.width, depth: shell.depth, wallHeight: shell.wallHeight }
      : null,
    shellRoof: shell?.roof ?? null,
    assemblies: assemblies.map((a) => ({
      id: a.id,
      source: a.source,
      materialId: a.materialId ?? null,
      massCount: (a.masses ?? []).length,
      planeCount: (a.planes ?? []).length,
      valleyCount: (a.edges ?? []).filter((e) => e.kind === "valley").length,
      sharedCount: (a.edges ?? []).filter((e) => e.kind === "shared").length,
      masses: (a.masses ?? []).map((m) => ({
        id: m.id,
        label: m.label ?? null,
        generator: m.generator
          ? {
              type: m.generator.type,
              origin: m.generator.origin,
              width: m.generator.width,
              depth: m.generator.depth,
              pitch: m.generator.pitch,
              ridgeDirection: m.generator.ridgeDirection,
              eaveHeight: m.generator.eaveHeight,
              overhang: m.generator.overhang,
              highSide: m.generator.highSide ?? null,
            }
          : null,
        planeIds: m.planeIds ?? [],
      })),
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
      { mode, beforeRevision: before.revision, before: beforeSnap },
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
      roofMatchBefore:
        JSON.stringify(undoSnap.assemblies) ===
        JSON.stringify(beforeSnap.assemblies),
      footprintMatchBefore:
        JSON.stringify(undoSnap.footprint) ===
        JSON.stringify(beforeSnap.footprint),
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
    toolSequence: sse.toolSequence,
    before: beforeSnap,
    after: afterSnap,
    footprintUnchanged:
      JSON.stringify(beforeSnap.footprint) ===
      JSON.stringify(afterSnap.footprint),
    finalText: sse.finalText.slice(0, 2500),
    undo,
  };
  const outPath = path.join(repoApps, `.tmp-roof-mass-${mode}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log("wrote", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
