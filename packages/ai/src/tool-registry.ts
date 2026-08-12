import { tool, type CoreTool } from 'ai';
import { z } from 'zod';
import type { AgentOperation } from './agent-operation';

type AnyTool = CoreTool<any, any>;

/**
 * Wrap AI SDK tools with:
 * - serialized execution (prevents parallel model write races)
 * - identical-failure loop protection
 * - structured error returns (agent can recover)
 * - operation logging
 */
export function wrapToolsWithAgentGuards(
  tools: Record<string, AnyTool>,
  operation: AgentOperation,
  options?: { maxIdenticalFailures?: number; maxToolCalls?: number },
): Record<string, AnyTool> {
  const maxIdenticalFailures = options?.maxIdenticalFailures ?? 2;
  const maxToolCalls = options?.maxToolCalls ?? 24;
  const wrapped: Record<string, AnyTool> = {};

  for (const [name, original] of Object.entries(tools)) {
    const parameters =
      // AI SDK tools expose parameters / inputSchema depending on version
      (original as { parameters?: z.ZodType; inputSchema?: z.ZodType }).parameters ??
      (original as { inputSchema?: z.ZodType }).inputSchema ??
      z.object({}).passthrough();

    const description =
      (original as { description?: string }).description ?? `Tool: ${name}`;

    const originalExecute = (original as { execute?: Function }).execute;
    if (typeof originalExecute !== 'function') {
      wrapped[name] = original;
      continue;
    }

    wrapped[name] = tool({
      description,
      parameters: parameters as z.ZodType,
      execute: async (args: unknown, execOptions: unknown) => {
        if (operation.toolCalls.length >= maxToolCalls) {
          return {
            ok: false,
            error: `Agent operation hit max tool calls (${maxToolCalls}). Summarize progress and ask the user how to continue.`,
            code: 'MAX_TOOL_CALLS',
          };
        }

        if (operation.shouldBlockRetry(name, args, maxIdenticalFailures)) {
          return {
            ok: false,
            error: `Blocked repeated identical failure for tool "${name}" with the same arguments. Inspect project state, change arguments, use a different tool, or explain the problem to the user.`,
            code: 'IDENTICAL_FAILURE_LOOP',
            hint: 'Do not retry the exact same call again.',
          };
        }

        const index = operation.recordToolStart(name, args);
        const started = Date.now();

        try {
          const result = await operation.enqueueWrite(() =>
            originalExecute(args, execOptions),
          );
          const durationMs = Date.now() - started;

          // Treat structured { ok: false } as a recoverable tool failure for loop protection
          if (
            result &&
            typeof result === 'object' &&
            'ok' in result &&
            (result as { ok: unknown }).ok === false
          ) {
            const message =
              typeof (result as { error?: unknown }).error === 'string'
                ? (result as { error: string }).error
                : 'Tool reported failure';
            operation.recordToolFailure(index, name, args, message, durationMs);
            return result;
          }

          operation.recordToolSuccess(index, name, args, durationMs);
          return result;
        } catch (error) {
          const durationMs = Date.now() - started;
          const message = error instanceof Error ? error.message : String(error);
          operation.recordToolFailure(index, name, args, message, durationMs);
          // Return error to the model instead of crashing the turn
          return {
            ok: false,
            error: message,
            code: 'TOOL_EXCEPTION',
            recoverable: true,
          };
        }
      },
    }) as AnyTool;
  }

  return wrapped;
}
