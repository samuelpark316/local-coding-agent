import { Command } from 'commander';
import { createActionHandler } from '../lib/commandHelpers.js';
import { type ChatOptions, runInteractiveSession } from '../lib/interactiveSession.js';
import type { CliRuntime } from '../lib/runtime.js';

export function createChatCommand(runtime: CliRuntime): Command {
  return new Command('chat')
    .description('Start a persistent interactive coding session')
    .option('--plain', 'Disable ANSI colors')
    .option('--stream', 'Stream model output while buffering actions safely')
    .option('--auto-approve', 'Skip confirmations for policy-allowed operations')
    .option('--max-steps <number>', 'Maximum model/tool steps per request', '40')
    .action(
      createActionHandler<ChatOptions & { maxSteps?: string; json?: boolean }>(
        runtime,
        async (options) => {
          const maxSteps = Number.parseInt(options.maxSteps ?? '40', 10);
          return runInteractiveSession(runtime, {
            ...options,
            maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : 40,
          });
        }
      )
    );
}
