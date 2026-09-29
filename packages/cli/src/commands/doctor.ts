/**
 * doctor command - Check system requirements
 *
 * agent doctor
 */

import { Command } from 'commander';
import { addJsonOption, createActionHandler } from '../lib/commandHelpers.js';
import type { CliRuntime } from '../lib/runtime.js';
import { handleDoctor } from './shared.js';

export function createDoctorCommand(runtime: CliRuntime): Command {
  return addJsonOption(
    new Command('doctor')
      .description('Check system requirements (git, ripgrep, ollama, etc.)')
      .option('--protocol', 'Ask the configured model for one harmless action and validate it')
      .action(
        createActionHandler<{ protocol?: boolean; json?: boolean }>(runtime, async (options) => {
          return handleDoctor(runtime.cwd, { protocol: options.protocol });
        })
      )
  );
}
