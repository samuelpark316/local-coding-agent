import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_MODEL_CONFIG,
  DEFAULT_POLICY,
  type PatchApplicationMetadata,
  SessionStore,
  TransactionStore,
} from '@local-agent/core';

const AGENT_DIRNAME = '.agent';
const POLICY_FILENAME = 'policy.json';
const MODEL_FILENAME = 'model.json';
const STATE_FILENAME = 'state.json';
const SESSIONS_DIRNAME = 'sessions';
const PATCHES_DIRNAME = 'patches';
const TRANSACTIONS_DIRNAME = 'transactions';
const LAST_PATCH_FILENAME = 'last-proposed.patch';
const LAST_APPLIED_PATCH_FILENAME = 'last-applied.patch';
const LAST_APPLIED_REVERSE_PATCH_FILENAME = 'last-applied.reverse.patch';
const LAST_APPLIED_METADATA_FILENAME = 'last-applied.json';

interface AgentState {
  lastProposedPatchPath: string | null;
  lastAppliedPatchPath: string | null;
}

export interface AppliedPatchRecord extends PatchApplicationMetadata {
  patchPath: string;
  reversePatchPath: string;
}

export interface AgentPaths {
  repoRoot: string;
  agentDir: string;
  policyPath: string;
  modelPath: string;
  sessionsDir: string;
  patchesDir: string;
  transactionsDir: string;
  statePath: string;
  lastPatchPath: string;
  lastAppliedPatchPath: string;
  lastAppliedReversePatchPath: string;
  lastAppliedMetadataPath: string;
}

export interface AgentStatus {
  repoRoot: string;
  initialized: boolean;
  agentDir: string;
  policyExists: boolean;
  modelExists: boolean;
  sessionsDirExists: boolean;
  patchesDirExists: boolean;
  transactionsDirExists: boolean;
  pendingPatch: string | null;
  lastAppliedPatch: string | null;
  lastTransaction: {
    id: string;
    status: 'active' | 'completed' | 'incomplete' | 'reverted';
    changedFiles: string[];
  } | null;
  lastSession: {
    sessionId: string;
    command: string;
    status: 'running' | 'completed' | 'aborted' | 'error';
    startedAt: number;
    endedAt?: number;
    eventCount: number;
    summary?: string;
  } | null;
}

interface AgentStatusOptions {
  excludeSessionId?: string;
}

const DEFAULT_STATE: AgentState = {
  lastProposedPatchPath: null,
  lastAppliedPatchPath: null,
};

function hasRepoMarker(directory: string): boolean {
  return ['.agent', '.git', 'package.json'].some((marker) =>
    existsSync(path.join(directory, marker))
  );
}

export function resolveRepoRoot(startPath: string): string | null {
  let current = path.resolve(startPath);

  while (true) {
    if (hasRepoMarker(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

export function resolveInitRoot(startPath: string): string {
  return resolveRepoRoot(startPath) ?? path.resolve(startPath);
}

export function getAgentPaths(repoRoot: string): AgentPaths {
  const agentDir = path.join(repoRoot, AGENT_DIRNAME);

  return {
    repoRoot,
    agentDir,
    policyPath: path.join(agentDir, POLICY_FILENAME),
    modelPath: path.join(agentDir, MODEL_FILENAME),
    sessionsDir: path.join(agentDir, SESSIONS_DIRNAME),
    patchesDir: path.join(agentDir, PATCHES_DIRNAME),
    transactionsDir: path.join(agentDir, TRANSACTIONS_DIRNAME),
    statePath: path.join(agentDir, STATE_FILENAME),
    lastPatchPath: path.join(repoRoot, AGENT_DIRNAME, PATCHES_DIRNAME, LAST_PATCH_FILENAME),
    lastAppliedPatchPath: path.join(
      repoRoot,
      AGENT_DIRNAME,
      PATCHES_DIRNAME,
      LAST_APPLIED_PATCH_FILENAME
    ),
    lastAppliedReversePatchPath: path.join(
      repoRoot,
      AGENT_DIRNAME,
      PATCHES_DIRNAME,
      LAST_APPLIED_REVERSE_PATCH_FILENAME
    ),
    lastAppliedMetadataPath: path.join(
      repoRoot,
      AGENT_DIRNAME,
      PATCHES_DIRNAME,
      LAST_APPLIED_METADATA_FILENAME
    ),
  };
}

export async function initializeAgent(repoRoot: string): Promise<AgentPaths> {
  const paths = getAgentPaths(repoRoot);

  await mkdir(paths.agentDir, { recursive: true });
  await mkdir(paths.sessionsDir, { recursive: true });
  await mkdir(paths.patchesDir, { recursive: true });
  await mkdir(paths.transactionsDir, { recursive: true });

  if (!existsSync(paths.policyPath)) {
    const policy = {
      ...DEFAULT_POLICY,
      allowedRepoRoots: [repoRoot],
      safeMode: {
        ...DEFAULT_POLICY.safeMode,
      },
    };
    await writeFile(paths.policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  }

  if (!existsSync(paths.modelPath)) {
    await writeFile(
      paths.modelPath,
      `${JSON.stringify(
        {
          ...DEFAULT_MODEL_CONFIG,
        },
        null,
        2
      )}\n`,
      'utf8'
    );
  }

  if (!existsSync(paths.statePath)) {
    await writeFile(paths.statePath, `${JSON.stringify(DEFAULT_STATE, null, 2)}\n`, 'utf8');
  }

  return paths;
}

export async function readAgentState(repoRoot: string): Promise<AgentState> {
  const { statePath } = getAgentPaths(repoRoot);
  if (!existsSync(statePath)) {
    return DEFAULT_STATE;
  }

  const content = await readFile(statePath, 'utf8');
  return {
    ...DEFAULT_STATE,
    ...JSON.parse(content),
  };
}

export async function writeAgentState(
  repoRoot: string,
  state: Partial<AgentState>
): Promise<AgentState> {
  const { statePath } = getAgentPaths(repoRoot);
  const nextState = {
    ...(await readAgentState(repoRoot)),
    ...state,
  };

  await writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
  return nextState;
}

export async function recordAppliedPatch(
  repoRoot: string,
  proposedPatchPath: string,
  metadata: PatchApplicationMetadata
): Promise<AppliedPatchRecord> {
  const paths = getAgentPaths(repoRoot);
  const reversePatch = metadata.files
    .map((file) => file.reversePatch)
    .join('\n')
    .trim();

  await copyFile(proposedPatchPath, paths.lastAppliedPatchPath);
  await writeFile(
    paths.lastAppliedReversePatchPath,
    reversePatch.length > 0 ? `${reversePatch}\n` : '',
    'utf8'
  );

  const record: AppliedPatchRecord = {
    ...metadata,
    patchPath: paths.lastAppliedPatchPath,
    reversePatchPath: paths.lastAppliedReversePatchPath,
  };

  await writeFile(paths.lastAppliedMetadataPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await writeAgentState(repoRoot, {
    lastAppliedPatchPath: paths.lastAppliedPatchPath,
    lastProposedPatchPath: null,
  });

  return record;
}

export async function readAppliedPatchRecord(repoRoot: string): Promise<AppliedPatchRecord | null> {
  const paths = getAgentPaths(repoRoot);
  if (!existsSync(paths.lastAppliedMetadataPath)) {
    return null;
  }

  const content = await readFile(paths.lastAppliedMetadataPath, 'utf8');
  return JSON.parse(content) as AppliedPatchRecord;
}

export async function clearAppliedPatchRecord(repoRoot: string): Promise<void> {
  const paths = getAgentPaths(repoRoot);

  await Promise.all([
    rm(paths.lastAppliedPatchPath, { force: true }),
    rm(paths.lastAppliedReversePatchPath, { force: true }),
    rm(paths.lastAppliedMetadataPath, { force: true }),
  ]);

  await writeAgentState(repoRoot, {
    lastAppliedPatchPath: null,
  });
}

export async function getAgentStatus(
  startPath: string,
  options: AgentStatusOptions = {}
): Promise<AgentStatus> {
  const repoRoot = resolveRepoRoot(startPath) ?? path.resolve(startPath);
  const paths = getAgentPaths(repoRoot);
  const initialized = existsSync(paths.agentDir);
  const state = initialized ? await readAgentState(repoRoot) : DEFAULT_STATE;
  const sessions = initialized ? await new SessionStore(paths.sessionsDir).listSessions() : [];
  const latestSessionMetadata = sessions.find(
    (session) => session.sessionId !== options.excludeSessionId
  );
  const latestTransaction = initialized
    ? await new TransactionStore(paths.transactionsDir, repoRoot).latest()
    : null;

  return {
    repoRoot,
    initialized,
    agentDir: paths.agentDir,
    policyExists: existsSync(paths.policyPath),
    modelExists: existsSync(paths.modelPath),
    sessionsDirExists: existsSync(paths.sessionsDir),
    patchesDirExists: existsSync(paths.patchesDir),
    transactionsDirExists: existsSync(paths.transactionsDir),
    pendingPatch:
      state.lastProposedPatchPath && existsSync(state.lastProposedPatchPath)
        ? state.lastProposedPatchPath
        : null,
    lastAppliedPatch:
      state.lastAppliedPatchPath && existsSync(state.lastAppliedPatchPath)
        ? state.lastAppliedPatchPath
        : null,
    lastTransaction: latestTransaction
      ? {
          id: latestTransaction.id,
          status: latestTransaction.status,
          changedFiles: [...new Set(latestTransaction.edits.flatMap((edit) => edit.filesChanged))],
        }
      : null,
    lastSession: latestSessionMetadata
      ? {
          sessionId: latestSessionMetadata.sessionId,
          command: latestSessionMetadata.command,
          status: latestSessionMetadata.status,
          startedAt: latestSessionMetadata.startedAt,
          endedAt: latestSessionMetadata.endedAt,
          eventCount: latestSessionMetadata.eventCount,
          summary: latestSessionMetadata.summary,
        }
      : null,
  };
}
