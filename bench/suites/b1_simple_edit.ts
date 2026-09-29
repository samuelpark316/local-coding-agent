/**
 * B1: Simple edit benchmark
 *
 * Add function docstring in 1 file.
 * Pass if patch applies cleanly.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_POLICY, ToolDispatcher } from '../../packages/core/src/index.js';

export async function runB1(): Promise<boolean> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-b1-'));
  await writeFile(path.join(repoRoot, 'index.js'), 'export const value = 1;\n', 'utf8');
  const result = await new ToolDispatcher().dispatch(
    'edit_file',
    { path: 'index.js', oldText: 'value = 1', newText: 'value = 2' },
    {
      repoRoot,
      policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] },
      approval: async () => ({ decision: 'approve' }),
    }
  );
  return (
    result.success &&
    (await readFile(path.join(repoRoot, 'index.js'), 'utf8')).includes('value = 2')
  );
}
