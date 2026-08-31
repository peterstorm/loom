import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { resolveTestEvidence } from "../../../src/core/implementation-evidence";
import { analyzeNewTests } from "../../../src/handlers/helpers/task-local-completion";
import { extractTestEvidence } from "../../../src/core/test-evidence";
import { judgeTestRun } from "../../../src/machine";
import type { Evidence } from "../../../src/machine";
import { reportSummary } from "../../machine/report-summary";

/**
 * Wrap added lines in the patch shape Git emits. New-test evidence is
 * path-bound, so an unattributed `+line` proves nothing.
 */
const patch = (path: string, ...lines: string[]): string => [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -0,0 +1 @@",
  ...lines,
].join("\n");

describe("extractTestEvidence — property tests", () => {
  it("random strings without test keywords → passed: false", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }).filter(
          (s) =>
            !s.includes("BUILD SUCCESS") &&
            !/\d+ passing/.test(s) &&
            !/Tests?\s+\d+ passed/.test(s) &&
            !/\d+ passed/.test(s),
        ),
        (output) => {
          expect(extractTestEvidence(output).passed).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("valid Maven output always detected", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), (n) => {
        const output = `BUILD SUCCESS\nTests run: ${n}, Failures: 0, Errors: 0`;
        const result = extractTestEvidence(output);
        expect(result.passed).toBe(true);
        expect(result.evidence).toContain("maven");
      }),
    );
  });

  it("Maven with any failures → passed: false", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 50 }),
        (total, failures) => {
          const output = `BUILD SUCCESS\nTests run: ${total}, Failures: ${failures}, Errors: 0`;
          expect(extractTestEvidence(output).passed).toBe(false);
        },
      ),
    );
  });

  it("valid Mocha output always detected", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (n) => {
        const output = `  ${n} passing (${n}ms)`;
        const result = extractTestEvidence(output);
        expect(result.passed).toBe(true);
        expect(result.evidence).toContain("node");
      }),
    );
  });

  it("a zero-test tally is never a pass for any supported runner", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "  0 passing (3ms)",
          "Tests  0 passed (1)",
          "===== 0 passed in 0.5s =====",
          "test result: ok. 0 passed; 0 failed; 0 ignored",
          "\n0 pass\n",
          "BUILD SUCCESS\nTests run: 0, Failures: 0, Errors: 0",
        ),
        (output) => {
          const result = extractTestEvidence(output);
          expect(result.passed).toBe(false);
          // Distinct from "no runner output at all": the tally is named.
          expect(result.evidence).toContain("0 tests executed");
        },
      ),
    );
  });

  it("the transcript tally path agrees with the report path on zero tests", () => {
    // Both paths judge the same run shape. Before this rule they disagreed:
    // `0 passing` read as success while `judgeTestRun` reported a failure.
    const reportRun = judgeTestRun(0, reportSummary(0, 0));
    expect(reportRun.verdict).toBe("trusted-fail");
    expect(extractTestEvidence("  0 passing (3ms)").passed).toBe(false);
  });

  it("Mocha with failures → passed: false", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: 100 }),
        (passing, failing) => {
          const output = `  ${passing} passing\n  ${failing} failing`;
          expect(extractTestEvidence(output).passed).toBe(false);
        },
      ),
    );
  });

  it("valid Vitest output always detected", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (n) => {
        const output = `Tests  ${n} passed (${n})`;
        const result = extractTestEvidence(output);
        expect(result.passed).toBe(true);
        expect(result.evidence).toContain("vitest");
      }),
    );
  });

  it("every mixed Vitest summary with a non-zero failure count fails", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 0, max: 500 }),
        (failed, passed) => {
          const total = failed + passed;
          const output = `Tests  ${failed} failed | ${passed} passed (${total})`;
          const result = extractTestEvidence(output);
          expect(result.passed).toBe(false);
          expect(result.evidence).toBe(`vitest: ${output}`);
        },
      ),
    );
  });

  it("valid pytest output always detected", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (n) => {
        const output = `===== ${n} passed in 0.5s =====`;
        const result = extractTestEvidence(output);
        expect(result.passed).toBe(true);
        expect(result.evidence).toContain("pytest");
      }),
    );
  });
});

describe("analyzeNewTests — property tests", () => {
  it("more +@Test lines → count never decreases", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        (base, extra) => {
          const lines = (n: number): string[] =>
            Array.from({ length: n }, () => "+    @Test\n+    assertThat(x).isTrue();");
          const baseDiff = patch("ExampleTest.java", ...lines(base));
          const moreDiff = patch("ExampleTest.java", ...lines(base + extra));

          const baseResult = analyzeNewTests(baseDiff, undefined);
          const moreResult = analyzeNewTests(moreDiff, undefined);

          // Both should detect tests
          expect(baseResult.written).toBe(true);
          expect(moreResult.written).toBe(true);
        },
      ),
    );
  });

  it("removed lines (-@Test) are never counted as new tests", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (n) => {
        const diff = patch(
          "ExampleTest.java",
          ...Array.from({ length: n }, () => "-    @Test\n-    assertThat(x).isTrue();"),
        );
        const result = analyzeNewTests(diff, undefined);
        expect(result.written).toBe(false);
      }),
    );
  });

  it("evidence-shaped lines with no Git path boundary are never accepted", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (n) => {
        const diff = Array.from(
          { length: n },
          () => "+    @Test\n+    assertThat(x).isTrue();",
        ).join("\n");
        const result = analyzeNewTests(diff, undefined);
        expect(result.written).toBe(false);
      }),
    );
  });

  it("legacy new_tests_required=false always returns written:false with migration provenance", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        (diff) => {
          const result = analyzeNewTests(diff, false);
          expect(result.written).toBe(false);
          expect(result.evidence).toContain(
            "verification_policy.new_tests waived: legacy-new-tests-required-false",
          );
        },
      ),
    );
  });
});

describe("resolveTestEvidence — property tests", () => {
  const eventArb: fc.Arbitrary<Evidence> = fc.oneof(
    fc.record({ kind: fc.constant("FileRead" as const), path: fc.constantFrom("/a.ts", "/b.ts") }),
    fc.record({ kind: fc.constant("FileWrite" as const), path: fc.constantFrom("/a.ts", "/b.ts"), via: fc.constantFrom("tool" as const, "shell" as const) }),
    fc.record({
      kind: fc.constant("TestRun" as const),
      command: fc.constantFrom("npm test", "bun test"),
      exit: fc.constantFrom<number | null>(0, 1, null),
      report: fc.constantFrom(
        null,
        reportSummary(5, 0),
        reportSummary(5, 2),
        reportSummary(0, 0),
      ),
    }),
  );

  /** Independent restatement: the deciding run is the LAST trusted TestRun. */
  function decidingRun(events: readonly Evidence[]): { index: number; verdict: string } | null {
    let deciding: { index: number; verdict: string } | null = null;
    events.forEach((e, index) => {
      if (e.kind !== "TestRun") return;
      const v = judgeTestRun(e.exit, e.report);
      if (v.verdict !== "untrusted") deciding = { index, verdict: v.verdict };
    });
    return deciding;
  }

  it("for ALL event sequences: a FileWrite after the deciding pass ⇒ verdict is never trusted-pass", () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 0, maxLength: 25 }),
        fc.constantFrom("12 passing", "no test output here"),
        (events, transcript) => {
          const resolved = resolveTestEvidence(events, transcript, true);
          const deciding = decidingRun(events);
          const writeAfterDecidingPass =
            deciding !== null &&
            deciding.verdict === "trusted-pass" &&
            events.slice(deciding.index + 1).some((e) => e.kind === "FileWrite");
          if (writeAfterDecidingPass) {
            expect(resolved.result.verdict).not.toBe("trusted-pass");
            expect(
              resolved.result.verdict === "untrusted" && resolved.result.label,
            ).toContain("files modified after last trusted pass");
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("for ALL event sequences: trusted-pass is returned ONLY when the deciding run is a pass with no later FileWrite", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 0, maxLength: 25 }), (events) => {
        const resolved = resolveTestEvidence(events, "12 passing", true);
        if (resolved.result.verdict === "trusted-pass") {
          const deciding = decidingRun(events);
          expect(deciding).not.toBeNull();
          expect(deciding!.verdict).toBe("trusted-pass");
          expect(events.slice(deciding!.index + 1).some((e) => e.kind === "FileWrite")).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });
});
