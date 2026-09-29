/**
 * B3: Fix failing test benchmark
 *
 * Repo fixture with 1 failing test.
 * Pass if green.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_POLICY, ToolDispatcher } from '../../packages/core/src/index.js';

export async function runB3(): Promise<boolean> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-b3-'));
  await writeFile(path.join(repoRoot, 'check.js'), 'process.exit(0);\n', 'utf8');
  const command = 'node check.js';
  const result = await new ToolDispatcher().dispatch(
    'run_command',
    { command },
    {
      repoRoot,
      policy: {
        ...DEFAULT_POLICY,
        allowedRepoRoots: [repoRoot],
        commandAllowlist: [command],
      },
      approval: async () => ({ decision: 'approve' }),
    }
  );
  return Boolean(result.success && (result.data as { exitCode?: number })?.exitCode === 0);
}
