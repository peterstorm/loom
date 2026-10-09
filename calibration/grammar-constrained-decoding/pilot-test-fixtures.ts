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
import { decidePreflight, type PreflightDecision, type PreflightFacts } from "./pilot-preflight";
import {
  buildPairSchedule,
  parsePreregistration,
  type CellPreregistration,
  type Preregistration,
  type RouteQualification,
  type ScheduledPair,
} from "./pilot-preregistration";
import { planDispatch, type LoadedPreregistration, type WindowWorkload } from "./pilot-retention";
import { contentDigest, type CellKey, type PilotArm } from "./pilot-vocabulary";
import { dispatchSchedule, type RouteHealthProbe, type SampleRecord } from "./pilot-window";
import { CURRENT_WINDOW_SCHEMA_VERSION } from "./pilot-window-ending";
import type { WindowRecord } from "./pilot-window-record";
import {
  parseWorkloadFixtures,
  resolveWindowInputs,
  WindowInputs,
  type CaseInput,
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
/** The pilot-2 preregistration: pilot-1's workload under the per-route release policy. */
export const PILOT_2_PREREGISTRATION = "preregistration-gcd-ad11-pilot-2.json";
export const pilot2PreregBytes = readFileSync(join(HERE, PILOT_2_PREREGISTRATION));
export const fixtureBytes = readFileSync(join(HERE, "workload-fixtures.json"));

/** A retained preregistration, parsed from its exact bytes; a refused one throws. */
function retainedPreregistration(bytes: Uint8Array): Preregistration {
  const parsed = parsePreregistration(JSON.parse(new TextDecoder().decode(bytes)));
  if (!parsed.ok) throw new Error(parsed.error.join("\n"));
  return parsed.value;
}

/** The retained pilot-1 preregistration (schemaVersion 1, `capable-route-required`). */
export const PILOT_1: Preregistration = retainedPreregistration(preregBytes);
/** The retained pilot-2 preregistration: pilot-1's workload under the per-route release policy. */
export const PILOT_2: Preregistration = retainedPreregistration(pilot2PreregBytes);

function retainedWorkload(): Readonly<{ fixtures: WorkloadFixtures; cases: readonly CalibrationCase[] }> {
  const fixtures = parseWorkloadFixtures(JSON.parse(fixtureBytes.toString("utf-8")));
  if (!fixtures.ok) throw new Error(fixtures.error.join("\n"));
  const corpus = parseCalibrationCorpus(readFileSync(join(REPO_ROOT, fixtures.value.reviewer.corpus), "utf-8"));
  if (!corpus.ok) throw new Error(corpus.errors.join("\n"));
  return { fixtures: fixtures.value, cases: corpus.value.cases };
}

const workload = retainedWorkload();
export const { fixtures } = workload;
export const corpusCases: readonly CalibrationCase[] = workload.cases;

/** The retained pilot-1 preregistration as a window loads it. */
export const LOADED: LoadedPreregistration = {
  ref: { path: "calibration/grammar-constrained-decoding/preregistration.json", digest: contentDigest(preregBytes), id: PILOT_1.id },
  prereg: PILOT_1,
};

/** Preflight facts of a route that refused the connection: the preflight blocks. */
export const UNREACHABLE_FACTS: PreflightFacts = {
  registry: { "reviewer-payload/v2": null, "reviewer-payload/v3": null, "judge-verdict/v1": null, "refutation-verdict/v1": null },
  workloadFixturesDigest: PILOT_1.workloadFixturesDigest,
  piVersion: PILOT_1.route.piVersion,
  stagedRuntimeRevision: "sha256:abc",
  loadedRuntimeRevision: null,
  route: { kind: "unreachable", reason: "connection refused" },
};

/** An opened `window.json` of this revision: a ready, dispatching window, or a blocked one. */
export const testWindowRecord = (dispatched: boolean): WindowRecord => {
  const preflight = dispatched ? READY : decidePreflight(PILOT_1, UNREACHABLE_FACTS);
  return {
    schemaVersion: CURRENT_WINDOW_SCHEMA_VERSION,
    windowId: "test-window",
    preregistration: LOADED.ref,
    workloadFixtures: { path: "calibration/grammar-constrained-decoding/workload-fixtures.json", digest: PILOT_1.workloadFixturesDigest },
    startedAt: "2026-10-05T08:00:00.000Z",
    preflightFacts: UNREACHABLE_FACTS,
    preflight,
    dispatch: planDispatch(preflight, false),
  };
};

/** The window workload `recordWindow` resolves, with no git-derived changed paths. */
export const WORKLOAD: WindowWorkload = { fixtures, loadCorpusCases: () => ({ ok: true, value: corpusCases }), changedPathsOf: () => [] };

const resolved = resolveWindowInputs(PILOT_1, fixtures, corpusCases, WORKLOAD.changedPathsOf);
if (!resolved.ok) throw new Error(resolved.error.join("\n"));
export const inputs: WindowInputs = resolved.value;

/** One preregistered case's resolved input, through the production lookup; a missing one throws. */
export function inputOf(cell: CellKey, caseId: string): CaseInput {
  const input = inputs.caseInput(cell, caseId);
  if (input === undefined) throw new Error(`${cell} ${caseId} has no resolved input`);
  return input;
}

/** Inputs filed through the production builder; a refused set throws. */
export function filedInputs(entries: Iterable<CaseInput>): WindowInputs {
  const filed = WindowInputs.of(entries);
  if (!filed.ok) throw new Error(filed.error.join("\n"));
  return filed.value;
}

/** The resolved inputs without one case's: a window whose lookup for it fails. */
export const inputsWithout = (cell: CellKey, caseId: string): WindowInputs =>
  filedInputs(inputs.values().filter((input) => !(input.cell === cell && input.caseId === caseId)));

/** A typed edit of a parsed preregistration; `testPreregistration` re-parses
 *  the edited value, so no edit can yield a preregistration the production
 *  parser refuses (a requalified cell's workload rules included). */
export type PreregistrationEdit = (prereg: Preregistration) => Preregistration;

const CONSTRAINED: RouteQualification = Object.freeze({
  kind: "constrained-emission", enforcedConstraints: Object.freeze(["type", "required", "enum", "additionalProperties"]), evidence: "test",
});
const EXTRACTION_ONLY: RouteQualification = Object.freeze({ kind: "extraction-only", reason: "route rejects the schema", evidence: "test" });

const requalified = (qualify: (cell: CellPreregistration) => RouteQualification): PreregistrationEdit =>
  (base) => ({ ...base, cells: base.cells.map((cell) => ({ ...cell, qualification: qualify(cell) })) });

/** Every cell but `except` qualified as a capable (constrained) route; `except` keeps its retained qualification. */
export const constrainedCells = (...except: readonly CellKey[]): PreregistrationEdit =>
  requalified((cell) => (except.includes(cell.cell) ? cell.qualification : CONSTRAINED));

/** One cell qualified extraction-only: the route cannot carry its schema, so it schedules nothing. */
export const extractionOnlyCell = (key: CellKey): PreregistrationEdit =>
  requalified((cell) => (cell.cell === key ? EXTRACTION_ONLY : cell.qualification));

/** The parse's minimum bootstrap, so the suites' release decisions stay cheap. */
const cheapBootstrap: PreregistrationEdit = (base) => ({ ...base, guardrails: { ...base.guardrails, bootstrapResamples: 200 } });

/** An edited preregistration through the production parser again. A
 *  schemaVersion 1 value's policy is implied by its version (the file never
 *  carries it), so it is left out of what is re-parsed. */
function reparsed(edited: Preregistration): Preregistration {
  const { releasePolicy: _implied, ...withoutPolicy } = edited;
  const parsed = parsePreregistration(edited.schemaVersion === 1 ? withoutPolicy : edited);
  if (!parsed.ok) throw new Error(parsed.error.join("\n"));
  return parsed.value;
}

/** A test preregistration: a retained one (pilot-1 by default) with a cheap
 *  bootstrap, then each edit in order, re-parsed. */
export const testPreregistration = (base: Preregistration = PILOT_1, ...edits: readonly PreregistrationEdit[]): Preregistration =>
  reparsed([cheapBootstrap, ...edits].reduce((edited, edit) => edit(edited), base));

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
export const firstPair = (): ScheduledPair => buildPairSchedule(PILOT_1)[0] as ScheduledPair;

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
/** What a route outage looks like from inside the window (`providerFailure`). */
export const INFRASTRUCTURE: Outcome = { kind: "infrastructure-failure", reason: "the provider ended the model turn with an error: Connection error." };

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

/** A route that always answers its listing: the fail-fast never trips on it. */
export const HEALTHY_ROUTE: RouteHealthProbe = async () => ({ kind: "reachable" });

/** The window dispatch path `recordWindow` runs, over a fake route. */
export async function runWindow(
  route: FakeRoute, onSample: (record: SampleRecord) => void = () => {}, routeHealth: RouteHealthProbe = HEALTHY_ROUTE,
) {
  const landed: SampleRecord[] = [];
  const progress: string[] = [];
  const { records, ending } = await dispatchSchedule({
    windowId: WINDOW_ID, prereg: PILOT_1, fixtures, inputs, dispatch: route.dispatch, routeHealth, now: route.now,
    onSample: (record) => { landed.push(record); onSample(record); },
    onPair: (index, total, pair) => { progress.push(`${index + 1}/${total} ${pair.pairId}`); },
  });
  return { records, ending, landed, progress };
}
