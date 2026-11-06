/**
 * The conformance scope (AD-11, INV-5 owner): whether a Task owes the
 * signature or ADT check, over which of its files, against which contracts.
 * Every caller that decides it — the settlement observation and the brief's
 * duty section — calls `conformanceScope`. Pure.
 *
 * - **Exempt.** An attested Task, or one whose regression is waived as
 *   `documentation-only` or `generated-artifact`, owes nothing (FR-019).
 *   Every other waiver still owes: there are no new waivers (FR-020).
 * - **Contracts.** Those the Task binds (a binding on one of its files) or
 *   claims, that have a types file and whose freeze is `frozen` or `revised`.
 *   A contract still `awaiting-red` has no frozen surface to check against,
 *   and a `Types file: none` contract has none at all.
 * - **Files.** The Task's production files (`productionFiles`), never a
 *   frozen path, that `skeletonLanguageOf` parses to a supported target and
 *   that some check applies to: the signature check to the Task's bound
 *   files, the ADT check to files of an in-scope types file's language.
 *   Files that existed at Wave start are checked like any other (FR-018).
 */

import { contractRole, frozenPaths, type AcceptanceContract } from "../acceptance-contract";
import { isNonEmpty, type NonEmpty } from "../orchestration-contract";
import { normalizePlanPath, samePlanPath } from "../plan-path-match";
import { frozenRedThenGreenEra } from "../proof-obligations";
import { classifyTaskFiles, ENGINE_DEFAULT_TEST_FILES } from "../test-file-classification";
import { taskVerificationPolicy, type RegressionWaiverReason } from "../verification-policy";
import type { Task, TaskGraph } from "../../types";
import { skeletonLanguageOf } from "./language";
import type { ExportBinding, SkeletonLanguage, SkeletonRecord, SkeletonTarget } from "./types";

/**
 * The TaskGraph with the G2 fields AD-4 persists: the bindings stamped at
 * population, and the engine-written skeleton records. Optional, because a
 * graph populated before G2 carries neither. Every `TaskGraph` is one, so
 * the skeleton core reads these through this view rather than a cast.
 */
export type SkeletonGraph = TaskGraph & Readonly<{
  export_bindings?: readonly ExportBinding[];
  skeletons?: readonly SkeletonRecord[];
}>;

/** Why a Task owes no conformance check. */
export type ConformanceNotOwedReason =
  | "attested"
  | "documentation-only"
  | "generated-artifact"
  | "no-frozen-contract"
  | "no-file-in-scope";

export type ConformanceScope =
  | Readonly<{ kind: "not-owed"; reason: ConformanceNotOwedReason }>
  | Readonly<{
      kind: "owed";
      /** In-scope contracts, in graph order. */
      contracts: NonEmpty<AcceptanceContract>;
      /** The Task's bindings to those contracts, in stamp order. */
      bindings: readonly ExportBinding[];
      /** The files to judge, each parsed once, in file_list order. */
      files: NonEmpty<SkeletonTarget>;
    }>;

type ExemptWaiver = Extract<RegressionWaiverReason, "documentation-only" | "generated-artifact">;

const isExemptWaiver = (reason: RegressionWaiverReason): reason is ExemptWaiver =>
  reason === "documentation-only" || reason === "generated-artifact";

const notOwed = (reason: ConformanceNotOwedReason): ConformanceScope => Object.freeze({ kind: "not-owed", reason });

/**
 * A Task's production files: its non-test file_list paths, in file_list
 * order, under the graph's frozen test-file classification (the engine
 * default for a graph frozen before the classification existed).
 */
export function productionFiles(graph: TaskGraph, task: Task): readonly string[] {
  const era = frozenRedThenGreenEra(graph.verification_manifest);
  const testFiles = era.kind === "owed-if-new-tests" ? era.testFiles : ENGINE_DEFAULT_TEST_FILES;
  return classifyTaskFiles(task.file_list ?? [], testFiles, task.artifact_baseline).implementationFiles;
}

function exemption(task: Task): ConformanceNotOwedReason | null {
  if (task.implementation_attestation === true) return "attested";
  const regression = taskVerificationPolicy(task).regression;
  return regression.kind === "waived" && isExemptWaiver(regression.reason) ? regression.reason : null;
}

/** A contract with a frozen (or revised) types file: the only kind a check can run against. */
type FrozenTypesContract = Readonly<{ contract: AcceptanceContract; typesPath: string }>;

const frozenTypesContracts = (contracts: readonly AcceptanceContract[]): readonly FrozenTypesContract[] =>
  contracts.flatMap((contract) =>
    contract.types.kind === "file" && contract.freeze.state !== "awaiting-red" ? [{ contract, typesPath: contract.types.path }] : []);

export function conformanceScope(graph: TaskGraph, task: Task): ConformanceScope {
  const exempt = exemption(task);
  if (exempt !== null) return notOwed(exempt);
  const view: SkeletonGraph = graph;
  const contracts = view.acceptance_contracts ?? [];
  const frozen = new Set(contracts.flatMap((contract) => frozenPaths(contract)).map(normalizePlanPath));
  const candidates = productionFiles(graph, task).filter((path) => !frozen.has(normalizePlanPath(path)));
  const held = (view.export_bindings ?? []).filter((binding) => candidates.some((path) => samePlanPath(path, binding.path)));
  const inScope = frozenTypesContracts(contracts).filter(({ contract }) =>
    held.some((binding) => binding.contract === contract.id) || contractRole(contract, task, view.tasks).kind === "claimant");
  const scopedContracts = inScope.map(({ contract }) => contract);
  if (!isNonEmpty(scopedContracts)) return notOwed("no-frozen-contract");
  const bindings = Object.freeze(held.filter((binding) => scopedContracts.some(({ id }) => id === binding.contract)));
  const adtLanguages = new Set<SkeletonLanguage>(inScope.flatMap(({ typesPath }) => {
    const types = skeletonLanguageOf(typesPath);
    return types.kind === "supported" ? [types.language] : [];
  }));
  const files = candidates.flatMap((path) => {
    const target = skeletonLanguageOf(path);
    return target.kind === "supported" &&
      (adtLanguages.has(target.language) || bindings.some((binding) => samePlanPath(binding.path, path)))
      ? [target]
      : [];
  });
  if (!isNonEmpty(files)) return notOwed("no-file-in-scope");
  return Object.freeze({ kind: "owed", contracts: Object.freeze(scopedContracts), bindings, files: Object.freeze(files) });
}
