import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  decideRefutationTranscriptRead,
  parseWaveRetryDiagnosticSection,
  REVIEWER_EXTRACTION_RETRY_INSTRUCTION,
  SPEC_CHECK_RETRY_TAIL,
  specCheckRetryDiagnostic,
  WAVE_RETRY_FIXED_TAIL,
  WAVE_RETRY_PREAMBLE,
  waveRetryDiagnostic,
} from "../../src/core/reviewer-retry";

const bytes = (text: string): readonly number[] => [...new TextEncoder().encode(text)];
const nonBlankReason = fc.string({ minLength: 1, maxLength: 400 })
  .filter((reason) => reason.trim().length > 0 && !reason.includes("\n\n"));

describe("waveRetryDiagnostic ↔ parseWaveRetryDiagnosticSection", () => {
  it("round-trips an archived v1 reason verbatim behind the fixed schema tail", () => {
    fc.assert(fc.property(nonBlankReason, (reason) => {
      const diagnostic = waveRetryDiagnostic(reason, 1);
      expect(diagnostic.startsWith(WAVE_RETRY_PREAMBLE)).toBe(true);
      expect(diagnostic.endsWith(WAVE_RETRY_FIXED_TAIL)).toBe(true);
      expect(parseWaveRetryDiagnosticSection(bytes(diagnostic), 1)).toEqual({ ok: true, reason });
    }));
  });

  it("bounds a current v2 reason to 2048 bytes of its JSON escape and parses it back", () => {
    fc.assert(fc.property(fc.string({ maxLength: 3000 }), (reason) => {
      const diagnostic = waveRetryDiagnostic(reason, 2);
      expect(diagnostic.endsWith(REVIEWER_EXTRACTION_RETRY_INSTRUCTION)).toBe(true);
      const parsed = parseWaveRetryDiagnosticSection(bytes(diagnostic), 2);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(new TextEncoder().encode(parsed.reason).length).toBeLessThanOrEqual(2048);
      expect(JSON.stringify(reason).startsWith(parsed.reason)).toBe(true);
    }));
  });

  it("refuses a diagnostic rendered for the other protocol version", () => {
    expect(parseWaveRetryDiagnosticSection(bytes(waveRetryDiagnostic("bad finding_id", 1)), 2).ok).toBe(false);
    expect(parseWaveRetryDiagnosticSection(bytes(waveRetryDiagnostic("bad finding_id", 2)), 1).ok).toBe(false);
  });
});

describe("specCheckRetryDiagnostic", () => {
  it("frames every reason between the shared preamble and the spec-check footer contract", () => {
    fc.assert(fc.property(fc.string({ maxLength: 200 }), (reason) => {
      const diagnostic = specCheckRetryDiagnostic(reason);
      expect(diagnostic.startsWith(WAVE_RETRY_PREAMBLE)).toBe(true);
      expect(diagnostic.endsWith(`\n\n${SPEC_CHECK_RETRY_TAIL}`)).toBe(true);
    }));
  });
});

describe("decideRefutationTranscriptRead", () => {
  it("prefers captured bytes, then the tombstone, and never turns a read failure into evidence", () => {
    expect(decideRefutationTranscriptRead({ ok: true, value: new TextEncoder().encode("{}") }, "rejected"))
      .toEqual({ kind: "verdict", transcript: "{}" });
    expect(decideRefutationTranscriptRead({ ok: false, error: { message: "gone" } }, "rejected"))
      .toEqual({ kind: "capture-rejection", diagnostic: "rejected" });
    expect(decideRefutationTranscriptRead({ ok: false, error: { message: "gone" } }, undefined))
      .toEqual({ kind: "infrastructure-failure", message: "gone" });
  });
});
