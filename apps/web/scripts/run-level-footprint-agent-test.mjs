/**
 * Level-footprint agent tests.
 * Usage: node ./scripts/run-level-footprint-agent-test.mjs <back-half|setback|garage|all>
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const envPath = path.join(webRoot, ".env.local");
const outDir = path.join(webRoot, ".tmp-level-footprint-agent");

const mode = process.argv[2] || "all";
const PROJECT_ID = "13efe9e0-1cea-40c5-bcf9-4c765dbced8b";
const EMAIL = "darinschlabach07@gmail.com";

const MESSAGES = {
  "back-half":
    "Make the second floor cover only the back half of the house and keep the staircase working.",
  setback:
    "Set the second floor back from both sides so the house feels less top-heavy.",
  garage: "Put the second floor only over the garage area.",
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

function polygonBounds(poly) {
  if (!poly?.length) return null;
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...ys),
    maxZ: Math.max(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    depth: Math.max(...ys) - Math.min(...ys),
  };
}

function snap(model) {
  const levels = model.levels ?? [];
  const walls = model.walls ?? [];
  const slabs = model.slabs ?? [];
  const stairs = model.stairs ?? [];
  const assemblies = model.roofAssemblies ?? [];
  const garageOpenings = (model.shell?.openings ?? []).filter(
    (o) => o.type === "garageDoor",
  );
  return {
    footprint: model.shell
      ? {
          width: model.shell.width,
          depth: model.shell.depth,
          wallHeight: model.shell.wallHeight,
        }
      : null,
    levels: levels.map((l) => ({
      id: l.id,
      name: l.name,
      elevation: l.elevation,
      height: l.height,
      footprintSource: l.footprintSource ?? "shell",
      footprint: l.footprint
        ? {
            centerX: l.footprint.center?.x,
            centerZ: l.footprint.center?.y,
            width: l.footprint.width,
            depth: l.footprint.depth,
          }
        : null,
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
    slabs: slabs.map((s) => ({
      id: s.id,
      levelId: s.levelId,
      bounds: polygonBounds(s.polygon),
    })),
    stairs: stairs.map((s) => ({
      id: s.id,
      type: s.type,
      fromLevelId: s.fromLevelId,
      toLevelId: s.toLevelId,
      origin: s.origin,
      directionDeg: s.directionDeg,
      width: s.width,
      floorOpeningId: s.floorOpeningId ?? null,
    })),
    garageOpenings: garageOpenings.map((o) => ({
      id: o.id,
      wall: o.wall,
      offset: o.offset,
      width: o.width,
      levelId: o.levelId ?? null,
    })),
    roof: {
      assemblyLevelIds: assemblies.map((a) => a.levelId),
      masses: assemblies.flatMap((a) =>
        (a.masses ?? [])
          .map((m) => m.generator)
          .filter(Boolean)
          .map((g) => ({
            originX: g.origin.x,
            originZ: g.origin.y,
            width: g.width,
            depth: g.depth,
            eaveHeight: g.eaveHeight,
          })),
      ),
    },
  };
}

function parseSse(text) {
  const toolSequence = [];
  let modelEvents = 0;
  let finalText = "";
  const exposedMentions = [];
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
        const blob = JSON.stringify(parsed).toLowerCase();
        if (blob.includes("exposed_lower_roof") || blob.includes("exposed lower")) {
          exposedMentions.push(parsed.name);
        }
      }
      if (t === "text" && typeof parsed.text === "string") finalText += parsed.text;
      if (t === "final" && typeof parsed.response === "string") {
        finalText = parsed.response;
      }
    } catch {
      /* ignore */
    }
  }
  return { modelEvents, finalText, toolSequence, exposedMentions };
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

async function callAgent(cookie, message) {
  const res = await fetch("http://localhost:3000/api/design-agent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${cookie.name}=${cookie.value}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ projectId: PROJECT_ID, message }),
  });
  const text = await res.text();
  return { status: res.status, text, sse: parseSse(text) };
}

async function restoreViaApi(cookie, fromRevision) {
  const undoRes = await fetch(
    `http://localhost:3000/api/projects/${PROJECT_ID}/revisions/restore`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${cookie.name}=${cookie.value}`,
      },
      body: JSON.stringify({ fromRevision }),
    },
  );
  const body = await undoRes.text();
  return { status: undoRes.status, body };
}

async function ensureTwoStoryWithStair(admin, cookie) {
  let before = await latestRevision(admin);
  let model = before.model;

  if ((model.levels ?? []).length < 2) {
    console.log("Seeding second story…");
    await callAgent(
      cookie,
      "Add a second story with the same footprint. Choose a reasonable story height.",
    );
    before = await latestRevision(admin);
    model = before.model;
  }

  // Reset L2 to full shell footprint if previously custom
  const l2 = (model.levels ?? []).find((l) => l.id !== model.levels?.[0]?.id);
  if (l2?.footprintSource === "custom") {
    console.log("Clearing custom L2 footprint before seed…");
    await callAgent(
      cookie,
      "Clear the second floor custom footprint and restore it to the full shell footprint.",
    );
    before = await latestRevision(admin);
    model = before.model;
  }

  if ((model.stairs ?? []).length < 1) {
    console.log("Seeding staircase…");
    await callAgent(
      cookie,
      "Add a staircase between the first and second floors wherever you think it fits best.",
    );
    before = await latestRevision(admin);
  }

  return latestRevision(admin);
}

function l2Of(snapModel) {
  return snapModel.levels.find((l) => l.id !== snapModel.levels[0]?.id) ??
    snapModel.levels[1] ??
    null;
}

async function runMode(admin, cookie, name) {
  const seeded = await ensureTwoStoryWithStair(admin, cookie);
  const before = seeded;
  const beforeSnap = snap(before.model);
  const message = MESSAGES[name];
  console.log(`\n=== ${name.toUpperCase()} ===`);
  console.log(
    "beforeRev",
    before.revision,
    "L2",
    l2Of(beforeSnap)?.footprintSource,
    "stairs",
    beforeSnap.stairs.length,
  );

  const { status, sse } = await callAgent(cookie, message);
  const after = await latestRevision(admin);
  const afterSnap = snap(after.model);
  const revisionDelta = after.revision - before.revision;
  const beforeL2 = l2Of(beforeSnap);
  const afterL2 = l2Of(afterSnap);
  const afterSlab2 = afterSnap.slabs.find((s) => s.levelId === afterL2?.id);
  const beforeSlab2 = beforeSnap.slabs.find((s) => s.levelId === beforeL2?.id);

  const exposedInText =
    /exposed.?lower.?roof|still needs lower.?roof|not (yet )?fully roofed|exposed (area|region)/i.test(
      sse.finalText,
    );

  const report = {
    mode: name,
    httpStatus: status,
    message,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    revisionDelta,
    modelEvents: sse.modelEvents,
    toolSequence: sse.toolSequence,
    exposedToolMentions: sse.exposedMentions,
    finalText: sse.finalText.slice(0, 2000),
    before: beforeSnap,
    after: afterSnap,
  };

  if (name === "back-half") {
    const fp = afterL2?.footprint;
    const shellDepth = afterSnap.footprint?.depth ?? 0;
    report.checks = {
      usedSetOrModifyFootprint: sse.toolSequence.some(
        (t) =>
          (t.name === "set_level_footprint" ||
            t.name === "modify_level_footprint") &&
          t.ok !== false,
      ),
      inspectedFootprint: sse.toolSequence.some(
        (t) => t.name === "inspect_level_footprint" || t.name === "inspect_level",
      ),
      customFootprint: afterL2?.footprintSource === "custom",
      depthAboutHalf:
        fp != null &&
        shellDepth > 0 &&
        fp.depth <= shellDepth * 0.6 + 1 &&
        fp.depth >= shellDepth * 0.35 - 1,
      rearBias: fp != null && fp.centerZ > 0,
      stairStillPresent: afterSnap.stairs.length >= 1,
      wallsRegenerated: (afterSnap.exteriorWallsByLevel.find(
        (w) => w.levelId === afterL2?.id,
      )?.wallIds.length ?? 0) >= 4,
      slabSmallerThanShell:
        afterSlab2?.bounds != null &&
        afterSnap.footprint != null &&
        afterSlab2.bounds.depth < afterSnap.footprint.depth - 1,
      exposedSurfaced: exposedInText || sse.exposedMentions.length > 0,
      oneRevision: revisionDelta === 1,
      oneSseModel: sse.modelEvents === 1,
      rendered: sse.toolSequence.some(
        (t) => t.name === "render_preview" && t.ok !== false,
      ),
    };

    if (revisionDelta > 0) {
      const undo = await restoreViaApi(cookie, before.revision);
      const afterUndo = await latestRevision(admin);
      const undoSnap = snap(afterUndo.model);
      report.undo = {
        status: undo.status,
        restoredFrom: before.revision,
        revisionAfterUndo: afterUndo.revision,
        levelsMatchBefore:
          JSON.stringify(undoSnap.levels) === JSON.stringify(beforeSnap.levels),
        stairsMatchBefore:
          JSON.stringify(undoSnap.stairs) === JSON.stringify(beforeSnap.stairs),
      };
      report.checks.undoRestored =
        report.undo.levelsMatchBefore && report.undo.stairsMatchBefore;
    }
  } else if (name === "setback") {
    const fp = afterL2?.footprint;
    const shellW = afterSnap.footprint?.width ?? 0;
    report.checks = {
      usedSetOrModifyFootprint: sse.toolSequence.some(
        (t) =>
          (t.name === "set_level_footprint" ||
            t.name === "modify_level_footprint") &&
          t.ok !== false,
      ),
      customFootprint: afterL2?.footprintSource === "custom",
      narrowerThanShell:
        fp != null && shellW > 0 && fp.width < shellW - 0.5,
      bothSideSetbacks:
        fp != null &&
        shellW > 0 &&
        Math.abs(fp.centerX) < (shellW - fp.width) / 2 + 2,
      oneRevision: revisionDelta === 1,
      oneSseModel: sse.modelEvents === 1,
      rendered: sse.toolSequence.some(
        (t) => t.name === "render_preview" && t.ok !== false,
      ),
      slabNarrower:
        afterSlab2?.bounds != null &&
        beforeSlab2?.bounds != null &&
        afterSlab2.bounds.width < beforeSlab2.bounds.width - 0.5,
    };
  } else if (name === "garage") {
    const hasGarage = beforeSnap.garageOpenings.length > 0;
    const usedFootprint = sse.toolSequence.some(
      (t) =>
        (t.name === "set_level_footprint" ||
          t.name === "modify_level_footprint") &&
        t.ok !== false,
    );
    const footprintBlockedByStair = sse.toolSequence.some(
      (t) =>
        (t.name === "set_level_footprint" ||
          t.name === "modify_level_footprint" ||
          t.name === "modify_stair") &&
        (t.code === "STAIR_OUTSIDE_UPPER_FOOTPRINT" ||
          t.code === "STAIR_OUTSIDE_FOOTPRINT" ||
          t.code === "STAIR_WALL_COLLISION" ||
          t.code === "STAIR_RUN_OVERFLOW" ||
          t.code === "IDENTICAL_FAILURE_REPEAT"),
    );
    const limitation =
      (!usedFootprint &&
        (/cannot|can't|unable|not (safely )?support|limitation|blocked|would end up outside|stair/i.test(
          sse.finalText,
        ) ||
          footprintBlockedByStair)) ||
      false;
    const faked =
      afterL2?.footprintSource === "custom" &&
      usedFootprint &&
      afterL2.footprint != null &&
      afterSnap.footprint != null &&
      Math.abs(afterL2.footprint.width - afterSnap.footprint.width) < 1 &&
      Math.abs(afterL2.footprint.depth - afterSnap.footprint.depth) < 1;
    report.checks = {
      hasGarageOpening: hasGarage,
      structuredOutcome: usedFootprint || limitation,
      didNotFakeFullShellAsGarage: !faked,
      oneRevisionIfChanged: revisionDelta === 0 || revisionDelta === 1,
      oneSseIfChanged: revisionDelta === 0 || sse.modelEvents === 1,
      limitationOrCustom: limitation || afterL2?.footprintSource === "custom",
      noSilentFake: revisionDelta === 0 || usedFootprint,
    };
    report.garageAttempt = {
      hasGarage,
      usedFootprint,
      limitation,
      footprintBlockedByStair,
      afterFootprint: afterL2?.footprint ?? null,
    };
  }

  writeFileSync(
    path.join(outDir, `${name}-report.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report.checks ?? {}, null, 2));
  console.log("tools:", sse.toolSequence.map((t) => t.name).join(" → "));
  console.log("final:", report.finalText.slice(0, 600));
  return report;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const env = loadEnv();
  const { admin, session } = await auth(env);
  const cookie = cookieFromSession(env, session);

  const modes =
    mode === "all" ? ["back-half", "setback", "garage"] : [mode];

  const reports = {};
  for (const m of modes) {
    if (!MESSAGES[m]) {
      console.error("Unknown mode", m);
      process.exit(1);
    }
    reports[m] = await runMode(admin, cookie, m);
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
