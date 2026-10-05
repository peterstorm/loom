import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createHash } from "node:crypto";
import {
  selectCanonicalPayload,
  selectVerdictSource,
  type IngestionSelection,
  type VerdictSourceSelection,
} from "../../src/core/emission-ingestion";
import {
  admitEmissionArguments,
  EMISSION_TOOL_SPECS,
  issueEmissionBinding,
  type EmissionArgumentAdmission,
  type EmissionParseFailure,
  type EmissionSchemaVersion,
  type IssuedEmissionBinding,
  type IssuedEmissionBindingOf,
} from "../../src/core/emission-tool";
import {
  canonicalCall,
  observeEmissionCalls,
  parseFinalPayload,
  type CaptureRejection,
  type EmissionCallFrame,
  type EmissionToolCall,
  type FinalPayload,
} from "../../src/core/harness-capture";
import {
  canonicalStructuralEquals,
  type ArtifactDigest,
  type DomainResult,
} from "../../src/core/orchestration-contract/identity";
import { sha256Hex } from "../../src/core/digest";
import type { PayloadProducerKind, PayloadProducerKindName } from "../../src/core/model-profiles";
import { standaloneReviewerPayloadV3Schema } from "../../src/core/standalone-lineage-contract";
import { parseStandaloneReviewerPayloadV3 } from "../../src/core/reviewer-protocol";
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
const REVIEWER_V3 = mustMint({ requestId: REQUEST_ID, kind: "reviewer-payload", version: "v3" });
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

  it("refuses an out-of-vocabulary producer kind in vocabulary instead of crashing (the mint's refusal contract)", () => {
    const refused = issueEmissionBinding({
      requestId: REQUEST_ID,
      // The exact shape a plain-string claims parser narrowed by cast would
      // mint: a misspelled kind that selects no registry cell.
      kind: "reviewr-payload" as PayloadProducerKindName,
      version: "v2",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("unknown-producer-kind");
      expect(refused.error.message).toContain("reviewr-payload");
    }
  });

  it("refuses a claimed version outside the closed schema-version vocabulary before any registry lookup", () => {
    const refused = issueEmissionBinding({ requestId: REQUEST_ID, kind: "judge-verdict", version: "v9" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("unsupported-schema-version");
      expect(refused.error.message).toContain("v9");
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

  it("refuses contradictory frames sharing one call identity, naming the first differing contract field (FR-007)", () => {
    const call = callOf(REVIEWER_V2, "call-1", validReviewerArguments("the registry"));
    for (const [field, variant] of [
      ["arguments", { ...call, arguments: { different: "arguments" } }],
      ["requestId", { ...call, requestId: OTHER_REQUEST_ID }],
      ["kind", { ...call, kind: Object.freeze({ kind: "judge-verdict" }) as PayloadProducerKind }],
      ["version", { ...call, version: "v3" as const }],
    ] as const) {
      const observation = observeEmissionCalls([frameOf(call), frameOf(variant)]);
      expect(observation.kind).toBe("unusable");
      if (observation.kind === "unusable") {
        expect(observation.reason).toBe(
          `contradictory duplicate transport frames for emission tool call call-1 (differing: ${field})`,
        );
      }
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
    const observation = observeEmissionCalls([frameOf(call)]);
    expect(observation.kind).toBe("unusable");
    if (observation.kind === "unusable") {
      // The refusal names the OBSERVED producer kind: the operator journal
      // identifies which family's calls cannot be bound without re-opening
      // the transcript — the reason is the diagnostic, not a bare tag.
      expect(observation.reason).toContain("reviewer-payload");
      expect(observation.reason).toContain("empty tool-call identity");
    }
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

  it("the baseline arm's RUNTIME value matches its declared shape — no refusal key, twin-arm symmetry", () => {
    // The declared arm, its doc comment and the compile pin below all say the
    // field is unrepresentable on the baseline; this pin proves the runtime
    // record agrees — a vestigial key is invisible through the declared type,
    // and the round-8 arm split left exactly such a key on this constructor.
    const selection = selectCanonicalPayload(REVIEWER_V2, ABSENT, []);
    expect(selection.kind).toBe("final-message-extraction");
    if (selection.kind === "final-message-extraction") {
      expect(Object.hasOwn(selection, "emissionRefusal")).toBe(false);
      expect(Object.keys(selection).sort()).toEqual(["fallback", "kind", "source"]);
    }
    // Twin-arm symmetry: the verdict path's baseline arm carries the same
    // three-key shape modulo its own payload field names.
    const verdict = selectVerdictSource(JUDGE_V1, ABSENT, "the captured attempt bytes");
    expect(verdict).toEqual({
      kind: "final-message-extraction",
      rawJson: "the captured attempt bytes",
      source: "extraction",
    });
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
        if (selection.kind === "extraction-over-refused-call") {
          return selection.emissionRefusal.code === refusal.code
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
    expect(selection.kind).toBe("extraction-over-refused-call");
    if (selection.kind === "extraction-over-refused-call") {
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
        expect(selection.kind).toBe("duplicate-emission-call");
        if (selection.kind === "duplicate-emission-call") {
          expect(selection.calls).toEqual([canonicalCall(first.call), canonicalCall(second.call)]);
        }
      }),
    );
  });

  it("rejects a refused-then-corrected pair in either order, and identical arguments under different call ids", () => {
    const invalid = frameOf(callOf(REVIEWER_V2, "call-a", INVALID_ARGUMENTS));
    const valid = frameOf(callOf(REVIEWER_V2, "call-b", validReviewerArguments("the registry")));
    expect(selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls([invalid, valid]), USABLE_CANDIDATES))
      .toMatchObject({ kind: "duplicate-emission-call" });
    expect(selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls([valid, invalid]), USABLE_CANDIDATES))
      .toMatchObject({ kind: "duplicate-emission-call" });

    const sameArgs = validReviewerArguments("the registry");
    const identicalA = frameOf(callOf(REVIEWER_V2, "call-a", sameArgs));
    const identicalB = frameOf(callOf(REVIEWER_V2, "call-b", structuredClone(sameArgs)));
    expect(selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls([identicalA, identicalB]), USABLE_CANDIDATES))
      .toMatchObject({ kind: "duplicate-emission-call" });
  });

  it("carries the ambiguity's observed calls on the duplicate arm in first-observed order — the rejection names what was observed (FR-007)", () => {
    const first = frameOf(callOf(REVIEWER_V2, "call-a", INVALID_ARGUMENTS));
    const second = frameOf(callOf(REVIEWER_V2, "call-b", validReviewerArguments("the registry")));
    const selection = selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls([first, second]), USABLE_CANDIDATES);
    expect(selection.kind).toBe("duplicate-emission-call");
    if (selection.kind === "duplicate-emission-call") {
      expect(selection.calls).toEqual([canonicalCall(first.call), canonicalCall(second.call)]);
      expect(Object.isFrozen(selection.calls)).toBe(true);
    }

    // The verdict path crosses the same shared decision — its duplicate arm
    // carries the same first-observed-order calls contract.
    const verdict = selectVerdictSource(
      JUDGE_V1,
      observeEmissionCalls([
        frameOf(callOf(JUDGE_V1, "call-a", validJudgeArguments("extensibility"))),
        frameOf(callOf(JUDGE_V1, "call-b", validJudgeArguments("reproduction"))),
      ]),
      "raw",
    );
    expect(verdict.kind).toBe("duplicate-emission-call");
    if (verdict.kind === "duplicate-emission-call") {
      expect(verdict.calls.map(({ toolCallId }) => toolCallId)).toEqual(["call-a", "call-b"]);
    }
  });

  it("pins the FR-014 misbinding check order — request attempt, then producer kind, then schema version", () => {
    // All three misbindings at once: the FIRST check in FR-014 order names the
    // refusal. This pin is what stops the order silently reordering — a call
    // misbound in request AND kind AND version must never surface as an
    // unexpected-version (or kind) refusal.
    const reviewerCall = callOf(REVIEWER_V2, "call-1", INVALID_ARGUMENTS);
    const allThree = selectCanonicalPayload(
      REVIEWER_V2,
      observeEmissionCalls([frameOf({
        ...reviewerCall,
        requestId: OTHER_REQUEST_ID,
        kind: Object.freeze({ kind: "judge-verdict" }) as PayloadProducerKind,
        version: "v1" as const,
      })]),
      USABLE_CANDIDATES,
    );
    expect(allThree).toMatchObject({
      kind: "observation-refused",
      refusal: { code: "wrong-request", message: expect.stringContaining(OTHER_REQUEST_ID) },
    });

    // Kind and version together: kind is checked before version.
    const kindAndVersion = selectCanonicalPayload(
      REVIEWER_V2,
      observeEmissionCalls([frameOf({
        ...reviewerCall,
        kind: Object.freeze({ kind: "judge-verdict" }) as PayloadProducerKind,
        version: "v1" as const,
      })]),
      USABLE_CANDIDATES,
    );
    expect(kindAndVersion).toMatchObject({
      kind: "observation-refused",
      refusal: { code: "unexpected-kind", message: expect.stringContaining("judge-verdict") },
    });

    // The verdict path crosses the same shared decision — the same order
    // there, with the version misbinding alone still naming the version.
    const judgeCall = callOf(JUDGE_V1, "call-j", INVALID_ARGUMENTS);
    const verdictAllThree = selectVerdictSource(
      JUDGE_V1,
      observeEmissionCalls([frameOf({
        ...judgeCall,
        requestId: OTHER_REQUEST_ID,
        kind: Object.freeze({ kind: "reviewer-payload" }) as PayloadProducerKind,
        version: "v2" as const,
      })]),
      "raw",
    );
    expect(verdictAllThree).toMatchObject({
      kind: "observation-refused",
      refusal: { code: "wrong-request", message: expect.stringContaining(OTHER_REQUEST_ID) },
    });
    const verdictKindAndVersion = selectVerdictSource(
      JUDGE_V1,
      observeEmissionCalls([frameOf({
        ...judgeCall,
        kind: Object.freeze({ kind: "reviewer-payload" }) as PayloadProducerKind,
        version: "v2" as const,
      })]),
      "raw",
    );
    expect(verdictKindAndVersion).toMatchObject({
      kind: "observation-refused",
      refusal: { code: "unexpected-kind", message: expect.stringContaining("reviewer-payload") },
    });
  });

  it("refuses contradictory duplicate frames on the reviewer path as an unusable observation — never a count, never absence (FR-007/AD-9)", () => {
    // The verdict path's contradictory-frame counterpart is pinned above; this
    // is the reviewer-path half: the same fold refuses before the count, so
    // contradictory duplicate frames reach the selection as an
    // observation-refused — never reclassified as one call, never absorbed
    // into ambiguity, never rescued by usable final candidates.
    const base = callOf(REVIEWER_V2, "call-1", INVALID_ARGUMENTS);
    const contradictory = frameOf({ ...base, arguments: { different: "arguments" } });
    for (const frames of [
      [frameOf(base), contradictory],
      [contradictory, frameOf(base)],
    ]) {
      const selection = selectCanonicalPayload(REVIEWER_V2, observeEmissionCalls(frames), USABLE_CANDIDATES);
      expect(selection).toMatchObject({
        kind: "observation-refused",
        refusal: {
          code: "unusable-observation",
          message: expect.stringContaining("call-1"),
        },
      });
    }
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
  it("leaves the caller's rawJson standing with zero calls — the no-op baseline arm carries no refusal field", () => {
    const selection = selectVerdictSource(JUDGE_V1, ABSENT, "the captured attempt bytes");
    expect(selection).toEqual({
      kind: "final-message-extraction",
      rawJson: "the captured attempt bytes",
      source: "extraction",
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

  it("retains the single refused call's refusal on its own arm — the submission seam decides usability", () => {
    const selection = selectVerdictSource(
      JUDGE_V1,
      observeEmissionCalls([frameOf(callOf(JUDGE_V1, "call-1", { criterion: "x", rankings: [] }))]),
      "the captured attempt bytes",
    );
    expect(selection).toEqual({
      kind: "extraction-over-refused-call",
      rawJson: "the captured attempt bytes",
      source: "extraction",
      emissionRefusal: asRefusal(JUDGE_REFUSED),
    });
  });

  it("rejects two distinct verdict calls as ambiguity even with a final message", () => {
    const first = frameOf(callOf(JUDGE_V1, "call-a", validJudgeArguments("extensibility")));
    const second = frameOf(callOf(JUDGE_V1, "call-b", validJudgeArguments("reproduction")));
    expect(selectVerdictSource(JUDGE_V1, observeEmissionCalls([first, second]), "final message"))
      .toMatchObject({ kind: "duplicate-emission-call" });
  });

  it("folds an exact verdict-call replay back to a single call", () => {
    const call = frameOf(callOf(JUDGE_V1, "call-1", validJudgeArguments("extensibility")));
    const selection = selectVerdictSource(JUDGE_V1, observeEmissionCalls([call, structuredClone(call)]), "raw");
    expect(selection.kind).toBe("emission-tool-arguments");
  });

  it("refuses an incomplete frame's unusable observation before counting — never absence, never absorbed (AD-8/FR-014)", () => {
    // The refusal row's "incomplete" half driven through the verdict selection
    // (its reviewer-path counterpart covers the reviewer path): the shared
    // decision refuses before counting, so an incomplete observation beside a
    // valid call is a typed refusal in either scan order — never reclassified
    // as absence, never absorbed into ambiguity, never rescued by the valid
    // call.
    const validJudge = frameOf(callOf(JUDGE_V1, "call-j", validJudgeArguments("extensibility")));
    for (const frames of [
      [incompleteFrame("call-x", "stream interrupted")],
      [validJudge, incompleteFrame("call-x", "stream interrupted")],
      [incompleteFrame("call-x", "stream interrupted"), validJudge],
    ]) {
      const selection = selectVerdictSource(JUDGE_V1, observeEmissionCalls(frames), "raw");
      expect(selection).toEqual({
        kind: "observation-refused",
        refusal: { code: "unusable-observation", message: expect.stringContaining("call-x") },
      });
    }
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
// Phase-2 discriminating acceptance: whitespace-only schema-vs-parser disagreement
// ---------------------------------------------------------------------------

/**
 * AD-5's discriminating case as selection behavior: whitespace-only advisory
 * prose passes Pi's frozen JSON Schema validation (the emitted bytes express
 * shape only — minLength — and never the zod refinements) but fails the
 * engine's admission. The pi-validation half is pinned by the real-Pi suite
 * (engine/tests/pi/emission-tool.test.ts) through the REAL
 * `validateToolArguments`; this suite pins the engine half: the harness-valid
 * call is a REFUSED call at the selection, never an ingested payload — and the
 * refusal is retained on whichever extraction arm the final candidates allow.
 */
const whitespaceOnlyArguments = (kind: PayloadProducerKindName): unknown => {
  switch (kind) {
    case "reviewer-payload": {
      const finding = reviewerPayloadV2Schema.parse({
        schemaVersion: 2,
        kind: "standalone-review",
        findings: [{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim: "real claim" }],
      }).findings[0]!;
      return { schemaVersion: 2, kind: "standalone-review", findings: [{ ...finding, claim: "   " }] };
    }
    case "judge-verdict":
      return {
        criterion: "extensibility",
        rankings: [{ candidate: "candidate-type-driven-fp.md", score: 8, fatal_flaw: null, strongest_idea: "   " }],
      };
    case "refutation-verdict":
      return {
        criterion: "reproduction",
        verdicts: [{ finding_id: "T1:code-reviewer-1", verdict: "refuted", reasoning: "   " }],
      };
  }
};

describe("whitespace-only schema-vs-parser disagreement (AD-5)", () => {
  it("refuses the whitespace-only call for every kind even though its shape passes the frozen JSON Schema", () => {
    for (const [kindName, spec] of Object.entries(EMISSION_TOOL_SPECS)) {
      for (const version of Object.keys(spec.schemaVersions)) {
        const admission = admitEmissionArguments(
          EMISSION_TOOL_SPECS[kindName as PayloadProducerKindName],
          version as EmissionSchemaVersion,
          whitespaceOnlyArguments(kindName as PayloadProducerKindName),
        );
        expect(admission.kind, `${kindName}/${version}`).toBe("refused");
      }
    }
  });

  it("selects usable extraction over the harness-valid-but-engine-refused call, refusal retained (FR-006)", () => {
    const binding = mustMint({ requestId: REQUEST_ID, kind: "reviewer-payload", version: "v2" });
    const call = callOf(binding, "call-w", whitespaceOnlyArguments("reviewer-payload"));
    const selection = selectCanonicalPayload(
      binding,
      observeEmissionCalls([frameOf(call)]),
      USABLE_CANDIDATES,
    );
    expect(selection.kind).toBe("extraction-over-refused-call");
    if (selection.kind === "extraction-over-refused-call") {
      expect(selection.emissionRefusal.code).toBe("invalid-payload");
      expect(canonicalStructuralEquals(selection.fallback, parseFinalPayload(USABLE_CANDIDATES))).toBe(true);
    }
  });

  it("rejects once with both causes when the whitespace-only call has no usable fallback (AD-9)", () => {
    const binding = mustMint({ requestId: REQUEST_ID, kind: "judge-verdict", version: "v1" });
    const call = callOf(binding, "call-w", whitespaceOnlyArguments("judge-verdict"));
    const selection = selectVerdictSource(binding, observeEmissionCalls([frameOf(call)]), "");
    expect(selection.kind).toBe("extraction-over-refused-call");
    if (selection.kind === "extraction-over-refused-call") {
      expect(selection.emissionRefusal.code).toBe("invalid-schema");
    }
  });

  it("pins the vocabulary's contract-field projection at its home: provenance beyond the five fields is folded away", () => {
    const base = callOf(REVIEWER_V2, "call-1", INVALID_ARGUMENTS);
    type ProvenancedCall = EmissionToolCall & Readonly<{ agent: string; observedAt: string }>;
    const provenanced: ProvenancedCall = { ...base, agent: "code-reviewer", observedAt: "t1" };
    expect(canonicalCall(provenanced)).toEqual(base);
    // The fold emits exactly this projection, so a hand-built observation with
    // provenance selects identically to the folded one (the selection is a
    // function of the contract fields only).
    const withProvenance = observeEmissionCalls([{ kind: "complete", call: provenanced }]);
    expect(canonicalStructuralEquals(withProvenance, observeEmissionCalls([frameOf(base)]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The binding-scoped admission's wire-form canonicalization (the transport
// parse at the ingestion boundary)
// ---------------------------------------------------------------------------

/** The recorded transport class the unconstrained local route produces: the
 *  transcript observes what the model emitted — JSON-encoded strings for
 *  declared non-string fields — while the child executed the canonical
 *  payload pi validated through `prepareArguments`. */
const wireFormOf = (payload: unknown): unknown => {
  const record = payload as Record<string, unknown>;
  const wire: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    wire[key] = typeof value === "number"
      ? JSON.stringify(value)
      : Array.isArray(value) || (typeof value === "object" && value !== null)
        ? JSON.stringify(value)
        : value;
  }
  return wire;
};

describe("the binding-scoped admission canonicalizes the observed wire form", () => {
  it("selects the recorded string-typed wire form as emission-tool-arguments with the canonical payload", () => {
    const wire = wireFormOf(REVIEWER_PAYLOAD_EXAMPLE_V2) as Record<string, unknown>;
    expect(wire["schemaVersion"]).toBe("2");
    expect(typeof wire["findings"]).toBe("string");
    const selection = selectCanonicalPayload(
      REVIEWER_V2,
      observeEmissionCalls([frameOf(callOf(REVIEWER_V2, "call-wire", wire))]),
      [],
    );
    expect(selection.kind).toBe("emission-tool-arguments");
    if (selection.kind === "emission-tool-arguments") {
      expect(canonicalStructuralEquals(JSON.parse(selection.payload.text), REVIEWER_PAYLOAD_EXAMPLE_V2)).toBe(true);
      // The provenance call keeps the OBSERVED transport form — the audit
      // trail records what the model emitted, not the canonicalization.
      expect(selection.call.arguments).toEqual(wire);
    }
  });

  it("canonicalizes the verdict path's observed wire form through its own binding", () => {
    const wire = wireFormOf(validJudgeArguments("extensibility"));
    const selection = selectVerdictSource(
      JUDGE_V1,
      observeEmissionCalls([frameOf(callOf(JUDGE_V1, "call-wire", wire))]),
      "the captured attempt bytes",
    );
    expect(selection.kind).toBe("emission-tool-arguments");
    if (selection.kind === "emission-tool-arguments") {
      expect(JSON.parse(selection.rawJson)).toEqual(validJudgeArguments("extensibility"));
    }
  });

  it("still refuses a wire form no declared type can accept — both causes retained, no invented fields", () => {
    const unparseable = { schemaVersion: "two", kind: "standalone-review", findings: "not json" };
    const selection = selectCanonicalPayload(
      REVIEWER_V2,
      observeEmissionCalls([frameOf(callOf(REVIEWER_V2, "call-unparseable", unparseable))]),
      [],
    );
    expect(selection.kind).toBe("refused-call-no-fallback");
    if (selection.kind === "refused-call-no-fallback") {
      expect(selection.emissionRefusal.code).toBe("invalid-payload");
      expect(selection.extraction.reason).toBe("no-final-payload");
    }
  });

  it("is idempotent over already-canonical observed arguments — the child-executed form selects identically", () => {
    const fromCanonical = selectCanonicalPayload(
      REVIEWER_V2,
      observeEmissionCalls([frameOf(callOf(REVIEWER_V2, "call-1", REVIEWER_PAYLOAD_EXAMPLE_V2))]),
      [],
    );
    const fromWire = selectCanonicalPayload(
      REVIEWER_V2,
      observeEmissionCalls([frameOf(callOf(REVIEWER_V2, "call-2", wireFormOf(REVIEWER_PAYLOAD_EXAMPLE_V2)))]),
      [],
    );
    expect(fromCanonical.kind).toBe("emission-tool-arguments");
    expect(fromWire.kind).toBe("emission-tool-arguments");
    if (fromCanonical.kind === "emission-tool-arguments" && fromWire.kind === "emission-tool-arguments") {
      expect(fromWire.payload.text).toBe(fromCanonical.payload.text);
      expect(fromWire.payload.digest).toBe(fromCanonical.payload.digest);
    }
  });
});

// ---------------------------------------------------------------------------
// The observed request id is parsed where it meets issued authority
// ---------------------------------------------------------------------------

describe("the observed request id is parsed at the binding check (FR-014)", () => {
  it.each([
    ["an empty id", ""],
    ["a non-canonical id", "request with spaces/../x"],
    ["the issued id with trailing whitespace", `${REQUEST_ID} `],
  ])("refuses %s as wrong-request — never absence, never a fallback — on both paths", (_label, requestId) => {
    const reviewer = selectCanonicalPayload(
      REVIEWER_V2,
      observeEmissionCalls([frameOf({ ...callOf(REVIEWER_V2, "call-malformed", validReviewerArguments("the registry")), requestId })]),
      USABLE_CANDIDATES,
    );
    expect(reviewer).toMatchObject({ kind: "observation-refused", refusal: { code: "wrong-request" } });
    const verdict = selectVerdictSource(
      JUDGE_V1,
      observeEmissionCalls([frameOf({ ...callOf(JUDGE_V1, "call-malformed", validJudgeArguments("extensibility")), requestId })]),
      "raw",
    );
    expect(verdict).toMatchObject({ kind: "observation-refused", refusal: { code: "wrong-request" } });
  });
});

// ---------------------------------------------------------------------------
// The selection's binding-certification invariant (AD-8: the expected
// kind/version/schema is CHECKED, never trusted)
// ---------------------------------------------------------------------------

/** The mint stamps the exact tool name and the frozen bytes' digest, and the
 *  binding type is NOMINAL: only `issueEmissionBinding` produces one, so an
 *  uncertified digest or tool name cannot reach the selection — and therefore
 *  can never flow into the accepted call's journal provenance as if it were the
 *  issued schema identity. The certification is a compile-time fact; these
 *  pins fail to type-check (the `@ts-expect-error` goes unused) the moment a
 *  forged record would be accepted. */
describe("the selection's binding-certification invariant", () => {
  it("rejects a spread-forged schema digest at compile time — the selection never receives an uncertified binding", () => {
    const forgedDigest = { ...REVIEWER_V2, schemaDigest: "0".repeat(64) as ArtifactDigest };
    const call = frameOf(callOf(REVIEWER_V2, "call-cert", validReviewerArguments("the registry")));
    // @ts-expect-error a spread copy of a minted binding is not a minted binding
    const reviewerForgery = (): IngestionSelection => selectCanonicalPayload(forgedDigest, observeEmissionCalls([call]), USABLE_CANDIDATES);

    const forgedVerdict = { ...JUDGE_V1, schemaDigest: "f".repeat(64) as ArtifactDigest };
    // @ts-expect-error a spread copy of a minted binding is not a minted binding
    const verdictForgery = (): VerdictSourceSelection => selectVerdictSource(forgedVerdict, observeEmissionCalls([]), "raw");
    expect([reviewerForgery, verdictForgery]).toHaveLength(2);
  });

  it("rejects a binding that claims another cell's tool name, or a hand-built record, at compile time", () => {
    const forgedTool = { ...JUDGE_V1, toolName: EMISSION_TOOL_SPECS["reviewer-payload"].toolName };
    // @ts-expect-error the exact tool name is part of the minted, issued contract
    const toolForgery = (): VerdictSourceSelection => selectVerdictSource(forgedTool, observeEmissionCalls([]), "raw");
    // @ts-expect-error an object literal can never carry the mint's nominal brand
    const literal: IssuedEmissionBinding = {
      requestId: JUDGE_V1.requestId, kind: JUDGE_V1.kind, version: JUDGE_V1.version, toolName: JUDGE_V1.toolName, schemaDigest: JUDGE_V1.schemaDigest,
    };
    expect([toolForgery, literal]).toHaveLength(2);
  });

  it("admits through every minted registry cell — the positive control over the compile-time certification", () => {
    const v3Arguments = standaloneReviewerPayloadV3Schema.parse({
      schemaVersion: 3,
      kind: "standalone-successor-review",
      lineageDigest: "a".repeat(64),
      snapshotDigest: "b".repeat(64),
      priorAssessments: [],
      findings: [],
    });
    // Per-path thunks: the path scoping is a type fact, so each control mints
    // its own binding literal and crosses its own selection entry.
    const positiveControls: readonly (readonly [string, () => IngestionSelection | VerdictSourceSelection])[] = [
      ["reviewer-payload/v2", () => {
        const minted = mustMint({ requestId: REQUEST_ID, kind: "reviewer-payload", version: "v2" });
        return selectCanonicalPayload(
          minted,
          observeEmissionCalls([frameOf(callOf(minted, "call-ok", validReviewerArguments("the registry")))]),
          [],
        );
      }],
      ["reviewer-payload/v3", () => {
        const minted = mustMint({ requestId: REQUEST_ID, kind: "reviewer-payload", version: "v3" });
        return selectCanonicalPayload(
          minted,
          observeEmissionCalls([frameOf(callOf(minted, "call-ok", v3Arguments))]),
          [],
        );
      }],
      ["judge-verdict/v1", () => {
        const minted = mustMint({ requestId: REQUEST_ID, kind: "judge-verdict", version: "v1" });
        return selectVerdictSource(
          minted,
          observeEmissionCalls([frameOf(callOf(minted, "call-ok", validJudgeArguments("extensibility")))]),
          "raw",
        );
      }],
      ["refutation-verdict/v1", () => {
        const minted = mustMint({ requestId: REQUEST_ID, kind: "refutation-verdict", version: "v1" });
        return selectVerdictSource(
          minted,
          observeEmissionCalls([frameOf(callOf(minted, "call-ok", validRefutationArguments("reproduction")))]),
          "raw",
        );
      }],
    ];
    for (const [label, select] of positiveControls) {
      expect(select().kind, label).toBe("emission-tool-arguments");
    }
  });
});

// ---------------------------------------------------------------------------
// The verdict extraction arms preserve the existing raw input byte-verbatim
// (AD-8: the verdict extraction arm preserves the existing raw input)
// ---------------------------------------------------------------------------

describe("the verdict extraction arms preserve the existing raw input byte-verbatim", () => {
  const whitespaceSignificantRawJson = `  \n\t{"criterion":"extensibility","rankings":[]}\u00a0`;

  it("returns the caller's rawJson byte-verbatim on both extraction arms — unicode and surrounding whitespace included", () => {
    const baseline = selectVerdictSource(JUDGE_V1, ABSENT, whitespaceSignificantRawJson);
    expect(baseline).toEqual({
      kind: "final-message-extraction",
      rawJson: whitespaceSignificantRawJson,
      source: "extraction",
    });

    const overRefused = selectVerdictSource(
      JUDGE_V1,
      observeEmissionCalls([frameOf(callOf(JUDGE_V1, "call-1", { criterion: "x", rankings: [] }))]),
      whitespaceSignificantRawJson,
    );
    expect(overRefused.kind).toBe("extraction-over-refused-call");
    if (overRefused.kind === "extraction-over-refused-call") {
      expect(overRefused.rawJson).toBe(whitespaceSignificantRawJson);
      // Byte-verbatim, not merely string-equal-by-coincidence: the UTF-8
      // encoding of what the arm returns is the encoding of what went in.
      expect(new TextEncoder().encode(overRefused.rawJson)).toEqual(new TextEncoder().encode(whitespaceSignificantRawJson));
    }
  });

  it("freezes the verdict duplicate arm's retained calls — parity with the reviewer path's ambiguity content", () => {
    const first = frameOf(callOf(JUDGE_V1, "call-a", validJudgeArguments("extensibility")));
    const second = frameOf(callOf(JUDGE_V1, "call-b", validJudgeArguments("reproduction")));
    const selection = selectVerdictSource(JUDGE_V1, observeEmissionCalls([first, second]), "raw");
    expect(selection.kind).toBe("duplicate-emission-call");
    if (selection.kind === "duplicate-emission-call") {
      expect(selection.calls.map(({ toolCallId }) => toolCallId)).toEqual(["call-a", "call-b"]);
      expect(Object.isFrozen(selection.calls)).toBe(true);
    }
  });

  it("carries any caller rawJson verbatim through the zero-call arm — the verdict containment law's baseline (property)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (rawJson) => {
        const selection = selectVerdictSource(JUDGE_V1, ABSENT, rawJson);
        return (
          selection.kind === "final-message-extraction" &&
          selection.rawJson === rawJson &&
          selection.source === "extraction"
        );
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The successor v3 reviewer path rides the shared selection kernel (T9)
// ---------------------------------------------------------------------------

/** A schema-valid successor v3 payload as emission arguments. The lineage
 *  digests are fixture-local; the successor's OWN joins re-check them
 *  against the prepared successor (the successor suites), so the kernel
 *  selection only ever sees the parser's verdict. */
const v3Arguments = (overrides: Record<string, unknown> = {}): unknown =>
  standaloneReviewerPayloadV3Schema.parse({
    schemaVersion: 3,
    kind: "standalone-successor-review",
    lineageDigest: "a".repeat(64),
    snapshotDigest: "b".repeat(64),
    priorAssessments: [],
    findings: [],
    ...overrides,
  });

/** The engine-refined v3 refusal fixtures, built as RAW argument objects —
 *  they are invalid BY the engine-only refinements, so the schema parse must
 *  never mint them. Whitespace-only prose and an authored finding id both
 *  pass the frozen JSON Schema's shape checks and must still refuse (AS-018). */
const v3WhitespaceRefusal = (): Record<string, unknown> => ({
  schemaVersion: 3,
  kind: "standalone-successor-review",
  lineageDigest: "a".repeat(64),
  snapshotDigest: "b".repeat(64),
  priorAssessments: [],
  findings: [{ draft: { severity: "advisory", file: null, line: null, claim: "Distinct v3 assertion", reason: "   " }, relation: { kind: "independent" } }],
});
const v3AuthoredIdRefusal = (): Record<string, unknown> => ({
  ...v3WhitespaceRefusal(),
  findings: [{ draft: { severity: "advisory", file: null, line: null, claim: "Authored id", reason: "Useful, nonblocking improvement." }, relation: { kind: "independent" }, id: "chosen-1" }],
});

/** The wire form routes without server-side constrained decoding emit:
 *  declared non-string fields serialized as JSON-encoded strings. */
const wireFormOfV3 = (value: unknown): unknown => {
  const record = value as Record<string, unknown>;
  return {
    schemaVersion: "3",
    kind: record["kind"],
    lineageDigest: record["lineageDigest"],
    snapshotDigest: record["snapshotDigest"],
    priorAssessments: JSON.stringify(record["priorAssessments"]),
    findings: JSON.stringify(record["findings"]),
  };
};

const v3RefusalOf = (arguments_: unknown): { code: string; message: string } => {
  const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["reviewer-payload"], "v3", arguments_);
  if (admitted.kind !== "refused") throw new Error("fixture v3 admission must be refused");
  return { code: admitted.code, message: admitted.message };
};

describe("the successor v3 reviewer path rides the shared selection kernel (T9)", () => {
  it("selects a valid v3 emission call over final text through the v3 registry cell, with the call's provenance (FR-003/AS-003)", () => {
    const selection = selectCanonicalPayload(
      REVIEWER_V3,
      observeEmissionCalls([frameOf(callOf(REVIEWER_V3, "call-v3-ok", v3Arguments()))]),
      USABLE_CANDIDATES,
    );
    expect(selection.kind).toBe("emission-tool-arguments");
    if (selection.kind !== "emission-tool-arguments") throw new Error("v3 fixture must select emission");
    expect(selection.source).toBe("emission-tool");
    expect(selection.call).toMatchObject({ toolCallId: "call-v3-ok", version: "v3" });
    // The canonical payload bytes re-parse through the SAME frozen v3 parser
    // the successor's issuance joins run — one schema, one contract (FR-021).
    const reparsed = parseStandaloneReviewerPayloadV3(Uint8Array.from(selection.payload.bytes));
    expect(reparsed.ok).toBe(true);
    expect(selection.payload.origin).toBe("emission-tool-arguments");
  });

  it("canonicalizes the v3 wire form through the frozen v3 schema and selects identically to the child-executed form", () => {
    const value = v3Arguments({
      findings: [{ draft: { severity: "advisory", file: null, line: null, claim: "Distinct v3 assertion", reason: "Useful, nonblocking improvement." }, relation: { kind: "independent" } }],
    });
    const fromCanonical = selectCanonicalPayload(
      REVIEWER_V3,
      observeEmissionCalls([frameOf(callOf(REVIEWER_V3, "call-v3-canonical", value))]),
      [],
    );
    const fromWire = selectCanonicalPayload(
      REVIEWER_V3,
      observeEmissionCalls([frameOf(callOf(REVIEWER_V3, "call-v3-wire", wireFormOfV3(value)))]),
      [],
    );
    expect(fromCanonical.kind).toBe("emission-tool-arguments");
    expect(fromWire.kind).toBe("emission-tool-arguments");
    if (fromCanonical.kind === "emission-tool-arguments" && fromWire.kind === "emission-tool-arguments") {
      expect(fromWire.payload.text).toBe(fromCanonical.payload.text);
      expect(fromWire.payload.digest).toBe(fromCanonical.payload.digest);
    }
  });

  it("never ingests engine-refined v3 arguments — the whitespace-only prose and authored-ID refinements refuse with the v3 vocabulary (AS-018)", () => {
    for (const [label, refused] of [
      ["whitespace-only prose", v3WhitespaceRefusal()],
      ["authored finding id", v3AuthoredIdRefusal()],
    ] as const) {
      const admission = admitEmissionArguments(EMISSION_TOOL_SPECS["reviewer-payload"], "v3", refused);
      expect(admission.kind, label).toBe("refused");
      if (admission.kind !== "refused") throw new Error(`${label} fixture must refuse`);
      expect(admission.code, label).toBe("invalid-payload");
    }
  });

  it("selects usable extraction over one engine-refused v3 call with the refusal retained and no retry consumed (FR-006/AS-007)", () => {
    const refused = v3RefusalOf(v3WhitespaceRefusal());
    expect(refused.code).toBe("invalid-payload");
    const selection = selectCanonicalPayload(
      REVIEWER_V3,
      observeEmissionCalls([frameOf(callOf(REVIEWER_V3, "call-v3-refused", v3WhitespaceRefusal()))]),
      USABLE_CANDIDATES,
    );
    expect(selection.kind).toBe("extraction-over-refused-call");
    if (selection.kind !== "extraction-over-refused-call") throw new Error("fixture must fall back with retention");
    expect(selection.source).toBe("extraction");
    expect(selection.emissionRefusal).toEqual(refused);
    expect(selection.fallback.ok).toBe(true);
  });

  it("rejects once with BOTH causes when the refused v3 call has no usable fallback (AD-9)", () => {
    const selection = selectCanonicalPayload(
      REVIEWER_V3,
      observeEmissionCalls([frameOf(callOf(REVIEWER_V3, "call-v3-refused-no-fallback", v3WhitespaceRefusal()))]),
      [],
    );
    expect(selection.kind).toBe("refused-call-no-fallback");
    if (selection.kind !== "refused-call-no-fallback") throw new Error("fixture must reject with both causes");
    expect(selection.emissionRefusal.code).toBe("invalid-payload");
    expect(selection.extraction.reason).toBe("no-final-payload");
  });

  it("rejects duplicate v3 calls as ambiguity — refused-then-corrected in either order, and identical arguments under different call ids (FR-007/AS-019)", () => {
    for (const [label, frames] of [
      ["refused then corrected", [frameOf(callOf(REVIEWER_V3, "call-v3-bad", v3WhitespaceRefusal())), frameOf(callOf(REVIEWER_V3, "call-v3-good", v3Arguments()))]],
      ["corrected then refused", [frameOf(callOf(REVIEWER_V3, "call-v3-good", v3Arguments())), frameOf(callOf(REVIEWER_V3, "call-v3-bad", v3WhitespaceRefusal()))]],
      ["identical arguments, distinct identities", [frameOf(callOf(REVIEWER_V3, "call-v3-one", v3Arguments())), frameOf(callOf(REVIEWER_V3, "call-v3-two", v3Arguments()))]],
    ] as const) {
      const selection = selectCanonicalPayload(REVIEWER_V3, observeEmissionCalls(frames), USABLE_CANDIDATES);
      expect(selection.kind, label).toBe("duplicate-emission-call");
      if (selection.kind !== "duplicate-emission-call") throw new Error(`${label} fixture must reject as ambiguity`);
      expect(selection.calls.map(({ toolCallId }) => toolCallId)).toEqual(frames.map((frame) => frame.call.toolCallId));
    }
  });

  it("refuses each v3 misbinding before counting — a v2 call in a v3 attempt never self-decodes, a verdict call never consults, a foreign request never binds (FR-014)", () => {
    const misbindings = [
      ["unexpected version", { ...callOf(REVIEWER_V3, "call-v2-in-v3", validReviewerArguments("misbound version")), version: "v2" as const }],
      ["unexpected kind", { ...callOf(REVIEWER_V3, "call-judge-in-v3", validJudgeArguments("extensibility")), kind: JUDGE_V1.kind }],
      ["wrong request", { ...callOf(REVIEWER_V3, "call-foreign-request", v3Arguments()), requestId: OTHER_REQUEST_ID }],
    ] as const;
    for (const [label, misbound] of misbindings) {
      const selection = selectCanonicalPayload(
        REVIEWER_V3,
        observeEmissionCalls([frameOf(misbound), frameOf(callOf(REVIEWER_V3, "call-v3-good", v3Arguments()))]),
        USABLE_CANDIDATES,
      );
      expect(selection.kind, label).toBe("observation-refused");
      if (selection.kind !== "observation-refused") throw new Error(`${label} fixture must refuse`);
      expect(selection.refusal.message).toContain("call-");
    }
    const versionRefusal = selectCanonicalPayload(REVIEWER_V3, observeEmissionCalls([frameOf(misbindings[0]![1])]), USABLE_CANDIDATES);
    expect(versionRefusal).toMatchObject({ kind: "observation-refused", refusal: { code: "unexpected-version" } });
    const kindRefusal = selectCanonicalPayload(REVIEWER_V3, observeEmissionCalls([frameOf(misbindings[1]![1])]), USABLE_CANDIDATES);
    expect(kindRefusal).toMatchObject({ kind: "observation-refused", refusal: { code: "unexpected-kind" } });
    const requestRefusal = selectCanonicalPayload(REVIEWER_V3, observeEmissionCalls([frameOf(misbindings[2]![1])]), USABLE_CANDIDATES);
    expect(requestRefusal).toMatchObject({ kind: "observation-refused", refusal: { code: "wrong-request" } });
  });

  it("folds an exact v3 replay back to a single call — idempotent (FR-007)", () => {
    const frame = frameOf(callOf(REVIEWER_V3, "call-v3-replay", v3Arguments()));
    const selection = selectCanonicalPayload(REVIEWER_V3, observeEmissionCalls([frame, frame]), USABLE_CANDIDATES);
    expect(selection).toEqual(selectCanonicalPayload(REVIEWER_V3, observeEmissionCalls([frame]), USABLE_CANDIDATES));
  });

  it("keeps the v3 extraction arms equal to the no-op baseline on the same final candidates, and asserts duplicate/misbound rejection outcomes (AD-9 containment law, property)", () => {
    const refusedV3 = v3WhitespaceRefusal();
    const misboundV2 = { ...callOf(REVIEWER_V3, "call-v2-in-v3", validReviewerArguments("misbound")), version: "v2" as const };
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        const baseline = parseFinalPayload(candidates);
        const zeroCall = selectCanonicalPayload(REVIEWER_V3, ABSENT, candidates);
        const overRefused = selectCanonicalPayload(
          REVIEWER_V3,
          observeEmissionCalls([frameOf(callOf(REVIEWER_V3, "call-v3-refused", refusedV3))]),
          candidates,
        );
        // The containment law claims ONLY the two extraction-selected states.
        if (baseline.ok) {
          expect(zeroCall).toMatchObject({ kind: "final-message-extraction", fallback: baseline, source: "extraction" });
          expect(overRefused).toMatchObject({ kind: "extraction-over-refused-call", fallback: baseline, source: "extraction" });
        } else {
          expect(zeroCall.kind).toBe("final-message-extraction");
          expect(overRefused.kind).toBe("refused-call-no-fallback");
          if (overRefused.kind === "refused-call-no-fallback") expect(overRefused.extraction).toEqual(baseline.error);
        }
        // The duplicate and misbound rows assert REJECTION outcomes — never
        // skipped under a universal containment name (AD-9).
        const duplicate = selectCanonicalPayload(
          REVIEWER_V3,
          observeEmissionCalls([frameOf(callOf(REVIEWER_V3, "call-v3-one", v3Arguments())), frameOf(callOf(REVIEWER_V3, "call-v3-two", v3Arguments()))]),
          candidates,
        );
        expect(duplicate.kind).toBe("duplicate-emission-call");
        const misbound = selectCanonicalPayload(REVIEWER_V3, observeEmissionCalls([frameOf(misboundV2)]), candidates);
        expect(misbound).toMatchObject({ kind: "observation-refused", refusal: { code: "unexpected-version" } });
        return true;
      }),
      { numRuns: 60 },
    );
  });

  it("keeps the v3 no-op baseline byte-identical to PR #52's extraction with zero calls — the unconstrained-route parity baseline (FR-010/AS-005)", () => {
    const zeroCall = selectCanonicalPayload(REVIEWER_V3, ABSENT, USABLE_CANDIDATES);
    expect(zeroCall).toEqual(selectCanonicalPayload(REVIEWER_V2, ABSENT, USABLE_CANDIDATES));
    if (zeroCall.kind !== "final-message-extraction") throw new Error("zero-call fixture must be the extraction baseline");
    expect("emissionRefusal" in zeroCall).toBe(false);
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

/** The no-op baseline arm carries NO refusal field — the split makes the
 *  refused-call state a distinct kind, so reading a refusal off the baseline
 *  is a compile error, not a null-check convention. */
const _baselineHasNoRefusalField = (
  selection: Extract<IngestionSelection, { kind: "final-message-extraction" }>,
): void => {
  // @ts-expect-error the no-op baseline arm carries no refusal field
  void selection.emissionRefusal;
};
void _baselineHasNoRefusalField;

/** The retained single-call refusal is REQUIRED on the refused-call arm of
 *  both paths — the arm exists only because a refusal was observed. */
const _refusalIsRetained: (
  selection: Extract<IngestionSelection | VerdictSourceSelection, { kind: "extraction-over-refused-call" }>,
) => EmissionParseFailure = (selection) => selection.emissionRefusal;
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
