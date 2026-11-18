import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSpecCheckOutput } from "../../src/core/spec-check";
import { parseFindings } from "../../src/handlers/helpers/store-review-findings";

// Doctests: the payload examples in references/loom/recovery-runbook.md are
// fed through the real parsers, so the documented grammar cannot rot apart
// from the code it documents. The `SPEC_CHECK_WAVE: N` placeholder stands for
// the wave under override; the doctest substitutes a concrete wave number.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const runbook = readFileSync(join(repoRoot, "references/loom/recovery-runbook.md"), "utf8");

const payloads = [...runbook.matchAll(/echo '([\s\S]*?)' \| bun/g)].map((match) => match[1]);

const withConcreteWave = (payload: string): string =>
  payload.replace(/^SPEC_CHECK_WAVE: N$/m, "SPEC_CHECK_WAVE: 1");

describe("recovery-runbook payload examples", () => {
  it("carries exactly the two override payload examples", () => {
    expect(payloads).toHaveLength(2);
  });

  it("the spec-check override example parses through the real grammar", () => {
    const parsed = parseSpecCheckOutput(withConcreteWave(payloads[0] as string));
    expect(parsed.wave).toBe(1);
    expect(parsed.verdict).toBe("PASSED");
    expect(parsed.criticalCount).toBe(0);
    expect(parsed.highCount).toBe(0);
    expect(parsed.medium).toEqual(["reason for override"]);
    expect(parsed.overrideReason).toBe("reason for override");
  });

  it("a finding recorded after the verdict is dropped — why the example orders findings first", () => {
    const tooLate = `${withConcreteWave(payloads[0] as string)}\nMEDIUM: too late`;
    const parsed = parseSpecCheckOutput(tooLate);
    expect(parsed.medium).toEqual(["reason for override"]);
  });

  it("the review-findings override example parses through the real parser", () => {
    const parsed = parseFindings(payloads[1] as string);
    expect(parsed.critical).toEqual([]);
    expect(parsed.advisory).toEqual(["original finding — reason for downgrade"]);
  });
});
