/**
 * Infrastructure failure of the contract conformance observation (AD-5) at
 * both proof-evaluating settlement paths. When the observation cannot read
 * what it judges — a frozen types file that is now a link, or that no longer
 * parses as a types surface — the result is never a semantic verdict:
 *
 * - `settleExactImplementation` settles `infrastructure-blocked` with an
 *   `implementation-observation-unavailable` failure, consuming no semantic
 *   attempt;
 * - `reconcile-implementation-proof` refuses with "cannot observe contract
 *   conformance" and leaves the State File byte-identical.
 */
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseIsoInstant } from "../../../src/core/implementation-completion";
import { TRUSTED_LEDGER_ONLY_POLICY } from "../../../src/core/proof-obligations";
import {
  productionExactSettlementPorts,
  settleExactImplementation,
  type ExactImplementationSettlement,
} from "../../../src/handlers/helpers/exact-implementation-settlement";
import reconcileImplementationProof from "../../../src/handlers/helpers/reconcile-implementation-proof";
import { registerTaskExecutionBatch } from "../../../src/handlers/task-execution";
import { StateManager } from "../../../src/state-manager";
import {
  cleanupSkeletonRepos,
  skeletonRepo,
  spawnFor,
  storedTask,
  TS_CONTRACT,
  type SkeletonRepo,
} from "../../fixtures/skeleton-repo";

afterEach(cleanupSkeletonRepos);

/** Each way the frozen CT-1 types file stops reading as a types surface. */
const BREAKAGES: readonly (readonly [string, (repo: SkeletonRepo) => void, string])[] = [
  [
    "a link in place of the types file",
    (repo) => {
      const target = join(repo.root, "outside-types.ts");
      writeFileSync(target, repo.read(TS_CONTRACT.types) ?? "");
      rmSync(join(repo.root, TS_CONTRACT.types));
      symlinkSync(target, join(repo.root, TS_CONTRACT.types));
    },
    "unreadable",
  ],
  [
    "a types file that no longer parses",
    (repo) => repo.write(TS_CONTRACT.types, "export type Order = ;\nexport type = {\n"),
    "cannot be read as a types surface",
  ],
];

/** Register T4's attempt, break the types file, then settle it as the Claude stop does. */
async function settleBrokenT4(break_: (repo: SkeletonRepo) => void): Promise<Readonly<{ repo: SkeletonRepo; settled: ExactImplementationSettlement }>> {
  const repo = skeletonRepo();
  const registration = await registerTaskExecutionBatch([spawnFor(repo.rawState(), "T4")]);
  if (registration.kind !== "registered") throw new Error(`registration refused: ${registration.message}`);
  const [authority] = registration.authorities;
  if (authority === undefined) throw new Error("no T4 authority");
  break_(repo);
  const observedAt = parseIsoInstant(new Date().toISOString(), "settlement instant");
  if (!observedAt.ok) throw new Error(observedAt.error.errors.join("; "));
  const manager = StateManager.fromPath(repo.statePath);
  if (manager === null) throw new Error("no State File");
  let settled: ExactImplementationSettlement | undefined;
  await manager.update((state) => {
    settled = settleExactImplementation(state, {
      transport: "Claude",
      authority,
      observedAt: observedAt.value,
      parserModifiedPaths: [],
      parserPathLabel: "conformance failure result paths",
      taskCompleted: true,
      testResult: { verdict: "trusted-pass" },
      testEvidence: "conformance failure pass",
      proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
      ledger: { kind: "read", events: [] },
    }, productionExactSettlementPorts(repo.root, repo.statePath));
    return settled.application.state;
  });
  if (settled === undefined) throw new Error("settlement did not run");
  return { repo, settled };
}

describe("settleExactImplementation when contract conformance cannot be observed", () => {
  it.each(BREAKAGES)("settles %s as infrastructure, consuming no semantic attempt", async (_name, break_, detail) => {
    const { repo, settled } = await settleBrokenT4(break_);

    expect(settled.infrastructureReason).toContain("Claude contract conformance observation unavailable");
    expect(settled.infrastructureReason).toContain(TS_CONTRACT.types);
    expect(settled.infrastructureReason).toContain(detail);
    expect(settled.application.kind).toBe("applied");
    if (settled.application.kind !== "applied") return;
    const { transition } = settled.application;
    expect(transition.kind).toBe("infrastructure-blocked");
    if (transition.kind !== "infrastructure-blocked") return;
    expect(transition.failures.map(({ kind }) => kind)).toEqual(["implementation-observation-unavailable"]);
    expect(transition.receipt).toMatchObject({
      transition: "infrastructure-blocked",
      consumesSemanticAttempt: false,
      semanticAttempt: 1,
      failureKinds: ["implementation-observation-unavailable"],
    });

    const stored = storedTask(repo.rawState(), "T4");
    expect(stored.status).toBe("pending");
    expect(stored.retry_count).toBeUndefined();
    expect(stored.active_implementation_attempt).toBeUndefined();
    // The next dispatch is still a first attempt: no retry appendix is owed.
    expect(spawnFor(repo.rawState(), "T4")).toMatchObject({ kind: "implementation", prompt: "Task ID: T4" });
  });
});

describe("reconcile-implementation-proof when contract conformance cannot be observed", () => {
  it.each(BREAKAGES)("refuses %s and leaves the State File unchanged", async (_name, break_, detail) => {
    const repo = skeletonRepo();
    break_(repo);
    const before = readFileSync(repo.statePath);

    const result = await reconcileImplementationProof("", ["--wave", "2"]);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("reconcile-implementation-proof failed without changing state");
    expect(result.message).toContain("cannot observe contract conformance for T4");
    expect(result.message).toContain(TS_CONTRACT.types);
    expect(result.message).toContain(detail);
    expect(readFileSync(repo.statePath).equals(before)).toBe(true);
  });
});
