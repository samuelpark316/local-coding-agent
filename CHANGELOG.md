# Changelog

## Unreleased

- Added a persistent `agent chat` workflow with strict one-action model turns.
- Added repository-scoped read, search, git, edit, delete, and allowlisted command tools.
- Added risk-aware approvals, rejection feedback, and session auto-approval.
- Added request transaction journals and transaction-aware undo.
- Added bounded loop detection, parse retries, streaming, and context compaction.
- Added deterministic capability and safety benchmarks.
- Added registered-tool action normalization for direct Qwen-style `create_file`/`edit_file` responses, with in-memory raw/normalized diagnostics.
- Added exact per-tool argument schemas, bounded corrective retries, and one bounded alternative-strategy nudge.
- Added patch-backed `replace_file` with SHA-256 stale-content support and clearer edit fallback hints.
- Added persistent hard conversation state, path-aware context gathering, and deterministic completion/path/verification checks.
- Added prepared/applied transaction journaling with hash-based crash recovery and undo path revalidation.
- Added provider-neutral JSON Schema output with Ollama support/fallback and deterministic chat temperature.
- Added optional `agent doctor --protocol`, interactive reliability metrics, a live Qwen benchmark, and exact full-command allowlist matching.
- Fixed installed `agent` symlink entry-point detection so global and temporary-prefix installs actually launch the CLI.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial repository skeleton
- Core package structure with runtime, policy, tools, and model adapters
- CLI package structure with command scaffolding
- Test fixtures and benchmark suites
- Documentation (architecture, policy, security)
- GitHub Actions CI workflow

## [0.1.0] - 2024-XX-XX

### Added
- Initial release
