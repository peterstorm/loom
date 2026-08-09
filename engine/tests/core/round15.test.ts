/**
 * Round-15 remediation: the defects six reviewers found, and the rules that now
 * foreclose them.
 *
 * Grouped by the module each defect lives in rather than by reviewer, because
 * the shared subject is what makes them one file: every block below is a place
 * where a critical finding could stop blocking a wave, or where a repair the
 * engine itself recommends did not work.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyFindingOutcomes,
  attributeFindings,
  deduplicateFindingIds,
  findingIdCollisionError,
  findingsUnionError,
  mergeFindings,
  unrecoverableViewClaims,
  type Finding,
  type RefutedFinding,
} from "../../src/core/findings";
import {
  carriedOverCount,
  parseMachineSummary,
  reviewResolutionLog,
} from "../../src/core/review-output";
import {
  defaultRefutationThreshold,
  selectReviewLenses,
  staleWaveError,
  tallyRefutations,
  REVIEW_LENSES,
  type BriefFinding,
  type ReviewLens,
  type WaveFindingId,
} from "../../src/core/review-panel";
import { exactOrderedSetErrors, sanitizeProse, selectLenses } from "../../src/core/panel-kernel";
import { aggregateVerdicts, candidateFilename, type JudgeVerdict } from "../../src/core/panel-contract";
import { artifactError, pruneSurplusItems } from "../../src/handlers/helpers/panel-run";
import { deriveAgentTranscriptPath } from "../../src/utils/agent-transcript-path";
import { parseTaskGraph } from "../../src/state-manager";
import type { Task } from "../../src/types";
import { fixFull, validateFull } from "../../src/handlers/helpers/validate-task-graph";

// ---------------------------------------------------------------------------
// C3 — the repair the load boundary recommends has to actually work
// ---------------------------------------------------------------------------

describe("deduplicateFindingIds restores the postcondition it exists for", () => {
  const one = (agent: string, ordinal: number, claim: string): Finding =>
    attributeFindings([{ severity: "critical", claim, file: null, line: null }], agent, ordinal)[0]!;

  it("does not re-mint onto an id a LATER finding already holds", () => {
    // The bug, verbatim: ["x-1","x-1","x-2"] → ["x-1","x-2","x-2"]. `nextOrdinal`
    // reads only the findings processed SO FAR, and the re-minted id was never
    // recorded, so the second x-1 landed on the third finding's id.
    const input = [one("x", 1, "one"), one("x", 1, "two"), one("x", 2, "three")];
    const out = deduplicateFindingIds(input, []);
    expect(out.map((f) => f.id)).toEqual(["x-1", "x-2", "x-3"]);
    expect(findingsUnionError(out, "T1")).toBeNull();
  });

  it("clears every collision in ONE pass, however they are stacked", () => {
    // The old loop needed one run per collision, and every intermediate graph
    // was still rejected — so the operator ran the recommended repair, was told
    // it succeeded AND that the issue remained, and the state file stayed
    // unloadable.
    const input = [one("x", 1, "a"), one("x", 1, "b"), one("x", 2, "c"), one("x", 3, "d")];
    const out = deduplicateFindingIds(input, []);
    expect(findingsUnionError(out, "T1")).toBeNull();
    expect(new Set(out.map((f) => f.id)).size).toBe(4);
  });

  it("still refuses ids the refuted set holds", () => {
    const refuted: RefutedFinding[] = [{
      finding: one("x", 2, "already refuted"),
      refutations: [{ lens: "intent", reason: "deliberate" }],
    }];
    const out = deduplicateFindingIds([one("x", 1, "a"), one("x", 1, "b")], refuted);
    expect(out.map((f) => f.id)).not.toContain("x-2");
    expect(findingsUnionError(out, "T1")).toBeNull();
    // The cross-set rule, which is the one the refuted seed exists for: a live
    // finding sharing an id with a refuted one is refused at load, and the
    // replay guard would then refuse to adjudicate it.
    expect(findingIdCollisionError(out, refuted, "T1")).toBeNull();
  });

  it("PROPERTY: the output is always unique, for any multiset of ids", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 12 }),
        fc.array(fc.integer({ min: 1, max: 4 }), { maxLength: 4 }),
        (liveOrdinals, refutedOrdinals) => {
          const refuted: RefutedFinding[] = refutedOrdinals.map((n, i) => ({
            finding: one("x", n, `refuted ${i}`),
            refutations: [{ lens: "intent", reason: "r" }],
          }));
          const live = liveOrdinals.map((n, i) => one("x", n, `live ${i}`));
          const out = deduplicateFindingIds(live, refuted);
          // The only postcondition that matters: the load boundary accepts it,
          // on BOTH rules it enforces over finding identity.
          return (
            findingsUnionError(out, "T1") === null &&
            findingIdCollisionError(out, refuted, "T1") === null &&
            out.length === live.length
          );
        },
      ),
    );
  });

  it("PROPERTY: --fix is a fixed point and its output always loads", () => {
    // The repair↔rejection agreement, end to end: `fixFull` must produce a graph
    // `validateFull` accepts, and running it again must change nothing.
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 8 }),
        (ordinals) => {
          const graph = {
            current_phase: "execute",
            phase_artifacts: {},
            plan_title: "t",
            plan_file: ".claude/plans/p.md",
            spec_file: ".claude/specs/s/spec.md",
            tasks: [{
              id: "T1",
              description: "d",
              agent: "code-implementer-agent",
              wave: 1,
              status: "implemented",
              depends_on: [],
              new_tests_required: false,
              findings: ordinals.map((n, i) => one("code-reviewer", n, `claim ${i}`)),
            }],
          };
          const once = fixFull(graph);
          const twice = fixFull(JSON.parse(once.json));
          return validateFull(JSON.parse(once.json)).ok && once.json === twice.json;
        },
      ),
      { numRuns: 40 },
    );
  });
});

// ---------------------------------------------------------------------------
// The derived view must not merely have the right COUNT — found while
// remediating, not reported by a reviewer
// ---------------------------------------------------------------------------

describe("applyFindingOutcomes derives the views rather than subtracting from them", () => {
  const claims = (severity: "critical" | "advisory", texts: readonly string[]): Task => {
    const base: Task = {
      id: "T1", description: "d", agent: "code-implementer-agent", wave: 1,
      status: "implemented", depends_on: [], review_status: "pending",
    };
    return mergeFindings(
      base,
      {
        drafts: texts.map((claim) => ({ severity, claim, file: null, line: null })),
        criticalCount: severity === "critical" ? texts.length : 0,
      },
      "code-reviewer",
    );
  };

  const refute = (task: Task, index: number): Task =>
    applyFindingOutcomes(task, [{
      finding: { id: `T1:${task.findings![index]!.id}`, taskId: "T1" },
      refutations: [{ lens: "intent", reason: "deliberate" }],
      survives: false,
    }]);

  it("keeps the view in the SAME ORDER as the array when two claims read alike", () => {
    // The old code subtracted the refuted claims from the stored view with
    // `removeOnce`, which deletes the FIRST occurrence of a claim while `kept`
    // deletes the one at the refuted INDEX. Refuting the second "B" of
    // [!, B, !, B] left the array [!, B, !] and the view [!, !, B]: the right
    // multiset, the wrong sequence. `findingsLockstepError` compares as a
    // multiset, so nothing failed — while `--fix` re-derives the views from
    // `findings` and so rewrote the file on the next repair for no reason, and
    // any reader pairing the two by position read one claim against another's
    // identity. Reproduced by the repo's own lockstep property at ~1-in-3000.
    const before = claims("advisory", ["!", "B", "!", "B"]);
    const after = refute(before, 3);

    expect(after.findings!.map((f) => f.claim)).toEqual(["!", "B", "!"]);
    expect(after.advisory_findings, "the view is the array's claims, in order").toEqual(["!", "B", "!"]);
  });

  it("holds for criticals too", () => {
    const after = refute(claims("critical", ["dup", "other", "dup"]), 0);
    expect(after.critical_findings).toEqual(["other", "dup"]);
    expect(after.critical_findings).toEqual(after.findings!.map((f) => f.claim));
  });

  it("still CONSERVES a view claim no structured finding accounts for", () => {
    // The thing `removeOnce` was really buying. A pre-identity task can hold
    // view claims with no counterpart in `findings`, and deriving from `kept`
    // alone would delete a critical the wave gate counts.
    const withOrphan: Task = { ...claims("critical", ["adjudicated"]) };
    const orphaned: Task = {
      ...withOrphan,
      critical_findings: [...withOrphan.critical_findings!, "a claim only the view holds"],
    };
    const after = refute(orphaned, 0);

    expect(after.findings).toHaveLength(0);
    expect(after.critical_findings, "the orphan survives the refutation").toEqual([
      "a claim only the view holds",
    ]);
  });

  it("PROPERTY: the view always EQUALS the array's claims when they started in step", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ critical: fc.boolean(), claim: fc.constantFrom("a", "b", "c") }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
        (specs, killFlags) => {
          // A three-claim alphabet on purpose: duplicates are the trigger, and
          // the original property's 6-char random strings collide too rarely to
          // find this in the default 100 runs.
          const start = mergeFindings(
            {
              id: "T1", description: "d", agent: "code-implementer-agent", wave: 1,
              status: "implemented", depends_on: [], review_status: "pending",
            },
            {
              drafts: specs.map((s) => ({
                severity: s.critical ? ("critical" as const) : ("advisory" as const),
                claim: s.claim,
                file: null,
                line: null,
              })),
              criticalCount: specs.filter((s) => s.critical).length,
            },
            "code-reviewer",
          );
          const outcomes = start.findings!.map((finding, index) => ({
            finding: { id: `T1:${finding.id}`, taskId: "T1" },
            refutations: [{ lens: "intent", reason: "deliberate" }] as const,
            survives: !killFlags[index],
          }));
          const after = applyFindingOutcomes(start, outcomes as never);
          const live = after.findings ?? [];
          return (
            JSON.stringify(after.critical_findings) ===
              JSON.stringify(live.filter((f) => f.severity === "critical").map((f) => f.claim)) &&
            JSON.stringify(after.advisory_findings) ===
              JSON.stringify(live.filter((f) => f.severity === "advisory").map((f) => f.claim))
          );
        },
      ),
      { numRuns: 2000 },
    );
  });
});

// ---------------------------------------------------------------------------
// A5 — a repair that removes a claim has to say so
// ---------------------------------------------------------------------------

describe("view-only claims that cannot be given identity are reported, not vanished", () => {
  it("names a sentinel claim the repair drops", () => {
    // `checkCriticalFindings` filters on non-empty text, NOT on sentinels, so a
    // pre-identity task holding ["none"] BLOCKED the gate before --fix and
    // PASSED after, with `dropped` computed only from `findings` so it stayed 0.
    expect(unrecoverableViewClaims([], ["none"], [])).toEqual(["none"]);
    // Collapsed before the reject decision, so it comes back normalized — the
    // point is that it is REPORTED, not what it looks like.
    expect(unrecoverableViewClaims([], ["  "], [])).toEqual([""]);
  });

  it("says nothing about claims that WERE recovered", () => {
    expect(unrecoverableViewClaims([], ["a real blocker"], [])).toEqual([]);
  });

  it("--fix emits an operator note naming the dropped claim and its consequence", () => {
    const repaired = fixFull({
      current_phase: "execute",
      phase_artifacts: {},
      tasks: [{
        id: "T1", description: "d", agent: "code-implementer-agent", wave: 1,
        status: "implemented", depends_on: [], new_tests_required: false,
        critical_findings: ["none"],
      }],
    });
    const note = repaired.notes.find((n) => n.includes("DROPPED view-only claim"));
    expect(note, `notes were: ${repaired.notes.join(" | ")}`).toBeDefined();
    expect(note).toContain("blocked the gate before this repair and no longer does");
  });
});

// ---------------------------------------------------------------------------
// A1 — the brief's wave proof fails CLOSED
// ---------------------------------------------------------------------------

describe("staleWaveError", () => {
  it("accepts the wave the graph is on", () => {
    expect(staleWaveError(2, 2)).toBeNull();
  });

  it("refuses a closed wave", () => {
    expect(staleWaveError(1, 2)).toContain("is not the graph's current wave");
  });

  it("refuses a graph with NO current wave rather than accepting anything", () => {
    // The guard used to skip entirely when `current_wave` was absent — the one
    // state where "which wave is this?" has no answer, so every --wave passed.
    const error = staleWaveError(7, undefined);
    expect(error).not.toBeNull();
    expect(error).toContain("records no current wave");
  });
});

// ---------------------------------------------------------------------------
// A8 / A17 — arbitration branches that survived mutation
// ---------------------------------------------------------------------------

describe("chooseSource keeps claim identity and marker severity in lockstep", () => {
  const block = (entries: unknown[]) =>
    ["```findings", JSON.stringify(entries), "```"].join("\n");

  it("does not record one claim TWICE when the block disagrees about severity", () => {
    // Matching per severity meant a block entry whose severity contradicted its
    // own marker line matched nothing, so the claim was recorded once as
    // critical (markers) and once as advisory (block). The panel then adjudicates
    // one defect twice, and the advisory copy can be dismissed while the critical
    // copy still blocks.
    const parsed = parseMachineSummary([
      "### Machine Summary",
      "CRITICAL_COUNT: 1",
      "ADVISORY_COUNT: 0",
      "CRITICAL: the retry loop never terminates",
      block([{ severity: "advisory", file: "src/a.ts", line: 3, claim: "the retry loop never terminates" }]),
    ].join("\n"))!;

    const all = [...parsed.critical, ...parsed.advisory];
    expect(all.filter((c) => c === "the retry loop never terminates")).toHaveLength(1);
    expect(parsed.critical, "the markers won, so the marker severity governs").toEqual([
      "the retry loop never terminates",
    ]);
  });

  it("does not duplicate or demote across severities on the WINNING side", () => {
    // The block clears the cardinal bar through another critical. Claim text is
    // still one identity, but the marker is severity authority: the optional
    // location-bearing block must not turn its critical into an advisory.
    const parsed = parseMachineSummary([
      "### Machine Summary",
      "CRITICAL_COUNT: 2",
      "ADVISORY_COUNT: 0",
      "CRITICAL: claim one",
      "CRITICAL: claim two",
      block([
        { severity: "advisory", file: "src/a.ts", line: 1, claim: "claim one" },
        { severity: "critical", file: "src/b.ts", line: 2, claim: "claim two" },
        { severity: "critical", file: "src/c.ts", line: 3, claim: "claim three" },
      ]),
    ].join("\n"))!;

    const all = [...parsed.critical, ...parsed.advisory];
    expect(all.filter((c) => c === "claim one")).toHaveLength(1);
    expect(parsed.critical).toContain("claim one");
    expect(parsed.advisory).not.toContain("claim one");
    expect(parsed.drafts.find((draft) => draft.claim === "claim one")).toMatchObject({
      severity: "critical",
      file: "src/a.ts",
      line: 1,
    });
  });

  it("does not let a same-text advisory consume and erase a critical marker", () => {
    const shared = "same text, different severity";
    const parsed = parseMachineSummary([
      "### Machine Summary",
      "CRITICAL_COUNT: 1",
      "ADVISORY_COUNT: 1",
      `CRITICAL: ${shared}`,
      `ADVISORY: ${shared}`,
      block([
        { severity: "advisory", file: "src/advisory.ts", line: 1, claim: shared },
        { severity: "critical", file: "src/other.ts", line: 2, claim: "another blocker" },
      ]),
    ].join("\n"))!;

    expect(parsed.critical).toEqual(["another blocker", shared]);
    expect(parsed.advisory).toEqual([shared]);
    expect(parsed.drafts.filter((draft) => draft.claim === shared).map((draft) => draft.severity))
      .toEqual(["advisory", "critical"]);
  });

  it("a CRITICAL_COUNT that understates its own marker lines still sets the bar", () => {
    // The `scraped.critical.length` term of `claimedCritical`. With only
    // `criticalCount` the bar here would be 0, a one-entry block would clear it,
    // and the block would win as `partial` rather than losing as `superseded`.
    const parsed = parseMachineSummary([
      "### Machine Summary",
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
      "CRITICAL: first blocker",
      "CRITICAL: second blocker",
      block([{ severity: "critical", file: "src/a.ts", line: 1, claim: "first blocker" }]),
    ].join("\n"))!;
    expect(parsed.blockStatus.kind).toBe("superseded");
    expect(parsed.critical).toEqual(["first blocker", "second blocker"]);
  });

  it("the operator line reports the markers' count when CRITICAL_COUNT understates it", () => {
    // The `Math.max` in `reviewResolutionLog`. Every prior assertion used a
    // count that AGREED with its marker lines, so the disjunction never
    // discriminated and `criticalCount ?? 0` survived mutation.
    const parsed = parseMachineSummary([
      "### Machine Summary",
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
      "CRITICAL: a real blocker",
    ].join("\n"))!;
    const log = reviewResolutionLog("T1", { kind: "findings", agent: "code-reviewer", findings: parsed });
    expect(log).toContain("blocked");
    expect(log).toContain("(1 critical)");
  });

  it("stops reading at the next heading, findings-shaped content and all", () => {
    // The next-heading trim in `parseMachineSummary`. The existing fixture put a
    // heading after the summary with nothing findings-shaped under it, so
    // deleting the trim changed nothing.
    const parsed = parseMachineSummary([
      "### Machine Summary",
      "CRITICAL_COUNT: 1",
      "ADVISORY_COUNT: 0",
      "CRITICAL: inside the summary",
      "",
      "### Appendix",
      "CRITICAL: outside the summary",
    ].join("\n"))!;
    expect(parsed.critical).toEqual(["inside the summary"]);
  });

  it("carries advisories over from a LOSING block, not just criticals", () => {
    const parsed = parseMachineSummary([
      "### Machine Summary",
      "CRITICAL_COUNT: 2",
      "ADVISORY_COUNT: 1",
      "CRITICAL: only one named",
      "ADVISORY: a nit the markers named",
      block([
        { severity: "critical", file: "src/a.ts", line: 1, claim: "only one named" },
        { severity: "advisory", file: "src/b.ts", line: 2, claim: "a nit only the block named" },
      ]),
    ].join("\n"))!;
    expect(parsed.blockStatus.kind).toBe("superseded");
    expect(parsed.advisory).toContain("a nit only the block named");
    expect(carriedOverCount(parsed.blockStatus)).toBe(1);
  });

  it("carriedOverCount is zero for every arm that carries nothing", () => {
    expect(carriedOverCount({ kind: "absent" })).toBe(0);
    expect(carriedOverCount({ kind: "used" })).toBe(0);
    expect(carriedOverCount({ kind: "rejected" })).toBe(0);
    expect(carriedOverCount({ kind: "partial", carriedOver: 3 })).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// A12 — the load boundary proves wave_gates and spec_check too
// ---------------------------------------------------------------------------

describe("the load boundary proves wave_gates and spec_check, not just tasks", () => {
  const graph = (extra: Record<string, unknown>) => ({
    current_phase: "execute",
    phase_artifacts: {},
    tasks: [],
    ...extra,
  });

  it("refuses a non-boolean reviews_complete", () => {
    // `validate-task-execution` blocks on `!gate.reviews_complete`, so the string
    // "no" read as TRUTHY and the previous-wave review gate silently stopped
    // blocking — while the cast asserted `Record<string, WaveGate>` and proved
    // only that the container was an object.
    const parsed = parseTaskGraph(graph({ wave_gates: { "1": { reviews_complete: "no" } } }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("reviews_complete must be a boolean");
  });

  it("accepts tests_passed: null — 'not yet judged' is a real state", () => {
    const parsed = parseTaskGraph(
      graph({ wave_gates: { "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false } } }),
    );
    expect(parsed.ok).toBe(true);
  });

  it("refuses a tests_passed that is neither boolean nor null", () => {
    const parsed = parseTaskGraph(graph({ wave_gates: { "1": { tests_passed: "yes" } } }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("tests_passed must be a boolean or null");
  });

  it("routes spec_check.verdict through the smart constructor that exists for it", () => {
    const parsed = parseTaskGraph(graph({ spec_check: { wave: 1, run_at: "t", verdict: "MOSTLY_FINE" } }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("spec_check.verdict");
  });

  it("accepts a well-formed spec_check", () => {
    const parsed = parseTaskGraph(graph({
      spec_check: {
        wave: 1,
        run_at: "t",
        verdict: "PASSED",
        critical_count: 0,
        high_count: 0,
        critical_findings: [],
        high_findings: [],
        medium_findings: [],
      },
    }));
    expect(parsed.ok).toBe(true);
  });

  it("refuses spec-check count/view drift at the state boundary", () => {
    const parsed = parseTaskGraph(graph({
      spec_check: {
        wave: 1,
        run_at: "t",
        verdict: "PASSED",
        critical_count: 0,
        high_count: 0,
        critical_findings: ["real drift"],
        high_findings: [],
        medium_findings: [],
      },
    }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("must equal critical_findings.length");
  });

  it("refuses a string current_wave before task execution can coerce it", () => {
    const parsed = parseTaskGraph(graph({ current_wave: "2" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("current_wave must be an integer >= 1");
  });

  it("an absent spec_check is not an error — it is the pre-wave-gate state", () => {
    expect(parseTaskGraph(graph({})).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A15 — kernel rules that no test could reach
// ---------------------------------------------------------------------------

describe("kernel rules that were deletable with the suite green", () => {
  it("exactOrderedSetErrors rejects a repeated id", () => {
    const errors = exactOrderedSetErrors(["a", "a"], ["a", "b"], {
      subject: "manifest candidates",
      missing: "manifest is missing candidate",
      ordered: "manifest candidates",
    });
    expect(errors.some((e) => e.includes("must be unique"))).toBe(true);
  });

  describe("selectLenses", () => {
    const spec = (count: number, signalled: readonly string[]) => ({
      baseline: ["reproduction", "intent"] as const,
      signalled,
      table: ["reproduction", "intent", "blast-radius", "security", "test-integrity"] as const,
      count,
      countLabel: "--lenses",
    });

    it("puts the baselines first and fills from the signals", () => {
      const selected = selectLenses(spec(3, ["security"]));
      expect(selected.ok).toBe(true);
      if (selected.ok) expect(selected.value).toEqual(["reproduction", "intent", "security"]);
    });

    it("DROPS a signalled lens at minimum panel size — baselines outrank signals", () => {
      // The behaviour the function's own comment calls "the arguable call", and
      // which nothing pinned: every existing test used count >= 3, and the one
      // that iterated the range asserted only `.length`.
      const selected = selectLenses(spec(2, ["security"]));
      expect(selected.ok).toBe(true);
      if (selected.ok) expect(selected.value).toEqual(["reproduction", "intent"]);
    });

    it("refuses a count below the baseline or above the table", () => {
      expect(selectLenses(spec(1, [])).ok).toBe(false);
      expect(selectLenses(spec(6, [])).ok).toBe(false);
      expect(selectLenses(spec(2.5, [])).ok).toBe(false);
    });

    it("never repeats a lens that is both baseline and signalled", () => {
      const selected = selectLenses(spec(3, ["intent"]));
      expect(selected.ok).toBe(true);
      if (selected.ok) expect(new Set(selected.value).size).toBe(selected.value.length);
    });
  });

  describe("sanitizeProse — what it strips, and what it deliberately does not", () => {
    it("strips the braces that would read as an unsubstituted placeholder", () => {
      expect(sanitizeProse("a {placeholder} in prose")).toBe("a placeholder in prose");
      expect(sanitizeProse("${injected}")).toBe("$injected");
      expect(sanitizeProse("{{nested}}")).toBe("nested");
    });

    it("trims the outside", () => {
      expect(sanitizeProse("  padded  ")).toBe("padded");
    });

    it("PROPERTY: no brace survives, whatever goes in", () => {
      // The one invariant the whole function exists for. Pinned as a property so
      // the class cannot be narrowed by accident.
      fc.assert(
        fc.property(fc.string(), (raw) => !/[{}]/.test(sanitizeProse(raw))),
      );
    });

    it("does NOT strip backticks, dollars, or inner newlines — pinned, not endorsed", () => {
      // These pass through today. Asserted so that widening or narrowing the
      // class is a deliberate edit to this test rather than a silent change to
      // what reaches a prompt template.
      expect(sanitizeProse("`code`")).toBe("`code`");
      expect(sanitizeProse("a\nb")).toBe("a\nb");
      expect(sanitizeProse("100% $safe")).toBe("100% $safe");
    });
  });
});

// ---------------------------------------------------------------------------
// A15 — compareRankings has to be a total order, or input order leaks out
// ---------------------------------------------------------------------------

describe("aggregateVerdicts ranks by a total order", () => {
  const CRITERIA = ["simplicity", "testability", "fit"];
  const LENSES = ["simplicity-first", "type-driven-fp", "risk-security-first"] as const;
  const candidates = LENSES.map(candidateFilename);

  const verdictsFor = (scores: Record<string, readonly number[]>): readonly JudgeVerdict[] =>
    CRITERIA.map((criterion, criterionIndex) => ({
      criterion,
      entries: LENSES.map((lens) => ({
        candidate: candidateFilename(lens),
        score: scores[lens]![criterionIndex]!,
        fatalFlaw: null,
        strongestIdea: "x",
      })),
    }));

  it("PROPERTY: the ranking is a permutation of the expected candidates, totals intact", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(...LENSES),
          fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 3, maxLength: 3 }),
          { minKeys: 3 },
        ),
        (scores) => {
          if (LENSES.some((lens) => scores[lens] === undefined)) return true;
          const ranked = aggregateVerdicts(verdictsFor(scores), CRITERIA, candidates);
          if (!ranked.ok) return false;
          const named = ranked.value.map((entry) => entry.candidate).sort();
          if (JSON.stringify(named) !== JSON.stringify([...candidates].sort())) return false;
          return ranked.value.every(
            (entry) => entry.totalScore === entry.scores.reduce((sum, s) => sum + s.score, 0),
          );
        },
      ),
      { numRuns: 60 },
    );
  });

  it("PROPERTY: the ranking does not depend on the order the candidates arrive in", () => {
    // The output order comes from `.sort()`, so a comparator that is not a total
    // order lets INPUT order leak into which candidate wins. The existing
    // permutation property permuted only the verdict argument, never the
    // expected-candidate list.
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(...LENSES),
          fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 3, maxLength: 3 }),
          { minKeys: 3 },
        ),
        fc.shuffledSubarray(candidates, { minLength: 3, maxLength: 3 }),
        (scores, shuffled) => {
          if (LENSES.some((lens) => scores[lens] === undefined)) return true;
          const straight = aggregateVerdicts(verdictsFor(scores), CRITERIA, candidates);
          const permuted = aggregateVerdicts(verdictsFor(scores), CRITERIA, shuffled);
          if (!straight.ok || !permuted.ok) return false;
          return JSON.stringify(straight.value) === JSON.stringify(permuted.value);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("breaks an exact tie by filename, deterministically", () => {
    const tied = Object.fromEntries(LENSES.map((lens) => [lens, [5, 5, 5]]));
    const ranked = aggregateVerdicts(verdictsFor(tied), CRITERIA, candidates);
    expect(ranked.ok).toBe(true);
    if (ranked.ok) {
      expect(ranked.value.map((entry) => entry.candidate)).toEqual([...candidates].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// A20 — the tally under panel sizes other than three
// ---------------------------------------------------------------------------

describe("tallyRefutations across panel sizes", () => {
  const finding = (n: number): BriefFinding => ({
    id: `T1:code-reviewer-${n}` as WaveFindingId,
    taskId: "T1",
    agent: "code-reviewer",
    severity: "critical",
    file: null,
    line: null,
    claim: `claim ${n}`,
  });

  const envelope = (lens: ReviewLens, verdicts: readonly ("refuted" | "upheld")[], findings: readonly BriefFinding[]) => ({
    criterion: lens,
    entries: findings.map((f, i) => ({
      findingId: f.id,
      verdict: verdicts[i]!,
      reasoning: "r",
    })),
  });

  it("PROPERTY: a finding dies exactly when refutations reach the threshold", () => {
    // Generated over panel size paired with its own strict-majority floor — the
    // interaction the shrunken-panel comments describe at length, and which was
    // only ever example-tested at three lenses.
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }),
        (panelSize, rawVotes) => {
          const lenses = REVIEW_LENSES.slice(0, panelSize) as readonly ReviewLens[];
          const votes = rawVotes.slice(0, panelSize);
          while (votes.length < panelSize) votes.push(false);
          const threshold = defaultRefutationThreshold(panelSize);
          const findings = [finding(1)];
          const verdicts = lenses.map((lens, i) =>
            envelope(lens, [votes[i] ? "refuted" : "upheld"], findings),
          );
          const tallied = tallyRefutations(verdicts as never, lenses, findings, threshold);
          if (!tallied.ok) return false;
          const refutations = votes.filter(Boolean).length;
          return tallied.value[0]!.survives === (refutations < threshold);
        },
      ),
      { numRuns: 80 },
    );
  });

  it("PROPERTY: the verdict ARRAY order does not change the outcome", () => {
    // The architecture side has this property; the review side did not.
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
        (votes) => {
          const lenses = REVIEW_LENSES.slice(0, 3) as readonly ReviewLens[];
          const findings = [finding(1)];
          const verdicts = lenses.map((lens, i) =>
            envelope(lens, [votes[i] ? "refuted" : "upheld"], findings),
          );
          const straight = tallyRefutations(verdicts as never, lenses, findings, defaultRefutationThreshold(3));
          const reversed = tallyRefutations([...verdicts].reverse() as never, lenses, findings, defaultRefutationThreshold(3));
          if (!straight.ok || !reversed.ok) return false;
          return straight.value[0]!.survives === reversed.value[0]!.survives;
        },
      ),
      { numRuns: 40 },
    );
  });

  it("the default threshold is a strict majority at every supported size", () => {
    for (let size = 2; size <= REVIEW_LENSES.length; size++) {
      const threshold = defaultRefutationThreshold(size);
      expect(threshold * 2, `panel of ${size}`).toBeGreaterThan(size);
      expect(threshold).toBeLessThanOrEqual(size);
    }
  });

  it("selectReviewLenses returns nested prefixes, which is why the size is pinned", () => {
    // The reason `panelSizeConflict` exists: re-deriving the lens SET cannot
    // detect a truncated list, because a shorter panel reproduces its own
    // derivation exactly.
    const three = selectReviewLenses({ reproduction: false, security: false, testIntegrity: false } as never, 3);
    const four = selectReviewLenses({ reproduction: false, security: false, testIntegrity: false } as never, 4);
    expect(three.ok && four.ok).toBe(true);
    if (three.ok && four.ok) expect(four.value.slice(0, 3)).toEqual([...three.value]);
  });
});

// ---------------------------------------------------------------------------
// A2 / A18 — the run-directory shell, tested directly
// ---------------------------------------------------------------------------

describe("pruneSurplusItems — a re-brief owns its item directory", () => {
  const withRun = (name: string, body: (runDir: string, itemDir: string) => void) => {
    const runDir = join(tmpdir(), `prune-${name}-${process.pid}-${Date.now()}`);
    const itemDir = "findings";
    mkdirSync(join(runDir, itemDir), { recursive: true });
    try {
      body(runDir, itemDir);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  };

  it("removes the artifact a shrunken brief no longer names", () => {
    // The stale file used to survive and surface two steps later as `manifest`
    // failing with "the panel that produced them was larger than the manifest
    // declares" — a diagnostic describing the opposite of what happened.
    withRun("stale", (runDir, itemDir) => {
      writeFileSync(join(runDir, itemDir, "finding-T1-code-reviewer-1.json"), "{}");
      writeFileSync(join(runDir, itemDir, "finding-T1-code-reviewer-2.json"), "{}");
      const pruned = pruneSurplusItems(runDir, itemDir, ["finding-T1-code-reviewer-1.json"]);
      expect(pruned.ok).toBe(true);
      if (pruned.ok) expect(pruned.value).toEqual(["finding-T1-code-reviewer-2.json"]);
      expect(readdirSync(join(runDir, itemDir))).toEqual(["finding-T1-code-reviewer-1.json"]);
    });
  });

  it("keeps everything the brief still names", () => {
    withRun("keep", (runDir, itemDir) => {
      writeFileSync(join(runDir, itemDir, "a.json"), "{}");
      const pruned = pruneSurplusItems(runDir, itemDir, ["a.json"]);
      expect(pruned.ok).toBe(true);
      if (pruned.ok) expect(pruned.value).toEqual([]);
      expect(readdirSync(join(runDir, itemDir))).toEqual(["a.json"]);
    });
  });

  it("REFUSES to unlink a symlink rather than cleaning it up", () => {
    // This runs `rm` inside a directory derived from an argument. A symlink is a
    // reason to stop, not something to tidy.
    withRun("symlink", (runDir, itemDir) => {
      const target = join(runDir, "outside.json");
      writeFileSync(target, "{}");
      symlinkSync(target, join(runDir, itemDir, "linked.json"));
      const pruned = pruneSurplusItems(runDir, itemDir, []);
      expect(pruned.ok).toBe(false);
      if (!pruned.ok) expect(pruned.errors[0]).toContain("must not be a symbolic link");
    });
  });

  it("REFUSES a nested directory rather than recursing", () => {
    withRun("nested", (runDir, itemDir) => {
      mkdirSync(join(runDir, itemDir, "subdir"));
      const pruned = pruneSurplusItems(runDir, itemDir, []);
      expect(pruned.ok).toBe(false);
      if (!pruned.ok) expect(pruned.errors[0]).toContain("must be a regular file");
    });
  });

  it("REFUSES a symlinked item directory without deleting its outside sentinel", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-parent-symlink-"));
    const runDir = join(root, "run");
    const outside = join(root, "outside");
    mkdirSync(runDir);
    mkdirSync(outside);
    const sentinel = join(outside, "sentinel.json");
    writeFileSync(sentinel, "outside\n");
    symlinkSync(outside, join(runDir, "findings"));
    try {
      const pruned = pruneSurplusItems(runDir, "findings", []);
      expect(pruned.ok).toBe(false);
      expect(readFileSync(sentinel, "utf-8")).toBe("outside\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a first brief, with no item directory yet, is not an error", () => {
    const runDir = join(tmpdir(), `prune-fresh-${process.pid}-${Date.now()}`);
    mkdirSync(runDir, { recursive: true });
    try {
      const pruned = pruneSurplusItems(runDir, "findings", ["a.json"]);
      expect(pruned.ok).toBe(true);
      if (pruned.ok) expect(pruned.value).toEqual([]);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A18 — the containment check a per-file symlink test cannot reach
// ---------------------------------------------------------------------------

describe("artifactError refuses an artifact whose PARENT is the escape", () => {
  const withTree = (name: string, body: (root: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), `artifact-${name}-`));
    try {
      body(realpathSync(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("accepts a plain non-empty file inside the expected directory", () => {
    withTree("ok", (root) => {
      const dir = join(root, "candidates");
      mkdirSync(dir);
      const file = join(dir, "candidate-simplicity-first.md");
      writeFileSync(file, "content");
      expect(artifactError(file, dir)).toBeNull();
    });
  });

  it("refuses a file that is itself a symlink", () => {
    withTree("link", (root) => {
      const dir = join(root, "candidates");
      mkdirSync(dir);
      const outside = join(root, "outside.md");
      writeFileSync(outside, "content");
      const link = join(dir, "candidate-simplicity-first.md");
      symlinkSync(outside, link);
      expect(artifactError(link, dir)).toContain("must not be a symbolic link");
    });
  });

  it("refuses a real file reached through a symlinked PARENT directory", () => {
    // The only containment check a per-file symlink test cannot catch: the
    // artifact itself passes `lstat` as a plain regular file, and it is the
    // DIRECTORY component of the path that leaves the run. `realpathSync` on
    // the file is what closes it, and nothing reached this branch before.
    withTree("parent", (root) => {
      const real = join(root, "elsewhere");
      mkdirSync(real);
      writeFileSync(join(real, "candidate-simplicity-first.md"), "content");

      const runDir = join(root, "run.1");
      mkdirSync(runDir);
      const linkedDir = join(runDir, "candidates");
      symlinkSync(real, linkedDir);

      const viaLink = join(linkedDir, "candidate-simplicity-first.md");
      // lstat on the FILE says "plain regular file" — the escape is one level up.
      expect(lstatSync(viaLink).isSymbolicLink()).toBe(false);
      expect(artifactError(viaLink, linkedDir)).toContain("resolves outside its run-scoped directory");
    });
  });

  it("refuses an empty file — a candidate an agent never wrote", () => {
    withTree("empty", (root) => {
      const dir = join(root, "candidates");
      mkdirSync(dir);
      const file = join(dir, "candidate-simplicity-first.md");
      writeFileSync(file, "");
      expect(artifactError(file, dir)).toContain("non-empty regular file");
    });
  });

  it("refuses an absent artifact by name rather than treating it as clean", () => {
    withTree("absent", (root) => {
      expect(artifactError(join(root, "nope.md"), root)).toContain("cannot verify artifact");
    });
  });
});

// ---------------------------------------------------------------------------
// A15 — the long-project-path branch of the transcript resolver
// ---------------------------------------------------------------------------

describe("deriveAgentTranscriptPath over a project path past the slug cap", () => {
  const SLUG_MAX = 200;
  let configDir: string;
  let projectDir: string;
  let longCwd: string;
  const saved = { config: process.env.CLAUDE_CONFIG_DIR, project: process.env.CLAUDE_PROJECT_DIR };

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "slug-config-"));
    // A project path whose slug exceeds the cap, so the harness truncates it and
    // appends a disambiguating hash — the branch the resolver has to scan for.
    longCwd = join(tmpdir(), `slug-${"x".repeat(SLUG_MAX)}`, "deep", "project");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.CLAUDE_PROJECT_DIR = longCwd;
    const slug = longCwd.replace(/[^a-zA-Z0-9]/g, "-");
    // Named exactly as the harness would: the first SLUG_MAX chars, a dash, a hash.
    projectDir = join(configDir, "projects", `${slug.slice(0, SLUG_MAX)}-a1b2c3`);
    mkdirSync(join(projectDir, "sess-1", "subagents"), { recursive: true });
  });

  afterEach(() => {
    if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved.config;
    if (saved.project === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = saved.project;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("finds the transcript in the hash-suffixed sibling the prefix scan locates", () => {
    const path = join(projectDir, "sess-1", "subagents", "agent-sub-1.jsonl");
    writeFileSync(path, "{}");
    expect(deriveAgentTranscriptPath("sess-1", "sub-1")).toBe(path);
  });

  it("returns null rather than guessing when no sibling holds the transcript", () => {
    expect(deriveAgentTranscriptPath("sess-1", "sub-1")).toBeNull();
  });

  it("returns null when the projects root does not exist at all", () => {
    // The `readdirSync` catch arm: unreadable root is "nothing found", not a throw.
    process.env.CLAUDE_CONFIG_DIR = join(configDir, "does-not-exist");
    expect(() => deriveAgentTranscriptPath("sess-1", "sub-1")).not.toThrow();
    expect(deriveAgentTranscriptPath("sess-1", "sub-1")).toBeNull();
  });

  it("still refuses a traversing session or agent id, long path or not", () => {
    expect(deriveAgentTranscriptPath("../escape", "sub-1")).toBeNull();
    expect(deriveAgentTranscriptPath("sess-1", "../escape")).toBeNull();
  });
});
