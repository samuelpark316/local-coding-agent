import type { AgentAction } from '../actions/AgentAction.js';
import type { ToolExecutionResult } from '../tools/ToolDispatcher.js';

export interface ConversationRequest {
  id: string;
  task: string;
  clarifications: string[];
  actions: AgentAction[];
  toolResults: Array<{ tool: string; result: ToolExecutionResult }>;
  inspectedFiles: string[];
  changedFiles: string[];
  createdFiles: string[];
  errors: string[];
  approvals: string[];
  verification: string[];
  summary?: string;
  stopReason?: string;
}

export interface ConversationStateOptions {
  maxRequests?: number;
  maxActionsPerRequest?: number;
  maxResultChars?: number;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export class ConversationState {
  private readonly maxRequests: number;
  private readonly maxActions: number;
  private readonly maxResultChars: number;
  private requests: ConversationRequest[] = [];
  private active?: ConversationRequest;
  private changedLedger = new Set<string>();

  constructor(options: ConversationStateOptions = {}) {
    this.maxRequests = options.maxRequests ?? 8;
    this.maxActions = options.maxActionsPerRequest ?? 24;
    this.maxResultChars = options.maxResultChars ?? 4_000;
  }

  beginRequest(id: string, task: string): ConversationRequest {
    const request: ConversationRequest = {
      id,
      task,
      clarifications: [],
      actions: [],
      toolResults: [],
      inspectedFiles: [],
      changedFiles: [],
      createdFiles: [],
      errors: [],
      approvals: [],
      verification: [],
    };
    this.requests.push(request);
    if (this.requests.length > this.maxRequests) this.requests.shift();
    this.active = request;
    return request;
  }

  resumeRequest(id: string, clarification: string): ConversationRequest | undefined {
    const request = this.requests.find((candidate) => candidate.id === id);
    if (!request) return undefined;
    request.clarifications.push(clarification);
    this.active = request;
    return request;
  }

  recordAction(action: AgentAction): void {
    if (!this.active) return;
    this.active.actions.push(action);
    if (this.active.actions.length > this.maxActions) this.active.actions.shift();
  }

  recordToolResult(tool: string, result: ToolExecutionResult, args: Record<string, unknown>): void {
    if (!this.active) return;
    const serializedData = result.data === undefined ? undefined : JSON.stringify(result.data);
    const boundedResult: ToolExecutionResult = {
      ...result,
      data:
        serializedData === undefined || serializedData.length <= this.maxResultChars
          ? result.data
          : { truncated: true, preview: serializedData.slice(0, this.maxResultChars) },
    };
    this.active.toolResults.push({ tool, result: boundedResult });
    if (this.active.toolResults.length > this.maxActions) this.active.toolResults.shift();
    if (result.success && tool === 'read_file' && typeof args.path === 'string') {
      this.active.inspectedFiles = unique([...this.active.inspectedFiles, args.path]);
    }
    for (const file of result.changedFiles ?? []) {
      this.changedLedger.add(file);
      this.active.changedFiles = unique([...this.active.changedFiles, file]);
      if (result.success && tool === 'create_file')
        this.active.createdFiles = unique([...this.active.createdFiles, file]);
    }
    if (result.error) this.active.errors.push(result.error);
    if (result.verification) this.active.verification.push(result.verification);
  }

  recordApproval(summary: string): void {
    if (this.active) this.active.approvals.push(summary);
  }

  recordError(error: string): void {
    if (!this.active) return;
    this.active.errors.push(error);
    if (this.active.errors.length > this.maxActions) this.active.errors.shift();
  }

  finish(summary: string, stopReason: string): void {
    if (!this.active) return;
    this.active.summary = summary;
    this.active.stopReason = stopReason;
  }

  current(): ConversationRequest | undefined {
    return this.active;
  }

  changedFiles(): string[] {
    return [...this.changedLedger];
  }

  clearConversation(): void {
    this.requests = [];
    this.active = undefined;
  }

  toPromptContext(): string {
    const blocks = this.requests.map((request) =>
      [
        `Request ${request.id}: ${request.task}`,
        ...(request.clarifications.length
          ? [`Clarifications: ${request.clarifications.join(' | ')}`]
          : []),
        `Inspected: ${request.inspectedFiles.join(', ') || 'none'}`,
        `Changed: ${request.changedFiles.join(', ') || 'none'}`,
        `Created: ${request.createdFiles.join(', ') || 'none'}`,
        `Errors: ${request.errors.slice(-3).join(' | ') || 'none'}`,
        `Approvals: ${request.approvals.slice(-3).join(' | ') || 'none'}`,
        `Verification: ${request.verification.join(' | ') || 'none'}`,
        ...request.toolResults
          .slice(-3)
          .map(
            ({ tool, result }) =>
              `Recent ${tool} result: ${JSON.stringify({ success: result.success, data: result.data, error: result.error, code: result.code })}`
          ),
        `Outcome: ${request.stopReason ?? 'active'}${request.summary ? ` — ${request.summary}` : ''}`,
      ].join('\n')
    );
    const ledger = `Session changed-file ledger: ${this.changedFiles().join(', ') || 'none'}`;
    const kept: string[] = [];
    let size = ledger.length;
    for (const block of [...blocks].reverse()) {
      if (kept.length > 0 && size + block.length > 24_000) break;
      const boundedBlock =
        block.length <= 16_000
          ? block
          : `${block.slice(0, 16_000)}\n... [request details truncated]`;
      kept.unshift(boundedBlock);
      size += boundedBlock.length;
    }
    return [
      ...(kept.length < blocks.length ? ['[Older request details compacted]'] : []),
      ...kept,
      ledger,
    ].join('\n');
  }
}
