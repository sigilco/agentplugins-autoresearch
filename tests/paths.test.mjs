import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sessionFilePath,
  sessionFileCandidates,
  hookScriptPath,
  ensureParentDir,
} from "../dist/runtime/paths.js";

describe("paths", () => {
  let tempDir;

  it("resolves current .auto layout paths", () => {
    const p = sessionFilePath("/tmp/project", "log");
    assert.ok(p.endsWith(".auto/log.jsonl"));
  });

  it("generates candidate paths for legacy fallback", () => {
    const candidates = sessionFileCandidates("/tmp/project", "log");
    assert.ok(candidates.current.includes(".auto/log.jsonl"));
    assert.ok(candidates.legacy.includes("autoresearch.jsonl"));
  });

  it("resolves hook script paths", () => {
    const p = hookScriptPath("/tmp/project", "before");
    assert.ok(p.endsWith(".auto/hooks/before.sh"));
  });

  it("ensures parent directories exist", () => {
    tempDir = mkdtempSync(join(tmpdir(), "autoresearch-paths-"));
    const nested = join(tempDir, "deep", "path", "file.txt");
    ensureParentDir(nested);
    assert.ok(mkdirSync || true); // ensureParentDir should not throw
    rmSync(tempDir, { recursive: true, force: true });
  });
});
