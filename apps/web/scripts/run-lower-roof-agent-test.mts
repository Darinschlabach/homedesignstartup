/**
 * Lower-roof agent tests.
 * Usage:
 *   pnpm exec tsx --tsconfig tsconfig.json scripts/run-lower-roof-agent-test.mts [rear-half|setback|all]
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  applyDesignOperations,
  computeExposedLowerRegions,
  uncoveredExposedLowerRegions,
  type BuildingModelV1,
} from "@aihd/domain";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const envPath = path.join(webRoot, ".env.local");
const outDir = path.join(webRoot, ".tmp-lower-roof-agent");

const mode = process.argv[2] || "all";
const PROJECT_ID = "13efe9e0-1cea-40c5-bcf9-4c765dbced8b";
const EMAIL = "darinschlabach07@gmail.com";

const MESSAGES = {
  "rear-half":
    "Finish the roof design for the exposed first-floor area and make it work well with the rest of the house.",
  setback:
    "Roof the exposed lower-story areas in a way that makes the overall massing feel balanced.",
} as const;

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

function cookieFromSession(env: Record<string, string>, session: { access_token: string; refresh_token: string }) {
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
  return { name: `sb-${ref}-auth-token`, value: `base64-${b64}` };
}

function snap(model: BuildingModelV1) {
  const assemblies = model.roofAssemblies ?? [];
  return {
    footprint: model.shell
      ? { width: model.shell.width, depth: model.shell.depth, wallHeight: model.shell.wallHeight }
      : null,
    levels: (model.levels ?? []).map((l) => ({
      id: l.id,
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
    stairs: (model.stairs ?? []).map((s) => ({
      id: s.id,
      fromLevelId: s.fromLevelId,
      toLevelId: s.toLevelId,
    })),
    exposed: computeExposedLowerRegions(model).map((r) => ({
      id: r.id,
      side: r.side,
      width: r.footprint.width,
      depth: r.footprint.depth,
      centerX: r.footprint.center.x,
      centerZ: r.footprint.center.y,
    })),
    uncovered: uncoveredExposedLowerRegions(model).map((r) => r.id),
    roofs: assemblies.map((a) => ({
      id: a.id,
      levelId: a.levelId,
      source: a.source,
      role: a.role ?? null,
      coversExposedRegionId: a.coversExposedRegionId ?? null,
      masses: (a.masses ?? []).map((m) => ({
        id: m.id,
        label: m.label ?? null,
        type: m.generator?.type ?? null,
        originX: m.generator?.origin.x ?? null,
        originZ: m.generator?.origin.y ?? null,
        width: m.generator?.width ?? null,
        depth: m.generator?.depth ?? null,
        pitch: m.generator?.pitch ?? null,
        eaveHeight: m.generator?.eaveHeight ?? null,
        highSide: m.generator?.highSide ?? null,
        ridgeDirection: m.generator?.ridgeDirection ?? null,
      })),
    })),
  };
}

function parseSse(text: string) {
  const toolSequence: Array<{ name: string; ok: boolean | null; code: string | null }> = [];
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
      if (t === "final" && typeof parsed.response === "string") finalText = parsed.response;
    } catch {
      /* ignore */
    }
  }
  return { modelEvents, finalText, toolSequence };
}

async function auth(env: Record<string, string>) {
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: EMAIL,
  });
  if (linkErr) throw linkErr;
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: verified, error: verifyErr } = await anon.auth.verifyOtp({
    type: "email",
    token_hash: linkData.properties.hashed_token,
  });
  if (verifyErr) throw verifyErr;
  return { admin, session: verified.session! };
}

async function latestRevision(admin: ReturnType<typeof createClient>) {
  const { data, error } = await admin
    .from("building_revisions")
    .select("revision,id,reason,model")
    .eq("project_id", PROJECT_ID)
    .order("revision", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as { revision: number; id: string; reason: string; model: BuildingModelV1 };
}

async function commitModel(
  admin: ReturnType<typeof createClient>,
  userId: string,
  model: BuildingModelV1,
  reason: string,
) {
  const latest = await latestRevision(admin);
  const nextRevision = (latest?.revision ?? 0) + 1;
  const { data, error } = await admin
    .from("building_revisions")
    .insert({
      project_id: PROJECT_ID,
      revision: nextRevision,
      model,
      checksum: `lower-roof-agent-${nextRevision}`,
      created_by: userId,
      reason,
    })
    .select("revision,id,reason,model")
    .single();
  if (error) throw error;
  return data as { revision: number; id: string; reason: string; model: BuildingModelV1 };
}

async function callAgent(
  cookie: { name: string; value: string },
  message: string,
) {
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

async function restoreViaApi(cookie: { name: string; value: string }, fromRevision: number) {
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
  return { status: undoRes.status, body: await undoRes.text() };
}

function ensureTwoStory(model: BuildingModelV1): BuildingModelV1 {
  if ((model.levels ?? []).length >= 2) return model;
  return applyDesignOperations(model, [
    { op: "createLevel", name: "Second Floor", height: 9, footprintSource: "shell" },
  ]);
}

function seedRearHalf(model: BuildingModelV1): BuildingModelV1 {
  const two = ensureTwoStory(model);
  const shell = two.shell!;
  let next = two;
  const stair = next.stairs?.[0];
  if (stair) {
    next = applyDesignOperations(next, [
      { op: "deleteStair", stairId: stair.id },
    ]);
  }
  return applyDesignOperations(next, [
    {
      op: "setLevelFootprint",
      levelId: "level-2",
      footprint: {
        kind: "rect",
        center: { x: 0, y: shell.depth / 4 },
        width: shell.width,
        depth: shell.depth / 2,
      },
    },
  ]);
}

function seedNarrowSetback(model: BuildingModelV1): BuildingModelV1 {
  const two = ensureTwoStory(model);
  const shell = two.shell!;
  return applyDesignOperations(two, [
    {
      op: "setLevelFootprint",
      levelId: "level-2",
      footprint: {
        kind: "rect",
        center: { x: 0, y: 0 },
        width: Math.max(18, shell.width - 8),
        depth: shell.depth,
      },
    },
  ]);
}

async function runMode(
  admin: ReturnType<typeof createClient>,
  cookie: { name: string; value: string },
  userId: string,
  name: keyof typeof MESSAGES,
) {
  const latest = await latestRevision(admin);
  const seededModel =
    name === "rear-half" ? seedRearHalf(latest.model) : seedNarrowSetback(latest.model);
  const seeded = await commitModel(
    admin,
    userId,
    seededModel,
    `lower-roof-agent-test: seed ${name}`,
  );
  const beforeSnap = snap(seeded.model);
  console.log(`\n=== ${name.toUpperCase()} ===`);
  console.log("seededRev", seeded.revision, "exposed", beforeSnap.exposed);

  const { status, sse } = await callAgent(cookie, MESSAGES[name]);
  const after = await latestRevision(admin);
  const afterSnap = snap(after.model);
  const revisionDelta = after.revision - seeded.revision;

  const lowerMasses = afterSnap.roofs
    .filter((r) => r.role === "lower")
    .flatMap((r) => r.masses);
  const limitation =
    /cannot|can't|unable|limitation|not supported|two-mass|ROOF_INTERSECT/i.test(
      sse.finalText,
    );

  const report: Record<string, unknown> = {
    mode: name,
    httpStatus: status,
    message: MESSAGES[name],
    seedRevision: seeded.revision,
    afterRevision: after.revision,
    revisionDelta,
    modelEvents: sse.modelEvents,
    toolSequence: sse.toolSequence,
    finalText: sse.finalText.slice(0, 2200),
    before: beforeSnap,
    after: afterSnap,
  };

  if (name === "rear-half") {
    report.checks = {
      exposedDetected: beforeSnap.exposed.length >= 1,
      inspectedExposed: sse.toolSequence.some(
        (t) => t.name === "inspect_exposed_roof_regions" || t.name === "inspect_roof",
      ),
      createdLowerMass:
        sse.toolSequence.some(
          (t) => t.name === "create_roof_mass" && t.ok !== false,
        ) && lowerMasses.length >= 1,
      massHasType: lowerMasses.some((m) => m.type != null),
      uncoveredClearedOrReduced:
        afterSnap.uncovered.length < beforeSnap.uncovered.length ||
        afterSnap.uncovered.length === 0,
      stairStillPresent: afterSnap.stairs.length >= beforeSnap.stairs.length,
      rendered: sse.toolSequence.some(
        (t) => t.name === "render_preview" && t.ok !== false,
      ),
      oneRevision: revisionDelta === 1,
      oneSseModel: sse.modelEvents === 1,
    };
    if (revisionDelta > 0) {
      const undo = await restoreViaApi(cookie, seeded.revision);
      const afterUndo = await latestRevision(admin);
      const undoSnap = snap(afterUndo.model);
      report.undo = {
        status: undo.status,
        restoredFrom: seeded.revision,
        revisionAfterUndo: afterUndo.revision,
        lowerRoofsCleared: undoSnap.roofs.every((r) => r.role !== "lower"),
      };
      (report.checks as Record<string, unknown>).undoRestored =
        Boolean((report.undo as { lowerRoofsCleared?: boolean }).lowerRoofsCleared);
    }
  } else {
    report.checks = {
      exposedDetected: beforeSnap.exposed.length >= 1,
      inspectedExposed: sse.toolSequence.some(
        (t) => t.name === "inspect_exposed_roof_regions" || t.name === "inspect_roof_mass",
      ),
      createdLowerOrLimitation: lowerMasses.length >= 1 || limitation,
      didNotFakePrimaryThirdMass: afterSnap.roofs
        .filter((r) => r.role !== "lower")
        .every((r) => r.masses.length <= 2),
      uncoveredImproved:
        afterSnap.uncovered.length <= beforeSnap.uncovered.length,
      oneRevisionIfChanged: revisionDelta === 0 || revisionDelta === 1,
      oneSseIfChanged: revisionDelta === 0 || sse.modelEvents === 1,
      renderedOrLimitation:
        limitation ||
        sse.toolSequence.some((t) => t.name === "render_preview" && t.ok !== false),
    };
  }

  writeFileSync(path.join(outDir, `${name}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.checks ?? {}, null, 2));
  console.log("tools:", sse.toolSequence.map((t) => t.name).join(" → "));
  console.log("final:", sse.finalText.slice(0, 700));
  return report;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const env = loadEnv();
  const { admin, session } = await auth(env);
  const cookie = cookieFromSession(env, session);
  const userId = session.user.id;
  const modes =
    mode === "all" ? (["rear-half", "setback"] as const) : ([mode] as const);

  const reports: Record<string, unknown> = {};
  for (const m of modes) {
    if (!(m in MESSAGES)) {
      console.error("Unknown mode", m);
      process.exit(1);
    }
    reports[m] = await runMode(admin, cookie, userId, m as keyof typeof MESSAGES);
  }
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(reports, null, 2));
  console.log("\nWrote", path.join(outDir, "summary.json"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
