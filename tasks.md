# tasks.md — Local Claude Code / Cursor‑Like Agent (Local‑First) Scope + Benchmarks

> Goal: ship a **CLI-first local coding agent** that can safely propose/apply diffs, run allowlisted commands, and iterate using a local model backend (Ollama first).  
> Each section includes **benchmarks/tests** to verify it works “up to that point.”

---

## Milestone 0 — Repo Bootstrap + Dev Ergonomics
### Tasks
- [x] Create repo skeleton (`packages/` or `src/`), license, contributing, release notes
- [x] Add formatter/linter (Biome/ESLint+Prettier or Ruff/Black)
- [x] Add unit test runner (Vitest/Jest or Pytest)
- [x] Add CI pipeline (GitHub Actions) for lint + tests on macOS/Linux
- [x] Add basic logging utility + log levels

### Benchmarks / Tests
- **CI green:** lint + unit tests pass on macOS + Linux
- **Smoke:** `agent --version` prints version and exits 0
- **Perf baseline:** `agent --help` < 200ms cold start on M2 Max (informational; track over time)

---

## Milestone 1 — CLI UX + Command Routing (No AI Yet)
### Tasks
- [x] CLI command structure
  - [x] `agent init`
  - [x] `agent ask "<task>"`
  - [x] `agent apply`
  - [x] `agent test`
  - [x] `agent undo`
  - [x] `agent status`
- [x] Config discovery (repo root detection, `.agent/` folder creation)
- [x] Structured output format (human-readable + optional `--json`)

### Benchmarks / Tests
- **Unit:** argument parsing for each command (happy path + invalid args)
- **Integration:** in temp repo, `agent init` creates `.agent/` with policy + session dirs
- **Golden output:** snapshot test for `--help` and `status` output
- **Failure behavior:** `agent apply` before any patch returns exit code ≠0 with clear message

---

## Milestone 2 — Policy + Safety Guardrails (No AI Yet)
### Tasks
- [ ] Define `policy.json` schema:
  - [ ] allowed repo roots / path allowlist (default: current repo)
  - [ ] command allowlist (default: none)
  - [ ] max file size to read
  - [ ] max patch size / max files changed
  - [ ] safe mode toggles (read-only, confirm apply, confirm commands)
- [ ] Policy enforcement layer (single gate before tool execution)
- [ ] Confirmation prompts (TTY) + non-interactive behavior (`--yes` / `--no-apply`)

### Benchmarks / Tests
- **Unit:** policy schema validation (valid/invalid)
- **Security:** deny reads outside repo root (e.g., `../secrets`)
- **Security:** deny running commands not allowlisted
- **UX:** safe mode requires confirmation before apply/command
- **Regression:** fuzz test path normalization (symlinks, `..`, unicode) to prevent escapes

---

## Milestone 3 — Filesystem Tools + Patch Pipeline (No AI Yet)
### Tasks
- [ ] Tool implementations:
  - [ ] `list_files(glob)`
  - [ ] `read_file(path, range?)`
  - [ ] `search_code(query)` (ripgrep)
  - [ ] `git_status`, `git_diff`
- [ ] Unified diff validator:
  - [ ] ensure paths within repo + policy
  - [ ] reject binary modifications unless explicitly allowed
  - [ ] cap total hunks/files/bytes
- [ ] Patch application:
  - [ ] apply unified diff
  - [ ] record patch metadata (files changed, timestamps)
  - [ ] support dry-run
- [ ] Rollback:
  - [ ] `agent undo` reverts last applied patch (use git if available; otherwise stored reverse diff)

### Benchmarks / Tests
- **Unit:** diff parser/validator rejects malformed diffs
- **Integration:** apply patch to create file + modify file + delete file; verify fs state
- **Integration:** `undo` restores repo exactly (byte-for-byte)
- **Git integration:** if git repo present, verify `git diff` equals patch preview after apply
- **Perf:** apply a patch touching 50 small files < 2s on M2 Max

---

## Milestone 4 — Session State + Reproducibility (Still No AI)
### Tasks
- [x] Session store (JSONL event log per run)
- [x] Event schema:
  - [x] `plan`, `tool_call`, `tool_result`, `patch_proposed`, `patch_applied`, `command_started`, `command_output`, `done`, `error`
- [x] `agent status` displays last run summary
- [x] `agent replay <session>` renders events (human + json)

### Benchmarks / Tests
- **Unit:** event schema validation
- **Integration:** running any command writes a session log
- **Repro:** `replay` reproduces identical event ordering + key fields
- **Durability:** handle abrupt termination (SIGINT) and mark session as aborted

---

## Milestone 5 — Model Adapter: Ollama (First AI)
### Tasks
- [x] Ollama client:
  - [x] detect server availability
  - [x] list models (optional)
  - [x] chat/completions call
  - [x] streaming support (optional but recommended)
- [x] Minimal “tool calling” protocol via strict JSON output
- [x] Prompt templates (system + run prompt)
- [x] Local model selection config (`model`, `temperature`, `context_limit`)

### Benchmarks / Tests
- **Contract test:** mock Ollama HTTP server; verify request shape + retry/backoff
- **Integration (optional gated):** if `OLLAMA_TESTS=1`, hit local Ollama and ensure response parses
- **Robustness:** invalid model name yields actionable error
- **Latency baseline:** small prompt returns first token < 2s on M2 Max with 14B model (track only)

---

## Milestone 6 — Agent Loop v1 (Plan → Retrieve → Patch → Stop)
### Tasks
- [x] Implement loop (single-iteration first):
  - [x] create plan
  - [x] retrieve minimal context (search + targeted reads)
  - [x] request PATCH from model
  - [x] present diff to user
- [x] Output contract enforcement:
  - [x] PLAN (short)
  - [x] PATCH (unified diff only)
  - [x] COMMANDS (optional)
  - [x] DONE
- [x] “Small diffs” strategy: encourage 1–5 files per step

### Benchmarks / Tests
- **Unit:** parser extracts plan/patch/commands reliably
- **Unit:** reject outputs that include prose in PATCH section
- **Integration:** on a toy repo, ask “add a README line” → model proposes patch; validator passes
- **Determinism:** same prompt+repo yields patch within tolerance (snapshot-based, allow minor differences)

---

## Milestone 7 — Apply + Test Loop (Autopilot-lite)
### Tasks
- [x] Add optional iterative loop:
  - [x] propose patch → apply (if allowed) → run tests (if allowed) → feed output → fix
- [x] Test command discovery:
  - [x] detect common commands (`npm test`, `pnpm test`, `pytest`, `go test ./...`)
  - [x] allow user to set explicit command in policy
- [x] Command sandboxing:
  - [x] working directory pinned to repo root
  - [x] timeout + output truncation
  - [x] no network flag (best-effort) (optional)

### Benchmarks / Tests
- **Integration:** failing unit test repo fixture:
  - ask “fix tests” → agent applies patch → `agent test` passes
- **Safety:** command not allowlisted never runs
- **Stability:** if tests fail twice, agent stops with summary and leaves diff visible
- **Timeout:** long-running command is killed and recorded as timeout

---

## Milestone 8 — Quality + Trust UX
### Tasks
- [x] Diff viewer in terminal (colored + paging) or plain mode
- [x] “Explain this patch” (optional) using local model
- [x] `--dry-run` and `--no-apply` flags
- [x] Clear rollback messaging
- [x] Telemetry OFF by default (if any; ideally none)

### Benchmarks / Tests
- **Golden tests:** diff output is stable across runs (no ANSI in `--plain`)
- **UX:** apply confirmation prompt text includes file count + risk summary
- **Safety regression:** cannot apply patch if validator fails, even with `--yes`

---

## Milestone 9 — Packaging + Distribution
### Tasks
- [x] Single binary build (pkg / bun / pyinstaller) OR `npm i -g` package
- [x] Auto-update strategy (optional)
- [x] `agent doctor` command:
  - [x] checks git, ripgrep, ollama server, model exists, permissions

### Benchmarks / Tests
- **Install test:** fresh machine install script succeeds
- **Doctor:** returns non-zero if Ollama missing; returns zero when configured
- **Compatibility:** macOS Apple Silicon is required target; Linux optional

---

## Bench Suite (Ongoing) — “Does it feel like Claude Code?”
Create a `bench/` folder with repeatable fixtures.

### Benchmarks
- **B1: Simple edit** — add function docstring in 1 file (pass if patch applies cleanly)
- **B2: Multi-file refactor** — rename function across 3 files (pass if compiles/tests)
- **B3: Fix failing test** — repo fixture with 1 failing test (pass if green)
- **B4: Interactive reliability** — blank creation, existing-file edit, follow-up continuity, malformed-argument repair, failed-check repair, verification, and undo
- **B5: Safety escape** — outside/symlink reads and writes, appended command syntax, and auto-approval bypass attempts (must be blocked)

### Scoring (track over time)
- Success rate (% passes)
- Avg iterations to success
- Valid-action, normalization, repair, verification, loop-stop, safety, and undo rates
- Tokens/time per run (optional)
- Max memory pressure incidents (manual for now)

---

## Definition of Done (MVP)
- [x] `agent init` creates policy + session directory
- [x] `agent ask` produces a **valid unified diff** for a small change
- [x] `agent apply` applies the diff safely and logs the session
- [x] `agent test` runs allowlisted tests and logs output
- [x] `agent undo` rolls back last patch or interactive transaction
- [x] Deterministic unit/integration tests pass locally

## Interactive Robustness (implemented)

- [x] Normalize direct registered-tool envelopes without guessing arguments.
- [x] Validate exact per-tool schemas before dispatch and bound repair attempts.
- [x] Provide a patch-backed whole-file `replace_file` fallback.
- [x] Retain bounded tasks, clarifications, reads, errors, changes, approvals, and verification across chat requests.
- [x] Prefer explicit paths and extracted identifiers during initial context gathering.
- [x] Reject obvious target-path, empty-file, no-edit, and unverified-completion mismatches.
- [x] Add harmless protocol doctor diagnostics and deterministic/live benchmark entry points.
- [ ] Run and record the optional live `qwen2.5-coder:14b` acceptance benchmark on a host with Ollama and the model installed.

---

## Notes / Constraints
- Default to **Safe Assist** mode.
- The model never writes files directly; one-shot mode proposes patches and interactive mutation tools construct patches internally.
- Keep context small; rely on retrieval (especially for 8GB machines).
- Ollama is the default provider; keep adapters pluggable.
