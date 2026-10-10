/**
 * Focused regression pin for the remediation report-reset guard's Git
 * observation (architecture-tech-lead-1, round-4).
 *
 * `resetRemediationReport` must re-observe the `git ls-files` tracked-state
 * probe through the canonical bounded empty-retry (`observeGitProbe`): a
 * single status-0/empty-stdout success is never a tracked/untracked decision,
 * because the transient empty-success class documented there would otherwise
 * bypass the tracked-file refusal arm and authorize unlinking tracked,
 * ignore-matched report content. Only a confirmed-empty observation reaches
 * the explicit caller decision (empty legitimately means untracked), and a
 * failed observation throws with attribution.
 *
 * The reset's two Git probes reach Git through the `GitSpawn` port the
 * runner's `reportResetGit` option binds, which a case scripts with the shared port fake
 * after real Git setup, so the status-0/empty-stdout transient is reproduced
 * deterministically — a real repository cannot produce it on demand. Fixture
 * setup, the spawned check process and every other Git observation stay real,
 * so the containment and report machinery is exercised unchanged.
 *
 * It also pins that the reset's ignore decision runs under the shared Git
 * execution policy, so it agrees with the remediation candidate's ignore
 * audit even when the operator's global config ignores the report.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvOverlay } from "../fixtures/env-overlay";
import { answered, failedToStart, scriptedGitSpawn, type ScriptedGitCall } from "../fixtures/scripted-git";

import {
  runRemediationCheck,
  type RemediationCheckRunnerResult,
} from "../../src/orchestration/completion-check-runner";
import type { AuthorizedRemediationCheck } from "../../src/core/defect-family-accounting";
import { authorizedRemediationCheck } from "../fixtures/authorized-remediation-check";
import { spawnGit } from "../../src/utils/git-execution-policy";
import {
  parseCanonicalRepositoryRoot,
  type CanonicalRepositoryRoot,
} from "../../src/utils/workspace-digest";

const roots: string[] = [];
const REPORT_PATH = ".loom/completion-reports/reset.xml";

function fixtureRoot(): CanonicalRepositoryRoot {
  const root = canonicalTempDir("loom-report-reset-");
  roots.push(root);
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root });
  if (initialized.status !== 0) throw new Error("reset fixture Git init failed");
  writeFileSync(join(root, ".gitignore"), ".loom/completion-reports/\n");
  writeFileSync(
    join(root, "reset-report.mjs"),
    [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import { dirname, join } from "node:path";',
      'mkdirSync(dirname(process.argv[2]), { recursive: true });',
      'writeFileSync(process.argv[2], \'<testsuite tests="1" failures="0"/>\');',
    ].join("\n"),
  );
  const parsed = parseCanonicalRepositoryRoot(root);
  if (!parsed.ok) throw new Error("message" in parsed.error ? parsed.error.message : "root observation drifted");
  return parsed.value;
}

function writeStaleReport(root: CanonicalRepositoryRoot, contents: string): string {
  const report = join(root, REPORT_PATH);
  mkdirSync(join(root, ".loom", "completion-reports"), { recursive: true });
  writeFileSync(report, contents);
  expect(spawnSync("git", ["add", ".gitignore"], { cwd: root }).status).toBe(0);
  return report;
}

function remediationCheck(root: CanonicalRepositoryRoot, name: string): AuthorizedRemediationCheck {
  return authorizedRemediationCheck(root, {
    name,
    runIdPrefix: "run.reset",
    reportPath: REPORT_PATH,
    args: ["reset-report.mjs", REPORT_PATH],
  });
}

function refusalText(result: { readonly ok: false; readonly error: unknown }): string {
  const error = result.error as Readonly<Record<string, unknown>>;
  const { diagnostics: _diagnostics, ...rest } = error;
  return JSON.stringify(rest);
}

const lsFilesCalls = (calls: readonly ScriptedGitCall[]): number =>
  calls.filter(({ args }) => args[0] === "--literal-pathspecs" && args[1] === "ls-files").length;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("remediation report reset agrees with the remediation candidate's ignore audit", () => {
  it("refuses a report that only the operator's global core.excludesFile ignores, as the policy-bound audit does", async () => {
    const root = fixtureRoot();
    // The repository itself does not ignore the report directory; only the
    // operator's global excludes file does.
    writeFileSync(join(root, ".gitignore"), "");
    const report = writeStaleReport(root, "stale, globally ignored only");
    const home = canonicalTempDir("loom-report-reset-home-");
    roots.push(home);
    writeFileSync(join(home, "global-ignore"), ".loom/\n");
    writeFileSync(join(home, ".gitconfig"), `[core]\n\texcludesFile = ${join(home, "global-ignore")}\n`);
    await withEnvOverlay({ HOME: home }, async () => {
      // Control: an ambient-config Git honours the operator's global ignore file…
      expect(spawnSync("git", ["check-ignore", "-q", "--", REPORT_PATH], { cwd: root }).status).toBe(0);
      // …but the candidate audit's policy-bound check-ignore (its exact argv) does not.
      expect(spawnGit(["check-ignore", "--no-index", "--quiet", "--", REPORT_PATH], { cwd: root, maxBuffer: 1024 }))
        .toMatchObject({ kind: "exited", status: 1 });
      const result = await runRemediationCheck(remediationCheck(root, "global-ignore"), root);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("a report the audit treats as a visible path was reset");
      expect(result.error.kind).toBe("report-reset-failed");
      expect(result.error.message).toContain("requires a Git-ignored path");
      expect(readFileSync(report, "utf8")).toBe("stale, globally ignored only");
    });
  });
});

describe("remediation report reset survives the transient empty tracked-state observation", () => {
  it("refuses a tracked, ignore-matched report after transient empties discharge into the observed truth", async () => {
    const root = fixtureRoot();
    const report = writeStaleReport(root, "stale tracked content");
    expect(spawnSync("git", ["add", "-f", REPORT_PATH], { cwd: root }).status).toBe(0);
    const index = readFileSync(join(root, ".git", "index"));

    const git = scriptedGitSpawn([
      answered(""), answered(""), answered("reset.xml\0"), // transient empties, then the tracked truth
    ]);
    const result: RemediationCheckRunnerResult = await runRemediationCheck(
      remediationCheck(root, "tracked-transient"), root, { reportResetGit: git.spawn },
    );
    // The repaired guard re-observes through the bounded retry; the observed
    // non-empty truth refuses loudly and never reaches the unlink.
    expect(result.ok, result.ok ? "" : `runner refused: ${refusalText(result)}`).toBe(false);
    if (result.ok) throw new Error("vulnerable behavior: tracked report was not refused");
    expect(result.error.kind).toBe("report-reset-failed");
    expect(result.error.message).toContain("before launch");
    expect(result.error.message).toContain("cannot prove exact path is untracked");
    expect(existsSync(report)).toBe(true);
    expect(readFileSync(report, "utf8")).toBe("stale tracked content");
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
    // The full retry budget was spent before the refusal.
    expect(lsFilesCalls(git.calls)).toBe(3);
  });

  it("proceeds with the reset only after a confirmed-empty observation names the untracked path", async () => {
    const root = fixtureRoot();
    writeStaleReport(root, "stale untracked content");

    const git = scriptedGitSpawn([
      answered(""), answered(""), answered(""), // confirmed-empty: legitimately untracked
      answered(""), // check-ignore -q: ignored
    ]);
    const result = await runRemediationCheck(remediationCheck(root, "confirmed-empty"), root, { reportResetGit: git.spawn });
    expect(result.ok, result.ok ? "" : `runner refused: ${refusalText(result)}`).toBe(true);
    if (!result.ok) throw new Error("confirmed-empty reset refused");
    expect(result.value.process).toMatchObject({ kind: "observed", exitCode: 0 });
    expect(result.value.report).toMatchObject({
      outcome: { kind: "produced", path: REPORT_PATH },
      parsedReportFacts: { ok: true, value: { total: 1, failed: 0 } },
    });
    // The explicit caller decision was reached only after the full retry budget.
    expect(lsFilesCalls(git.calls)).toBe(3);
    expect(git.calls.map(({ args }) => args[0])).toEqual(["--literal-pathspecs", "--literal-pathspecs", "--literal-pathspecs", "check-ignore"]);
  });

  it("attributes a failed tracked-state observation instead of a generic untracked refusal", async () => {
    const root = fixtureRoot();
    const report = writeStaleReport(root, "stale");

    const git = scriptedGitSpawn([
      failedToStart("spawn git ENOENT"),
    ]);
    const result = await runRemediationCheck(remediationCheck(root, "failed-probe"), root, { reportResetGit: git.spawn });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("failed probe was not refused");
    expect(result.error.kind).toBe("report-reset-failed");
    expect(result.error.message).toContain("before launch");
    expect(result.error.message).toContain("could not observe tracked state");
    expect(result.error.message).toContain("could not start");
    expect(existsSync(report)).toBe(true);
    expect(lsFilesCalls(git.calls)).toBe(1);
  });
});
