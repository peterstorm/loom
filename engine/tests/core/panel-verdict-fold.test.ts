/**
 * The panel verdict fold (T8, AD-8/AD-9): judge v1 and refutation v1 enter
 * their panels through the SAME deterministic selection seam the reviewer
 * capture path uses — the emission observation is folded and bound ONCE, the
 * selection runs BEFORE the authoritative parse, and the accepted source is
 * returned by the same decision and carried on the durable accepted event
 * (with the plan's historical projection for pre-feature events). The panel
 * parsers keep their criterion/lens bindings and complete candidate/finding
 * coverage: a source can choose WHICH bytes are parsed, never what they bind
 * to — a source cannot override issuance.
 *
 * These tests cross the SAME production seam the submissions run
 * (`submitArchitectureJudgeResult` / `submitRefutationVerdict` over the real
 * publication authority, folded by the kernel's ONE verdict-source selection),
 * never a test twin, and pin the AD-9 matrix at the
 * panel boundary: extraction-selected states keep the containment law
 * (identical to the plain parse on the same raw bytes), duplicate and misbound
 * calls are pinned as rejections in their own right rather than skipped.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  completePersistentRefutationPanel,
  panelRequestIdentity,
  parsePersistentArchitecturePanelEvent,
  parsePersistentRefutationPanelEvent,
  parseRefutationPanelCheckpoint,
  parsePersistentRefutationPanelHistory,
  planRefutationPanelPersistence,
  reducePersistentRefutationPanel,
  refutationPanelCheckpoint,
  startPersistentArchitecturePanel,
  startPersistentRefutationPanel,
  submitArchitectureCandidateResult,
  submitArchitectureJudgeResult,
  submitRefutationVerdict,
  type ArchitecturePanelState,
} from "../../src/core/persistent-panel";
import {
  parsePanelVerdictSourceRecord,
  panelVerdictSourceProvenance,
  panelVerdictSourceRecord,
  projectPanelVerdictSourceArm,
  replayPanelVerdictSourceSelection,
  type PanelVerdictSource,
  type PanelVerdictSourceRecord,
} from "../../src/core/panel-verdict-source";
import { selectVerdictSource } from "../../src/core/emission-ingestion";
import { issueEmissionBinding, type IssuedEmissionBindingOf } from "../../src/core/emission-tool";
import { observeEmissionCalls, type EmissionCallFrame, type EmissionToolCall } from "../../src/core/harness-capture";
import { parseRequestId, parseSlotId } from "../../src/core/orchestration-contract";
import { canonicalStructuralEquals, parseArtifactDigest } from "../../src/core/orchestration-contract/identity";
import {
  architecturePanelFixture,
  panelPublicationResolver as publicationResolver,
  refutationPanelFixture,
  type ArchitecturePanelFixture as ArchitectureFixture,
  type RefutationPanelFixture as RefutationFixture,
} from "../fixtures/panel-authority";
import { refusal, value } from "../fixtures/parse-result";

// ---------------------------------------------------------------------------
// Fixtures (the persistent panel's publication authority, minted — never asserted)
// ---------------------------------------------------------------------------

const hexDigest = (seed: string): string => createHash("sha256").update(seed).digest("hex");

const architectureFixture = (suffix: string): ArchitectureFixture => architecturePanelFixture(`run.verdict-fold.arch.${suffix}`);
const refutationFixture = (suffix: string): RefutationFixture =>
  refutationPanelFixture(`run.verdict-fold.ref.${suffix}`, ["reproduction", "intent"]);

// ---------------------------------------------------------------------------
// Emission fixtures: minted bindings, valid/refused verdict arguments
// ---------------------------------------------------------------------------

function mintJudgeBinding(requestId: string): IssuedEmissionBindingOf<"judge-verdict"> {
  return value(issueEmissionBinding({ requestId, kind: "judge-verdict", version: "v1" }));
}
function mintRefutationBinding(requestId: string): IssuedEmissionBindingOf<"refutation-verdict"> {
  return value(issueEmissionBinding({ requestId, kind: "refutation-verdict", version: "v1" }));
}

const callOf = (
  binding: IssuedEmissionBindingOf<"judge-verdict" | "refutation-verdict">,
  toolCallId: string,
  args: unknown,
): EmissionToolCall => ({
  requestId: binding.requestId,
  toolCallId,
  kind: binding.kind,
  version: binding.version,
  arguments: args,
});

const singleCallObservation = (call: EmissionToolCall) =>
  observeEmissionCalls([Object.freeze({ kind: "complete" as const, call })] as readonly EmissionCallFrame[]);

/** Every AD-9 observation row the judge fold distinguishes. */
const FOLD_OBSERVATION_KINDS = ["absent", "valid-call", "refused-call", "duplicate", "replayed", "wrong-request", "unusable"] as const;
type FoldObservationKind = (typeof FOLD_OBSERVATION_KINDS)[number];

/**
 * The transport frames of one AD-9 observation row over one call's
 * arguments: no frame, one complete call, two distinct calls (the second
 * named `<callId>-second`), an exact replay, a call observed under another
 * request, or an incomplete frame. A refused call is the single-call row over
 * arguments the emission edge refuses, so its frames are the valid row's.
 */
function framesFor(
  kind: FoldObservationKind,
  args: unknown,
  binding: IssuedEmissionBindingOf<"judge-verdict" | "refutation-verdict">,
  callId: string,
): readonly EmissionCallFrame[] {
  const complete = (overrides: Partial<EmissionToolCall> = {}): EmissionCallFrame =>
    Object.freeze({ kind: "complete" as const, call: { ...callOf(binding, callId, args), ...overrides } });
  switch (kind) {
    case "absent": return [];
    case "valid-call":
    case "refused-call": return [complete()];
    case "duplicate": return [complete(), complete({ toolCallId: `${callId}-second` })];
    case "replayed": return [complete(), complete()];
    case "wrong-request": return [complete({ requestId: "some-other-request" })];
    // An incomplete/failed frame is representable as itself: the fold refuses
    // it with its reason and never reclassifies it as absence.
    case "unusable": return [Object.freeze({ kind: "incomplete" as const, toolCallId: callId, reason: "the tool call ended without arguments" })];
  }
}

/** Schema-valid judge emission arguments that ALSO satisfy the seam's joins:
 *  the bound criterion, complete candidate coverage, non-increasing scores. */
const validJudgeArguments = (criterion: string, candidates: readonly string[]): unknown => ({
  criterion,
  rankings: candidates.map((candidate, index) => ({
    candidate,
    score: 9 - index,
    fatal_flaw: null,
    strongest_idea: `idea ${index + 1}`,
  })),
});

/** The SAME shape, but one the emission parse refuses: a non-integer score is
 *  outside the frozen schema's integer domain. */
const refusedJudgeArguments = (criterion: string, candidates: readonly string[]): unknown => ({
  criterion,
  rankings: candidates.map((candidate, index) => ({
    candidate,
    score: index === 0 ? 9.5 : 8 - index,
    fatal_flaw: null,
    strongest_idea: `idea ${index + 1}`,
  })),
});

const validRefutationArguments = (lens: string, findingIds: readonly string[]): unknown => ({
  criterion: lens,
  verdicts: findingIds.map((findingId) => ({
    finding_id: findingId,
    verdict: "refuted",
    reasoning: "the current packet does not exhibit the finding",
  })),
});

/** A valid judge verdict as plain extraction text (the same joins, no emission). */
const judgeExtractionText = (fixture: ArchitectureFixture, index: number): string => JSON.stringify({
  criterion: fixture.authority.judgeCriteria[index],
  rankings: fixture.authority.candidateIds.map((candidate, candidateIndex) => ({
    candidate,
    score: 9 - candidateIndex,
    fatal_flaw: null,
    strongest_idea: `idea ${candidateIndex + 1}`,
  })).sort((left, right) => right.score - left.score),
});

const refutationExtractionText = (fixture: RefutationFixture, index: number): string => JSON.stringify({
  criterion: fixture.authority.lenses[index],
  verdicts: fixture.authority.findings.map(({ id }) => ({
    finding_id: id,
    verdict: "upheld",
    reasoning: "the packet still exhibits the finding",
  })),
});

type ArchitectureJudgeState = ReturnType<typeof startPersistentArchitecturePanel>["state"];
type RefutationPanelState = ReturnType<typeof startPersistentRefutationPanel>["state"];

function submitJudgeEmission(
  state: ArchitectureJudgeState,
  fixture: ArchitectureFixture,
  index: number,
  emission: NonNullable<Parameters<typeof submitArchitectureJudgeResult>[4]>,
  rawJson: unknown = judgeExtractionText(fixture, index),
) {
  return submitArchitectureJudgeResult(state, publicationResolver, panelRequestIdentity(fixture.judges[index]!), rawJson, emission);
}

function submitRefutationEmission(
  state: RefutationPanelState,
  fixture: RefutationFixture,
  index: number,
  emission: NonNullable<Parameters<typeof submitRefutationVerdict>[4]>,
  rawJson: unknown = refutationExtractionText(fixture, index),
) {
  return submitRefutationVerdict(state, publicationResolver, panelRequestIdentity(fixture.requests[index]!), rawJson, emission);
}

function submitCandidatesBaseline(fixture: ArchitectureFixture) {
  let step = startPersistentArchitecturePanel(fixture.authority);
  for (const index of [1, 0]) {
    step = value(submitArchitectureCandidateResult(step.state, publicationResolver, panelRequestIdentity(fixture.candidates[index]!), {
      lens: fixture.authority.candidateLenses[index],
      candidate: fixture.authority.candidateIds[index],
      artifact: `# candidate ${index + 1}`,
    }));
  }
  return step;
}

/** The awaiting-judges slots of a state that has not left the judge stage. */
function awaitingJudgeSlots(state: ArchitecturePanelState) {
  if (state.stage !== "awaiting-judges") throw new Error(`expected awaiting-judges, got ${state.stage}`);
  return state.slots;
}

const judgeHistoryValue = (fixture: ArchitectureFixture) => ({
  criterion: fixture.authority.judgeCriteria[0],
  entries: fixture.authority.candidateIds.map((candidate, index) => ({
    candidate,
    score: 9 - index,
    fatalFlaw: null,
    strongestIdea: `idea ${index + 1}`,
  })),
});

// ---------------------------------------------------------------------------
// Judge v1 through the persistent seam
// ---------------------------------------------------------------------------

describe("judge v1 through the persistent panel seam", () => {
  it("selects the emission verdict before the authoritative parse and records the accepted source on the event", () => {
    const fixture = architectureFixture("emission-accepted");
    const step = submitCandidatesBaseline(fixture);
    const binding = mintJudgeBinding(fixture.judges[0]!.authority.requestId);
    const call = callOf(binding, "tool-call-judge-1", validJudgeArguments(fixture.authority.judgeCriteria[0], fixture.authority.candidateIds));
    const submitted = value(submitJudgeEmission(step.state, fixture, 0, {
      binding,
      observation: singleCallObservation(call),
    }, "the model answered in prose, which the emission source supersedes"));
    const event = submitted.recordedEvent!;
    expect(event.type).toBe("architecture-judge-accepted");
    if (event.type !== "architecture-judge-accepted") throw new Error("unreachable");
    expect(event.source).toEqual({
      source: "emission-tool",
      toolCallId: "tool-call-judge-1",
      producerKind: "judge-verdict",
      emissionSchemaVersion: "v1",
      schemaDigest: binding.schemaDigest,
    });
    // The emission source won REGARDLESS of the (parseable) final text, and
    // the verdict is the emission payload's: full candidate coverage under the
    // bound criterion.
    expect(event.value.criterion).toBe(fixture.authority.judgeCriteria[0]);
    expect(event.value.entries).toHaveLength(2);
  });

  it("keeps the criterion and coverage joins: a schema-valid emission payload with a foreign criterion refuses", () => {
    const fixture = architectureFixture("foreign-criterion");
    const step = submitCandidatesBaseline(fixture);
    const binding = mintJudgeBinding(fixture.judges[0]!.authority.requestId);
    // The frozen schema cannot bind the criterion (shape-level string), so a
    // foreign criterion ADMITS at the emission edge and must refuse at the
    // authoritative parse — the source never overrides issuance (FR-012).
    const foreign = validJudgeArguments("my own taste", fixture.authority.candidateIds);
    const submitted = value(submitJudgeEmission(step.state, fixture, 0, {
      binding,
      observation: singleCallObservation(callOf(binding, "tool-call-foreign", foreign)),
    }, judgeExtractionText(fixture, 0)));
    expect(submitted.recordedEvent).toMatchObject({
      type: "architecture-judge-rejected",
      category: "result-binding-mismatch",
      message: expect.stringContaining("emission tool call tool-call-foreign produced a judge verdict that refuses its authoritative parse"),
    });
    // The slot still waits: one rejection consumed the attempt, nothing accepted.
    expect(awaitingJudgeSlots(submitted.state).every((slot) => slot.status === "pending")).toBe(true);
  });

  it.each([
    ["wrong-request", (binding: IssuedEmissionBindingOf<"judge-verdict">): EmissionToolCall => callOf(
      { ...binding, requestId: "not-this-request" } as IssuedEmissionBindingOf<"judge-verdict">,
      "tool-call-misbound",
      validJudgeArguments("simplicity", ["candidate-a.md"]),
    ), "wrong-request"],
    ["unexpected-kind", (binding: IssuedEmissionBindingOf<"judge-verdict">): EmissionToolCall => ({
      requestId: binding.requestId,
      toolCallId: "tool-call-wrong-kind",
      kind: { kind: "reviewer-payload" },
      version: "v2",
      arguments: {},
    }), "unexpected-kind"],
    ["unexpected-version", (binding: IssuedEmissionBindingOf<"judge-verdict">): EmissionToolCall => ({
      requestId: binding.requestId,
      toolCallId: "tool-call-wrong-version",
      kind: { kind: "judge-verdict" },
      version: "v2",
      arguments: {},
    }), "unexpected-version"],
  ] as const)("refuses a %s emission call as a typed rejection, never extraction fallback", (_label, buildCall, expectedCode) => {
    const fixture = architectureFixture("misbound");
    const step = submitCandidatesBaseline(fixture);
    const binding = mintJudgeBinding(fixture.judges[0]!.authority.requestId);
    const submitted = value(submitJudgeEmission(step.state, fixture, 0, {
      binding,
      observation: singleCallObservation(buildCall(binding)),
    }, judgeExtractionText(fixture, 0)));
    const event = submitted.recordedEvent!;
    expect(event).toMatchObject({
      type: "architecture-judge-rejected",
      category: "result-binding-mismatch",
      message: expect.stringContaining(expectedCode),
    });
    // The usable final text is NOT consulted: a misbound observation refuses,
    // it never falls back (FR-014/AD-9).
    expect(awaitingJudgeSlots(submitted.state).every((slot) => slot.status === "pending")).toBe(true);
  });

  it("rejects two distinct emission calls as ambiguity even with valid final text", () => {
    const fixture = architectureFixture("duplicate");
    const step = submitCandidatesBaseline(fixture);
    const binding = mintJudgeBinding(fixture.judges[0]!.authority.requestId);
    const args = validJudgeArguments(fixture.authority.judgeCriteria[0], fixture.authority.candidateIds);
    const observation = observeEmissionCalls(framesFor("duplicate", args, binding, "call-a"));
    const submitted = value(submitJudgeEmission(step.state, fixture, 0, { binding, observation }, judgeExtractionText(fixture, 0)));
    expect(submitted.recordedEvent).toMatchObject({
      type: "architecture-judge-rejected",
      category: "malformed-result",
      message: expect.stringContaining("2 distinct emission tool calls (call-a, call-a-second)"),
    });
  });

  it("treats an exact replay of one call as one call and accepts it", () => {
    const fixture = architectureFixture("replay");
    const step = submitCandidatesBaseline(fixture);
    const binding = mintJudgeBinding(fixture.judges[0]!.authority.requestId);
    const args = validJudgeArguments(fixture.authority.judgeCriteria[0], fixture.authority.candidateIds);
    const observation = observeEmissionCalls(framesFor("replayed", args, binding, "call-replayed"));
    const submitted = value(submitJudgeEmission(step.state, fixture, 0, { binding, observation }, judgeExtractionText(fixture, 0)));
    expect(submitted.recordedEvent).toMatchObject({
      type: "architecture-judge-accepted",
      source: { source: "emission-tool", toolCallId: "call-replayed" },
    });
  });

  it("accepts extraction over a single refused call with the refusal retained and no retry consumed", () => {
    const fixture = architectureFixture("refused-extraction");
    const step = submitCandidatesBaseline(fixture);
    const binding = mintJudgeBinding(fixture.judges[0]!.authority.requestId);
    const submitted = value(submitJudgeEmission(step.state, fixture, 0, {
      binding,
      observation: singleCallObservation(callOf(binding, "call-refused", refusedJudgeArguments(fixture.authority.judgeCriteria[0], fixture.authority.candidateIds))),
    }, judgeExtractionText(fixture, 0)));
    const event = submitted.recordedEvent!;
    expect(event.type).toBe("architecture-judge-accepted");
    if (event.type !== "architecture-judge-accepted") throw new Error("unreachable");
    expect(event.source).toEqual({
      source: "extraction",
      emissionRefusal: { code: "invalid-schema", message: expect.any(String) },
    });
    // The accepted value IS the extraction text's verdict (containment law,
    // AD-9): the refused call's payload never entered the ingestion.
    expect(event.value.criterion).toBe(fixture.authority.judgeCriteria[0]);
    // No retry consumed: the slot accepted at attempt 1.
    expect(awaitingJudgeSlots(submitted.state)[0]?.status).toBe("accepted");
  });

  it("records both causes when extraction over a refused call also fails its parse", () => {
    const fixture = architectureFixture("refused-no-fallback");
    const step = submitCandidatesBaseline(fixture);
    const binding = mintJudgeBinding(fixture.judges[0]!.authority.requestId);
    const submitted = value(submitJudgeEmission(step.state, fixture, 0, {
      binding,
      observation: singleCallObservation(callOf(binding, "call-refused", refusedJudgeArguments(fixture.authority.judgeCriteria[0], fixture.authority.candidateIds))),
    }, "not json at all"));
    const event = submitted.recordedEvent!;
    expect(event).toMatchObject({ type: "architecture-judge-rejected", category: "malformed-result" });
    if (event.type !== "architecture-judge-rejected") throw new Error("unreachable");
    expect(event.message).toContain("emission arguments were refused [invalid-schema]");
    expect(event.message).toContain("authoritative verdict parse was refused");
    // One rejection carrying BOTH causes — never two.
    expect(event.message).toContain("judge verdict is not valid JSON");
  });

  it("keeps the no-emission baseline byte-identical and records the extraction source", () => {
    const fixture = architectureFixture("baseline");
    const step = submitCandidatesBaseline(fixture);
    const raw = judgeExtractionText(fixture, 0);
    const submitted = value(submitArchitectureJudgeResult(step.state, publicationResolver, panelRequestIdentity(fixture.judges[0]!), raw));
    expect(submitted.recordedEvent).toMatchObject({
      type: "architecture-judge-accepted",
      source: { source: "extraction" },
    });
    if (submitted.recordedEvent!.type !== "architecture-judge-accepted") throw new Error("unreachable");
    expect(submitted.recordedEvent!.value.criterion).toBe(fixture.authority.judgeCriteria[0]);
    // The baseline's accepted value equals the plain parse of the same bytes.
    expect(submitted.recordedEvent!.value.entries).toHaveLength(2);
  });

  it("refuses an emission binding minted for another request before any selection", () => {
    const fixture = architectureFixture("foreign-binding");
    const step = submitCandidatesBaseline(fixture);
    const otherJudgeBinding = mintJudgeBinding(fixture.judges[1]!.authority.requestId);
    const submitted = submitJudgeEmission(step.state, fixture, 0, {
      binding: otherJudgeBinding,
      observation: singleCallObservation(callOf(otherJudgeBinding, "call-foreign-binding", validJudgeArguments(fixture.authority.judgeCriteria[1], fixture.authority.candidateIds))),
    }, judgeExtractionText(fixture, 0));
    // A caller defect (a binding that does not certify THIS slot's request) is
    // a typed failure before any selection — not a rejection event, not an
    // acceptance.
    expect(submitted.ok).toBe(false);
    if (submitted.ok) throw new Error("unreachable");
    expect(submitted.error).toMatchObject({
      kind: "invalid-authority",
      message: expect.stringContaining("issued emission binding certifies request"),
    });
  });
});

// ---------------------------------------------------------------------------
// Refutation v1 through the persistent seam
// ---------------------------------------------------------------------------

describe("refutation v1 through the persistent panel seam", () => {
  it("selects the emission verdict before the authoritative parse and records the accepted source", () => {
    const fixture = refutationFixture("emission-accepted");
    const step = startPersistentRefutationPanel(fixture.authority);
    const binding = mintRefutationBinding(fixture.requests[0]!.authority.requestId);
    const findingIds = fixture.authority.findings.map(({ id }) => id);
    const call = callOf(binding, "tool-call-verifier-1", validRefutationArguments(fixture.authority.lenses[0], findingIds));
    const submitted = value(submitRefutationEmission(step.state, fixture, 0, {
      binding,
      observation: singleCallObservation(call),
    }, "prose, not a verdict"));
    const event = submitted.recordedEvent!;
    expect(event.type).toBe("refutation-verdict-accepted");
    if (event.type !== "refutation-verdict-accepted") throw new Error("unreachable");
    expect(event.source).toEqual({
      source: "emission-tool",
      toolCallId: "tool-call-verifier-1",
      producerKind: "refutation-verdict",
      emissionSchemaVersion: "v1",
      schemaDigest: binding.schemaDigest,
    });
    expect(event.value.criterion).toBe(fixture.authority.lenses[0]);
    expect(event.value.entries).toHaveLength(2);
  });

  it("keeps the lens and finding-coverage joins: a foreign lens refuses through the emission source", () => {
    const fixture = refutationFixture("foreign-lens");
    const step = startPersistentRefutationPanel(fixture.authority);
    const binding = mintRefutationBinding(fixture.requests[0]!.authority.requestId);
    const findingIds = fixture.authority.findings.map(({ id }) => id);
    const submitted = value(submitRefutationEmission(step.state, fixture, 0, {
      binding,
      observation: singleCallObservation(callOf(binding, "tool-call-foreign-lens", validRefutationArguments("blast-radius", findingIds))),
    }, refutationExtractionText(fixture, 0)));
    expect(submitted.recordedEvent).toMatchObject({
      type: "refutation-verdict-rejected",
      category: "result-binding-mismatch",
      message: expect.stringContaining("emission tool call tool-call-foreign-lens produced a refutation verdict that refuses its authoritative parse"),
    });
  });

  it("rejects duplicate emission calls and accepts extraction over a refused call with the refusal retained", () => {
    const fixture = refutationFixture("refutation-rows");
    const step = startPersistentRefutationPanel(fixture.authority);
    const binding = mintRefutationBinding(fixture.requests[0]!.authority.requestId);
    const findingIds = fixture.authority.findings.map(({ id }) => id);
    const args = validRefutationArguments(fixture.authority.lenses[0], findingIds);

    const duplicated = value(submitRefutationEmission(step.state, fixture, 0, {
      binding,
      observation: observeEmissionCalls(framesFor("duplicate", args, binding, "call-a")),
    }, refutationExtractionText(fixture, 0)));
    expect(duplicated.recordedEvent).toMatchObject({
      type: "refutation-verdict-rejected",
      message: expect.stringContaining("2 distinct emission tool calls (call-a, call-a-second)"),
    });

    // Refused call + usable final text → extraction with the refusal retained.
    const invalidArgs = { criterion: fixture.authority.lenses[0], verdicts: [{ finding_id: findingIds[0], verdict: "maybe", reasoning: "unknown verdict enum" }] };
    const refused = value(submitRefutationEmission(step.state, fixture, 0, {
      binding,
      observation: singleCallObservation(callOf(binding, "call-refused", invalidArgs)),
    }, refutationExtractionText(fixture, 0)));
    const event = refused.recordedEvent!;
    expect(event.type).toBe("refutation-verdict-accepted");
    if (event.type !== "refutation-verdict-accepted") throw new Error("unreachable");
    expect(event.source).toEqual({
      source: "extraction",
      emissionRefusal: { code: "invalid-schema", message: expect.any(String) },
    });
    expect(refused.state.stage).toBe("awaiting-verdicts");
    if (refused.state.stage !== "awaiting-verdicts") throw new Error("unreachable");
    expect(refused.state.slots[0]?.status).toBe("accepted");
  });

  it("refuses an incomplete emission observation as a typed rejection, never reclassified as absence", () => {
    const fixture = refutationFixture("incomplete-observation");
    const step = startPersistentRefutationPanel(fixture.authority);
    const binding = mintRefutationBinding(fixture.requests[0]!.authority.requestId);
    const submitted = value(submitRefutationEmission(step.state, fixture, 0, {
      binding,
      observation: observeEmissionCalls(framesFor("unusable", {}, binding, "call-truncated")),
    }, refutationExtractionText(fixture, 0)));
    expect(submitted.recordedEvent).toMatchObject({
      type: "refutation-verdict-rejected",
      category: "malformed-result",
      message: expect.stringContaining("unusable-observation"),
    });
    // The usable final text is NOT consulted: an unusable observation is
    // representable as itself, never as absence (AD-8), so there is no
    // extraction fallback and no acceptance.
    expect(submitted.state.stage).toBe("awaiting-verdicts");
    if (submitted.state.stage !== "awaiting-verdicts") throw new Error("unreachable");
    expect(submitted.state.slots[0]?.status).toBe("pending");
  });

  it("records both causes when a refused refutation call's extraction fallback also refuses its parse", () => {
    const fixture = refutationFixture("refused-no-fallback");
    const step = startPersistentRefutationPanel(fixture.authority);
    const binding = mintRefutationBinding(fixture.requests[0]!.authority.requestId);
    const findingIds = fixture.authority.findings.map(({ id }) => id);
    // The verdict enum outside the frozen schema refuses the emission edge.
    const invalidArgs = {
      criterion: fixture.authority.lenses[0],
      verdicts: [{ finding_id: findingIds[0], verdict: "maybe", reasoning: "unknown verdict enum" }],
    };
    const submitted = value(submitRefutationEmission(step.state, fixture, 0, {
      binding,
      observation: singleCallObservation(callOf(binding, "call-refused-both", invalidArgs)),
    }, "not json at all"));
    const event = submitted.recordedEvent!;
    expect(event).toMatchObject({ type: "refutation-verdict-rejected", category: "malformed-result" });
    if (event.type !== "refutation-verdict-rejected") throw new Error("unreachable");
    expect(event.message).toContain("emission arguments were refused [invalid-schema]");
    expect(event.message).toContain("authoritative verdict parse was refused");
    // One rejection carrying BOTH causes — never two (AD-9).
    expect(event.message).toContain("refutation verdict is not valid JSON");
  });

  it("refuses an emission binding minted for another refutation request before any selection", () => {
    const fixture = refutationFixture("foreign-binding");
    const step = startPersistentRefutationPanel(fixture.authority);
    const otherBinding = mintRefutationBinding(fixture.requests[1]!.authority.requestId);
    const findingIds = fixture.authority.findings.map(({ id }) => id);
    const submitted = submitRefutationEmission(step.state, fixture, 0, {
      binding: otherBinding,
      observation: singleCallObservation(callOf(otherBinding, "call-foreign-binding", validRefutationArguments(fixture.authority.lenses[1], findingIds))),
    }, refutationExtractionText(fixture, 0));
    // A caller defect (a binding that does not certify THIS slot's request)
    // is a typed failure before any selection — not a rejection event, not an
    // acceptance — exactly as the judge seam refuses one.
    expect(submitted.ok).toBe(false);
    if (submitted.ok) throw new Error("unreachable");
    expect(submitted.error).toMatchObject({
      kind: "invalid-authority",
      message: expect.stringContaining("issued emission binding certifies request"),
    });
  });
});

// ---------------------------------------------------------------------------
// Durable accepted-event source arm: projection, validation, replay
// ---------------------------------------------------------------------------

const historicalJudgeEvent = (fixture: ArchitectureFixture, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  type: "architecture-judge-accepted",
  request: panelRequestIdentity(fixture.judges[0]!),
  value: judgeHistoryValue(fixture),
  ...extra,
});

describe("the durable accepted-event source arm", () => {
  it("projects a historical accepted event without a source arm as extraction", () => {
    const fixture = architectureFixture("historical");
    const state = submitCandidatesBaseline(fixture).state;
    const parsedEvent = value(parsePersistentArchitecturePanelEvent(state, historicalJudgeEvent(fixture), publicationResolver));
    expect(parsedEvent.type === "architecture-judge-accepted" ? parsedEvent.source : null).toEqual({ source: "extraction" });
  });

  it("refuses malformed present-day source arms instead of calling them historical absence", () => {
    const fixture = architectureFixture("malformed-arm");
    const state = submitCandidatesBaseline(fixture).state;
    const malformedArms = [
      { source: { source: "emission-tool" } },
      { source: { source: "emission-tool", toolCallId: "call", producerKind: "judge-verdict", emissionSchemaVersion: "v1", schemaDigest: "not-a-digest" } },
      { source: { source: "emission-tool", toolCallId: "call", producerKind: "judge-verdict", schemaDigest: hexDigest("d") } },
      { source: { source: "extraction", toolCallId: "call" } },
      { source: { source: "extraction", emissionRefusal: { code: "x" } } },
      { source: { source: "something-else" } },
      { source: "extraction" },
    ];
    for (const arm of malformedArms) {
      const refused = parsePersistentArchitecturePanelEvent(state, historicalJudgeEvent(fixture, arm), publicationResolver);
      expect(refused.ok, JSON.stringify(arm)).toBe(false);
      if (refused.ok) throw new Error("unreachable");
      expect(refused.error.kind).toBe("malformed-event");
    }
  });

  it("replays a recorded emission source arm into a fresh panel verbatim", () => {
    const fixture = refutationFixture("replay-arm");
    const started = startPersistentRefutationPanel(fixture.authority);
    const binding = mintRefutationBinding(fixture.requests[0]!.authority.requestId);
    const findingIds = fixture.authority.findings.map(({ id }) => id);
    const submitted = value(submitRefutationEmission(started.state, fixture, 0, {
      binding,
      observation: singleCallObservation(callOf(binding, "call-replay-arm", validRefutationArguments(fixture.authority.lenses[0], findingIds))),
    }, "prose, not a verdict"));
    const recorded = submitted.recordedEvent!;
    // The recorded event replays into a fresh panel: the projected arm is the
    // SAME source, and the slot re-accepts from the replayed event alone.
    const reparsed = value(parsePersistentRefutationPanelEvent(started.state, JSON.parse(JSON.stringify(recorded)), publicationResolver));
    expect(reparsed.type === "refutation-verdict-accepted" ? reparsed.source : null).toEqual(recorded.type === "refutation-verdict-accepted" ? recorded.source : null);
    const reducedStep = value(reducePersistentRefutationPanel(started.state, reparsed));
    expect(reducedStep.state.slots[0]?.status).toBe("accepted");
  });

  it("round-trips a checkpoint whose event prefix carries emission source arms", () => {
    const fixture = refutationFixture("checkpoint-parse");
    let step = startPersistentRefutationPanel(fixture.authority);
    const binding = mintRefutationBinding(fixture.requests[0]!.authority.requestId);
    const findingIds = fixture.authority.findings.map(({ id }) => id);
    step = value(submitRefutationEmission(step.state, fixture, 0, {
      binding,
      observation: singleCallObservation(callOf(binding, "call-cp", validRefutationArguments(fixture.authority.lenses[0], findingIds))),
    }, "prose, not a verdict"));
    const emissionEvent = step.recordedEvent!;
    step = value(submitRefutationVerdict(step.state, publicationResolver, panelRequestIdentity(fixture.requests[1]!), refutationExtractionText(fixture, 1)));
    const extractionEvent = step.recordedEvent!;
    const completed = value(completePersistentRefutationPanel(step.state, publicationResolver));
    const tallyEvent = completed.recordedEvent!;
    const checkpoint = value(refutationPanelCheckpoint(completed.state, [emissionEvent, extractionEvent, tallyEvent], publicationResolver));
    const replayed = value(parseRefutationPanelCheckpoint(JSON.parse(JSON.stringify(checkpoint)), publicationResolver));
    expect(replayed.state.stage).toBe("done");
    const persistedEvents = JSON.parse(JSON.stringify(checkpoint.events)) as readonly { type?: string; source?: { toolCallId?: string } }[];
    const persistedEmission = persistedEvents.find((event) => event.type === "refutation-verdict-accepted" && event.source?.toolCallId === "call-cp");
    expect(persistedEmission).toBeDefined();
    // The persistence plan replays the recorded prefix WITHOUT the step's own
    // event (the plan appends it) and derives its dedup keys from the SAME
    // durable event bytes.
    const history = value(parsePersistentRefutationPanelHistory(fixture.authority, [emissionEvent, extractionEvent], publicationResolver));
    const planned = value(planRefutationPanelPersistence(completed, history, publicationResolver));
    expect(planned[0]?.dedupKey).toBeDefined();
    const replaceEffect = planned[1];
    expect(replaceEffect?.kind).toBe("replace-refutation-panel-checkpoint");
    if (replaceEffect?.kind !== "replace-refutation-panel-checkpoint") throw new Error("unreachable");
    expect(replaceEffect.checkpoint.events.some((event) => event.type === "refutation-verdict-accepted" && event.source.source === "emission-tool" && event.source.toolCallId === "call-cp")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The durable panel verdict source record (the legacy path's replay authority)
// ---------------------------------------------------------------------------

function buildEmissionRecord(): {
  record: PanelVerdictSourceRecord;
  binding: IssuedEmissionBindingOf<"refutation-verdict">;
  acceptedCall: EmissionToolCall;
  rawJson: string;
} {
  const fixture = refutationFixture("record");
  const binding = mintRefutationBinding(fixture.requests[0]!.authority.requestId);
  const findingIds = fixture.authority.findings.map(({ id }) => id);
  const call = callOf(binding, "call-record", validRefutationArguments(fixture.authority.lenses[0], findingIds));
  const rawJson = "prose, not a verdict";
  const selection = selectVerdictSource(binding, singleCallObservation(call), rawJson);
  if (selection.kind !== "emission-tool-arguments") throw new Error("fixture selection must be emission");
  const acceptedBytes = new TextEncoder().encode(selection.rawJson);
  const record = value(panelVerdictSourceRecord({
    requestId: fixture.requests[0]!.authority.requestId,
    slotId: fixture.requests[0]!.authority.slotId,
    attempt: 1,
    source: panelVerdictSourceProvenance(binding, selection),
    acceptedCall: selection.call,
    payloadDigest: value(parseArtifactDigest(createHash("sha256").update(acceptedBytes).digest("hex"))),
    payloadByteLength: acceptedBytes.length,
  }));
  return { record, binding, rawJson, acceptedCall: selection.call };
}

describe("the durable panel verdict source record", () => {
  it("parses back byte-identically and replays the accepted call through the same seam", () => {
    const { record, rawJson } = buildEmissionRecord();
    const reparsed = value(parsePanelVerdictSourceRecord(JSON.parse(JSON.stringify(record))));
    expect(canonicalStructuralEquals(reparsed, record)).toBe(true);
    const replayed = value(replayPanelVerdictSourceSelection(reparsed, rawJson));
    expect(replayed.kind).toBe("emission-tool-arguments");
    if (replayed.kind !== "emission-tool-arguments") throw new Error("unreachable");
    expect(replayed.call.toolCallId).toBe("call-record");
  });

  it("refuses tampered records instead of replaying them", () => {
    const { record, rawJson, acceptedCall } = buildEmissionRecord();
    const tamperedDigest = {
      ...record,
      source: { ...record.source, schemaDigest: value(parseArtifactDigest(hexDigest("tampered"))) },
    };
    const refusedDigest = replayPanelVerdictSourceSelection(value(parsePanelVerdictSourceRecord(tamperedDigest)), rawJson);
    expect(refusedDigest.ok).toBe(false);
    if (refusedDigest.ok) throw new Error("unreachable");
    expect(refusedDigest.error).toContain("does not certify the frozen registry digest");

    const tamperedCall = { ...record, acceptedCall: { ...acceptedCall, toolCallId: "other-call" } };
    const refusedCall = parsePanelVerdictSourceRecord(tamperedCall);
    expect(refusedCall.ok).toBe(false);
    if (refusedCall.ok) throw new Error("unreachable");
    expect(refusedCall.error).toContain("source arm");

    const tamperedRequest = { ...record, requestId: "run.other-ref:refutation:verifier:1:1" };
    const refusedRequest = parsePanelVerdictSourceRecord(tamperedRequest);
    expect(refusedRequest.ok).toBe(false);
    if (refusedRequest.ok) throw new Error("unreachable");
    expect(refusedRequest.error).toContain("different request");

    const callWithoutRecord = { ...record, acceptedCall: undefined };
    const refusedMissing = parsePanelVerdictSourceRecord(callWithoutRecord);
    expect(refusedMissing.ok).toBe(false);

    const extractionWithCall = {
      schemaVersion: 1,
      kind: "panel-verdict-source",
      requestId: record.requestId,
      slotId: record.slotId,
      attempt: 1,
      source: { source: "extraction" },
      acceptedCall,
      payloadDigest: record.payloadDigest,
      payloadByteLength: record.payloadByteLength,
    };
    const refusedExtraction = parsePanelVerdictSourceRecord(extractionWithCall);
    expect(refusedExtraction.ok).toBe(false);
  });

  it("replays an extraction record verbatim with its retained refusal", () => {
    const source: PanelVerdictSource = {
      source: "extraction",
      emissionRefusal: { code: "invalid-schema", message: "the arguments refused the frozen schema" },
    };
    const record = value(panelVerdictSourceRecord({
      requestId: value(parseRequestId("run.record-extraction:refutation:verifier:1:1")),
      slotId: value(parseSlotId("refutation-slot:abc")),
      attempt: 2,
      source,
      payloadDigest: value(parseArtifactDigest(hexDigest("payload"))),
      payloadByteLength: 42,
    }));
    const replayed = value(replayPanelVerdictSourceSelection(
      value(parsePanelVerdictSourceRecord(JSON.parse(JSON.stringify(record)))),
      "the raw attempt bytes",
    ));
    expect(replayed).toEqual({
      kind: "extraction-over-refused-call",
      rawJson: "the raw attempt bytes",
      source: "extraction",
      emissionRefusal: source.emissionRefusal,
    });
  });

  it("never builds a record that carries a non-verdict producer kind, so none reaches the replay", () => {
    const schemaDigest = value(parseArtifactDigest(hexDigest("schema")));
    const built = panelVerdictSourceRecord({
      requestId: value(parseRequestId("run.record-kind:judge:1:1")),
      slotId: value(parseSlotId("judge:1")),
      attempt: 1,
      source: { source: "emission-tool", toolCallId: "call", producerKind: "reviewer-payload", emissionSchemaVersion: "v2", schemaDigest },
      acceptedCall: {
        requestId: value(parseRequestId("run.record-kind:judge:1:1")),
        toolCallId: "call",
        kind: { kind: "reviewer-payload" },
        version: "v2",
        arguments: {},
      },
      payloadDigest: value(parseArtifactDigest(hexDigest("payload"))),
      payloadByteLength: 7,
    });
    expect(refusal(built)).toContain("is not a panel verdict kind");
  });
});

// ---------------------------------------------------------------------------
// The historical projection's exact rule
// ---------------------------------------------------------------------------

describe("projectPanelVerdictSourceArm", () => {
  it("projects absence as extraction and validates every present shape", () => {
    expect(projectPanelVerdictSourceArm(undefined)).toEqual({ ok: true, value: { source: "extraction" } });
    expect(projectPanelVerdictSourceArm({ source: "extraction" })).toEqual({ ok: true, value: { source: "extraction" } });
    const refusal = { source: "extraction", emissionRefusal: { code: "invalid-schema", message: "m" } };
    expect(projectPanelVerdictSourceArm(refusal)).toEqual({ ok: true, value: refusal });
    const emission = {
      source: "emission-tool",
      toolCallId: "call",
      producerKind: "judge-verdict",
      emissionSchemaVersion: "v1",
      schemaDigest: value(parseArtifactDigest(hexDigest("schema"))),
    };
    expect(projectPanelVerdictSourceArm(emission)).toEqual({ ok: true, value: emission });
    for (const malformed of [null, "extraction", 7, { source: "unknown" }, { source: "emission-tool", extra: 1 }]) {
      expect(projectPanelVerdictSourceArm(malformed).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Property: the verdict fold's outcome matrix (AD-9, with the containment law
// claimed only for the extraction-selected states)
// ---------------------------------------------------------------------------

const judgeArgumentsArb = fc.record({
  criterion: fc.constantFrom("simplicity", "pure functional core"),
  scoreBase: fc.integer({ min: 5, max: 9 }),
});

describe("property: judge submissions fold every AD-9 row through the panel seam", () => {
  it("accepts exactly the single-call rows, records the source by decision, and rejects duplicates, misbindings, and unusable observations", () => {
    const fixture = architectureFixture("property");
    const baseState = submitCandidatesBaseline(fixture).state;
    const binding = mintJudgeBinding(fixture.judges[0]!.authority.requestId);
    const extractionRaw = judgeExtractionText(fixture, 0);
    /** One row of the matrix: fold `kind` over the generated payload and assert
     *  that row's outcome. The property drives EVERY row per generated case, so
     *  no row's assertion depends on the generator happening to draw it. */
    const assertRow = (raw: Readonly<{ criterion: string; scoreBase: number }>, kind: FoldObservationKind, callId: string): void => {
      // The rankings always cover the authority's EXACT candidate set (the
      // property's variable is the criterion and the score level — the join
      // the payload must satisfy to be acceptable).
      const args = {
        criterion: raw.criterion,
        rankings: fixture.authority.candidateIds.map((candidate, index) => ({
          candidate,
          score: raw.scoreBase - index,
          fatal_flaw: null,
          strongest_idea: `idea ${index + 1}`,
        })),
      };
      const argumentsFor = kind === "refused-call"
        ? { ...args, rankings: [{ ...args.rankings[0]!, score: 9.5 }, ...args.rankings.slice(1)] }
        : args;
      const frames = framesFor(kind, argumentsFor, binding, callId);
      const observation = observeEmissionCalls(frames);
      const submitted = value(submitArchitectureJudgeResult(baseState, publicationResolver, panelRequestIdentity(fixture.judges[0]!), extractionRaw, { binding, observation }));
      const event = submitted.recordedEvent!;
      const slotAccepted = awaitingJudgeSlots(submitted.state).some((slot) => slot.status === "accepted");
      switch (kind) {
        case "absent": {
          expect(event.type).toBe("architecture-judge-accepted");
          if (event.type !== "architecture-judge-accepted") throw new Error("unreachable");
          expect(event.source).toEqual({ source: "extraction" });
          expect(slotAccepted).toBe(true);
          break;
        }
        case "valid-call":
        case "replayed": {
          if (args.criterion !== fixture.authority.judgeCriteria[0]) {
            // The payload carries a foreign criterion: the emission edge
            // admitted it (shape-level string) and the authoritative parse
            // refused the join — the source cannot override issuance.
            expect(event.type).toBe("architecture-judge-rejected");
            if (event.type !== "architecture-judge-rejected") throw new Error("unreachable");
            expect(event.category).toBe("result-binding-mismatch");
            expect(event.message).toContain("refuses its authoritative parse");
            expect(slotAccepted).toBe(false);
            break;
          }
          expect(event.type).toBe("architecture-judge-accepted");
          if (event.type !== "architecture-judge-accepted") throw new Error("unreachable");
          expect(event.source).toEqual({
            source: "emission-tool",
            toolCallId: callId,
            producerKind: "judge-verdict",
            emissionSchemaVersion: "v1",
            schemaDigest: binding.schemaDigest,
          });
          expect(slotAccepted).toBe(true);
          break;
        }
        case "refused-call": {
          expect(event.type).toBe("architecture-judge-accepted");
          if (event.type !== "architecture-judge-accepted") throw new Error("unreachable");
          expect(event.source).toEqual({ source: "extraction", emissionRefusal: { code: expect.any(String), message: expect.any(String) } });
          expect(slotAccepted).toBe(true);
          break;
        }
        case "duplicate": {
          expect(event.type).toBe("architecture-judge-rejected");
          if (event.type !== "architecture-judge-rejected") throw new Error("unreachable");
          expect(event.message).toContain("2 distinct emission tool calls");
          expect(slotAccepted).toBe(false);
          break;
        }
        case "wrong-request": {
          expect(event.type).toBe("architecture-judge-rejected");
          if (event.type !== "architecture-judge-rejected") throw new Error("unreachable");
          expect(event.message).toContain("wrong-request");
          expect(slotAccepted).toBe(false);
          break;
        }
        case "unusable": {
          // An incomplete frame is representable as itself (AD-8): a typed
          // rejection with its reason — never absence, so never an
          // extraction fallback over the usable final text, never accepted.
          expect(event.type).toBe("architecture-judge-rejected");
          if (event.type !== "architecture-judge-rejected") throw new Error("unreachable");
          expect(event.category).toBe("malformed-result");
          expect(event.message).toContain("unusable-observation");
          expect(slotAccepted).toBe(false);
          break;
        }
        default: {
          const unhandled: never = kind;
          throw new Error(`unhandled AD-9 row: ${String(unhandled)}`);
        }
      }
    };
    fc.assert(fc.property(
      judgeArgumentsArb,
      fc.string({ minLength: 2, maxLength: 12 }).filter((s) => /^[a-z][a-z0-9]+$/.test(s)),
      (raw, callId) => {
        for (const kind of FOLD_OBSERVATION_KINDS) assertRow(raw, kind, callId);
      },
    ), { numRuns: 40 });
  });
});
