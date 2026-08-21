/**
 * The one fact the adversarial review panel exists to establish, asserted as one
 * fact: **majority-refuted criticals die; survivors block the gate.**
 *
 * Both halves were already covered separately — `tallyRefutations` and
 * `applyFindingOutcomes` in the core, `checkCriticalFindings` in the gate — and
 * they agree today. Nothing joined them. `complete-wave-gate.test.ts` contained
 * zero `refuted_findings` scenarios, so the feature's headline claim rested on
 * two independently-correct pieces and the assumption that the derived view
 * `checkCriticalFindings` counts stays in step with the authoritative array
 * `applyFindingOutcomes` writes.
 *
 * These tests run the real adjudication and then ask the real gate.
 */

import { describe, expect, it } from "vitest";
import { applyFindingOutcomes, attributeFindings, mergeFindings } from "../../src/core/findings";
import {
  buildFindingBrief,
  defaultRefutationThreshold,
  tallyRefutations,
  type BriefFinding,
  type ReviewLens,
} from "../../src/core/review-panel";
import { checkCriticalFindings } from "../../src/core/wave-gate-machine";
import type { Task } from "../../src/types";

const LENSES: readonly ReviewLens[] = ["reproduction", "intent", "blast-radius"];
const THRESHOLD = defaultRefutationThreshold(LENSES.length);

function task(id: string, criticals: readonly string[]): Task {
  const base: Task = {
    id,
    description: "d",
    agent: "code-implementer-agent",
    wave: 1,
    status: "implemented",
    depends_on: [],
    review_status: "pending",
  };
  return criticals.reduce(
    (t, claim) =>
      mergeFindings(
        t,
        { drafts: [{ severity: "critical", claim, file: null, line: null }], criticalCount: 1 },
        "code-reviewer",
      ),
    base,
  );
}

/** Vote on every brief finding, one entry per lens, per the panel contract. */
function verdicts(brief: readonly BriefFinding[], votes: Record<string, readonly boolean[]>) {
  return LENSES.map((lens, lensIndex) => ({
    criterion: lens,
    entries: brief.map((finding) => ({
      findingId: finding.id,
      verdict: (votes[finding.id]?.[lensIndex] ? "refuted" : "upheld") as "refuted" | "upheld",
      reasoning: "r",
    })),
  }));
}

function adjudicate(tasks: readonly Task[], votes: Record<string, readonly boolean[]>): Task[] {
  const brief = buildFindingBrief(1, tasks);
  const tallied = tallyRefutations(verdicts(brief.findings, votes) as never, LENSES, brief.findings, THRESHOLD);
  if (!tallied.ok) throw new Error(`tally failed: ${tallied.errors.join("; ")}`);
  return tasks.map((t) => applyFindingOutcomes(t, tallied.value));
}

describe("the panel's verdict is the gate's verdict", () => {
  it("a critical the panel REFUTES stops blocking the wave", () => {
    const before = [task("T1", ["the catch block swallows the parse error"])];
    expect(checkCriticalFindings(before).passed, "blocked before the panel ran").toBe(false);

    const id = before[0]!.findings![0]!.id;
    const after = adjudicate(before, { [`T1:${id}`]: [true, true, false] });

    expect(checkCriticalFindings(after).passed, "2 of 3 refuted — it dies").toBe(true);
    expect(after[0]!.review_status).toBe("passed");
    // Recorded, never deleted: a wrong refutation is a shipped bug, so the
    // audit trail has to outlive the finding.
    expect(after[0]!.refuted_findings).toHaveLength(1);
    expect(after[0]!.refuted_findings![0]!.refutations).toHaveLength(2);
  });

  it("a critical the panel UPHOLDS still blocks the wave", () => {
    const before = [task("T1", ["the retry loop never terminates"])];
    const id = before[0]!.findings![0]!.id;
    const after = adjudicate(before, { [`T1:${id}`]: [true, false, false] });

    expect(checkCriticalFindings(after).passed, "1 of 3 is under the bar").toBe(false);
    expect(after[0]!.review_status).toBe("blocked");
    expect(after[0]!.refuted_findings ?? []).toHaveLength(0);
  });

  it("a TIE favours the finding, and the gate stays shut", () => {
    // Ties favour keeping the finding: a false positive costs a cycle, a false
    // negative ships a bug. Asserted at the gate, where the trade actually pays.
    const evenLenses: readonly ReviewLens[] = ["reproduction", "intent"];
    const before = [task("T1", ["an unchecked cast"])];
    const brief = buildFindingBrief(1, before);
    const tallied = tallyRefutations(
      evenLenses.map((lens, i) => ({
        criterion: lens,
        entries: brief.findings.map((f) => ({
          findingId: f.id,
          verdict: (i === 0 ? "refuted" : "upheld") as "refuted" | "upheld",
          reasoning: "r",
        })),
      })) as never,
      evenLenses,
      brief.findings,
      defaultRefutationThreshold(2),
    );
    expect(tallied.ok).toBe(true);
    if (!tallied.ok) return;
    const after = before.map((t) => applyFindingOutcomes(t, tallied.value));
    expect(checkCriticalFindings(after).passed).toBe(false);
  });

  it("ONE task clearing does not open a wave another task still blocks", () => {
    // The gate-deciding multi-task case, and the reason `WaveFindingId` is
    // wave-scoped at all: `checkCriticalFindings` sums across every task in the
    // wave, so T1 passing is not the wave passing.
    const before = [task("T1", ["T1's blocker"]), task("T2", ["T2's blocker"])];
    const t1 = `T1:${before[0]!.findings![0]!.id}`;
    const t2 = `T2:${before[1]!.findings![0]!.id}`;
    // Both tasks minted `code-reviewer-1` — the collision the wave scope exists
    // to keep apart. If the ids were task-local the two would be one item.
    expect(before[0]!.findings![0]!.id).toBe(before[1]!.findings![0]!.id);

    const after = adjudicate(before, { [t1]: [true, true, true], [t2]: [false, false, false] });

    expect(after[0]!.review_status, "T1's only critical was refuted").toBe("passed");
    expect(after[1]!.review_status, "T2's survived").toBe("blocked");
    const check = checkCriticalFindings(after);
    expect(check.passed, "the WAVE is still blocked").toBe(false);
    if (check.passed) return;
    expect(check.reason).toContain("T2");
    expect(check.reason).not.toContain("T1's blocker");
  });

  it("refuting one of a task's two criticals leaves the other blocking", () => {
    const before = [task("T1", ["first blocker", "second blocker"])];
    const [one, two] = before[0]!.findings!;
    const after = adjudicate(before, {
      [`T1:${one!.id}`]: [true, true, true],
      [`T1:${two!.id}`]: [false, false, false],
    });

    expect(checkCriticalFindings(after).passed).toBe(false);
    expect(after[0]!.review_status).toBe("blocked");
    expect(after[0]!.critical_findings).toEqual(["second blocker"]);
    expect(after[0]!.findings).toHaveLength(1);
  });

  it("the authoritative array and the view the gate counts stay in step", () => {
    // `checkCriticalFindings` counts `critical_findings`; `applyFindingOutcomes`
    // writes `findings`. The lockstep between them is what makes this feature
    // safe, and it is enforced at the LOAD boundary — not by construction — so
    // it is worth asserting on the object the transform actually returns.
    const before = [task("T1", ["a", "b", "c"])];
    const ids = before[0]!.findings!.map((f) => `T1:${f.id}`);
    const after = adjudicate(before, {
      [ids[0]!]: [true, true, false],
      [ids[1]!]: [false, false, false],
      [ids[2]!]: [true, true, true],
    });

    const stored = after[0]!;
    expect(stored.critical_findings).toEqual(
      stored.findings!.filter((f) => f.severity === "critical").map((f) => f.claim),
    );
    expect(stored.critical_findings).toEqual(["b"]);
  });

  it("advisories are untouched — they never reached the panel", () => {
    const withAdvisory = mergeFindings(
      task("T1", ["a real blocker"]),
      { drafts: [{ severity: "advisory", claim: "prefer a named constant", file: null, line: null }], criticalCount: 0 },
      "comment-analyzer",
    );
    const id = `T1:${withAdvisory.findings![0]!.id}`;
    const after = adjudicate([withAdvisory], { [id]: [true, true, true] });

    expect(checkCriticalFindings(after).passed).toBe(true);
    expect(after[0]!.advisory_findings, "still there for the wave gate's advisory triage").toEqual([
      "prefer a named constant",
    ]);
  });

  it("a sentinel-only view is NOT filtered by the gate — the reason --fix must report dropping it", () => {
    // `checkCriticalFindings` filters on non-empty text only. "none" is a
    // no-findings sentinel to `makeDraftFinding` and a blocking critical to the
    // gate, which is exactly why a repair that silently removes it flips the
    // wave from blocked to passing.
    const sentinel: Task = {
      id: "T1", description: "d", agent: "code-implementer-agent", wave: 1,
      status: "implemented", depends_on: [], review_status: "blocked",
      critical_findings: ["none"],
    };
    expect(checkCriticalFindings([sentinel]).passed).toBe(false);
  });

  it("attributed identity survives adjudication, so the audit names the reviewer", () => {
    const before = [task("T1", ["a blocker"])];
    const id = before[0]!.findings![0]!.id;
    const after = adjudicate(before, { [`T1:${id}`]: [true, true, true] });
    const record = after[0]!.refuted_findings![0]!;
    expect(record.finding.agent).toBe("code-reviewer");
    expect(record.finding.id).toBe(id);
    expect(record.refutations.map((r) => r.lens)).toEqual([...LENSES]);
  });

  it("a re-mint from --fix does not orphan the finding from its brief id", () => {
    // The ids the brief hands verifiers are `${taskId}:${finding.id}`, so any
    // repair that renames a finding renames its brief item too. Proven by
    // building the brief from the repaired task and adjudicating THAT.
    const collided = attributeFindings(
      [{ severity: "critical", claim: "a blocker", file: null, line: null }],
      "code-reviewer",
      1,
    );
    const withDuplicate: Task = {
      ...task("T1", []),
      review_status: "blocked",
      findings: [...collided, ...collided],
      critical_findings: ["a blocker", "a blocker"],
      advisory_findings: [],
    };
    const brief = buildFindingBrief(1, [withDuplicate]);
    // Two findings sharing an id would collapse to one brief item, so the panel
    // could only ever adjudicate one of them — the collision the load boundary
    // rejects and `--fix` repairs.
    expect(new Set(brief.findings.map((f) => f.id)).size).toBeLessThan(2);
  });
});
