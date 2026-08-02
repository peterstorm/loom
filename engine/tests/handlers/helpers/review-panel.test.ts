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
      expect(task.refuted_findings[0].refutedBy).toEqual(["reproduction", "intent"]);
      expect(task.refuted_findings[0].reasoning).toHaveLength(2);
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

    it("honours an explicit --threshold", () => {
      writeVerdicts([["refuted", "upheld"], ["upheld", "upheld"], ["upheld", "upheld"]]);
      expect(tally(["--threshold", "1"]).status).toBe(0);
      expect(stateTask().critical_findings).toEqual(["catch block swallows the error"]);
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

  it("rejects an unknown operation", () => {
    expect(run(["adjudicate", "--runs-root", REL_ROOT]).stderr).toContain("Usage: helper review-panel");
  });
});
