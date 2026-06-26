/**
 * Experiment tool logic — pure function port of init/run/log handlers.
 *
 * No Pi imports. No closures over ctx/pi/runtime. Functions take (cwd, args)
 * and return structured results. Side effects (git, fs) are performed directly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

import {
  reconstructJsonlState,
  parseJsonlEntry,
  isAutoresearchRunEntry,
  type ReconstructedRun,
  type ReconstructedJsonlState,
} from "./jsonl.js";
import {
  sessionFilePath,
  ensureParentDir,
  AUTO_DIR,
} from "./paths.js";
import {
  runHook,
  steerMessageFor,
  appendHookLogEntryIfConfigured,
  type HookPayload,
} from "./hooks.js";
import {
  parseMetricLines,
  computeConfidence,
  findBaselineMetric,
  findBestMetric,
  findBaselineSecondary,
  currentResults,
} from "./confidence.js";

// ---------------------------------------------------------------------------
// Output limits
// ---------------------------------------------------------------------------

/** Tight truncation for LLM context */
const EXPERIMENT_MAX_LINES = 10;
const EXPERIMENT_MAX_BYTES = 4 * 1024; // 4KB

/** Wider truncation for display tail */
const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_BYTES = 51200; // 50KB

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface InitArgs {
  name: string;
  metric_name: string;
  metric_unit?: string;
  direction?: "lower" | "higher";
}

export interface InitResult {
  ok: true;
  jsonlPath: string;
  segment: number;
  name: string;
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
  maxExperiments: number | null;
  reinit: boolean;
  text: string;
  steerMessage: string | null;
}

export interface RunArgs {
  command: string;
  timeout_seconds?: number;
  checks_timeout_seconds?: number;
}

export interface RunDetails {
  command: string;
  exitCode: number | null;
  durationSeconds: number;
  passed: boolean;
  crashed: boolean;
  timedOut: boolean;
  tailOutput: string;
  checksPass: boolean | null;
  checksTimedOut: boolean;
  checksOutput: string;
  checksDuration: number;
  parsedMetrics: Record<string, number> | null;
  parsedPrimary: number | null;
  metricName: string;
  metricUnit: string;
}

export interface RunResult {
  ok: true;
  details: RunDetails;
  text: string;
  fullOutputPath?: string;
}

export interface LogArgs {
  commit: string;
  metric: number;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  metrics?: Record<string, number>;
  force?: boolean;
  asi?: Record<string, unknown>;
}

export interface LogResult {
  ok: true;
  entry: Record<string, unknown>;
  baselineMetric: number | null;
  bestMetric: number | null;
  confidence: number | null;
  segmentCount: number;
  steerMessage: string | null;
  text: string;
  limitReached: boolean;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface AutoresearchConfig {
  maxIterations?: number;
  workingDir?: string;
}

function readConfig(cwd: string): AutoresearchConfig {
  try {
    const configPath = autoresearchConfigPath(cwd);
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function readMaxExperiments(cwd: string): number | null {
  const config = readConfig(cwd);
  return (typeof config.maxIterations === "number" && config.maxIterations > 0)
    ? Math.floor(config.maxIterations)
    : null;
}

function resolveWorkDir(ctxCwd: string): string {
  const config = readConfig(ctxCwd);
  if (!config.workingDir) return ctxCwd;
  return path.isAbsolute(config.workingDir)
    ? config.workingDir
    : path.resolve(ctxCwd, config.workingDir);
}

function validateWorkDir(ctxCwd: string): string | null {
  const workDir = resolveWorkDir(ctxCwd);
  if (workDir === ctxCwd) return null;
  try {
    const stat = fs.statSync(workDir);
    if (!stat.isDirectory()) {
      return `workingDir "${workDir}" (from .auto/config.json) is not a directory.`;
    }
  } catch {
    return `workingDir "${workDir}" (from .auto/config.json) does not exist.`;
  }
  return null;
}

function createTempFileAllocator(): () => string {
  let p: string | undefined;
  return () => {
    if (!p) {
      const id = randomBytes(8).toString("hex");
      p = path.join(tmpdir(), `pi-experiment-${id}.log`);
    }
    return p;
  };
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
}

/**
 * Check if a command's primary purpose is running the benchmark script.
 */
function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim();

  // Strip leading env variable assignments: FOO=bar BAZ="qux" ...
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");

  // Strip known harmless command wrappers (env, time, nice, nohup) repeatedly
  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
  } while (cmd !== prev);

  // Now the core command must be the benchmark script via a known invocation.
  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\/|\.{1,2}\/|[\w.-]+\/)*(?:autoresearch\.sh|\.auto\/measure\.sh)(?:\s|$)/.test(cmd);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Number formatting helpers
// ---------------------------------------------------------------------------

function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(",");
}

function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n));
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1); // ".3"
    return (n < 0 ? "-" : "") + commas(int) + frac;
  }
  return commas(n);
}

function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  const u = unit || "";
  if (value === Math.round(value)) return fmtNum(value) + u;
  return fmtNum(value, 2) + u;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(0)}KB`;
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

interface TruncateResult {
  content: string;
  truncated: boolean;
  truncatedBy?: "lines" | "bytes";
  outputLines?: number;
  totalLines?: number;
}

/**
 * Simple truncation that keeps the tail of text, bounded by maxLines and maxBytes.
 * Operates on a complete string — no streaming buffer trick.
 */
function truncateTail(text: string, { maxLines, maxBytes }: { maxLines: number; maxBytes: number }): TruncateResult {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(text, "utf-8");

  // If within limits, return as-is
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content: text, truncated: false, outputLines: totalLines, totalLines };
  }

  // Truncate by lines first: take last maxLines lines
  if (totalLines > maxLines) {
    const tail = lines.slice(-maxLines).join("\n");
    const tailBytes = Buffer.byteLength(tail, "utf-8");
    if (tailBytes > maxBytes) {
      // Also exceeds byte limit — keep trimming from the top
      return truncateTailByBytes(tail, maxBytes, totalLines);
    }
    return { content: tail, truncated: true, truncatedBy: "lines", outputLines: maxLines, totalLines };
  }

  // Only exceeds byte limit
  return truncateTailByBytes(text, maxBytes, totalLines);
}

function truncateTailByBytes(text: string, maxBytes: number, totalLines: number): TruncateResult {
  const textBytes = Buffer.byteLength(text, "utf-8");
  if (textBytes <= maxBytes) {
    const lines = text.split("\n").length;
    return { content: text, truncated: false, outputLines: lines, totalLines };
  }

  // Work with a buffer to handle multi-byte UTF-8 correctly
  const buf = Buffer.from(text, "utf-8");
  // Find the start of the tail that fits within maxBytes
  const start = textBytes - maxBytes;

  // Find the next newline after the cut point to avoid splitting a line
  let cutPoint = start;
  for (let i = start; i < textBytes; i++) {
    if (buf[i] === 0x0a) { // '\n'
      cutPoint = i + 1;
      break;
    }
  }

  const tailBuf = buf.subarray(cutPoint);
  const tail = tailBuf.toString("utf-8");
  const outputLines = tail.split("\n").length;

  return { content: tail, truncated: true, truncatedBy: "bytes", outputLines, totalLines };
}

// ---------------------------------------------------------------------------
// Session file path helpers (local)
// ---------------------------------------------------------------------------

const autoresearchJsonlPath = (dir: string) => sessionFilePath(dir, "log");
const autoresearchChecksPath = (dir: string) => sessionFilePath(dir, "checks");
const autoresearchScriptPath = (dir: string) => sessionFilePath(dir, "measure");
const autoresearchConfigPath = (dir: string) => sessionFilePath(dir, "config");

// ---------------------------------------------------------------------------
// Git exec helper (replaces process.exec for git operations)
// ---------------------------------------------------------------------------

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
}

function execCommand(cmd: string, args: string[], options: { cwd: string; timeout?: number; signal?: AbortSignal }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    if (options.signal) {
      const onAbort = () => {
        if (child.pid) killTree(child.pid);
        else child.kill();
      };
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (err) => {
      resolve({ code: null, stdout, stderr: err.message, killed: false });
    });

    child.on("close", (code) => {
      resolve({ code, stdout, stderr, killed: child.killed });
    });
  });
}

// ---------------------------------------------------------------------------
// JSONL state helpers (local)
// ---------------------------------------------------------------------------

function readJsonlLines(workDir: string): string[] {
  const jsonlPath = autoresearchJsonlPath(workDir);
  if (!fs.existsSync(jsonlPath)) return [];
  return fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
}

function readLastRun(workDir: string): Record<string, unknown> | null {
  const lines = readJsonlLines(workDir);
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseJsonlEntry(lines[i]);
    if (isAutoresearchRunEntry(entry)) return entry;
  }
  return null;
}

function buildSessionSnapshot(state: ReconstructedJsonlState): { metric_name: string; metric_unit: string; direction: "lower" | "higher"; baseline_metric: number | null; best_metric: number | null; run_count: number; goal: string } {
  return {
    metric_name: state.metricName,
    metric_unit: state.metricUnit,
    direction: state.bestDirection,
    baseline_metric: findBaselineMetric(state.results, state.currentSegment),
    best_metric: findBestMetric(state.results, state.currentSegment, state.bestDirection),
    run_count: state.results.length,
    goal: state.name ?? "",
  };
}

async function fireHook(payload: HookPayload): Promise<string | null> {
  const result = await runHook(payload);
  appendHookLogEntryIfConfigured(autoresearchJsonlPath(payload.cwd), payload.event, result);
  return steerMessageFor(payload.event, result);
}

// ---------------------------------------------------------------------------
// init_experiment
// ---------------------------------------------------------------------------

export async function initExperiment(cwd: string, args: InitArgs): Promise<InitResult> {
  // Validate working directory exists
  const workDirError = validateWorkDir(cwd);
  if (workDirError) {
    throw new Error(workDirError);
  }

  const workDir = resolveWorkDir(cwd);

  // Reconstruct existing state to determine segment and reinit
  const jsonlPath = autoresearchJsonlPath(workDir);
  let state: ReconstructedJsonlState;
  let isReinit = false;
  if (fs.existsSync(jsonlPath)) {
    try {
      state = reconstructJsonlState(fs.readFileSync(jsonlPath, "utf-8"));
      isReinit = state.results.length > 0;
    } catch {
      state = {
        name: null,
        metricName: "metric",
        metricUnit: "",
        bestDirection: "lower",
        currentSegment: 0,
        results: [],
        secondaryMetrics: [],
      };
    }
  } else {
    state = {
      name: null,
      metricName: "metric",
      metricUnit: "",
      bestDirection: "lower",
      currentSegment: 0,
      results: [],
      secondaryMetrics: [],
    };
  }

  state.name = args.name;
  state.metricName = args.metric_name;
  state.metricUnit = args.metric_unit ?? "";
  if (args.direction === "lower" || args.direction === "higher") {
    state.bestDirection = args.direction;
  }
  if (isReinit) {
    state.currentSegment++;
  }

  const maxExperiments = readMaxExperiments(cwd);

  // Write config header to jsonl
  ensureParentDir(jsonlPath);
    const config = JSON.stringify({
      type: "config",
      name: state.name,
      metricName: state.metricName,
      metricUnit: state.metricUnit,
      bestDirection: state.bestDirection,
      segment: state.currentSegment,
    });
  if (fs.existsSync(jsonlPath)) {
    fs.appendFileSync(jsonlPath, config + "\n");
  } else {
    fs.writeFileSync(jsonlPath, config + "\n");
  }

  // Fire "before" hook if transitioning from inactive
  let steerMessage: string | null = null;
  if (!isReinit) {
    steerMessage = await fireHook({
      event: "before",
      cwd: workDir,
      next_run: state.results.length + 1,
      last_run: readLastRun(workDir),
      session: buildSessionSnapshot(state),
    });
  }

  const text = `Initialized autoresearch session "${state.name}" optimizing ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better).`;

  return {
    ok: true,
    jsonlPath,
    segment: state.currentSegment,
    name: state.name,
    metricName: state.metricName,
    metricUnit: state.metricUnit,
    bestDirection: state.bestDirection,
    maxExperiments,
    reinit: isReinit,
    text,
    steerMessage,
  };
}

// ---------------------------------------------------------------------------
// run_experiment
// ---------------------------------------------------------------------------

export async function runExperiment(
  cwd: string,
  args: RunArgs,
  signal?: AbortSignal,
): Promise<RunResult> {
  // Validate working directory exists
  const workDirError = validateWorkDir(cwd);
  if (workDirError) {
    throw new Error(workDirError);
  }
  const workDir = resolveWorkDir(cwd);

  // Reconstruct state to get metricName, metricUnit, and check maxExperiments
  const jsonlPath = autoresearchJsonlPath(workDir);
  let state: ReconstructedJsonlState;
  if (fs.existsSync(jsonlPath)) {
    try {
      state = reconstructJsonlState(fs.readFileSync(jsonlPath, "utf-8"));
    } catch {
      state = { name: null, metricName: "metric", metricUnit: "", bestDirection: "lower", currentSegment: 0, results: [], secondaryMetrics: [] };
    }
  } else {
    state = { name: null, metricName: "metric", metricUnit: "", bestDirection: "lower", currentSegment: 0, results: [], secondaryMetrics: [] };
  }

  // Block if max experiments limit already reached
  const maxExperiments = readMaxExperiments(cwd);
  if (maxExperiments !== null) {
    const segCount = currentResults(state.results, state.currentSegment).length;
    if (segCount >= maxExperiments) {
      throw new Error(`Maximum experiments reached (${maxExperiments}). The experiment loop is done. To continue, call init_experiment to start a new segment.`);
    }
  }

  const timeout = (args.timeout_seconds ?? 600) * 1000;

  // Guard: if the benchmark script exists, only allow running it
  const autoresearchShPath = autoresearchScriptPath(workDir);
  const benchmarkScriptRel = path.relative(workDir, autoresearchShPath) || path.basename(autoresearchShPath);
  if (fs.existsSync(autoresearchShPath) && !isAutoresearchShCommand(args.command)) {
    throw new Error(
      `${benchmarkScriptRel} exists — you must run it instead of a custom command.\n\nFound: ${autoresearchShPath}\nYour command: ${args.command}\n\nUse: run_experiment({ command: "bash ${benchmarkScriptRel}" }) or run_experiment({ command: "./${benchmarkScriptRel}" })`,
    );
  }

  const t0 = Date.now();

  // Spawn the process directly for streaming output
  const getTempFile = createTempFileAllocator();
  const { exitCode, killed: timedOut, output, tempFilePath: streamTempFile, actualTotalBytes } = await new Promise<{
    exitCode: number | null;
    killed: boolean;
    output: string;
    tempFilePath: string | undefined;
    actualTotalBytes: number;
  }>((resolve, reject) => {
    let processTimedOut = false;

    const child = spawn("bash", ["-c", args.command], {
      cwd: workDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Rolling buffer for tail truncation (keep 2x what we need)
    const chunks: Buffer[] = [];
    let chunksBytes = 0;
    const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

    // Temp file for full output when it overflows
    let tempFilePath: string | undefined;
    let tempFileStream: ReturnType<typeof fs.createWriteStream> | undefined;
    let totalBytes = 0;

    // Cache for Buffer.concat — only rebuild when chunks change
    let chunksGeneration = 0;
    let cachedGeneration = -1;
    let cachedText = "";

    function getBufferText(): string {
      if (cachedGeneration === chunksGeneration) return cachedText;
      cachedText = Buffer.concat(chunks).toString("utf-8");
      cachedGeneration = chunksGeneration;
      return cachedText;
    }

    const handleData = (data: Buffer) => {
      totalBytes += data.length;

      // Start writing to temp file once we exceed the threshold
      if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
        tempFilePath = getTempFile();
        tempFileStream = fs.createWriteStream(tempFilePath);
        for (const chunk of chunks) {
          tempFileStream.write(chunk);
        }
      }

      if (tempFileStream) {
        tempFileStream.write(data);
      }

      // Keep rolling buffer of recent data
      chunks.push(data);
      chunksBytes += data.length;

      // Evict old chunks, then trim the first surviving chunk to a line boundary
      while (chunksBytes > maxChunksBytes && chunks.length > 1) {
        const removed = chunks.shift()!;
        chunksBytes -= removed.length;
      }
      // Trim first surviving chunk to a newline boundary
      if (chunks.length > 0 && chunksBytes > maxChunksBytes) {
        const buf = chunks[0];
        const nlIdx = buf.indexOf(0x0a); // '\n'
        if (nlIdx !== -1 && nlIdx < buf.length - 1) {
          chunks[0] = buf.subarray(nlIdx + 1);
          chunksBytes -= nlIdx + 1;
        }
      }

      chunksGeneration++;
    };

    if (child.stdout) child.stdout.on("data", handleData);
    if (child.stderr) child.stderr.on("data", handleData);

    // Timeout
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeout > 0) {
      timeoutHandle = setTimeout(() => {
        processTimedOut = true;
        if (child.pid) killTree(child.pid);
      }, timeout);
    }

    // Abort signal
    const onAbort = () => {
      if (child.pid) killTree(child.pid);
      else {
        child.kill();
        child.once("spawn", () => { if (child.pid) killTree(child.pid); });
      }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (tempFileStream) tempFileStream.end();
      reject(err);
    });

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (tempFileStream) tempFileStream.end();

      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }

      const fullBuffer = Buffer.concat(chunks);
      resolve({
        exitCode: code,
        killed: processTimedOut,
        output: fullBuffer.toString("utf-8"),
        tempFilePath,
        actualTotalBytes: totalBytes,
      });
    });
  });

  const durationSeconds = (Date.now() - t0) / 1000;
  const benchmarkPassed = exitCode === 0 && !timedOut;

  // Run backpressure checks if benchmark passed and checks file exists
  let checksPass: boolean | null = null;
  let checksTimedOut = false;
  let checksOutput = "";
  let checksDuration = 0;

  const checksPath = autoresearchChecksPath(workDir);
  if (benchmarkPassed && fs.existsSync(checksPath)) {
    const checksTimeout = (args.checks_timeout_seconds ?? 300) * 1000;
    const ct0 = Date.now();
    try {
      const checksResult = await execCommand("bash", [checksPath], {
        signal,
        timeout: checksTimeout,
        cwd: workDir,
      });
      checksDuration = (Date.now() - ct0) / 1000;
      checksTimedOut = !!checksResult.killed;
      checksPass = checksResult.code === 0 && !checksResult.killed;
      checksOutput = (checksResult.stdout + "\n" + checksResult.stderr).trim();
    } catch (e) {
      checksDuration = (Date.now() - ct0) / 1000;
      checksPass = false;
      checksOutput = e instanceof Error ? e.message : String(e);
    }
  }

  const passed = benchmarkPassed && (checksPass === null || checksPass);

  // Reuse streaming temp file if it exists, otherwise create one for large output
  let fullOutputPath: string | undefined = streamTempFile;
  const totalLines = output.split("\n").length;
  if (!fullOutputPath && (actualTotalBytes > EXPERIMENT_MAX_BYTES || totalLines > EXPERIMENT_MAX_LINES)) {
    fullOutputPath = getTempFile();
    fs.writeFileSync(fullOutputPath, output);
  }

  // Wider truncation for display (details.tailOutput)
  const displayTruncation = truncateTail(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  // Parse structured METRIC lines from output
  const parsedMetricMap = parseMetricLines(output);
  const parsedMetrics = parsedMetricMap.size > 0
    ? Object.fromEntries(parsedMetricMap)
    : null;
  const parsedPrimary = parsedMetricMap.get(state.metricName) ?? null;

  const details: RunDetails = {
    command: args.command,
    exitCode,
    durationSeconds,
    passed,
    crashed: !passed,
    timedOut,
    tailOutput: displayTruncation.content,
    checksPass,
    checksTimedOut,
    checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
    checksDuration,
    parsedMetrics,
    parsedPrimary,
    metricName: state.metricName,
    metricUnit: state.metricUnit,
  };

  const text = `Run complete: ${details.command}\nExit code: ${details.exitCode}, duration: ${details.durationSeconds.toFixed(2)}s, passed: ${details.passed}. Parsed ${details.metricName}: ${details.parsedPrimary !== null ? String(details.parsedPrimary) + details.metricUnit : "none"}.`;

  return { ok: true, details, text };
}

// ---------------------------------------------------------------------------
// log_experiment
// ---------------------------------------------------------------------------

export async function logExperiment(
  cwd: string,
  args: LogArgs,
  signal?: AbortSignal,
): Promise<LogResult> {
  // Validate working directory exists
  const workDirError = validateWorkDir(cwd);
  if (workDirError) {
    throw new Error(workDirError);
  }
  const workDir = resolveWorkDir(cwd);

  const secondaryMetrics = args.metrics ?? {};

  // Reconstruct existing state from JSONL
  const jsonlPath = autoresearchJsonlPath(workDir);
  let state: ReconstructedJsonlState;
  if (fs.existsSync(jsonlPath)) {
    try {
      state = reconstructJsonlState(fs.readFileSync(jsonlPath, "utf-8"));
    } catch {
      state = { name: null, metricName: "metric", metricUnit: "", bestDirection: "lower", currentSegment: 0, results: [], secondaryMetrics: [] };
    }
  } else {
    state = { name: null, metricName: "metric", metricUnit: "", bestDirection: "lower", currentSegment: 0, results: [], secondaryMetrics: [] };
  }

  // Gate: prevent "keep" when last run's checks failed
  // (Note: in the runtime port we don't have access to lastRunChecks from a previous runExperiment
  // call because there's no persistent runtime. The caller must enforce this gate if needed.)

  // Validate secondary metrics consistency (after first experiment establishes them)
  if (state.secondaryMetrics.length > 0) {
    const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
    const providedNames = new Set(Object.keys(secondaryMetrics));

    // Check for missing metrics
    const missing = [...knownNames].filter((n) => !providedNames.has(n));
    if (missing.length > 0) {
      throw new Error(`Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`);
    }

    // Check for new metrics not yet tracked
    const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
    if (newMetrics.length > 0 && !args.force) {
      throw new Error(`New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\nExisting metrics: ${[...knownNames].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.`);
    }
  }

  // ASI: agent-supplied free-form diagnostics
  const mergedASI = (args.asi && Object.keys(args.asi).length > 0)
    ? args.asi
    : undefined;

  const experiment: ReconstructedRun & { segment: number; confidence: number | null; asi?: Record<string, unknown> } = {
    run: state.results.length + 1,
    commit: args.commit.slice(0, 7),
    metric: args.metric,
    metrics: secondaryMetrics,
    status: args.status,
    description: args.description,
    timestamp: Date.now(),
    segment: state.currentSegment,
    confidence: null,
    asi: mergedASI,
  };

  state.results.push(experiment);

  // Register any new secondary metric names
  for (const name of Object.keys(secondaryMetrics)) {
    if (!state.secondaryMetrics.find((m) => m.name === name)) {
      let unit = "";
      if (name.endsWith("µs")) unit = "µs";
      else if (name.endsWith("_ms")) unit = "ms";
      else if (name.endsWith("_s") || name.endsWith("_sec")) unit = "s";
      else if (name.endsWith("_kb")) unit = "kb";
      else if (name.endsWith("_mb")) unit = "mb";
      state.secondaryMetrics.push({ name, unit });
    }
  }

  // Baseline = first run in current segment
  const baselineMetric = findBaselineMetric(state.results, state.currentSegment);

  // Compute confidence score
  const confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
  experiment.confidence = confidence;

  // Best metric
  const bestMetric = findBestMetric(state.results, state.currentSegment, state.bestDirection);

  // Segment count
  const segmentCount = currentResults(state.results, state.currentSegment).length;
  const maxExperiments = readMaxExperiments(cwd);
  const limitReached = maxExperiments !== null && segmentCount >= maxExperiments;

  // Auto-commit only on keep
  if (args.status === "keep") {
    try {
      const resultData: Record<string, unknown> = {
        status: args.status,
        [state.metricName || "metric"]: args.metric,
        ...secondaryMetrics,
      };
      const trailerJson = JSON.stringify(resultData);
      const commitMsg = `${args.description}\n\nResult: ${trailerJson}`;

      const execOpts = { cwd: workDir, timeout: 10000 };
      const addResult = await execCommand("git", ["add", "-A"], execOpts);
      if (addResult.code !== 0) {
        const addErr = (addResult.stdout + addResult.stderr).trim();
        throw new Error(`git add failed (exit ${addResult.code}): ${addErr.slice(0, 200)}`);
      }

      const diffResult = await execCommand("git", ["diff", "--cached", "--quiet"], execOpts);
      if (diffResult.code !== 0) {
        const gitResult = await execCommand("git", ["commit", "-m", commitMsg], execOpts);
        if (gitResult.code === 0) {
          try {
            const shaResult = await execCommand("git", ["rev-parse", "--short=7", "HEAD"], { cwd: workDir, timeout: 5000 });
            const newSha = (shaResult.stdout || "").trim();
            if (newSha && newSha.length >= 7) {
              experiment.commit = newSha;
            }
          } catch {
            // Keep the original commit hash if rev-parse fails
          }
        }
      }
    } catch (e) {
      // Git errors are non-fatal for logging
    }
  }

  // Write JSONL entry
  const jsonlEntry: Record<string, unknown> = {
    run: state.results.length,
    commit: experiment.commit,
    metric: experiment.metric,
    metrics: experiment.metrics,
    status: experiment.status,
    description: experiment.description,
    timestamp: experiment.timestamp,
    segment: experiment.segment,
    confidence: experiment.confidence,
  };
  if (!mergedASI) delete jsonlEntry.asi;
  const jsonlLine = JSON.stringify(jsonlEntry);

  try {
    ensureParentDir(jsonlPath);
    fs.appendFileSync(jsonlPath, jsonlLine + "\n");
  } catch (e) {
    // Non-fatal for the result
  }

  // Revert changes on non-keep statuses
  if (args.status !== "keep") {
    try {
      const revertScript = `
        git checkout -- . ':(exclude,glob)**/${AUTO_DIR}' ':(exclude,glob)**/${AUTO_DIR}/**' ':(exclude,glob)**/autoresearch.*' ':(exclude,glob)**/autoresearch.*/**'
        git clean -fd -e '${AUTO_DIR}' -e '**/${AUTO_DIR}/**' -e 'autoresearch.*' -e '**/autoresearch.*/**' 2>/dev/null
      `;
      await execCommand("bash", ["-c", revertScript], { cwd: workDir, timeout: 10000 });
    } catch (e) {
      // Git revert errors are non-fatal
    }
  }

  // Fire after hook
  let afterSteer: string | null = null;
  try {
    afterSteer = await fireHook({
      event: "after",
      cwd: workDir,
      run_entry: jsonlEntry,
      session: buildSessionSnapshot(state),
    });
  } catch {
    // Hook errors are non-fatal
  }

  const text = `Logged experiment #${experiment.run}: ${experiment.status} — ${experiment.description}\nMetric: ${experiment.metric}${state.metricUnit}, confidence: ${confidence !== null ? confidence.toFixed(2) : "n/a"}, segment count: ${segmentCount}${limitReached ? " (limit reached)" : ""}.`;

  return {
    ok: true,
    entry: jsonlEntry,
    baselineMetric,
    bestMetric,
    confidence,
    segmentCount,
    steerMessage: afterSteer,
    text,
    limitReached,
  };
}
