/**
 * Shell for the engine-rendered implementation brief: reads the protected
 * graph, the Spec Index, the active Loom package's binding rules and brief
 * template, then delegates every decision to the pure renderer. Shared by the
 * `helper orchestration brief` CLI and the Pi extension's brief-marker
 * expansion, so both harnesses spawn byte-identical briefs.
 *
 * The brief's Frozen Signatures section reads the skeleton paths through
 * `observeSkeletons` (`skeleton-observation.ts`), the observation
 * `helper orchestration status` reads too, so the two observe a path the same
 * way. A brief is refused while the plan's export bindings have drifted from
 * the TaskGraph stamp, because its frozen duties would then come from
 * bindings the plan no longer holds.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { observeTaskGraphProjectBoundary } from "../config";
import {
  invariantOwnershipSourceOf,
  renderImplementationBrief,
  ruleDocumentsFor,
  type FrozenSignaturesInput,
  type ImplementationBrief,
  type ImplementationBriefRequest,
  type RuleDocument,
} from "../core/implementation-brief";
import type { DomainResult } from "../core/orchestration-contract";
import { bindingStampAgreement } from "../core/skeleton/bindings";
import type { SkeletonGraph } from "../core/skeleton/graph-view";
import { deriveTaskImplementationDispatch } from "../core/task-implementation-dispatch";
import { taskOwnerDuty } from "../core/owner-verification/obligations";
import { parsePlanExportBindings, parsePlanModels } from "../core/parse-plan-models";
import { StateManager } from "../state-manager";
import type { PlanInvariant, Task, TaskGraph } from "../types";
import { observeSkeletons } from "./skeleton-observation";
import { observeSpecIndex } from "./spec-index-observation";

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
