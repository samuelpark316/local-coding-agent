import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AgentRunner,
  applyDiff,
  OllamaAdapter,
  parseUnifiedDiff,
  RunCommandTool,
  rollbackLastPatch,
  TransactionStore,
  validateDiff,
} from '@local-agent/core';
import {
  clearAppliedPatchRecord,
  getAgentPaths,
  getAgentStatus,
  initializeAgent,
  readAgentState,
  readAppliedPatchRecord,
  recordAppliedPatch,
  resolveInitRoot,
  resolveRepoRoot,
  writeAgentState,
} from '../lib/agentFs.js';
import { CliCommandError } from '../lib/commandHelpers.js';
import { type DoctorOptions, formatDoctorReport, runDoctorChecks } from '../lib/doctor.js';
import { loadModelConfig } from '../lib/model.js';
import type { CommandResult } from '../lib/output.js';
import { discoverTestCommand, loadAgentPolicy, requirePolicyApproval } from '../lib/policy.js';
import type { CliRuntime } from '../lib/runtime.js';
import { readSessionById } from '../lib/session.js';
import { formatDiff } from '../ui/diffView.js';
import { confirmApply, confirmCommand } from '../ui/prompts.js';

interface ConfirmationOptions {
  autopilot?: boolean;
  dryRun?: boolean;
  explainPatch?: boolean;
  noApply?: boolean;
  plain?: boolean;
  yes?: boolean;
}

async function requireInteractiveConfirmation(
  runtime: CliRuntime,
  options: ConfirmationOptions,
  needsConfirmation: boolean,
  prompt: () => Promise<boolean>,
  description: string
): Promise<void> {
  if (!needsConfirmation || options.yes) {
    return;
  }

  if (!runtime.io.isInteractive) {
    throw new CliCommandError(
      `Confirmation required before ${description}, but no TTY is available. Re-run with --yes or update policy.json.`
    );
  }

  const confirmed = await prompt();
  if (!confirmed) {
    throw new CliCommandError(`Aborted ${description}.`, 1, {
      confirmed: false,
    });
  }
}

async function queuePatch(repoRoot: string, patch: string): Promise<string> {
  const { lastPatchPath } = getAgentPaths(repoRoot);
  await writeFile(lastPatchPath, `${patch.trimEnd()}\n`, 'utf8');
  await writeAgentState(repoRoot, {
    lastProposedPatchPath: lastPatchPath,
  });
  return lastPatchPath;
}

async function applyQueuedPatch(
  runtime: CliRuntime,
  repoRoot: string,
  policy: Awaited<ReturnType<typeof loadAgentPolicy>>,
  pendingPatchPath: string,
  options: ConfirmationOptions
): Promise<{ filesChanged: string[]; appliedAt: string }> {
  const pendingPatchStat = await stat(pendingPatchPath).catch(() => null);
  if (!pendingPatchStat) {
    throw new CliCommandError('The queued patch file no longer exists.', 1, {
      pendingPatch: pendingPatchPath,
    });
  }

  const decision = requirePolicyApproval(policy, repoRoot, {
    kind: 'apply',
    targetPath: pendingPatchPath,
    patchSize: pendingPatchStat.size,
  });

  await requireInteractiveConfirmation(
    runtime,
    options,
    decision.requiresConfirmation,
    async () => confirmApply(runtime.io, [path.basename(pendingPatchPath)]),
    'applying the pending patch'
  );

  const diffText = await readFile(pendingPatchPath, 'utf8').catch(() => {
    throw new CliCommandError('Unable to read the queued patch file.', 1, {
      pendingPatch: pendingPatchPath,
    });
  });

  await runtime.sessionStore?.appendEvent('patch_proposed', {
    patchPath: pendingPatchPath,
    byteLength: Buffer.byteLength(diffText, 'utf8'),
  });

  let diff: ReturnType<typeof parseUnifiedDiff>;
  try {
    diff = parseUnifiedDiff(diffText);
  } catch (error) {
    throw new CliCommandError(error instanceof Error ? error.message : 'Invalid unified diff.', 1);
  }

  const validation = validateDiff(diff, policy, repoRoot);
  if (!validation.valid) {
    throw new CliCommandError(validation.errors.join(' '), 1);
  }

  const applyResult = await applyDiff(diff, repoRoot);
  if (!applyResult.success || !applyResult.metadata) {
    throw new CliCommandError(applyResult.error ?? 'Patch application failed.', 1);
  }

  await runtime.sessionStore?.appendEvent('patch_applied', {
    patchPath: pendingPatchPath,
    filesChanged: applyResult.filesChanged,
    dryRun: false,
  });

  const record = await recordAppliedPatch(repoRoot, pendingPatchPath, applyResult.metadata);
  await rm(pendingPatchPath, { force: true });

  return {
    filesChanged: applyResult.filesChanged,
    appliedAt: record.appliedAt,
  };
}

async function executeAllowlistedCommand(
  runtime: CliRuntime,
  repoRoot: string,
  policy: Awaited<ReturnType<typeof loadAgentPolicy>>,
  commandToRun: string,
  options: ConfirmationOptions,
  timeoutMs = 120_000
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}> {
  await runtime.sessionStore?.appendEvent('command_started', {
    command: commandToRun,
    argv: commandToRun.split(' '),
    cwd: repoRoot,
  });

  const decision = requirePolicyApproval(policy, repoRoot, {
    kind: 'command',
    command: commandToRun,
  });

  await requireInteractiveConfirmation(
    runtime,
    options,
    decision.requiresConfirmation,
    async () => confirmCommand(runtime.io, commandToRun),
    `running "${commandToRun}"`
  );

  const runner = new RunCommandTool({
    repoRoot,
    policy,
    defaultTimeoutMs: timeoutMs,
    maxOutputBytes: 128 * 1024,
  });
  const result = await runner.execute({
    command: commandToRun,
    timeout: timeoutMs,
  });
  if (!result.success || !result.data) {
    throw new CliCommandError(result.error ?? 'Command execution failed.');
  }

  const summary = [
    `exit=${result.data.exitCode}`,
    `timedOut=${result.data.timedOut}`,
    `truncated=${result.data.truncated}`,
  ].join(' ');

  await runtime.sessionStore?.appendEvent('command_output', {
    stream: 'system',
    message: `Command result for "${commandToRun}": ${summary}`,
  });

  if (result.data.stdout.trim().length > 0) {
    await runtime.sessionStore?.appendEvent('command_output', {
      stream: 'stdout',
      message: result.data.stdout.slice(0, 2_000),
    });
  }
  if (result.data.stderr.trim().length > 0) {
    await runtime.sessionStore?.appendEvent('command_output', {
      stream: 'stderr',
      message: result.data.stderr.slice(0, 2_000),
    });
  }

  return result.data;
}

export async function handleInit(cwd: string): Promise<CommandResult> {
  const repoRoot = resolveInitRoot(cwd);
  const paths = await initializeAgent(repoRoot);

  return {
    ok: true,
    message: `Initialized agent configuration in ${paths.agentDir}`,
    data: {
      repoRoot,
      agentDir: paths.agentDir,
      policyPath: paths.policyPath,
      modelPath: paths.modelPath,
      sessionsDir: paths.sessionsDir,
      patchesDir: paths.patchesDir,
      transactionsDir: paths.transactionsDir,
    },
    human: [
      `Initialized agent configuration in ${paths.agentDir}`,
      `Policy: ${paths.policyPath}`,
      'Telemetry: disabled by default',
      `Model config: ${paths.modelPath}`,
      `Sessions: ${paths.sessionsDir}`,
      `Patches: ${paths.patchesDir}`,
      `Transactions: ${paths.transactionsDir}`,
    ],
  };
}

export async function handleAsk(
  runtime: CliRuntime,
  task: string,
  options: {
    autopilot?: boolean;
    dryRun?: boolean;
    explainPatch?: boolean;
    noApply?: boolean;
    plain?: boolean;
    yes?: boolean;
  }
): Promise<CommandResult> {
  const repoRoot = resolveRepoRoot(runtime.cwd);
  if (!repoRoot) {
    throw new CliCommandError(
      'No repository root found. Run `agent init` from your project first.'
    );
  }

  const status = await getAgentStatus(repoRoot);
  if (!status.initialized) {
    throw new CliCommandError(
      'Agent is not initialized in this repository. Run `agent init` first.'
    );
  }

  const modelConfig = await loadModelConfig(repoRoot);
  const policy = await loadAgentPolicy(repoRoot);
  const adapter = OllamaAdapter.fromModelConfig(modelConfig);
  const serverAvailable = await adapter.checkServer();
  if (!serverAvailable) {
    throw new CliCommandError(
      `Ollama server is unavailable at ${modelConfig.baseUrl}. Start it with: ollama serve`
    );
  }

  const runner = new AgentRunner({
    llm: adapter,
    onEvent: async (type, data) => {
      await runtime.sessionStore?.appendEvent(type, data);
    },
  });

  let runResult: Awaited<ReturnType<AgentRunner['run']>>;
  try {
    runResult = await runner.run({
      task,
      repoRoot,
      llmOptions: {
        temperature: modelConfig.temperature,
        contextLimit: modelConfig.contextLimit,
      },
    });
  } catch (error) {
    const rawModelOutput =
      error && typeof error === 'object' && 'rawModelOutput' in error
        ? (error.rawModelOutput as string | undefined)
        : undefined;
    throw new CliCommandError(
      error instanceof Error ? error.message : 'Ollama request failed unexpectedly.',
      1,
      rawModelOutput ? { rawModelOutput } : undefined
    );
  }

  const output = runResult.output;
  const autopilotEnabled = Boolean(options.autopilot && !options.noApply);

  let queuedPatchPath: string | null = null;
  if (output.patch && output.patch.trim().length > 0) {
    let diff: ReturnType<typeof parseUnifiedDiff>;
    try {
      diff = parseUnifiedDiff(output.patch);
    } catch (error) {
      throw new CliCommandError(error instanceof Error ? error.message : 'Invalid unified diff.');
    }

    const validation = validateDiff(diff, policy, repoRoot);
    if (!validation.valid) {
      throw new CliCommandError(validation.errors.join(' '));
    }
    if (!options.dryRun) {
      queuedPatchPath = await queuePatch(repoRoot, output.patch);
    }
  }

  let patchExplanation: string | null = null;
  if (options.explainPatch && output.patch) {
    try {
      const explanation = await adapter.complete(
        `Explain this unified diff in concise bullet points, including risk notes:\n\n${output.patch}`,
        {
          temperature: 0.2,
          contextLimit: modelConfig.contextLimit,
        }
      );
      patchExplanation = explanation.content.trim();
    } catch (error) {
      patchExplanation = `Unable to explain patch: ${
        error instanceof Error ? error.message : 'unknown error'
      }`;
    }
  }

  const commandToRun = discoverTestCommand(repoRoot, policy);
  if (autopilotEnabled && output.patch && queuedPatchPath && !options.dryRun) {
    let latestPlan = output.plan;
    let latestPatchPath = queuedPatchPath;
    let latestPatch = output.patch;
    let lastTestResult: Awaited<ReturnType<typeof executeAllowlistedCommand>> | null = null;
    const testCommand = commandToRun;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await applyQueuedPatch(runtime, repoRoot, policy, latestPatchPath, options);

      if (!testCommand) {
        return {
          ok: true,
          message: 'Autopilot applied patch, but no allowlisted test command was discovered.',
          data: {
            task,
            repoRoot,
            model: modelConfig.model,
            plan: latestPlan,
            attemptedAutopilot: true,
            applied: true,
            testCommand: null,
          },
          human: [
            `Task: ${task}`,
            `Model: ${modelConfig.model}`,
            `Plan: ${latestPlan}`,
            'Autopilot applied the patch.',
            'No allowlisted test command was discovered.',
          ],
        };
      }

      const testResult = await executeAllowlistedCommand(
        runtime,
        repoRoot,
        policy,
        testCommand,
        options
      );
      lastTestResult = testResult;

      if (testResult.exitCode === 0 && !testResult.timedOut) {
        return {
          ok: true,
          message: 'Autopilot applied patch and tests passed.',
          data: {
            task,
            repoRoot,
            model: modelConfig.model,
            plan: latestPlan,
            attemptedAutopilot: true,
            applied: true,
            testCommand: testCommand,
            testExitCode: testResult.exitCode,
            timedOut: testResult.timedOut,
          },
          human: [
            `Task: ${task}`,
            `Model: ${modelConfig.model}`,
            `Plan: ${latestPlan}`,
            'Autopilot applied the patch.',
            `Test command: ${testCommand}`,
            `Test exit code: ${testResult.exitCode}`,
          ],
        };
      }

      if (attempt === 2) {
        break;
      }

      const followupTask = `${task}

Previous attempt failed tests using:
${testCommand}

Exit code: ${testResult.exitCode}
Timed out: ${testResult.timedOut}
STDOUT:
${testResult.stdout.slice(0, 2_000)}
STDERR:
${testResult.stderr.slice(0, 2_000)}

Provide a minimal corrective patch.`;

      const followupRun = await runner.run({
        task: followupTask,
        repoRoot,
        llmOptions: {
          temperature: modelConfig.temperature,
          contextLimit: modelConfig.contextLimit,
        },
      });
      if (!followupRun.output.patch || followupRun.output.patch.trim().length === 0) {
        throw new CliCommandError(
          'Autopilot fix iteration did not return a patch. Stopping with current diff.',
          1,
          {
            attempt,
            testCommand,
            testExitCode: testResult.exitCode,
          }
        );
      }

      const followupDiff = parseUnifiedDiff(followupRun.output.patch);
      const followupValidation = validateDiff(followupDiff, policy, repoRoot);
      if (!followupValidation.valid) {
        throw new CliCommandError(followupValidation.errors.join(' '), 1, {
          attempt,
          testCommand,
        });
      }

      latestPlan = followupRun.output.plan;
      latestPatch = followupRun.output.patch;
      latestPatchPath = await queuePatch(repoRoot, latestPatch);
    }

    throw new CliCommandError(
      'Autopilot stopped after two failing test runs. Latest diff remains applied for inspection.',
      1,
      {
        task,
        repoRoot,
        testCommand,
        testExitCode: lastTestResult?.exitCode ?? null,
        timedOut: lastTestResult?.timedOut ?? null,
      }
    );
  }

  return {
    ok: true,
    message: `Generated model response for task: ${task}`,
    data: {
      task,
      repoRoot,
      model: modelConfig.model,
      plan: output.plan,
      commands: output.commands,
      done: output.done,
      toolCalls: output.tool_calls,
      context: runResult.context,
      proposedPatchFileCount: runResult.proposedPatchFileCount,
      autopilot: autopilotEnabled,
      dryRun: options.dryRun ?? false,
      noApply: options.noApply ?? false,
      queuedPatchPath,
      patchExplanation,
    },
    human: [
      `Task: ${task}`,
      `Model: ${modelConfig.model}`,
      `Plan: ${output.plan}`,
      `Patch: ${queuedPatchPath ? queuedPatchPath : 'none'}`,
      `Autopilot: ${autopilotEnabled ? 'enabled' : 'disabled'}`,
      `Suggested commands: ${output.commands.length > 0 ? output.commands.join('; ') : 'none'}`,
      ...(output.patch
        ? ['Diff preview:', ...formatDiff(output.patch, options.plain ?? false)]
        : []),
      ...(patchExplanation ? ['Patch explanation:', patchExplanation] : []),
    ],
  };
}

export async function handleApply(
  runtime: CliRuntime,
  options: ConfirmationOptions
): Promise<CommandResult> {
  const repoRoot = resolveRepoRoot(runtime.cwd);
  if (!repoRoot) {
    throw new CliCommandError(
      'No repository root found. Run `agent init` from your project first.'
    );
  }

  const status = await getAgentStatus(repoRoot);
  if (!status.initialized) {
    throw new CliCommandError(
      'Agent is not initialized in this repository. Run `agent init` first.'
    );
  }

  const policy = await loadAgentPolicy(repoRoot);
  const state = await readAgentState(repoRoot);
  if (!state.lastProposedPatchPath) {
    throw new CliCommandError(
      'No patch is currently queued. Run `agent ask` once patch generation exists.'
    );
  }

  const pendingPatchPath = state.lastProposedPatchPath;
  const pendingPatchStat = await stat(pendingPatchPath).catch(() => null);
  if (!pendingPatchStat) {
    throw new CliCommandError('The queued patch file no longer exists.', 1, {
      pendingPatch: pendingPatchPath,
    });
  }

  if (!options.dryRun) {
    const decision = requirePolicyApproval(policy, repoRoot, {
      kind: 'apply',
      targetPath: pendingPatchPath,
      patchSize: pendingPatchStat?.size,
    });

    await requireInteractiveConfirmation(
      runtime,
      options,
      decision.requiresConfirmation,
      async () => confirmApply(runtime.io, [path.basename(pendingPatchPath)]),
      'applying the pending patch'
    );
  }

  let diffText: string;

  try {
    diffText = await readFile(pendingPatchPath, 'utf8');
  } catch {
    throw new CliCommandError('Unable to read the queued patch file.', 1, {
      pendingPatch: pendingPatchPath,
    });
  }

  await runtime.sessionStore?.appendEvent('patch_proposed', {
    patchPath: pendingPatchPath,
    byteLength: Buffer.byteLength(diffText, 'utf8'),
  });

  let diff: ReturnType<typeof parseUnifiedDiff>;
  try {
    diff = parseUnifiedDiff(diffText);
  } catch (error) {
    throw new CliCommandError(error instanceof Error ? error.message : 'Invalid unified diff.', 1);
  }

  const validation = validateDiff(diff, policy, repoRoot);
  if (!validation.valid) {
    throw new CliCommandError(validation.errors.join(' '), 1);
  }

  if (options.dryRun) {
    return {
      ok: true,
      message: `Dry-run succeeded. Patch touching ${diff.files.length} file(s) passed validation.`,
      data: {
        repoRoot,
        dryRun: true,
        filesChanged: diff.files.map((file) => file.path),
      },
      human: [
        `Dry-run succeeded. Patch touching ${diff.files.length} file(s) passed validation.`,
        'Diff preview:',
        ...formatDiff(diffText, options.plain ?? false),
      ],
    };
  }

  const applyResult = await applyDiff(diff, repoRoot);
  if (!applyResult.success || !applyResult.metadata) {
    throw new CliCommandError(applyResult.error ?? 'Patch application failed.', 1);
  }

  await runtime.sessionStore?.appendEvent('patch_applied', {
    patchPath: pendingPatchPath,
    filesChanged: applyResult.filesChanged,
    dryRun: false,
  });

  const record = await recordAppliedPatch(repoRoot, pendingPatchPath, applyResult.metadata);
  await rm(pendingPatchPath, { force: true });

  return {
    ok: true,
    message: `Applied patch touching ${applyResult.filesChanged.length} file(s).`,
    data: {
      repoRoot,
      filesChanged: applyResult.filesChanged,
      appliedAt: record.appliedAt,
    },
    human: [
      `Applied patch touching ${applyResult.filesChanged.length} file(s).`,
      ...applyResult.filesChanged.map((filePath) => `Changed: ${filePath}`),
    ],
  };
}

export async function handleStatus(runtime: CliRuntime): Promise<CommandResult> {
  const status = await getAgentStatus(runtime.cwd, {
    excludeSessionId: runtime.sessionStore?.getMetadata()?.sessionId,
  });
  const lastSessionLines = status.lastSession
    ? [
        `Last session: ${status.lastSession.sessionId}`,
        `Last command: ${status.lastSession.command}`,
        `Last result: ${status.lastSession.status}`,
        `Last summary: ${status.lastSession.summary ?? 'n/a'}`,
        `Last events: ${status.lastSession.eventCount}`,
      ]
    : ['Last session: none'];

  return {
    ok: true,
    message: status.initialized
      ? 'Agent repository is initialized.'
      : 'Agent repository is not initialized.',
    data: status,
    human: [
      'Agent Status',
      `Repo root: ${status.repoRoot}`,
      `Initialized: ${status.initialized ? 'yes' : 'no'}`,
      `Agent dir: ${status.agentDir}`,
      `Policy file: ${status.policyExists ? 'present' : 'missing'}`,
      'Telemetry: off',
      `Model file: ${status.modelExists ? 'present' : 'missing'}`,
      `Sessions dir: ${status.sessionsDirExists ? 'present' : 'missing'}`,
      `Patches dir: ${status.patchesDirExists ? 'present' : 'missing'}`,
      `Transactions dir: ${status.transactionsDirExists ? 'present' : 'missing'}`,
      `Pending patch: ${status.pendingPatch ?? 'none'}`,
      `Last applied patch: ${status.lastAppliedPatch ?? 'none'}`,
      `Last transaction: ${status.lastTransaction?.id ?? 'none'}`,
      `Transaction status: ${status.lastTransaction?.status ?? 'n/a'}`,
      `Transaction files: ${status.lastTransaction?.changedFiles.join(', ') || 'none'}`,
      ...lastSessionLines,
    ],
  };
}

export async function handleTest(
  runtime: CliRuntime,
  options: ConfirmationOptions
): Promise<CommandResult> {
  const repoRoot = resolveRepoRoot(runtime.cwd);
  if (!repoRoot) {
    throw new CliCommandError(
      'No repository root found. Run `agent init` from your project first.'
    );
  }

  const status = await getAgentStatus(repoRoot);
  if (!status.initialized) {
    throw new CliCommandError(
      'Agent is not initialized in this repository. Run `agent init` first.'
    );
  }

  const policy = await loadAgentPolicy(repoRoot);
  const selectedCommand = discoverTestCommand(repoRoot, policy);

  if (!selectedCommand) {
    throw new CliCommandError(
      'No allowlisted test command is configured. Update .agent/policy.json first.'
    );
  }

  const commandToRun = selectedCommand;
  const execution = await executeAllowlistedCommand(
    runtime,
    repoRoot,
    policy,
    commandToRun,
    options
  );
  const timedOutSuffix = execution.timedOut ? ' (timed out)' : '';
  const truncatedSuffix = execution.truncated ? ' (output truncated)' : '';

  if (execution.exitCode !== 0 || execution.timedOut) {
    throw new CliCommandError(
      `Test command failed with exit code ${execution.exitCode}${timedOutSuffix}${truncatedSuffix}.`,
      1,
      {
        repoRoot,
        command: commandToRun,
        exitCode: execution.exitCode,
        timedOut: execution.timedOut,
        truncated: execution.truncated,
        stdout: execution.stdout,
        stderr: execution.stderr,
      }
    );
  }

  return {
    ok: true,
    message: `Test command completed successfully${truncatedSuffix}.`,
    data: {
      repoRoot,
      command: commandToRun,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      truncated: execution.truncated,
      stdout: execution.stdout,
      stderr: execution.stderr,
    },
    human: [
      `Selected test command: ${commandToRun}`,
      `Exit code: ${execution.exitCode}`,
      `Timed out: ${execution.timedOut ? 'yes' : 'no'}`,
      `Output truncated: ${execution.truncated ? 'yes' : 'no'}`,
    ],
  };
}

export async function handleUndo(cwd: string): Promise<CommandResult> {
  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) {
    throw new CliCommandError(
      'No repository root found. Run `agent init` from your project first.'
    );
  }

  const transactionStore = new TransactionStore(getAgentPaths(repoRoot).transactionsDir, repoRoot);
  const transaction = await transactionStore.latest();
  if (transaction && transaction.status !== 'reverted' && transaction.edits.length > 0) {
    await transactionStore.revert(transaction);
    return {
      ok: true,
      message: `Reverted transaction ${transaction.id}.`,
      data: {
        repoRoot,
        transactionId: transaction.id,
        filesChanged: transaction.edits.flatMap((edit) => edit.filesChanged),
      },
      human: [
        `Reverted transaction ${transaction.id}.`,
        `Changed files: ${[...new Set(transaction.edits.flatMap((edit) => edit.filesChanged))].join(', ')}`,
      ],
    };
  }

  const record = await readAppliedPatchRecord(repoRoot);
  if (!record) {
    throw new CliCommandError('No applied patch is available to undo.');
  }

  const rollbackResult = await rollbackLastPatch(repoRoot, record.reversePatchPath);
  if (!rollbackResult.success) {
    throw new CliCommandError(rollbackResult.error ?? 'Rollback failed.');
  }

  await clearAppliedPatchRecord(repoRoot);

  return {
    ok: true,
    message: 'Rolled back the last applied patch and cleared rollback state.',
    data: { repoRoot, patchPath: record.patchPath },
    human: [
      'Rollback complete: last applied patch was reverted.',
      `Reverted patch: ${record.patchPath}`,
      'Rollback metadata and applied patch pointers were cleared.',
    ],
  };
}

export async function handleReplay(cwd: string, sessionId: string): Promise<CommandResult> {
  const session = await readSessionById(cwd, sessionId);
  if (!session) {
    throw new CliCommandError(`Session "${sessionId}" was not found.`, 1, { sessionId });
  }

  return {
    ok: true,
    message: `Replayed session ${session.metadata.sessionId}.`,
    data: session,
    human: [
      `Session: ${session.metadata.sessionId}`,
      `Command: ${session.metadata.command}`,
      `Status: ${session.metadata.status}`,
      ...session.events.map(
        (event) =>
          `#${event.sequence} ${event.type} ${new Date(event.timestamp).toISOString()} ${JSON.stringify(event.data)}`
      ),
    ],
  };
}

export async function handleDoctor(
  cwd: string,
  options: DoctorOptions = {}
): Promise<CommandResult> {
  const report = await runDoctorChecks(cwd, {}, options);
  const lines = formatDoctorReport(report);
  const summary = `Doctor checks ${report.ok ? 'passed' : 'failed'} (${report.passed} passed, ${report.warnings} warnings, ${report.failed} failed).`;

  if (!report.ok) {
    throw new CliCommandError([summary, ...lines].join('\n'), 1, report);
  }

  return {
    ok: true,
    message: summary,
    data: report,
    human: [summary, ...lines],
  };
}
