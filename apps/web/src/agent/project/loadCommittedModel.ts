import { ensureEntities, type BuildingModelV1 } from "@aihd/domain";
import type { DesignAgentContext } from "../context/agentContext";
import { getLatestRevision, parseModel } from "@/lib/projects";
import { createClient } from "@/lib/supabase/server";

export type LoadModelFailure = {
  success: false;
  error: string;
  code:
    | "MISSING_CONTEXT"
    | "UNAUTHORIZED"
    | "PROJECT_NOT_FOUND"
    | "NO_REVISION"
    | "INVALID_MODEL"
    | "LOAD_FAILED";
  projectId?: string;
};

export type LoadModelSuccess = {
  success: true;
  projectId: string;
  revision: number;
  revisionId: string;
  model: BuildingModelV1;
  units: BuildingModelV1["meta"]["units"];
};

export async function loadLatestCommittedModel(
  context: DesignAgentContext | undefined,
): Promise<LoadModelSuccess | LoadModelFailure> {
  if (!context?.projectId || !context.userId) {
    return {
      success: false,
      error: "Agent context is missing projectId or userId.",
      code: "MISSING_CONTEXT",
    };
  }

  try {
    const supabase = await createClient();
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id")
      .eq("id", context.projectId)
      .maybeSingle();

    if (projectError) {
      return {
        success: false,
        error: projectError.message || "Failed to load project.",
        code: "UNAUTHORIZED",
        projectId: context.projectId,
      };
    }

    if (!project) {
      return {
        success: false,
        error: `Project not found or access denied: ${context.projectId}`,
        code: "PROJECT_NOT_FOUND",
        projectId: context.projectId,
      };
    }

    const latest = await getLatestRevision(context.projectId);
    if (!latest) {
      return {
        success: false,
        error: "No building revision exists for this project.",
        code: "NO_REVISION",
        projectId: context.projectId,
      };
    }

    let model: BuildingModelV1;
    try {
      model = ensureEntities(parseModel(latest.model));
    } catch (parseError) {
      return {
        success: false,
        error:
          parseError instanceof Error
            ? parseError.message
            : "Invalid building model JSON in revision.",
        code: "INVALID_MODEL",
        projectId: context.projectId,
      };
    }

    return {
      success: true,
      projectId: context.projectId,
      revision: latest.revision,
      revisionId: latest.id,
      model,
      units: model.meta.units,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: message,
      code: /unauthor/i.test(message) ? "UNAUTHORIZED" : "LOAD_FAILED",
      projectId: context.projectId,
    };
  }
}
