# Offline Cursor Alignment Plan

> This document describes the target architecture and product phases. Use [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md) as the canonical execution order and [`IMPLEMENTATION_GUIDE.md`](IMPLEMENTATION_GUIDE.md) for coding constraints.

## Product Goal

Create a local coding-agent experience that feels continuous and collaborative like Offline Cursor while remaining safer, more auditable, and easier to automate.

A successful session should look like this:

```text
$ agent chat
Local Agent ready — model, repository, and policy summary

You> Fix the failing parser tests

[1/40] Searching for parser tests...
[2/40] Reading packages/core/src/...
[3/40] Proposed edit to 2 files
Approve this patch? [y/N/a/feedback]
[4/40] Running allowlisted test command...
[5/40] Tests passed

Completed: fixed parser handling and added coverage.
You>
```

Existing commands such as `agent ask`, `agent apply`, `agent test`, `agent undo`, `agent status`, `agent replay`, and `agent doctor` should continue to work.

## Design Principles

1. **Interactive behavior, structured internals.** The terminal can feel conversational while the runtime uses typed actions and results.
2. **One action per turn.** Small local models are more reliable when choosing one tool or completion action at a time.
3. **Hybrid context.** Seed the model with bounded relevant context, then allow adaptive retrieval.
4. **Patch-backed mutation.** Present edits as immediate tools but implement them through validated, reversible patches.
5. **One policy boundary.** Every read, edit, and command must pass through a common dispatcher and policy decision.
6. **Bounded autonomy.** Limit steps, retries, output, command time, changed files, and context growth.
7. **Observable by default.** Persist enough typed events to understand and replay what happened.
8. **Automation remains first-class.** Interactive features must not degrade `--json` or non-TTY behavior.

## Target Architecture

```text
packages/cli
  InteractiveSession / terminal presenter
           |
           v
packages/core
  ToolLoopRunner
    -> ConversationState
    -> LLM adapter
    -> Action parser
    -> ToolDispatcher
         -> policy evaluation
         -> approval callback
         -> read/search/git tools
         -> patch-backed edit tools
         -> allowlisted command tool
    -> LoopDetector
    -> Session event callback
```

Core should express approval as an injected callback, not read from stdin. The CLI callback owns TTY prompts and rendering. This keeps the runtime testable and UI-independent.

## Recommended Action Protocol

Replace the current all-in-one response as the loop's internal protocol with a discriminated JSON action. Keep the old output parser for compatibility with `agent ask` during migration.

Tool action:

```json
{
  "type": "tool_call",
  "summary": "Inspect the parser implementation",
  "tool": "read_file",
  "args": { "path": "packages/core/src/parser.ts", "startLine": 1, "endLine": 240 }
}
```

Completion action:

```json
{
  "type": "complete",
  "summary": "Fixed parser handling and verified focused tests.",
  "changedFiles": ["packages/core/src/parser.ts"],
  "verification": ["npm test -- parser"]
}
```

Blocked/question action, if human input is genuinely required:

```json
{
  "type": "request_input",
  "question": "Should the parser reject unknown keys or ignore them?",
  "context": "Existing tests cover both interpretations."
}
```

Do not ask the model to return a final patch, command list, completion boolean, and future tool calls simultaneously during interactive operation.

## Phased Delivery

### Phase 0: Lock the Runtime Contract

Define typed loop actions, tool results, stop reasons, options, and events. Add parser tests using representative valid, fenced, prefixed, truncated, and malformed local-model outputs. Decide how the current tolerance normalizer is reused without weakening schema validation.

Deliverables:

- Typed `AgentAction` union.
- Strict parser and deterministic envelope normalization.
- `ToolLoopOptions` with step, context, and retry bounds.
- New event types or event payloads for model turns, approvals, and loop stops.

Exit criteria:

- Malformed output never executes a tool.
- Exactly one action is accepted per model turn.
- Parsing failures preserve raw output for diagnostics.

### Phase 1: Read-Only Tool Loop

Implement `ToolLoopRunner` with only safe retrieval tools: list files, read bounded file ranges, search code, git status, and git diff. Feed each structured tool result back into conversation state and let the model select the next action.

Deliverables:

- Core tool registry/dispatcher.
- Tool descriptions independent of concrete function signatures.
- Read-only loop with explicit completion and maximum steps.
- Action/error history and repeated-action detection.
- Unit tests with a scripted fake LLM.

Exit criteria:

- A fake model can list, search, read, and complete over multiple turns.
- Every tool call and result is emitted as a session event.
- Repeated identical actions and repeated identical errors stop or trigger a bounded corrective message.
- No side effects are available in this phase.

### Phase 2: Interactive CLI Shell

Add `agent chat` as a new command. Preserve all existing commands. Support a normal single-line prompt and a documented multiline mode; do not require the literal `SUBMIT` convention unless user testing shows it is preferable.

Deliverables:

- Persistent session accepting multiple requests.
- Startup summary for repository, model, approval mode, and available test command.
- Step indicator, tool-call summaries, concise result rendering, completion summary, and Ctrl+C handling.
- Optional `--stream`, `--plain`, `--json`, and max-step flags with clear compatibility rules.
- One `SessionStore` lifecycle for the interactive process, with request boundary events.

Exit criteria:

- The user can complete multiple read-only requests without restarting the CLI.
- Ctrl+C interrupts the active request safely; a second interrupt exits if that behavior is chosen.
- Non-TTY execution never hangs waiting for input.
- Existing command tests remain green.

### Phase 3: Approval and Feedback UX

Generalize approval beyond yes/no. The core dispatcher should return an operation preview and risk metadata to an injected CLI approval callback.

Approval outcomes:

- Approve once.
- Reject with a standard reason.
- Reject with free-form corrective feedback that is returned to the model.
- Enable auto-approval for the current session, bounded by repository policy.
- Abort the request.

Auto mode must never override path containment, patch limits, command allowlists, or hard policy denials. It only skips confirmations that policy marks as confirmable.

Exit criteria:

- Feedback changes the next model turn without executing the rejected action.
- Session auto mode does not persist unless an explicit future feature adds that option.
- Approval decisions and hard denials are logged.

### Phase 4: Patch-Backed Editing Tools

Introduce editing tools in increasing order of complexity:

1. `edit_file` exact search/replace.
2. `create_file` with an expected nonexistence precondition.
3. `delete_file` for files only.
4. Optional line-range replacement if model benchmarks show it adds value.

Each tool should read the current file, validate preconditions, construct a unified diff, validate it through the existing patch pipeline, render a preview, request approval, apply it, and record reverse-patch metadata.

Avoid exposing unrestricted whole-file overwrite and recursive directory deletion merely to match Offline Cursor. Those operations are error-prone for local models and weaken existing guarantees.

Exit criteria:

- Stale exact-match edits fail without changing files.
- Every edit can be previewed and is policy-checked.
- A completed request can report all files changed.
- Undo behavior is clearly defined for multi-edit sessions: either one transaction or a documented stack. Prefer a session transaction before enabling many sequential edits.

### Phase 5: Command and Verification Loop

Expose the existing `RunCommandTool` through the dispatcher. Commands remain limited by repository policy. Prefer dedicated test/lint actions selected from discovered and allowlisted commands rather than arbitrary shell text.

Deliverables:

- Model-callable allowlisted command action.
- Streaming or incremental command output events.
- Bounded fix/verify cycle driven by tool results.
- Clear distinction between command failure, timeout, truncation, and policy denial.

Exit criteria:

- The model can edit, run an allowlisted focused test, inspect failure output, correct the edit, and complete.
- Step and retry bounds prevent endless fix loops.
- Command output supplied to the model is truncated deterministically with an explicit marker.

### Phase 6: Streaming and Context Compaction

Wire the existing optional `LLM.stream` and `OllamaAdapter.stream` capability into the runtime only after the action loop is stable. Separate raw token streaming from trusted structured action rendering so partial JSON is never treated as an executable action.

Implement deterministic conversation compaction based on token/character budgets. Preserve the system prompt, repository/policy summary, changed-file ledger, unresolved errors, user decisions, and recent turns. Generated summaries must never silently replace hard state.

Exit criteria:

- Streaming can be disabled for tests and JSON output.
- Interrupted partial actions never execute.
- Long sessions remain under configured context limits.
- Compaction is visible in session events and does not lose changed-file or approval state.

### Phase 7: Default Experience and Cleanup

After benchmarks and user testing, decide whether bare `agent` should launch chat while subcommands remain available. Update README, architecture, policy, security, and running guides. Remove obsolete prompt fields only after migration compatibility is no longer needed.

Exit criteria:

- End-to-end benchmark tasks show a measurable gain over one-shot `agent ask`.
- Safety regression suites pass.
- Documentation matches source defaults and actual behavior.
- Packaging and global install smoke tests include the interactive command.

## Suggested Tool Set

Initial read-only tools:

- `list_files(path, depth?, limit?)`
- `read_file(path, startLine?, endLine?)`
- `search_code(query, path?, glob?, limit?)`
- `git_status()`
- `git_diff(path?)`

Mutation and verification tools added later:

- `edit_file(path, oldText, newText)`
- `create_file(path, content)`
- `delete_file(path)`
- `run_check(checkId)` where `checkId` maps to a discovered allowlisted command
- `run_command(command)` only when the exact command is allowlisted
- `complete(summary, verification?)`

Environment inspection can be added if benchmarks show repeated unnecessary package installation attempts. It should return bounded, structured facts rather than large package dumps.

## Session and Event Model

Extend the event model deliberately. Recommended events:

- `request_started`
- `model_started`
- `model_output` or a metadata-only completion event
- `tool_call`
- `policy_decision`
- `approval_requested`
- `approval_resolved`
- `tool_result`
- `patch_proposed`
- `patch_applied`
- `command_started`
- `command_output`
- `context_compacted`
- `request_completed`
- `request_stopped`
- existing terminal `done` / `error`

Do not persist private chain-of-thought. Streaming should show only model output that the selected model/API intentionally exposes, and logs should favor structured actions and summaries.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Small model emits malformed actions | Strict one-action schema, deterministic normalization, one bounded corrective retry |
| Tool loop consumes excessive context | Bounded results, range reads, search limits, deterministic compaction |
| Interactive runtime becomes coupled to TTY | Inject approval and event callbacks; keep loop in core |
| Auto mode weakens safety | Skip prompts only; never bypass hard policy checks |
| Sequential edits make undo ambiguous | Build a transaction or patch stack before broad mutation support |
| Partial streamed JSON executes | Buffer and validate complete action before dispatch |
| Existing `ask` behavior regresses | Add `chat` alongside it and share internals incrementally |
| `shared.ts` becomes larger | Move orchestration into focused core and CLI session modules |

## Definition of Done

The alignment is complete when a user can launch one local terminal session, ask a multi-step coding task, observe adaptive repository inspection, approve or redirect edits, see allowlisted verification run, receive an explicit completion summary, continue with a follow-up request, inspect the session afterward, and undo changes—without sacrificing repository containment, patch validation, command restrictions, or structured automation.
