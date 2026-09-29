# tolerance-pipeline-plan.md — Robust Output Recovery + Strict Safety Pipeline

> Goal: improve `agent ask` reliability with small/slow local models by adding **bounded output recovery and repair**, while preserving the current strict safety model (policy gates + diff validation + apply confirmation).

---

## Principles

- Keep final safety checks strict.
- Recover from common model formatting errors before final rejection.
- Bound retries and repairs (no unbounded loops).
- Log every recovery attempt in session events for reproducibility.
- Prefer deterministic repairs over speculative model behavior.

---

## Milestone T0 — Baseline + Failure Taxonomy
### Tasks
- [x] Define explicit failure categories for ask pipeline:
  - [x] `json_parse_failed`
  - [x] `schema_failed`
  - [x] `patch_contract_failed` (header/fence/prose)
  - [x] `diff_parse_failed` (line prefix, malformed file sections)
  - [x] `diff_validation_failed` (hunk counts, policy limits)
  - [x] `llm_timeout_or_http_error`
- [x] Add structured error metadata to command/session output.
- [x] Add a simple local report script for failure frequencies from `.agent/sessions/*.jsonl`.

### Benchmarks / Tests
- **Unit:** category mapper maps known error strings to expected category.
- **Integration:** `ask` failure writes category + original message in session log.
- **Observability:** report script prints category counts from sample logs.

---

## Milestone T1 — Configurable Inference Reliability
### Tasks
- [x] Extend model config schema with:
  - [x] `timeoutMs`
  - [x] `maxRetries`
- [x] Propagate config through CLI model loader → Ollama adapter constructor.
- [x] Keep safe defaults and backward compatibility for existing `model.json`.
- [x] Update `agent doctor` to warn on risky config combinations:
  - [x] large model + too-short timeout
  - [x] excessively high context on low-memory systems (best-effort warning)

### Benchmarks / Tests
- **Unit:** model config normalization accepts/validates new fields.
- **Unit:** adapter uses configured timeout/retry values.
- **Doctor:** warning appears for obviously fragile config.
- **Regression:** existing `model.json` without new keys still works.

---

## Milestone T2 — JSON Envelope Normalization (Pre-Parse)
### Tasks
- [x] Add pre-parser normalizer for raw model output:
  - [x] trim BOM / whitespace wrappers
  - [x] remove outer markdown fences robustly
  - [x] extract first balanced JSON object when prose wraps output
- [x] Preserve original raw response for diagnostics.
- [x] Parse normalized output with existing strict schema validator.

### Benchmarks / Tests
- **Unit:** accepts wrapped JSON with leading/trailing prose.
- **Unit:** accepts fenced JSON variants.
- **Unit:** rejects when no valid JSON object is recoverable.
- **Regression:** strict unknown-key and type checks remain enforced.

---

## Milestone T3 — Patch Sanitization (Pre-Contract)
### Tasks
- [ ] Add patch text sanitizer before `validatePatchOutputContract`:
  - [ ] remove leading prose lines before first diff header (`---` / `diff --git`) when unambiguous
  - [ ] strip accidental markdown fences inside patch field
  - [ ] normalize line endings and trailing newline
- [ ] Add sanitizer metadata (`sanitized: true/false`, actions list) for session logging.
- [ ] Keep hard failure if no diff header can be recovered safely.

### Benchmarks / Tests
- **Unit:** leading prose + valid diff becomes valid patch.
- **Unit:** fenced patch body becomes valid raw diff text.
- **Unit:** ambiguous/non-diff content still fails.
- **Safety regression:** patch content never bypasses parser/validator.

---

## Milestone T4 — Deterministic Diff Repair Heuristics
### Tasks
- [ ] Implement deterministic repair pass for frequent structural errors:
  - [ ] recompute hunk `oldLines/newLines` from actual hunk content
  - [ ] normalize benign section separators
- [ ] Explicitly disallow risky repairs:
  - [ ] path rewriting outside declared file blocks
  - [ ] binary patch coercion
  - [ ] missing file headers
- [ ] Re-parse and re-validate repaired diff via existing pipeline.

### Benchmarks / Tests
- **Unit:** hunk count mismatch repairs pass when otherwise valid.
- **Unit:** invalid line prefixes still fail.
- **Unit:** path/policy violations still fail after repair.
- **Integration:** repaired patch queues and applies successfully on fixture.

---

## Milestone T5 — Bounded Repair Retry Loop
### Tasks
- [ ] In `AgentRunner`, add one bounded repair retry on parse/contract failure:
  - [ ] prompt model with original output + exact validator error
  - [ ] require strict JSON schema again
  - [ ] max 1 repair attempt
- [ ] Stop with actionable summary if retry fails.
- [ ] Emit clear event trail for replay:
  - [ ] `repair_attempt_started`
  - [ ] `repair_attempt_succeeded` / `repair_attempt_failed`

### Benchmarks / Tests
- **Unit:** first output malformed, repair output valid → success.
- **Unit:** both malformed → single retry then fail.
- **Stability:** no infinite loops or repeated retries.
- **Replay:** events show repair attempt lifecycle in order.

---

## Milestone T6 — CLI UX + Controls
### Tasks
- [ ] Improve `ask` failure messages with category + next action hints.
- [ ] Add optional user control flags:
  - [ ] `--repair` (force enable repair loop)
  - [ ] `--no-repair` (strict fail-fast mode)
- [ ] Expose recovery metadata in `--json` output.
- [ ] Ensure `status`/`replay` surfaces latest recovery outcome.

### Benchmarks / Tests
- **CLI unit:** error messages include category and actionable hint.
- **CLI unit:** flags correctly toggle repair behavior.
- **JSON contract:** output includes repair metadata when enabled.

---

## Milestone T7 — Bench Harness + Rollout Gate
### Tasks
- [ ] Implement currently stubbed bench runner and suites.
- [ ] Add tolerance-focused benchmark cases:
  - [ ] wrapped JSON output
  - [ ] leading prose in patch
  - [ ] off-by-one hunk count
  - [ ] timeout on first try + success on retry
- [ ] Define rollout gates for default enablement:
  - [ ] patch queue success rate threshold
  - [ ] no safety-regression threshold

### Benchmarks / Tests
- **Bench:** success-rate lift on small model fixtures (7b profile).
- **Safety:** B5 escape benchmark remains blocked.
- **Regression:** invalid patch still cannot be applied with `--yes`.

---

## Definition of Done (Tolerance Pipeline v1)

- [ ] `ask` recovers from common formatting issues without weakening apply safety.
- [ ] Recovery path is bounded, deterministic, and fully logged.
- [ ] Existing policy and patch validation guarantees remain intact.
- [ ] CLI provides clear, actionable failure categories.
- [ ] Benchmarks show measurable reliability gain on local small-model profiles.

## Interactive action protocol status

The chat runtime now has its own completed bounded recovery layer. It normalizes only registered direct-tool forms, validates exact tool argument schemas before dispatch, requests Ollama JSON Schema output through `LLMOptions`, retries malformed actions a configurable finite number of times, records typed normalization/repair/stop events without persisting raw model output, and issues one alternative-strategy nudge for repeated failures. This does not mark the remaining one-shot `AgentRunner` patch sanitation/diff-repair work in T3–T6 complete.

---

## Out of Scope (for this plan)

- Model/provider swap away from Ollama.
- Semantic patch correction beyond structural repair.
- Multi-step autonomous planning beyond current autopilot scope.
- Any bypass of policy/path/apply gates.
