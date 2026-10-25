/**
 * The owner-verification execution shell (AD-8; FR-008, FR-015, FR-016,
 * AS-007, AS-008, AS-016, AS-017) over the CT-1 fixture repository: real Git,
 * real worktrees, and the fixture's runner stand-in launched through the
 * frozen `affectedRunner` with the matrix test as its only file.
 *
 * Every case also proves SC-004: the real workspace's bytes and its
 * Git-visible digest are identical before and after, and no worktree is left.
 */

import { execFileSync } from "node:child_process";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactDigest, DomainResult } from "../../src/core/orchestration-contract";
import { parseArtifactDigest, success } from "../../src/core/orchestration-contract/identity";
import { obligationsDigest } from "../../src/core/owner-verification/obligations";
import type {
  InvariantVerdict,
  MatrixTestRun,
  OwnerObligation,
  OwnerVerificationObservation,
} from "../../src/core/owner-verification/types";
import { parseReviewPath } from "../../src/core/review-packet";
import { freezeVerificationManifest } from "../../src/core/verification-manifest";
import type { CommandExecutionResult } from "../../src/orchestration/completion-check-runner";
import {
  matrixTestRunOf,
  runOwnerVerification,
  type OwnerVerificationInput,
} from "../../src/orchestration/owner-verification-runner";
import { ownerObligation } from "../fixtures/owner-obligation";
import {
  buildOwnerVerificationRepo as build,
  canonicalRoot,
  cleanupOwnerVerificationRepos,
  OWNER_FIXTURE,
  type OwnerVerificationRepo,
  type StampedGraph,
} from "../fixtures/owner-verification-repo";

afterEach(cleanupOwnerVerificationRepos);

const TIMEOUT_MS = 60_000;

const digestOf = (raw: string): ArtifactDigest => {
  const parsed = parseArtifactDigest(raw);
  if (!parsed.ok) throw new Error(`not a digest: ${raw}`);
  return parsed.value;
};

/** The owner check authority the gate hands the runner for `owed` under `stamp`. */
const authorityOf = (stamp: readonly OwnerObligation[], owed: readonly OwnerObligation[]): OwnerVerificationInput["authority"] => ({
  obligationsDigest: obligationsDigest(stamp),
  owed: owed.map(({ invariant }) => invariant),
});

function inputOf(repo: OwnerVerificationRepo, overrides: Partial<OwnerVerificationInput> = {}): OwnerVerificationInput {
  const graph = repo.manager.load() as StampedGraph;
  const [first, ...rest] = graph.owner_obligations;
  if (first === undefined) throw new Error("the fixture stamps one obligation");
  return {
    root: canonicalRoot(repo.root),
    graph,
    wave: 1,
    authority: authorityOf(graph.owner_obligations, graph.owner_obligations),
    owed: [first, ...rest],
    manifest: graph.verification_manifest!,
    observeWorkspace: (): DomainResult<ArtifactDigest, string> => success(digestOf(repo.workspaceDigest())),
    ...overrides,
  };
}

/** Run owner verification and prove SC-004 around it: bytes, digest and worktrees unchanged. */
async function verify(repo: OwnerVerificationRepo, overrides: Partial<OwnerVerificationInput> = {}): Promise<OwnerVerificationObservation> {
  const bytes = repo.workspaceBytes();
  const digest = repo.workspaceDigest();
  const observation = await runOwnerVerification(inputOf(repo, overrides));
  expect(repo.workspaceBytes()).toEqual(bytes);
  expect(repo.workspaceDigest()).toBe(digest);
  expect(repo.worktrees()).toEqual([repo.root]);
  return observation;
}

function onlyVerdict(observation: OwnerVerificationObservation): InvariantVerdict {
  expect(observation.kind, JSON.stringify(observation)).toBe("verified");
  if (observation.kind !== "verified") throw new Error("unreachable");
  expect(observation.verdicts).toHaveLength(1);
  return observation.verdicts[0]!;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

describe("runOwnerVerification", () => {
  it("AS-007: FR-008: runs the unmutated matrix test first, green, then every mutant; a discriminating test kills every non-invalid mutant", async () => {
    const repo = build();
    const observation = await verify(repo);
    const verdict = onlyVerdict(observation);
    expect(verdict).toMatchObject({
      invariant: "INV-1",
      owner: OWNER_FIXTURE.owner,
      matrixTest: OWNER_FIXTURE.matrixTests.discriminating,
      coverage: { kind: "covered" },
      mutation: { kind: "verified", generated: 5, killed: 5, timedOut: 0, invalid: 0, survivors: [], unmutated: 0, ownerChangedInWave: true },
    });
    const launches = repo.runnerLaunches();
    expect(launches).toHaveLength(6);
    expect(launches[0]!.owner).toBe(repo.ownerDigest);
    for (const launch of launches) {
      expect(launch.files).toEqual([OWNER_FIXTURE.matrixTests.discriminating]);
      expect(launch.cwd.startsWith(`${repo.root}/`)).toBe(false);
      expect(launch.cwd).not.toBe(repo.root);
    }
    expect(new Set(launches.slice(1).map((launch) => launch.owner)).size).toBe(5);
    expect(launches.slice(1).every((launch) => launch.owner !== repo.ownerDigest)).toBe(true);
    // One baseline plus five mutants, each bounded by the clamped per-mutant limit.
    expect(observation).toMatchObject({ kind: "verified", boundMs: 6 * 30_000 });
  }, TIMEOUT_MS);

  it("SC-002: a vacuous matrix test lets every non-invalid mutant survive", async () => {
    const repo = build({ matrixTest: "vacuous" });
    const verdict = onlyVerdict(await verify(repo));
    expect(verdict.coverage).toEqual({ kind: "covered" });
    expect(verdict.mutation).toMatchObject({ kind: "verified", generated: 5, killed: 0, invalid: 0 });
    expect(verdict.mutation.kind === "verified" ? verdict.mutation.survivors : []).toHaveLength(5);
  }, TIMEOUT_MS);

  it("AS-008: FR-008: a red baseline runs zero mutants", async () => {
    const repo = build({ runner: "red" });
    const verdict = onlyVerdict(await verify(repo));
    expect(verdict.mutation).toMatchObject({ kind: "red-baseline" });
    expect(repo.runnerLaunches()).toHaveLength(1);
  }, TIMEOUT_MS);

  it.each([
    ["the runner cannot start", { runner: "unstartable" }, "spawn-failed", 0],
    ["the runner writes no report", { runner: "no-report" }, "report-missing", 1],
    ["the isolated copy cannot be made", { worktree: "blocked" }, "worktree-failed", 0],
  ] as const)("AS-017: FR-016: %s is a named infrastructure failure, never a kill", async (_case, options, failure, launches) => {
    const repo = build(options);
    const verdict = onlyVerdict(await verify(repo));
    expect(verdict.mutation).toMatchObject({ kind: "infrastructure", failure: { kind: failure } });
    expect(verdict.mutation).not.toHaveProperty("killed");
    expect(repo.runnerLaunches()).toHaveLength(launches);
  }, TIMEOUT_MS);

  it("FR-007: coverage resolves the tsconfig alias and the re-export barrel, and names an omitted sibling", async () => {
    const repo = build({ matrixTest: "sibling-omitting" });
    const verdict = onlyVerdict(await verify(repo));
    expect(verdict.coverage).toEqual({ kind: "missing", paths: [OWNER_FIXTURE.siblings[1]] });
  }, TIMEOUT_MS);

  it("an exempt Invariant still runs coverage, runs no matrix test, and needs no runner", async () => {
    const repo = build({ matrixTest: "vacuous", exemption: "equivalent mutants only" });
    const noRunner = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
      schemaVersion: 2, kind: "loom-verification-manifest", checks: [],
    })));
    if (!noRunner.ok) throw new Error("manifest refused");
    const verdict = onlyVerdict(await verify(repo, { manifest: noRunner.value }));
    expect(verdict).toMatchObject({ coverage: { kind: "covered" }, mutation: { kind: "exempt", reason: "equivalent mutants only" } });
    expect(repo.runnerLaunches()).toEqual([]);
  }, TIMEOUT_MS);

  it("AS-014: a Wave that changed only a sibling runs the baseline and generates zero mutants", async () => {
    const repo = build({ waveChanges: "sibling" });
    const verdict = onlyVerdict(await verify(repo));
    expect(verdict.mutation).toMatchObject({ kind: "verified", generated: 0, unmutated: 0, ownerChangedInWave: false });
    expect(repo.runnerLaunches()).toHaveLength(1);
  }, TIMEOUT_MS);

  it("a non-exempt owed Invariant without a frozen affectedRunner is the runner-missing infrastructure failure", async () => {
    const repo = build();
    const noRunner = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
      schemaVersion: 2, kind: "loom-verification-manifest", checks: [],
    })));
    if (!noRunner.ok) throw new Error("manifest refused");
    const observation = await verify(repo, { manifest: noRunner.value });
    expect(observation).toMatchObject({ kind: "unavailable", failure: { kind: "runner-missing" } });
    expect(repo.runnerLaunches()).toEqual([]);
  }, TIMEOUT_MS);

  it("an owner Task without a start_sha is the missing-wave-base infrastructure failure", async () => {
    const repo = build();
    const graph = repo.manager.load() as StampedGraph;
    const unbased: StampedGraph = { ...graph, tasks: graph.tasks.map(({ start_sha: _dropped, ...task }) => task) };
    const verdict = onlyVerdict(await verify(repo, { graph: unbased }));
    expect(verdict.mutation).toMatchObject({ kind: "infrastructure", failure: { kind: "missing-wave-base" } });
    expect(repo.runnerLaunches()).toEqual([]);
  }, TIMEOUT_MS);

  it("FR-016: an owner with syntax errors is the owner-unparseable infrastructure failure, and no matrix test runs", async () => {
    const repo = build();
    writeFileSync(join(repo.root, OWNER_FIXTURE.owner), "export function decide(age: number {\n  return age >= 18;\n}\n");
    const verdict = onlyVerdict(await verify(repo));
    expect(verdict.mutation).toMatchObject({
      kind: "infrastructure",
      failure: { kind: "owner-unparseable", detail: expect.stringContaining(OWNER_FIXTURE.owner) },
    });
    expect(repo.runnerLaunches()).toEqual([]);
  }, TIMEOUT_MS);

  it("several owner Tasks diff the owner against their octopus merge-base", async () => {
    const repo = build();
    const graph = repo.manager.load() as StampedGraph;
    const base = graph.tasks[0]!.start_sha!;
    // A later commit that already holds the Wave's owner: alone it would leave no changed line.
    git(repo.root, "add", "--", OWNER_FIXTURE.owner);
    git(repo.root, "commit", "-qm", "second owner task");
    const later = git(repo.root, "rev-parse", "HEAD");
    const second = { ...graph.tasks[0]!, id: "T2", start_sha: later };
    const verdict = onlyVerdict(await verify(repo, { graph: { ...graph, tasks: [...graph.tasks, second] } }));
    expect(base).not.toBe(later);
    expect(verdict.mutation).toMatchObject({ kind: "verified", generated: 5, ownerChangedInWave: true });
  }, TIMEOUT_MS);

  it("SC-004: a real workspace that changed while verification ran is the real-workspace-changed failure", async () => {
    const repo = build();
    let calls = 0;
    const observeWorkspace = (): DomainResult<ArtifactDigest, string> => {
      calls += 1;
      return success(digestOf((calls === 1 ? "a" : "b").repeat(64)));
    };
    const observation = await verify(repo, { observeWorkspace });
    expect(observation).toMatchObject({ kind: "unavailable", failure: { kind: "real-workspace-changed" } });
    expect(calls).toBe(2);
  }, TIMEOUT_MS);

  it("an unobservable real workspace is never a pass", async () => {
    const repo = build();
    const observation = await verify(repo, { observeWorkspace: () => ({ ok: false, error: "git exploded" }) });
    expect(observation).toMatchObject({ kind: "unavailable", failure: { kind: "real-workspace-changed" } });
    expect(repo.runnerLaunches()).toEqual([]);
  }, TIMEOUT_MS);

  it("an unreadable frontier file (ELOOP) is a coverage infrastructure failure, never a missing sibling", async () => {
    const repo = build();
    const sibling = join(repo.root, OWNER_FIXTURE.siblings[1]);
    rmSync(sibling);
    symlinkSync(sibling, sibling);
    const fixed = digestOf("d".repeat(64));
    const observation = await runOwnerVerification(inputOf(repo, { observeWorkspace: () => success(fixed) }));
    const verdict = onlyVerdict(observation);
    expect(verdict.coverage).toMatchObject({
      kind: "infrastructure",
      failure: { kind: "repository-file-unreadable", detail: expect.stringContaining(OWNER_FIXTURE.siblings[1]) },
    });
    expect(repo.worktrees()).toEqual([repo.root]);
  }, TIMEOUT_MS);

  it("never throws: a frontier path the filesystem refuses (ENAMETOOLONG) is a coverage infrastructure failure", async () => {
    const repo = build();
    const graph = repo.manager.load() as StampedGraph;
    const obligation: OwnerObligation = { ...graph.owner_obligations[0]!, matrixTest: `tests/${"x".repeat(300)}.matrix.test.ts` };
    const verdict = onlyVerdict(await verify(repo, { owed: [obligation] }));
    expect(verdict.coverage).toMatchObject({
      kind: "infrastructure",
      failure: { kind: "repository-file-unreadable", detail: expect.stringContaining("ENAMETOOLONG") },
    });
  }, TIMEOUT_MS);

  it("never throws: a workspace observer that throws is an unobservable workspace, never a pass", async () => {
    const repo = build();
    const observation = await verify(repo, { observeWorkspace: () => { throw new Error("EMFILE: too many open files"); } });
    expect(observation).toEqual({
      kind: "unavailable",
      failure: { kind: "real-workspace-changed", detail: expect.stringContaining("EMFILE: too many open files") },
    });
    expect(repo.runnerLaunches()).toEqual([]);
  }, TIMEOUT_MS);

  it("never throws: a step that throws mid-run is the unexpected-error failure, and the after-run digest is still compared", async () => {
    const repo = build();
    const graph = repo.manager.load() as StampedGraph;
    // Only the per-obligation run reads `siblings`: the throw lands between the two digest observations.
    const exploding: readonly [OwnerObligation] = [Object.defineProperty({ ...graph.owner_obligations[0]! }, "siblings", {
      get: () => { throw new Error("EIO: i/o error, read"); },
    })];
    let calls = 0;
    const observeWorkspace = (): DomainResult<ArtifactDigest, string> => {
      calls += 1;
      return success(digestOf("e".repeat(64)));
    };
    const observation = await verify(repo, { owed: exploding, observeWorkspace });
    expect(observation).toEqual({
      kind: "unavailable",
      failure: { kind: "unexpected-error", detail: expect.stringContaining("EIO: i/o error, read") },
    });
    expect(calls).toBe(2);

    let changing = 0;
    const drifting = (): DomainResult<ArtifactDigest, string> => {
      changing += 1;
      return success(digestOf((changing === 1 ? "a" : "b").repeat(64)));
    };
    const drifted = await verify(repo, { owed: exploding, observeWorkspace: drifting });
    expect(drifted).toMatchObject({ kind: "unavailable", failure: { kind: "real-workspace-changed" } });
    expect(changing).toBe(2);
  }, TIMEOUT_MS);

  it("two owed obligations: verdicts follow the stamp order, and one obligation's infrastructure failure never reaches the other", async () => {
    const repo = build();
    const graph = repo.manager.load() as StampedGraph;
    const admission = graph.owner_obligations[0]!;
    // Owed first, and broken: its owner is not in the workspace, so its mutation cannot be planned.
    const absent = ownerObligation({
      invariant: "INV-2",
      title: "Absence is decided only by absent.ts",
      statement: null,
      owner: "src/absent.ts",
      siblings: [],
      matrixTest: OWNER_FIXTURE.matrixTests.vacuous,
      mutation: { kind: "verify" },
    });
    const owed = [absent, admission] as const;
    const observation = await verify(repo, { owed, authority: authorityOf([...graph.owner_obligations, absent], owed) });
    expect(observation.kind, JSON.stringify(observation)).toBe("verified");
    if (observation.kind !== "verified") return;
    expect(observation.obligationsDigest).toBe(obligationsDigest([...graph.owner_obligations, absent]));
    expect(observation.verdicts.map(({ invariant }) => invariant)).toEqual(["INV-2", "INV-1"]);
    expect(observation.verdicts[0]).toMatchObject({
      coverage: { kind: "missing", paths: ["src/absent.ts"] },
      mutation: { kind: "infrastructure", failure: { kind: "plan-drift", detail: expect.stringContaining("src/absent.ts") } },
    });
    expect(observation.verdicts[1]).toMatchObject({
      coverage: { kind: "covered" },
      mutation: { kind: "verified", generated: 5, killed: 5, survivors: [] },
    });
    // Only INV-1 ran its matrix test: the baseline and five mutants, never the vacuous test of INV-2.
    const launches = repo.runnerLaunches();
    expect(launches).toHaveLength(6);
    expect(launches.every((launch) => launch.files[0] === OWNER_FIXTURE.matrixTests.discriminating)).toBe(true);
  }, TIMEOUT_MS);

  it("never throws: a matrix test absent from the workspace reaches nothing, so every declared path is missing", async () => {
    const repo = build();
    const graph = repo.manager.load() as StampedGraph;
    const obligation: OwnerObligation = { ...graph.owner_obligations[0]!, matrixTest: "tests/absent.matrix.test.ts" };
    const verdict = onlyVerdict(await verify(repo, { owed: [obligation] }));
    expect(verdict.coverage).toEqual({ kind: "missing", paths: [OWNER_FIXTURE.owner, ...OWNER_FIXTURE.siblings] });
  }, TIMEOUT_MS);
});

describe("matrixTestRunOf", () => {
  const diagnostics = { stdoutTail: "", stderrTail: "", stdoutTruncated: false, stderrTruncated: false };
  const reportPath = (() => {
    const parsed = parseReviewPath("r.xml");
    if (!parsed.ok) throw new Error("fixture path refused");
    return parsed.value;
  })();

  it("reads a timed-out execution as timed-out, whatever its report", () => {
    const execution: CommandExecutionResult = {
      ok: true,
      value: { kind: "observed", process: { kind: "observed", exitCode: null, timedOut: true, signal: "SIGTERM" }, report: { kind: "missing", path: reportPath }, diagnostics },
    };
    expect(matrixTestRunOf(execution, 1234)).toEqual<MatrixTestRun>({ kind: "timed-out", elapsedMs: 1234 });
  });

  it("reads a runner that could not contain its process as a run that could not start, never a report", () => {
    const execution: CommandExecutionResult = {
      ok: false,
      error: { kind: "termination-unconfirmed", message: "group survived", diagnostics },
    };
    expect(matrixTestRunOf(execution, 1)).toEqual<MatrixTestRun>({ kind: "spawn-failed", message: "termination-unconfirmed: group survived" });
  });

  it("carries a produced report's exact bytes", () => {
    const bytes = new TextEncoder().encode("<testsuites/>");
    const execution: CommandExecutionResult = {
      ok: true,
      value: {
        kind: "observed",
        process: { kind: "observed", exitCode: 0, timedOut: false, signal: null },
        report: { outcome: { kind: "produced", path: reportPath, digest: digestOf("c".repeat(64)), byteLength: bytes.byteLength }, bytes, mode: 0o644 },
        diagnostics,
      },
    };
    expect(matrixTestRunOf(execution, 1)).toEqual<MatrixTestRun>({ kind: "exited", exitCode: 0, signal: null, report: { kind: "produced", bytes } });
  });
});
