import { normalizeAgentOutputEnvelope } from '../prompts/formats.js';
import {
  type AgentAction,
  type AgentActionDiagnostics,
  AgentActionParseError,
  type CompleteAction,
  type ParsedAgentAction,
  type RequestInputAction,
  type ToolCallAction,
} from './AgentAction.js';

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalStrings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value;
}

function rejectUnknown(record: Record<string, unknown>, allowed: string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`Action includes unsupported keys: ${unknown.join(', ')}.`);
  }
}

export interface ParseAgentActionOptions {
  knownTools?: Iterable<string>;
}

function normalizeToolEnvelope(
  record: Record<string, unknown>,
  knownTools: Set<string>,
  actions: string[]
): Record<string, unknown> {
  const type = typeof record.type === 'string' ? record.type.trim() : undefined;
  const tool = typeof record.tool === 'string' ? record.tool.trim() : undefined;
  const directTool = type && knownTools.has(type) ? type : undefined;

  if (directTool) {
    rejectUnknown(record, ['type', 'summary', 'args']);
    actions.push(`direct_tool_type:${directTool}`);
    return {
      type: 'tool_call',
      summary:
        typeof record.summary === 'string' && record.summary.trim()
          ? record.summary.trim()
          : `Use ${directTool}`,
      tool: directTool,
      args: record.args,
    };
  }

  if (type === undefined && tool && knownTools.has(tool)) {
    rejectUnknown(record, ['tool', 'summary', 'args']);
    actions.push(`tool_only:${tool}`);
    return {
      type: 'tool_call',
      summary:
        typeof record.summary === 'string' && record.summary.trim()
          ? record.summary.trim()
          : `Use ${tool}`,
      tool,
      args: record.args,
    };
  }

  return record;
}

export function parseAgentActionWithDiagnostics(
  rawModelOutput: string,
  options: ParseAgentActionOptions = {}
): ParsedAgentAction {
  const diagnostics: AgentActionDiagnostics = {
    rawOutput: rawModelOutput,
    envelopeOutput: rawModelOutput,
    normalizationActions: [],
    validationErrors: [],
  };
  try {
    const normalized = normalizeAgentOutputEnvelope(rawModelOutput);
    diagnostics.envelopeOutput = normalized;
    if (normalized !== rawModelOutput.trim().replace(/^\uFEFF/u, '')) {
      diagnostics.normalizationActions.push('json_envelope_recovered');
    }
    const parsedRecord = requireRecord(JSON.parse(normalized) as unknown, 'Action');
    const record = normalizeToolEnvelope(
      parsedRecord,
      new Set(options.knownTools ?? []),
      diagnostics.normalizationActions
    );
    diagnostics.normalizedOutput = JSON.stringify(record);
    const type = requireString(record.type, 'type');

    if (type === 'tool_call') {
      rejectUnknown(record, ['type', 'summary', 'tool', 'args']);
      const action: ToolCallAction = {
        type,
        summary: requireString(record.summary, 'summary'),
        tool: requireString(record.tool, 'tool'),
        args: requireRecord(record.args, 'args'),
      };
      return { action, diagnostics };
    }

    if (type === 'complete') {
      rejectUnknown(record, ['type', 'summary', 'changedFiles', 'verification', 'noChangeReason']);
      const action: CompleteAction = {
        type,
        summary: requireString(record.summary, 'summary'),
        changedFiles: optionalStrings(record.changedFiles, 'changedFiles'),
        verification: optionalStrings(record.verification, 'verification'),
        noChangeReason:
          record.noChangeReason === undefined
            ? undefined
            : requireString(record.noChangeReason, 'noChangeReason'),
      };
      return { action, diagnostics };
    }

    if (type === 'request_input') {
      rejectUnknown(record, ['type', 'question', 'context']);
      const action: RequestInputAction = {
        type,
        question: requireString(record.question, 'question'),
        context:
          record.context === undefined ? undefined : requireString(record.context, 'context'),
      };
      return { action, diagnostics };
    }

    throw new Error(`Unsupported action type: ${type}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to parse model action.';
    diagnostics.validationErrors.push(message);
    throw new AgentActionParseError(message, rawModelOutput, diagnostics);
  }
}

export function parseAgentAction(
  rawModelOutput: string,
  options: ParseAgentActionOptions = {}
): AgentAction {
  return parseAgentActionWithDiagnostics(rawModelOutput, options).action;
}
