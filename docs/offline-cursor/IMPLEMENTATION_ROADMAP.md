# Interactive Agent Implementation Roadmap

## Purpose

This is the canonical implementation plan for evolving Local Coding Agent toward the Offline Cursor interaction model. It converts the architectural direction into an ordered, testable backlog with explicit dependencies, file-level scope, migration rules, and release gates.

The roadmap covers all planned changes:

- Reliable structured model output and bounded repair.
- A typed one-action-per-turn protocol.
- A model-callable tool registry and central dispatcher.
- A bounded multi-step agent loop.
- A persistent `agent chat` terminal experience.
- Risk-aware approval, rejection feedback, and session auto-approval.
- Reversible patch-backed file tools.
- Model-driven allowlisted verification commands.
- Loop detection and context compaction.
- Safe streaming presentation.
- Session transactions, replay, status, benchmarks, documentation, and rollout.

## Planning Status

| Item | Decision |
| --- | --- |
| Migration strategy | Add `agent chat`; preserve every existing subcommand |
| Core interaction protocol | Strict JSON, exactly one discriminated action per model turn |
| Initial tools | Read-only list, read, search, git status, and git diff |
| Editing model | Tool-shaped edit intents backed by unified diffs |
| Command model | Exact repository allowlist; no broad shell-family permissions |
| Approval ownership | Policy in core, TTY prompt in CLI through an injected callback |
| Auto-approval | Session-scoped confirmation bypass only; hard denials still apply |
| Multi-edit undo | Request-scoped transaction journal with reverse patches |
| Streaming | Presentation only; execute only after complete action validation |
| Existing `agent ask` | Remains supported and uses its current output contract during migration |
| Bare `agent` behavior | Deferred until `agent chat` passes rollout gates |

## Dependency Graph

```text
M0 Baseline and tolerance completion
  -> M1 Action contracts and events
      -> M2 Read-only tool registry and dispatcher
          -> M3 Conversation state and tool loop
              -> M4 Read-only interactive CLI
                  -> M5 Approval and feedback
                      -> M6 Transactional patch infrastructure
                          -> M7 Editing tools
                              -> M8 Command and verification loop
                                  -> M9 Multi-request continuity and input requests
                                      -> M10 Streaming presentation
                                          -> M11 Context compaction
                                              -> M12 Benchmarks, rollout, and cleanup
```

Some test and documentation work runs continuously, but implementation should not skip dependency gates. In particular, mutation tools must not be added before the dispatcher, approval contract, and transaction journal exist.

## Cross-Cutting Rules

Every milestone must follow these rules:

1. Preserve unrelated worktree changes.
2. Keep terminal dependencies out of `packages/core`.
3. Parse and validate complete model output before dispatch.
4. Route every tool through one dispatcher.
5. Evaluate hard policy constraints before approval.
6. Revalidate mutation preconditions immediately before writing.
7. Bound steps, retries, result sizes, command duration, and context growth.
8. Emit typed events for externally visible state changes.
9. Keep existing human and `--json` command behavior backward compatible unless deliberately versioned.
10. Add focused unit tests before broad integration tests.

## M0: Stabilize the Existing Baseline

### Objective

Finish the in-progress tolerance work needed by both the one-shot and interactive protocols, reconcile misleading source documentation, and establish a clean behavioral baseline before introducing a second runtime.

### Dependencies

None. This milestone must complete first.

### Existing Work to Preserve

The current worktree already contains changes in:

- `packages/core/src/prompts/formats.ts`
- `packages/core/src/runtime/AgentRunner.ts`
- `packages/cli/src/commands/shared.ts`
- Related core and CLI tests
- `tasks.md`
- `tolerance-pipeline-plan.md`

Treat those changes as active user work. Review and finish them rather than replacing them.

### Implementation Tasks

1. Complete Tolerance T2 envelope normalization:
   - Trim BOM and outer whitespace.
   - Strip one complete outer Markdown fence.
   - Extract the first balanced JSON object when surrounding prose exists.
   - Preserve raw output in parse failures.
   - Keep unknown-key and field-type validation strict.
2. Update T2 checklist state only after tests pass.
3. Implement or explicitly defer T3/T4 patch sanitation and deterministic hunk-count repair.
4. Add shared recovery metadata types instead of encoding recovery only in error strings.
5. Reconcile documentation with source defaults:
   - `safeMode.readOnly` is currently `false`.
   - Apply and command confirmation remain `true`.
   - `LLM.stream` and `OllamaAdapter.stream` already exist.
6. Capture a baseline of existing test, build, and lint results without fixing unrelated failures.

### Files

Modify as needed:

- `packages/core/src/prompts/formats.ts`
- `packages/core/src/runtime/AgentRunner.ts`
- `packages/core/src/runtime/EventBus.ts`
- `packages/cli/src/commands/shared.ts`
- `packages/cli/src/lib/errorClassification.ts`
- `packages/core/test/unit/formats.test.ts`
- `packages/core/test/unit/agentRunner.test.ts`
- `packages/cli/test/unit/commands.test.ts`
- `tolerance-pipeline-plan.md`
- `docs/security.md`
- `docs/policy.md`
- `README.md`

### Tests

- Wrapped, fenced, prefixed, BOM-prefixed, malformed, and multi-object output.
- Braces and escaped quotes inside JSON strings.
- Raw output preserved on failure.
- Unknown keys and invalid field types still fail.
- A normalized patch still passes the existing strict patch parser and validator.

### Exit Gate

- T2 behavior is fully tested and checklist state matches source.
- Existing one-shot `agent ask` behavior has a known passing baseline.
- Documentation no longer claims a read-only default that source does not implement.
- No tolerance recovery path can bypass patch or policy validation.

## M1: Define Interactive Action and Event Contracts

### Objective

Introduce the typed protocol used by the interactive loop without changing existing `agent ask` behavior.

### Dependencies

M0.

### New Contracts

Create a strict discriminated union:

```ts
type AgentAction =
  | {
      type: 'tool_call';
      summary: string;
      tool: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'complete';
      summary: string;
      changedFiles?: string[];
      verification?: string[];
    }
  | {
      type: 'request_input';
      question: string;
      context?: string;
    };
```

Define loop results and stop reasons independently from exceptions:

```ts
type LoopStopReason =
  | 'completed'
  | 'input_required'
  | 'user_aborted'
  | 'max_steps'
  | 'loop_detected'
  | 'parse_retry_exhausted'
  | 'context_limit'
  | 'model_error'
  | 'tool_error';
```

### Implementation Tasks

1. Add loop action and result types.
2. Add `parseAgentAction` using deterministic envelope normalization from M0.
3. Reject unknown top-level keys and multiple actions.
4. Validate common fields, then defer tool-specific argument validation to the registry.
5. Add loop-specific system/run prompts that enumerate the exact tools supplied by the registry.
6. Extend events for request, model turn, policy, approval, compaction, and stop lifecycle.
7. Keep existing event names and payloads compatible where possible.
8. Export new public types from the core package.

### Files

Add:

- `packages/core/src/actions/AgentAction.ts`
- `packages/core/src/actions/parseAgentAction.ts`
- `packages/core/src/prompts/toolLoop.ts`
- `packages/core/test/unit/agentAction.test.ts`

Modify:

- `packages/core/src/runtime/EventBus.ts`
- `packages/core/src/index.ts`
- `packages/core/test/unit/sessionStore.test.ts`

### Tests

- One valid case for each action variant.
- Missing, unknown, and incorrectly typed fields.
- Multiple action objects in one response.
- Fenced and prose-wrapped action recovery.
- Incomplete/truncated JSON.
- SessionStore persistence for every new event type.

### Exit Gate

- One complete model response can produce exactly one typed action or one typed parsing error.
- Raw model output is available for diagnostics.
- No action is executable merely because it parsed; dispatch remains separate.
- Existing `AgentOutput` parsing tests remain green.

## M2: Build the Tool Registry and Read-Only Dispatcher

### Objective

Create the only legal path from a parsed model tool action to a concrete tool implementation, initially with read-only capabilities.

### Dependencies

M1.

### Tool Contract

Replace the current minimal untyped tool surface for loop use with definitions that include:

- Stable tool name.
- Model-facing description.
- Argument validator/normalizer.
- Risk class.
- Side-effect classification.
- Bounded result serializer.
- Concrete execution function.

The model-facing schema must be authored explicitly; do not infer prompts from TypeScript function signatures.

### Initial Registry

- `list_files`
- `read_file`
- `search_code`
- `git_status`
- `git_diff`

### Implementation Tasks

1. Add typed `ToolDefinition`, `ToolCall`, `ToolExecutionContext`, and `ToolResult` contracts.
2. Add explicit argument validators for each initial tool.
3. Wrap existing core tools rather than duplicating filesystem/search/git logic.
4. Enforce repository root and policy read rules in the dispatcher.
5. Add default result byte/entry/line limits.
6. Return structured error codes for unknown tool, invalid arguments, policy denial, not found, timeout, truncation, and execution failure.
7. Emit `tool_call`, `policy_decision`, and `tool_result` through an injected event callback.
8. Ensure errors are safe to feed back to the model and do not leak unrestricted absolute paths.

### Files

Add:

- `packages/core/src/tools/ToolDefinition.ts`
- `packages/core/src/tools/ToolRegistry.ts`
- `packages/core/src/tools/ToolDispatcher.ts`
- `packages/core/src/tools/registry/readOnlyTools.ts`
- `packages/core/test/unit/toolRegistry.test.ts`
- `packages/core/test/unit/toolDispatcher.test.ts`

Modify:

- `packages/core/src/tools/Tool.ts`
- `packages/core/src/tools/fs/listFiles.ts`
- `packages/core/src/tools/fs/readFile.ts`
- `packages/core/src/tools/search/ripgrep.ts`
- `packages/core/src/tools/git/status.ts`
- `packages/core/src/tools/git/diff.ts`
- `packages/core/src/policy/validate.ts`
- `packages/core/src/index.ts`

### Tests

- Tool name and schema discovery.
- Invalid and unknown arguments.
- File reads inside root.
- `..`, absolute outside-root, and symlink escape denial.
- File-size, line-range, result-byte, search-count, and list-count bounds.
- Git commands outside and inside a repository.
- Event order and structured error codes.

### Exit Gate

- Every read-only model tool call goes through one dispatcher.
- No registry tool accepts unchecked `unknown` arguments.
- No tool can read outside the allowed repository root.
- Tool descriptions and schemas can be injected into the loop prompt.

## M3: Implement Conversation State, Loop Detection, and ToolLoopRunner

### Objective

Build the reusable core multi-turn runtime with a scripted fake LLM before connecting terminal interaction.

### Dependencies

M2.

### Conversation Model

Keep two layers of state:

1. Model messages: system, user, assistant action, and tool result messages.
2. Hard runtime state: step count, inspected files, changed files, command outcomes, approvals, action signatures, errors, and stop reason.

Hard state must not depend on a model-written summary.

### Implementation Tasks

1. Add `ConversationState` with bounded append and deterministic serialization.
2. Add `LoopDetector` using canonical tool/action signatures.
3. Add `ToolLoopRunner` with injected `LLM`, dispatcher, options, and event callback.
4. Seed each request with bounded `gatherContext` output plus tool descriptions.
5. Execute one model action per step.
6. Feed structured tool results back to the model.
7. Add one bounded corrective turn for malformed model action output.
8. Stop on explicit completion, input request, user abort, limits, repeated loops, transport failure, or fatal infrastructure failure.
9. Distinguish recoverable tool errors from fatal runtime errors.
10. Return a typed result containing summary, stop reason, steps, inspected files, changed files, and verification ledger.

### Default Bounds

Start conservatively and keep values configurable in `ToolLoopOptions`:

- Maximum 40 steps per request.
- One parsing corrective retry per step.
- Three identical consecutive action signatures trigger loop handling.
- Two identical consecutive errors trigger loop handling.
- Tool result text capped before model insertion.
- Initial gathered context remains under current context chunk limits.

### Files

Add:

- `packages/core/src/runtime/ConversationState.ts`
- `packages/core/src/runtime/LoopDetector.ts`
- `packages/core/src/runtime/ToolLoopRunner.ts`
- `packages/core/test/unit/conversationState.test.ts`
- `packages/core/test/unit/loopDetector.test.ts`
- `packages/core/test/unit/toolLoopRunner.test.ts`

Modify:

- `packages/core/src/index.ts`
- `packages/core/src/context/gather.ts` only if a bounded serialization hook is needed

### Tests

- List, search, read, complete sequence with a scripted LLM.
- Recoverable tool failure followed by a corrected action.
- Parse failure followed by one valid corrective response.
- Two parse failures stop without dispatch.
- Repeated action and repeated error detection.
- Maximum-step stop.
- Input-request stop.
- Model transport failure.
- Event ordering across all paths.
- No side-effecting tool can be registered in the read-only fixture accidentally.

### Exit Gate

- A complete read-only coding investigation can run across multiple model turns in core tests.
- Every path ends with an explicit typed stop reason.
- The runtime has no dependency on stdin, stdout, Commander, or ANSI rendering.
- Existing one-shot `AgentRunner` remains unchanged except shared helper reuse.

## M4: Add the Read-Only `agent chat` CLI

### Objective

Expose the new runtime through a persistent terminal session without enabling mutation.

### Dependencies

M3.

### CLI Contract

Initial command:

```text
agent chat [--plain] [--max-steps <n>]
```

Keep `agent chat` TTY-only in the first slice. Existing `agent ask --json` remains the supported non-interactive automation path. Add structured chat automation only after the interactive behavior and event contract stabilize.

### Interaction Behavior

- Show repository, model, policy mode, and read-only tool availability at startup.
- Accept repeated user requests in one process.
- Use a normal single-line prompt.
- Support multiline input through an explicit command such as `/multiline`, ending with a documented delimiter.
- Show `[step/max]`, action summary, tool name, concise result, and completion/stop summary.
- Provide `/help`, `/status`, `/clear`, and `/exit` session commands.
- A first Ctrl+C cancels the active model request or tool call; Ctrl+C while idle exits.
- Never print raw action JSON by default.

### Implementation Tasks

1. Register a thin `chat` Commander command.
2. Add an interactive session controller using the existing `CliIO` abstraction.
3. Add a session presenter for plain and colored output.
4. Load repository, model, and policy with existing CLI helpers.
5. Persist one parent session for the chat process and request boundary events for each user task.
6. Wire cancellation with `AbortSignal` through the runtime where feasible; otherwise define a safe staged migration.
7. Return actionable errors when Ollama, model configuration, or TTY is unavailable.
8. Keep terminal prompts out of core.

### Files

Add:

- `packages/cli/src/commands/chat.ts`
- `packages/cli/src/lib/interactiveSession.ts`
- `packages/cli/src/ui/sessionView.ts`
- `packages/cli/test/unit/chatCommand.test.ts`
- `packages/cli/test/unit/interactiveSession.test.ts`

Modify:

- `packages/cli/src/app.ts`
- `packages/cli/src/lib/runtime.ts`
- `packages/cli/src/lib/session.ts`
- `packages/cli/src/lib/commandHelpers.ts` only if long-lived session support requires a separate helper
- `packages/core/src/runtime/EventBus.ts`

### Tests

- Command registration and options.
- Startup validation failures.
- Multiple requests using scripted input and fake LLM output.
- Slash commands.
- Multiline input.
- Plain rendering.
- Idle and active interruption.
- EOF exits without a dangling running session.
- Non-TTY invocation fails instead of hanging.
- Existing CLI command tests remain green.

### Exit Gate

- A user can start one process and complete multiple read-only tasks.
- Session replay identifies request boundaries and tool steps.
- No mutation or command tool is available.
- Existing subcommands and package entry point remain compatible.

## M5: Add Policy-Aware Approval and User Feedback

### Objective

Create the approval framework required for future edits and commands, with Offline Cursor-like ergonomics and stronger Local Coding Agent policy boundaries.

### Dependencies

M4.

### Approval Model

```ts
type ApprovalOutcome =
  | { decision: 'approve' }
  | { decision: 'reject'; feedback?: string }
  | { decision: 'approve_session' }
  | { decision: 'abort' };
```

Policy decisions remain distinct:

- Hard deny: cannot be approved.
- Allow without confirmation: execute immediately.
- Allow with confirmation: invoke approval callback.

### Implementation Tasks

1. Add operation preview and risk metadata types.
2. Extend dispatcher context with an optional approval callback.
3. Add CLI approval UI with yes, no, session auto-approval, abort, and free-form feedback.
4. Store session auto-approval only in memory.
5. Return rejection feedback to the model as a structured tool result.
6. Log policy decision, approval request, and approval resolution events.
7. Add non-interactive behavior: confirmation-required operations fail unless an existing explicit bypass option applies.
8. Reuse the approval framework for existing apply/command prompts where practical, but avoid a broad refactor in the first approval PR.

### Files

Add:

- `packages/core/src/policy/Approval.ts`
- `packages/cli/src/ui/approvalPrompt.ts`
- `packages/core/test/unit/approvalFlow.test.ts`
- `packages/cli/test/unit/approvalPrompt.test.ts`

Modify:

- `packages/core/src/tools/ToolDispatcher.ts`
- `packages/core/src/policy/Policy.ts`
- `packages/core/src/policy/validate.ts`
- `packages/core/src/runtime/EventBus.ts`
- `packages/cli/src/lib/interactiveSession.ts`
- `packages/cli/src/ui/prompts.ts`

### Tests

- Hard denial never invokes approval.
- Approval and rejection.
- Free-form feedback appears in the next model turn.
- Session auto-approval skips later prompts but not policy checks.
- Abort stops the request.
- EOF/Ctrl+C at the prompt rejects safely.
- Approval events contain no raw sensitive file content beyond bounded preview metadata.

### Exit Gate

- Approval is injectable and core remains terminal-independent.
- Session auto-approval cannot bypass path, size, patch, command, or read-only policy constraints.
- User feedback can redirect the model without executing the rejected action.

## M6: Add Request Transaction and Patch Journal Infrastructure

### Objective

Define reliable undo and crash-recovery semantics before allowing the loop to make multiple edits.

### Dependencies

M5.

### Transaction Decision

Each interactive user request owns one edit transaction.

- A journal is created before the first mutation.
- Each applied edit appends original patch metadata and reverse patch data immediately.
- The journal is written durably before and after each mutation step.
- Successful completion seals the transaction.
- Abort, max-step, model error, or crash leaves a recoverable `incomplete` transaction.
- Changes are not silently rolled back on failure because they may be useful and tests may already have run against them.
- `agent undo` reverts the latest transaction, including an incomplete one, in reverse edit order.
- `agent status` clearly reports incomplete transactions.

This replaces the single-last-patch model for interactive work while preserving compatibility with existing patch records.

### Data Layout

Recommended repository-local state:

```text
.agent/transactions/
  <transaction-id>.json
  <transaction-id>.patch
  <transaction-id>.reverse.patch
.agent/state.json
```

Transaction metadata should include request/session IDs, status, timestamps, ordered edits, changed files, verification results, and recovery notes.

### Implementation Tasks

1. Add transaction types and store.
2. Add begin, append edit, append verification, seal, mark incomplete, list, read, and revert operations.
3. Build combined forward and reverse patch artifacts in deterministic order.
4. Make journal writes atomic using temporary file plus rename where supported.
5. Update agent initialization to create the transaction directory.
6. Update status and replay data models.
7. Extend undo to prefer the latest transaction, with fallback to legacy last-applied patch state.
8. Add crash/incomplete transaction diagnostics to doctor or status, not automatic mutation.
9. Define retention policy but defer automatic deletion until later.

### Files

Add:

- `packages/core/src/runtime/EditTransaction.ts`
- `packages/core/src/runtime/TransactionStore.ts`
- `packages/core/test/unit/transactionStore.test.ts`

Modify:

- `packages/core/src/tools/patch/applyDiff.ts`
- `packages/core/src/tools/patch/rollback.ts`
- `packages/core/src/runtime/EventBus.ts`
- `packages/core/src/index.ts`
- `packages/cli/src/lib/agentFs.ts`
- `packages/cli/src/commands/shared.ts`
- `packages/cli/test/unit/commands.test.ts`

### Tests

- Empty transaction lifecycle.
- Multiple edits combine and reverse in the correct order.
- New, changed, and deleted files restore exact bytes where current patch limits support it.
- Incomplete transaction survives a new process/store instance.
- Undo latest sealed and incomplete transactions.
- Legacy undo remains supported.
- Atomic metadata replacement does not leave invalid JSON after simulated failure.

### Exit Gate

- Multi-edit undo semantics are explicit and tested.
- A crash after any committed edit leaves enough journal state to inspect or undo it.
- Existing one-patch apply/undo behavior remains compatible.
- Mutation tools still are not model-callable until M7.

## M7: Add Patch-Backed Editing Tools

### Objective

Allow the model to make immediate, approved edits while retaining unified-diff validation, policy checks, event logs, and transaction undo.

### Dependencies

M6.

### Delivery Order

1. `edit_file`: exact search/replace.
2. `create_file`: create only when absent.
3. `delete_file`: files only.
4. Optional `replace_lines`: only if benchmark evidence shows exact replacement is insufficient.

Do not add unrestricted directory deletion or blind overwrite.

### Edit Pipeline

For each edit:

```text
validate args
  -> resolve and policy-check path
  -> read current state within limits
  -> validate edit precondition
  -> construct unified diff
  -> parse and validate diff
  -> build bounded preview/risk metadata
  -> request approval
  -> re-read and revalidate stale precondition
  -> journal intent
  -> apply patch
  -> journal applied metadata and reverse patch
  -> emit result
```

### Implementation Tasks

1. Add a deterministic diff builder for exact replacement, creation, and deletion.
2. Require `oldText` to match exactly once by default.
3. Return explicit missing-match and ambiguous-match errors without writing.
4. Hash or compare source content between preview and apply to detect stale edits.
5. Use existing `parseUnifiedDiff`, `validateDiff`, and `applyDiff` for the final mutation.
6. Integrate transaction store updates.
7. Add edit tool definitions to the registry only when the transaction context and approval callback are present.
8. Track changed files in hard conversation state.
9. Render diff previews through the existing CLI diff view.
10. Add risk summaries based on operation, file count, patch size, and sensitive path categories already expressible in policy.

### Files

Add:

- `packages/core/src/tools/patch/buildUnifiedDiff.ts`
- `packages/core/src/tools/edit/editFile.ts`
- `packages/core/src/tools/edit/createFile.ts`
- `packages/core/src/tools/edit/deleteFile.ts`
- `packages/core/src/tools/registry/editTools.ts`
- `packages/core/test/unit/editTools.test.ts`

Modify:

- `packages/core/src/tools/ToolRegistry.ts`
- `packages/core/src/tools/ToolDispatcher.ts`
- `packages/core/src/runtime/ToolLoopRunner.ts`
- `packages/core/src/runtime/ConversationState.ts`
- `packages/core/src/runtime/TransactionStore.ts`
- `packages/core/src/prompts/toolLoop.ts`
- `packages/cli/src/lib/interactiveSession.ts`
- `packages/cli/src/ui/sessionView.ts`
- `packages/cli/src/ui/diffView.ts`

### Tests

- Exact replacement success.
- Empty `oldText`, no match, and duplicate match rejection.
- Stale source between preview and apply.
- File creation and existing-file rejection.
- File deletion and directory-deletion rejection.
- Path/symlink escape.
- Patch and file-size limits.
- User rejection and feedback.
- Session auto-approval with hard policy denial.
- Multi-edit transaction undo.
- No filesystem changes on any validation or approval failure.

### Exit Gate

- The interactive loop can inspect, edit, create, and delete files through reversible validated patches.
- Every mutation has a preview, policy decision, approval outcome, transaction entry, and event trail.
- `agent undo` reverts all edits from the latest request transaction.

## M8: Add Allowlisted Command and Verification Tools

### Objective

Enable the model to verify edits and iterate on failures without broadening command permissions.

### Dependencies

M7.

### Tool Strategy

Prefer a constrained `run_check` tool over arbitrary model-authored shell commands.

- `run_check(checkId)` selects from commands discovered from repository markers and allowed by policy.
- `run_command(command)` may be exposed only for an exact command already in `commandAllowlist`.
- The model never modifies the allowlist.

### Implementation Tasks

1. Extract test/check discovery from CLI policy helpers into reusable core logic or a neutral module without CLI dependencies.
2. Assign stable check IDs and model-facing descriptions.
3. Register verification tools with high-risk/side-effect metadata.
4. Reuse `RunCommandTool` timeout and output caps.
5. Add approval preview showing exact command and working directory.
6. Stream command events internally even if CLI rendering remains buffered initially.
7. Insert bounded stdout/stderr into conversation with explicit truncation metadata.
8. Record verification outcomes in conversation state and transaction metadata.
9. Let the model edit again after failed verification until loop bounds are reached.
10. Require completion summaries to report verification truthfully from hard state; do not trust model-provided verification claims alone.

### Files

Add:

- `packages/core/src/tools/checks/discoverChecks.ts`
- `packages/core/src/tools/registry/commandTools.ts`
- `packages/core/test/unit/discoverChecks.test.ts`
- `packages/core/test/unit/commandDispatcher.test.ts`

Modify:

- `packages/core/src/tools/shell/runCommand.ts`
- `packages/core/src/tools/ToolDispatcher.ts`
- `packages/core/src/runtime/ConversationState.ts`
- `packages/core/src/runtime/ToolLoopRunner.ts`
- `packages/core/src/runtime/TransactionStore.ts`
- `packages/core/src/prompts/toolLoop.ts`
- `packages/cli/src/lib/policy.ts`
- `packages/cli/src/lib/interactiveSession.ts`
- `packages/cli/src/ui/sessionView.ts`

### Tests

- npm, Python, and Go fixture discovery where supported.
- Policy filtering and exact allowlist enforcement.
- Approval, rejection, auto-approval, and hard denial.
- Passing, failing, timed-out, truncated, and spawn-error commands.
- Failed test, corrective edit, passing test, completion sequence.
- Transaction verification ledger.
- Command output bounds in model context and session events.

### Exit Gate

- A multi-step fixture can be inspected, edited, tested, corrected, retested, and completed in one request.
- Commands outside the exact allowlist remain impossible even in session auto-approval mode.
- Completion output distinguishes verified, failed, skipped, and unavailable verification.

## M9: Complete the Persistent Collaborative Session

### Objective

Add input requests, follow-up continuity, request isolation, and practical session commands so chat behaves like a durable coding assistant rather than repeated independent prompts.

### Dependencies

M8.

### Implementation Tasks

1. Resume the same request after an `input_required` action and user response.
2. Carry a bounded repository/session summary into later requests.
3. Keep each request's transaction, step limit, errors, and stop reason isolated.
4. Add `/changes`, `/undo`, `/model`, and `/policy` session commands.
5. Make `/clear` clear conversational history without deleting transaction/session logs.
6. Add a changed-file and verification summary after each request.
7. Clarify behavior when a new request starts while an incomplete transaction exists.
8. Add status and replay rendering for request boundaries, approvals, transactions, and verification.
9. Define one active request at a time; reject concurrent terminal submissions.
10. Add optional `--auto-approve` startup flag with a prominent safety summary, still bounded by policy.

### Files

Modify:

- `packages/core/src/runtime/ToolLoopRunner.ts`
- `packages/core/src/runtime/ConversationState.ts`
- `packages/core/src/runtime/EventBus.ts`
- `packages/core/src/runtime/SessionStore.ts`
- `packages/cli/src/commands/chat.ts`
- `packages/cli/src/lib/interactiveSession.ts`
- `packages/cli/src/ui/sessionView.ts`
- `packages/cli/src/commands/shared.ts`
- `packages/cli/src/lib/agentFs.ts`
- Relevant core and CLI tests

### Tests

- Input request, user response, and resumed completion.
- Follow-up request can refer to a file changed earlier.
- Request state does not leak step/error counters.
- Session commands do not invoke the model.
- Undo from within chat updates transaction and changed-file state.
- Status/replay output for completed and incomplete requests.
- Auto-approval startup flag never bypasses hard policy denial.

### Exit Gate

- A user can perform multiple related coding requests without restarting.
- Human clarification resumes safely.
- Session operational commands work without model involvement.
- Persistent state and replay accurately represent each request.

## M10: Add Safe Streaming Presentation

### Objective

Use the already available `LLM.stream`/`OllamaAdapter.stream` capability to improve perceived responsiveness without ever executing partial structured output.

### Dependencies

M9.

### Streaming Rules

- Buffer all streamed tokens for action parsing.
- Partial JSON is display-only and never dispatched.
- Default display should show a spinner/status or sanitized progress, not raw chain-of-thought.
- A `--stream raw` diagnostic mode may show raw model output only if explicitly documented and not persisted by default.
- Plain and test modes can disable incremental rendering.
- Ctrl+C discards the incomplete action.

### Implementation Tasks

1. Add a model invocation helper that selects complete or stream mode.
2. Ensure streamed transport has the same retry/timeout/error semantics as non-streaming transport, or document intentional differences and add tests.
3. Add CLI stream modes such as `off`, `status`, and optionally `raw`.
4. Buffer full output, then parse once.
5. Emit model-started/model-finished metadata rather than token events into durable logs by default.
6. Add cancellation support through adapter fetch and stream reader.
7. Keep `--json` and unit-test rendering deterministic and non-streaming.

### Files

Modify:

- `packages/core/src/model/LLM.ts`
- `packages/core/src/model/adapters/ollama.ts`
- `packages/core/src/runtime/ToolLoopRunner.ts`
- `packages/core/src/runtime/EventBus.ts`
- `packages/cli/src/commands/chat.ts`
- `packages/cli/src/lib/interactiveSession.ts`
- `packages/cli/src/ui/sessionView.ts`
- `packages/core/test/unit/ollamaAdapter.test.ts`
- `packages/core/test/unit/toolLoopRunner.test.ts`
- `packages/cli/test/unit/interactiveSession.test.ts`

### Tests

- Chunked NDJSON with boundaries split across chunks.
- Final buffered action equals non-streamed action.
- Partial stream interruption executes nothing.
- Invalid final streamed action follows the same corrective retry path.
- Timeout, retry, and disconnect behavior.
- Plain/JSON/test output remains deterministic.

### Exit Gate

- Streaming improves feedback while preserving validate-before-execute semantics.
- No partial or interrupted response can call a tool.
- Durable session logs do not capture private reasoning by default.

## M11: Add Deterministic Context Budgeting and Compaction

### Objective

Keep long interactive sessions within local model context limits without losing hard state or safety-relevant history.

### Dependencies

M10.

### Context Layers

Always preserve:

- System/tool contract.
- Current user request.
- Repository and policy summary.
- Current transaction and changed-file ledger.
- Approval decisions relevant to the request.
- Verification outcomes.
- Unresolved tool errors.
- Recent model/tool turns.

Eligible for truncation or replacement:

- Old full file contents.
- Repeated search results.
- Old successful tool output.
- Earlier completed request transcripts.

### Implementation Tasks

1. Add a conservative character/token estimator.
2. Budget prompt sections explicitly.
3. Truncate individual tool results before appending.
4. Add deterministic compaction that replaces old tool messages with factual records from hard state.
5. Add optional model-generated narrative summary only as advisory context.
6. Emit compaction events with counts and sizes, not removed sensitive content.
7. Stop with `context_limit` if the required minimum state cannot fit safely.
8. Add configurable context thresholds derived from model configuration.

### Files

Add:

- `packages/core/src/context/budget.ts`
- `packages/core/src/context/compact.ts`
- `packages/core/test/unit/contextBudget.test.ts`
- `packages/core/test/unit/contextCompaction.test.ts`

Modify:

- `packages/core/src/runtime/ConversationState.ts`
- `packages/core/src/runtime/ToolLoopRunner.ts`
- `packages/core/src/model/config.ts`
- `packages/core/src/runtime/EventBus.ts`

### Tests

- No compaction below threshold.
- Old read/search results compact first.
- Changed files, verification, approvals, and current errors survive.
- Multiple completed requests compact deterministically.
- Minimum required state exceeding limit stops safely.
- Compacted prompts remain stable snapshot inputs for fake-model tests.

### Exit Gate

- Long sessions remain under configured limits.
- Safety and transaction state never depend on lossy summaries.
- Compaction behavior is deterministic, tested, and visible in replay metadata.

## M12: Benchmarks, Rollout, Documentation, and Cleanup

### Objective

Prove the new experience is more capable without safety regressions, then decide whether it becomes the default entry point.

### Dependencies

M11, plus remaining tolerance milestones required by the benchmark gate.

### Benchmark Harness

Implement the existing stubs:

- `bench/runner.ts`
- `bench/suites/b1_simple_edit.ts`
- `bench/suites/b2_multifile_refactor.ts`
- `bench/suites/b3_fix_failing_test.ts`
- `bench/suites/b5_safety_escape.ts`

Add interactive-loop cases:

- Read-only repository question.
- Exact single-file edit.
- Multi-file refactor.
- Failing test diagnosis and fix.
- Rejected edit with corrective feedback.
- Repeated-action loop.
- Malformed model action recovery.
- Context compaction.
- Path escape, symlink escape, command denial, and auto-approval safety.
- Incomplete transaction recovery and undo.

### Rollout Metrics

Track at minimum:

- Task completion rate.
- Valid action rate.
- Average model turns per completed task.
- Tool error/retry rate.
- Patch apply success rate.
- Verification pass rate.
- Loop-stop frequency by reason.
- Safety benchmark pass rate.
- Undo/recovery success rate.
- Median time to first visible progress and completion.

### Required Gates

- All safety escape benchmarks pass.
- No invalid or unapproved patch is applied.
- No non-allowlisted command executes.
- Existing one-shot CLI tests remain green.
- Interactive benchmark completion rate is measurably better than one-shot behavior on multi-step tasks.
- Package build, npm tarball creation, global binary smoke, and `agent doctor` pass in supported environments.

### Documentation Tasks

Update:

- `README.md`
- `RUNNING_AGENT.md`
- `docs/architecture.md`
- `docs/policy.md`
- `docs/security.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `tasks.md`
- `tolerance-pipeline-plan.md`
- Milestone implementation notes as appropriate

Document:

- `agent chat` startup and slash commands.
- Approval and session auto-approval semantics.
- Tool list and hard restrictions.
- Transaction and undo behavior.
- Streaming modes.
- Context compaction.
- Status/replay event meaning.
- Non-interactive automation remains on existing subcommands.

### Cleanup Decisions

Only after rollout gates pass:

1. Decide whether bare `agent` launches chat.
2. Decide whether `agent ask` should internally use a one-request ToolLoopRunner mode.
3. Deprecate legacy `AgentOutput.tool_calls` only with a compatibility window.
4. Split remaining orchestration out of `packages/cli/src/commands/shared.ts`.
5. Version session/event schema if external consumers need stability.
6. Add transaction retention/cleanup commands rather than automatic silent deletion.

### Exit Gate

- The complete interactive workflow is tested, benchmarked, documented, packaged, and recoverable.
- Safety results are at least as strong as the pre-alignment baseline.
- Default-command changes are made only from evidence, not merely because Offline Cursor uses a REPL.

## Pull Request Sequence

Each row should be independently reviewable and keep the repository buildable.

| PR | Scope | Depends On | Main Verification |
| --- | --- | --- | --- |
| 1 | Finish T2 normalization and raw-output diagnostics | None | Formats, AgentRunner, CLI failure tests |
| 2 | Interactive action types, parser, and prompts | PR 1 | Action parser unit tests |
| 3 | New event contracts and SessionStore compatibility | PR 2 | Event/session tests |
| 4 | Read-only registry and dispatcher | PR 3 | Tool/policy unit tests |
| 5 | ConversationState and LoopDetector | PR 4 | State/loop tests |
| 6 | Read-only ToolLoopRunner | PR 5 | Scripted LLM integration tests |
| 7 | Read-only `agent chat` | PR 6 | CLI session tests |
| 8 | Approval contract and terminal prompt | PR 7 | Core/CLI approval tests |
| 9 | TransactionStore and transactional undo | PR 8 | Crash/undo tests |
| 10 | Exact replacement edit tool | PR 9 | Edit/policy/transaction tests |
| 11 | Create and delete file tools | PR 10 | Mutation regression tests |
| 12 | Check discovery and command tools | PR 11 | Command/fix-loop tests |
| 13 | Input requests and session commands | PR 12 | Multi-request CLI tests |
| 14 | Streaming presentation and cancellation | PR 13 | Adapter/stream interruption tests |
| 15 | Context budgeting and compaction | PR 14 | Long-session tests |
| 16 | Benchmark harness and safety suites | PR 15 | Bench reports and rollout gates |
| 17 | Documentation, packaging, default UX decision | PR 16 | Build/test/lint/smoke/package |

Patch sanitization, deterministic diff repair, and bounded one-shot repair from Tolerance T3-T6 can land in separate PRs between PR 1 and PR 16. Shared normalizers and events should be reused, but those changes must not be bundled into unrelated tool-loop PRs.

## Validation Ladder

For each implementation PR, run validation from narrowest to broadest:

1. Changed-module unit tests.
2. Package unit tests.
3. TypeScript build.
4. Formatter/linter checks.
5. CLI integration tests or fixture tests.
6. Safety regression tests for any policy, path, patch, approval, or command change.
7. Benchmark slice when a runnable vertical feature exists.
8. Full workspace tests before milestone completion.
9. Smoke/package checks before rollout.

Do not fix unrelated baseline failures as part of an alignment PR. Record them separately.

## Feature Completion Checklist

The full program is complete only when all statements are true:

- [x] `agent chat` supports multiple requests in one process.
- [x] The model selects exactly one validated action per turn.
- [x] Read-only tools are repository-scoped and bounded.
- [x] Malformed output receives at most bounded corrective retries.
- [x] Repeated action/error loops stop safely.
- [x] Approval supports approve, reject, feedback, session auto-approval, and abort.
- [x] Hard policy denials cannot be overridden by session mode.
- [x] File edits use validated patch-backed tools.
- [x] Multi-edit requests have durable transaction journals.
- [x] `agent undo` reverts the latest request transaction.
- [x] Only policy-allowlisted commands can run.
- [x] Failed verification can drive a bounded edit/retest cycle.
- [x] Human input requests pause and resume safely.
- [x] Streaming never executes partial actions.
- [x] Long sessions compact without losing hard state.
- [x] Status and replay explain requests, tools, approvals, edits, commands, and stop reasons.
- [x] Existing subcommands and `--json` automation remain supported.
- [x] Safety benchmarks pass with and without session auto-approval.
- [x] Documentation matches actual defaults and behavior.
- [x] Build, tests, lint, smoke, package, and distribution checks pass.

## Source-backed implementation note (2026-09-28)

The robustness follow-through adds capabilities that were not represented by the older checkbox list:

- Direct registered-tool action types and unambiguous tool-only envelopes normalize into canonical `tool_call` actions; unknown or ambiguous forms fail.
- Tool argument schemas validate before dispatch, and repair prompts include the invalid response, exact error, canonical envelope, exact selected schema, and corrected example.
- `replace_file` provides a validated, approved, transactional whole-file fallback with optional SHA-256 stale-content checking.
- `ConversationState` retains bounded request, clarification, inspected/changed file, error, approval, verification, action, and result facts across requests.
- Hybrid context reads explicit paths directly, lists tiny/blank repositories, and searches extracted fixed-string identifiers.
- Completion checks use hard changed-file, explicit-target, requested-empty-content, and successful-verification facts.
- `agent doctor --protocol` performs an optional harmless action-format probe without dispatch.
- Deterministic benchmarks cover creation, editing, continuity, failed-check repair, escape/command/auto-approval safety, and undo; `npm run bench:live` is the opt-in Qwen/Ollama gate.

The optional live `qwen2.5-coder:14b` acceptance run remains environment-dependent and must not be marked passed until executed with a reachable local Ollama installation. The legacy one-shot tolerance milestones T3–T6 also remain separate work.
