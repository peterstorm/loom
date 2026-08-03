/**
 * The SubagentStop handler that is the ONLY way a reviewer's findings enter the
 * task graph under Claude Code.
 *
 * Nothing executed this file before. `review-findings-parity.test.ts` asserted
 * on its SOURCE TEXT — that it contains the string `core/review-output"` and
 * three function names — which its own comment justifies for `pi/extension.ts`
 * ("needs the Pi runtime to execute") and which the directly-executable sibling
 * inherited by proximity. The cost was measured: six branches survived semantic
 * mutation with the whole suite green, including deleting the
 * `resolveAgentTranscriptPath` call, which reverts commit `0710b76` ("survive
 * the Task → Agent rename and stop failing silently"). A harness that sends no
 * `agent_transcript_path` then loses every reviewer's findings and the wave gate
 * reads a clean review that never happened.
 *
 * Every test here drives the real handler against a tmp state file and a planted
 * transcript, and asserts on the STATE it wrote plus the line it logged —
 * modelled on `store-spec-check-findings.test.ts`, which already does this for
 * the handler beside it.
 */

import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import handler from "../../../src/handlers/subagent-stop/store-reviewer-findings";
import { SUBAGENT_DIR } from "../../../src/config";

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
  status: "implemented",
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
  const dir = join(tmpdir(), `store-reviewer-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, "active_task_graph.json");
  writeFileSync(statePath, graph(tasks));

  const transcriptPath = join(dir, "transcript.jsonl");
  if (transcript !== null) {
    const lines = [
      ...(userPrompt === undefined ? [] : [{ type: "user", message: { role: "user", content: [{ type: "text", text: userPrompt }] } }]),
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
  it("leaves task state untouched for an explicitly marked standalone review", async () => {
    const f = fixture("standalone", BLOCKING, [task("T1")], "LOOM_REVIEW_CONTEXT: standalone\nReview the scope.");
    try {
      const before = readFileSync(f.statePath, "utf-8");
      const { result, stderr } = await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      expect(result).toEqual({ kind: "passthrough" });
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

  it("says so when the transcript is empty or missing", async () => {
    const f = fixture("empty", null);
    try {
      const { result, stderr } = await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      expect(result.kind).toBe("passthrough");
      expect(stderr).toContain("findings NOT stored");
      // Left `pending`, which `checkReviews` fails the gate on — the fail-closed
      // direction. A silent `passed` here is the whole failure class.
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
      const { stderr } = await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      expect(stderr).toContain("not in the task graph");
      expect(stderr).toContain("findings NOT stored");
      expect(f.state().tasks[0].review_status).toBe("pending");
    } finally {
      f.cleanup();
    }
  });

  it("warns rather than throwing out of the hook on a corrupt state file", async () => {
    const f = fixture("corrupt", BLOCKING);
    try {
      writeFileSync(f.statePath, "{ not json");
      const { result, stderr } = await run({
        session_id: f.session,
        agent_type: "code-reviewer",
        agent_transcript_path: f.transcriptPath,
      });
      expect(result.kind).toBe("passthrough");
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
    expect(result.kind).toBe("passthrough");
    expect(stderr).toContain("findings NOT stored");
  });

  it("reports invalid stdin as an error rather than parsing nothing", async () => {
    const { result } = await run_raw("{ not json");
    expect(result.kind).toBe("error");
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
