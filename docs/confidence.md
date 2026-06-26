# Confidence scoring

After 3+ experiments in a session, agentplugins-autoresearch computes a **confidence score** — how the best improvement compares to the session's noise floor. This helps distinguish real gains from benchmark jitter, especially on noisy signals like ML training, Lighthouse scores, or flaky benchmarks.

## How it works

- Uses [Median Absolute Deviation (MAD)](https://en.wikipedia.org/wiki/Median_absolute_deviation) of all metric values in the current segment as a robust noise estimator.
- Confidence = `|best_improvement| / MAD`. A score of 2.0× means the best improvement is twice the noise floor.
- Shown in the widget, fullscreen dashboard, and `log_experiment` output.
- Persisted to `.auto/log.jsonl` on each result for post-hoc analysis.
- **Advisory only** — never auto-discards. The agent is guided to re-run experiments when confidence is low, but the final keep/discard decision stays with the agent.

| Confidence | Color | Meaning |
|-----------|-------|---------|
| ≥ 2.0× | 🟢 green | Improvement is likely real |
| 1.0–2.0× | 🟡 yellow | Above noise but marginal |
| < 1.0× | 🔴 red | Within noise — consider re-running to confirm |
