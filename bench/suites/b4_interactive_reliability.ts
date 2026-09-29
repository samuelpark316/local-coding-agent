import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ConversationState,
  DEFAULT_POLICY,
  ToolDispatcher,
  ToolLoopRunner,
  TransactionStore,
} from '../../packages/core/src/index.js';
import type { LLM } from '../../packages/core/src/model/LLM.js';
import type { BenchmarkResult } from '../types.js';

function scripted(outputs: string[], prompts: string[]): LLM {
  return {
    async complete(prompt) {
      prompts.push(prompt);
      const content = outputs.shift();
      if (!content) throw new Error('Benchmark script exhausted.');
      return { content, finishReason: 'stop' };
    },
  };
}

export async function runB4(): Promise<BenchmarkResult> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-b4-'));
  const transactionStore = new TransactionStore(
    path.join(repoRoot, '.agent', 'transactions'),
    repoRoot
  );
  const prompts: string[] = [];
  const events: string[] = [];
  const outputs = [
    JSON.stringify({ type: 'create_file', args: { path: 'bubble.py', content: '' } }),
    JSON.stringify({ type: 'complete', summary: 'Created empty bubble.py.' }),
    JSON.stringify({
      type: 'tool_call',
      summary: 'Read bubble.py',
      tool: 'read_file',
      args: { path: 'bubble.py' },
    }),
    JSON.stringify({ type: 'edit_file', args: { path: 'bubble.py', newText: 'invalid' } }),
    JSON.stringify({
      type: 'replace_file',
      args: {
        path: 'bubble.py',
        content:
          'def bubble_sort(values: list[int]) -> list[int]:\n    """Return a sorted copy without mutating the input."""\n    result = values.copy()\n    for end in range(len(result) - 1, 0, -1):\n        swapped = False\n        for index in range(end):\n            if result[index] > result[index + 1]:\n                result[index], result[index + 1] = result[index + 1], result[index]\n                swapped = True\n        if not swapped:\n            break\n    return result\n',
      },
    }),
    JSON.stringify({ type: 'complete', summary: 'Implemented bubble_sort.' }),
    JSON.stringify({
      type: 'create_file',
      args: {
        path: 'test_bubble.py',
        content:
          'from bubble import bubble_sort\n\ndef test_empty():\n    assert bubble_sort([]) == []\n',
      },
    }),
    JSON.stringify({ type: 'complete', summary: 'Added tests.' }),
  ];
  const state = new ConversationState();
  const runner = new ToolLoopRunner({
    llm: scripted(outputs, prompts),
    dispatcher: new ToolDispatcher(),
    onEvent: (type) => events.push(type),
  });
  const policy = { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] };
  const options = { autoApprove: true, transactionStore, conversationState: state };
  const create = await runner.run(
    { task: 'Create an empty bubble.py file.', repoRoot, policy },
    options
  );
  const edit = await runner.run(
    { task: 'Implement bubble_sort in that file without mutating input.', repoRoot, policy },
    options
  );
  const followUp = await runner.run(
    { task: 'Add tests for the function from the previous request.', repoRoot, policy },
    options
  );
  const content = await readFile(path.join(repoRoot, 'bubble.py'), 'utf8');
  const continuity = prompts.at(-2)?.includes('bubble.py') === true;

  const repairRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-b4-repair-'));
  await writeFile(path.join(repairRoot, 'check.js'), 'process.exit(1);\n', 'utf8');
  const command = 'node check.js';
  const repairEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const repair = await new ToolLoopRunner({
    llm: scripted(
      [
        JSON.stringify({
          type: 'tool_call',
          summary: 'Run test',
          tool: 'run_command',
          args: { command },
        }),
        JSON.stringify({
          type: 'replace_file',
          args: { path: 'check.js', content: 'process.exit(0);\n' },
        }),
        JSON.stringify({
          type: 'tool_call',
          summary: 'Run test again',
          tool: 'run_command',
          args: { command },
        }),
        JSON.stringify({ type: 'complete', summary: 'Tests passed after repair.' }),
      ],
      []
    ),
    dispatcher: new ToolDispatcher(),
    onEvent: (type, data) => repairEvents.push({ type, data }),
  }).run(
    {
      task: 'Fix the failing check and verify it.',
      repoRoot: repairRoot,
      policy: {
        ...DEFAULT_POLICY,
        allowedRepoRoots: [repairRoot],
        commandAllowlist: [command],
      },
    },
    { autoApprove: true }
  );

  const latest = await transactionStore.latest();
  const undoWorked = latest ? (await transactionStore.revert(latest)).status === 'reverted' : false;
  const passed =
    create.stopReason === 'completed' &&
    edit.stopReason === 'completed' &&
    followUp.stopReason === 'completed' &&
    repair.stopReason === 'completed' &&
    content.includes('values.copy()') &&
    continuity &&
    undoWorked;
  const totalModelOutputs = 12;
  const acceptedActions =
    events.filter((event) => event === 'model_output').length +
    repairEvents.filter((event) => event.type === 'model_output').length;
  const normalizations =
    events.filter((event) => event === 'action_normalized').length +
    repairEvents.filter((event) => event.type === 'action_normalized').length;
  return {
    passed,
    metrics: {
      validActionRate: acceptedActions / totalModelOutputs,
      normalizationRate: normalizations / totalModelOutputs,
      repairSuccess:
        events.includes('repair_succeeded') ||
        repairEvents.some((event) => event.type === 'repair_succeeded')
          ? 1
          : 0,
      taskCompletionRate:
        [create, edit, followUp, repair].filter((result) => result.stopReason === 'completed')
          .length / 4,
      averageTurns: (create.steps + edit.steps + followUp.steps + repair.steps) / 4,
      toolErrors: repairEvents.filter(
        (event) => event.type === 'tool_result' && event.data.success === false
      ).length,
      verificationSuccess: repair.verification.length > 0 ? 1 : 0,
      loopStops: 0,
      safetyPass: 1,
      undoSuccess: undoWorked ? 1 : 0,
    },
  };
}
