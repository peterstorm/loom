/**
 * Test fixtures shared by the pilot's shell-level suites: the retained
 * workload with its resolved case inputs, and a fake route — a plain
 * `ArmDispatch` function and a fake clock wired into the window dispatch path
 * (`pilot-window.ts`) exactly where the script wires the live Pi adapter.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCalibrationCorpus, type CalibrationCase } from "../../engine/src/core/model-calibration";
import {
  parsePreregistration,
  type AttemptObservation,
  type ExtractionArmAttempt,
  type PreflightDecision,
  type Preregistration,
} from "./pilot-core";
import type { ArmDispatch, ArmRequest } from "./pilot-dispatch";
import { parseCaseSource, parseWorkloadFixtures, type CaseInput, type WorkloadFixtures } from "./pilot-workload";
import { caseInputKey, dispatchSchedule, type SampleRecord } from "./pilot-window";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "../..");

export const WINDOW_ID = "fake-route-window";
export const ATTEMPT_MS = 100;
export const READY: PreflightDecision = {
  kind: "ready",
  runtime: { stagedRuntimeRevision: "sha256:abc", loadedRuntime: { kind: "unobserved" }, piVersion: "0.83.0" },
};

function retainedWorkload(): Readonly<{ prereg: Preregistration; fixtures: WorkloadFixtures; cases: readonly CalibrationCase[] }> {
  const prereg = parsePreregistration(JSON.parse(readFileSync(join(HERE, "preregistration.json"), "utf-8")));
  if (!prereg.ok) throw new Error(prereg.error.join("\n"));
  const fixtures = parseWorkloadFixtures(JSON.parse(readFileSync(join(HERE, "workload-fixtures.json"), "utf-8")));
  if (!fixtures.ok) throw new Error(fixtures.error.join("\n"));
  const corpus = parseCalibrationCorpus(readFileSync(join(REPO_ROOT, fixtures.value.reviewer.corpus), "utf-8"));
  if (!corpus.ok) throw new Error(corpus.errors.join("\n"));
  return { prereg: prereg.value, fixtures: fixtures.value, cases: corpus.value.cases };
}

/** Case inputs as the script resolves them, minus the git-derived changed paths. */
function caseInput(source: string, cases: readonly CalibrationCase[], fixtures: WorkloadFixtures): CaseInput {
  const parsed = parseCaseSource(source);
  if (!parsed.ok) throw new Error(parsed.error);
  const { kind, id } = parsed.value;
  if (kind === "corpus") {
    const corpusCase = cases.find((entry) => entry.id === id);
    if (corpusCase === undefined) throw new Error(`corpus case ${id} missing`);
    return { kind: "corpus", corpusCase, changedPaths: [] };
  }
  const fixture = fixtures.fixtures[id];
  if (fixture === undefined) throw new Error(`fixture ${id} missing`);
  return fixture.kind === "judge-verdict" ? { kind: "judge", fixture } : { kind: "refutation", fixture };
}

const workload = retainedWorkload();
export const { prereg, fixtures } = workload;
export const inputs: ReadonlyMap<string, CaseInput> = new Map(prereg.cells.flatMap((cell) => cell.workload.cases.map((entry) =>
  [caseInputKey(cell.cell, entry.caseId), caseInput(entry.source, workload.cases, fixtures)] as const)));

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

/** A route substitute: every attempt advances the fake clock by ATTEMPT_MS,
 *  is recorded, and settles with the scripted outcome. */
export function fakeRoute(script: Script): FakeRoute {
  const requests: ArmRequest[] = [];
  let clock = 0;
  const dispatch: ArmDispatch = async (request) => {
    requests.push(request);
    clock += ATTEMPT_MS;
    const outcome = script(request);
    const acceptedPayload = outcome.kind === "accepted" ? { findings: [], nonce: requests.length } : null;
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

/** The window dispatch path the script runs, over a fake route. */
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
