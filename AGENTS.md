# Agent Guidance

## Product Direction

The repository is evolving from a one-shot patch generator into an interactive, local-first coding agent. The target experience is informed by the sibling `../offline_cursor` project: a user should be able to start one terminal session, submit multiple tasks, watch the agent inspect and modify the project through tools, approve risky operations, provide corrective feedback, and continue until the agent explicitly completes the task.

Do not port Offline Cursor's Python implementation wholesale. Preserve this repository's stronger TypeScript package boundaries, policy engine, unified-diff validation, rollback support, session event logs, structured output, tests, and distributable CLI.

## Required Context

Before changing agent behavior, read:

1. [`docs/offline-cursor/COMPARISON.md`](docs/offline-cursor/COMPARISON.md) for the source-backed differences between the repositories.
2. [`docs/offline-cursor/ALIGNMENT_PLAN.md`](docs/offline-cursor/ALIGNMENT_PLAN.md) for the desired architecture and phased implementation plan.
3. [`docs/offline-cursor/IMPLEMENTATION_GUIDE.md`](docs/offline-cursor/IMPLEMENTATION_GUIDE.md) for file ownership, acceptance criteria, and sequencing constraints.
4. [`docs/offline-cursor/IMPLEMENTATION_ROADMAP.md`](docs/offline-cursor/IMPLEMENTATION_ROADMAP.md) for the canonical milestone order, concrete file changes, dependencies, tests, and release gates.

## Non-Negotiable Invariants

- Keep model access behind the core `LLM` abstraction.
- Keep UI and terminal dependencies out of `packages/core`.
- Route every side-effecting tool through one policy and approval boundary.
- Resolve and validate paths against the repository root before access.
- Keep command execution allowlisted, timeout-bounded, and output-bounded.
- Validate edits before applying them and retain rollback metadata.
- Record loop steps, approvals, tool activity, errors, and completion in session events.
- Preserve non-interactive `--json` behavior for automation.
- Add focused tests alongside each behavioral change.

## Working Rules

- Treat source code as authoritative when documentation disagrees with behavior.
- Preserve existing subcommands while adding an interactive workflow incrementally.
- Prefer small vertical slices that are usable and testable end to end.
- Do not weaken safety merely to reproduce Offline Cursor's behavior.
- Check `git status` before editing and do not overwrite unrelated worktree changes.
