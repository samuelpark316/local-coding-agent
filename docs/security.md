# Security

## Path Validation

All file paths are normalized and validated to ensure they are within the allowed repository root. This prevents:
- Reading files outside the repo (`../secrets`)
- Symlink escapes
- Unicode normalization attacks

## Command Sandboxing

Commands are:
- Allowlisted (only run if in `commandAllowlist`)
- Executed in repo root directory
- Timeout-protected
- Output-truncated

## Patch Validation

Patches are validated before application:
- All paths must be within repo root
- Binary modifications are rejected unless explicitly allowed
- Total size and file count are capped

## Default Safety

The default policy permits patch application but requires confirmation:
- Reads are restricted to configured repository roots
- Patch application requires confirmation
- Commands require confirmation and exact allowlisting
- Interactive auto-approval skips prompts only; it never bypasses hard policy denials
- Every interactive edit is validated as a unified diff and journaled for undo

## Interactive Runtime

- Model output is fully buffered and validated before a tool can execute, including streaming mode.
- Exactly one action is accepted per model turn.
- Steps, parse retries, output sizes, command duration, and conversation size are bounded.
- Repeated actions and repeated errors stop the request.
- Before stopping a repeated failing strategy, the runtime gives the model one bounded alternative-strategy nudge.
- File mutations are revalidated immediately before application to detect stale content.
- Transaction journals durably prepare reverse patches and before/after hashes before mutation, preserve them for completed and interrupted requests, and re-check journal paths during undo.
- Direct registered-tool envelopes may be normalized, but tool names must be registered and all exact argument schemas must validate before dispatch.
- Ollama JSON Schema output is requested through the provider-neutral LLM abstraction and safely falls back to strict prompt validation when unavailable.
- Completion is checked against deterministic changed-file, explicit-path, empty-file, and successful-command facts; model-authored claims do not override those facts.
- Raw model responses and private reasoning are not written to session events by default.
