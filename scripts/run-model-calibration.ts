#!/usr/bin/env bun
/**
 * Opt-in live Pi calibration. Never runs in CI without an explicit opt-in.
 *
 * Modes (the imperative shell; every decision lives in pure cores):
 *
 * - default — historical corpus calibration of one model profile (refactored
 *   into functions; same Pi invocation and result shape).
 * - `--pilot <preregistration.json> [--preflight-only] [--window-dir <dir>]
 *   [--assessment <file>]...` — the AD-11 matched calibration pilot of the
 *   grammar-constrained-decoding feature: content-addressed preflight (frozen
 *   registry digests, workload fixtures, Pi version, staged vs loaded
 *   Runtime Revision, live route reachability), then — only when the
 *   preflight is ready — matched emission-enabled vs extraction-only dispatch
 *   with dispatch-to-ingestion counters, persisted incrementally, then the
 *   release decision. Core: `calibration/grammar-constrained-decoding/`;
 *   the window dispatch path behind the `ArmDispatch` port is `pilot-window.ts`.
 * - `--decide <window-dir> [--assessment <file>]...` — offline re-evaluation
 *   of a retained window once blinded assessments arrive. Makes no model
 *   call, so it needs no opt-in.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseCalibrationCorpus, type CalibrationCase } from "../engine/src/core/model-calibration";
import { lowerModelProfile, resolveModelProfile, type LlmProfileId, type PiBinding } from "../engine/src/core/model-profiles";
import { EMISSION_TOOL_SPECS } from "../engine/src/core/emission-tool";
import { sha256Hex } from "../engine/src/core/review-packet";
import { calibrationRevisionPaths } from "../engine/src/handlers/helpers/model-calibration";
import { captureLoomRuntimeIdentity, PI_EXTENSION_RUNTIME_REVISION_ENV } from "../engine/src/runtime-compatibility";
import {
  CELL_KEYS,
  contentDigest,
  decidePreflight,
  evaluatePilot,
  parseBlindingKey,
  parsePreflightFacts,
  parsePreregistration,
  parseQualityAssessment,
  parseSampleObservation,
  type BlindingKey,
  type PreflightDecision,
  type PreflightFacts,
  type Preregistration,
  type QualityAssessment,
  type RouteProbe,
  type SampleObservation,
} from "../calibration/grammar-constrained-decoding/pilot-core";
import {
  CELL_PRODUCER,
  cellSchemaBytes,
  parseCaseSource,
  parseWorkloadFixtures,
  type CaseInput,
  type WorkloadFixtures,
} from "../calibration/grammar-constrained-decoding/pilot-workload";
import { piArmDispatch } from "../calibration/grammar-constrained-decoding/pilot-dispatch";
import {
  blind,
  blindedPacket,
  caseInputKey,
  dispatchSchedule,
  rubricAssessment,
  type SampleRecord,
} from "../calibration/grammar-constrained-decoding/pilot-window";

const args = process.argv.slice(2);
const value = (flag: string, fallback: string): string => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const values = (flag: string): readonly string[] =>
  args.flatMap((arg, index) => (arg === flag && args[index + 1] ? [args[index + 1]!] : []));
const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
/** Retained records name files relative to the checkout, never by machine path. */
const repoRelative = (path: string): string => relative(REPO_ROOT, path);

// ---------------------------------------------------------------------------
// Historical corpus calibration (same Pi invocation and result shape)
// ---------------------------------------------------------------------------

type CorpusCaseResult =
  | Readonly<{ case_id: string; status: "executed"; findings: unknown[] }>
  | Readonly<{ case_id: string; status: "not-executed"; reason: string }>;

function corpusPrompt(corpusPath: string, caseId: string): string {
  const result = spawnSync("bun", [
    "engine/src/cli.ts", "helper", "model-calibration", "prompt",
    "--corpus", corpusPath, "--case", caseId,
  ], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || `could not build prompt for ${caseId}`);
  return result.stdout;
}

function finalText(stdout: string): string | null {
  let answer: string | null = null;
  const malformed: string[] = [];
  for (const [index, line] of stdout.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = event.message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") ?? "";
        if (text.trim()) answer = text;
      }
    } catch (error) {
      malformed.push(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (malformed.length > 0) {
    throw new Error(`Pi JSON stream contained ${malformed.length} malformed line(s): ${malformed.join("; ")}`);
  }
  return answer;
}

function findings(text: string): unknown[] {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(unfenced);
  if (!Array.isArray(parsed)) throw new Error("model output was not a JSON array");
  return parsed;
}

function calibrateCorpusCase(corpusPath: string, target: PiBinding, caseId: string): CorpusCaseResult {
  // `corpusPrompt()` throws when the helper cannot build this case's prompt.
  // Built INSIDE the try that isolates one case: evaluated as a `spawnSync`
  // argument it sat outside, so a single unbuildable case aborted the whole
  // run before any result was written.
  try {
    const run = spawnSync("pi", [
      "--mode", "json", "-p", "--no-session",
      "--provider", target.provider,
      "--model", target.model,
      "--thinking", target.thinking,
      "--tools", "read,grep,find,ls,bash",
      corpusPrompt(corpusPath, caseId),
    ], { encoding: "utf-8", cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) {
      return { case_id: caseId, status: "not-executed", reason: run.stderr.trim() || `pi exited ${run.status}` };
    }
    const text = finalText(run.stdout);
    if (!text) throw new Error("Pi produced no final assistant text");
    return { case_id: caseId, status: "executed", findings: findings(text) };
  } catch (error) {
    return { case_id: caseId, status: "not-executed", reason: error instanceof Error ? error.message : String(error) };
  }
}

function runCorpusCalibration(): void {
  const profileId = value("--profile", "focused-review") as LlmProfileId;
  const corpusPath = resolve(value("--corpus", "calibration/corpus.json"));
  const outputPath = resolve(value("--output", `calibration/results/${profileId}.json`));
  const profile = resolveModelProfile(profileId);
  if (!profile.ok) throw new Error(profile.error.message);
  const target = lowerModelProfile(profile.value, "pi");
  const corpus = parseCalibrationCorpus(readFileSync(corpusPath, "utf-8"));
  if (!corpus.ok) throw new Error(corpus.errors.join("\n"));
  const cases = corpus.value.cases.map((entry) => calibrateCorpusCase(corpusPath, target, entry.id));

  const output = { schema_version: 1, profile_id: profileId, cases };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
  const notExecuted = cases.filter((entry) => entry.status === "not-executed");
  process.stdout.write(`${outputPath}\n`);
  process.stderr.write(
    `Calibration execution: ${cases.length - notExecuted.length}/${cases.length} executed, ` +
    `${notExecuted.length} not executed.\n`,
  );
  if (notExecuted.length > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// AD-11 matched pilot — shell
// ---------------------------------------------------------------------------

const PILOT_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
const ROUTE_PROBE_TIMEOUT_MS = 10_000;
const READINESS_TIMEOUT_MS = 45_000;

/** The files of one retained window directory. */
const windowFiles = (dir: string) => Object.freeze({
  window: join(dir, "window.json"),
  observations: join(dir, "observations.jsonl"),
  payloads: join(dir, "accepted-payloads.jsonl"),
  key: join(dir, "blinding-key.json"),
  packet: join(dir, "blinded-assessment-packet.json"),
  assessments: join(dir, "assessments"),
  decision: join(dir, "release-decision.json"),
  decisionLog: join(dir, "decision-log.jsonl"),
});

const writeJson = (path: string, data: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
};

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf-8"));

type LoadedPreregistration = Readonly<{ path: string; digest: string; prereg: Preregistration }>;

function loadPreregistration(path: string): LoadedPreregistration {
  const bytes = readFileSync(path);
  const parsed = parsePreregistration(JSON.parse(bytes.toString("utf-8")));
  if (!parsed.ok) throw new Error(`invalid preregistration ${path}:\n  - ${parsed.error.join("\n  - ")}`);
  return Object.freeze({ path, digest: contentDigest(bytes), prereg: parsed.value });
}

function loadFixtures(path: string): Readonly<{ digest: string; fixtures: WorkloadFixtures }> {
  const bytes = readFileSync(path);
  const parsed = parseWorkloadFixtures(JSON.parse(bytes.toString("utf-8")));
  if (!parsed.ok) throw new Error(`invalid workload fixtures ${path}:\n  - ${parsed.error.join("\n  - ")}`);
  return Object.freeze({ digest: contentDigest(bytes), fixtures: parsed.value });
}

async function probeRoute(baseUrl: string): Promise<RouteProbe> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(ROUTE_PROBE_TIMEOUT_MS) });
    if (!response.ok) return { kind: "unreachable", reason: `GET /models answered HTTP ${response.status}` };
    const body: unknown = await response.json();
    const data = typeof body === "object" && body !== null && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data : [];
    return {
      kind: "reachable",
      servedModels: data.flatMap((entry) =>
        typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string" ? [(entry as { id: string }).id] : []),
    };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
    return { kind: "unreachable", reason: `GET ${baseUrl}/models failed: ${error instanceof Error ? error.message : String(error)}${cause}` };
  }
}

function observedPiVersion(): string | null {
  const run = spawnSync("pi", ["--version"], { encoding: "utf-8" });
  return run.status === 0 ? run.stdout.trim() || null : null;
}

async function gatherPreflightFacts(prereg: Preregistration, fixturesDigest: string, stagedRevision: string): Promise<PreflightFacts> {
  const registry = Object.fromEntries(CELL_KEYS.map((cell) => {
    const producer = CELL_PRODUCER[cell];
    return [cell, { toolName: EMISSION_TOOL_SPECS[producer.kind].toolName, schemaDigest: sha256Hex(cellSchemaBytes(cell)) }];
  })) as PreflightFacts["registry"];
  return Object.freeze({
    registry,
    workloadFixturesDigest: fixturesDigest,
    piVersion: observedPiVersion(),
    stagedRuntimeRevision: stagedRevision,
    loadedRuntimeRevision: process.env[PI_EXTENSION_RUNTIME_REVISION_ENV] ?? null,
    route: await probeRoute(prereg.route.baseUrl),
  });
}

function resolveCaseInput(source: string, corpus: ReadonlyMap<string, CalibrationCase>, fixtures: WorkloadFixtures): CaseInput {
  const parsed = parseCaseSource(source);
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.value.kind === "corpus") {
    const corpusCase = corpus.get(parsed.value.id);
    if (corpusCase === undefined) throw new Error(`corpus case ${parsed.value.id} is not in the corpus`);
    return { kind: "corpus", corpusCase, changedPaths: calibrationRevisionPaths(corpusCase.revision) };
  }
  const fixture = fixtures.fixtures[parsed.value.id];
  if (fixture === undefined) throw new Error(`workload fixture ${parsed.value.id} is not in the fixture file`);
  return fixture.kind === "judge-verdict" ? { kind: "judge", fixture } : { kind: "refutation", fixture };
}

function parseAssessmentFile(path: string): QualityAssessment {
  const parsed = parseQualityAssessment(readJson(path));
  if (!parsed.ok) throw new Error(`invalid assessment ${path}:\n  - ${parsed.error.join("\n  - ")}`);
  return parsed.value;
}

/** AS-017 retention: every assessment a decision reads lives in the window.
 *  An external `--assessment` file is copied to `assessments/<assessorId>.json`
 *  first; re-submitting identical bytes is a no-op, and a DIFFERENT assessment
 *  for an already-retained assessor is refused — never overwritten. */
function retainAssessments(dir: string, paths: readonly string[]): void {
  const { assessments } = windowFiles(dir);
  for (const path of paths) {
    const bytes = readFileSync(path, "utf-8");
    const target = join(assessments, `${parseAssessmentFile(path).assessorId}.json`);
    if (existsSync(target)) {
      if (readFileSync(target, "utf-8") === bytes) continue;
      throw new Error(`assessment ${repoRelative(target)} is already retained with different content; a retained assessment is never overwritten`);
    }
    mkdirSync(assessments, { recursive: true });
    writeFileSync(target, bytes);
  }
}

/** The retained assessments of a window, in a stable order. */
function retainedAssessments(dir: string): readonly QualityAssessment[] {
  const { assessments } = windowFiles(dir);
  return existsSync(assessments)
    ? readdirSync(assessments).filter((name) => name.endsWith(".json")).sort().map((name) => parseAssessmentFile(join(assessments, name)))
    : [];
}

function decideAndPersist(
  dir: string,
  loaded: LoadedPreregistration,
  preflight: PreflightDecision,
  observations: readonly SampleObservation[],
  key: BlindingKey | null,
  assessments: readonly QualityAssessment[],
): number {
  const evaluation = evaluatePilot({ preregistration: loaded.prereg, preflight, observations, quality: { key, assessments } });
  if (!evaluation.ok) {
    process.stderr.write(`Pilot evidence is inconsistent; no decision recorded:\n  - ${evaluation.error.problems.join("\n  - ")}\n`);
    return 1;
  }
  const record = {
    schemaVersion: 1,
    decidedAt: new Date().toISOString(),
    preregistration: { path: repoRelative(loaded.path), digest: loaded.digest, id: loaded.prereg.id },
    decidedFrom: { observations: observations.length, assessors: assessments.map((assessment) => assessment.assessorId) },
    decision: evaluation.value.decision,
    cells: evaluation.value.cells,
  };
  // `release-decision.json` is the CURRENT decision; the log is append-only,
  // so a re-decision (new assessments) can never erase an earlier verdict —
  // a violated guardrail stays on record (no favourable-window chasing).
  writeJson(windowFiles(dir).decision, record);
  appendFileSync(windowFiles(dir).decisionLog, JSON.stringify(record) + "\n");
  process.stdout.write(`${windowFiles(dir).decision}\n`);
  process.stderr.write(`Release decision: ${evaluation.value.decision.kind}\n`);
  return evaluation.value.decision.kind === "done-allowed" ? 0 : 1;
}

async function runPilot(): Promise<number> {
  const loaded = loadPreregistration(resolve(value("--pilot", "")));
  const { prereg } = loaded;
  const fixturesPath = resolve(value("--fixtures", join(dirname(loaded.path), "workload-fixtures.json")));
  const { digest: fixturesDigest, fixtures } = loadFixtures(fixturesPath);
  const startedAt = new Date().toISOString();
  const windowId = `${prereg.id}--${startedAt.replace(/[:.]/g, "-")}`;
  const dir = resolve(value("--window-dir", join(dirname(loaded.path), "windows", windowId)));
  if (existsSync(windowFiles(dir).window)) throw new Error(`window ${dir} already exists; a retained window is never overwritten`);
  const staged = captureLoomRuntimeIdentity(REPO_ROOT);
  const facts = await gatherPreflightFacts(prereg, fixturesDigest, staged.revision);
  const preflight = decidePreflight(prereg, facts);
  const dispatchPlan = planDispatch(preflight, args.includes("--preflight-only"));
  const windowRecord = {
    schemaVersion: 1,
    windowId,
    preregistration: { path: repoRelative(loaded.path), digest: loaded.digest, id: prereg.id },
    workloadFixtures: { path: repoRelative(fixturesPath), digest: fixturesDigest },
    startedAt,
    preflightFacts: facts,
    preflight,
    dispatch: dispatchPlan,
  };
  writeJson(windowFiles(dir).window, windowRecord);

  const inputs = dispatchPlan.kind === "dispatched" ? resolveWindowInputs(prereg, fixtures) : new Map<string, CaseInput>();
  const records = dispatchPlan.kind === "dispatched"
    ? await dispatchWindow(dir, windowId, prereg, fixtures, inputs, staged.revision)
    : [];
  const key = retainBlindedPacket(dir, windowId, prereg, records, inputs);
  writeJson(windowFiles(dir).window, { ...windowRecord, endedAt: new Date().toISOString(), observations: records.length });
  retainAssessments(dir, values("--assessment"));
  return decideAndPersist(dir, loaded, preflight, records.map((record) => record.sample), key, retainedAssessments(dir));
}

type DispatchPlan = Readonly<{ kind: "not-attempted"; reason: string }> | Readonly<{ kind: "dispatched" }>;

function planDispatch(preflight: PreflightDecision, preflightOnly: boolean): DispatchPlan {
  if (preflight.kind === "blocked") return { kind: "not-attempted", reason: "preflight blocked — no sample is dispatched or fabricated" };
  if (preflightOnly) return { kind: "not-attempted", reason: "--preflight-only" };
  return { kind: "dispatched" };
}

/** Every preregistered case's input, keyed by `caseInputKey`. */
function resolveWindowInputs(prereg: Preregistration, fixtures: WorkloadFixtures): ReadonlyMap<string, CaseInput> {
  const corpusCases = parseCalibrationCorpus(readFileSync(resolve(REPO_ROOT, fixtures.reviewer.corpus), "utf-8"));
  if (!corpusCases.ok) throw new Error(corpusCases.errors.join("\n"));
  const corpus = new Map(corpusCases.value.cases.map((entry) => [entry.id, entry] as const));
  return new Map(prereg.cells.flatMap((cell) => cell.workload.cases.map((entry) =>
    [caseInputKey(cell.cell, entry.caseId), resolveCaseInput(entry.source, corpus, fixtures)] as const)));
}

/** Matched dispatch of the whole schedule through the live Pi adapter; every
 *  sample is persisted as it lands, so an interrupted window retains every observation. */
async function dispatchWindow(
  dir: string, windowId: string, prereg: Preregistration, fixtures: WorkloadFixtures,
  inputs: ReadonlyMap<string, CaseInput>, stagedRevision: string,
): Promise<readonly SampleRecord[]> {
  const dispatch = piArmDispatch({
    repoRoot: REPO_ROOT,
    piCommand: "pi",
    launcherModule: resolve(value("--launcher", join(homedir(), ".pi/agent/extensions/subagent/rpc-launcher.ts"))),
    provider: prereg.route.provider,
    model: prereg.route.model,
    thinking: prereg.route.thinking,
    tools: PILOT_TOOLS,
    stagedRevision,
    timeoutMs: prereg.perAttemptTimeoutMs,
    readinessTimeoutMs: READINESS_TIMEOUT_MS,
  });
  return dispatchSchedule({
    windowId, prereg, fixtures, inputs, dispatch,
    now: () => performance.now(),
    onSample: ({ sample, acceptedPayload }) => {
      appendFileSync(windowFiles(dir).observations, JSON.stringify(sample) + "\n");
      if (acceptedPayload !== null) {
        appendFileSync(windowFiles(dir).payloads, JSON.stringify({ pairId: sample.pairId, arm: sample.arm, payload: acceptedPayload }) + "\n");
      }
    },
    onPair: (index, total, pair) => { process.stderr.write(`pilot ${index + 1}/${total} ${pair.pairId}\n`); },
  });
}

/** Writes the blinding key, the blinded assessment packet and the rubric assessment; returns the key.
 *  The key and packet are retained first, so an unassessable rubric fails loudly
 *  without losing them; no rubric file is written then, which the decision core
 *  reads as a missing assessor — never as zero escapes. */
function retainBlindedPacket(
  dir: string, windowId: string, prereg: Preregistration, records: readonly SampleRecord[], inputs: ReadonlyMap<string, CaseInput>,
): BlindingKey {
  const blinded = blind(windowId, records);
  writeJson(windowFiles(dir).key, blinded.key);
  writeJson(windowFiles(dir).packet, blindedPacket(windowId, blinded.entries));
  const rubric = rubricAssessment(prereg, blinded.entries, inputs);
  if (!rubric.ok) throw new Error(`the rubric assessor cannot assess window ${windowId}:\n${rubric.error.join("\n")}`);
  writeJson(join(windowFiles(dir).assessments, "rubric-v1.json"), rubric.value);
  return blinded.key;
}

/** Offline: re-evaluate a retained window from its retained assessments —
 *  any `--assessment` file is retained into `assessments/` first. */
function decideWindow(dir: string): number {
  const files = windowFiles(dir);
  const window = readJson(files.window) as { preregistration?: { path?: unknown; digest?: unknown }; preflightFacts?: unknown };
  const prePath = window.preregistration?.path;
  if (typeof prePath !== "string") throw new Error(`${files.window} carries no preregistration record`);
  const facts = parsePreflightFacts(window.preflightFacts);
  if (!facts.ok) throw new Error(`${files.window} preflight facts: ${facts.error.join("; ")}`);
  const loaded = loadPreregistration(resolve(REPO_ROOT, prePath));
  if (loaded.digest !== window.preregistration?.digest) {
    throw new Error(`preregistration ${prePath} changed after window ${dir} was recorded (digest ${loaded.digest} ≠ ${String(window.preregistration?.digest)})`);
  }
  const observations = existsSync(files.observations)
    ? readFileSync(files.observations, "utf-8").split("\n").filter((line) => line.trim()).map((line, index) => {
        const parsed = parseSampleObservation(JSON.parse(line));
        if (!parsed.ok) throw new Error(`observation line ${index + 1}: ${parsed.error.join("; ")}`);
        return parsed.value;
      })
    : [];
  const key = existsSync(files.key) ? parseBlindingKey(readJson(files.key)) : null;
  if (key !== null && !key.ok) throw new Error(`blinding key: ${key.error.join("; ")}`);
  retainAssessments(dir, values("--assessment"));
  // The preflight is RE-DERIVED from the retained facts by the same pure
  // decision, never trusted as a stored verdict.
  return decideAndPersist(dir, loaded, decidePreflight(loaded.prereg, facts.value), observations, key?.value ?? null,
    retainedAssessments(dir));
}

// ---------------------------------------------------------------------------
// Entry (last: every module-level binding above is initialized)
// ---------------------------------------------------------------------------

if (args.includes("--decide")) {
  process.exitCode = decideWindow(resolve(value("--decide", "")));
} else {
  if (process.env.LOOM_RUN_MODEL_CALIBRATION !== "1") {
    process.stderr.write("Calibration NOT executed. Set LOOM_RUN_MODEL_CALIBRATION=1 explicitly.\n");
    process.exit(2);
  }
  if (args.includes("--pilot")) process.exitCode = await runPilot();
  else runCorpusCalibration();
}
