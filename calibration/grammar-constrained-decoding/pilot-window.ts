/**
 * Pilot window: the matched dispatch of one calibration window and its
 * blinded assessment packet, behind the `ArmDispatch` port (the live
 * `piArmDispatch` adapter in production, plain fakes in tests) and an
 * injected monotonic clock. `recordWindow` (`pilot-retention.ts`) runs it.
 *
 * - `dispatchSchedule` walks the preregistered pair schedule, dispatching
 *   each pair's two arms in its scheduled order over ONE rendered task body
 *   (matched inputs), and hands every sample to the caller as it lands.
 * - Each arm runs attempt 1 and — only after a semantic rejection — the one
 *   fresh engine-issued attempt 2 (AD-9's shared request-slot budget). Wall
 *   clock runs from the initial dispatch through accepted ingestion.
 * - Each attempt's request identity and issued binding are minted by the pure
 *   `pilot-binding.ts`; this module imports only the port TYPES of
 *   `pilot-dispatch.ts`, never its child-process adapter.
 * - `blind` / `blindedPacket` derive the retained blinding key and the
 *   arm-free packet an assessor sees (the rubric assessor is `pilot-rubric.ts`).
 */

import { randomUUID } from "node:crypto";
import { err, ok, type Result } from "../kernel";
import { parseSampleObservation, type SampleObservation } from "./pilot-observation";
import { buildPairSchedule, type Preregistration, type ScheduledPair } from "./pilot-preregistration";
import type { BlindingKey } from "./pilot-quality";
import { SPEC_SEMANTIC_ATTEMPT_BUDGET, type CellKey, type PilotArm } from "./pilot-vocabulary";
import { mintCellBinding, pilotRequestId } from "./pilot-binding";
import type { ArmDispatch, AttemptClassification } from "./pilot-dispatch";
import { caseInputOf, renderPilotPrompt, renderTaskBody, type WindowInputs, type WorkloadFixtures } from "./pilot-workload";

/** One landed sample: an accepted sample carries its canonical payload; a
 *  terminal (non-accepted) sample carries none. */
export type SampleRecord =
  | Readonly<{ kind: "accepted"; sample: SampleObservation; acceptedPayload: unknown }>
  | Readonly<{ kind: "terminal"; sample: SampleObservation }>;

/** Pair a parsed sample with its final attempt's payload; an accepted outcome
 *  without a payload (or a payload on any other outcome) is refused. */
function sampleRecord(sample: SampleObservation, last: AttemptClassification | undefined): Result<SampleRecord, string> {
  const accepted = last?.observation.outcome.kind === "accepted";
  const payload = last?.acceptedPayload ?? null;
  if (accepted && payload === null) return err("its accepted outcome carries no accepted payload");
  if (!accepted && payload !== null) return err("it carries an accepted payload without an accepted outcome");
  return ok(Object.freeze(accepted ? { kind: "accepted" as const, sample, acceptedPayload: payload } : { kind: "terminal" as const, sample }));
}

export type WindowDispatch = Readonly<{
  windowId: string;
  prereg: Preregistration;
  fixtures: WorkloadFixtures;
  /** Every preregistered case's resolved input (`resolveWindowInputs`). */
  inputs: WindowInputs;
  /** The dispatch port: one attempt of one arm, launched and classified. */
  dispatch: ArmDispatch;
  /** Monotonic clock in milliseconds. */
  now: () => number;
  /** Receives every sample as it lands, so an interrupted window retains every observation. */
  onSample: (record: SampleRecord) => void;
  /** Receives each completed pair (0-based index of `total`). */
  onPair: (index: number, total: number, pair: ScheduledPair) => void;
}>;

async function dispatchSample(window: WindowDispatch, pair: ScheduledPair, arm: PilotArm, body: string): Promise<SampleRecord> {
  const started = window.now();
  const attempts: AttemptClassification[] = [];
  for (let attempt = 1; attempt <= SPEC_SEMANTIC_ATTEMPT_BUDGET; attempt += 1) {
    const requestId = pilotRequestId(window.windowId, pair.pairId, arm, attempt);
    // The binding's context digest addresses the exact prompt, so it is minted
    // over the body first and the wire section is rendered from that binding.
    const minted = mintCellBinding(pair.cell, requestId, body);
    if (!minted.ok) throw new Error(`cannot mint the issued binding for ${pair.pairId}: ${minted.error}`);
    const prompt = renderPilotPrompt(body, pair.cell, arm === "emission-enabled"
      ? { arm, binding: minted.value.binding }
      : { arm });
    const classified = await window.dispatch({ cell: pair.cell, arm, attempt, prompt, cellBinding: minted.value });
    attempts.push(classified);
    if (classified.observation.outcome.kind !== "rejected") break;
  }
  const sample = parseSampleObservation({
    pairId: pair.pairId,
    cell: pair.cell,
    caseId: pair.caseId,
    arm,
    dispatchToIngestionMs: window.now() - started,
    attempts: attempts.map((attempt) => attempt.observation),
    rawArgumentObservation: "unavailable",
  });
  if (!sample.ok) throw new Error(`recorded observation for ${pair.pairId}/${arm} is malformed: ${sample.error.join("; ")}`);
  const record = sampleRecord(sample.value, attempts[attempts.length - 1]);
  if (!record.ok) throw new Error(`recorded sample for ${pair.pairId}/${arm} is inconsistent: ${record.error}`);
  return record.value;
}

/** Matched dispatch of the whole preregistered schedule. */
export async function dispatchSchedule(window: WindowDispatch): Promise<readonly SampleRecord[]> {
  const records: SampleRecord[] = [];
  const schedule = buildPairSchedule(window.prereg);
  for (const [index, pair] of schedule.entries()) {
    const input = caseInputOf(window.inputs, pair.cell, pair.caseId);
    if (input === undefined) throw new Error(`no resolved input for ${pair.cell} case ${pair.caseId}`);
    const body = renderTaskBody(input, window.fixtures);
    for (const arm of pair.armOrder) {
      const record = await dispatchSample(window, pair, arm, body);
      records.push(record);
      window.onSample(record);
    }
    window.onPair(index, schedule.length, pair);
  }
  return records;
}

export type BlindedEntry = Readonly<{ blindId: string; pairId: string; arm: PilotArm; cell: CellKey; caseId: string; payload: unknown }>;

const byCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  return left > right ? 1 : 0;
};

/** Blind ids are unpredictable and the entries are ordered by them, so the
 *  packet order is a shuffle of the schedule. Only accepted payloads are blinded. */
export function blind(windowId: string, records: readonly SampleRecord[]): Readonly<{ key: BlindingKey; entries: readonly BlindedEntry[] }> {
  const entries: BlindedEntry[] = records
    .flatMap((record) => (record.kind === "accepted" ? [record] : []))
    .map((record) => ({
      blindId: randomUUID(), pairId: record.sample.pairId, arm: record.sample.arm,
      cell: record.sample.cell, caseId: record.sample.caseId, payload: record.acceptedPayload,
    }))
    .sort((left, right) => byCodeUnits(left.blindId, right.blindId));
  return {
    key: { schemaVersion: 1, windowId, entries: entries.map(({ blindId, pairId, arm }) => ({ blindId, pairId, arm })) },
    entries,
  };
}

/** What an assessor sees: blind id, source and canonical payload — never the arm or the pair. */
export function blindedPacket(windowId: string, entries: readonly BlindedEntry[]) {
  return {
    schemaVersion: 1,
    windowId,
    instructions: "Score each entry with the preregistered severity rubric: list every KNOWN defect of the entry's case the payload lets escape. The arm is hidden; do not attempt to infer it.",
    entries: entries.map(({ blindId, cell, caseId, payload }) => ({ blindId, cell, caseId, payload })),
  };
}
