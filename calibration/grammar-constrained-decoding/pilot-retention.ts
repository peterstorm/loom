/**
 * Pilot retention: one AD-11 window's retained files and the rules that keep
 * them honest (AS-017) — the `--pilot` / `--decide` paths behind the
 * `WindowStore` port (`scripts/run-model-calibration.ts` wires the filesystem
 * adapter; tests wire an in-memory map).
 *
 * - Pure derivations over bytes and text, each returning a Result:
 *   preregistration and assessment parsing, the retained window record, the
 *   preregistration-drift check, the observation log, the assessment
 *   retention decision (identical bytes are a no-op, different bytes are
 *   refused — never overwritten) and the decision record.
 * - `recordWindow` and `decideRetainedWindow` sequence them over the store:
 *   the window record is written before dispatch and CLOSED (end time and
 *   observation count) before the blinded packet is derived, so a window
 *   whose rubric cannot assess it still records how it ended; every decision
 *   is the current `release-decision.json` AND an append-only log line.
 */

import { z } from "zod";
import {
  contentDigest,
  decidePreflight,
  evaluatePilot,
  parseBlindingKey,
  parsePreflightFacts,
  parsePreregistration,
  parseQualityAssessment,
  parseSampleObservation,
  type BlindingKey,
  type NonEmpty,
  type PilotEvaluation,
  type PreflightDecision,
  type PreflightFacts,
  type Preregistration,
  type QualityAssessment,
  type ReleaseDecision,
  type Result,
  type SampleObservation,
} from "./pilot-core";
import type { CaseInput } from "./pilot-workload";
import { blind, blindedPacket, rubricAssessment, type SampleRecord } from "./pilot-window";

const ok = <T>(value: T): Result<T, never> => Object.freeze({ ok: true as const, value });
const err = <E>(error: E): Result<never, E> => Object.freeze({ ok: false as const, error });

// ---------------------------------------------------------------------------
// The window's files and the store port
// ---------------------------------------------------------------------------

/** The files of one retained window, relative to its directory. */
export const WINDOW_FILES = Object.freeze({
  window: "window.json",
  observations: "observations.jsonl",
  payloads: "accepted-payloads.jsonl",
  key: "blinding-key.json",
  packet: "blinded-assessment-packet.json",
  assessments: "assessments",
  decision: "release-decision.json",
  decisionLog: "decision-log.jsonl",
});

/** An assessor id is path-safe by parse, so it names its retained file. */
const assessmentFile = (assessorId: string): string => `${WINDOW_FILES.assessments}/${assessorId}.json`;

/** One window directory: text files named relative to it. */
export type WindowStore = Readonly<{
  /** The file's text, or null when it does not exist. */
  read: (name: string) => string | null;
  /** Create or replace a file (parent directories included). */
  write: (name: string, text: string) => void;
  append: (name: string, text: string) => void;
  /** The file names directly inside a subdirectory ([] when it does not exist). */
  list: (directory: string) => readonly string[];
  /** Where a diagnostic says the file lives. */
  locate: (name: string) => string;
}>;

/** How every retained JSON file is serialized. */
const jsonText = (data: unknown): string => `${JSON.stringify(data, null, 2)}\n`;

const parseJson = (text: string, label: string): Result<unknown, string> => {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (error) {
    return err(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const issueList = (problems: readonly string[]): string => `\n  - ${problems.join("\n  - ")}`;

// ---------------------------------------------------------------------------
// Pure derivations
// ---------------------------------------------------------------------------

/** A preregistration file as content: its parsed value and the digest of its exact bytes. */
export function parsePreregistrationFile(bytes: Uint8Array, label: string): Result<Readonly<{ digest: string; prereg: Preregistration }>, string> {
  const raw = parseJson(new TextDecoder().decode(bytes), `invalid preregistration ${label}`);
  if (!raw.ok) return raw;
  const parsed = parsePreregistration(raw.value);
  return parsed.ok
    ? ok(Object.freeze({ digest: contentDigest(bytes), prereg: parsed.value }))
    : err(`invalid preregistration ${label}:${issueList(parsed.error)}`);
}

/** The retained identity of a preregistration: its checkout path, content digest and id. */
export type PreregistrationRef = Readonly<{ path: string; digest: string; id: string }>;
export type LoadedPreregistration = Readonly<{ ref: PreregistrationRef; prereg: Preregistration }>;

export type DispatchPlan = Readonly<{ kind: "not-attempted"; reason: string }> | Readonly<{ kind: "dispatched" }>;

export function planDispatch(preflight: PreflightDecision, preflightOnly: boolean): DispatchPlan {
  if (preflight.kind === "blocked") return { kind: "not-attempted", reason: "preflight blocked — no sample is dispatched or fabricated" };
  if (preflightOnly) return { kind: "not-attempted", reason: "--preflight-only" };
  return { kind: "dispatched" };
}

/** `window.json` as written when the window opens. */
export type WindowRecord = Readonly<{
  schemaVersion: 1;
  windowId: string;
  preregistration: PreregistrationRef;
  workloadFixtures: Readonly<{ path: string; digest: string }>;
  startedAt: string;
  preflightFacts: PreflightFacts;
  preflight: PreflightDecision;
  dispatch: DispatchPlan;
}>;

/** `window.json` once the window has ended: how it ended and how many samples it retained. */
type ClosedWindowRecord = WindowRecord & Readonly<{ endedAt: string; observations: number }>;

const closeWindow = (record: WindowRecord, endedAt: string, observations: number): ClosedWindowRecord =>
  Object.freeze({ ...record, endedAt, observations });

/** What a re-decision reads back from a retained `window.json`. */
export type RetainedWindow = Readonly<{ preregistration: Readonly<{ path: string; digest: string }>; facts: PreflightFacts }>;

const retainedWindowSchema = z.object({
  preregistration: z.object({ path: z.string(), digest: z.string() }),
  preflightFacts: z.unknown(),
});

export function parseRetainedWindow(text: string, label: string): Result<RetainedWindow, string> {
  const raw = parseJson(text, label);
  if (!raw.ok) return raw;
  const window = retainedWindowSchema.safeParse(raw.value);
  if (!window.success) return err(`${label} carries no preregistration record`);
  const facts = parsePreflightFacts(window.data.preflightFacts);
  if (!facts.ok) return err(`${label} preflight facts: ${facts.error.join("; ")}`);
  return ok(Object.freeze({ preregistration: window.data.preregistration, facts: facts.value }));
}

/** A window is re-decided only against the exact preregistration it recorded. */
export function checkPreregistrationUnchanged(window: RetainedWindow, loaded: LoadedPreregistration, windowLabel: string): Result<null, string> {
  return loaded.ref.digest === window.preregistration.digest
    ? ok(null)
    : err(`preregistration ${window.preregistration.path} changed after window ${windowLabel} was recorded (digest ${loaded.ref.digest} ≠ ${window.preregistration.digest})`);
}

/** `observations.jsonl`: one sample per line; a missing log is a window that observed nothing. */
export function parseObservationLog(text: string | null): Result<readonly SampleObservation[], string> {
  const samples: SampleObservation[] = [];
  const lines = (text ?? "").split("\n").filter((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    const raw = parseJson(line, `observation line ${index + 1}`);
    if (!raw.ok) return raw;
    const parsed = parseSampleObservation(raw.value);
    if (!parsed.ok) return err(`observation line ${index + 1}: ${parsed.error.join("; ")}`);
    samples.push(parsed.value);
  }
  return ok(Object.freeze(samples));
}

/** `blinding-key.json`; a window that never reached blinding has none. */
function parseRetainedKey(text: string | null, label: string): Result<BlindingKey | null, string> {
  if (text === null) return ok(null);
  const raw = parseJson(text, label);
  if (!raw.ok) return raw;
  const key = parseBlindingKey(raw.value);
  return key.ok ? ok(key.value) : err(`blinding key: ${key.error.join("; ")}`);
}

export function parseAssessmentText(text: string, label: string): Result<QualityAssessment, string> {
  const raw = parseJson(text, `invalid assessment ${label}`);
  if (!raw.ok) return raw;
  const parsed = parseQualityAssessment(raw.value);
  return parsed.ok ? ok(parsed.value) : err(`invalid assessment ${label}:${issueList(parsed.error)}`);
}

/** An assessment file handed to a decision from outside the window. */
export type ExternalAssessment = Readonly<{ path: string; text: string }>;

export type RetentionStep = Readonly<{ kind: "retain"; file: string; text: string }> | Readonly<{ kind: "already-retained" }>;

/** AS-017 retention: an external assessment is copied to `assessments/<assessorId>.json`;
 *  identical bytes again are a no-op, and a DIFFERENT assessment for an
 *  already-retained assessor is refused — never overwritten. */
export function retentionStep(
  external: ExternalAssessment,
  retainedText: (file: string) => string | null,
  locate: (file: string) => string,
): Result<RetentionStep, string> {
  const assessment = parseAssessmentText(external.text, external.path);
  if (!assessment.ok) return assessment;
  const file = assessmentFile(assessment.value.assessorId);
  const retained = retainedText(file);
  if (retained === null) return ok(Object.freeze({ kind: "retain" as const, file, text: external.text }));
  return retained === external.text
    ? ok(Object.freeze({ kind: "already-retained" as const }))
    : err(`assessment ${locate(file)} is already retained with different content; a retained assessment is never overwritten`);
}

/** The persisted decision: what was decided, from what, against which preregistration. */
type DecisionRecord = Readonly<{
  schemaVersion: 1;
  decidedAt: string;
  preregistration: PreregistrationRef;
  decidedFrom: Readonly<{ observations: number; assessors: readonly string[] }>;
  decision: ReleaseDecision;
  cells: PilotEvaluation["cells"];
}>;

function decisionRecord(
  decidedAt: string,
  preregistration: PreregistrationRef,
  observations: readonly SampleObservation[],
  assessments: readonly QualityAssessment[],
  evaluation: PilotEvaluation,
): DecisionRecord {
  return Object.freeze({
    schemaVersion: 1 as const,
    decidedAt,
    preregistration,
    decidedFrom: Object.freeze({ observations: observations.length, assessors: assessments.map((assessment) => assessment.assessorId) }),
    decision: evaluation.decision,
    cells: evaluation.cells,
  });
}

// ---------------------------------------------------------------------------
// Orchestration over the store
// ---------------------------------------------------------------------------

/** What a decision run left behind. */
export type DecisionOutcome =
  | Readonly<{ kind: "recorded"; decision: ReleaseDecision["kind"]; file: string }>
  | Readonly<{ kind: "inconsistent"; problems: NonEmpty<string> }>;

function retainAssessments(store: WindowStore, externals: readonly ExternalAssessment[]): Result<null, string> {
  for (const external of externals) {
    const step = retentionStep(external, store.read, store.locate);
    if (!step.ok) return step;
    if (step.value.kind === "retain") store.write(step.value.file, step.value.text);
  }
  return ok(null);
}

/** The retained assessments of a window, in a stable order. */
function retainedAssessments(store: WindowStore): Result<readonly QualityAssessment[], string> {
  const assessments: QualityAssessment[] = [];
  for (const name of [...store.list(WINDOW_FILES.assessments)].filter((entry) => entry.endsWith(".json")).sort()) {
    const file = `${WINDOW_FILES.assessments}/${name}`;
    const parsed = parseAssessmentText(store.read(file) ?? "", store.locate(file));
    if (!parsed.ok) return parsed;
    assessments.push(parsed.value);
  }
  return ok(Object.freeze(assessments));
}

type DecisionInputs = Readonly<{
  preregistration: LoadedPreregistration;
  preflight: PreflightDecision;
  observations: readonly SampleObservation[];
  key: BlindingKey | null;
  externalAssessments: readonly ExternalAssessment[];
  now: () => string;
}>;

/** Retain the external assessments, evaluate, and record the decision: the
 *  CURRENT `release-decision.json` plus an append-only log line, so a
 *  re-decision (new assessments) can never erase an earlier verdict — a
 *  violated guardrail stays on record (no favourable-window chasing). */
function decideAndRecord(store: WindowStore, inputs: DecisionInputs): Result<DecisionOutcome, string> {
  const retention = retainAssessments(store, inputs.externalAssessments);
  if (!retention.ok) return retention;
  const assessments = retainedAssessments(store);
  if (!assessments.ok) return assessments;
  const evaluation = evaluatePilot({
    preregistration: inputs.preregistration.prereg,
    preflight: inputs.preflight,
    observations: inputs.observations,
    quality: { key: inputs.key, assessments: assessments.value },
  });
  if (!evaluation.ok) return ok(Object.freeze({ kind: "inconsistent" as const, problems: evaluation.error.problems }));
  const record = decisionRecord(inputs.now(), inputs.preregistration.ref, inputs.observations, assessments.value, evaluation.value);
  store.write(WINDOW_FILES.decision, jsonText(record));
  store.append(WINDOW_FILES.decisionLog, `${JSON.stringify(record)}\n`);
  return ok(Object.freeze({ kind: "recorded" as const, decision: record.decision.kind, file: store.locate(WINDOW_FILES.decision) }));
}

/** Writes the blinding key, the blinded assessment packet and the rubric
 *  assessment; returns the key. The key and packet are retained first, so an
 *  unassessable rubric fails loudly without losing them; no rubric file is
 *  written then, which the decision core reads as a missing assessor — never
 *  as zero escapes. */
function retainBlindedPacket(
  store: WindowStore, record: WindowRecord, prereg: Preregistration,
  samples: readonly SampleRecord[], inputs: ReadonlyMap<string, CaseInput>,
): Result<BlindingKey, string> {
  const blinded = blind(record.windowId, samples);
  store.write(WINDOW_FILES.key, jsonText(blinded.key));
  store.write(WINDOW_FILES.packet, jsonText(blindedPacket(record.windowId, blinded.entries)));
  const rubric = rubricAssessment(prereg, blinded.entries, inputs);
  if (!rubric.ok) return err(`the rubric assessor cannot assess window ${record.windowId}:\n${rubric.error.join("\n")}`);
  store.write(assessmentFile(rubric.value.assessorId), jsonText(rubric.value));
  return ok(blinded.key);
}

/** The window's matched dispatch, run only when the plan dispatches: every
 *  sample is handed to `persist` as it lands. */
export type WindowDispatchRun = (persist: (record: SampleRecord) => void) => Promise<Readonly<{
  records: readonly SampleRecord[];
  /** Every preregistered case's input, keyed by `caseInputKey` (the rubric reads them). */
  inputs: ReadonlyMap<string, CaseInput>;
}>>;

export type WindowRun = Readonly<{
  store: WindowStore;
  record: WindowRecord;
  preregistration: LoadedPreregistration;
  dispatch: WindowDispatchRun;
  externalAssessments: readonly ExternalAssessment[];
  /** ISO-8601 wall clock. */
  now: () => string;
}>;

/**
 * One `--pilot` window: open (never over a retained one), dispatch with every
 * sample persisted as it lands (an interrupted window keeps everything
 * observed), close the window record, retain the blinding key, packet and
 * rubric assessment, then decide.
 */
export async function recordWindow(run: WindowRun): Promise<Result<DecisionOutcome, string>> {
  const { store, record } = run;
  if (store.read(WINDOW_FILES.window) !== null) {
    return err(`window ${store.locate("")} already exists; a retained window is never overwritten`);
  }
  store.write(WINDOW_FILES.window, jsonText(record));
  const dispatched = record.dispatch.kind === "dispatched"
    ? await run.dispatch(({ sample, acceptedPayload }) => {
        store.append(WINDOW_FILES.observations, `${JSON.stringify(sample)}\n`);
        if (acceptedPayload !== null) {
          store.append(WINDOW_FILES.payloads, `${JSON.stringify({ pairId: sample.pairId, arm: sample.arm, payload: acceptedPayload })}\n`);
        }
      })
    : { records: [], inputs: new Map<string, CaseInput>() };
  store.write(WINDOW_FILES.window, jsonText(closeWindow(record, run.now(), dispatched.records.length)));
  const key = retainBlindedPacket(store, record, run.preregistration.prereg, dispatched.records, dispatched.inputs);
  if (!key.ok) return key;
  return decideAndRecord(store, {
    preregistration: run.preregistration,
    preflight: record.preflight,
    observations: dispatched.records.map((entry) => entry.sample),
    key: key.value,
    externalAssessments: run.externalAssessments,
    now: run.now,
  });
}

export type RetainedWindowDecision = Readonly<{
  store: WindowStore;
  /** Loads the preregistration a window names by its checkout path. */
  loadPreregistration: (path: string) => Result<LoadedPreregistration, string>;
  externalAssessments: readonly ExternalAssessment[];
  now: () => string;
}>;

/** Offline `--decide`: re-evaluate a retained window from its retained
 *  evidence. The preflight is RE-DERIVED from the retained facts by the same
 *  pure decision, never trusted as a stored verdict, and only against the
 *  exact preregistration the window recorded. */
export function decideRetainedWindow(input: RetainedWindowDecision): Result<DecisionOutcome, string> {
  const { store } = input;
  const window = parseRetainedWindow(store.read(WINDOW_FILES.window) ?? "", store.locate(WINDOW_FILES.window));
  if (!window.ok) return window;
  const loaded = input.loadPreregistration(window.value.preregistration.path);
  if (!loaded.ok) return loaded;
  const unchanged = checkPreregistrationUnchanged(window.value, loaded.value, store.locate(""));
  if (!unchanged.ok) return unchanged;
  const observations = parseObservationLog(store.read(WINDOW_FILES.observations));
  if (!observations.ok) return observations;
  const key = parseRetainedKey(store.read(WINDOW_FILES.key), store.locate(WINDOW_FILES.key));
  if (!key.ok) return key;
  return decideAndRecord(store, {
    preregistration: loaded.value,
    preflight: decidePreflight(loaded.value.prereg, window.value.facts),
    observations: observations.value,
    key: key.value,
    externalAssessments: input.externalAssessments,
    now: input.now,
  });
}
