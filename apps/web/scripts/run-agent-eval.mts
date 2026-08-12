/**
 * Home Design Agent evaluation harness (development only).
 *
 * Usage:
 *   pnpm exec tsx --tsconfig tsconfig.json scripts/run-agent-eval.mts
 *   pnpm exec tsx --tsconfig tsconfig.json scripts/run-agent-eval.mts 1,3,7
 *   pnpm exec tsx --tsconfig tsconfig.json scripts/run-agent-eval.mts --no-restore
 *
 * Requires:
 *   - apps/web/.env.local (Supabase + OpenAI keys)
 *   - Next.js dev server on http://localhost:3000
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  BuildingModelV1Schema,
  type BuildingModelV1,
} from "@aihd/domain";

import { buildSingleStoryEvalFixture, buildTwoStoryEvalFixture } from "./eval/fixture.ts";
import {
  EVAL_SCENARIOS,
  parseScenarioFilter,
  type EvalScenario,
} from "./eval/scenarios.ts";
import {
  scoreScenario,
  type CommitRecord,
  type FailureCategory,
  type ToolCallRecord,
} from "./eval/score.ts";
import { diffSnaps, snapModel, type ModelSnap } from "./eval/snap.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const envPath = path.join(webRoot, ".env.local");
const outDir = path.join(webRoot, ".tmp-agent-eval");

const PROJECT_ID = "13efe9e0-1cea-40c5-bcf9-4c765dbced8b";
const EMAIL = "darinschlabach07@gmail.com";
const AGENT_URL = process.env.AGENT_EVAL_URL ?? "http://localhost:3000/api/design-agent";
const SCENARIO_DELAY_MS = Number(process.env.AGENT_EVAL_DELAY_MS ?? "8000");
const RATE_LIMIT_MAX_RETRIES = Number(process.env.AGENT_EVAL_MAX_RETRIES ?? "4");
const RATE_LIMIT_BASE_MS = Number(process.env.AGENT_EVAL_BACKOFF_MS ?? "5000");

const argv = process.argv.slice(2);
const noRestore = argv.includes("--no-restore");
const filterArg =
  argv.find((a) => !a.startsWith("--")) ??
  process.env.AGENT_EVAL_SCENARIOS ??
  undefined;
const scenarioFilter = parseScenarioFilter(filterArg);

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

function cookieFromSession(
  env: Record<string, string>,
  session: { access_token: string; refresh_token: string },
) {
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

type ParsedSse = {
  toolCalls: ToolCallRecord[];
  modelEvents: number;
  commit: CommitRecord | null;
  finalText: string;
  errorText: string;
  rawEvents: unknown[];
};

function parseSse(text: string): ParsedSse {
  const toolCalls: ToolCallRecord[] = [];
  const rawEvents: unknown[] = [];
  let modelEvents = 0;
  let finalText = "";
  let errorText = "";
  let commit: CommitRecord | null = null;

  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    let data = "";
    for (const line of lines) {
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      rawEvents.push(parsed);
      const t = parsed.type;
      if (t === "model") modelEvents += 1;
      if (t === "tool" && typeof parsed.name === "string") {
        toolCalls.push({
          name: parsed.name,
          ok: (parsed.ok as boolean | null | undefined) ?? null,
          code: (parsed.code as string | null | undefined) ?? null,
          arguments: parsed.arguments ?? undefined,
          resultSummary: parsed.resultSummary ?? undefined,
        });
      }
      if (t === "commit") {
        commit = {
          success: (parsed.success as boolean | null | undefined) ?? null,
          skipped: (parsed.skipped as boolean | null | undefined) ?? null,
          reason: (parsed.reason as string | null | undefined) ?? null,
          stagedOperationCount:
            (parsed.stagedOperationCount as number | null | undefined) ?? null,
          revisionAfter: (parsed.revisionAfter as number | null | undefined) ?? null,
          baseRevision: (parsed.baseRevision as number | null | undefined) ?? null,
          validation: parsed.validation ?? null,
          code: (parsed.code as string | null | undefined) ?? null,
          completionReport: parsed.completionReport ?? null,
          continuationAttempt: (parsed.continuationAttempt as number | null | undefined) ?? null,
        };
      }
      if (t === "text" && typeof parsed.text === "string") finalText += parsed.text;
      if (t === "error" && typeof parsed.text === "string") errorText += parsed.text;
      if (t === "final" && typeof parsed.response === "string") finalText = parsed.response;
    } catch {
      /* ignore partial JSON */
    }
  }

  return { toolCalls, modelEvents, commit, finalText, errorText, rawEvents };
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

async function latestRevision(admin: SupabaseClient) {
  const { data, error } = await admin
    .from("building_revisions")
    .select("revision,id,reason,model")
    .eq("project_id", PROJECT_ID)
    .order("revision", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("No revision found for eval project");
  return data as { revision: number; id: string; reason: string; model: BuildingModelV1 };
}

async function commitModel(
  admin: SupabaseClient,
  userId: string,
  model: BuildingModelV1,
  reason: string,
) {
  const latest = await latestRevision(admin);
  const nextRevision = latest.revision + 1;
  const { data, error } = await admin
    .from("building_revisions")
    .insert({
      project_id: PROJECT_ID,
      revision: nextRevision,
      model,
      checksum: `agent-eval-${nextRevision}`,
      created_by: userId,
      reason,
    })
    .select("revision,id,reason,model")
    .single();
  if (error) throw error;
  return data as { revision: number; id: string; reason: string; model: BuildingModelV1 };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(text: string): boolean {
  return /\b429\b|rate limit|tokens per min|TPM|too many requests/i.test(text);
}

function parseRetryAfterMs(text: string): number | null {
  const headerMatch = text.match(/retry[- ]after[^0-9]*(\d+)/i);
  if (headerMatch) return Number(headerMatch[1]) * 1000;
  const tryAgain = text.match(/try again in ([0-9.]+)s/i);
  if (tryAgain) return Math.ceil(Number(tryAgain[1]) * 1000);
  return null;
}

async function callAgent(cookie: { name: string; value: string }, message: string) {
  let last: { status: number; text: string; sse: ParsedSse } = {
    status: 0,
    text: "",
    sse: parseSse(""),
  };

  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
    const res = await fetch(AGENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${cookie.name}=${cookie.value}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ projectId: PROJECT_ID, message }),
    });
    const text = await res.text();
    const sse = parseSse(text);
    last = { status: res.status, text, sse };

    const rateLimited =
      res.status === 429 ||
      isRateLimitError(sse.errorText) ||
      isRateLimitError(text);

    if (!rateLimited) {
      return { ...last, rateLimitFailure: false };
    }
    if (attempt >= RATE_LIMIT_MAX_RETRIES) break;

    const retryAfter =
      parseRetryAfterMs(text) ?? parseRetryAfterMs(sse.errorText);
    const waitMs = retryAfter ?? RATE_LIMIT_BASE_MS * Math.pow(2, attempt);
    console.warn(
      `Rate limit (attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES + 1}) — waiting ${waitMs}ms`,
    );
    await sleep(waitMs);
  }

  return { ...last, rateLimitFailure: true };
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

function fixtureModel(kind: EvalScenario["fixture"]): BuildingModelV1 {
  const single = buildSingleStoryEvalFixture();
  return kind === "twoStory" ? buildTwoStoryEvalFixture(single) : single;
}

async function ensureFixture(
  admin: SupabaseClient,
  userId: string,
  scenario: EvalScenario,
): Promise<{ revision: number; model: BuildingModelV1 }> {
  const model = BuildingModelV1Schema.parse(fixtureModel(scenario.fixture));
  const committed = await commitModel(
    admin,
    userId,
    model,
    `agent-eval: fixture scenario ${scenario.id} (${scenario.fixture})`,
  );
  return { revision: committed.revision, model: committed.model };
}

type ScenarioReport = {
  scenarioId: number;
  title: string;
  message: string;
  pass: boolean;
  httpStatus: number;
  baseRevision: number;
  afterRevision: number;
  revisionDelta: number;
  metrics: ReturnType<typeof scoreScenario>["checks"];
  failureCategory: FailureCategory | null;
  failureReason: string | null;
  reviewerNotes: string[];
  toolSequence: ToolCallRecord[];
  toolNames: string[];
  renders: ReturnType<typeof scoreScenario>["renders"];
  commit: CommitRecord | null;
  modelEvents: number;
  finalText: string;
  errorText: string;
  constraintViolations: string[];
  before: ModelSnap;
  after: ModelSnap;
  diff: ReturnType<typeof diffSnaps>;
  designChanges: Record<string, unknown>;
  planning?: {
    taskPlanCreated: boolean;
    progressCheckCount: number;
    commitAllowed: boolean | null;
    incompleteDiscarded: boolean;
    completionReport: unknown;
    rateLimitFailure: boolean;
  };
  restore?: { status: number; revisionAfterRestore: number };
};

async function runScenario(
  admin: SupabaseClient,
  cookie: { name: string; value: string },
  userId: string,
  scenario: EvalScenario,
): Promise<ScenarioReport> {
  console.log(`\n=== Scenario ${scenario.id}: ${scenario.title} ===`);
  const seeded = await ensureFixture(admin, userId, scenario);
  const before = snapModel(seeded.model);
  console.log("base revision", seeded.revision, "fixture", scenario.fixture);

  const { status, sse, rateLimitFailure } = await callAgent(cookie, scenario.message);
  const afterRow = await latestRevision(admin);
  const after = snapModel(BuildingModelV1Schema.parse(afterRow.model));
  const diff = diffSnaps(before, after);
  const revisionDelta = afterRow.revision - seeded.revision;

  const score = scoreScenario({
    scenario,
    tools: sse.toolCalls,
    commit: sse.commit,
    before,
    after,
    diff,
    finalText: sse.finalText,
    modelEvents: sse.modelEvents,
    revisionDelta,
    errorText: sse.errorText,
    rateLimitFailure,
  });

  const report: ScenarioReport = {
    scenarioId: scenario.id,
    title: scenario.title,
    message: scenario.message,
    pass: score.pass,
    httpStatus: status,
    baseRevision: seeded.revision,
    afterRevision: afterRow.revision,
    revisionDelta,
    metrics: score.checks,
    failureCategory: score.failureCategory,
    failureReason: score.failureReason,
    reviewerNotes: score.reviewerNotes,
    toolSequence: sse.toolCalls,
    toolNames: score.toolNames,
    renders: score.renders,
    commit: sse.commit,
    modelEvents: sse.modelEvents,
    finalText: sse.finalText,
    errorText: sse.errorText,
    constraintViolations: score.constraintViolations,
    before,
    after,
    diff,
    designChanges: {
      footprintChanged: diff.footprintChanged,
      l1FootprintChanged: diff.l1FootprintChanged,
      l2AreaBefore: diff.l2AreaBefore,
      l2AreaAfter: diff.l2AreaAfter,
      bedroomDelta: diff.bedroomDelta,
      interiorWallDelta: diff.interiorWallDelta,
      spaceCountDelta: diff.spaceCountDelta,
      stairCountDelta: diff.stairCountDelta,
      roofChanged: diff.roofChanged,
      openingsChanged: diff.openingsChanged,
      materialCatalogChanged: diff.materialCatalogChanged,
      materialBindingsChanged: diff.materialBindingsChanged,
      objectCountDelta: diff.objectCountDelta,
      geometryValid: after.geometryValid,
    },
    planning: {
      taskPlanCreated: sse.toolCalls.some((t) => t.name === "set_task_plan"),
      progressCheckCount: sse.toolCalls.filter(
        (t) => t.name === "check_operation_progress",
      ).length,
      commitAllowed: sse.commit?.success === true && sse.commit?.skipped === false,
      incompleteDiscarded:
        sse.commit?.code === "INCOMPLETE_OPERATION" ||
        Boolean(sse.errorText && /materially incomplete/i.test(sse.errorText)),
      completionReport: sse.commit?.completionReport ?? null,
      rateLimitFailure,
    },
  };

  if (!noRestore && revisionDelta > 0) {
    const restore = await restoreViaApi(cookie, seeded.revision);
    const restored = await latestRevision(admin);
    report.restore = {
      status: restore.status,
      revisionAfterRestore: restored.revision,
    };
  }

  writeFileSync(
    path.join(outDir, `scenario-${scenario.id}.json`),
    JSON.stringify(report, null, 2),
  );

  console.log(score.pass ? "PASS" : "FAIL", score.failureCategory ?? "", score.failureReason ?? "");
  console.log("tools:", score.toolNames.join(" → "));
  console.log(
    "metrics:",
    JSON.stringify(
      {
        taskCompleted: score.checks.taskCompleted,
        oneSse: score.checks.oneSse,
        revisionDelta,
        stagedMutations: score.checks.stagedMutationCount,
        validationErrors: score.checks.validationErrors,
        geometryValid: score.checks.geometryValid,
        visualRender: score.checks.visualRenderUsed,
      },
      null,
      0,
    ),
  );
  if (sse.finalText) console.log("final:", sse.finalText.slice(0, 500));

  return report;
}

function summarizeReports(reports: ScenarioReport[]) {
  const passCount = reports.filter((r) => r.pass).length;
  const byCategory: Record<string, number> = {};
  for (const r of reports) {
    if (r.failureCategory) byCategory[r.failureCategory] = (byCategory[r.failureCategory] ?? 0) + 1;
  }

  const repeated: string[] = [];
  const maxTurns = reports.filter((r) => /max turns/i.test(r.errorText)).length;
  if (maxTurns >= 2) repeated.push(`Max turns exceeded in ${maxTurns} scenarios`);
  const noRender = reports.filter(
    (r) => r.metrics.visualRenderWhereAppropriate === false,
  ).length;
  if (noRender >= 3) repeated.push(`Visual render missing on ${noRender} visual scenarios`);
  const inspectLate = reports.filter((r) => r.metrics.inspectBeforeMutate === false).length;
  if (inspectLate >= 2) repeated.push(`Mutated before inspect/render in ${inspectLate} scenarios`);
  const validation = reports.filter((r) => r.metrics.validationErrors > 0).length;
  if (validation >= 3) repeated.push(`Validation tool failures in ${validation} scenarios`);

  const topImprovements = [
    "Increase agent turn budget or improve early inspection→plan→commit pacing for multi-step requests.",
    "Stronger pre-mutation inspect/render guidance for ambiguous and whole-house requests.",
    "Better constraint tracking in final responses (footprint, garage, front door, geometry-only).",
    "Clearer unsupported-capability messaging (spiral stairs, curved glass walls).",
    "Reduce repeated failed tool retries via loop-safety feedback in agent context.",
  ];

  const missingCapabilities = [
    "Spiral / curved stair types",
    "Curved or non-rectilinear walls (e.g. curved glass wall)",
    "Automatic room program inference from vague 'fix it' prompts without explicit inspect/render",
  ];

  return {
    generatedAt: new Date().toISOString(),
    projectId: PROJECT_ID,
    passCount,
    failCount: reports.length - passCount,
    results: reports.map((r) => ({
      id: r.scenarioId,
      title: r.title,
      pass: r.pass,
      failureCategory: r.failureCategory,
      failureReason: r.failureReason,
      toolNames: r.toolNames,
      renders: r.renders.length,
      constraintViolations: r.constraintViolations,
      revisionDelta: r.revisionDelta,
      oneSse: r.metrics.oneSse,
      taskCompleted: r.metrics.taskCompleted,
    })),
    failureCategories: byCategory,
    repeatedProblems: repeated,
    topImprovements,
    missingCapabilities,
    reports,
  };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const env = loadEnv();
  const { admin, session } = await auth(env);
  const cookie = cookieFromSession(env, session);
  const userId = session.user.id;

  const scenarios = scenarioFilter
    ? EVAL_SCENARIOS.filter((s) => scenarioFilter.includes(s.id))
    : EVAL_SCENARIOS;

  console.log(`Running ${scenarios.length} agent evaluation scenario(s)…`);
  if (scenarioFilter) {
    console.log("Filter:", scenarioFilter.join(", "));
  }
  console.log("Output:", outDir);

  const reports: ScenarioReport[] = [];
  for (const scenario of scenarios) {
    reports.push(await runScenario(admin, cookie, userId, scenario));
    if (SCENARIO_DELAY_MS > 0) {
      await sleep(SCENARIO_DELAY_MS);
    }
  }

  const summary = summarizeReports(reports);
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# Home Design Agent Evaluation",
      "",
      `Generated: ${summary.generatedAt}`,
      "",
      `**Pass:** ${summary.passCount}/${reports.length}`,
      "",
      "## Results",
      "",
      ...summary.results.map(
        (r) =>
          `- **${r.id}. ${r.title}** — ${r.pass ? "PASS" : "FAIL"}${r.failureCategory ? ` (${r.failureCategory})` : ""}`,
      ),
      "",
      "## Repeated problems",
      "",
      ...(summary.repeatedProblems.length
        ? summary.repeatedProblems.map((p) => `- ${p}`)
        : ["- None flagged"]),
      "",
      "## Top 5 improvements",
      "",
      ...summary.topImprovements.map((t, i) => `${i + 1}. ${t}`),
      "",
      "## Missing capabilities",
      "",
      ...summary.missingCapabilities.map((m) => `- ${m}`),
    ].join("\n"),
  );

  console.log(`\nWrote ${path.join(outDir, "summary.json")}`);
  console.log(`Pass ${summary.passCount}/${reports.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
