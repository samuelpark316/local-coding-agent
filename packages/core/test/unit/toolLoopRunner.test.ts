import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LLM } from '../../src/model/LLM';
import { DEFAULT_POLICY } from '../../src/policy/Policy';
import { ConversationState } from '../../src/runtime/ConversationState';
import { ToolLoopRunner } from '../../src/runtime/ToolLoopRunner';
import { TransactionStore } from '../../src/runtime/TransactionStore';
import { ToolDispatcher } from '../../src/tools/ToolDispatcher';

function scriptedLlm(outputs: string[]): LLM {
  let index = 0;
  return {
    async complete() {
      const content = outputs[index++];
      if (!content) throw new Error('No scripted output.');
      return { content, finishReason: 'stop' };
    },
  };
}

describe('ToolLoopRunner', () => {
  it('executes multiple read-only turns before completion', async () => {
    const events: string[] = [];
    const runner = new ToolLoopRunner({
      llm: scriptedLlm([
        JSON.stringify({
          type: 'tool_call',
          summary: 'List files',
          tool: 'list_files',
          args: { glob: '**/*' },
        }),
        JSON.stringify({ type: 'complete', summary: 'Repository inspected.' }),
      ]),
      dispatcher: new ToolDispatcher(),
      contextGatherer: async () => ({ files: [], searchResults: [] }),
      onEvent: async (type) => events.push(type),
    });
    const result = await runner.run({
      task: 'inspect',
      repoRoot: process.cwd(),
      policy: { ...DEFAULT_POLICY, allowedRepoRoots: [process.cwd()] },
    });
    expect(result.stopReason).toBe('completed');
    expect(result.steps).toBe(2);
    expect(events).toContain('tool_call');
    expect(events).toContain('request_completed');
  });

  it('stops repeated actions', async () => {
    const repeated = JSON.stringify({
      type: 'tool_call',
      summary: 'List files',
      tool: 'list_files',
      args: { glob: '**/*' },
    });
    const runner = new ToolLoopRunner({
      llm: scriptedLlm([repeated, repeated, repeated, repeated]),
      dispatcher: new ToolDispatcher(),
      contextGatherer: async () => ({ files: [], searchResults: [] }),
    });
    const result = await runner.run({
      task: 'loop',
      repoRoot: process.cwd(),
      policy: { ...DEFAULT_POLICY, allowedRepoRoots: [process.cwd()] },
    });
    expect(result.stopReason).toBe('loop_detected');
  });

  it('repairs valid envelopes with missing required tool arguments before dispatch', async () => {
    const events: string[] = [];
    const runner = new ToolLoopRunner({
      llm: scriptedLlm([
        JSON.stringify({
          type: 'tool_call',
          summary: 'Edit file',
          tool: 'edit_file',
          args: { path: 'bubble.py', newText: 'value' },
        }),
        JSON.stringify({
          type: 'tool_call',
          summary: 'Read file',
          tool: 'read_file',
          args: { path: 'bubble.py' },
        }),
        JSON.stringify({ type: 'complete', summary: 'Inspected file.' }),
      ]),
      dispatcher: new ToolDispatcher(),
      contextGatherer: async () => ({ files: [], searchResults: [] }),
      onEvent: (type) => events.push(type),
    });
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-repair-'));
    await writeFile(path.join(repoRoot, 'bubble.py'), '', 'utf8');
    const result = await runner.run({
      task: 'Inspect bubble.py',
      repoRoot,
      policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] },
    });
    expect(result.stopReason).toBe('completed');
    expect(events.filter((event) => event === 'tool_call')).toHaveLength(1);
    expect(events).toContain('repair_started');
    expect(events).toContain('repair_succeeded');
  });

  it('bounds repeated identical malformed arguments and emits repair failure', async () => {
    const invalid = JSON.stringify({
      type: 'tool_call',
      summary: 'Edit',
      tool: 'edit_file',
      args: { path: 'bubble.py', newText: 'x' },
    });
    const events: string[] = [];
    const result = await new ToolLoopRunner({
      llm: scriptedLlm([invalid, invalid, invalid]),
      dispatcher: new ToolDispatcher(),
      contextGatherer: async () => ({ files: [], searchResults: [] }),
      onEvent: (type) => events.push(type),
    }).run(
      {
        task: 'Edit bubble.py',
        repoRoot: process.cwd(),
        policy: { ...DEFAULT_POLICY, allowedRepoRoots: [process.cwd()] },
      },
      { maxParseRetries: 2 }
    );
    expect(result.stopReason).toBe('parse_retry_exhausted');
    expect(events.filter((event) => event === 'repair_started')).toHaveLength(2);
    expect(events).toContain('repair_failed');
    expect(events).not.toContain('tool_call');
  });

  it('continues after an unnecessary input request when the target path is explicit', async () => {
    const result = await new ToolLoopRunner({
      llm: scriptedLlm([
        JSON.stringify({ type: 'request_input', question: 'Which file path should I inspect?' }),
        JSON.stringify({ type: 'complete', summary: 'Used the explicit path.' }),
      ]),
      dispatcher: new ToolDispatcher(),
      contextGatherer: async () => ({ files: [], searchResults: [] }),
    }).run({
      task: 'Inspect bubble.py',
      repoRoot: process.cwd(),
      policy: { ...DEFAULT_POLICY, allowedRepoRoots: [process.cwd()] },
    });
    expect(result.stopReason).toBe('completed');
    expect(result.steps).toBe(2);
  });

  it('retains failed tool results and clarifications across runs', async () => {
    const prompts: string[] = [];
    const outputs = [
      JSON.stringify({
        type: 'tool_call',
        summary: 'Read',
        tool: 'read_file',
        args: { path: 'missing.py' },
      }),
      JSON.stringify({
        type: 'request_input',
        question: 'What behavior should the new file have?',
      }),
      JSON.stringify({
        type: 'complete',
        summary: 'Understood.',
        noChangeReason: 'Waiting only for this diagnostic fixture.',
      }),
      JSON.stringify({ type: 'complete', summary: 'Remembered prior state.' }),
    ];
    const llm: LLM = {
      async complete(prompt) {
        prompts.push(prompt);
        return { content: outputs.shift() as string, finishReason: 'stop' };
      },
    };
    const state = new ConversationState();
    const runner = new ToolLoopRunner({
      llm,
      dispatcher: new ToolDispatcher(),
      contextGatherer: async () => ({ files: [], searchResults: [] }),
    });
    const base = {
      repoRoot: process.cwd(),
      policy: { ...DEFAULT_POLICY, allowedRepoRoots: [process.cwd()] },
    };
    const first = await runner.run(
      { task: 'Investigate the missing module', ...base },
      { conversationState: state }
    );
    expect(first.stopReason).toBe('input_required');
    await runner.run(
      {
        task: 'It should return a copy.',
        ...base,
        requestId: first.requestId,
        continuation: true,
        clarification: 'It should return a copy.',
      },
      { conversationState: state }
    );
    await runner.run(
      { task: 'Summarize the prior investigation', ...base },
      { conversationState: state }
    );
    expect(prompts.at(-1)).toContain('missing.py');
    expect(prompts.at(-1)).toContain('It should return a copy.');
  });

  it('normalizes direct create actions and enforces exact explicit-path and empty-file semantics', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-create-'));
    const events: string[] = [];
    const runner = new ToolLoopRunner({
      llm: scriptedLlm([
        JSON.stringify({ type: 'create_file', args: { path: 'src/bubble.py', content: '' } }),
        JSON.stringify({ type: 'create_file', args: { path: 'bubble.py', content: 'not empty' } }),
        JSON.stringify({ type: 'complete', summary: 'Created bubble.py.' }),
        JSON.stringify({ type: 'replace_file', args: { path: 'bubble.py', content: '' } }),
        JSON.stringify({ type: 'complete', summary: 'Created the requested empty bubble.py.' }),
      ]),
      dispatcher: new ToolDispatcher(),
      contextGatherer: async () => ({ files: [], searchResults: [], repositoryFiles: [] }),
      onEvent: (type) => events.push(type),
    });
    const result = await runner.run(
      {
        task: 'Create an empty bubble.py file.',
        repoRoot,
        policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] },
      },
      { autoApprove: true }
    );
    expect(result.stopReason).toBe('completed');
    expect(result.changedFiles).toEqual(['bubble.py']);
    expect(
      await import('node:fs/promises').then(({ readFile }) =>
        readFile(path.join(repoRoot, 'bubble.py'))
      )
    ).toHaveLength(0);
    expect(events.filter((event) => event === 'action_normalized')).toHaveLength(3);
  });

  it('rejects an immediate no-change completion for an explicit create and continues the loop', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-create-completion-'));
    const result = await new ToolLoopRunner({
      llm: scriptedLlm([
        JSON.stringify({
          type: 'complete',
          summary: 'No changes needed.',
          noChangeReason: 'No files were inspected or edited.',
        }),
        JSON.stringify({ type: 'create_file', args: { path: 'bubble.py', content: '' } }),
        JSON.stringify({ type: 'complete', summary: 'Created bubble.py.' }),
      ]),
      dispatcher: new ToolDispatcher(),
      contextGatherer: async () => ({ files: [], searchResults: [] }),
    }).run(
      {
        task: 'Create bubble.py in the repository root.',
        repoRoot,
        policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] },
      },
      { autoApprove: true }
    );

    expect(result).toMatchObject({ stopReason: 'completed', steps: 3 });
    expect(result.changedFiles).toEqual(['bubble.py']);
  });

  it('rejects an implement completion with no inspection and no changes', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-implement-completion-'));
    await writeFile(
      path.join(repoRoot, 'bubble.py'),
      'def bubble_sort(values):\n    return values\n'
    );
    const result = await new ToolLoopRunner({
      llm: scriptedLlm([
        JSON.stringify({
          type: 'complete',
          summary: 'No changes needed.',
          noChangeReason: 'The implementation is already present.',
        }),
      ]),
      dispatcher: new ToolDispatcher(),
      contextGatherer: async () => ({ files: [], searchResults: [] }),
    }).run(
      {
        task: 'Implement bubble_sort in bubble.py.',
        repoRoot,
        policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] },
      },
      { maxSteps: 1 }
    );

    expect(result.stopReason).toBe('max_steps');
    expect(result.changedFiles).toEqual([]);
    expect(result.inspectedFiles).toEqual([]);
  });

  it('rejects completion when an explicit mutation target is missing', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-missing-completion-'));
    const prompts: string[] = [];
    const outputs = [
      JSON.stringify({
        type: 'complete',
        summary: 'No changes needed.',
        noChangeReason: 'The requested code is already correct.',
      }),
      JSON.stringify({ type: 'request_input', question: 'Please clarify the expected behavior.' }),
    ];
    const result = await new ToolLoopRunner({
      llm: {
        async complete(prompt) {
          prompts.push(prompt);
          return { content: outputs.shift() as string, finishReason: 'stop' };
        },
      },
      dispatcher: new ToolDispatcher(),
      contextGatherer: async () => ({ files: [], searchResults: [] }),
    }).run({
      task: 'Implement bubble_sort in missing.py.',
      repoRoot,
      policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] },
    });

    expect(result.stopReason).toBe('input_required');
    expect(prompts[1]).toContain('missing.py, but the target does not exist');
  });

  it('accepts an inspected no-op only after the model supplies a reason', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-noop-completion-'));
    await writeFile(
      path.join(repoRoot, 'bubble.py'),
      'def bubble_sort(values):\n    return sorted(values)\n'
    );
    const result = await new ToolLoopRunner({
      llm: scriptedLlm([
        JSON.stringify({ type: 'read_file', args: { path: 'bubble.py' } }),
        JSON.stringify({ type: 'complete', summary: 'The implementation is already correct.' }),
        JSON.stringify({
          type: 'complete',
          summary: 'The implementation is already correct.',
          noChangeReason: 'The inspected function already returns a sorted copy.',
        }),
      ]),
      dispatcher: new ToolDispatcher(),
      contextGatherer: async () => ({ files: [], searchResults: [] }),
    }).run({
      task: 'Implement bubble_sort in bubble.py.',
      repoRoot,
      policy: { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] },
    });

    expect(result).toMatchObject({ stopReason: 'completed', steps: 3, changedFiles: [] });
    expect(result.inspectedFiles).toEqual(['bubble.py']);
  });

  it('accepts successful explicit creates and edits', async () => {
    const createRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-success-create-'));
    const created = await new ToolLoopRunner({
      llm: scriptedLlm([
        JSON.stringify({ type: 'create_file', args: { path: 'bubble.py', content: '' } }),
        JSON.stringify({ type: 'complete', summary: 'Created bubble.py.' }),
      ]),
      dispatcher: new ToolDispatcher(),
      contextGatherer: async () => ({ files: [], searchResults: [] }),
    }).run(
      {
        task: 'Create bubble.py.',
        repoRoot: createRoot,
        policy: { ...DEFAULT_POLICY, allowedRepoRoots: [createRoot] },
      },
      { autoApprove: true }
    );
    expect(created).toMatchObject({ stopReason: 'completed', changedFiles: ['bubble.py'] });

    const editRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-success-edit-'));
    await writeFile(path.join(editRoot, 'bubble.py'), 'pass\n');
    const edited = await new ToolLoopRunner({
      llm: scriptedLlm([
        JSON.stringify({
          type: 'edit_file',
          args: {
            path: 'bubble.py',
            oldText: 'pass\n',
            newText: 'def bubble_sort():\n    return []\n',
          },
        }),
        JSON.stringify({ type: 'complete', summary: 'Implemented bubble_sort.' }),
      ]),
      dispatcher: new ToolDispatcher(),
      contextGatherer: async () => ({ files: [], searchResults: [] }),
    }).run(
      {
        task: 'Edit bubble.py to implement bubble_sort.',
        repoRoot: editRoot,
        policy: { ...DEFAULT_POLICY, allowedRepoRoots: [editRoot] },
      },
      { autoApprove: true }
    );
    expect(edited).toMatchObject({ stopReason: 'completed', changedFiles: ['bubble.py'] });
  });

  it('keeps one transaction active when clarification resumes a mutated request', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-clarify-'));
    const store = new TransactionStore(path.join(repoRoot, '.agent', 'transactions'), repoRoot);
    const state = new ConversationState();
    const runner = new ToolLoopRunner({
      llm: scriptedLlm([
        JSON.stringify({ type: 'create_file', args: { path: 'answer.txt', content: 'draft\n' } }),
        JSON.stringify({ type: 'request_input', question: 'Should I finalize the draft?' }),
        JSON.stringify({ type: 'replace_file', args: { path: 'answer.txt', content: 'final\n' } }),
        JSON.stringify({ type: 'complete', summary: 'Finalized answer.txt.' }),
      ]),
      dispatcher: new ToolDispatcher(),
      contextGatherer: async () => ({ files: [], searchResults: [] }),
    });
    const policy = { ...DEFAULT_POLICY, allowedRepoRoots: [repoRoot] };
    const first = await runner.run(
      { task: 'Create answer.txt and ask before finalizing.', repoRoot, policy },
      { autoApprove: true, transactionStore: store, conversationState: state }
    );
    expect(first.stopReason).toBe('input_required');
    expect(first.transaction?.status).toBe('active');
    const second = await runner.run(
      {
        task: 'Yes.',
        repoRoot,
        policy,
        requestId: first.requestId,
        continuation: true,
        clarification: 'Yes.',
      },
      {
        autoApprove: true,
        transactionStore: store,
        transaction: first.transaction,
        conversationState: state,
      }
    );
    expect(second.stopReason).toBe('completed');
    expect(second.transaction).toMatchObject({ status: 'completed' });
    expect(second.transaction?.edits).toHaveLength(2);
  });
});
