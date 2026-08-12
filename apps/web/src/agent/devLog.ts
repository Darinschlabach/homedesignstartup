/**
 * Development-only server logs for the Home Design Agent.
 * Never logs system prompts, chain-of-thought, or secrets.
 */

export function isHomeDesignAgentDevLoggingEnabled(): boolean {
  return process.env.NODE_ENV === "development";
}

export function homeDesignAgentDevLog(
  event: string,
  payload: Record<string, unknown> = {},
): void {
  if (!isHomeDesignAgentDevLoggingEnabled()) return;

  console.info(
    JSON.stringify({
      scope: "home-design-agent",
      event,
      ...payload,
      ts: new Date().toISOString(),
    }),
  );
}

/** Parse tool call arguments from the Agents SDK toolCall item (JSON string or object). */
export function parseToolCallArguments(toolCall: unknown): unknown {
  if (!toolCall || typeof toolCall !== "object") return {};

  const call = toolCall as { arguments?: unknown; name?: unknown };
  const raw = call.arguments;

  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return raw;

  try {
    return JSON.parse(raw);
  } catch {
    return { _unparsed: raw };
  }
}

export function toolNameFromCall(tool: { name?: string } | undefined, toolCall: unknown): string {
  if (tool?.name) return tool.name;
  if (toolCall && typeof toolCall === "object" && "name" in toolCall) {
    const name = (toolCall as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "unknown_tool";
}
