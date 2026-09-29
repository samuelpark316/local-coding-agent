/**
 * EventBus - Emit plan/patch/tool/command events
 *
 * Event-driven architecture for decoupling engine from UI.
 * Events: plan, tool_call, tool_result, patch_proposed, patch_applied,
 *         command_started, command_output, done, error
 */

export type EventType =
  | 'request_started'
  | 'model_started'
  | 'model_output'
  | 'action_normalized'
  | 'repair_started'
  | 'repair_succeeded'
  | 'repair_failed'
  | 'loop_stopped'
  | 'policy_decision'
  | 'approval_requested'
  | 'approval_resolved'
  | 'context_compacted'
  | 'request_completed'
  | 'request_stopped'
  | 'plan'
  | 'tool_call'
  | 'tool_result'
  | 'patch_proposed'
  | 'patch_applied'
  | 'command_started'
  | 'command_output'
  | 'done'
  | 'error';

export interface PlanEventData {
  summary: string;
  steps?: string[];
}

export interface ToolCallEventData {
  tool: string;
  input?: unknown;
}

export interface ToolResultEventData {
  tool: string;
  success: boolean;
  output?: unknown;
  error?: string;
}

export interface PatchProposedEventData {
  patchPath: string;
  fileCount?: number;
  byteLength?: number;
}

export interface PatchAppliedEventData {
  patchPath: string;
  filesChanged: string[];
  dryRun?: boolean;
}

export interface CommandStartedEventData {
  command: string;
  argv?: string[];
  cwd?: string;
}

export interface CommandOutputEventData {
  stream: 'stdout' | 'stderr' | 'system';
  message: string;
}

export interface DoneEventData {
  message: string;
  exitCode?: number;
}

export interface ErrorEventData {
  message: string;
  exitCode?: number;
  details?: unknown;
}

export interface RuntimeLifecycleEventData {
  requestId?: string;
  task?: string;
  step?: number;
  actionType?: string;
  summary?: string;
  stopReason?: string;
  steps?: number;
  remainingMessages?: number;
  tool?: string;
  allowed?: boolean;
  reasons?: string[];
  risk?: string;
  decision?: string;
  attempt?: number;
  attempts?: number;
  error?: string;
  actions?: string[];
  normalizedOutput?: string;
  continuation?: boolean;
}

export interface EventDataMap {
  request_started: RuntimeLifecycleEventData;
  model_started: RuntimeLifecycleEventData;
  model_output: RuntimeLifecycleEventData;
  action_normalized: RuntimeLifecycleEventData;
  repair_started: RuntimeLifecycleEventData;
  repair_succeeded: RuntimeLifecycleEventData;
  repair_failed: RuntimeLifecycleEventData;
  loop_stopped: RuntimeLifecycleEventData;
  policy_decision: RuntimeLifecycleEventData;
  approval_requested: RuntimeLifecycleEventData;
  approval_resolved: RuntimeLifecycleEventData;
  context_compacted: RuntimeLifecycleEventData;
  request_completed: RuntimeLifecycleEventData;
  request_stopped: RuntimeLifecycleEventData;
  plan: PlanEventData;
  tool_call: ToolCallEventData;
  tool_result: ToolResultEventData;
  patch_proposed: PatchProposedEventData;
  patch_applied: PatchAppliedEventData;
  command_started: CommandStartedEventData;
  command_output: CommandOutputEventData;
  done: DoneEventData;
  error: ErrorEventData;
}

export interface AgentEvent<TType extends EventType = EventType> {
  type: TType;
  timestamp: number;
  sequence: number;
  data: EventDataMap[TType];
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === 'string' &&
    typeof candidate.timestamp === 'number' &&
    Number.isFinite(candidate.timestamp) &&
    typeof candidate.sequence === 'number' &&
    Number.isInteger(candidate.sequence) &&
    candidate.sequence >= 1 &&
    typeof candidate.data === 'object' &&
    candidate.data !== null
  );
}

export class EventBus {
  private listeners: Map<EventType, Array<(event: AgentEvent) => void>> = new Map();
  private sequence = 0;

  on(type: EventType, handler: (event: AgentEvent) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)?.push(handler);
  }

  emit<TType extends EventType>(type: TType, data: EventDataMap[TType]): AgentEvent<TType> {
    const event: AgentEvent<TType> = {
      type,
      timestamp: Date.now(),
      sequence: ++this.sequence,
      data,
    };
    const handlers = this.listeners.get(type) || [];
    handlers.forEach((handler) => {
      handler(event);
    });

    return event;
  }

  off(type: EventType, handler: (event: AgentEvent) => void): void {
    const handlers = this.listeners.get(type);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }
}
