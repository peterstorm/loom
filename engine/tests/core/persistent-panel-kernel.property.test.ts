/**
 * The slot-progress and program kernel the persistent refutation panel runs
 * on, pinned as properties over its verifier stage: for any order of slot
 * outcomes, an attempt-1 rejection spawns exactly that slot's attempt 2, an
 * attempt-2 rejection is terminal and admits nothing further, the stage
 * advances only once every slot accepted, and every recorded prefix replays and
 * checkpoints back to the exact state the reducer produced. A two-verifier panel
 * enumerates its whole outcome space; a three-verifier panel is sampled. (The
 * two-slot enumeration moved here from the deleted architecture panel, ADR-0030.)
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  panelRequestIdentity,
  parseRefutationPanelCheckpoint,
  refutationPanelCheckpoint,
  replayPersistentRefutationPanel,
  startPersistentRefutationPanel,
  submitRefutationVerdict,
  type PersistentRefutationPanelEvent,
  type PersistentRefutationStep,
} from "../../src/core/persistent-panel";
import type { PersistentPanelResult, RefutationPanelAuthority } from "../../src/core/panel-authority";
import type { AgentRequestAuthority, ExactRoster, SpawnRequest } from "../../src/core/orchestration-contract";
import { createPanelPublications } from "../fixtures/panel-authority";
import { value } from "../fixtures/parse-result";

/** This property's private publication store: its resolver reads only the panels issued here. */
const { issuePanelRequests, refutationPanelFixture, resolver } = createPanelPublications();

/** What happens to one slot: accepted at once, accepted on its retry, or rejected twice. */
const SLOT_PLANS = ["accept", "reject-then-accept", "reject-twice"] as const;
type SlotPlan = (typeof SLOT_PLANS)[number];

/** The verifier stage as the property drives it. */
type StageDriver = Readonly<{
  start: () => PersistentRefutationStep;
  roster: ExactRoster;
  attempt1: readonly SpawnRequest[];
  submit: (step: PersistentRefutationStep, request: SpawnRequest, outcome: "accept" | "reject") => PersistentPanelResult<PersistentRefutationStep>;
  /** Replay and checkpoint the recorded prefix; returns the replayed state's JSON. */
  persist: (prefix: readonly unknown[]) => string;
}>;

const json = (raw: unknown): string => JSON.stringify(raw, (key, entry: unknown) => (key === "byId" || key === "bySlot" ? undefined : entry));

/** Replay, checkpoint and reload the recorded prefix through its durable JSON,
 *  asserting the reloaded state is the replayed one; returns the replayed
 *  state's JSON. */
function persistPrefix(authority: RefutationPanelAuthority, prefix: readonly unknown[]): string {
  const events: readonly PersistentRefutationPanelEvent[] = JSON.parse(JSON.stringify(prefix));
  const replayed = value(replayPersistentRefutationPanel(authority, events, resolver));
  const checkpoint = value(refutationPanelCheckpoint(replayed.state, events, resolver));
  const reloaded = value(parseRefutationPanelCheckpoint(JSON.parse(JSON.stringify(checkpoint)), resolver));
  expect(json(reloaded.state)).toBe(json(replayed.state));
  return json(replayed.state);
}

let runSequence = 0;

function refutationDriver(lenses: readonly ("reproduction" | "intent" | "blast-radius")[]): StageDriver {
  runSequence += 1;
  const fixture = refutationPanelFixture(`run.kernel-property.ref.${runSequence}`, lenses);
  const verdict = (index: number) => JSON.stringify({
    criterion: fixture.authority.lenses[index],
    verdicts: fixture.authority.findings.map(({ id }) => ({ finding_id: id, verdict: "upheld", reasoning: "still exhibited" })),
  });
  const indexOf = (request: SpawnRequest) => fixture.authority.verifierRoster.orderedSlots.findIndex(({ slotId }) => slotId === request.authority.slotId);
  return {
    start: () => startPersistentRefutationPanel(fixture.authority),
    roster: fixture.authority.verifierRoster,
    attempt1: fixture.requests,
    submit: (step, request, outcome) => submitRefutationVerdict(step.state, resolver, panelRequestIdentity(request), outcome === "accept" ? verdict(indexOf(request)) : "not json"),
    persist: (prefix) => persistPrefix(fixture.authority, prefix),
  };
}

/** Drive one stage through `plans` in slot `order`, asserting the kernel invariants after every step. */
function driveStage(driver: StageDriver, plans: readonly SlotPlan[], order: readonly number[]): void {
  let step = driver.start();
  const prefix: unknown[] = [];
  const settled = new Set<number>();
  for (const slot of order) {
    const plan = plans[slot]!;
    const attempts: readonly ("accept" | "reject")[] = plan === "accept" ? ["accept"] : plan === "reject-then-accept" ? ["reject", "accept"] : ["reject", "reject"];
    let request = driver.attempt1[slot]!;
    for (const [attemptIndex, outcome] of attempts.entries()) {
      const next = value(driver.submit(step, request, outcome));
      prefix.push(next.recordedEvent);
      expect(driver.persist(prefix)).toBe(json(next.state));
      step = next;
      if (outcome === "accept") {
        settled.add(slot);
        continue;
      }
      if (attemptIndex === 0) {
        // Attempt 1 rejected: exactly this slot's attempt 2, nothing else.
        const retry: AgentRequestAuthority = driver.roster.orderedSlots[slot]!.attempts[1];
        expect(step.state.stage).toBe("awaiting-verdicts");
        expect(step.action).toEqual({ kind: "spawn-refutation-verifiers", runId: retry.runId, requests: [retry] });
        request = issuePanelRequests([retry])[0]!;
        continue;
      }
      // Attempt 2 rejected: terminal, and the stage admits nothing further.
      expect(step.state.stage).toBe("terminal-blocked");
      expect(step.action?.kind).toBe("refutation-blocked");
      const later = driver.attempt1.find((_, index) => index !== slot) ?? driver.attempt1[slot]!;
      const refused = driver.submit(step, later, "accept");
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.kind).toBe("unexpected-event");
      return;
    }
    const complete = settled.size === plans.length;
    expect(step.state.stage).toBe(complete ? "ready-to-tally" : "awaiting-verdicts");
    if (!complete && plans[slot] === "accept") expect(step.action).toBeNull();
  }
}

type StagePlan = Readonly<{ plans: readonly SlotPlan[]; order: readonly number[] }>;

const stagePlans = (slots: number): fc.Arbitrary<StagePlan> => fc.record({
  plans: fc.array(fc.constantFrom(...SLOT_PLANS), { minLength: slots, maxLength: slots }),
  order: fc.shuffledSubarray([...Array(slots).keys()], { minLength: slots, maxLength: slots }),
});

/** The whole outcome space of a stage: every per-slot plan crossed with every slot order. */
function everyStagePlan(slots: number): readonly StagePlan[] {
  const permutations = (pending: readonly number[]): readonly (readonly number[])[] => pending.length === 0
    ? [[]]
    : pending.flatMap((slot) => permutations(pending.filter((other) => other !== slot)).map((rest) => [slot, ...rest]));
  const plansOf = (remaining: number): readonly (readonly SlotPlan[])[] => remaining === 0
    ? [[]]
    : SLOT_PLANS.flatMap((plan) => plansOf(remaining - 1).map((rest) => [plan, ...rest]));
  const orders = permutations([...Array(slots).keys()]);
  return plansOf(slots).flatMap((plans) => orders.map((order) => ({ plans, order })));
}

describe("property: the slot-progress and program kernel", () => {
  // 3 slots span 3^3 plans x 3! orders = 162 cases, too many to enumerate at
  // ~150ms each (every recorded prefix replays through the production
  // publication resolver), so this samples 25 unseeded; a failure reports its
  // fast-check seed and path for replay. The sampling, not the assertion, sets
  // the cost, so the case states its budget.
  it("drives every refutation verifier outcome order through the same retry, terminal and replay invariants", { timeout: 30_000 }, () => {
    fc.assert(fc.property(stagePlans(3), ({ plans, order }) => driveStage(refutationDriver(["reproduction", "intent", "blast-radius"]), plans, order)), { numRuns: 25 });
  });

  // 2 slots span only 3^2 plans x 2! orders = 18 cases: enumerate them all,
  // which is both exhaustive and cheaper than sampling 25.
  it("drives every two-verifier outcome order through the same retry, terminal and replay invariants", { timeout: 30_000 }, () => {
    const space = everyStagePlan(2);
    expect(space).toHaveLength(18);
    for (const { plans, order } of space) driveStage(refutationDriver(["reproduction", "intent"]), plans, order);
  });
});
