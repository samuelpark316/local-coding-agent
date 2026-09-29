/**
 * Policy validation and enforcement
 *
 * Validates policy schema and enforces path normalization,
 * command allowlisting, and file size limits.
 */

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_POLICY, type Policy } from './Policy.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function normalizeStringPath(inputPath: string): string {
  return inputPath.normalize('NFC');
}

function resolveExistingPath(inputPath: string): string {
  return realpathSync.native(inputPath);
}

function resolveParentPath(inputPath: string): string {
  const pathSegments: string[] = [];
  let currentPath = path.resolve(inputPath);

  while (!existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return path.resolve(inputPath);
    }

    pathSegments.unshift(path.basename(currentPath));
    currentPath = parentPath;
  }

  return path.join(resolveExistingPath(currentPath), ...pathSegments);
}

function resolvePolicyPath(inputPath: string, repoRoot: string): string {
  const normalizedInput = normalizeStringPath(inputPath);
  const absolutePath = path.isAbsolute(normalizedInput)
    ? path.resolve(normalizedInput)
    : path.resolve(repoRoot, normalizedInput);

  if (existsSync(absolutePath)) {
    return resolveExistingPath(absolutePath);
  }

  return resolveParentPath(absolutePath);
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);

  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export function validatePolicy(policy: unknown): policy is Policy {
  if (!isRecord(policy)) {
    return false;
  }

  if (
    !Array.isArray(policy.allowedRepoRoots) ||
    !policy.allowedRepoRoots.every((entry) => typeof entry === 'string')
  ) {
    return false;
  }

  if (
    !Array.isArray(policy.commandAllowlist) ||
    !policy.commandAllowlist.every((entry) => typeof entry === 'string')
  ) {
    return false;
  }

  if (
    !isNonNegativeInteger(policy.maxFileSize) ||
    !isNonNegativeInteger(policy.maxPatchSize) ||
    !isNonNegativeInteger(policy.maxFilesChanged)
  ) {
    return false;
  }

  if (!isRecord(policy.safeMode)) {
    return false;
  }

  return (
    typeof policy.safeMode.readOnly === 'boolean' &&
    typeof policy.safeMode.confirmApply === 'boolean' &&
    typeof policy.safeMode.confirmCommands === 'boolean'
  );
}

export function normalizePolicy(policy: unknown, repoRoot: string): Policy {
  if (!validatePolicy(policy)) {
    throw new Error('Policy does not match the expected schema.');
  }

  return {
    ...DEFAULT_POLICY,
    ...policy,
    allowedRepoRoots:
      policy.allowedRepoRoots.length > 0
        ? policy.allowedRepoRoots.map((entry) => resolvePolicyPath(entry, repoRoot))
        : [resolvePolicyPath(repoRoot, repoRoot)],
    commandAllowlist: policy.commandAllowlist.map((entry) => entry.trim()).filter(Boolean),
    safeMode: {
      ...DEFAULT_POLICY.safeMode,
      ...policy.safeMode,
    },
  };
}

export function normalizePath(targetPath: string, repoRoot: string): string {
  return resolvePolicyPath(targetPath, repoRoot);
}

export function isPathAllowed(targetPath: string, policy: Policy, repoRoot: string): boolean {
  const normalizedTargetPath = normalizePath(targetPath, repoRoot);
  const allowedRoots =
    policy.allowedRepoRoots.length > 0 ? policy.allowedRepoRoots : [path.resolve(repoRoot)];

  return allowedRoots.some((root) => {
    const normalizedRoot = resolvePolicyPath(root, repoRoot);
    return isWithinRoot(normalizedTargetPath, normalizedRoot);
  });
}

export function isCommandAllowed(command: string, policy: Policy): boolean {
  if (policy.commandAllowlist.length === 0) {
    return false;
  }

  const trimmedCommand = command.trim();
  if (trimmedCommand.length === 0) {
    return false;
  }

  return policy.commandAllowlist.some((allowedCommand) => allowedCommand.trim() === trimmedCommand);
}

export type PolicyOperation =
  | {
      kind: 'read';
      targetPath: string;
      fileSize?: number;
    }
  | {
      kind: 'apply';
      targetPath: string;
      patchSize?: number;
      filesChanged?: number;
    }
  | {
      kind: 'command';
      command: string;
    };

export interface PolicyDecision {
  allowed: boolean;
  requiresConfirmation: boolean;
  normalizedTargetPath?: string;
  reasons: string[];
}

export function evaluatePolicyOperation(
  operation: PolicyOperation,
  policy: Policy,
  repoRoot: string
): PolicyDecision {
  const reasons: string[] = [];

  if (operation.kind === 'command') {
    if (!isCommandAllowed(operation.command, policy)) {
      reasons.push(`Command "${operation.command}" is not in commandAllowlist.`);
    }

    return {
      allowed: reasons.length === 0,
      requiresConfirmation: policy.safeMode.confirmCommands,
      reasons,
    };
  }

  const normalizedTargetPath = normalizePath(operation.targetPath, repoRoot);

  if (!isPathAllowed(normalizedTargetPath, policy, repoRoot)) {
    reasons.push(`Path "${operation.targetPath}" resolves outside allowedRepoRoots.`);
  }

  if (operation.kind === 'read') {
    if (
      typeof operation.fileSize === 'number' &&
      Number.isFinite(operation.fileSize) &&
      operation.fileSize > policy.maxFileSize
    ) {
      reasons.push(
        `File size ${operation.fileSize} bytes exceeds maxFileSize ${policy.maxFileSize} bytes.`
      );
    }

    return {
      allowed: reasons.length === 0,
      requiresConfirmation: false,
      normalizedTargetPath,
      reasons,
    };
  }

  if (policy.safeMode.readOnly) {
    reasons.push('Patch application is blocked because safeMode.readOnly is true.');
  }

  if (
    typeof operation.patchSize === 'number' &&
    Number.isFinite(operation.patchSize) &&
    operation.patchSize > policy.maxPatchSize
  ) {
    reasons.push(
      `Patch size ${operation.patchSize} bytes exceeds maxPatchSize ${policy.maxPatchSize} bytes.`
    );
  }

  if (
    typeof operation.filesChanged === 'number' &&
    Number.isFinite(operation.filesChanged) &&
    operation.filesChanged > policy.maxFilesChanged
  ) {
    reasons.push(
      `Patch changes ${operation.filesChanged} files, exceeding maxFilesChanged ${policy.maxFilesChanged}.`
    );
  }

  return {
    allowed: reasons.length === 0,
    requiresConfirmation: policy.safeMode.confirmApply,
    normalizedTargetPath,
    reasons,
  };
}
