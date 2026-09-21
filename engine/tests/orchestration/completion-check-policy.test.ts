/**
 * Plain-closure tests for the completion-check runner's containment policy
 * seam (atl-3). The group/leader probes and the wall clock are defaulted
 * ports; these tests drive the exported wait/classification policy with
 * plain fakes and never touch `process.kill` or real time, which is the
 * project's port rule for test doubles.
 */

import { describe, expect, it, vi } from "vitest";
import {
  observeClosedProcessGroup,
  waitForClosedProcessGroup,
  waitForProcessGroupGone,
  type ClosedProcessGroupObservation,
  type GroupProbe,
  type LeaderLivenessProbe,
  type ProcessGroupProbe,
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

describe("the process-group dissolution wait policy (plain fakes, no process global)", () => {
  it("keeps observing through undecided probes and settles on the provable ESRCH", async () => {
    // The policy under test: neither `present` nor `eperm` proves dissolution;
    // only a `gone` probe does. The loop must keep observing until that proof
    // arrives, whatever the intermediate answers.
    const kill = vi.spyOn(process, "kill");
    try {
      const latest = await waitForProcessGroupGone(
        4242,
        1_000,
        scriptedGroupProbe({ kind: "present" }, { kind: "eperm" }, { kind: "eperm" }, { kind: "gone" }),
        steppingClock(5),
      );
      expect(latest).toEqual({ kind: "gone" });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("returns the latest unproven probe at the deadline without any signal", async () => {
    // Deadline refusal: a group that never proves gone ends the wait with the
    // last observation, and the wait itself never signals anything.
    const kill = vi.spyOn(process, "kill");
    try {
      const latest = await waitForProcessGroupGone(
        4242,
        30,
        scriptedGroupProbe({ kind: "eperm" }, { kind: "eperm" }, { kind: "eperm" }, { kind: "present" }),
        steppingClock(10),
      );
      expect(latest).toEqual({ kind: "eperm" });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("exits immediately when the injected clock already sits at the deadline", async () => {
    const probes = scriptedGroupProbe({ kind: "present" }, { kind: "present" });
    const kill = vi.spyOn(process, "kill");
    try {
      const latest = await waitForProcessGroupGone(4242, 0, probes, () => 10_000);
      expect(latest).toEqual({ kind: "present" });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
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

describe("the post-close observation wait (plain fakes)", () => {
  it("keeps observing an unconfirmed EPERM group until a provable ESRCH resolves it", async () => {
    const kill = vi.spyOn(process, "kill");
    try {
      const settled = await waitForClosedProcessGroup(
        4242,
        1_000,
        scriptedGroupProbe({ kind: "eperm" }, { kind: "eperm" }, { kind: "gone" }),
        goneLeader,
        steppingClock(5),
      );
      expect(settled).toEqual({ kind: "gone", reason: "absent" });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("resolves surviving descendants to gone once the members exit", async () => {
    const kill = vi.spyOn(process, "kill");
    try {
      const settled = await waitForClosedProcessGroup(
        4242,
        1_000,
        scriptedGroupProbe({ kind: "present" }, { kind: "present" }, { kind: "gone" }),
        goneLeader,
        steppingClock(5),
      );
      expect(settled).toEqual({ kind: "gone", reason: "absent" });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("expires fail-closed with the last undecided observation", async () => {
    const kill = vi.spyOn(process, "kill");
    try {
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
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});
