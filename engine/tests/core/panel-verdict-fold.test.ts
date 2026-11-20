/**
 * The panel verdict fold (T8, AD-8/AD-9): refutation v1 enters the persistent
 * panel through the SAME deterministic selection seam the reviewer capture
 * path uses — the emission observation is folded and bound ONCE, the
 * selection runs BEFORE the authoritative parse, and the accepted source is
 * returned by the same decision and carried on the durable accepted event
 * (with a historical projection for pre-feature events). The panel parser
 * keeps its lens binding and complete finding coverage: a source can choose
 * WHICH bytes are parsed, never what they bind to — a source cannot override
 * issuance.
 *
 * These tests cross the SAME production seam the submissions run
 * (`submitRefutationVerdict` over the real publication authority, folded by
 * the kernel's ONE verdict-source selection), never a test twin, and pin the
 * AD-9 matrix at the panel boundary: extraction-selected states keep the
 * containment law (identical to the plain parse on the same raw bytes),
 * duplicate and misbound calls are pinned as rejections in their own right
 * rather than skipped.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  completePersistentRefutationPanel,
  panelRequestIdentity,
  parsePersistentRefutationPanelEvent,
  parseRefutationPanelCheckpoint,
  reducePersistentRefutationPanel,
  refutationPanelCheckpoint,
  startPersistentRefutationPanel,
  submitRefutationVerdict,
  type RefutationPanelState,
} from "../../src/core/persistent-panel";
import { projectPanelVerdictSourceArm } from "../../src/core/panel-verdict-source";
import { issueEmissionBinding, type IssuedEmissionBindingOf } from "../../src/core/emission-tool";
import { observeEmissionCalls, type EmissionCallFrame, type EmissionToolCall } from "../../src/core/emission-observation";
import { parseArtifactDigest } from "../../src/core/orchestration-contract/identity";
import {
  createPanelPublications,
  type RefutationPanelFixture as RefutationFixture,
} from "../fixtures/panel-authority";
import { value } from "../fixtures/parse-result";

/** This suite's private publication store: its resolver reads only the panels issued here. */
const { refutationPanelFixture, resolver: publicationResolver } = createPanelPublications();

// ---------------------------------------------------------------------------
// Fixtures (the persistent panel's publication authority, minted — never asserted)
// ---------------------------------------------------------------------------

const hexDigest = (seed: string): string => createHash("sha256").update(seed).digest("hex");

const refutationFixture = (suffix: string): RefutationFixture =>
  refutationPanelFixture(`run.verdict-fold.ref.${suffix}`, ["reproduction", "intent"]);

// ---------------------------------------------------------------------------
// Emission fixtures: minted bindings, valid/refused verdict arguments
// ---------------------------------------------------------------------------

function mintRefutationBinding(requestId: string): IssuedEmissionBindingOf<"refutation-verdict"> {
  return value(issueEmissionBinding({ requestId, kind: "refutation-verdict", version: "v1" }));
}

const callOf = (
  binding: IssuedEmissionBindingOf<"refutation-verdict">,
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

/** Every AD-9 observation row the verdict fold distinguishes. */
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
  binding: IssuedEmissionBindingOf<"refutation-verdict">,
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

const validRefutationArguments = (lens: string, findingIds: readonly string[], verdict = "refuted"): unknown => ({
  criterion: lens,
  verdicts: findingIds.map((findingId) => ({
    finding_id: findingId,
    verdict,
    reasoning: "the current packet does not exhibit the finding",
  })),
});

const refutationExtractionText = (fixture: RefutationFixture, index: number): string => JSON.stringify({
  criterion: fixture.authority.lenses[index],
  verdicts: fixture.authority.findings.map(({ id }) => ({
    finding_id: id,
    verdict: "upheld",
    reasoning: "the packet still exhibits the finding",
  })),
});

function submitRefutationEmission(
  state: RefutationPanelState,
  fixture: RefutationFixture,
  index: number,
  emission: NonNullable<Parameters<typeof submitRefutationVerdict>[4]>,
  rawJson: unknown = refutationExtractionText(fixture, index),
) {
  return submitRefutationVerdict(state, publicationResolver, panelRequestIdentity(fixture.requests[index]!), rawJson, emission);
}

/** The awaiting-verdicts slots of a state that has not left the verifier stage. */
function awaitingVerdictSlots(state: RefutationPanelState) {
  if (state.stage !== "awaiting-verdicts") throw new Error(`expected awaiting-verdicts, got ${state.stage}`);
  return state.slots;
}

const refutationHistoryValue = (fixture: RefutationFixture) => ({
  criterion: fixture.authority.lenses[0],
  entries: fixture.authority.findings.map(({ id }) => ({
    findingId: id,
    verdict: "upheld",
    reasoning: "the packet still exhibits the finding",
  })),
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
    // acceptance.
    expect(submitted.ok).toBe(false);
    if (submitted.ok) throw new Error("unreachable");
    expect(submitted.error).toMatchObject({
      kind: "invalid-authority",
      message: expect.stringContaining("issued emission binding certifies request"),
    });
  });
});

describe("refutation v1 misbinding, replay, and baseline rows", () => {
  it.each([
    ["wrong-request", (binding: IssuedEmissionBindingOf<"refutation-verdict">, findingIds: readonly string[]): EmissionToolCall => callOf(
      { ...binding, requestId: "not-this-request" } as IssuedEmissionBindingOf<"refutation-verdict">,
      "tool-call-misbound",
      validRefutationArguments("reproduction", findingIds),
    ), "wrong-request"],
    ["unexpected-kind", (binding: IssuedEmissionBindingOf<"refutation-verdict">): EmissionToolCall => ({
      requestId: binding.requestId,
      toolCallId: "tool-call-wrong-kind",
      kind: { kind: "reviewer-payload" },
      version: "v2",
      arguments: {},
    }), "unexpected-kind"],
    ["unexpected-version", (binding: IssuedEmissionBindingOf<"refutation-verdict">): EmissionToolCall => ({
      requestId: binding.requestId,
      toolCallId: "tool-call-wrong-version",
      kind: { kind: "refutation-verdict" },
      version: "v2",
      arguments: {},
    }), "unexpected-version"],
  ] as const)("refuses a %s emission call as a typed rejection, never extraction fallback", (_label, buildCall, expectedCode) => {
    const fixture = refutationFixture(`misbound-${_label}`);
    const step = startPersistentRefutationPanel(fixture.authority);
    const binding = mintRefutationBinding(fixture.requests[0]!.authority.requestId);
    const findingIds = fixture.authority.findings.map(({ id }) => id);
    const submitted = value(submitRefutationEmission(step.state, fixture, 0, {
      binding,
      observation: singleCallObservation(buildCall(binding, findingIds)),
    }, refutationExtractionText(fixture, 0)));
    expect(submitted.recordedEvent).toMatchObject({
      type: "refutation-verdict-rejected",
      category: "result-binding-mismatch",
      message: expect.stringContaining(expectedCode),
    });
    // The usable final text is NOT consulted: a misbound observation refuses,
    // it never falls back (FR-014/AD-9).
    expect(awaitingVerdictSlots(submitted.state).every((slot) => slot.status === "pending")).toBe(true);
  });

  it("treats an exact replay of one call as one call and accepts it", () => {
    const fixture = refutationFixture("replay");
    const step = startPersistentRefutationPanel(fixture.authority);
    const binding = mintRefutationBinding(fixture.requests[0]!.authority.requestId);
    const args = validRefutationArguments(fixture.authority.lenses[0], fixture.authority.findings.map(({ id }) => id));
    const observation = observeEmissionCalls(framesFor("replayed", args, binding, "call-replayed"));
    const submitted = value(submitRefutationEmission(step.state, fixture, 0, { binding, observation }, refutationExtractionText(fixture, 0)));
    expect(submitted.recordedEvent).toMatchObject({
      type: "refutation-verdict-accepted",
      source: { source: "emission-tool", toolCallId: "call-replayed" },
    });
  });

  it("keeps the no-emission baseline byte-identical and records the extraction source", () => {
    const fixture = refutationFixture("baseline");
    const step = startPersistentRefutationPanel(fixture.authority);
    const raw = refutationExtractionText(fixture, 0);
    const submitted = value(submitRefutationVerdict(step.state, publicationResolver, panelRequestIdentity(fixture.requests[0]!), raw));
    expect(submitted.recordedEvent).toMatchObject({
      type: "refutation-verdict-accepted",
      source: { source: "extraction" },
    });
    if (submitted.recordedEvent!.type !== "refutation-verdict-accepted") throw new Error("unreachable");
    expect(submitted.recordedEvent!.value.criterion).toBe(fixture.authority.lenses[0]);
    // The baseline's accepted value equals the plain parse of the same bytes.
    expect(submitted.recordedEvent!.value.entries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Durable accepted-event source arm: projection, validation, replay
// ---------------------------------------------------------------------------

const historicalRefutationEvent = (fixture: RefutationFixture, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  type: "refutation-verdict-accepted",
  request: panelRequestIdentity(fixture.requests[0]!),
  value: refutationHistoryValue(fixture),
  ...extra,
});

describe("the durable accepted-event source arm", () => {
  it("projects a historical accepted event without a source arm as extraction", () => {
    const fixture = refutationFixture("historical");
    const { state } = startPersistentRefutationPanel(fixture.authority);
    const parsedEvent = value(parsePersistentRefutationPanelEvent(state, historicalRefutationEvent(fixture), publicationResolver));
    expect(parsedEvent.type === "refutation-verdict-accepted" ? parsedEvent.source : null).toEqual({ source: "extraction" });
  });

  it("refuses malformed present-day source arms instead of calling them historical absence", () => {
    const fixture = refutationFixture("malformed-arm");
    const { state } = startPersistentRefutationPanel(fixture.authority);
    const malformedArms = [
      { source: { source: "emission-tool" } },
      { source: { source: "emission-tool", toolCallId: "call", producerKind: "refutation-verdict", emissionSchemaVersion: "v1", schemaDigest: "not-a-digest" } },
      { source: { source: "emission-tool", toolCallId: "call", producerKind: "refutation-verdict", schemaDigest: hexDigest("d") } },
      { source: { source: "extraction", toolCallId: "call" } },
      { source: { source: "extraction", emissionRefusal: { code: "x" } } },
      { source: { source: "something-else" } },
      { source: "extraction" },
    ];
    for (const arm of malformedArms) {
      const refused = parsePersistentRefutationPanelEvent(state, historicalRefutationEvent(fixture, arm), publicationResolver);
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
    // The reloaded prefix keeps the emission arm exactly as it was recorded.
    expect(replayed.state.stage === "done" && replayed.state.decision.verdicts).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(checkpoint.events))[0]).toEqual(JSON.parse(JSON.stringify(emissionEvent)));
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

const refutationArgumentsArb = fc.record({
  lens: fc.constantFrom("reproduction", "intent"),
  verdict: fc.constantFrom("refuted", "upheld", "uncertain"),
});

describe("property: refutation submissions fold every AD-9 row through the panel seam", () => {
  it("accepts exactly the single-call rows, records the source by decision, and rejects duplicates, misbindings, and unusable observations", () => {
    const fixture = refutationFixture("property");
    const baseState = startPersistentRefutationPanel(fixture.authority).state;
    const binding = mintRefutationBinding(fixture.requests[0]!.authority.requestId);
    const findingIds = fixture.authority.findings.map(({ id }) => id);
    const extractionRaw = refutationExtractionText(fixture, 0);
    /** One row of the matrix: fold `kind` over the generated payload and assert
     *  that row's outcome. The property drives EVERY row per generated case, so
     *  no row's assertion depends on the generator happening to draw it. */
    const assertRow = (raw: Readonly<{ lens: string; verdict: string }>, kind: FoldObservationKind, callId: string): void => {
      // The verdicts always cover the authority's EXACT finding set (the
      // property's variable is the lens and the verdict — the join the payload
      // must satisfy to be acceptable). A refused call carries a verdict
      // outside the frozen schema's enum.
      const args = validRefutationArguments(raw.lens, findingIds, kind === "refused-call" ? "maybe" : raw.verdict);
      const observation = observeEmissionCalls(framesFor(kind, args, binding, callId));
      const submitted = value(submitRefutationVerdict(baseState, publicationResolver, panelRequestIdentity(fixture.requests[0]!), extractionRaw, { binding, observation }));
      const event = submitted.recordedEvent!;
      const slotAccepted = awaitingVerdictSlots(submitted.state).some((slot) => slot.status === "accepted");
      switch (kind) {
        case "absent": {
          expect(event.type).toBe("refutation-verdict-accepted");
          if (event.type !== "refutation-verdict-accepted") throw new Error("unreachable");
          expect(event.source).toEqual({ source: "extraction" });
          expect(slotAccepted).toBe(true);
          break;
        }
        case "valid-call":
        case "replayed": {
          if (raw.lens !== fixture.authority.lenses[0]) {
            // The payload carries a foreign lens: the emission edge admitted it
            // (shape-level string) and the authoritative parse refused the
            // join — the source cannot override issuance.
            expect(event.type).toBe("refutation-verdict-rejected");
            if (event.type !== "refutation-verdict-rejected") throw new Error("unreachable");
            expect(event.category).toBe("result-binding-mismatch");
            expect(event.message).toContain("refuses its authoritative parse");
            expect(slotAccepted).toBe(false);
            break;
          }
          expect(event.type).toBe("refutation-verdict-accepted");
          if (event.type !== "refutation-verdict-accepted") throw new Error("unreachable");
          expect(event.source).toEqual({
            source: "emission-tool",
            toolCallId: callId,
            producerKind: "refutation-verdict",
            emissionSchemaVersion: "v1",
            schemaDigest: binding.schemaDigest,
          });
          expect(slotAccepted).toBe(true);
          break;
        }
        case "refused-call": {
          expect(event.type).toBe("refutation-verdict-accepted");
          if (event.type !== "refutation-verdict-accepted") throw new Error("unreachable");
          expect(event.source).toEqual({ source: "extraction", emissionRefusal: { code: expect.any(String), message: expect.any(String) } });
          expect(slotAccepted).toBe(true);
          break;
        }
        case "duplicate": {
          expect(event.type).toBe("refutation-verdict-rejected");
          if (event.type !== "refutation-verdict-rejected") throw new Error("unreachable");
          expect(event.message).toContain("2 distinct emission tool calls");
          expect(slotAccepted).toBe(false);
          break;
        }
        case "wrong-request": {
          expect(event.type).toBe("refutation-verdict-rejected");
          if (event.type !== "refutation-verdict-rejected") throw new Error("unreachable");
          expect(event.message).toContain("wrong-request");
          expect(slotAccepted).toBe(false);
          break;
        }
        case "unusable": {
          // An incomplete frame is representable as itself (AD-8): a typed
          // rejection with its reason — never absence, so never an
          // extraction fallback over the usable final text, never accepted.
          expect(event.type).toBe("refutation-verdict-rejected");
          if (event.type !== "refutation-verdict-rejected") throw new Error("unreachable");
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
      refutationArgumentsArb,
      fc.string({ minLength: 2, maxLength: 12 }).filter((s) => /^[a-z][a-z0-9]+$/.test(s)),
      (raw, callId) => {
        for (const kind of FOLD_OBSERVATION_KINDS) assertRow(raw, kind, callId);
      },
    ), { numRuns: 40 });
  });
});
