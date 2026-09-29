import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TransactionStore } from '../../src/runtime/TransactionStore';

const forwardPatch = '--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n';
const reversePatch = '--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-after\n+before\n';

describe('TransactionStore prepared edit recovery', () => {
  it('skips an intent that was journaled but never applied', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-transaction-'));
    await writeFile(path.join(repoRoot, 'file.txt'), 'before\n', 'utf8');
    const store = new TransactionStore(path.join(repoRoot, '.agent', 'transactions'), repoRoot);
    let transaction = await store.begin('request-before');
    transaction = await store.prepareEdit(
      transaction,
      forwardPatch,
      reversePatch,
      'file.txt',
      'before\n',
      'after\n'
    );
    expect((await store.latest())?.edits[0].status).toBe('prepared');
    await store.revert(transaction);
    expect(await readFile(path.join(repoRoot, 'file.txt'), 'utf8')).toBe('before\n');
  });

  it('reverses an applied write even when the crash happened before the applied marker', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-transaction-'));
    await writeFile(path.join(repoRoot, 'file.txt'), 'before\n', 'utf8');
    const store = new TransactionStore(path.join(repoRoot, '.agent', 'transactions'), repoRoot);
    let transaction = await store.begin('request-after');
    transaction = await store.prepareEdit(
      transaction,
      forwardPatch,
      reversePatch,
      'file.txt',
      'before\n',
      'after\n'
    );
    await writeFile(path.join(repoRoot, 'file.txt'), 'after\n', 'utf8');
    await store.revert(transaction);
    expect(await readFile(path.join(repoRoot, 'file.txt'), 'utf8')).toBe('before\n');
  });

  it('rejects a tampered reverse patch that targets outside the repository', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-transaction-'));
    const repoRoot = path.join(parent, 'repo');
    await mkdir(repoRoot);
    const outsidePath = path.join(parent, 'outside.txt');
    await writeFile(outsidePath, 'safe\n', 'utf8');
    const store = new TransactionStore(path.join(repoRoot, '.agent', 'transactions'), repoRoot);
    const transaction = await store.begin('tampered');
    transaction.edits.push({
      patch: '',
      reversePatch: '--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1,1 +1,1 @@\n-safe\n+unsafe\n',
      filesChanged: ['../outside.txt'],
      status: 'applied',
    });
    await expect(store.revert(transaction)).rejects.toThrow('Unsafe transaction path');
    expect(await readFile(outsidePath, 'utf8')).toBe('safe\n');
  });
});
