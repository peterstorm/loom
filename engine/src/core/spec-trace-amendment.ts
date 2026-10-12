/**
 * Requirement trace amendment — the one pure command that changes a populated
 * v2 graph's Completion Claims and Contributions in place.
 *
 * Re-population is the only other way to change a v2 trace, and it discards
 * every settled implementation, review and refutation result. An amendment
 * keeps all of that and retires, in the same transition, exactly the authority
 * the old trace produced: the current Wave's review epoch, spec-check and
 * packet-bound review state, which froze the old Requirement scope. Completed
 * Waves are verified scope and cannot be amended at all.
 *
 * Requirement Content Hashes follow the edges they describe: a retained claim
 * keeps the hash recorded when its edge was made (so drift evidence survives),
 * an added claim is hashed from the Spec Index observed now, and a removed
 * claim's hash goes with it.
 */

import type {
  SpecTraceAmendment,
  SpecTraceAmendmentChange,
  SpecTraceOwnership,
  Task,
  TaskGraph,
} from "../types";
import type { NonEmpty } from "./orchestration-contract";
import {
  completableRequirementIds,
  recordedAnchorHashes,
  specIndexObservationOf,
  specIndexPath,
  specIndexUnavailableMessage,
  type SpecIndexAvailability,
} from "./requirement-coverage";
import {
  parseSpecTraceContract,
  sameRequirementTrace,
  SPEC_TRACE_VERSION,
  specTraceDiagnosticMessages,
} from "./spec-trace";
import { parseOwnershipInput, rosterError } from "./spec-trace-migration";
import { retireWaveReviewResidue, supersedeAbandonedWaveGateReview } from "./wave-gate-registration";

export type SpecTraceAmendmentRefusal = Readonly<{
  kind:
    | "legacy-graph"
    | "invalid-input"
    | "not-executing"
    | "spec-authority-changed"
    | "implementation-active"
    | "live-wave-gate"
    | "completed-wave-changed"
    | "spec-index-unavailable"
    | "unknown-requirement"
    | "invalid-trace";
  message: string;
}>;

export type SpecTraceAmendmentOutcome =
  | Readonly<{ kind: "amended"; graph: TaskGraph; amendment: SpecTraceAmendment }>
  /** The submitted trace already holds (Arrays compare as sets): nothing to write. */
  | Readonly<{ kind: "unchanged"; graph: TaskGraph }>;

export type SpecTraceAmendmentResult =
  | Readonly<{ ok: true; value: SpecTraceAmendmentOutcome }>
  | Readonly<{ ok: false; error: SpecTraceAmendmentRefusal }>;

const LABEL = "Spec trace amendment";

const refuse = (kind: SpecTraceAmendmentRefusal["kind"], message: string): SpecTraceAmendmentResult =>
  Object.freeze({ ok: false, error: Object.freeze({ kind, message }) });

const traceOf = (task: Task): SpecTraceOwnership => Object.freeze({
  spec_anchors: task.spec_anchors ?? [],
  spec_contributions: task.spec_contributions ?? [],
});

const added = (before: readonly string[], after: readonly string[]): readonly string[] =>
  after.filter((id) => !before.includes(id));

/**
 * The first id a submitted trace repeats, as a refusal message. Arrays compare
 * as sets, so without this a repeated id would read as an unchanged replay
 * instead of the malformed input it is.
 */
function repeatedIdError(ownership: ReadonlyMap<string, SpecTraceOwnership>): string | null {
  for (const [taskId, trace] of ownership) {
    for (const field of ["spec_anchors", "spec_contributions"] as const) {
      const repeated = trace[field].find((id, index) => trace[field].indexOf(id) !== index);
      if (repeated !== undefined) return `${LABEL} input Task ${taskId} ${field} repeats ${repeated}`;
    }
  }
  return null;
}

/** One amended Task with the change made to it. */
type AmendedTrace = Readonly<{ task: Task; change: SpecTraceAmendmentChange }>;

/** Every Task whose submitted trace differs, as a set, from its protected one — in roster order. */
function changesOf(
  graph: TaskGraph,
  ownership: ReadonlyMap<string, SpecTraceOwnership>,
): readonly AmendedTrace[] {
  return graph.tasks.flatMap((task) => {
    const before = traceOf(task);
    const after = ownership.get(task.id)!;
    return sameRequirementTrace(before, after)
      ? []
      : [Object.freeze({ task, change: Object.freeze({ taskId: task.id, before, after }) })];
  });
}

/** Retained claims keep their recorded hash, added claims are minted, removed claims drop theirs. */
function amendedAnchorHashes(
  task: Task,
  change: SpecTraceAmendmentChange,
  specIndex: SpecIndexAvailability,
): Readonly<Record<string, string>> {
  const recorded = task.spec_anchor_hashes ?? {};
  const addedClaims = added(change.before.spec_anchors, change.after.spec_anchors);
  const minted: Readonly<Record<string, string>> = specIndex.kind === "indexed"
    ? recordedAnchorHashes(specIndex.index, addedClaims)
    : {};
  return Object.freeze(Object.fromEntries(change.after.spec_anchors.flatMap((claim) => {
    const hash = addedClaims.includes(claim) ? minted[claim] : recorded[claim];
    return hash === undefined ? [] : [[claim, hash] as const];
  })));
}

function amendedTask(task: Task, change: SpecTraceAmendmentChange, specIndex: SpecIndexAvailability): Task {
  const hashes = amendedAnchorHashes(task, change, specIndex);
  const { spec_anchor_hashes: _replaced, ...unhashed } = task;
  return Object.freeze({
    ...unhashed,
    spec_anchors: change.after.spec_anchors,
    spec_contributions: change.after.spec_contributions,
    ...(Object.keys(hashes).length === 0 ? {} : { spec_anchor_hashes: hashes }),
  });
}

/** Every id the amendment introduces, per Task: new Completion Claims and new Contributions. */
const introducedIds = (changes: readonly SpecTraceAmendmentChange[]): readonly Readonly<{ taskId: string; id: string }>[] =>
  changes.flatMap(({ taskId, before, after }) => [
    ...added(before.spec_anchors, after.spec_anchors),
    ...added(before.spec_contributions, after.spec_contributions),
  ].map((id) => Object.freeze({ taskId, id })));

function liveGateRefusal(graph: TaskGraph): SpecTraceAmendmentResult | null {
  const active = graph.active_wave_gate;
  if (active === undefined || active.terminalOutcome?.kind === "terminal-abandoned") return null;
  return refuse("live-wave-gate", active.terminalOutcome === null
    ? `${LABEL} refused: Wave Gate run ${active.runId} is live and its review packets froze the current trace; ` +
      "abandon it with helper orchestration abandon, then retry the same amendment"
    : `${LABEL} refused: legacy terminal Wave Gate run ${active.runId} must be migrated to terminal history first`);
}

function completedWaveRefusal(
  graph: TaskGraph,
  amended: readonly AmendedTrace[],
): SpecTraceAmendmentResult | null {
  const completedWaves = new Set((graph.wave_gate_history ?? []).map(({ wave }) => wave));
  const frozen = amended.flatMap(({ task }) =>
    completedWaves.has(task.wave) ? [`${task.id} (Wave ${task.wave})`] : []);
  return frozen.length === 0
    ? null
    : refuse(
        "completed-wave-changed",
        `${LABEL} cannot change Tasks in completed Waves, which are verified scope: ${frozen.join(", ")}`,
      );
}

function specIndexRefusal(
  specIndex: SpecIndexAvailability,
  changes: readonly SpecTraceAmendmentChange[],
): SpecTraceAmendmentResult | null {
  const introduced = introducedIds(changes);
  if (introduced.length === 0) return null;
  if (specIndex.kind === "unavailable") {
    return refuse(
      "spec-index-unavailable",
      `${LABEL} adds Requirement ids but no Spec Index can prove they exist: ` +
        specIndexUnavailableMessage(specIndex.reason),
    );
  }
  const completable = completableRequirementIds(specIndex.index);
  const unknown = introduced.filter(({ id }) => !completable.has(id));
  return unknown.length === 0
    ? null
    : refuse(
        "unknown-requirement",
        `${LABEL} names ids the Spec Index does not define as a completable FR or AS entry: ` +
          unknown.map(({ taskId, id }) => `${taskId} → ${id}`).join(", "),
      );
}

/**
 * The trace-derived review authority an amendment retires. An abandoned
 * tombstone is retired exactly as its successor's install would retire it;
 * without a gate, whatever current-Wave review residue survives is retired.
 */
function retireTraceDerivedAuthority(graph: TaskGraph, wave: number): TaskGraph {
  if (graph.active_wave_gate === undefined) return retireWaveReviewResidue(graph, wave);
  const waveTaskIds = graph.tasks.filter((task) => task.wave === wave).map(({ id }) => id);
  return supersedeAbandonedWaveGateReview(graph, graph.active_wave_gate.runId, waveTaskIds);
}

/**
 * Amend a populated v2 graph's Requirement trace from an exact-roster input.
 * `specIndex` is the Spec Index observed for the graph's `spec_file` now; it
 * proves new ids and mints hashes for new Completion Claims.
 */
export function amendSpecTrace(
  graph: TaskGraph,
  raw: unknown,
  specIndex: SpecIndexAvailability,
): SpecTraceAmendmentResult {
  if (graph.spec_trace_version !== SPEC_TRACE_VERSION) {
    return refuse("legacy-graph", `${LABEL} requires a Requirement trace v2 graph; migrate it with helper upgrade-spec-trace`);
  }
  const parsed = parseOwnershipInput(raw, LABEL);
  if (!parsed.ok) return refuse("invalid-input", parsed.message);
  const inputProblem = rosterError(graph, parsed.value, LABEL) ?? repeatedIdError(parsed.value);
  if (inputProblem !== null) return refuse("invalid-input", inputProblem);

  const amendedTraces = changesOf(graph, parsed.value);
  const [first, ...rest] = amendedTraces.map(({ change }) => change);
  if (first === undefined) return Object.freeze({ ok: true, value: Object.freeze({ kind: "unchanged", graph }) });
  const changes = [first, ...rest];

  const wave = graph.current_wave;
  if (graph.current_phase !== "execute" || wave === undefined) {
    return refuse("not-executing", `${LABEL} requires a populated graph in the execute Phase (current: ${graph.current_phase})`);
  }
  if (specIndexPath(specIndex) !== graph.spec_file) {
    return refuse(
      "spec-authority-changed",
      `${LABEL} observed Spec Index ${specIndexPath(specIndex) ?? "none"}, but protected spec_file is ${graph.spec_file ?? "none"}; retry`,
    );
  }
  const executing = graph.executing_tasks ?? [];
  if (executing.length > 0) {
    return refuse(
      "implementation-active",
      `${LABEL} refused while implementation reservations are active: ${executing.join(", ")}`,
    );
  }
  const preconditionRefusal = liveGateRefusal(graph) ??
    completedWaveRefusal(graph, amendedTraces) ??
    specIndexRefusal(specIndex, changes);
  if (preconditionRefusal !== null) return preconditionRefusal;

  const replacements = new Map(amendedTraces.map(({ task, change }) =>
    [task, amendedTask(task, change, specIndex)] as const));
  const candidate: TaskGraph = Object.freeze({
    ...graph,
    tasks: Object.freeze(graph.tasks.map((task) => replacements.get(task) ?? task)),
  });
  const validated = parseSpecTraceContract(SPEC_TRACE_VERSION, candidate.tasks);
  if (!validated.ok) {
    return refuse("invalid-trace", `${LABEL} violates v2 ownership: ${specTraceDiagnosticMessages(validated).join("; ")}`);
  }

  const amendment: SpecTraceAmendment = Object.freeze({
    schemaVersion: 1,
    kind: "spec-trace-amendment",
    wave,
    retiredRunId: graph.active_wave_gate?.runId ?? null,
    changes: Object.freeze(changes) as NonEmpty<SpecTraceAmendmentChange>,
    specIndexObservation: specIndexObservationOf(specIndex),
  });
  const amended: TaskGraph = Object.freeze({
    ...retireTraceDerivedAuthority(candidate, wave),
    spec_trace_amendments: Object.freeze([...(graph.spec_trace_amendments ?? []), amendment]),
  });
  return Object.freeze({ ok: true, value: Object.freeze({ kind: "amended", graph: amended, amendment }) });
}
