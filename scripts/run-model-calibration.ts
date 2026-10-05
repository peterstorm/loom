#!/usr/bin/env bun
/**
 * Opt-in live Pi calibration. Never runs in CI without an explicit opt-in.
 *
 * A dispatcher between thin shells; every decision lives in a pure core:
 *
 * - default — historical corpus calibration of one model profile. Core:
 *   `calibration/corpus-calibration.ts` (Pi stream folding, findings parse,
 *   per-case result); this shell spawns Pi per case and writes the results.
 * - `--pilot <preregistration.json> [--preflight-only] [--window-dir <dir>]
 *   [--assessment <file>]...` — the AD-11 matched calibration pilot of the
 *   grammar-constrained-decoding feature: content-addressed preflight (frozen
 *   registry digests, workload fixtures, Pi version, staged vs loaded
 *   Runtime Revision, live route reachability), then — only when the
 *   preflight is ready — matched emission-enabled vs extraction-only dispatch
 *   with dispatch-to-ingestion counters, persisted incrementally, then the
 *   release decision. Cores: `calibration/grammar-constrained-decoding/`;
 *   the window's retained files and decision rules are `pilot-retention.ts`
 *   (behind its `WindowStore` port), the matched dispatch is `pilot-window.ts`
 *   (behind the `ArmDispatch` port).
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
import { sha256Hex } from "../engine/src/core/digest";
import { calibrationRevisionPaths } from "../engine/src/handlers/helpers/model-calibration";
import { captureLoomRuntimeIdentity, PI_EXTENSION_RUNTIME_REVISION_ENV } from "../engine/src/runtime-compatibility";
import { corpusCaseResult, type CorpusRun } from "../calibration/corpus-calibration";
import {
  CELL_KEYS,
  contentDigest,
  decidePreflight,
  type PreflightFacts,
  type Preregistration,
  type Result,
  type RouteProbe,
} from "../calibration/grammar-constrained-decoding/pilot-core";
import {
  CELL_PRODUCER,
  cellSchemaBytes,
  parseCaseSource,
  parseWorkloadFixtures,
  type CaseInput,
  type WorkloadFixtures,
} from "../calibration/grammar-constrained-decoding/pilot-workload";
import { importRpcLauncher, piArmDispatch } from "../calibration/grammar-constrained-decoding/pilot-dispatch";
import { caseInputKey, dispatchSchedule } from "../calibration/grammar-constrained-decoding/pilot-window";
import {
  decideRetainedWindow,
  parsePreregistrationFile,
  planDispatch,
  recordWindow,
  type DecisionOutcome,
  type ExternalAssessment,
  type LoadedPreregistration,
  type WindowStore,
} from "../calibration/grammar-constrained-decoding/pilot-retention";

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
/** The shell boundary: a refused core Result becomes the CLI's error. */
const orThrow = <T>(result: Result<T, string>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

// ---------------------------------------------------------------------------
// Historical corpus calibration (same Pi invocation and result shape)
// ---------------------------------------------------------------------------

function corpusPrompt(corpusPath: string, caseId: string): string {
  const result = spawnSync("bun", [
    "engine/src/cli.ts", "helper", "model-calibration", "prompt",
    "--corpus", corpusPath, "--case", caseId,
  ], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || `could not build prompt for ${caseId}`);
  return result.stdout;
}

/** One case's Pi run. A case whose prompt cannot be built is not launched;
 *  it never aborts the other cases. */
function runCorpusCase(corpusPath: string, target: PiBinding, caseId: string): CorpusRun {
  let prompt: string;
  try {
    prompt = corpusPrompt(corpusPath, caseId);
  } catch (error) {
    return { kind: "unlaunched", reason: error instanceof Error ? error.message : String(error) };
  }
  const run = spawnSync("pi", [
    "--mode", "json", "-p", "--no-session",
    "--provider", target.provider,
    "--model", target.model,
    "--thinking", target.thinking,
    "--tools", "read,grep,find,ls,bash",
    prompt,
  ], { encoding: "utf-8", cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
  if (run.error !== undefined) return { kind: "unlaunched", reason: `spawn pi: ${run.error.message}` };
  return { kind: "exited", status: run.status, stdout: run.stdout, stderr: run.stderr };
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
  const cases = corpus.value.cases.map((entry) => corpusCaseResult(entry.id, runCorpusCase(corpusPath, target, entry.id)));

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

/** The filesystem adapter of the window store: one window directory. */
function fsWindowStore(dir: string): WindowStore {
  const at = (name: string): string => join(dir, name);
  return {
    read: (name) => (existsSync(at(name)) ? readFileSync(at(name), "utf-8") : null),
    write: (name, text) => {
      mkdirSync(dirname(at(name)), { recursive: true });
      writeFileSync(at(name), text);
    },
    append: (name, text) => {
      mkdirSync(dirname(at(name)), { recursive: true });
      appendFileSync(at(name), text);
    },
    list: (directory) => (existsSync(at(directory)) ? readdirSync(at(directory)) : []),
    locate: at,
  };
}

function loadPreregistration(path: string): Result<LoadedPreregistration, string> {
  const parsed = parsePreregistrationFile(readFileSync(path), path);
  if (!parsed.ok) return parsed;
  const { digest, prereg } = parsed.value;
  return { ok: true, value: Object.freeze({ ref: { path: repoRelative(path), digest, id: prereg.id }, prereg }) };
}

function loadFixtures(path: string): Readonly<{ digest: string; fixtures: WorkloadFixtures }> {
  const bytes = readFileSync(path);
  const parsed = parseWorkloadFixtures(JSON.parse(bytes.toString("utf-8")));
  if (!parsed.ok) throw new Error(`invalid workload fixtures ${path}:\n  - ${parsed.error.join("\n  - ")}`);
  return Object.freeze({ digest: contentDigest(bytes), fixtures: parsed.value });
}

const externalAssessments = (): readonly ExternalAssessment[] =>
  values("--assessment").map((path) => ({ path, text: readFileSync(path, "utf-8") }));

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

/** Every preregistered case's input, keyed by `caseInputKey`. */
function resolveWindowInputs(prereg: Preregistration, fixtures: WorkloadFixtures): ReadonlyMap<string, CaseInput> {
  const corpusCases = parseCalibrationCorpus(readFileSync(resolve(REPO_ROOT, fixtures.reviewer.corpus), "utf-8"));
  if (!corpusCases.ok) throw new Error(corpusCases.errors.join("\n"));
  const corpus = new Map(corpusCases.value.cases.map((entry) => [entry.id, entry] as const));
  return new Map(prereg.cells.flatMap((cell) => cell.workload.cases.map((entry) =>
    [caseInputKey(cell.cell, entry.caseId), resolveCaseInput(entry.source, corpus, fixtures)] as const)));
}

/** Prints a recorded decision; exit 0 only for `done-allowed`. */
function reportDecision(outcome: DecisionOutcome): number {
  if (outcome.kind === "inconsistent") {
    process.stderr.write(`Pilot evidence is inconsistent; no decision recorded:\n  - ${outcome.problems.join("\n  - ")}\n`);
    return 1;
  }
  process.stdout.write(`${outcome.file}\n`);
  process.stderr.write(`Release decision: ${outcome.decision}\n`);
  return outcome.decision === "done-allowed" ? 0 : 1;
}

async function runPilot(): Promise<number> {
  const preregPath = resolve(value("--pilot", ""));
  const loaded = orThrow(loadPreregistration(preregPath));
  const { prereg } = loaded;
  const fixturesPath = resolve(value("--fixtures", join(dirname(preregPath), "workload-fixtures.json")));
  const { digest: fixturesDigest, fixtures } = loadFixtures(fixturesPath);
  const startedAt = new Date().toISOString();
  const windowId = `${prereg.id}--${startedAt.replace(/[:.]/g, "-")}`;
  const store = fsWindowStore(resolve(value("--window-dir", join(dirname(preregPath), "windows", windowId))));
  const staged = captureLoomRuntimeIdentity(REPO_ROOT);
  const facts = await gatherPreflightFacts(prereg, fixturesDigest, staged.revision);
  const preflight = decidePreflight(prereg, facts);
  const outcome = await recordWindow({
    store,
    record: {
      schemaVersion: 1,
      windowId,
      preregistration: loaded.ref,
      workloadFixtures: { path: repoRelative(fixturesPath), digest: fixturesDigest },
      startedAt,
      preflightFacts: facts,
      preflight,
      dispatch: planDispatch(preflight, args.includes("--preflight-only")),
    },
    preregistration: loaded,
    // Matched dispatch of the whole schedule through the live Pi adapter.
    dispatch: async (persist) => {
      const inputs = resolveWindowInputs(prereg, fixtures);
      const dispatch = piArmDispatch({
        repoRoot: REPO_ROOT,
        piCommand: "pi",
        loadLauncher: importRpcLauncher(resolve(value("--launcher", join(homedir(), ".pi/agent/extensions/subagent/rpc-launcher.ts")))),
        provider: prereg.route.provider,
        model: prereg.route.model,
        thinking: prereg.route.thinking,
        tools: PILOT_TOOLS,
        stagedRevision: staged.revision,
        timeoutMs: prereg.perAttemptTimeoutMs,
        readinessTimeoutMs: READINESS_TIMEOUT_MS,
      });
      const records = await dispatchSchedule({
        windowId, prereg, fixtures, inputs, dispatch,
        now: () => performance.now(),
        onSample: persist,
        onPair: (index, total, pair) => { process.stderr.write(`pilot ${index + 1}/${total} ${pair.pairId}\n`); },
      });
      return { records, inputs };
    },
    externalAssessments: externalAssessments(),
    now: () => new Date().toISOString(),
  });
  return reportDecision(orThrow(outcome));
}

/** Offline: re-evaluate a retained window from its retained assessments —
 *  any `--assessment` file is retained into `assessments/` first. */
function decideWindow(dir: string): number {
  return reportDecision(orThrow(decideRetainedWindow({
    store: fsWindowStore(dir),
    loadPreregistration: (path) => loadPreregistration(resolve(REPO_ROOT, path)),
    externalAssessments: externalAssessments(),
    now: () => new Date().toISOString(),
  })));
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
