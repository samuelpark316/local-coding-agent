import { describe, expect, it } from 'vitest';
import { AgentActionParseError } from '../../src/actions/AgentAction';
import {
  parseAgentAction,
  parseAgentActionWithDiagnostics,
} from '../../src/actions/parseAgentAction';

describe('parseAgentAction', () => {
  it('parses each supported action', () => {
    expect(
      parseAgentAction(
        '{"type":"tool_call","summary":"Read file","tool":"read_file","args":{"path":"a.ts"}}'
      )
    ).toMatchObject({ type: 'tool_call', tool: 'read_file' });
    expect(parseAgentAction('{"type":"complete","summary":"Done"}')).toEqual({
      type: 'complete',
      summary: 'Done',
      changedFiles: undefined,
      verification: undefined,
    });
    expect(
      parseAgentAction('prose\n```json\n{"type":"request_input","question":"Which API?"}\n```')
    ).toMatchObject({ type: 'request_input', question: 'Which API?' });
  });

  it('normalizes direct registered-tool action forms without guessing arguments', () => {
    const knownTools = ['create_file', 'edit_file'];
    expect(
      parseAgentAction('{"type":"create_file","args":{"path":"bubble.py","content":""}}', {
        knownTools,
      })
    ).toEqual({
      type: 'tool_call',
      summary: 'Use create_file',
      tool: 'create_file',
      args: { path: 'bubble.py', content: '' },
    });
    expect(
      parseAgentAction(
        '{"type":"edit_file","summary":"Edit it","args":{"path":"bubble.py","oldText":"x","newText":"y"}}',
        { knownTools }
      )
    ).toMatchObject({ type: 'tool_call', tool: 'edit_file' });
    expect(
      parseAgentAction('{"tool":"create_file","args":{"path":"bubble.py","content":""}}', {
        knownTools,
      })
    ).toMatchObject({ type: 'tool_call', tool: 'create_file' });
  });

  it('rejects unknown direct tools and ambiguous direct envelopes', () => {
    expect(() =>
      parseAgentAction('{"type":"erase_disk","args":{}}', { knownTools: ['read_file'] })
    ).toThrow('Unsupported action type');
    expect(() =>
      parseAgentAction('{"type":"edit_file","tool":"read_file","args":{"path":"a"}}', {
        knownTools: ['edit_file', 'read_file'],
      })
    ).toThrow('unsupported keys');
  });

  it('preserves raw, recovered, and normalized forms in diagnostics', () => {
    const raw = 'Here you go:\n```json\n{"tool":"read_file","args":{"path":"a.py"}}\n```';
    const parsed = parseAgentActionWithDiagnostics(raw, { knownTools: ['read_file'] });
    expect(parsed.action).toMatchObject({ type: 'tool_call', tool: 'read_file' });
    expect(parsed.diagnostics.rawOutput).toBe(raw);
    expect(parsed.diagnostics.normalizedOutput).toContain('"type":"tool_call"');
    expect(parsed.diagnostics.normalizationActions).toContain('tool_only:read_file');
  });

  it('rejects unknown keys and preserves raw output', () => {
    const raw = '{"type":"complete","summary":"Done","extra":true}';
    expect(() => parseAgentAction(raw)).toThrow(AgentActionParseError);
    try {
      parseAgentAction(raw);
    } catch (error) {
      expect((error as AgentActionParseError).rawModelOutput).toBe(raw);
    }
  });
});
