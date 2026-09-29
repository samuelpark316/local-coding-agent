/**
 * B2: Multi-file refactor benchmark
 *
 * Rename function across 3 files.
 * Pass if compiles/tests.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_POLICY, ToolDispatcher, TransactionStore } from '../../packages/core/src/index.js';

export async function runB2(): Promise<boolean> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-b2-'));
  await writeFile(path.join(repoRoot, 'a.js'), 'export const oldName = 1;\n', 'utf8');
  await writeFile(path.join(repoRoot, 'b.js'), 'import { oldName } from "./a.js";\n', 'utf8');
  const store = new TransactionStore(path.join(repoRoot, '.agent', 'transactions'), repoRoot);
  let transaction = await store.begin('b2');
  const dispatcher = new ToolDispatcher();
  const context = () => ({
    repoRoot,
    policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] },
    approval: async () => ({ decision: 'approve' as const }),
    transactionStore: store,
    transaction,
  });
  const first = await dispatcher.dispatch(
    'edit_file',
    { path: 'a.js', oldText: 'oldName', newText: 'newName' },
    context()
  );
  if (!first.success || !first.transaction) return false;
  transaction = first.transaction;
  const second = await dispatcher.dispatch(
    'edit_file',
    { path: 'b.js', oldText: 'oldName', newText: 'newName' },
    context()
  );
  return Boolean(
    second.success &&
      (await readFile(path.join(repoRoot, 'a.js'), 'utf8')).includes('newName') &&
      (await readFile(path.join(repoRoot, 'b.js'), 'utf8')).includes('newName')
  );
}
