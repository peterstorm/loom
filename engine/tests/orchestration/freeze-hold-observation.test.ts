/**
 * The frozen paths a contract writer holds (ADR-0104): `writerFrozenPaths`
 * names the paths of the contracts a Task writes, and `observeHeldForFreeze`
 * reads each without following a link. Exercised on the skeleton fixture
 * repository, whose CT-1, CT-2 and CT-3 are written by T1, T2 and T3.
 */
import { chmodSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writerFrozenPaths } from "../../src/core/acceptance-contract";
import { observeHeldForFreeze } from "../../src/orchestration/freeze-hold-observation";
import type { Task, TaskGraph } from "../../src/types";
import {
  authorityOf,
  cleanupSkeletonRepos,
  graphOf,
  JAVA_CONTRACT,
  proofFailureKinds,
  registered,
  settleAttempt,
  skeletonRepo,
  TS_CONTRACT,
  TS_TYPES_TEXT,
} from "../fixtures/skeleton-repo";

afterEach(cleanupSkeletonRepos);

const taskOf = (graph: TaskGraph, id: string): Task => {
  const task = graph.tasks.find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`fixture: no Task ${id}`);
  return task;
};

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

describe("observeHeldForFreeze", () => {
  it("holds every present frozen path of the Task's own contracts, and only those", () => {
    const repo = skeletonRepo();
    const graph = graphOf(repo);
    expect(observeHeldForFreeze(repo.root, graph, taskOf(graph, "T1"))).toEqual({
      ok: true,
      value: [
        { artifact: TS_CONTRACT.types, contract: "CT-1" },
        { artifact: TS_CONTRACT.acceptance, contract: "CT-1" },
      ],
    });
    const t2 = observeHeldForFreeze(repo.root, graph, taskOf(graph, "T2"));
    expect(t2.ok && t2.value.map(({ contract }) => contract)).toEqual(["CT-2", "CT-2"]);
    expect(t2.ok && t2.value.map(({ artifact }) => artifact)).toEqual([JAVA_CONTRACT.types, JAVA_CONTRACT.acceptance]);
  });

  it("holds nothing for a Task that writes no contract, reading nothing (an unresolvable root is never touched)", () => {
    const repo = skeletonRepo();
    const graph = graphOf(repo);
    expect(observeHeldForFreeze(join(repo.root, "no-such-root"), graph, taskOf(graph, "T4"))).toEqual({ ok: true, value: [] });
  });

  it("does not hold a missing frozen path", () => {
    const repo = skeletonRepo();
    repo.remove(TS_CONTRACT.acceptance);
    const graph = graphOf(repo);
    expect(observeHeldForFreeze(repo.root, graph, taskOf(graph, "T1"))).toEqual({
      ok: true,
      value: [{ artifact: TS_CONTRACT.types, contract: "CT-1" }],
    });
  });

  it("does not hold a frozen path that is a link or a directory", () => {
    const repo = skeletonRepo();
    const target = join(repo.root, "elsewhere.ts");
    repo.write("elsewhere.ts", repo.read(TS_CONTRACT.acceptance) ?? "");
    rmSync(join(repo.root, TS_CONTRACT.acceptance));
    symlinkSync(target, join(repo.root, TS_CONTRACT.acceptance));
    rmSync(join(repo.root, TS_CONTRACT.types));
    mkdirSync(join(repo.root, TS_CONTRACT.types));
    const graph = graphOf(repo);
    expect(observeHeldForFreeze(repo.root, graph, taskOf(graph, "T1"))).toEqual({ ok: true, value: [] });
  });

  it("reports a path it cannot observe as an infrastructure failure naming it", () => {
    if (process.getuid?.() === 0) return; // root reads through any permission
    const repo = skeletonRepo();
    const graph = graphOf(repo);
    const directory = join(repo.root, "tests");
    chmodSync(directory, 0o000);
    try {
      const observed = observeHeldForFreeze(repo.root, graph, taskOf(graph, "T1"));
      expect(observed).toMatchObject({ ok: false, error: expect.stringContaining(TS_CONTRACT.acceptance) });
    } finally {
      chmodSync(directory, 0o755);
    }
  });

  it("reports an unresolvable repository root for a contract writer", () => {
    const repo = skeletonRepo();
    const graph = graphOf(repo);
    expect(observeHeldForFreeze(join(repo.root, "no-such-root"), graph, taskOf(graph, "T1")))
      .toMatchObject({ ok: false, error: expect.stringContaining("cannot resolve the repository root") });
  });
});

describe("the exact settlement of a contract writer re-freezing a revised contract", () => {
  /** The contract Wave with CT-1's sources already written and committed, as a
   *  revision finds them (less `absent`): T1 is registered against those very bytes. */
  async function refreezing(absent: readonly string[] = []) {
    const repo = skeletonRepo({ stage: "contract-wave" });
    repo.writeContractSources();
    for (const path of absent) repo.remove(path);
    repo.commit("CT-1 sources before the revision");
    const attempt = authorityOf(await registered(repo, "T1"), "T1");
    // The revision changes the types file; the acceptance file is already right.
    const revisedTypes = `${TS_TYPES_TEXT}export type Currency = "EUR" | "DKK";\n`;
    repo.write(TS_CONTRACT.types, revisedTypes);
    return { repo, attempt };
  }

  it("settles implemented with the byte-identical acceptance file held for CT-1's freeze", async () => {
    const { repo, attempt } = await refreezing();

    const settled = await settleAttempt(repo, attempt, [TS_CONTRACT.types]);

    expect(settled.infrastructureReason).toBeUndefined();
    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    const t1 = taskOf(graphOf(repo), "T1");
    expect(t1.status).toBe("implemented");
    expect(t1.proof.state === "satisfied" ? t1.proof.evidence : []).toEqual(expect.arrayContaining([
      { kind: "declared-artifact-changed", artifact: TS_CONTRACT.types },
      { kind: "declared-artifact-changed", artifact: TS_CONTRACT.acceptance, basis: { kind: "held-for-freeze", contract: "CT-1" } },
    ]));
  });

  it("still fails a writer that never creates its frozen acceptance file: absence is never held", async () => {
    const { repo, attempt } = await refreezing([TS_CONTRACT.acceptance]);

    const settled = await settleAttempt(repo, attempt, [TS_CONTRACT.types]);

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "retry-required" } });
    expect(proofFailureKinds(repo.rawState(), "T1")).toEqual(["declared-artifact-not-changed"]);
  });
});
