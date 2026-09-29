/** Optional local-model benchmark. Never runs in CI unless explicitly enabled. */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  ConversationState,
  DEFAULT_POLICY,
  OllamaAdapter,
  ToolDispatcher,
  ToolLoopRunner,
  TransactionStore,
} from '../packages/core/src/index.js';

if (process.env.LIVE_OLLAMA_BENCH !== '1') {
  process.stdout.write('SKIP live Ollama benchmark (set LIVE_OLLAMA_BENCH=1)\n');
  process.exit(0);
}

const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-live-'));
await promisify(execFile)('git', ['init', '--quiet'], { cwd: repoRoot });
const model = process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:14b';
const llm = new OllamaAdapter({
  baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  model,
  temperature: 0,
  timeoutMs: 120_000,
  maxRetries: 1,
});
const events: string[] = [];
const runner = new ToolLoopRunner({
  llm,
  dispatcher: new ToolDispatcher(),
  onEvent: (type) => events.push(type),
});
const policy = { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] };
const state = new ConversationState();
const transactionStore = new TransactionStore(
  path.join(repoRoot, '.agent', 'transactions'),
  repoRoot
);
const options = { autoApprove: true, conversationState: state, transactionStore };
const started = Date.now();
const first = await runner.run(
  { task: 'Create an empty bubble.py file.', repoRoot, policy },
  options
);
const second = await runner.run(
  {
    task: 'Implement a bubble_sort function in that file. Return a sorted copy, do not mutate the input, use type hints and a docstring, and stop early when no swaps occur.',
    repoRoot,
    policy,
  },
  options
);
const content = await readFile(path.join(repoRoot, 'bubble.py'), 'utf8').catch(() => '');
const passed =
  first.stopReason === 'completed' &&
  second.stopReason === 'completed' &&
  content.includes('bubble_sort');
process.stdout.write(
  `${passed ? 'PASS' : 'FAIL'} live ${model} ${JSON.stringify({
    taskCompletion:
      [first, second].filter((result) => result.stopReason === 'completed').length / 2,
    averageTurns: (first.steps + second.steps) / 2,
    normalizations: events.filter((event) => event === 'action_normalized').length,
    repairs: events.filter((event) => event === 'repair_succeeded').length,
    toolErrors: events.filter((event) => event === 'tool_result').length,
    elapsedMs: Date.now() - started,
    safety: 1,
  })}\n`
);
if (!passed) process.exitCode = 1;
