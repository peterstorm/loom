/**
 * Round-14 remediation: the run-policy rules that used to be inline in the
 * review-panel shell, and the refutation threshold they are judged against.
 *
 * Each decides whether a tally may proceed, each is a pure comparison over
 * already-parsed values, and each carries a documented bug it prevents. In the
 * shell the only way to reach them was to spawn the CLI against a temp
 * filesystem, so none of them had a direct test — while the equivalents that
 * already lived in the core each had one.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  defaultRefutationThreshold,
  manifestLensCount,
  panelSizeConflict,
  refutedIdsOf,
  replayError,
  replayedOutcomes,
  type FindingOutcome,
  type ReviewLens,
  type WaveFindingId,
} from "../../src/core/review-panel";

const id = (raw: string) => raw as WaveFindingId;

const briefFinding = (raw: string) => ({
  id: id(raw),
  taskId: raw.split(":")[0]!,
  agent: "code-reviewer",
  severity: "critical" as const,
  file: null,
  line: null,
  claim: `claim for ${raw}`,
});

const outcome = (raw: string, survives: boolean): FindingOutcome =>
  survives
    ? {
        finding: briefFinding(raw),
        upheldBy: ["intent" as ReviewLens],
        uncertainFrom: [],
        survives: true,
        refutations: [],
      }
    : {
        finding: briefFinding(raw),
        upheldBy: [],
        uncertainFrom: [],
        survives: false,
        refutations: [
          { lens: "intent", reason: "deliberate" },
          { lens: "reproduction", reason: "cannot trigger" },
        ],
      };

describe("panelSizeConflict — the panel size is fixed for the life of a run", () => {
  it("refuses a --lenses that disagrees with the recorded count", () => {
    // Re-running `manifest` without --lenses used to rewrite a recorded 5-lens
    // panel to the 3-lens default. readVerdicts then iterated only the shrunken
    // list, verdict-4 and verdict-5 were ignored, the absolute bar fell from 3
    // to 2, and a finding the full panel UPHELD came out refuted — at exit 0.
    const error = panelSizeConflict(3, 5);
    expect(error).not.toBeNull();
    expect(error).toContain("already fixed at 5 lens(es)");
    expect(error).toContain("start a new run directory");
  });

  it("is silent when the request matches, or when either side is unknown", () => {
    expect(panelSizeConflict(3, 3)).toBeNull();
    expect(panelSizeConflict(null, 5)).toBeNull();
    expect(panelSizeConflict(3, null)).toBeNull();
    expect(panelSizeConflict(null, null)).toBeNull();
  });

  it("property: conflicts exactly when both are known and differ", () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 2, max: 5 }), { nil: null }),
        fc.option(fc.integer({ min: 2, max: 5 }), { nil: null }),
        (requested, recorded) => {
          const conflicts = requested !== null && recorded !== null && requested !== recorded;
          return (panelSizeConflict(requested, recorded) !== null) === conflicts;
        },
      ),
    );
  });
});

describe("defaultRefutationThreshold — the one bar, a function of the roster", () => {
  it("requires unanimity at the minimum panel size", () => {
    expect(defaultRefutationThreshold(2)).toBe(2);
  });

  it("takes two of three and three of five", () => {
    expect(defaultRefutationThreshold(3)).toBe(2);
    expect(defaultRefutationThreshold(5)).toBe(3);
  });

  it("property: the smallest refutation count that outnumbers every other vote", () => {
    // A strict majority: one fewer refutation is at most half the panel, so a
    // tie keeps the finding; and the bar never exceeds the panel itself.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 64 }), (lenses) => {
        const threshold = defaultRefutationThreshold(lenses);
        return threshold * 2 > lenses && (threshold - 1) * 2 <= lenses && threshold <= lenses;
      }),
    );
  });
});

describe("replayedOutcomes — a closed decision is not re-adjudicated", () => {
  const graph = [
    { id: "T1", refuted_findings: [{ finding: { id: "code-reviewer-1" } }] },
    { id: "T2", refuted_findings: [] },
  ];

  it("scopes recorded ids by task, matching the brief's id space", () => {
    // applyFindingOutcomes strips the `${taskId}:` prefix when it applies an
    // outcome, so the stored record carries a task-LOCAL id and has to be
    // re-scoped before it can be compared against the tally's wave-scoped ones.
    expect([...refutedIdsOf(graph)]).toEqual(["T1:code-reviewer-1"]);
  });

  it("flags a refuted outcome the graph already holds", () => {
    const replays = replayedOutcomes([outcome("T1:code-reviewer-1", false)], refutedIdsOf(graph));
    expect(replays).toEqual(["T1:code-reviewer-1"]);
    expect(replayError(replays)).toContain("already been tallied");
  });

  it("flags a SURVIVING outcome the graph already holds refuted — the brief is stale", () => {
    // This used to assert the opposite, and that was the hole. A brief is built
    // from `task.findings`, which excludes refuted findings, so a FRESH brief
    // can never name an id the graph holds refuted. Seeing one means this brief
    // predates an adjudication, whichever way the new verdicts fell — and the
    // second run's own answer for this finding ("it survives") cannot be
    // applied, because `applyFindingOutcomes` only ever moves findings OUT.
    const replays = replayedOutcomes([outcome("T1:code-reviewer-1", true)], refutedIdsOf(graph));
    expect(replays).toEqual(["T1:code-reviewer-1"]);
  });

  it("flags a stale brief even when THIS run refutes a different finding", () => {
    // The exact walk-past the `!survives` filter allowed: tally 1 refuted
    // code-reviewer-1 and upheld code-reviewer-2; the operator rewrote the
    // verdicts and re-ran, flipping both. The two refutation sets are disjoint,
    // so the old guard saw nothing — and the tally refuted code-reviewer-2 off
    // a stale item set, promoting blocked → passed if it was the last live
    // critical while reporting code-reviewer-1 as surviving.
    const replays = replayedOutcomes(
      [outcome("T1:code-reviewer-1", true), outcome("T1:code-reviewer-2", false)],
      refutedIdsOf(graph),
    );
    expect(replays).toEqual(["T1:code-reviewer-1"]);
    expect(replayError(replays)).toContain("already been tallied");
  });

  it("does not confuse the same local id on a different task", () => {
    // The reason the ids are wave-scoped at all: two tasks in one wave both
    // holding `code-reviewer-1` is the normal case, not the exception.
    expect(replayedOutcomes([outcome("T2:code-reviewer-1", false)], refutedIdsOf(graph))).toEqual([]);
  });

  it("is empty against a graph that has adjudicated nothing", () => {
    expect(replayedOutcomes([outcome("T1:code-reviewer-1", false)], refutedIdsOf([{ id: "T1" }]))).toEqual([]);
  });
});

describe("manifestLensCount — reading the recorded panel size off untrusted JSON", () => {
  it("reads the length of a non-empty lens array", () => {
    expect(manifestLensCount({ lenses: ["reproduction", "intent"] })).toBe(2);
  });

  it.each([
    ["a non-object", 42],
    ["null", null],
    ["an array", []],
    ["a missing lenses field", {}],
    ["an empty lens array", { lenses: [] }],
    ["a non-array lenses field", { lenses: "three" }],
  ])("returns null for %s — parseReviewManifest is what rejects it, with a diagnostic", (_label, raw) => {
    expect(manifestLensCount(raw)).toBeNull();
  });
});
