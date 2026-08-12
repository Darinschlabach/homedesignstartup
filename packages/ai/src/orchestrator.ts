import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { streamText, type CoreMessage } from 'ai';
import type { BuildingModelV1 } from '@aihd/domain';
import { getProjectState, summarizeBuilding } from '@aihd/domain';
import { AgentOperation } from './agent-operation';
import { ARCHITECT_SYSTEM_PROMPT } from './prompts';
import { createDesignTools } from './tools';
import { wrapToolsWithAgentGuards } from './tool-registry';

export type DesignTurnInput = {
  messages: CoreMessage[];
  model: BuildingModelV1;
  /**
   * Persist the final model once per agent operation.
   * Mid-turn tool mutations stay in memory until flush.
   */
  commitModel: (model: BuildingModelV1, reason?: string) => Promise<void> | void;
  enqueueJob?: (
    type: 'render' | 'normalize',
    payload?: Record<string, unknown>,
  ) => Promise<string> | string;
  undoLastChange?: () => Promise<{ model: BuildingModelV1; revision: number } | null> | {
    model: BuildingModelV1;
    revision: number;
  } | null;
  selectedEntityId?: string | null;
  provider?: 'anthropic' | 'openai';
  transactionId?: string;
  turnBaselineRevision?: number;
  projectId?: string;
  userMessage?: string;
  /** Called whenever in-memory model changes (for live preview SSE). */
  onModelDraft?: (model: BuildingModelV1) => void;
};

function hasKey(value?: string) {
  return Boolean(value && value.trim());
}

function resolveProvider(explicit?: 'anthropic' | 'openai'): 'anthropic' | 'openai' {
  if (explicit) return explicit;
  const configured = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (configured === 'openai' && hasKey(process.env.OPENAI_API_KEY)) return 'openai';
  if (configured === 'anthropic' && hasKey(process.env.ANTHROPIC_API_KEY)) return 'anthropic';
  if (hasKey(process.env.OPENAI_API_KEY)) return 'openai';
  if (hasKey(process.env.ANTHROPIC_API_KEY)) return 'anthropic';
  throw new Error('No AI provider API key is configured.');
}

function resolveModel(provider: 'anthropic' | 'openai') {
  if (provider === 'openai') {
    return openai(process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini');
  }
  return anthropic(process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-20250514');
}

export type DesignTurnHandle = {
  operation: AgentOperation;
  result: ReturnType<typeof streamText>;
  /** In-memory model (updated by tools). */
  getModel: () => BuildingModelV1;
  /** True if tools mutated the model and a DB commit is needed. */
  isDirty: () => boolean;
  /** Persist buffered model once (call after stream completes). */
  flush: () => Promise<BuildingModelV1>;
};

/**
 * Autonomous design agent turn with multi-step tools.
 * Mutations buffer in memory; caller flushes a single revision at the end.
 */
export function runDesignTurn(input: DesignTurnInput): DesignTurnHandle {
  let current = input.model;
  let dirty = false;

  const operation = new AgentOperation({
    projectId: input.projectId ?? 'unknown',
    userMessage: input.userMessage ?? '',
    operationId: input.transactionId,
  });

  operation.log('operation_start', {
    baselineRevision: input.turnBaselineRevision,
    selectedEntityId: input.selectedEntityId ?? null,
    messagePreview: (input.userMessage ?? '').slice(0, 200),
  });

  const rawTools = createDesignTools({
    getModel: () => current,
    // Buffer only — do not hit the database on every tool.
    commitModel: async (model, reason) => {
      current = model;
      dirty = true;
      input.onModelDraft?.(model);
      operation.log('model_draft', { reason: reason ?? null });
    },
    enqueueJob: input.enqueueJob,
    undoLastChange: input.undoLastChange
      ? async () => {
          const result = await input.undoLastChange!();
          if (result) {
            current = result.model;
            dirty = false; // restored via its own commit path
            input.onModelDraft?.(current);
          }
          return result;
        }
      : undefined,
    selectedEntityId: input.selectedEntityId ?? null,
    transactionId: operation.id,
  });

  const tools = wrapToolsWithAgentGuards(rawTools as never, operation, {
    maxIdenticalFailures: 2,
    maxToolCalls: 24,
  });

  const summary = summarizeBuilding(current, input.selectedEntityId);
  const projectState = getProjectState(current, input.selectedEntityId);

  const system = `${ARCHITECT_SYSTEM_PROMPT}

Operation id: ${operation.id}
${input.turnBaselineRevision != null ? `Turn baseline revision: ${input.turnBaselineRevision}` : ''}

Building summary (JSON):
${JSON.stringify(summary, null, 2)}

Project state excerpt (JSON):
${JSON.stringify(
  {
    selected: projectState.selected,
    protectedEntityIds: projectState.protectedEntityIds,
    footprint: projectState.footprint,
    rooms: projectState.rooms,
    walls: projectState.walls,
    openings: projectState.openings,
    roof: projectState.roof,
    interiors: projectState.interiors,
    designPreferences: projectState.designPreferences,
    materials: projectState.materials.map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      color: m.color,
    })),
  },
  null,
  2,
)}
`;

  const provider = resolveProvider(input.provider);

  const result = streamText({
    model: resolveModel(provider),
    system,
    messages: input.messages,
    tools,
    maxSteps: 16,
    onFinish: ({ steps }) => {
      operation.log('stream_finish', {
        steps: steps?.length ?? 0,
        dirty,
        toolCallsRecorded: operation.toolCalls.length,
      });
    },
  });

  return {
    operation,
    result,
    getModel: () => current,
    isDirty: () => dirty,
    flush: async () => {
      if (!dirty) {
        operation.complete(input.turnBaselineRevision);
        return current;
      }
      await input.commitModel(current, operation.summaryReason());
      dirty = false;
      return current;
    },
  };
}

export { ARCHITECT_SYSTEM_PROMPT } from './prompts';
export { createDesignTools } from './tools';
export { AgentOperation } from './agent-operation';
export { wrapToolsWithAgentGuards } from './tool-registry';
