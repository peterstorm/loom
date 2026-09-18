import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createHash } from "node:crypto";
import {
  selectCanonicalPayload,
  selectVerdictSource,
  type EmissionToolCallRecord,
  type IngestionSelection,
} from "../../src/core/emission-ingestion";
import { parseFinalPayload } from "../../src/core/harness-capture";
import {
  canonicalStructuralEquals,
  type DomainResult,
} from "../../src/core/orchestration-contract/identity";
import {
  REVIEWER_PAYLOAD_EXAMPLE_V2,
  reviewerPayloadV2Schema,
} from "../../src/core/reviewer-contract";

/**
 * The deterministic selection is a property, not a caller convention: the
 * engine never chooses between interpretations, so the same inputs must select
 * the same source, a valid emission record must win whenever one is present,
 * and wherever the selection is not emission-tool-arguments the fallback
 * behavior must be exactly the no-op baseline (containment). Arbitrary shapes
 * exercise every combination, including the ones a hand-written suite would
 * never think to build.
 */
const proseArb = fc.stringMatching(/^[a-z0-9][a-z0-9 .,;:\-]{0,60}$/);

const candidateArb = fc.record({
  origin: fc.constant("content[0].text"),
  text: fc.string({ minLength: 1, maxLength: 100 }),
});

/** Arbitrary emission records: arbitrary kind/version/arguments combinations,
 *  almost all of which fail a frozen schema — exactly the combinations the
 *  containment property must cover. */
const recordArb = fc.array(
  fc.record({
    kind: fc.constantFrom(
      { kind: "reviewer-payload" } as const,
      { kind: "judge-verdict" } as const,
      { kind: "refutation-verdict" } as const,
    ),
    version: fc.constantFrom("v2", "v3", "v1"),
    arguments: fc.record({ arbitrary: fc.string({ minLength: 0, maxLength: 20 }) }),
  }),
  { maxLength: 4 },
);

/** A valid reviewer payload as emission arguments, parametrized by claim text. */
const validReviewerRecordArb = claimArb().map((claim) => ({
  kind: { kind: "reviewer-payload" } as const,
  version: "v2" as const,
  arguments: reviewerPayloadV2Schema.parse({
    schemaVersion: 2,
    kind: "standalone-review",
    findings: [{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim }],
  }),
}));

function claimArb() {
  return fc.stringMatching(/^[a-z0-9][a-z0-9 .,;:\-]{0,60}$/);
}

const validJudgeRecordArb = fc.record({
  kind: fc.constant({ kind: "judge-verdict" } as const),
  version: fc.constant("v1" as const),
  arguments: fc.record({
    criterion: proseArb,
    rankings: fc.array(
      fc.record({
        candidate: proseArb,
        score: fc.integer({ min: 0, max: 10 }),
        fatal_flaw: fc.option(proseArb, { nil: null }),
        strongest_idea: proseArb,
      }),
      { minLength: 1, maxLength: 4 },
    ),
  }),
});

/** A valid refutation verdict as emission arguments — the second verdict kind
 *  the verdict path serves, parametrized over the reasoning prose. */
const validRefutationRecordArb = fc.record({
  kind: fc.constant({ kind: "refutation-verdict" } as const),
  version: fc.constant("v1" as const),
  arguments: fc.record({
    criterion: proseArb,
    verdicts: fc.array(
      fc.record({
        finding_id: proseArb,
        verdict: fc.constantFrom("refuted", "upheld", "uncertain"),
        reasoning: proseArb,
      }),
      { minLength: 1, maxLength: 4 },
    ),
  }),
});

describe("selectCanonicalPayload", () => {
  it("is deterministic: the same inputs select the same source", () => {
    fc.assert(
      fc.property(recordArb, fc.array(candidateArb, { maxLength: 3 }), (records, candidates) => {
        const first = selectCanonicalPayload(records, candidates);
        const second = selectCanonicalPayload(records, candidates);
        return canonicalStructuralEquals(first, second);
      }),
    );
  });

  it("prefers a valid emission record over extraction whenever it is the only reviewer record", () => {
    fc.assert(
      fc.property(validReviewerRecordArb, fc.array(candidateArb, { maxLength: 3 }), (record, candidates) => {
        const selection = selectCanonicalPayload([record], candidates);
        return selection.kind === "emission-tool-arguments" && selection.source === "emission-tool";
      }),
    );
  });

  it("preserves the fallback verbatim in every input combination where the selection is not emission-tool-arguments", () => {
    fc.assert(
      fc.property(recordArb, fc.array(candidateArb, { maxLength: 3 }), (records, candidates) => {
        const selection = selectCanonicalPayload(records, candidates);
        const baseline = parseFinalPayload(candidates);
        if (selection.kind === "final-message-extraction") {
          return canonicalStructuralEquals(selection.fallback, baseline);
        }
        // duplicate-emission-call: the selection never ingests and the
        // caller's existing rejection path engages — the baseline is not
        // consulted, so there is nothing to compare.
        return true;
      }),
    );
  });

  it("carries the rejection vocabulary verbatim when the fallback rejects", () => {
    const selection = selectCanonicalPayload([], []);
    expect(selection.kind).toBe("final-message-extraction");
    if (selection.kind === "final-message-extraction") {
      expect(selection.fallback.ok).toBe(false);
      if (!selection.fallback.ok) expect(selection.fallback.error.reason).toBe("no-final-payload");
    }
  });

  it("admits a valid emission record as the canonical payload", () => {
    const selection = selectCanonicalPayload(
      [{ kind: { kind: "reviewer-payload" }, version: "v2", arguments: REVIEWER_PAYLOAD_EXAMPLE_V2 }],
      [{ origin: "content[0].text", text: "prose payload" }],
    );
    expect(selection.kind).toBe("emission-tool-arguments");
    if (selection.kind === "emission-tool-arguments") {
      expect(selection.source).toBe("emission-tool");
      const parsed = JSON.parse(selection.payload.text);
      expect(canonicalStructuralEquals(parsed, REVIEWER_PAYLOAD_EXAMPLE_V2)).toBe(true);
    }
  });

  it("digests the canonical payload as the sha256 of its deterministically encoded bytes", () => {
    const selection = selectCanonicalPayload(
      [{ kind: { kind: "reviewer-payload" }, version: "v2", arguments: REVIEWER_PAYLOAD_EXAMPLE_V2 }],
      [],
    );
    expect(selection.kind).toBe("emission-tool-arguments");
    if (selection.kind === "emission-tool-arguments") {
      // Encoded ONCE, deterministically — the digest derivation is pinned so a
      // re-encode or re-indent divergence in the canonical payload is caught.
      const bytes = new TextEncoder().encode(selection.payload.text);
      expect(selection.payload.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(selection.payload.byteLength).toBe(bytes.length);
    }
  });

  it("treats an invalid emission record as never-ingestable — the fallback still engages", () => {
    const selection = selectCanonicalPayload(
      [{ kind: { kind: "reviewer-payload" }, version: "v2", arguments: { arbitrary: "not a payload" } }],
      [{ origin: "content[0].text", text: "{\"schemaVersion\":2}" }],
    );
    expect(selection.kind).toBe("final-message-extraction");
    if (selection.kind === "final-message-extraction") {
      expect(selection.fallback.ok).toBe(true);
    }
  });

  it("fails closed on duplicate emission records", () => {
    const record: EmissionToolCallRecord = {
      kind: { kind: "reviewer-payload" },
      version: "v2",
      arguments: REVIEWER_PAYLOAD_EXAMPLE_V2,
    };
    const selection = selectCanonicalPayload([record, record], []);
    expect(selection).toEqual({ kind: "duplicate-emission-call" });
  });

  it("fails closed on a duplicate even when one record is valid — a valid record does not rescue a duplicate", () => {
    const valid: EmissionToolCallRecord = {
      kind: { kind: "reviewer-payload" },
      version: "v2",
      arguments: REVIEWER_PAYLOAD_EXAMPLE_V2,
    };
    const invalid: EmissionToolCallRecord = {
      kind: { kind: "reviewer-payload" },
      version: "v2",
      arguments: { arbitrary: "not a payload" },
    };
    // Either order: the duplicate-ness is the call count, validity-blind (FR-007).
    expect(selectCanonicalPayload([valid, invalid], [])).toEqual({ kind: "duplicate-emission-call" });
    expect(selectCanonicalPayload([invalid, valid], [])).toEqual({ kind: "duplicate-emission-call" });
  });

  it("fails closed on two invalid emission records rather than engaging the fallback", () => {
    const invalid: EmissionToolCallRecord = {
      kind: { kind: "reviewer-payload" },
      version: "v2",
      arguments: { arbitrary: "not a payload" },
    };
    const selection = selectCanonicalPayload([invalid, invalid], [{ origin: "content[0].text", text: "prose" }]);
    expect(selection).toEqual({ kind: "duplicate-emission-call" });
  });

  it("ignores a judge record in a reviewer spawn's transcript — the fallback engages as today", () => {
    const selection = selectCanonicalPayload(
      [{ kind: { kind: "judge-verdict" }, version: "v1", arguments: { criterion: "x", rankings: [] } }],
      [],
    );
    expect(selection.kind).toBe("final-message-extraction");
  });
});

describe("selectVerdictSource", () => {
  it("is deterministic: the same inputs select the same source", () => {
    fc.assert(
      fc.property(proseArb, recordArb, (transcriptText, records) => {
        const first = selectVerdictSource(transcriptText, records);
        const second = selectVerdictSource(transcriptText, records);
        return canonicalStructuralEquals(first, second);
      }),
    );
  });

  it("prefers a valid verdict record over extraction whenever it is the only verdict record", () => {
    fc.assert(
      fc.property(validJudgeRecordArb, validRefutationRecordArb, proseArb, (judge, refutation, transcriptText) => {
        for (const record of [judge, refutation]) {
          const selection = selectVerdictSource(transcriptText, [record]);
          if (selection.kind !== "emission-tool-arguments" || selection.source !== "emission-tool") return false;
        }
        return true;
      }),
    );
  });

  it("returns the caller's transcript byte-verbatim when the selection is extraction", () => {
    fc.assert(
      fc.property(proseArb, recordArb, (transcriptText, records) => {
        const selection = selectVerdictSource(transcriptText, records);
        if (selection.kind === "final-message-extraction") {
          return selection.rawJson === transcriptText;
        }
        // duplicate-emission-call: the caller's existing rejection path
        // engages — the transcript is not consulted.
        return true;
      }),
    );
  });

  it("wins with the deterministically serialized arguments on the emission path", () => {
    const arguments_ = {
      criterion: "extensibility",
      rankings: [{ candidate: "candidate-type-driven-fp.md", score: 8, fatal_flaw: null, strongest_idea: "the registry" }],
    };
    const selection = selectVerdictSource("prose around the payload", [
      { kind: { kind: "judge-verdict" }, version: "v1", arguments: arguments_ },
    ]);
    expect(selection.kind).toBe("emission-tool-arguments");
    if (selection.kind === "emission-tool-arguments") {
      expect(JSON.parse(selection.rawJson)).toEqual(arguments_);
    }
  });

  it("leaves the caller's rawJson standing when no valid record is present", () => {
    const selection = selectVerdictSource("the captured attempt bytes", [
      { kind: { kind: "judge-verdict" }, version: "v1", arguments: { criterion: "x", rankings: [] } },
    ]);
    expect(selection.kind).toBe("final-message-extraction");
    if (selection.kind === "final-message-extraction") {
      expect(selection.rawJson).toBe("the captured attempt bytes");
      expect(selection.source).toBe("extraction");
    }
  });

  it("fails closed on duplicate valid verdict records", () => {
    const arguments_ = {
      criterion: "reproduction",
      verdicts: [{ finding_id: "T1:code-reviewer-1", verdict: "refuted", reasoning: "cannot be triggered" }],
    };
    const record: EmissionToolCallRecord = {
      kind: { kind: "refutation-verdict" },
      version: "v1",
      arguments: arguments_,
    };
    const selection = selectVerdictSource("transcript", [record, record]);
    expect(selection).toEqual({ kind: "duplicate-emission-call" });
  });

  it("fails closed on one judge and one refutation record — the verdict count spans both verdict kinds", () => {
    const judge: EmissionToolCallRecord = {
      kind: { kind: "judge-verdict" },
      version: "v1",
      arguments: {
        criterion: "extensibility",
        rankings: [{ candidate: "candidate-x.md", score: 8, fatal_flaw: null, strongest_idea: "x" }],
      },
    };
    const refutation: EmissionToolCallRecord = {
      kind: { kind: "refutation-verdict" },
      version: "v1",
      arguments: {
        criterion: "reproduction",
        verdicts: [{ finding_id: "T1:x-1", verdict: "refuted", reasoning: "x" }],
      },
    };
    // Either order: the duplicate-ness is the count of ALL verdict-kind records,
    // validity-blind (FR-007) — two verdict kinds in one slot's transcript are
    // ambiguous about which path produced them, so the selection never ingests.
    expect(selectVerdictSource("transcript", [judge, refutation])).toEqual({ kind: "duplicate-emission-call" });
    expect(selectVerdictSource("transcript", [refutation, judge])).toEqual({ kind: "duplicate-emission-call" });
  });

  it("fails closed on a duplicate even when one verdict record is valid — the call count is validity-blind", () => {
    const valid: EmissionToolCallRecord = {
      kind: { kind: "judge-verdict" },
      version: "v1",
      arguments: {
        criterion: "extensibility",
        rankings: [{ candidate: "candidate-type-driven-fp.md", score: 8, fatal_flaw: null, strongest_idea: "the registry" }],
      },
    };
    const invalid: EmissionToolCallRecord = {
      kind: { kind: "judge-verdict" },
      version: "v1",
      arguments: { criterion: "x", rankings: [] },
    };
    // Either order: the duplicate-ness is the call count, validity-blind (FR-007).
    expect(selectVerdictSource("transcript", [valid, invalid])).toEqual({ kind: "duplicate-emission-call" });
    expect(selectVerdictSource("transcript", [invalid, valid])).toEqual({ kind: "duplicate-emission-call" });
  });

  it("fails closed on two invalid verdict records rather than leaving the rawJson standing", () => {
    const invalid: EmissionToolCallRecord = {
      kind: { kind: "judge-verdict" },
      version: "v1",
      arguments: { criterion: "x", rankings: [] },
    };
    const selection = selectVerdictSource("the captured attempt bytes", [invalid, invalid]);
    expect(selection).toEqual({ kind: "duplicate-emission-call" });
  });

  it("does not consult a reviewer-payload record in a verdict spawn", () => {
    const selection = selectVerdictSource("transcript", [
      { kind: { kind: "reviewer-payload" }, version: "v2", arguments: REVIEWER_PAYLOAD_EXAMPLE_V2 },
    ]);
    expect(selection.kind).toBe("final-message-extraction");
    if (selection.kind === "final-message-extraction") {
      expect(selection.rawJson).toBe("transcript");
    }
  });

  it("engages the caller's rawJson byte-verbatim with zero records — the no-op baseline", () => {
    const selection = selectVerdictSource("the captured attempt bytes", []);
    expect(selection).toEqual({
      kind: "final-message-extraction",
      rawJson: "the captured attempt bytes",
      source: "extraction",
    });
  });
});

/** Type-level: the fallback DomainResult is carried verbatim on the union. */
const _fallbackIsDomainResult: (
  selection: Extract<IngestionSelection, { kind: "final-message-extraction" }>,
) => DomainResult<import("../../src/core/harness-capture").FinalPayload, import("../../src/core/harness-capture").CaptureRejection> =
  (selection) => selection.fallback;
void _fallbackIsDomainResult;
