# local-coding-agent

A **CLI-first local coding agent** that can safely propose/apply diffs, run allowlisted commands, and iterate using a local model backend (Ollama first).

It now includes an interactive `agent chat` workflow with model-selected repository tools, bounded multi-step execution, approval feedback, patch-backed edits, verification commands, transaction logs, and request-level undo.

## Goal

Ship a commoditized, local-first coding agent (Claude Code / Cursor-style) that can safely read + modify files, run commands, and iterate — without a subscription.

## Project Structure

```
local-coding-agent/
  packages/
    core/          # The engine (no UI)
      src/
        runtime/   # AgentRunner, EventBus, SessionStore
        policy/    # Policy schema + validation
        tools/     # Filesystem, patch, git, shell, search tools
        context/   # Context gathering + chunking
        prompts/   # System prompts + output formats
        model/     # LLM interface + adapters (Ollama)
        util/      # Logger, errors, paths
    cli/           # CLI wrapper
      src/
        commands/  # init, ask, apply, test, undo, status, doctor
        ui/        # Diff viewer + prompts
  fixtures/        # Test repositories for integration tests
  bench/           # Benchmark suites ("Claude Code feel" checks)
  docs/            # Architecture, policy, security docs
  scripts/         # Release + smoke test scripts
```

## Architecture

- **Core Engine** (`packages/core`): The product — no UI dependencies. Contains runtime, policy enforcement, tools, and model adapters.
- **CLI** (`packages/cli`): Thin wrapper around the core engine.
- **Model Adapters**: Pluggable providers (Ollama first, llama.cpp/vLLM later).
- **Tools**: Small, auditable, policy-gated capabilities.
- **Interactive runtime**: One validated action per model turn, adaptive repository inspection, reversible edits, and bounded verification loops.

See [docs/architecture.md](docs/architecture.md) for more details.

## Safety Model

The default policy permits repository-contained patch application but requires confirmation. Interactive file tools never write directly: `create_file`, exact `edit_file`, `replace_file`, and `delete_file` construct unified diffs, pass policy and patch validation, show a preview, and commit through a reversible transaction. Commands must match a complete `commandAllowlist` entry exactly.

## Development

### Prerequisites

- Node.js >= 18.0.0
- npm (or compatible package manager)

### Setup

```bash
npm install
npm run build
```

### Commands

- `npm run build` - Build all packages
- `npm test` - Run tests
- `npm run lint` - Lint code
- `npm run smoke` - Run smoke tests
- `npm run bench` - Run deterministic capability and safety benchmarks
- `npm run dev` - Run CLI in development mode

### Interactive usage

Initialize a target repository and start a persistent session:

```bash
agent init
agent chat
```

Inside chat, enter coding requests normally. Use `/status`, `/changes`, `/undo`, `/clear`, `/help`, or `/exit` for session operations. Edits and commands require confirmation unless `--auto-approve` is selected; auto-approval never bypasses repository policy, patch validation, or command allowlisting.

### Distribution

Build installable package tarballs:

```bash
npm run package:all
```

Install tarballs globally (after packaging):

```bash
npm install -g ./dist-packages/local-agent-core-0.1.0.tgz ./dist-packages/local-agent-cli-0.1.0.tgz
```

Run diagnostics after install:

```bash
agent doctor
agent doctor --protocol # optional harmless model protocol probe
```

### Running development code against another repository

`npm run dev -- ...` uses the directory where the development command is started as the target. To avoid accidentally targeting `packages/cli`, build once and invoke the CLI entry point while your shell is in the separate repository:

```bash
cd /path/to/local-coding-agent
npm run build
cd /path/to/target-repository
node /path/to/local-coding-agent/packages/cli/dist/main.js init
node /path/to/local-coding-agent/packages/cli/dist/main.js chat
```

Chat uses deterministic temperature `0`, requests Ollama JSON Schema output when supported, and falls back to the same strict prompt/validator contract for older servers. Direct known-tool action shapes are normalized for local-model compatibility; unknown tools and malformed arguments never execute.

## Milestones

See [tasks.md](tasks.md) and the [interactive roadmap](docs/offline-cursor/IMPLEMENTATION_ROADMAP.md) for the source-backed milestone status. Deterministic rollout gates are implemented; the optional live Qwen/Ollama acceptance run remains environment-dependent.

## License

MIT License - see [LICENSE](LICENSE) file.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
