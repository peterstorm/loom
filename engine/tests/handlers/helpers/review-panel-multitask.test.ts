/**
 * The review panel driven end to end over a wave with MORE THAN ONE TASK.
 *
 * The existing CLI suite uses a single-task fixture and reads `tasks[0]`
 * everywhere, so the behaviours that only exist because a wave has several tasks
 * were unit-tested and never driven through the real chain:
 *
 *   - `WaveFindingId` exists specifically so two tasks can each hold a
 *     `code-reviewer-1` without becoming one item. That collision is the NORMAL
 *     case in a wave, and nothing ran it through brief → manifest → verdict →
 *     tally.
 *   - `applyFindingOutcomes` routes each outcome to its own task and must leave
 *     the siblings untouched.
 *   - The case that decides the gate: task A's criticals are all refuted, so A
 *     is promoted to `passed`, while task B's survive — and the WAVE must stay
 *     blocked.
 *   - `briefCompletenessErrors`' per-task rule, exercised where the stale-wave
 *     and completeness guards actually run rather than in isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "cli.ts");

// The whole point: the LOCAL ids collide, the wave-scoped ones do not.
const T1_F1 = "T1:code-reviewer-1";
const T2_F1 = "T2:code-reviewer-1";
const T2_F2 = "T2:silent-failure-hunter-1";

const critical = (id: string, agent: string, file: string, claim: string) => ({
  id, agent, severity: "critical", file, line: 7, claim,
});

function taskGraph() {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    wave_gates: { "1": { impl_complete: true, tests_passed: true, reviews_complete: false, blocked: true } },
    tasks: [
      {
        id: "T1", description: "d", agent: "code-implementer-agent", wave: 1,
        status: "implemented", depends_on: [], review_status: "blocked",
        findings: [critical("code-reviewer-1", "code-reviewer", "src/auth/token.ts", "T1 unchecked cast")],
        critical_findings: ["T1 unchecked cast"],
        advisory_findings: [],
      },
      {
        id: "T2", description: "d", agent: "code-implementer-agent", wave: 1,
        status: "implemented", depends_on: [], review_status: "blocked",
        findings: [
          // Same LOCAL id as T1's finding — legal, and the reason ids are
          // wave-scoped before they reach a verifier.
          critical("code-reviewer-1", "code-reviewer", "src/b.ts", "T2 unchecked cast"),
          critical("silent-failure-hunter-1", "silent-failure-hunter", "src/c.ts", "T2 swallowed error"),
        ],
        critical_findings: ["T2 unchecked cast", "T2 swallowed error"],
        advisory_findings: [],
      },
      // A wave-2 task, so "the brief is scoped to the wave" is not vacuous.
      {
        id: "T9", description: "d", agent: "code-implementer-agent", wave: 2,
        status: "pending", depends_on: [], review_status: "pending",
        findings: [critical("code-reviewer-1", "code-reviewer", "src/z.ts", "a later wave's blocker")],
        critical_findings: ["a later wave's blocker"],
        advisory_findings: [],
      },
    ],
  };
}

describe("review panel over a multi-task wave", () => {
  let tmp: string;
  let runDir: string;
  let statePath: string;

  const REL_ROOT = "panel-runs";
  const REL_RUN = join("panel-runs", "run.1234567890");
  const REL_MANIFEST = join(REL_RUN, "manifest.json");

  function run(args: readonly string[], input = "") {
    return spawnSync("bun", [CLI, "helper", "review-panel", ...args], {
      cwd: tmp,
      input,
      encoding: "utf-8",
      env: { ...process.env, LOOM_STATE_PATH: ".claude/state/active_task_graph.json" },
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loom-review-panel-multi-"));
    runDir = join(tmp, REL_RUN);
    statePath = join(tmp, ".claude", "state", "active_task_graph.json");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(taskGraph(), null, 2));
  });

  afterEach(() => {
    chmodSync(statePath, 0o644);
    rmSync(tmp, { recursive: true, force: true });
  });

  const state = () => JSON.parse(readFileSync(statePath, "utf-8"));
  const taskById = (id: string) =>
    state().tasks.find((t: { id: string }) => t.id === id);

  function stage() {
    const brief = run(["brief", "--runs-root", REL_ROOT, "--run-dir", REL_RUN, "--wave", "1"]);
    expect(brief.status, brief.stderr).toBe(0);
    const manifest = run(["manifest", "--runs-root", REL_ROOT, "--run-dir", REL_RUN]);
    expect(manifest.status, manifest.stderr).toBe(0);
    return JSON.parse(brief.stdout);
  }

  /** Vote on every brief finding, per lens, through the real verdict contract. */
  function writeVerdicts(votes: Record<string, readonly ("refuted" | "upheld")[]>) {
    const lenses = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf-8")).lenses as string[];
    const ids = Object.keys(votes);
    lenses.forEach((lens, index) => {
      const payload = JSON.stringify({
        criterion: lens,
        verdicts: ids.map((id) => ({
          finding_id: id,
          verdict: votes[id]![index],
          reasoning: `${lens} on ${id}`,
        })),
      });
      const result = run(["verdict", "--lens", lens, "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST], payload);
      expect(result.status, result.stderr).toBe(0);
      writeFileSync(join(runDir, "verdicts", `verdict-${index + 1}.json`), result.stdout);
    });
  }

  const tally = () => run(["tally", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST]);

  it("briefs every task in the wave, and only that wave", () => {
    const brief = stage();
    expect(brief.findings.map((f: { id: string }) => f.id)).toEqual([T1_F1, T2_F1, T2_F2]);
    // Two DISTINCT items despite the identical local id — the collision the
    // wave scope exists to keep apart.
    expect(brief.findings[0].task_id).toBe("T1");
    expect(brief.findings[1].task_id).toBe("T2");
    expect(brief.task_ids, "the brief names every task it covers").toEqual(["T1", "T2"]);
    expect(JSON.stringify(brief)).not.toContain("a later wave's blocker");
  });

  it("writes one run-scoped artifact per finding, colliding local ids and all", () => {
    stage();
    expect(readFileSync(join(runDir, "findings", "finding-T1-code-reviewer-1.json"), "utf-8"))
      .toContain("T1 unchecked cast");
    expect(readFileSync(join(runDir, "findings", "finding-T2-code-reviewer-1.json"), "utf-8"))
      .toContain("T2 unchecked cast");
  });

  it("ONE task clearing does not open a wave another task still blocks", () => {
    stage();
    writeVerdicts({
      [T1_F1]: ["refuted", "refuted", "refuted"],
      [T2_F1]: ["upheld", "upheld", "upheld"],
      [T2_F2]: ["refuted", "upheld", "upheld"],
    });
    const result = tally();
    expect(result.status, result.stderr).toBe(0);

    expect(taskById("T1").review_status, "every T1 critical was refuted").toBe("passed");
    expect(taskById("T1").critical_findings).toEqual([]);
    expect(taskById("T2").review_status, "T2's criticals survived").toBe("blocked");
    expect(taskById("T2").critical_findings).toEqual(["T2 unchecked cast", "T2 swallowed error"]);
  });

  it("routes each outcome to its OWN task — the sibling's record is untouched", () => {
    stage();
    writeVerdicts({
      [T1_F1]: ["upheld", "upheld", "upheld"],
      [T2_F1]: ["refuted", "refuted", "refuted"],
      [T2_F2]: ["upheld", "upheld", "upheld"],
    });
    expect(tally().status).toBe(0);

    expect(taskById("T1").critical_findings, "T1 untouched").toEqual(["T1 unchecked cast"]);
    expect(taskById("T1").refuted_findings ?? []).toHaveLength(0);
    expect(taskById("T2").critical_findings).toEqual(["T2 swallowed error"]);
    expect(taskById("T2").refuted_findings).toHaveLength(1);
    // Attribution survives the wave-scoped round trip: the record stores the
    // TASK-LOCAL id, which is what `refutedIdsOf` re-scopes on the way back.
    expect(taskById("T2").refuted_findings[0].finding.id).toBe("code-reviewer-1");
    expect(taskById("T2").refuted_findings[0].finding.claim).toBe("T2 unchecked cast");
  });

  it("leaves the next wave's task completely alone", () => {
    stage();
    writeVerdicts({
      [T1_F1]: ["refuted", "refuted", "refuted"],
      [T2_F1]: ["refuted", "refuted", "refuted"],
      [T2_F2]: ["refuted", "refuted", "refuted"],
    });
    expect(tally().status).toBe(0);
    expect(taskById("T9").review_status).toBe("pending");
    expect(taskById("T9").critical_findings).toEqual(["a later wave's blocker"]);
  });

  it("refuses a verifier that covered only one task's findings", () => {
    // The per-task completeness rule, driven where it actually runs: a verifier
    // that votes on T2 and forgets T1 is a partial panel, not a lenient one.
    stage();
    const payload = JSON.stringify({
      criterion: "reproduction",
      verdicts: [
        { finding_id: T2_F1, verdict: "refuted", reasoning: "x" },
        { finding_id: T2_F2, verdict: "refuted", reasoning: "y" },
      ],
    });
    const result = run(["verdict", "--lens", "reproduction", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST], payload);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is missing finding");
    expect(result.stderr).toContain(T1_F1);
  });

  it("refuses a brief for a wave the graph has closed", () => {
    const closed = taskGraph();
    closed.current_wave = 2;
    writeFileSync(statePath, JSON.stringify(closed, null, 2));
    const result = run(["brief", "--runs-root", REL_ROOT, "--run-dir", REL_RUN, "--wave", "1"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not the graph's current wave");
  });

  it("refuses a brief when the graph records NO current wave — fails closed", () => {
    const unpopulated: Record<string, unknown> = taskGraph();
    delete unpopulated.current_wave;
    writeFileSync(statePath, JSON.stringify(unpopulated, null, 2));
    const result = run(["brief", "--runs-root", REL_ROOT, "--run-dir", REL_RUN, "--wave", "1"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("records no current wave");
  });

  it("a re-brief after a refutation clears the departed finding's artifact", () => {
    // Left behind, the stale file surfaced two steps later as `manifest` failing
    // with "the panel that produced them was larger than the manifest declares"
    // — a diagnostic about a resized panel that never happened.
    stage();
    writeVerdicts({
      [T1_F1]: ["refuted", "refuted", "refuted"],
      [T2_F1]: ["upheld", "upheld", "upheld"],
      [T2_F2]: ["upheld", "upheld", "upheld"],
    });
    expect(tally().status).toBe(0);

    const rebrief = run(["brief", "--runs-root", REL_ROOT, "--run-dir", REL_RUN, "--wave", "1"]);
    expect(rebrief.status, rebrief.stderr).toBe(0);
    expect(JSON.parse(rebrief.stdout).findings.map((f: { id: string }) => f.id)).toEqual([T2_F1, T2_F2]);

    const remanifest = run(["manifest", "--runs-root", REL_ROOT, "--run-dir", REL_RUN]);
    expect(remanifest.status, remanifest.stderr).toBe(0);
  });

  it("refuses a SECOND tally even when the new verdicts refute a different finding", () => {
    // The partial-guard walk-past: tally 1 refutes T1's finding; the operator
    // rewrites the verdicts so that one is upheld and T2's are refuted instead.
    // The two refutation sets are disjoint, so the old `!survives` filter saw
    // nothing and re-adjudicated against a brief the graph had moved past.
    stage();
    writeVerdicts({
      [T1_F1]: ["refuted", "refuted", "refuted"],
      [T2_F1]: ["upheld", "upheld", "upheld"],
      [T2_F2]: ["upheld", "upheld", "upheld"],
    });
    expect(tally().status).toBe(0);
    expect(taskById("T1").review_status).toBe("passed");

    const rewrittenVerdict = run(
      ["verdict", "--lens", "reproduction", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST],
      JSON.stringify({
        criterion: "reproduction",
        verdicts: [
          { finding_id: T1_F1, verdict: "upheld", reasoning: "changed" },
          { finding_id: T2_F1, verdict: "refuted", reasoning: "changed" },
          { finding_id: T2_F2, verdict: "refuted", reasoning: "changed" },
        ],
      }),
    );
    expect(rewrittenVerdict.status).toBe(1);
    expect(rewrittenVerdict.stderr).toContain("already been tallied");
    const second = tally();
    expect(second.status, "the replay guard must fire").toBe(1);
    expect(second.stderr).toContain("already been tallied");
    expect(taskById("T2").review_status, "T2 was never re-adjudicated").toBe("blocked");
  });
});
