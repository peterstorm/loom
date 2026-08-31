import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseSpecCheckOutput, reconcileSpecCheck } from "../src/core/spec-check";
import { extractTestEvidence } from "../src/core/test-evidence";
import { countNewTests } from "../src/utils/git";

const passedSpecFooter = [
  "SPEC_CHECK_WAVE: 1",
  "SPEC_CHECK_CRITICAL_COUNT: 0",
  "SPEC_CHECK_HIGH_COUNT: 0",
  "SPEC_CHECK_VERDICT: PASSED",
].join("\n");

const addedTypeScriptLine = (line: string): string => [
  "diff --git a/example.test.ts b/example.test.ts",
  "--- a/example.test.ts",
  "+++ b/example.test.ts",
  "@@ -0,0 +1 @@",
  `+${line}`,
].join("\n");

describe("round-six evidence authority regressions", () => {
  it.each([
    ["omitted", ["SPEC_CHECK_WAVE: 2", "SPEC_CHECK_HIGH_COUNT: 0", "SPEC_CHECK_VERDICT: PASSED"]],
    ["malformed", ["SPEC_CHECK_WAVE: 2", "SPEC_CHECK_CRITICAL_COUNT: nope", "SPEC_CHECK_HIGH_COUNT: 0", "SPEC_CHECK_VERDICT: PASSED"]],
  ])("does not borrow an earlier spec-check count when the final footer is %s", (_label, finalFooter) => {
    const parsed = parseSpecCheckOutput(`${passedSpecFooter}\n${finalFooter.join("\n")}`);
    const resolution = reconcileSpecCheck(parsed, 2, "2026-08-31T00:00:00.000Z");

    expect(parsed.wave).toBe(2);
    expect(parsed.criticalCount).toBeNull();
    expect(resolution).toMatchObject({
      kind: "evidence-failed",
      specCheck: { verdict: "EVIDENCE_CAPTURE_FAILED", error: expect.stringContaining("SPEC_CHECK_CRITICAL_COUNT") },
    });
  });

  it("lets a summary-less later Vitest invocation supersede an earlier pass", () => {
    const evidence = extractTestEvidence([
      " RUN  v3.2.4 /repo",
      " Tests  4 passed (4)",
      " RUN  v3.2.4 /repo",
    ].join("\n"));

    expect(evidence).toEqual({ passed: false, evidence: "vitest: incomplete run: RUN  v3.2.4 /repo" });
  });

  it("lets a later no-test Maven invocation supersede an earlier incomplete tally", () => {
    const evidence = extractTestEvidence([
      "[INFO] Scanning for projects...",
      "Tests run: 4, Failures: 0, Errors: 0",
      "[INFO] Scanning for projects...",
      "BUILD SUCCESS",
    ].join("\n"));

    expect(evidence).toEqual({ passed: false, evidence: "maven: 0 tests executed" });
  });

  it("never preserves a stale runner pass after a recognized later incomplete invocation", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 10_000 }), (passed) => {
      const vitest = extractTestEvidence(
        ` RUN  v3.2.4 /repo\n Tests  ${passed} passed (${passed})\n RUN  v3.2.4 /repo`,
      );
      const maven = extractTestEvidence(
        `[INFO] Scanning for projects...\nTests run: ${passed}, Failures: 0, Errors: 0\n` +
          "[INFO] Scanning for projects...\nBUILD SUCCESS",
      );
      expect(vitest.passed).toBe(false);
      expect(maven.passed).toBe(false);
    }));
  });

  it("does not count return-annotated TypeScript methods as runner calls", () => {
    expect(countNewTests(addedTypeScriptLine("test(): void {}"))).toMatchObject({ ts: 0, total: 0 });
    expect(countNewTests(addedTypeScriptLine("test(): void;"))).toMatchObject({ ts: 0, total: 0 });
    expect(countNewTests(addedTypeScriptLine("test("))).toMatchObject({ ts: 0, total: 0 });
    expect(countNewTests(addedTypeScriptLine('test("works", () => {});'))).toMatchObject({ ts: 1, total: 1 });
  });
});
