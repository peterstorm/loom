/**
 * SessionRegistry invariants as properties over interleavings of
 * start (markActive + bind) / record / stop (snapshot + unbind + removeActive):
 *
 * (a) soleActiveBinding returns a binding only when exactly one binding
 *     exists AND the active roster is exactly the bound agent (an empty
 *     roster is a leaked binding — attribution stands down) — checked
 *     against an independent pure model after every op.
 * (b) evidence recorded under an epoch is never attributed to another
 *     epoch: the registry ledger always equals the model ledger record for
 *     record, epoch for epoch.
 * (c) the snapshot-before-unbind ordering preserves a stopping agent's
 *     evidence regardless of interleaved binds: the snapshot taken at stop
 *     contains exactly the events attributed to that agent's EPOCH since
 *     the last ledger truncation, even though a later bind may truncate the
 *     live ledger. (Epochs are `<agent_id>:<agent_type>` — agent-keyed, not
 *     run-keyed. A re-bind of the SAME agent id while another binding is
 *     live skips truncation and inherits the epoch's earlier events; the
 *     harness mints unique agent ids per spawn, so this is the honest
 *     statement of the invariant, not a hole the property papers over.)
 *
 * The property runs against the in-memory fake (fast, many runs) and the
 * fs adapter (fewer runs — conformance: the production adapter satisfies
 * the same invariants).
 */

import { describe, it, expect, afterAll } from "vitest";
import fc from "fast-check";
import { unlinkSync } from "node:fs";
import type { Evidence } from "../../src/machine/types";
import {
  epochOf,
  eventsForEpoch,
  parseAgentId,
  parseAgentType,
  parseSessionId,
  resolveSoleActiveBinding,
  type MachineBinding,
  type SessionId,
  type SessionRegistry,
} from "../../src/machine/evidence";
import { fsSessionRegistry } from "../../src/machine/session-registry";
import { ledgerPath, machineBindingPath } from "../../src/machine/ledger";
import { SUBAGENT_DIR } from "../../src/config";
import { inMemorySessionRegistry } from "./fake-session-registry";
import { reportSummary } from "./report-summary";

// --- Agent pool (mix of machine-gated and ungated agents) ---

interface PoolAgent {
  readonly key: number;
  readonly id: string;
  readonly type: string;
  /** Whether this agent type ships a machine (bind on start). */
  readonly gated: boolean;
}

const POOL: readonly PoolAgent[] = [
  { key: 0, id: "a-1", type: "code-implementer-agent", gated: true },
  { key: 1, id: "a-2", type: "ts-test-agent", gated: false },
  { key: 2, id: "a-3", type: "code-implementer-agent", gated: true },
];

function bindingOf(agent: PoolAgent): MachineBinding {
  const agentId = parseAgentId(agent.id);
  const agentType = parseAgentType(agent.type);
  if (!agentId || !agentType) throw new Error("pool identity must be parseable");
  return { agentId, agentType, epoch: epochOf(agentId, agentType) };
}

// --- Operations ---

type Op =
  | { readonly op: "start"; readonly agent: number }
  | { readonly op: "stop"; readonly agent: number }
  | { readonly op: "record"; readonly event: Evidence };

const eventArb: fc.Arbitrary<Evidence> = fc.oneof(
  fc.record({ kind: fc.constant("FileRead" as const), path: fc.constantFrom("/a.ts", "/b.ts") }),
  fc.record({ kind: fc.constant("FileWrite" as const), path: fc.constantFrom("/a.ts", "/b.ts") }),
  fc.record({
    kind: fc.constant("TestRun" as const),
    command: fc.constantFrom("npm test", "bun test"),
    exit: fc.constantFrom<number | null>(0, 1, null),
    report: fc.constantFrom(null, reportSummary(5, 0)),
  }),
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant("start" as const), agent: fc.constantFrom(0, 1, 2) }),
  fc.record({ op: fc.constant("stop" as const), agent: fc.constantFrom(0, 1, 2) }),
  fc.record({ op: fc.constant("record" as const), event: eventArb }),
);

// --- Pure model (independent re-statement of the attribution rules) ---

interface Model {
  bindings: MachineBinding[];
  active: string[];
  ledger: { epoch: string; event: Evidence }[];
  /** Events attributed to each epoch since the last ledger truncation. */
  epochEvents: Map<string, Evidence[]>;
  started: Set<number>;
}

function modelSole(m: Model): MachineBinding | null {
  if (m.bindings.length !== 1) return null;
  if (m.active.length !== 1) return null;
  return m.active[0] === m.bindings[0].agentId ? m.bindings[0] : null;
}

/** Run one op against registry + model, asserting invariants (a) and (b). */
async function step(reg: SessionRegistry, s: SessionId, m: Model, op: Op): Promise<void> {
  if (op.op === "start") {
    const agent = POOL[op.agent];
    if (m.started.has(agent.key)) return; // an agent instance starts once
    m.started.add(agent.key);
    // Production order (mark-subagent-active): roster first, then bind.
    await reg.markActive(s, parseAgentId(agent.id)!);
    m.active.push(agent.id);
    if (agent.gated) {
      if (m.bindings.length === 0) {
        // bind truncates a dead session's ledger — every epoch's history goes
        m.ledger = [];
        m.epochEvents.clear();
      }
      await reg.bind(s, parseAgentType(agent.type)!, parseAgentId(agent.id)!);
      m.bindings.push(bindingOf(agent));
    }
  } else if (op.op === "record") {
    // Production recorder: append ONLY under a sole active binding, stamped
    // with ITS epoch — this is where invariant (b) is enforced.
    const binding = reg.soleActiveBinding(s);
    if (binding !== null) {
      reg.appendEvidence(s, binding.epoch, [op.event]);
    }
    const expected = modelSole(m);
    if (expected !== null) {
      m.ledger.push({ epoch: expected.epoch, event: op.event });
      const attributed = m.epochEvents.get(expected.epoch) ?? [];
      m.epochEvents.set(expected.epoch, [...attributed, op.event]);
    }
  } else {
    const agent = POOL[op.agent];
    if (!m.started.has(agent.key)) return;
    m.started.delete(agent.key);
    // Production order (dispatch → cleanup): snapshot BEFORE unbind, then
    // unbind, then roster removal.
    const snapshot = reg.readEvidence(s);
    await reg.unbind(s, parseAgentType(agent.type)!, parseAgentId(agent.id)!);
    await reg.removeActive(s, parseAgentId(agent.id)!);
    m.bindings = m.bindings.filter((b) => !(b.agentId === agent.id && b.agentType === agent.type));
    m.active = m.active.filter((a) => a !== agent.id);

    // Invariant (c): the pre-unbind snapshot preserves everything the
    // stopping agent's epoch was credited with — later binds may truncate
    // the live file, never this snapshot.
    if (agent.gated) {
      const epoch = epochOf(parseAgentId(agent.id)!, parseAgentType(agent.type)!);
      expect(eventsForEpoch(snapshot, epoch)).toEqual(m.epochEvents.get(epoch) ?? []);
    }
  }

  // Invariant (a): registry agrees with the independent model, op by op.
  const sole = reg.soleActiveBinding(s);
  expect(sole).toEqual(modelSole(m));
  // The roster count must equal the independent model's active roster size
  // EXACTLY — an upper bound (≤ 1) would miss an off-by-one that
  // under-counts (dropping an active agent silently re-opens attribution) or
  // over-counts. The model is the sole source of truth for the roster.
  expect(reg.countActiveAgents(s)).toBe(m.active.length);

  // Invariant (b): every ledger record carries exactly the epoch the model
  // attributed it to — no cross-epoch bleed, no lost/extra records.
  expect(reg.readEvidence(s)).toEqual(m.ledger);
}

async function runScenario(reg: SessionRegistry, session: SessionId, ops: readonly Op[]): Promise<void> {
  const model: Model = { bindings: [], active: [], ledger: [], epochEvents: new Map(), started: new Set() };
  for (const op of ops) {
    await step(reg, session, model, op);
  }
}

// --- The property, against the fake (many runs) ---

describe("SessionRegistry invariants (in-memory fake)", () => {
  it("(a) sole-active (b) epoch attribution (c) snapshot-before-unbind hold under arbitrary interleavings", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 30 }), async (ops) => {
        await runScenario(inMemorySessionRegistry(), parseSessionId("prop-session")!, ops);
      }),
      { numRuns: 250 },
    );
  });
});

// --- Conformance: the production fs adapter satisfies the same properties ---

const run = `registry-prop-${process.pid}-${Date.now()}`;
const fsSessions: SessionId[] = [];

afterAll(() => {
  for (const s of fsSessions) {
    for (const path of [ledgerPath(s), machineBindingPath(s), `${SUBAGENT_DIR}/${s}.active`]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
});

describe("SessionRegistry invariants (fs adapter conformance)", () => {
  it("the production adapter satisfies (a), (b), and (c) under interleavings", async () => {
    let n = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 15 }), async (ops) => {
        const session = parseSessionId(`${run}-${n++}`)!;
        fsSessions.push(session);
        await runScenario(fsSessionRegistry, session, ops);
      }),
      { numRuns: 12 },
    );
  }, 60000);
});

// --- The leaked-binding shape: a binding with an EMPTY roster stands down ---
//
// The op model can't produce this (start rosters before binding; stop unbinds
// and de-rosters together), so it is pinned directly: the shape arises when a
// bound agent's roster entry is lost (crash between the paired writes) while
// its binding survives.

describe("empty roster + one binding = leaked binding → no attribution", () => {
  const agent = POOL[0];

  it("resolveSoleActiveBinding (the shared pure rule) refuses an empty roster", () => {
    const binding = bindingOf(agent);
    expect(resolveSoleActiveBinding([binding], [])).toBeNull();
    expect(resolveSoleActiveBinding([binding], [agent.id])).toEqual(binding);
    expect(resolveSoleActiveBinding([binding], ["someone-else"])).toBeNull();
    expect(resolveSoleActiveBinding([binding], [agent.id, "second"])).toBeNull();
    expect(resolveSoleActiveBinding([], [agent.id])).toBeNull();
  });

  it("in-memory fake: bind without markActive → soleActiveBinding null; roster arrival restores it", async () => {
    const reg = inMemorySessionRegistry();
    const s = parseSessionId("leaked-binding-fake")!;
    await reg.bind(s, parseAgentType(agent.type)!, parseAgentId(agent.id)!);
    expect(reg.soleActiveBinding(s)).toBeNull(); // leaked shape stands down
    await reg.markActive(s, parseAgentId(agent.id)!);
    expect(reg.soleActiveBinding(s)?.agentId).toBe(agent.id);
  });

  it("fs adapter: bind without markActive → soleActiveBinding null; roster arrival restores it", async () => {
    const s = parseSessionId(`${run}-leaked-binding-fs`)!;
    fsSessions.push(s);
    await fsSessionRegistry.bind(s, parseAgentType(agent.type)!, parseAgentId(agent.id)!);
    expect(fsSessionRegistry.soleActiveBinding(s)).toBeNull(); // leaked shape stands down
    await fsSessionRegistry.markActive(s, parseAgentId(agent.id)!);
    expect(fsSessionRegistry.soleActiveBinding(s)?.agentId).toBe(agent.id);
  });
});
