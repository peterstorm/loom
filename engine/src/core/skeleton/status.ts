/**
 * The skeleton report of `helper orchestration status` (AD-13, FR-040; an
 * INV-4 sibling): for every Task of the current Wave, every non-test
 * file_list path with exactly one skeleton outcome, every stale skeleton
 * record (FR-033), and every stage-two problem that keeps the Wave from
 * spawning (AS-051).
 *
 * An outcome is `recorded` when the Task's registration recorded one for the
 * path (`skeleton_outcomes`, the outcome the engine acted on), else
 * `projected`: what registration would decide now. Both come from the one
 * derivation, `skeletonOutcomesOf` — this module never compares digests and
 * never orders the outcomes itself. The implementation brief reads each
 * Task's outcomes through `taskSkeletonOutcomes` too, so status and brief
 * never disagree on a path.
 *
 * Pure: the shell observes the paths and resolves the bindings, and passes
 * both in. A stage-two problem arrives with its rendered line
 * (`renderSkeletonProblem`), so status, brief and window quote one string.
 */

import { match } from "ts-pattern";
import type { DomainResult } from "../orchestration-contract";
import { samePlanPath } from "../plan-path-match";
import type { Task, TaskGraph } from "../../types";
import { renderSkeletonOutcome, skeletonOutcomesOf } from "./outcomes";
import type { SkeletonProblem } from "./problems";
import type { PathObservation, SkeletonOutcome, UnknownTask } from "./types";

/** Whether an outcome is the one registration recorded, or the one it would decide now. */
export type SkeletonOutcomeBasis = "recorded" | "projected";

export type FileSkeletonStatus = Readonly<{ path: string; outcome: SkeletonOutcome; basis: SkeletonOutcomeBasis }>;

export type TaskSkeletonStatus = Readonly<{ taskId: string; files: readonly FileSkeletonStatus[] }>;

/** A skeleton a Contract Revision left on disk because it had been modified. */
export type StaleSkeleton = Readonly<{ path: string; contract: string; stale: Readonly<{ revision: number }> }>;

/** One stage-two problem and the line that names it. */
export type UnresolvedSkeletonBinding = Readonly<{ problem: SkeletonProblem; message: string }>;

export type SkeletonStatusReport =
  /** Nothing to report: no execute Wave is current, or the TaskGraph carries no binding stamp. */
  | Readonly<{ kind: "not-applicable"; reason: string }>
  /** The shell could not observe the paths or the frozen types files. */
  | Readonly<{ kind: "unobserved"; reason: string }>
  | Readonly<{
      kind: "reported";
      wave: number;
      /** Every Task of the Wave, in graph order, each path in file_list order. */
      tasks: readonly TaskSkeletonStatus[];
      /** Every stale skeleton record, of any Wave, in record order. */
      stale: readonly StaleSkeleton[];
      /** Every stage-two problem of the Wave's outstanding Tasks. */
      unresolved: readonly UnresolvedSkeletonBinding[];
    }>;

/** Which Tasks a report covers, and whose bindings must resolve before the Wave spawns. */
export type SkeletonReportScope =
  | Readonly<{ kind: "not-applicable"; reason: string }>
  | Readonly<{
      kind: "wave";
      wave: number;
      /** Every Task of the current Wave: the ones whose paths are observed and reported. */
      tasks: readonly Task[];
      /** Those not yet implemented or completed: the ones whose bindings must resolve. */
      outstanding: readonly Task[];
    }>;

const notApplicable = (reason: string): Readonly<{ kind: "not-applicable"; reason: string }> =>
  Object.freeze({ kind: "not-applicable", reason });

export const skeletonsUnobserved = (reason: string): SkeletonStatusReport => Object.freeze({ kind: "unobserved", reason });

export function skeletonReportScope(graph: TaskGraph): SkeletonReportScope {
  if (graph.current_phase !== "execute" || graph.current_wave === undefined) return notApplicable("no execute Wave is current");
  if (graph.export_bindings === undefined) {
    return notApplicable("the TaskGraph was populated before export bindings were stamped, so the engine writes no skeletons");
  }
  const wave = graph.current_wave;
  const tasks = Object.freeze(graph.tasks.filter((task) => task.wave === wave));
  return Object.freeze({
    kind: "wave",
    wave,
    tasks,
    outstanding: Object.freeze(tasks.filter(({ status }) => status !== "implemented" && status !== "completed")),
  });
}

/**
 * Exactly one outcome per non-test file_list path of the Task, in file_list
 * order: the recorded one where registration recorded it, else the one
 * `skeletonOutcomesOf` projects from the observations; or `unknown-task` for
 * an id the graph does not hold.
 */
export function taskSkeletonOutcomes(
  graph: TaskGraph,
  taskId: string,
  observations: ReadonlyMap<string, PathObservation>,
): DomainResult<readonly FileSkeletonStatus[], UnknownTask> {
  const projected = skeletonOutcomesOf(graph, taskId, observations);
  if (!projected.ok) return projected;
  const recorded = graph.tasks.find(({ id }) => id === taskId)?.skeleton_outcomes ?? [];
  return {
    ok: true,
    value: Object.freeze(projected.value.map(({ path, outcome }): FileSkeletonStatus => {
      const kept = recorded.find((entry) => samePlanPath(entry.path, path));
      return Object.freeze(kept === undefined
        ? { path, outcome, basis: "projected" }
        : { path, outcome: kept.outcome, basis: "recorded" });
    })),
  };
}

/** Every stale skeleton record of the graph, in record order. */
export function staleSkeletons(graph: TaskGraph): readonly StaleSkeleton[] {
  return Object.freeze((graph.skeletons ?? []).flatMap(({ path, contract, stale }) =>
    stale === null ? [] : [Object.freeze({ path, contract, stale })]));
}

/**
 * The report of the current Wave. Its Tasks come from the graph itself, so
 * each is known; were one not, the report is `unobserved`, naming it, rather
 * than a Task shown with no paths.
 */
export function skeletonStatusReport(
  graph: TaskGraph,
  observations: ReadonlyMap<string, PathObservation>,
  unresolved: readonly UnresolvedSkeletonBinding[],
): SkeletonStatusReport {
  const scope = skeletonReportScope(graph);
  if (scope.kind === "not-applicable") return scope;
  const tasks: TaskSkeletonStatus[] = [];
  for (const { id } of scope.tasks) {
    const files = taskSkeletonOutcomes(graph, id, observations);
    if (!files.ok) return skeletonsUnobserved(`Task ${files.error.taskId} of Wave ${scope.wave} is not in the TaskGraph`);
    tasks.push(Object.freeze({ taskId: id, files: files.value }));
  }
  return Object.freeze({
    kind: "reported",
    wave: scope.wave,
    tasks: Object.freeze(tasks),
    stale: staleSkeletons(graph),
    unresolved: Object.freeze([...unresolved]),
  });
}

/** The lines naming every stage-two problem the report carries: what blocks the spawn. */
export const unresolvedSkeletonBindings = (report: SkeletonStatusReport): readonly string[] =>
  report.kind === "reported" ? report.unresolved.map(({ message }) => message) : [];

/** The FR-033 flag, with the contract and revision that left the skeleton stale. */
export const renderStaleSkeleton = ({ contract, stale }: StaleSkeleton): string =>
  `stale against revised contract ${contract} (revision ${stale.revision})`;

/** The human status lines: one per path with its exact outcome string and basis, then each stale flag and problem. */
export function renderSkeletonStatus(report: SkeletonStatusReport): readonly string[] {
  return match(report)
    .with({ kind: "not-applicable" }, ({ reason }) => [`- skeletons: not applicable (${reason})`])
    .with({ kind: "unobserved" }, ({ reason }) => [`- skeletons: unobserved (${reason})`])
    .with({ kind: "reported" }, ({ wave, tasks, stale, unresolved }) => [
      `- skeletons: Wave ${wave}`,
      ...tasks.flatMap(({ taskId, files }) =>
        files.map(({ path, outcome, basis }) => `  - ${taskId} ${path}: ${renderSkeletonOutcome(outcome)} (${basis})`)),
      ...stale.map((entry) => `  - ${entry.path}: ${renderStaleSkeleton(entry)}`),
      ...unresolved.map(({ message }) => `  - unresolved: ${message}`),
    ])
    .exhaustive();
}
