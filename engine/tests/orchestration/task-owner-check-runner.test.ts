/**
 * The Task owner check's execution shell and helper (ADR-0092) over the
 * owner-verification fixture repository: real Git, real worktrees, and the
 * fixture's runner stand-in launched through the frozen `affectedRunner`.
 *
 * - The Task check and the Wave Gate share one per-obligation run
 *   (`verifyObligations`): where the paths due at the stop are the paths due
 *   by the Wave, the Task check's verdicts are the gate's, verdict for
 *   verdict, and the gate's own verdicts are unchanged by the refactor.
 * - A vacuous matrix test leaves survivors; one that omits a sibling misses it.
 * - A run the deadline cannot hold is never launched: the mutation half is
 *   the infrastructure verdict naming the deadline, and coverage is still
 *   judged.
 * - `helper owner-check` records the result under the digest of what it
 *   judged, and the stop's observation reads it back as current, then as
 *   stale after a family file changes; the real workspace is only read.
 */

import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parseArtifactDigest, success } from "../../src/core/orchestration-contract/identity";
import { obligationsDigest } from "../../src/core/owner-verification/obligations";
import { ownerObservationDecision } from "../../src/core/owner-verification/owed-verification";
import type { InvariantVerdict } from "../../src/core/owner-verification/types";
import { taskOwnerCheckDuty, type OwedTaskOwnerCheck, type TaskOwnerCheckResult } from "../../src/core/task-owner-check";
import { createOwnerCheckHandler } from "../../src/handlers/helpers/owner-check";
import { runOwnerVerification } from "../../src/orchestration/owner-verification-runner";
import { observeTaskOwnerCheck, readTaskOwnerCheckRecord } from "../../src/orchestration/task-owner-check-record";
import { deadlineRefusal, runTaskOwnerCheck } from "../../src/orchestration/task-owner-check-runner";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { loomCommandsAt } from "../fixtures/loom-package-root";
import {
  buildOwnerVerificationRepo as build,
  canonicalRoot,
  cleanupOwnerVerificationRepos,
  OWNER_FIXTURE,
  type OwnerVerificationRepo,
  type StampedGraph,
} from "../fixtures/owner-verification-repo";

const savedStatePath = process.env.LOOM_STATE_PATH;
const recordDirectories: string[] = [];
const recordDirectory = (): string => {
  const directory = canonicalTempDir("loom-owner-check-records-");
  recordDirectories.push(directory);
  return directory;
};
afterEach(() => {
  cleanupOwnerVerificationRepos();
  for (const directory of recordDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (savedStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = savedStatePath;
});

const TIMEOUT_MS = 60_000;

function dutyOf(repo: OwnerVerificationRepo): OwedTaskOwnerCheck {
  const duty = taskOwnerCheckDuty(repo.manager.load(), "T1");
  if (duty.kind !== "owed") throw new Error(`fixture: T1 owes no owner check (${duty.reason})`);
  return duty;
}

async function taskCheck(repo: OwnerVerificationRepo, now: () => number = () => Date.now()): Promise<TaskOwnerCheckResult> {
  const bytes = repo.workspaceBytes();
  const result = await runTaskOwnerCheck({ root: canonicalRoot(repo.root), graph: repo.manager.load(), duty: dutyOf(repo), now });
  expect(repo.workspaceBytes()).toEqual(bytes);
  expect(repo.worktrees()).toEqual([repo.root]);
  return result;
}

/** The gate's verdicts over the same repository, run the one way the gate runs them. */
async function gateVerdicts(repo: OwnerVerificationRepo): Promise<readonly InvariantVerdict[]> {
  const graph = repo.manager.load() as StampedGraph;
  const decision = ownerObservationDecision({
    integrity: null,
    owed: graph.owner_obligations,
    authority: { obligationsDigest: obligationsDigest(graph.owner_obligations), owed: graph.owner_obligations.map(({ invariant }) => invariant) },
  });
  if (decision.kind !== "must-run") throw new Error("the fixture owes the gate a run");
  const digest = parseArtifactDigest(repo.workspaceDigest());
  if (!digest.ok) throw new Error("fixture digest");
  const observation = await runOwnerVerification({
    root: canonicalRoot(repo.root),
    graph,
    wave: 1,
    owed: decision.owed,
    manifest: graph.verification_manifest!,
    observeWorkspace: () => success(digest.value),
  });
  if (observation.kind !== "verified") throw new Error(`the gate could not verify: ${JSON.stringify(observation)}`);
  return observation.verdicts;
}

const verdictsOf = (result: TaskOwnerCheckResult): readonly InvariantVerdict[] => {
  if (result.kind !== "verdicts") throw new Error(`the check did not run: ${result.reason}`);
  return result.verdicts;
};

describe("runTaskOwnerCheck — the gate's per-obligation run, at a Task's stop", () => {
  it.each(["discriminating", "vacuous", "sibling-omitting"] as const)(
    "gives the gate's own verdicts for a %s matrix test when the stop and the Wave owe the same paths",
    async (matrixTest) => {
      const repo = build({ waveChanges: "owner", matrixTest });
      const atStop = verdictsOf(await taskCheck(repo));
      expect(atStop).toEqual(await gateVerdicts(repo));
    },
    TIMEOUT_MS,
  );

  it("names the survivors of a vacuous matrix test and the sibling an omitting one misses", async () => {
    const [vacuous] = verdictsOf(await taskCheck(build({ waveChanges: "owner", matrixTest: "vacuous" })));
    expect(vacuous?.mutation.kind === "verified" && vacuous.mutation.survivors.length).toBeGreaterThan(0);
    const [omitting] = verdictsOf(await taskCheck(build({ waveChanges: "owner", matrixTest: "sibling-omitting" })));
    expect(omitting?.coverage).toEqual({ kind: "missing", paths: [OWNER_FIXTURE.siblings[1]] });
  }, TIMEOUT_MS);

  it("launches no run its deadline cannot hold, and still judges coverage", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "sibling-omitting" });
    let calls = 0;
    // The first reading fixes the deadline; every later one is past it.
    const now = (): number => (calls++ === 0 ? 0 : Number.MAX_SAFE_INTEGER);
    const [verdict] = verdictsOf(await taskCheck(repo, now));
    expect(repo.runnerLaunches()).toEqual([]);
    expect(verdict?.coverage).toEqual({ kind: "missing", paths: [OWNER_FIXTURE.siblings[1]] });
    expect(verdict?.mutation).toEqual({
      kind: "infrastructure",
      failure: { kind: "spawn-failed", detail: expect.stringContaining("not launched: the Task owner check's 480 s deadline cannot hold another run") },
    });
  }, TIMEOUT_MS);

  it("deadlineRefusal admits a run exactly while the time left holds its whole limit", () => {
    expect(deadlineRefusal(1_000, 0, 1_000)).toBeNull();
    expect(deadlineRefusal(1_000, 1, 1_000)).toContain("(999 ms left, one run may take 1000 ms)");
    expect(deadlineRefusal(1_000, 5_000, 10)).toContain("(0 ms left");
  });
});

describe("helper owner-check — the record a stop reads", () => {
  const COMMANDS = loomCommandsAt("/opt/loom");

  async function runHelper(repo: OwnerVerificationRepo, records: string): Promise<string> {
    process.env.LOOM_STATE_PATH = repo.manager.getPath();
    let printed = "";
    const result = await createOwnerCheckHandler({
      write: (text) => { printed += text; },
      repositoryRoot: () => ({ ok: true, root: canonicalRoot(repo.root) }),
      run: (input) => runTaskOwnerCheck(input),
      now: () => Date.now(),
      recordDirectory: records,
    })("", ["--task", "T1"]);
    expect(result).toEqual({ kind: "passthrough" });
    return printed;
  }

  it("records the result under the digest of the family it judged; a later edit makes it stale", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "vacuous" });
    const records = recordDirectory();
    const printed = await runHelper(repo, records);
    expect(printed).toContain("Task owner check for T1: nothing for this Task to answer.");
    expect(printed).toContain("only tests/rules-vacuous.matrix.test.ts answers this, and this Task does not list it");

    const root = canonicalRoot(repo.root);
    const recorded = readTaskOwnerCheckRecord(root, "T1", records);
    expect(recorded.ok && recorded.value.kind).toBe("recorded");
    const observe = observeTaskOwnerCheck(COMMANDS, () => records);
    const current = observe(dutyOf(repo), root);
    expect(current.kind === "observed" && current.standing.kind).toBe("current");
    expect(current.kind === "observed" && current.command).toBe(COMMANDS.ownerCheck("T1"));

    writeFileSync(join(repo.root, OWNER_FIXTURE.siblings[0]), "export const changed = true;\n");
    const stale = observe(dutyOf(repo), root);
    expect(stale.kind === "observed" && stale.standing.kind).toBe("stale");
  }, TIMEOUT_MS);

  it("prints why a Task owes nothing, and runs nothing", async () => {
    const repo = build({ waveChanges: "unrelated", matrixTest: "discriminating" });
    const printed = await runHelper(repo, recordDirectory());
    expect(printed).toMatch(/^Task owner check for T1: not owed — no owned Invariant this Task touches is owed at its stop/);
    expect(repo.runnerLaunches()).toEqual([]);
  }, TIMEOUT_MS);

  it("refuses a command line without --task and a Task the graph does not hold", async () => {
    const repo = build({ waveChanges: "owner", matrixTest: "discriminating" });
    process.env.LOOM_STATE_PATH = repo.manager.getPath();
    const handler = createOwnerCheckHandler();
    expect(await handler("", [])).toEqual({ kind: "error", message: "owner-check requires --task <task-id>" });
    expect(await handler("", ["--task", "T1", "--extra"])).toEqual({ kind: "error", message: expect.stringContaining("unknown or unconsumed") });
    expect(await handler("", ["--task", "T9"])).toEqual({ kind: "error", message: expect.stringContaining("Task T9 is not in the TaskGraph") });
  }, TIMEOUT_MS);
});
