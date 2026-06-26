# Usage

## 1. Start autoresearch

```
/skill:autoresearch-create
```

The agent asks about your goal, command, metric, and files in scope — or infers them from context. It then creates a branch, writes `.auto/prompt.md` and `.auto/measure.sh`, runs the baseline, and starts looping immediately.

## 2. The loop

The agent runs autonomously: edit → commit → `run_experiment` → `log_experiment` → keep or revert → repeat. It never stops unless interrupted.

Every result is appended to `.auto/log.jsonl` in your project — one line per run. This means:

- **Survives restarts** — the agent can resume a session by reading the file
- **Survives context resets** — `.auto/prompt.md` captures what's been tried so a fresh agent has full context
- **Human readable** — open it anytime to see the full history
- **Branch-aware** — each branch has its own session

## 3. Finalize into reviewable branches

```
/skill:autoresearch-finalize
```

The agent reads `.auto/log.jsonl`, groups kept experiments into logical changesets, proposes the grouping for your approval, then creates independent branches from the merge-base. Each commit includes metric improvements in the message. Groups must not share files, so branches can be reviewed and merged independently.

## 4. Monitor progress

- **Widget** — full results table, always visible above the editor
- **`Ctrl+Shift+F`** — fullscreen scrollable dashboard overlay (config key: `shortcuts.fullscreenDashboard`)
- **`/autoresearch export`** — open a live browser dashboard with chart and share card
- **`Escape`** — interrupt anytime and ask for a summary

## `/autoresearch` commands

| Subcommand | Description |
|------------|-------------|
| `/autoresearch <text>` | Enter autoresearch mode. If `.auto/prompt.md` exists, resumes the loop with `<text>` as context. Otherwise, sets up a new session. |
| `/autoresearch off` | Leave autoresearch mode. Stops auto-resume and clears runtime state but keeps `.auto/log.jsonl` intact. |
| `/autoresearch clear` | Delete `.auto/log.jsonl`, reset all state, and turn autoresearch mode off. Use this for a clean start. |
| `/autoresearch export` | Open a live dashboard in your browser. Auto-updates as experiments run. |

**Examples:**

```
/autoresearch optimize unit test runtime, monitor correctness
/autoresearch model training, run 5 minutes of train.py and note the loss ratio as optimization target
/autoresearch export
/autoresearch off
/autoresearch clear
```

## Example domains

| Domain | Metric | Command |
|--------|--------|---------|
| Test speed | seconds ↓ | `pnpm test` |
| Bundle size | KB ↓ | `pnpm build && du -sb dist` |
| LLM training | val_bpb ↓ | `uv run train.py` |
| Build speed | seconds ↓ | `pnpm build` |
| Lighthouse | perf score ↑ | `lighthouse http://localhost:3000 --output=json` |

## UI

- **Dashboard widget** — always visible above the editor: a full results table with columns for commit, metric, status, and description.
- **Confidence score** — after 3+ runs, shows how the best improvement compares to the session noise floor. ≥2.0× (green) = likely real, 1.0–2.0× (yellow) = above noise but marginal, <1.0× (red) = within noise.
- **Fullscreen overlay** — `Ctrl+Shift+F` opens a scrollable full-terminal dashboard. Shows a live spinner with elapsed time for running experiments.

## Controlling costs

Autoresearch loops run autonomously and can burn through tokens. Two ways to cap spend:

- **API key limits** — most providers let you set per-key or monthly budgets. Check your provider's dashboard.
- **`maxIterations`** — cap experiments per session in `.auto/config.json`:
   ```json
   {
     "maxIterations": 30
   }
   ```
