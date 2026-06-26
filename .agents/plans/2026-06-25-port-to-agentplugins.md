# Plan: Port pi-autoresearch to AgentPlugins (manifest-only)

**Date:** 2026-06-25
**Architecture:** A (manifest-only)
**AgentPlugins version:** v0.4.0 (branch `feat/v0.4.0-authoring-primitives`)

## Scope
In-place rewrite of this workspace from the Pi Mono extension `pi-autoresearch@1.6.0` into an AgentPlugins plugin `agentplugins-autoresearch@0.1.0`. All functionality expressed via universal manifest primitives; **no** `nativeEntry` escape hatches, **no** `adapterOverrides`. Pi-specific surface degrades to universal primitives (documented in the post-implementation shortcomings report).

## Goals
- Tier-1 functional parity on Claude Code, Codex, OpenCode, and Pi Mono for autonomous experiment loops.
- Preserve portable runtime: JSONL logging, deterministic compaction, path resolution with legacy fallback, hook-shell invocation.
- Deliver core tools via MCP server: `init_experiment`, `run_experiment`, `log_experiment`.
- Provide skills `autoresearch-create`, `autoresearch-finalize`, `autoresearch-hooks`.
- Wire the autonomous loop via the universal `stop` hook with `continueWith`.
- Preserve `/autoresearch [off|clear|export|<text>]` slash command across all Tier-1 harnesses.

## Non-goals
- Pi TUI widget (`ctx.ui.setWidget`), fullscreen dashboard overlay (`ctx.ui.custom`), keyboard shortcuts — degraded, documented in shortcomings report.
- Backwards compatibility with the legacy `pi-autoresearch` extension format or its file layout.
- Tier-2 (Copilot, Gemini, Kimi) targets — Tier-1 only.

## Milestones
1. Scaffold `agentplugins.config.ts`, `package.json`, `tsconfig.json`; clean stale Pi artifacts.
2. Port portable runtime into `src/runtime/` (`jsonl.ts`, `paths.ts`, `compaction.ts`, `hooks.ts`, `confidence.ts`).
3. Implement MCP server in `src/mcp/index.ts` exposing the three experiment tools.
4. Adapt `skills/autoresearch-create/SKILL.md`, `autoresearch-finalize/SKILL.md`, `autoresearch-hooks/SKILL.md`.
5. Define universal hooks in manifest: `sessionStart` (inject context), `stop` (continueWith loop), `preCompact`/`postCompact` (snapshot/cleanup), `userPromptSubmit` (gate on `/autoresearch`).
6. Define `/autoresearch` prompt-based command in the manifest.
7. Wire local `@agentplugins/cli` and `@agentplugins/core` via `pnpm link` against `../agentplugins`.
8. `pnpm agentplugins build --targets claude,codex,opencode,pimono && validate && lint`.
9. Port `tests/*.test.mjs` to MCP-server-level integration tests; add a smoke build test.
10. Write `.agents/notes/agentplugins-port-shortcomings.md` enumerating architecture A losses vs. the original Pi extension, with recommendations for adding `nativeEntry.pimono` if Pi fidelity is later required.

## Component design
- **`agentplugins.config.ts`** — `definePlugin({ name, version, description, targets, skills, hooks, commands, mcpServers, userConfig })`.
- **`src/runtime/jsonl.ts`** — append-only JSONL logger.
- **`src/runtime/paths.ts`** — `.auto/` resolver with legacy fallback.
- **`src/runtime/compaction.ts`** — deterministic summary generator.
- **`src/runtime/hooks.ts`** — `.auto/hooks/*` shell invocation helper.
- **`src/runtime/confidence.ts`** — confidence-score helper.
- **`src/mcp/index.ts`** — stdio MCP server with `init_experiment`, `run_experiment`, `log_experiment`.
- **`skills/autoresearch-{create,finalize,hooks}/SKILL.md`** — adapted content + YAML frontmatter.
- **`assets/template.html`** — ported dashboard (referenced by the create/finalize skills).
- **`finalize.sh`** — port as portable script under `assets/` or `runtime/`.

## Local dependency
Use `pnpm link` (preferred) or `verdaccio` to expose `@agentplugins/cli` and `@agentplugins/core` from `../agentplugins` (branch `feat/v0.4.0-authoring-primitives`). Add as `devDependencies` in `package.json`.

## Verification
- `pnpm install`
- `pnpm agentplugins build --targets claude,codex,opencode,pimono`
- `pnpm agentplugins validate`
- `pnpm agentplugins lint`
- `pnpm test`
- Manual: inspect `dist/claude/`, `dist/codex/`, `dist/opencode/`, `dist/pimono/`.

## Post-implementation report
`.agents/notes/agentplugins-port-shortcomings.md` documenting:
- Pi TUI widget, fullscreen dashboard, keyboard shortcuts lost.
- Live confidence widget and progress overlays lost.
- Codex `command` handler vs. prompt-only commands compatibility.
- Recommendations for adding `nativeEntry.pimono` if Pi fidelity is later required.