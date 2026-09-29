import { createInterface } from 'node:readline/promises';
import {
  type ApprovalOutcome,
  type ApprovalRequest,
  ConversationState,
  type EditTransaction,
  type EventDataMap,
  type EventType,
  OllamaAdapter,
  ToolDispatcher,
  ToolLoopRunner,
  TransactionStore,
} from '@local-agent/core';
import { promptForApproval } from '../ui/approvalPrompt.js';
import { SessionView } from '../ui/sessionView.js';
import { getAgentPaths, getAgentStatus, resolveRepoRoot } from './agentFs.js';
import { CliCommandError } from './commandHelpers.js';
import { loadModelConfig } from './model.js';
import type { CommandResult } from './output.js';
import { loadAgentPolicy } from './policy.js';
import type { CliRuntime } from './runtime.js';

export interface ChatOptions {
  autoApprove?: boolean;
  maxSteps?: number;
  plain?: boolean;
  stream?: boolean;
}

export async function runInteractiveSession(
  runtime: CliRuntime,
  options: ChatOptions
): Promise<CommandResult> {
  if (!runtime.io.isInteractive) {
    throw new CliCommandError(
      '`agent chat` requires an interactive TTY. Use `agent ask --json` for automation.'
    );
  }
  const repoRoot = resolveRepoRoot(runtime.cwd);
  if (!repoRoot || !(await getAgentStatus(repoRoot)).initialized) {
    throw new CliCommandError('Agent is not initialized. Run `agent init` first.');
  }
  const modelConfig = await loadModelConfig(repoRoot);
  const policy = await loadAgentPolicy(repoRoot);
  const adapter = OllamaAdapter.fromModelConfig(modelConfig);
  if (!(await adapter.checkServer())) {
    throw new CliCommandError(
      `Ollama server is unavailable at ${modelConfig.baseUrl}. Start it with: ollama serve`
    );
  }

  const readline = createInterface({ input: runtime.io.input, output: runtime.io.output });
  const view = new SessionView(runtime.io.stdout, options.plain ?? false);
  const paths = getAgentPaths(repoRoot);
  const transactionStore = new TransactionStore(paths.transactionsDir, repoRoot);
  const dispatcher = new ToolDispatcher();
  const maxSteps = options.maxSteps ?? 40;
  let autoApprove = options.autoApprove ?? false;
  let lastChanged: string[] = [];
  const conversationState = new ConversationState();

  const onEvent = async (type: string, data: Record<string, unknown>): Promise<void> => {
    view.event(type, data, maxSteps);
    if (runtime.sessionStore && isEventType(type)) {
      await runtime.sessionStore.appendEvent(type, data as EventDataMap[typeof type]);
    }
  };
  const runner = new ToolLoopRunner({ llm: adapter, dispatcher, onEvent });
  const approve = async (request: ApprovalRequest): Promise<ApprovalOutcome> => {
    if (autoApprove) return { decision: 'approve' };
    const outcome = await promptForApproval(readline, request, runtime.io.stdout);
    if (outcome.decision === 'approve_session') autoApprove = true;
    return outcome;
  };

  view.startup(repoRoot, modelConfig.model, autoApprove);
  try {
    while (true) {
      let input = (await readline.question('You> ')).trim();
      if (!input) continue;
      if (input === '/exit' || input === '/quit') break;
      if (input === '/help') {
        runtime.io.stdout(
          'Enter a coding request, or use /multiline /status /changes /undo /model /policy /clear /exit.'
        );
        continue;
      }
      if (input === '/multiline') {
        runtime.io.stdout('Enter multiple lines, then type SUBMIT on its own line.');
        const lines: string[] = [];
        while (true) {
          const line = await readline.question('... ');
          if (line.trim().toUpperCase() === 'SUBMIT') break;
          lines.push(line);
        }
        input = lines.join('\n').trim();
        if (!input) continue;
      }
      if (input === '/status') {
        const latest = await transactionStore.latest();
        runtime.io.stdout(
          latest ? `Latest transaction: ${latest.id} (${latest.status})` : 'No edit transactions.'
        );
        continue;
      }
      if (input === '/changes') {
        runtime.io.stdout(
          lastChanged.length > 0 ? lastChanged.join('\n') : 'No files changed by the last request.'
        );
        continue;
      }
      if (input === '/model') {
        runtime.io.stdout(
          `${modelConfig.provider}: ${modelConfig.model} (${modelConfig.contextLimit} context)`
        );
        continue;
      }
      if (input === '/policy') {
        runtime.io.stdout(
          `Read-only: ${policy.safeMode.readOnly}; confirm edits: ${policy.safeMode.confirmApply}; confirm commands: ${policy.safeMode.confirmCommands}; allowlisted commands: ${policy.commandAllowlist.join(', ') || 'none'}`
        );
        continue;
      }
      if (input === '/undo') {
        const latest = await transactionStore.latest();
        if (!latest || latest.status === 'reverted')
          runtime.io.stdout('No transaction is available to undo.');
        else {
          await transactionStore.revert(latest);
          runtime.io.stdout(`Reverted transaction ${latest.id}.`);
          lastChanged = [];
        }
        continue;
      }
      if (input === '/clear') {
        lastChanged = [];
        conversationState.clearConversation();
        runtime.io.stdout('Session working summary cleared. Persistent logs were retained.');
        continue;
      }

      let task = input;
      let continuation = false;
      let requestId: string | undefined;
      let transaction: EditTransaction | undefined;
      while (true) {
        const result = await runner.run(
          {
            task,
            repoRoot,
            policy,
            requestId,
            continuation,
            clarification: continuation ? task : undefined,
          },
          {
            maxSteps,
            approval: approve,
            autoApprove,
            transactionStore,
            transaction,
            conversationState,
            stream: options.stream,
            onToken: options.stream
              ? (token) => {
                  runtime.io.output.write(token);
                }
              : undefined,
          }
        );
        if (options.stream) runtime.io.output.write('\n');
        view.result(result);
        lastChanged = result.changedFiles;
        if (result.stopReason !== 'input_required' || !result.question) break;
        const answer = (await readline.question(`${result.question}\nYou> `)).trim();
        if (!answer) break;
        requestId = result.requestId;
        transaction = result.transaction;
        continuation = true;
        task = answer;
      }
    }
  } finally {
    readline.close();
  }

  return { ok: true, message: 'Interactive session ended.', human: ['Interactive session ended.'] };
}

function isEventType(type: string): type is EventType {
  return [
    'request_started',
    'model_started',
    'model_output',
    'action_normalized',
    'repair_started',
    'repair_succeeded',
    'repair_failed',
    'loop_stopped',
    'policy_decision',
    'approval_requested',
    'approval_resolved',
    'context_compacted',
    'request_completed',
    'request_stopped',
    'tool_call',
    'tool_result',
    'patch_proposed',
    'patch_applied',
    'command_started',
    'command_output',
    'plan',
    'done',
    'error',
  ].includes(type);
}
