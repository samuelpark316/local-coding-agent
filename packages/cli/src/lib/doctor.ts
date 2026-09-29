import { execFile as execFileCallback } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_MODEL_CONFIG,
  type ModelConfig,
  OllamaAdapter,
  parseAgentAction,
} from '@local-agent/core';
import type { AgentPaths } from './agentFs.js';
import { getAgentPaths, resolveRepoRoot } from './agentFs.js';
import { loadModelConfig } from './model.js';

const execFile = promisify(execFileCallback);

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  required: boolean;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  repoRoot: string;
  checks: DoctorCheck[];
  passed: number;
  warnings: number;
  failed: number;
}

type DoctorAgentPaths = Pick<AgentPaths, 'agentDir' | 'modelPath'>;

export interface DoctorDependencies {
  execBinary: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  checkAccess: (targetPath: string, mode: number) => Promise<void>;
  pathExists: (targetPath: string) => boolean;
  getSystemMemoryBytes: () => number;
  resolveRepoRoot: (startPath: string) => string | null;
  getAgentPaths: (repoRoot: string) => DoctorAgentPaths;
  loadModelConfig: (repoRoot: string) => Promise<ModelConfig>;
  createAdapter: (
    config: ModelConfig
  ) => Pick<OllamaAdapter, 'checkServer' | 'listModels'> & Partial<Pick<OllamaAdapter, 'complete'>>;
}

export interface DoctorOptions {
  protocol?: boolean;
}

const defaultDependencies: DoctorDependencies = {
  execBinary: (command: string, args: string[]) => execFile(command, args),
  checkAccess: (targetPath: string, mode: number) => access(targetPath, mode),
  pathExists: (targetPath: string) => existsSync(targetPath),
  getSystemMemoryBytes: () => os.totalmem(),
  resolveRepoRoot,
  getAgentPaths,
  loadModelConfig,
  createAdapter: (config: ModelConfig) => OllamaAdapter.fromModelConfig(config),
};

const GIB = 1024 * 1024 * 1024;

function isLikelyLargeModel(modelName: string): boolean {
  return /(14b|32b|70b|\b[2-9]\db\b)/iu.test(modelName);
}

function addRiskWarnings(
  checks: DoctorCheck[],
  modelConfig: ModelConfig,
  systemMemoryBytes: number
): void {
  if (isLikelyLargeModel(modelConfig.model) && modelConfig.timeoutMs < 20_000) {
    checks.push({
      id: 'model_timeout_profile',
      label: 'model timeout profile',
      status: 'warn',
      required: false,
      message: `Model "${modelConfig.model}" with timeoutMs=${modelConfig.timeoutMs} may cause ask/apply timeouts. Consider timeoutMs >= 20000.`,
    });
  }

  if (systemMemoryBytes <= 16 * GIB && modelConfig.contextLimit > 8192) {
    checks.push({
      id: 'model_context_profile',
      label: 'model context profile',
      status: 'warn',
      required: false,
      message: `contextLimit=${modelConfig.contextLimit} on ~${Math.round(systemMemoryBytes / GIB)}GiB system memory may increase latency/instability. Consider contextLimit <= 8192.`,
    });
  }
}

function firstLine(text: string): string | null {
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ?? null;
}

function summarize(
  checks: DoctorCheck[]
): Pick<DoctorReport, 'ok' | 'passed' | 'warnings' | 'failed'> {
  const passed = checks.filter((check) => check.status === 'pass').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  const failed = checks.filter((check) => check.status === 'fail').length;

  return {
    ok: failed === 0,
    passed,
    warnings,
    failed,
  };
}

async function checkExecutable(
  checks: DoctorCheck[],
  dependencies: DoctorDependencies,
  command: string,
  label: string
): Promise<void> {
  try {
    const { stdout, stderr } = await dependencies.execBinary(command, ['--version']);
    checks.push({
      id: command,
      label,
      status: 'pass',
      required: false,
      message: firstLine(stdout) ?? firstLine(stderr) ?? `${command} is available.`,
    });
  } catch (_error) {
    checks.push({
      id: command,
      label,
      status: 'warn',
      required: false,
      message: `${command} not found in PATH.`,
    });
  }
}

async function checkWriteAccess(
  checks: DoctorCheck[],
  dependencies: DoctorDependencies,
  targetPath: string,
  id: string,
  label: string
): Promise<void> {
  try {
    await dependencies.checkAccess(targetPath, constants.R_OK | constants.W_OK);
    checks.push({
      id,
      label,
      status: 'pass',
      required: true,
      message: `${targetPath} is readable and writable.`,
    });
  } catch {
    checks.push({
      id,
      label,
      status: 'fail',
      required: true,
      message: `${targetPath} is not writable with current permissions.`,
    });
  }
}

export async function runDoctorChecks(
  cwd: string,
  overrides: Partial<DoctorDependencies> = {},
  options: DoctorOptions = {}
): Promise<DoctorReport> {
  const dependencies: DoctorDependencies = {
    ...defaultDependencies,
    ...overrides,
  };
  const repoRoot = dependencies.resolveRepoRoot(cwd) ?? path.resolve(cwd);
  const paths = dependencies.getAgentPaths(repoRoot);
  const checks: DoctorCheck[] = [];

  await checkExecutable(checks, dependencies, 'git', 'git executable');
  await checkExecutable(checks, dependencies, 'rg', 'ripgrep executable');
  await checkWriteAccess(checks, dependencies, repoRoot, 'repo_permissions', 'repo permissions');

  if (dependencies.pathExists(paths.agentDir)) {
    await checkWriteAccess(
      checks,
      dependencies,
      paths.agentDir,
      'agent_permissions',
      '.agent directory permissions'
    );
  } else {
    checks.push({
      id: 'agent_permissions',
      label: '.agent directory permissions',
      status: 'warn',
      required: false,
      message: '.agent directory is missing. Run `agent init` to scaffold project config.',
    });
  }

  let modelConfig = DEFAULT_MODEL_CONFIG;
  if (dependencies.pathExists(paths.modelPath)) {
    try {
      modelConfig = await dependencies.loadModelConfig(repoRoot);
      checks.push({
        id: 'model_config',
        label: 'model configuration',
        status: 'pass',
        required: true,
        message: `Loaded ${paths.modelPath} (model: ${modelConfig.model}).`,
      });
    } catch (error) {
      checks.push({
        id: 'model_config',
        label: 'model configuration',
        status: 'fail',
        required: true,
        message:
          error instanceof Error
            ? error.message
            : `Invalid model configuration at ${paths.modelPath}.`,
      });
    }
  } else {
    checks.push({
      id: 'model_config',
      label: 'model configuration',
      status: 'warn',
      required: false,
      message: `No ${paths.modelPath} found. Using default model "${modelConfig.model}" for diagnostics.`,
    });
  }

  addRiskWarnings(checks, modelConfig, dependencies.getSystemMemoryBytes());

  const adapter = dependencies.createAdapter(modelConfig);
  try {
    const serverReachable = await adapter.checkServer();
    if (!serverReachable) {
      checks.push({
        id: 'ollama_server',
        label: 'ollama server',
        status: 'fail',
        required: true,
        message: `Ollama server is unavailable at ${modelConfig.baseUrl}. Start it with: ollama serve`,
      });
    } else {
      checks.push({
        id: 'ollama_server',
        label: 'ollama server',
        status: 'pass',
        required: true,
        message: `Reachable at ${modelConfig.baseUrl}.`,
      });

      const installedModels = await adapter.listModels();
      if (installedModels.includes(modelConfig.model)) {
        checks.push({
          id: 'ollama_model',
          label: 'ollama model',
          status: 'pass',
          required: true,
          message: `Model "${modelConfig.model}" is installed.`,
        });
        if (options.protocol) {
          try {
            if (!adapter.complete) throw new Error('Adapter does not support protocol completion.');
            const response = await adapter.complete(
              'Return exactly this harmless JSON completion action: {"type":"complete","summary":"Protocol check passed","noChangeReason":"Diagnostic only"}',
              {
                temperature: 0,
                structuredOutput: {
                  fallbackToPrompt: true,
                  schema: {
                    type: 'object',
                    properties: {
                      type: { const: 'complete' },
                      summary: { type: 'string' },
                      noChangeReason: { type: 'string' },
                    },
                    required: ['type', 'summary'],
                    additionalProperties: false,
                  },
                },
              }
            );
            const action = parseAgentAction(response.content, { knownTools: [] });
            if (action.type !== 'complete')
              throw new Error('Model did not return a completion action.');
            checks.push({
              id: 'model_protocol',
              label: 'model action protocol',
              status: 'pass',
              required: false,
              message: 'Configured model returned a valid harmless action; nothing was executed.',
            });
          } catch (error) {
            checks.push({
              id: 'model_protocol',
              label: 'model action protocol',
              status: 'warn',
              required: false,
              message: `Model is installed but did not follow the action protocol: ${error instanceof Error ? error.message : 'invalid response'}`,
            });
          }
        }
      } else {
        checks.push({
          id: 'ollama_model',
          label: 'ollama model',
          status: 'fail',
          required: true,
          message: `Model "${modelConfig.model}" is missing. Run: ollama pull ${modelConfig.model}`,
        });
      }
    }
  } catch (error) {
    checks.push({
      id: 'ollama_server',
      label: 'ollama server',
      status: 'fail',
      required: true,
      message: error instanceof Error ? error.message : 'Unable to connect to Ollama server.',
    });
  }

  return {
    repoRoot,
    checks,
    ...summarize(checks),
  };
}

export function formatDoctorReport(report: DoctorReport): string[] {
  return report.checks.map((check) => {
    const prefix = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL';
    return `[${prefix}] ${check.label}: ${check.message}`;
  });
}
