/** Bounded, path-aware hybrid context gathering. */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export interface Context {
  files: Array<{ path: string; content: string }>;
  searchResults: Array<{ path: string; matches: string[] }>;
  repositoryFiles?: string[];
  searchTerms?: string[];
}

const MAX_SEARCH_FILES = 5;
const MAX_MATCHES_PER_FILE = 3;
const MAX_FILE_LINES = 200;
const MAX_FILE_CHARS = 8_000;
const MAX_LIST_FILES = 120;
const STOP_WORDS = new Set([
  'add',
  'and',
  'create',
  'file',
  'fix',
  'for',
  'from',
  'implement',
  'input',
  'into',
  'that',
  'the',
  'this',
  'use',
  'with',
]);

function withinRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function extractExplicitPaths(task: string): string[] {
  const candidates =
    task.match(
      /(?:^|[\s"'`(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9_-]+)(?=$|[\s"'`,):;.!?])/gu
    ) ?? [];
  return [
    ...new Set(
      candidates
        .map((candidate) => candidate.trim().replace(/^["'`(]+|["'`,):;]+$/gu, ''))
        .filter((candidate) => !path.isAbsolute(candidate) && !candidate.split('/').includes('..'))
    ),
  ];
}

export function extractSearchTerms(task: string): string[] {
  const paths = new Set(extractExplicitPaths(task));
  return [
    ...new Set(
      task
        .match(/[A-Za-z_][A-Za-z0-9_]{2,}/gu)
        ?.filter((term) => !STOP_WORDS.has(term.toLowerCase()) && !paths.has(term)) ?? []
    ),
  ].slice(0, 6);
}

async function listRepositoryFiles(repoRoot: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['.git', '.agent', 'node_modules', 'dist'].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile())
        results.push(path.relative(repoRoot, absolute).split(path.sep).join('/'));
      if (results.length >= MAX_LIST_FILES) return;
    }
  };
  await walk(repoRoot);
  return results.sort();
}

async function readExplicitPath(
  relativePath: string,
  repoRoot: string
): Promise<{ path: string; content: string } | null> {
  const absolute = path.resolve(repoRoot, relativePath);
  if (!withinRoot(absolute, path.resolve(repoRoot)) || !existsSync(absolute)) return null;
  const resolved = realpathSync.native(absolute);
  if (!withinRoot(resolved, realpathSync.native(repoRoot))) return null;
  const fileStat = await stat(resolved);
  if (!fileStat.isFile() || fileStat.size > 1024 * 1024) return null;
  try {
    return { path: relativePath, content: truncateContent(await readFile(resolved, 'utf8')) };
  } catch {
    return null;
  }
}

export async function gatherContext(query: string, repoRoot: string): Promise<Context> {
  const explicitPaths = extractExplicitPaths(query);
  const searchTerms = extractSearchTerms(query);
  const repositoryFiles = await listRepositoryFiles(repoRoot).catch(() => []);
  const explicitFiles = (
    await Promise.all(explicitPaths.map((filePath) => readExplicitPath(filePath, repoRoot)))
  ).filter((file): file is { path: string; content: string } => file !== null);
  const searchLines = (
    await Promise.all(searchTerms.map((term) => runRipgrepSearch(term, repoRoot)))
  ).flat();
  const prioritized = groupSearchLines(searchLines)
    .sort(
      (left, right) =>
        Number(explicitPaths.includes(right.path)) - Number(explicitPaths.includes(left.path)) ||
        left.path.localeCompare(right.path)
    )
    .slice(0, MAX_SEARCH_FILES);
  const alreadyRead = new Set(explicitFiles.map((file) => file.path));
  const searchedFiles = (
    await Promise.all(
      prioritized
        .filter((result) => !alreadyRead.has(result.path))
        .map((result) => readExplicitPath(result.path, repoRoot))
    )
  ).filter((file): file is { path: string; content: string } => file !== null);
  return {
    searchResults: prioritized,
    files: [...explicitFiles, ...searchedFiles].slice(0, MAX_SEARCH_FILES),
    repositoryFiles,
    searchTerms,
  };
}

function runRipgrepSearch(query: string, repoRoot: string): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn(
      'rg',
      [
        '--fixed-strings',
        '--line-number',
        '--color',
        'never',
        '--max-count',
        String(MAX_MATCHES_PER_FILE),
        query,
        '.',
      ],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => resolve([]));
    child.on('close', (code) =>
      resolve(code === 0 || code === 1 ? stdout.trim().split('\n').filter(Boolean) : [])
    );
  });
}

function groupSearchLines(lines: string[]): Array<{ path: string; matches: string[] }> {
  const byFile = new Map<string, string[]>();
  for (const line of lines) {
    const firstColon = line.indexOf(':');
    const secondColon = line.indexOf(':', firstColon + 1);
    if (firstColon <= 0 || secondColon <= firstColon + 1) continue;
    const filePath = line.slice(0, firstColon).replace(/^\.\//u, '');
    const existing = byFile.get(filePath) ?? [];
    const match = `${line.slice(firstColon + 1, secondColon)}: ${line.slice(secondColon + 1).trim()}`;
    if (existing.length < MAX_MATCHES_PER_FILE && !existing.includes(match)) existing.push(match);
    byFile.set(filePath, existing);
  }
  return [...byFile.entries()].map(([filePath, matches]) => ({ path: filePath, matches }));
}

function truncateContent(content: string): string {
  const joined = content.split('\n').slice(0, MAX_FILE_LINES).join('\n');
  return joined.length <= MAX_FILE_CHARS
    ? joined
    : `${joined.slice(0, MAX_FILE_CHARS)}\n... [truncated]`;
}
