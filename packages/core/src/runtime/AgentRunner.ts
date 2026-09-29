/**
 * AgentRunner - Event-driven loop orchestration
 *
 * Coordinates the agent execution loop:
 * - Plan creation
 * - Context gathering
 * - Tool execution
 * - Patch proposal/application
 */

import type { Context } from '../context/gather.js';
import { gatherContext } from '../context/gather.js';
import type { LLM, LLMOptions } from '../model/LLM.js';
import {
  type AgentOutput,
  parseAgentOutput,
  validatePatchOutputContract,
} from '../prompts/formats.js';
import { getSystemPrompt } from '../prompts/system.js';
import { buildRunPrompt } from '../prompts/templates.js';
import type { EventDataMap, EventType } from './EventBus.js';
import { EventBus } from './EventBus.js';

export interface AgentRunInput {
  task: string;
  repoRoot: string;
  llmOptions?: LLMOptions;
}

export interface AgentRunResult {
  output: AgentOutput;
  prompt: string;
  rawModelOutput: string;
  context: Context;
  proposedPatchFileCount: number;
}

export interface AgentRunnerOptions {
  llm: LLM;
  eventBus?: EventBus;
  contextGatherer?: (query: string, repoRoot: string) => Promise<Context>;
  onEvent?: <TType extends EventType>(
    type: TType,
    data: EventDataMap[TType]
  ) => Promise<void> | void;
}

export class AgentRunner {
  private readonly llm: LLM;
  private readonly eventBus: EventBus;
  private readonly contextGatherer: (query: string, repoRoot: string) => Promise<Context>;
  private readonly onEvent?: <TType extends EventType>(
    type: TType,
    data: EventDataMap[TType]
  ) => Promise<void> | void;

  constructor(options: AgentRunnerOptions) {
    this.llm = options.llm;
    this.eventBus = options.eventBus ?? new EventBus();
    this.contextGatherer = options.contextGatherer ?? gatherContext;
    this.onEvent = options.onEvent;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    await this.emit('tool_call', {
      tool: 'gather_context',
      input: {
        query: input.task,
        repoRoot: input.repoRoot,
      },
    });

    const context = await this.contextGatherer(input.task, input.repoRoot);

    await this.emit('tool_result', {
      tool: 'gather_context',
      success: true,
      output: {
        searchFiles: context.searchResults.length,
        loadedFiles: context.files.length,
      },
    });

    const prompt = buildRunPrompt(input.task, serializeContext(context));
    const completion = await this.llm.complete(prompt, {
      ...input.llmOptions,
      systemPrompt: input.llmOptions?.systemPrompt ?? getSystemPrompt(),
    });

    const rawModelOutput = completion.content;
    let output: AgentOutput;
    try {
      output = parseAgentOutput(rawModelOutput);
      validatePatchOutputContract(output.patch);
    } catch (error) {
      const parseError = new Error(
        error instanceof Error ? error.message : 'Failed to parse model output.'
      ) as Error & { rawModelOutput?: string };
      parseError.rawModelOutput = rawModelOutput;
      throw parseError;
    }

    await this.emit('plan', {
      summary: output.plan,
    });

    const proposedPatchFileCount = countPatchFiles(output.patch);
    if (output.patch) {
      await this.emit('patch_proposed', {
        patchPath: '.agent/patches/last-proposed.patch',
        fileCount: proposedPatchFileCount,
        byteLength: Buffer.byteLength(output.patch, 'utf8'),
      });
    }

    return {
      output,
      prompt,
      rawModelOutput,
      context,
      proposedPatchFileCount,
    };
  }

  private async emit<TType extends EventType>(
    type: TType,
    data: EventDataMap[TType]
  ): Promise<void> {
    this.eventBus.emit(type, data);
    await this.onEvent?.(type, data);
  }
}

function serializeContext(context: Context): string {
  const sections: string[] = [];

  if (context.searchResults.length > 0) {
    sections.push(
      `Search Results:\n${context.searchResults
        .map((result) => `- ${result.path}: ${result.matches.join(' | ')}`)
        .join('\n')}`
    );
  }

  if (context.files.length > 0) {
    sections.push(
      `File Excerpts:\n${context.files
        .map((file) => `### ${file.path}\n${file.content}`)
        .join('\n\n')}`
    );
  }

  if (sections.length === 0) {
    return 'No relevant context found.';
  }

  return sections.join('\n\n');
}

function countPatchFiles(patch: string | null): number {
  if (!patch) {
    return 0;
  }

  return patch.split('\n').filter((line) => line.startsWith('+++ ')).length;
}
