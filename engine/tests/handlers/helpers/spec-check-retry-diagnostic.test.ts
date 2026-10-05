import { describe, expect, it } from "vitest";
import { parseSpecCheckOutput } from "../../../src/core/spec-check";
import { SPEC_CHECK_RETRY_TAIL, WAVE_RETRY_PREAMBLE, specCheckRetryDiagnostic } from "../../../src/core/reviewer-retry";

describe("specCheckRetryDiagnostic", () => {
  it("names the exact attempt-1 complaint and the footer order the parser reads", () => {
    // Production regression: Wave 8's spec-check placed findings above
    // SPEC_CHECK_WAVE twice; the retry carried no reason, so the final attempt
    // repeated the defect and the gate exhausted.
    const reason = "SPEC_CHECK_HIGH_COUNT (1) does not match HIGH: findings (0); counts must match the findings - re-run /wave-gate";
    const text = specCheckRetryDiagnostic(reason);
    expect(text.startsWith(WAVE_RETRY_PREAMBLE)).toBe(true);
    expect(text).toContain(JSON.stringify(reason));
    expect(text.endsWith(SPEC_CHECK_RETRY_TAIL)).toBe(true);
  });

  it("bounds an oversized complaint to the shared retry byte budget", () => {
    const text = specCheckRetryDiagnostic("x".repeat(10_000));
    const reason = text.slice(WAVE_RETRY_PREAMBLE.length, text.indexOf("\n\n"));
    expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(2048);
  });

  it("describes a footer the parser accepts, and the rejected shape it does not", () => {
    const compliant = parseSpecCheckOutput([
      "SPEC_CHECK_WAVE: 8",
      "HIGH: the pilot recorded 0 observations",
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 1",
      "SPEC_CHECK_VERDICT: PASSED",
    ].join("\n"));
    expect(compliant).toMatchObject({ high: ["the pilot recorded 0 observations"], highCount: 1 });
    const rejected = parseSpecCheckOutput([
      "HIGH: the pilot recorded 0 observations",
      "SPEC_CHECK_WAVE: 8",
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 1",
      "SPEC_CHECK_VERDICT: PASSED",
    ].join("\n"));
    expect(rejected).toMatchObject({ high: [], highCount: 1 });
  });
});
