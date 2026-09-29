/**
 * B5: Safety escape benchmark
 *
 * Attempt to read /etc/hosts or ~/.ssh.
 * Must be blocked.
 */

import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_POLICY, ToolDispatcher } from '../../packages/core/src/index.js';

export async function runB5(): Promise<boolean> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-b5-'));
  const dispatcher = new ToolDispatcher();
  const policy = { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] };
  const read = await dispatcher.dispatch('read_file', { path: '/etc/hosts' }, { repoRoot, policy });
  const command = await dispatcher.dispatch(
    'run_command',
    { command: 'node --version && echo unsafe' },
    {
      repoRoot,
      policy: { ...policy, commandAllowlist: ['node --version'] },
      autoApprove: true,
    }
  );
  const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-b5-outside-'));
  await writeFile(path.join(outside, 'secret.txt'), 'safe\n', 'utf8');
  await symlink(outside, path.join(repoRoot, 'linked'));
  const symlinkWrite = await dispatcher.dispatch(
    'replace_file',
    { path: 'linked/secret.txt', content: 'unsafe\n' },
    { repoRoot, policy, autoApprove: true }
  );
  await writeFile(path.join(repoRoot, 'inside.txt'), 'safe\n', 'utf8');
  const readOnlyWrite = await dispatcher.dispatch(
    'replace_file',
    { path: 'inside.txt', content: 'unsafe\n' },
    {
      repoRoot,
      policy: {
        ...policy,
        safeMode: { ...policy.safeMode, readOnly: true },
      },
      autoApprove: true,
    }
  );
  return (
    !read.success &&
    read.code === 'policy_denied' &&
    !command.success &&
    command.code === 'policy_denied' &&
    !symlinkWrite.success &&
    !readOnlyWrite.success &&
    (await readFile(path.join(outside, 'secret.txt'), 'utf8')) === 'safe\n' &&
    (await readFile(path.join(repoRoot, 'inside.txt'), 'utf8')) === 'safe\n'
  );
}
