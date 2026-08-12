/**
 * Stair agent tests.
 * Usage: node ./scripts/run-stair-agent-test.mjs <create|modify|delete|spiral|all>
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const envPath = path.join(webRoot, ".env.local");
const outDir = path.join(webRoot, ".tmp-stair-agent");

const mode = process.argv[2] || "all";
const PROJECT_ID = "13efe9e0-1cea-40c5-bcf9-4c765dbced8b";
const EMAIL = "darinschlabach07@gmail.com";

const MESSAGES = {
  create:
    "Add a staircase between the first and second floors wherever you think it fits best. Choose the stair configuration and dimensions yourself.",
  modify:
    "This staircase takes up too much room. Improve it while keeping the same floor-to-floor connection.",
  delete: "Remove this staircase and close up its stair opening.",
  spiral: "Replace this stair with a spiral staircase.",
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

function snapStairs(model) {
  const stairs = model.stairs ?? [];
  const openings = model.floorOpenings ?? [];
  const levels = model.levels ?? [];
  const riseBetween = (fromId, toId) => {
    const from = levels.find((l) => l.id === fromId);
    const to = levels.find((l) => l.id === toId);
    if (!from || !to) return null;
    return to.elevation - from.elevation;
  };
  return {
    levels: levels.map((l) => ({
      id: l.id,
      elevation: l.elevation,
      height: l.height,
    })),
    stairs: stairs.map((s) => ({
      id: s.id,
      type: s.type,
      fromLevelId: s.fromLevelId,
      toLevelId: s.toLevelId,
      origin: s.origin,
      directionDeg: s.directionDeg,
      width: s.width,
      availableRun: s.availableRun ?? null,
      targetTreadDepth: s.targetTreadDepth ?? null,
      maxRiserHeight: s.maxRiserHeight ?? null,
      turn: s.turn ?? null,
      firstFlightRisers: s.firstFlightRisers ?? null,
      landingSize: s.landingSize ?? null,
      floorOpeningId: s.floorOpeningId ?? null,
      totalRise: riseBetween(s.fromLevelId, s.toLevelId),
    })),
    floorOpenings: openings.map((o) => ({
      id: o.id,
      levelId: o.levelId,
      stairId: o.stairId ?? null,
      vertexCount: o.polygon?.length ?? 0,
    })),
  };
}

function parseSse(text) {
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
  return { modelEvents, finalText, toolSequence };
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

async function commitModel(admin, userId, model, reason) {
  const latest = await latestRevision(admin);
  const nextRevision = (latest?.revision ?? 0) + 1;
  const { data, error } = await admin
    .from("building_revisions")
    .insert({
      project_id: PROJECT_ID,
      revision: nextRevision,
      model,
      checksum: `stair-agent-${nextRevision}`,
      created_by: userId,
      reason,
    })
    .select("revision,id,reason,model")
    .single();
  if (error) throw error;
  return data;
}

async function ensureTwoStoryNoStairs(admin, cookie, userId, before) {
  let model = structuredClone(before.model);

  if ((model.levels ?? []).length < 2) {
    const res = await fetch("http://localhost:3000/api/design-agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${cookie.name}=${cookie.value}`,
      },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        message:
          "Add a second story with the same footprint. Choose a reasonable story height.",
      }),
    });
    await res.text();
    before = await latestRevision(admin);
    model = structuredClone(before.model);
  }

  const stairs = model.stairs ?? [];
  if (stairs.length > 0 || (model.floorOpenings ?? []).some((o) => o.stairId)) {
    const openingIds = new Set(
      stairs.map((s) => s.floorOpeningId).filter(Boolean),
    );
    model.stairs = [];
    model.floorOpenings = (model.floorOpenings ?? []).filter(
      (o) => !o.stairId && !openingIds.has(o.id),
    );
    const committed = await commitModel(
      admin,
      userId,
      model,
      "stair-agent-test: clear stairs before create",
    );
    return { seeded: true, revision: committed };
  }

  return { seeded: false, revision: before };
}

async function callAgent(cookie, message) {
  const res = await fetch("http://localhost:3000/api/design-agent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${cookie.name}=${cookie.value}`,
    },
    body: JSON.stringify({ projectId: PROJECT_ID, message }),
  });
  const text = await res.text();
  return { status: res.status, text, sse: parseSse(text) };
}

async function restoreRevision(admin, userId, fromRev) {
  const { data, error } = await admin
    .from("building_revisions")
    .select("revision,model")
    .eq("project_id", PROJECT_ID)
    .eq("revision", fromRev)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Revision ${fromRev} not found`);
  return commitModel(
    admin,
    userId,
    data.model,
    `stair-agent-test: restore revision ${fromRev}`,
  );
}

async function runMode(admin, cookie, userId, name) {
  const before = await latestRevision(admin);
  const beforeSnap = snapStairs(before.model);
  const message = MESSAGES[name];
  console.log(`\n=== ${name.toUpperCase()} ===`);
  console.log("beforeRev", before.revision, "stairs", beforeSnap.stairs.length);

  const { status, sse } = await callAgent(cookie, message);
  const after = await latestRevision(admin);
  const afterSnap = snapStairs(after.model);

  const revisionDelta = after.revision - before.revision;
  const report = {
    mode: name,
    httpStatus: status,
    message,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    revisionDelta,
    modelEvents: sse.modelEvents,
    toolSequence: sse.toolSequence,
    finalText: sse.finalText.slice(0, 1500),
    before: beforeSnap,
    after: afterSnap,
  };

  if (name === "create") {
    report.checks = {
      hasStair: afterSnap.stairs.length >= 1,
      hasOpening: afterSnap.floorOpenings.some((o) => o.stairId),
      oneRevision: revisionDelta === 1,
      oneSseModel: sse.modelEvents === 1,
      usedCreateStair: sse.toolSequence.some(
        (t) => t.name === "create_stair" && t.ok !== false,
      ),
      positiveRise: afterSnap.stairs.every(
        (s) => typeof s.totalRise === "number" && s.totalRise > 0,
      ),
    };
  } else if (name === "modify") {
    report.checks = {
      stillConnected:
        Boolean(afterSnap.stairs[0]?.fromLevelId) &&
        Boolean(afterSnap.stairs[0]?.toLevelId) &&
        afterSnap.stairs[0].fromLevelId !== afterSnap.stairs[0].toLevelId,
      oneRevision: revisionDelta === 1,
      oneSseModel: sse.modelEvents === 1,
      usedModifyStair: sse.toolSequence.some(
        (t) => t.name === "modify_stair" && t.ok !== false,
      ),
      openingPresent: afterSnap.floorOpenings.length >= 1,
    };
  } else if (name === "delete") {
    report.checks = {
      stairRemoved: afterSnap.stairs.length === 0,
      openingRemoved: afterSnap.floorOpenings.length === 0,
      oneRevision: revisionDelta === 1,
      oneSseModel: sse.modelEvents === 1,
      usedDeleteStair: sse.toolSequence.some(
        (t) => t.name === "delete_stair" && t.ok !== false,
      ),
    };
    const restored = await restoreRevision(admin, userId, before.revision);
    const undoSnap = snapStairs(restored.model);
    report.undo = {
      restoredFrom: before.revision,
      newRevision: restored.revision,
      stairsRestored: undoSnap.stairs.length,
      openingsRestored: undoSnap.floorOpenings.length,
      snap: undoSnap,
    };
    report.checks.undoRestoredStairAndOpening =
      undoSnap.stairs.length >= 1 && undoSnap.floorOpenings.length >= 1;
  } else if (name === "spiral") {
    const refused =
      /spiral|not supported|unsupported|cannot|can't|unable/i.test(
        sse.finalText,
      );
    const noFake = !sse.toolSequence.some(
      (t) =>
        (t.name === "create_stair" || t.name === "modify_stair") &&
        t.ok !== false,
    );
    report.checks = {
      refused,
      noRevision: revisionDelta === 0,
      noSseModel: sse.modelEvents === 0,
      noSuccessfulStairMutation: noFake,
    };
  }

  writeFileSync(
    path.join(outDir, `${name}-report.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report.checks ?? {}, null, 2));
  console.log("tools:", sse.toolSequence.map((t) => t.name).join(" → "));
  console.log("final:", report.finalText.slice(0, 500));
  return report;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const env = loadEnv();
  const { admin, session } = await auth(env);
  const cookie = cookieFromSession(env, session);
  const userId = session.user.id;

  const modes =
    mode === "all" ? ["create", "modify", "delete", "spiral"] : [mode];

  if (modes.includes("create") || mode === "all") {
    const latest = await latestRevision(admin);
    await ensureTwoStoryNoStairs(admin, cookie, userId, latest);
  }

  const reports = {};
  for (const m of modes) {
    if (!MESSAGES[m]) {
      console.error("Unknown mode", m);
      process.exit(1);
    }
    reports[m] = await runMode(admin, cookie, userId, m);
  }

  writeFileSync(
    path.join(outDir, "summary.json"),
    JSON.stringify(reports, null, 2),
  );
  console.log("\nWrote", path.join(outDir, "summary.json"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
