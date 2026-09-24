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

type SpawnAnswer = {
  error?: Error;
  status: number | null;
  stdout: string;
  stderr: string;
};

const answered = (stdout: string): SpawnAnswer => ({ status: 0, stdout, stderr: "" });

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const realSpawnSync = actual.spawnSync;
  return {
    ...actual,
    spawnSync: (
      file: string,
      args: readonly string[],
      options: import("node:child_process").SpawnSyncOptions,
    ) => {
      if (scripted.passthrough) return realSpawnSync(file, args, options);
      scripted.calls.push([file, ...args]);
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
import {
  authorizeRemediationChecks,
  createCandidateRepositoryWitness,
  createRemediationCheckScope,
  prepareDefectFamilyAccounting,
  prepareDefectFamilyVerification,
  type AuthorizedRemediationCheck,
} from "../../src/core/defect-family-accounting";
import { parseRepositorySnapshotWitness } from "../../src/core/remediation-machine";
import { VERIFICATION_MANIFEST_KIND, freezeVerificationManifest } from "../../src/core/verification-manifest";
import { standaloneFixture } from "../fixtures/standalone-remediation-authority";
import {
  parseCanonicalRepositoryRoot,
  type CanonicalRepositoryRoot,
} from "../../src/utils/workspace-digest";

const roots: string[] = [];
const digest = (character: string): string => character.repeat(64);
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

function valueOf<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  if (!result.ok) throw new Error(`fixture construction failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

function remediationCheck(root: CanonicalRepositoryRoot, name: string): AuthorizedRemediationCheck {
  const source = standaloneFixture(["src/main.ts"], true).input.standaloneResult;
  const findingId = source.survivingCriticals[0]!.id;
  const accounting = valueOf(prepareDefectFamilyAccounting(source, {
    kind: "declared-defect-family-accounting",
    provenance: "DECLARED",
    dispositions: [{ findingId, status: "repaired", repairGroupId: `family:${name}` }],
    groups: [{
      kind: "declared-repair-group",
      provenance: "DECLARED",
      repairGroupId: `family:${name}`,
      findingIds: [findingId],
      rootCause: { provenance: "DECLARED", statement: "The tested behavior regressed." },
      invariant: { provenance: "DECLARED", statement: "The tested behavior remains fixed." },
      siblings: { kind: "none-declared", provenance: "DECLARED", reason: "No siblings declared." },
      checks: [{
        checkId: `project:${name}`,
        historicalRed: {
          kind: "historical-red",
          provenance: "DECLARED",
          statement: "The check distinguishes the historical defect.",
          reference: null,
        },
      }],
    }],
  }));
  const manifest = valueOf(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    kind: VERIFICATION_MANIFEST_KIND,
    checks: [{
      id: `project:${name}`,
      scope: "wave",
      executable: "node",
      args: ["reset-report.mjs", REPORT_PATH],
      cwd: ".",
      timeoutMs: 2_000,
      report: { kind: "required-file", path: REPORT_PATH },
    }],
  }))));
  const plan = valueOf(prepareDefectFamilyVerification(accounting, manifest));
  if (plan.kind !== "selected-operator-checks") throw new Error("selected remediation plan required");
  const gitWitness = valueOf(parseRepositorySnapshotWitness({
    baseTreeDigest: digest("1"),
    indexDigest: digest("2"),
    worktreeDigest: digest("3"),
  }));
  const candidate = valueOf(createCandidateRepositoryWitness({
    kind: "candidate-repository-witness",
    repositoryRoot: root,
    workspaceDigest: digest("4"),
    pathCount: 1,
    observedPaths: ["src/candidate.ts"],
    gitWitness,
    generatedReportExclusions: [REPORT_PATH],
  }));
  const scope = valueOf(createRemediationCheckScope(plan.source, candidate, {
    kind: "standalone-remediation",
    remediationRunId: `run.reset-${name}`,
    sourceRunId: plan.source.sourceRunId,
    registrationDigest: digest("a"),
    candidateWitnessDigest: candidate.digest,
  }));
  return valueOf(authorizeRemediationChecks(plan, scope))[0];
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

describe("remediation report reset survives the transient empty tracked-state observation", () => {
  it("refuses a tracked, ignore-matched report after transient empties discharge into the observed truth", async () => {
    const root = fixtureRoot();
    const report = join(root, REPORT_PATH);
    mkdirSync(join(root, ".loom", "completion-reports"), { recursive: true });
    writeFileSync(report, "stale tracked content");
    expect(spawnSync("git", ["add", ".gitignore"], { cwd: root }).status).toBe(0);
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
    const report = join(root, REPORT_PATH);
    mkdirSync(join(root, ".loom", "completion-reports"), { recursive: true });
    writeFileSync(report, "stale untracked content");
    expect(spawnSync("git", ["add", ".gitignore"], { cwd: root }).status).toBe(0);

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
    const report = join(root, REPORT_PATH);
    mkdirSync(join(root, ".loom", "completion-reports"), { recursive: true });
    writeFileSync(report, "stale");
    expect(spawnSync("git", ["add", ".gitignore"], { cwd: root }).status).toBe(0);

    scripted.passthrough = false;
    scripted.queue = [
      { error: new Error("spawn git ENOENT"), status: null, stdout: "", stderr: "" },
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
