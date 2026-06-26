# Comparison: agentplugins-autoresearch vs original pi-autoresearch

This note compares the ported `agentplugins-autoresearch` plugin against the original `pi-autoresearch` Pi Mono extension across token usage, accuracy, and performance for the autoresearch goal.

## 1. Token usage

### Hypothesis
The ported plugin uses marginally more tokens per tool call because the universal MCP delivery layer serializes requests/responses as JSON-RPC over stdio, whereas the original Pi extension called tool handlers in-process.

### Components that affect token usage

| Component | Original pi-autoresearch | agentplugins-autoresearch | Expected delta |
|-----------|--------------------------|---------------------------|----------------|
| Tool call serialization | In-process function call | JSON-RPC over stdio | Small overhead (~10-30% per call envelope) |
| Tool result formatting | TypeBox render functions embedded in Pi TUI | Plain text returned via MCP | Similar; no image/widget rendering |
| Hook context injection | In-memory state summaries | Disk reconstruction + inline summary generation | Similar summary size; extra disk I/O but no token cost |
| TUI dashboard | Visual widget/overlay rendered by Pi TUI | Not implemented (browser dashboard not ported) | Saved TUI tokens, but agent may ask for status updates more often |
| Auto-resume | `pi.sendUserMessage` with settled-window heuristic | `continueWith` hook primitive | Similar: one extra user message per iteration |

### Verdict
For the core autoresearch loop, token usage should be comparable. The MCP envelope adds a small per-call overhead, but the absence of the Pi TUI widget means the agent is not receiving base64/widget payloads. Empirical measurement would require running the same benchmark suite on both harnesses and counting LLM input/output tokens; that was not done in this port pass.

## 2. Accuracy for the autoresearch goal

The autoresearch goal is to find a near-optimal implementation by iteratively proposing changes, measuring a metric, and deciding keep/discard.

### Algorithm parity
- The core decision logic is identical: `computeConfidence`, `findBaselineMetric`, `findBestMetric`, `isBetter`, and the `METRIC` line parser were ported directly from `extensions/pi-autoresearch/index.ts`.
- The JSONL log format is unchanged, so experimental data is recorded the same way.
- Therefore, given the same sequence of proposed changes and measurements, both versions should reach the same conclusion about which run is best.

### Operational differences that may affect accuracy

| Factor | Original pi-autoresearch | agentplugins-autoresearch | Impact |
|--------|--------------------------|---------------------------|--------|
| Auto-resume reliability | Pi Mono `agent.AgentEnd` + settled timer ensures robust loop continuation | Relies on `stop` hook `continueWith`; behavior depends on harness event ordering | Slightly more fragile on non-Pi harnesses; agent might not always continue |
| Codex support | Full Pi Mono lifecycle | Inline hooks are skipped on Codex | Accuracy on Codex depends entirely on the agent following the `/autoresearch` prompt and skills manually |
| Compaction context | In-memory snapshot injected before compact | Inline `preCompact` hook reconstructs from disk | Same context quality, but Codex/OpenCode may miss some hook events |
| Max-experiments gate | Enforced by extension runtime | Enforced by `runExperiment`/`logExperiment` and `stop` hook | Equivalent |

### Verdict
Algorithmic accuracy is preserved. End-to-end accuracy is highest on Pi Mono and OpenCode (where hooks and tools work). It is lower on Claude (hooks are wrapped as command scripts, which is less integrated) and lowest on Codex (hooks are skipped entirely). A Codex user would need to drive the loop manually via prompts and skills.

## 3. Performance

### Hypothesis
The port is slightly slower per tool call due to MCP stdio serialization and disk-based state reconstruction, but the difference is negligible for typical experiment commands that take seconds to minutes.

### Components that affect performance

| Component | Original | Port | Expected delta |
|-----------|----------|------|----------------|
| Tool handler invocation | In-process function call | MCP stdio round-trip or dynamic `import()` | <10 ms for init/log, still dominated by the benchmark command itself |
| State access | In-memory object | Reconstruct from `.auto/log.jsonl` on each call | <1 ms for small logs; grows linearly with log size but still tiny for typical experiments |
| Process spawning | `pi.exec` (in-process wrapper) | `child_process.spawn` directly | Equivalent or slightly faster because there is no Pi wrapper |
| Hook execution | In-process shell spawn | Command script or inline handler + shell spawn | Equivalent |
| Plugin load time | Interpreted by Pi's jiti | Pre-compiled `dist/` outputs | Faster cold start after first build |

### Verdict
Per-call overhead is slightly higher in the port, but for the autoresearch workload (where each `run_experiment` typically executes a benchmark for seconds or longer) the overhead is negligible. Plugin load time is faster because the TypeScript is pre-compiled.

## 4. Summary table

| Dimension | Original pi-autoresearch | agentplugins-autoresearch | Winner | Notes |
|-----------|--------------------------|---------------------------|--------|-------|
| Token usage | In-process, TUI widgets | MCP stdio, text-only | Roughly tied | MCP overhead offset by no TUI payloads |
| Algorithmic accuracy | Baseline | Identical | Tied | Same math and log format |
| End-to-end accuracy on Pi Mono | Excellent | Good to excellent | Original | More mature auto-resume and TUI |
| End-to-end accuracy on Claude/Codex | N/A (Pi-only) | Fair / poor on Codex | Original (if Pi Mono) | Codex lacks hooks entirely |
| Per-call performance | Faster | Slightly slower | Original | Difference is negligible for long benchmarks |
| Cold-start load time | Slower (jit) | Faster (pre-compiled) | Port | Build step required once |
| Cross-harness portability | None | Tier-1 | Port | Main reason for the port |

## 5. Recommendations for empirical validation

To replace the hypotheses above with measurements, run the same autoresearch benchmark (e.g. the example in `skills/autoresearch-create/SKILL.md`) on:
1. Pi Mono with the original extension.
2. Pi Mono with the agentplugins port.
3. Claude Desktop with the agentplugins port via MCP.

Measure:
- Total LLM input/output tokens to reach a "winner".
- Best metric achieved after N iterations (accuracy).
- Wall-clock time excluding the benchmark commands themselves (overhead).

Record results in this note or in a follow-up ADR.
