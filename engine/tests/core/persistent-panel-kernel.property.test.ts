/**
 * The slot-progress and program kernel both persistent panels share, pinned
 * once as properties over BOTH panels: for any order of slot outcomes, an
 * attempt-1 rejection spawns exactly that slot's attempt 2, an attempt-2
 * rejection is terminal and admits nothing further, a stage advances only once
 * every slot accepted, and every recorded prefix replays, checkpoints and
 * plans persistence back to the exact state the reducer produced.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  panelRequestIdentity,
  parseArchitecturePanelCheckpoint,
  parsePersistentArchitecturePanelHistory,
  parsePersistentRefutationPanelHistory,
  parseRefutationPanelCheckpoint,
  planArchitecturePanelPersistence,
  planRefutationPanelPersistence,
  architecturePanelCheckpoint,
  refutationPanelCheckpoint,
  replayPersistentArchitecturePanel,
  replayPersistentRefutationPanel,
  startPersistentArchitecturePanel,
  startPersistentRefutationPanel,
  submitArchitectureCandidateResult,
  submitRefutationVerdict,
  type PersistentArchitectureStep,
  type PersistentRefutationStep,
} from "../../src/core/persistent-panel";
import type { PersistentPanelResult } from "../../src/core/panel-authority";
import type { AgentRequestAuthority, ExactRoster, SpawnRequest } from "../../src/core/orchestration-contract";
import { architecturePanelFixture, issuePanelRequests, panelPublicationResolver as resolver, refutationPanelFixture } from "../fixtures/panel-authority";
import { value } from "../fixtures/parse-result";

/** What happens to one slot: accepted at once, accepted on its retry, or rejected twice. */
const SLOT_PLANS = ["accept", "reject-then-accept", "reject-twice"] as const;
type SlotPlan = (typeof SLOT_PLANS)[number];

/** One panel stage as the property drives it, whichever panel owns it. */
type StageDriver<Step> = Readonly<{
  start: () => Step;
  roster: ExactRoster;
  attempt1: readonly SpawnRequest[];
  submit: (step: Step, request: SpawnRequest, outcome: "accept" | "reject") => PersistentPanelResult<Step>;
  /** Replay, checkpoint and plan the recorded prefix; returns the replayed state's JSON. */
  persist: (step: Step, prefix: readonly unknown[]) => string;
  waitingStage: string;
  advancedStage: string;
  spawnKind: string;
  blockedKind: string;
}>;

type AnyStep = PersistentArchitectureStep | PersistentRefutationStep;

const json = (raw: unknown): string => JSON.stringify(raw, (key, entry: unknown) => (key === "byId" || key === "bySlot" ? undefined : entry));

let runSequence = 0;

function refutationDriver(): StageDriver<PersistentRefutationStep> {
  runSequence += 1;
  const fixture = refutationPanelFixture(`run.kernel-property.ref.${runSequence}`, ["reproduction", "intent", "blast-radius"]);
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
    persist: (step, prefix) => {
      const events = JSON.parse(JSON.stringify(prefix));
      const replayed = value(replayPersistentRefutationPanel(fixture.authority, events, resolver));
      const checkpoint = value(refutationPanelCheckpoint(replayed.state, events, resolver));
      const reloaded = value(parseRefutationPanelCheckpoint(JSON.parse(JSON.stringify(checkpoint)), resolver));
      const history = value(parsePersistentRefutationPanelHistory(fixture.authority, events.slice(0, -1), resolver));
      const [append, replace] = value(planRefutationPanelPersistence(step, history, resolver));
      expect(append.sequence).toBe(events.length);
      expect(replace.kind === "replace-refutation-panel-checkpoint" ? json(replace.checkpoint) : null).toBe(json(checkpoint));
      expect(json(reloaded.state)).toBe(json(replayed.state));
      return json(replayed.state);
    },
    waitingStage: "awaiting-verdicts",
    advancedStage: "ready-to-tally",
    spawnKind: "spawn-refutation-verifiers",
    blockedKind: "refutation-blocked",
  };
}

function architectureDriver(): StageDriver<PersistentArchitectureStep> {
  runSequence += 1;
  const fixture = architecturePanelFixture(`run.kernel-property.arch.${runSequence}`);
  const indexOf = (request: SpawnRequest) => fixture.authority.candidateRoster.orderedSlots.findIndex(({ slotId }) => slotId === request.authority.slotId);
  return {
    start: () => startPersistentArchitecturePanel(fixture.authority),
    roster: fixture.authority.candidateRoster,
    attempt1: fixture.candidates,
    submit: (step, request, outcome) => {
      const index = indexOf(request);
      return submitArchitectureCandidateResult(step.state, resolver, panelRequestIdentity(request), outcome === "accept"
        ? { lens: fixture.authority.candidateLenses[index], candidate: fixture.authority.candidateIds[index], artifact: `# candidate ${index}` }
        : { lens: fixture.authority.candidateLenses[index] });
    },
    persist: (step, prefix) => {
      const events = JSON.parse(JSON.stringify(prefix));
      const replayed = value(replayPersistentArchitecturePanel(fixture.authority, events, resolver));
      const checkpoint = value(architecturePanelCheckpoint(replayed.state, events, resolver));
      const reloaded = value(parseArchitecturePanelCheckpoint(JSON.parse(JSON.stringify(checkpoint)), resolver));
      const history = value(parsePersistentArchitecturePanelHistory(fixture.authority, events.slice(0, -1), resolver));
      const [append, replace] = value(planArchitecturePanelPersistence(step, history, resolver));
      expect(append.sequence).toBe(events.length);
      expect(replace.kind === "replace-architecture-panel-checkpoint" ? json(replace.checkpoint) : null).toBe(json(checkpoint));
      expect(json(reloaded.state)).toBe(json(replayed.state));
      return json(replayed.state);
    },
    waitingStage: "awaiting-candidates",
    advancedStage: "awaiting-judges",
    spawnKind: "spawn-architecture-candidates",
    blockedKind: "architecture-blocked",
  };
}

/** Drive one stage through `plans` in slot `order`, asserting the kernel invariants after every step. */
function driveStage<Step extends AnyStep>(driver: StageDriver<Step>, plans: readonly SlotPlan[], order: readonly number[]): void {
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
      expect(driver.persist(next, prefix)).toBe(json(next.state));
      step = next;
      if (outcome === "accept") {
        settled.add(slot);
        continue;
      }
      if (attemptIndex === 0) {
        // Attempt 1 rejected: exactly this slot's attempt 2, nothing else.
        const retry: AgentRequestAuthority = driver.roster.orderedSlots[slot]!.attempts[1];
        expect(step.state.stage).toBe(driver.waitingStage);
        expect(step.action).toEqual({ kind: driver.spawnKind, runId: retry.runId, requests: [retry] });
        request = issuePanelRequests([retry])[0]!;
        continue;
      }
      // Attempt 2 rejected: terminal, and the stage admits nothing further.
      expect(step.state.stage).toBe("terminal-blocked");
      expect(step.action?.kind).toBe(driver.blockedKind);
      const later = driver.attempt1.find((_, index) => index !== slot) ?? driver.attempt1[slot]!;
      const refused = driver.submit(step, later, "accept");
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.kind).toBe("unexpected-event");
      return;
    }
    const complete = settled.size === plans.length;
    expect(step.state.stage).toBe(complete ? driver.advancedStage : driver.waitingStage);
    if (!complete && plans[slot] === "accept") expect(step.action).toBeNull();
  }
}

const stagePlans = (slots: number) => fc.record({
  plans: fc.array(fc.constantFrom(...SLOT_PLANS), { minLength: slots, maxLength: slots }),
  order: fc.shuffledSubarray([...Array(slots).keys()], { minLength: slots, maxLength: slots }),
});

describe("property: the shared slot-progress and program kernel", () => {
  it("drives every refutation verifier outcome order through the same retry, terminal and replay invariants", () => {
    fc.assert(fc.property(stagePlans(3), ({ plans, order }) => driveStage(refutationDriver(), plans, order)), { numRuns: 25 });
  });

  it("drives every architecture candidate outcome order through the same retry, terminal and replay invariants", () => {
    fc.assert(fc.property(stagePlans(2), ({ plans, order }) => driveStage(architectureDriver(), plans, order)), { numRuns: 25 });
  });
});
