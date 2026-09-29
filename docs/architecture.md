# Architecture

## Overview

The local coding agent is built with a modular architecture:

- **Core Engine** (`packages/core`): The product - no UI dependencies
- **CLI** (`packages/cli`): Thin wrapper around the core
- **Model Adapters**: Pluggable providers (Ollama first)
- **Tools**: Small, auditable, policy-gated capabilities

## Event-Driven Design

The engine uses an event bus to decouple execution from UI:

- `plan` - Agent creates a plan
- `tool_call` - Tool is invoked
- `tool_result` - Tool returns result
- `patch_proposed` - Patch is proposed
- `patch_applied` - Patch is applied
- `command_started` - Command execution starts
- `command_output` - Command produces output
- `done` - Task completed
- `error` - Error occurred

Interactive requests additionally record request boundaries, model turns, policy decisions, approvals, context compaction, and typed stop reasons.

Action parsing has two stages. A deterministic normalizer can convert only registered direct-tool envelopes into the canonical `tool_call` shape; strict action and per-tool schemas then validate the result. Diagnostics retain raw and normalized forms in memory, while durable events store typed recovery metadata rather than raw model reasoning.

## Interactive Tool Loop

`ToolLoopRunner` is separate from the legacy one-shot `AgentRunner`. It asks the model for exactly one strict JSON action per turn, dispatches that action through `ToolDispatcher`, feeds the bounded result back to the model, and stops on explicit completion, user input, limits, repeated loops, or errors.

`ToolDispatcher` is the only model-to-tool boundary. It validates arguments, applies repository policy, requests approval through an injected callback, executes bounded read/search/git/edit/command tools, and returns structured results. Core never reads terminal input directly.

Interactive edits are expressed as exact edit intents but converted into unified diffs. They pass through the existing parser and validator, are applied through the patch pipeline, and are appended to a request transaction. Before each filesystem mutation, the transaction durably records a prepared forward patch, reverse patch, path, and before/after hashes; the entry is marked applied afterward. Recovery can therefore distinguish an unapplied intent from a write interrupted before its applied marker. Transactions retain reverse patches so multiple edits can be undone together.

`ConversationState` keeps model messages separate from deterministic hard state: active task, clarifications, inspected and changed files, tool errors, approvals, and verification. Each new request resets its step/error budget while bounded session facts remain available. Compaction discards old transcript detail before it discards hard state.

Initial retrieval is hybrid: explicit repository-relative paths are read first, tiny repositories receive a bounded file listing, and `rg` receives extracted identifiers instead of the full natural-language request.

## Safety Model

The default policy permits patch-backed edits with confirmation. Read-only mode is available through policy, and commands require both exact allowlisting and confirmation by default.

## Patch-Based Editing

Legacy `agent ask` still returns PLAN/PATCH/COMMANDS/DONE. Interactive chat returns one action per turn; mutation actions are translated into validated patches before approval and application.
