import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  decideRefutationTranscriptRead,
  parseWaveRetryDiagnosticSection,
  REVIEWER_EXTRACTION_RETRY_INSTRUCTION,
  reviewerRetryInstruction,
  SPEC_CHECK_RETRY_TAIL,
  specCheckRetryDiagnostic,
  standaloneRetryAppendix,
  waveReviewerRetryAppendix,
  refutationRetryAppendix,
  WAVE_RETRY_FIXED_TAIL,
  WAVE_RETRY_PREAMBLE,
  waveRetryDiagnostic,
} from "../../src/core/reviewer-retry";
import { emissionToolPrimaryInstruction, type IssuedSpawnEmissionRoute } from "../../src/core/issued-emission-capability";
import { STANDALONE_SUCCESSOR_ROSTER_RULE } from "../../src/core/standalone-lineage-contract";
import { emissionRouteFor, REVIEWER_V2 } from "../fixtures/issued-emission";

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
  const readBytes = (text: string) => ({ ok: true as const, value: new TextEncoder().encode(text) });
  const readFailure = (message: string) => ({ ok: false as const, error: { message } });

  // Captured bytes win over any tombstone; only an explicit capture-rejection
  // tombstone turns a failed read into semantic rejection; a failed read with
  // no tombstone stays blocking infrastructure failure, never evidence.
  it.each([
    ["captured bytes beside a tombstone", readBytes("{}"), "rejected", { kind: "verdict", transcript: "{}" }],
    ["captured bytes with no tombstone", readBytes('{"verdict":"upheld"}'), undefined, { kind: "verdict", transcript: '{"verdict":"upheld"}' }],
    ["a failed read with a tombstone", readFailure("no transcript bytes exist"), "capture runtime terminally rejected this attempt",
      { kind: "capture-rejection", diagnostic: "capture runtime terminally rejected this attempt" }],
    ["a failed read with no tombstone", readFailure("captured transcript is unreadable"), undefined,
      { kind: "infrastructure-failure", message: "captured transcript is unreadable" }],
  ] as const)("decides %s", (_label, read, tombstone, expected) => {
    expect(decideRefutationTranscriptRead(read, tombstone)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Route-aware retry final actions: the issued route is data handed over by the
// render that produced the task, never re-parsed out of the task text.
// ---------------------------------------------------------------------------

const EMISSION_ROUTE = emissionRouteFor(REVIEWER_V2);
const EXTRACTION_ROUTE: IssuedSpawnEmissionRoute = Object.freeze({
  kind: "extraction-only",
  reason: "issued Pi route is not the explicitly trusted qualified route",
});
const FRESH_SPAWN_TOOL_RULE = `This is a fresh spawn with a fresh one-call budget. ${emissionToolPrimaryInstruction(REVIEWER_V2)}`;

describe("reviewerRetryInstruction", () => {
  it("closes an emission route with the fresh-spawn tool rule and every other route with the extraction instruction", () => {
    expect(reviewerRetryInstruction(EMISSION_ROUTE)).toBe(FRESH_SPAWN_TOOL_RULE);
    expect(reviewerRetryInstruction(EXTRACTION_ROUTE)).toBe(REVIEWER_EXTRACTION_RETRY_INSTRUCTION);
  });
});

describe("standaloneRetryAppendix", () => {
  it("writes the route-aware final action for a current standalone request", () => {
    const emission = standaloneRetryAppendix(EMISSION_ROUTE, "bad payload", 2);
    expect(emission).toContain(`calling the exact tool ${REVIEWER_V2.toolName} exactly once`);
    expect(emission).toContain("fresh one-call budget");
    expect(emission.endsWith(REVIEWER_EXTRACTION_RETRY_INSTRUCTION)).toBe(false);
    // Scope discipline is stated, not implied: the retry names the rule the
    // admission enforces AND the escape hatch that avoids re-emitting the same
    // defect (a real path outside the frozen slice).
    expect(emission).toContain("Every finding's file is either null or a path inside the frozen scope.");
    expect(emission).toContain("or emit an honest null location — never an unfrozen path.");
    // The appendix begins with the blank line a render separates it by, so the
    // task and its retry notice cannot be joined two different ways.
    expect(emission).toBe(["", "Your previous attempt was rejected by the engine's admission check.",
      JSON.stringify("bad payload"), "",
      "Satisfy BOTH admission rules:\n1. Every finding's file is either null or a path inside the frozen scope.\n" +
        "2. The payload conforms exactly to the issued reviewer-payload-schema and reviewer-impact-rubric.\n" +
        "When the evidence lies outside the frozen scope, name the frozen file that should have carried\n" +
        "the assertion, or emit an honest null location — never an unfrozen path.",
      "", `This is your final attempt. ${FRESH_SPAWN_TOOL_RULE}`].join("\n"));
    expect(standaloneRetryAppendix(EXTRACTION_ROUTE, null, 2))
      .toContain(`This is your final attempt. ${REVIEWER_EXTRACTION_RETRY_INSTRUCTION}`);
  });

  it("tells a successor retry the v3 envelope and the roster rule, and no other version (issue #185)", () => {
    const successor = standaloneRetryAppendix(EXTRACTION_ROUTE, "bad assessment", 3);
    const current = standaloneRetryAppendix(EXTRACTION_ROUTE, "bad assessment", 2);
    // The roster rule is the one wording every successor prompt surface shares, verbatim.
    for (const phrase of ['"schemaVersion": 3', '"kind": "standalone-successor-review"', STANDALONE_SUCCESSOR_ROSTER_RULE,
      "in roster order", "repairablePaths"]) {
      expect(successor, phrase).toContain(phrase);
      expect(current, phrase).not.toContain(phrase);
    }
    // The successor rule sits between the shared rules and the closing action, which is unchanged.
    expect(successor.endsWith(`This is your final attempt. ${REVIEWER_EXTRACTION_RETRY_INSTRUCTION}`)).toBe(true);
    expect(successor.startsWith(current.slice(0, current.indexOf("This is your final attempt.")))).toBe(true);
  });

  it("keeps the archived schema-1 retry wording whatever the route", () => {
    const archived = standaloneRetryAppendix(EMISSION_ROUTE, "missing summary", 1);
    expect(archived).toBe(standaloneRetryAppendix(EXTRACTION_ROUTE, "missing summary", 1));
    expect(archived).toContain("### Machine Summary");
    expect(archived).not.toContain(REVIEWER_V2.toolName);
  });
});

describe("waveReviewerRetryAppendix", () => {
  it("carries the canonical extraction diagnostic unchanged on an extraction route", () => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), fc.constantFrom(1 as const, 2 as const), (reason, protocolVersion) => {
      expect(waveReviewerRetryAppendix(EXTRACTION_ROUTE, { kind: "rejected", reason, protocolVersion }))
        .toBe(waveRetryDiagnostic(reason, protocolVersion));
    }));
  });

  it("swaps only the closing action of a current rejection on an emission route — byte-identical to the persisted diagnostic's preamble and bounded reason", () => {
    fc.assert(fc.property(fc.string({ maxLength: 3000 }), (reason) => {
      const persisted = waveRetryDiagnostic(reason, 2);
      const lead = persisted.slice(0, -REVIEWER_EXTRACTION_RETRY_INSTRUCTION.length);
      const appendix = waveReviewerRetryAppendix(EMISSION_ROUTE, { kind: "rejected", reason, protocolVersion: 2 });
      expect(appendix).toBe(`${lead}${FRESH_SPAWN_TOOL_RULE}`);
      expect(appendix.endsWith(REVIEWER_EXTRACTION_RETRY_INSTRUCTION)).toBe(false);
      expect(appendix).toContain(`calling the exact tool ${REVIEWER_V2.toolName} exactly once`);
    }));
  });

  it("appends the tool rule after an archived v1 diagnostic and after the unattributed notice", () => {
    expect(waveReviewerRetryAppendix(EMISSION_ROUTE, { kind: "rejected", reason: "bad finding_id", protocolVersion: 1 }))
      .toBe(`${waveRetryDiagnostic("bad finding_id", 1)}\n\n${FRESH_SPAWN_TOOL_RULE}`);
    const unattributed = "Attempt 1 was rejected; correct the packet evidence contract.";
    expect(waveReviewerRetryAppendix(EMISSION_ROUTE, { kind: "unattributed" }))
      .toBe(`${unattributed}\n\n${FRESH_SPAWN_TOOL_RULE}`);
    expect(waveReviewerRetryAppendix(EXTRACTION_ROUTE, { kind: "unattributed" })).toBe(unattributed);
  });
});

describe("refutationRetryAppendix", () => {
  it("names the rejection it was given and closes with the one-object final-action contract", () => {
    const named = refutationRetryAppendix("verdict payload had no criterion");
    expect(named).toContain("Your previous attempt was rejected:");
    expect(named).toContain("verdict payload had no criterion");
    expect(named).toContain("Your FINAL message must be exactly one JSON object and nothing else");
    expect(named.startsWith("\n")).toBe(true);
  });

  it("degrades to the unparseable-verdict notice when no diagnostic survived", () => {
    expect(refutationRetryAppendix(null)).toContain("its verdict payload could not be parsed.");
  });
});
