import type { Interface } from 'node:readline/promises';
import type { ApprovalOutcome, ApprovalRequest } from '@local-agent/core';

export async function promptForApproval(
  readline: Interface,
  request: ApprovalRequest,
  write: (message: string) => void
): Promise<ApprovalOutcome> {
  write(`[${request.risk.toUpperCase()}] ${request.summary}`);
  if (request.preview) {
    write(request.preview);
  }
  const answer = (await readline.question('Approve? [y/N/a/abort or feedback] ')).trim();
  const normalized = answer.toLowerCase();
  if (normalized === 'y' || normalized === 'yes') return { decision: 'approve' };
  if (normalized === 'a' || normalized === 'auto') return { decision: 'approve_session' };
  if (normalized === 'abort' || normalized === 'q' || normalized === 'quit')
    return { decision: 'abort' };
  if (normalized === '' || normalized === 'n' || normalized === 'no') return { decision: 'reject' };
  return { decision: 'reject', feedback: answer };
}
