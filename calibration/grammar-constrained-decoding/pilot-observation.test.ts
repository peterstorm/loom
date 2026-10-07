import { describe, expect, it } from "vitest";
import { classifyEmissionToolError, parseSampleObservation, sampleRetries } from "./pilot-observation";
import { ACCEPT_EMISSION, ACCEPT_EXTRACTION, firstPair, sample, type AttemptSpec } from "./pilot-test-fixtures";
import type { PilotArm } from "./pilot-vocabulary";

describe("observations", () => {
  it("classifies errored emission tool results by their real producers", () => {
    expect(classifyEmissionToolError("Validation failed for tool \"loom_emit_judge_verdict\":\n  - score: must be <= 10")).toEqual({ class: "harness-schema-validation" });
    expect(classifyEmissionToolError("invalid-schema: emission arguments do not conform")).toEqual({ class: "engine-refusal", code: "invalid-schema" });
    expect(classifyEmissionToolError("Tool not found")).toEqual({ class: "unclassified", excerpt: "Tool not found" });
  });

  it("refuses attempt sequences the request-slot budget cannot produce", () => {
    const pair = firstPair();
    const raw = (attempts: readonly AttemptSpec[]) => ({
      pairId: pair.pairId, cell: pair.cell, caseId: pair.caseId, arm: "emission-enabled", dispatchToIngestionMs: 1,
      attempts: attempts.map((spec, index) => ({
        attempt: index + 1, elapsedMs: 1, readinessMs: null, modelRequests: 1, emissionCalls: 0, toolErrors: [],
        toolAcknowledged: false, followUpTurnsAfterAck: 0, outcome: spec.outcome,
      })),
      rawArgumentObservation: "unavailable",
    });
    const rejected: AttemptSpec = { outcome: { kind: "rejected", cause: { kind: "extraction-failure", detail: "none" } } };
    expect(parseSampleObservation(raw([ACCEPT_EMISSION, ACCEPT_EMISSION])).ok).toBe(false);
    expect(parseSampleObservation(raw([rejected])).ok).toBe(false);
    expect(parseSampleObservation(raw([rejected, rejected, rejected])).ok).toBe(false);
    expect(parseSampleObservation(raw([rejected, ACCEPT_EMISSION])).ok).toBe(true);
    expect(parseSampleObservation(raw([rejected, rejected])).ok).toBe(true);
  });

  it("refuses observations whose arm, source and counters contradict each other", () => {
    const pair = firstPair();
    const attempt = (overrides: Record<string, unknown>) => ({
      attempt: 1, elapsedMs: 1, readinessMs: null, modelRequests: 1, emissionCalls: 0, toolErrors: [],
      toolAcknowledged: false, followUpTurnsAfterAck: 0, outcome: ACCEPT_EXTRACTION.outcome, ...overrides,
    });
    const parses = (arm: PilotArm, overrides: Record<string, unknown>): boolean => parseSampleObservation({
      pairId: pair.pairId, cell: pair.cell, caseId: pair.caseId, arm, dispatchToIngestionMs: 1,
      attempts: [attempt(overrides)], rawArgumentObservation: "unavailable",
    }).ok;
    const accepted = (source: string, fallbackOverRefusal: boolean) => ({ outcome: { kind: "accepted", source, fallbackOverRefusal, payloadDigest: "a".repeat(64) } });

    // The extraction-only arm is offered no emission tool and passes no readiness barrier.
    expect(parses("extraction-only", {})).toBe(true);
    expect(parses("extraction-only", { emissionCalls: 1 })).toBe(false);
    expect(parses("extraction-only", { readinessMs: 50 })).toBe(false);
    expect(parses("extraction-only", { toolErrors: [{ class: "unclassified", excerpt: "Tool not found" }] })).toBe(false);
    expect(parses("extraction-only", { toolAcknowledged: true })).toBe(false);
    expect(parses("extraction-only", accepted("emission-tool", false))).toBe(false);
    expect(parses("extraction-only", accepted("extraction", true))).toBe(false);
    expect(parses("extraction-only", { outcome: { kind: "startup-refused", reason: "barrier" } })).toBe(false);
    expect(parses("extraction-only", { outcome: { kind: "rejected", cause: { kind: "duplicate-call", calls: 2 } } })).toBe(false);
    // Only extraction selected over a refused call carries the fallback flag.
    expect(parses("emission-enabled", { ...accepted("emission-tool", false), emissionCalls: 1, readinessMs: 50 })).toBe(true);
    expect(parses("emission-enabled", { ...accepted("emission-tool", true), emissionCalls: 1 })).toBe(false);
    expect(parses("emission-enabled", { ...accepted("extraction", true), emissionCalls: 1 })).toBe(true);
    expect(parses("emission-enabled", { outcome: { kind: "startup-refused", reason: "barrier" } })).toBe(true);
  });

  it("attributes retries to separate series: provider-enforced vs unenforced vs engine-only", () => {
    const pair = firstPair();
    const observed = sample(pair, "emission-enabled", 30_000, [
      { outcome: { kind: "rejected", cause: { kind: "observation-refused", detail: "incomplete" } }, emissionCalls: 1, toolErrors: [{ class: "harness-schema-validation" }] },
      { ...ACCEPT_EMISSION, toolErrors: [{ class: "engine-refusal", code: "invalid-payload" }] },
    ]);
    const constrained = { kind: "constrained-emission", enforcedConstraints: ["enum"], evidence: "x" } as const;
    const unconstrained = { kind: "unconstrained-emission", evidence: "x" } as const;
    expect(sampleRetries(observed, constrained).map((retry) => `${retry.kind}:${retry.cause}`)).toEqual([
      "semantic-retry:provider-structural", "in-child-reprompt:provider-structural", "in-child-reprompt:engine-only-refusal",
    ]);
    expect(sampleRetries(observed, unconstrained).map((retry) => retry.cause)).toEqual([
      "unenforced-schema-violation", "unenforced-schema-violation", "engine-only-refusal",
    ]);
  });
});
