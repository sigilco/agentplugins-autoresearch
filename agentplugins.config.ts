import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@agentplugins/core";

// ---------------------------------------------------------------------------
// AgentPlugins manifest for agentplugins-autoresearch
// ---------------------------------------------------------------------------

interface LogEntry {
  type?: string;
  run?: number;
  segment?: number;
  status?: string;
  metric?: number;
  description?: unknown;
  name?: unknown;
  metricName?: unknown;
  metricUnit?: unknown;
  bestDirection?: unknown;
  maxIterations?: unknown;
}

interface Session {
  config: LogEntry;
  runs: LogEntry[];
  segmentRuns: LogEntry[];
}

function parseLog(directory?: string): Session | null {
  const cwd = directory ?? process.cwd();
  const jsonlPath = join(cwd, ".auto", "log.jsonl");
  if (!existsSync(jsonlPath)) return null;

  const lines = readFileSync(jsonlPath, "utf-8")
    .split("\n")
    .filter((line: string) => line.trim() !== "");

  let config: LogEntry | null = null;
  const runs: LogEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as LogEntry;
      if (entry.type === "config") config = entry;
      else if (typeof entry.run === "number") runs.push(entry);
    } catch {
      // ignore malformed lines
    }
  }
  if (!config) return null;

  const segment = typeof config.segment === "number" ? config.segment : 0;
  const segmentRuns = runs.filter(
    (r) => (typeof r.segment === "number" ? r.segment : 0) === segment,
  );

  return { config, runs, segmentRuns };
}

function metricDirection(config: LogEntry): number {
  return config.bestDirection === "higher" ? 1 : -1;
}

function sortByMetric(runs: LogEntry[], direction: number): LogEntry[] {
  return [...runs].sort((a, b) => {
    const am = typeof a.metric === "number" ? a.metric : Infinity;
    const bm = typeof b.metric === "number" ? b.metric : Infinity;
    return direction === 1 ? bm - am : am - bm;
  });
}

function bestRun(segmentRuns: LogEntry[], direction: number): LogEntry | null {
  const kept = segmentRuns.filter((r) => r.status === "keep");
  return sortByMetric(kept, direction)[0] ?? null;
}

function formatRun(run: LogEntry, unit: string): string {
  const metric = typeof run.metric === "number" ? String(run.metric) : "—";
  const description = String(run.description ?? "");
  return `  #${run.run} ${run.status}: ${metric}${unit} — ${description}`;
}

function sessionSummary(directory?: string) {
  const session = parseLog(directory);
  if (!session) return {};

  const { config, segmentRuns } = session;
  const metricName = String(config.metricName ?? "metric");
  const unit = String(config.metricUnit ?? "");
  const direction = config.bestDirection === "higher" ? "higher" : "lower";
  const kept = segmentRuns.filter((r) => r.status === "keep");
  const best = bestRun(segmentRuns, metricDirection(config));

  const summary = [
    `Active autoresearch session: "${config.name}"`,
    `Metric: ${metricName} (${unit || "unitless"}, ${direction} is better)`,
    `Segment runs: ${segmentRuns.length} (${kept.length} kept)`,
    `Best so far: ${best ? String(best.metric) + unit : "—"}`,
    "",
    "Latest runs:",
    ...segmentRuns.slice(-5).map((r) => formatRun(r, unit)),
  ].join("\n");

  return { additionalContext: summary };
}

function stopPrompt(directory?: string) {
  const session = parseLog(directory);
  if (!session) return {};

  const { config, segmentRuns } = session;
  const metricName = String(config.metricName ?? "metric");
  const unit = String(config.metricUnit ?? "");
  const direction = metricDirection(config);
  const best = bestRun(segmentRuns, direction);

  const max = typeof config.maxIterations === "number" ? config.maxIterations : null;
  if (max !== null && segmentRuns.length >= max) {
    return {
      additionalContext: `Autoresearch "${config.name}" has reached its maximum of ${max} experiments. Stop the loop.`,
    };
  }

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
}

function compactSummary(directory?: string) {
  const session = parseLog(directory);
  if (!session) return {};

  const { config, segmentRuns } = session;
  const metricName = String(config.metricName ?? "metric");
  const unit = String(config.metricUnit ?? "");
  const direction = config.bestDirection === "higher" ? "higher" : "lower";
  const kept = segmentRuns.filter((r) => r.status === "keep");
  const best = bestRun(segmentRuns, metricDirection(config));
  const baseline = segmentRuns[0];

  const summary = [
    `Autoresearch compaction summary for "${config.name}"`,
    `Metric: ${metricName} (${unit || "unitless"}, ${direction} is better)`,
    `Runs this segment: ${segmentRuns.length} (${kept.length} kept)`,
    baseline ? `Baseline: ${baseline.metric}${unit} — ${baseline.description}` : "",
    best ? `Best: ${best.metric}${unit} — ${best.description}` : "",
    "",
    "Recent runs:",
    ...segmentRuns.slice(-10).map((r) => formatRun(r, unit)),
  ]
    .filter((line) => line !== "")
    .join("\n");

  return { additionalContext: summary };
}

function delegateTool(source: string, target: string) {
  const handler = async (
    args: Record<string, unknown>,
    ctx: { directory?: string },
  ) => {
    const mod = await import(source);
    const result = await mod[target](ctx.directory ?? process.cwd(), args);
    return { content: [{ type: "text" as const, text: result.text }] };
  };
  Object.assign(handler, { source, target });
  return handler as (args: Record<string, unknown>, ctx: { directory?: string }) => Promise<unknown>;
}

export default definePlugin({
  name: "autoresearch",
  version: "0.1.0",
  description:
    "Autonomous experiment loop for agentplugins — run, measure, keep or discard. Inspired by karpathy/autoresearch.",
  license: "MIT",

  targets: ["claude", "codex", "opencode"],
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

  hooks: {
    sessionStart: {
      handler: {
        type: "inline",
        handler: sessionSummary,
      },
    },

    preToolUse: {
      handler: {
        type: "inline",
        handler: async () => ({}),
      },
    },

    stop: {
      handler: {
        type: "inline",
        handler: stopPrompt,
      },
    },

    preCompact: {
      handler: {
        type: "inline",
        handler: compactSummary,
      },
    },
  },

  mcpServers: {
    "autoresearch-tools": {
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/index.js"],
      transport: "stdio",
    },
  },

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
      handler: delegateTool("../runtime/experiment-logic.js", "initExperiment"),
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
      handler: delegateTool("../runtime/experiment-logic.js", "runExperiment"),
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
      handler: delegateTool("../runtime/experiment-logic.js", "logExperiment"),
    },
  ],
});
