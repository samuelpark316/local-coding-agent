import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Policy } from '../policy/Policy.js';
import { evaluatePolicyOperation } from '../policy/validate.js';
import type { EditTransaction, TransactionStore } from '../runtime/TransactionStore.js';
import { getGitDiff } from './git/diff.js';
import { getGitStatus } from './git/status.js';
import { applyDiff } from './patch/applyDiff.js';
import { parseUnifiedDiff } from './patch/parseUnifiedDiff.js';
import { validateDiff } from './patch/validateDiff.js';
import { RunCommandTool } from './shell/runCommand.js';

export interface ToolDescription {
  name: string;
  description: string;
  argumentSchema: Record<string, unknown>;
  example: Record<string, unknown>;
  risk: 'safe' | 'moderate' | 'high';
}

export interface ToolCallValidation {
  valid: boolean;
  error?: string;
  tool?: ToolDescription;
}

export interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  changedFiles?: string[];
  verification?: string;
  transaction?: EditTransaction;
}

export interface ApprovalRequest {
  tool: string;
  risk: 'moderate' | 'high';
  summary: string;
  preview?: string;
}

export type ApprovalOutcome =
  | { decision: 'approve' }
  | { decision: 'reject'; feedback?: string }
  | { decision: 'approve_session' }
  | { decision: 'abort' };

export interface ToolExecutionContext {
  repoRoot: string;
  policy: Policy;
  approval?: (request: ApprovalRequest) => Promise<ApprovalOutcome>;
  autoApprove?: boolean;
  transactionStore?: TransactionStore;
  transaction?: EditTransaction;
  requestId?: string;
  onEvent?: (type: string, data: Record<string, unknown>) => Promise<void> | void;
}

const DESCRIPTIONS: ToolDescription[] = [
  {
    name: 'list_files',
    description: 'List repository files matching an optional glob.',
    argumentSchema: objectSchema({}, { glob: { type: 'string' }, limit: integerSchema(1, 500) }),
    example: { glob: '**/*', limit: 200 },
    risk: 'safe',
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 file or inclusive line range.',
    argumentSchema: objectSchema(
      { path: { type: 'string', minLength: 1 } },
      { startLine: integerSchema(1), endLine: integerSchema(1) }
    ),
    example: { path: 'path/to/file.ext', startLine: 1, endLine: 200 },
    risk: 'safe',
  },
  {
    name: 'search_code',
    description: 'Search repository text with ripgrep.',
    argumentSchema: objectSchema(
      { query: { type: 'string', minLength: 1 } },
      { path: { type: 'string', minLength: 1 }, limit: integerSchema(1, 500) }
    ),
    example: { query: 'symbol_name', path: '.', limit: 100 },
    risk: 'safe',
  },
  {
    name: 'git_status',
    description: 'Read current git status.',
    argumentSchema: objectSchema({}),
    example: {},
    risk: 'safe',
  },
  {
    name: 'git_diff',
    description: 'Read current git diff.',
    argumentSchema: objectSchema({}, { staged: { type: 'boolean' } }),
    example: { staged: false },
    risk: 'safe',
  },
  {
    name: 'edit_file',
    description: 'Replace one exact, unique text block in a file.',
    argumentSchema: objectSchema({
      path: { type: 'string', minLength: 1 },
      oldText: { type: 'string', minLength: 1 },
      newText: { type: 'string' },
    }),
    example: { path: 'path/to/file.ext', oldText: 'exact text', newText: 'replacement' },
    risk: 'moderate',
  },
  {
    name: 'create_file',
    description: 'Create a new file that does not already exist.',
    argumentSchema: objectSchema({
      path: { type: 'string', minLength: 1 },
      content: { type: 'string' },
    }),
    example: { path: 'path/to/new-file.ext', content: '' },
    risk: 'moderate',
  },
  {
    name: 'replace_file',
    description:
      'Safely replace the complete contents of an existing file. Pass expectedHash from read_file when available.',
    argumentSchema: objectSchema(
      { path: { type: 'string', minLength: 1 }, content: { type: 'string' } },
      { expectedHash: { type: 'string', minLength: 64, maxLength: 64 } }
    ),
    example: {
      path: 'path/to/file.ext',
      content: 'complete replacement content',
    },
    risk: 'moderate',
  },
  {
    name: 'delete_file',
    description: 'Delete one existing file.',
    argumentSchema: objectSchema({ path: { type: 'string', minLength: 1 } }),
    example: { path: 'path/to/old-file.ext' },
    risk: 'high',
  },
  {
    name: 'run_command',
    description: 'Run an exact command allowed by repository policy.',
    argumentSchema: objectSchema(
      { command: { type: 'string', minLength: 1 } },
      { timeout: integerSchema(1, 600_000) }
    ),
    example: { command: 'exact allowlisted command', timeout: 120000 },
    risk: 'high',
  },
  {
    name: 'run_check',
    description: 'Run a discovered test check when its exact command is policy-allowed.',
    argumentSchema: objectSchema({ check: { type: 'string', enum: ['test', 'lint', 'build'] } }),
    example: { check: 'test' },
    risk: 'high',
  },
];

function integerSchema(minimum: number, maximum?: number): Record<string, unknown> {
  return { type: 'integer', minimum, ...(maximum === undefined ? {} : { maximum }) };
}

function objectSchema(
  required: Record<string, Record<string, unknown>>,
  optional: Record<string, Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    type: 'object',
    properties: { ...required, ...optional },
    required: Object.keys(required),
    additionalProperties: false,
  };
}

function validateValue(
  value: unknown,
  schema: Record<string, unknown>,
  label: string
): string | null {
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${label} must be a string.`;
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      return `${label} must not be empty.`;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      return `${label} is too long.`;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value))
      return `${label} must be one of: ${schema.enum.join(', ')}.`;
    return null;
  }
  if (schema.type === 'boolean')
    return typeof value === 'boolean' ? null : `${label} must be a boolean.`;
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return `${label} must be an integer.`;
    const numberValue = value as number;
    if (typeof schema.minimum === 'number' && numberValue < schema.minimum)
      return `${label} must be at least ${schema.minimum}.`;
    if (typeof schema.maximum === 'number' && numberValue > schema.maximum)
      return `${label} must be at most ${schema.maximum}.`;
    return null;
  }
  return null;
}

function stringArg(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${key} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
  }
  return value;
}

function bounded(value: string, max = 16_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n... [truncated]`;
}

function lineArray(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  return content.split('\n');
}

function buildWholeFilePatch(
  filePath: string,
  oldContent: string | null,
  newContent: string | null
): string {
  const oldLines = oldContent === null ? [] : lineArray(oldContent);
  const newLines = newContent === null ? [] : lineArray(newContent);
  const oldHeader = oldContent === null ? '/dev/null' : `a/${filePath}`;
  const newHeader = newContent === null ? '/dev/null' : `b/${filePath}`;
  const oldStart = oldLines.length === 0 ? 0 : 1;
  const newStart = newLines.length === 0 ? 0 : 1;
  return [
    `--- ${oldHeader}`,
    `+++ ${newHeader}`,
    `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

async function walk(directory: string, root: string, results: string[]): Promise<void> {
  const { readdir } = await import('node:fs/promises');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '.agent', 'node_modules'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute, root, results);
    else if (entry.isFile()) results.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
}

export class ToolDispatcher {
  describeTools(): ToolDescription[] {
    return DESCRIPTIONS.map((tool) => ({
      ...tool,
      argumentSchema: structuredClone(tool.argumentSchema),
      example: structuredClone(tool.example),
    }));
  }

  registeredToolNames(): Set<string> {
    return new Set(DESCRIPTIONS.map((tool) => tool.name));
  }

  validateCall(toolName: string, args: unknown): ToolCallValidation {
    const tool = DESCRIPTIONS.find((candidate) => candidate.name === toolName);
    if (!tool) return { valid: false, error: `Unknown tool: ${toolName}.` };
    if (!args || typeof args !== 'object' || Array.isArray(args))
      return { valid: false, error: `${toolName} args must be an object.`, tool };
    const record = args as Record<string, unknown>;
    const properties = tool.argumentSchema.properties as Record<string, Record<string, unknown>>;
    const required = new Set(tool.argumentSchema.required as string[]);
    const unknown = Object.keys(record).filter((key) => !(key in properties));
    if (unknown.length > 0)
      return {
        valid: false,
        error: `${toolName} args include unsupported keys: ${unknown.join(', ')}.`,
        tool,
      };
    for (const key of required) {
      if (!(key in record))
        return { valid: false, error: `${toolName} requires argument ${key}.`, tool };
    }
    for (const [key, value] of Object.entries(record)) {
      const error = validateValue(value, properties[key], `${toolName}.${key}`);
      if (error) return { valid: false, error, tool };
    }
    if (
      toolName === 'read_file' &&
      typeof record.startLine === 'number' &&
      typeof record.endLine === 'number' &&
      record.endLine < record.startLine
    )
      return { valid: false, error: 'read_file.endLine must be >= startLine.', tool };
    return { valid: true, tool };
  }

  async dispatch(
    tool: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const validation = this.validateCall(tool, args);
    if (!validation.valid) {
      const result = { success: false, code: 'invalid_arguments', error: validation.error };
      await context.onEvent?.('tool_result', { tool, success: false, error: result.error });
      return result;
    }
    await context.onEvent?.('tool_call', { tool, input: args });
    try {
      let result: ToolExecutionResult;
      if (tool === 'list_files') result = await this.listFiles(args, context);
      else if (tool === 'read_file') result = await this.readFile(args, context);
      else if (tool === 'search_code') result = await this.searchCode(args, context);
      else if (tool === 'git_status')
        result = { success: true, data: await getGitStatus(context.repoRoot) };
      else if (tool === 'git_diff')
        result = {
          success: true,
          data: bounded((await getGitDiff(context.repoRoot, args.staged === true)) ?? ''),
        };
      else if (tool === 'edit_file') result = await this.editFile(args, context);
      else if (tool === 'create_file') result = await this.createFile(args, context);
      else if (tool === 'replace_file') result = await this.replaceFile(args, context);
      else if (tool === 'delete_file') result = await this.deleteFile(args, context);
      else if (tool === 'run_command') result = await this.runCommand(args, context);
      else if (tool === 'run_check') result = await this.runCheck(args, context);
      else result = { success: false, code: 'unknown_tool', error: `Unknown tool: ${tool}.` };
      await context.onEvent?.('tool_result', {
        tool,
        success: result.success,
        output: result.data,
        error: result.error,
      });
      return result;
    } catch (error) {
      const errorCode =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : undefined;
      const result = {
        success: false,
        code: errorCode === 'ENOENT' ? 'not_found' : 'execution_failed',
        error: error instanceof Error ? error.message : 'Tool failed.',
      };
      await context.onEvent?.('tool_result', { tool, success: false, error: result.error });
      return result;
    }
  }

  private async listFiles(
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const files: string[] = [];
    await walk(context.repoRoot, context.repoRoot, files);
    const glob = typeof args.glob === 'string' ? args.glob : '**/*';
    const limit =
      typeof args.limit === 'number' ? Math.max(1, Math.min(500, Math.floor(args.limit))) : 200;
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('**', '§§')
      .replaceAll('*', '[^/]*')
      .replaceAll('§§', '.*')
      .replaceAll('?', '.');
    const matcher = new RegExp(`^${escaped}$`);
    return {
      success: true,
      data: files
        .filter((file) => matcher.test(file))
        .sort()
        .slice(0, limit),
    };
  }

  private async readFile(
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const filePath = stringArg(args, 'path');
    const absolute = path.resolve(context.repoRoot, filePath);
    const pathDecision = evaluatePolicyOperation(
      { kind: 'read', targetPath: absolute },
      context.policy,
      context.repoRoot
    );
    if (!pathDecision.allowed)
      return { success: false, code: 'policy_denied', error: pathDecision.reasons.join(' ') };
    const fileStat = await stat(absolute);
    const decision = evaluatePolicyOperation(
      { kind: 'read', targetPath: absolute, fileSize: fileStat.size },
      context.policy,
      context.repoRoot
    );
    await context.onEvent?.('policy_decision', {
      tool: 'read_file',
      allowed: decision.allowed,
      reasons: decision.reasons,
    });
    if (!decision.allowed)
      return { success: false, code: 'policy_denied', error: decision.reasons.join(' ') };
    const content = await readFile(absolute, 'utf8');
    const start = typeof args.startLine === 'number' ? Math.max(1, Math.floor(args.startLine)) : 1;
    const end =
      typeof args.endLine === 'number' ? Math.max(start, Math.floor(args.endLine)) : start + 399;
    return {
      success: true,
      data: {
        path: filePath,
        startLine: start,
        endLine: Math.min(end, Math.max(1, content.split('\n').length)),
        content: bounded(
          content
            .split('\n')
            .slice(start - 1, end)
            .join('\n')
        ),
        sha256: createHash('sha256').update(content).digest('hex'),
        size: fileStat.size,
      },
    };
  }

  private async searchCode(
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const query = stringArg(args, 'query');
    const target = typeof args.path === 'string' ? args.path : '.';
    const absolute = path.resolve(context.repoRoot, target);
    const decision = evaluatePolicyOperation(
      { kind: 'read', targetPath: absolute },
      context.policy,
      context.repoRoot
    );
    if (!decision.allowed)
      return { success: false, code: 'policy_denied', error: decision.reasons.join(' ') };
    const { spawn } = await import('node:child_process');
    const limit =
      typeof args.limit === 'number' ? Math.max(1, Math.min(500, Math.floor(args.limit))) : 100;
    return new Promise((resolve) => {
      const child = spawn('rg', ['--line-number', '--color', 'never', query, target], {
        cwd: context.repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) =>
        resolve({ success: false, code: 'execution_failed', error: error.message })
      );
      child.on('close', (code) =>
        resolve(
          code === 0 || code === 1
            ? { success: true, data: stdout.split('\n').filter(Boolean).slice(0, limit) }
            : {
                success: false,
                code: 'execution_failed',
                error: stderr.trim() || `rg exited ${code}`,
              }
        )
      );
    });
  }

  private async editFile(
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const filePath = stringArg(args, 'path');
    const oldText = stringArg(args, 'oldText');
    const newText = stringArg(args, 'newText', true);
    const absolute = path.resolve(context.repoRoot, filePath);
    const readDecision = evaluatePolicyOperation(
      { kind: 'read', targetPath: absolute },
      context.policy,
      context.repoRoot
    );
    if (!readDecision.allowed)
      return { success: false, code: 'policy_denied', error: readDecision.reasons.join(' ') };
    const fileStat = await stat(absolute);
    const sizeDecision = evaluatePolicyOperation(
      { kind: 'read', targetPath: absolute, fileSize: fileStat.size },
      context.policy,
      context.repoRoot
    );
    if (!sizeDecision.allowed)
      return { success: false, code: 'policy_denied', error: sizeDecision.reasons.join(' ') };
    const content = await readFile(absolute, 'utf8');
    const occurrences = content.split(oldText).length - 1;
    if (occurrences !== 1)
      return {
        success: false,
        code: occurrences === 0 ? 'match_missing' : 'match_ambiguous',
        error:
          occurrences === 0
            ? 'oldText was not found. Read the file again, then use exact current text or replace_file with its sha256.'
            : `oldText matched ${occurrences} times. Include more surrounding context or use replace_file with the read_file sha256.`,
      };
    return this.applyMutation(
      'edit_file',
      filePath,
      content,
      content.replace(oldText, newText),
      context
    );
  }

  private async createFile(
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const filePath = stringArg(args, 'path');
    const content = stringArg(args, 'content', true);
    const absolute = path.resolve(context.repoRoot, filePath);
    const decision = evaluatePolicyOperation(
      {
        kind: 'apply',
        targetPath: absolute,
        patchSize: Buffer.byteLength(content, 'utf8'),
        filesChanged: 1,
      },
      context.policy,
      context.repoRoot
    );
    if (!decision.allowed)
      return { success: false, code: 'policy_denied', error: decision.reasons.join(' ') };
    if (existsSync(absolute))
      return { success: false, code: 'already_exists', error: 'Target file already exists.' };
    return this.applyMutation('create_file', filePath, null, content, context);
  }

  private async replaceFile(
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const filePath = stringArg(args, 'path');
    const content = stringArg(args, 'content', true);
    const expectedHash =
      typeof args.expectedHash === 'string' ? args.expectedHash.toLowerCase() : undefined;
    const absolute = path.resolve(context.repoRoot, filePath);
    const readDecision = evaluatePolicyOperation(
      { kind: 'read', targetPath: absolute },
      context.policy,
      context.repoRoot
    );
    if (!readDecision.allowed)
      return { success: false, code: 'policy_denied', error: readDecision.reasons.join(' ') };
    const fileStat = await stat(absolute);
    if (!fileStat.isFile())
      return { success: false, code: 'not_a_file', error: 'replace_file only replaces files.' };
    const sizeDecision = evaluatePolicyOperation(
      { kind: 'read', targetPath: absolute, fileSize: fileStat.size },
      context.policy,
      context.repoRoot
    );
    if (!sizeDecision.allowed)
      return { success: false, code: 'policy_denied', error: sizeDecision.reasons.join(' ') };
    const current = await readFile(absolute, 'utf8');
    const currentHash = createHash('sha256').update(current).digest('hex');
    if (expectedHash && currentHash !== expectedHash)
      return {
        success: false,
        code: 'stale_content',
        error: 'expectedHash does not match current content; read_file again before replacing.',
      };
    return this.applyMutation('replace_file', filePath, current, content, context);
  }

  private async deleteFile(
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const filePath = stringArg(args, 'path');
    const absolute = path.resolve(context.repoRoot, filePath);
    const readDecision = evaluatePolicyOperation(
      { kind: 'read', targetPath: absolute },
      context.policy,
      context.repoRoot
    );
    if (!readDecision.allowed)
      return { success: false, code: 'policy_denied', error: readDecision.reasons.join(' ') };
    const fileStat = await stat(absolute);
    if (!fileStat.isFile())
      return { success: false, code: 'not_a_file', error: 'delete_file only deletes files.' };
    return this.applyMutation(
      'delete_file',
      filePath,
      await readFile(absolute, 'utf8'),
      null,
      context
    );
  }

  private async applyMutation(
    tool: string,
    filePath: string,
    oldContent: string | null,
    newContent: string | null,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const patch = buildWholeFilePatch(filePath, oldContent, newContent);
    const diff = parseUnifiedDiff(patch);
    const policyDecision = evaluatePolicyOperation(
      {
        kind: 'apply',
        targetPath: path.resolve(context.repoRoot, filePath),
        patchSize: Buffer.byteLength(patch, 'utf8'),
        filesChanged: 1,
      },
      context.policy,
      context.repoRoot
    );
    await context.onEvent?.('policy_decision', {
      tool,
      allowed: policyDecision.allowed,
      reasons: policyDecision.reasons,
    });
    if (!policyDecision.allowed) {
      return { success: false, code: 'policy_denied', error: policyDecision.reasons.join(' ') };
    }
    const validation = validateDiff(diff, context.policy, context.repoRoot);
    if (!validation.valid)
      return { success: false, code: 'policy_denied', error: validation.errors.join(' ') };
    await context.onEvent?.('patch_proposed', {
      patchPath: filePath,
      fileCount: 1,
      byteLength: Buffer.byteLength(patch, 'utf8'),
    });
    const approval = policyDecision.requiresConfirmation
      ? await this.approve(
          {
            tool,
            risk: tool === 'delete_file' ? 'high' : 'moderate',
            summary: `${tool} ${filePath}`,
            preview: bounded(patch, 8_000),
          },
          context
        )
      : { decision: 'approve' as const };
    if (approval.decision === 'abort')
      return { success: false, code: 'user_aborted', error: 'User aborted the request.' };
    if (approval.decision === 'reject')
      return {
        success: false,
        code: 'user_rejected',
        error: approval.feedback
          ? `User feedback: ${approval.feedback}`
          : 'User rejected the operation.',
      };
    const revalidation = evaluatePolicyOperation(
      {
        kind: 'apply',
        targetPath: path.resolve(context.repoRoot, filePath),
        patchSize: Buffer.byteLength(patch, 'utf8'),
        filesChanged: 1,
      },
      context.policy,
      context.repoRoot
    );
    if (!revalidation.allowed)
      return { success: false, code: 'policy_denied', error: revalidation.reasons.join(' ') };
    if (oldContent === null && existsSync(revalidation.normalizedTargetPath as string))
      return {
        success: false,
        code: 'stale_content',
        error: 'Target appeared after preview; create_file will not overwrite it.',
      };
    const current =
      oldContent === null
        ? null
        : await readFile(revalidation.normalizedTargetPath as string, 'utf8');
    if (current !== oldContent)
      return {
        success: false,
        code: 'stale_content',
        error: 'File changed after preview; inspect it again.',
      };
    let transaction = context.transaction;
    if (context.transactionStore && !transaction)
      transaction = await context.transactionStore.begin(
        context.requestId ?? `request-${Date.now()}`
      );
    let preparedIndex: number | undefined;
    if (context.transactionStore && transaction) {
      const reversePatch = buildWholeFilePatch(filePath, newContent, oldContent);
      transaction = await context.transactionStore.prepareEdit(
        transaction,
        patch,
        reversePatch,
        filePath,
        oldContent,
        newContent
      );
      preparedIndex = transaction.edits.length - 1;
    }
    const applied = await applyDiff(diff, context.repoRoot);
    if (!applied.success || !applied.metadata) {
      if (context.transactionStore && transaction && preparedIndex !== undefined)
        transaction = await context.transactionStore.discardPreparedEdit(
          transaction,
          preparedIndex
        );
      return {
        success: false,
        code: 'apply_failed',
        error: applied.error ?? 'Patch apply failed.',
        transaction,
      };
    }
    if (context.transactionStore && transaction && preparedIndex !== undefined)
      transaction = await context.transactionStore.markPreparedEditApplied(
        transaction,
        preparedIndex,
        applied.metadata
      );
    await context.onEvent?.('patch_applied', {
      patchPath: filePath,
      filesChanged: applied.filesChanged,
    });
    return {
      success: true,
      data: { patch, filesChanged: applied.filesChanged },
      changedFiles: applied.filesChanged,
      transaction,
    };
  }

  private async runCommand(
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const command = stringArg(args, 'command');
    const decision = evaluatePolicyOperation(
      { kind: 'command', command },
      context.policy,
      context.repoRoot
    );
    if (!decision.allowed)
      return { success: false, code: 'policy_denied', error: decision.reasons.join(' ') };
    if (decision.requiresConfirmation) {
      const approval = await this.approve(
        { tool: 'run_command', risk: 'high', summary: `Run ${command}` },
        context
      );
      if (approval.decision === 'abort')
        return { success: false, code: 'user_aborted', error: 'User aborted the request.' };
      if (approval.decision === 'reject')
        return {
          success: false,
          code: 'user_rejected',
          error: approval.feedback
            ? `User feedback: ${approval.feedback}`
            : 'User rejected the command.',
        };
    }
    const runner = new RunCommandTool({
      repoRoot: context.repoRoot,
      policy: context.policy,
      defaultTimeoutMs: 120_000,
      maxOutputBytes: 128 * 1024,
    });
    await context.onEvent?.('command_started', { command, cwd: context.repoRoot });
    const result = await runner.execute({
      command,
      timeout: typeof args.timeout === 'number' ? args.timeout : undefined,
    });
    if (!result.success || !result.data)
      return { success: false, code: 'execution_failed', error: result.error ?? 'Command failed.' };
    await context.onEvent?.('command_output', {
      stream: 'system',
      message: `${command}: exit=${result.data.exitCode} timedOut=${result.data.timedOut} truncated=${result.data.truncated}`,
    });
    const summary = `${command}: exit=${result.data.exitCode} timedOut=${result.data.timedOut} truncated=${result.data.truncated}`;
    if (result.data.exitCode !== 0 || result.data.timedOut)
      return {
        success: false,
        code: result.data.timedOut ? 'timeout' : 'command_failed',
        error: summary,
        data: {
          ...result.data,
          stdout: bounded(result.data.stdout),
          stderr: bounded(result.data.stderr),
        },
        transaction: context.transaction,
      };
    let transaction = context.transaction;
    if (context.transactionStore && transaction)
      transaction = await context.transactionStore.appendVerification(transaction, summary);
    return {
      success: true,
      data: {
        ...result.data,
        stdout: bounded(result.data.stdout),
        stderr: bounded(result.data.stderr),
      },
      verification: summary,
      transaction,
    };
  }

  private async runCheck(
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const check = stringArg(args, 'check');
    const candidates: Record<string, string[]> = {
      test: ['npm test', 'pnpm test', 'yarn test', 'pytest', 'go test ./...'],
      lint: ['npm run lint', 'pnpm lint', 'yarn lint'],
      build: ['npm run build', 'pnpm build', 'yarn build', 'go build ./...'],
    };
    const command = (candidates[check] ?? []).find((candidate) =>
      context.policy.commandAllowlist.includes(candidate)
    );
    if (!command)
      return {
        success: false,
        code: 'check_unavailable',
        error: `No policy-allowed ${check} check was discovered.`,
      };
    return this.runCommand({ command }, context);
  }

  private async approve(
    request: ApprovalRequest,
    context: ToolExecutionContext
  ): Promise<ApprovalOutcome> {
    await context.onEvent?.('approval_requested', {
      tool: request.tool,
      risk: request.risk,
      summary: request.summary,
    });
    const outcome = context.autoApprove
      ? { decision: 'approve' as const }
      : context.approval
        ? await context.approval(request)
        : { decision: 'reject' as const, feedback: 'Confirmation is required.' };
    await context.onEvent?.('approval_resolved', {
      tool: request.tool,
      decision: outcome.decision,
    });
    return outcome;
  }
}
