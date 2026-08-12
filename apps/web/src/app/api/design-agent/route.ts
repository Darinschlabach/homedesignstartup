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
import { designRunner } from "@/agent/runner";
import type { CompletionReport } from "@/agent/planning/taskPlan";
import { getLatestRevision, parseModel, requireUser } from "@/lib/projects";

const MAX_COMPLETION_CONTINUATIONS = 2;

function buildContinuationPrompt(
  report: CompletionReport | undefined,
): string {
  const gap = report?.gapSummary;
  return [
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
  try {
    const { user, supabase } = await requireUser();
    const body = await request.json();

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

    const latest = await getLatestRevision(projectId);
    if (!latest) {
      return NextResponse.json(
        { error: "No building revision exists for this project." },
        { status: 404 },
      );
    }

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
    const stream = new ReadableStream({
      async start(controller) {
        const send = (payload: unknown) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        };

        let lastEmittedRevision: number | null = null;

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
          let runMessage = message;
          let result: { finalOutput?: unknown } | null = null;
          let commitResult: Awaited<ReturnType<typeof commitAgentOperation>> | null =
            null;

          for (
            let attempt = 0;
            attempt <= MAX_COMPLETION_CONTINUATIONS;
            attempt += 1
          ) {
            result = await designRunner.run(homeDesignAgent, runMessage, {
              context,
              maxTurns: HOME_DESIGN_AGENT_MAX_TURNS,
            });

            commitResult = await commitAgentOperation(context);
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
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
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
