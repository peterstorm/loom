import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { extractTestEvidence, analyzeNewTests } from "../../../src/handlers/subagent-stop/update-task-status";

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
          const baseDiff = Array.from({ length: base }, () => "+    @Test\n+    assertThat(x).isTrue();").join("\n");
          const moreDiff = Array.from({ length: base + extra }, () => "+    @Test\n+    assertThat(x).isTrue();").join("\n");

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
        const diff = Array.from({ length: n }, () => "-    @Test\n-    assertThat(x).isTrue();").join("\n");
        const result = analyzeNewTests(diff, undefined);
        expect(result.written).toBe(false);
      }),
    );
  });

  it("new_tests_required=false always returns written:false", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        (diff) => {
          const result = analyzeNewTests(diff, false);
          expect(result.written).toBe(false);
          expect(result.evidence).toContain("skipped");
        },
      ),
    );
  });
});
