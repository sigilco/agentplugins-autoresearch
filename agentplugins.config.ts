import { definePlugin } from "@agentplugins/core";

// ---------------------------------------------------------------------------
// AgentPlugins manifest for agentplugins-autoresearch
// Architecture A: manifest-only, no nativeEntry. Tier-1 targets via MCP + tools.
// ---------------------------------------------------------------------------

// Helper to attach Pi-Mono source/target delegation while satisfying the core
// function-typed handler. The function body is never executed by the pimono
// adapter (it does dynamic import(source)), but we keep a real fallback.
function delegatedToolHandler(source: string, target: string) {
  const handler = async (args: Record<string, unknown>, ctx: { directory?: string }) => {
    const mod = await import(source);
    const fn = mod[target];
    if (typeof fn !== "function") {
      throw new Error(`Tool target "${target}" not found in ${source}`);
    }
    const result = await fn(ctx.directory ?? process.cwd(), args);
    return {
      content: [{ type: "text" as const, text: result.text }],
    };
  };
  (handler as unknown as Record<string, unknown>).source = source;
  (handler as unknown as Record<string, unknown>).target = target;
  return handler as (args: Record<string, unknown>, ctx: { directory?: string }) => Promise<unknown>;
}

export default definePlugin({
  name: "autoresearch",
  version: "0.1.0",
  description:
    "Autonomous experiment loop for agentplugins — run, measure, keep or discard. Inspired by karpathy/autoresearch.",
  license: "MIT",

  targets: ["claude", "codex", "opencode", "pimono"],
  capabilities: ["subprocess"],

  skills: [
    {
      name: "autoresearch-create",
      description:
        "Start and run an autoresearch experiment loop: initialize, benchmark, keep/discard, and iterate.",
      filePath: "./skills/autoresearch-create/SKILL.md",
    },
    {
      name: "autoresearch-finalize",
      description:
        "Finalize an autoresearch session: pick the best run, export the dashboard, and summarize findings.",
      filePath: "./skills/autoresearch-finalize/SKILL.md",
    },
    {
      name: "autoresearch-hooks",
      description:
        "Install custom before/after hooks to steer the autoresearch loop between experiments.",
      filePath: "./skills/autoresearch-hooks/SKILL.md",
    },
  ],

  commands: [
    {
      name: "/autoresearch",
      description: "Start or manage an autoresearch experiment loop",
      argumentHint: "[goal]",
      prompt: `You are in autoresearch mode. Use these tools to run an autonomous experiment loop:

- init_experiment(name, metric_name, metric_unit?, direction?) — start a new session
- run_experiment(command, timeout_seconds?, checks_timeout_seconds?) — run a benchmark command
- log_experiment(commit, metric, status, description, metrics?, force?, asi?) — record the result

If the user provided a goal, follow these steps:
1. Call init_experiment with a concise session name and the primary metric to optimize.
2. Run a baseline with run_experiment, then log it as status "keep".
3. Propose improvements, run each with run_experiment, and log as keep/discard/crash/checks_failed.
4. Use the autoresearch-finalize skill when you have a clear winner.

Goal:`,
    },
  ],

  // -------------------------------------------------------------------------
  // Hooks: all inline and self-contained so they survive extraction on Claude,
  // inlining on OpenCode, and inlining on Pi Mono.
  // -------------------------------------------------------------------------
  hooks: {
    sessionStart: {
      handler: {
        type: "inline",
        handler: async (ctx: { directory?: string }) => {
          const { existsSync, readFileSync } = await import("node:fs");
          const path = await import("node:path");
          const cwd = ctx.directory ?? process.cwd();
          const jsonlPath = path.join(cwd, ".auto", "log.jsonl");
          if (!existsSync(jsonlPath)) return {};

          const lines = readFileSync(jsonlPath, "utf-8")
            .split("\n")
            .filter((l) => l.trim() !== "");
          let config: Record<string, unknown> | null = null;
          const runs: Array<Record<string, unknown>> = [];
          for (const line of lines) {
            try {
              const entry = JSON.parse(line) as Record<string, unknown>;
              if (entry.type === "config") config = entry;
              else if (typeof entry.run === "number") runs.push(entry);
            } catch {
              // ignore malformed lines
            }
          }
          if (!config) return {};

          const segment =
            typeof config.segment === "number" ? config.segment : 0;
          const segmentRuns = runs.filter(
            (r) =>
              (typeof r.segment === "number" ? r.segment : 0) === segment,
          );
          const kept = segmentRuns.filter((r) => r.status === "keep");
          const sorted = [...kept].sort((a, b) => {
            const direction = config!.bestDirection === "higher" ? 1 : -1;
            const am = typeof a.metric === "number" ? a.metric : Infinity;
            const bm = typeof b.metric === "number" ? b.metric : Infinity;
            return direction === 1 ? bm - am : am - bm;
          });
          const best = sorted[0];
          const metricName = String(config.metricName ?? "metric");
          const unit = String(config.metricUnit ?? "");
          const direction = String(config.bestDirection ?? "lower");

          const summary = [
            `Active autoresearch session: "${config.name}"`,
            `Metric: ${metricName} (${unit || "unitless"}, ${direction} is better)`,
            `Segment runs: ${segmentRuns.length} (${kept.length} kept)`,
            `Best so far: ${best ? String(best.metric) + unit : "—"}`,
            "",
            "Latest runs:",
            ...segmentRuns.slice(-5).map(
              (r) =
                `  #${r.run} ${r.status}: ${r.metric}${unit} — ${r.description}`,
            ),
          ].join("\n");

          return { additionalContext: summary };
        },
      },
    },

    preToolUse: {
      handler: {
        type: "inline",
        handler: async () => {
          return {};
        },
      },
    },

    stop: {
      handler: {
        type: "inline",
        handler: async (ctx: { directory?: string }) => {
          const { existsSync, readFileSync } = await import("node:fs");
          const path = await import("node:path");
          const cwd = ctx.directory ?? process.cwd();
          const jsonlPath = path.join(cwd, ".auto", "log.jsonl");
          if (!existsSync(jsonlPath)) return {};

          const lines = readFileSync(jsonlPath, "utf-8")
            .split("\n")
            .filter((l) => l.trim() !== "");
          let config: Record<string, unknown> | null = null;
          const runs: Array<Record<string, unknown>> = [];
          for (const line of lines) {
            try {
              const entry = JSON.parse(line) as Record<string, unknown>;
              if (entry.type === "config") config = entry;
              else if (typeof entry.run === "number") runs.push(entry);
            } catch {
              // ignore malformed lines
            }
          }
          if (!config) return {};

          const segment =
            typeof config.segment === "number" ? config.segment : 0;
          const segmentRuns = runs.filter(
            (r) =>
              (typeof r.segment === "number" ? r.segment : 0) === segment,
          );
          const max =
            typeof config.maxIterations === "number"
              ? config.maxIterations
              : null;
          if (max !== null && segmentRuns.length >= max) {
            return {
              additionalContext: `Autoresearch "${config.name}" has reached its maximum of ${max} experiments. Stop the loop.`,
            };
          }

          const metricName = String(config.metricName ?? "metric");
          const unit = String(config.metricUnit ?? "");
          const direction = String(config.bestDirection ?? "lower");
          const kept = segmentRuns.filter((r) => r.status === "keep");
          const sorted = [...kept].sort((a, b) => {
            const dir = direction === "higher" ? 1 : -1;
            const am = typeof a.metric === "number" ? a.metric : Infinity;
            const bm = typeof b.metric === "number" ? b.metric : Infinity;
            return dir === 1 ? bm - am : am - bm;
          });
          const best = sorted[0];

          if (segmentRuns.length === 0) {
            return {
              continueWith:
                `Start the first experiment for "${config.name}". ` +
                `Call run_experiment with a command that measures ${metricName}, then log_experiment.`,
            };
          }

          const last = segmentRuns[segmentRuns.length - 1];
          const lastStatus = String(last.status);
          if (lastStatus === "crash" || lastStatus === "checks_failed") {
            return {
              continueWith:
                `The last run crashed or failed checks. Diagnose, fix the issue, ` +
                `then run the next experiment for "${config.name}". ` +
                `Best ${metricName} so far: ${best ? String(best.metric) + unit : "—"}.`,
            };
          }

          return {
            continueWith:
              `Continue autoresearch "${config.name}". Run #${segmentRuns.length + 1}. ` +
              `Best ${metricName} so far: ${best ? String(best.metric) + unit : "—"}. ` +
              `Propose a new change, run it with run_experiment, and log it with log_experiment.`,
          };
        },
      },
    },

    preCompact: {
      handler: {
        type: "inline",
        handler: async (ctx: { directory?: string }) => {
          const { existsSync, readFileSync } = await import("node:fs");
          const path = await import("node:path");
          const cwd = ctx.directory ?? process.cwd();
          const jsonlPath = path.join(cwd, ".auto", "log.jsonl");
          if (!existsSync(jsonlPath)) return {};

          const lines = readFileSync(jsonlPath, "utf-8")
            .split("\n")
            .filter((l) => l.trim() !== "");
          let config: Record<string, unknown> | null = null;
          const runs: Array<Record<string, unknown>> = [];
          for (const line of lines) {
            try {
              const entry = JSON.parse(line) as Record<string, unknown>;
              if (entry.type === "config") config = entry;
              else if (typeof entry.run === "number") runs.push(entry);
            } catch {
              // ignore malformed lines
            }
          }
          if (!config) return {};

          const segment =
            typeof config.segment === "number" ? config.segment : 0;
          const segmentRuns = runs.filter(
            (r) =>
              (typeof r.segment === "number" ? r.segment : 0) === segment,
          );
          const kept = segmentRuns.filter((r) => r.status === "keep");
          const metricName = String(config.metricName ?? "metric");
          const unit = String(config.metricUnit ?? "");
          const direction = String(config.bestDirection ?? "lower");
          const sorted = [...kept].sort((a, b) => {
            const dir = direction === "higher" ? 1 : -1;
            const am = typeof a.metric === "number" ? a.metric : Infinity;
            const bm = typeof b.metric === "number" ? b.metric : Infinity;
            return dir === 1 ? bm - am : am - bm;
          });
          const best = sorted[0];
          const baseline = segmentRuns[0];

          const summary = [
            `Autoresearch compaction summary for "${config.name}"`,
            `Metric: ${metricName} (${unit || "unitless"}, ${direction} is better)`,
            `Runs this segment: ${segmentRuns.length} (${kept.length} kept)`,
            baseline
              ? `Baseline: ${baseline.metric}${unit} — ${baseline.description}`
              : "",
            best
              ? `Best: ${best.metric}${unit} — ${best.description}`
              : "",
            "",
            "Recent runs:",
            ...segmentRuns.slice(-10).map(
              (r) =
                `  #${r.run} ${r.status}: ${r.metric}${unit} — ${r.description}`,
            ),
          ]
            .filter((line) => line !== "")
            .join("\n");

          return { additionalContext: summary };
        },
      },
    },
  },

  // -------------------------------------------------------------------------
  // MCP server: primary tool delivery for Claude/Codex/OpenCode.
  // -------------------------------------------------------------------------
  mcpServers: {
    "autoresearch-tools": {
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/index.js"],
      transport: "stdio",
    },
  },

  // -------------------------------------------------------------------------
  // Tools: Pi Mono native registration only. Handlers delegate to compiled
  // runtime; the function body here is not executed by the pimono adapter.
  // -------------------------------------------------------------------------
  tools: [
    {
      name: "init_experiment",
      description:
        "Initialize a new autoresearch session. Writes a config header to .auto/log.jsonl.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          metric_name: { type: "string" },
          metric_unit: { type: "string" },
          direction: { type: "string", enum: ["lower", "higher"] },
        },
        required: ["name", "metric_name"],
      },
      handler: delegatedToolHandler(
        "../runtime/experiment-logic.js",
        "initExperiment",
      ),
    },
    {
      name: "run_experiment",
      description:
        "Run a shell command as an experiment. Captures output, parses METRIC lines, runs .auto/checks.sh if present.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_seconds: { type: "number" },
          checks_timeout_seconds: { type: "number" },
        },
        required: ["command"],
      },
      handler: delegatedToolHandler(
        "../runtime/experiment-logic.js",
        "runExperiment",
      ),
    },
    {
      name: "log_experiment",
      description:
        "Record an experiment result to .auto/log.jsonl, update confidence, optionally commit/revert changes, and fire hooks.",
      parameters: {
        type: "object",
        properties: {
          commit: { type: "string" },
          metric: { type: "number" },
          status: {
            type: "string",
            enum: ["keep", "discard", "crash", "checks_failed"],
          },
          description: { type: "string" },
          metrics: {
            type: "object",
            additionalProperties: { type: "number" },
          },
          force: { type: "boolean" },
          asi: { type: "object" },
        },
        required: ["commit", "metric", "status", "description"],
      },
      handler: delegatedToolHandler(
        "../runtime/experiment-logic.js",
        "logExperiment",
      ),
    },
  ],
});
