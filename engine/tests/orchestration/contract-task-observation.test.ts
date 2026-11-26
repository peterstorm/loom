/**
 * The one settlement observation of a Task against the Acceptance Contracts
 * (`observeContractTask`): its conformance verdict (AD-5) and the frozen paths
 * of the contracts it writes that hold a regular file (ADR-0104), in one read.
 * Exercised on the skeleton fixture repository, whose CT-1, CT-2 and CT-3 are
 * written by T1, T2 and T3, through the observer itself, the exact settlement
 * and the stored-evidence reconcile that recovers a stuck contract writer.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writerFrozenPaths } from "../../src/core/acceptance-contract";
import { settleObservedImplementation } from "../../src/core/implementation-application";
import { parseIsoInstant, type ImplementationAttemptAuthority } from "../../src/core/implementation-completion";
import { NO_CONTRACT_TASK_OBSERVATION, TRUSTED_LEDGER_ONLY_POLICY } from "../../src/core/proof-obligations";
import {
  productionExactSettlementPorts,
  settleExactImplementation,
  type ExactImplementationSettlement,
  type ExactImplementationSettlementPorts,
} from "../../src/handlers/helpers/exact-implementation-settlement";
import reconcileImplementationProof from "../../src/handlers/helpers/reconcile-implementation-proof";
import { observeTaskLocalCompletion } from "../../src/handlers/helpers/task-local-completion";
import { observeContractTask } from "../../src/orchestration/contract-task-observation";
import { NEW_TEST_EVIDENCE_NOT_WRITTEN, type Task, type TaskGraph } from "../../src/types";
import {
  authorityOf,
  cleanupSkeletonRepos,
  graphOf,
  JAVA_CONTRACT,
  managerOf,
  proofFailureKinds,
  registered,
  settleAttempt,
  skeletonRepo,
  storedTask,
  TS_CONTRACT,
  TS_TYPES_TEXT,
  type SkeletonRepo,
} from "../fixtures/skeleton-repo";

afterEach(cleanupSkeletonRepos);

const taskOf = (graph: TaskGraph, id: string): Task => {
  const task = graph.tasks.find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`fixture: no Task ${id}`);
  return task;
};

const HELD_ACCEPTANCE = {
  kind: "declared-artifact-changed",
  artifact: TS_CONTRACT.acceptance,
  basis: { kind: "held-for-freeze", contract: "CT-1" },
} as const;

describe("writerFrozenPaths", () => {
  it("names every frozen path of each contract the Task writes, types file first, and nothing for any other Task", () => {
    const contracts = graphOf(skeletonRepo()).acceptance_contracts ?? [];
    expect(writerFrozenPaths(contracts, "T1")).toEqual([
      { path: TS_CONTRACT.types, contract: "CT-1" },
      { path: TS_CONTRACT.acceptance, contract: "CT-1" },
    ]);
    expect(writerFrozenPaths(contracts, "T3")).toEqual([{ path: "tests/audit.acceptance.test.ts", contract: "CT-3" }]);
    expect(writerFrozenPaths(contracts, "T4")).toEqual([]);
    expect(writerFrozenPaths([], "T1")).toEqual([]);
  });
});

describe("observeContractTask", () => {
  it("holds every present frozen path of the Task's own contracts, and only those", () => {
    const repo = skeletonRepo();
    const graph = graphOf(repo);
    const t1 = observeContractTask(repo.root, graph, taskOf(graph, "T1"));
    expect(t1.ok && t1.value.heldForFreeze).toEqual([
      { artifact: TS_CONTRACT.types, contract: "CT-1" },
      { artifact: TS_CONTRACT.acceptance, contract: "CT-1" },
    ]);
    const t2 = observeContractTask(repo.root, graph, taskOf(graph, "T2"));
    expect(t2.ok && t2.value.heldForFreeze).toEqual([
      { artifact: JAVA_CONTRACT.types, contract: "CT-2" },
      { artifact: JAVA_CONTRACT.acceptance, contract: "CT-2" },
    ]);
  });

  it("judges a bound Task's conformance and holds nothing for it, since it writes no contract", () => {
    const repo = skeletonRepo();
    const graph = graphOf(repo);
    const t4 = observeContractTask(repo.root, graph, taskOf(graph, "T4"));
    expect(t4.ok && t4.value.conformance.kind).toBe("judged");
    expect(t4.ok && t4.value.heldForFreeze).toEqual([]);
  });

  it("yields the empty observation for a Task that owes no conformance and writes no contract, reading nothing", () => {
    const repo = skeletonRepo();
    const graph = graphOf(repo);
    // T7 waives regression as documentation-only, so it owes no conformance; an unresolvable root is never touched.
    expect(observeContractTask(join(repo.root, "no-such-root"), graph, taskOf(graph, "T7")))
      .toEqual({ ok: true, value: NO_CONTRACT_TASK_OBSERVATION });
  });

  it("does not hold a missing frozen path", () => {
    const repo = skeletonRepo();
    repo.remove(TS_CONTRACT.acceptance);
    const graph = graphOf(repo);
    const t1 = observeContractTask(repo.root, graph, taskOf(graph, "T1"));
    expect(t1.ok && t1.value.heldForFreeze).toEqual([{ artifact: TS_CONTRACT.types, contract: "CT-1" }]);
  });

  it("does not hold a frozen path that is a link or a directory", () => {
    const repo = skeletonRepo();
    repo.write("elsewhere.ts", repo.read(TS_CONTRACT.acceptance) ?? "");
    rmSync(join(repo.root, TS_CONTRACT.acceptance));
    symlinkSync(join(repo.root, "elsewhere.ts"), join(repo.root, TS_CONTRACT.acceptance));
    rmSync(join(repo.root, TS_CONTRACT.types));
    mkdirSync(join(repo.root, TS_CONTRACT.types));
    const graph = graphOf(repo);
    const t1 = observeContractTask(repo.root, graph, taskOf(graph, "T1"));
    expect(t1.ok && t1.value.heldForFreeze).toEqual([]);
  });

  it("reports a frozen path it cannot read as one infrastructure failure naming it", () => {
    if (process.getuid?.() === 0) return; // root reads through any permission
    const repo = skeletonRepo();
    const graph = graphOf(repo);
    withUnreadable(repo, TS_CONTRACT.acceptance, () => {
      expect(observeContractTask(repo.root, graph, taskOf(graph, "T1")))
        .toMatchObject({ ok: false, error: expect.stringContaining(TS_CONTRACT.acceptance) });
    });
  });

  it("reports an unresolvable repository root for a contract writer", () => {
    const repo = skeletonRepo();
    const graph = graphOf(repo);
    expect(observeContractTask(join(repo.root, "no-such-root"), graph, taskOf(graph, "T1")))
      .toMatchObject({ ok: false, error: expect.stringContaining("cannot resolve the repository root") });
  });
});

/** Run `body` with the bytes at `path` unreadable (mode 000), restoring them after. */
function withUnreadable(repo: SkeletonRepo, path: string, body: () => void): void {
  const absolute = join(repo.root, path);
  chmodSync(absolute, 0o000);
  try {
    body();
  } finally {
    chmodSync(absolute, 0o644);
  }
}

/**
 * The contract Wave with CT-1's sources already written and committed, as a
 * revision finds them (less `absent`), T1 registered against those very bytes,
 * and the revision's new types file written: the acceptance file is already right.
 */
async function refreezing(absent: readonly string[] = []): Promise<Readonly<{ repo: SkeletonRepo; attempt: ImplementationAttemptAuthority }>> {
  const repo = skeletonRepo({ stage: "contract-wave" });
  repo.writeContractSources();
  for (const path of absent) repo.remove(path);
  repo.commit("CT-1 sources before the revision");
  const attempt = authorityOf(await registered(repo, "T1"), "T1");
  repo.write(TS_CONTRACT.types, `${TS_TYPES_TEXT}export type Currency = "EUR" | "DKK";\n`);
  return { repo, attempt };
}

describe("the exact settlement of a contract writer re-freezing a revised contract", () => {
  it("settles implemented with the byte-identical acceptance file held for CT-1's freeze", async () => {
    const { repo, attempt } = await refreezing();

    const settled = await settleAttempt(repo, attempt, [TS_CONTRACT.types]);

    expect(settled.infrastructureReason).toBeUndefined();
    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    const t1 = taskOf(graphOf(repo), "T1");
    expect(t1.status).toBe("implemented");
    expect(t1.proof.state === "satisfied" ? t1.proof.evidence : []).toEqual(expect.arrayContaining([
      { kind: "declared-artifact-changed", artifact: TS_CONTRACT.types },
      HELD_ACCEPTANCE,
    ]));
  });

  it("still fails a writer that never creates its frozen acceptance file: absence is never held", async () => {
    const { repo, attempt } = await refreezing([TS_CONTRACT.acceptance]);

    const settled = await settleAttempt(repo, attempt, [TS_CONTRACT.types]);

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "retry-required" } });
    expect(proofFailureKinds(repo.rawState(), "T1")).toEqual(["declared-artifact-not-changed"]);
  });
});

/**
 * T1 stuck as the engine before ADR-0104 left it: its attempt settled over
 * the real observed bytes with nothing held, so the byte-identical acceptance
 * file failed `declared-artifact-not-changed` and the Task is pending a retry.
 */
async function stuckBeforeTheHold(): Promise<SkeletonRepo> {
  const { repo, attempt } = await refreezing();
  const observedAt = parseIsoInstant(new Date().toISOString(), "fixture settlement instant");
  if (!observedAt.ok) throw new Error(observedAt.error.errors.join("; "));
  await managerOf(repo).updateAndReturn((state) => {
    const bytes = observeTaskLocalCompletion({
      repositoryRoot: repo.root,
      task: taskOf(state, "T1"),
      authority: attempt,
      parserModifiedPaths: [TS_CONTRACT.types],
      parserPathLabel: "pre-ADR-0104 result paths",
      siblingOwnedPaths: [],
      authoritativeStatePath: repo.statePath,
      engineSkeletons: state.skeletons ?? [],
    });
    const application = settleObservedImplementation(state, attempt, observedAt.value, {
      taskCompleted: true,
      testResult: { verdict: "trusted-pass" },
      testEvidence: "pre-ADR-0104 pass",
      newTests: NEW_TEST_EVIDENCE_NOT_WRITTEN,
      contractTask: NO_CONTRACT_TASK_OBSERVATION,
    }, TRUSTED_LEDGER_ONLY_POLICY, bytes);
    return { state: application.state, value: application };
  });
  expect(storedTask(repo.rawState(), "T1")).toMatchObject({ status: "pending", retry_count: 1 });
  expect(proofFailureKinds(repo.rawState(), "T1")).toEqual(["declared-artifact-not-changed"]);
  return repo;
}

describe("reconcile-implementation-proof recovers a contract writer stuck on a byte-identical frozen file", () => {
  it("re-evaluates the stored failed Proof and satisfies the held file on the held-for-freeze basis", async () => {
    const repo = await stuckBeforeTheHold();

    // The Wave still holds T2 and T3 unproven, so the reconcile reports them; it commits T1 regardless.
    await reconcileImplementationProof("", ["--wave", "1"]);

    const t1 = taskOf(graphOf(repo), "T1");
    expect(t1).toMatchObject({ status: "pending", revalidation_required: true, proof: { state: "satisfied" } });
    expect(t1.proof.state === "satisfied" ? t1.proof.evidence : []).toContainEqual(HELD_ACCEPTANCE);
  });

  it("refuses, naming the path, and leaves the State File byte-identical when the frozen file cannot be read", async () => {
    if (process.getuid?.() === 0) return; // root reads through any permission
    const repo = await stuckBeforeTheHold();
    const before = readFileSync(repo.statePath);

    let result: Awaited<ReturnType<typeof reconcileImplementationProof>> | undefined;
    const absolute = join(repo.root, TS_CONTRACT.acceptance);
    chmodSync(absolute, 0o000);
    try {
      result = await reconcileImplementationProof("", ["--wave", "1"]);
    } finally {
      chmodSync(absolute, 0o644);
    }

    // A frozen path is always in its writer's file_list, so the declared-artifact
    // snapshot is the first reader to refuse it; the contract observation never decides.
    expect(result).toMatchObject({ kind: "error" });
    expect(result?.kind === "error" ? result.message : "").toContain("reconcile-implementation-proof failed without changing state");
    expect(result?.kind === "error" ? result.message : "").toContain(TS_CONTRACT.acceptance);
    expect(readFileSync(repo.statePath).equals(before)).toBe(true);
    expect(proofFailureKinds(repo.rawState(), "T1")).toEqual(["declared-artifact-not-changed"]);
  });
});

describe("the exact settlement when a contract writer's frozen path cannot be read", () => {
  it("blocks as infrastructure naming the contract observation and the path, consuming no semantic attempt", async () => {
    if (process.getuid?.() === 0) return; // root reads through any permission
    const { repo, attempt } = await refreezing();
    const absolute = join(repo.root, TS_CONTRACT.acceptance);
    const observedAt = parseIsoInstant(new Date().toISOString(), "fixture settlement instant");
    if (!observedAt.ok) throw new Error(observedAt.error.errors.join("; "));
    const production = productionExactSettlementPorts(repo.root, repo.statePath);
    // The file turns unreadable after the attempt's bytes were observed and
    // before the contract observation reads it: only that observation can fail.
    const ports: ExactImplementationSettlementPorts = {
      ...production,
      newTests: {
        collect: (args) => {
          const collected = production.newTests.collect(args);
          chmodSync(absolute, 0o000);
          return collected;
        },
      },
    };

    let settled: ExactImplementationSettlement;
    try {
      settled = await managerOf(repo).updateAndReturn((state) => {
        const settlement = settleExactImplementation(state, {
          transport: "Claude",
          authority: attempt,
          observedAt: observedAt.value,
          parserModifiedPaths: [TS_CONTRACT.types],
          parserPathLabel: "unreadable frozen path result paths",
          taskCompleted: true,
          test: { result: { verdict: "trusted-pass" }, evidence: "unreadable frozen path pass" },
          proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
          ledger: { kind: "read", events: [] },
        }, ports);
        return { state: settlement.application.state, value: settlement };
      });
    } finally {
      chmodSync(absolute, 0o644);
    }

    expect(settled.infrastructureReason).toContain("Claude contract conformance and freeze-hold observation unavailable");
    expect(settled.infrastructureReason).toContain(TS_CONTRACT.acceptance);
    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "infrastructure-blocked" } });
    if (settled.application.kind !== "applied") return;
    expect(settled.application.transition.receipt).toMatchObject({
      transition: "infrastructure-blocked",
      consumesSemanticAttempt: false,
      failureKinds: ["implementation-observation-unavailable"],
    });
    const stored = storedTask(repo.rawState(), "T1");
    expect(stored.status).toBe("pending");
    expect(stored.retry_count).toBeUndefined();
    expect(stored.active_implementation_attempt).toBeUndefined();
  });
});
