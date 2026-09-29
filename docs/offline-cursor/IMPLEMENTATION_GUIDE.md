# Implementation Guide for Agents

> Use [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md) for the ordered backlog and milestone gates. This guide explains module ownership and implementation constraints.

## How to Use This Guide

This is the execution-oriented companion to `COMPARISON.md` and `ALIGNMENT_PLAN.md`. It identifies where changes should live, what can be reused, and which dependencies determine implementation order.

Work one vertical slice at a time. Do not begin with a broad rewrite of the CLI, prompt, and tools together.

## Current Ownership Map

| Concern | Current source | Guidance |
| --- | --- | --- |
| CLI registration | `packages/cli/src/app.ts` | Add `chat` without breaking current subcommands |
| CLI actions | `packages/cli/src/commands/*.ts` | Keep command definitions thin |
| Shared command orchestration | `packages/cli/src/commands/shared.ts` | Extract new behavior; do not grow this file further |
| Terminal I/O abstraction | `packages/cli/src/lib/runtime.ts` | Reuse/increment for testable interactive I/O |
| Confirmation prompts | `packages/cli/src/ui/prompts.ts` | Expand to typed approval outcomes in a new module if needed |
| Human/JSON rendering | `packages/cli/src/lib/output.ts` | Preserve existing command output contract |
| Diff rendering | `packages/cli/src/ui/diffView.ts` | Reuse for edit-tool approval previews |
| Agent orchestration | `packages/core/src/runtime/AgentRunner.ts` | Keep one-shot compatibility; introduce a separate loop runner first |
| Event types | `packages/core/src/runtime/EventBus.ts` | Extend before relying on new event persistence |
| Session persistence | `packages/core/src/runtime/SessionStore.ts` | Reuse; define interactive lifecycle explicitly |
| LLM contract | `packages/core/src/model/LLM.ts` | Reuse its existing optional `stream` method when the loop adds streaming |
| Ollama transport | `packages/core/src/model/adapters/ollama.ts` | Reuse existing completion, streaming, timeout, retry, and config behavior |
| Output parsing | `packages/core/src/prompts/formats.ts` | Keep legacy output parser; add loop action parser separately |
| System/run prompts | `packages/core/src/prompts/*.ts` | Add loop-specific prompts rather than overloading one-shot prompts |
| Initial context | `packages/core/src/context/*.ts` | Reuse as bounded seed context |
| Policy schema/gate | `packages/core/src/policy/*.ts` | Hard safety boundary; extend operation types carefully |
| Read/search tools | `packages/core/src/tools/fs`, `search`, `git` | Wrap in a common dispatcher |
| Command tool | `packages/core/src/tools/shell/runCommand.ts` | Reuse only through policy evaluation |
| Patch pipeline | `packages/core/src/tools/patch/*` | Foundation for all edit tools |
| Repository agent state | `packages/cli/src/lib/agentFs.ts` | Avoid moving policy/state ownership into interactive UI |

## Recommended New Modules

Names can change to match repository conventions, but responsibilities should remain separate.

```text
packages/core/src/runtime/ToolLoopRunner.ts
packages/core/src/runtime/ConversationState.ts
packages/core/src/runtime/LoopDetector.ts
packages/core/src/actions/AgentAction.ts
packages/core/src/actions/parseAgentAction.ts
packages/core/src/tools/ToolRegistry.ts
packages/core/src/tools/ToolDispatcher.ts
packages/core/src/tools/edit/editFile.ts
packages/core/src/tools/edit/createFile.ts
packages/core/src/tools/edit/deleteFile.ts
packages/core/src/prompts/toolLoop.ts

packages/cli/src/commands/chat.ts
packages/cli/src/lib/interactiveSession.ts
packages/cli/src/ui/approvalPrompt.ts
packages/cli/src/ui/sessionView.ts
```

Do not create all modules up front. Add them as their phase becomes executable and tested.

## First Vertical Slice

The first implementation should prove the architecture with a read-only multi-turn request.

Scope:

1. Add `AgentAction` with `tool_call` and `complete` variants.
2. Add strict parsing and focused unit tests.
3. Add a registry containing `list_files`, `read_file`, and `search_code`.
4. Add `ToolLoopRunner` with an injected fakeable `LLM`, maximum steps, event callback, and no approval concerns yet.
5. Add a non-default `agent chat` command that runs one request through the loop.
6. Add CLI tests with scripted input/output; no real Ollama requirement.

Acceptance scenario:

```text
fake model -> list_files
tool result -> fake model -> search_code
tool result -> fake model -> read_file
tool result -> fake model -> complete
```

Assertions:

- Tools execute in the expected order.
- Tool results become subsequent model context.
- All paths remain repository-scoped.
- Maximum-step exhaustion returns a typed stop reason.
- Completion summary reaches human and JSON renderers.
- Session events preserve sequence.

## Dispatcher Contract

The dispatcher should be the only path from model action to tool execution. A useful conceptual contract is:

```ts
interface ToolDispatcher {
  describeTools(): ToolDescription[];
  dispatch(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>;
}
```

`ToolExecutionContext` should carry repository root, policy, request/session identifiers, and an optional approval callback. It should not carry raw terminal streams.

Dispatch order for every tool:

1. Validate tool name and argument schema.
2. Normalize repository-relative paths.
3. Evaluate policy and hard limits.
4. Build a bounded preview and risk classification.
5. Request approval when policy requires it.
6. Revalidate stale preconditions immediately before mutation.
7. Execute with timeout/output bounds where applicable.
8. Return a bounded structured result.
9. Emit events without secrets or chain-of-thought.

Unknown tools, malformed arguments, hard policy denials, and user rejections are results the model can reason about; they are not reasons to bypass validation or crash the whole process unless the runtime cannot continue safely.

## Approval Contract

Use a typed outcome instead of a boolean:

```ts
type ApprovalOutcome =
  | { decision: 'approve' }
  | { decision: 'reject'; feedback?: string }
  | { decision: 'approve_session' }
  | { decision: 'abort' };
```

Important distinction:

- Policy decides whether an operation is forbidden, allowed without confirmation, or allowed with confirmation.
- Approval handles only the confirmable case.
- `approve_session` can skip future confirmations but cannot turn a forbidden operation into an allowed one.

The model should receive concise rejection feedback, but terminal formatting and policy internals should not be copied verbatim into the conversation.

## Edit Tool Strategy

Implement exact replacement before line-number editing. Exact replacement has a strong stale-content precondition and maps naturally to a patch.

`edit_file` requirements:

- Path must resolve inside an allowed repository root.
- Source file must satisfy read limits.
- `oldText` must be non-empty and match exactly once by default.
- Ambiguous or missing matches must fail without writing.
- The generated diff must pass the existing parser and validator.
- The preview must identify changed files and line counts.
- Approval occurs after preview generation and before application.
- The applied patch must be included in rollback/session state.

`create_file` requirements:

- Fail if the target exists unless a future explicit overwrite mode is designed.
- Enforce file and patch size limits.
- Create parent directories only after approval.

`delete_file` requirements:

- Operate on files, not recursive directories.
- Preview deletion clearly.
- Preserve reverse content within rollback limits.

## Conversation State

Conversation state is more than the raw model message array. Track hard state separately:

- Current request and request ID.
- Step number and stop reason.
- Files inspected.
- Files changed and patch records.
- Commands run and verification outcomes.
- Approval mode and decisions.
- Recent action signatures and error signatures.
- Token/character budget.

Hard state should generate prompt context but should never depend on a model-written summary for correctness.

When compaction is added, retain recent turns plus a deterministic state summary. If a model-generated narrative summary is used, treat it as advisory only.

## Loop Stop Conditions

Every loop must terminate on one of these explicit conditions:

- Model returns `complete`.
- Model returns `request_input` and the runtime yields to the user.
- User aborts.
- Maximum steps reached.
- Repeated action/error threshold reached.
- Parsing corrective retry exhausted.
- Context budget cannot be reduced safely.
- Fatal model transport or tool infrastructure error.

Return a typed stop reason and human next step. Do not infer success from generic prose phrases as Offline Cursor does.

## Testing Matrix

### Action Parsing

- Valid tool, completion, and input-request actions.
- Unknown keys, tools, and malformed args.
- Markdown fences and leading prose handled only by approved deterministic normalization.
- Braces and escapes inside JSON strings.
- Multiple JSON objects rejected or handled deterministically.
- Raw output attached to failures.

### Loop Runtime

- Multi-tool success path.
- Tool error followed by corrected action.
- Parse error followed by one corrective retry.
- Repeated identical call detection.
- Maximum steps.
- Completion with changed-file and verification ledger.
- Abort and interruption.

### Policy and Approval

- Read outside root denied.
- Symlink escape denied.
- Write hard denial cannot be auto-approved.
- Rejection feedback reaches next turn.
- Session auto mode skips only confirmation.
- Non-TTY confirmation returns an actionable failure.

### Editing

- Exact single replacement.
- Missing and duplicate search text.
- Stale file after preview.
- New file and file deletion.
- Patch/file size limits.
- Multi-edit rollback semantics.
- No writes on any failed validation.

### Commands

- Exact allowlist acceptance and denial.
- Timeout, truncation, non-zero exit, and spawn failure.
- Bounded output fed back to model.
- No shell execution for a rejected action.

### CLI

- Multiple requests in one process.
- Multiline input behavior.
- Ctrl+C during input, model request, and command.
- Plain and colored rendering.
- JSON/non-interactive behavior.
- Existing subcommand compatibility.

## Documentation Corrections to Bundle With Behavior Changes

Update documentation only when the corresponding behavior lands, but ensure these known drifts are eventually resolved:

- Reconcile the stated read-only default with `DEFAULT_SAFE_MODE_POLICY.readOnly`.
- Update milestone checkboxes to reflect implemented policy and patch work.
- Document whether `agent chat` or bare `agent` is the preferred entry point.
- Document session-level auto approval precisely.
- Explain transaction and undo semantics for multiple interactive edits.
- Document streaming as presentation only; execution waits for a complete validated action.

## Changes to Avoid

- Do not call the Python Offline Cursor process from this project.
- Do not replace the npm workspace with a single CLI file.
- Do not let the CLI execute model-returned `tool_calls` directly.
- Do not allow broad command families merely because Offline Cursor does.
- Do not implement writes outside the patch pipeline.
- Do not log private chain-of-thought.
- Do not make streaming a prerequisite for the tool loop.
- Do not remove current commands during the interactive migration.
- Do not mix unrelated tolerance-pipeline changes into a tool-loop patch without tests proving both concerns.

## Handoff Checklist

Before completing any alignment task:

- Read current `git status` and preserve unrelated changes.
- Identify the phase and acceptance criterion being implemented.
- Keep core free of terminal dependencies.
- Add or update focused tests.
- Run the narrowest relevant tests first, then build/lint as appropriate.
- Confirm events and structured output remain stable or are intentionally versioned.
- Confirm no policy, path, patch, command, timeout, or output bound was weakened.
- Update these documents if an architectural decision changes the plan.
