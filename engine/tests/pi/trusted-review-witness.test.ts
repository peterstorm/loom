/**
 * The Trusted Review Witness Aggregate (`pi/trusted-review-witness.ts`) at its
 * own injected seam — one isolated aggregate per test, real (empty) Run
 * Directories, no extension wiring.
 *
 * Which run the aggregate holds CURRENT for a root is observed through
 * `verify`: a Run Directory with no registered program is rejected with a
 * message naming that run's id, so the rejection says exactly which run was
 * verified. The accepted-replay arm (and the retirement of older witnesses
 * after acceptance) needs a fully published Standalone Review and is driven
 * end to end by `engine/tests/pi-extension-review-events.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { createTrustedReviewWitnesses } from "../../../pi/trusted-review-witness";
import { createRunDirectory } from "../../src/orchestration/run-directory-handle";
import type { SessionRunBinding } from "../../src/orchestration/session-run-bindings";
import type { CaptureOutcome } from "../../src/orchestration/harness-capture-runtime";

const SESSION = "witness-session";
const CONTEXT_DIGEST = "c".repeat(64);

describe("the Trusted Review Witness Aggregate", () => {
  let root: string;

  beforeEach(() => {
    root = canonicalTempDir("loom-trusted-review-witness-");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A project cwd and its Standalone Review runs root. */
  const project = (name: string): Readonly<{ cwd: string; runsRoot: string }> => {
    const cwd = join(root, name);
    const runsRoot = join(cwd, ".claude", "reviews", "review-and-fix-runs");
    mkdirSync(runsRoot, { recursive: true });
    return { cwd, runsRoot };
  };

  /** One real, registered-but-programless Run Directory, bound as Pi would. */
  const runBinding = (runsRoot: string, runId: string): SessionRunBinding => {
    const created = createRunDirectory(runsRoot, runId);
    if (!created.ok) throw new Error(created.error.message);
    return Object.freeze({ ...created.value.identity, requestIds: Object.freeze([]), resultDigest: null });
  };

  const rejectionOf = (runId: string): string =>
    `current witnessed Standalone Review rejected: ${runId}: registered program is missing`;

  const captured = (digest: string): Extract<CaptureOutcome, { kind: "captured" }> => ({
    kind: "captured",
    receipt: {
      schemaVersion: 1,
      kind: "capture-receipt",
      harness: "pi",
      requestId: "req-witness-1",
      slotId: "slot-witness-1",
      attempt: 1,
      nativeId: "native-witness-1",
      byteLength: 7,
      digest,
    },
  }) as unknown as Extract<CaptureOutcome, { kind: "captured" }>;

  const markedTask = (contextDigest: string): string =>
    `Review the change\nLOOM_REQUEST_ID: req-witness-1\nLOOM_CONTEXT_DIGEST: ${contextDigest}\n`;

  it("refuses verification when the session witnessed nothing", async () => {
    const witnesses = createTrustedReviewWitnesses();
    await expect(witnesses.verify({ cwd: project("p").cwd, sessionId: SESSION }))
      .rejects.toThrow(`no request-bound Loom captures were witnessed for Pi session ${SESSION}`);
  });

  it("refuses verification for a root the session never touched", async () => {
    const witnesses = createTrustedReviewWitnesses();
    const touched = project("touched");
    const other = project("other");
    witnesses.touch(SESSION, runBinding(touched.runsRoot, "run.a"));
    await expect(witnesses.verify({ cwd: other.cwd, sessionId: SESSION }))
      .rejects.toThrow(`no request-bound Loom captures were witnessed for Pi session ${SESSION} and root ${other.runsRoot}`);
  });

  it("keeps first-touch order stable across retries: the latest NEW run is current", async () => {
    const witnesses = createTrustedReviewWitnesses();
    const { cwd, runsRoot } = project("p");
    const first = runBinding(runsRoot, "run.a");
    const second = runBinding(runsRoot, "run.b");
    witnesses.touch(SESSION, first);
    witnesses.touch(SESSION, second);
    // A retry of the older run re-binds it without reordering it.
    witnesses.touch(SESSION, first);
    await expect(witnesses.verify({ cwd, sessionId: SESSION })).rejects.toThrow(rejectionOf("run.b"));
  });

  it("never falls back to an older run when the current one is rejected", async () => {
    const witnesses = createTrustedReviewWitnesses();
    const { cwd, runsRoot } = project("p");
    witnesses.touch(SESSION, runBinding(runsRoot, "run.a"));
    witnesses.touch(SESSION, runBinding(runsRoot, "run.b"));
    await expect(witnesses.verify({ cwd, sessionId: SESSION })).rejects.toThrow(rejectionOf("run.b"));
    // The rejection retired nothing and promoted nothing: run.b is still current.
    await expect(witnesses.verify({ cwd, sessionId: SESSION })).rejects.toThrow(rejectionOf("run.b"));
  });

  it("enriches a witnessed run without reordering it", async () => {
    const witnesses = createTrustedReviewWitnesses();
    const { cwd, runsRoot } = project("p");
    const first = runBinding(runsRoot, "run.a");
    witnesses.touch(SESSION, first);
    witnesses.touch(SESSION, runBinding(runsRoot, "run.b"));
    witnesses.remember(SESSION, first, "code-reviewer", markedTask(CONTEXT_DIGEST), captured("d".repeat(64)));
    await expect(witnesses.verify({ cwd, sessionId: SESSION })).rejects.toThrow(rejectionOf("run.b"));
  });

  it("refuses an older authority when the root changes while verification is in flight", async () => {
    const witnesses = createTrustedReviewWitnesses();
    const { cwd, runsRoot } = project("p");
    witnesses.touch(SESSION, runBinding(runsRoot, "run.a"));
    const verification = witnesses.verify({ cwd, sessionId: SESSION });
    witnesses.touch(SESSION, runBinding(runsRoot, "run.b"));
    await expect(verification)
      .rejects.toThrow("current witnessed Standalone Review changed during verification; no older authority accepted");
  });

  it("forgets every root of the session it retires, and only that session", async () => {
    const witnesses = createTrustedReviewWitnesses();
    const first = project("first");
    const second = project("second");
    witnesses.touch(SESSION, runBinding(first.runsRoot, "run.a"));
    witnesses.touch(SESSION, runBinding(second.runsRoot, "run.b"));
    witnesses.touch("other-session", runBinding(first.runsRoot, "run.c"));
    witnesses.forget(SESSION);
    for (const { cwd } of [first, second]) {
      await expect(witnesses.verify({ cwd, sessionId: SESSION }))
        .rejects.toThrow(`no request-bound Loom captures were witnessed for Pi session ${SESSION}`);
    }
    await expect(witnesses.verify({ cwd: first.cwd, sessionId: "other-session" })).rejects.toThrow(rejectionOf("run.c"));
  });

  it("isolates one aggregate instance from another", async () => {
    const witnessing = createTrustedReviewWitnesses();
    const fresh = createTrustedReviewWitnesses();
    const { cwd, runsRoot } = project("p");
    witnessing.touch(SESSION, runBinding(runsRoot, "run.a"));
    await expect(fresh.verify({ cwd, sessionId: SESSION }))
      .rejects.toThrow(`no request-bound Loom captures were witnessed for Pi session ${SESSION}`);
  });

  describe("remember", () => {
    it("refuses a capture whose task lacks its exact request markers", () => {
      const witnesses = createTrustedReviewWitnesses();
      const binding = runBinding(project("p").runsRoot, "run.a");
      expect(() => witnesses.remember(SESSION, binding, "code-reviewer", "Review the change", captured("d".repeat(64))))
        .toThrow("captured request req-witness-1 is missing its exact task authority markers");
      const otherRequest = "LOOM_REQUEST_ID: req-other\nLOOM_CONTEXT_DIGEST: " + CONTEXT_DIGEST;
      expect(() => witnesses.remember(SESSION, binding, "code-reviewer", otherRequest, captured("d".repeat(64))))
        .toThrow("captured request req-witness-1 is missing its exact task authority markers");
    });

    it("refuses an invalid context marker or receipt digest, and records nothing", async () => {
      const witnesses = createTrustedReviewWitnesses();
      const { cwd, runsRoot } = project("p");
      const binding = runBinding(runsRoot, "run.a");
      expect(() => witnesses.remember(SESSION, binding, "code-reviewer", markedTask("not-a-digest"), captured("d".repeat(64))))
        .toThrow("captured request req-witness-1 carries an invalid context marker");
      expect(() => witnesses.remember(SESSION, binding, "code-reviewer", markedTask(CONTEXT_DIGEST), captured("not-a-digest")))
        .toThrow("captured request req-witness-1 carries an invalid receipt digest");
      await expect(witnesses.verify({ cwd, sessionId: SESSION }))
        .rejects.toThrow(`no request-bound Loom captures were witnessed for Pi session ${SESSION}`);
    });

    it("binds an untouched run as current on its first witness", async () => {
      const witnesses = createTrustedReviewWitnesses();
      const { cwd, runsRoot } = project("p");
      witnesses.touch(SESSION, runBinding(runsRoot, "run.a"));
      witnesses.remember(SESSION, runBinding(runsRoot, "run.b"), "code-reviewer", markedTask(CONTEXT_DIGEST), captured("d".repeat(64)));
      await expect(witnesses.verify({ cwd, sessionId: SESSION })).rejects.toThrow(rejectionOf("run.b"));
    });
  });
});
