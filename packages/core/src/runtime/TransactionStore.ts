import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_POLICY } from '../policy/Policy.js';
import { evaluatePolicyOperation } from '../policy/validate.js';
import type { PatchApplicationMetadata } from '../tools/patch/applyDiff.js';
import { applyDiff } from '../tools/patch/applyDiff.js';
import { parseUnifiedDiff } from '../tools/patch/parseUnifiedDiff.js';

export interface TransactionEdit {
  patch: string;
  reversePatch: string;
  filesChanged: string[];
  appliedAt?: string;
  status?: 'prepared' | 'applied';
  targetPath?: string;
  beforeHash?: string | null;
  afterHash?: string | null;
}

export interface EditTransaction {
  id: string;
  requestId: string;
  status: 'active' | 'completed' | 'incomplete' | 'reverted';
  startedAt: string;
  endedAt?: string;
  edits: TransactionEdit[];
  verification: string[];
}

export class TransactionStore {
  constructor(
    private readonly directory: string,
    private readonly repoRoot: string
  ) {}

  async begin(requestId: string): Promise<EditTransaction> {
    await mkdir(this.directory, { recursive: true });
    const transaction: EditTransaction = {
      id: `${new Date().toISOString().replaceAll(':', '-')}-${Math.random().toString(36).slice(2, 8)}`,
      requestId,
      status: 'active',
      startedAt: new Date().toISOString(),
      edits: [],
      verification: [],
    };
    await this.write(transaction);
    return transaction;
  }

  async appendEdit(
    transaction: EditTransaction,
    patch: string,
    metadata: PatchApplicationMetadata
  ): Promise<EditTransaction> {
    const next: EditTransaction = {
      ...transaction,
      edits: [
        ...transaction.edits,
        {
          patch,
          reversePatch: metadata.files.map((file) => file.reversePatch).join('\n'),
          filesChanged: metadata.files.map((file) => file.path),
          appliedAt: metadata.appliedAt,
          status: 'applied',
        },
      ],
    };
    await this.write(next);
    return next;
  }

  async prepareEdit(
    transaction: EditTransaction,
    patch: string,
    reversePatch: string,
    targetPath: string,
    beforeContent: string | null,
    afterContent: string | null
  ): Promise<EditTransaction> {
    const next: EditTransaction = {
      ...transaction,
      edits: [
        ...transaction.edits,
        {
          patch,
          reversePatch,
          filesChanged: [targetPath],
          status: 'prepared',
          targetPath,
          beforeHash: contentHash(beforeContent),
          afterHash: contentHash(afterContent),
        },
      ],
    };
    await this.write(next);
    return next;
  }

  async markPreparedEditApplied(
    transaction: EditTransaction,
    editIndex: number,
    metadata: PatchApplicationMetadata
  ): Promise<EditTransaction> {
    const edits = [...transaction.edits];
    const prepared = edits[editIndex];
    if (!prepared || prepared.status !== 'prepared')
      throw new Error('Prepared transaction edit was not found.');
    edits[editIndex] = {
      ...prepared,
      status: 'applied',
      appliedAt: metadata.appliedAt,
      reversePatch: metadata.files.map((file) => file.reversePatch).join('\n'),
      filesChanged: metadata.files.map((file) => file.path),
    };
    const next = { ...transaction, edits };
    await this.write(next);
    return next;
  }

  async discardPreparedEdit(
    transaction: EditTransaction,
    editIndex: number
  ): Promise<EditTransaction> {
    const edits = transaction.edits.filter((_, index) => index !== editIndex);
    const next = { ...transaction, edits };
    await this.write(next);
    return next;
  }

  async appendVerification(
    transaction: EditTransaction,
    summary: string
  ): Promise<EditTransaction> {
    const next = { ...transaction, verification: [...transaction.verification, summary] };
    await this.write(next);
    return next;
  }

  async finish(
    transaction: EditTransaction,
    status: 'completed' | 'incomplete'
  ): Promise<EditTransaction> {
    const next = { ...transaction, status, endedAt: new Date().toISOString() };
    await this.write(next);
    return next;
  }

  async latest(): Promise<EditTransaction | null> {
    if (!existsSync(this.directory)) {
      return null;
    }
    const files = (await readdir(this.directory)).filter((file) => file.endsWith('.json')).sort();
    const latest = files.at(-1);
    if (!latest) {
      return null;
    }
    return JSON.parse(await readFile(path.join(this.directory, latest), 'utf8')) as EditTransaction;
  }

  async revert(transaction: EditTransaction): Promise<EditTransaction> {
    for (const edit of [...transaction.edits].reverse()) {
      if (edit.status === 'prepared' && edit.targetPath) {
        const currentHash = await this.currentHash(edit.targetPath);
        if (currentHash === edit.beforeHash) continue;
        if (currentHash !== edit.afterHash)
          throw new Error(
            `Cannot safely recover prepared edit for ${edit.targetPath}; current content matches neither journal state.`
          );
      }
      const reverseDiff = parseUnifiedDiff(edit.reversePatch);
      for (const file of reverseDiff.files) {
        const decision = evaluatePolicyOperation(
          { kind: 'apply', targetPath: path.resolve(this.repoRoot, file.path) },
          {
            ...DEFAULT_POLICY,
            allowedRepoRoots: [this.repoRoot],
            maxPatchSize: Number.MAX_SAFE_INTEGER,
            maxFileSize: Number.MAX_SAFE_INTEGER,
          },
          this.repoRoot
        );
        if (!decision.allowed) throw new Error(`Unsafe transaction path rejected: ${file.path}.`);
      }
      const result = await applyDiff(reverseDiff, this.repoRoot);
      if (!result.success) {
        throw new Error(result.error ?? 'Unable to revert transaction.');
      }
    }
    const next: EditTransaction = {
      ...transaction,
      status: 'reverted',
      endedAt: new Date().toISOString(),
    };
    await this.write(next);
    return next;
  }

  private async currentHash(relativePath: string): Promise<string | null> {
    const target = path.join(this.repoRoot, relativePath);
    const decision = evaluatePolicyOperation(
      { kind: 'read', targetPath: target },
      { ...DEFAULT_POLICY, allowedRepoRoots: [this.repoRoot] },
      this.repoRoot
    );
    if (!decision.allowed) throw new Error(`Unsafe transaction path rejected: ${relativePath}.`);
    if (!existsSync(target)) return null;
    return createHash('sha256')
      .update(await readFile(decision.normalizedTargetPath as string))
      .digest('hex');
  }

  private async write(transaction: EditTransaction): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${transaction.id}.json`);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(transaction, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  }
}

function contentHash(content: string | null): string | null {
  return content === null ? null : createHash('sha256').update(content).digest('hex');
}
