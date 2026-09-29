# Local Coding Agent vs. Offline Cursor

## Purpose and Scope

This document compares the current source trees at:

- Local Coding Agent: `local-coding-agent/`
- Offline Cursor: sibling repository `../offline_cursor/`

The comparison focuses on runtime architecture, user experience, model protocol, tools, editing, safety, state, and testability. "Look more like Offline Cursor" is interpreted as matching its interactive terminal experience and autonomous tool loop, not copying its language, file layout, or weaker safety choices.

## Executive Summary

The two projects share the same product premise—an Ollama-backed coding agent that works locally—but currently optimize for different things.

Offline Cursor is an interactive agent loop. It keeps a conversation alive, lets the model choose one tool at a time, executes that tool, feeds the result back to the model, and repeats for up to 50 steps. Its terminal UX shows step progress, optional streamed model output, tool results, and per-operation approval prompts. This makes it feel like an agent even though its internals are compact and loosely coupled.

Local Coding Agent is a safer, more structured patch pipeline. `agent ask` gathers context before the model call, requests one strict JSON response, validates and queues a unified diff, and stops. Applying, testing, undoing, status inspection, replay, and diagnostics are separate commands. Its architecture, policy enforcement, rollback, event logs, automated tests, and package boundaries are stronger, but its main interaction feels like a sequence of CLI utilities rather than a continuous coding session.

The main alignment task is therefore to add a genuine bounded tool loop and interactive shell to Local Coding Agent while retaining its existing safety and observability advantages.

## Repository Shape

| Area | Local Coding Agent | Offline Cursor |
| --- | --- | --- |
| Language | TypeScript, ESM, Node.js 18+ | Python 3.11+ |
| Structure | npm workspace with `core` and `cli` packages | One entry point plus a `utils` package |
| CLI framework | Commander subcommands | `argparse` flags plus a custom REPL |
| Model dependency | Custom Ollama HTTP adapter behind `LLM` | Python `ollama` package called directly |
| Main runtime | `AgentRunner` one-shot retrieve/model/parse flow | `run_coding_agent_loop` multi-step conversation loop |
| Distribution | npm packages/tarballs and global `agent` binary | Run `python coding_agent.py` |
| Tests | Vitest unit suites for core and CLI | No tracked tests |
| Persistent state | `.agent` policy, model config, patch state, JSONL sessions | In-memory conversation and action history only |

## Runtime Control Flow

### Local Coding Agent

Current `agent ask` flow:

```text
Commander command
  -> validate initialized repository
  -> load model and policy configuration
  -> gather context from task terms
  -> make one Ollama completion request
  -> parse one strict JSON envelope
  -> validate unified diff contract and policy
  -> queue patch (unless dry-run)
  -> print plan and diff
  -> stop
```

Optional `--autopilot` adds a narrow apply/test/fix sequence. It can apply the generated patch, run one discovered allowlisted test command, and ask the model for one corrective patch after failure. This is not a general tool loop: the model cannot inspect arbitrary additional files, choose tools after seeing results, or decide among actions during the run.

`AgentRunner` currently emits `tool_call` and `tool_result` only for the built-in context gatherer. Although the model output schema contains `tool_calls`, those calls are returned as data and are not dispatched.

### Offline Cursor

Current session flow:

```text
start process
  -> create and enter a local projects/ directory
  -> initialize runtime flags
  -> repeatedly collect multiline user input
  -> for each request, iterate up to 50 times:
       call Ollama with full conversation
       parse the first model-selected tool call
       detect loops
       request approval if required
       execute the tool
       display and append the result
       repeat until task_complete
  -> retain conversation for the next user request
```

This creates the stronger agent-like experience: the model observes each result before selecting its next action, and the user stays in one session.

## Model Protocol

### Local Coding Agent

The system prompt requires exactly one JSON object with:

```json
{
  "plan": "string",
  "patch": "unified diff or null",
  "commands": ["suggested commands"],
  "done": true,
  "tool_calls": [{ "tool": "name", "args": {} }]
}
```

Strengths:

- Machine-readable and explicitly validated.
- Unknown keys and invalid field types are rejected.
- Patch text must pass a strict unified-diff contract.
- Raw model output is retained on parsing failures in the current worktree.
- The Ollama adapter has timeouts, retries, context-limit propagation, and actionable errors.

Limitations:

- The envelope combines plans, final edits, command suggestions, completion, and retrieval intents in one response.
- `done` does not control an iterative runtime.
- `tool_calls` are not executed.
- A malformed final patch invalidates the whole one-shot run.
- There is no model-visible cycle of tool call, result, reflection, and next action.

### Offline Cursor

The model emits text in the form `tool: tool_name({...})`. A regex-based parser locates a known tool, normalizes multiline string literals, and parses arguments with JSON or Python literal parsing. Only the first parsed invocation is executed.

Strengths:

- Simple enough for smaller local models.
- Naturally supports one action per turn.
- Parse failures are fed back to the model so it can retry.
- Explicit `task_complete` provides a runtime termination signal.

Limitations:

- The protocol is less structurally reliable than strict JSON.
- Parser recovery can change literal content.
- Completion is partly inferred from phrases if the model forgets `task_complete`.
- Tool descriptions are generated from Python function signatures and docstrings, coupling the prompt to implementation details.

## Context and Repository Inspection

Local Coding Agent performs deterministic context gathering before the model call. It searches terms derived from the task, reads bounded excerpts, and serializes search results and file excerpts into the prompt. Core tools also exist for file listing, file reading, ripgrep search, git status, and git diff, but the current agent loop does not expose them as executable model actions.

Offline Cursor starts with no automatic repository map. The system prompt lists tools, and the model uses `list_files`, `read_file`, `view_file`, `search_in_files`, environment inspection, and commands to build context over multiple turns. This is less token-efficient but more adaptive when the initial task wording does not identify the right files.

The best target is hybrid: retain bounded initial context gathering, then let the model request additional read-only tools when needed.

## Tool and Capability Matrix

| Capability | Local Coding Agent | Offline Cursor | Alignment Note |
| --- | --- | --- | --- |
| List files | Core tool exists | Model-callable | Make the core tool model-callable |
| Read whole file | Core tool exists with policy/size limits | Model-callable | Preserve local limits |
| View line range | Not a distinct model tool | Model-callable | Add bounded range reads or extend read input |
| Search code | Core ripgrep tool exists | Python regex walk with glob | Expose ripgrep through the loop |
| Git status/diff | Core tools exist | Usually via shell | Prefer dedicated core tools |
| Environment inventory | Doctor checks, not an agent tool | Model-callable | Add only if needed for package decisions |
| Package availability | Not a model tool | `check_installed` | Consider a read-only environment tool |
| Create/overwrite file | Only through unified patch | Direct write tool | Keep patch-backed writes |
| Exact search/replace | No model-facing equivalent | `apply_diff` exact replacement | High-value addition; implement as patch generation |
| Line insert/replace/delete | No model-facing equivalents | Direct mutation tools | Prefer range-aware patch tools, not direct writes |
| Delete path | Unified diff can delete files | Direct recursive delete tool | Keep patch validation and avoid recursive directory delete |
| Run command | Core allowlisted tool | Broad shell tool with pattern blocks | Keep strict local allowlist |
| Apply patch | Dedicated validated pipeline | Exact text replacement per file | Preserve local pipeline |
| Undo | Stored reverse patch plus git fallback | None | Preserve local advantage |
| Task completion | `done` field in one-shot output | Explicit `task_complete` tool | Add an explicit loop completion action |

## Editing Model

Local Coding Agent treats the model as a patch proposer. The patch is parsed, checked for path containment, file count, byte size, hunk consistency, and binary content, then queued. Application is separately confirmed and recorded with reverse patches for undo. This design is auditable and should remain the foundation.

Offline Cursor lets individual tools mutate files immediately after approval. It supports whole-file writes, line-number edits, deletion, and an exact-search `apply_diff` operation that creates a preview and then writes the result. This provides quick feedback and is easier for the model than generating a complete unified diff, but it has no transaction spanning multiple tool calls and no built-in rollback history.

To match the feel safely, Local Coding Agent should expose edit intents as tools while internally translating them into validated patches. For example, an `edit_file` tool can accept exact old/new text, construct a unified diff, show the preview, pass through policy and approval, apply it, and record rollback metadata. The user sees an immediate tool action; the system retains patch safety.

## Terminal Experience

### Local Coding Agent Today

- One command invocation per operation.
- Task must be supplied as a command argument.
- Human output is line-oriented, with a colored diff preview.
- Confirmation is a basic `[y/N]` prompt for apply and command execution.
- `--json` supports automation.
- `--plain`, `--dry-run`, `--no-apply`, `--explain-patch`, `--autopilot`, and `--yes` cover useful scripted workflows.
- `status`, `replay`, `doctor`, `undo`, and separate `test` are strong operational features.
- No persistent chat prompt, live step counter, model streaming, approval feedback, or session auto-mode toggle.

### Offline Cursor Today

- Persistent REPL with multiline input terminated by `SUBMIT`.
- Conversation survives across user requests in the same process.
- Displays `[Step n/50]`, the beginning of each raw model response, selected tool, result summary, and completion.
- Optional silent or streamed model output.
- Approval UI labels moderate/high risk, previews the exact operation, and accepts yes, no, session auto-mode, or free-form feedback.
- Tracks files created during the process and reports them at completion.
- Uses ANSI colors and symbols extensively.
- No structured JSON output or standalone operational commands.

## Safety Comparison

### Local Coding Agent Strengths

- Repository-root discovery and normalized path containment.
- Symlink-aware path resolution.
- Explicit allowed repository roots.
- Exact command allowlist rather than a blacklist-first shell policy.
- File, patch, and file-count size limits.
- Patch validation before writes.
- Confirmation settings stored in repository policy.
- Command timeout and output truncation.
- Rollback metadata and `undo`.
- Non-interactive confirmation failure unless explicitly bypassed.

### Offline Cursor Strengths and Weaknesses

- Starts in a generated `projects/` directory to reduce accidental parent access.
- Classifies tools as safe, moderate, or high risk.
- Blocks known dangerous commands and system write paths.
- Allows rejection feedback and a per-session auto mode.
- Its broad command pattern allowlist permits classes such as `git`, `python`, and `kubectl`, which is less restrictive than Local Coding Agent's exact configured allowlist.
- Auto mode bypasses all moderate/high approval prompts after forbidden-pattern checks.
- Read operations may access system paths.
- Path checks permit writes under the user's home directory, not only the active project.
- Direct edit tools do not provide the local project's transactional patch record and undo behavior.

The alignment must adopt Offline Cursor's approval ergonomics without adopting its broader trust boundary.

## Loop Control and Recovery

Offline Cursor has practical runtime recovery features absent from the local one-shot loop:

- Maximum 50 model/tool steps per user request.
- Repeated action signatures and repeated errors are detected.
- Two no-tool responses trigger a stronger tool/completion nudge.
- Parse errors are returned to the model with corrective instructions.
- Long conversations are compacted by retaining the system prompt, a minimal summary, and recent messages.

Local Coding Agent has stronger model transport recovery:

- Request timeout and bounded retry with backoff.
- Strict schema and patch-contract diagnostics.
- Failure categories persisted in session metadata.
- A tolerance pipeline is being developed for safe output normalization and repair.
- Autopilot has a fixed two-attempt test loop.

The future tool loop should combine both: transport retries, deterministic parsing recovery, per-step loop detection, bounded corrective retries, and event logging.

## State, Observability, and Reproducibility

Local Coding Agent records every CLI command as a JSONL session with metadata and typed events. It persists pending patch state and the last applied/reverse patch. Sessions can be inspected with `status` and replayed. This is a major architectural advantage.

Offline Cursor keeps conversation, created-file tracking, action history, and recent errors in process memory. Nothing survives process exit, and there is no deterministic replay artifact.

An interactive local session should use the existing `SessionStore`, with one session per REPL process or one parent session containing request boundaries. Events should include model turn, tool call, policy decision, approval result, tool result, compaction, completion, and interruption.

## Testing and Maintainability

Local Coding Agent has core/CLI separation, narrow interfaces, dependency injection for CLI runtime and LLM behavior, Vitest coverage, linting, build configuration, CI history, and package distribution. Its larger `packages/cli/src/commands/shared.ts` is already becoming a concentration point and should not absorb the interactive runtime.

Offline Cursor's small modules are easy to read, but global configuration, direct terminal I/O, hand-written registry dispatch, lack of tests, and a central loop tied to concrete Ollama calls make behavior harder to isolate and verify.

New alignment work should live primarily in reusable core runtime modules with a thin CLI presenter, rather than reproducing Offline Cursor's monolithic entry-point loop.

## Documentation Drift Found During Review

Agents should use source code as the authority because both repositories contain stale statements:

- Offline Cursor's README line counts and listed project files predate several modules.
- Offline Cursor's README says Qwen 2.5 Coder 14B, while `utils/model_config.py` currently selects `qwen3-coder:30b`.
- Offline Cursor's system prompt still tells the model to call a removed `auto_lint_format` tool; it is not present in the registry.
- Offline Cursor's model guide says the legacy call in `coding_agent.py` consumes model constants, but that function delegates to the streaming module.
- Local Coding Agent's README and security docs describe read-only defaults, while `DEFAULT_SAFE_MODE_POLICY.readOnly` is currently `false`; apply still requires confirmation by default.
- Local Coding Agent's milestone checklist contains unchecked tasks that source and implementation notes indicate are implemented.

## What to Preserve and What to Adopt

Preserve from Local Coding Agent:

- TypeScript workspace and core/CLI boundary.
- Strict repository-scoped policy.
- Patch validation, pending patch workflow, and undo.
- Exact command allowlist, timeouts, and output caps.
- JSON mode, operational subcommands, diagnostics, and replay.
- Model adapter abstraction and automated tests.

Adopt from Offline Cursor:

- Persistent interactive session.
- Model-selected read/tool/action loop.
- One clear action per model turn.
- Visible step progress and concise tool results.
- Streaming as an optional presentation mode.
- Risk-aware operation previews.
- Approval choices for yes, no, session auto mode, and feedback.
- Explicit completion action.
- Loop detection, corrective nudges, and bounded conversation compaction.

