/**
 * Drive the real Claude Code findings-ingestion handler against a temporary
 * TaskGraph and planted transcript, then assert its durable state and stderr.
 */

import { describe, expect, it, vi } from "vitest";
import { mkdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import handler, {
  retainedReviewGeneration,
  unavailableReviewerResolution,
} from "../../../src/handlers/subagent-stop/store-reviewer-findings";
import { SUBAGENT_DIR } from "../../../src/config";
import { parseReviewPath } from "../../../src/core/review-packet";
import type { Task } from "../../../src/types";

const reviewPath = (raw: string) => {
  const parsed = parseReviewPath(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
};

const CLEAN = "### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 0";
const BLOCKING = [
  "Task T1 review.",
  "### Machine Summary",
  "CRITICAL_COUNT: 1",
  "ADVISORY_COUNT: 0",
  "CRITICAL: the catch block swallows the parse error",
].join("\n");

function graph(tasks: unknown[]): string {
  return JSON.stringify({
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    tasks,
    wave_gates: {},
  });
}

const task = (id: string) => ({
  id,
  description: "d",
  agent: "code-implementer-agent",
  wave: 1,
  status: "pending",
  depends_on: [],
  review_status: "pending",
});

/** A tmp state file, a session pointer to it, and a planted transcript. */
function fixture(
  name: string,
  transcript: string | null,
  tasks: unknown[] = [task("T1")],
  userPrompt?: string,
) {
  let dir = join(tmpdir(), `store-reviewer-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  // macOS tmpdir() sits behind the system /var → /private/var symlink; the
  // handler opens the state dir through the anchored primitives, so the
  // fixture root must be canonical, mirroring production's base resolution.
  dir = realpathSync.native(dir);
  const statePath = join(dir, "active_task_graph.json");
  writeFileSync(statePath, graph(tasks));

  const transcriptPath = join(dir, "transcript.jsonl");
  if (transcript !== null) {
    const inferredTask = transcript.match(/\bT\d+\b/)?.[0] ?? "T1";
    const trustedPrompt = userPrompt ?? `Review Task ${inferredTask}.`;
    const lines = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: trustedPrompt }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: transcript }] } },
    ];
    writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n"));
  }

  const session = `store-reviewer-${name}-${process.pid}-${Date.now()}`;
  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  const pointer = join(SUBAGENT_DIR, `${session}.task_graph`);
  writeFileSync(pointer, statePath);

  return {
    session,
    statePath,
    transcriptPath,
    state: () => JSON.parse(readFileSync(statePath, "utf-8")),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(pointer, { force: true });
    },
  };
}

/** Run the handler, capturing what it wrote to stderr. */
async function run(payload: Record<string, unknown>) {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const result = await handler(JSON.stringify(payload), []);
    return { result, stderr: spy.mock.calls.map((c) => String(c[0])).join("") };
  } finally {
    spy.mockRestore();
  }
}

describe("store-reviewer-findings — the Claude Code findings-ingestion shell", () => {
  it("classifies unavailable evidence for a retired generation-aware review as stale", () => {
    const retired = {
      ...task("T1"),
      review_status: "passed",
      review_generation: 2,
    } as unknown as Task;

    expect(retainedReviewGeneration({
      ...retired,
      review_generation: undefined,
      accepted_review_authority: {
        generation: 3,
        packet_id: "a".repeat(64),
        head_sha: "1".repeat(40),
        scope: [],
      },
    })).toBe(3);
    expect(retainedReviewGeneration({
      ...retired,
      review_generation: undefined,
      issued_review_packets: [{
        task_id: "T1",
        packet_id: "b".repeat(64),
        packet_path: reviewPath("packets/T1.json"),
        base_sha: "2".repeat(40),
        head_sha: "3".repeat(40),
        scope: [],
      }],
    })).toBe(0);
    expect(unavailableReviewerResolution(retired, "code-reviewer", "transcript unreadable"))
      .toEqual({
        kind: "ignored-stale",
        agent: "code-reviewer",
        message: "stale reviewer evidence ignored: transcript unreadable",
      });
  });

  it("leaves task state untouched for an explicitly marked standalone review", async () => {
    const f = fixture("standalone", BLOCKING, [task("T1")], "LOOM_REVIEW_CONTEXT: standalone\nReview the scope.");
    try {
      const before = readFileSync(f.statePath, "utf-8");
      const { result, stderr } = await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      // The same line reaches BOTH channels: stderr for a --debug/direct-call
      // reader, and systemMessage because an exit-0 hook's stderr does not
      // reach the operator at all.
      expect(result).toEqual({
        kind: "passthrough",
        systemMessage: "[loom] store-reviewer-findings: code-reviewer belongs to a standalone review run — task state untouched",
      });
      expect(readFileSync(f.statePath, "utf-8")).toBe(before);
      expect(stderr).toContain("standalone review run — task state untouched");
    } finally { f.cleanup(); }
  });

  it("does not trust a standalone marker emitted only by reviewer output", async () => {
    const f = fixture("spoofed-marker", `LOOM_REVIEW_CONTEXT: standalone\n${BLOCKING}`, [task("T1")], "Review Task T1.");
    try {
      await run({ session_id: f.session, agent_type: "code-reviewer", agent_transcript_path: f.transcriptPath });
      expect(f.state().tasks[0].review_status).toBe("blocked");
    } finally { f.cleanup(); }
  });

  it("fails attribution instead of skipping a malformed first prompt line", async () => {
    const f = fixture("malformed-prompt", BLOCKING);
    try {
      writeFileSync(f.transcriptPath, [
        "{truncated",
        JSON.stringify({ type: "user", message: { role: "user", content: "Review Task T1." } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: BLOCKING } }),
      ].join("\n"));
      const before = readFileSync(f.statePath, "utf-8");

      const { result, stderr } = await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });

      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringContaining("malformed transcript JSON before the first user prompt"),
      });
      expect(readFileSync(f.statePath, "utf-8")).toBe(before);
      expect(stderr).toContain("review evidence cannot be attributed");
    } finally { f.cleanup(); }
  });

  it("stores a reviewer's critical and blocks the task", async () => {
    const f = fixture("stores", BLOCKING);
    try {
      const { result, stderr } = await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      expect(result.kind).toBe("passthrough");

      const stored = f.state().tasks[0];
      expect(stored.review_status).toBe("blocked");
      expect(stored.critical_findings).toEqual(["the catch block swallows the parse error"]);
      // Identity is minted here, not by the panel: the brief is built from it.
      expect(stored.findings).toHaveLength(1);
      expect(stored.findings[0].id).toBe("code-reviewer-1");
      expect(stored.findings[0].agent).toBe("code-reviewer");
      expect(stderr).toContain("blocked");
    } finally {
      f.cleanup();
    }
  });

  it("resolves review generation against the task held under the update lock", async () => {
    const f = fixture("locked-authority", BLOCKING);
    const { StateManager } = await import("../../../src/state-manager");
    const originalUpdate = StateManager.prototype.update;
    const update = vi.spyOn(StateManager.prototype, "update").mockImplementation(async function (
      this: typeof StateManager.prototype,
      updater,
    ) {
      const current = JSON.parse(readFileSync(f.statePath, "utf-8"));
      current.tasks[0].review_generation = 1;
      writeFileSync(f.statePath, JSON.stringify(current));
      return originalUpdate.call(this, updater);
    });
    try {
      const { stderr } = await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      const stored = f.state().tasks[0];
      expect(stored.review_generation).toBe(1);
      expect(stored.review_status).toBe("pending");
      expect(stored.findings).toBeUndefined();
      expect(stderr).toContain("evidence ignored");
    } finally {
      update.mockRestore();
      f.cleanup();
    }
  });

  it("fails evidence capture when a located finding is outside the Review Packet scope", async () => {
    const claim = "outside-scope blocker";
    const located = [
      "Task T1 review.",
      "### Machine Summary",
      "CRITICAL_COUNT: 1",
      "ADVISORY_COUNT: 0",
      `CRITICAL: ${claim}`,
      "```findings",
      JSON.stringify([{ severity: "critical", file: "src/outside.ts", line: 9, claim }]),
      "```",
    ].join("\n");
    const f = fixture("scope", located, [{ ...task("T1"), file_list: ["src/inside.ts"] }]);
    try {
      const { stderr } = await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      const stored = f.state().tasks[0];
      expect(stored.review_status).toBe("evidence_capture_failed");
      expect(stored.findings).toBeUndefined();
      expect(stored.review_error).toContain("src/outside.ts");
      expect(stderr).toContain("outside Review Packet scope");
    } finally {
      f.cleanup();
    }
  });

  it("records a clean review as passed", async () => {
    const f = fixture("clean", `Task T1 review.\n${CLEAN}`);
    try {
      await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      expect(f.state().tasks[0].review_status).toBe("passed");
    } finally {
      f.cleanup();
    }
  });

  it("accepts a NAMESPACED agent type — `loom:code-reviewer` is a reviewer", async () => {
    // The prefix strip at the top of the handler. Without it a plugin-namespaced
    // agent falls through `isReviewAgent` as a non-reviewer, and the findings are
    // dropped by the one early return that deliberately does not log.
    const f = fixture("namespaced", BLOCKING);
    try {
      await run({
        session_id: f.session,
        agent_type: "loom:code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      expect(f.state().tasks[0].review_status).toBe("blocked");
    } finally {
      f.cleanup();
    }
  });

  it("leaves a non-reviewer's completion completely alone", async () => {
    const f = fixture("passthrough", BLOCKING);
    try {
      const { result, stderr } = await run({
        session_id: f.session,
        agent_type: "code-implementer-agent",
        agent_transcript_path: f.transcriptPath,
      });
      expect(result.kind).toBe("passthrough");
      expect(f.state().tasks[0].review_status).toBe("pending");
      expect(stderr, "the one silent return: nothing was discarded").toBe("");
    } finally {
      f.cleanup();
    }
  });

  it("resolves the transcript path itself when the payload omits it", async () => {
    // THE regression from commit 0710b76. Deleting `resolveAgentTranscriptPath`
    // leaves `input.agent_transcript_path ?? ""`, which reads as an empty
    // transcript — findings silently not stored, and the gate later counts the
    // task as reviewed-clean. Proven by asserting the handler reaches a state
    // write with only `agent_id` to go on.
    const f = fixture("resolved", BLOCKING);
    const spy = vi.spyOn(
      await import("../../../src/utils/agent-transcript-path"),
      "resolveAgentTranscriptPath",
    );
    try {
      spy.mockReturnValue(f.transcriptPath);
      await run({ session_id: f.session, agent_type: "code-reviewer", agent_id: "sub-1" });
      expect(spy, "the handler must resolve, not read the payload").toHaveBeenCalled();
      expect(f.state().tasks[0].review_status).toBe("blocked");
    } finally {
      spy.mockRestore();
      f.cleanup();
    }
  });

  it("marks an attributable empty reviewer transcript as evidence capture failed", async () => {
    const f = fixture("empty", "review stopped before Machine Summary", [{ ...task("T1"), review_status: "passed" }]);
    try {
      const { result, stderr } = await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      expect(result.kind).toBe("passthrough");
      expect(stderr).toContain("marking evidence_capture_failed");
      expect(f.state().tasks[0]).toMatchObject({
        review_status: "evidence_capture_failed",
        review_evidence_failures: ["code-reviewer"],
      });
      expect(f.state().tasks[0].review_error).toContain("CRITICAL_COUNT marker not found");
    } finally {
      f.cleanup();
    }
  });

  it("fails loudly when a missing transcript cannot supply a trusted task binding", async () => {
    const f = fixture("missing", null);
    try {
      const { result, stderr } = await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      expect(result.kind).toBe("error");
      expect(stderr).toContain("review evidence cannot be attributed");
      expect(f.state().tasks[0].review_status).toBe("pending");
    } finally {
      f.cleanup();
    }
  });

  it("surfaces a trusted prompt that carries no task identity", async () => {
    const f = fixture("missing-task-binding", BLOCKING, [task("T1")], "Review this implementation.");
    try {
      const { result, stderr } = await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      expect(result.kind).toBe("error");
      expect(stderr).toContain("no extractable task ID");
      expect(stderr).toContain("review evidence cannot be attributed");
      expect(f.state().tasks[0].review_status).toBe("pending");
    } finally {
      f.cleanup();
    }
  });

  it("says so when the reviewer names a task the graph does not have", async () => {
    // `extractTaskId` falls back to any standalone `T\d+`, so a reviewer quoting
    // an unrelated id used to have its criticals dropped by a no-op `tasks.map`
    // while stderr reported them recorded.
    const f = fixture("unknown-task", BLOCKING.replace(/T1/g, "T97"));
    try {
      const { result, stderr } = await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("not in the task graph") });
      expect(stderr).toContain("not in the task graph");
      expect(stderr).toContain("findings NOT stored");
      expect(f.state().tasks[0].review_status).toBe("pending");
    } finally {
      f.cleanup();
    }
  });

  // The task is looked up BEFORE the transcript read and applied INSIDE the
  // locked update, so a graph rewritten in between leaves the `tasks.map` a
  // no-op. Without the `taskFound` check the handler would then log a stored
  // resolution for a task that is no longer in the graph. The window is real:
  // the transcript read is the await that separates the two.
  it("warns instead of reporting stored findings when the task vanishes mid-update", async () => {
    // No CRITICAL_COUNT marker, so the reader retries and the window between
    // the pre-update lookup and the locked update is deterministic.
    const f = fixture("toctou", "Reviewing Task T1 — still writing the summary.");
    try {
      const pending = run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      // T1 is gone by the time the locked update runs.
      writeFileSync(f.statePath, graph([task("T2")]));

      const { result, stderr } = await pending;

      // Discarded reviewer output is a failed evidence command, never exit 0.
      expect(result).toEqual({
        kind: "error",
        message: "[loom] store-reviewer-findings: code-reviewer review task T1 disappeared before evidence application — findings NOT stored",
      });
      expect(stderr).toContain("disappeared before evidence application");
      expect(stderr).toContain("findings NOT stored");
      // Nothing was invented for the surviving task either.
      expect(f.state().tasks).toHaveLength(1);
      expect(f.state().tasks[0].id).toBe("T2");
      expect(f.state().tasks[0].review_status).toBe("pending");
    } finally {
      f.cleanup();
    }
  });

  it("fails the hook after warning that a corrupt state file lost reviewer evidence", async () => {
    const f = fixture("corrupt", BLOCKING);
    try {
      writeFileSync(f.statePath, "{ not json");
      const { result, stderr } = await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      expect(result.kind).toBe("error");
      if (result.kind === "error") expect(result.message).toContain("findings NOT stored");
      expect(stderr).toContain("cannot load task graph");
      expect(stderr).toContain("findings NOT stored");
    } finally {
      f.cleanup();
    }
  });

  it("says so when no task graph exists for the session", async () => {
    const { result, stderr } = await run({
      session_id: `no-such-session-${process.pid}-${Date.now()}`,
      agent_type: "code-reviewer",
      agent_transcript_path: "/nonexistent/transcript.jsonl",
    });
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/no task graph.*code-reviewer findings NOT stored/),
    });
    expect(stderr).toContain("findings NOT stored");
  });

  it("fails closed when a reviewer carries malformed session authority", async () => {
    const { result, stderr } = await run({
      session_id: "../../invalid reviewer session",
      agent_type: "code-reviewer",
      agent_transcript_path: "/nonexistent/transcript.jsonl",
    });
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/no task graph.*findings NOT stored/),
    });
    expect(stderr).toContain("invalid session id");
    expect(stderr).toContain("findings NOT stored");
  });

  it("reports invalid stdin as an error rather than parsing nothing", async () => {
    const { result } = await run_raw("{ not json");
    expect(result.kind).toBe("error");
  });

  it.each(["null", "42", "[]", JSON.stringify({ session_id: "session-1", agent_type: 7 })])(
    "rejects valid JSON outside the SubagentStop domain: %s",
    async (stdin) => {
      const { result } = await run_raw(stdin);
      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringMatching(/invalid SubagentStop input.*findings NOT stored/),
      });
    },
  );

  it("rejects an unnameable direct result instead of treating it as a non-reviewer", async () => {
    const { result } = await run_raw(JSON.stringify({ session_id: "session-1" }));
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/Agent identity is unavailable.*findings NOT stored/),
    });
  });

  it("does not touch the other tasks in the wave", async () => {
    const f = fixture("siblings", BLOCKING, [task("T1"), task("T2")]);
    try {
      await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      const [one, two] = f.state().tasks;
      expect(one.review_status).toBe("blocked");
      expect(two.review_status).toBe("pending");
      expect(two.findings).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

  it("accumulates a second reviewer's findings rather than overwriting the first's", async () => {
    const f = fixture("accumulate", BLOCKING);
    try {
      await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      writeFileSync(
        f.transcriptPath,
        [
          JSON.stringify({
            type: "user",
            message: { role: "user", content: [{ type: "text", text: "Review Task T1." }] },
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                {
                  type: "text",
                  text: [
                    "Task T1 review.",
                    "### Machine Summary",
                    "CRITICAL_COUNT: 1",
                    "ADVISORY_COUNT: 0",
                    "CRITICAL: the retry loop never terminates",
                  ].join("\n"),
                },
              ],
            },
          }),
        ].join("\n"),
      );
      await run({
        session_id: f.session,
        agent_type: "silent-failure-hunter",
        agent_transcript_path: f.transcriptPath,
      });

      const stored = f.state().tasks[0];
      expect(stored.critical_findings).toHaveLength(2);
      // Attribution survives accumulation — the panel adjudicates per finding.
      expect(stored.findings.map((f: { id: string }) => f.id)).toEqual([
        "code-reviewer-1",
        "silent-failure-hunter-1",
      ]);
    } finally {
      f.cleanup();
    }
  });
});

/** Raw-stdin variant, for the JSON-parse failure that has no payload object. */
async function run_raw(stdin: string) {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    return { result: await handler(stdin, []) };
  } finally {
    spy.mockRestore();
  }
}
