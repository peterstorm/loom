import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  decideRefutationTranscriptRead,
  parseWaveRetryDiagnosticSection,
  renderCurrentWaveRetryTask,
  REVIEWER_EXTRACTION_RETRY_INSTRUCTION,
  reviewerRetryInstruction,
  SPEC_CHECK_RETRY_TAIL,
  specCheckRetryDiagnostic,
  standaloneRetryTask,
  WAVE_RETRY_FIXED_TAIL,
  WAVE_RETRY_PREAMBLE,
  waveRetryDiagnostic,
} from "../../src/core/reviewer-retry";
import { emissionToolPrimaryInstruction, type IssuedSpawnEmissionRoute } from "../../src/core/issued-emission-capability";
import { emissionRouteFor, emissionTask, issuedTask, REVIEWER_V2 } from "../fixtures/issued-emission";

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

  it("keeps a captured transcript read failure as blocking infrastructure failure", () => {
    expect(decideRefutationTranscriptRead(
      { ok: false, error: { message: "captured transcript is unreadable" } },
      undefined,
    )).toEqual({ kind: "infrastructure-failure", message: "captured transcript is unreadable" });
  });

  it("turns only an explicit capture-rejection tombstone into semantic rejection", () => {
    expect(decideRefutationTranscriptRead(
      { ok: false, error: { message: "no transcript bytes exist" } },
      "capture runtime terminally rejected this attempt",
    )).toEqual({
      kind: "capture-rejection",
      diagnostic: "capture runtime terminally rejected this attempt",
    });
  });

  it("parses successfully read transcript bytes for verdict submission", () => {
    expect(decideRefutationTranscriptRead(
      { ok: true, value: new TextEncoder().encode('{"verdict":"upheld"}') },
      undefined,
    )).toEqual({ kind: "verdict", transcript: '{"verdict":"upheld"}' });
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

  it("is a function of the route alone: the task text it closes plays no part", () => {
    // The descriptor a task carries can no longer disagree with the route,
    // because the route is never recovered from it.
    const descriptorTask = emissionTask("code-reviewer", REVIEWER_V2);
    expect(standaloneRetryTask(descriptorTask, EXTRACTION_ROUTE, null, { schemaVersion: 2 })
      .endsWith(REVIEWER_EXTRACTION_RETRY_INSTRUCTION)).toBe(true);
    expect(standaloneRetryTask(issuedTask("code-reviewer", REVIEWER_V2), EMISSION_ROUTE, null, { schemaVersion: 2 })
      .endsWith(FRESH_SPAWN_TOOL_RULE)).toBe(true);
  });
});

describe("standaloneRetryTask", () => {
  it("renders route-aware final actions for current standalone requests", () => {
    const emission = emissionTask("code-reviewer", REVIEWER_V2);
    const standaloneEmission = standaloneRetryTask(emission, EMISSION_ROUTE, "bad payload", { schemaVersion: 2 });
    expect(standaloneEmission).toContain(`calling the exact tool ${REVIEWER_V2.toolName} exactly once`);
    expect(standaloneEmission).toContain("fresh one-call budget");
    expect(standaloneEmission.endsWith(REVIEWER_EXTRACTION_RETRY_INSTRUCTION)).toBe(false);
    expect(standaloneEmission).toBe([emission, "", "Your previous attempt was rejected by the engine's admission check.",
      JSON.stringify("bad payload"), "", `This is your final attempt. ${FRESH_SPAWN_TOOL_RULE}`].join("\n"));

    const extractionTask = issuedTask("code-reviewer", REVIEWER_V2);
    expect(standaloneRetryTask(extractionTask, EXTRACTION_ROUTE, null, { schemaVersion: 2 }))
      .toContain(`This is your final attempt. ${REVIEWER_EXTRACTION_RETRY_INSTRUCTION}`);
  });

  it("keeps the archived schema-1 retry wording whatever the route", () => {
    const task = issuedTask("code-reviewer", REVIEWER_V2);
    const archived = standaloneRetryTask(task, EMISSION_ROUTE, "missing summary", { schemaVersion: 1 });
    expect(archived).toBe(standaloneRetryTask(task, EXTRACTION_ROUTE, "missing summary", { schemaVersion: 1 }));
    expect(archived).toContain("### Machine Summary");
    expect(archived).not.toContain(REVIEWER_V2.toolName);
  });
});

describe("renderCurrentWaveRetryTask", () => {
  const task = emissionTask("code-reviewer", REVIEWER_V2);

  it("carries the canonical extraction diagnostic unchanged on an extraction route", () => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), fc.constantFrom(1 as const, 2 as const), (reason, protocolVersion) => {
      expect(renderCurrentWaveRetryTask(task, EXTRACTION_ROUTE, { kind: "rejected", reason, protocolVersion }))
        .toBe(`${task}\n${waveRetryDiagnostic(reason, protocolVersion)}`);
    }));
  });

  it("swaps only the closing action of a current rejection on an emission route — byte-identical to the persisted diagnostic's preamble and bounded reason", () => {
    fc.assert(fc.property(fc.string({ maxLength: 3000 }), (reason) => {
      const persisted = waveRetryDiagnostic(reason, 2);
      const lead = persisted.slice(0, -REVIEWER_EXTRACTION_RETRY_INSTRUCTION.length);
      const rendered = renderCurrentWaveRetryTask(task, EMISSION_ROUTE, { kind: "rejected", reason, protocolVersion: 2 });
      expect(rendered).toBe(`${task}\n${lead}${FRESH_SPAWN_TOOL_RULE}`);
      expect(rendered.endsWith(REVIEWER_EXTRACTION_RETRY_INSTRUCTION)).toBe(false);
      expect(rendered).toContain(`calling the exact tool ${REVIEWER_V2.toolName} exactly once`);
    }));
  });

  it("appends the tool rule after an archived v1 diagnostic and after the unattributed notice", () => {
    expect(renderCurrentWaveRetryTask(task, EMISSION_ROUTE, { kind: "rejected", reason: "bad finding_id", protocolVersion: 1 }))
      .toBe(`${task}\n${waveRetryDiagnostic("bad finding_id", 1)}\n\n${FRESH_SPAWN_TOOL_RULE}`);
    const unattributed = "Attempt 1 was rejected; correct the packet evidence contract.";
    expect(renderCurrentWaveRetryTask(task, EMISSION_ROUTE, { kind: "unattributed" }))
      .toBe(`${task}\n${unattributed}\n\n${FRESH_SPAWN_TOOL_RULE}`);
    expect(renderCurrentWaveRetryTask(task, EXTRACTION_ROUTE, { kind: "unattributed" }))
      .toBe(`${task}\n${unattributed}`);
  });
});
