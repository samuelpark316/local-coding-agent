/**
 * Agent runner tests
 */

import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/context/gather';
import type { LLM } from '../../src/model/LLM';
import { AgentRunner } from '../../src/runtime/AgentRunner';

const FIXTURE_CONTEXT: Context = {
  searchResults: [{ path: 'README.md', matches: ['1: before'] }],
  files: [{ path: 'README.md', content: 'before\n' }],
};

function createDeterministicLlm(content: string): LLM {
  return {
    async complete() {
      return {
        content,
        finishReason: 'stop',
      };
    },
  };
}

describe('AgentRunner', () => {
  it('runs a single iteration and returns parsed output with events', async () => {
    const events: string[] = [];
    const runner = new AgentRunner({
      llm: createDeterministicLlm(
        JSON.stringify({
          plan: 'Update README',
          patch: [
            '--- a/README.md',
            '+++ b/README.md',
            '@@ -1 +1 @@',
            '-before',
            '+after',
            '',
          ].join('\n'),
          commands: ['npm test'],
          done: true,
          tool_calls: [],
        })
      ),
      contextGatherer: async () => FIXTURE_CONTEXT,
      onEvent: async (type) => {
        events.push(type);
      },
    });

    const result = await runner.run({
      task: 'update readme',
      repoRoot: '/tmp/repo',
    });

    expect(result.output.plan).toBe('Update README');
    expect(result.output.patch).toContain('+++ b/README.md');
    expect(result.proposedPatchFileCount).toBe(1);
    expect(events).toEqual(['tool_call', 'tool_result', 'plan', 'patch_proposed']);
  });

  it('rejects model outputs that include prose before patch headers', async () => {
    const runner = new AgentRunner({
      llm: createDeterministicLlm(
        JSON.stringify({
          plan: 'Update README',
          patch: ['Here is your patch:', '--- a/README.md', '+++ b/README.md'].join('\n'),
          commands: [],
          done: true,
          tool_calls: [],
        })
      ),
      contextGatherer: async () => FIXTURE_CONTEXT,
    });

    await expect(
      runner.run({
        task: 'update readme',
        repoRoot: '/tmp/repo',
      })
    ).rejects.toThrow('leading prose');
  });

  it('preserves raw model output on parse/contract failures for diagnostics', async () => {
    const badOutput = JSON.stringify({
      plan: 'Update README',
      patch: ['prose', '--- a/README.md', '+++ b/README.md'].join('\n'),
      commands: [],
      done: true,
      tool_calls: [],
    });
    const runner = new AgentRunner({
      llm: createDeterministicLlm(badOutput),
      contextGatherer: async () => FIXTURE_CONTEXT,
    });

    try {
      await runner.run({
        task: 'update readme',
        repoRoot: '/tmp/repo',
      });
      throw new Error('Expected runner to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const candidate = error as Error & { rawModelOutput?: string };
      expect(candidate.rawModelOutput).toBe(badOutput);
    }
  });

  it('is deterministic for identical prompt and context inputs', async () => {
    const llm = createDeterministicLlm(
      JSON.stringify({
        plan: 'Rename symbol',
        patch: ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-foo', '+bar', ''].join('\n'),
        commands: [],
        done: true,
        tool_calls: [],
      })
    );
    const runner = new AgentRunner({
      llm,
      contextGatherer: async () => FIXTURE_CONTEXT,
    });

    const first = await runner.run({ task: 'rename foo to bar', repoRoot: '/tmp/repo' });
    const second = await runner.run({ task: 'rename foo to bar', repoRoot: '/tmp/repo' });

    expect(first.prompt).toBe(second.prompt);
    expect(first.output.patch).toBe(second.output.patch);
    expect(first.output.plan).toBe(second.output.plan);
  });
});
