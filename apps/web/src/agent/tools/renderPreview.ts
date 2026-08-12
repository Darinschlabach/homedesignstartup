import { tool, type ToolOutputImage, type ToolOutputText } from "@openai/agents";
import { z } from "zod";
import type { RunContext } from "@openai/agents";
import { homeDesignAgentDevLog } from "../devLog";
import type { DesignAgentContext } from "../context/agentContext";
import {
  assertLoopNotBlocked,
  guardAgainstIdenticalFailure,
  recordToolFailure,
  recordToolSuccess,
} from "../loopSafety";
import { loadAgentModel } from "../project/loadAgentModel";
import { renderBuildingPreview } from "@/lib/render/renderBuildingPreview";

export const renderPreviewTool = tool({
  name: "render_preview",

  description:
    "Capture a real Three.js preview image of the current agent working model (staged when dirty, otherwise base committed revision). Returns an actual image only on success. If rendering fails, imageGenerated=false and you must NOT claim visual inspection. Does not modify the model or create a revision.",

  parameters: z.object({
    view: z
      .enum([
        "front",
        "rear",
        "left",
        "right",
        "perspective",
        "isometric",
        "top",
        "current",
        "room",
      ])
      .optional()
      .describe(
        "Camera view. Elevations: front/rear/left/right. perspective/isometric for 3/4 view. current uses workspace camera when available. room is an interior view when supported. Defaults to front.",
      ),
    width: z.number().int().min(320).max(1920).optional(),
    height: z.number().int().min(240).max(1080).optional(),
  }),

  // No outputSchema — required so image structured outputs reach the model as vision input.
  execute: async (
    args,
    runContext?: RunContext<DesignAgentContext>,
  ): Promise<(ToolOutputText | ToolOutputImage)[] | ToolOutputText> => {
    const context = runContext?.context;
    const view = args.view ?? "front";
    const callArgs = {
      view,
      width: args.width ?? null,
      height: args.height ?? null,
    };

    homeDesignAgentDevLog("render_preview_execute_start", {
      tool: "render_preview",
      arguments: callArgs,
      projectId: context?.projectId ?? null,
      operationId: context?.operationId ?? null,
    });

    if (context?.loopSafety) {
      const blocked =
        assertLoopNotBlocked(context.loopSafety) ??
        guardAgainstIdenticalFailure(
          context.loopSafety,
          "render_preview",
          callArgs,
        );
      if (blocked) {
        const failure = {
          success: false as const,
          imageGenerated: false as const,
          visualInspectionPossible: false as const,
          error: blocked.error,
          code: blocked.code,
          requestedView: view,
          renderBackend: null,
        };
        homeDesignAgentDevLog("render_preview_execute_end", {
          tool: "render_preview",
          projectId: context.projectId ?? null,
          requestedView: view,
          ok: false,
          resultSummary: failure,
        });
        return { type: "text", text: JSON.stringify(failure) };
      }
    }

    const loaded = await loadAgentModel(context);
    if (!loaded.success) {
      recordToolFailure(context?.loopSafety, "render_preview", callArgs);
      const failure = {
        success: false as const,
        imageGenerated: false as const,
        visualInspectionPossible: false as const,
        error: loaded.error,
        code: loaded.code,
        projectId: loaded.projectId,
        requestedView: view,
        renderBackend: null,
      };
      homeDesignAgentDevLog("render_preview_execute_end", {
        tool: "render_preview",
        projectId: context?.projectId ?? null,
        requestedView: view,
        ok: false,
        resultSummary: failure,
      });
      return { type: "text", text: JSON.stringify(failure) };
    }

    const rendered = await renderBuildingPreview({
      model: loaded.model,
      view,
      width: args.width,
      height: args.height,
      currentCamera: context?.cameraSnapshot ?? null,
      projectId: loaded.projectId,
      revision: loaded.revision,
      modelSource: loaded.source,
    });

    if (!rendered.success) {
      recordToolFailure(context?.loopSafety, "render_preview", callArgs);
      const failure = {
        success: false as const,
        imageGenerated: false as const,
        visualInspectionPossible: false as const,
        error: rendered.error,
        code: rendered.code,
        projectId: loaded.projectId,
        baseRevision: loaded.revision,
        revisionId: loaded.revisionId,
        modelSource: loaded.source,
        dirty: loaded.dirty,
        operationId: loaded.operationId ?? null,
        stagedOperationCount: loaded.stagedOperationCount ?? 0,
        requestedView: view,
        renderBackend: null,
        remediation: rendered.remediation ?? null,
        diagnostics: rendered.diagnostics ?? null,
        agentGuidance:
          "Visual inspection FAILED. Do not claim you visually evaluated the design. You may continue with structured geometry/material facts only, and must clearly distinguish structured judgment from visual judgment.",
      };
      homeDesignAgentDevLog("render_preview_execute_end", {
        tool: "render_preview",
        projectId: loaded.projectId,
        baseRevision: loaded.revision,
        modelSource: loaded.source,
        requestedView: view,
        ok: false,
        resultSummary: {
          code: failure.code,
          error: failure.error,
          imageGenerated: false,
          renderBackend: null,
        },
      });
      return { type: "text", text: JSON.stringify(failure) };
    }

    recordToolSuccess(context?.loopSafety);

    if (context?.operation) {
      context.operation.runMetrics.renderPreviewSuccessCount += 1;
    }

    const meta = {
      success: true as const,
      imageGenerated: true as const,
      visualInspectionPossible: true as const,
      projectId: rendered.projectId,
      baseRevision: loaded.revision,
      revisionId: loaded.revisionId,
      modelSource: loaded.source,
      dirty: loaded.dirty,
      operationId: loaded.operationId ?? null,
      stagedOperationCount: loaded.stagedOperationCount ?? 0,
      source: "BuildingModelV1",
      requestedView: rendered.requestedView,
      view: rendered.view,
      camera: rendered.camera,
      width: rendered.width,
      height: rendered.height,
      mediaType: rendered.mediaType,
      renderBackend: rendered.renderBackend,
      assetRef: rendered.assetRef,
      assetPath: rendered.assetPath,
      note: rendered.note ?? null,
      vision:
        loaded.source === "staged"
          ? "IMAGE FOLLOWS — visually inspect this STAGED (uncommitted) preview. Only then make visual claims."
          : "IMAGE FOLLOWS — visually inspect this committed-base preview. Only then make visual claims.",
    };

    homeDesignAgentDevLog("render_preview_execute_end", {
      tool: "render_preview",
      projectId: rendered.projectId,
      baseRevision: loaded.revision,
      modelSource: loaded.source,
      dirty: loaded.dirty,
      requestedView: rendered.requestedView,
      view: rendered.view,
      ok: true,
      resultSummary: {
        imageGenerated: true,
        renderBackend: rendered.renderBackend,
        assetRef: rendered.assetRef,
        assetPath: rendered.assetPath,
        width: rendered.width,
        height: rendered.height,
        mediaType: rendered.mediaType,
        modelSource: loaded.source,
        dirty: loaded.dirty,
      },
    });

    return [
      {
        type: "text",
        text: JSON.stringify(meta),
      },
      {
        type: "image",
        image: rendered.dataUrl,
        detail: "high",
      },
    ];
  },
});
