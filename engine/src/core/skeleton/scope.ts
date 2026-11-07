/**
 * The conformance scope (AD-11, INV-5 owner): whether a Task owes the
 * signature or ADT check, over which of its files, against which contracts.
 * Every caller that decides it — the settlement observation and the brief's
 * duty section — calls `conformanceScope`. Pure.
 *
 * - **Pre-G2.** A graph with no `export_bindings` stamp was populated before
 *   G2 and owes nothing (`pre-g2-graph`): its frozen ADTs are not checked
 *   retroactively (AD-14). A stamp that binds nothing (`[]`) is a G2 graph.
 * - **Exempt.** An attested Task, or one whose regression is waived as
 *   `documentation-only` or `generated-artifact`, owes nothing (FR-019).
 *   Every other waiver still owes: there are no new waivers (FR-020).
 * - **Contracts.** Those the Task binds (a binding on one of its candidate
 *   files: production files that are no frozen path) or claims, that have a
 *   types file and whose freeze is `frozen` or `revised`. A binding on a
 *   test file or a frozen path never brings a contract into scope. A contract
 *   still `awaiting-red` has no frozen surface to check against, and a
 *   `Types file: none` contract has none at all.
 * - **Files.** The Task's candidate files that `skeletonLanguageOf` parses
 *   to a supported target and that some check applies to: the signature
 *   check to the Task's bound files, the ADT check to files of an in-scope
 *   types file's language.
 *   Files that existed at Wave start are checked like any other (FR-018).
 */

import { contractRole, frozenPaths, type AcceptanceContract } from "../acceptance-contract";
import { isNonEmpty, type NonEmpty } from "../orchestration-contract";
import { normalizePlanPath, samePlanPath } from "../plan-path-match";
import { taskVerificationPolicy, type RegressionWaiverReason } from "../verification-policy";
import type { Task, TaskGraph } from "../../types";
import { productionFiles } from "./graph-view";
import { skeletonLanguageOf } from "./language";
import type { ExportBinding, SkeletonLanguage, SkeletonTarget } from "./types";

/** Why a Task owes no conformance check. */
export type ConformanceNotOwedReason =
  | "pre-g2-graph"
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
  const stamp = graph.export_bindings;
  if (stamp === undefined) return notOwed("pre-g2-graph");
  const exempt = exemption(task);
  if (exempt !== null) return notOwed(exempt);
  const contracts = graph.acceptance_contracts ?? [];
  const frozen = new Set(contracts.flatMap((contract) => frozenPaths(contract)).map(normalizePlanPath));
  const candidates = productionFiles(graph, task).filter((path) => !frozen.has(normalizePlanPath(path)));
  const held = stamp.filter((binding) => candidates.some((path) => samePlanPath(path, binding.path)));
  const inScope = frozenTypesContracts(contracts).filter(({ contract }) =>
    held.some((binding) => binding.contract === contract.id) || contractRole(contract, task, graph.tasks).kind === "claimant");
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
