/**
 * CT-1 acceptance: owner verification at the Wave Gate.
 *
 * Every testcase drives the production completion suite
 * (`ensureWaveCompletionSuite`) over a real temp Git repository built by
 * `ownerVerificationRepo`: an owner, two siblings, a re-export barrel, a
 * tsconfig `paths` alias, three matrix tests (discriminating, vacuous,
 * sibling-omitting), a plan declaring INV-1 over that family, and a TaskGraph
 * stamped with the plan's Owner Obligations whose frozen manifest's
 * `affectedRunner` is a deterministic stand-in that writes JUnit and logs
 * every launch outside the repository.
 *
 * Evidence is read from what the suite leaves behind: its diagnostic, the
 * persisted completion result's `ownerVerification`, the installed receipt,
 * the runner's launch log, and the real workspace's bytes.
 *
 * Each testcase runs the matrix test up to six times as a real `node`
 * process inside real `git worktree`s, so it states a 60s timeout.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ensureWaveCompletionSuite } from "../../src/handlers/helpers/wave-completion-suite";
import {
  cleanupOwnerVerificationRepos,
  ownerVerificationRepo,
  OWNER_FIXTURE,
  type OwnerVerificationRepo,
  type OwnerVerificationRepoOptions,
} from "../fixtures/owner-verification-repo";

const OWNER_CHECK = "loom:owner-verification";
const GATE_TIMEOUT_MS = 60_000;

afterEach(cleanupOwnerVerificationRepos);

async function gate(repo: OwnerVerificationRepo) {
  return ensureWaveCompletionSuite({
    handle: repo.handle,
    manager: repo.manager,
    graph: repo.manager.load(),
    registration: repo.registration,
  });
}

type Blocked = Readonly<{ categories: readonly string[]; checkIds: readonly string[]; message: string }>;

async function blockedGate(repo: OwnerVerificationRepo): Promise<Blocked> {
  const result = await gate(repo);
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) throw new Error("the gate must block");
  return result.error.diagnostic;
}

async function acceptedGate(repo: OwnerVerificationRepo): Promise<void> {
  const result = await gate(repo);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, value: { kind: "accepted", disposition: "installed" } });
}

/** The single owner-verification observation the suite persisted. */
function persistedOwnerVerification(repo: OwnerVerificationRepo): Record<string, unknown> {
  const observations = repo.publishedResults().map((result) => result.ownerVerification).filter((value) => value !== undefined);
  expect(observations).toHaveLength(1);
  return observations[0] as Record<string, unknown>;
}

/** The persisted verdict for INV-1, the fixture's one owned Invariant. */
function persistedVerdict(repo: OwnerVerificationRepo): Record<string, unknown> {
  const observation = persistedOwnerVerification(repo);
  expect(observation).toMatchObject({ kind: "verified" });
  const verdicts = observation.verdicts as readonly Record<string, unknown>[];
  expect(verdicts.map((verdict) => verdict.invariant)).toEqual(["INV-1"]);
  return verdicts[0]!;
}

const build = (options: OwnerVerificationRepoOptions) => ownerVerificationRepo(options);

describe("owner verification at the Wave Gate (CT-1)", () => {
  it("FR-001: a Wave that changed the owner runs sibling coverage and mutation for that owned Invariant", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating" });
    await acceptedGate(repo);
    const verdict = persistedVerdict(repo);
    expect(verdict).toMatchObject({
      invariant: "INV-1",
      owner: OWNER_FIXTURE.owner,
      matrixTest: OWNER_FIXTURE.matrixTests.discriminating,
      coverage: { kind: "covered" },
      mutation: { kind: "verified", generated: 5, killed: 5, timedOut: 0, invalid: 0, survivors: [], unmutated: 0, ownerChangedInWave: true },
    });
    const receipt = repo.manager.load().active_wave_completion_suite as unknown as Record<string, unknown> | undefined;
    expect(receipt?.ownerVerification).toEqual(persistedOwnerVerification(repo));
  }, GATE_TIMEOUT_MS);

  it("FR-001: a Wave that changed only a sibling owes the family: coverage runs, and the unchanged owner yields zero mutants", async () => {
    const repo = build({ waveChanges: "sibling", matrixTest: "discriminating" });
    await acceptedGate(repo);
    expect(persistedVerdict(repo)).toMatchObject({
      coverage: { kind: "covered" },
      mutation: { kind: "verified", generated: 0, killed: 0, survivors: [], unmutated: 0, ownerChangedInWave: false },
    });
  }, GATE_TIMEOUT_MS);

  it.each(["matrix-test", "unrelated"] as const)(
    "FR-001: FR-002: a Wave that changed only the %s owes nothing: the plan is re-read and agrees, and no coverage or mutation runs",
    async (waveChanges) => {
      const repo = build({ waveChanges, matrixTest: "discriminating" });
      await acceptedGate(repo);
      expect(persistedOwnerVerification(repo)).toMatchObject({ kind: "verified", verdicts: [] });
      expect(repo.runnerLaunches()).toEqual([]);
    },
    GATE_TIMEOUT_MS,
  );

  it.each([
    ["the graph names no plan", "unnamed", "plan-unreadable"],
    ["the named plan is missing", "missing", "plan-unreadable"],
    ["the plan declares an exemption without a reason", "malformed", "plan-malformed"],
    ["the plan gained an owned Invariant after population", "drift", "plan-drift"],
  ] as const)("FR-002: a stamped graph whose Wave owes nothing still blocks when %s", async (_case, plan, failure) => {
    const repo = build({ waveChanges: "unrelated", matrixTest: "discriminating", plan });
    const blocked = await blockedGate(repo);
    expect(blocked.categories).toContain("infrastructure");
    expect(blocked.checkIds).toContain(OWNER_CHECK);
    expect(blocked.message).toContain(failure);
    expect(repo.manager.load().active_wave_completion_suite).toBeUndefined();
    expect(repo.runnerLaunches()).toEqual([]);
  }, GATE_TIMEOUT_MS);

  it("AS-007: FR-008: the matrix test runs first against the unmutated workspace, and passes, before any mutant", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating" });
    await acceptedGate(repo);
    const launches = repo.runnerLaunches();
    expect(launches).toHaveLength(6);
    expect(launches[0]!.owner).toBe(repo.ownerDigest);
    expect(launches[0]!.files).toEqual([OWNER_FIXTURE.matrixTests.discriminating]);
    for (const mutant of launches.slice(1)) expect(mutant.owner).not.toBe(repo.ownerDigest);
    expect(new Set(launches.slice(1).map((launch) => launch.owner)).size).toBe(5);
  }, GATE_TIMEOUT_MS);

  it("AS-008: FR-008: a matrix test red before mutation blocks the gate, and no mutant runs", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating", runner: "red" });
    const blocked = await blockedGate(repo);
    expect(blocked.checkIds).toContain(OWNER_CHECK);
    expect(blocked.categories).toContain("semantic");
    expect(blocked.message).toContain("INV-1");
    expect(blocked.message).toMatch(/red/i);
    expect(repo.runnerLaunches()).toHaveLength(1);
    expect(persistedVerdict(repo)).toMatchObject({ mutation: { kind: "red-baseline" } });
    expect(repo.manager.load().active_wave_completion_suite).toBeUndefined();
  }, GATE_TIMEOUT_MS);

  it("FR-014: AS-011: a survivor of a non-exempt Invariant blocks, naming the Invariant, owner file, line, operator, and original and mutated text", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "vacuous" });
    const blocked = await blockedGate(repo);
    expect(blocked.checkIds).toContain(OWNER_CHECK);
    expect(blocked.categories).toContain("semantic");
    const verdict = persistedVerdict(repo);
    expect(verdict).toMatchObject({ coverage: { kind: "covered" }, mutation: { kind: "verified", generated: 5, killed: 0 } });
    const survivors = (verdict.mutation as { survivors: readonly Record<string, unknown>[] }).survivors;
    expect(survivors).toHaveLength(5);
    expect(blocked.message).toContain("INV-1");
    for (const survivor of survivors) {
      expect(blocked.message).toContain(`${OWNER_FIXTURE.owner}:${String(survivor.line)}`);
      expect(blocked.message).toContain(String(survivor.operator));
      expect(blocked.message).toContain(String(survivor.original));
      expect(blocked.message).toContain(String(survivor.replacement));
    }
    expect(repo.manager.load().active_wave_completion_suite).toBeUndefined();
  }, GATE_TIMEOUT_MS);

  it("FR-014: a missing sibling blocks the gate, naming the Invariant, the matrix test and the missing sibling path", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "sibling-omitting" });
    const blocked = await blockedGate(repo);
    expect(blocked.checkIds).toContain(OWNER_CHECK);
    expect(blocked.message).toContain("INV-1");
    expect(blocked.message).toContain(OWNER_FIXTURE.matrixTests["sibling-omitting"]);
    expect(blocked.message).toContain(OWNER_FIXTURE.siblings[1]);
    expect(persistedVerdict(repo)).toMatchObject({ coverage: { kind: "missing", paths: [OWNER_FIXTURE.siblings[1]] } });
  }, GATE_TIMEOUT_MS);

  it("AS-018: FR-020: an exempt Invariant records its exemption and reason, still runs coverage, and runs no mutation", async () => {
    const reason = "The owner is a generated lookup table; every mutant is equivalent.";
    const repo = build({ waveChanges: "owner", matrixTest: "vacuous", exemption: reason });
    await acceptedGate(repo);
    expect(persistedVerdict(repo)).toMatchObject({ coverage: { kind: "covered" }, mutation: { kind: "exempt", reason } });
    expect(repo.runnerLaunches()).toEqual([]);
  }, GATE_TIMEOUT_MS);

  it("FR-020: an exemption disables only the mutation check: a missing sibling still blocks", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "sibling-omitting", exemption: "equivalent mutants only" });
    const blocked = await blockedGate(repo);
    expect(blocked.checkIds).toContain(OWNER_CHECK);
    expect(blocked.message).toContain(OWNER_FIXTURE.siblings[1]);
    expect(persistedVerdict(repo)).toMatchObject({
      coverage: { kind: "missing", paths: [OWNER_FIXTURE.siblings[1]] },
      mutation: { kind: "exempt", reason: "equivalent mutants only" },
    });
    expect(repo.runnerLaunches()).toEqual([]);
  }, GATE_TIMEOUT_MS);

  it("AS-016: FR-015: every mutant runs in an isolated copy and the real workspace is byte-identical before and after", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "vacuous" });
    const before = repo.workspaceBytes();
    const digestBefore = repo.workspaceDigest();
    await blockedGate(repo);
    expect(repo.workspaceBytes()).toEqual(before);
    expect(repo.workspaceDigest()).toBe(digestBefore);
    const launches = repo.runnerLaunches();
    expect(launches.length).toBeGreaterThan(1);
    for (const launch of launches) {
      expect(launch.cwd).not.toBe(repo.root);
      expect(launch.cwd.startsWith(`${repo.root}/`)).toBe(false);
    }
    expect(repo.worktrees()).toEqual([repo.root]);
  }, GATE_TIMEOUT_MS);

  it.each([
    ["the runner cannot start", { runner: "unstartable" }, "spawn-failed"],
    ["the runner writes no report", { runner: "no-report" }, "report-missing"],
    ["the isolated copy cannot be made", { worktree: "blocked" }, "worktree-failed"],
  ] as const)("AS-017: FR-016: %s blocks with a named infrastructure diagnostic and never counts as a kill", async (_case, options, failure) => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating", ...options });
    const before = repo.workspaceBytes();
    const blocked = await blockedGate(repo);
    expect(blocked.categories).toContain("infrastructure");
    expect(blocked.checkIds).toContain(OWNER_CHECK);
    expect(blocked.message).toContain(failure);
    expect(blocked.message).toContain("INV-1");
    expect(repo.manager.load().active_wave_completion_suite).toBeUndefined();
    // Never a kill: INV-1's persisted verdict exists, and its mutation half is
    // the named infrastructure failure, so no verified tally (and no kill
    // count) was recorded for any mutant of this run.
    const mutation = persistedVerdict(repo).mutation as Record<string, unknown>;
    expect(mutation).toMatchObject({ kind: "infrastructure", failure: { kind: failure } });
    expect(mutation).not.toHaveProperty("killed");
    expect(mutation).not.toHaveProperty("timedOut");
    expect(repo.workspaceBytes()).toEqual(before);
  }, GATE_TIMEOUT_MS);
});
