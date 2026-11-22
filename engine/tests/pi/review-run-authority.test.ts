/**
 * The one issued-review-request authentication both Pi shells cross —
 * spawn admission's `readPiIssuedSpawnRequest` and result capture — exercised
 * at its own seam: every refusing step names itself, in the order the
 * sequence runs (registration read → parse → program kind → classification →
 * publication). The authenticated arm needs a real published Run Directory and
 * is driven end to end by the extension suites. The marker boundary
 * (`piTaskIdentity`) and the issuing-run resolution (`piIssuingRun`) that
 * both Pi shells cross before it are pinned here too.
 */

import { rmSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticatePiIssuedReviewRequest,
  piIssuedSpawnRequestRefusal,
  piIssuingRun,
  piTaskIdentity,
} from "../../../pi/review-run-authority";
import { createRunDirectory, type RunDirHandle } from "../../src/orchestration/run-directory-handle";
import { registerSessionRunBinding, type RunLocation } from "../../src/orchestration/session-run-bindings";
import type { AgentRequestAuthority, RequestId } from "../../src/core/orchestration-contract";
import type { TaskIdentity } from "../../src/core/spawn-task-text";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { withEnvOverlaySync } from "../fixtures/env-overlay";

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

describe("piIssuedSpawnRequestRefusal (the spawn admission's rendering)", () => {
  const requestId = "req-review-run-authority-1" as RequestId;
  const refusalFor = (registration: unknown, overrides: Readonly<Record<string, unknown>> = {}) => {
    const authenticated = authenticatePiIssuedReviewRequest(handleWith({ ok: true, value: registration }), request(overrides));
    if (authenticated.kind === "authenticated") throw new Error("fixture unexpectedly authenticated");
    return piIssuedSpawnRequestRefusal(requestId, authenticated);
  };

  it("keeps the exact parser diagnostic of a claimed-but-invalid registration", () => {
    expect(refusalFor({ ...WAVE_GATE_V1, input: { wave: 0 } })).toBe(
      "request req-review-run-authority-1 has no matching registered review program: " +
        "the program registration is invalid: wave-gate input must contain exactly wave (null or a positive integer)",
    );
  });

  it("refuses a request outside any review program with the one generic refusal", () => {
    const generic = "request req-review-run-authority-1 has no matching registered review program";
    expect(refusalFor(null)).toBe(generic);
    expect(refusalFor({ schemaVersion: 1, kind: "remediation", input: { sourceRunsRoot: "roots", sourceRun: "run.x", supportPaths: [] } }))
      .toBe(generic);
  });

  it("names every other refusing step by its own message", () => {
    expect(refusalFor(WAVE_GATE_V1, { runId: "run.other" }))
      .toBe("request req-review-run-authority-1 belongs to another orchestration run");
    expect(refusalFor(WAVE_GATE_V1)).toBe("reviewer request reservations are unavailable");
    expect(piIssuedSpawnRequestRefusal(requestId, { kind: "registration-unreadable", message: "registration EACCES" }))
      .toBe("registration EACCES");
  });
});

const ISSUED_REQUEST = "request:reviewer:1";
const ISSUED_DIGEST = "a".repeat(64);
const markers = (lines: readonly string[]): string => [...lines, "Review the issued request"].join("\n");
const ITEM = "Pi spawn item 1/code-reviewer";

describe("piTaskIdentity (Pi's throw-on-refusal marker boundary)", () => {
  it("names no identity for a task that carries no markers", () => {
    expect(piTaskIdentity("Review the change", ITEM)).toBeNull();
  });

  it("returns the bound identity of canonical markers", () => {
    expect(piTaskIdentity(markers([`LOOM_REQUEST_ID: ${ISSUED_REQUEST}`, `LOOM_CONTEXT_DIGEST: ${ISSUED_DIGEST}`]), ITEM))
      .toEqual({ requestId: ISSUED_REQUEST, contextDigest: ISSUED_DIGEST });
  });

  it.each([
    [
      "two different request ids",
      [`LOOM_REQUEST_ID: ${ISSUED_REQUEST}`, "LOOM_REQUEST_ID: request:reviewer:2", `LOOM_CONTEXT_DIGEST: ${ISSUED_DIGEST}`],
      "task issuance identity is incomplete or contradictory",
    ],
    [
      "a request id without its digest",
      [`LOOM_REQUEST_ID: ${ISSUED_REQUEST}`],
      "task issuance identity is incomplete or contradictory",
    ],
    [
      "a non-canonical context digest",
      [`LOOM_REQUEST_ID: ${ISSUED_REQUEST}`, "LOOM_CONTEXT_DIGEST: NOT-A-DIGEST"],
      "task LOOM_CONTEXT_DIGEST marker is not canonical",
    ],
  ] as const)("throws, naming the item, for %s", (_name, lines, reason) => {
    expect(() => piTaskIdentity(markers(lines), ITEM))
      .toThrow(new RegExp(`^${ITEM} carries unusable authority markers: ${reason}`));
  });
});

describe("piIssuingRun (the one open-and-read of the run that issued a Pi task)", () => {
  const SESSION = "019fca39-f989-7510-8e62-50dadbcad4aa";
  const parsedIdentity = piTaskIdentity(markers([`LOOM_REQUEST_ID: ${ISSUED_REQUEST}`, `LOOM_CONTEXT_DIGEST: ${ISSUED_DIGEST}`]), ITEM);
  if (parsedIdentity === null) throw new Error("fixture identity is unbound");
  const identity: TaskIdentity = parsedIdentity;
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const tempDir = (prefix: string): string => {
    const dir = canonicalTempDir(prefix);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  /** A run that reserved the canonical reviewer request. */
  async function issuingRun(name: string): Promise<RunLocation> {
    const runsRoot = tempDir(`loom-pi-issuing-${name}-`);
    const created = createRunDirectory(runsRoot, `run.${name}`);
    if (!created.ok) throw new Error(created.error.message);
    const reserved = await created.value.reserveRequest(agentRequestAuthority(`run.${name}`));
    if (!reserved.ok) throw new Error(reserved.error.message);
    return { runsRoot, runDirectory: join(runsRoot, `run.${name}`) };
  }

  async function bindAll(subagents: string, runs: readonly RunLocation[]): Promise<void> {
    for (const run of runs) {
      const registered = await registerSessionRunBinding(subagents, SESSION, {
        runId: basename(run.runDirectory),
        ...run,
        requestIds: [ISSUED_REQUEST],
        resultDigest: null,
      }, "pi");
      if (!registered.ok) throw new Error(registered.message);
    }
  }

  const resolveIn = (subagents: string, explicit: RunLocation | null) =>
    withEnvOverlaySync({ LOOM_SUBAGENT_DIR: subagents }, () => piIssuingRun(SESSION, explicit, [identity]));

  it("refuses, instead of picking one, when two session bindings both issued the identity", async () => {
    const subagents = tempDir("loom-pi-issuing-bindings-");
    await bindAll(subagents, [await issuingRun("first"), await issuingRun("second")]);
    expect(() => resolveIn(subagents, null)).toThrow(
      `multiple Pi session run bindings contain issued request/context authority ${ISSUED_REQUEST}@${ISSUED_DIGEST}`,
    );
  });

  it("refuses when no session binding issued the identity", () => {
    expect(() => resolveIn(tempDir("loom-pi-issuing-empty-"), null)).toThrow(
      `no Pi session run binding contains issued request/context authority ${ISSUED_REQUEST}@${ISSUED_DIGEST}`,
    );
  });

  it("returns the one issuing binding with the run it opened and the requests it read", async () => {
    const subagents = tempDir("loom-pi-issuing-one-");
    const run = await issuingRun("only");
    await bindAll(subagents, [run]);
    const resolved = resolveIn(subagents, null);
    expect(resolved.binding).toMatchObject({ runId: "run.only", requestIds: [ISSUED_REQUEST], resultDigest: null });
    expect(resolved.handle.runId).toBe("run.only");
    expect(resolved.issued.map(({ requestId }) => requestId)).toEqual([ISSUED_REQUEST]);
  });

  it("opens an explicit run without reading the session's bindings, binding every request it issued", async () => {
    const run = await issuingRun("explicit");
    // A binding directory that does not exist would refuse a session read.
    const resolved = resolveIn(join(tempDir("loom-pi-issuing-unread-"), "missing", "subagents"), run);
    expect(resolved.binding).toMatchObject({ runId: "run.explicit", requestIds: [ISSUED_REQUEST], resultDigest: null });
    expect(resolved.handle.runId).toBe("run.explicit");
    expect(resolved.issued.map(({ requestId }) => requestId)).toEqual([ISSUED_REQUEST]);
  });

  it("throws when the explicit run cannot be opened", () => {
    const runsRoot = tempDir("loom-pi-issuing-absent-");
    expect(() => resolveIn(tempDir("loom-pi-issuing-unused-"), { runsRoot, runDirectory: join(runsRoot, "run.absent") }))
      .toThrow(/run directory does not exist/);
  });
});
