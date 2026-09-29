#!/usr/bin/env node

/**
 * @local-agent/cli
 *
 * CLI entrypoint for the local coding agent.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgram } from './app.js';

export { createProgram } from './app.js';

export function isMainEntrypoint(argvPath: string | undefined, moduleUrl: string): boolean {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync.native(argvPath) === realpathSync.native(modulePath);
  } catch {
    return path.resolve(argvPath) === path.resolve(modulePath);
  }
}

const isEntrypoint = isMainEntrypoint(process.argv[1], import.meta.url);

if (isEntrypoint) {
  const program = createProgram();
  await program.parseAsync(process.argv);
}
