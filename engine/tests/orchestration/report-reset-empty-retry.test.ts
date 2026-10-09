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
 * `spawnSync` is scripted after real Git setup (passthrough flag), so the
 * status-0/empty-stdout transient is reproduced deterministically — a real
 * repository cannot produce it on demand. The spawned check process itself
 * stays real, so the containment and report machinery is exercised unchanged.
 *
 * It also pins that the reset's ignore decision runs under the shared Git
 * execution policy, so it agrees with the remediation candidate's ignore
 * audit even when the operator's global config ignores the report.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scripted = vi.hoisted(() => ({
  queue: [] as SpawnAnswer[],
  calls: [] as string[][],
  passthrough: true,
}));

/** A scripted raw `spawnSync` result. A spawn that started no child hands back
 *  null streams, as both runtimes do; a child that ran hands back strings. */
type SpawnAnswer = {
  error?: Error;
  status: number | null;
  stdout: string | null;
  stderr: string | null;
};

const answered = (stdout: string): SpawnAnswer => ({ status: 0, stdout, stderr: "" });

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { logicalGitArgs } = await import("../fixtures/policy-bound-git-argv");
  const realSpawnSync = actual.spawnSync;
  return {
    ...actual,
    spawnSync: (
      file: string,
      args: readonly string[],
      options: import("node:child_process").SpawnSyncOptions,
    ) => {
      if (scripted.passthrough) return realSpawnSync(file, args, options);
      scripted.calls.push([file, ...logicalGitArgs(args)]);
      const next = scripted.queue.shift();
      if (next === undefined) throw new Error("fixture ran past its scripted Git responses");
      return next;
    },
  };
});

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

const lsFilesCalls = (): number =>
  scripted.calls.filter((entry) => entry[1] === "--literal-pathspecs" && entry[2] === "ls-files").length;

afterEach(() => {
  scripted.passthrough = true;
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

beforeEach(() => {
  scripted.calls.length = 0;
  scripted.queue.length = 0;
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
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
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
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});

describe("remediation report reset survives the transient empty tracked-state observation", () => {
  it("refuses a tracked, ignore-matched report after transient empties discharge into the observed truth", async () => {
    const root = fixtureRoot();
    const report = writeStaleReport(root, "stale tracked content");
    expect(spawnSync("git", ["add", "-f", REPORT_PATH], { cwd: root }).status).toBe(0);
    const index = readFileSync(join(root, ".git", "index"));

    scripted.passthrough = false;
    scripted.queue = [
      answered(""), answered(""), answered("reset.xml\0"), // transient empties, then the tracked truth
    ];
    const result: RemediationCheckRunnerResult = await runRemediationCheck(
      remediationCheck(root, "tracked-transient"), root,
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
    expect(lsFilesCalls()).toBe(3);
  });

  it("proceeds with the reset only after a confirmed-empty observation names the untracked path", async () => {
    const root = fixtureRoot();
    writeStaleReport(root, "stale untracked content");

    scripted.passthrough = false;
    scripted.queue = [
      answered(""), answered(""), answered(""), // confirmed-empty: legitimately untracked
      answered(""), // check-ignore -q: ignored
    ];
    const result = (await runRemediationCheck(remediationCheck(root, "confirmed-empty"), root));
    expect(result.ok, result.ok ? "" : `runner refused: ${refusalText(result)}`).toBe(true);
    if (!result.ok) throw new Error("confirmed-empty reset refused");
    expect(result.value.process).toMatchObject({ kind: "observed", exitCode: 0 });
    expect(result.value.report).toMatchObject({
      outcome: { kind: "produced", path: REPORT_PATH },
      parsedReportFacts: { ok: true, value: { total: 1, failed: 0 } },
    });
    // The explicit caller decision was reached only after the full retry budget.
    expect(lsFilesCalls()).toBe(3);
  });

  it("attributes a failed tracked-state observation instead of a generic untracked refusal", async () => {
    const root = fixtureRoot();
    const report = writeStaleReport(root, "stale");

    scripted.passthrough = false;
    scripted.queue = [
      { error: new Error("spawn git ENOENT"), status: null, stdout: null, stderr: null },
    ];
    const result = await runRemediationCheck(remediationCheck(root, "failed-probe"), root);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("failed probe was not refused");
    expect(result.error.kind).toBe("report-reset-failed");
    expect(result.error.message).toContain("before launch");
    expect(result.error.message).toContain("could not observe tracked state");
    expect(result.error.message).toContain("could not start");
    expect(existsSync(report)).toBe(true);
    expect(lsFilesCalls()).toBe(1);
  });
});
