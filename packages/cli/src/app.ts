import { Command } from 'commander';
import { createApplyCommand } from './commands/apply.js';
import { createAskCommand } from './commands/ask.js';
import { createChatCommand } from './commands/chat.js';
import { createDoctorCommand } from './commands/doctor.js';
import { createInitCommand } from './commands/init.js';
import { createReplayCommand } from './commands/replay.js';
import { createStatusCommand } from './commands/status.js';
import { createTestCommand } from './commands/test.js';
import { createUndoCommand } from './commands/undo.js';
import { type CliRuntime, createRuntime } from './lib/runtime.js';

export function createProgram(runtime: CliRuntime = createRuntime()): Command {
  const program = new Command();

  program.name('agent').description('Local coding agent - CLI-first assistant').version('0.1.0');

  program.addCommand(createInitCommand(runtime));
  program.addCommand(createAskCommand(runtime));
  program.addCommand(createChatCommand(runtime));
  program.addCommand(createApplyCommand(runtime));
  program.addCommand(createTestCommand(runtime));
  program.addCommand(createUndoCommand(runtime));
  program.addCommand(createStatusCommand(runtime));
  program.addCommand(createReplayCommand(runtime));
  program.addCommand(createDoctorCommand(runtime));

  return program;
}
