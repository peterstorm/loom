import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "cli.ts");

const DIGEST = [
  "**Primary axis:** simplicity",
  "**Testability bar:** pure functional core",
  "**Sensitive boundaries:** none",
  "**Codebase maturity:** brownfield",
  "**Codebase constraints:** existing engine boundaries",
  "**Error-handling philosophy:** Either/Result end-to-end",
  "**Concurrency & state:** stateless",
  "**Data & persistence:** none",
  "**Tech preferences:** TypeScript",
  "**Observability:** diagnostics",
  "**Backwards compatibility:** preserve CLI",
  "**Deployment:** none",
  "**Out-of-scope:** state migration",
  "**Executable-model signal:** none",
].join("\n");

function run(cwd: string, args: readonly string[], input = "") {
  return spawnSync("bun", [CLI, "helper", "panel-contract", ...args], {
    cwd,
    input,
    encoding: "utf-8",
  });
}

describe("panel-contract helper CLI", () => {
  let tmp: string;
  let runsRoot: string;
  let runDir: string;
  let manifestPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loom-panel-contract-"));
    runsRoot = join(tmp, "panel-runs");
    runDir = join(runsRoot, "run.1234567890");
    mkdirSync(join(runDir, "candidates"), { recursive: true });
    writeFileSync(join(runDir, "interview.md"), DIGEST);
    writeFileSync(join(runDir, "interview.json"), JSON.stringify({
      primaryAxis: "simplicity",
      testabilityBar: "pure functional core",
      sensitiveBoundaries: "none",
      codebaseMaturity: "brownfield",
      codebaseConstraints: "existing engine boundaries",
      errorHandlingPhilosophy: "Either/Result end-to-end",
      concurrencyAndState: "stateless",
      dataAndPersistence: "none",
      techPreferences: "TypeScript",
      observability: "diagnostics",
      backwardsCompatibility: "preserve CLI",
      deployment: "none",
      outOfScope: "state migration",
      executableModelSignal: "none",
    }));
    for (const filename of ["candidate-simplicity-first.md", "candidate-type-driven-fp.md"]) {
      writeFileSync(join(runDir, "candidates", filename), `# ${filename}\n`);
    }
    manifestPath = join(runDir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      run_id: "run.1234567890",
      interview_file: join(runDir, "interview.md"),
      interview_json: join(runDir, "interview.json"),
      candidates: [
        {
          lens: "simplicity-first",
          path: join(runDir, "candidates", "candidate-simplicity-first.md"),
          filename: "candidate-simplicity-first.md",
        },
        {
          lens: "type-driven-fp",
          path: join(runDir, "candidates", "candidate-type-driven-fp.md"),
          filename: "candidate-type-driven-fp.md",
        },
      ],
    }));
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /** Write verdict-N.json for each criterion with the given candidate scores. */
  function writeVerdicts(
    scoresByCriterion: readonly (readonly (readonly [string, number])[])[],
    criteria: readonly string[] = ["simplicity", "pure functional core", "codebase fit + effort"],
  ) {
    mkdirSync(join(runDir, "verdicts"), { recursive: true });
    criteria.forEach((criterion, index) => {
      const ordered = [...(scoresByCriterion[index] ?? [])].sort((a, b) => b[1] - a[1]);
      writeFileSync(
        join(runDir, "verdicts", `verdict-${index + 1}.json`),
        JSON.stringify({
          criterion,
          rankings: ordered.map(([candidate, score]) => ({
            candidate,
            score,
            fatal_flaw: null,
            strongest_idea: "an idea",
          })),
        }),
      );
    });
  }

  const A = "candidate-simplicity-first.md";
  const B = "candidate-type-driven-fp.md";
  const RUN_ARGS = () => ["--runs-root", runsRoot, "--manifest", manifestPath, "--designers", "2"];

  it("derives the judge criteria from the validated digest", () => {
    const result = run(tmp, ["criteria", ...RUN_ARGS()]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      "simplicity",
      "pure functional core",
      "codebase fit + effort",
    ]);
  });

  it("rejects a --criterion that the digest does not derive", () => {
    const verdict = JSON.stringify({
      criterion: "performance",
      rankings: [
        { candidate: A, score: 9, fatal_flaw: null, strongest_idea: "x" },
        { candidate: B, score: 8, fatal_flaw: null, strongest_idea: "y" },
      ],
    });
    const result = run(
      tmp,
      ["verdict", "--criterion", "performance", ...RUN_ARGS()],
      verdict,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be one of the derived criteria");
  });

  it("aggregates verdicts from disk into a deterministic ranking", () => {
    writeVerdicts([
      [[A, 3], [B, 9]],
      [[A, 4], [B, 8]],
      [[A, 5], [B, 1]],
    ]);
    const result = run(tmp, ["aggregate", ...RUN_ARGS()]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ranking.map((entry: { candidate: string }) => entry.candidate)).toEqual([B, A]);
    expect(parsed.ranking[0].rank).toBe(1);
    expect(parsed.ranking[0].total_score).toBe(18);
    expect(parsed.ranking[1].total_score).toBe(12);
  });

  it("rejects a verdict file written into the wrong criterion slot", () => {
    // verdict-1.json must carry criterion 1. Swapping slots 1 and 2 is exactly
    // the positional mistake the old prose contract could not detect.
    writeVerdicts([
      [[A, 5], [B, 5]],
      [[A, 5], [B, 5]],
      [[A, 5], [B, 5]],
    ], ["pure functional core", "simplicity", "codebase fit + effort"]);
    const result = run(tmp, ["aggregate", ...RUN_ARGS()]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("criterion must equal");
  });

  it("refuses to aggregate when a verdict file is missing or empty", () => {
    writeVerdicts([
      [[A, 5], [B, 5]],
      [[A, 5], [B, 5]],
      [[A, 5], [B, 5]],
    ]);
    rmSync(join(runDir, "verdicts", "verdict-3.json"));
    const missing = run(tmp, ["aggregate", ...RUN_ARGS()]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("panel verdicts contract failed");

    writeFileSync(join(runDir, "verdicts", "verdict-3.json"), "");
    const empty = run(tmp, ["aggregate", ...RUN_ARGS()]);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("non-empty regular file");
  });

  it("rejects a symlinked verdict file", () => {
    writeVerdicts([
      [[A, 5], [B, 5]],
      [[A, 5], [B, 5]],
      [[A, 5], [B, 5]],
    ]);
    const outside = join(tmp, "outside-verdict.json");
    writeFileSync(outside, readFileSync(join(runDir, "verdicts", "verdict-3.json"), "utf-8"));
    rmSync(join(runDir, "verdicts", "verdict-3.json"));
    symlinkSync(outside, join(runDir, "verdicts", "verdict-3.json"));
    const result = run(tmp, ["aggregate", ...RUN_ARGS()]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("symbolic link");
  });

  it("rejects an unknown operation with usage", () => {
    const result = run(tmp, ["rank", ...RUN_ARGS()]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: helper panel-contract");
  });

  it("canonicalizes a valid interview and fails malformed input with diagnostics", () => {
    const valid = run(tmp, ["interview"], DIGEST);
    expect(valid.status).toBe(0);
    expect(JSON.parse(valid.stdout).primaryAxis).toBe("simplicity");

    const invalid = run(tmp, ["interview"], "**Primary axis:** novelty");
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("interview digest contract failed");
  });

  it("validates a run-bound manifest and rejects a cross-run reference", () => {
    const args = ["manifest", "--runs-root", runsRoot, "--manifest", manifestPath, "--designers", "2"];
    expect(run(tmp, args).status).toBe(0);

    const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    raw.candidates[0].path = join(tmp, "old-run", "candidates", raw.candidates[0].filename);
    writeFileSync(manifestPath, JSON.stringify(raw));
    const invalid = run(tmp, args);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("must exactly equal its run-scoped candidate path");
  });

  it("rejects symlinked run-root components and a symlinked manifest", () => {
    const aliasRoot = join(tmp, "alias-runs");
    symlinkSync(runsRoot, aliasRoot);
    const aliasManifest = join(aliasRoot, "run.1234567890", "manifest.json");
    const rootResult = run(tmp, [
      "manifest", "--runs-root", aliasRoot, "--manifest", aliasManifest, "--designers", "2",
    ]);
    expect(rootResult.status).toBe(1);
    expect(rootResult.stderr).toContain("symbolic link");

    const target = join(runDir, "manifest-target.json");
    writeFileSync(target, readFileSync(manifestPath));
    rmSync(manifestPath);
    symlinkSync(target, manifestPath);
    const manifestResult = run(tmp, [
      "manifest", "--runs-root", runsRoot, "--manifest", manifestPath, "--designers", "2",
    ]);
    expect(manifestResult.status).toBe(1);
    expect(manifestResult.stderr).toContain("manifest must not be a symbolic link");
  });

  it("rejects a manifest-listed candidate that was replaced by a symlink", () => {
    const candidate = join(runDir, "candidates", "candidate-simplicity-first.md");
    const outside = join(tmp, "stale-candidate.md");
    writeFileSync(outside, "# stale\n");
    rmSync(candidate);
    symlinkSync(outside, candidate);

    const result = run(tmp, [
      "verdict", "--criterion", "simplicity", "--runs-root", runsRoot,
      "--manifest", manifestPath, "--designers", "2",
    ], "{}");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not be a symbolic link");
  });

  it("validates and sanitizes verdict output through the real CLI", () => {
    const verdict = JSON.stringify({
      criterion: "simplicity",
      rankings: [
        {
          candidate: "candidate-simplicity-first.md",
          score: 9,
          fatal_flaw: null,
          strongest_idea: "one {pure} core",
        },
        {
          candidate: "candidate-type-driven-fp.md",
          score: 7,
          fatal_flaw: "too much ceremony",
          strongest_idea: "typed errors",
        },
      ],
    });
    const result = run(tmp, [
      "verdict", "--criterion", "simplicity", "--runs-root", runsRoot,
      "--manifest", manifestPath, "--designers", "2",
    ], verdict);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).rankings[0].strongest_idea).toBe("one pure core");
  });

  it("returns failure when canonical stdout cannot be written", () => {
    const full = openSync("/dev/full", "w");
    try {
      const result = spawnSync("bun", [CLI, "helper", "panel-contract", "interview"], {
        cwd: tmp,
        input: DIGEST,
        stdio: ["pipe", full, "pipe"],
        encoding: "utf-8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("canonical output contract failed");
    } finally {
      closeSync(full);
    }
  });
});
