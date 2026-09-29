/**
 * Prompt output contract tests
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeAgentOutputEnvelope,
  parseAgentOutput,
  validatePatchOutputContract,
} from '../../src/prompts/formats';

describe('parseAgentOutput', () => {
  it('parses strict JSON output', () => {
    const parsed = parseAgentOutput(
      JSON.stringify({
        plan: 'Update README',
        patch: '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n',
        commands: ['npm test'],
        done: true,
        tool_calls: [{ tool: 'search_code', args: { query: 'README' } }],
      })
    );

    expect(parsed.plan).toBe('Update README');
    expect(parsed.patch).toContain('+++ b/README.md');
    expect(parsed.commands).toEqual(['npm test']);
    expect(parsed.done).toBe(true);
    expect(parsed.tool_calls[0]).toEqual({ tool: 'search_code', args: { query: 'README' } });
  });

  it('rejects unknown keys and malformed shapes', () => {
    expect(() =>
      parseAgentOutput(
        JSON.stringify({
          plan: 'x',
          patch: null,
          commands: [],
          done: true,
          tool_calls: [],
          extra: true,
        })
      )
    ).toThrow('unsupported keys');

    expect(() =>
      parseAgentOutput(
        JSON.stringify({
          plan: '',
          patch: null,
          commands: [],
          done: true,
          tool_calls: [],
        })
      )
    ).toThrow('plan');
  });

  it('accepts fenced JSON content', () => {
    const parsed = parseAgentOutput(`\`\`\`json
{"plan":"p","patch":null,"commands":[],"done":true,"tool_calls":[]}
\`\`\``);

    expect(parsed.done).toBe(true);
  });

  it('extracts embedded JSON when prose wraps the object', () => {
    const parsed = parseAgentOutput(
      [
        'Here is the structured result:',
        '{"plan":"p","patch":null,"commands":[],"done":true,"tool_calls":[]}',
        'Thanks.',
      ].join('\n')
    );

    expect(parsed.plan).toBe('p');
    expect(parsed.done).toBe(true);
  });

  it('normalizes BOM + fenced wrappers', () => {
    const normalized = normalizeAgentOutputEnvelope(
      `\uFEFF\`\`\`JSON\n{"plan":"p","patch":null,"commands":[],"done":true,"tool_calls":[]}\n\`\`\``
    );
    expect(normalized.startsWith('{')).toBe(true);
    expect(normalized.endsWith('}')).toBe(true);
  });

  it('rejects unrecoverable non-json outputs', () => {
    expect(() => parseAgentOutput('no structured output here')).toThrow('not valid JSON');
  });

  it('rejects prose before unified diff headers in patch output', () => {
    expect(() =>
      validatePatchOutputContract(
        [
          'Here is your patch:',
          '--- a/README.md',
          '+++ b/README.md',
          '@@ -1 +1 @@',
          '-a',
          '+b',
          '',
        ].join('\n')
      )
    ).toThrow('leading prose');
  });
});
