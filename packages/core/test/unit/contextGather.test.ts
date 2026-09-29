import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractExplicitPaths, extractSearchTerms, gatherContext } from '../../src/context/gather';

describe('hybrid context gathering', () => {
  it('extracts explicit repository paths and useful identifiers', () => {
    const task = 'Implement bubble_sort in src/bubble.py and return a sorted copy.';
    expect(extractExplicitPaths(task)).toEqual(['src/bubble.py']);
    expect(extractExplicitPaths('Update README.md.')).toEqual(['README.md']);
    expect(extractSearchTerms(task)).toContain('bubble_sort');
    expect(extractSearchTerms(task).join(' ')).not.toContain(task);
  });

  it('reads an explicitly named path directly and seeds a tiny repository listing', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-context-'));
    await writeFile(path.join(repoRoot, 'bubble.py'), 'def bubble_sort():\n    pass\n', 'utf8');
    const context = await gatherContext('Update bubble.py without mutating input.', repoRoot);
    expect(context.files).toContainEqual({
      path: 'bubble.py',
      content: 'def bubble_sort():\n    pass\n',
    });
    expect(context.repositoryFiles).toEqual(['bubble.py']);
    expect(context.searchTerms).not.toContain('Update bubble.py without mutating input.');
  });

  it('does not treat path traversal as an explicit repository path', () => {
    expect(extractExplicitPaths('Read ../secret.txt')).toEqual([]);
  });
});
