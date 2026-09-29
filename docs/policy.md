# Policy Configuration

The agent uses a `policy.json` file in `.agent/` directory to enforce safety guardrails.

## Schema

```json
{
  "allowedRepoRoots": [],
  "commandAllowlist": [],
  "maxFileSize": 1048576,
  "maxPatchSize": 102400,
  "maxFilesChanged": 50,
  "safeMode": {
    "readOnly": false,
    "confirmApply": true,
    "confirmCommands": true
  }
}
```

## Fields

- `allowedRepoRoots`: List of allowed repository root paths (default: current repo)
- `commandAllowlist`: List of complete allowed command strings (default: none). Matching is exact after outer whitespace is trimmed; allowing `npm test` does not allow another `npm` command or appended shell syntax.
- `maxFileSize`: Maximum file size to read in bytes (default: 1MB)
- `maxPatchSize`: Maximum patch size in bytes (default: 100KB)
- `maxFilesChanged`: Maximum number of files that can be changed in one patch (default: 50)
- `safeMode.readOnly`: If true, only read files, never apply patches
- `safeMode.confirmApply`: If true, require confirmation before applying patches
- `safeMode.confirmCommands`: If true, require confirmation before running commands

Auto-approval affects only confirmation. It cannot override repository containment, symlink checks, read-only mode, file/patch limits, exact command matching, or malformed tool arguments.

Interactive mutation tools keep distinct semantics: `create_file` fails when a target exists, `edit_file` requires one exact non-empty match, `replace_file` replaces an existing file through a validated whole-file diff and accepts the SHA-256 returned by `read_file` as a stale-content precondition, and `delete_file` only accepts files.
