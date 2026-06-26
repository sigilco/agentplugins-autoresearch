# agentplugins-autoresearch: Architecture A (manifest-only) port limitations

This document records the deliberate trade-offs and known gaps of the manifest-only port of `pi-autoresearch` to the agentplugins framework. These items should be reviewed before deciding whether to add a `nativeEntry.pimono` (or `nativeEntry.opencode`) implementation.

## 1. Pi-specific TUI features are not ported

The original `pi-autoresearch` extension was tightly coupled to Pi Mono's TUI APIs:

- **Live confidence widget** (`ctx.ui.setWidget`): there is no cross-harness equivalent in agentplugins. The port exposes the same confidence score via tool results and compaction summaries, but there is no persistent floating widget.
- **Fullscreen overlay dashboard** (`ctx.ui.custom` + keyboard shortcut): the original opened a rich fullscreen overlay from `renderDashboardLines`. The port does not render this overlay.
- **Keyboard shortcuts** (`shortcuts.ts`): the `fullscreenDashboard` shortcut relied on `getAgentDir` from `@earendil-works/pi-coding-agent`. The entire `shortcuts.ts` file was dropped.
- **Pi notifications** (`pi.ui.notify`, `pi.notifications`): used by the original HTTP dashboard server to notify the user of state changes. These are Pi-only and were removed.

**Impact:** On Pi Mono the experience is degraded from a polished TUI workflow to a text/MCP-tool workflow. On Claude/Codex/OpenCode this is the expected experience.

**Recommendation:** If Pi Mono fidelity matters, add `nativeEntry.pimono` that imports `@earendil-works/pi-tui` / `@earendil-works/pi-coding-agent` and re-implements the widget, overlay, and shortcuts on top of the portable runtime.

## 2. Codex now supports inline hook handlers

Codex now supports inline hook handlers (v0.4.0 auto-wrap). All three inline hooks are emitted as Node.js wrapper scripts. The port's auto-resume, session context injection, and compaction summaries work on Codex without a `nativeEntry`.

**Impact:** None — Codex is on parity with Claude, OpenCode, and Pi Mono for these hooks.

**Recommendation:** ~~Convert the hooks to `command` handlers bundled as standalone Node scripts (this requires verifying that the Codex adapter supports command hooks and placeholder substitution for the plugin root).~~ Already addressed by v0.4.0 auto-wrap. If Codex fidelity drifts again, re-evaluate `nativeEntry` for Codex.

## 3. OpenCode ignores `postCompact`

The agentplugins OpenCode adapter does not support the `postCompact` hook. The original Pi Mono extension used both `preCompact` and a post-compaction resume trigger. To keep the build clean across all Tier-1 targets, `postCompact` was removed from the manifest.

**Impact:** The auto-resume signal after compaction now relies entirely on the `stop` hook (`continueWith`). Depending on harness turn boundaries, the loop may pause after a compaction until the next natural stop event or user message.

**Recommendation:** If tighter post-compaction resumption is needed, add `nativeEntry.opencode` that wires a custom handler, or accept the `stop`-hook timing.

## 4. State is read from disk on every hook call

The original extension kept a rich in-memory runtime store per session (`AutoresearchRuntime`, pending resume timers, settled-state detection, active tools). The manifest-only port is stateless: each hook invocation reconstructs state from `.auto/log.jsonl`.

**Impact:**
- No delayed/settled auto-resume: the original waited up to 800 ms for the agent to become idle before calling `pi.sendUserMessage`. The port returns `continueWith` immediately and lets the harness schedule the follow-up.
- No `runningExperiment` gate, no `pendingResumeTimer`, no `hasReachedAutoResumeLimit` bookkeeping beyond counting runs in the current segment.
- Hooks cannot distinguish between a user-driven pause and an agent-driven pause.

**Recommendation:** This is acceptable for architecture A. Re-introduce stateful behavior only via `nativeEntry` for a specific harness.

## 5. Browser dashboard server is not implemented

The original extension spun up an HTTP server (`createServer`) serving `assets/template.html`, `logo.webp`, and SSE updates so a browser could show a live dashboard. The port keeps `assets/template.html` in the repo but does not start the server.

**Impact:** `/autoresearch export` or equivalent has no effect. Users cannot open a browser dashboard.

**Recommendation:** Port the static server as a standalone script and expose it via an MCP tool (`export_dashboard`) or a Pi-only `nativeEntry` handler.

## 6. Pi Mono tool delivery uses dynamic `import()` of a relative path

For Pi Mono, the three experiment tools are emitted via `tools[]` with `handler.source = "../runtime/experiment-logic.js"` and `handler.target = "initExperiment"` etc. The pimono adapter generates:

```ts
const mod = await import("../runtime/experiment-logic.js");
return mod["initExperiment"](args);
```

This path is relative to the generated `dist/pimono/index.ts`. It resolves correctly after `pnpm build`, but it is fragile: moving build outputs or changing the monorepo layout would break it.

**Impact:** Pi Mono tool execution depends on the compiled `dist/runtime/experiment-logic.js` existing next to `dist/pimono/`.

**Recommendation:** A `nativeEntry.pimono` implementation could inline the tool handlers and import the runtime with a robust resolver, removing this fragility.

## 7. `/autoresearch` subcommands are prompt-based only

The original `/autoresearch` command handled `off`, `clear`, and `export` directly in code. The port exposes `/autoresearch` as a prompt-based command only.

**Impact:** Subcommands like `clear` rely on the agent interpreting the prompt and calling tools or deleting files. There are no dedicated tools for `status`, `clear`, or `export` yet.

**Recommendation:** Add MCP/native tools for `autoresearch_status`, `autoresearch_clear`, and `autoresearch_export` if direct subcommand handling is desired.

## 8. TypeBox schema test and shortcuts test were dropped

Two original tests were removed because they test Pi-specific surfaces:

- `tests/log-params-schema.test.mjs` validated TypeBox schemas from `extensions/pi-autoresearch/index.ts`.
- `tests/shortcuts.test.mjs` tested Pi-specific keyboard shortcut registration.
- `tests/finalize_test.sh` was Pi-specific shell scaffolding.

The remaining 21 tests cover the portable runtime, compaction, JSONL parsing, paths, and end-to-end init/run/log logic.

## 9. Secondary metric units are inferred heuristically

The original extension used Pi's `StringEnum` and explicit metric definitions. The port infers secondary metric units from suffixes (`_ms`, `_s`, `_kb`, `_mb`, `µs`) in `experiment-logic.ts`.

**Impact:** Niche units may display without a suffix until a user adds them manually to `.auto/log.jsonl`.

**Recommendation:** Acceptable for architecture A. Add a `userConfig` schema if users need to declare custom units.

## Summary

Architecture A delivers a working, cross-harness autoresearch loop via MCP servers and prompt-based commands, but it sacrifices the polished Pi Mono TUI experience and a few harness-specific lifecycle hooks. The most important next step for parity is a `nativeEntry.pimono` that re-introduces the widget, fullscreen overlay, shortcuts, and dashboard server on top of the portable runtime.
