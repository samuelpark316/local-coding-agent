import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../../src/policy/Policy';
import { TransactionStore } from '../../src/runtime/TransactionStore';
import { ToolDispatcher } from '../../src/tools/ToolDispatcher';

describe('interactive tools', () => {
  it('applies and reverts an approved exact edit transaction', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-tools-'));
    await writeFile(path.join(repoRoot, 'file.txt'), 'before\n', 'utf8');
    const store = new TransactionStore(path.join(repoRoot, '.agent', 'transactions'), repoRoot);
    const transaction = await store.begin('request-1');
    const dispatcher = new ToolDispatcher();
    const result = await dispatcher.dispatch(
      'edit_file',
      { path: 'file.txt', oldText: 'before', newText: 'after' },
      {
        repoRoot,
        policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] },
        transactionStore: store,
        transaction,
        approval: async () => ({ decision: 'approve' }),
      }
    );
    expect(result.success).toBe(true);
    expect(await readFile(path.join(repoRoot, 'file.txt'), 'utf8')).toBe('after\n');
    expect(result.transaction?.edits).toHaveLength(1);
    if (!result.transaction) throw new Error('Expected transaction.');
    await store.revert(result.transaction);
    expect(await readFile(path.join(repoRoot, 'file.txt'), 'utf8')).toBe('before\n');
  });

  it('does not mutate when approval is rejected', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-tools-'));
    await mkdir(path.join(repoRoot, '.agent'), { recursive: true });
    await writeFile(path.join(repoRoot, 'file.txt'), 'before\n', 'utf8');
    const result = await new ToolDispatcher().dispatch(
      'edit_file',
      { path: 'file.txt', oldText: 'before', newText: 'after' },
      {
        repoRoot,
        policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] },
        approval: async () => ({ decision: 'reject', feedback: 'Keep it.' }),
      }
    );
    expect(result).toMatchObject({ success: false, code: 'user_rejected' });
    expect(await readFile(path.join(repoRoot, 'file.txt'), 'utf8')).toBe('before\n');
  });

  it('does not let auto-approval bypass read-only policy', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-tools-'));
    await writeFile(path.join(repoRoot, 'file.txt'), 'before\n', 'utf8');
    const result = await new ToolDispatcher().dispatch(
      'edit_file',
      { path: 'file.txt', oldText: 'before', newText: 'after' },
      {
        repoRoot,
        policy: {
          ...DEFAULT_POLICY,
          allowedRepoRoots: [repoRoot],
          safeMode: { ...DEFAULT_POLICY.safeMode, readOnly: true },
        },
        autoApprove: true,
      }
    );
    expect(result).toMatchObject({ success: false, code: 'policy_denied' });
    expect(await readFile(path.join(repoRoot, 'file.txt'), 'utf8')).toBe('before\n');
  });

  it('reverts file creation and deletion as one transaction', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-tools-'));
    await writeFile(path.join(repoRoot, 'old.txt'), 'restore me\n', 'utf8');
    const store = new TransactionStore(path.join(repoRoot, '.agent', 'transactions'), repoRoot);
    let transaction = await store.begin('request-files');
    const dispatcher = new ToolDispatcher();
    const context = () => ({
      repoRoot,
      policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] },
      transactionStore: store,
      transaction,
      approval: async () => ({ decision: 'approve' as const }),
    });
    const created = await dispatcher.dispatch(
      'create_file',
      { path: 'new.txt', content: 'new file\n' },
      context()
    );
    if (!created.transaction) throw new Error('Expected create transaction.');
    transaction = created.transaction;
    const deleted = await dispatcher.dispatch('delete_file', { path: 'old.txt' }, context());
    if (!deleted.transaction) throw new Error('Expected delete transaction.');
    expect(await readFile(path.join(repoRoot, 'new.txt'), 'utf8')).toBe('new file\n');
    await expect(readFile(path.join(repoRoot, 'old.txt'), 'utf8')).rejects.toBeDefined();
    await store.revert(deleted.transaction);
    await expect(readFile(path.join(repoRoot, 'new.txt'), 'utf8')).rejects.toBeDefined();
    expect(await readFile(path.join(repoRoot, 'old.txt'), 'utf8')).toBe('restore me\n');
  });

  it('blocks reads outside the repository before reading content', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-tools-'));
    const result = await new ToolDispatcher().dispatch(
      'read_file',
      { path: '/etc/hosts' },
      { repoRoot, policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] } }
    );
    expect(result).toMatchObject({ success: false, code: 'policy_denied' });
  });

  it('creates an actually empty file and never overwrites with create_file', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-tools-'));
    const dispatcher = new ToolDispatcher();
    const context = {
      repoRoot,
      policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] },
      approval: async () => ({ decision: 'approve' as const }),
    };
    expect(
      await dispatcher.dispatch('create_file', { path: 'bubble.py', content: '' }, context)
    ).toMatchObject({ success: true, changedFiles: ['bubble.py'] });
    expect(await readFile(path.join(repoRoot, 'bubble.py'))).toHaveLength(0);
    expect(
      await dispatcher.dispatch('create_file', { path: 'bubble.py', content: 'overwrite' }, context)
    ).toMatchObject({ success: false, code: 'already_exists' });
    expect(await readFile(path.join(repoRoot, 'bubble.py'))).toHaveLength(0);
  });

  it('replaces a whole file through the patch pipeline with a stale hash precondition', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-tools-'));
    const original = 'old content\n';
    await writeFile(path.join(repoRoot, 'bubble.py'), original, 'utf8');
    const context = {
      repoRoot,
      policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] },
      approval: async () => ({ decision: 'approve' as const }),
    };
    const dispatcher = new ToolDispatcher();
    expect(
      await dispatcher.dispatch(
        'replace_file',
        { path: 'bubble.py', content: 'new content\n', expectedHash: '0'.repeat(64) },
        context
      )
    ).toMatchObject({ success: false, code: 'stale_content' });
    const result = await dispatcher.dispatch(
      'replace_file',
      {
        path: 'bubble.py',
        content: 'new content\n',
        expectedHash: createHash('sha256').update(original).digest('hex'),
      },
      context
    );
    expect(result).toMatchObject({ success: true, changedFiles: ['bubble.py'] });
    expect(await readFile(path.join(repoRoot, 'bubble.py'), 'utf8')).toBe('new content\n');
  });

  it('blocks mutation through a symlink that escapes the repository', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-tools-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-outside-'));
    await writeFile(path.join(outside, 'secret.txt'), 'secret\n', 'utf8');
    await symlink(outside, path.join(repoRoot, 'linked'));
    const result = await new ToolDispatcher().dispatch(
      'replace_file',
      { path: 'linked/secret.txt', content: 'changed\n' },
      {
        repoRoot,
        policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] },
        autoApprove: true,
      }
    );
    expect(result).toMatchObject({ success: false, code: 'policy_denied' });
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret\n');
  });
});
