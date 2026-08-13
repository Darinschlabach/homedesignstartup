import { NextResponse } from "next/server";
import { ensureEntities, type BuildingModelV1 } from "@aihd/domain";

import { homeDesignAgent } from "@/agent/designAgent";
import type { DesignAgentContext } from "@/agent/context/agentContext";
import { homeDesignAgentDevLog } from "@/agent/devLog";
import {
  createLoopSafetyState,
  HOME_DESIGN_AGENT_MAX_TURNS,
} from "@/agent/loopSafety";
import {
  commitAgentOperation,
  createAgentOperation,
  discardAgentOperation,
} from "@/agent/operation/agentOperation";
import { capabilityBoundaryPrompt } from "@/agent/planning/capabilityPolicy";
import { designRunner } from "@/agent/runner";
import type { CompletionReport } from "@/agent/planning/taskPlan";
import { getLatestRevision, parseModel, requireUser } from "@/lib/projects";

const MAX_COMPLETION_CONTINUATIONS = 2;
const REQUEST_TIMEOUT_MS = Number(
  process.env.HOME_DESIGN_AGENT_REQUEST_TIMEOUT_MS ?? "300000",
);
const SSE_HEARTBEAT_MS = 15000;

function buildContinuationPrompt(
  report: CompletionReport | undefined,
  originalUserMessage: string,
): string {
  const gap = report?.gapSummary;
  return [
    `Original user request (still authoritative): ${originalUserMessage}`,
    "Continue the same staged design operation — do not restart from scratch.",
    gap?.repairGuidance ??
      "Repair ONLY remaining gaps while preserving completed staged work.",
    gap?.completedOutcomes?.length
      ? `Already completed: ${gap.completedOutcomes.map((o) => o.description).join("; ")}`
      : null,
    gap?.unsatisfiedOutcomes?.length
      ? `Still needed: ${gap.unsatisfiedOutcomes.map((o) => `${o.description}${o.reason ? ` (${o.reason})` : ""}`).join("; ")}`
      : report?.pendingOutcomeIds?.length
        ? `Pending planned outcomes: ${report.pendingOutcomeIds.join(", ")}`
        : null,
    gap?.violatedConstraints?.length
      ? `Constraint violations: ${gap.violatedConstraints.map((c) => c.violation ?? c.description).join("; ")}`
      : report?.constraintViolations?.length
        ? `Constraint violations to fix: ${report.constraintViolations.join("; ")}`
        : null,
    gap?.blockedDependencies?.length
      ? `Blocked dependencies: ${gap.blockedDependencies.join("; ")}`
      : report?.missingChecks?.length
        ? `Missing completion checks: ${report.missingChecks.join("; ")}`
        : null,
    "Merge-revise the task plan if needed (never drop required outcomes silently). Inspect blocking dependencies, finish every required outcome, then call check_operation_progress before finishing.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Keep SSE tool payloads small (eval harness / UI). Never include image bytes. */
function truncateForSse(value: unknown, maxChars = 6000): unknown {
  if (value == null) return null;
  try {
    const s = JSON.stringify(value);
    if (s.length <= maxChars) return value;
    return { _truncated: true, preview: s.slice(0, maxChars) };
  } catch {
    return null;
  }
}

/**
 * Same SSE event shapes as /api/chat so ArchitectChat can reuse onModelUpdated:
 *   { type: 'text', text }
 *   { type: 'model', model, revision }  // committed BuildingModelV1 only (final op commit)
 *   { type: 'error', text }
 *   data: [DONE]
 */
export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  const requestId =
    request.headers.get("x-agent-eval-request-id") ??
    `req-${requestStartedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const timing = (stage: string, detail: Record<string, unknown> = {}) =>
    homeDesignAgentDevLog("request_timing", {
      requestId,
      stage,
      elapsedMs: Date.now() - requestStartedAt,
      ...detail,
    });

  timing("request_start");
  try {
    const { user, supabase } = await requireUser();
    timing("auth_complete");
    const body = await request.json();
    timing("body_parsed");

    const message =
      typeof body?.message === "string" ? body.message.trim() : "";
    const projectId =
      typeof body?.projectId === "string" ? body.projectId.trim() : "";
    const selectedEntityId =
      typeof body?.selectedEntityId === "string"
        ? body.selectedEntityId
        : body?.selectedEntityId === null
          ? null
          : undefined;

    const cameraSnapshot =
      body?.cameraSnapshot &&
      typeof body.cameraSnapshot === "object" &&
      body.cameraSnapshot.position &&
      body.cameraSnapshot.target
        ? {
            position: {
              x: Number(body.cameraSnapshot.position.x),
              y: Number(body.cameraSnapshot.position.y),
              z: Number(body.cameraSnapshot.position.z),
            },
            target: {
              x: Number(body.cameraSnapshot.target.x),
              y: Number(body.cameraSnapshot.target.y),
              z: Number(body.cameraSnapshot.target.z),
            },
            fov:
              typeof body.cameraSnapshot.fov === "number"
                ? body.cameraSnapshot.fov
                : 45,
          }
        : undefined;

    if (!message) {
      return NextResponse.json(
        { error: "A message is required." },
        { status: 400 },
      );
    }

    if (!projectId) {
      return NextResponse.json(
        { error: "A projectId is required." },
        { status: 400 },
      );
    }

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .maybeSingle();

    if (projectError) {
      return NextResponse.json(
        { error: projectError.message || "Failed to load project." },
        { status: 400 },
      );
    }

    if (!project) {
      return NextResponse.json(
        { error: "Project not found or access denied." },
        { status: 404 },
      );
    }
    timing("project_load_complete");

    const latest = await getLatestRevision(projectId);
    if (!latest) {
      return NextResponse.json(
        { error: "No building revision exists for this project." },
        { status: 404 },
      );
    }
    timing("revision_load_complete", { revision: latest.revision });

    let baseModel: BuildingModelV1;
    try {
      baseModel = ensureEntities(parseModel(latest.model));
    } catch {
      return NextResponse.json(
        { error: "Invalid building model in latest revision." },
        { status: 400 },
      );
    }

    const operationId = `hdr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const encoder = new TextEncoder();
    const runAbortController = new AbortController();
    const abortFromClient = () =>
      runAbortController.abort(new Error("Client disconnected."));
    request.signal.addEventListener("abort", abortFromClient, { once: true });
    const stream = new ReadableStream({
      async start(controller) {
        let streamClosed = false;
        const send = (payload: unknown) => {
          if (streamClosed || runAbortController.signal.aborted) return;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        };
        const heartbeat = setInterval(() => {
          if (!streamClosed && !runAbortController.signal.aborted) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          }
        }, SSE_HEARTBEAT_MS);
        const timeout = setTimeout(() => {
          timing("request_timeout", { timeoutMs: REQUEST_TIMEOUT_MS });
          runAbortController.abort(
            new Error(`Design agent request timed out after ${REQUEST_TIMEOUT_MS}ms.`),
          );
        }, REQUEST_TIMEOUT_MS);
        timing("sse_open");

        let lastEmittedRevision: number | null = null;
        let firstModelResponseObserved = false;

        const context: DesignAgentContext = {
          userId: user.id,
          projectId,
          operationId,
          selectedEntityId,
          cameraSnapshot,
          loopSafety: createLoopSafetyState(),
          operation: createAgentOperation({
            operationId,
            projectId,
            userId: user.id,
            userMessage: message,
            baseRevision: latest.revision,
            baseRevisionId: latest.id,
            baseModel,
          }),
          emitCommittedModel: (model: BuildingModelV1, revision: number) => {
            if (lastEmittedRevision != null && revision <= lastEmittedRevision) {
              return;
            }
            lastEmittedRevision = revision;
            homeDesignAgentDevLog("live_model_emit", {
              runId: operationId,
              projectId,
              revision,
            });
            send({ type: "model", model, revision });
          },
          emitToolEvent: (payload) => {
            if (!firstModelResponseObserved) {
              firstModelResponseObserved = true;
              timing("first_model_response", { via: "tool_call" });
            }
            if (payload.name === "render_preview") {
              timing(payload.phase === "start" ? "render_start" : "render_finish", {
                ok: payload.ok ?? null,
                code: payload.code ?? null,
              });
            }
            timing("tool_call", {
              phase: payload.phase,
              tool: payload.name,
              ok: payload.ok ?? null,
              code: payload.code ?? null,
            });
            if (payload.phase === "end") {
              send({
                type: "tool",
                name: payload.name,
                ok: payload.ok ?? null,
                code: payload.code ?? null,
                arguments: truncateForSse(payload.arguments),
                resultSummary: truncateForSse(payload.resultSummary),
              });
            }
          },
        };

        homeDesignAgentDevLog("run_start", {
          runId: operationId,
          userMessage: message,
          projectId,
          userId: user.id,
          baseRevision: latest.revision,
          agent: homeDesignAgent.name,
        });

        try {
          const boundaryPrompt = context.operation
            ? capabilityBoundaryPrompt(context.operation.capabilityAssessment)
            : null;
          let runMessage = boundaryPrompt
            ? `${message}\n\n${boundaryPrompt}`
            : message;
          let result: { finalOutput?: unknown } | null = null;
          let commitResult: Awaited<ReturnType<typeof commitAgentOperation>> | null =
            null;

          for (
            let attempt = 0;
            attempt <= MAX_COMPLETION_CONTINUATIONS;
            attempt += 1
          ) {
            timing("agent_run_start", { continuationAttempt: attempt });
            result = await designRunner.run(homeDesignAgent, runMessage, {
              context,
              maxTurns: HOME_DESIGN_AGENT_MAX_TURNS,
              signal: runAbortController.signal,
            });
            if (!firstModelResponseObserved) {
              firstModelResponseObserved = true;
              timing("first_model_response", { via: "final_output" });
            }
            timing("agent_run_complete", { continuationAttempt: attempt });

            commitResult = await commitAgentOperation(context);
            timing(commitResult.success ? "commit" : "commit_blocked", {
              continuationAttempt: attempt,
              code: "code" in commitResult ? commitResult.code ?? null : null,
            });
            send({
              type: "commit",
              success: commitResult.success,
              skipped:
                "skipped" in commitResult ? Boolean(commitResult.skipped) : false,
              reason:
                "reason" in commitResult ? (commitResult.reason ?? null) : null,
              stagedOperationCount:
                "stagedOperationCount" in commitResult
                  ? (commitResult.stagedOperationCount ?? 0)
                  : 0,
              revisionAfter:
                "revisionAfter" in commitResult
                  ? (commitResult.revisionAfter ?? null)
                  : null,
              baseRevision: commitResult.baseRevision,
              validation:
                "validation" in commitResult
                  ? (commitResult.validation ?? null)
                  : null,
              code: "code" in commitResult ? (commitResult.code ?? null) : null,
              completionReport:
                "completionReport" in commitResult
                  ? (commitResult.completionReport ?? null)
                  : null,
              continuationAttempt: attempt,
            });

            if (commitResult.success) break;
            if ("skipped" in commitResult && commitResult.skipped) break;

            if (
              commitResult.code === "INCOMPLETE_OPERATION" &&
              attempt < MAX_COMPLETION_CONTINUATIONS &&
              context.operation
            ) {
              context.operation.progressAcknowledged = false;
              runMessage = buildContinuationPrompt(
                "completionReport" in commitResult
                  ? commitResult.completionReport
                  : undefined,
                context.operation.userMessage,
              );
              homeDesignAgentDevLog("agent_operation_continuation", {
                runId: operationId,
                attempt: attempt + 1,
                completionReport:
                  "completionReport" in commitResult
                    ? commitResult.completionReport
                    : null,
              });
              continue;
            }
            break;
          }

          if (!commitResult || !result) {
            throw new Error("Agent run did not produce a result.");
          }

          if (!commitResult.success) {
            discardAgentOperation(context);
            timing("discard");
            const incomplete =
              commitResult.code === "INCOMPLETE_OPERATION" &&
              "completionReport" in commitResult;
            send({
              type: "error",
              text: commitResult.error,
              incomplete: incomplete || undefined,
              completionReport: incomplete
                ? commitResult.completionReport
                : undefined,
            });
            homeDesignAgentDevLog("run_finish", {
              runId: operationId,
              projectId,
              ok: false,
              error: commitResult.error,
              commit: commitResult,
              baseRevision: latest.revision,
            });
          } else {
            const finalText =
              typeof result.finalOutput === "string"
                ? result.finalOutput
                : result.finalOutput != null
                  ? String(result.finalOutput)
                  : "";

            if (finalText) {
              send({ type: "text", text: finalText });
            }

            homeDesignAgentDevLog("run_finish", {
              runId: operationId,
              projectId,
              ok: true,
              finalOutput: finalText || null,
              baseRevision: latest.revision,
              commit: commitResult,
              lastEmittedRevision,
              maxTurns: HOME_DESIGN_AGENT_MAX_TURNS,
              loopSafety: context.loopSafety
                ? {
                    blocked: context.loopSafety.blocked,
                    blockReason: context.loopSafety.blockReason ?? null,
                    consecutiveValidationFailures:
                      context.loopSafety.consecutiveValidationFailures,
                    successfulModObjectIds: Object.keys(
                      context.loopSafety.successfulModsByObject,
                    ),
                  }
                : null,
            });
          }
        } catch (runError) {
          discardAgentOperation(context);
          const messageText =
            runError instanceof Error ? runError.message : String(runError);
          const isMaxTurns = /max turns/i.test(messageText);

          homeDesignAgentDevLog("run_finish", {
            runId: operationId,
            projectId,
            ok: false,
            error: messageText,
            maxTurnsExceeded: isMaxTurns,
            maxTurns: HOME_DESIGN_AGENT_MAX_TURNS,
            baseRevision: latest.revision,
            discarded: true,
            loopSafety: context.loopSafety
              ? {
                  blocked: context.loopSafety.blocked,
                  blockReason: context.loopSafety.blockReason ?? null,
                }
              : null,
          });

          send({
            type: "error",
            text: isMaxTurns
              ? `Stopped after ${HOME_DESIGN_AGENT_MAX_TURNS} agent turns to prevent a runaway loop. Staged changes were discarded. Please refine your request or continue in a new message.`
              : messageText,
          });
        } finally {
          clearTimeout(timeout);
          clearInterval(heartbeat);
          request.signal.removeEventListener("abort", abortFromClient);
          if (!streamClosed && !request.signal.aborted) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            timing("sse_close");
            streamClosed = true;
            controller.close();
          }
          timing("request_end", {
            aborted: runAbortController.signal.aborted,
          });
        }
      },
      cancel(reason) {
        timing("sse_cancel", {
          reason: reason instanceof Error ? reason.message : String(reason ?? ""),
        });
        runAbortController.abort(reason);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Design agent failed.";
    if (message === "Unauthorized") {
      return NextResponse.json({ success: false, error: message }, { status: 401 });
    }

    console.error("Design agent error:", error);

    return NextResponse.json(
      {
        success: false,
        error: "The design agent failed to process the request.",
      },
      { status: 500 },
    );
  }
}
