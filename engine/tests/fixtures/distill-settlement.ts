/**
 * What every Distill Task settlement suite reads and builds the same way
 * (ADR-0068 §5): the transport facts of a settlement, the basis a settled
 * Distill Task recorded, the snapshot refs a repository holds, and a snapshot
 * store that must not be asked.
 */
import type { DistillSnapshotPort } from "../../src/core/distill-snapshot";
import { parseIsoInstant, type ImplementationAttemptAuthority } from "../../src/core/implementation-completion";
import { TRUSTED_LEDGER_ONLY_POLICY, type BehaviourPreservedBasis } from "../../src/core/proof-obligations";
import type { ExactImplementationTransportFacts } from "../../src/handlers/helpers/exact-implementation-settlement";
import type { Task, TaskTestResult } from "../../src/types";
import { gitResult } from "./git-repository";
import { value } from "./parse-result";

/**
 * The facts a transport hands the exact settlement for `authority`'s attempt:
 * the Claude transport, completed, under the ledger-only policy, with an empty
 * epoch, observed now. `overrides` replace any fact.
 */
export function settlementFacts(
  authority: ImplementationAttemptAuthority,
  testResult: TaskTestResult,
  parserModifiedPaths: readonly string[],
  overrides: Partial<ExactImplementationTransportFacts> = {},
): ExactImplementationTransportFacts {
  return {
    transport: "Claude",
    authority,
    observedAt: value(parseIsoInstant(new Date().toISOString(), "fixture settlement instant")),
    parserModifiedPaths,
    parserPathLabel: "fixture result paths",
    taskCompleted: true,
    testResult,
    testEvidence: "fixture evidence",
    proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
    ledger: { kind: "read", events: [] },
    ...overrides,
  };
}

/** The basis a settled Distill Task's `behaviour-preserved` evidence recorded, if it is satisfied. */
export function behaviourPreservedBasis(task: Task): BehaviourPreservedBasis | undefined {
  if (task.proof === undefined || task.proof.state === "pending") return undefined;
  return task.proof.results.flatMap((result) =>
    result.state === "satisfied" && result.evidence.kind === "behaviour-preserved" ? [result.evidence.basis] : [])[0];
}

/** Every Distill snapshot ref the repository at `root` holds. */
export const distillSnapshotRefs = (root: string): readonly string[] =>
  gitResult(root, ["for-each-ref", "--format=%(refname)", "refs/loom/distill"]).stdout.trim().split("\n").filter((ref) => ref !== "");

/** A snapshot store no operation may reach: each call fails the test that made it. */
export const REFUSING_DISTILL_SNAPSHOTS: DistillSnapshotPort = Object.freeze({
  capture: () => { throw new Error("capture must not be called"); },
  restore: () => { throw new Error("restore must not be called"); },
  discard: () => { throw new Error("discard must not be called"); },
});
