/**
 * Test fixtures shared by the pilot's suites: the retained workload with its
 * case inputs resolved by the PRODUCTION resolver (`resolveWindowInputs`,
 * with a constant changed-path lookup in place of git), sample builders over
 * the observation parser, and a fake route — a plain `ArmDispatch` function
 * and a fake clock wired into the window dispatch path (`pilot-window.ts`)
 * exactly where `recordWindow` wires the live Pi adapter.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../engine/src/core/reviewer-contract";
import { parseCalibrationCorpus, type CalibrationCase } from "../../engine/src/core/model-calibration";
import type { ArmDispatch, ArmRequest } from "./pilot-dispatch";
import {
  parseSampleObservation,
  type AttemptObservation,
  type ExtractionArmAttempt,
  type SampleObservation,
} from "./pilot-observation";
import type { PreflightDecision } from "./pilot-preflight";
import { buildPairSchedule, parsePreregistration, type Preregistration, type ScheduledPair } from "./pilot-preregistration";
import type { WindowWorkload } from "./pilot-retention";
import type { CellKey, PilotArm } from "./pilot-vocabulary";
import { dispatchSchedule, type SampleRecord } from "./pilot-window";
import {
  caseInputOf,
  parseWorkloadFixtures,
  resolveWindowInputs,
  type CaseInput,
  type WindowInputs,
  type WorkloadFixtures,
} from "./pilot-workload";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "../..");

export const WINDOW_ID = "fake-route-window";
export const ATTEMPT_MS = 100;
export const READY: PreflightDecision = {
  kind: "ready",
  runtime: { stagedRuntimeRevision: "sha256:abc", loadedRuntime: { kind: "unobserved" }, piVersion: "0.83.0" },
};

export const preregBytes = readFileSync(join(HERE, "preregistration.json"));
export const fixtureBytes = readFileSync(join(HERE, "workload-fixtures.json"));

function retainedWorkload(): Readonly<{ prereg: Preregistration; fixtures: WorkloadFixtures; cases: readonly CalibrationCase[] }> {
  const prereg = parsePreregistration(JSON.parse(preregBytes.toString("utf-8")));
  if (!prereg.ok) throw new Error(prereg.error.join("\n"));
  const fixtures = parseWorkloadFixtures(JSON.parse(fixtureBytes.toString("utf-8")));
  if (!fixtures.ok) throw new Error(fixtures.error.join("\n"));
  const corpus = parseCalibrationCorpus(readFileSync(join(REPO_ROOT, fixtures.value.reviewer.corpus), "utf-8"));
  if (!corpus.ok) throw new Error(corpus.errors.join("\n"));
  return { prereg: prereg.value, fixtures: fixtures.value, cases: corpus.value.cases };
}

const workload = retainedWorkload();
export const { prereg, fixtures } = workload;
export const corpusCases: readonly CalibrationCase[] = workload.cases;

/** The window workload `recordWindow` resolves, with no git-derived changed paths. */
export const WORKLOAD: WindowWorkload = { fixtures, loadCorpusCases: () => ({ ok: true, value: corpusCases }), changedPathsOf: () => [] };

const resolved = resolveWindowInputs(prereg, fixtures, corpusCases, WORKLOAD.changedPathsOf);
if (!resolved.ok) throw new Error(resolved.error.join("\n"));
export const inputs: WindowInputs = resolved.value;

/** One preregistered case's resolved input, through the production lookup; a missing one throws. */
export function inputOf(cell: CellKey, caseId: string): CaseInput {
  const input = caseInputOf(inputs, cell, caseId);
  if (input === undefined) throw new Error(`${cell} ${caseId} has no resolved input`);
  return input;
}

/** The resolved inputs without one case's: a window whose lookup for it fails. */
export const inputsWithout = (cell: CellKey, caseId: string): WindowInputs =>
  new Map([...inputs].filter(([, input]) => !(input.cell === cell && input.caseId === caseId)));

/** A test preregistration: the retained one, optionally with every cell (but
 *  `unconstrained`, which keeps the retained unconstrained qualification)
 *  qualified as a capable (constrained) route and a cheaper bootstrap. */
export function testPreregistration(options: Readonly<{ constrained?: boolean; extractionOnly?: CellKey; unconstrained?: CellKey }> = {}): Preregistration {
  const raw = JSON.parse(preregBytes.toString("utf-8")) as { guardrails: { bootstrapResamples: number }; cells: Array<{ cell: string; qualification: unknown }> };
  raw.guardrails.bootstrapResamples = 200;
  for (const cell of raw.cells) {
    if (options.constrained && options.unconstrained !== cell.cell) {
      cell.qualification = { kind: "constrained-emission", enforcedConstraints: ["type", "required", "enum", "additionalProperties"], evidence: "test" };
    }
    if (options.extractionOnly === cell.cell) {
      cell.qualification = { kind: "extraction-only", reason: "route rejects the schema", evidence: "test" };
    }
  }
  const parsed = parsePreregistration(raw);
  if (!parsed.ok) throw new Error(parsed.error.join("\n"));
  return parsed.value;
}

export type AttemptSpec = Readonly<{
  outcome: Record<string, unknown>;
  emissionCalls?: number;
  toolErrors?: readonly Record<string, unknown>[];
}>;

export const ACCEPT_EMISSION: AttemptSpec = { outcome: { kind: "accepted", source: "emission-tool", fallbackOverRefusal: false, payloadDigest: "a".repeat(64) }, emissionCalls: 1 };
export const ACCEPT_EXTRACTION: AttemptSpec = { outcome: { kind: "accepted", source: "extraction", fallbackOverRefusal: false, payloadDigest: "b".repeat(64) } };

/** One arm's sample of a scheduled pair, built through the observation parser. */
export function sample(pair: ScheduledPair, arm: PilotArm, ms: number, attempts: readonly AttemptSpec[]): SampleObservation {
  const parsed = parseSampleObservation({
    pairId: pair.pairId,
    cell: pair.cell,
    caseId: pair.caseId,
    arm,
    dispatchToIngestionMs: ms,
    attempts: attempts.map((spec, index) => ({
      attempt: index + 1,
      elapsedMs: ms / attempts.length,
      readinessMs: arm === "emission-enabled" ? 50 : null,
      modelRequests: 1 + (spec.toolErrors?.length ?? 0),
      emissionCalls: spec.emissionCalls ?? 0,
      toolErrors: spec.toolErrors ?? [],
      toolAcknowledged: spec.outcome["source"] === "emission-tool",
      followUpTurnsAfterAck: 0,
      outcome: spec.outcome,
    })),
    rawArgumentObservation: "unavailable",
  });
  if (!parsed.ok) throw new Error(parsed.error.join("\n"));
  return parsed.value;
}

/** The first scheduled pair of the retained preregistration. */
export const firstPair = (): ScheduledPair => buildPairSchedule(prereg)[0] as ScheduledPair;

type Outcome = AttemptObservation["outcome"];
export type Script = (request: ArmRequest) => Outcome;
export type FakeRoute = Readonly<{ dispatch: ArmDispatch; now: () => number; requests: readonly ArmRequest[] }>;

export const accepted = (request: ArmRequest): Outcome => ({
  kind: "accepted",
  source: request.arm === "emission-enabled" ? "emission-tool" : "extraction",
  fallbackOverRefusal: false,
  payloadDigest: "a".repeat(64),
});
export const REJECTED: Outcome = { kind: "rejected", cause: { kind: "extraction-failure", detail: "final message carried no JSON" } };
export const TIMEOUT: Outcome = { kind: "timeout", afterMs: ATTEMPT_MS };

/**
 * A canonical payload each cell's frozen parser accepts, which lets every
 * known defect escape: a reviewer payload with no findings, a judge verdict
 * that names no fatal flaw, a refutation verdict that refutes the finding.
 */
function acceptedPayloadFor(cell: CellKey): unknown {
  switch (cell) {
    case "reviewer-payload/v2":
      return { ...REVIEWER_PAYLOAD_EXAMPLE_V2, findings: [] };
    case "reviewer-payload/v3":
      return {
        schemaVersion: 3, kind: "standalone-successor-review",
        lineageDigest: fixtures.reviewer.v3Context.lineageDigest, snapshotDigest: fixtures.reviewer.v3Context.snapshotDigest,
        priorAssessments: [], findings: [],
      };
    case "judge-verdict/v1":
      return { criterion: "correctness", rankings: [{ candidate: "a.md", score: 7, fatal_flaw: null, strongest_idea: "reuse the budget" }] };
    case "refutation-verdict/v1":
      return { criterion: "correctness", verdicts: [{ finding_id: "f1", verdict: "refuted", reasoning: "the guard holds" }] };
  }
}

/** A route substitute: every attempt advances the fake clock by ATTEMPT_MS,
 *  is recorded, and settles with the scripted outcome (an accepted one
 *  carrying its cell's canonical payload). */
export function fakeRoute(script: Script): FakeRoute {
  const requests: ArmRequest[] = [];
  let clock = 0;
  const dispatch: ArmDispatch = async (request) => {
    requests.push(request);
    clock += ATTEMPT_MS;
    const outcome = script(request);
    const acceptedPayload = outcome.kind === "accepted" ? acceptedPayloadFor(request.cell) : null;
    const observation: AttemptObservation = request.arm === "emission-enabled"
      ? {
          attempt: request.attempt, elapsedMs: ATTEMPT_MS, readinessMs: 5, modelRequests: 1, emissionCalls: 1, toolErrors: [],
          toolAcknowledged: outcome.kind === "accepted", followUpTurnsAfterAck: 0, outcome,
        }
      : {
          attempt: request.attempt, elapsedMs: ATTEMPT_MS, readinessMs: null, modelRequests: 1, emissionCalls: 0, toolErrors: [],
          toolAcknowledged: false, followUpTurnsAfterAck: 0,
          // Scripts give the extraction arm extraction-source outcomes; the sample parse re-checks.
          outcome: outcome as ExtractionArmAttempt["outcome"],
        };
    return { observation, acceptedPayload };
  };
  return { dispatch, now: () => clock, requests };
}

/** The window dispatch path `recordWindow` runs, over a fake route. */
export async function runWindow(route: FakeRoute, onSample: (record: SampleRecord) => void = () => {}) {
  const landed: SampleRecord[] = [];
  const progress: string[] = [];
  const records = await dispatchSchedule({
    windowId: WINDOW_ID, prereg, fixtures, inputs, dispatch: route.dispatch, now: route.now,
    onSample: (record) => { landed.push(record); onSample(record); },
    onPair: (index, total, pair) => { progress.push(`${index + 1}/${total} ${pair.pairId}`); },
  });
  return { records, landed, progress };
}
