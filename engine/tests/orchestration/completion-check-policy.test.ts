/**
 * Plain-closure tests for the completion-check runner's containment policy
 * seam (atl-3). The group/leader probes and the wall clock are defaulted
 * ports; these tests drive the exported wait/classification/escalation
 * policy with plain closure fakes and an injected clock, while a passive
 * `process.kill` spy (via `expectNoSignal`) pins that the faked policy never
 * sends a signal — the negative-observation proof that the ports fully
 * replace the real probe.
 */

import { describe, expect, it, vi } from "vitest";
import {
  decideEpermEscalation,
  decideSurvivingEscalation,
  observeClosedProcessGroup,
  waitForClosedProcessGroup,
  waitForProcessGroupGone,
  type ClosedProcessGroupObservation,
  type EpermEscalationDecision,
  type GroupProbe,
  type LeaderLivenessProbe,
  type LeaderProbe,
  type ProcessGroupProbe,
  type SurvivingEscalationDecision,
  type WallClock,
} from "../../src/orchestration/completion-check-runner";

/** A probe that answers each call from a scripted list in order. */
const scriptedGroupProbe = (...answers: ProcessGroupProbe[]): GroupProbe => {
  const queue = [...answers];
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("fixture ran past its scripted group probes");
    return next;
  };
};

const goneLeader: LeaderLivenessProbe = () => ({ kind: "gone" });
const presentLeader: LeaderLivenessProbe = () => ({ kind: "present" });

/** A fake clock that advances a fixed step on every read. */
const steppingClock = (step: number, start = 0): WallClock => {
  let current = start;
  return () => {
    const read = current;
    current += step;
    return read;
  };
};

/** Runs the policy body under a passive `process.kill` spy and asserts the
 *  spy saw no call — the no-signal invariant stated once, in one place, with
 *  assertion strength unchanged (it still runs for every caller). */
const expectNoSignal = async (run: () => Promise<void>): Promise<void> => {
  const kill = vi.spyOn(process, "kill");
  try {
    await run();
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
};

describe("the process-group dissolution wait policy (plain fakes, no process global)", () => {
  it("keeps observing through undecided probes and settles on the provable ESRCH", async () => {
    // The policy under test: neither `present` nor `eperm` proves dissolution;
    // only a `gone` probe does. The loop must keep observing until that proof
    // arrives, whatever the intermediate answers.
    await expectNoSignal(async () => {
      const latest = await waitForProcessGroupGone(
        4242,
        1_000,
        scriptedGroupProbe({ kind: "present" }, { kind: "eperm" }, { kind: "eperm" }, { kind: "gone" }),
        steppingClock(5),
      );
      expect(latest).toEqual({ kind: "gone" });
    });
  });

  it("returns the latest unproven probe at the deadline without any signal", async () => {
    // Deadline refusal: a group that never proves gone ends the wait with the
    // last observation, and the wait itself never signals anything.
    await expectNoSignal(async () => {
      const latest = await waitForProcessGroupGone(
        4242,
        30,
        scriptedGroupProbe({ kind: "eperm" }, { kind: "eperm" }, { kind: "eperm" }, { kind: "present" }),
        steppingClock(10),
      );
      expect(latest).toEqual({ kind: "eperm" });
    });
  });

  it("exits immediately when the injected clock already sits at the deadline", async () => {
    await expectNoSignal(async () => {
      const latest = await waitForProcessGroupGone(4242, 0, scriptedGroupProbe({ kind: "present" }), () => 10_000);
      expect(latest).toEqual({ kind: "present" });
    });
  });
});

describe("the closed process-group classification (plain fakes)", () => {
  const observe = (
    groupAnswers: ProcessGroupProbe[],
    leader: LeaderLivenessProbe,
  ): ClosedProcessGroupObservation =>
    observeClosedProcessGroup(4242, scriptedGroupProbe(...groupAnswers), leader);

  it("reads a surviving leader as a recycled numeric id, never as ours", () => {
    // After the parent closed, a positive-pid probe that succeeds cannot name
    // our leader (Node reaped it) — the id now names someone else's process,
    // so the observation is gone-by-recycling and no signal is authorized.
    expect(observe([{ kind: "present" }], presentLeader)).toEqual({
      kind: "gone",
      reason: "recycled-leader",
    });
  });

  it("classifies a reaped leader's surviving group as surviving descendants", () => {
    expect(observe([{ kind: "present" }], goneLeader)).toEqual({ kind: "surviving-descendants" });
  });

  it("classifies EPERM beside a reaped leader as unconfirmed, never dissolved", () => {
    // EPERM names an unsignalable member — or a foreign id that recycled the
    // numeric group. With the leader reaped that pair cannot prove
    // dissolution, so the classification stays unconfirmed.
    expect(observe([{ kind: "eperm" }], goneLeader)).toEqual({
      kind: "unconfirmed",
      reason: "foreign-eperm",
    });
  });

  it("propagates probe failures from either port", () => {
    expect(observe([{ kind: "error", message: "group probe failed" }], presentLeader)).toEqual({
      kind: "error",
      message: "group probe failed",
    });
    expect(observe([{ kind: "present" }], () => ({ kind: "error", message: "leader probe failed" }))).toEqual({
      kind: "error",
      message: "leader probe failed",
    });
  });

  it("reports a dissolved group as gone-by-absence without consulting the leader", () => {
    let leaderCalls = 0;
    const countingLeader: LeaderLivenessProbe = () => {
      leaderCalls += 1;
      return { kind: "gone" };
    };
    expect(observe([{ kind: "gone" }], countingLeader)).toEqual({ kind: "gone", reason: "absent" });
    expect(leaderCalls).toBe(0);
  });
});

describe("the post-SIGTERM escalation decisions (phase-explicit, plain fakes)", () => {
  const presentLeaderProbe: LeaderProbe = { kind: "present" };
  const goneLeaderProbe: LeaderProbe = { kind: "gone" };
  const errorLeaderProbe: LeaderProbe = { kind: "error", message: "leader probe failed" };

  it("refuses every further signal in the leader-reaped phase, whatever the probes answer", () => {
    // Once the spawned leader's exit is observed the numeric id is no longer
    // identity-bound: leader-present names a recycled pid exactly as the
    // closed classifier reads it, so both decision arms refuse.
    const decisions: EpermEscalationDecision[] = [
      decideEpermEscalation({ kind: "leader-reaped" }, presentLeaderProbe),
      decideEpermEscalation({ kind: "leader-reaped" }, goneLeaderProbe),
      decideEpermEscalation({ kind: "leader-reaped" }, errorLeaderProbe),
    ];
    expect(decisions).toEqual([
      { kind: "refuse-recycled-id" },
      { kind: "refuse-recycled-id" },
      { kind: "refuse-recycled-id" },
    ]);
    const surviving: SurvivingEscalationDecision = decideSurvivingEscalation({ kind: "leader-reaped" });
    expect(surviving).toEqual({ kind: "refuse-recycled-id" });
  });

  it("escalates the EPERM group exactly when the un-reaped leader probe proves the id ours", () => {
    expect(decideEpermEscalation({ kind: "leader-unreaped" }, presentLeaderProbe)).toEqual({ kind: "escalate" });
  });

  it("refuses the ambiguous leader-gone and leader-error EPERM states without a signal", () => {
    expect(decideEpermEscalation({ kind: "leader-unreaped" }, goneLeaderProbe)).toEqual({
      kind: "refuse-ambiguous-leader",
      leaderMessage: null,
    });
    expect(decideEpermEscalation({ kind: "leader-unreaped" }, errorLeaderProbe)).toEqual({
      kind: "refuse-ambiguous-leader",
      leaderMessage: "leader probe failed",
    });
  });

  it("escalates a plainly surviving group only in the leader-unreaped phase", () => {
    expect(decideSurvivingEscalation({ kind: "leader-unreaped" })).toEqual({ kind: "escalate" });
  });
});

describe("the post-close observation wait (plain fakes)", () => {
  it("keeps observing an unconfirmed EPERM group until a provable ESRCH resolves it", async () => {
    await expectNoSignal(async () => {
      const settled = await waitForClosedProcessGroup(
        4242,
        1_000,
        scriptedGroupProbe({ kind: "eperm" }, { kind: "eperm" }, { kind: "gone" }),
        goneLeader,
        steppingClock(5),
      );
      expect(settled).toEqual({ kind: "gone", reason: "absent" });
    });
  });

  it("resolves surviving descendants to gone once the members exit", async () => {
    await expectNoSignal(async () => {
      const settled = await waitForClosedProcessGroup(
        4242,
        1_000,
        scriptedGroupProbe({ kind: "present" }, { kind: "present" }, { kind: "gone" }),
        goneLeader,
        steppingClock(5),
      );
      expect(settled).toEqual({ kind: "gone", reason: "absent" });
    });
  });

  it("expires fail-closed with the last undecided observation", async () => {
    await expectNoSignal(async () => {
      const settled = await waitForClosedProcessGroup(
        4242,
        20,
        scriptedGroupProbe(
          { kind: "present" }, { kind: "present" }, { kind: "present" },
          { kind: "present" }, { kind: "present" }, { kind: "present" },
        ),
        goneLeader,
        steppingClock(10),
      );
      expect(settled).toEqual({ kind: "surviving-descendants" });
    });
  });
});
