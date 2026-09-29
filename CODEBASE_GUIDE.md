# Local Coding Agent: Codebase and Architecture Guide

This document explains the current `local-coding-agent` codebase from the ground up. It is written
for someone who has never seen the repository and wants to understand what runs, where state lives,
how model output becomes a file change, and which guarantees and limitations exist today.

The source code is the authority. Some planning documents describe the desired end state or retain
stale checklist items, so this guide calls out current behavior separately from future work.

## 1. What this project is

Local Coding Agent is a TypeScript command-line coding assistant backed by a local Ollama model. It
supports two different ways of working:

1. **One-shot patch workflow (`agent ask`)**: the model receives a task and bounded repository
   context, then returns one structured response containing a plan and unified diff. The diff is
   validated and queued. Applying and testing are explicit follow-up operations unless autopilot is
   enabled.
2. **Interactive tool workflow (`agent chat`)**: the model chooses one action per turn, observes
   tool results, and repeats until it completes, asks a question, or reaches a stop condition.

These are separate runtimes with separate model-response contracts. Much of the confusion in this
codebase comes from assuming that `ask` and `chat` are two interfaces over the same loop. They are
not.

The project tries to combine:

- local inference through Ollama;
- an agent-like, multi-step terminal experience;
- repository-scoped filesystem access;
- exact command allowlisting;
- human approval for mutations and commands;
- patch validation and reversible edits;
- persistent session and transaction records;
- deterministic unit tests and safety benchmarks.

## 2. Repository layout

```text
local-coding-agent/
├── packages/
│   ├── core/                 Model, prompts, runtimes, tools, policy, patches, state
│   └── cli/                  Commander commands, terminal I/O, configuration, rendering
├── bench/                    Deterministic benchmarks and optional live Ollama benchmark
├── fixtures/                 Small repositories used by tests and benchmarks
├── docs/                     Architecture, policy, security, and Offline Cursor planning
├── scripts/                  Release, smoke, and failure-report scripts
├── package.json              npm workspace scripts
├── tsconfig.build.json       TypeScript project references for core and CLI
├── tasks.md                  Product milestones and benchmark checklist
└── tolerance-pipeline-plan.md
                              Planned recovery work, especially for one-shot model output
```

The repository is an npm workspace. `@local-agent/core` deliberately has no terminal UI dependency.
`@local-agent/cli` depends on core and owns Commander, stdin/stdout, prompts, and human rendering.

## 3. High-level architecture

```text
User terminal
    │
    ▼
Commander CLI (`packages/cli`)
    │
    ├── one-shot commands ──► AgentRunner
    │                           │
    │                           └── plan + unified-diff response
    │
    └── `agent chat` ───────► ToolLoopRunner
                                │
                                ├── ConversationState
                                ├── action parser and repair
                                ├── ToolDispatcher
                                ├── policy and approval
                                └── TransactionStore

Both paths ──► LLM abstraction ──► OllamaAdapter ──► http://localhost:11434
Both paths ──► SessionStore (`.agent/sessions`)
All mutations ──► unified diff validation ──► patch application
```

The central architectural rule is that model text is never trusted as an instruction to write
directly. The response must become a validated action or patch, pass policy checks, and—when
required—receive user approval.

## 4. Packages and ownership boundaries

### `packages/core`

Core contains reusable behavior that does not know about stdin, terminal colors, or Commander:

- `model/`: provider-neutral LLM interfaces, model configuration, Ollama transport;
- `prompts/`: one-shot and interactive prompts and output schemas;
- `actions/`: interactive action types and parsing;
- `runtime/`: the one-shot runner, tool loop, conversation state, events, sessions, transactions;
- `context/`: deterministic initial context gathering;
- `policy/`: configuration and the central allow/deny decision function;
- `tools/`: read/search/git/edit/command operations and the interactive dispatcher;
- `tools/patch/`: unified-diff parsing, validation, application, and rollback;
- `util/`: logging, paths, and shared error types.

`packages/core/src/index.ts` is the public surface consumed by the CLI and benchmarks.

### `packages/cli`

CLI owns the application shell:

- `main.ts`: executable entry point, including symlink-safe global-install detection;
- `app.ts`: registers all `agent` subcommands;
- `commands/*.ts`: thin Commander definitions;
- `commands/shared.ts`: orchestration for the older one-shot commands;
- `lib/interactiveSession.ts`: persistent terminal loop for `agent chat`;
- `lib/agentFs.ts`: `.agent` paths, initialization, status, and legacy patch state;
- `lib/doctor.ts`: environment and optional model-protocol diagnostics;
- `lib/policy.ts`: loads policy and discovers an allowlisted test command;
- `lib/session.ts`: starts and reads command sessions;
- `ui/`: approvals, diff formatting, prompts, and chat event rendering.

`commands/shared.ts` is large because it contains most legacy command orchestration. New interactive
runtime behavior belongs in core rather than growing this file further.

## 5. CLI lifecycle

`packages/cli/src/main.ts` checks whether the module is the actual process entry point. The realpath
comparison matters for the globally installed `agent` symlink. It then builds the Commander program
from `app.ts` and parses `process.argv`.

Registered commands are:

| Command | Purpose |
| --- | --- |
| `agent init` | Create repository-local configuration and state directories |
| `agent ask "task"` | Generate one plan/patch response |
| `agent chat` | Start the interactive one-action-per-turn loop |
| `agent apply` | Validate and apply the last queued one-shot patch |
| `agent test` | Run a discovered, exactly allowlisted test command |
| `agent undo` | Revert the newest interactive transaction or legacy applied patch |
| `agent status` | Show initialization, pending patch, transaction, and session state |
| `agent replay <id>` | Render a stored JSONL session |
| `agent doctor` | Check executables, permissions, configuration, Ollama, and model availability |

Most commands are wrapped by `createActionHandler`. The wrapper:

1. creates a `SessionStore` entry;
2. records `command_started`;
3. calls the command handler;
4. renders human or JSON output;
5. records completion or a structured error;
6. sets the process exit code.

This means operational commands—not only model calls—leave an auditable session record.

## 6. Repository discovery and `.agent`

The CLI treats the nearest ancestor containing `.agent`, `.git`, or `package.json` as the repository
root. Discovery begins at `process.cwd()` and walks upward.

This has an important practical implication: initialize Git or create the project marker before
running `agent init` in an otherwise empty directory, especially if a parent directory is itself a
repository.

`agent init` creates this structure without overwriting existing configuration files:

```text
.agent/
├── policy.json
├── model.json
├── state.json
├── sessions/
├── patches/
└── transactions/
```

### Files in `.agent`

- `policy.json`: allowed roots, exact command allowlist, size limits, and confirmation settings;
- `model.json`: Ollama URL, model, temperature, context size, timeout, and retries;
- `state.json`: paths to the pending and last-applied legacy patches;
- `sessions/*.jsonl`: ordered runtime events;
- `sessions/*.meta.json`: status and summary for each command session;
- `patches/`: the latest proposed/applied/reverse patch for one-shot commands;
- `transactions/*.json`: interactive request edit journals.

Deleting `.agent` deletes project-specific configuration and history. Running `agent init` afterward
regenerates defaults, including the current source default of `timeoutMs: 10000`.

## 7. Model abstraction and Ollama transport

`LLM` is the provider-neutral interface:

```ts
interface LLM {
  complete(prompt, options?): Promise<LLMResponse>;
  stream?(prompt, options?): AsyncIterable<string>;
}
```

Options include the system prompt, temperature, token/context limits, stop strings, and an optional
structured-output JSON Schema.

`OllamaAdapter` turns these options into `/api/chat` requests. It also:

- checks `/api/tags` for server availability and installed models;
- supports Ollama's `format` JSON Schema field;
- can retry without the schema when `fallbackToPrompt` is enabled;
- supports streaming NDJSON;
- retries failed requests with short exponential backoff;
- aborts each request after `timeoutMs`.

The timeout covers the full HTTP request, including cold model loading and inference. The message
“Timed out connecting to Ollama” is therefore broader than its wording suggests. A reachable server
can still produce that error when inference exceeds the configured timeout.

The source defaults are currently:

```json
{
  "model": "qwen2.5-coder:14b",
  "temperature": 0.2,
  "contextLimit": 8192,
  "timeoutMs": 10000,
  "maxRetries": 2
}
```

The interactive loop overrides temperature to `0` unless explicitly supplied, because deterministic
tool selection matters more than creative variation. Ten seconds is commonly too short for a cold
14B model, which is why `doctor` warns about that combination.

## 8. Runtime A: the one-shot `agent ask` pipeline

`AgentRunner` implements the older workflow:

```text
task
  → gather bounded context
  → build one-shot system/run prompt
  → one Ollama completion
  → normalize JSON envelope
  → parse AgentOutput
  → validate patch contract
  → return plan, patch, commands, and events
```

The one-shot `AgentOutput` schema contains:

```ts
{
  plan: string;
  patch: string | null;
  commands: string[];
  done: boolean;
  tool_calls: Array<{ tool: string; args: object }>;
}
```

Despite the `tool_calls` field, this runtime is not a general tool loop. It performs deterministic
context gathering before the model call and expects the model to return a final patch in one answer.

The parser can remove a BOM, strip an outer Markdown fence, and extract the first balanced JSON
object from surrounding prose. It then enforces field types and rejects unknown keys. Patch text must
start with a unified-diff header, contain no Markdown fence, and parse successfully.

After `AgentRunner` returns:

1. the CLI parses and policy-validates the diff again;
2. `--dry-run` previews without saving;
3. otherwise the patch is saved as `.agent/patches/last-proposed.patch`;
4. `agent apply` previews, confirms, revalidates, applies, and stores reverse metadata;
5. `--autopilot` can apply, run one allowlisted test command, and request one corrective patch, for
   at most two apply/test attempts.

This path is automation-friendly and supports `--json`, but it is sensitive to malformed final diffs
and cannot adaptively inspect more files after the single model response.

## 9. Runtime B: the interactive `agent chat` loop

`agent chat` constructs one long-lived set of objects:

- `OllamaAdapter` loaded from the repository model config;
- `ToolDispatcher`;
- `ToolLoopRunner`;
- `ConversationState`;
- `TransactionStore`;
- terminal `SessionView` and approval callback.

For every user request, `ToolLoopRunner.run` performs this bounded cycle:

```text
gather initial context
       │
       ▼
build hard state + recent transcript + tool schemas
       │
       ▼
request exactly one JSON action from the model
       │
       ├── malformed ─► bounded repair prompt ─► retry
       │
       ├── tool_call ─► validate args ─► dispatch ─► append result ─┐
       │                                                           │
       ├── request_input ─► yield to CLI ─► resume same request     │
       │                                                           │
       └── complete ─► validate completion ─► stop or continue      │
                                                                   │
       └───────────────────────────────────────────────────────────┘
```

Default bounds include 40 model/tool steps, a 64,000-character context budget, two repair attempts,
and one alternative-strategy nudge for repeated actions.

### Interactive action types

The model must choose one discriminated action:

```json
{"type":"tool_call","summary":"Read the file","tool":"read_file","args":{"path":"a.ts"}}
```

```json
{"type":"complete","summary":"Implemented and verified the change."}
```

```json
{"type":"request_input","question":"Which behavior should be preserved?","context":"..."}
```

The tool list and exact per-tool argument JSON Schemas are embedded in both the system prompt and the
Ollama structured-output schema.

### Action normalization and repair

`parseAgentActionWithDiagnostics` first applies the generic JSON-envelope normalizer. It then accepts
the canonical action format and two limited Qwen-style variants:

- a registered tool name placed in `type`, with arguments already under `args`;
- a registered `tool` field with no `type`, again with arguments under `args`.

The normalized action still passes strict parsing and per-tool argument validation. Unknown tools or
unknown fields are rejected.

When parsing or argument validation fails, the loop sends the model:

- its bounded invalid response;
- the exact validation error;
- the canonical envelope;
- the selected tool's argument schema and example, when identifiable.

No invalid action executes. Recovery is deliberately bounded.

### Completion validation

The model cannot be trusted merely because it says `complete`. The runtime checks several observable
claims:

- explicit create requests require the named path to exist and appear in the created-file ledger;
- mutation requests with no changes require relevant successful inspection and a concrete reason;
- explicitly named mutation targets must match changed files;
- a requested empty file must actually be empty;
- claims that tests/checks passed require a recorded successful verification command.

Failed completion validation is appended to the model transcript and the loop continues.

### Stop reasons

The loop returns a typed reason:

- `completed`;
- `input_required`;
- `user_aborted`;
- `max_steps`;
- `loop_detected`;
- `parse_retry_exhausted`;
- `context_limit`;
- `model_error`;
- `tool_error`.

Typed stop reasons make session logs and tests more useful than inferring success from prose.

## 10. Conversation state and context

### Initial context gathering

`gatherContext` builds a small deterministic seed before each request. It:

1. extracts path-like tokens from the task;
2. reads explicit in-repository files when they exist;
3. extracts non-stop-word search terms;
4. runs bounded ripgrep searches;
5. includes a bounded repository file listing for small or empty projects;
6. truncates file contents by line and character limits.

The limits favor local models and predictable prompt sizes: five search files, three matches per
file, 200 lines/8,000 characters per seeded file, and 120 repository paths.

### `ConversationState`

Conversation state stores hard facts rather than only a raw chat transcript:

- request ID and original task;
- user clarifications;
- recent actions and bounded tool results;
- inspected, changed, and created files;
- errors, approvals, and verification results;
- summary and stop reason;
- a session-wide changed-file ledger.

The prompt representation keeps at most eight requests by default, limits actions/results, and
compacts older request blocks when the state becomes large. Hard state is safer than relying on a
model-authored narrative summary.

Clarification handling is split between the CLI and runner. When the model returns `request_input`,
the CLI asks the user, reuses the same request ID and transaction, and calls the runner with
`continuation: true`.

## 11. Tool dispatcher

`ToolDispatcher` is the only model-to-tool execution boundary. It owns:

- the registered tool list;
- descriptions, examples, risk levels, and JSON Schemas;
- argument validation;
- policy checks;
- approval calls;
- mutation-to-patch conversion;
- bounded structured results and events.

### Registered tools

| Tool | Risk | Behavior |
| --- | --- | --- |
| `list_files` | safe | Recursively list bounded repository-relative paths; skips `.git`, `.agent`, and `node_modules` |
| `read_file` | safe | Read a bounded UTF-8 line range and return size plus SHA-256 |
| `search_code` | safe | Run bounded ripgrep within the allowed repository |
| `git_status` | safe | Return parsed Git status when available |
| `git_diff` | safe | Return bounded staged or unstaged diff |
| `edit_file` | moderate | Replace one exact unique `oldText` block |
| `create_file` | moderate | Create a path only when it does not already exist |
| `replace_file` | moderate | Replace complete existing contents, optionally guarded by expected SHA-256 |
| `delete_file` | high | Delete one file, never a recursive directory |
| `run_command` | high | Run one exact allowlisted command with timeout/output cap |
| `run_check` | high | Discover and run an allowlisted `test`, `lint`, or `build` command |

Safe means no approval is normally needed, not that policy is skipped. Moderate/high operations go
through policy and approval unless session auto-approval is enabled. Auto-approval bypasses the
prompt only; it cannot override a hard policy denial.

### Editing tools are patch-backed

Interactive mutation methods do not call `writeFile` with model text directly. They:

1. resolve the repository-relative target;
2. evaluate path and size policy;
3. read current content and verify preconditions;
4. construct a whole-file unified diff;
5. parse and validate that diff;
6. prepare a transaction edit record;
7. show a preview and request approval;
8. revalidate stale-content conditions;
9. apply the diff;
10. record reverse patches and hashes.

`edit_file` requires `oldText` to occur exactly once. `replace_file` is the whole-file fallback and
can use the SHA-256 returned by `read_file` to reject stale writes. `create_file` intentionally does
not overwrite, and `delete_file` intentionally does not remove directories.

## 12. Policy and approval

The default policy contains:

```ts
{
  allowedRepoRoots: [],
  commandAllowlist: [],
  maxFileSize: 1 MiB,
  maxPatchSize: 100 KiB,
  maxFilesChanged: 50,
  safeMode: {
    readOnly: false,
    confirmApply: true,
    confirmCommands: true
  }
}
```

Initialization fills `allowedRepoRoots` with the detected repository root.

`evaluatePolicyOperation` is the common decision point for reads, writes/applies, and commands. It
checks canonical paths, existing symlinks or nearest existing parents, allowed roots, read-only mode,
size/count limits, and exact command allowlisting.

Commands must match a complete allowlist entry after trimming. Allowlisting `node --version` does not
allow `node --version && echo unsafe`.

Approval outcomes are typed:

- approve once;
- reject, optionally with feedback;
- approve for the session;
- abort.

Rejected feedback is returned to the interactive model as a tool result. The terminal owns the
prompt; core receives only the callback result.

## 13. Unified diff pipeline

The patch subsystem is shared by both workflows.

### Parsing

`parseUnifiedDiff` recognizes file headers and hunks, normalizes CRLF, rejects missing structure and
binary patches, and builds a typed representation containing old/new paths, hunk ranges, and lines.

### Validation

`validateDiff` enforces:

- maximum patch bytes;
- maximum changed files;
- allowed repository paths;
- valid hunk old/new line counts;
- at least one hunk;
- no binary patch markers.

Read-only policy is handled at application time so a patch may still be parsed and previewed without
being writable.

### Application

`applyDiff` applies hunks in memory, checks context/removal lines exactly, writes or deletes the file,
and records before/after hashes plus a reverse patch. If a later file in the same patch fails, already
applied files are restored from captured original content.

Legacy rollback first attempts `git apply -R` on the stored patch when possible, then falls back to
the stored reverse diff.

## 14. Interactive transactions and undo

`TransactionStore` journals multiple edits belonging to one interactive request. Transactions use
these statuses:

- `active`;
- `completed`;
- `incomplete`;
- `reverted`.

Each edit records forward/reverse patches, changed files, timestamps, and before/after hashes. The
journal distinguishes prepared edits from applied edits so a crash between disk mutation and journal
update can be audited and recovered conservatively.

At the end of a request, the loop marks the transaction completed only for a successful completion;
other terminal stop reasons produce an incomplete transaction. `agent chat /undo` and `agent undo`
prefer the latest interactive transaction and revalidate current file hashes before reverting so
later user changes are not silently overwritten.

This request-scoped journal is different from the single “last applied patch” state used by the
one-shot commands.

## 15. Sessions, events, status, and replay

`SessionStore` writes append-only JSONL records and a metadata file. Event sequence numbers are
monotonic within a session.

Important event families include:

- command lifecycle: `command_started`, `done`, `error`;
- model lifecycle: `model_started`, `model_output`;
- recovery: `action_normalized`, `repair_started`, `repair_succeeded`, `repair_failed`,
  `loop_stopped`;
- tools and safety: `tool_call`, `tool_result`, `policy_decision`, `approval_requested`,
  `approval_resolved`;
- mutations and execution: `patch_proposed`, `patch_applied`, `command_started`,
  `command_output`;
- request lifecycle: `request_started`, `request_completed`, `request_stopped`,
  `context_compacted`.

Raw invalid model output is retained in in-memory parser diagnostics, but durable events intentionally
store bounded normalized/error information instead of private reasoning by default.

`agent status` combines `.agent/state.json`, the latest transaction, and recent session metadata.
`agent replay` reads a stored JSONL log and renders its ordered events.

## 16. Streaming

`agent chat --stream` displays model tokens as they arrive, but execution waits until the complete
response has been buffered and parsed. Partial JSON never executes. Streaming changes presentation,
not the trust boundary.

The current implementation does not expose a separate cancellation token through the provider
interface; request timeout and process interruption are the practical bounds.

## 17. Doctor diagnostics

`agent doctor` checks:

- `git` and `rg` executables;
- repository read/write permissions;
- `.agent` permissions;
- model configuration parsing;
- risky model timeout/context combinations;
- Ollama reachability;
- configured model installation.

`agent doctor --protocol` additionally asks the model for one harmless `complete` action and validates
the response schema. It does not prove that the model can complete a multi-step coding task; it only
tests a minimal protocol round trip.

The standard server/model checks use `/api/tags`, so they can pass even when cold model loading or
generation later exceeds the request timeout.

## 18. Tests and benchmarks

Both packages use Vitest. Tests are intentionally dominated by scripted/fake LLMs so CI is
deterministic and does not require Ollama.

Core tests cover:

- JSON and action parsing/normalization;
- Ollama request shape, schema format, timeout, retry, and streaming;
- policy, symlink escape, and exact command matching;
- patch parse/apply/rollback behavior;
- conversation state and compaction;
- tool argument validation and interactive edits;
- tool-loop success, repair, completion, continuation, and stop conditions;
- session and transaction persistence/recovery.

CLI tests cover command routing, doctor output, error classification, session behavior, and installed
entry-point detection.

`npm run bench` runs deterministic suites:

- B1 exact single-file edit;
- B2 multi-file transaction;
- B3 allowlisted verification command;
- B4 scripted interactive reliability, continuity, repair, verification, and undo;
- B5 path/symlink/command/read-only escape attempts.

`npm run bench:live` is opt-in through `LIVE_OLLAMA_BENCH=1`. It creates a temporary repository and
asks the actual configured model to create and then implement `bubble.py`. This is the relevant test
for model/runtime compatibility; deterministic scripted benchmarks can pass while the live model
still chooses poor actions.

## 19. Build, development, and distribution

Common commands from the repository root:

```bash
npm install
npm run build
npm test
npm run lint
npm run bench
npm run smoke
```

The root development command now invokes the CLI source directly:

```bash
npm run dev -- <command>
```

This avoids the older npm-workspace behavior that changed the working directory to `packages/cli`.

Packaging builds tarballs for both workspaces:

```bash
npm run package:all
npm install -g \
  ./dist-packages/local-agent-core-0.1.0.tgz \
  ./dist-packages/local-agent-cli-0.1.0.tgz
```

The installed CLI is a copy of the packaged build. Editing source does not update the global command
until it is rebuilt, repackaged, and reinstalled.

## 20. How to trace a request while debugging

For `agent chat`:

1. Confirm the target root printed at startup.
2. Read `.agent/model.json` and `.agent/policy.json`.
3. Find the newest `.agent/sessions/*.jsonl`.
4. Follow `request_started` → `model_started` → `model_output`/repair events → tool events.
5. If a mutation was attempted, inspect `.agent/transactions/*.json`.
6. Compare the action with `ToolDispatcher`'s schema.
7. Distinguish model transport failure, action parse failure, invalid arguments, policy denial,
   approval rejection, tool failure, completion rejection, and loop stop.

For `agent ask`:

1. Inspect the latest session and failure category.
2. Check whether the failure occurred in JSON parsing, patch contract, diff parsing, diff validation,
   policy, or application.
3. Inspect `.agent/patches/last-proposed.patch` and `.agent/state.json` when a patch was queued.
4. Run `npm run report:failures -- <sessions-directory>` from the source repository to summarize
   recorded error categories.

## 21. Current limitations and known sharp edges

The following are present-day implementation facts, not merely hypothetical concerns:

1. **Live model reliability trails deterministic tests.** Scripted tests demonstrate that the loop
   can work when given valid or anticipated outputs. They do not guarantee that Qwen will choose the
   right action.
2. **Flattened direct tool arguments are not normalized.** A response like
   `{"type":"create_file","path":"bubble.py","content":"..."}` is rejected because the current
   normalizer requires `path` and `content` under `args`.
3. **Unnecessary input requests are only narrowly filtered.** The runtime suppresses some redundant
   path questions, but can still accept requests asking the user to provide code or implementation
   content that the coding model should generate itself.
4. **Clarification loop detection is not durable enough.** Resuming a request preserves the request
   ID and hard state, but per-run action/error signatures reset. Equivalent questions can therefore
   repeat across continuations.
5. **Candidate output rendering can be confusing.** A model's proposed completion may be displayed
   before runtime completion validation rejects it, making “No changes needed” look final even when
   the loop continues.
6. **The default timeout is aggressive.** Ten seconds is often insufficient for cold loading or
   inference with the default 14B model. Project-level configuration can override it.
7. **Structured output enforces shape, not judgment.** A schema can force valid JSON while the model
   still chooses `complete` or `request_input` instead of a useful tool.
8. **One-shot tolerance work is incomplete.** The interactive loop has bounded action repair, but
   planned one-shot patch sanitation, deterministic diff repair, and model repair controls remain
   unfinished in `tolerance-pipeline-plan.md`.
9. **`chunkFile` is currently a placeholder.** Context gathering relies on its own bounded reads
   rather than a completed generic chunker.
10. **Planning documents may overstate completion.** Validate behavior against current source and a
    live benchmark before treating a checked roadmap item as production-ready.

These limitations explain why a simple coding request can fail even when `doctor`, unit tests, and
deterministic benchmarks pass: infrastructure readiness, runtime safety, protocol syntax, and model
decision quality are separate layers.

## 22. Design invariants to preserve

When extending the project, preserve these constraints:

- keep provider access behind `LLM`;
- keep terminal dependencies out of core;
- route all model-selected operations through one dispatcher;
- validate paths against the repository and policy before access;
- keep commands exactly allowlisted, timeout-bounded, and output-bounded;
- parse and validate complete model output before execution;
- build interactive writes as validated patches rather than raw writes;
- revalidate stale mutation preconditions immediately before application;
- retain reverse metadata for undo;
- keep repair, steps, output, and context bounded;
- log externally visible lifecycle events without persisting hidden reasoning;
- preserve the one-shot CLI and JSON automation while interactive behavior evolves;
- add focused tests for every model-output variant accepted by normalization.

## 23. Recommended reading order for contributors

For a first tour, read files in this order:

1. `packages/cli/src/app.ts` — available commands;
2. `packages/cli/src/lib/agentFs.ts` — repository and `.agent` state;
3. `packages/core/src/model/LLM.ts` and `model/adapters/ollama.ts` — model boundary;
4. `packages/core/src/runtime/AgentRunner.ts` — one-shot path;
5. `packages/core/src/actions/AgentAction.ts` and `parseAgentAction.ts` — chat contract;
6. `packages/core/src/prompts/toolLoop.ts` — what the interactive model sees;
7. `packages/core/src/runtime/ToolLoopRunner.ts` — the main interactive control loop;
8. `packages/core/src/tools/ToolDispatcher.ts` — tool schemas and execution boundary;
9. `packages/core/src/policy/validate.ts` — hard safety decisions;
10. `packages/core/src/tools/patch/*` — edit validation and application;
11. `packages/core/src/runtime/ConversationState.ts` and `TransactionStore.ts` — continuity and undo;
12. `packages/cli/src/lib/interactiveSession.ts` — terminal conversation lifecycle;
13. corresponding unit tests — precise behavior and edge cases;
14. `bench/suites/b4_interactive_reliability.ts` and `bench/live_ollama.ts` — intended interactive
    behavior versus real-model acceptance.

With that sequence, the system becomes easier to reason about as four cooperating layers:

```text
model suggestion
    → deterministic normalization and validation
    → policy/approval-controlled tool execution
    → persistent evidence, recovery, and undo
```

That separation is the codebase's main strength. The current engineering challenge is making the
model-facing layer more tolerant and directive without weakening the strict execution boundary.
