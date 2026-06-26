# Configuration

Create `.auto/config.json` in your agentplugins session directory to customize behavior:

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50
}
```

| Field | Type | Description |
|-------|------|-------------|
| `workingDir` | string | Override the directory for all autoresearch operations — file I/O, command execution, and git. Supports absolute or relative paths (resolved against the agentplugins session cwd). The config file itself always stays under the session cwd. Fails if the directory doesn't exist. |
| `maxIterations` | number | Maximum experiments before auto-stopping. The agent is told to stop and won't run more experiments until a new segment is initialized. |

## Session files

All session files live in a single `.auto/` subfolder at the working-directory root — one folder to preserve across reverts, gitignore, and clean up. (Legacy flat `autoresearch.*` files are still read for in-flight sessions.)

| File | Purpose |
|------|---------|
| `.auto/prompt.md` | Session document — objective, metrics, files in scope, what's been tried. A fresh agent can resume from this alone. |
| `.auto/measure.sh` | Benchmark script — pre-checks, runs the workload, outputs `METRIC name=number` lines. |
| `.auto/log.jsonl` | Append-only log of every run (written by the tools). |
| `.auto/checks.sh` | *(optional)* Backpressure checks — tests, types, lint. Runs after each passing benchmark. Failures block `keep`. |
| `.auto/hooks/` | *(optional)* Executable scripts (`before.sh`, `after.sh`) that fire around iterations. Stdout is delivered to the agent as a steer message. |

## Long-running loops and context

The loop is designed to run unattended across context limits. When the agent's auto-compaction summarizes the older portion of the conversation, autoresearch detects the resulting idle and re-prompts the agent to re-read `.auto/prompt.md`, the tail of `.auto/log.jsonl`, `.auto/ideas.md`, and `git log` before continuing. All progress is persisted in those files, so the post-summary turn rehydrates from the source of truth instead of relying on whatever survived compaction. No tuning required — if auto-compaction is enabled (the default), this just works.
