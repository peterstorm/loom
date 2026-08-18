/**
 * What a registered run's own files SAY about it, as one value.
 *
 * Orienting inside a Run Directory used to be four hand-read JSON files:
 * `authority.json` to prove the run is the one you think it is, `program.json`
 * for which program it runs, `checkpoint.json` for the machine state, and a
 * `jq` walk of `events/` plus each slot's `attempt-N.rejected` marker to learn
 * which slots produced evidence and which refused. That runs before
 * every "resume or replace it?" decision, and doing it by hand puts the answer
 * in the operator's session notes rather than in the run.
 *
 * This module is the projection half. Every fact is an `ObservedFact`, so a
 * file that could not be read is reported as `unavailable` WITH its cause
 * rather than defaulted — the same rule `LoomStatus` follows, and for the same
 * reason: a run whose checkpoint is unreadable is the run you most need the
 * truth about, and "no state" would read as "never started".
 *
 * Nothing here decides policy. It reads no files (the shell hands it what it
 * observed), recommends no action, and cannot mutate a run. `resume` remains
 * the only thing that advances a program.
 */

import { match } from "ts-pattern";
import { captureKey, type CaptureKey } from "./harness-capture";
import type { AgentRequestAuthority } from "./orchestration-contract";

/**
 * One observed fact, or the reason it could not be observed.
 *
 * A projection that silently substituted a default for an unreadable file
 * would report a symlink-swapped checkpoint and a run that never wrote one as
 * the same thing, which is exactly backwards: the unreadable one is the fault.
 */
export type ObservedFact<T> =
  | Readonly<{ kind: "observed"; value: T }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export const observed = <T>(value: T): ObservedFact<T> => Object.freeze({ kind: "observed" as const, value });
export const unavailable = <T>(reason: string): ObservedFact<T> =>
  Object.freeze({ kind: "unavailable" as const, reason });

/** The registered program kinds a checkpoint's state label can be read through. */
export const INSPECTABLE_PROGRAMS = [
  "standalone-review", "remediation", "wave-gate", "architecture", "refutation",
] as const;
export type InspectableProgram = (typeof INSPECTABLE_PROGRAMS)[number];

const isInspectableProgram = (value: unknown): value is InspectableProgram =>
  typeof value === "string" && (INSPECTABLE_PROGRAMS as readonly string[]).includes(value);

/** Minimal event shape; structurally satisfied by the journal's `ProgramEventRecord`. */
export type InspectedEvent = Readonly<{
  sequence: number;
  dedupKey: string;
  recordedAtMs: number;
  event: unknown;
}>;

/** Minimal abandonment shape; structurally satisfied by the handle's `RunAbandonment`. */
export type InspectedAbandonment = Readonly<{
  supersededBy: string | null;
  reason: string;
}>;

/** Everything the shell read off one Run Directory, before any interpretation. */
export type RunInspectionObservation = Readonly<{
  runId: string;
  runsRoot: string;
  runDirectory: string;
  authority: ObservedFact<null>;
  programRegistration: ObservedFact<unknown>;
  checkpoint: ObservedFact<string | null>;
  requests: ObservedFact<readonly AgentRequestAuthority[]>;
  capturedAttempts: ObservedFact<ReadonlySet<CaptureKey>>;
  /** Rejection markers by request id, as read from the transcript slots. */
  markerRejections: ObservedFact<ReadonlyMap<string, string>>;
  events: ObservedFact<readonly InspectedEvent[]>;
  abandonment: ObservedFact<InspectedAbandonment | null>;
}>;

export type SlotCapture = "captured" | "rejected" | "awaited";

export type InspectedSlot = Readonly<{
  slotId: string;
  requestId: string;
  role: string;
  attempt: 1 | 2;
  capture: SlotCapture;
  diagnostic: string | null;
}>;

export type InspectedEventSummary = Readonly<{
  count: number;
  last: Readonly<{ sequence: number; kind: string; recordedAtMs: number }> | null;
}>;

export type RunInspection = Readonly<{
  schemaVersion: 1;
  kind: "run-inspection";
  runId: string;
  runsRoot: string;
  runDirectory: string;
  authority: ObservedFact<null>;
  /** `null` = the run exists but no program was ever registered against it. */
  program: ObservedFact<InspectableProgram | null>;
  /** `null` = no checkpoint was ever written; a label only ever comes from a known program. */
  state: ObservedFact<string | null>;
  slots: ObservedFact<readonly InspectedSlot[]>;
  events: ObservedFact<InspectedEventSummary>;
  abandonment: ObservedFact<InspectedAbandonment | null>;
}>;

const CAPTURE_REJECTED_EVENT = "request-capture-rejected";

/**
 * Where each program's checkpoint keeps its state label.
 *
 * Read per registered program kind rather than probed: every writer's shape is
 * known (`programs/standalone.ts`, `programs/remediation.ts`,
 * `programs/wave-gate.ts`, and the Fugue codec for the two panels), and a probe
 * that tried `kind`, then `state.state`, then `data.state.stage` in turn would
 * report whichever field happened to match — including one belonging to a
 * different program's shape after a schema change, which is the one case where
 * a wrong label is worse than none.
 */
function checkpointStateLabel(program: InspectableProgram, raw: unknown): string | null {
  const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  const text = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;
  const root = record(raw);
  if (root === null) return null;
  return match(program)
    .with("standalone-review", "wave-gate", () => text(root["kind"]))
    .with("remediation", () => text(record(root["state"])?.["state"]))
    .with("architecture", "refutation", () => text(record(record(root["data"])?.["state"])?.["stage"]))
    .exhaustive();
}

/** The rejection diagnostics the event log carries, by request id. */
function eventRejections(events: readonly InspectedEvent[]): ReadonlyMap<string, string> {
  const rejections = new Map<string, string>();
  for (const { event } of events) {
    if (typeof event !== "object" || event === null || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (record["kind"] !== CAPTURE_REJECTED_EVENT || typeof record["requestId"] !== "string") continue;
    rejections.set(
      record["requestId"],
      typeof record["diagnostic"] === "string" ? record["diagnostic"] : "capture was rejected without a diagnostic",
    );
  }
  return rejections;
}

/**
 * Slot status, with the event log taking precedence over the on-disk marker.
 *
 * Same precedence `durableCaptureRejection` applies, and for the same reason:
 * both are written by the same rejection, but the event log is the run's
 * authoritative append-only record while the marker is a per-slot convenience.
 * Captured beats both — bytes that landed are not a rejection, whatever an
 * earlier attempt recorded.
 */
function inspectSlots(
  requests: readonly AgentRequestAuthority[],
  captured: ReadonlySet<CaptureKey>,
  markers: ReadonlyMap<string, string>,
  events: readonly InspectedEvent[],
): readonly InspectedSlot[] {
  const fromEvents = eventRejections(events);
  return Object.freeze([...requests]
    .sort((left, right) => left.slotId.localeCompare(right.slotId) || left.attempt - right.attempt)
    .map((request) => {
      const diagnostic = fromEvents.get(request.requestId) ?? markers.get(request.requestId) ?? null;
      const capture: SlotCapture = match({
        landed: captured.has(captureKey(request.slotId, request.attempt)),
        refused: diagnostic !== null,
      })
        .with({ landed: true }, () => "captured" as const)
        .with({ refused: true }, () => "rejected" as const)
        .otherwise(() => "awaited" as const);
      return Object.freeze({
        slotId: request.slotId as string,
        requestId: request.requestId as string,
        role: request.role as string,
        attempt: request.attempt,
        capture,
        diagnostic: capture === "rejected" ? diagnostic : null,
      });
    }));
}

function summarizeEvents(events: readonly InspectedEvent[]): InspectedEventSummary {
  const last = events.at(-1);
  const eventKind = last === undefined || typeof last.event !== "object" || last.event === null
    ? null
    : (last.event as Record<string, unknown>)["kind"];
  return Object.freeze({
    count: events.length,
    last: last === undefined ? null : Object.freeze({
      sequence: last.sequence,
      kind: typeof eventKind === "string" ? eventKind : last.dedupKey,
      recordedAtMs: last.recordedAtMs,
    }),
  });
}

const mapFact = <A, B>(fact: ObservedFact<A>, project: (value: A) => B): ObservedFact<B> =>
  fact.kind === "observed" ? observed(project(fact.value)) : fact;

/** Derive the whole projection. Pure: every input was observed by the shell. */
export function deriveRunInspection(observation: RunInspectionObservation): RunInspection {
  const program = mapFact(observation.programRegistration, (raw): InspectableProgram | null => {
    if (raw === null) return null;
    const kind = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["kind"] : undefined;
    return isInspectableProgram(kind) ? kind : null;
  });

  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "run-inspection" as const,
    runId: observation.runId,
    runsRoot: observation.runsRoot,
    runDirectory: observation.runDirectory,
    authority: observation.authority,
    program,
    // A state label is only meaningful against a known program shape, so an
    // unreadable or unregistered program propagates as an unavailable state
    // rather than silently reporting "no checkpoint".
    state: deriveState(program, observation.checkpoint),
    slots: deriveSlots(observation),
    events: mapFact(observation.events, summarizeEvents),
    abandonment: observation.abandonment,
  });
}

function deriveState(
  program: ObservedFact<InspectableProgram | null>,
  checkpoint: ObservedFact<string | null>,
): ObservedFact<string | null> {
  if (program.kind === "unavailable") {
    return unavailable(`program registration is unavailable: ${program.reason}`);
  }
  if (checkpoint.kind === "unavailable") return checkpoint;
  if (checkpoint.value === null) return observed(null);
  if (program.value === null) return unavailable("run has a checkpoint but no registered program to read it through");
  let raw: unknown;
  try {
    raw = JSON.parse(checkpoint.value) as unknown;
  } catch (error) {
    return unavailable(`checkpoint is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const label = checkpointStateLabel(program.value, raw);
  return label === null
    ? unavailable(`checkpoint carries no ${program.value} state label`)
    : observed(label);
}

function deriveSlots(observation: RunInspectionObservation): ObservedFact<readonly InspectedSlot[]> {
  const { requests, capturedAttempts, markerRejections, events } = observation;
  if (requests.kind === "unavailable") return requests;
  if (capturedAttempts.kind === "unavailable") {
    return unavailable(`captured attempts are unavailable: ${capturedAttempts.reason}`);
  }
  return observed(inspectSlots(
    requests.value,
    capturedAttempts.value,
    markerRejections.kind === "observed" ? markerRejections.value : new Map(),
    events.kind === "observed" ? events.value : [],
  ));
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

const renderFact = <T>(fact: ObservedFact<T>, render: (value: T) => string): string =>
  fact.kind === "observed" ? render(fact.value) : `unavailable (${fact.reason})`;

/**
 * JSON form. Both renderers project the SAME value, so they cannot disagree —
 * and `RunInspection` is plain records and arrays by construction (the Sets and
 * Maps the shell observes are folded away by `deriveRunInspection`), so this
 * needs no replacer to stay faithful.
 */
export function renderRunInspectionJson(inspection: RunInspection): string {
  return JSON.stringify(inspection, null, 2);
}

export function renderRunInspectionHuman(inspection: RunInspection): string {
  const lines = [
    `run:       ${inspection.runId}`,
    `directory: ${inspection.runDirectory}`,
    `authority: ${renderFact(inspection.authority, () => "readable")}`,
    `program:   ${renderFact(inspection.program, (kind) => kind ?? "none registered")}`,
    `state:     ${renderFact(inspection.state, (label) => label ?? "no checkpoint written")}`,
    `events:    ${renderFact(inspection.events, ({ count, last }) =>
      last === null ? `${count}` : `${count} (last: ${last.kind} @ seq ${last.sequence})`)}`,
    `slots:     ${renderFact(inspection.slots, renderSlotTally)}`,
  ];
  if (inspection.slots.kind === "observed") {
    const width = Math.max(0, ...inspection.slots.value.map(({ slotId }) => slotId.length));
    for (const slot of inspection.slots.value) {
      lines.push(`  ${slot.slotId.padEnd(width)}  attempt ${slot.attempt}  ${slot.capture.padEnd(8)}  ${slot.role}` +
        (slot.diagnostic === null ? "" : `\n  ${" ".repeat(width)}  ${slot.diagnostic}`));
    }
  }
  lines.push(`abandoned: ${renderFact(inspection.abandonment, renderAbandonment)}`);
  return lines.join("\n");
}

function renderAbandonment(marker: InspectedAbandonment | null): string {
  if (marker === null) return "no";
  const replacement = marker.supersededBy === null
    ? "not superseded"
    : `superseded by ${marker.supersededBy}`;
  return `yes — ${replacement}: ${marker.reason}`;
}

function renderSlotTally(slots: readonly InspectedSlot[]): string {
  const tally = (capture: SlotCapture): number => slots.filter((slot) => slot.capture === capture).length;
  return `${slots.length} issued — ${tally("captured")} captured, ${tally("rejected")} rejected, ${tally("awaited")} awaited`;
}
