import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentAction, LoopStopReason } from '../actions/AgentAction.js';
import { AgentActionParseError } from '../actions/AgentAction.js';
import { parseAgentActionWithDiagnostics } from '../actions/parseAgentAction.js';
import type { Context } from '../context/gather.js';
import { extractExplicitPaths, gatherContext } from '../context/gather.js';
import type { LLM, LLMOptions } from '../model/LLM.js';
import type { Policy } from '../policy/Policy.js';
import {
  buildAgentActionSchema,
  buildToolLoopPrompt,
  getToolLoopSystemPrompt,
} from '../prompts/toolLoop.js';
import type {
  ApprovalOutcome,
  ApprovalRequest,
  ToolDescription,
  ToolDispatcher,
} from '../tools/ToolDispatcher.js';
import { ConversationState } from './ConversationState.js';
import type { EditTransaction, TransactionStore } from './TransactionStore.js';

export interface ToolLoopOptions {
  maxSteps?: number;
  maxContextChars?: number;
  maxParseRetries?: number;
  maxAlternativeStrategyNudges?: number;
  llmOptions?: LLMOptions;
  approval?: (request: ApprovalRequest) => Promise<ApprovalOutcome>;
  autoApprove?: boolean;
  transactionStore?: TransactionStore;
  transaction?: EditTransaction;
  stream?: boolean;
  onToken?: (token: string) => void;
  conversationState?: ConversationState;
}

export interface ToolLoopInput {
  task: string;
  repoRoot: string;
  policy: Policy;
  requestId?: string;
  continuation?: boolean;
  clarification?: string;
}

export interface ToolLoopResult {
  requestId: string;
  stopReason: LoopStopReason;
  summary: string;
  question?: string;
  steps: number;
  changedFiles: string[];
  inspectedFiles: string[];
  verification: string[];
  transaction?: EditTransaction;
}

export interface ToolLoopRunnerOptions {
  llm: LLM;
  dispatcher: ToolDispatcher;
  contextGatherer?: (query: string, repoRoot: string) => Promise<Context>;
  onEvent?: (type: string, data: Record<string, unknown>) => Promise<void> | void;
}

function serializeContext(context: Context): string {
  return (
    [
      context.repositoryFiles?.length
        ? `Repository files:\n${context.repositoryFiles.join('\n')}`
        : '',
      context.searchTerms?.length ? `Search terms: ${context.searchTerms.join(', ')}` : '',
      ...context.searchResults.map((result) => `${result.path}: ${result.matches.join(' | ')}`),
      ...context.files.map((file) => `### ${file.path}\n${file.content}`),
    ]
      .filter(Boolean)
      .join('\n\n') || 'No initial context found.'
  );
}

function signature(action: AgentAction): string {
  return action.type === 'tool_call'
    ? `${action.tool}:${JSON.stringify(action.args)}`
    : action.type;
}

function mutationRequest(task: string): boolean {
  return /\b(add|create|delete|edit|fix|implement|modify|remove|replace|update|write)\b/iu.test(
    task
  );
}

function mutationTool(tool: string): boolean {
  return ['create_file', 'delete_file', 'edit_file', 'replace_file'].includes(tool);
}

function explicitCreateRequest(task: string): boolean {
  return /\bcreate\b/iu.test(task) && extractExplicitPaths(task).length > 0;
}

function deletionRequest(task: string): boolean {
  return /\b(delete|remove)\b/iu.test(task);
}

async function existingFiles(repoRoot: string, targets: string[]): Promise<Set<string>> {
  const existing = await Promise.all(
    targets.map(async (target) => {
      try {
        return (await stat(path.join(repoRoot, target))).isFile() ? target : undefined;
      } catch {
        return undefined;
      }
    })
  );
  return new Set(existing.filter((target): target is string => target !== undefined));
}

function repairInstruction(raw: string, error: string, tool?: ToolDescription): string {
  const boundedRaw = raw.length <= 12_000 ? raw : `${raw.slice(0, 12_000)}\n... [truncated]`;
  return [
    'Your previous action was invalid and was not executed.',
    `Invalid response: ${boundedRaw}`,
    `Validation error: ${error}`,
    'Canonical envelope: {"type":"tool_call","summary":"short action","tool":"known_tool","args":{}}',
    tool ? `Exact ${tool.name} argument schema: ${JSON.stringify(tool.argumentSchema)}` : '',
    tool
      ? `Corrected example: ${JSON.stringify({ type: 'tool_call', summary: `Use ${tool.name}`, tool: tool.name, args: tool.example })}`
      : '',
    'Return exactly one corrected JSON action.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function validateCompletion(
  action: Extract<AgentAction, { type: 'complete' }>,
  task: string,
  repoRoot: string,
  changedFiles: Set<string>,
  inspectedFiles: Set<string>,
  createdFiles: Set<string>,
  verification: string[]
): Promise<string | null> {
  const explicitPaths = extractExplicitPaths(task);
  const existing = await existingFiles(repoRoot, explicitPaths);

  if (explicitCreateRequest(task)) {
    const absent = explicitPaths.filter((target) => !existing.has(target));
    if (absent.length > 0)
      return `The request explicitly requires creating ${absent.join(', ')}, but the target does not exist.`;
    const notCreated = explicitPaths.filter((target) => !createdFiles.has(target));
    if (notCreated.length > 0)
      return `The request explicitly requires creating ${notCreated.join(', ')}, but it was not created during this request.`;
  }

  if (mutationRequest(task) && changedFiles.size === 0) {
    const absent = deletionRequest(task)
      ? []
      : explicitPaths.filter((target) => !existing.has(target));
    if (absent.length > 0)
      return `The request explicitly targets ${absent.join(', ')}, but the target does not exist.`;

    const uninspected =
      explicitPaths.length > 0
        ? explicitPaths.filter((target) => !inspectedFiles.has(target))
        : inspectedFiles.size === 0
          ? ['a relevant repository file']
          : [];
    if (uninspected.length > 0)
      return `This mutation request made no changes and lacks a successful inspection of ${uninspected.join(', ')}. Inspect the relevant file before claiming no changes are needed.`;
    if (!action.noChangeReason)
      return 'This mutation request made no changes. Provide a concrete noChangeReason supported by the inspected file contents, or make the requested edit.';
  }

  const missing = explicitPaths.filter((target) => !changedFiles.has(target));
  if (
    mutationRequest(task) &&
    explicitPaths.length > 0 &&
    changedFiles.size > 0 &&
    missing.length > 0
  )
    return `The request explicitly targets ${missing.join(', ')}, but those paths were not changed.`;
  if (/\b(empty|zero[- ]byte)\b/iu.test(task)) {
    for (const target of explicitPaths) {
      try {
        if ((await readFile(path.join(repoRoot, target))).byteLength !== 0)
          return `${target} was requested to be empty but is not empty.`;
      } catch {
        return `${target} was requested but does not exist.`;
      }
    }
  }
  if (
    /\b(verified|tests? pass(?:ed|ing)?|checks? pass(?:ed|ing)?)\b/iu.test(action.summary) &&
    verification.length === 0
  )
    return 'Completion claims verification, but no successful command result is recorded.';
  return null;
}

export class ToolLoopRunner {
  private readonly llm: LLM;
  private readonly dispatcher: ToolDispatcher;
  private readonly gather: (query: string, repoRoot: string) => Promise<Context>;
  private readonly onEvent?: (type: string, data: Record<string, unknown>) => Promise<void> | void;

  constructor(options: ToolLoopRunnerOptions) {
    this.llm = options.llm;
    this.dispatcher = options.dispatcher;
    this.gather = options.contextGatherer ?? gatherContext;
    this.onEvent = options.onEvent;
  }

  async run(input: ToolLoopInput, options: ToolLoopOptions = {}): Promise<ToolLoopResult> {
    const maxSteps = options.maxSteps ?? 40;
    const maxContextChars = options.maxContextChars ?? 64_000;
    const maxRepairs = options.maxParseRetries ?? 2;
    const requestId = input.requestId ?? `request-${Date.now()}`;
    const state = options.conversationState ?? new ConversationState();
    const request = input.continuation
      ? (state.resumeRequest(requestId, input.clarification ?? input.task) ??
        state.beginRequest(requestId, input.task))
      : state.beginRequest(requestId, input.task);
    const gatheredContext = await this.gather(request.task, input.repoRoot);
    for (const file of gatheredContext.files)
      if (!request.inspectedFiles.includes(file.path)) request.inspectedFiles.push(file.path);
    const initial = serializeContext(gatheredContext);
    const transcript: string[] = [];
    const changedFiles = new Set(request.changedFiles);
    const inspectedFiles = new Set([
      ...request.inspectedFiles,
      ...gatheredContext.files.map((file) => file.path),
    ]);
    const createdFiles = new Set(request.createdFiles);
    const verification = [...request.verification];
    const signatures: string[] = [];
    const errors: string[] = [];
    const alternativeNudges = new Set<string>();
    let transaction = options.transaction;

    await this.onEvent?.('request_started', {
      requestId,
      task: request.task,
      continuation: input.continuation === true,
    });
    const stop = async (
      stopReason: LoopStopReason,
      summary: string,
      steps: number,
      question?: string
    ): Promise<ToolLoopResult> => {
      if (
        transaction &&
        transaction.edits.length > 0 &&
        options.transactionStore &&
        stopReason !== 'input_required'
      )
        transaction = await options.transactionStore.finish(
          transaction,
          stopReason === 'completed' ? 'completed' : 'incomplete'
        );
      state.finish(summary, stopReason);
      await this.onEvent?.(stopReason === 'completed' ? 'request_completed' : 'request_stopped', {
        requestId,
        stopReason,
        summary,
        steps,
      });
      await this.onEvent?.('loop_stopped', { requestId, stopReason, steps });
      return {
        requestId,
        stopReason,
        summary,
        question,
        steps,
        changedFiles: [...changedFiles],
        inspectedFiles: [...inspectedFiles],
        verification,
        transaction,
      };
    };

    for (let step = 1; step <= maxSteps; step += 1) {
      const hardState = [
        `Current task: ${request.task}`,
        `Changed files: ${[...changedFiles].join(', ') || 'none'}`,
        `Created files: ${[...createdFiles].join(', ') || 'none'}`,
        `Inspected files: ${[...inspectedFiles].join(', ') || 'none'}`,
        `Unresolved errors: ${errors.slice(-3).join(' | ') || 'none'}`,
        `Verification: ${verification.join(' | ') || 'none'}`,
        `Bounded session context:\n${state.toPromptContext()}`,
      ].join('\n');
      let transcriptText = transcript.join('\n\n');
      while (
        transcript.length > 4 &&
        initial.length + transcriptText.length + hardState.length > maxContextChars
      ) {
        transcript.splice(0, 2);
        transcriptText = `[Earlier tool turns compacted; hard state retained]\n\n${transcript.join('\n\n')}`;
        await this.onEvent?.('context_compacted', {
          requestId,
          remainingMessages: transcript.length,
        });
      }
      if (initial.length + transcriptText.length + hardState.length > maxContextChars)
        return stop(
          'context_limit',
          'Required hard context exceeds the configured limit.',
          step - 1
        );

      await this.onEvent?.('model_started', { requestId, step });
      let action: AgentAction | undefined;
      let invalidRaw = '';
      let validationError = '';
      let selectedTool: ToolDescription | undefined;
      for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
        if (attempt > 0)
          await this.onEvent?.('repair_started', {
            requestId,
            step,
            attempt,
            error: validationError,
          });
        const prompt =
          buildToolLoopPrompt(request.task, initial, transcriptText, hardState) +
          (attempt > 0
            ? `\n\n${repairInstruction(invalidRaw, validationError, selectedTool)}`
            : '');
        const llmOptions: LLMOptions = {
          ...options.llmOptions,
          temperature: options.llmOptions?.temperature ?? 0,
          systemPrompt: getToolLoopSystemPrompt(this.dispatcher.describeTools()),
          structuredOutput: {
            schema: buildAgentActionSchema(this.dispatcher.describeTools()),
            fallbackToPrompt: true,
          },
        };
        let content: string;
        try {
          if (options.stream && this.llm.stream) {
            const chunks: string[] = [];
            for await (const chunk of this.llm.stream(prompt, llmOptions)) {
              chunks.push(chunk);
              options.onToken?.(chunk);
            }
            content = chunks.join('');
          } else content = (await this.llm.complete(prompt, llmOptions)).content;
        } catch (error) {
          return stop(
            'model_error',
            error instanceof Error ? error.message : 'Model request failed.',
            step
          );
        }
        invalidRaw = content;
        try {
          const parsed = parseAgentActionWithDiagnostics(content, {
            knownTools: this.dispatcher.registeredToolNames(),
          });
          action = parsed.action;
          if (parsed.diagnostics.normalizationActions.length > 0)
            await this.onEvent?.('action_normalized', {
              requestId,
              step,
              actions: parsed.diagnostics.normalizationActions,
              normalizedOutput: parsed.diagnostics.normalizedOutput?.slice(0, 12_000),
            });
          if (action.type === 'tool_call') {
            const validation = this.dispatcher.validateCall(action.tool, action.args);
            if (!validation.valid) {
              selectedTool = validation.tool;
              throw new Error(validation.error ?? 'Invalid tool arguments.');
            }
          }
          if (attempt > 0) await this.onEvent?.('repair_succeeded', { requestId, step, attempt });
          break;
        } catch (error) {
          action = undefined;
          validationError = error instanceof Error ? error.message : 'Invalid model action.';
          state.recordError(validationError);
          if (error instanceof AgentActionParseError) {
            const candidate = /(?:"tool"|"type")\s*:\s*"([A-Za-z0-9_]+)"/u.exec(content)?.[1];
            selectedTool = this.dispatcher.describeTools().find((tool) => tool.name === candidate);
          }
          if (attempt === maxRepairs)
            await this.onEvent?.('repair_failed', {
              requestId,
              step,
              attempts: maxRepairs,
              error: validationError,
            });
        }
      }
      if (!action) return stop('parse_retry_exhausted', validationError, step);
      state.recordAction(action);
      await this.onEvent?.('model_output', {
        requestId,
        step,
        actionType: action.type,
        summary: action.type === 'request_input' ? action.question : action.summary,
      });

      if (action.type === 'complete') {
        const completionError = await validateCompletion(
          action,
          request.task,
          input.repoRoot,
          changedFiles,
          inspectedFiles,
          createdFiles,
          verification
        );
        if (completionError) {
          errors.push(completionError);
          state.recordError(completionError);
          transcript.push(
            `Assistant action: ${JSON.stringify(action)}`,
            `Runtime completion validation: ${completionError}`
          );
          continue;
        }
        return stop('completed', action.summary, step);
      }
      if (action.type === 'request_input') {
        const unnecessary =
          extractExplicitPaths(request.task).length > 0 &&
          /\b(file|path|which file|what file)\b/iu.test(action.question);
        if (unnecessary) {
          transcript.push(
            `Assistant action: ${JSON.stringify(action)}`,
            'Runtime guidance: the task already names the target path; continue without asking the user.'
          );
          continue;
        }
        return stop('input_required', action.context ?? action.question, step, action.question);
      }

      const explicitPaths = extractExplicitPaths(request.task);
      const actionPath = typeof action.args.path === 'string' ? action.args.path : undefined;
      if (
        mutationTool(action.tool) &&
        actionPath &&
        explicitPaths.length > 0 &&
        !explicitPaths.includes(actionPath)
      ) {
        const error = `Path deviation blocked: the request explicitly names ${explicitPaths.join(', ')}, not ${actionPath}.`;
        errors.push(error);
        state.recordError(error);
        transcript.push(
          `Assistant action: ${JSON.stringify(action)}`,
          `Tool result: ${JSON.stringify({ success: false, code: 'path_deviation', error })}`
        );
        continue;
      }

      const currentSignature = signature(action);
      signatures.push(currentSignature);
      if (
        signatures.length >= 3 &&
        signatures.slice(-3).every((item) => item === currentSignature)
      ) {
        if (
          (options.maxAlternativeStrategyNudges ?? 1) > 0 &&
          !alternativeNudges.has(currentSignature)
        ) {
          alternativeNudges.add(currentSignature);
          transcript.push(
            'Runtime guidance: this exact strategy has repeated. Choose one different tool or argument strategy; do not repeat it again.'
          );
          continue;
        }
        return stop(
          'loop_detected',
          `Repeated action detected after alternative-strategy guidance: ${action.tool}.`,
          step
        );
      }

      const result = await this.dispatcher.dispatch(action.tool, action.args, {
        repoRoot: input.repoRoot,
        policy: input.policy,
        approval: options.approval,
        autoApprove: options.autoApprove,
        transactionStore: options.transactionStore,
        transaction,
        requestId,
        onEvent: async (type, data) => {
          if (type === 'approval_resolved')
            state.recordApproval(`${String(data.tool)}: ${String(data.decision)}`);
          await this.onEvent?.(type, data);
        },
      });
      if (result.transaction) transaction = result.transaction;
      for (const file of result.changedFiles ?? []) changedFiles.add(file);
      if (result.success && action.tool === 'create_file')
        for (const file of result.changedFiles ?? []) createdFiles.add(file);
      if (action.tool === 'read_file' && typeof action.args.path === 'string' && result.success)
        inspectedFiles.add(action.args.path);
      if (result.verification) verification.push(result.verification);
      state.recordToolResult(action.tool, result, action.args);
      const serialized = JSON.stringify({
        success: result.success,
        data: result.data,
        error: result.error,
        code: result.code,
      });
      transcript.push(
        `Assistant action: ${JSON.stringify(action)}`,
        `Tool result: ${serialized.slice(0, 16_000)}`
      );
      if (!result.success) {
        const error = result.error ?? 'Unknown tool error.';
        errors.push(error);
        if (result.code === 'user_aborted') return stop('user_aborted', error, step);
        if (errors.length >= 2 && errors.at(-1) === errors.at(-2)) {
          const errorKey = `${action.tool}:${error}`;
          if ((options.maxAlternativeStrategyNudges ?? 1) > 0 && !alternativeNudges.has(errorKey)) {
            alternativeNudges.add(errorKey);
            transcript.push(
              `Runtime guidance: ${action.tool} failed twice the same way. Use a different safe strategy or inspect the file again. Available whole-file fallback: replace_file.`
            );
          } else
            return stop(
              'loop_detected',
              `Repeated error after alternative-strategy guidance: ${error}`,
              step
            );
        }
      }
    }
    return stop('max_steps', `Stopped after ${maxSteps} steps.`, maxSteps);
  }
}
