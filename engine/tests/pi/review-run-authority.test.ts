/**
 * The one issued-review-request authentication both Pi shells cross —
 * spawn admission's `readPiIssuedSpawnRequest` and result capture — exercised
 * at its own seam: every refusing step names itself, in the order the
 * sequence runs (registration read → parse → program kind → classification →
 * publication). The authenticated arm needs a real published Run Directory and
 * is driven end to end by the extension suites.
 */

import { describe, expect, it } from "vitest";
import { authenticatePiIssuedReviewRequest } from "../../../pi/review-run-authority";
import type { RunDirHandle } from "../../src/orchestration/run-directory-handle";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";

const RUN_ID = "run.review-run-authority";
const WAVE_GATE_V1 = Object.freeze({
  schemaVersion: 1,
  kind: "wave-gate",
  input: { wave: 1 },
  taskIds: ["T1"],
  authorityDigest: "d".repeat(64),
});

/** A Run Directory adapter holding only what the sequence reads before
 *  publication: its run id, its registration, and its reservations. */
const handleWith = (registration: Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; message: string }>) =>
  ({
    runId: RUN_ID,
    runDirectory: "/nonexistent/run-directory",
    readProgramRegistration: () => registration.ok
      ? { ok: true, value: registration.value }
      : { ok: false, error: { message: registration.message } },
    readIssuedRequests: () => ({ ok: false, error: { message: "reservations unreadable" } }),
  }) as unknown as RunDirHandle;

const request = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  runId: RUN_ID,
  requestId: "req-review-run-authority-1",
  contextDigest: "c".repeat(64),
  program: "wave-gate",
  role: "code-reviewer",
  ...overrides,
}) as unknown as AgentRequestAuthority;

describe("authenticatePiIssuedReviewRequest", () => {
  it("names an unreadable registration with the read's own message", () => {
    expect(authenticatePiIssuedReviewRequest(handleWith({ ok: false, message: "registration EACCES" }), request()))
      .toEqual({ kind: "registration-unreadable", message: "registration EACCES" });
  });

  it("keeps a claimed-but-invalid registration's exact parser diagnostic", () => {
    expect(authenticatePiIssuedReviewRequest(handleWith({ ok: true, value: { ...WAVE_GATE_V1, input: { wave: 0 } } }), request()))
      .toEqual({
        kind: "registration-invalid",
        message: "wave-gate input must contain exactly wave (null or a positive integer)",
      });
  });

  it("returns an unclaimed registration verbatim, absence included", () => {
    expect(authenticatePiIssuedReviewRequest(handleWith({ ok: true, value: null }), request()))
      .toEqual({ kind: "unclaimed-program", registration: null });
    const architecture = { schemaVersion: 1, kind: "architecture" };
    expect(authenticatePiIssuedReviewRequest(handleWith({ ok: true, value: architecture }), request()))
      .toEqual({ kind: "unclaimed-program", registration: architecture });
  });

  it("refuses a registered program that is not a review program before classifying", () => {
    const remediation = {
      schemaVersion: 1,
      kind: "remediation",
      input: { sourceRunsRoot: "roots", sourceRun: "run.x", supportPaths: [] },
    };
    expect(authenticatePiIssuedReviewRequest(handleWith({ ok: true, value: remediation }), request()))
      .toEqual({ kind: "other-program" });
  });

  it("refuses a request the registered review program does not issue, before any publication read", () => {
    expect(authenticatePiIssuedReviewRequest(handleWith({ ok: true, value: WAVE_GATE_V1 }), request({ runId: "run.other" })))
      .toEqual({ kind: "unclassified", message: "request req-review-run-authority-1 belongs to another orchestration run" });
    expect(authenticatePiIssuedReviewRequest(handleWith({ ok: true, value: WAVE_GATE_V1 }), request({ program: "standalone-review" })))
      .toEqual({ kind: "unclassified", message: "request req-review-run-authority-1 has no matching registered review program" });
  });

  it("requires the request's immutable publication once it classifies", () => {
    expect(authenticatePiIssuedReviewRequest(handleWith({ ok: true, value: WAVE_GATE_V1 }), request()))
      .toEqual({ kind: "publication-unavailable", message: "reviewer request reservations are unavailable" });
  });
});
