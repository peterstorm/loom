/**
 * `orchestration disposition` (loom#213 Cause 4, ADR-0090): record the
 * operator's decision on advisories of the active Wave on the TaskGraph, at
 * the Wave Gate's advisory pause or after the run is abandoned to fix some of
 * them, so the decision survives the run and later gates stop reissuing a
 * deferred or dismissed advisory whose bytes did not change.
 *
 * Pure: the shell observes each named Task's reviewed workspace (the anchor
 * bytes) before the lock and commits what this decides under it.
 */

import {
  advisoryDecisionTasks,
  advisoryDisposition,
  anchorDigest,
  standingDispositions,
  waveAdvisories,
  type AdvisoryDisposition,
} from "./advisory-disposition";
import type { DomainResult } from "./orchestration-contract";
import { hasExactKeys, isRecord } from "./plain-record";
import { admitReviewedWorkspace, type ReviewedWorkspaceObservation } from "./reviewed-workspace";
import { taskReviewScope } from "./wave-review-authority";
import type { TaskGraph } from "../types";

const DISPOSITION_USAGE =
  'Usage: helper orchestration disposition <<\'JSON\'\n{"dispositions":[{"finding":"<task>:<finding-id>","decision":"fixed|deferred|dismissed","reason":"<why>","target":"<Wave or Task, deferred only>"}]}\nJSON';

/** One requested decision, before its anchor is computed. */
export type DispositionEntry = Readonly<{
  taskId: string;
  findingId: string;
  decision: unknown;
  reason: unknown;
  target: unknown;
}>;

export type DispositionRefusal = Readonly<{
  kind: "not-executing" | "unknown-advisory" | "invalid-disposition" | "workspace-unobserved";
  message: string;
}>;

export type DispositionOutcome = Readonly<{
  graph: TaskGraph;
  /** The records appended, in request order. */
  recorded: readonly AdvisoryDisposition[];
  /** The advisories whose standing decision already said exactly this. */
  unchanged: readonly string[];
}>;

const freeze = Object.freeze;
const refuse = (kind: DispositionRefusal["kind"], message: string): DomainResult<never, DispositionRefusal> =>
  freeze({ ok: false as const, error: freeze({ kind, message }) });

const ENTRY_FIELDS = ["finding", "decision", "reason", "target"] as const;
const ADVISORY_NAME = /^([^:\s]+):([^:\s]+)$/;

/** `{"dispositions":[…]}` with at least one entry, each naming its advisory as `<task>:<finding-id>` once. */
export function parseDispositionInput(stdin: string): DomainResult<readonly DispositionEntry[], string> {
  const fail = (problem: string) => freeze({ ok: false as const, error: `${problem}\n${DISPOSITION_USAGE}` });
  let raw: unknown;
  try {
    raw = JSON.parse(stdin);
  } catch (error) {
    return fail(`input must be JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw) || !hasExactKeys(raw, ["dispositions"])) return fail('input must be exactly {"dispositions":[...]}');
  const list: unknown = raw.dispositions;
  if (!Array.isArray(list) || list.length === 0) return fail("dispositions must be a non-empty array");
  const items: readonly unknown[] = list;
  const entries: DispositionEntry[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of items.entries()) {
    const label = `dispositions[${index}]`;
    if (!isRecord(entry)) return fail(`${label} must be an object`);
    const extra = Object.keys(entry).filter((key) => !ENTRY_FIELDS.some((field) => field === key));
    if (extra.length > 0) return fail(`${label} has unexpected fields: ${extra.join(", ")}`);
    const finding = entry.finding;
    const named = typeof finding === "string" ? ADVISORY_NAME.exec(finding) : null;
    const taskId = named?.[1];
    const findingId = named?.[2];
    if (typeof finding !== "string" || taskId === undefined || findingId === undefined) {
      return fail(`${label}.finding must be "<task>:<finding-id>"`);
    }
    if (seen.has(finding)) return fail(`${label} names ${finding} twice`);
    seen.add(finding);
    entries.push(freeze({ taskId, findingId, decision: entry.decision, reason: entry.reason, target: entry.target ?? null }));
  }
  return freeze({ ok: true as const, value: freeze(entries) });
}

/**
 * Append one record per entry whose standing decision differs, or refuse the
 * whole request: outside the execute phase, for an advisory the active Wave's
 * decision request would not issue (`advisoryDecisionTasks`,
 * `waveAdvisories`: the set approval counts), for an invalid
 * decision, or when a named Task's reviewed workspace was not observed over
 * its current review scope. Allowed while the Wave Gate is paused on its
 * advisories and after it is abandoned. Idempotent: a repeated request
 * appends nothing.
 */
export function recordAdvisoryDispositions(
  graph: TaskGraph,
  entries: readonly DispositionEntry[],
  workspaces: readonly ReviewedWorkspaceObservation[],
): DomainResult<DispositionOutcome, DispositionRefusal> {
  const wave = graph.current_wave;
  if (graph.current_phase !== "execute" || wave === undefined) {
    return refuse("not-executing", `advisory dispositions are recorded in the execute phase; the phase is ${graph.current_phase}`);
  }
  const waveTasks = advisoryDecisionTasks(graph, wave);
  const advisories = waveAdvisories(waveTasks);
  const standing = standingDispositions(graph.advisory_dispositions);
  const recorded: AdvisoryDisposition[] = [];
  const unchanged: string[] = [];
  for (const entry of entries) {
    const advisory = advisories.find(({ taskId, findingId }) => taskId === entry.taskId && findingId === entry.findingId);
    const task = waveTasks.find(({ id }) => id === entry.taskId);
    if (advisory === undefined || task === undefined) {
      return refuse("unknown-advisory", `${entry.taskId}:${entry.findingId} is not an advisory of a Task in the active Wave ${wave}`);
    }
    const unobserved = `${task.id}'s reviewed workspace was not observed over its current review scope`;
    const observation = workspaces.find(({ taskId }) => taskId === task.id);
    if (observation === undefined) return refuse("workspace-unobserved", unobserved);
    const admitted = admitReviewedWorkspace(task.id, taskReviewScope(task), observation);
    if (!admitted.ok) return refuse("workspace-unobserved", `${unobserved}: ${admitted.error}`);
    const built = advisoryDisposition({
      wave,
      taskId: entry.taskId,
      findingId: entry.findingId,
      decision: entry.decision,
      reason: entry.reason,
      target: entry.target,
      anchor: entry.decision === "fixed" ? null : anchorDigest(advisory.file, admitted.value.artifacts),
    });
    if (!built.ok) return refuse("invalid-disposition", `${advisory.identity}: ${built.error}`);
    const previous = standing.get(advisory.identity);
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(built.value)) {
      unchanged.push(advisory.identity);
      continue;
    }
    recorded.push(built.value);
  }
  return freeze({
    ok: true as const,
    value: freeze({
      graph: recorded.length === 0
        ? graph
        : freeze({ ...graph, advisory_dispositions: freeze([...(graph.advisory_dispositions ?? []), ...recorded]) }),
      recorded: freeze(recorded),
      unchanged: freeze(unchanged),
    }),
  });
}
