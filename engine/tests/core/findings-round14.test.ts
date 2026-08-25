/**
 * Round-14 remediation: the findings-aggregate defects six reviewers found, and
 * the invariants that now foreclose them.
 *
 * Each block below names the failure it pins. They are kept together rather than
 * scattered into the existing suites because they share one subject — the
 * `Task.findings` aggregate and the load boundary that proves it — and because a
 * regression in any of them is the same class of bug: a critical finding that
 * silently stops blocking a wave.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Task, TaskCommonMetadata } from "../../src/types";
import { taskFixture } from "../fixtures/task-lifecycle";
import {
  attributeFindings,
  deduplicateFindingIds,
  findingIdCollisionError,
  findingsLockstepError,
  findingsViewError,
  makeDraftFinding,

  nextOrdinal,
  recoverViewOnlyClaims,
  refutationsUnionError,
  type Finding,
  type RefutedFinding,
} from "../../src/core/findings";
import { applyReviewResolution, resolveReviewFindings } from "../../src/core/review-output";
import { parseTaskGraph } from "../../src/state-manager";
import { updateTaskFindings } from "../../src/handlers/helpers/store-review-findings";

const draft = (severity: "critical" | "advisory", claim: string) =>
  makeDraftFinding({ severity, claim })!;

function task(overrides: Partial<TaskCommonMetadata> = {}): Task {
  return taskFixture({
    id: "T1",
    description: "d",
    agent: "code-implementer-agent",
    wave: 1,
    status: "implemented",
    depends_on: [],
    ...overrides,
  });
}

function graphWith(t: Record<string, unknown>): unknown {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    spec_file: null,
    plan_file: null,
    wave_gates: {},
    tasks: [{ id: "T1", description: "d", agent: "code-implementer-agent", wave: 1, status: "implemented", depends_on: [], ...t }],
  };
}

// ---------------------------------------------------------------------------
// C1 — evidence_capture_failed survives a sibling's clean pass, and clears
// ---------------------------------------------------------------------------

describe("evidence_capture_failed is per-agent, so a sibling cannot erase it", () => {
  const failed = (agent: string) =>
    applyReviewResolution(task(), resolveReviewFindings("no markers at all", agent));

  it("a later reviewer's clean pass does NOT demote the failure", () => {
    // The bug: /wave-gate spawns every reviewer in one message, so completion
    // order is arbitrary. Reviewer 2 finishing second used to overwrite
    // reviewer 1's evidence_capture_failed with `passed` and clear review_error,
    // making the gate outcome for identical transcripts nondeterministic.
    const afterOne = failed("code-reviewer");
    expect(afterOne.review_status).toBe("evidence_capture_failed");

    const clean = "### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 0";
    const afterTwo = applyReviewResolution(afterOne, resolveReviewFindings(clean, "comment-analyzer"));

    expect(afterTwo.review_status).toBe("evidence_capture_failed");
    expect(afterTwo.review_evidence_failures).toEqual(["code-reviewer"]);
    expect(afterTwo.review_error, "the reason must survive with the status").toBeDefined();
  });

  it("the reviewer that failed CAN clear it by re-running successfully", () => {
    // The other half: stickiness that only an operator override could lift
    // would fix the data loss and dead-end the normal recovery path.
    const afterFail = failed("code-reviewer");
    const clean = "### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 0";
    const afterRetry = applyReviewResolution(afterFail, resolveReviewFindings(clean, "code-reviewer"));

    expect(afterRetry.review_status).toBe("passed");
    expect(afterRetry.review_evidence_failures).toBeUndefined();
    expect(afterRetry.review_error).toBeUndefined();
  });

  it("clearing the last failure does not demote a task another reviewer blocked", () => {
    // The subtle one. Status is single-valued, so while a task sat at
    // evidence_capture_failed the `blocked` it would otherwise hold was masked.
    // Deriving the new status from THIS reviewer's drafts alone then dropped a
    // real critical another reviewer had already recorded.
    let t = failed("code-reviewer");
    const blocking = "### Machine Summary\nCRITICAL_COUNT: 1\nADVISORY_COUNT: 0\nCRITICAL: real blocker";
    t = applyReviewResolution(t, resolveReviewFindings(blocking, "silent-failure-hunter"));
    expect(t.review_status).toBe("evidence_capture_failed");
    expect(t.critical_findings).toEqual(["real blocker"]);

    const clean = "### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 0";
    t = applyReviewResolution(t, resolveReviewFindings(clean, "code-reviewer"));

    expect(t.review_status, "the other reviewer's critical still blocks").toBe("blocked");
    expect(t.critical_findings).toEqual(["real blocker"]);
  });

  it("two failed reviewers both have to come back", () => {
    let t = failed("code-reviewer");
    t = applyReviewResolution(t, resolveReviewFindings("still nothing", "pr-test-analyzer"));
    expect(t.review_evidence_failures).toEqual(["code-reviewer", "pr-test-analyzer"]);

    const clean = "### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 0";
    t = applyReviewResolution(t, resolveReviewFindings(clean, "code-reviewer"));
    expect(t.review_status).toBe("evidence_capture_failed");
    expect(t.review_evidence_failures).toEqual(["pr-test-analyzer"]);

    t = applyReviewResolution(t, resolveReviewFindings(clean, "pr-test-analyzer"));
    expect(t.review_status).toBe("passed");
  });

  it("a repeated failure from the same reviewer is recorded once", () => {
    let t = failed("code-reviewer");
    t = applyReviewResolution(t, resolveReviewFindings("still nothing", "code-reviewer"));
    expect(t.review_evidence_failures).toEqual(["code-reviewer"]);
  });

  it("the load boundary refuses the status without a named reviewer", () => {
    const parsed = parseTaskGraph(graphWith({ review_status: "evidence_capture_failed" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("names no reviewer");
  });

  it("the load boundary refuses named reviewers under a passing status", () => {
    const parsed = parseTaskGraph(
      graphWith({ review_status: "passed", review_evidence_failures: ["code-reviewer"] }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("review_status is \"passed\"");
  });

  it("rejects stale review_error after review_status has moved to passed", () => {
    const parsed = parseTaskGraph(
      graphWith({ review_status: "passed", review_error: "CRITICAL_COUNT marker not found" }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("review_error is meaningful only");
  });

  it("rejects an unconfigured legacy reviewer that no retry can spawn", () => {
    const parsed = parseTaskGraph(
      graphWith({
        review_status: "evidence_capture_failed",
        review_error: "capture failed",
        review_evidence_failures: ["retired-reviewer"],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("unconfigured reviewer 'retired-reviewer'");
  });

  it("rejects a failed reviewer outside the active packet's expected batch", () => {
    const parsed = parseTaskGraph(
      graphWith({
        review_status: "evidence_capture_failed",
        review_error: "capture failed",
        review_generation: 1,
        review_evidence_failures: ["silent-failure-hunter"],
        review_run: {
          generation: 1,
          packet_id: "a".repeat(64),
          head_sha: "b".repeat(40),
          expected_agents: ["code-reviewer"],
          prior_finding_ids: [],
          evidence: [],
        },
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("outside the active review run");
  });

  it("accepts the well-formed pairing", () => {
    const parsed = parseTaskGraph(
      graphWith({
        review_status: "evidence_capture_failed",
        review_error: "CRITICAL_COUNT marker not found",
        review_evidence_failures: ["code-reviewer"],
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  it("an operator override clears the whole review record", () => {
    const overridden = updateTaskFindings(
      task({
        review_status: "evidence_capture_failed",
        review_error: "CRITICAL_COUNT marker not found",
        review_evidence_failures: ["code-reviewer"],
      }),
      [],
      [],
    );
    expect(overridden.review_status).toBe("passed");
    expect(overridden.review_evidence_failures).toBeUndefined();
    expect(overridden.review_error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C2 — the derived views earn their `readonly string[]` type
// ---------------------------------------------------------------------------

describe("the load boundary proves the derived views are string arrays", () => {
  it.each([
    ["a non-string member beside no findings array", { critical_findings: ["real", 42] }],
    ["a non-array view", { critical_findings: { a: 1 } }],
    ["a non-string advisory member", { advisory_findings: [null] }],
    [
      "a non-string member beside an otherwise in-step findings array",
      {
        findings: [{ id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "real" }],
        critical_findings: ["real", 42],
        advisory_findings: [],
      },
    ],
  ])("rejects %s", (_label, fields) => {
    const parsed = parseTaskGraph(graphWith(fields));
    expect(parsed.ok).toBe(false);
  });

  it("names the offending index rather than a generic shape error", () => {
    const parsed = parseTaskGraph(graphWith({ critical_findings: ["real", 42] }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("critical_findings[1] must be a string");
  });

  it("findingsLockstepError reports a malformed view instead of filtering it away", () => {
    // The masking bug: non-strings were dropped BEFORE the multiset comparison,
    // so a broken view reported as in lockstep and the graph loaded. The gate
    // then threw `f.trim is not a function` from inside checkCriticalFindings.
    const error = findingsLockstepError([], ["real", 42], [], "T1");
    expect(error).not.toBeNull();
    expect(error).toContain("must be a string");
  });

  it("findingsViewError accepts absent and well-formed views", () => {
    expect(findingsViewError(undefined, "T1")).toBeNull();
    expect(findingsViewError([], "T1")).toBeNull();
    expect(findingsViewError(["a", "b"], "T1")).toBeNull();
  });

  it("property: a view of strings never trips the shape check", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (claims) => findingsViewError(claims, "T1") === null),
    );
  });
});

// ---------------------------------------------------------------------------
// C3 — the manual override cannot rewind an id
// ---------------------------------------------------------------------------

describe("updateTaskFindings mints ids that removal cannot rewind", () => {
  it("a second override does not reuse the first override's id", () => {
    // The bug: nextOrdinal was seeded from the SURVIVING subset, so override #2
    // re-minted `manual-override-1`. An in-flight refutation brief still named
    // that id, so applyFindingOutcomes' absence guard stayed quiet while it
    // retired a different, live critical and filed the panel's reasoning about
    // claim A against claim C.
    const first = updateTaskFindings(task(), ["claim A"], []);
    expect(first.findings?.map((f) => f.id)).toEqual(["manual-override-1"]);

    const second = updateTaskFindings(first, ["claim C"], []);
    expect(second.findings?.map((f) => f.id)).toEqual(["manual-override-2"]);
    expect(second.critical_findings).toEqual(["claim C"]);
  });

  it("property: ids are strictly increasing across any override sequence", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.string({ minLength: 1 }).filter((s) => s.trim() !== ""), { maxLength: 3 }), {
          minLength: 1,
          maxLength: 6,
        }),
        (rounds) => {
          let current = task();
          const seen = new Set<string>();
          for (const criticals of rounds) {
            current = updateTaskFindings(current, [...criticals], []);
            for (const finding of current.findings ?? []) {
              if (finding.agent !== "manual-override") continue;
              // An id may PERSIST across rounds (advisories are kept), but a
              // retired one must never come back attached to a new claim.
              seen.add(`${finding.id}\0${finding.claim}`);
            }
          }
          const ids = [...seen].map((entry) => entry.split("\0")[0]!);
          return new Set(ids).size === ids.length;
        },
      ),
    );
  });

  it("keeps advisories the override did not speak to, without colliding with them", () => {
    const withAdvisory = updateTaskFindings(task(), ["c1"], ["a1"]);
    const overridden = updateTaskFindings(withAdvisory, ["c2"], []);
    expect(overridden.advisory_findings).toEqual(["a1"]);
    const ids = overridden.findings!.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// A7 — an id cannot be live and refuted at once
// ---------------------------------------------------------------------------

describe("finding ids are unique ACROSS findings and refuted_findings", () => {
  const live = { id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "live claim" };
  const refuted: RefutedFinding = {
    finding: { id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "dead claim" },
    refutations: [{ lens: "intent", reason: "deliberate" }],
  };

  it("the load boundary rejects the collision", () => {
    // Terminal without this: the tally's replay guard builds `alreadyRefuted`
    // from refuted_findings and refuses to adjudicate any brief item whose id is
    // in it, so the live finding can never be voted on — and the guard's advice
    // ("start a new run directory") can never clear it.
    const parsed = parseTaskGraph(
      graphWith({
        findings: [live],
        critical_findings: ["live claim"],
        advisory_findings: [],
        refuted_findings: [refuted],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("refuted_findings already holds");
  });

  it("--fix repairs it by re-minting the live finding's id", () => {
    const repaired = deduplicateFindingIds([live as Finding], [refuted as RefutedFinding]);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.id).not.toBe("code-reviewer-1");
    expect(repaired[0]!.claim, "the claim is a naming defect's victim, not its cause").toBe("live claim");
  });

  it("refutationsUnionError rejects a repeated refuted id", () => {
    const error = refutationsUnionError([refuted, refuted], "T1: refuted_findings");
    expect(error).toContain("repeats refuted finding id");
  });

  it("findingIdCollisionError is silent when either side is absent", () => {
    expect(findingIdCollisionError(undefined, [refuted], "T1")).toBeNull();
    expect(findingIdCollisionError([live], undefined, "T1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A9 — --fix does not duplicate a critical over a whitespace difference
// ---------------------------------------------------------------------------

describe("view claims are normalized before the orphan comparison", () => {
  it("a view claim differing only by an internal space run is not an orphan", () => {
    // The bug: `makeDraftFinding` collapses whitespace runs, the raw view read
    // from disk does not, and `removeOnce` compares verbatim — so `--fix` minted
    // a SECOND finding and one critical became two the panel must each refute.
    const identified = attributeFindings([draft("critical", "foo bar")], "code-reviewer");
    const recovered = recoverViewOnlyClaims(identified, [], { critical: ["foo  bar"], advisory: [] });
    expect(recovered).toEqual([]);
  });

  it("a genuinely orphaned claim is still recovered", () => {
    const recovered = recoverViewOnlyClaims([], [], { critical: ["a real orphan"], advisory: [] });
    expect(recovered.map((f) => f.claim)).toEqual(["a real orphan"]);
  });

  it("property: normalizing a view claim never creates an orphan", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }).filter((s) => s.trim() !== "" && !/^(none|n\/a)$/i.test(s.trim())), (raw) => {
        const finding = makeDraftFinding({ severity: "critical", claim: raw });
        if (finding === null) return true;
        const identified = attributeFindings([finding], "code-reviewer");
        return recoverViewOnlyClaims(identified, [], { critical: [raw], advisory: [] }).length === 0;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// nextOrdinal's contract, stated directly
// ---------------------------------------------------------------------------

describe("nextOrdinal counts every id a task ever minted", () => {
  it("property: it exceeds every ordinal in findings AND refuted_findings", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 50 }), { maxLength: 5 }),
        fc.array(fc.integer({ min: 1, max: 50 }), { maxLength: 5 }),
        (liveOrdinals, refutedOrdinals) => {
          const mk = (n: number): Finding => ({
            ...draft("critical", `claim ${n}`),
            id: `code-reviewer-${n}`,
            agent: "code-reviewer",
          });
          const next = nextOrdinal(
            liveOrdinals.map(mk),
            refutedOrdinals.map((n) => ({ finding: mk(n), refutations: [{ lens: "intent", reason: "r" }] })),
            "code-reviewer",
          );
          return [...liveOrdinals, ...refutedOrdinals].every((n) => next > n);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// The lockstep invariant holds through the new merge path
// ---------------------------------------------------------------------------

describe("mergeFindings keeps lockstep across evidence failures", () => {
  it("property: the views always equal the derived claims, whatever the sequence", () => {
    const TRANSCRIPTS = [
      "no markers at all",
      "### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 0",
      "### Machine Summary\nCRITICAL_COUNT: 1\nADVISORY_COUNT: 1\nCRITICAL: blocker\nADVISORY: nit",
    ];
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom("code-reviewer", "comment-analyzer", "pr-test-analyzer"),
            fc.constantFrom(...TRANSCRIPTS),
          ),
          { minLength: 1, maxLength: 8 },
        ),
        (steps) => {
          let current = task();
          for (const [agent, transcript] of steps) {
            current = applyReviewResolution(current, resolveReviewFindings(transcript, agent));
          }
          const derivedCritical = (current.findings ?? [])
            .filter((f) => f.severity === "critical")
            .map((f) => f.claim);
          const derivedAdvisory = (current.findings ?? [])
            .filter((f) => f.severity === "advisory")
            .map((f) => f.claim);
          return (
            JSON.stringify(current.critical_findings ?? []) === JSON.stringify(derivedCritical) &&
            JSON.stringify(current.advisory_findings ?? []) === JSON.stringify(derivedAdvisory)
          );
        },
      ),
    );
  });

  it("property: the resulting graph always survives its own load boundary", () => {
    const TRANSCRIPTS = [
      "no markers at all",
      "### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 0",
      "### Machine Summary\nCRITICAL_COUNT: 2\nADVISORY_COUNT: 0\nCRITICAL: one",
    ];
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.constantFrom("code-reviewer", "comment-analyzer"), fc.constantFrom(...TRANSCRIPTS)),
          { minLength: 1, maxLength: 6 },
        ),
        (steps) => {
          let current = task();
          for (const [agent, transcript] of steps) {
            current = applyReviewResolution(current, resolveReviewFindings(transcript, agent));
          }
          // JSON round-trip: `undefined` fields disappear exactly as they do on
          // disk, which is the shape the biconditional is actually proved over.
          const onDisk = JSON.parse(JSON.stringify(graphWith(current as unknown as Record<string, unknown>)));
          return parseTaskGraph(onDisk).ok;
        },
      ),
    );
  });
});
