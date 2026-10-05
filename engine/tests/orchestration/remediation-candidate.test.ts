import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRepositorySnapshotWitness } from "../../src/core/remediation-machine";
import {
  captureRemediationCandidateWorkspace,
  recaptureRemediationCandidateWorkspace,
  type RemediationCandidateCapture,
  type RemediationCandidateCaptureInput,
} from "../../src/orchestration/remediation-candidate";
import {
  openGitRepository,
  snapshotRepositoryWitness,
} from "../../src/orchestration/git-remediation";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

const REPORT_PATH = ".loom/completion-reports/repair.xml";
const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf-8",
    env: { PATH: process.env["PATH"] ?? "", HOME: root, LC_ALL: "C" },
  }).trim();
}

function write(root: string, path: string, contents: string): void {
  const absolute = join(root, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function fixtureRepository(): string {
  const root = canonicalTempDir("loom-remediation-candidate-");
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "loom-tests@example.invalid");
  git(root, "config", "user.name", "Loom Tests");
  git(root, "config", "commit.gpgsign", "false");
  write(root, ".gitignore", `${REPORT_PATH}\n.claude/reviews/review-and-fix-runs/\nignored-sibling.ts\n`);
  write(root, ".loom/verification-manifest.json", "{\"fixture\":true}\n");
  write(root, "src/reviewed.ts", "export const reviewed = 1;\n");
  write(root, "src/removed.ts", "export const removed = 1;\n");
  write(root, "src/sibling.ts", "export const sibling = 1;\n");
  write(root, "scripts/check.mjs", "process.exitCode = 0;\n");
  write(root, "clean.txt", "clean-v1\n");
  write(root, "target-a.txt", "target\n");
  write(root, "target-b.txt", "target\n");
  symlinkSync("target-a.txt", join(root, "link.txt"));
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "fixture");
  write(root, "src/reviewed.ts", "export const reviewed = 2;\n");
  unlinkSync(join(root, "src/removed.ts"));
  write(root, "tests/regression.test.ts", "test('repair', () => {});\n");
  write(root, ".loom/unrelated-code.ts", "export const visible = true;\n");
  return root;
}

function verification(reportPath = REPORT_PATH): Extract<
  RemediationCandidateCaptureInput["verification"],
  { kind: "selected-operator-checks" }
> {
  return {
    kind: "selected-operator-checks",
    commands: [{ reportPolicy: { kind: "required-file", path: reportPath } }],
  } as unknown as Extract<
    RemediationCandidateCaptureInput["verification"],
    { kind: "selected-operator-checks" }
  >;
}

function input(root: string, reportPath = REPORT_PATH): RemediationCandidateCaptureInput & Readonly<{
  verification: Extract<RemediationCandidateCaptureInput["verification"], { kind: "selected-operator-checks" }>;
}> {
  return {
    repositoryStartPath: root,
    verification: verification(reportPath),
    pathSources: {
      reviewedPaths: ["src/reviewed.ts", "src/removed.ts"],
      supportPaths: ["tests/regression.test.ts"],
      siblingPaths: ["src/sibling.ts"],
      inputSourcePaths: ["scripts/check.mjs"],
    },
    runDirectory: join(root, ".claude/reviews/review-and-fix-runs/run.candidate"),
  };
}

function captureResult(root: string, captureInput = input(root)) {
  const repository = openGitRepository(root);
  if (!repository.ok) throw new Error(repository.error.message);
  const rawWitness = snapshotRepositoryWitness(repository.value);
  if (!rawWitness.ok) throw new Error(rawWitness.error.message);
  const witness = parseRepositorySnapshotWitness(rawWitness.value);
  if (!witness.ok) throw new Error(witness.error.message);
  return captureRemediationCandidateWorkspace(captureInput, witness.value);
}

function capture(root: string, captureInput = input(root)): RemediationCandidateCapture {
  const captured = captureResult(root, captureInput);
  if (!captured.ok) throw new Error(`${captured.error.field}: ${captured.error.message}`);
  return captured.value;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("remediation candidate workspace capture", () => {
  it("rejects unminted baselines before any accessor or repository observation", () => {
    const root = fixtureRepository();
    const baseline = capture(root).candidateWitness;
    for (const field of ["repositoryRoot", "generatedReportExclusions", "digest"] as const) {
      let effects = 0;
      const forged = Object.defineProperty({ ...baseline }, field, {
        get() { effects++; throw new Error("forged candidate accessor executed"); },
      });
      const result = recaptureRemediationCandidateWorkspace({
        candidateBaseline: forged,
        get repositoryStartPath() { effects++; return root; },
        get runDirectory() { effects++; return input(root).runDirectory; },
      }, baseline.gitWitness);
      expect(result).toMatchObject({ ok: false, error: { field: "candidateBaseline" } });
      expect(effects).toBe(0);
    }
    const revoked = Proxy.revocable(baseline, {});
    revoked.revoke();
    expect(recaptureRemediationCandidateWorkspace({
      repositoryStartPath: "/not-a-repository",
      candidateBaseline: revoked.proxy,
    }, baseline.gitWitness)).toMatchObject({ ok: false, error: { field: "candidateBaseline" } });
  });

  it("recaptures minted authority and refuses no-follow report substitutions", () => {
    const root = fixtureRepository();
    const baseline = capture(root).candidateWitness;
    const recapture = () => recaptureRemediationCandidateWorkspace({
      repositoryStartPath: root,
      candidateBaseline: baseline,
      runDirectory: input(root).runDirectory,
    }, baseline.gitWitness);
    expect(recapture()).toMatchObject({ ok: true, value: { candidateWitness: baseline } });
    write(root, REPORT_PATH, "ignored report");
    unlinkSync(join(root, REPORT_PATH));
    symlinkSync(join(root, "clean.txt"), join(root, REPORT_PATH));
    expect(recapture().ok).toBe(false);
    expect(readFileSync(join(root, "clean.txt"), "utf8")).toBe("clean-v1\n");
    unlinkSync(join(root, REPORT_PATH));
    rmSync(join(root, ".loom/completion-reports"), { recursive: true });
    symlinkSync(join(root, "src"), join(root, ".loom/completion-reports"));
    expect(recapture().ok).toBe(false);
  });

  it("captures the exact Git-visible roster and leaves the real index unchanged", () => {
    const root = fixtureRepository();
    write(root, REPORT_PATH, "old ignored report\n");
    const indexPath = join(root, ".git/index");
    const indexBefore = readFileSync(indexPath);
    const previousIndexOverride = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = join(root, ".git/ambient-redirected-index");
    let captured: RemediationCandidateCapture;
    try {
      captured = capture(root);
    } finally {
      if (previousIndexOverride === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previousIndexOverride;
    }

    expect(captured.observedPaths).toContain("src/reviewed.ts");
    expect(captured.observedPaths).toContain("src/removed.ts");
    expect(captured.observedPaths).toContain("src/sibling.ts");
    expect(captured.observedPaths).toContain("tests/regression.test.ts");
    expect(captured.observedPaths).toContain("scripts/check.mjs");
    expect(captured.observedPaths).toContain("clean.txt");
    expect(captured.observedPaths).toContain(".loom/verification-manifest.json");
    expect(captured.observedPaths).toContain(".loom/unrelated-code.ts");
    expect(captured.observedPaths).not.toContain(REPORT_PATH);
    expect(captured.pathCount).toBe(captured.observedPaths.length);
    expect(captured.candidateWitness.workspaceDigest).toBe(captured.workspaceDigest);
    expect(captured.candidateWitness.generatedReportExclusions).toEqual([REPORT_PATH]);
    expect(readFileSync(indexPath)).toEqual(indexBefore);
  });

  it("accepts only ignored untracked reports and rejects tracked or overlapping reports", () => {
    const allowedRoot = fixtureRepository();
    expect(captureResult(allowedRoot).ok).toBe(true);

    const trackedRoot = fixtureRepository();
    write(trackedRoot, REPORT_PATH, "tracked report\n");
    git(trackedRoot, "add", "-f", REPORT_PATH);
    git(trackedRoot, "commit", "--quiet", "-m", "track report");
    const tracked = captureResult(trackedRoot);
    expect(tracked).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("must be untracked") },
    });

    const overlapInput = input(allowedRoot);
    const overlap = captureResult(allowedRoot, {
      ...overlapInput,
      pathSources: { ...overlapInput.pathSources, supportPaths: [REPORT_PATH] },
    });
    expect(overlap).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("overlap candidate input paths") },
    });

    const notIgnored = captureResult(
      allowedRoot,
      input(allowedRoot, ".loom/completion-reports/not-ignored.xml"),
    );
    expect(notIgnored).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("is not Git-ignored") },
    });

    const duplicateInput = input(allowedRoot);
    const duplicate = captureResult(allowedRoot, {
      ...duplicateInput,
      verification: {
        ...duplicateInput.verification,
        commands: [
          ...duplicateInput.verification.commands,
          ...duplicateInput.verification.commands,
        ] as typeof duplicateInput.verification.commands,
      },
    });
    expect(duplicate).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("is repeated") },
    });
  });

  it("rejects wildcards, ignored candidate inputs, and Git-visible Run Directory evidence", () => {
    const root = fixtureRepository();
    const wildcard = captureResult(root, input(root, ".loom/completion-reports/*.xml"));
    expect(wildcard).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("not a wildcard pattern") },
    });

    write(root, "ignored-sibling.ts", "ignored\n");
    const ignoredSiblingInput = input(root);
    const ignoredSibling = captureResult(root, {
      ...ignoredSiblingInput,
      pathSources: { ...ignoredSiblingInput.pathSources, siblingPaths: ["ignored-sibling.ts"] },
    });
    expect(ignoredSibling).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("not Git-visible") },
    });

    const visibleRunInput = input(root);
    const visibleRun = captureResult(root, {
      ...visibleRunInput,
      runDirectory: join(root, "evidence/run.candidate"),
    });
    expect(visibleRun).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("choose an already-ignored location") },
    });
  });

  it("admits a committed path whose deletion an earlier remediation already staged", () => {
    const root = fixtureRepository();
    const unstaged = capture(root);
    expect(unstaged.observedPaths).toContain("src/removed.ts");
    git(root, "rm", "--quiet", "--cached", "src/removed.ts");
    const staged = capture(root);
    expect(staged.observedPaths).not.toContain("src/removed.ts");
    expect(staged.candidateWitness.observedPaths).toEqual(staged.observedPaths);
  });

  it("refuses an unobserved source unless it is a committed path absent from both index and worktree", () => {
    const root = fixtureRepository();
    const named = (path: string) => {
      const base = input(root);
      return captureResult(root, { ...base, pathSources: { ...base.pathSources, supportPaths: [path] } });
    };
    expect(named("src/never-committed.ts")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("src/never-committed.ts") },
    });
    write(root, "ignored-sibling.ts", "committed then untracked\n");
    git(root, "add", "-f", "ignored-sibling.ts");
    git(root, "commit", "--quiet", "-m", "track ignored path");
    git(root, "rm", "--quiet", "--cached", "ignored-sibling.ts");
    expect(named("ignored-sibling.ts")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("committed paths with a staged deletion") },
    });
  });

  it("admits a reviewed path the reviewed change deleted in an earlier commit, and only as a reviewed path", () => {
    const root = fixtureRepository();
    write(root, "src/retired.ts", "export const retired = 1;\n");
    git(root, "add", "src/retired.ts");
    git(root, "commit", "--quiet", "-m", "add retired");
    git(root, "rm", "--quiet", "src/retired.ts");
    git(root, "commit", "--quiet", "-m", "retire it");
    const base = input(root);
    const withSources = (sources: Partial<RemediationCandidateCaptureInput["pathSources"]>) =>
      captureResult(root, { ...base, pathSources: { ...base.pathSources, ...sources } });

    const reviewed = withSources({ reviewedPaths: [...base.pathSources.reviewedPaths, "src/retired.ts"] });
    expect(reviewed.ok).toBe(true);
    if (reviewed.ok) expect(reviewed.value.observedPaths).not.toContain("src/retired.ts");
    expect(withSources({ supportPaths: ["src/retired.ts"] })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("src/retired.ts") },
    });

    write(root, "ignored-sibling.ts", "present but ignored\n");
    expect(withSources({ reviewedPaths: [...base.pathSources.reviewedPaths, "ignored-sibling.ts"] })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("ignored-sibling.ts") },
    });
  });

  it.each([
    ["dirty M bytes", (root: string) => write(root, "src/reviewed.ts", "export const reviewed = 3;\n")],
    ["clean tracked bytes", (root: string) => write(root, "clean.txt", "clean-v2\n")],
    ["executable mode", (root: string) => chmodSync(join(root, "scripts/check.mjs"), 0o755)],
    ["symlink target", (root: string) => {
      unlinkSync(join(root, "link.txt"));
      symlinkSync("target-b.txt", join(root, "link.txt"));
    }],
    ["symlink node type", (root: string) => {
      unlinkSync(join(root, "link.txt"));
      write(root, "link.txt", "target-a.txt");
    }],
    ["missing tracked path", (root: string) => unlinkSync(join(root, "clean.txt"))],
    ["added untracked path", (root: string) => write(root, "new-untracked.ts", "export {};\n")],
  ])("changes candidate identity for %s", (kind, mutate) => {
    const root = fixtureRepository();
    const before = capture(root);

    mutate(root);
    const after = capture(root);

    expect(after.workspaceDigest, kind).not.toBe(before.workspaceDigest);
    expect(after.candidateWitness.digest, kind).not.toBe(before.candidateWitness.digest);
    if (kind === "dirty M bytes") {
      expect(after.candidateWitness.gitWitness.worktreeDigest).toBe(
        before.candidateWitness.gitWitness.worktreeDigest,
      );
    }
  });
});
