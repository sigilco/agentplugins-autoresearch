/**
 * Confidence scoring and metric analysis for autoresearch experiments.
 *
 * Pure functions operating on reconstructed run data — no side effects.
 */

import type { ReconstructedRun, ReconstructedMetricDef } from "./jsonl.ts";

// ---------------------------------------------------------------------------
// Metric line parsing
// ---------------------------------------------------------------------------

/** Prefix for structured metric output lines: `METRIC name=value` */
const METRIC_LINE_PREFIX = "METRIC";

/** Metric names that could cause prototype pollution if used as object keys */
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Parse structured METRIC lines from command output.
 * Format: METRIC name=value (one per line)
 * Example:
 *   METRIC total_µs=15200
 *   METRIC compile_µs=4200
 *
 * Names must be word chars, dots, or µ (rejects `=` and other specials).
 * Values must be finite numbers (rejects Infinity, NaN, hex, etc.).
 * Duplicate names: last occurrence wins (allows scripts to refine values).
 * Returns a Map preserving insertion order of first occurrence per key.
 */
export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = new RegExp(
    `^${METRIC_LINE_PREFIX}(?::\\s*|\\s+)([\\w.µ]+)(?:\\s*=\\s*|\\s+)(\\S+)\\s*$`,
    "gm",
  );
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      metrics.set(name, value);
    }
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

export function isBetter(
  value: number,
  current: number,
  direction: "lower" | "higher"
): boolean {
  return direction === "lower" ? value < current : value > current;
}

/** Compute the median of a numeric array (returns 0 for empty arrays) */
export function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

/**
 * Compute confidence score for the best improvement vs. session noise floor.
 *
 * Uses Median Absolute Deviation (MAD) of all metric values in the current
 * segment as a robust noise estimator. Returns `|best_delta| / MAD`, where
 * best_delta is the improvement of the best kept metric over baseline.
 *
 * Returns null when there are fewer than 3 data points (insufficient data)
 * or when MAD is 0 (all values identical — no measurable noise).
 */
export function computeConfidence(
  runs: ReconstructedRun[],
  segment: number,
  direction: "lower" | "higher"
): number | null {
  const cur = currentResults(runs, segment).filter((r) => r.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((r) => r.metric);
  const median = sortedMedian(values);
  const deviations = values.map((v) => Math.abs(v - median));
  const mad = sortedMedian(deviations);

  if (mad === 0) return null;

  const baseline = findBaselineMetric(runs, segment);
  if (baseline === null) return null;

  // Find best kept metric in current segment
  let bestKept: number | null = null;
  for (const r of cur) {
    if (r.status === "keep" && r.metric > 0) {
      if (bestKept === null || isBetter(r.metric, bestKept, direction)) {
        bestKept = r.metric;
      }
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  const delta = Math.abs(bestKept - baseline);
  return delta / mad;
}

/** Get results in the current segment only */
export function currentResults(runs: ReconstructedRun[], segment: number): ReconstructedRun[] {
  return runs.filter((r) => r.segment === segment);
}

/** Baseline = first experiment in current segment */
export function findBaselineMetric(runs: ReconstructedRun[], segment: number): number | null {
  const cur = currentResults(runs, segment);
  return cur.length > 0 ? cur[0].metric : null;
}

/** Best = optimal metric across kept experiments in current segment (min for lower, max for higher) */
export function findBestMetric(
  runs: ReconstructedRun[],
  segment: number,
  direction: "lower" | "higher",
): number | null {
  const kept = currentResults(runs, segment)
    .filter((r) => r.status === "keep")
    .map((r) => r.metric);
  if (kept.length === 0) return null;
  return direction === "lower" ? Math.min(...kept) : Math.max(...kept);
}

/**
 * Find secondary metric baselines from the first experiment in current segment.
 * For metrics that didn't exist at baseline time, falls back to the first
 * occurrence of that metric in the current segment.
 */
export function findBaselineSecondary(
  runs: ReconstructedRun[],
  segment: number,
  knownMetrics?: ReconstructedMetricDef[]
): Record<string, number> {
  const cur = currentResults(runs, segment);
  const base: Record<string, number> = cur.length > 0
    ? { ...(cur[0].metrics ?? {}) }
    : {};

  // Fill in any known metrics missing from baseline with their first occurrence
  if (knownMetrics) {
    for (const sm of knownMetrics) {
      if (base[sm.name] === undefined) {
        for (const r of cur) {
          const val = (r.metrics ?? {})[sm.name];
          if (val !== undefined) {
            base[sm.name] = val;
            break;
          }
        }
      }
    }
  }

  return base;
}
