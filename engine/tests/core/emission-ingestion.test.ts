import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createHash } from "node:crypto";
import {
  observeEmissionCalls,
  selectCanonicalPayload,
  selectVerdictSource,
  type EmissionCallFrame,
  type EmissionToolCall,
  type IngestionSelection,
  type VerdictSourceSelection,
} from "../../src/core/emission-ingestion";
import {
  admitEmissionArguments,
  EMISSION_TOOL_SPECS,
  issueEmissionBinding,
  type EmissionArgumentAdmission,
  type EmissionParseFailure,
  type IssuedEmissionBinding,
  type IssuedEmissionBindingOf,
} from "../../src/core/emission-tool";
import { parseFinalPayload, type CaptureRejection, type FinalPayload } from "../../src/core/harness-capture";
import {
  canonicalStructuralEquals,
  type DomainResult,
} from "../../src/core/orchestration-contract/identity";
import { sha256Hex } from "../../src/core/review-packet";
import type { PayloadProducerKind, PayloadProducerKindName } from "../../src/core/model-profiles";
import {
  REVIEWER_PAYLOAD_EXAMPLE_V2,
  reviewerPayloadV2Schema,
} from "../../src/core/reviewer-contract";

/**
 * The AD-8/AD-9 selection matrix as executable behavior: the issued binding
 * mint, the closed observation fold (identity, replay, contradiction,
 * incompleteness), and the two selection functions' every row. The properties
 * assert rejection outcomes rather than skipping them (AD-9): duplicates and
 * refusals are pinned as outcomes in their own right, and the containment law
 * is claimed only for the two extraction-selected states it actually covers.
 */

const REQUEST_ID = "req-emission-attempt-1";
const OTHER_REQUEST_ID = "req-emission-attempt-2";

const proseArb = fc.stringMatching(/^[a-z0-9][a-z0-9 .,;:\-]{0,60}$/);

const mustMint = <K extends PayloadProducerKindName>(
  issued: IssuedEmissionRequestFixture<K>,
): IssuedEmissionBindingOf<K> => {
  const minted = issueEmissionBinding(issued);
  if (!minted.ok) throw new Error(`fixture binding refused: ${minted.error.code} — ${minted.error.message}`);
  return minted.value;
};

const REVIEWER_V2 = mustMint({ requestId: REQUEST_ID, kind: "reviewer-payload", version: "v2" });
const JUDGE_V1 = mustMint({ requestId: REQUEST_ID, kind: "judge-verdict", version: "v1" });
const REFUTATION_V1 = mustMint({ requestId: REQUEST_ID, kind: "refutation-verdict", version: "v1" });

const ABSENT = observeEmissionCalls([]);

/** The mint's parameter shape, restated so the fixture helper preserves the
 *  kind literal in its return type. */
type IssuedEmissionRequestFixture<K extends PayloadProducerKindName> = IssuedEmissionRequestShape &
  Readonly<{ kind: K }>;
type IssuedEmissionRequestShape = Readonly<{
  requestId: string;
  kind: PayloadProducerKindName;
  version: string;
  toolName?: string;
  schemaDigest?: string;
}>;

const candidatesArb = fc.array(
  fc.record({ origin: fc.constant("content[0].text"), text: fc.string({ minLength: 0, maxLength: 100 }) }),
  { maxLength: 3 },
);

/** The frozen v2 schema bytes — read through the registry, the one source. */
function REVIEWER_PAYLOAD_SCHEMA_BYTES(): string {
  return EMISSION_TOOL_SPECS["reviewer-payload"].schemaVersions["v2"]!.schemaBytes;
}

const callOf = (
  binding: IssuedEmissionBinding,
  toolCallId: string,
  arguments_: unknown,
): EmissionToolCall => ({
  requestId: binding.requestId,
  toolCallId,
  kind: binding.kind,
  version: binding.version,
  arguments: arguments_,
});

const frameOf = (call: EmissionToolCall): Extract<EmissionCallFrame, { kind: "complete" }> => ({
  kind: "complete",
  call,
});

const incompleteFrame = (toolCallId: string | null, reason: string): EmissionCallFrame => ({
  kind: "incomplete",
  toolCallId,
  reason,
});

const INVALID_ARGUMENTS = { arbitrary: "not a payload" };

/** A valid reviewer payload as emission arguments, parametrized by claim text. */
const validReviewerArguments = (claim: string): unknown =>
  reviewerPayloadV2Schema.parse({
    schemaVersion: 2,
    kind: "standalone-review",
    findings: [{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim }],
  });

const validJudgeArguments = (criterion: string): unknown => ({
  criterion,
  rankings: [
    { candidate: "candidate-type-driven-fp.md", score: 8, fatal_flaw: null, strongest_idea: "the registry" },
  ],
});

const validRefutationArguments = (criterion: string): unknown => ({
  criterion,
  verdicts: [{ finding_id: "T1:code-reviewer-1", verdict: "refuted", reasoning: "cannot be triggered" }],
});

const USABLE_CANDIDATES = [{ origin: "content[0].text", text: "prose payload" }];
const invalidArgsArb = fc.record({ arbitrary: fc.string({ maxLength: 20 }) });

/** The admission refusals the refused-call fixtures retain — pinned in the
 *  fixture-integrity test so a schema change surfaces here first. */
const REVIEWER_REFUSED = admitEmissionArguments(
  EMISSION_TOOL_SPECS["reviewer-payload"],
  "v2",
  INVALID_ARGUMENTS,
);
const JUDGE_REFUSED = admitEmissionArguments(
  EMISSION_TOOL_SPECS["judge-verdict"],
  "v1",
  { criterion: "x", rankings: [] },
);

const asRefusal = (admission: EmissionArgumentAdmission): { code: string; message: string } => {
  if (admission.kind !== "refused") throw new Error("fixture admission must be refused");
  return { code: admission.code, message: admission.message };
};

// ---------------------------------------------------------------------------
// issueEmissionBinding — the issued binding mint (AD-8)
// ---------------------------------------------------------------------------

describe("issueEmissionBinding", () => {
  it("mints every registry-carried (kind, version) cell with the registry tool name and the frozen bytes' digest", () => {
    for (const [kindName, spec] of Object.entries(EMISSION_TOOL_SPECS)) {
      for (const [version, schemaVersion] of Object.entries(spec.schemaVersions)) {
        const minted = issueEmissionBinding({
          requestId: REQUEST_ID,
          kind: kindName as PayloadProducerKindName,
          version,
        });
        expect(minted.ok).toBe(true);
        if (minted.ok) {
          expect(minted.value.toolName).toBe(spec.toolName);
          expect(minted.value.schemaDigest).toBe(sha256Hex(schemaVersion.schemaBytes));
          expect(minted.value.version).toBe(version);
          expect(minted.value.kind).toEqual({ kind: kindName });
          expect(minted.value.requestId).toBe(REQUEST_ID);
          expect(Object.isFrozen(minted.value)).toBe(true);
        }
      }
    }
  });

  it("agrees with registry membership for every (kind, version) pair — unsupported pairs refuse", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<PayloadProducerKindName>("reviewer-payload", "judge-verdict", "refutation-verdict"),
        fc.constantFrom("v2", "v3", "v1"),
        (kindName, version) => {
          const carried =
            version in EMISSION_TOOL_SPECS[kindName].schemaVersions;
          const minted = issueEmissionBinding({ requestId: REQUEST_ID, kind: kindName, version });
          return minted.ok === carried;
        },
      ),
    );
  });

  it("refuses an unsupported pair with the supported versions named", () => {
    const minted = issueEmissionBinding({ requestId: REQUEST_ID, kind: "judge-verdict", version: "v2" });
    expect(minted.ok).toBe(false);
    if (!minted.ok) {
      expect(minted.error.code).toBe("unsupported-schema-version");
      expect(minted.error.message).toContain("v1");
    }
  });

  it("verifies the claimed tool name against the registry and derives it when absent", () => {
    const derived = mustMint({ requestId: REQUEST_ID, kind: "reviewer-payload", version: "v2" });
    expect(derived.toolName).toBe("loom_emit_reviewer_payload");

    const claimed = issueEmissionBinding({
      requestId: REQUEST_ID,
      kind: "reviewer-payload",
      version: "v2",
      toolName: "loom_emit_reviewer_payload",
    });
    expect(claimed.ok).toBe(true);

    const mismatched = issueEmissionBinding({
      requestId: REQUEST_ID,
      kind: "reviewer-payload",
      version: "v2",
      toolName: "loom_emit_judge_verdict",
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.error.code).toBe("tool-name-mismatch");
      expect(mismatched.error.message).toContain("loom_emit_judge_verdict");
    }
  });

  it("verifies the claimed schema digest against the frozen bytes and refuses stale or malformed digests", () => {
    const digest = sha256Hex(REVIEWER_PAYLOAD_SCHEMA_BYTES());
    const certified = issueEmissionBinding({
      requestId: REQUEST_ID,
      kind: "reviewer-payload",
      version: "v2",
      schemaDigest: digest,
    });
    expect(certified.ok).toBe(true);

    for (const stale of ["0".repeat(64), "not-a-digest", digest.slice(0, 63)]) {
      const refused = issueEmissionBinding({
        requestId: REQUEST_ID,
        kind: "reviewer-payload",
        version: "v2",
        schemaDigest: stale,
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe("schema-digest-mismatch");
        expect(refused.error.message).toContain("reviewer-payload/v2");
      }
    }
  });

  it("refuses a non-canonical request identity — an empty id can never bind observations vacuously", () => {
    for (const requestId of ["", "not a canonical id!"]) {
      const refused = issueEmissionBinding({ requestId, kind: "judge-verdict", version: "v1" });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("invalid-request-identity");
    }
  });
});

// ---------------------------------------------------------------------------
// observeEmissionCalls — the closed observation fold (AD-8/FR-007/FR-014)
// ---------------------------------------------------------------------------

const completeFrameArb = fc.record({
  requestId: fc.constantFrom(REQUEST_ID, OTHER_REQUEST_ID),
  toolCallId: fc.string({ minLength: 1, maxLength: 8 }),
  kind: fc.constantFrom<PayloadProducerKindName>("reviewer-payload", "judge-verdict", "refutation-verdict")
    .map((kind) => Object.freeze({ kind }) as PayloadProducerKind),
  version: fc.constantFrom("v2", "v3", "v1"),
  arguments: fc.record({ arbitrary: fc.string({ maxLength: 20 }) }),
}).map((call): Extract<EmissionCallFrame, { kind: "complete" }> => frameOf(call as EmissionToolCall));

const incompleteFrameArb = fc.record({
  toolCallId: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
  reason: proseArb,
}).map(({ toolCallId, reason }) => incompleteFrame(toolCallId, reason));

const framesArb = fc.array(fc.oneof(completeFrameArb, incompleteFrameArb), { maxLength: 5 });

describe("observeEmissionCalls", () => {
  it("classifies zero frames as absent", () => {
    expect(observeEmissionCalls([])).toEqual({ kind: "absent" });
  });

  it("classifies one complete call as single-call, projected to the contract fields", () => {
    const call = callOf(REVIEWER_V2, "call-1", INVALID_ARGUMENTS);
    const observation = observeEmissionCalls([frameOf(call)]);
    expect(observation).toEqual({
      kind: "single-call",
      call: { requestId: REQUEST_ID, toolCallId: "call-1", kind: { kind: "reviewer-payload" }, version: "v2", arguments: INVALID_ARGUMENTS },
    });
    if (observation.kind === "single-call") expect(Object.isFrozen(observation.call)).toBe(true);
  });

  it("is binding-blind: it counts by tool-call identity for every kind and version", () => {
    const judgeCall = { ...callOf(REVIEWER_V2, "call-j", INVALID_ARGUMENTS), kind: Object.freeze({ kind: "judge-verdict" }) as PayloadProducerKind, version: "v1" as const };
    const refutationCall = { ...callOf(REVIEWER_V2, "call-r", INVALID_ARGUMENTS), kind: Object.freeze({ kind: "refutation-verdict" }) as PayloadProducerKind, version: "v3" as const };
    const observation = observeEmissionCalls([frameOf(judgeCall), frameOf(refutationCall)]);
    expect(observation.kind).toBe("multiple-calls");
    if (observation.kind === "multiple-calls") {
      expect(observation.calls.map(({ toolCallId }) => toolCallId)).toEqual(["call-j", "call-r"]);
    }
  });

  it("folds an exact replay of one call back to a single call — idempotent (FR-007)", () => {
    const call = callOf(REVIEWER_V2, "call-1", validReviewerArguments("the registry"));
    const replayed = structuredClone(frameOf(call));
    const observation = observeEmissionCalls([frameOf(call), replayed]);
    expect(observation.kind).toBe("single-call");
    expect(canonicalStructuralEquals(observation, observeEmissionCalls([frameOf(call)]))).toBe(true);
  });

  it("refuses contradictory frames sharing one call identity for every differing field (FR-007)", () => {
    const call = callOf(REVIEWER_V2, "call-1", validReviewerArguments("the registry"));
    const contradictory: readonly EmissionToolCall[] = [
      { ...call, arguments: { different: "arguments" } },
      { ...call, requestId: OTHER_REQUEST_ID },
      { ...call, kind: Object.freeze({ kind: "judge-verdict" }) as PayloadProducerKind },
      { ...call, version: "v3" as const },
    ];
    for (const variant of contradictory) {
      const observation = observeEmissionCalls([frameOf(call), frameOf(variant)]);
      expect(observation).toEqual({
        kind: "unusable",
        reason: "contradictory duplicate transport frames for emission tool call call-1",
      });
    }
  });

  it("refuses an incomplete frame with its reason — never reclassified as absence (AD-8)", () => {
    expect(observeEmissionCalls([incompleteFrame("call-1", "stream interrupted")])).toEqual({
      kind: "unusable",
      reason: "emission tool call call-1 was observed incomplete: stream interrupted",
    });
    expect(observeEmissionCalls([incompleteFrame(null, "frame lost")])).toEqual({
      kind: "unusable",
      reason: "an emission tool call was observed incomplete: frame lost",
    });
  });

  it("refuses the attempt when any frame is incomplete, even beside complete calls (AD-8)", () => {
    const callA = frameOf(callOf(REVIEWER_V2, "call-a", INVALID_ARGUMENTS));
    const callB = frameOf(callOf(REVIEWER_V2, "call-b", INVALID_ARGUMENTS));
    const observation = observeEmissionCalls([callA, incompleteFrame("call-x", "stream interrupted"), callB]);
    expect(observation.kind).toBe("unusable");
    if (observation.kind === "unusable") {
      expect(observation.reason).toContain("call-x");
    }
  });

  it("refuses a complete frame carrying an empty tool-call identity — it cannot be bound or replay-deduplicated", () => {
    const call = callOf(REVIEWER_V2, "", INVALID_ARGUMENTS);
    expect(observeEmissionCalls([frameOf(call)]).kind).toBe("unusable");
  });

  it("is deterministic over arbitrary frame lists", () => {
    fc.assert(
      fc.property(framesArb, (frames) => {
        expect(canonicalStructuralEquals(observeEmissionCalls(frames), observeEmissionCalls(frames))).toBe(true);
      }),
    );
  });

  it("never refuses a clean list and never silently collapses a contradiction (the fold's classification law)", () => {
    fc.assert(
      fc.property(fc.array(completeFrameArb, { maxLength: 4 }), (frames) => {
        const groups = new Map<string, EmissionToolCall[]>();
        for (const frame of frames) {
          const id = frame.call.toolCallId;
          const group = groups.get(id) ?? [];
          group.push(frame.call);
          groups.set(id, group);
        }
        const emptyId = frames.some((frame) => frame.call.toolCallId.length === 0);
        const contradictory = [...groups.values()].some((group) =>
          group.length > 1 && group.slice(1).some((call) => !canonicalStructuralEquals(group[0], call)),
        );
        const distinct = groups.size;
        const observation = observeEmissionCalls(frames);
        if (emptyId || contradictory) {
          return observation.kind === "unusable";
        }
        if (distinct === 0) return observation.kind === "absent";
        if (distinct === 1) return observation.kind === "single-call";
        return observation.kind === "multiple-calls" && observation.calls.length === distinct;
      }),
    );
  });

  it("keeps an exact replay of any observed complete call idempotent over arbitrary lists (FR-007)", () => {
    fc.assert(
      fc.property(
        fc.array(completeFrameArb, { minLength: 1, maxLength: 4 }),
        fc.nat(3),
        (frames, index) => {
          const picked = frames[Math.min(index, frames.length - 1)]!;
          const replayed = [...frames, structuredClone(picked)];
          expect(canonicalStructuralEquals(observeEmissionCalls(replayed), observeEmissionCalls(frames))).toBe(true);
        },
      ),
    );
  });

  it("keeps replays inert once an attempt is poisoned by an incomplete frame (AD-8)", () => {
    fc.assert(
      fc.property(
        fc.array(completeFrameArb, { maxLength: 3 }),
        incompleteFrameArb,
        fc.nat(3),
        completeFrameArb,
        (prefix, incomplete, at, suffix) => {
          const poisoned = [...prefix.slice(0, at), incomplete, ...prefix.slice(at), suffix];
          const baseline = observeEmissionCalls(poisoned);
          expect(baseline.kind).toBe("unusable");
          const replayed = observeEmissionCalls([...poisoned, structuredClone(suffix)]);
          expect(canonicalStructuralEquals(replayed, baseline)).toBe(true);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// selectCanonicalPayload — the reviewer path's AD-9 matrix
// ---------------------------------------------------------------------------

describe("selectCanonicalPayload", () => {
  it("refuses the fixtures' invalid arguments so the retention pins below are meaningful", () => {
    expect(REVIEWER_REFUSED.kind).toBe("refused");
    expect(JUDGE_REFUSED.kind).toBe("refused");
  });

  it("engages extraction verbatim with zero calls — the no-op baseline, usable candidates accepted as today", () => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        const selection = selectCanonicalPayload(REVIEWER_V2, ABSENT, candidates);
        expect(selection.kind).toBe("final-message-extraction");
        if (selection.kind === "final-message-extraction") {
          expect(selection.source).toBe("extraction");
          expect(selection.emissionRefusal).toBeNull();
          expect(canonicalStructuralEquals(selection.fallback, parseFinalPayload(candidates))).toBe(true);
        }
      }),
    );
  });

  it("carries the existing rejection vocabulary verbatim with zero calls and no candidates", () => {
    const selection = selectCanonicalPayload(REVIEWER_V2, ABSENT, []);
    expect(selection.kind).toBe("final-message-extraction");
    if (selection.kind === "final-message-extraction") {
      expect(selection.fallback.ok).toBe(false);
      if (!selection.fallback.ok) expect(selection.fallback.error.reason).toBe("no-final-payload");
    }
  });

  it("prefers a valid emission call over extraction regardless of final text (FR-003/AS-003)", () => {
    fc.assert(
      fc.property(proseArb, candidatesArb, (claim, candidates) => {
        const selection = selectCanonicalPayload(
          REVIEWER_V2,
          observeEmissionCalls([frameOf(callOf(REVIEWER_V2, "call-1", validReviewerArguments(claim)))]),
          candidates,
        );
        expect(selection.kind).toBe("emission-tool-arguments");
        if (selection.kind === "emission-tool-arguments") {
          expect(selection.source).toBe("emission-tool");
          expect(canonicalStructuralEquals(JSON.parse(selection.payload.text), validReviewerArguments(claim))).toBe(true);
        }
      }),
    );
  });

  it("digests the canonical payload as the sha256 of its deterministically encoded bytes", () => {
    const selection = selectCanonicalPayload(
      REVIEWER_V2,
      observeEmissionCalls([frameOf(callOf(REVIEWER_V2, "call-1", REVIEWER_PAYLOAD_EXAMPLE_V2))]),
      [],
    );
    expect(selection.kind).toBe("emission-tool-arguments");
    if (selection.kind === "emission-tool-arguments") {
      const bytes = new TextEncoder().encode(selection.payload.text);
      expect(selection.payload.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(selection.payload.byteLength).toBe(bytes.length);
    }
  });

  it("returns the accepted call's identity as provenance on the emission arm (FR-009/AD-8)", () => {
    const args = validReviewerArguments("the registry");
    const selection = selectCanonicalPayload(
      REVIEWER_V2,
      observeEmissionCalls([frameOf(callOf(REVIEWER_V2, "call-7", args))]),
      USABLE_CANDIDATES,
    );
    expect(selection.kind).toBe("emission-tool-arguments");
    if (selection.kind === "emission-tool-arguments") {
      expect(selection.call).toEqual({
        requestId: REQUEST_ID,
        toolCallId: "call-7",
        kind: { kind: "reviewer-payload" },
        version: "v2",
        arguments: args,
      });
    }
  });

  it("never ingests the single refused call's arguments and retains its refusal with unchanged extraction (FR-006/AS-007)", () => {
    fc.assert(
      fc.property(invalidArgsArb, candidatesArb, (args, candidates) => {
        const admission = admitEmissionArguments(EMISSION_TOOL_SPECS["reviewer-payload"], "v2", args);
        // Asserted, not skipped: an admission that is not refused here would
        // mean the fixture generator can mint valid payloads, and this
        // property would be silently vacuous (AD-9's warning to test authors).
        expect(admission.kind).toBe("refused");
        const refusal = asRefusal(admission);
        const selection = selectCanonicalPayload(
          REVIEWER_V2,
          observeEmissionCalls([frameOf(callOf(REVIEWER_V2, "call-1", args))]),
          candidates,
        );
        if (selection.kind === "final-message-extraction") {
          return selection.emissionRefusal !== null
            && selection.emissionRefusal.code === refusal.code
            && selection.emissionRefusal.message === refusal.message
            && canonicalStructuralEquals(selection.fallback, parseFinalPayload(candidates));
        }
        if (selection.kind === "refused-call-no-fallback") {
          const baseline = parseFinalPayload(candidates);
          return !baseline.ok
            && selection.emissionRefusal.code === refusal.code
            && selection.emissionRefusal.message === refusal.message
            && canonicalStructuralEquals(selection.extraction, baseline.error);
        }
        return false; // never emission, never duplicate, never observation-refused
      }),
    );
  });

  it("accepts usable extraction over a refused call with the refusal retained and no retry consumed (AD-9)", () => {
    const selection = selectCanonicalPayload(
      REVIEWER_V2,
      observeEmissionCalls([frameOf(callOf(REVIEWER_V2, "call-1", INVALID_ARGUMENTS))]),
      USABLE_CANDIDATES,
    );
    expect(selection.kind).toBe("final-message-extraction");
    if (selection.kind === "final-message-extraction") {
      expect(selection.fallback.ok).toBe(true);
      expect(selection.emissionRefusal).toEqual(asRefusal(REVIEWER_REFUSED));
      expect(canonicalStructuralEquals(selection.fallback, parseFinalPayload(USABLE_CANDIDATES))).toBe(true);
    }
  });

  it("rejects once with BOTH causes retained when the refused call has no usable fallback (AD-9)", () => {
    const baseline = parseFinalPayload([]);
    expect(baseline.ok).toBe(false);
    const selection = selectCanonicalPayload(
      REVIEWER_V2,
      observeEmissionCalls([frameOf(callOf(REVIEWER_V2, "call-1", INVALID_ARGUMENTS))]),
      [],
    );
    expect(selection.kind).toBe("refused-call-no-fallback");
    if (selection.kind === "refused-call-no-fallback" && !baseline.ok) {
      expect(selection.emissionRefusal).toEqual(asRefusal(REVIEWER_REFUSED));
      expect(canonicalStructuralEquals(selection.extraction, baseline.error)).toBe(true);
      expect(selection.extraction.reason).toBe("no-final-payload");
    }
  });

  it("rejects ambiguity for two distinct calls — validity-blind, even with valid final text (FR-007/AS-019)", () => {
    fc.assert(
      fc.property(invalidArgsArb, invalidArgsArb, candidatesArb, (argsA, argsB, candidates) => {
        const first = frameOf(callOf(REVIEWER_V2, "call-a", argsA));
        const second = frameOf(callOf(REVIEWER_V2, "call-b", argsB));
        const selection = selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls([first, second]), candidates);
        expect(selection).toEqual({ kind: "duplicate-emission-call" });
      }),
    );
  });

  it("rejects a refused-then-corrected pair in either order, and identical arguments under different call ids", () => {
    const invalid = frameOf(callOf(REVIEWER_V2, "call-a", INVALID_ARGUMENTS));
    const valid = frameOf(callOf(REVIEWER_V2, "call-b", validReviewerArguments("the registry")));
    expect(selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls([invalid, valid]), USABLE_CANDIDATES))
      .toEqual({ kind: "duplicate-emission-call" });
    expect(selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls([valid, invalid]), USABLE_CANDIDATES))
      .toEqual({ kind: "duplicate-emission-call" });

    const sameArgs = validReviewerArguments("the registry");
    const identicalA = frameOf(callOf(REVIEWER_V2, "call-a", sameArgs));
    const identicalB = frameOf(callOf(REVIEWER_V2, "call-b", structuredClone(sameArgs)));
    expect(selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls([identicalA, identicalB]), USABLE_CANDIDATES))
      .toEqual({ kind: "duplicate-emission-call" });
  });

  it("selects a replayed single call identically to the un-replayed observation (AD-9 replay row)", () => {
    const call = frameOf(callOf(REVIEWER_V2, "call-1", REVIEWER_PAYLOAD_EXAMPLE_V2));
    const replayed = structuredClone(call);
    expect(
      canonicalStructuralEquals(
        selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls([call, replayed]), USABLE_CANDIDATES),
        selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls([call]), USABLE_CANDIDATES),
      ),
    ).toBe(true);
  });

  it("refuses each misbinding with its own closed code and a diagnostic naming the call (FR-014)", () => {
    const call = callOf(REVIEWER_V2, "call-1", INVALID_ARGUMENTS);
    const wrongRequest = selectCanonicalPayload(
      REVIEWER_V2,
      observeEmissionCalls([frameOf({ ...call, requestId: OTHER_REQUEST_ID })]),
      USABLE_CANDIDATES,
    );
    expect(wrongRequest).toEqual({
      kind: "observation-refused",
      refusal: {
        code: "wrong-request",
        message: expect.stringContaining(OTHER_REQUEST_ID),
      },
    });

    const unexpectedVersion = selectCanonicalPayload(
      REVIEWER_V2,
      observeEmissionCalls([frameOf({ ...call, version: "v3" })]),
      USABLE_CANDIDATES,
    );
    expect(unexpectedVersion).toEqual({
      kind: "observation-refused",
      refusal: { code: "unexpected-version", message: expect.stringContaining("v3") },
    });
  });

  it("refuses an unexpected producer kind instead of filtering it away or letting it self-decode (FR-014/AD-8)", () => {
    const judgeCall = {
      ...callOf(REVIEWER_V2, "call-j", validJudgeArguments("extensibility")),
      kind: Object.freeze({ kind: "judge-verdict" }) as PayloadProducerKind,
      version: "v1" as const,
    };
    const selection = selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls([frameOf(judgeCall)]), USABLE_CANDIDATES);
    expect(selection).toEqual({
      kind: "observation-refused",
      refusal: { code: "unexpected-kind", message: expect.stringContaining("judge-verdict") },
    });
  });

  it("refuses the misbound call before counting — a misbound call is never absorbed into ambiguity", () => {
    const judgeCall = {
      ...callOf(REVIEWER_V2, "call-j", INVALID_ARGUMENTS),
      kind: Object.freeze({ kind: "judge-verdict" }) as PayloadProducerKind,
      version: "v1" as const,
    };
    const reviewerCall = frameOf(callOf(REVIEWER_V2, "call-r", validReviewerArguments("the registry")));
    for (const calls of [[frameOf(judgeCall), reviewerCall], [reviewerCall, frameOf(judgeCall)]]) {
      const selection = selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls(calls), USABLE_CANDIDATES);
      expect(selection).toEqual({
        kind: "observation-refused",
        refusal: { code: "unexpected-kind", message: expect.stringContaining("judge-verdict") },
      });
    }
  });

  it("refuses an unusable observation before counting — incompleteness is never absorbed into ambiguity", () => {
    const validA = frameOf(callOf(REVIEWER_V2, "call-a", validReviewerArguments("the registry")));
    const validB = frameOf(callOf(REVIEWER_V2, "call-b", validReviewerArguments("second registry")));
    const selection = selectCanonicalPayload(
      REVIEWER_V2,
      observeEmissionCalls([incompleteFrame("call-x", "stream interrupted"), validA, validB]),
      USABLE_CANDIDATES,
    );
    expect(selection).toEqual({
      kind: "observation-refused",
      refusal: { code: "unusable-observation", message: expect.stringContaining("call-x") },
    });
  });

  it("projects adapter provenance beyond the contract fields — the selection is a function of the contract only", () => {
    const base = callOf(REVIEWER_V2, "call-1", REVIEWER_PAYLOAD_EXAMPLE_V2);
    const withProvenance = { ...base, agent: "code-reviewer", observedAt: "t1" };
    const fromBase = selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls([frameOf(base)]), []);
    const fromFull = selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls([{ kind: "complete", call: withProvenance }]), []);
    expect(fromFull.kind).toBe("emission-tool-arguments");
    expect(canonicalStructuralEquals(fromFull, fromBase)).toBe(true);
  });

  it("is deterministic over arbitrary frame lists and candidates", () => {
    fc.assert(
      fc.property(framesArb, candidatesArb, (frames, candidates) => {
        const observation = observeEmissionCalls(frames);
        expect(
          canonicalStructuralEquals(
            selectCanonicalPayload(REVIEWER_V2, observation, candidates),
            selectCanonicalPayload(REVIEWER_V2, observation, candidates),
          ),
        ).toBe(true);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// selectVerdictSource — the verdict paths' AD-9 matrix
// ---------------------------------------------------------------------------


describe("selectVerdictSource", () => {
  it("leaves the caller's rawJson standing with zero calls — the no-op baseline with no retained refusal", () => {
    const selection = selectVerdictSource(JUDGE_V1, ABSENT, "the captured attempt bytes");
    expect(selection).toEqual({
      kind: "final-message-extraction",
      rawJson: "the captured attempt bytes",
      source: "extraction",
      emissionRefusal: null,
    });
  });

  it("wins with the deterministically serialized arguments and the accepted call's provenance", () => {
    const args = validJudgeArguments("extensibility");
    const selection = selectVerdictSource(
      JUDGE_V1,
      observeEmissionCalls([frameOf(callOf(JUDGE_V1, "call-3", args))]),
      "prose around the payload",
    );
    expect(selection.kind).toBe("emission-tool-arguments");
    if (selection.kind === "emission-tool-arguments") {
      expect(selection.source).toBe("emission-tool");
      expect(JSON.parse(selection.rawJson)).toEqual(args);
      expect(selection.call).toEqual({
        requestId: REQUEST_ID,
        toolCallId: "call-3",
        kind: { kind: "judge-verdict" },
        version: "v1",
        arguments: args,
      });
    }
  });

  it("serves the refutation kind through its own binding with the same matrix", () => {
    const args = validRefutationArguments("reproduction");
    const selection = selectVerdictSource(
      REFUTATION_V1,
      observeEmissionCalls([frameOf(callOf(REFUTATION_V1, "call-4", args))]),
      "prose",
    );
    expect(selection.kind).toBe("emission-tool-arguments");
    if (selection.kind === "emission-tool-arguments") expect(JSON.parse(selection.rawJson)).toEqual(args);
  });

  it("retains the single refused call's refusal on the extraction arm — the submission seam decides usability", () => {
    const selection = selectVerdictSource(
      JUDGE_V1,
      observeEmissionCalls([frameOf(callOf(JUDGE_V1, "call-1", { criterion: "x", rankings: [] }))]),
      "the captured attempt bytes",
    );
    expect(selection).toEqual({
      kind: "final-message-extraction",
      rawJson: "the captured attempt bytes",
      source: "extraction",
      emissionRefusal: asRefusal(JUDGE_REFUSED),
    });
  });

  it("rejects two distinct verdict calls as ambiguity even with a final message", () => {
    const first = frameOf(callOf(JUDGE_V1, "call-a", validJudgeArguments("extensibility")));
    const second = frameOf(callOf(JUDGE_V1, "call-b", validJudgeArguments("reproduction")));
    expect(selectVerdictSource(JUDGE_V1, observeEmissionCalls([first, second]), "final message"))
      .toEqual({ kind: "duplicate-emission-call" });
  });

  it("folds an exact verdict-call replay back to a single call", () => {
    const call = frameOf(callOf(JUDGE_V1, "call-1", validJudgeArguments("extensibility")));
    const selection = selectVerdictSource(JUDGE_V1, observeEmissionCalls([call, structuredClone(call)]), "raw");
    expect(selection.kind).toBe("emission-tool-arguments");
  });

  it("refuses contradictory verdict frames sharing one call identity", () => {
    const call = frameOf(callOf(JUDGE_V1, "call-1", validJudgeArguments("extensibility")));
    const contradictory = frameOf({ ...call.call, arguments: validJudgeArguments("reproduction") });
    const selection = selectVerdictSource(JUDGE_V1, observeEmissionCalls([call, contradictory]), "raw");
    expect(selection).toEqual({
      kind: "observation-refused",
      refusal: { code: "unusable-observation", message: expect.stringContaining("call-1") },
    });
  });

  it("refuses a reviewer-payload call in a judge attempt — unexpected kind, never consulted, never absence (FR-014)", () => {
    const reviewerCall = {
      ...callOf(JUDGE_V1, "call-r", REVIEWER_PAYLOAD_EXAMPLE_V2),
      kind: Object.freeze({ kind: "reviewer-payload" }) as PayloadProducerKind,
      version: "v2" as const,
    };
    const selection = selectVerdictSource(JUDGE_V1, observeEmissionCalls([frameOf(reviewerCall)]), "the captured attempt bytes");
    expect(selection).toEqual({
      kind: "observation-refused",
      refusal: { code: "unexpected-kind", message: expect.stringContaining("reviewer-payload") },
    });
  });

  it("refuses a misbound verdict call before counting — one judge and one refutation call refuses as unexpected-kind", () => {
    // Supersedes the old kind-filtered expectation that the "verdict count
    // spans both verdict kinds": under the issued binding one attempt is ONE
    // kind (AD-6), so the off-kind call is a misbinding refusal (FR-014),
    // checked before the count and in either scan order.
    const judgeCall = frameOf(callOf(JUDGE_V1, "call-j", validJudgeArguments("extensibility")));
    const refutationCall = {
      ...callOf(JUDGE_V1, "call-f", validRefutationArguments("reproduction")),
      kind: Object.freeze({ kind: "refutation-verdict" }) as PayloadProducerKind,
      version: "v1" as const,
    };
    for (const calls of [[frameOf(refutationCall), judgeCall], [judgeCall, frameOf(refutationCall)]]) {
      const selection = selectVerdictSource(JUDGE_V1, observeEmissionCalls(calls), "raw");
      expect(selection).toEqual({
        kind: "observation-refused",
        refusal: { code: "unexpected-kind", message: expect.stringContaining("refutation-verdict") },
      });
    }
  });

  it("refuses a wrong-request verdict call and an unexpected verdict schema version", () => {
    const call = callOf(JUDGE_V1, "call-1", validJudgeArguments("extensibility"));
    const wrongRequest = selectVerdictSource(
      JUDGE_V1,
      observeEmissionCalls([frameOf({ ...call, requestId: OTHER_REQUEST_ID })]),
      "raw",
    );
    expect(wrongRequest).toEqual({
      kind: "observation-refused",
      refusal: { code: "wrong-request", message: expect.stringContaining(OTHER_REQUEST_ID) },
    });

    const unexpectedVersion = selectVerdictSource(
      JUDGE_V1,
      observeEmissionCalls([frameOf({ ...call, version: "v2" })]),
      "raw",
    );
    expect(unexpectedVersion).toEqual({
      kind: "observation-refused",
      refusal: { code: "unexpected-version", message: expect.stringContaining("v2") },
    });
  });
});

// ---------------------------------------------------------------------------
// Type-level pins
// ---------------------------------------------------------------------------

/** The fallback DomainResult is carried verbatim on the union (PR #52). */
const _fallbackIsDomainResult: (
  selection: Extract<IngestionSelection, { kind: "final-message-extraction" }>,
) => DomainResult<FinalPayload, CaptureRejection> = (selection) => selection.fallback;
void _fallbackIsDomainResult;

/** The retained single-call refusal rides the extraction arms of both paths. */
const _refusalIsRetained: (
  selection: Extract<VerdictSourceSelection, { kind: "final-message-extraction" }>,
) => EmissionParseFailure | null = (selection) => selection.emissionRefusal;
void _refusalIsRetained;

/** Type-level path scoping (AD-8): a binding minted for one ingestion path
 *  cannot be passed to the other — the misbinding is a compile error, not a
 *  runtime check a caller could forget. */
const _misScopedVerdict: VerdictSourceSelection =
  // @ts-expect-error the reviewer-payload refinement is not a verdict-kind binding
  selectVerdictSource(REVIEWER_V2, ABSENT, "raw");
void _misScopedVerdict;

const _misScopedCanonical: IngestionSelection =
  // @ts-expect-error the judge-verdict refinement is not a reviewer-payload binding
  selectCanonicalPayload(JUDGE_V1, ABSENT, []);
void _misScopedCanonical;
