import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAutoresearchCompactionSummary,
  autoresearchSummaryPathsFor,
} from "../dist/runtime/compaction.js";

describe("compaction", () => {
  function writeJsonlLines(dir, lines) {
    const p = join(dir, ".auto", "log.jsonl");
    mkdirSync(join(dir, ".auto"), { recursive: true });
    writeFileSync(p, lines.join("\n"));
  }

  it("returns a header for missing jsonl", () => {
    const paths = autoresearchSummaryPathsFor("/does/not/exist");
    const summary = buildAutoresearchCompactionSummary(paths);
    assert.ok(summary.includes("Autoresearch Compaction Summary"));
  });

  it("builds a summary for the .auto layout", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "autoresearch-compaction-"));
    writeJsonlLines(tempDir, [
      JSON.stringify({
        type: "config",
        name: "latency-bench",
        metricName: "latency",
        metricUnit: "ms",
        bestDirection: "lower",
        segment: 0,
      }),
      JSON.stringify({
        run: 1,
        commit: "abc1234",
        metric: 100,
        status: "keep",
        description: "baseline",
        timestamp: 1,
        segment: 0,
        confidence: null,
      }),
      JSON.stringify({
        run: 2,
        commit: "def5678",
        metric: 90,
        status: "keep",
        description: "faster parser",
        timestamp: 2,
        segment: 0,
        confidence: 1.5,
      }),
    ]);

    const paths = autoresearchSummaryPathsFor(tempDir);
    const summary = buildAutoresearchCompactionSummary(paths);
    assert.ok(summary.includes("latency-bench"));
    assert.ok(summary.includes("baseline"));
    assert.ok(summary.includes("faster parser"));
    assert.ok(summary.includes("Best"));

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("suggests a next step after baseline", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "autoresearch-compaction-"));
    writeJsonlLines(tempDir, [
      JSON.stringify({
        type: "config",
        name: "latency-bench",
        metricName: "latency",
        metricUnit: "ms",
        bestDirection: "lower",
        segment: 0,
      }),
      JSON.stringify({
        run: 1,
        commit: "abc1234",
        metric: 100,
        status: "keep",
        description: "baseline",
        timestamp: 1,
        segment: 0,
        confidence: null,
      }),
    ]);

    const paths = autoresearchSummaryPathsFor(tempDir);
    const summary = buildAutoresearchCompactionSummary(paths);
    assert.ok(summary.includes("Next step") || summary.includes("baseline"));

    rmSync(tempDir, { recursive: true, force: true });
  });
});
