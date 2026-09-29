import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isMainEntrypoint } from '../../src/main';

describe('CLI entry-point detection', () => {
  it('recognizes an installed binary symlink as the module entry point', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-entrypoint-'));
    const modulePath = path.join(directory, 'main.js');
    const binaryPath = path.join(directory, 'agent');
    await writeFile(modulePath, '', 'utf8');
    await symlink(modulePath, binaryPath);
    expect(isMainEntrypoint(binaryPath, pathToFileURL(modulePath).href)).toBe(true);
  });
});
