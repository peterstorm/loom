/**
 * Retro facts (ADR-0083, loom#200): the friction a TaskGraph recorded, per
 * Wave and per Task, derived only from protected state. A retrospective reads
 * these first and the session transcript only for the why, so no friction the
 * engine recorded can be missed.
 *
 * A Wave's slice of these facts is its friction digest: what status shows
 * beside a Wave, and what the per-Wave retro trigger judges
 * (`retro-triggers.ts`).
 *
 * Pure: it reads a parsed graph, live or archived, and never the disk.
 */

import { isDistillTask } from "./distill-task";
import type { Task, TaskGraph } from "../types";

/** Finding counts as review left them on the Task. */
export type FindingTally = Readonly<{ critical: number; advisory: number; refuted: number }>;

/** One Task's recorded friction. */
export type TaskFriction = Readonly<{
  taskId: string;
  wave: number;
  /** Settlement receipts, by transition. */
  implemented: number;
  retries: number;
  escalations: number;
  remediations: number;
  infrastructureBlocks: number;
  /** Every failure kind its receipts named, sorted and distinct. */
  failureKinds: readonly string[];
  /** Times an operator reopened it after it was implemented. */
  reopenings: number;
  /** Audited plan edits of it: re-scopes and added dependencies. */
  planEdits: number;
  /** The Forward Fix Tasks that held it, in audit order. */
  heldByForwardFixes: readonly string[];
  /** Whether the Task is itself a Forward Fix an operator appended. */
  forwardFix: boolean;
  findings: FindingTally;
}>;

/** Where a Wave stands. */
export type WaveProgress = "completed" | "active" | "pending";

/** One Wave's friction digest. */
export type WaveFriction = Readonly<{
  wave: number;
  progress: WaveProgress;
  /**
   * Wave Gate runs that completed; runs retired without completing (orphaned
   * or spec-trace retirements); and distinct runs abandoned, as the audits
   * that retired them name them (reopenings, Forward Fixes) plus a live
   * abandoned tombstone.
   */
  gateRuns: Readonly<{ completed: number; retired: number; abandoned: number }>;
  /** Completed-Wave reopenings for review integrity. */
  waveReopenings: number;
  taskReopenings: number;
  forwardFixes: number;
  forwardFixWithdrawals: number;
  planEdits: number;
  specTraceAmendments: number;
  /** Sums over the Wave's Tasks. */
  retries: number;
  escalations: number;
  remediations: number;
  infrastructureBlocks: number;
  findings: FindingTally;
  /** The Wave's Tasks with any friction, in graph order. */
  tasks: readonly TaskFriction[];
}>;

/** The whole run's facts. */
export type RetroFacts = Readonly<{
  waves: readonly WaveFriction[];
  /** Times the operator moved the run to another engine revision mid-run. */
  engineRevisionAdoptions: number;
}>;

const freeze = Object.freeze;
const count = <T>(items: readonly T[] | undefined, keep: (item: T) => boolean): number =>
  (items ?? []).filter(keep).length;

function taskFriction(graph: TaskGraph, task: Task): TaskFriction {
  const receipts = task.implementation_attempt_history ?? [];
  const transitions = (transition: string): number => count(receipts, (receipt) => receipt.transition === transition);
  const failureKinds = [...new Set(receipts.flatMap((receipt) => receipt.failureKinds))].sort();
  return freeze({
    taskId: task.id,
    wave: task.wave,
    implemented: transitions("implemented"),
    retries: transitions("retry-required"),
    escalations: transitions("escalation-required"),
    remediations: transitions("escalation-remediated"),
    infrastructureBlocks: transitions("infrastructure-blocked"),
    failureKinds: freeze(failureKinds),
    reopenings: count(graph.task_reopening_history, (audit) => audit.reopenedTaskIds.some((id) => id === task.id)),
    planEdits: count(graph.wave_plan_edits, (edit) => edit.taskId === task.id),
    heldByForwardFixes: freeze((graph.forward_fix_history ?? [])
      .filter((audit) => audit.heldTaskIds.some((id) => id === task.id))
      .map(({ fixTaskId }) => fixTaskId)),
    forwardFix: (graph.forward_fix_history ?? []).some(({ fixTaskId }) => fixTaskId === task.id),
    findings: freeze({
      critical: (task.critical_findings ?? []).length,
      advisory: (task.advisory_findings ?? []).length,
      refuted: (task.refuted_findings ?? []).length,
    }),
  });
}

/** Whether a Task recorded anything beyond one clean implementation. */
function hasFriction(task: TaskFriction): boolean {
  return task.retries + task.escalations + task.remediations + task.infrastructureBlocks + task.reopenings +
    task.planEdits + task.heldByForwardFixes.length + task.findings.critical + task.findings.refuted > 0 ||
    task.forwardFix;
}

const sum = (tasks: readonly TaskFriction[], pick: (task: TaskFriction) => number): number =>
  tasks.reduce((total, task) => total + pick(task), 0);

function progressOf(graph: TaskGraph, wave: number): WaveProgress {
  if ((graph.wave_gate_history ?? []).some((entry) => entry.wave === wave)) return "completed";
  return wave === graph.current_wave ? "active" : "pending";
}

/** Every Wave Gate run a Wave's digest saw: completed, retired and abandoned. */
export const gateRunCount = ({ gateRuns }: WaveFriction): number => gateRuns.completed + gateRuns.retired + gateRuns.abandoned;

/** One Wave's friction digest; every count is the Wave's alone. */
export function waveFriction(graph: TaskGraph, wave: number): WaveFriction {
  const all = graph.tasks.filter((task) => task.wave === wave && !isDistillTask(task)).map((task) => taskFriction(graph, task));
  const ofWave = <T extends Readonly<{ wave: number }>>(items: readonly T[] | undefined): number =>
    count(items, (item) => item.wave === wave);
  const active = graph.active_wave_gate;
  return freeze({
    wave,
    progress: progressOf(graph, wave),
    gateRuns: freeze({
      completed: ofWave(graph.wave_gate_history),
      retired: ofWave(graph.orphaned_wave_gate_history) + ofWave(graph.spec_trace_wave_gate_retirements),
      abandoned: new Set([
        ...[...(graph.task_reopening_history ?? []), ...(graph.forward_fix_history ?? [])]
          .flatMap((audit) => (audit.wave === wave && audit.abandonedRunId !== null ? [audit.abandonedRunId] : [])),
        ...(active !== undefined && active.wave === wave && active.terminalOutcome?.kind === "terminal-abandoned" ? [active.runId] : []),
      ]).size,
    }),
    waveReopenings: ofWave(graph.wave_reopening_history),
    taskReopenings: ofWave(graph.task_reopening_history),
    forwardFixes: ofWave(graph.forward_fix_history),
    forwardFixWithdrawals: count(graph.forward_fix_withdrawals, ({ audit }) => audit.wave === wave),
    planEdits: ofWave(graph.wave_plan_edits),
    specTraceAmendments: ofWave(graph.spec_trace_amendments),
    retries: sum(all, (task) => task.retries),
    escalations: sum(all, (task) => task.escalations),
    remediations: sum(all, (task) => task.remediations),
    infrastructureBlocks: sum(all, (task) => task.infrastructureBlocks),
    findings: freeze({
      critical: sum(all, (task) => task.findings.critical),
      advisory: sum(all, (task) => task.findings.advisory),
      refuted: sum(all, (task) => task.findings.refuted),
    }),
    tasks: freeze(all.filter(hasFriction)),
  });
}

/** Every Wave the graph holds, in order, and the run-level facts. */
export function retroFacts(graph: TaskGraph): RetroFacts {
  const waves = [...new Set(graph.tasks.map((task) => task.wave))].sort((left, right) => left - right);
  const pin = graph.engine_revision;
  return freeze({
    waves: freeze(waves.map((wave) => waveFriction(graph, wave))),
    engineRevisionAdoptions: pin?.kind === "pinned" ? pin.adoptions.length : 0,
  });
}
