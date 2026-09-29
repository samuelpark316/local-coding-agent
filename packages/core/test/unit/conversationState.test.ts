import { describe, expect, it } from 'vitest';
import { ConversationState } from '../../src/runtime/ConversationState';

describe('ConversationState', () => {
  it('compacts old result detail while retaining current task and changed-file ledger', () => {
    const state = new ConversationState({ maxRequests: 8, maxResultChars: 4_000 });
    for (let index = 0; index < 8; index += 1) {
      state.beginRequest(`request-${index}`, `task-${index}`);
      state.recordToolResult(
        'read_file',
        {
          success: true,
          data: { content: 'x'.repeat(8_000) },
          changedFiles: [`file-${index}.txt`],
        },
        { path: `file-${index}.txt` }
      );
      state.finish(`summary-${index}`, 'completed');
    }
    const context = state.toPromptContext();
    expect(context.length).toBeLessThan(25_000);
    expect(context).toContain('task-7');
    expect(context).toContain('file-0.txt');
    expect(context).toContain('file-7.txt');
    expect(context).toContain('Older request details compacted');
  });
});
