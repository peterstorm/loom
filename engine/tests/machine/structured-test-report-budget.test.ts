import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readTestReport, reportCounts } from "../../src/core/structured-test-report";
import { countedReport, summarizedReport } from "./report-summary";

const LIMIT = 8 * 1024 * 1024;

describe("structured report resource budget", () => {
  it("accepts exactly 8 MiB and refuses limit+1 before accessing bytes for decoding", () => {
    const xml = '<testsuite tests="1" failures="0"/>';
    expect(countedReport(xml.padEnd(LIMIT, " ")).ok).toBe(true);
    let decoded = false;
    const Decoder = globalThis.TextDecoder;
    // Counting adapter delegates to the real decoder; it changes no decoding
    // behavior and proves the budget refusal happens before decoder loading.
    globalThis.TextDecoder = class extends Decoder {
      override decode(...args: Parameters<TextDecoder["decode"]>): string {
        decoded = true;
        return super.decode(...args);
      }
    };
    try {
      expect(reportCounts(readTestReport(new Uint8Array(LIMIT + 1)))).toMatchObject({ ok: false, error: { reason: "resource-limit" } });
      expect(decoded).toBe(false);
    } finally { globalThis.TextDecoder = Decoder; }
    expect(countedReport(xml.padEnd(LIMIT + 1, " "))).toMatchObject({ ok: false, error: { reason: "resource-limit" } });
  });

  it("bounds actual XML structure to depth 128, including diagnostic elements", () => {
    const nested = (depth: number) => '<testsuite tests="1" failures="0">' + '<detail>'.repeat(depth - 1) + '</detail>'.repeat(depth - 1) + '</testsuite>';
    expect(countedReport(nested(128)).ok).toBe(true);
    expect(countedReport(nested(129)).ok).toBe(false);
    expect(summarizedReport(nested(129), "junit-xml")).toBeNull();
    expect(countedReport(nested(20_000)).ok).toBe(false);
  });

  it("never authorizes generated over-depth XML, including recursive suite traversals", () => {
    fc.assert(fc.property(fc.integer({ min: 129, max: 1024 }), (depth) => {
      const xml = '<testsuite tests="1">'.repeat(depth) + '</testsuite>'.repeat(depth);
      expect(countedReport(xml).ok).toBe(false);
      expect(summarizedReport(xml, "junit-xml")).toBeNull();
    }), { numRuns: 30 });
  });
});
