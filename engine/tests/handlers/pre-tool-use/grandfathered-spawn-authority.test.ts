import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import validateAgentModel from "../../../src/handlers/pre-tool-use/validate-agent-model";
import validateAgentSkill from "../../../src/handlers/pre-tool-use/validate-agent-skill";
import { anchoredRunDirectoryFromContextPath } from "../../../src/core/grandfathered-spawn-model";

/**
 * The grandfathering rescue in `validate-agent-model`, and the anchoring that
 * makes it safe.
 *
 * The rescue exists so an engine-issued attempt-2 retry — deliberately carrying
 * a STORED binding from a profile that has since been promoted — is not vetoed
 * by today's policy table. It can only turn a would-be block into an allow, and
 * only when the engine's own issued authority for that exact request names the
 * requested model.
 *
 * Two things had no test at all: the ALLOW itself (every handler-level test was
 * block-only, so nothing proved the rescue works), and the anchoring that keeps
 * it from being a bypass. Both markers it reads — `LOOM_REQUEST_ID` and
 * `LOOM_CONTEXT_PATH` — are written by the SPAWNING AGENT, and a stored
 * authority proves only that a record is internally self-consistent, never who
 * wrote it. Without anchoring, a hand-written authority under any writable
 * directory proved an arbitrary model for a Loom-owned agent.
 */

const cleanup: string[] = [];
let repositoryRoot: string;
let priorProjectDir: string | undefined;

beforeEach(() => {
  repositoryRoot = mkdtempSync(join(tmpdir(), "loom-grandfather-repo-"));
  cleanup.push(repositoryRoot);
  priorProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = repositoryRoot;
});

afterEach(() => {
  if (priorProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = priorProjectDir;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * A stored authority as the ENGINE writes it. `comment-analyzer` resolves to
 * `focused-review` (claude: sonnet) under today's policy; this record is issued
 * under the older `mechanical` profile (claude: haiku), which is exactly the
 * promotion the rescue exists for. It is fully self-consistent — its
 * `harnessBinding` is what `lowerModelProfile("mechanical")` produces — which
 * is precisely why self-consistency alone cannot be the trust signal.
 */
const storedAuthority = (runId: string, requestId: string) => ({
  runId,
  requestId,
  slotId: "wave-slot:1:comment-analyzer",
  program: "wave-gate",
  role: "comment-analyzer",
  attempt: 2,
  modelProfile: "mechanical",
  harnessBinding: {
    pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.4-mini", thinking: "medium" },
    claude: { harness: "claude-code", model: "haiku" },
  },
  requiredSkill: null,
  contextDigest: "a".repeat(64),
  outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/wave-slot:1:comment-analyzer/attempt-2.raw" },
});

/** Write an authority into `<runDirectory>/requests/` and return its context path. */
function plantAuthority(runDirectory: string, runId: string, requestId: string): string {
  mkdirSync(join(runDirectory, "requests"), { recursive: true });
  mkdirSync(join(runDirectory, "contexts"), { recursive: true });
  writeFileSync(
    join(runDirectory, "requests", "authority.json"),
    JSON.stringify(storedAuthority(runId, requestId)),
  );
  return join(runDirectory, "contexts", `${"a".repeat(64)}.json`);
}

const spawn = (requestId: string, contextPath: string, model: string) => JSON.stringify({
  tool_name: "Agent",
  tool_input: {
    subagent_type: "loom:comment-analyzer",
    model,
    prompt: [
      "LOOM_REVIEW_CONTEXT: wave",
      `LOOM_REQUEST_ID: ${requestId}`,
      `LOOM_CONTEXT_PATH: ${contextPath}`,
      "Read the immutable context packet and emit the reviewer result.",
    ].join("\n"),
  },
});

/** A canonical, in-repository Run Directory: `.claude/reviews/<layout>/run.<id>`. */
function canonicalRunDirectory(layout = "wave-gate-runs", runId = "run.grandfather1"): string {
  const directory = join(repositoryRoot, ".claude", "reviews", layout, runId);
  mkdirSync(directory, { recursive: true });
  return directory;
}

describe("anchoredRunDirectoryFromContextPath", () => {
  it("accepts a run directory under every canonical run-layout root", () => {
    for (const layout of ["panel-runs", "review-runs", "review-and-fix-runs", "wave-gate-runs", "orchestration-runs"]) {
      const directory = canonicalRunDirectory(layout);
      const contextPath = join(directory, "contexts", "digest.json");
      expect(anchoredRunDirectoryFromContextPath(repositoryRoot, contextPath), layout).toBe(directory);
    }
  });

  it("accepts the spec-scoped panel-runs layout", () => {
    const directory = join(repositoryRoot, ".claude", "specs", "2026-08-15-feature", "panel-runs", "run.abc123");
    mkdirSync(directory, { recursive: true });
    const contextPath = join(directory, "contexts", "digest.json");
    expect(anchoredRunDirectoryFromContextPath(repositoryRoot, contextPath)).toBe(directory);
  });

  it.each([
    ["a path outside the repository", "/tmp/attacker/contexts/x.json"],
    ["a traversal escape", ".claude/reviews/wave-gate-runs/run.a/../../../../tmp/evil/contexts/x.json"],
    ["a directory that is not under .claude", "build/wave-gate-runs/run.a/contexts/x.json"],
    ["a parent that is not a run-layout root", ".claude/reviews/scratch/run.a/contexts/x.json"],
    // The run id must parse as one — the SAME `parseOrchestrationRunId` the
    // rest of the engine applies, not a stricter prefix rule invented here.
    ["a run id with an unsafe leading character", ".claude/reviews/wave-gate-runs/-run.a/contexts/x.json"],
    ["a run id with a space", ".claude/reviews/wave-gate-runs/run a/contexts/x.json"],
    ["a run directory nested below its layout root", ".claude/reviews/wave-gate-runs/deep/run.a/contexts/x.json"],
    ["a context path with no contexts/ tail", ".claude/reviews/wave-gate-runs/run.a/x.json"],
  ])("refuses %s", (_label, contextPath) => {
    expect(anchoredRunDirectoryFromContextPath(repositoryRoot, contextPath)).toBeNull();
  });
});

describe("validate-agent-model — the grandfathering rescue", () => {
  it("ALLOWS a stale model that a real, anchored engine authority issued for this request", async () => {
    const runId = "run.grandfather1";
    const requestId = "request:grandfathered-retry";
    const directory = canonicalRunDirectory("wave-gate-runs", runId);
    const contextPath = plantAuthority(directory, runId, requestId);

    // `haiku` is NOT what comment-analyzer's current profile resolves to; the
    // engine's stored attempt-2 authority is the only thing authorizing it.
    const result = await validateAgentModel(spawn(requestId, contextPath, "haiku"), []);

    expect(result.kind, JSON.stringify(result)).toBe("allow");
  });

  it("BLOCKS the identical spawn when the authority sits outside the repository", async () => {
    // The C3 regression. Same self-consistent authority record, same markers —
    // only the location differs, and location is the entire trust signal.
    const runId = "run.grandfather1";
    const requestId = "request:grandfathered-retry";
    const outside = mkdtempSync(join(tmpdir(), "loom-forged-authority-"));
    cleanup.push(outside);
    const forgedDirectory = join(outside, "wave-gate-runs", runId);
    mkdirSync(forgedDirectory, { recursive: true });
    const contextPath = plantAuthority(forgedDirectory, runId, requestId);

    const result = await validateAgentModel(spawn(requestId, contextPath, "haiku"), []);

    expect(result.kind).toBe("block");
  });

  it("BLOCKS when the authority is in-repository but not under a run-layout root", async () => {
    const runId = "run.grandfather1";
    const requestId = "request:grandfathered-retry";
    const forged = join(repositoryRoot, ".claude", "scratch", runId);
    mkdirSync(forged, { recursive: true });
    const contextPath = plantAuthority(forged, runId, requestId);

    const result = await validateAgentModel(spawn(requestId, contextPath, "haiku"), []);

    expect(result.kind).toBe("block");
  });

  it("BLOCKS when the anchored authority names a DIFFERENT request", async () => {
    const runId = "run.grandfather1";
    const directory = canonicalRunDirectory("wave-gate-runs", runId);
    const contextPath = plantAuthority(directory, runId, "request:some-other-slot");

    const result = await validateAgentModel(spawn("request:grandfathered-retry", contextPath, "haiku"), []);

    expect(result.kind).toBe("block");
  });

  it("BLOCKS a model the anchored authority did not issue", async () => {
    const runId = "run.grandfather1";
    const requestId = "request:grandfathered-retry";
    const directory = canonicalRunDirectory("wave-gate-runs", runId);
    const contextPath = plantAuthority(directory, runId, requestId);

    // The authority proves `haiku`; the spawn asks for `opus`.
    const result = await validateAgentModel(spawn(requestId, contextPath, "opus"), []);

    expect(result.kind).toBe("block");
  });

  it("BLOCKS an inherited (absent) model even with a valid anchored authority", async () => {
    // The rescue answers a MISMATCH, never a missing model: inheritance is not
    // an engine-issued binding and can never be grandfathered.
    const runId = "run.grandfather1";
    const requestId = "request:grandfathered-retry";
    const directory = canonicalRunDirectory("wave-gate-runs", runId);
    const contextPath = plantAuthority(directory, runId, requestId);

    const result = await validateAgentModel(JSON.stringify({
      tool_name: "Agent",
      tool_input: {
        subagent_type: "loom:comment-analyzer",
        prompt: `LOOM_REQUEST_ID: ${requestId}\nLOOM_CONTEXT_PATH: ${contextPath}`,
      },
    }), []);

    expect(result.kind).toBe("block");
  });

  it("ALLOWS an ordinary spawn that matches current policy, with no markers at all", async () => {
    // The plain allow path, which no handler-level test covered either: a
    // block-only suite cannot tell a working gate from one that blocks
    // everything.
    const result = await validateAgentModel(JSON.stringify({
      tool_name: "Agent",
      tool_input: { subagent_type: "loom:comment-analyzer", model: "sonnet" },
    }), []);

    expect(result.kind, JSON.stringify(result)).toBe("allow");
  });
});

describe("validate-agent-skill — review-verifier-agent", () => {
  it("allows the review-verifier-agent spawn declared by its policy", async () => {
    const result = await validateAgentSkill(JSON.stringify({
      tool_name: "Agent",
      tool_input: {
        subagent_type: "loom:review-verifier-agent",
        prompt: "LOOM_REVIEW_CONTEXT: standalone\nAdjudicate every finding through your lens.",
      },
    }), []);

    expect(result.kind, JSON.stringify(result)).toBe("allow");
  });
});
