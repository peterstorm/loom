import { describe, expect, it } from "vitest";
import { parseSpecCheckOutput, reconcileSpecCheck } from "../../src/core/spec-check";

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

const transcript = (critical: number): string => [
  "SPEC_CHECK_WAVE: 5",
  ...Array.from({ length: critical }, (_, at) => `CRITICAL: finding ${at + 1}`),
  `SPEC_CHECK_CRITICAL_COUNT: ${critical}`,
  "SPEC_CHECK_HIGH_COUNT: 0",
  `SPEC_CHECK_VERDICT: ${critical === 0 ? "PASSED" : "BLOCKED"}`,
].join("\n");

const reconcile = (critical: number, floor: number | null) =>
  reconcileSpecCheck(parseSpecCheckOutput(transcript(critical)), 5, "2026-09-05T00:00:00.000Z", floor);

describe("reconcileSpecCheck enforces the settled floor", () => {
  it("fails evidence capture when the report falls below the floor", () => {
    const result = reconcile(0, 3);
    expect(result.kind).toBe("evidence-failed");
    expect(result.specCheck.verdict).toBe("EVIDENCE_CAPTURE_FAILED");
    expect(String((result.specCheck as { error?: string }).error))
      .toContain("the Requirement Coverage Projection settled 3");
  });

  it("admits a report that meets the floor, and one that exceeds it", () => {
    expect(reconcile(3, 3).kind).toBe("captured");
    // A floor, never an equality: the Agent adds its own findings.
    expect(reconcile(7, 3).kind).toBe("captured");
  });

  it("imposes no floor when no projection was available", () => {
    // `null` is the Unprojected path — a real state, and not a pass: the
    // command requires the Agent to say so in its summary.
    expect(reconcile(0, null).kind).toBe("captured");
  });

  it("defaults to no floor, so an un-updated caller cannot silently gain one", () => {
    const withoutArgument = reconcileSpecCheck(
      parseSpecCheckOutput(transcript(0)), 5, "2026-09-05T00:00:00.000Z",
    );
    expect(withoutArgument.kind).toBe("captured");
  });

  it("reports a malformed footer as malformed, not as a floor violation", () => {
    // Ordering matters: a transcript missing its markers must not be reported
    // as having under-counted against a floor it never reached.
    const malformed = reconcileSpecCheck(
      parseSpecCheckOutput("SPEC_CHECK_WAVE: 5\nSPEC_CHECK_HIGH_COUNT: 0"), 5, "2026-09-05T00:00:00.000Z", 3,
    );
    expect(malformed.kind).toBe("evidence-failed");
    expect(String((malformed.specCheck as { error?: string }).error)).toContain("SPEC_CHECK_CRITICAL_COUNT marker");
  });
});

describe("every settlement path floors through reconcileSpecCheck", () => {
  const sources = [
    "src/handlers/subagent-stop/store-spec-check-findings.ts",
    "src/handlers/helpers/programs/wave-gate.ts",
    "../pi/subagent-result.ts",
  ] as const;

  it("passes a settled floor at every reconcileSpecCheck call site that commits spec_check", async () => {
    // The round-2 defect in one assertion: the floor existed at ONE of these
    // three. A call with only three arguments takes the `null` default and
    // silently settles unfloored, which is exactly how the Pi transport and the
    // Wave Gate façade shipped without the enforcement the command promises.
    const { readFileSync } = await import("node:fs");
    for (const source of sources) {
      const text = readFileSync(new URL(`../../${source}`, import.meta.url), "utf8");
      const calls = [...text.matchAll(/reconcileSpecCheck\(([\s\S]*?)\);/gu)].map(([, args]) => args);
      expect(calls.length, `${source} must call reconcileSpecCheck`).toBeGreaterThan(0);
      for (const args of calls) {
        // A call that reconciles the EMPTY transcript is not settling an Agent's
        // report at all — it synthesizes an evidence failure for a durable
        // capture rejection, and fails on the missing marker long before any
        // floor could apply. Every OTHER call settles a real transcript and
        // must carry the floor.
        if (/parseSpecCheckOutput\(""\)/u.test(args)) continue;
        expect(args, ` calls reconcileSpecCheck on a real transcript without a settled floor`)
          .toContain("settledSpecCheckFloor");
      }
    }
  });
});
