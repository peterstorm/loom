/**
 * The Pi transcript adapter's emission frames (pi/transcript-adapter.ts):
 * complete, request-bound emission observations read from settled Pi
 * transcripts — assistant tool calls only, never JSON pasted into user or
 * tool-result text — and their fold through the shared observation decision.
 * No Pi runtime is loaded; the real agent loop that produces these transcripts
 * is pinned in emission-tool-runtime.test.ts.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { FinalPayloadCandidate } from "../../src/core/harness-capture";
import { observeEmissionCalls, type EmissionCallFrame } from "../../src/core/emission-observation";
import { selectCanonicalPayload } from "../../src/core/emission-ingestion";
import { admitIssuedEmissionArguments, type IssuedEmissionBinding } from "../../src/core/emission-tool";
import { canonicalStructuralEquals } from "../../src/core/orchestration-contract/identity";
import { REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../src/core/reviewer-contract";
import { piEmissionCallFrames } from "../../../pi/transcript-adapter";
import { piReviewerCaptureObservation } from "../../../pi/review-capture";
import {
  canonicalArguments,
  JUDGE_V1_CELL,
  mintedBindingFor,
  OBSERVED_REQUEST_ID,
  REVIEWER_V2_CELL,
} from "../fixtures/emission-registry-cells";

const assistantWithCalls = (calls: readonly { id: string; name: string; arguments?: unknown }[], text = ""): unknown => ({
  role: "assistant",
  content: [
    ...(text.length > 0 ? [{ type: "text", text }] : []),
    ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} })),
  ],
});

const framesOf = (messages: unknown, issued: IssuedEmissionBinding): readonly EmissionCallFrame[] => {
  const scanned = piEmissionCallFrames(messages, issued);
  if (!scanned.ok) throw new Error(`fixture transcript refused: ${scanned.errors.join("; ")}`);
  return scanned.value;
};

const asCompleteCalls = (frames: readonly EmissionCallFrame[]): readonly Extract<EmissionCallFrame, { kind: "complete" }>["call"][] =>
  frames.filter((frame): frame is Extract<EmissionCallFrame, { kind: "complete" }> => frame.kind === "complete")
    .map((frame) => frame.call);

describe("piEmissionCallFrames — complete, request-bound emission observations (FR-014/AD-8)", () => {
  const issued = mintedBindingFor(REVIEWER_V2_CELL, OBSERVED_REQUEST_ID);
  const reviewerTool = REVIEWER_V2_CELL.spec.toolName;
  const judgeTool = JUDGE_V1_CELL.spec.toolName;

  it("a transcript with no emission calls observes absence", () => {
    const messages = [
      userLike(),
      assistantWithCalls([{ id: "call-bash", name: "bash", arguments: { command: "bun test" } }], "working"),
      toolResultLike("call-bash", "bash"),
      assistantWithCalls([], "done in prose"),
    ];
    expect(framesOf(messages, issued)).toEqual([]);
    expect(observeEmissionCalls(framesOf(messages, issued))).toEqual({ kind: "absent" });
  });

  it("one emission call observes one complete frame, bound to the issued request, kind from the registry, arguments as observed", () => {
    const args = canonicalArguments(REVIEWER_V2_CELL);
    const messages = [
      userLike(),
      assistantWithCalls([{ id: "call-emit-1", name: reviewerTool, arguments: args }]),
      toolResultLike("call-emit-1", reviewerTool),
    ];
    const frames = framesOf(messages, issued);
    expect(frames).toHaveLength(1);
    const [frame] = asCompleteCalls(frames);
    expect(frame!.toolCallId).toBe("call-emit-1");
    expect(frame!.requestId).toBe(issued.requestId);
    expect(frame!.kind).toEqual({ kind: "reviewer-payload" });
    expect(frame!.version).toBe(issued.version);
    expect(frame!.arguments).toEqual(args);
    // The fold classifies the frames the production adapter produced: one
    // complete call, and the engine re-admits the observed arguments.
    const observation = observeEmissionCalls(frames);
    expect(observation.kind).toBe("single-call");
    if (observation.kind === "single-call") {
      expect(admitIssuedEmissionArguments(mintedBindingFor(REVIEWER_V2_CELL, "req-emission-tool-admission"), observation.call.arguments).kind).toBe("valid");
    }
  });

  it("a well-formed payload pasted as final assistant text with zero emission calls extracts through the existing parser — the adapter observes assistant tool calls, never pasted text (AD-8)", () => {
    const messages = [
      userLike(),
      assistantWithCalls([], JSON.stringify(REVIEWER_PAYLOAD_EXAMPLE_V2, null, 2)),
    ];
    // Pasted JSON in text is a FinalPayloadCandidate, never an emission frame:
    // the observation is absence even though the text IS a schema-valid payload.
    expect(framesOf(messages, issued)).toEqual([]);
    const capture = piReviewerCaptureObservation(messages, issued);
    expect(capture.kind).toBe("candidates");
    if (capture.kind === "candidates") {
      expect(capture.candidates).toHaveLength(1);
      // The extraction candidate keeps its text origin — the existing parser's
      // provenance, not an emission-tool one.
      expect(capture.candidates[0]!.origin).toBe("content[0].text");
      expect(JSON.parse(capture.candidates[0]!.text)).toEqual(REVIEWER_PAYLOAD_EXAMPLE_V2);
    }
  });

  it("a successfully executed tool-only reviewer result reaches the production capture observation without assistant prose", () => {
    const args = canonicalArguments(REVIEWER_V2_CELL);
    const messages = [
      assistantWithCalls([{ id: "call-tool-only", name: reviewerTool, arguments: args }]),
      toolResultLike("call-tool-only", reviewerTool),
    ];
    const observation = piReviewerCaptureObservation(messages, issued);
    expect(observation.kind).toBe("candidates");
    if (observation.kind === "candidates") {
      expect(observation.candidates).toHaveLength(1);
      expect(observation.candidates[0]!.origin).toBe("emission-tool-arguments");
      expect(JSON.parse(observation.candidates[0]!.text)).toEqual(args);
    }
  });

  it("a missing or failed finalized tool result makes valid-looking arguments unusable", () => {
    const args = canonicalArguments(REVIEWER_V2_CELL);
    for (const [label, messages] of [
      ["missing", [assistantWithCalls([{ id: "call-unexecuted", name: reviewerTool, arguments: args }])]],
      ["failed", [
        assistantWithCalls([{ id: "call-refused", name: reviewerTool, arguments: args }]),
        toolResultLike("call-refused", reviewerTool, true),
      ]],
    ] as const) {
      const frames = framesOf(messages, issued);
      expect(frames, label).toHaveLength(1);
      expect(frames[0], label).toMatchObject({ kind: "incomplete" });
      expect(observeEmissionCalls(frames).kind, label).toBe("unusable");
      const capture = piReviewerCaptureObservation(messages, issued);
      expect(capture.kind, label).toBe("terminal-refusal");
      if (capture.kind === "terminal-refusal") expect(capture.reason, label).toBe("unusable-observation");
    }
  });

  it("refuses duplicate finalized toolResult entries with one toolCallId instead of treating either as authoritative", () => {
    const args = canonicalArguments(REVIEWER_V2_CELL);
    const messages = [
      assistantWithCalls([{ id: "call-duplicate-result", name: reviewerTool, arguments: args }]),
      toolResultLike("call-duplicate-result", reviewerTool),
      toolResultLike("call-duplicate-result", reviewerTool),
    ];
    const frames = framesOf(messages, issued);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "incomplete",
      toolCallId: "call-duplicate-result",
      reason: expect.stringContaining("2 finalized tool results; exactly one is required"),
    });
    expect(observeEmissionCalls(frames).kind).toBe("unusable");
    expect(piReviewerCaptureObservation(messages, issued)).toMatchObject({
      kind: "terminal-refusal",
      reason: "unusable-observation",
    });
  });

  it("observes mismatched toolResult names and non-false isError for the emission call id as incomplete", () => {
    const args = canonicalArguments(REVIEWER_V2_CELL);
    for (const [label, toolName, isError, reason] of [
      ["wrong tool name", "bash", false, "mismatched tool result"],
      ["missing success flag", reviewerTool, undefined, "non-success isError"],
      ["non-boolean success flag", reviewerTool, "false", "non-success isError"],
    ] as const) {
      const messages = [
        assistantWithCalls([{ id: "call-mismatched-result", name: reviewerTool, arguments: args }]),
        { role: "toolResult", toolCallId: "call-mismatched-result", toolName, isError,
          content: [{ type: "text", text: "payload acknowledged" }] },
      ];
      const frames = framesOf(messages, issued);
      expect(frames, label).toHaveLength(1);
      expect(frames[0], label).toMatchObject({
        kind: "incomplete",
        toolCallId: "call-mismatched-result",
        reason: expect.stringContaining(reason),
      });
      expect(observeEmissionCalls(frames).kind, label).toBe("unusable");
      expect(piReviewerCaptureObservation(messages, issued).kind, label).toBe("terminal-refusal");
    }
  });

  it("an aborted turn finalizes every emission call in it as incomplete BEFORE argument shape — finalization is the causal reason (AD-8)", () => {
    // The cancellation path a live launcher produces: the transport finalizes
    // the turn as aborted while a partial toolCall block carries arguments the
    // wire never completed. The frame's reason is the FINALIZATION, not the
    // argument form — the call died with its turn regardless of how its
    // arguments look, and the diagnostic must say which.
    const registryCell = JUDGE_V1_CELL;
    const messages = [
      {
        role: "assistant",
        stopReason: "aborted",
        content: [{
          type: "toolCall",
          id: "call-aborted-malformed",
          name: registryCell.spec.toolName,
          arguments: "not-an-object",
        }],
      },
    ];
    const frames = framesOf(messages, mintedBindingFor(registryCell, "req-emission-frames-aborted-malformed"));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "incomplete",
      toolCallId: "call-aborted-malformed",
      reason: expect.stringContaining("belongs to an assistant turn finalized as aborted"),
    });
    expect(observeEmissionCalls(frames).kind).toBe("unusable");
  });

  it("a failed singleton typed-block emission refuses the exact final-message fallback reproduction", () => {
    const messages = [
      {
        role: "assistant",
        content: {
          type: "toolCall",
          id: "call-1",
          name: reviewerTool,
          arguments: { schemaVersion: 2, kind: "standalone-review", findings: "bad" },
        },
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: reviewerTool,
        isError: true,
        content: [{ type: "text", text: "schema rejected" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: '{"schemaVersion":2,"kind":"standalone-review","findings":[]}' }],
      },
    ];

    const frames = framesOf(messages, issued);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "incomplete",
      toolCallId: "call-1",
      reason: expect.stringContaining("failed"),
    });
    const capture = piReviewerCaptureObservation(messages, issued);
    expect(capture.kind).toBe("terminal-refusal");
    if (capture.kind === "terminal-refusal") expect(capture.reason).toBe("unusable-observation");
  });

  it("normalizes array and singleton typed-block emissions to the same unusable observation (property)", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{1,12}$/),
        fc.integer({ min: 0, max: 1_000 }),
        (suffix, sentinel) => {
          const id = `call-${suffix}`;
          const block = {
            type: "toolCall",
            id,
            name: reviewerTool,
            arguments: { schemaVersion: 2, kind: "standalone-review", findings: sentinel },
          };
          for (const content of [block, [block]]) {
            const frames = framesOf([
              { role: "assistant", content },
              toolResultLike(id, reviewerTool, true),
            ], issued);
            expect(frames).toHaveLength(1);
            expect(frames[0]).toMatchObject({ kind: "incomplete", toolCallId: id });
            expect(observeEmissionCalls(frames).kind).toBe("unusable");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("refuses accessor-backed native content without invoking it", () => {
    let accessorReads = 0;
    const assistant = Object.defineProperty({ role: "assistant" }, "content", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return { type: "toolCall", id: "call-accessor", name: reviewerTool, arguments: {} };
      },
    });

    const scanned = piEmissionCallFrames([assistant], issued);
    expect(scanned.ok).toBe(false);
    expect(accessorReads).toBe(0);
    const capture = piReviewerCaptureObservation([assistant], issued);
    expect(capture.kind).toBe("terminal-refusal");
    expect(accessorReads).toBe(0);
  });

  it("does not collapse an arbitrary singleton object into a valid tool call or fallback", () => {
    const messages = [
      { role: "assistant", content: { id: "call-not-typed", name: reviewerTool, arguments: {} } },
      { role: "assistant", content: [{ type: "text", text: '{"schemaVersion":2,"kind":"standalone-review","findings":[]}' }] },
    ];
    expect(framesOf(messages, issued)).toEqual([]);
    const capture = piReviewerCaptureObservation(messages, issued);
    expect(capture.kind).toBe("terminal-refusal");
    if (capture.kind === "terminal-refusal") {
      // The selection arm's own typed refusal is RETAINED, then composed with
      // the independent transcript scan's refusal — neither erases the other.
      expect(capture.reason).toBe("no-final-payload");
      expect(capture.message).toContain("result carried no final text payload;");
      expect(capture.message).toContain("the independent transcript scan also refused:");
      expect(capture.message.length).toBeGreaterThan("result carried no final text payload; the independent transcript scan also refused:".length);
    }
  });

  it("retains unknown argument keys in complete frames as unprojected enumerable snapshots", () => {
    const args = {
      ...(canonicalArguments(REVIEWER_V2_CELL) as Record<string, unknown>),
      adapterSentinel: { retained: true },
    };
    const [call] = asCompleteCalls(framesOf([
      assistantWithCalls([{ id: "call-raw", name: reviewerTool, arguments: args }]),
      toolResultLike("call-raw", reviewerTool),
    ], issued));
    expect(call!.arguments).toEqual(args);
    expect(call!.arguments).toHaveProperty("adapterSentinel", { retained: true });
  });

  it("a malformed unrelated entry does not hide a valid emission call from the independent scan", () => {
    const args = canonicalArguments(REVIEWER_V2_CELL);
    const frames = framesOf([
      { role: "assistant", content: 42 },
      assistantWithCalls([{ id: "call-after-corruption", name: reviewerTool, arguments: args }]),
      toolResultLike("call-after-corruption", reviewerTool),
    ], issued);
    expect(asCompleteCalls(frames)).toHaveLength(1);
    expect(asCompleteCalls(frames)[0]!.toolCallId).toBe("call-after-corruption");
  });

  it("the production reviewer capture selects a successful emission after a malformed unrelated entry with no prose", () => {
    const args = canonicalArguments(REVIEWER_V2_CELL);
    const observation = piReviewerCaptureObservation([
      { role: "assistant", content: 42 },
      assistantWithCalls([{ id: "call-after-unrelated-malformation", name: reviewerTool, arguments: args }]),
      toolResultLike("call-after-unrelated-malformation", reviewerTool),
    ], issued);

    expect(observation.kind).toBe("candidates");
    if (observation.kind === "candidates") {
      expect(observation.candidates).toHaveLength(1);
      expect(observation.candidates[0]!.origin).toBe("emission-tool-arguments");
      expect(JSON.parse(observation.candidates[0]!.text)).toEqual(args);
    }
  });

  it("a call to a DIFFERENT producer kind's tool is a complete frame carrying the OBSERVED kind — and the selection refuses it as unexpected-kind, never a self-selected decoder (FR-014)", () => {
    const messages = [
      assistantWithCalls([{ id: "call-wrong", name: judgeTool, arguments: { criterion: "extensibility", rankings: [] } }]),
      toolResultLike("call-wrong", judgeTool),
    ];
    const frames = framesOf(messages, issued);
    const [frame] = asCompleteCalls(frames);
    expect(frame!.kind).toEqual({ kind: "judge-verdict" });
    expect(frame!.version).toBe(issued.version);
    const observation = observeEmissionCalls(frames);
    expect(observation.kind).toBe("single-call");
    const selection = selectCanonicalPayload(issued, observation, [] satisfies readonly FinalPayloadCandidate[]);
    expect(selection.kind).toBe("observation-refused");
    if (selection.kind === "observation-refused") {
      expect(selection.refusal.code).toBe("unexpected-kind");
      expect(selection.refusal.message).toContain("judge-verdict");
    }
  });

  it("a prefix-reserved name outside the frozen registry refuses as an incomplete frame — never absorbed as absence (FR-014)", () => {
    const messages = [assistantWithCalls([{ id: "call-stale", name: "loom_emit_gibberish", arguments: { arbitrary: true } }])];
    const frames = framesOf(messages, issued);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      kind: "incomplete",
      toolCallId: "call-stale",
      reason: expect.stringContaining("loom_emit_gibberish"),
    });
    expect(observeEmissionCalls(frames).kind).toBe("unusable");
  });

  it("an emission call without a recoverable identity, and one with non-object arguments, are incomplete frames with reasons", () => {
    const noIdentity = framesOf([assistantWithCalls([{ id: "", name: reviewerTool, arguments: { schemaVersion: 2 } }])], issued);
    expect(noIdentity).toHaveLength(1);
    expect(noIdentity[0]).toMatchObject({ kind: "incomplete", toolCallId: null });
    const badArguments = framesOf([
      { role: "assistant", content: [{ type: "toolCall", id: "call-bad", name: reviewerTool, arguments: "not-an-object" }] },
      toolResultLike("call-bad", reviewerTool, true),
    ], issued);
    expect(badArguments).toHaveLength(1);
    expect(badArguments[0]).toMatchObject({ kind: "incomplete", toolCallId: "call-bad" });
    for (const frames of [noIdentity, badArguments]) {
      const observation = observeEmissionCalls(frames);
      expect(observation.kind).toBe("unusable");
      if (observation.kind === "unusable") expect(observation.reason.length).toBeGreaterThan(0);
    }
  });

  it("an exact replay of one call identity folds idempotently; a contradictory replay refuses (FR-007)", () => {
    const args = canonicalArguments(REVIEWER_V2_CELL);
    const replayed = framesOf([
      assistantWithCalls([{ id: "call-replay", name: reviewerTool, arguments: args }]),
      assistantWithCalls([{ id: "call-replay", name: reviewerTool, arguments: args }]),
      toolResultLike("call-replay", reviewerTool),
    ], issued);
    expect(asCompleteCalls(replayed)).toHaveLength(2);
    expect(observeEmissionCalls(replayed)).toEqual(observeEmissionCalls(framesOf([
      assistantWithCalls([{ id: "call-replay", name: reviewerTool, arguments: args }]),
      toolResultLike("call-replay", reviewerTool),
    ], issued)));
    const contradictory = framesOf([
      assistantWithCalls([{ id: "call-contradicted", name: reviewerTool, arguments: args }]),
      assistantWithCalls([{ id: "call-contradicted", name: reviewerTool, arguments: { schemaVersion: 2, kind: "standalone-review", findings: [] } }]),
      toolResultLike("call-contradicted", reviewerTool),
    ], issued);
    const observation = observeEmissionCalls(contradictory);
    expect(observation.kind).toBe("unusable");
    if (observation.kind === "unusable") expect(observation.reason).toContain("contradictory");
  });

  it("two distinct calls and an incomplete-beside-complete pair refuse exactly as the fold classifies them", () => {
    const args = canonicalArguments(REVIEWER_V2_CELL);
    const doubled = observeEmissionCalls(framesOf([
      assistantWithCalls([{ id: "call-a", name: reviewerTool, arguments: args }]),
      assistantWithCalls([{ id: "call-b", name: reviewerTool, arguments: args }]),
      toolResultLike("call-a", reviewerTool),
      toolResultLike("call-b", reviewerTool),
    ], issued));
    expect(doubled.kind).toBe("multiple-calls");

    const mixed = observeEmissionCalls(framesOf([
      assistantWithCalls([{ id: "call-good", name: reviewerTool, arguments: args }]),
      { role: "assistant", content: [{ type: "toolCall", id: "call-broken", name: reviewerTool, arguments: "nope" }] },
      toolResultLike("call-good", reviewerTool),
      toolResultLike("call-broken", reviewerTool, true),
    ], issued));
    expect(mixed.kind).toBe("unusable");
  });

  it("two distinct calls through the real adapter reach the duplicate arm carrying BOTH observed calls (FR-007)", () => {
    // The real transcript scan folds two distinct successfully executed calls
    // into multiple-calls, and the production selection's duplicate arm
    // carries the ambiguity's content — the observed calls in first-observed
    // order — so the terminal diagnostic names what was observed instead of a
    // bare count.
    const args = canonicalArguments(REVIEWER_V2_CELL);
    const messages = [
      assistantWithCalls([{ id: "call-a", name: reviewerTool, arguments: args }]),
      assistantWithCalls([{ id: "call-b", name: reviewerTool, arguments: args }]),
      toolResultLike("call-a", reviewerTool),
      toolResultLike("call-b", reviewerTool),
    ];
    const observation = observeEmissionCalls(framesOf(messages, issued));
    expect(observation.kind).toBe("multiple-calls");
    const selection = selectCanonicalPayload(issued, observation, [] satisfies readonly FinalPayloadCandidate[]);
    expect(selection.kind).toBe("duplicate-emission-call");
    if (selection.kind === "duplicate-emission-call") {
      expect(selection.calls.map(({ toolCallId }) => toolCallId)).toEqual(["call-a", "call-b"]);
      expect(selection.calls.every((call) => call.requestId === issued.requestId)).toBe(true);
    }
    // The production capture terminalises the same ambiguity: the shared
    // decision's arm, translated at the adapter, is a terminal refusal — never
    // a silent pick of one of the two calls.
    expect(piReviewerCaptureObservation(messages, issued)).toMatchObject({
      kind: "terminal-refusal",
      reason: "ambiguous-emission-call",
    });
  });

  it("the production reviewer capture refuses contradictory duplicate frames with the fold's retained diagnostic (FR-007/AD-9)", () => {
    // Two finalized frames share one tool-call identity but disagree on the
    // arguments: the fold refuses the observation as unusable (naming the
    // differing contract field), and the production capture translation
    // carries that retained diagnostic — never a count, never absence, never
    // a silent pick of either frame.
    const args = canonicalArguments(REVIEWER_V2_CELL);
    const messages = [
      assistantWithCalls([{ id: "call-contradicted", name: reviewerTool, arguments: args }]),
      assistantWithCalls([{
        id: "call-contradicted",
        name: reviewerTool,
        arguments: { schemaVersion: 2, kind: "standalone-review", findings: [] },
      }]),
      toolResultLike("call-contradicted", reviewerTool),
    ];
    const frames = framesOf(messages, issued);
    expect(frames).toHaveLength(2);
    const observation = observeEmissionCalls(frames);
    expect(observation.kind).toBe("unusable");
    if (observation.kind === "unusable") {
      expect(observation.reason).toContain("contradictory duplicate transport frames for emission tool call call-contradicted");
      expect(observation.reason).toContain("(differing: arguments)");
    }
    const capture = piReviewerCaptureObservation(messages, issued);
    expect(capture.kind).toBe("terminal-refusal");
    if (capture.kind === "terminal-refusal") {
      expect(capture.reason).toBe("unusable-observation");
      expect(capture.message).toContain("differing: arguments");
    }
  });

  it("observes only ASSISTANT tool calls — user-carried and result-carried tool-call shapes are not emission observations (AD-8)", () => {
    const args = canonicalArguments(REVIEWER_V2_CELL);
    const messages = [
      { role: "user", content: [{ type: "toolCall", id: "call-user", name: reviewerTool, arguments: args }] },
      { role: "toolResult", toolCallId: "call-user", toolName: reviewerTool, content: [{ type: "text", text: JSON.stringify(args) }] },
    ];
    expect(framesOf(messages, issued)).toEqual([]);
  });

  it("refuses a non-array transcript — the scan fails closed, it never invents absence", () => {
    const scanned = piEmissionCallFrames({ role: "assistant" }, issued);
    expect(scanned.ok).toBe(false);
  });

  it("is deterministic over arbitrary transcripts and attributes every complete frame to the issued request (property)", () => {
    const nameArb = fc.constantFrom(JUDGE_V1_CELL.spec.toolName, "loom_emit_future_tool", "bash", "read");
    const idArb = fc.oneof(fc.stringMatching(/^call-[a-z0-9]{1,8}$/), fc.constant(""));
    const blockArb = fc.oneof(
      fc.record({ type: fc.constant("toolCall"), id: idArb, name: nameArb, arguments: fc.record({ n: fc.integer({ min: 0, max: 9 }) }) }),
      fc.record({ type: fc.constant("text"), text: fc.string({ maxLength: 8 }) }),
    );
    const messageArb = fc.record({
      role: fc.constantFrom("assistant", "user", "toolResult"),
      content: fc.array(blockArb, { maxLength: 4 }),
    });
    const judgeIssued = mintedBindingFor(JUDGE_V1_CELL, OBSERVED_REQUEST_ID);
    fc.assert(
      fc.property(fc.array(messageArb, { maxLength: 5 }), (messages) => {
        const first = piEmissionCallFrames(messages, judgeIssued);
        const second = piEmissionCallFrames(messages, judgeIssued);
        expect(canonicalStructuralEquals(first, second)).toBe(true);
        if (first.ok) {
          for (const frame of first.value) {
            if (frame.kind === "complete") {
              expect(frame.call.requestId).toBe(judgeIssued.requestId);
              expect(frame.call.toolCallId.length).toBeGreaterThan(0);
              expect(frame.call.kind.kind).toBe("judge-verdict");
              expect(frame.call.version).toBe(judgeIssued.version);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

function userLike(): unknown {
  return { role: "user", content: [{ type: "text", text: "Emit the issued payload exactly once." }] };
}

function toolResultLike(id: string, name: string, isError = false): unknown {
  return { role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text: "payload acknowledged" }] };
}
