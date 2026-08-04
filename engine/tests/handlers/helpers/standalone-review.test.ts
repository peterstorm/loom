import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const CLI = join(ROOT, "engine/src/cli.ts");

const cleanReviewOutput = [
  "### Machine Summary",
  "CRITICAL_COUNT: 0",
  "ADVISORY_COUNT: 1",
  "CRITICAL:",
  "ADVISORY: improve the name",
  "```findings",
  JSON.stringify([
    { severity: "advisory", file: "src/x.ts", line: 2, claim: "improve the name" },
  ]),
  "```",
].join("\n");

const reviewOutput = [
  "### Machine Summary",
  "CRITICAL_COUNT: 1",
  "ADVISORY_COUNT: 1",
  "CRITICAL: impossible failure",
  "ADVISORY: improve the name",
  "```findings",
  JSON.stringify([
    { severity: "critical", file: "src/x.ts", line: 1, claim: "impossible failure" },
    { severity: "advisory", file: "src/x.ts", line: 2, claim: "improve the name" },
  ]),
  "```",
].join("\n");

describe("standalone review helper and refutation adapter", () => {
  let tmp: string;
  let runDir: string;
  const runsRoot = ".claude/reviews/review-and-fix-runs";

  const cli = (handler: string, args: string[], stdin = "") => spawnSync(
    "bun", [CLI, "helper", handler, ...args], { cwd: tmp, input: stdin, encoding: "utf-8" },
  );

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loom-standalone-review-"));
    runDir = join(runsRoot, "run.abcdef12");
    mkdirSync(join(tmp, runDir, "reviewers"), { recursive: true });
    writeFileSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"), reviewOutput);
    writeFileSync(join(tmp, runDir, "review-input.json"), JSON.stringify({
      reviews: [{ agent: "code-reviewer", transcript: join(runDir, "reviewers/1-code-reviewer.md") }],
    }));
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const initialize = (agents: string[] = ["code-reviewer"]) => {
    writeFileSync(join(tmp, runDir, "review-plan.json"), JSON.stringify({ scope: ["src/x.ts"], expected_agents: agents }));
    const run = cli("standalone-review", ["init", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-plan.json")]);
    expect(run.status, run.stderr).toBe(0);
  };

  it("runs end to end without creating or mutating orchestration state", () => {
    initialize();
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);
    const aggregate = JSON.parse(run.stdout);
    expect(aggregate.findings).toHaveLength(2);

    run = cli("review-panel", ["brief", "--runs-root", runsRoot, "--run-dir", runDir, "--standalone", join(runDir, "aggregate.json")]);
    expect(run.status, run.stderr).toBe(0);
    const brief = JSON.parse(run.stdout);
    expect(brief.source_kind).toBe("standalone");
    expect(brief.findings).toHaveLength(1);

    run = cli("review-panel", ["manifest", "--runs-root", runsRoot, "--run-dir", runDir]);
    expect(run.status, run.stderr).toBe(0);
    const manifest = JSON.parse(run.stdout);
    const findingId = manifest.findings[0].id;

    for (const [index, lens] of manifest.lenses.entries()) {
      const raw = JSON.stringify({
        criterion: lens,
        verdicts: [{
          finding_id: findingId,
          verdict: index < 2 ? "refuted" : "upheld",
          reasoning: index < 2 ? `refuted through ${lens}` : "claim still appears plausible",
        }],
      });
      run = cli("review-panel", ["verdict", "--lens", lens, "--runs-root", runsRoot, "--manifest", join(runDir, "manifest.json")], raw);
      expect(run.status, run.stderr).toBe(0);
      writeFileSync(join(tmp, runDir, `verdicts/verdict-${index + 1}.json`), run.stdout);
    }

    run = cli("review-panel", ["tally", "--runs-root", runsRoot, "--manifest", join(runDir, "manifest.json")]);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(tmp, runDir, "outcomes.json"), "utf-8")).refuted).toBe(1);
    expect(() => readFileSync(join(tmp, ".claude/state/active_task_graph.json"), "utf-8")).toThrow();

    const resultPath = join(tmp, runDir, "result.json");
    const outcomesPath = join(tmp, runDir, "outcomes.json");
    const result = JSON.parse(readFileSync(resultPath, "utf-8"));
    expect(result.surviving_critical_findings).toEqual([]);
    expect(result.refuted_critical_findings).toHaveLength(1);
    expect(result.advisory_findings).toHaveLength(1);

    const published = {
      result: readFileSync(resultPath, "utf-8"),
      outcomes: readFileSync(outcomesPath, "utf-8"),
    };
    run = cli("review-panel", ["tally", "--runs-root", runsRoot, "--manifest", join(runDir, "manifest.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("already been tallied");
    expect(readFileSync(resultPath, "utf-8")).toBe(published.result);
    expect(readFileSync(outcomesPath, "utf-8")).toBe(published.outcomes);

    run = cli("standalone-review", ["finalize", "--runs-root", runsRoot, "--run-dir", runDir]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("already been finalized");
  });

  it("rejects session authority that drifts from the frozen review plan", () => {
    initialize();
    const sessionPath = join(tmp, runDir, "session.json");
    const session = JSON.parse(readFileSync(sessionPath, "utf-8"));
    session.scope = ["src/other.ts"];
    writeFileSync(sessionPath, JSON.stringify(session));

    const run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("does not match the frozen scope and expected agents");
  });

  it("tallies a brace-bearing claim and publishes the original reviewer text", () => {
    initialize();
    writeFileSync(
      join(tmp, runDir, "reviewers/1-code-reviewer.md"),
      reviewOutput.replaceAll("impossible failure", "the {config} value is unchecked"),
    );
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);
    run = cli("review-panel", ["brief", "--runs-root", runsRoot, "--run-dir", runDir, "--standalone", join(runDir, "aggregate.json")]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("the config value is unchecked");
    expect(run.stdout).not.toContain("{config}");
    run = cli("review-panel", ["manifest", "--runs-root", runsRoot, "--run-dir", runDir]);
    expect(run.status, run.stderr).toBe(0);
    const manifest = JSON.parse(run.stdout);
    for (const [index, lens] of manifest.lenses.entries()) {
      const raw = JSON.stringify({
        criterion: lens,
        verdicts: [{ finding_id: manifest.findings[0].id, verdict: "upheld", reasoning: "reachable" }],
      });
      run = cli("review-panel", ["verdict", "--lens", lens, "--runs-root", runsRoot, "--manifest", join(runDir, "manifest.json")], raw);
      expect(run.status, run.stderr).toBe(0);
      writeFileSync(join(tmp, runDir, `verdicts/verdict-${index + 1}.json`), run.stdout);
    }
    run = cli("review-panel", ["tally", "--runs-root", runsRoot, "--manifest", join(runDir, "manifest.json")]);
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(readFileSync(join(tmp, runDir, "result.json"), "utf-8"));
    expect(result.surviving_critical_findings[0].claim).toBe("the {config} value is unchecked");
  });

  it("requires the observed reviewer set, immutable slots, and physical files to match", () => {
    initialize(["code-reviewer", "type-design-analyzer"]);
    writeFileSync(join(tmp, runDir, "review-input.json"), JSON.stringify({
      reviews: [{ agent: "code-reviewer", transcript: join(runDir, "reviewers/1-code-reviewer.md") }],
    }));
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("must match the pre-spawn session expected_agents exactly");

    const second = join(tmp, runDir, "reviewers/2-type-design-analyzer.md");
    writeFileSync(second, reviewOutput);
    writeFileSync(join(tmp, runDir, "review-input.json"), JSON.stringify({
      reviews: [
        { agent: "code-reviewer", transcript: join(runDir, "reviewers/2-type-design-analyzer.md") },
        { agent: "type-design-analyzer", transcript: join(runDir, "reviewers/1-code-reviewer.md") },
      ],
    }));
    run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("review transcript slot 1 for code-reviewer must be exactly");

    rmSync(second);
    linkSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"), second);
    writeFileSync(join(tmp, runDir, "review-input.json"), JSON.stringify({
      reviews: [
        { agent: "code-reviewer", transcript: join(runDir, "reviewers/1-code-reviewer.md") },
        { agent: "type-design-analyzer", transcript: join(runDir, "reviewers/2-type-design-analyzer.md") },
      ],
    }));
    run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("assigned to more than one reviewer");
  });

  it("finalizes a zero-critical run and rejects unexpected panel outcomes", () => {
    initialize();
    writeFileSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"), cleanReviewOutput);
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);

    const outcomesPath = join(tmp, runDir, "outcomes.json");
    writeFileSync(outcomesPath, JSON.stringify({ lenses: [], outcomes: [] }));
    run = cli("standalone-review", ["finalize", "--runs-root", runsRoot, "--run-dir", runDir]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("clean review unexpectedly has panel outcomes");

    rmSync(outcomesPath);
    run = cli("standalone-review", ["finalize", "--runs-root", runsRoot, "--run-dir", runDir]);
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(readFileSync(join(tmp, runDir, "result.json"), "utf-8"));
    expect(result.surviving_critical_findings).toEqual([]);
    expect(result.refuted_critical_findings).toEqual([]);
    expect(result.advisory_findings).toHaveLength(1);
    expect(result.panel).toBeNull();
  });

  it("refuses to finalize a schema-valid aggregate after its reviewer evidence is removed", () => {
    initialize();
    writeFileSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"), cleanReviewOutput);
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);

    rmSync(join(tmp, runDir, "session.json"));
    rmSync(join(tmp, runDir, "review-input.json"));
    rmSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"));
    run = cli("standalone-review", ["finalize", "--runs-root", runsRoot, "--run-dir", runDir]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("cannot read review session");
    expect(() => readFileSync(join(tmp, runDir, "result.json"), "utf-8")).toThrow();
  });

  it("rejects a standalone panel brief when aggregate.json drifts from the transcripts", () => {
    initialize();
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);
    const aggregatePath = join(tmp, runDir, "aggregate.json");
    const aggregate = JSON.parse(readFileSync(aggregatePath, "utf-8"));
    aggregate.findings[0].claim = "forged replacement claim";
    writeFileSync(aggregatePath, JSON.stringify(aggregate));

    run = cli("review-panel", ["brief", "--runs-root", runsRoot, "--run-dir", runDir, "--standalone", join(runDir, "aggregate.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("does not match the aggregate rederived");
  });

  it("cannot turn a hand-authored outcomes file into a finalized critical review", () => {
    initialize();
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);
    writeFileSync(join(tmp, runDir, "outcomes.json"), JSON.stringify({
      lenses: ["fake"], threshold: 1, surviving: 0, refuted: 1, outcomes: [],
    }));
    run = cli("standalone-review", ["finalize", "--runs-root", runsRoot, "--run-dir", runDir]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("critical findings require review-panel tally");
    expect(() => readFileSync(join(tmp, runDir, "result.json"), "utf-8")).toThrow();
  });

  it("rejects a symlink-plus-dotdot run path instead of writing through its raw spelling", () => {
    const outsideParent = join(tmp, "outside");
    const symlinkTarget = join(outsideParent, "target");
    mkdirSync(symlinkTarget, { recursive: true });
    mkdirSync(join(outsideParent, "run.escape"), { recursive: true });
    mkdirSync(join(tmp, runsRoot, "run.escape"), { recursive: true });
    symlinkSync(symlinkTarget, join(tmp, runsRoot, "link"));
    const raw = `${runsRoot}/link/../run.escape`;
    const run = cli("standalone-review", ["finalize", "--runs-root", runsRoot, "--run-dir", raw]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("must not contain dot path segments");
  });

  it("distinguishes incomplete and corrupt prior aggregate publication", () => {
    initialize();
    const pending = join(tmp, runDir, ".aggregate.pending.json");
    writeFileSync(pending, "{\"partial\":");
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("incomplete prior aggregation");

    rmSync(pending);
    writeFileSync(join(tmp, runDir, "aggregate.json"), "{\"partial\":");
    run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("corrupt prior aggregate");
    expect(run.stderr).not.toContain("already been aggregated");
  });

  it("fails closed on missing reviewer evidence and refuses a second aggregation", () => {
    initialize();
    writeFileSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"), "looks fine");
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("CRITICAL_COUNT marker not found");

    writeFileSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"), reviewOutput);
    run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);
    run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("already been aggregated");
  });
});
