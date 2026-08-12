/**
 * Agent operation: one user request → multi-step tool loop → single revision commit.
 * Keeps mutations in memory during the turn to avoid revision races.
 */

export type AgentToolCallRecord = {
  index: number;
  name: string;
  args: unknown;
  ok: boolean;
  error?: string;
  durationMs: number;
  at: string;
};

export type AgentOperationStatus = 'running' | 'completed' | 'failed';

export class AgentOperation {
  readonly id: string;
  readonly projectId: string;
  readonly userMessage: string;
  readonly startedAt: string;
  status: AgentOperationStatus = 'running';
  completedAt?: string;
  toolCalls: AgentToolCallRecord[] = [];
  errors: string[] = [];
  resultingRevision?: number;
  private failureCounts = new Map<string, number>();
  private writeQueue: Promise<unknown> = Promise.resolve();
  private toolCallIndex = 0;

  constructor(options: { projectId: string; userMessage: string; operationId?: string }) {
    this.id = options.operationId ?? `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.projectId = options.projectId;
    this.userMessage = options.userMessage;
    this.startedAt = new Date().toISOString();
  }

  /** Serialize mutating work so parallel tool calls cannot interleave model writes. */
  enqueueWrite<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.writeQueue.then(() => fn(), () => fn());
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  fingerprint(name: string, args: unknown): string {
    try {
      return `${name}:${JSON.stringify(args)}`;
    } catch {
      return `${name}:[unserializable]`;
    }
  }

  /**
   * Returns true if this exact failing call should be blocked
   * (same tool + args failed too many times).
   */
  shouldBlockRetry(name: string, args: unknown, maxIdenticalFailures = 2): boolean {
    const key = this.fingerprint(name, args);
    return (this.failureCounts.get(key) ?? 0) >= maxIdenticalFailures;
  }

  recordToolStart(name: string, args: unknown): number {
    const index = ++this.toolCallIndex;
    this.log('tool_start', { index, name, args });
    return index;
  }

  recordToolSuccess(index: number, name: string, args: unknown, durationMs: number) {
    // Success clears the failure fingerprint for this call shape.
    this.failureCounts.delete(this.fingerprint(name, args));
    const record: AgentToolCallRecord = {
      index,
      name,
      args,
      ok: true,
      durationMs,
      at: new Date().toISOString(),
    };
    this.toolCalls.push(record);
    this.log('tool_success', { index, name, durationMs });
  }

  recordToolFailure(
    index: number,
    name: string,
    args: unknown,
    error: string,
    durationMs: number,
  ) {
    const key = this.fingerprint(name, args);
    this.failureCounts.set(key, (this.failureCounts.get(key) ?? 0) + 1);
    const record: AgentToolCallRecord = {
      index,
      name,
      args,
      ok: false,
      error,
      durationMs,
      at: new Date().toISOString(),
    };
    this.toolCalls.push(record);
    this.errors.push(`${name}: ${error}`);
    this.log('tool_error', {
      index,
      name,
      error,
      durationMs,
      identicalFailures: this.failureCounts.get(key),
    });
  }

  complete(revision?: number) {
    this.status = 'completed';
    this.completedAt = new Date().toISOString();
    this.resultingRevision = revision;
    this.log('operation_complete', {
      revision,
      toolCalls: this.toolCalls.length,
      errors: this.errors.length,
    });
  }

  fail(message: string) {
    this.status = 'failed';
    this.completedAt = new Date().toISOString();
    this.errors.push(message);
    this.log('operation_failed', { message, toolCalls: this.toolCalls.length });
  }

  summaryReason(): string {
    const names = this.toolCalls.filter((t) => t.ok).map((t) => t.name);
    const unique = [...new Set(names)];
    const tools = unique.slice(0, 6).join(', ') || 'no tools';
    return `[${this.id}] Agent operation (${this.toolCalls.length} calls: ${tools})`;
  }

  /** Structured server-side log — not shown in user chat. */
  log(event: string, payload: Record<string, unknown>) {
    console.info(
      JSON.stringify({
        scope: 'atelier-agent',
        operationId: this.id,
        projectId: this.projectId,
        event,
        ...payload,
        ts: new Date().toISOString(),
      }),
    );
  }
}
