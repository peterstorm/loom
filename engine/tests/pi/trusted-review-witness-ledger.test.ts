/**
 * The Trusted Review Witness Aggregate's ordering law at its own interface:
 * a touch reports whether it made its run current, and retracting a refused
 * spawn's binding leaves the root's previous run current again — never an
 * empty run no dispatched spawn can witness. Verification is observed only
 * through which run it names: every fixture run directory is absent, so each
 * verify rejects naming the run it judged current.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createTrustedReviewWitnesses } from "../../../pi/trusted-review-witness";
import type { SessionRunBinding } from "../../src/orchestration/session-run-bindings";
import type { CaptureOutcome } from "../../src/orchestration/harness-capture-runtime";

const cwd = "/nonexistent-loom-witness-project";
const runsRoot = join(cwd, ".claude/reviews/review-and-fix-runs");
const session = "witness-session";
const run = (name: string): SessionRunBinding =>
  ({ runId: name, runsRoot, runDirectory: join(runsRoot, name), requestIds: [], resultDigest: null }) as unknown as SessionRunBinding;

const contextDigest = "c".repeat(64);
const captured = {
  kind: "captured",
  receipt: { requestId: "request:reviewer:1", slotId: "slot-1", attempt: 1, digest: "d".repeat(64), byteLength: 12 },
} as unknown as Extract<CaptureOutcome, { kind: "captured" }>;
const task = `LOOM_REQUEST_ID: request:reviewer:1\nLOOM_CONTEXT_DIGEST: ${contextDigest}\nReview the scope`;

/** The run `verify` judged current, read from its rejection. */
const currentRun = async (witnesses: ReturnType<typeof createTrustedReviewWitnesses>): Promise<string> => {
  const outcome = await witnesses.verify({ cwd, sessionId: session }).then(
    () => "accepted",
    (error: Error) => error.message,
  );
  const named = /^current witnessed Standalone Review rejected: (run\.[a-z-]+):/.exec(outcome);
  return named?.[1] ?? outcome;
};

describe("createTrustedReviewWitnesses", () => {
  it("reports a first touch as bound and a retry of the same run as already bound", () => {
    const witnesses = createTrustedReviewWitnesses();
    expect(witnesses.touch(session, run("run.first"))).toBe("bound");
    expect(witnesses.touch(session, run("run.first"))).toBe("already-bound");
  });

  it("retracting a refused spawn's run leaves the previous run current", async () => {
    const witnesses = createTrustedReviewWitnesses();
    witnesses.touch(session, run("run.earlier"));
    witnesses.touch(session, run("run.refused"));
    expect(await currentRun(witnesses)).toBe("run.refused");
    witnesses.retract(session, run("run.refused"));
    expect(await currentRun(witnesses)).toBe("run.earlier");
  });

  it("retracting the session's only run leaves nothing witnessed rather than an empty current run", async () => {
    const witnesses = createTrustedReviewWitnesses();
    witnesses.touch(session, run("run.refused"));
    witnesses.retract(session, run("run.refused"));
    await expect(witnesses.verify({ cwd, sessionId: session }))
      .rejects.toThrow(`no request-bound Loom captures were witnessed for Pi session ${session}`);
    // The retracted run can be bound afresh by a later, admitted spawn.
    expect(witnesses.touch(session, run("run.refused"))).toBe("bound");
  });

  it("retracting a root's only run collapses that root alone and leaves the session's other roots current", async () => {
    const witnesses = createTrustedReviewWitnesses();
    const otherRoot = "/nonexistent-loom-witness-other/.claude/reviews/review-and-fix-runs";
    const elsewhere = { ...run("run.elsewhere"), runsRoot: otherRoot, runDirectory: join(otherRoot, "run.elsewhere") } as SessionRunBinding;
    witnesses.touch(session, elsewhere);
    witnesses.touch(session, run("run.refused"));
    witnesses.retract(session, run("run.refused"));
    // The session survives (it still holds the other root), but this root is
    // gone rather than kept as an empty container with no current run.
    await expect(witnesses.verify({ cwd, sessionId: session }))
      .rejects.toThrow(`no request-bound Loom captures were witnessed for Pi session ${session} and root ${runsRoot}`);
    // Re-binding the collapsed root starts a fresh run order.
    expect(witnesses.touch(session, run("run.refused"))).toBe("bound");
    expect(await currentRun(witnesses)).toBe("run.refused");
  });

  it("keeps a run that has since witnessed a capture, and ignores a run it never bound", async () => {
    const witnesses = createTrustedReviewWitnesses();
    witnesses.touch(session, run("run.earlier"));
    witnesses.touch(session, run("run.witnessed"));
    witnesses.remember(session, run("run.witnessed"), "code-reviewer", task, captured);
    witnesses.retract(session, run("run.witnessed"));
    witnesses.retract(session, run("run.never-bound"));
    witnesses.retract("other-session", run("run.earlier"));
    expect(await currentRun(witnesses)).toBe("run.witnessed");
  });
});
