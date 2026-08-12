import { Runner } from "@openai/agents";
import type { RunContext } from "@openai/agents";
import {
  homeDesignAgentDevLog,
  isHomeDesignAgentDevLoggingEnabled,
  parseToolCallArguments,
  toolNameFromCall,
} from "./devLog";
import type { DesignAgentContext } from "./context/agentContext";

/** Redact image payloads from tool-end logs (never log image bytes). */
function summarizeToolResultForLog(result: unknown): unknown {
  if (Array.isArray(result)) {
    return result.map((item) => {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if (record.type === "image") {
          return {
            type: "image",
            detail: record.detail ?? null,
            image: "[omitted]",
          };
        }
        if (typeof record.text === "string" && record.text.includes("data:image")) {
          return { ...record, text: "[text with embedded image data omitted]" };
        }
      }
      return item;
    });
  }

  if (typeof result === "string") {
    if (result.includes("data:image") || result.length > 4000) {
      try {
        const parsed = JSON.parse(result);
        return summarizeToolResultForLog(parsed);
      } catch {
        return result.length > 4000 ? `${result.slice(0, 200)}…[truncated]` : result;
      }
    }
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }

  return result;
}

function successMeta(result: unknown): { ok: boolean | null; code: string | null } {
  const summarized = summarizeToolResultForLog(result);
  if (summarized && typeof summarized === "object" && !Array.isArray(summarized)) {
    const rec = summarized as Record<string, unknown>;
    return {
      ok: typeof rec.success === "boolean" ? rec.success : null,
      code: typeof rec.code === "string" ? rec.code : null,
    };
  }
  if (Array.isArray(summarized)) {
    const textItem = summarized.find(
      (i) => i && typeof i === "object" && (i as { type?: string }).type === "text",
    ) as { text?: string } | undefined;
    if (typeof textItem?.text === "string") {
      try {
        const parsed = JSON.parse(textItem.text) as Record<string, unknown>;
        return {
          ok: typeof parsed.success === "boolean" ? parsed.success : null,
          code: typeof parsed.code === "string" ? parsed.code : null,
        };
      } catch {
        /* ignore */
      }
    }
  }
  return { ok: null, code: null };
}

export const designRunner = new Runner();

designRunner.on(
  "agent_tool_start",
  (runContext: RunContext<DesignAgentContext>, _agent, tool, details) => {
    const name = toolNameFromCall(tool, details.toolCall);
    const args = parseToolCallArguments(details.toolCall);
    if (isHomeDesignAgentDevLoggingEnabled()) {
      homeDesignAgentDevLog("tool_start", {
        tool: name,
        arguments: args,
      });
    }
    runContext.context?.emitToolEvent?.({
      phase: "start",
      name,
      arguments: args,
    });
  },
);

designRunner.on(
  "agent_tool_end",
  (runContext: RunContext<DesignAgentContext>, _agent, tool, result, details) => {
    const name = toolNameFromCall(tool, details.toolCall);
    const args = parseToolCallArguments(details.toolCall);
    const meta = successMeta(result);
    if (isHomeDesignAgentDevLoggingEnabled()) {
      homeDesignAgentDevLog("tool_end", {
        tool: name,
        arguments: args,
        result: summarizeToolResultForLog(result),
        ok: true,
      });
    }
    runContext.context?.emitToolEvent?.({
      phase: "end",
      name,
      ok: meta.ok,
      code: meta.code,
      arguments: args,
      resultSummary: summarizeToolResultForLog(result),
    });
  },
);
