import { describe, expect, it } from "vitest";
import {
  capturedSpecCheck,
  parseSpecCheckOutput,
  parseStoredSpecCheck,
  reconcileSpecCheck,
  settleSpecCheck,
  specCheckNeedsReapplication,
} from "../../src/core/spec-check";
import {
  manualOverrideFloor,
  parseSettledFloor,
  unprojectedFloor,
  type ManualOverrideFloor,
  type SettledFloor,
} from "../../src/core/requirement-coverage";
import { epochSettledFloor } from "../../src/core/wave-review-authority";
import type { CapturedSpecCheck, SpecCheck, TaskGraph, WaveReviewEpochAuthority } from "../../src/types";


/**
 * The settled floor lives inside `reconcileSpecCheck` and not beside one
 * harness's call to it.
 *
 * Round 1 put it in the Claude SubagentStop handler alone. The Pi transport and
 * the Wave Gate façade both committed the Agent's own count unchecked — and the
 * façade's resume loop re-applied the transcript through its unfloored path
 * precisely BECAUSE a floor violation writes `EVIDENCE_CAPTURE_FAILED`, which
 * is the one verdict that loop refuses to skip. The enforcement erased itself.
 *
 * These tests pin the rule at the one function all three call, so a harness
 * cannot be clean while another is evidence-failed.
 */

const transcript = (critical: number | readonly string[]): string => {
  const findings = typeof critical === "number"
    ? Array.from({ length: critical }, (_, at) => `finding ${at + 1}`)
    : critical;
  return [
    "SPEC_CHECK_WAVE: 5",
    ...findings.map((finding) => `CRITICAL: ${finding}`),
    `SPEC_CHECK_CRITICAL_COUNT: ${findings.length}`,
    "SPEC_CHECK_HIGH_COUNT: 0",
    `SPEC_CHECK_VERDICT: ${findings.length === 0 ? "PASSED" : "BLOCKED"}`,
  ].join("\n");
};

const legacySettled = (count: number): SettledFloor => {
  const parsed = parseSettledFloor({ kind: "settled", count });
  if (parsed === null) throw new Error("fixture settled floor must parse");
  return parsed;
};
const currentSettled = (...criticalFindings: readonly string[]): SettledFloor => {
  const parsed = parseSettledFloor({
    kind: "settled",
    count: criticalFindings.length,
    criticalFindings,
  });
  if (parsed === null) throw new Error("fixture current floor must parse");
  return parsed;
};
const unprojected = (): SettledFloor => unprojectedFloor("test fixture: no projection");

const reconcile = (critical: number, floor: SettledFloor) =>
  reconcileSpecCheck(parseSpecCheckOutput(transcript(critical)), 5, "2026-09-05T00:00:00.000Z", floor);

describe("reconcileSpecCheck enforces the settled floor", () => {
  it("fails evidence capture when the report falls below the floor", () => {
    const result = reconcile(0, legacySettled(3));
    expect(result.kind).toBe("evidence-failed");
    expect(result.specCheck.verdict).toBe("EVIDENCE_CAPTURE_FAILED");
    expect(String((result.specCheck as { error?: string }).error))
      .toContain("the Requirement Coverage Projection settled 3");
    // Typed, not inferred from the prose: the resume loop branches on this.
    expect(result.specCheck).toMatchObject({ cause: "settled-floor" });
  });

  it("admits a legacy report that meets the count floor, and one that exceeds it", () => {
    expect(reconcile(3, legacySettled(3)).kind).toBe("captured");
    // Historical packets carried count authority only.
    expect(reconcile(7, legacySettled(3)).kind).toBe("captured");
  });

  it("requires every current settled Finding identity while admitting additions", () => {
    const floor = currentSettled("required one", "required two");
    expect(reconcileSpecCheck(
      parseSpecCheckOutput(transcript(["required one", "required two"])), 5, "now", floor,
    ).kind).toBe("captured");
    expect(reconcileSpecCheck(
      parseSpecCheckOutput(transcript(["unrelated one", "unrelated two"])), 5, "now", floor,
    )).toMatchObject({
      kind: "evidence-failed",
      specCheck: { cause: "settled-floor", error: expect.stringContaining("required one") },
    });
  });

  it("fails closed when no projection was available", () => {
    const result = reconcile(0, unprojected());
    expect(result.kind).toBe("evidence-failed");
    expect(result.specCheck).toMatchObject({ cause: "projection-unavailable" });
    expect(String((result.specCheck as { error?: string }).error)).toContain("test fixture: no projection");
  });

  it("admits only separately authorized manual override settlement without a floor", () => {
    expect(reconcileSpecCheck(
      parseSpecCheckOutput(transcript(0)),
      5,
      "2026-09-05T00:00:00.000Z",
      manualOverrideFloor("operator supplied an attributable override"),
    ).kind).toBe("captured");
  });


  it("takes no default floor, so every settlement path must name one", () => {
    // The defect this pins: the floor argument used to default to `null`, so
    // a settlement path that never passed one silently settled unfloored --
    // and three of the four paths did exactly that. Making the parameter
    // required is what made `tsc` name them all. A reintroduced default would
    // erase that, and `Function.length` stops at the first defaulted parameter.
    expect(reconcileSpecCheck.length).toBe(4);
  });

  it("reports a malformed footer as malformed, not as a floor violation", () => {
    // Ordering matters: a transcript missing its markers must not be reported
    // as having under-counted against a floor it never reached.
    const malformed = reconcileSpecCheck(
      parseSpecCheckOutput("SPEC_CHECK_WAVE: 5\nSPEC_CHECK_HIGH_COUNT: 0"), 5, "2026-09-05T00:00:00.000Z", legacySettled(3),
    );
    expect(malformed.kind).toBe("evidence-failed");
    expect(String((malformed.specCheck as { error?: string }).error)).toContain("SPEC_CHECK_CRITICAL_COUNT marker");
    // And it stays re-applyable: a malformed capture is exactly the crash
    // window the resume loop recovers, unlike a decided floor refusal.
    expect(malformed.specCheck).toMatchObject({ cause: "transcript" });
  });
});

describe("epochSettledFloor reads back the authority the Agent was shown", () => {
  const epoch = (floor?: SettledFloor): WaveReviewEpochAuthority => ({
    runId: "run.floor" as WaveReviewEpochAuthority["runId"],
    wave: 5,
    batchEpoch: "a".repeat(64) as WaveReviewEpochAuthority["batchEpoch"],
    ...(floor === undefined ? {} : { settledSpecCheckFloor: floor }),
  });

  it("returns a historical count-only floor as an explicit legacy variant", () => {
    expect(epochSettledFloor(epoch(legacySettled(4)))).toEqual({ kind: "legacy-settled", count: 4 });
  });

  it("returns current identity-bearing authority verbatim", () => {
    expect(epochSettledFloor(epoch(currentSettled("required")))).toEqual({
      kind: "settled",
      count: 1,
      criticalFindings: ["required"],
    });
  });

  it("states why an absent epoch carries no floor, rather than settling zero", () => {
    // A zero floor and no floor are behaviourally identical for a report of
    // zero, but only one of them can be read back and explained afterwards.
    const floor = epochSettledFloor(undefined);
    expect(floor.kind).toBe("unprojected");
    if (floor.kind !== "unprojected") return;
    expect(floor.reason).toContain("not packet-correlated");
  });

  it("states why an epoch predating the field carries no floor", () => {
    const floor = epochSettledFloor(epoch());
    expect(floor.kind).toBe("unprojected");
    if (floor.kind !== "unprojected") return;
    expect(floor.reason).toContain("predates recorded Requirement Coverage floor authority");
  });
});

describe("a settled-floor refusal survives the resume loop", () => {
  const failed = (cause: "transcript" | "settled-floor" | "projection-unavailable"): SpecCheck =>
    ({ wave: 5, run_at: "now", verdict: "EVIDENCE_CAPTURE_FAILED", error: "refused", cause });

  it("does not re-apply a decided floor refusal", () => {
    // The defect this closes: the resume loop re-applies a durable capture
    // exactly when the recorded verdict is EVIDENCE_CAPTURE_FAILED - which is
    // what a floor violation writes - so a resume overwrote the refusal with a
    // fresh reconciliation and left no record it had ever happened.
    expect(specCheckNeedsReapplication(failed("settled-floor"), 5)).toBe(false);
  });

  it("still re-applies a transcript failure, which is what the loop exists for", () => {
    expect(specCheckNeedsReapplication(failed("transcript"), 5)).toBe(true);
  });

  it("does not re-apply a decided projection-unavailable refusal", () => {
    expect(specCheckNeedsReapplication(failed("projection-unavailable"), 5)).toBe(false);
  });

  it("re-applies when nothing is recorded, or when what is recorded is another Wave's", () => {
    expect(specCheckNeedsReapplication(undefined, 5)).toBe(true);
    expect(specCheckNeedsReapplication(failed("settled-floor"), 6)).toBe(true);
  });

  it("leaves a successfully captured verdict alone", () => {
    expect(specCheckNeedsReapplication(
      capturedSpecCheck({ wave: 5, runAt: "now", criticalFindings: [] }), 5,
    )).toBe(false);
  });
});

describe("a persisted evidence failure carries its cause across a reload", () => {
  const stored = (overrides: Record<string, unknown>) => parseStoredSpecCheck({
    wave: 5, run_at: "now", verdict: "EVIDENCE_CAPTURE_FAILED", error: "refused", ...overrides,
  });

  it.each(["transcript", "settled-floor", "projection-unavailable"] as const)("round-trips the %s cause", (cause) => {
    const parsed = stored({ cause });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({ verdict: "EVIDENCE_CAPTURE_FAILED", cause });
    expect(Object.isFrozen(parsed.value)).toBe(true);
  });

  it("reads a record written before the cause existed as a transcript failure", () => {
    // Every failure written before the floor existed WAS a transcript failure,
    // so the historical shape has exactly one meaning - and the parse boundary
    // is where it becomes total, not a `?.` at each reader.
    const parsed = stored({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({ cause: "transcript" });
  });

  it("refuses an unrecognized cause rather than degrading it to transcript", () => {
    // Degrading would silently make a decided refusal re-applyable again, which
    // is exactly the erasure the typed cause exists to stop.
    const parsed = stored({ cause: "waived" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("spec_check.cause");
  });

  it("refuses a cause on a record that captured successfully", () => {
    const parsed = parseStoredSpecCheck({
      wave: 5, run_at: "now", verdict: "PASSED",
      critical_count: 0, high_count: 0,
      critical_findings: [], high_findings: [], medium_findings: [],
      cause: "transcript",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("must be absent when evidence capture succeeded");
  });

  it.each([1e100, Number.MAX_SAFE_INTEGER + 1])("refuses unsafe captured count %s", (criticalCount) => {
    const parsed = parseStoredSpecCheck({
      wave: 5, run_at: "now", verdict: "BLOCKED",
      critical_count: criticalCount, high_count: 0,
      critical_findings: [], high_findings: [], medium_findings: [],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toContain("safe integer");
  });

  it("migrates persisted UNKNOWN into retryable evidence failure", () => {
    const parsed = parseStoredSpecCheck({
      wave: 5,
      run_at: "now",
      verdict: "UNKNOWN",
      critical_count: 0,
      high_count: 0,
      critical_findings: [],
      high_findings: [],
      medium_findings: [],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      verdict: "EVIDENCE_CAPTURE_FAILED",
      cause: "transcript",
      error: expect.stringContaining("UNKNOWN"),
    });
    expect(specCheckNeedsReapplication(parsed.value, 5)).toBe(true);
  });

  it("round-trips attributable manual override provenance", () => {
    const resolution = reconcileSpecCheck(
      parseSpecCheckOutput(transcript(0)),
      5,
      "now",
      manualOverrideFloor("accepted false-positive waiver"),
    );
    expect(resolution).toMatchObject({
      kind: "captured",
      specCheck: { evidence_source: { kind: "manual-override", reason: "accepted false-positive waiver" } },
    });
    const parsed = parseStoredSpecCheck(resolution.specCheck);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(resolution.specCheck);
  });
});

describe("settleSpecCheck aggregate command", () => {
  const state = (): TaskGraph => ({
    current_phase: "execute",
    current_wave: 5,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [],
    wave_gates: {
      "5": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: true },
    },
    spec_check: capturedSpecCheck({
      wave: 5,
      runAt: "before",
      criticalFindings: ["old blocker"],
    }),
  });

  it("changes captured evidence and its derived Wave block atomically", () => {
    const settlement = settleSpecCheck(state(), {
      kind: "registered-transcript",
      parsed: parseSpecCheckOutput(transcript(0)),
      wave: 5,
      runAt: "now",
      floor: legacySettled(0),
    });
    expect(settlement.state.spec_check).toEqual(settlement.specCheck);
    expect(settlement.specCheck).toMatchObject({ verdict: "PASSED", critical_count: 0 });
    expect(settlement.state.wave_gates["5"]?.blocked).toBe(false);
  });

  it("applies capture failure through the same atomic transition", () => {
    const settlement = settleSpecCheck(state(), {
      kind: "capture-failure",
      wave: 5,
      runAt: "now",
      error: "transport lost transcript",
    });
    expect(settlement.specCheck).toMatchObject({
      verdict: "EVIDENCE_CAPTURE_FAILED",
      cause: "transcript",
      error: "transport lost transcript",
    });
    expect(settlement.state.wave_gates["5"]?.blocked).toBe(false);
  });

  it("deeply freezes captured and failed evidence exposed by the aggregate", () => {
    const captured = settleSpecCheck(state(), {
      kind: "manual-transcript",
      parsed: parseSpecCheckOutput(transcript(0)),
      wave: 5,
      runAt: "now",
      authority: manualOverrideFloor("operator override"),
    });
    expect(captured.kind).toBe("applied");
    expect(Object.isFrozen(captured.specCheck)).toBe(true);
    if (captured.specCheck.verdict !== "EVIDENCE_CAPTURE_FAILED") {
      expect(Object.isFrozen(captured.specCheck.critical_findings)).toBe(true);
      expect(Object.isFrozen(captured.specCheck.high_findings)).toBe(true);
      expect(Object.isFrozen(captured.specCheck.medium_findings)).toBe(true);
      expect(Object.isFrozen(captured.specCheck.evidence_source)).toBe(true);
    }
    const failed = settleSpecCheck(state(), {
      kind: "capture-failure",
      wave: 5,
      runAt: "now",
      error: "transport lost transcript",
    });
    expect(Object.isFrozen(failed.specCheck)).toBe(true);
  });

  it("preserves the aggregate when manual evidence is malformed", () => {
    const original = state();
    const settlement = settleSpecCheck(original, {
      kind: "manual-transcript",
      parsed: parseSpecCheckOutput("SPEC_CHECK_WAVE: 5"),
      wave: 5,
      runAt: "now",
      authority: manualOverrideFloor("operator override"),
    });
    expect(settlement.kind).toBe("manual-evidence-refused");
    expect(settlement.state).toBe(original);
  });
});

describe("transcript authority invariants", () => {
  it.each([
    ["missing", "SPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED"],
    ["wrong", "SPEC_CHECK_WAVE: 6\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED"],
  ])("rejects a %s Wave marker", (_label, raw) => {
    expect(reconcileSpecCheck(parseSpecCheckOutput(raw), 5, "now", legacySettled(0))).toMatchObject({
      kind: "evidence-failed",
      specCheck: { cause: "transcript", error: expect.stringContaining("SPEC_CHECK_WAVE") },
    });
  });

  it.each([
    ["PASSED", 1],
    ["BLOCKED", 0],
  ] as const)("rejects verdict %s with %i critical findings", (verdict, count) => {
    const parsed = parseSpecCheckOutput([
      "SPEC_CHECK_WAVE: 5",
      ...(count === 0 ? [] : ["CRITICAL: finding"]),
      `SPEC_CHECK_CRITICAL_COUNT: ${count}`,
      "SPEC_CHECK_HIGH_COUNT: 0",
      `SPEC_CHECK_VERDICT: ${verdict}`,
    ].join("\n"));
    expect(reconcileSpecCheck(parsed, 5, "now", legacySettled(0))).toMatchObject({
      kind: "evidence-failed",
      specCheck: { error: expect.stringContaining("SPEC_CHECK_VERDICT must be") },
    });
  });

  it("requires captured evidence to come from a smart constructor", () => {
    if (Date.now() < 0) {
      // @ts-expect-error direct structural construction lacks nominal parser provenance.
      const forged: CapturedSpecCheck = {
        wave: 5, run_at: "now", verdict: "PASSED", critical_count: 0, high_count: 0,
        critical_findings: [], high_findings: [], medium_findings: [],
      };
      expect(forged.verdict).toBe("PASSED");
    }
    expect(capturedSpecCheck({ wave: 5, runAt: "now", criticalFindings: [] }))
      .toMatchObject({ verdict: "PASSED", critical_count: 0 });
  });

  it("rejects blank authority reasons at construction", () => {
    expect(() => unprojectedFloor("  ")).toThrow("non-empty reason");
    expect(() => manualOverrideFloor("\n")).toThrow("non-empty reason");
  });

  it("does not let an ordinary object literal forge manual authority", () => {
    // @ts-expect-error the private unique-symbol witness is minted only by manualOverrideFloor
    const forged: ManualOverrideFloor = { kind: "manual-override", reason: "invented" };
    expect(forged.kind).toBe("manual-override");
  });

  it("derives a current floor's count from its findings, so a disagreeing count is unrepresentable", () => {
    // @ts-expect-error the current-floor witness is minted only from criticalFindings
    const forged: SettledFloor = { kind: "settled", count: 3, criticalFindings: [] };
    expect(forged.kind).toBe("settled");
    expect(parseSettledFloor({ kind: "settled", count: 1, criticalFindings: ["one", "two"] })).toBeNull();
    const parsed = parseSettledFloor({ kind: "settled", count: 2, criticalFindings: ["one", "two"] });
    expect(parsed).toEqual({ kind: "settled", count: 2, criticalFindings: ["one", "two"] });
    // The persisted wire shape is unchanged: count stays an enumerable field.
    expect(JSON.parse(JSON.stringify(parsed))).toEqual({ kind: "settled", count: 2, criticalFindings: ["one", "two"] });
  });

  it.each([1e100, Number.MAX_SAFE_INTEGER + 1])("refuses unsafe persisted floor count %s", (count) => {
    expect(parseSettledFloor({ kind: "settled", count })).toBeNull();
  });

  it("rejects duplicate persisted settled Finding identities", () => {
    expect(parseSettledFloor({
      kind: "settled",
      count: 2,
      criticalFindings: ["required", "required"],
    })).toBeNull();
  });

  it("compares identities as a multiset even when typed authority is forged", () => {
    const forged = {
      kind: "settled",
      count: 2,
      criticalFindings: ["required", "required"],
    } as unknown as SettledFloor;
    expect(reconcileSpecCheck(
      parseSpecCheckOutput(transcript(["required", "replacement"])), 5, "now", forged,
    )).toMatchObject({
      kind: "evidence-failed",
      specCheck: { cause: "settled-floor", error: expect.stringContaining("required") },
    });
  });

  it.each([
    { kind: "settled", count: 1, criticalFinding: ["misspelled"] },
    { kind: "settled", count: 1, forged: true },
    { kind: "settled", count: 1, criticalFindings: ["required"], forged: true },
    { kind: "legacy-settled", count: 1, forged: true },
    { kind: "unprojected", reason: "missing", forged: true },
  ])("refuses ambiguous or surplus persisted floor fields: %j", (floor) => {
    expect(parseSettledFloor(floor)).toBeNull();
  });
});
