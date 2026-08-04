import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "cli.ts");

const F1 = "T1:code-reviewer-1";
const F2 = "T1:silent-failure-hunter-1";

/** A wave-1 task graph with two criticals — one on a sensitive path, so the
 *  `security` lens is signal-selected and the default panel is three lenses. */
function taskGraph() {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    wave_gates: { "1": { impl_complete: true, tests_passed: true, reviews_complete: false, blocked: true } },
    tasks: [{
      id: "T1",
      description: "d",
      agent: "code-implementer-agent",
      wave: 1,
      status: "implemented",
      depends_on: [],
      review_status: "blocked",
      findings: [
        { id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", file: "src/auth/token.ts", line: 42, claim: "unchecked cast in the token reducer" },
        { id: "code-reviewer-2", agent: "code-reviewer", severity: "advisory", file: null, line: null, claim: "prefer a named constant" },
        { id: "silent-failure-hunter-1", agent: "silent-failure-hunter", severity: "critical", file: "src/x.ts", line: 7, claim: "catch block swallows the error" },
      ],
      critical_findings: ["unchecked cast in the token reducer", "catch block swallows the error"],
      advisory_findings: ["prefer a named constant"],
    }],
  };
}

describe("review-panel helper CLI", () => {
  let tmp: string;
  let runsRoot: string;
  let runDir: string;
  let statePath: string;
  let manifestPath: string;

  function run(args: readonly string[], input = "") {
    return spawnSync("bun", [CLI, "helper", "review-panel", ...args], {
      cwd: tmp,
      input,
      encoding: "utf-8",
      env: { ...process.env, LOOM_STATE_PATH: ".claude/state/active_task_graph.json" },
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loom-review-panel-"));
    runsRoot = join(tmp, "panel-runs");
    runDir = join(runsRoot, "run.1234567890");
    statePath = join(tmp, ".claude", "state", "active_task_graph.json");
    manifestPath = join(runDir, "manifest.json");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(taskGraph(), null, 2));
  });

  afterEach(() => {
    chmodSync(statePath, 0o644);
    rmSync(tmp, { recursive: true, force: true });
  });

  const REL_ROOT = "panel-runs";
  const REL_RUN = join("panel-runs", "run.1234567890");
  const REL_MANIFEST = join(REL_RUN, "manifest.json");

  const buildBrief = () => run(["brief", "--runs-root", REL_ROOT, "--run-dir", REL_RUN, "--wave", "1"]);
  const buildManifest = () => run(["manifest", "--runs-root", REL_ROOT, "--run-dir", REL_RUN]);

  /** Set up brief + manifest, the precondition for every later operation. */
  function stage() {
    expect(buildBrief().status).toBe(0);
    expect(buildManifest().status).toBe(0);
  }

  const verdictJson = (lens: string, v1: string, v2: string) => JSON.stringify({
    criterion: lens,
    verdicts: [
      { finding_id: F1, verdict: v1, reasoning: `${lens} on F1` },
      { finding_id: F2, verdict: v2, reasoning: `${lens} on F2` },
    ],
  });

  /** Validate each lens's raw output into its canonical verdict slot. */
  function writeVerdicts(votes: readonly (readonly [string, string])[]) {
    const lenses = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf-8")).lenses as string[];
    lenses.forEach((lens, index) => {
      const result = run(
        ["verdict", "--lens", lens, "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST],
        verdictJson(lens, votes[index]![0], votes[index]![1]),
      );
      expect(result.status, result.stderr).toBe(0);
      writeFileSync(join(runDir, "verdicts", `verdict-${index + 1}.json`), result.stdout);
    });
  }

  describe("brief", () => {
    it("writes engine-authored artifacts for the wave's critical findings", () => {
      const result = buildBrief();
      expect(result.status, result.stderr).toBe(0);
      const brief = JSON.parse(result.stdout);
      expect(brief.severity).toBe("critical");
      expect(brief.findings.map((f: { id: string }) => f.id)).toEqual([F1, F2]);
      // Advisories skip the panel entirely.
      expect(JSON.stringify(brief)).not.toContain("prefer a named constant");
      expect(readFileSync(join(runDir, "brief.md"), "utf-8")).toContain(F1);
      expect(readFileSync(join(runDir, "findings", "finding-T1-code-reviewer-1.json"), "utf-8"))
        .toContain("unchecked cast");
    });

    it("rejects a run directory outside the runs root", () => {
      const result = run(["brief", "--runs-root", REL_ROOT, "--run-dir", ".claude", "--wave", "1"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("run directory must be directly inside --runs-root");
    });

    it("rejects a runs root outside the working directory", () => {
      const result = run(["brief", "--runs-root", "/tmp", "--run-dir", REL_RUN, "--wave", "1"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must be inside the current working directory");
    });

    it("rejects a symlinked run directory", () => {
      const real = join(tmp, "elsewhere");
      mkdirSync(real);
      symlinkSync(real, join(runsRoot, "run.symlinked"));
      const result = run(["brief", "--runs-root", REL_ROOT, "--run-dir", join(REL_ROOT, "run.symlinked"), "--wave", "1"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must not be a symbolic link");
    });

    it("requires a wave", () => {
      expect(run(["brief", "--runs-root", REL_ROOT, "--run-dir", REL_RUN]).stderr)
        .toContain("Usage: helper review-panel");
    });
  });

  describe("manifest and lenses", () => {
    it("fixes the finding set and derives the lenses from the brief", () => {
      stage();
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(manifest.lenses).toEqual(["reproduction", "intent", "security"]);
      expect(manifest.findings.map((f: { id: string }) => f.id)).toEqual([F1, F2]);

      const lenses = run(["lenses", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST]);
      expect(lenses.status).toBe(0);
      expect(JSON.parse(lenses.stdout)).toEqual(["reproduction", "intent", "security"]);
    });

    it("falls back to the default trio when no signal fires", () => {
      const plain = taskGraph();
      plain.tasks[0]!.findings = [
        { id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", file: "src/render.ts", line: 1, claim: "off-by-one" },
      ];
      plain.tasks[0]!.critical_findings = ["off-by-one"];
      // The views are derived, and the load boundary now proves it — dropping
      // the advisory finding without dropping its view is a corrupt graph.
      plain.tasks[0]!.advisory_findings = [];
      writeFileSync(statePath, JSON.stringify(plain));
      stage();
      expect(JSON.parse(readFileSync(manifestPath, "utf-8")).lenses)
        .toEqual(["reproduction", "intent", "blast-radius"]);
    });

    it("honours an explicit --lenses count", () => {
      expect(buildBrief().status).toBe(0);
      expect(run(["manifest", "--runs-root", REL_ROOT, "--run-dir", REL_RUN, "--lenses", "2"]).status).toBe(0);
      expect(JSON.parse(readFileSync(manifestPath, "utf-8")).lenses).toEqual(["reproduction", "intent"]);
    });

    it("rejects a lens count outside the viable range", () => {
      expect(buildBrief().status).toBe(0);
      const result = run(["manifest", "--runs-root", REL_ROOT, "--run-dir", REL_RUN, "--lenses", "9"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("review lens selection contract failed");
    });

    it("rejects a tampered manifest that drops a finding", () => {
      stage();
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      manifest.findings.pop();
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = run(["lenses", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("review manifest contract failed");
    });

    it("rejects a manifest that is not named manifest.json", () => {
      stage();
      const other = join(REL_RUN, "not-manifest.json");
      writeFileSync(join(tmp, other), readFileSync(manifestPath, "utf-8"));
      const result = run(["lenses", "--runs-root", REL_ROOT, "--manifest", other]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("manifest filename must be exactly manifest.json");
    });

    it("rejects a run whose finding artifact was deleted", () => {
      stage();
      rmSync(join(runDir, "findings", "finding-T1-code-reviewer-1.json"));
      const result = run(["lenses", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("review artifacts contract failed");
    });
  });

  describe("verdict", () => {
    beforeEach(stage);

    it("canonicalizes a well-formed verifier output", () => {
      const result = run(
        ["verdict", "--lens", "reproduction", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST],
        verdictJson("reproduction", "refuted", "upheld"),
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        criterion: "reproduction",
        verdicts: [
          { finding_id: F1, verdict: "refuted", reasoning: "reproduction on F1" },
          { finding_id: F2, verdict: "upheld", reasoning: "reproduction on F2" },
        ],
      });
    });

    it("rejects a lens outside the selected set", () => {
      const result = run(
        ["verdict", "--lens", "blast-radius", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST],
        verdictJson("blast-radius", "refuted", "upheld"),
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must be one of the selected lenses");
    });

    it("rejects a verifier that skipped a finding", () => {
      const result = run(
        ["verdict", "--lens", "intent", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST],
        JSON.stringify({ criterion: "intent", verdicts: [{ finding_id: F1, verdict: "refuted", reasoning: "x" }] }),
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("is missing finding");
    });

    it("rejects a verifier that invented a finding", () => {
      const result = run(
        ["verdict", "--lens", "intent", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST],
        JSON.stringify({
          criterion: "intent",
          verdicts: [
            { finding_id: F1, verdict: "refuted", reasoning: "x" },
            { finding_id: "T1:invented-1", verdict: "refuted", reasoning: "y" },
          ],
        }),
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("has unknown finding");
    });

    it("strips braces from reasoning before it reaches a prompt or state", () => {
      const result = run(
        ["verdict", "--lens", "reproduction", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST],
        JSON.stringify({
          criterion: "reproduction",
          verdicts: [
            { finding_id: F1, verdict: "refuted", reasoning: "the {guard} excludes it" },
            { finding_id: F2, verdict: "upheld", reasoning: "reachable" },
          ],
        }),
      );
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("{guard}");
      expect(result.stdout).toContain("the guard excludes it");
    });
  });

  describe("tally", () => {
    beforeEach(stage);

    const tally = (extra: readonly string[] = []) =>
      run(["tally", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST, ...extra]);

    const stateTask = () => JSON.parse(readFileSync(statePath, "utf-8")).tasks[0];

    it("kills a majority-refuted finding and records why", () => {
      writeVerdicts([["refuted", "upheld"], ["refuted", "upheld"], ["uncertain", "upheld"]]);
      const result = tally();
      expect(result.status, result.stderr).toBe(0);
      const outcomes = JSON.parse(result.stdout);
      expect(outcomes).toMatchObject({ threshold: 2, surviving: 1, refuted: 1 });

      const task = stateTask();
      expect(task.critical_findings).toEqual(["catch block swallows the error"]);
      expect(task.findings.map((f: { id: string }) => f.id)).toEqual(["code-reviewer-2", "silent-failure-hunter-1"]);
      expect(task.refuted_findings).toHaveLength(1);
      expect(task.refuted_findings[0].refutations.map((r: { lens: string }) => r.lens))
        .toEqual(["reproduction", "intent"]);
      expect(task.refuted_findings[0].refutations.every((r: { reason: string }) => r.reason.length > 0)).toBe(true);
      // One critical survives, so the block stands.
      expect(task.review_status).toBe("blocked");
    });

    it("keeps a finding the panel could not agree on — ties favor the finding", () => {
      writeVerdicts([["refuted", "upheld"], ["upheld", "upheld"], ["uncertain", "upheld"]]);
      expect(tally().status).toBe(0);
      const task = stateTask();
      expect(task.critical_findings).toHaveLength(2);
      expect(task.refuted_findings ?? []).toHaveLength(0);
    });

    it("passes the task when every critical is refuted", () => {
      writeVerdicts([["refuted", "refuted"], ["refuted", "refuted"], ["upheld", "upheld"]]);
      expect(tally().status).toBe(0);
      const task = stateTask();
      expect(task.critical_findings).toEqual([]);
      expect(task.review_status).toBe("passed");
      expect(task.refuted_findings).toHaveLength(2);
      // The advisory is untouched: advisories never enter the panel.
      expect(task.advisory_findings).toEqual(["prefer a named constant"]);
    });

    it("honours a --threshold that RAISES the bar", () => {
      // Two of three refute F1, which the default (strict majority of 3 = 2)
      // would kill. Demanding unanimity keeps it.
      writeVerdicts([["refuted", "upheld"], ["refuted", "upheld"], ["upheld", "upheld"]]);
      expect(tally(["--threshold", "3"]).status).toBe(0);
      expect(stateTask().critical_findings).toEqual([
        "unchecked cast in the token reducer",
        "catch block swallows the error",
      ]);
    });

    it("refuses a --threshold below the strict-majority floor", () => {
      // `--threshold 1` let a single lens kill a critical on its own, inverting
      // the documented "ties favour keeping the finding" rule — and the runbook
      // never mentions the flag, so nothing gated an orchestrator that improvised
      // it. Raising the bar is safe; lowering it is a weaker panel under the
      // same name.
      writeVerdicts([["refuted", "upheld"], ["upheld", "upheld"], ["upheld", "upheld"]]);
      const result = tally(["--threshold", "1"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("below the strict majority of 3 lenses (2)");
      // State is untouched — the weaker panel adjudicated nothing.
      expect(stateTask().critical_findings).toHaveLength(2);
    });

    it("fails when a verdict slot is missing", () => {
      writeVerdicts([["refuted", "upheld"], ["refuted", "upheld"], ["upheld", "upheld"]]);
      rmSync(join(runDir, "verdicts", "verdict-3.json"));
      const result = tally();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("review verdicts contract failed");
      // State is untouched on failure — a partial panel adjudicates nothing.
      expect(stateTask().critical_findings).toHaveLength(2);
    });

    it("fails when a verdict lands in the wrong slot", () => {
      writeVerdicts([["refuted", "upheld"], ["refuted", "upheld"], ["upheld", "upheld"]]);
      const slot1 = readFileSync(join(runDir, "verdicts", "verdict-1.json"), "utf-8");
      writeFileSync(join(runDir, "verdicts", "verdict-2.json"), slot1);
      const result = tally();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("criterion must equal");
    });

    it("re-validates verdicts from disk rather than trusting the verdict step", () => {
      writeVerdicts([["refuted", "upheld"], ["refuted", "upheld"], ["upheld", "upheld"]]);
      writeFileSync(
        join(runDir, "verdicts", "verdict-1.json"),
        JSON.stringify({ criterion: "reproduction", verdicts: [{ finding_id: F1, verdict: "refuted", reasoning: "x" }] }),
      );
      const result = tally();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("is missing finding");
    });
  });


  describe("brief refuses to build a set the panel cannot honestly adjudicate", () => {
    const writeState = (mutate: (graph: ReturnType<typeof taskGraph>) => void) => {
      const graph = taskGraph();
      mutate(graph);
      writeFileSync(statePath, JSON.stringify(graph, null, 2));
    };

    it("rejects a --wave that is not the graph's current wave", () => {
      // A typo'd --wave used to produce a fully green, fully EMPTY panel run:
      // three verifiers spawned, nothing adjudicated, and a tally printing
      // "0 survived, 0 refuted" — indistinguishable from a real unanimous panel.
      // The runbook asked the operator to compare --wave against .current_wave
      // with jq; the engine holds the graph and now proves it.
      const result = run(["brief", "--runs-root", REL_ROOT, "--run-dir", REL_RUN, "--wave", "99"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("is not the graph's current wave (1)");
    });

    it("rejects the current wave when it holds no tasks at all", () => {
      // The completeness postcondition, reached with the wave check satisfied:
      // a graph whose current_wave names a wave no task belongs to.
      writeState((graph) => {
        graph.current_wave = 99;
        graph.tasks[0]!.wave = 1;
      });
      const result = run(["brief", "--runs-root", REL_ROOT, "--run-dir", REL_RUN, "--wave", "99"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no tasks in wave 99");
    });

    it("rejects a wave with nothing of the verified severity, naming the skip", () => {
      writeState((graph) => {
        graph.tasks[0]!.findings = graph.tasks[0]!.findings.filter((f) => f.severity !== "critical");
        graph.tasks[0]!.critical_findings = [];
      });
      const result = buildBrief();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("skip the refutation panel");
    });

    it("rejects a task graph whose criticals never gained structured identity", () => {
      // Every graph written before findings had identity is in this shape, as
      // was every graph a pre-fix `--fix` repaired. The wave gate's skip
      // predicate reads critical_findings while the brief reads findings, so
      // the panel WOULD be run on exactly these waves.
      writeState((graph) => {
        delete (graph.tasks[0] as Record<string, unknown>).findings;
      });
      const result = buildBrief();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("carry structured identity");
      expect(result.stderr, "the diagnostic names a repair").toContain("validate-task-graph --fix");
    });

    it("rejects a graph whose findings undercount the view the gate counts", () => {
      // Caught one step earlier than it used to be: `findingsLockstepError` at
      // the load boundary refuses the graph outright, so a drifted view never
      // reaches brief construction at all. The completeness guard remains as
      // the backstop for the one drift the load boundary cannot see — a
      // pre-identity task, covered by the test above.
      writeState((graph) => {
        graph.tasks[0]!.findings = graph.tasks[0]!.findings.filter((f) => f.id !== "code-reviewer-1");
      });
      const result = buildBrief();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("critical_findings is not the derived view of findings");
      expect(result.stderr, "the diagnostic names a repair").toContain("validate-task-graph --fix");
    });
  });

  describe("the panel size survives the whole run without being re-passed", () => {
    it("recovers the lens count from the manifest for every later operation", () => {
      // `--lenses N` used to be consumed by all four manifest-scoped
      // operations, but only the `manifest` snippet in the runbook carried it —
      // so the very next step failed with "manifest.lenses must contain exactly
      // 3 lenses", blaming the manifest for the caller's omission.
      expect(buildBrief().status).toBe(0);
      expect(run(["manifest", "--runs-root", REL_ROOT, "--run-dir", REL_RUN, "--lenses", "5"]).status).toBe(0);

      const lenses = run(["lenses", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST]);
      expect(lenses.status, lenses.stderr).toBe(0);
      expect(JSON.parse(lenses.stdout)).toHaveLength(5);
    });

    it("still rejects a manifest whose lens set the brief does not reproduce", () => {
      // Taking the COUNT from the file must not mean trusting the file: the set
      // is re-derived from the brief's signals and compared name by name.
      expect(buildBrief().status).toBe(0);
      expect(buildManifest().status).toBe(0);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      manifest.lenses = ["reproduction", "intent", "test-coverage"];
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const result = run(["lenses", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must exactly match");
    });
  });

  describe("the panel size is fixed for the life of the run", () => {
    const buildManifestSized = (n: number) =>
      run(["manifest", "--runs-root", REL_ROOT, "--run-dir", REL_RUN, "--lenses", String(n)]);
    const lensesOf = () =>
      JSON.parse(readFileSync(manifestPath, "utf-8")).lenses as string[];

    it("does not shrink a recorded panel when manifest is re-run without --lenses", () => {
      // The bug this pins, verified end to end at exit 0 with nothing on
      // stderr: `manifest` was the one manifest-scoped operation that skipped
      // reading the existing file, so its count recovery never ran. A retry of
      // step 3.5.2 — or any re-run — silently rewrote a 5-lens panel to the
      // 3-lens default. readVerdicts then iterated only 3 lenses, verdict-4 and
      // verdict-5 (the two that UPHELD) were ignored, the absolute refutation
      // bar fell from 3 to 2, and the finding came out refuted. Re-deriving the
      // lens SET does not catch it: selectReviewLenses returns nested prefixes,
      // so a truncated list reproduces its own derivation exactly.
      expect(buildBrief().status).toBe(0);
      expect(buildManifestSized(5).status).toBe(0);
      expect(lensesOf()).toHaveLength(5);

      const rerun = buildManifest();
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(lensesOf(), "the recorded panel size survives a re-run").toHaveLength(5);
    });

    it("refuses a --lenses that disagrees with the recorded size", () => {
      expect(buildBrief().status).toBe(0);
      expect(buildManifestSized(5).status).toBe(0);
      const conflict = buildManifestSized(3);
      expect(conflict.status).toBe(1);
      expect(conflict.stderr).toContain("already fixed at 5 lens(es)");
      expect(lensesOf(), "the refused re-size wrote nothing").toHaveLength(5);
    });

    it("accepts a --lenses that restates the recorded size", () => {
      expect(buildBrief().status).toBe(0);
      expect(buildManifestSized(4).status).toBe(0);
      expect(buildManifestSized(4).status, "idempotent, not merely rejected").toBe(0);
      expect(lensesOf()).toHaveLength(4);
    });

    it("rejects a tally whose verdict directory holds more votes than the panel", () => {
      // The other half of the same failure. A surplus verdict-N.json is
      // positive evidence that the panel which actually RAN was larger than the
      // manifest now claims — which is what a hand-truncated `manifest.lenses`
      // leaves behind. Ignoring the extra files is what let a 5-lens run be
      // adjudicated as a 3-lens one under a lower absolute bar.
      stage();
      writeVerdicts([["upheld", "upheld"], ["upheld", "upheld"], ["upheld", "upheld"]]);
      writeFileSync(join(runDir, "verdicts", "verdict-4.json"), verdictJson("security", "upheld", "upheld"));

      const result = run(["tally", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("verdict-4.json");
      expect(result.stderr).toContain("larger than the criteria set names");
    });
  });

  it("closes an all-upheld run so changed verdicts cannot be re-tallied", () => {
    stage();
    writeVerdicts([["upheld", "upheld"], ["upheld", "upheld"], ["upheld", "upheld"]]);
    const first = run(["tally", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST]);
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(runDir, "outcomes.json"), "utf-8")).refuted).toBe(0);
    expect(readFileSync(join(runDir, "tally-closure.json"), "utf-8")).toContain(F1);

    // Rewrite every canonical slot to a majority-refuted result. The immutable
    // run closure, not task.refuted_findings, must reject this second decision.
    writeVerdicts([["refuted", "refuted"], ["refuted", "refuted"], ["upheld", "upheld"]]);
    const second = run(["tally", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST]);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("already been tallied");
    expect(second.stderr).toContain(F1);

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].critical_findings).toHaveLength(2);
    expect(state.tasks[0].refuted_findings ?? []).toHaveLength(0);
  });

  it("refuses to re-tally a run it has already adjudicated", () => {
    // A second tally sent applyFindingOutcomes looking for findings the first
    // one had already moved into refuted_findings, where the invariant throw
    // blamed "the task graph changed between brief and tally" — true of an
    // override landing mid-run, and wrong about the likelier cause. It also
    // escaped mgr.update uncaught rather than returning a contract error. A
    // broken pipe on the canonical output, after the state write has landed, is
    // enough to invite the re-run.
    stage();
    writeVerdicts([["refuted", "upheld"], ["refuted", "upheld"], ["refuted", "upheld"]]);
    const first = run(["tally", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST]);
    expect(first.status, first.stderr).toBe(0);

    const second = run(["tally", "--runs-root", REL_ROOT, "--manifest", REL_MANIFEST]);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("already been tallied");
    expect(second.stderr).toContain(F1);
    expect(second.stderr).not.toContain("changed between brief and tally");

    // And the first tally's decision is intact — the refusal wrote nothing.
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].refuted_findings).toHaveLength(1);
  });

  it("refuses to write a brief artifact through a symlink", () => {
    // The engine is the first panel author to WRITE into a run directory, and
    // a write follows a symlink as happily as a read does. artifactErrors runs
    // at the manifest step — by then the bytes have already landed.
    const escape = join(tmp, "escaped.md");
    writeFileSync(escape, "");
    symlinkSync(escape, join(runDir, "brief.md"));
    const result = buildBrief();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("write target must not be a symbolic link");
    expect(readFileSync(escape, "utf-8"), "nothing was written through the link").toBe("");
  });

  it("refuses a write target it cannot stat, rather than assuming it is absent", () => {
    // The blanket `catch {}` was labelled ENOENT but never inspected the code,
    // so EACCES on a parent component and ELOOP both read as "target absent,
    // safe to write" — defeating the symlink check this function exists to
    // perform. A directory with no execute bit makes lstat fail with EACCES.
    const sealed = join(runDir, "findings");
    mkdirSync(sealed, { recursive: true });
    chmodSync(sealed, 0o000);
    try {
      const result = buildBrief();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("cannot verify write target");
    } finally {
      chmodSync(sealed, 0o755);
    }
  });

  it("rejects an unknown operation", () => {
    expect(run(["adjudicate", "--runs-root", REL_ROOT]).stderr).toContain("Usage: helper review-panel");
  });
});
