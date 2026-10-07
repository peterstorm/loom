/**
 * The persistent panel program kernel at its own interface, driven by a
 * trivial third program — a tally counter — with neither real panel in
 * sight: the reducer guard, replay-equals-state, histories, checkpoints, the
 * persistence plan and its dedup key, and proof-domain isolation. The two
 * real panels' instantiations are pinned by persistent-panel-kernel.property
 * and the persistent panel suites.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { sha256Hex } from "../../src/core/digest";
import { safeRecord } from "../../src/core/exact-data";
import { panelError, persistentFailure, persistentSuccess } from "../../src/core/panel-authority";
import { parseOrchestrationRunId, type OrchestrationRunId } from "../../src/core/orchestration-contract";
import {
  createPanelProofs,
  jsonEqual,
  panelProgramCheckpoint,
  parsePanelProgramCheckpoint,
  parsePanelProgramHistory,
  planPanelProgramPersistence,
  reduceParsedPanelEvent,
  reducePanelProgram,
  replayPanelProgram,
  resumePanelProgram,
  type PanelProgramDefinition,
  type PanelStep,
} from "../../src/core/persistent-panel-program";
import { createPanelPublications } from "../fixtures/panel-authority";
import { refusal, value } from "../fixtures/parse-result";

// ---------------------------------------------------------------------------
// The tally program: count increments until finished; a count of 13 is an
// invariant violation its transition throws on.
// ---------------------------------------------------------------------------

type TallyAuthority = Readonly<{ runId: OrchestrationRunId }>;
type TallyAuthorityInput = Readonly<{ runId: string }>;
type TallyState = Readonly<{ authority: TallyAuthority; stage: "counting" | "done"; count: number }>;
type TallyEvent = Readonly<{ schemaVersion: 1; type: "increment" | "finish" }>;
type TallyAction = Readonly<{ kind: "tally"; count: number }>;
type TallyStep = PanelStep<TallyState, TallyAction, TallyEvent>;

/** This suite's private publication store: the resolver every parsed event reads. */
const { resolver } = createPanelPublications();
const proofs = createPanelProofs();
const tallyState = (state: TallyState): TallyState => proofs.prove("refutation:state", Object.freeze(state));
const tallyAction = (state: TallyState): TallyAction => Object.freeze({ kind: "tally", count: state.count });
const tallyStep = (state: TallyState): TallyStep => Object.freeze({ state, action: tallyAction(state) });

const TALLY: PanelProgramDefinition<"refutation", TallyAuthority, TallyAuthorityInput, TallyState, TallyAction, TallyEvent> = {
  panel: "refutation",
  proofs,
  start: (authority) => tallyStep(tallyState({ authority, stage: "counting", count: 0 })),
  action: tallyAction,
  parseEvent: (state, raw) => {
    if (!proofs.proven("refutation:state", state)) return persistentFailure(panelError("refutation", "malformed-checkpoint", "tally events parse only over a proved state"));
    const event = safeRecord(raw, ["schemaVersion", "type"]);
    if (event === null || event.schemaVersion !== 1 || (event.type !== "increment" && event.type !== "finish")) {
      return persistentFailure(panelError("refutation", "malformed-event", "tally event must be an exact increment or finish"));
    }
    return persistentSuccess(proofs.prove("refutation:event", Object.freeze({ schemaVersion: 1 as const, type: event.type })));
  },
  transition: (state, event) => {
    if (event.type === "finish") return persistentSuccess(tallyStep(tallyState({ ...state, stage: "done" })));
    if (state.count === 12) throw new Error("tally invariant: thirteen is unrepresentable");
    return persistentSuccess(tallyStep(tallyState({ ...state, count: state.count + 1 })));
  },
  parseAuthority: (raw) => {
    const record = safeRecord(raw, ["runId"]);
    const runId = parseOrchestrationRunId(record?.runId);
    return runId.ok
      ? persistentSuccess(Object.freeze({ runId: runId.value }))
      : persistentFailure(panelError("refutation", "invalid-authority", runId.error.message));
  },
  authorityJson: (authority) => Object.freeze({ runId: authority.runId }),
  // A tally state derives nothing from its own content: its JSON is canonical.
  canonicalStateJson: (stateJson) => stateJson,
};

const AUTHORITY: TallyAuthority = Object.freeze({ runId: value(parseOrchestrationRunId("run.tally")) });
const OTHER_AUTHORITY: TallyAuthority = Object.freeze({ runId: value(parseOrchestrationRunId("run.other-tally")) });
const INCREMENT = Object.freeze({ schemaVersion: 1, type: "increment" });
const FINISH = Object.freeze({ schemaVersion: 1, type: "finish" });
const increments = (count: number) => Array.from({ length: count }, () => INCREMENT);
/** Record `count` increments one submission at a time, as a shell would. */
const recordIncrements = (count: number): TallyStep => {
  let step = TALLY.start(AUTHORITY);
  for (let index = 0; index < count; index += 1) step = value(reduceParsedPanelEvent(TALLY, step.state, INCREMENT, resolver));
  return step;
};

describe("persistent panel program kernel: the reducer guard", () => {
  it("transitions a proved state on a strictly parsed event", () => {
    const started = TALLY.start(AUTHORITY);
    const event = value(TALLY.parseEvent(started.state, INCREMENT, resolver));
    expect(value(reducePanelProgram(TALLY, started.state, event)).state).toMatchObject({ stage: "counting", count: 1 });
  });

  it("refuses a state outside the program's proof domain", () => {
    const forged: TallyState = Object.freeze({ authority: AUTHORITY, stage: "counting", count: 0 });
    const event = value(TALLY.parseEvent(TALLY.start(AUTHORITY).state, INCREMENT, resolver));
    expect(refusal(reducePanelProgram(TALLY, forged, event))).toMatchObject({ kind: "malformed-checkpoint", panel: "refutation" });
  });

  it("refuses an event that was not strictly parsed", () => {
    const forged: TallyEvent = Object.freeze({ schemaVersion: 1, type: "increment" });
    expect(refusal(reducePanelProgram(TALLY, TALLY.start(AUTHORITY).state, forged))).toMatchObject({ kind: "malformed-event" });
  });

  it("admits no transition out of a terminal stage", () => {
    const done = value(reduceParsedPanelEvent(TALLY, TALLY.start(AUTHORITY).state, FINISH, resolver));
    expect(refusal(reduceParsedPanelEvent(TALLY, done.state, INCREMENT, resolver)))
      .toEqual({ kind: "terminal-state", panel: "refutation", message: "refutation panel is done and cannot transition" });
  });

  it("fails a thrown invariant closed while keeping its message", () => {
    expect(refusal(reduceParsedPanelEvent(TALLY, recordIncrements(12).state, INCREMENT, resolver))).toEqual({ kind: "malformed-event", panel: "refutation",
      message: "refutation event could not be safely reduced: tally invariant: thirteen is unrepresentable" });
  });

  it("resumes only a proved state, with its own next action", () => {
    const step = recordIncrements(3);
    expect(value(resumePanelProgram(TALLY, step.state))).toEqual({ state: step.state, action: { kind: "tally", count: 3 } });
    expect(refusal(resumePanelProgram(TALLY, Object.freeze({ ...step.state })))).toMatchObject({ kind: "malformed-checkpoint" });
  });
});

describe("persistent panel program kernel: replay, checkpoints and persistence", () => {
  it("replays any recorded prefix to exactly the state its submissions produced, checkpoint included", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 12 }), fc.boolean(), (count, finish) => {
      const recorded = finish ? value(reduceParsedPanelEvent(TALLY, recordIncrements(count).state, FINISH, resolver)) : recordIncrements(count);
      const events = [...increments(count), ...(finish ? [FINISH] : [])];
      const replayed = value(replayPanelProgram(TALLY, AUTHORITY, events, resolver));
      expect(jsonEqual(replayed.state, recorded.state)).toBe(true);
      const checkpoint = value(panelProgramCheckpoint(TALLY, recorded.state, value(parsePanelProgramHistory(TALLY, AUTHORITY, events, resolver)).events, resolver));
      expect(checkpoint).toMatchObject({ schemaVersion: 2, kind: "refutation-panel-checkpoint", authority: { runId: "run.tally" } });
      const restored = value(parsePanelProgramCheckpoint(TALLY, JSON.parse(JSON.stringify(checkpoint)), resolver));
      expect(jsonEqual(restored.state, recorded.state)).toBe(true);
      expect(value(resumePanelProgram(TALLY, restored.state)).action).toEqual({ kind: "tally", count });
    }));
  });

  it.each([
    ["a non-array history", { not: "events" }, "refutation history must be a dense JSON event array"],
    ["an unknown event", [INCREMENT, { schemaVersion: 1, type: "decrement" }], "tally event must be an exact increment or finish"],
    ["an event after the terminal stage", [FINISH, INCREMENT], "refutation panel is done and cannot transition"],
  ])("refuses to replay %s", (_name, events, message) => {
    expect(refusal(replayPanelProgram(TALLY, AUTHORITY, events, resolver)).message).toBe(message);
  });

  it("refuses a checkpoint whose prefix does not replay to the supplied state", () => {
    expect(refusal(panelProgramCheckpoint(TALLY, recordIncrements(2).state, value(parsePanelProgramHistory(TALLY, AUTHORITY, increments(1), resolver)).events, resolver)))
      .toMatchObject({ kind: "malformed-checkpoint", message: "refutation checkpoint event prefix does not replay to the supplied state" });
  });

  /** The durable JSON of a two-increment checkpoint, as a shell reads it back. */
  const durableCheckpoint = (): Record<string, unknown> => {
    const history = value(parsePanelProgramHistory(TALLY, AUTHORITY, increments(2), resolver));
    return JSON.parse(JSON.stringify(value(panelProgramCheckpoint(TALLY, recordIncrements(2).state, history.events, resolver)))) as Record<string, unknown>;
  };
  const NOT_EXACT = { kind: "malformed-checkpoint", message: "refutation checkpoint must be an exact schemaVersion 2 record" } as const;
  const DISAGREES = { kind: "malformed-checkpoint", message: "refutation checkpoint state disagrees with its immutable event prefix" } as const;

  it.each<[string, (raw: Record<string, unknown>) => unknown, Readonly<{ kind: string; message?: string }>]>([
    ["another program's kind", (raw) => ({ ...raw, kind: "architecture-panel-checkpoint" }), NOT_EXACT],
    ["a forward schemaVersion", (raw) => ({ ...raw, schemaVersion: 3 }), NOT_EXACT],
    ["a past schemaVersion", (raw) => ({ ...raw, schemaVersion: 1 }), NOT_EXACT],
    ["an extra top-level key", (raw) => ({ ...raw, note: "unrecorded" }), NOT_EXACT],
    ["a recorded state its prefix disagrees with", (raw) => ({ ...raw, state: { ...(raw.state as object), count: 7 } }), DISAGREES],
    // The kernel filters no key by name: a field called like a roster's derived
    // view is recorded content like any other, unless the program's canonical
    // projection says otherwise.
    ["a recorded state with a key named like a derived view", (raw) => ({ ...raw, state: { ...(raw.state as object), byId: {} } }), DISAGREES],
    ["an authority its codec refuses", (raw) => ({ ...raw, authority: { runId: 7 } }), { kind: "invalid-authority" }],
    ["an authority that is not a record at all", (raw) => ({ ...raw, authority: "run.tally" }), { kind: "invalid-authority" }],
  ])("refuses a checkpoint carrying %s", (_name, tamper, expected) => {
    expect(refusal(parsePanelProgramCheckpoint(TALLY, tamper(durableCheckpoint()), resolver))).toMatchObject(expected);
  });

  it("compares recorded and replayed states only through the program's canonical projection", () => {
    // A twin whose state JSON carries a derived `echo` view its canonical form omits.
    const withoutEcho = (stateJson: unknown): unknown => {
      if (typeof stateJson !== "object" || stateJson === null) return stateJson;
      return Object.fromEntries(Object.entries(stateJson).filter(([key]) => key !== "echo"));
    };
    const twin: typeof TALLY = { ...TALLY, canonicalStateJson: withoutEcho };
    const echoed = { ...durableCheckpoint(), state: { ...(durableCheckpoint().state as object), echo: { size: 2 } } };
    expect(value(parsePanelProgramCheckpoint(twin, echoed, resolver)).state).toMatchObject({ count: 2 });
    expect(refusal(parsePanelProgramCheckpoint(TALLY, echoed, resolver))).toMatchObject(DISAGREES);
    // The projection decides agreement, never membership: the twin still refuses real disagreement.
    const disagreeing = { ...echoed, state: { ...echoed.state, count: 7 } };
    expect(refusal(parsePanelProgramCheckpoint(twin, disagreeing, resolver))).toMatchObject(DISAGREES);
  });

  it("plans the journal append and checkpoint replacement of one recorded step, keyed by sequence and content", () => {
    const history = value(parsePanelProgramHistory(TALLY, AUTHORITY, increments(2), resolver));
    const step = value(reduceParsedPanelEvent(TALLY, value(replayPanelProgram(TALLY, AUTHORITY, increments(2), resolver)).state, INCREMENT, resolver));
    const [append, replace] = value(planPanelProgramPersistence(TALLY, step, history, resolver));
    expect(append).toEqual({ schemaVersion: 1, kind: "append-refutation-panel-event", runId: "run.tally", sequence: 3,
      dedupKey: `run.tally:3:${sha256Hex(JSON.stringify(step.recordedEvent))}`, event: step.recordedEvent });
    expect(replace).toMatchObject({ kind: "replace-refutation-panel-checkpoint", sequence: 3, checkpoint: { state: { count: 3 } } });
    expect(replace.dedupKey).toBe(`run.tally:3:${sha256Hex(JSON.stringify(replace.kind === "replace-refutation-panel-checkpoint" ? replace.checkpoint : null))}`);
  });

  it("plans nothing for a step that was not recorded, or over a history it does not extend", () => {
    const history = value(parsePanelProgramHistory(TALLY, AUTHORITY, increments(1), resolver));
    const recorded = value(reduceParsedPanelEvent(TALLY, value(replayPanelProgram(TALLY, AUTHORITY, increments(1), resolver)).state, INCREMENT, resolver));
    expect(refusal(planPanelProgramPersistence(TALLY, TALLY.start(AUTHORITY), history, resolver))).toMatchObject({ kind: "malformed-event" });
    expect(refusal(planPanelProgramPersistence(TALLY, recorded, { ...history }, resolver))).toMatchObject({ kind: "malformed-history" });
    const foreign = value(parsePanelProgramHistory(TALLY, OTHER_AUTHORITY, increments(1), resolver));
    expect(refusal(planPanelProgramPersistence(TALLY, recorded, foreign, resolver))).toMatchObject({ kind: "malformed-history" });
    const stale = value(parsePanelProgramHistory(TALLY, AUTHORITY, increments(2), resolver));
    expect(refusal(planPanelProgramPersistence(TALLY, recorded, stale, resolver))).toMatchObject({ kind: "malformed-checkpoint",
      message: "refutation event prefix does not replay exactly to the proposed checkpoint state" });
  });
});

describe("persistent panel program kernel: proof domains", () => {
  it("never accepts a value minted in another domain, even under the same panel tag", () => {
    const foreign = createPanelProofs();
    const twin = { ...TALLY, proofs: foreign };
    const state = TALLY.start(AUTHORITY).state;
    expect(proofs.proven("refutation:state", state)).toBe(true);
    expect(foreign.proven("refutation:state", state)).toBe(false);
    expect(refusal(resumePanelProgram(twin, state))).toMatchObject({ kind: "malformed-checkpoint" });
  });

  it("keeps panel and role apart within one domain", () => {
    const state = TALLY.start(AUTHORITY).state;
    expect(proofs.proven("architecture:state", state)).toBe(false);
    expect(proofs.proven("refutation:event", state)).toBe(false);
    expect(proofs.proven("refutation:state", null)).toBe(false);
  });
});
