/**
 * @local-agent/core
 *
 * Core engine for the local coding agent.
 * This package contains the runtime, policy, tools, and model adapters.
 * No UI dependencies.
 */

export * from './actions/AgentAction.js';
export * from './actions/parseAgentAction.js';
export * from './context/chunk.js';
export * from './context/gather.js';
export * from './model/adapters/ollama.js';
export * from './model/config.js';
export * from './model/LLM.js';
export * from './policy/Policy.js';
export * from './policy/validate.js';
export * from './prompts/formats.js';
export * from './prompts/system.js';
export * from './prompts/templates.js';
export * from './runtime/AgentRunner.js';
export * from './runtime/ConversationState.js';
export * from './runtime/EventBus.js';
export * from './runtime/SessionStore.js';
export * from './runtime/ToolLoopRunner.js';
export * from './runtime/TransactionStore.js';
export * from './tools/fs/listFiles.js';
export * from './tools/fs/readFile.js';
export * from './tools/git/diff.js';
export * from './tools/git/status.js';
export * from './tools/patch/applyDiff.js';
export * from './tools/patch/parseUnifiedDiff.js';
export * from './tools/patch/rollback.js';
export * from './tools/patch/validateDiff.js';
export * from './tools/search/ripgrep.js';
export * from './tools/shell/runCommand.js';
export * from './tools/Tool.js';
export * from './tools/ToolDispatcher.js';
export * from './util/errors.js';
export * from './util/logger.js';
export * from './util/paths.js';
