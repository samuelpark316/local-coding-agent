import type { ToolLoopResult } from '@local-agent/core';

const CYAN = '\u001B[36m';
const GREEN = '\u001B[32m';
const YELLOW = '\u001B[33m';
const RESET = '\u001B[0m';

function color(text: string, code: string, plain: boolean): string {
  return plain ? text : `${code}${text}${RESET}`;
}

export class SessionView {
  constructor(
    private readonly write: (message: string) => void,
    private readonly plain = false
  ) {}

  startup(repoRoot: string, model: string, autoApprove: boolean): void {
    this.write(color('Local Agent ready', GREEN, this.plain));
    this.write(`Repository: ${repoRoot}`);
    this.write(`Model: ${model}`);
    this.write(`Approval: ${autoApprove ? 'session auto-approval' : 'confirm edits and commands'}`);
    this.write('Commands: /help /multiline /status /changes /undo /model /policy /clear /exit');
  }

  event(type: string, data: Record<string, unknown>, maxSteps: number): void {
    if (type === 'model_started')
      this.write(color(`[${String(data.step)}/${maxSteps}] Thinking...`, CYAN, this.plain));
    else if (type === 'model_output')
      this.write(color(String(data.summary ?? data.actionType ?? ''), YELLOW, this.plain));
    else if (type === 'tool_call') this.write(`Tool: ${String(data.tool)}`);
    else if (type === 'context_compacted') this.write('Context compacted.');
  }

  result(result: ToolLoopResult): void {
    const label = result.stopReason === 'completed' ? 'Completed' : 'Stopped';
    this.write(
      color(
        `${label}: ${result.summary}`,
        result.stopReason === 'completed' ? GREEN : YELLOW,
        this.plain
      )
    );
    if (result.changedFiles.length > 0) this.write(`Changed: ${result.changedFiles.join(', ')}`);
    if (result.verification.length > 0)
      this.write(`Verification: ${result.verification.join('; ')}`);
  }
}
