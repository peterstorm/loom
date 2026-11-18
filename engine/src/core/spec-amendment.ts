/**
 * Spec Amendment (ADR-0087, loom#199 Cause 4): an audited, operator-authored
 * change to the specification's text while a TaskGraph is live.
 *
 * Until this existed, the only route was listing `spec.md` as a file of a fix
 * Task, as if requirement text were sealed code, and `amend-spec-trace` could
 * re-assign ids but never change what a Requirement says. `amendSpec` takes the
 * current Spec Index and the proposed one and:
 *
 * - records both observations and the Requirement diff (rewritten, added and
 *   withdrawn ids) in a `spec-amended` audit;
 * - re-anchors the claims of every Task that has not completed to the new text,
 *   since they are still to be verified against it;
 * - lists the claims of completed Tasks the change rewrote or withdrew as
 *   re-judgements: the next Wave Gate's spec-check judges each rewritten claim
 *   again (`pendingRejudgements`), and its completion re-anchors them;
 * - retires the current Wave's review authority and spec-check, which froze the
 *   old text.
 *
 * Trace changes stay `amend-spec-trace`'s: an id this amendment withdraws may
 * not still be claimed by a Task that has not completed, so the operator moves
 * that claim first and nothing is left claiming an id the spec no longer has.
 *
 * Pure: the shell observes both Spec Indexes and writes the new bytes after the
 * graph commits.
 */

import type { SpecAmendment, SpecAmendmentRejudgement, Task, TaskGraph } from "../types";
import { parseSpecContentHash } from "./parse-spec";
import type { DomainResult } from "./orchestration-contract";
import {
  completableRequirementIds,
  recordedAnchorHashes,
  specIndexObservationOf,
  type SpecIndexAvailability,
} from "./requirement-coverage";
import type { ParsedSpec } from "./parse-spec";
import { SPEC_TRACE_VERSION } from "./spec-trace";
import { reopenableWave, waveReopeningRefusalMessage } from "./task-revalidation";
import { parsePlanEditReason } from "./wave-plan-edit";
import { retireWaveReviewAuthority } from "./wave-gate-registration";

export type SpecAmendmentRefusal = Readonly<{
  kind:
    | "legacy-graph"
    | "not-executing"
    | "live-wave-gate"
    | "implementation-active"
    | "spec-authority-changed"
    | "spec-index-unavailable"
    | "withdrawn-still-claimed"
    | "invalid-reason";
  message: string;
}>;

export type SpecAmendmentOutcome =
  /** The graph records the amendment: persist `graph`, then write the new spec bytes. */
  | Readonly<{ kind: "amended"; graph: TaskGraph; amendment: SpecAmendment }>
  /** The graph already records this amendment but the spec still holds the old bytes: write them, nothing else. */
  | Readonly<{ kind: "bytes-pending"; amendment: SpecAmendment }>
  /** The spec already holds the proposed bytes. */
  | Readonly<{ kind: "unchanged" }>;

/** The Requirement ids one amendment changes, each list in Spec Index order. */
export type SpecAmendmentDiff = Readonly<{
  rewritten: readonly string[];
  added: readonly string[];
  withdrawn: readonly string[];
}>;

const LABEL = "Spec amendment";
const freeze = Object.freeze;
const refuse = (kind: SpecAmendmentRefusal["kind"], message: string): DomainResult<never, SpecAmendmentRefusal> =>
  freeze({ ok: false as const, error: freeze({ kind, message }) });

/** Every completable entry (FR and AS) by id, with its content hash. */
const completableHashes = (index: ParsedSpec): ReadonlyMap<string, string> =>
  new Map([...index.frs, ...index.scenarios].map((entry) => [entry.id, entry.contentHash] as const));

/**
 * What changes between two Spec Indexes: an id whose text changed is
 * rewritten; one only the new index defines is added; one the new index no
 * longer defines as completable (gone, or moved to Out of Scope) is withdrawn.
 */
export function specAmendmentDiff(before: ParsedSpec, after: ParsedSpec): SpecAmendmentDiff {
  const old = completableHashes(before);
  const next = completableHashes(after);
  const nowCompletable = completableRequirementIds(after);
  return freeze({
    rewritten: freeze([...next].flatMap(([id, hash]) => (old.has(id) && old.get(id) !== hash ? [id] : []))),
    added: freeze([...next.keys()].filter((id) => !old.has(id))),
    withdrawn: freeze([...old.keys()].filter((id) => !nowCompletable.has(id))),
  });
}

const claimsOf = (task: Task): readonly string[] => [...(task.spec_anchors ?? []), ...(task.spec_contributions ?? [])];

/** The first Task that has not completed and still claims or contributes to a withdrawn id, as a refusal. */
function withdrawnClaimRefusal(graph: TaskGraph, withdrawn: readonly string[]): DomainResult<never, SpecAmendmentRefusal> | null {
  for (const task of graph.tasks) {
    if (task.status === "completed") continue;
    const claimed = claimsOf(task).find((id) => withdrawn.includes(id));
    if (claimed !== undefined) {
      return refuse("withdrawn-still-claimed", `${LABEL} withdraws ${claimed}, which ${task.id} (${task.status}) still claims or ` +
        "contributes to; move that claim first with helper amend-spec-trace");
    }
  }
  return null;
}

/** The claims of completed Tasks that the amendment rewrote or withdrew, in roster order. */
function rejudgementsOf(graph: TaskGraph, diff: SpecAmendmentDiff): readonly SpecAmendmentRejudgement[] {
  const changed = new Set([...diff.rewritten, ...diff.withdrawn]);
  return freeze(graph.tasks.flatMap((task) => task.status !== "completed"
    ? []
    : (task.spec_anchors ?? []).filter((claim) => changed.has(claim)).map((claim) => freeze({ taskId: task.id, claim }))));
}

/** `task` with its rewritten completion claims re-anchored to `after`'s text; completed Tasks keep theirs. */
function reanchoredTask(task: Task, rewritten: ReadonlySet<string>, after: ParsedSpec): Task {
  if (task.status === "completed") return task;
  const claims = (task.spec_anchors ?? []).filter((claim) => rewritten.has(claim));
  if (claims.length === 0) return task;
  return freeze({ ...task, spec_anchor_hashes: freeze({ ...(task.spec_anchor_hashes ?? {}), ...recordedAnchorHashes(after, claims) }) });
}

/**
 * Amend the specification of a live v2 TaskGraph from `current` (the Spec
 * Index of the protected spec_file's bytes now) to `proposed` (the Spec Index
 * of the new bytes, under the same path), or refuse with the exact
 * precondition that failed. Replaying a committed amendment whose bytes were
 * not yet written answers `bytes-pending`; once they are, `unchanged`.
 */
export function amendSpec(
  graph: TaskGraph,
  current: SpecIndexAvailability,
  proposed: SpecIndexAvailability,
  reason: string,
): DomainResult<SpecAmendmentOutcome, SpecAmendmentRefusal> {
  if (graph.spec_trace_version !== SPEC_TRACE_VERSION) {
    return refuse("legacy-graph", `${LABEL} requires a Requirement trace v2 graph; migrate it with helper upgrade-spec-trace`);
  }
  if (current.kind !== "indexed" || proposed.kind !== "indexed") {
    const which = current.kind !== "indexed" ? "the current spec" : "the proposed spec";
    return refuse("spec-index-unavailable", `${LABEL} needs ${which} to parse into a Spec Index`);
  }
  if (current.path !== graph.spec_file || proposed.path !== graph.spec_file) {
    return refuse("spec-authority-changed", `${LABEL} observed ${current.path}, but protected spec_file is ${graph.spec_file ?? "none"}; retry`);
  }
  if (current.contentDigest === proposed.contentDigest) return freeze({ ok: true as const, value: freeze({ kind: "unchanged" as const }) });
  const last = graph.spec_amendments?.at(-1);
  if (last !== undefined && last.after.kind === "indexed" && last.before.kind === "indexed" &&
      last.after.contentDigest === proposed.contentDigest && last.before.contentDigest === current.contentDigest) {
    return freeze({ ok: true as const, value: freeze({ kind: "bytes-pending" as const, amendment: last }) });
  }
  const parsedReason = parsePlanEditReason(reason);
  if (!parsedReason.ok) return refuse("invalid-reason", `${LABEL} reason ${parsedReason.error}`);
  const open = reopenableWave(graph);
  if (!open.ok) return refuse(open.error.kind, waveReopeningRefusalMessage(open.error, "amending the spec", "amend the spec"));
  const { wave, abandonedRunId } = open.value;

  const diff = specAmendmentDiff(current.index, proposed.index);
  const claimRefusal = withdrawnClaimRefusal(graph, diff.withdrawn);
  if (claimRefusal !== null) return claimRefusal;
  const rewritten = new Set(diff.rewritten);
  const tasks = freeze(graph.tasks.map((task) => reanchoredTask(task, rewritten, proposed.index)));
  const amendment: SpecAmendment = freeze({
    schemaVersion: 1,
    kind: "spec-amended",
    wave,
    reason: parsedReason.value,
    before: specIndexObservationOf(current),
    after: specIndexObservationOf(proposed),
    rewritten: diff.rewritten,
    added: diff.added,
    withdrawn: diff.withdrawn,
    rejudge: rejudgementsOf(graph, diff),
    retiredRunId: abandonedRunId,
  });
  const amended: TaskGraph = freeze({
    ...retireWaveReviewAuthority(freeze({ ...graph, tasks }), wave),
    spec_amendments: freeze([...(graph.spec_amendments ?? []), amendment]),
  });
  return freeze({ ok: true as const, value: freeze({ kind: "amended" as const, graph: amended, amendment }) });
}

/**
 * The completed-Task claims a spec amendment listed for re-judgement that are
 * still owed one: the claim's recorded hash still differs from the text
 * `index` gives it now. A Wave Gate that completes after the amendment
 * re-anchors them (`reanchorVerifiedClaims`), which discharges them. A
 * withdrawn claim has no text to judge against; it stays the completed-claim
 * drift it already is until `amend-spec-trace` drops it.
 */
export function pendingRejudgements(graph: TaskGraph, index: ParsedSpec): readonly SpecAmendmentRejudgement[] {
  const text = completableHashes(index);
  const seen = new Set<string>();
  const pending: SpecAmendmentRejudgement[] = [];
  for (const { rejudge } of graph.spec_amendments ?? []) {
    for (const entry of rejudge) {
      const key = `${entry.taskId}\u0000${entry.claim}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const current = text.get(entry.claim);
      const task = graph.tasks.find(({ id }) => id === entry.taskId);
      const recorded = task?.spec_anchor_hashes?.[entry.claim];
      const parsed = recorded === undefined ? null : parseSpecContentHash(recorded);
      if (current !== undefined && task?.status === "completed" && (task.spec_anchors ?? []).includes(entry.claim) &&
          (parsed === null || parsed !== current)) {
        pending.push(entry);
      }
    }
  }
  return freeze(pending);
}
