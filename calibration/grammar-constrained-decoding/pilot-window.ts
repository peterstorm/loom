/**
 * Pilot window: the matched dispatch of one calibration window and its
 * blinded assessment packet — the `--pilot` shell's path behind the
 * `ArmDispatch` port (`scripts/run-model-calibration.ts` wires the live
 * `piArmDispatch` adapter and `performance.now`; tests wire plain fakes).
 *
 * - `dispatchSchedule` walks the preregistered pair schedule, dispatching
 *   each pair's two arms in its scheduled order over ONE rendered task body
 *   (matched inputs), and hands every sample to the caller as it lands.
 * - Each arm runs attempt 1 and — only after a semantic rejection — the one
 *   fresh engine-issued attempt 2 (AD-9's shared request-slot budget). Wall
 *   clock runs from the initial dispatch through accepted ingestion.
 * - `blind` / `blindedPacket` / `rubricAssessment` derive the retained
 *   blinding key, the arm-free packet an assessor sees, and the deterministic
 *   rubric assessor's scores over that packet.
 */

import { randomUUID } from "node:crypto";
import {
  buildPairSchedule,
  parseSampleObservation,
  SPEC_SEMANTIC_ATTEMPT_BUDGET,
  type BlindingKey,
  type CellKey,
  type PilotArm,
  type Preregistration,
  type QualityAssessment,
  type Result,
  type SampleObservation,
  type ScheduledPair,
} from "./pilot-core";
import { mintCellBinding, type ArmDispatch, type AttemptClassification } from "./pilot-dispatch";
import {
  pilotRequestId,
  renderPilotPrompt,
  renderTaskBody,
  rubricEscapes,
  type CaseInput,
  type WorkloadFixtures,
} from "./pilot-workload";

export type SampleRecord = Readonly<{ sample: SampleObservation; acceptedPayload: unknown }>;

/** The key of one preregistered case's resolved input: `<cell>|<caseId>`. */
export const caseInputKey = (cell: CellKey, caseId: string): string => `${cell}|${caseId}`;

export type WindowDispatch = Readonly<{
  windowId: string;
  prereg: Preregistration;
  fixtures: WorkloadFixtures;
  /** Every preregistered case's input, keyed by `caseInputKey`. */
  inputs: ReadonlyMap<string, CaseInput>;
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
  return Object.freeze({ sample: sample.value, acceptedPayload: attempts[attempts.length - 1]?.acceptedPayload ?? null });
}

/** Matched dispatch of the whole preregistered schedule. */
export async function dispatchSchedule(window: WindowDispatch): Promise<readonly SampleRecord[]> {
  const records: SampleRecord[] = [];
  const schedule = buildPairSchedule(window.prereg);
  for (const [index, pair] of schedule.entries()) {
    const input = window.inputs.get(caseInputKey(pair.cell, pair.caseId));
    if (input === undefined) throw new Error(`no resolved input for ${pair.cell} case ${pair.caseId}`);
    const body = renderTaskBody(pair.cell, input, window.fixtures);
    if (!body.ok) throw new Error(body.error);
    for (const arm of pair.armOrder) {
      const record = await dispatchSample(window, pair, arm, body.value);
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
    .filter((record) => record.acceptedPayload !== null)
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

type AssessedEntry = QualityAssessment["entries"][number];

/** One blinded entry scored by the rubric, or why it cannot be scored. */
function assessEntry(
  prereg: Preregistration, entry: BlindedEntry, inputs: ReadonlyMap<string, CaseInput>,
): Result<AssessedEntry, string> {
  const where = `blinded entry ${entry.blindId} (${entry.cell} case ${entry.caseId})`;
  const workloadCase = prereg.cells.find((cell) => cell.cell === entry.cell)?.workload.cases.find((item) => item.caseId === entry.caseId);
  if (workloadCase === undefined) return { ok: false, error: `${where}: the case is not preregistered` };
  const input = inputs.get(caseInputKey(entry.cell, entry.caseId));
  if (input === undefined) return { ok: false, error: `${where}: no resolved input` };
  const escapes = rubricEscapes(workloadCase, input, entry.payload);
  return escapes.ok
    ? { ok: true, value: { blindId: entry.blindId, escapedDefects: escapes.value } }
    : { ok: false, error: `${where}: ${escapes.error}` };
}

/**
 * The deterministic rubric assessor over the blinded packet. Fails closed:
 * an entry whose case, input or escaped defect cannot be resolved makes the
 * whole assessment an error listing every such entry — it is never scored as
 * zero escapes, so a lookup drift cannot understate a window's escapes.
 */
export function rubricAssessment(
  prereg: Preregistration, entries: readonly BlindedEntry[], inputs: ReadonlyMap<string, CaseInput>,
): Result<QualityAssessment, readonly string[]> {
  const scored: AssessedEntry[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    const assessed = assessEntry(prereg, entry, inputs);
    if (assessed.ok) scored.push(assessed.value);
    else problems.push(assessed.error);
  }
  if (problems.length > 0) return { ok: false, error: Object.freeze(problems) };
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      assessorId: "rubric-v1",
      method: "deterministic rubric: corpus match rules (reviewer), planted-flaw ranking (judge), real-defect refutation (refutation); sees blind id, source and canonical payload only",
      blinded: true,
      entries: Object.freeze(scored),
    },
  };
}
