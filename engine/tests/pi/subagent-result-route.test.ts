/**
 * The SubagentStop dispatcher's per-result routing, at its own interface: the
 * ordering invariants the shell used to hold only in comments are decided
 * here over plain facts, and each route names the exact operator line and
 * processing error it raises.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  isLoomOwnedResultAgent,
  missingResultMarkersProblem,
  missingTaskGraphNotice,
  piResultApplier,
  reservedAgentMismatch,
  resultAuthorityRejection,
  routeCapturedPiResult,
  routeEmissionStartup,
  type PiCapturedResultFacts,
} from "../../../pi/subagent-result-route";
import type { CaptureOutcome } from "../../src/orchestration/harness-capture-runtime";

const CAPTURED = { kind: "captured", receipt: {} } as unknown as CaptureOutcome;
const OUTCOMES: readonly CaptureOutcome[] = [
  CAPTURED,
  { kind: "not-an-orchestration-run" },
  { kind: "no-reservation", agentId: "pi-x" },
  { kind: "terminal-rejection", reason: "transcript-shape", message: "bad" },
  { kind: "retriable-failure", reason: "io", message: "busy" },
];
const AGENTS = ["code-reviewer", "code-implementer-agent", "spec-check-invoker", "architecture-agent", "unrelated-agent"] as const;

const facts = (overrides: Partial<PiCapturedResultFacts> = {}): PiCapturedResultFacts => ({
  agentType: "code-reviewer",
  reservedKind: "non-implementation",
  runBound: false,
  standaloneContext: false,
  resultFailed: false,
  spawnedWithoutTaskGraph: false,
  capture: { kind: "not-an-orchestration-run" },
  ...overrides,
});

const arbitraryFacts = fc.record({
  agentType: fc.constantFrom(...AGENTS),
  reservedKind: fc.constantFrom("implementation", "non-implementation", "standalone", undefined),
  runBound: fc.boolean(),
  standaloneContext: fc.boolean(),
  resultFailed: fc.boolean(),
  spawnedWithoutTaskGraph: fc.boolean(),
  capture: fc.constantFrom(...OUTCOMES),
}) as fc.Arbitrary<PiCapturedResultFacts>;

describe("reservedAgentMismatch", () => {
  it("ignores a result whose agent contradicts its slot, a processing error only under run authority", () => {
    const diagnostic = 'result 2 agent "code-reviewer" does not match reserved "spec-check-invoker"';
    for (const runBound of [false, true]) {
      expect(reservedAgentMismatch({ agentType: "code-reviewer", reservedAgentType: "spec-check-invoker", resultIndex: 1, runBound }))
        .toEqual({ stderr: `loom(pi): ${diagnostic} — evidence ignored`, processingError: runBound ? `request-bound ${diagnostic}` : null });
    }
  });

  it("passes a matching or unreserved result", () => {
    expect(reservedAgentMismatch({ agentType: "code-reviewer", reservedAgentType: "code-reviewer", resultIndex: 0, runBound: true })).toBeNull();
    expect(reservedAgentMismatch({ agentType: "code-reviewer", reservedAgentType: undefined, resultIndex: 0, runBound: true })).toBeNull();
  });
});

describe("resultAuthorityRejection", () => {
  it("rejects uncaptured and terminalises the slot with the same diagnostic", () => {
    const problem = missingResultMarkersProblem(0, "code-reviewer");
    expect(problem).toBe("request-bound result 1/code-reviewer has no request/context markers");
    const diagnostic = `request-bound result authority rejected for code-reviewer: ${problem}`;
    expect(resultAuthorityRejection("code-reviewer", problem)).toEqual({
      notice: { stderr: `loom(pi): ${diagnostic}; transcript was not captured`, processingError: diagnostic },
      captureRejection: diagnostic,
    });
  });
});

describe("routeEmissionStartup", () => {
  it("captures an ordinary result silently and an untrusted marker loudly", () => {
    expect(routeEmissionStartup({ kind: "ordinary" }, "code-reviewer", 0)).toEqual({ kind: "capture", notice: null });
    const untrusted = routeEmissionStartup({ kind: "untrusted-marker", reason: "forged" }, "code-reviewer", 3);
    const diagnostic = "untrusted emission launch outcome for code-reviewer[3]: forged";
    expect(untrusted).toEqual({
      kind: "capture",
      notice: { stderr: `loom(pi): ${diagnostic}; applying the ordinary failed-result lifecycle`, processingError: diagnostic },
    });
  });

  it("retains semantic capture authority for a proven pre-prompt refusal, never capturing it", () => {
    const route = routeEmissionStartup({
      kind: "proven-startup-refusal",
      marker: { requestId: "req-1", toolName: "loom_emit_reviewer_payload", reason: "readiness-timeout" },
    }, "code-reviewer", 0);
    expect(route.kind).toBe("retain-authority");
    expect(route.notice?.processingError).toBe(
      "Emission startup refused before the Task prompt for issued request req-1 (code-reviewer, loom_emit_reviewer_payload): " +
        "readiness-timeout. Correct the launcher/readiness infrastructure and retry this same issued request with a new subagent tool call.",
    );
    expect(route.notice?.stderr).toMatch(/ Semantic capture authority was retained\.$/);
  });
});

describe("routeCapturedPiResult", () => {
  it("never lets a standalone or run-bound result reach the TaskGraph", () => {
    fc.assert(fc.property(arbitraryFacts, (input) => {
      const route = routeCapturedPiResult(input);
      if (input.runBound || input.reservedKind === "standalone" || input.standaloneContext) {
        expect(route.kind).toBe("skip");
        if (route.kind !== "skip") return;
        // Under run authority a failed capture is a processing error, never a harmless short-circuit.
        expect(route.notice.processingError !== null).toBe(input.runBound && input.capture.kind !== "captured");
        expect(route.notice.stderr).toContain("task state untouched");
      }
    }));
  });

  it("settles only captured-or-unbound evidence of a TaskGraph-backed batch, through the agent's applier", () => {
    fc.assert(fc.property(arbitraryFacts, (input) => {
      const route = routeCapturedPiResult(input);
      const settles = !input.runBound && input.reservedKind !== "standalone" && !input.standaloneContext &&
        input.capture.kind !== "terminal-rejection" && input.capture.kind !== "retriable-failure" &&
        !input.spawnedWithoutTaskGraph;
      expect(route.kind).toBe(settles ? "settle" : "skip");
      if (route.kind === "settle") expect(route.applier).toEqual(piResultApplier(input.agentType, input.resultFailed));
    }));
  });

  it("renders each skip with its exact operator line", () => {
    expect(routeCapturedPiResult(facts({ runBound: true, capture: { kind: "terminal-rejection", reason: "r", message: "m" } })))
      .toEqual({ kind: "skip", notice: {
        stderr: "loom(pi): standalone request-bound capture failed for code-reviewer: r: m; task state untouched",
        processingError: "standalone request-bound capture failed for code-reviewer: r: m",
      } });
    expect(routeCapturedPiResult(facts({ standaloneContext: true, resultFailed: true })))
      .toEqual({ kind: "skip", notice: {
        stderr: "loom(pi): failed standalone code-reviewer result ignored — task state untouched",
        processingError: null,
      } });
    expect(routeCapturedPiResult(facts({ reservedKind: "standalone" })))
      .toEqual({ kind: "skip", notice: {
        stderr: "loom(pi): code-reviewer belongs to a standalone review run — task state untouched",
        processingError: null,
      } });
    expect(routeCapturedPiResult(facts({ capture: { kind: "retriable-failure", reason: "io", message: "busy" } })))
      .toEqual({ kind: "skip", notice: {
        stderr: "loom(pi): request-bound capture rejected for code-reviewer: io: busy; protected state unchanged",
        processingError: "request-bound capture rejected for code-reviewer: io: busy",
      } });
    expect(routeCapturedPiResult(facts({ spawnedWithoutTaskGraph: true })))
      .toEqual({ kind: "skip", notice: {
        stderr: "loom(pi): ad-hoc code-reviewer completion — no TaskGraph existed at spawn, protected state untouched",
        processingError: null,
      } });
  });
});

describe("piResultApplier and missingTaskGraphNotice", () => {
  it("settles a failed process as a failure whatever its agent", () => {
    for (const agent of AGENTS) expect(piResultApplier(agent, true)).toEqual({ kind: "failed" });
  });

  it("chooses the applier by agent kind", () => {
    expect(piResultApplier("code-implementer-agent", false)).toEqual({ kind: "implementation" });
    expect(piResultApplier("code-reviewer", false)).toEqual({ kind: "review" });
    expect(piResultApplier("spec-check-invoker", false)).toEqual({ kind: "spec-check" });
    expect(piResultApplier("architecture-agent", false)).toMatchObject({ kind: "phase" });
    expect(piResultApplier("unrelated-agent", false)).toEqual({ kind: "none" });
  });

  it("reports dropped Loom-owned evidence when the session has no TaskGraph, and ignores other agents", () => {
    for (const agent of AGENTS) {
      const reason = missingTaskGraphNotice(agent, "s-1");
      expect(reason === null).toBe(!isLoomOwnedResultAgent(agent));
    }
    expect(missingTaskGraphNotice("code-reviewer", "s-1")).toEqual({
      stderr: 'loom(pi): no task graph for session "s-1"; code-reviewer completion was NOT applied',
      processingError: 'no task graph for session "s-1"; code-reviewer completion was NOT applied',
    });
  });
});
