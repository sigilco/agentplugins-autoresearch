import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initExperiment,
  runExperiment,
  logExperiment,
} from "../dist/runtime/experiment-logic.js";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "autoresearch-experiment-"));
}

describe("experiment-logic", () => {
  it("initExperiment creates .auto/log.jsonl", async () => {
    const tempDir = makeTempDir();
    try {
      const result = await initExperiment(tempDir, {
        name: "latency-bench",
        metric_name: "latency",
        metric_unit: "ms",
        direction: "lower",
      });
      assert.ok(result.text);
      assert.equal(result.metricName, "latency");

      const logPath = join(tempDir, ".auto", "log.jsonl");
      const contents = readFileSync(logPath, "utf-8");
      assert.ok(contents.includes('"type":"config"'));
      assert.ok(contents.includes('"segment":0'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("runExperiment captures output and parsed metrics", async () => {
    const tempDir = makeTempDir();
    try {
      await initExperiment(tempDir, {
        name: "latency-bench",
        metric_name: "latency",
        metric_unit: "ms",
        direction: "lower",
      });

      const result = await runExperiment(tempDir, {
        command: 'echo "METRIC: latency 42"; echo "done"',
      });
      assert.ok(result.text);
      assert.equal(result.details.parsedPrimary, 42);
      assert.equal(result.details.parsedMetrics?.latency, 42);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("logExperiment appends a run entry and computes confidence", async () => {
    const tempDir = makeTempDir();
    try {
      await initExperiment(tempDir, {
        name: "latency-bench",
        metric_name: "latency",
        metric_unit: "ms",
        direction: "lower",
      });

      await logExperiment(tempDir, {
        commit: "abc1234",
        metric: 100,
        status: "keep",
        description: "baseline",
      });

      await logExperiment(tempDir, {
        commit: "def5678",
        metric: 90,
        status: "keep",
        description: "optimization A",
      });

      await logExperiment(tempDir, {
        commit: "ghi9012",
        metric: 85,
        status: "keep",
        description: "optimization B",
      });

      const logPath = join(tempDir, ".auto", "log.jsonl");
      const lines = readFileSync(logPath, "utf-8").trim().split("\n");
      assert.equal(lines.length, 4); // config + 3 runs

      const lastRun = JSON.parse(lines[lines.length - 1]);
      assert.equal(lastRun.run, 3);
      assert.equal(lastRun.metric, 85);
      assert.ok(typeof lastRun.confidence === "number");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reinit increments segment", async () => {
    const tempDir = makeTempDir();
    try {
      await initExperiment(tempDir, {
        name: "latency-bench",
        metric_name: "latency",
        metric_unit: "ms",
        direction: "lower",
      });
      await logExperiment(tempDir, {
        commit: "abc1234",
        metric: 100,
        status: "keep",
        description: "baseline",
      });

      const result = await initExperiment(tempDir, {
        name: "latency-bench-v2",
        metric_name: "latency",
        metric_unit: "ms",
        direction: "lower",
      });
      assert.ok(result.reinit);
      assert.equal(result.segment, 1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("runExperiment respects maxExperiments gate", async () => {
    const tempDir = makeTempDir();
    try {
      mkdirSync(join(tempDir, ".auto"), { recursive: true });
      writeFileSync(
        join(tempDir, ".auto", "config.json"),
        JSON.stringify({ maxIterations: 1 }),
      );

      await initExperiment(tempDir, {
        name: "limited",
        metric_name: "x",
        direction: "lower",
      });
      await logExperiment(tempDir, {
        commit: "a",
        metric: 1,
        status: "keep",
        description: "first",
      });

      // runExperiment should refuse to run after the limit is reached
      let error;
      try {
        const result = await runExperiment(tempDir, { command: "echo ok" });
        if (result && result.ok === false) {
          error = new Error(result.error);
        } else {
          assert.fail("expected runExperiment to refuse after limit");
        }
      } catch (e) {
        error = e;
      }
      assert.ok(error && error.message.includes("Maximum experiments reached"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
