# Hooks

Drop executable scripts in `.auto/hooks/` to run code at iteration boundaries. Hooks are **transparent to the agent** — the agent calls tools and sees results; hooks run alongside without any agent-facing surface.

- `.auto/hooks/before.sh` — fires before every iteration (at `/autoresearch` activation and at the end of every `log_experiment`, after `after.sh`). Use for prospective work: fetch research, prime context for the next attempt.
- `.auto/hooks/after.sh` — fires at the end of every `log_experiment`. Use for retrospective work: annotate learnings, send notifications.

## Contract

- Must be executable (`chmod +x`). Preserved on revert — the entire `.auto/` folder survives (as do legacy `autoresearch.*` artefacts).
- **Stdin** — a JSON object on a single line. Shape depends on the stage (see below). Extract fields with `jq`.
- **Stdout** is delivered to the agent as a steer message (capped at 8 KB). Empty stdout = silent.
- Non-zero exit or >30s timeout surfaces an error steer to the agent.
- Each fire appends a `{"type":"hook",…}` entry to `.auto/log.jsonl` for observability.

## `before.sh` stdin

On fresh activation `last_run` is `null`:

```json
{
  "event": "before",
  "cwd": "/path/to/workdir",
  "next_run": 6,
  "last_run": {
    "run": 5, "status": "discard", "metric": 42.1,
    "description": "…",
    "asi": { "hypothesis": "…", "next_focus": "…" }
  },
  "session": {
    "metric_name": "total_ms", "metric_unit": "ms", "direction": "lower",
    "baseline_metric": 40.7, "best_metric": 33.5,
    "run_count": 5, "goal": "optimize sort speed"
  }
}
```

## `after.sh` stdin

```json
{
  "event": "after",
  "cwd": "/path/to/workdir",
  "run_entry": {
    "run": 6, "status": "discard", "metric": 38.9,
    "description": "…",
    "asi": { "hypothesis": "…", "learned": "…" }
  },
  "session": { "metric_name": "total_ms", "direction": "lower", "baseline_metric": 40.7, "best_metric": 33.5, "run_count": 6, "goal": "…" }
}
```

## Agent signal

The agent writes `description` and `asi.*` fields in its `log_experiment` calls for its own future-self reasoning. The hook opportunistically mines whichever fields the agent naturally uses — `asi.hypothesis`, `asi.next_focus`, `description`, etc. There is no dedicated "hook input" field; the agent is unaware the hook exists.

## Examples

Reference scripts for both stages live at [`skills/autoresearch-hooks/examples/`](../skills/autoresearch-hooks/examples/) — external search, qmd document search, persistent learnings, native notifications, git tagging, anti-thrash, idea rotator, hypothesis reflection, context rotation. Copy one to your session's `.auto/hooks/` directory, adapt, `chmod +x`.
