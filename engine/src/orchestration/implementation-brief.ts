/**
 * Shell for the engine-rendered implementation brief: reads the protected
 * graph, the Spec Index, the active Loom package's binding rules and brief
 * template, then delegates every decision to the pure renderer. Shared by the
 * `helper orchestration brief` CLI and the Pi extension's brief-marker
 * expansion, so both harnesses spawn byte-identical briefs.
 *
 * It also owns the skeleton observation (G2 AD-13) that the brief's Frozen
 * Signatures section and `helper orchestration status` both read, so the two
 * observe a path the same way: `observeSkeletons`. A brief is refused while
 * the plan's export bindings have drifted from the TaskGraph stamp, because
 * its frozen duties would then come from bindings the plan no longer holds.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { observeTaskGraphProjectBoundary } from "../config";
import { contractRole } from "../core/acceptance-contract";
import {
  invariantOwnershipSourceOf,
  renderImplementationBrief,
  ruleDocumentsFor,
  type FrozenSignaturesInput,
  type ImplementationBrief,
  type ImplementationBriefRequest,
  type RuleDocument,
} from "../core/implementation-brief";
import { isNonEmpty, type DomainResult } from "../core/orchestration-contract";
import { normalizePlanPath, samePlanPath } from "../core/plan-path-match";
import { bindingStampAgreement } from "../core/skeleton/bindings";
import { productionFiles, type SkeletonGraph } from "../core/skeleton/scope";
import type { SkeletonProblem } from "../core/contract-revision";
import type { UnresolvedSkeletonBinding } from "../core/skeleton/status";
import type { ExportBinding, FrozenSurface, PathObservation } from "../core/skeleton/types";
import { deriveTaskImplementationDispatch } from "../core/task-implementation-dispatch";
import { taskOwnerDuty } from "../core/owner-verification/obligations";
import { parsePlanExportBindings, parsePlanModels } from "../core/parse-plan-models";
import { StateManager } from "../state-manager";
import type { PlanInvariant, Task, TaskGraph } from "../types";
import {
  canonicalContractSkeletons,
  observeSkeletonPaths,
  renderSkeletonProblem,
} from "./contract-stub-materialization";
import { observeFrozenSurface, typedContract, type TypedContract } from "./frozen-surface-observation";
import { renderResolutionProblem } from "./skeleton-materialization";
import { observeSpecIndex } from "./spec-index-observation";

// ---------------------------------------------------------------------------
// The skeleton observation, shared with `helper orchestration status`
// ---------------------------------------------------------------------------

/**
 * What is on disk for some Tasks' skeletons: each production path, absent or
 * present with its digest and its canonical skeleton's; each relevant
 * contract's frozen surface as its freeze stamps it, or the line naming why
 * it could not be read; and every stage-two problem of the resolving Tasks'
 * bindings, exactly as registration would meet them.
 */
export type SkeletonObservation = Readonly<{
  observations: ReadonlyMap<string, PathObservation>;
  surfaces: ReadonlyMap<string, DomainResult<FrozenSurface, string>>;
  unresolved: readonly UnresolvedSkeletonBinding[];
}>;

const NOTHING_OBSERVED: SkeletonObservation = Object.freeze({
  observations: new Map(),
  surfaces: new Map(),
  unresolved: Object.freeze([]),
});

/** The contracts whose frozen surface matters: those the resolving Tasks bind, then those any observed Task claims. */
function relevantContractIds(graph: SkeletonGraph, observed: readonly Task[], heldContracts: readonly string[]): readonly string[] {
  const claimed = (graph.acceptance_contracts ?? []).filter((contract) =>
    observed.some((task) => contractRole(contract, task, graph.tasks).kind === "claimant")).map(({ id }) => id);
  return [...new Set([...heldContracts, ...claimed])];
}

/**
 * Observe the skeletons of `observed`, resolving the bindings of `resolving`
 * (the Tasks a spawn would register). Each contract a resolving Task binds is
 * read in `stamped` mode, as registration reads it, so a drifted or
 * unparseable types file is the problem registration would refuse with; a
 * contract that resolves gets canonical skeletons (`canonicalContractSkeletons`)
 * and every per-binding problem. A contract still `awaiting-red` has no frozen
 * surface yet and is skipped. A TaskGraph populated before export bindings
 * were stamped writes no skeletons, so nothing is read. An unreadable path or
 * repository root is the error.
 */
export function observeSkeletons(
  root: string,
  graph: TaskGraph,
  observed: readonly Task[],
  resolving: readonly Task[],
): DomainResult<SkeletonObservation, string> {
  const view: SkeletonGraph = graph;
  if (view.export_bindings === undefined) return { ok: true, value: NOTHING_OBSERVED };
  const resolvingPaths = resolving.flatMap((task) => productionFiles(view, task));
  const held = view.export_bindings.filter((binding) => resolvingPaths.some((path) => samePlanPath(path, binding.path)));
  const contracts = relevantContractIds(view, observed, held.map(({ contract }) => contract)).flatMap((id) => {
    const found = (view.acceptance_contracts ?? []).find((contract) => contract.id === id);
    const typed = found === undefined ? null : typedContract(found);
    return typed === null || typed.freeze.state === "awaiting-red" ? [] : [typed];
  });
  const read = contracts.map((contract) =>
    observeContract(root, contract, held.filter((binding) => binding.contract === contract.id)));
  const failed = read.flatMap((result) => (result.ok ? [] : [result.error]));
  if (isNonEmpty(failed)) return { ok: false, error: failed.join("; ") };
  const observedContracts = read.flatMap((result) => (result.ok ? [result.value] : []));
  const canonical = new Map(observedContracts.flatMap(({ canonical: digests }) => digests));
  const paths = [...new Set(observed.flatMap((task) => productionFiles(view, task)))];
  const present = observeSkeletonPaths(root, paths, (path) => canonical.get(normalizePlanPath(path)) ?? null);
  if (!present.ok) return present;
  if (isNonEmpty(present.value.problems)) return { ok: false, error: present.value.problems.map(renderSkeletonProblem).join("; ") };
  return {
    ok: true,
    value: Object.freeze({
      observations: present.value.observations,
      surfaces: new Map(observedContracts.map(({ id, surface }) => [id, surface] as const)),
      unresolved: Object.freeze(observedContracts.flatMap(({ unresolved }) => unresolved)),
    }),
  };
}

/** What one contract contributes: its surface, its bound paths' canonical digests, and its stage-two problems. */
type ContractObservation = Readonly<{
  id: string;
  surface: DomainResult<FrozenSurface, string>;
  canonical: readonly (readonly [string, string])[];
  unresolved: readonly UnresolvedSkeletonBinding[];
}>;

/**
 * One contract's frozen surface in `stamped` mode, and — when a resolving Task
 * binds it — the canonical skeletons and problems of those `bindings`. A
 * surface that cannot be read is that contract's one problem; failing to read
 * its acceptance files for the specifier style is the error.
 */
function observeContract(root: string, contract: TypedContract, bindings: readonly ExportBinding[]): DomainResult<ContractObservation, string> {
  const stamped = observeFrozenSurface(root, contract, "stamped");
  const unresolvedOf = (problem: SkeletonProblem): UnresolvedSkeletonBinding => Object.freeze({ problem, message: renderSkeletonProblem(problem) });
  if (!stamped.ok) {
    const unreadable: ContractObservation = {
      id: contract.id,
      surface: { ok: false, error: renderResolutionProblem(stamped.error) },
      canonical: [],
      unresolved: bindings.length === 0 ? [] : [unresolvedOf(stamped.error)],
    };
    return { ok: true, value: Object.freeze(unreadable) };
  }
  if (bindings.length === 0) return { ok: true, value: Object.freeze({ id: contract.id, surface: stamped, canonical: [], unresolved: [] }) };
  const generated = canonicalContractSkeletons(root, contract, bindings);
  if (!generated.ok) return generated;
  return {
    ok: true,
    value: Object.freeze({
      id: contract.id,
      surface: stamped,
      canonical: generated.value.candidates.map(({ skeleton }) => [normalizePlanPath(skeleton.path), skeleton.sha256] as const),
      unresolved: generated.value.problems.map(unresolvedOf),
    }),
  };
}

/**
 * Whether the recorded plan's export bindings still agree with the TaskGraph
 * stamp (`bindingStampAgreement`). A graph with no stamp, or no recorded
 * plan, has nothing to drift from; a plan that cannot be read refuses.
 */
function bindingStampDrift(graph: SkeletonGraph, planFile: string | null): DomainResult<null, string> {
  if (graph.export_bindings === undefined || planFile === null) return { ok: true, value: null };
  let text: string;
  try {
    text = readFileSync(planFile, "utf8");
  } catch (error) {
    return { ok: false, error: `cannot read the plan ${planFile} for its export bindings: ${error instanceof Error ? error.message : String(error)}` };
  }
  return bindingStampAgreement(parsePlanExportBindings(text).bindings, graph.export_bindings);
}

/** The brief's Frozen Signatures observation of one Task, or why it cannot be made. */
function frozenSignaturesOf(projectRoot: string, graph: TaskGraph, task: Task, planFile: string | null): DomainResult<FrozenSignaturesInput, string> {
  const drift = bindingStampDrift(graph, planFile);
  if (!drift.ok) return drift;
  const observed = observeSkeletons(projectRoot, graph, [task], [task]);
  if (!observed.ok) return { ok: false, error: `cannot observe its skeleton paths: ${observed.error}` };
  return { ok: true, value: Object.freeze({ graph, ...observed.value }) };
}

/** The brief template, relative to the active Loom package root. */
export const IMPLEMENTATION_BRIEF_TEMPLATE = join("commands", "templates", "impl-agent-context.md");

/**
 * The invariants the recorded plan declares; none when the graph records no
 * plan. Plan population validated the plan, so one that cannot be read now
 * refuses the brief rather than silently dropping its invariant ownership.
 */
function planInvariants(planFile: string | null): DomainResult<readonly PlanInvariant[], string> {
  if (planFile === null) return { ok: true, value: [] };
  try {
    return { ok: true, value: parsePlanModels(readFileSync(planFile, "utf8")).invariants };
  } catch (error) {
    return { ok: false, error: `cannot read the plan ${planFile} for its invariant ownership: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Render the brief `request` asks for (its Task of the graph at `graphPath`,
 * with its operator notes), using the binding rules and template of the Loom
 * package at `packageRoot`. Refusals name the exact cause; nothing here writes.
 */
export function renderTaskImplementationBrief(
  graphPath: string,
  packageRoot: string,
  request: ImplementationBriefRequest,
): DomainResult<ImplementationBrief, string> {
  const { taskId } = request;
  try {
    const graph = new StateManager(graphPath).load();
    const task = graph.tasks.find(({ id }) => id === taskId);
    if (task === undefined) return { ok: false, error: `Task ${taskId} is not in the TaskGraph at ${graphPath}` };
    // A reopened Task (helper orchestration reopen-task) is `pending` again and
    // renders like any other owed dispatch.
    if (task.status === "implemented") {
      return {
        ok: false,
        error: `Task ${taskId} is implemented; it is owed no implementation dispatch until it is reopened ` +
          `(abandon the Wave Gate run, then helper orchestration reopen-task --wave ${task.wave} --task ${taskId} --reason "<why>")`,
      };
    }
    if (task.status === "completed") {
      return { ok: false, error: `Task ${taskId} is completed; it is owed no implementation dispatch` };
    }
    const derivation = deriveTaskImplementationDispatch(task);
    if (derivation.kind === "escalated") {
      return { ok: false, error: `Task ${taskId} reached terminal implementation escalation (${derivation.failureKinds.join(", ")}); it is owed no dispatch` };
    }
    if (derivation.kind === "invalid-retry") {
      return { ok: false, error: `Task ${taskId} has invalid implementation retry authority: ${derivation.errors.join("; ")}` };
    }
    if (derivation.kind === "invalid-attestation") {
      return { ok: false, error: `Task ${taskId} cannot derive its attestation context: ${derivation.error}` };
    }
    const projectRoot = observeTaskGraphProjectBoundary(graphPath).root;
    const inProject = (path: string | null | undefined): string | null =>
      path === null || path === undefined ? null : isAbsolute(path) ? path : resolve(projectRoot, path);
    const specFile = inProject(graph.spec_file);
    const planFile = inProject(graph.plan_file);
    // A stamped graph needs no plan read; a pre-feature one (plan AD-10: owed no owner duty) renders the plan's Invariants.
    const ownership = invariantOwnershipSourceOf(taskOwnerDuty(graph, task.file_list ?? []), () => planInvariants(planFile));
    if (!ownership.ok) return { ok: false, error: `Task ${taskId}: ${ownership.error}` };
    const frozenSignatures = frozenSignaturesOf(projectRoot, graph, task, planFile);
    if (!frozenSignatures.ok) return { ok: false, error: `Task ${taskId}: ${frozenSignatures.error}` };
    const rules = new Map<RuleDocument, string>(ruleDocumentsFor(task.file_list ?? []).map((name) =>
      [name, readFileSync(join(packageRoot, "rules", name), "utf8")] as const));
    const rendered = renderImplementationBrief({
      template: readFileSync(join(packageRoot, IMPLEMENTATION_BRIEF_TEMPLATE), "utf8"),
      task,
      dispatch: derivation.dispatch,
      planFile: graph.plan_file ?? null,
      spec: observeSpecIndex(specFile),
      rules,
      roster: graph.tasks,
      ownership: ownership.value,
      contracts: graph.acceptance_contracts ?? [],
      verificationManifest: graph.verification_manifest,
      repositoryRoot: projectRoot,
      operatorNotes: request.operatorNotes,
      frozenSignatures: frozenSignatures.value,
    });
    return rendered.ok ? rendered : { ok: false, error: rendered.error.message };
  } catch (error) {
    return { ok: false, error: `cannot render Task ${taskId}'s implementation brief: ${error instanceof Error ? error.message : String(error)}` };
  }
}
