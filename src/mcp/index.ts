#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  initExperiment,
  runExperiment,
  logExperiment,
  type InitArgs,
  type RunArgs,
  type LogArgs,
} from "../runtime/experiment-logic.js";

function getCwd(): string {
  if (process.env.AUTORESEARCH_CWD) {
    return process.env.AUTORESEARCH_CWD;
  }
  return process.cwd();
}

const server = new Server(
  {
    name: "autoresearch-tools",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "init_experiment",
        description:
          "Initialize a new autoresearch session. Writes a config header to .auto/log.jsonl so that subsequent run_experiment and log_experiment calls know the metric name, goal, and direction of improvement.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Short human-readable name for this experiment session. Used in compaction summaries.",
            },
            metric_name: {
              type: "string",
              description:
                "Primary metric to optimize, e.g. 'latency', 'throughput', 'error_rate'. Values are parsed from `METRIC: <metric_name> <value>` lines in run_experiment output.",
            },
            metric_unit: {
              type: "string",
              description:
                "Optional unit suffix, e.g. 'ms', 'req/s', '%'. Used only for display.",
            },
            direction: {
              type: "string",
              enum: ["lower", "higher"],
              description:
                "Whether a lower or higher primary metric is better. Default: lower.",
            },
          },
          required: ["name", "metric_name"],
        },
      },
      {
        name: "run_experiment",
        description:
          "Run a shell command as an experiment. Captures stdout/stderr, parses `METRIC: <metric_name> <value>` lines, runs .auto/checks.sh if present, and reports pass/fail/tail output. Does NOT mutate the log.",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description:
                "Shell command to run. If .auto/measure.sh exists, only autoresearch.sh or the measure script itself is accepted.",
            },
            timeout_seconds: {
              type: "number",
              description:
                "Maximum seconds to let the command run. Default: 600.",
            },
            checks_timeout_seconds: {
              type: "number",
              description:
                "Maximum seconds for .auto/checks.sh. Default: 300.",
            },
          },
          required: ["command"],
        },
      },
      {
        name: "log_experiment",
        description:
          "Record an experiment result to .auto/log.jsonl, update the confidence score, optionally commit or revert changes, and fire .auto/hooks/before.sh / .auto/hooks/after.sh.",
        inputSchema: {
          type: "object",
          properties: {
            commit: {
              type: "string",
              description:
                "Git commit-ish or short SHA for this run. Updated automatically after a successful commit.",
            },
            metric: {
              type: "number",
              description:
                "Primary metric value for this run. Must be numeric.",
            },
            status: {
              type: "string",
              enum: ["keep", "discard", "crash", "checks_failed"],
              description:
                "keep = accept the change and commit; discard = revert working tree; crash = command crashed; checks_failed = command passed but .auto/checks.sh failed.",
            },
            description: {
              type: "string",
              description:
                "Short description of what changed in this run. Becomes the git commit message subject if kept.",
            },
            metrics: {
              type: "object",
              additionalProperties: { type: "number" },
              description:
                "Optional secondary metrics parsed from run_experiment output, e.g. {'memory_kb': 1024, 'compile_ms': 45}.",
            },
            force: {
              type: "boolean",
              description:
                "If true, allow adding new secondary metrics that were not previously tracked.",
            },
            asi: {
              type: "object",
              additionalProperties: true,
              description:
                "Optional agent-state-information object to attach to the run entry for later analysis.",
            },
          },
          required: ["commit", "metric", "status", "description"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const cwd = getCwd();

  function errorContent(message: string) {
    return {
      content: [
        {
          type: "text" as const,
          text: message,
        },
      ],
      isError: true,
    };
  }

  try {
    switch (name) {
      case "init_experiment": {
        const args = rawArgs as unknown as InitArgs;
        const result = await initExperiment(cwd, args);
        return {
          content: [
            {
              type: "text" as const,
              text: result.text,
            },
          ],
        };
      }

      case "run_experiment": {
        const args = rawArgs as unknown as RunArgs;
        const result = await runExperiment(cwd, args);
        return {
          content: [
            {
              type: "text" as const,
              text: result.text,
            },
          ],
        };
      }

      case "log_experiment": {
        const args = rawArgs as unknown as LogArgs;
        const result = await logExperiment(cwd, args);
        const lines: string[] = [result.text];
        if (result.steerMessage) {
          lines.push("");
          lines.push("── Next-step guidance from hooks ──");
          lines.push(result.steerMessage);
        }
        if (result.limitReached) {
          lines.push("");
          lines.push(
            "Experiment limit reached. Stop iterating. Call init_experiment with a new name if you want to start a fresh segment.",
          );
        }
        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n"),
            },
          ],
        };
      }

      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[autoresearch-tools] Tool ${name} threw: ${message}`);
    return errorContent(`Unexpected error in ${name}: ${message}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(`[autoresearch-tools] Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
