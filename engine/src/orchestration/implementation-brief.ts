/**
 * Shell for the engine-rendered implementation brief: reads the protected
 * graph, the Spec Index, the active Loom package's binding rules and brief
 * template, then delegates every decision to the pure renderer. Shared by the
 * `helper orchestration brief` CLI and the Pi extension's brief-marker
 * expansion, so both harnesses spawn byte-identical briefs.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { observeTaskGraphProjectBoundary } from "../config";
import {
  renderImplementationBrief,
  ruleDocumentsFor,
  type ImplementationBrief,
  type RuleDocument,
} from "../core/implementation-brief";
import type { DomainResult } from "../core/orchestration-contract";
import { deriveTaskImplementationDispatch } from "../core/task-implementation-dispatch";
import { StateManager } from "../state-manager";
import { observeSpecIndex } from "./spec-index-observation";

/** The brief template, relative to the active Loom package root. */
export const IMPLEMENTATION_BRIEF_TEMPLATE = join("commands", "templates", "impl-agent-context.md");

/**
 * Render the brief for one Task of the graph at `graphPath`, using the binding
 * rules and template of the Loom package at `packageRoot`. Refusals name the
 * exact cause; nothing here writes.
 */
export function renderTaskImplementationBrief(
  graphPath: string,
  packageRoot: string,
  taskId: string,
): DomainResult<ImplementationBrief, string> {
  try {
    const graph = new StateManager(graphPath).load();
    const task = graph.tasks.find(({ id }) => id === taskId);
    if (task === undefined) return { ok: false, error: `Task ${taskId} is not in the TaskGraph at ${graphPath}` };
    if (task.status === "implemented" || task.status === "completed") {
      return { ok: false, error: `Task ${taskId} is ${task.status}; it is owed no implementation dispatch` };
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
    const specFile = graph.spec_file === null || graph.spec_file === undefined
      ? null
      : isAbsolute(graph.spec_file) ? graph.spec_file : resolve(projectRoot, graph.spec_file);
    const rules = new Map<RuleDocument, string>(ruleDocumentsFor(task.file_list ?? []).map((name) =>
      [name, readFileSync(join(packageRoot, "rules", name), "utf8")] as const));
    const rendered = renderImplementationBrief({
      template: readFileSync(join(packageRoot, IMPLEMENTATION_BRIEF_TEMPLATE), "utf8"),
      task,
      dispatch: derivation.dispatch,
      planFile: graph.plan_file ?? null,
      spec: observeSpecIndex(specFile),
      rules,
    });
    return rendered.ok ? rendered : { ok: false, error: rendered.error.message };
  } catch (error) {
    return { ok: false, error: `cannot render Task ${taskId}'s implementation brief: ${error instanceof Error ? error.message : String(error)}` };
  }
}
