# agentplugins-autoresearch

> **Let the agent run experiments, keep what works, and discard what doesn't.**

A fork of [pi-autoresearch](https://github.com/badlogic/pi-autoresearch) and inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch), ported to the [agentplugins](https://github.com/sigilco/agentplugins) CLI.

The vision is simple: give an agent a benchmark, then let it try ideas, measure results, commit winners, revert losers, and keep going until you tell it to stop.

---

## Quick start

```bash
# install via agentplugins
pnpm dlx agentplugins install agentplugins-autoresearch

# start a loop
/skill:autoresearch-create
```

The agent will ask for:

1. **Goal** — what you want to optimize
2. **Metric** — the number that decides keep vs discard
3. **Command** — the benchmark that produces that number
4. **Scope** — files the agent is allowed to change

Then it writes `.auto/prompt.md` and `.auto/measure.sh`, runs a baseline, and starts iterating.

---

## How to use it

### `/skill:autoresearch-create` — start a loop

Opens the autoresearch skill. Answer a few questions and the agent begins experimenting.

### `/autoresearch <goal>` — enter autoresearch mode

Puts the agent into a tight loop: propose change → run benchmark → log result → keep or revert → repeat.

```
/autoresearch optimize test runtime while keeping correctness
/autoresearch reduce bundle size after pnpm build
/autoresearch improve Lighthouse performance score
```

### `/autoresearch export` — open the dashboard

Launches a browser dashboard with a live chart and results table.

### `/skill:autoresearch-finalize` — turn wins into reviewable branches

Groups kept experiments into clean, independent branches from the merge-base. Each branch can be reviewed and merged on its own.

---

## What you get

| | |
|---|---|
| **Extension** | `init_experiment`, `run_experiment`, `log_experiment` tools + live widget + `/autoresearch` dashboard |
| **Skills** | `autoresearch-create`, `autoresearch-finalize`, and optional `autoresearch-hooks` |
| **Session files** | One `.auto/` folder per project: `prompt.md`, `measure.sh`, `log.jsonl`, optional `checks.sh` and `hooks/` |

---

## Why this works

- **Benchmark-driven.** The metric is the judge. No hand-waving.
- **Persistent.** `.auto/log.jsonl` survives restarts and context resets.
- **Safe.** Every experiment is committed; regressions are reverted.
- **Composable.** One extension handles any domain — tests, builds, ML, Lighthouse, anything that prints a number.

---

## Learn more

- [Installation and setup](docs/install.md)
- [Usage guide](docs/usage.md)
- [Configuration](docs/configuration.md)
- [Confidence scoring](docs/confidence.md)
- [Backpressure checks](docs/checks.md)
- [Hooks](docs/hooks.md)
- [CHANGELOG](CHANGELOG.md)

## License

MIT
