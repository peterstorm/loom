import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeProgramDedupKey,
  createCheckpointCodec,
  createFileProgramJournal,
  createInMemoryProgramJournal,
  createProgramJob,
  projectProgramTrace,
  replayProgram,
  resumeProgram,
  runProgram,
  toProgramMachine,
  type ProgramData,
  type ProgramEventRecord,
  type ProgramJournal,
  type ProgramRuntimeResult,
} from "../../src/orchestration/fugue-program-runtime";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "loom-fugue-runtime-"));
  cleanup.push(directory);
  return directory;
}

// --- A minimal program standing in for a Loom domain reducer -----------------

type Stage = "preparing" | "awaiting" | "suspended" | "ready" | "done" | "failed";
type TestState = Readonly<{ stage: Stage; accepted: number }>;
/** `seen` is a Set on purpose: checkpoints must round-trip it through toJson. */
type TestContext = Readonly<{ runId: string; seen: Set<string> }>;
type TestEvent =
  | Readonly<{ kind: "published" }>
  | Readonly<{ kind: "accepted"; slot: string; secret: string }>
  | Readonly<{ kind: "gate-reached" }>
  | Readonly<{ kind: "decided" }>
  | Readonly<{ kind: "committed" }>
  | Readonly<{ kind: "fail"; message: string }>;

const ok = (state: TestState, context: TestContext): ProgramRuntimeResult<ProgramData<TestState, TestContext>> =>
  ({ ok: true, value: { state, context } });
const rejected = (message: string): ProgramRuntimeResult<ProgramData<TestState, TestContext>> =>
  ({ ok: false, error: { kind: "program-runtime-rejected", message } });

function reduce(
  state: TestState,
  event: TestEvent,
  context: TestContext,
): ProgramRuntimeResult<ProgramData<TestState, TestContext>> {
  if (event.kind === "fail") return ok({ stage: "failed", accepted: state.accepted }, context);
  if (event.kind === "published" && state.stage === "preparing") return ok({ stage: "awaiting", accepted: 0 }, context);
  if (event.kind === "accepted" && state.stage === "awaiting") {
    const accepted = state.accepted + 1;
    const seen = new Set(context.seen);
    seen.add(event.slot);
    return ok({ stage: accepted >= 2 ? "ready" : "awaiting", accepted }, { ...context, seen });
  }
  if (event.kind === "gate-reached" && state.stage === "awaiting") {
    return ok({ stage: "suspended", accepted: state.accepted }, context);
  }
  if (event.kind === "decided" && state.stage === "suspended") {
    return ok({ stage: "ready", accepted: state.accepted }, context);
  }
  if (event.kind === "committed" && state.stage === "ready") {
    return ok({ stage: "done", accepted: state.accepted }, context);
  }
  return rejected(`${event.kind} is not accepted during ${state.stage}`);
}

const machine = toProgramMachine<TestState, TestEvent, TestContext>({
  reduce,
  onRejected: (state, context, message) => ({ state: { stage: "failed", accepted: state.accepted }, context: { ...context, seen: new Set(context.seen).add(`rejected:${message}`) } }),
  isTerminal: (state) => state.stage === "done" || state.stage === "failed",
  isFailed: (state) => state.stage === "failed",
  isHalted: (state) => state.stage === "suspended",
  progress: (state) => (state.stage === "done" ? 100 : state.accepted * 25),
  stateKey: (state) => `${state.stage}:${state.accepted}`,
});

const STAGES: readonly Stage[] = ["preparing", "awaiting", "suspended", "ready", "done", "failed"];

/** Parses an untrusted checkpoint back into typed values — never a bare cast. */
const codec = createCheckpointCodec<TestState, TestContext>((raw) => {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: { kind: "program-runtime-rejected", message: "checkpoint data must be an object" } };
  const record = raw as Record<string, unknown>;
  const state = record["state"] as Record<string, unknown> | undefined;
  const context = record["context"] as Record<string, unknown> | undefined;
  if (state === undefined || context === undefined) {
    return { ok: false, error: { kind: "program-runtime-rejected", message: "checkpoint data must carry state and context" } };
  }
  if (!STAGES.includes(state["stage"] as Stage) || typeof state["accepted"] !== "number") {
    return { ok: false, error: { kind: "program-runtime-rejected", message: "checkpoint state is not a known stage" } };
  }
  if (!(context["seen"] instanceof Set) || typeof context["runId"] !== "string") {
    return { ok: false, error: { kind: "program-runtime-rejected", message: "checkpoint context did not round-trip" } };
  }
  return {
    ok: true,
    value: {
      state: { stage: state["stage"] as Stage, accepted: state["accepted"] },
      context: { runId: context["runId"], seen: context["seen"] as Set<string> },
    },
  };
});

const genesis: ProgramData<TestState, TestContext> = {
  state: { stage: "preparing", accepted: 0 },
  context: { runId: "run.test-1", seen: new Set<string>() },
};

const accept = (slot: string): TestEvent => ({ kind: "accepted", slot, secret: `payload-bytes-for-${slot}` });

/** Executor that replays a fixed script; exhausting it throws into errorEventOf. */
function scripted(events: readonly TestEvent[]): (state: TestState, context: TestContext) => Promise<TestEvent> {
  const queue = [...events];
  return async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("script exhausted");
    return next;
  };
}

const errorEventOf = (classified: Readonly<{ retriable: boolean; message: string }>): TestEvent =>
  ({ kind: "fail", message: classified.message });

async function drive(journal: ProgramJournal, resumed: ProgramData<TestState, TestContext>, script: readonly TestEvent[]) {
  return runProgram<TestState, TestEvent, TestContext>({
    runId: "run.test-1",
    machine,
    journal,
    codec,
    resumed,
    executor: scripted(script),
    errorEventOf,
  });
}

// --- Journals ---------------------------------------------------------------

describe("program journal dedup", () => {
  const record = (dedupKey: string, slot: string): ProgramEventRecord => ({
    schemaVersion: 1,
    sequence: 0,
    dedupKey,
    recordedAtMs: 1,
    event: accept(slot),
  });

  it("treats a second append carrying a known dedup key as a no-op in memory", async () => {
    const journal = createInMemoryProgramJournal();
    await journal.appendEvent(record("key-a", "s1"));
    await journal.appendEvent(record("key-a", "s1"));
    await journal.appendEvent(record("key-b", "s2"));

    const events = await journal.readEvents();
    expect(events).toHaveLength(2);
    expect(events.map((entry) => entry.sequence)).toEqual([0, 1]);
  });

  it("treats a second append carrying a known dedup key as a no-op on disk", async () => {
    const directory = runDirectory();
    const journal = createFileProgramJournal(directory);
    await journal.appendEvent(record("key-a", "s1"));
    await journal.appendEvent(record("key-a", "s1"));

    expect(readdirSync(join(directory, "events"))).toHaveLength(1);
    expect(await journal.readEvents()).toHaveLength(1);
  });

  it("names event files by append order and dedup key, and leaves no temporary files", async () => {
    const directory = runDirectory();
    const journal = createFileProgramJournal(directory);
    await journal.appendEvent(record("key-a", "s1"));
    await journal.appendEvent(record("key-b", "s2"));

    const names = readdirSync(join(directory, "events")).sort();
    expect(names).toEqual(["000000-key-a.json", "000001-key-b.json"]);
    expect(names.some((name) => name.includes(".tmp."))).toBe(false);
  });

  it("treats only a missing checkpoint as absent", async () => {
    const directory = runDirectory();
    const journal = createFileProgramJournal(directory);
    expect(await journal.readCheckpoint()).toBeNull();

    const checkpoint = join(directory, "checkpoint.json");
    symlinkSync(checkpoint, checkpoint);
    await expect(journal.readCheckpoint()).rejects.toThrow(/ELOOP/i);
  });

  it("round-trips Map/Set state through the checkpoint codec", async () => {
    const journal = createInMemoryProgramJournal();
    const data: ProgramData<TestState, TestContext> = {
      state: { stage: "awaiting", accepted: 1 },
      context: { runId: "run.test-1", seen: new Set(["slot-1"]) },
    };
    await journal.writeCheckpoint(codec.encode(data));

    const stored = await journal.readCheckpoint();
    expect(stored).not.toBeNull();
    const decoded = codec.decode(stored as string);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.context.seen).toBeInstanceOf(Set);
    expect([...decoded.value.context.seen]).toEqual(["slot-1"]);
  });
});

// --- Replay -----------------------------------------------------------------

describe("replay", () => {
  it("reconstructs state from the durable prefix without invoking an executor", () => {
    const records: readonly ProgramEventRecord[] = [
      { schemaVersion: 1, sequence: 0, dedupKey: "k0", recordedAtMs: 1, event: { kind: "published" } },
      { schemaVersion: 1, sequence: 1, dedupKey: "k1", recordedAtMs: 2, event: accept("slot-1") },
    ];

    const replayed = replayProgram(machine, genesis, records);

    expect(replayed.state).toEqual({ stage: "awaiting", accepted: 1 });
    expect([...replayed.context.seen]).toEqual(["slot-1"]);
  });

  it("accepts a checkpoint that lags the log by exactly the un-checkpointed transition", () => {
    const records: readonly ProgramEventRecord[] = [
      { schemaVersion: 1, sequence: 0, dedupKey: "k0", recordedAtMs: 1, event: { kind: "published" } },
      { schemaVersion: 1, sequence: 1, dedupKey: "k1", recordedAtMs: 2, event: accept("slot-1") },
    ];
    const lagging = codec.encode({ state: { stage: "awaiting", accepted: 0 }, context: genesis.context });

    const resumed = resumeProgram({ machine, codec, genesis, records, checkpoint: lagging });

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.state).toEqual({ stage: "awaiting", accepted: 1 });
  });

  it("fails closed when the checkpoint is not any prefix of the replayed log", () => {
    const records: readonly ProgramEventRecord[] = [
      { schemaVersion: 1, sequence: 0, dedupKey: "k0", recordedAtMs: 1, event: { kind: "published" } },
    ];
    const forged = codec.encode({ state: { stage: "done", accepted: 9 }, context: genesis.context });

    const resumed = resumeProgram({ machine, codec, genesis, records, checkpoint: forged });

    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.message).toContain("disagrees with the replayed event prefix");
  });
});

// --- Corruption -------------------------------------------------------------

describe("corruption", () => {
  it("rejects a checkpoint that is not readable JSON", () => {
    const decoded = codec.decode("{not json");
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.message).toContain("not readable JSON");
  });

  it("rejects a checkpoint written under a different schema version", () => {
    const decoded = codec.decode(JSON.stringify({ schemaVersion: 2, data: {} }));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.message).toContain("schema version must be 1");
  });

  it("rejects a structurally valid checkpoint whose state is not a known stage", () => {
    const decoded = codec.decode(JSON.stringify({
      schemaVersion: 1,
      data: { state: { stage: "smuggled", accepted: 0 }, context: { runId: "r", seen: { __set__: [] } } },
    }));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.message).toContain("not a known stage");
  });

  it("refuses to read a corrupt event file instead of folding it into state", async () => {
    const directory = runDirectory();
    const journal = createFileProgramJournal(directory);
    await journal.appendEvent({ schemaVersion: 1, sequence: 0, dedupKey: "k0", recordedAtMs: 1, event: { kind: "published" } });
    writeFileSync(join(directory, "events", "000001-k1.json"), JSON.stringify({ schemaVersion: 1, sequence: "one" }));

    await expect(journal.readEvents()).rejects.toThrow(/Corrupt program event/);
  });
});

// --- Running ----------------------------------------------------------------

describe("running a program", () => {
  it("drives a clean run to terminal, checkpointing every transition", async () => {
    const directory = runDirectory();
    const journal = createFileProgramJournal(directory);

    const outcome = await drive(journal, genesis, [
      { kind: "published" }, accept("slot-1"), accept("slot-2"), { kind: "committed" },
    ]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.data.state).toEqual({ stage: "done", accepted: 2 });
    expect(outcome.value.terminal).toBe(true);
    expect(outcome.value.halted).toBe(false);
    expect(await journal.readEvents()).toHaveLength(4);
  });

  it("halts durably at a gate and resumes from the persisted state", async () => {
    const directory = runDirectory();
    const journal = createFileProgramJournal(directory);

    const halted = await drive(journal, genesis, [{ kind: "published" }, { kind: "gate-reached" }]);

    expect(halted.ok).toBe(true);
    if (!halted.ok) return;
    expect(halted.value.halted).toBe(true);
    expect(halted.value.terminal).toBe(false);
    expect(halted.value.data.state.stage).toBe("suspended");

    const resumed = resumeProgram({
      machine, codec, genesis,
      records: await journal.readEvents(),
      checkpoint: await journal.readCheckpoint(),
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;

    const finished = await drive(journal, resumed.value, [{ kind: "decided" }, { kind: "committed" }]);
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(finished.value.data.state).toEqual({ stage: "done", accepted: 0 });
  });

  it("never checkpoints a terminal-failed state", async () => {
    const journal = createInMemoryProgramJournal();

    const outcome = await drive(journal, genesis, [{ kind: "published" }, { kind: "fail", message: "boom" }]);

    expect(outcome.ok).toBe(false);
    const checkpoint = await journal.readCheckpoint();
    expect(checkpoint).not.toBeNull();
    const decoded = codec.decode(checkpoint as string);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    // Only the `published` transition was checkpointed; the failure was not.
    expect(decoded.value.state).toEqual({ stage: "awaiting", accepted: 0 });
  });

  it("recovers a crash between appendEvent and checkpoint without duplicating the event", async () => {
    const directory = runDirectory();
    const backing = createFileProgramJournal(directory);
    let failNextCheckpoint = false;
    const crashing: ProgramJournal = {
      appendEvent: (record) => backing.appendEvent(record),
      readEvents: () => backing.readEvents(),
      readCheckpoint: () => backing.readCheckpoint(),
      writeProgress: (percent) => backing.writeProgress(percent),
      writeCheckpoint: async (json) => {
        if (failNextCheckpoint) throw new Error("simulated crash before checkpoint");
        await backing.writeCheckpoint(json);
      },
    };

    const halted = await drive(crashing, genesis, [{ kind: "published" }, { kind: "gate-reached" }]);
    expect(halted.ok).toBe(true);
    if (!halted.ok) return;

    // Crash in the window the kernel leaves open: the event is durable, its
    // checkpoint is not.
    failNextCheckpoint = true;
    const crashed = await drive(crashing, halted.value.data, [{ kind: "decided" }]);
    expect(crashed.ok).toBe(false);

    const records = await backing.readEvents();
    expect(records).toHaveLength(3);
    const staleCheckpoint = await backing.readCheckpoint();
    expect(codec.decode(staleCheckpoint as string).ok).toBe(true);

    failNextCheckpoint = false;
    const resumed = resumeProgram({ machine, codec, genesis, records, checkpoint: staleCheckpoint });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    // Replay carried the un-checkpointed transition; the checkpoint lagged it.
    expect(resumed.value.state).toEqual({ stage: "ready", accepted: 0 });

    const finished = await drive(crashing, resumed.value, [{ kind: "committed" }]);
    expect(finished.ok).toBe(true);
    // Re-driving appended only the committing event — the replayed prefix was
    // never re-appended.
    expect(await backing.readEvents()).toHaveLength(4);
  });

  it("re-deriving the same transition yields the same dedup key", () => {
    const event = accept("slot-1");
    expect(computeProgramDedupKey("awaiting:0", 0, event)).toBe(computeProgramDedupKey("awaiting:0", 0, event));
    expect(computeProgramDedupKey("awaiting:0", 0, event)).not.toBe(computeProgramDedupKey("awaiting:1", 0, event));
  });

  it("keeps the kernel's append-before-checkpoint order", async () => {
    const order: string[] = [];
    const journal = createInMemoryProgramJournal();
    const observing: ProgramJournal = {
      ...journal,
      appendEvent: async (record) => { order.push("append"); await journal.appendEvent(record); },
      writeCheckpoint: async (json) => { order.push("checkpoint"); await journal.writeCheckpoint(json); },
    };

    await drive(observing, genesis, [{ kind: "published" }, accept("s1"), accept("s2"), { kind: "committed" }]);

    expect(order).toEqual(["append", "checkpoint", "append", "checkpoint", "append", "checkpoint", "append", "checkpoint"]);
  });
});

// --- Tracing ----------------------------------------------------------------

describe("tracing", () => {
  it("projects ids, keys and outcomes without carrying payload bytes", () => {
    const trace = projectProgramTrace<TestState, TestEvent>("run.test-1", machine.stateKey, {
      state: { stage: "awaiting", accepted: 0 },
      event: accept("slot-1"),
      nextState: { stage: "awaiting", accepted: 1 },
      outcome: "success",
      durationMs: 4,
      timestamp: new Date(1_700_000_000_000),
    });

    expect(trace).toMatchObject({
      runId: "run.test-1",
      fromStateKey: "awaiting:0",
      toStateKey: "awaiting:1",
      eventType: "accepted",
      outcome: "success",
    });
    expect(JSON.stringify(trace)).not.toContain("payload-bytes-for-slot-1");
  });

  it("labels an aborted transition that carries no event", () => {
    const trace = projectProgramTrace<TestState, TestEvent>("run.test-1", machine.stateKey, {
      state: { stage: "awaiting", accepted: 0 },
      nextState: { stage: "awaiting", accepted: 0 },
      outcome: "skipped",
      durationMs: 0,
      timestamp: new Date(0),
    });

    expect(trace.eventType).toBe("<aborted>");
  });

  it("emits one trace per transition while driving a run", async () => {
    const journal = createInMemoryProgramJournal();
    const outcome = await drive(journal, genesis, [{ kind: "published" }, accept("s1"), accept("s2"), { kind: "committed" }]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.traces.map((trace) => trace.eventType))
      .toEqual(["published", "accepted", "accepted", "committed"]);
    expect(outcome.value.traces.at(-1)?.toStateKey).toBe("done:2");
  });
});

// --- Job wiring -------------------------------------------------------------

describe("program job", () => {
  it("exposes the resumed checkpoint as the kernel's entry data", () => {
    const journal = createInMemoryProgramJournal();
    const resumed: ProgramData<TestState, TestContext> = {
      state: { stage: "ready", accepted: 2 },
      context: { runId: "run.test-1", seen: new Set(["a"]) },
    };

    const job = createProgramJob<TestState, TestEvent, TestContext>({ journal, codec, initial: resumed });

    expect(job.data.state).toEqual({ stage: "ready", accepted: 2 });
    expect(job.current().context.seen.has("a")).toBe(true);
  });

  it("persists a checkpoint before it reports new data", async () => {
    const directory = runDirectory();
    const journal = createFileProgramJournal(directory);
    const job = createProgramJob<TestState, TestEvent, TestContext>({ journal, codec, initial: genesis });

    await job.updateData({ state: { stage: "awaiting", accepted: 1 }, context: genesis.context });

    expect(job.current().state).toEqual({ stage: "awaiting", accepted: 1 });
    const stored = readFileSync(join(directory, "checkpoint.json"), "utf-8");
    expect(codec.decode(stored).ok).toBe(true);
  });
});

// --- onRejected: the illegal-event landing state ----------------------------

/**
 * `onRejected` is the adapter's explicit landing state for a REJECTED event.
 *
 * Domain reducers refuse illegal events rather than throwing, so without an
 * explicit landing the kernel would keep the prior state — and a rejected event
 * would appear in the audit log as a successful self-loop, indistinguishable
 * from a transition that legitimately did nothing. Every existing test drove
 * `onRejected` only through the raw `transition` seam, never through
 * `runProgram`, so the behaviour that actually reaches the journal and the
 * checkpoint was unverified.
 */
describe("illegal events land in the rejection state through runProgram", () => {
  it("drives an illegal event to the rejection landing rather than a self-loop", async () => {
    const journal = createInMemoryProgramJournal();
    // `committed` is legal only from `ready`; the genesis stage is `preparing`.
    // The reducer REJECTS it, `onRejected` lands in the failed state, and a
    // failed terminal is a runtime failure — never a quiet return to the prior
    // state, which is what would make a rejection look like a successful no-op.
    const result = await drive(journal, genesis, [{ kind: "committed" }]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("failed terminal state");
  });

  it("never checkpoints the rejection landing, because it is terminal-failed", async () => {
    const journal = createInMemoryProgramJournal();
    await drive(journal, genesis, [{ kind: "committed" }]);

    // The same rule the clean terminal-failed case pins: a failed state is not
    // a resumption point, so nothing durable may point at it.
    expect(await journal.readCheckpoint()).toBeNull();
  });

  it("leaves NOTHING durable behind, so a resume replays from the last good state", async () => {
    const journal = createInMemoryProgramJournal();
    await drive(journal, genesis, [{ kind: "committed" }]);

    // A rejected event is not history: it never happened as far as the run is
    // concerned, so neither the log nor the checkpoint may record it. Were it
    // appended, every later replay would re-derive the failed landing and the
    // run could never be resumed at all.
    expect(await journal.readEvents()).toEqual([]);
    expect(await journal.readCheckpoint()).toBeNull();

    const replayed = replayProgram(machine, genesis, await journal.readEvents());
    expect(replayed.state.stage).toBe("preparing");
  });

  it("reaches the rejection landing through the machine seam itself", () => {
    // The landing state is what the adapter substitutes for the refusal, and it
    // carries the diagnostic into context rather than discarding it.
    const landed = machine.transition(
      { stage: "preparing", accepted: 0 },
      { kind: "committed" },
      { runId: "run.test-1", seen: new Set<string>() },
    );

    expect(landed.state.stage).toBe("failed");
    expect([...landed.context.seen].some((entry) =>
      entry.startsWith("rejected:") && entry.includes("committed is not accepted during preparing"),
    )).toBe(true);
  });

  it("an executor that throws mid-run lands through errorEventOf, not as an exception", async () => {
    const journal = createInMemoryProgramJournal();
    // An empty script: the scripted executor throws "script exhausted", which
    // the runtime must classify into a domain event rather than propagate.
    const result = await drive(journal, genesis, []);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("failed terminal state");
    // The throw was classified into a domain `fail` event, not propagated: the
    // outcome is a typed runtime failure, and nothing durable claims progress.
    expect(await journal.readCheckpoint()).toBeNull();
  });
});

// --- resumeProgram against a corrupt checkpoint -----------------------------

/**
 * `resumeProgram` with a corrupt checkpoint.
 *
 * The corruption cases were tested only against the raw codec. Whether
 * `resumeProgram` — the function an actual resume calls — propagates that
 * refusal or quietly falls back to the replayed prefix was never checked, and
 * a fallback would resume a run from a state its own checkpoint contradicts.
 */
describe("resuming against a corrupt checkpoint", () => {
  it("refuses rather than silently trusting the replayed prefix", () => {
    const resumed = resumeProgram({
      machine,
      codec,
      genesis,
      records: [],
      checkpoint: "{not json",
    });

    expect(resumed.ok).toBe(false);
  });

  it("refuses a structurally valid checkpoint whose stage is unknown", () => {
    const resumed = resumeProgram({
      machine,
      codec,
      genesis,
      records: [],
      checkpoint: JSON.stringify({
        schemaVersion: 1,
        data: { state: { stage: "not-a-stage", accepted: 0 }, context: { runId: "run.test-1", seen: [] } },
      }),
    });

    expect(resumed.ok).toBe(false);
  });

  it("accepts a null checkpoint as 'nothing persisted yet' and returns the replay", () => {
    const resumed = resumeProgram({ machine, codec, genesis, records: [], checkpoint: null });

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.state.stage).toBe("preparing");
  });
});
