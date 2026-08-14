import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  engineIssuedClaudeModel,
  engineIssuedClaudeModelFromRunDir,
  loomMarkerValue,
  runDirectoryFromContextPath,
} from "../../src/core/grandfathered-spawn-model";
import { openRunDirectory } from "../../src/orchestration/run-directory-handle";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function authority(overrides: Record<string, unknown> = {}): AgentRequestAuthority {
  return {
    runId: "run.grandfather",
    requestId: "request:comment-analyzer:2",
    slotId: "slot-1",
    program: "wave-gate",
    role: "comment-analyzer",
    attempt: 2,
    // Stored PRE-promotion binding: comment-analyzer was `mechanical`/haiku
    // before it was promoted to focused-review/sonnet.
    modelProfile: "mechanical",
    harnessBinding: {
      pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.4-mini", thinking: "medium" },
      claude: { harness: "claude-code", model: "haiku" },
    },
    requiredSkill: null,
    contextDigest: "a".repeat(64),
    outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-1/attempt-2.raw" },
    ...overrides,
  } as AgentRequestAuthority;
}

describe("grandfathered-spawn-model — marker + path parsing (pure)", () => {
  it("extracts single LOOM markers and returns null when absent", () => {
    const prompt = "LOOM_REQUEST_ID: request:comment-analyzer:2\nLOOM_CONTEXT_PATH: /r/contexts/d.json\nread it";
    expect(loomMarkerValue(prompt, "REQUEST_ID")).toBe("request:comment-analyzer:2");
    expect(loomMarkerValue(prompt, "CONTEXT_PATH")).toBe("/r/contexts/d.json");
    expect(loomMarkerValue(prompt, "MISSING")).toBeNull();
    expect(loomMarkerValue("no markers here", "REQUEST_ID")).toBeNull();
  });

  it("derives the run directory from a context path, rejecting a wrong shape", () => {
    expect(runDirectoryFromContextPath("/runs/run.abc/contexts/deadbeef.json")).toBe("/runs/run.abc");
    expect(runDirectoryFromContextPath("/runs/run.abc/contexts/deadbeef.json/")).toBe("/runs/run.abc");
    expect(runDirectoryFromContextPath("/runs/run.abc/transcripts/x.raw")).toBeNull();
    expect(runDirectoryFromContextPath("contexts/x.json")).toBeNull();
    expect(runDirectoryFromContextPath("")).toBeNull();
  });

  it("matches an issued authority by request id (pure)", () => {
    const issued = [authority(), authority({ requestId: "request:code-reviewer:1", harnessBinding: {
      pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
      claude: { harness: "claude-code", model: "sonnet" },
    } })];
    expect(engineIssuedClaudeModel(issued, "request:comment-analyzer:2")).toBe("haiku");
    expect(engineIssuedClaudeModel(issued, "request:code-reviewer:1")).toBe("sonnet");
    expect(engineIssuedClaudeModel(issued, "request:unknown:1")).toBeNull();
    expect(engineIssuedClaudeModel([], "request:comment-analyzer:2")).toBeNull();
  });
});

describe("grandfathered-spawn-model — reads the engine's issued authority from the run dir", () => {
  it("returns the model the engine actually issued for the request", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-grandfather-"));
    dirs.push(runsRoot);
    const runDir = join(runsRoot, "run.grandfather");
    mkdirSync(runDir, { recursive: true });
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    expect((await opened.value.reserveRequest(authority())).ok).toBe(true);

    // The stored attempt-2 authorized haiku; the rescue must surface exactly that.
    expect(engineIssuedClaudeModelFromRunDir(runDir, "request:comment-analyzer:2")).toBe("haiku");
    // An unknown request id proves nothing.
    expect(engineIssuedClaudeModelFromRunDir(runDir, "request:comment-analyzer:1")).toBeNull();
  });

  it("returns null (fail closed) for a missing run directory", () => {
    expect(engineIssuedClaudeModelFromRunDir("/does/not/exist", "request:x:1")).toBeNull();
  });
});
