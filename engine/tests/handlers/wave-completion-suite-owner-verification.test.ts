/**
 * The owner check through the production completion suite
 * (`ensureWaveCompletionSuite`) over the real owner-verification fixture
 * repository: the plan re-read whenever the graph carries the stamp (FR-002),
 * the scope of the checks (FR-001, FR-003, AS-004, AS-005), the
 * unstamped-graph regression (FR-004), receipt reuse, and the shell's
 * conversion of a throwing owner run into a named infrastructure failure.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureWaveCompletionSuite,
  type RunOwnerVerification,
} from "../../src/handlers/helpers/wave-completion-suite";
import { authorizeWaveCompletionSuite } from "../../src/core/verification-manifest";
import type { ArtifactDigest } from "../../src/core/orchestration-contract";
import { obligationsDigest } from "../../src/core/owner-verification/obligations";
import type { OwnerVerificationObservation } from "../../src/core/owner-verification/types";
import type { OwnerVerificationInput } from "../../src/orchestration/owner-verification-runner";
import {
  buildOwnerVerificationRepo as build,
  cleanupOwnerVerificationRepos,
  OWNER_FIXTURE,
  type OwnerVerificationRepo,
  type StampedGraph,
} from "../fixtures/owner-verification-repo";

const OWNER_CHECK = "loom:owner-verification";
const GATE_TIMEOUT_MS = 60_000;

afterEach(cleanupOwnerVerificationRepos);

const gate = (repo: OwnerVerificationRepo, runOwnerVerification?: RunOwnerVerification) =>
  ensureWaveCompletionSuite({
    handle: repo.handle,
    manager: repo.manager,
    graph: repo.manager.load(),
    registration: repo.registration,
    ...(runOwnerVerification === undefined ? {} : { runOwnerVerification }),
  });

async function blockedDiagnostic(repo: OwnerVerificationRepo, run?: RunOwnerVerification) {
  const result = await gate(repo, run);
  if (result.ok) throw new Error(`the gate must block, got ${JSON.stringify(result)}`);
  return result.error.diagnostic;
}

/** Every owner-verification observation the suite published, in any slot. */
const observations = (repo: OwnerVerificationRepo): readonly unknown[] =>
  repo.publishedResults().map((result) => result.ownerVerification).filter((entry) => entry !== undefined);

/** A plan whose only Invariant is unowned, and a graph re-stamped with the empty stamp it derives. */
async function onlyUnowned(repo: OwnerVerificationRepo): Promise<void> {
  writeFileSync(join(repo.root, OWNER_FIXTURE.plan), [
    "# Plan: owner-verification fixture", "", "## Invariants", "",
    "### INV-1: No clock reads", "",
    "**Tier:** advisory",
    "**Owner module:** none",
    "**Unowned reason:** a prohibition with no single implementation", "",
  ].join("\n"));
  await repo.manager.update((graph) => ({ ...graph, owner_obligations: [] }));
}

describe("FR-002: a stamped graph owing nothing still re-reads the plan the graph names", () => {
  it.each([
    ["unnamed", "plan-unreadable"],
    ["missing", "plan-unreadable"],
    ["malformed", "plan-malformed"],
    ["drift", "plan-drift"],
  ] as const)("the %s plan blocks as %s, with no coverage or mutation run", async (plan, failure) => {
    const repo = build({ waveChanges: "unrelated", matrixTest: "discriminating", plan });
    const diagnostic = await blockedDiagnostic(repo);
    expect(diagnostic.categories).toContain("infrastructure");
    expect(diagnostic.checkIds).toContain(OWNER_CHECK);
    expect(diagnostic.message).toContain(failure);
    expect(observations(repo)).toEqual([{ kind: "unavailable", failure: { kind: failure, detail: expect.any(String) } }]);
    expect(repo.runnerLaunches()).toEqual([]);
    expect(repo.manager.load().active_wave_completion_suite).toBeUndefined();
  }, GATE_TIMEOUT_MS);

  it("an agreeing plan passes with verdicts [] and no coverage or mutation run", async () => {
    const repo = build({ waveChanges: "unrelated", matrixTest: "discriminating" });
    expect(await gate(repo)).toMatchObject({ ok: true, value: { kind: "accepted", disposition: "installed" } });
    expect(observations(repo)).toEqual([expect.objectContaining({ kind: "verified", verdicts: [] })]);
    expect(repo.runnerLaunches()).toEqual([]);
  }, GATE_TIMEOUT_MS);

  it("an owner infrastructure failure never occupies the result slot: a retry runs the check again", async () => {
    const repo = build({ waveChanges: "unrelated", matrixTest: "discriminating", plan: "missing" });
    await blockedDiagnostic(repo);
    const again = await blockedDiagnostic(repo);
    expect(again.categories).toContain("infrastructure");
    expect(again.message).toContain("plan-unreadable");
    expect(again.categories).not.toContain("artifact");
  }, GATE_TIMEOUT_MS);
});

describe("FR-003: the checks run for exactly the owned Invariants whose family the Wave changed", () => {
  it("AS-004: an owned Invariant whose family the Wave did not change runs no sibling coverage or mutation", async () => {
    const repo = build({ waveChanges: "matrix-test", matrixTest: "sibling-omitting" });
    expect(await gate(repo)).toMatchObject({ ok: true, value: { kind: "accepted" } });
    expect(observations(repo)).toEqual([expect.objectContaining({ kind: "verified", verdicts: [] })]);
    expect(repo.runnerLaunches()).toEqual([]);
  }, GATE_TIMEOUT_MS);

  it("AS-005: a plan declaring only unowned Invariants is re-read, and no sibling coverage or mutation runs", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "sibling-omitting" });
    await onlyUnowned(repo);
    expect(await gate(repo)).toMatchObject({ ok: true, value: { kind: "accepted" } });
    expect(observations(repo)).toEqual([expect.objectContaining({ kind: "verified", verdicts: [] })]);
    expect(repo.runnerLaunches()).toEqual([]);
  }, GATE_TIMEOUT_MS);

  it("AS-005: an empty stamp still blocks when the plan gained an owned Invariant", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating" });
    await repo.manager.update((graph) => ({ ...graph, owner_obligations: [] }));
    const diagnostic = await blockedDiagnostic(repo);
    expect(diagnostic.message).toContain("plan-drift");
    expect(repo.runnerLaunches()).toEqual([]);
  }, GATE_TIMEOUT_MS);
});

describe("FR-004: a graph without the stamp is the pre-feature suite", () => {
  it("authorizes no owner check, records no observation, and keeps the pre-feature suite digest", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "sibling-omitting" });
    await repo.manager.update((graph) => {
      const { owner_obligations: _stamp, ...unstamped } = graph;
      return unstamped;
    });
    expect(await gate(repo)).toMatchObject({ ok: true, value: { kind: "accepted", disposition: "installed" } });
    const graph = repo.manager.load();
    const receipt = graph.active_wave_completion_suite!;
    expect(receipt.checks.map((check) => check.checkId)).toEqual(["loom:full-tier-lint"]);
    expect(receipt.ownerVerification).toBeUndefined();
    const preFeature = authorizeWaveCompletionSuite(graph.verification_manifest!, graph.active_wave_gate!, receipt.workspaceDigest as ArtifactDigest, null);
    expect(preFeature.ok && preFeature.value.suiteDigest).toBe(receipt.suiteDigest);
    expect(observations(repo)).toEqual([]);
    expect(repo.runnerLaunches()).toEqual([]);
  }, GATE_TIMEOUT_MS);
});

describe("receipt reuse", () => {
  it("an unchanged workspace reuses the accepted receipt without re-running owner verification", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating" });
    expect(await gate(repo)).toMatchObject({ ok: true, value: { disposition: "installed" } });
    const launches = repo.runnerLaunches().length;
    expect(await gate(repo)).toMatchObject({ ok: true, value: { kind: "accepted", disposition: "reused" } });
    expect(repo.runnerLaunches()).toHaveLength(launches);
  }, GATE_TIMEOUT_MS);
});

describe("AS-017: FR-016: the shell never lets owner verification throw past the gate", () => {
  it.each([
    ["an unexpected filesystem error", new Error("EIO: i/o error, read")],
    ["a non-Error throw", "EMFILE: too many open files"],
  ])("AS-017: %s blocks with a named infrastructure failure and installs nothing", async (_case, thrown) => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating" });
    const throwing: RunOwnerVerification = async () => {
      throw thrown;
    };
    const diagnostic = await blockedDiagnostic(repo, throwing);
    expect(diagnostic.categories).toContain("infrastructure");
    expect(diagnostic.checkIds).toContain(OWNER_CHECK);
    expect(diagnostic.message).toContain(thrown instanceof Error ? thrown.message : thrown);
    expect(diagnostic.message).toContain("unexpected-error");
    expect(observations(repo)).toEqual([{
      kind: "unavailable",
      failure: { kind: "unexpected-error", detail: expect.stringContaining(thrown instanceof Error ? thrown.message : thrown) },
    }]);
    expect(repo.manager.load().active_wave_completion_suite).toBeUndefined();
    expect(repo.runnerLaunches()).toEqual([]);
  }, GATE_TIMEOUT_MS);

  it("a run that changed the real workspace and then threw is still caught by the suite's after-run digest check", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating" });
    const throwing: RunOwnerVerification = async () => {
      writeFileSync(join(repo.root, "src", "left-behind.ts"), "export const stray = 1;\n");
      throw new Error("EIO: i/o error, write");
    };
    const diagnostic = await blockedDiagnostic(repo, throwing);
    expect(diagnostic.categories).toContain("workspace");
    expect(diagnostic.message).toMatch(/drifted during completion checks/);
    expect(repo.manager.load().active_wave_completion_suite).toBeUndefined();
  }, GATE_TIMEOUT_MS);
});

describe("the owner run's verdicts reach the gate", () => {
  it("AS-007: the owed Invariant's baseline runs before any mutant, and the run is recorded on the receipt", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating" });
    expect(await gate(repo)).toMatchObject({ ok: true, value: { kind: "accepted" } });
    const launches = repo.runnerLaunches();
    expect(launches[0]!.owner).toBe(repo.ownerDigest);
    expect(launches.slice(1).every((launch) => launch.owner !== repo.ownerDigest)).toBe(true);
    expect(repo.manager.load().active_wave_completion_suite?.ownerVerification).toMatchObject({
      kind: "verified",
      verdicts: [{ invariant: "INV-1", coverage: { kind: "covered" }, mutation: { kind: "verified", survivors: [] } }],
    });
  }, GATE_TIMEOUT_MS);

  it("AS-008: a red baseline blocks as a semantic finding and the result is replayed, not re-run", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating", runner: "red" });
    const first = await blockedDiagnostic(repo);
    expect(first.categories).toContain("semantic");
    expect(first.message).toMatch(/INV-1: matrix test .* is red/);
    const replayed = await blockedDiagnostic(repo);
    expect(replayed.message).toMatch(/INV-1: matrix test .* is red/);
    expect(repo.runnerLaunches()).toHaveLength(1);
  }, GATE_TIMEOUT_MS);

  it("AS-016: the real workspace is byte-identical after a mutation run", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating" });
    const before = repo.workspaceBytes();
    await gate(repo);
    expect(repo.workspaceBytes()).toEqual(before);
    expect(repo.worktrees()).toEqual([repo.root]);
  }, GATE_TIMEOUT_MS);

  it("AS-018: an exempt Invariant's exemption and reason are on the receipt, and no mutant ran", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "vacuous", exemption: "generated lookup table" });
    expect(await gate(repo)).toMatchObject({ ok: true, value: { kind: "accepted" } });
    expect(repo.manager.load().active_wave_completion_suite?.ownerVerification).toMatchObject({
      verdicts: [{ invariant: "INV-1", coverage: { kind: "covered" }, mutation: { kind: "exempt", reason: "generated lookup table" } }],
    });
    expect(repo.runnerLaunches()).toEqual([]);
  }, GATE_TIMEOUT_MS);
});

/** Every completion-suite artifact the gate published, relative to the Run Directory's completion-suites root. */
function publishedPaths(repo: OwnerVerificationRepo): readonly string[] {
  const root = join(repo.handle.runDirectory, "artifacts", "completion-suites");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
}

describe("where a rejected result is published (owner-attempt path versus result slot)", () => {
  /** A verified observation whose one verdict is both decided (a missing sibling) and undecided (a failed isolated copy). */
  const mixed = (input: OwnerVerificationInput): OwnerVerificationObservation => ({
    kind: "verified",
    obligationsDigest: input.authority.obligationsDigest,
    boundMs: 0,
    verdicts: input.owed.map((obligation) => ({
      invariant: obligation.invariant,
      title: obligation.title,
      owner: obligation.owner,
      matrixTest: obligation.matrixTest,
      coverage: { kind: "missing", paths: [OWNER_FIXTURE.siblings[1]] },
      mutation: { kind: "infrastructure", failure: { kind: "worktree-failed", detail: "the isolated copy could not be made" } },
    })),
  });

  it("the owner run receives the authority the gate authorized, never a re-derived one", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating" });
    const seen: OwnerVerificationInput[] = [];
    await blockedDiagnostic(repo, async (input) => {
      seen.push(input);
      return mixed(input);
    });
    const graph = repo.manager.load() as StampedGraph;
    expect(seen).toHaveLength(1);
    expect(seen[0]!.authority).toMatchObject({ obligationsDigest: obligationsDigest(graph.owner_obligations), owed: ["INV-1"] });
    expect(seen[0]!.owed.map(({ invariant }) => invariant)).toEqual(["INV-1"]);
  }, GATE_TIMEOUT_MS);

  it("a rejection mixing a decided owner finding with an undecided one is terminal: it fills the result slot and is replayed, not re-run", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating" });
    let runs = 0;
    const run: RunOwnerVerification = async (input) => {
      runs += 1;
      return mixed(input);
    };
    const first = await blockedDiagnostic(repo, run);
    expect(first.categories).toEqual(expect.arrayContaining(["infrastructure", "semantic"]));
    expect(first.message).toContain("owner-verification-rejected");
    const paths = publishedPaths(repo);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^[0-9a-f]{64}\/[0-9a-f]{64}\.json$/);
    expect(paths[0]).not.toContain("owner-infrastructure");

    const replayed = await blockedDiagnostic(repo, run);
    expect(runs).toBe(1);
    expect(replayed.categories).not.toContain("artifact");
    expect(replayed.message).toContain("owner-verification-rejected");
    expect(publishedPaths(repo)).toEqual(paths);
    expect(repo.manager.load().active_wave_completion_suite).toBeUndefined();
  }, GATE_TIMEOUT_MS);

  it("a rejection whose only failure is the owner check's undecided one is an attempt record beside the slot, and a retry runs again", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating" });
    let runs = 0;
    const undecided: RunOwnerVerification = async () => {
      runs += 1;
      return { kind: "unavailable", failure: { kind: "worktree-failed", detail: "the isolated copy could not be made" } };
    };
    await blockedDiagnostic(repo, undecided);
    const retried = await blockedDiagnostic(repo, undecided);
    expect(runs).toBe(2);
    expect(retried.categories).toEqual(["infrastructure"]);
    const paths = publishedPaths(repo);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/\.owner-infrastructure\/[0-9a-f]{64}\.json$/);
  }, GATE_TIMEOUT_MS);
});
