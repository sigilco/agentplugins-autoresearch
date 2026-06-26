import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonlEntry,
  isAutoresearchConfigEntry,
  isAutoresearchRunEntry,
  hasAutoresearchConfigHeader,
  extractAutoresearchSessionName,
  reconstructJsonlState,
} from "../dist/runtime/jsonl.js";
import { steerMessageFor } from "../dist/runtime/hooks.js";

describe("jsonl parsers", () => {
  it("parses a config entry", () => {
    const entry = parseJsonlEntry(
      JSON.stringify({
        type: "config",
        name: "latency-bench",
        metricName: "latency",
        metricUnit: "ms",
        bestDirection: "lower",
      }),
    );
    assert.equal(entry.type, "config");
    assert.equal(entry.name, "latency-bench");
  });

  it("parses a run entry", () => {
    const entry = parseJsonlEntry(
      JSON.stringify({
        run: 1,
        commit: "abc1234",
        metric: 42,
        status: "keep",
        description: "baseline",
        timestamp: 1234567890,
        segment: 0,
      }),
    );
    assert.equal(entry.run, 1);
    assert.equal(entry.metric, 42);
    assert.equal(entry.status, "keep");
  });

  it("detects config entries", () => {
    assert.ok(
      isAutoresearchConfigEntry({
        type: "config",
        name: "x",
        metricName: "y",
      }),
    );
    assert.ok(!isAutoresearchConfigEntry({ run: 1, metric: 5 }));
  });

  it("detects run entries", () => {
    assert.ok(
      isAutoresearchRunEntry({
        run: 1,
        commit: "a",
        metric: 5,
        status: "keep",
        description: "x",
        timestamp: 1,
        segment: 0,
      }),
    );
    assert.ok(!isAutoresearchRunEntry({ type: "config", name: "x" }));
  });

  it("detects config header presence", () => {
    const lines = [
      JSON.stringify({ type: "config", name: "x", metricName: "y" }),
      JSON.stringify({ run: 1 }),
    ];
    assert.ok(hasAutoresearchConfigHeader(lines.join("\n")));
    assert.ok(!hasAutoresearchConfigHeader(JSON.stringify({ run: 1 })));
  });

  it("extracts session name", () => {
    const name = extractAutoresearchSessionName(
      [
        JSON.stringify({ type: "config", name: "my-session", metricName: "x" }),
      ].join("\n"),
    );
    assert.equal(name, "my-session");
  });
});

describe("state reconstruction", () => {
  it("reconstructs a full session", () => {
    const lines = [
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
        description: "optimization A",
        timestamp: 2,
        segment: 0,
        confidence: 1.5,
      }),
    ];
    const state = reconstructJsonlState(lines.join("\n"));
    assert.equal(state.name, "latency-bench");
    assert.equal(state.results.length, 2);
    assert.equal(state.results[1].metric, 90);
    assert.equal(state.results[0].metric, 100);
  });

  it("steerMessageFor returns stdout on zero exit", () => {
    const msg = steerMessageFor("before", { fired: true, exitCode: 0, stdout: "try X", stderr: "" });
    assert.equal(msg, "try X");
  });

  it("steerMessageFor returns error message on non-zero exit", () => {
    const msg = steerMessageFor("before", { fired: true, exitCode: 1, stdout: "try X", stderr: "" });
    assert.ok(msg?.includes("[before hook exited 1]"));
    assert.ok(msg?.includes("try X"));
  });
});
