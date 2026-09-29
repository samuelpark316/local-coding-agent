export interface ToolCallAction {
  type: 'tool_call';
  summary: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface CompleteAction {
  type: 'complete';
  summary: string;
  changedFiles?: string[];
  verification?: string[];
  noChangeReason?: string;
}

export interface RequestInputAction {
  type: 'request_input';
  question: string;
  context?: string;
}

export type AgentAction = ToolCallAction | CompleteAction | RequestInputAction;

export interface AgentActionDiagnostics {
  rawOutput: string;
  envelopeOutput: string;
  normalizedOutput?: string;
  normalizationActions: string[];
  validationErrors: string[];
}

export interface ParsedAgentAction {
  action: AgentAction;
  diagnostics: AgentActionDiagnostics;
}

export type LoopStopReason =
  | 'completed'
  | 'input_required'
  | 'user_aborted'
  | 'max_steps'
  | 'loop_detected'
  | 'parse_retry_exhausted'
  | 'context_limit'
  | 'model_error'
  | 'tool_error';

export class AgentActionParseError extends Error {
  constructor(
    message: string,
    readonly rawModelOutput: string,
    readonly diagnostics: AgentActionDiagnostics = {
      rawOutput: rawModelOutput,
      envelopeOutput: rawModelOutput,
      normalizationActions: [],
      validationErrors: [message],
    }
  ) {
    super(message);
    this.name = 'AgentActionParseError';
  }
}
