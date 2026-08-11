import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isReviewAgent } from "../../config";
import type { HookHandler, HookResult } from "../../types";
import {
  aggregateLegacyStandaloneReview,
  captureStandaloneReviewerBytes,
  finalizeStandaloneReview,
  parseStandaloneAggregate,
  parseStandaloneReviewScope,
  serializeHistoricalAdjudicatedStandaloneReview,
  serializeStandaloneAggregate,
  type PreparedStandaloneReviewerCapture,
  type StandaloneCaptureAuthority,
  type StandaloneCaptureError,
  type StandaloneReviewAggregate,
  type StandaloneReviewerRole,
} from "../../core/standalone-review";
import { parseArtifactRef, type ArtifactRef } from "../../core/orchestration-contract";
import { resolveReviewFindings, reviewResolutionLog } from "../../core/review-output";
import {
  argumentValue,
  contractError,
  parseRunDirectory,
  prepareWriteTargets,
  publishStagedRunFile,
  readRunFileNoFollow,
  removeRunFileNoFollow,
  requireRunDirectoriesNoFollow,
  writeCanonicalOutput,
  writeRunFileExclusiveNoFollow,
} from "./panel-run";

export const STANDALONE_REVIEW_OPERATIONS = ["init", "aggregate", "finalize"] as const;
const USAGE =
  `Usage: helper standalone-review <${STANDALONE_REVIEW_OPERATIONS.join("|")}> ` +
  "--runs-root <dir> --run-dir <dir> [--input <review-plan.json|review-input.json>]";
const usageError: HookResult = { kind: "error", message: USAGE };

/**
 * Harness-facing FR-033 boundary. Pi/Claude adapters (T11) pass the attributed
 * request id and exact completion bytes here; this entry point only returns a
 * request-bound capture intent and never asks the parent to publish output.
 */
export function prepareStandaloneReviewHarnessCapture(input: Readonly<{
  captureAuthority: StandaloneCaptureAuthority;
  requestId: unknown;
  rawBytes: unknown;
}>): Readonly<{ ok: true; value: PreparedStandaloneReviewerCapture }> |
  Readonly<{ ok: false; error: StandaloneCaptureError }> {
  return captureStandaloneReviewerBytes(input.captureAuthority, input.requestId, input.rawBytes);
}

type Parse<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };
interface ReviewInputEntry {
  readonly agent: StandaloneReviewerRole;
  readonly transcript: string;
  readonly expectedByteLength: number | null;
  readonly expectedSha256: string | null;
}
interface ReviewSession {
  readonly runId: string;
  readonly scope: readonly string[];
  readonly expectedAgents: readonly StandaloneReviewerRole[];
  readonly transcriptSlots: readonly string[];
}

function readJson(path: string, label: string, expectedParent: string): Parse<unknown> {
  const absolute = resolve(path);
  if (dirname(absolute) !== resolve(expectedParent)) {
    return { ok: false, errors: [`${label} must be directly inside ${expectedParent}: ${path}`] };
  }
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 || realpathSync(absolute) !== absolute) {
      return { ok: false, errors: [`${label} must be a non-empty regular non-symlink file: ${path}`] };
    }
    return { ok: true, value: JSON.parse(readFileSync(absolute, "utf-8")) };
  } catch (error) {
    return { ok: false, errors: [`cannot read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function parseAgents(raw: unknown, label: string, errors: string[]): readonly StandaloneReviewerRole[] {
  const agents = Array.isArray(raw) && raw.every((agent) => typeof agent === "string" && agent.trim() !== "")
    ? raw.map((agent) => (agent as string).trim().replace(/^loom:/, "")) : [];
  if (agents.length === 0) errors.push(`${label} must be a non-empty string array`);
  if (new Set(agents).size !== agents.length) errors.push(`${label} must be distinct`);
  for (const agent of agents) {
    if (!isReviewAgent(agent)) errors.push(`${label} contains a non-Machine-Summary reviewer: ${agent}`);
  }
  return agents.filter(isReviewAgent) as StandaloneReviewerRole[];
}

function transcriptSlots(agents: readonly StandaloneReviewerRole[]): readonly string[] {
  return Object.freeze(agents.map((agent, index) => `reviewers/${index + 1}-${agent}.md`));
}

/** Existing files and every existing parent component must be non-symlinks. */
function scopeSafetyErrors(scope: readonly string[]): readonly string[] {
  const errors: string[] = [];
  for (const path of scope) {
    const segments = path.split("/");
    let cursor = resolve(".");
    for (const segment of segments) {
      cursor = join(cursor, segment);
      try {
        // lstat must be the first inspection: existsSync follows dangling
        // symlinks and would misclassify them as an absent safe path.
        if (lstatSync(cursor).isSymbolicLink()) {
          errors.push(`review plan.scope contains a symlink-unsafe path component: ${path}`);
          break;
        }
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
        if (code === "ENOENT" || code === "ENOTDIR") break; // deletion/new path: explicitly absent
        errors.push(`cannot inspect review plan.scope path ${path}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
  }
  return errors;
}

function parseReviewPlan(raw: unknown, runId: string): Parse<ReviewSession> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: ["review plan must be an object"] };
  const record = raw as Record<string, unknown>;
  const errors: string[] = [];
  const parsedScope = parseStandaloneReviewScope(record.scope, "review plan.scope");
  if (!parsedScope.ok) errors.push(...parsedScope.errors);
  const expectedAgents = parseAgents(record.expected_agents, "review plan.expected_agents", errors);
  if (parsedScope.ok) errors.push(...scopeSafetyErrors(parsedScope.value));
  return errors.length > 0 || !parsedScope.ok
    ? { ok: false, errors }
    : { ok: true, value: {
        runId,
        scope: parsedScope.value,
        expectedAgents,
        transcriptSlots: transcriptSlots(expectedAgents),
      } };
}

function serializeSession(session: ReviewSession): string {
  return JSON.stringify({
    schema_version: 1,
    run_id: session.runId,
    scope: session.scope,
    expected_agents: session.expectedAgents,
    transcript_slots: session.transcriptSlots,
  }, null, 2);
}

function parseSession(raw: unknown, expectedRunId: string): Parse<ReviewSession> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: ["review session must be an object"] };
  const record = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (record.schema_version !== 1) errors.push("review session.schema_version must be 1");
  if (record.run_id !== expectedRunId) errors.push(`review session.run_id must equal run directory '${expectedRunId}'`);
  const plan = parseReviewPlan(record, expectedRunId);
  if (!plan.ok) errors.push(...plan.errors.map((error) => error.replace(/^review plan\./, "review session.")));
  // Historical schema-v1 sessions predate the explicit slot projection. Their
  // slots are still deterministically derived from expected_agents; new v1
  // sessions persist the projection and must match it exactly.
  if (plan.ok && record.transcript_slots !== undefined && (
    !Array.isArray(record.transcript_slots) ||
    record.transcript_slots.length !== plan.value.transcriptSlots.length ||
    record.transcript_slots.some((slot, index) => slot !== plan.value.transcriptSlots[index])
  )) {
    errors.push("review session.transcript_slots must exactly match the immutable reviewer slots");
  }
  return errors.length > 0 || !plan.ok ? { ok: false, errors } : { ok: true, value: plan.value };
}

/** Load both copies of the frozen authority and prove lockstep. */
function loadReviewAuthority(runDir: string): Parse<ReviewSession> {
  const runId = basename(runDir);
  const planRaw = readJson(join(runDir, "review-plan.json"), "review plan", runDir);
  if (!planRaw.ok) return planRaw;
  const plan = parseReviewPlan(planRaw.value, runId);
  if (!plan.ok) return plan;

  const sessionRaw = readJson(join(runDir, "session.json"), "review session", runDir);
  if (!sessionRaw.ok) return sessionRaw;
  const session = parseSession(sessionRaw.value, runId);
  if (!session.ok) return session;

  return serializeSession(plan.value) === serializeSession(session.value)
    ? session
    : {
        ok: false,
        errors: ["session.json does not match the frozen scope and expected agents in review-plan.json"],
      };
}

function parseObservedReviews(raw: unknown, expectedAgents: readonly StandaloneReviewerRole[]): Parse<readonly ReviewInputEntry[]> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: ["review input must be an object"] };
  const record = raw as Record<string, unknown>;
  const versioned = Object.hasOwn(record, "schema_version");
  const topKeys = Object.keys(record);
  const allowedTop = versioned ? ["schema_version", "reviews"] : ["reviews"];
  const errors = topKeys.filter((key) => !allowedTop.includes(key)).map((key) => `review input contains unknown field '${key}'`);
  if (versioned && record.schema_version !== 1) errors.push("review input.schema_version must be 1");
  if (!Array.isArray(record.reviews) || record.reviews.length === 0) {
    return { ok: false, errors: [...errors, "review input.reviews must be a non-empty array"] };
  }
  const reviews: ReviewInputEntry[] = [];
  for (const [index, entry] of record.reviews.entries()) {
    const path = `review input.reviews[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) { errors.push(`${path} must be an object`); continue; }
    const item = entry as Record<string, unknown>;
    const allowed = versioned ? ["agent", "transcript", "byte_length", "sha256"] : ["agent", "transcript"];
    errors.push(...Object.keys(item).filter((key) => !allowed.includes(key)).map((key) => `${path} contains unknown field '${key}'`));
    const rawAgent = typeof item.agent === "string" ? item.agent.trim().replace(/^loom:/, "") : "";
    const transcript = typeof item.transcript === "string" ? item.transcript.trim() : "";
    if (rawAgent === "" || !isReviewAgent(rawAgent)) errors.push(`${path}.agent must be a standalone Machine-Summary reviewer`);
    if (transcript === "") errors.push(`${path}.transcript must be non-empty`);
    const expectedByteLength = versioned && typeof item.byte_length === "number" && Number.isSafeInteger(item.byte_length) && item.byte_length > 0
      ? item.byte_length : null;
    const expectedSha256 = versioned && typeof item.sha256 === "string" && /^[0-9a-f]{64}$/.test(item.sha256)
      ? item.sha256 : null;
    if (versioned && expectedByteLength === null) errors.push(`${path}.byte_length must be a positive safe integer`);
    if (versioned && expectedSha256 === null) errors.push(`${path}.sha256 must be a lowercase SHA-256 digest`);
    if (isReviewAgent(rawAgent)) reviews.push({
      agent: rawAgent as StandaloneReviewerRole,
      transcript,
      expectedByteLength,
      expectedSha256,
    });
  }
  const observed = reviews.map(({ agent }) => agent);
  if (new Set(observed).size !== observed.length) errors.push("review input agents must be distinct");
  if (observed.length !== expectedAgents.length || observed.some((agent, index) => agent !== expectedAgents[index])) {
    errors.push("review input.reviews must match the pre-spawn session expected_agents exactly, in spawn order");
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: reviews };
}

type LoadedTranscript = Readonly<{
  agent: StandaloneReviewerRole;
  output: string;
  artifact: ArtifactRef;
}>;

function loadTranscripts(runDir: string, reviews: readonly ReviewInputEntry[]): Parse<readonly LoadedTranscript[]> {
  const expectedParent = resolve(join(runDir, "reviewers"));
  const errors: string[] = [];
  const transcripts: LoadedTranscript[] = [];
  const seenRealpaths = new Set<string>();
  const seenFiles = new Set<string>();
  try {
    const expectedNames = reviews.map((review, index) => `${index + 1}-${review.agent}.md`).sort();
    const observedNames = readdirSync(expectedParent).sort();
    if (observedNames.length !== expectedNames.length || observedNames.some((name, index) => name !== expectedNames[index])) {
      errors.push("reviewers directory must contain exactly the frozen transcript slots; missing or surplus evidence is forbidden");
    }
  } catch (error) {
    errors.push(`cannot enumerate frozen reviewer slots: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const [index, review] of reviews.entries()) {
    const path = resolve(review.transcript);
    const expectedPath = resolve(join(runDir, "reviewers", `${index + 1}-${review.agent}.md`));
    if (path !== expectedPath) {
      errors.push(`review transcript slot ${index + 1} for ${review.agent} must be exactly ${expectedPath}: ${review.transcript}`);
      continue;
    }
    if (dirname(path) !== expectedParent) { errors.push(`review transcript must be directly inside ${expectedParent}: ${review.transcript}`); continue; }
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) {
        errors.push(`review transcript must be a non-empty regular non-symlink file: ${review.transcript}`);
        continue;
      }
      const real = realpathSync(path);
      const fileIdentity = `${stat.dev}:${stat.ino}`;
      if (real !== path) { errors.push(`review transcript must resolve to itself: ${review.transcript}`); continue; }
      if (seenRealpaths.has(real) || seenFiles.has(fileIdentity)) {
        errors.push(`review transcript file is assigned to more than one reviewer: ${review.transcript}`);
        continue;
      }
      seenRealpaths.add(real);
      seenFiles.add(fileIdentity);
      const bytes = readFileSync(path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (review.expectedByteLength !== null && review.expectedByteLength !== bytes.byteLength) {
        errors.push(`review transcript byte_length is stale for ${review.agent}`);
        continue;
      }
      if (review.expectedSha256 !== null && review.expectedSha256 !== sha256) {
        errors.push(`review transcript sha256 is stale for ${review.agent}`);
        continue;
      }
      let output: string;
      try {
        output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        errors.push(`review transcript must contain exact valid UTF-8 Agent output: ${review.transcript}`);
        continue;
      }
      const artifact = parseArtifactRef({
        runId: basename(runDir),
        slot: `reviewers/${index + 1}-${review.agent}.md`,
        digest: sha256,
        byteLength: bytes.byteLength,
      });
      if (!artifact.ok) {
        errors.push(`cannot bind review transcript artifact: ${artifact.error.message}`);
        continue;
      }
      transcripts.push({ agent: review.agent, output, artifact: artifact.value });
    } catch (error) {
      errors.push(`cannot read review transcript ${review.transcript}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: transcripts };
}

function init(runDir: string, inputPath: string): HookResult {
  const sessionPath = join(runDir, "session.json");
  if (existsSync(sessionPath)) return contractError("standalone review", ["this run has already been initialized"]);
  if (resolve(inputPath) !== resolve(join(runDir, "review-plan.json"))) {
    return contractError("standalone review boundary", [`--input must be ${join(runDir, "review-plan.json")}`]);
  }
  const raw = readJson(inputPath, "review plan", runDir);
  if (!raw.ok) return contractError("standalone review", raw.errors);
  const session = parseReviewPlan(raw.value, basename(runDir));
  if (!session.ok) return contractError("standalone review", session.errors);
  const json = serializeSession(session.value) + "\n";
  const target = prepareWriteTargets(runDir, [], ["session.json"]);
  if (!target.ok) return contractError("standalone review boundary", target.errors);
  try { writeRunFileExclusiveNoFollow(sessionPath, json); }
  catch (error) { return contractError("standalone review", [`cannot write session: ${error instanceof Error ? error.message : String(error)}`]); }
  return writeCanonicalOutput(json);
}

function aggregate(runDir: string, inputPath: string): HookResult {
  const aggregatePath = join(runDir, "aggregate.json");
  const pendingPath = join(runDir, ".aggregate.pending.json");
  if (existsSync(pendingPath)) {
    return contractError("standalone review", [
      "this run has an incomplete prior aggregation — start a new run directory",
    ]);
  }
  if (existsSync(aggregatePath)) {
    const existing = readJson(aggregatePath, "standalone aggregate", runDir);
    if (!existing.ok) {
      return contractError("standalone review", [
        "this run has a corrupt prior aggregate and cannot be resumed",
        ...existing.errors,
      ]);
    }
    const parsed = parseStandaloneAggregate(existing.value);
    return parsed.ok
      ? contractError("standalone review", ["this run has already been aggregated"])
      : contractError("standalone review", [
          "this run has a corrupt prior aggregate and cannot be resumed",
          ...parsed.errors,
        ]);
  }
  if (resolve(inputPath) !== resolve(join(runDir, "review-input.json"))) {
    return contractError("standalone review boundary", [`--input must be ${join(runDir, "review-input.json")}`]);
  }
  const session = loadReviewAuthority(runDir);
  if (!session.ok) return contractError("standalone review", session.errors);
  const inputRaw = readJson(inputPath, "review input", runDir);
  if (!inputRaw.ok) return contractError("standalone review", inputRaw.errors);
  const reviews = parseObservedReviews(inputRaw.value, session.value.expectedAgents);
  if (!reviews.ok) return contractError("standalone review", reviews.errors);
  const loaded = loadTranscripts(runDir, reviews.value);
  if (!loaded.ok) return contractError("standalone review", loaded.errors);
  const result = aggregateLegacyStandaloneReview({ runId: session.value.runId, scope: session.value.scope, transcripts: loaded.value });
  if (!result.ok) return contractError("standalone review", result.errors);
  const json = serializeStandaloneAggregate(result.value.aggregate) + "\n";
  const target = prepareWriteTargets(runDir, [], ["aggregate.json", ".aggregate.pending.json"]);
  if (!target.ok) return contractError("standalone review boundary", target.errors);
  let stagedCreated = false;
  try {
    writeRunFileExclusiveNoFollow(pendingPath, json);
    stagedCreated = true;
    const staged = parseStandaloneAggregate(JSON.parse(readRunFileNoFollow(pendingPath)));
    if (!staged.ok) throw new Error(`staged aggregate failed validation: ${staged.errors.join("; ")}`);
    publishStagedRunFile(pendingPath, aggregatePath);
  } catch (error) {
    let cleanupError: string | null = null;
    try { if (stagedCreated) removeRunFileNoFollow(pendingPath); }
    catch (cleanup) { cleanupError = cleanup instanceof Error ? cleanup.message : String(cleanup); }
    return contractError("standalone review", [
      `cannot atomically publish aggregate: ${error instanceof Error ? error.message : String(error)}`,
      ...(cleanupError === null ? [] : [`also failed to remove pending aggregate: ${cleanupError}`]),
    ]);
  }
  for (const transcript of loaded.value) {
    const resolution = resolveReviewFindings(transcript.output, transcript.agent);
    if (
      resolution.kind === "findings" &&
      resolution.findings.blockStatus.kind !== "absent" &&
      resolution.findings.blockStatus.kind !== "used"
    ) {
      process.stderr.write(reviewResolutionLog(`standalone:${transcript.agent}`, resolution) + "\n");
    }
  }
  process.stderr.write(result.value.kind === "clean"
    ? `Standalone review: 0 critical, ${result.value.aggregate.findings.filter((f) => f.severity === "advisory").length} advisory; skip refutation panel\n`
    : `Standalone review: ${result.value.criticals.length} critical; refutation panel required\n`);
  return writeCanonicalOutput(json);
}

function loadBoundAggregate(runDir: string): Parse<StandaloneReviewAggregate> {
  const raw = readJson(join(runDir, "aggregate.json"), "standalone aggregate", runDir);
  if (!raw.ok) return raw;
  const aggregate = parseStandaloneAggregate(raw.value);
  if (!aggregate.ok) return aggregate;
  return aggregate.value.runId === basename(runDir)
    ? aggregate
    : { ok: false, errors: [`aggregate.run_id must equal run directory '${basename(runDir)}'`] };
}

/**
 * Reload the immutable review authority and prove that aggregate.json is still
 * exactly the value derived from its physical transcript slots. A standalone
 * result is remediation authority, so schema validity alone is insufficient:
 * a hand-authored clean aggregate must never become evidence merely because it
 * carries the right run id.
 */
export function loadEvidenceBoundAggregate(runDir: string): Parse<StandaloneReviewAggregate> {
  const runId = basename(runDir);
  const session = loadReviewAuthority(runDir);
  if (!session.ok) return session;

  const inputRaw = readJson(join(runDir, "review-input.json"), "review input", runDir);
  if (!inputRaw.ok) return inputRaw;
  const reviews = parseObservedReviews(inputRaw.value, session.value.expectedAgents);
  if (!reviews.ok) return reviews;
  const transcripts = loadTranscripts(runDir, reviews.value);
  if (!transcripts.ok) return transcripts;

  const derived = aggregateLegacyStandaloneReview({
    runId,
    scope: session.value.scope,
    transcripts: transcripts.value,
  });
  if (!derived.ok) return { ok: false, errors: derived.errors };

  const stored = loadBoundAggregate(runDir);
  if (!stored.ok) return stored;
  const derivedCanonical = serializeStandaloneAggregate(derived.value.aggregate);
  const storedCanonical = serializeStandaloneAggregate(stored.value);
  if (derivedCanonical !== storedCanonical) {
    return {
      ok: false,
      errors: [
        "aggregate.json does not match the aggregate rederived from session.json, review-input.json, and reviewer transcripts",
      ],
    };
  }
  return { ok: true, value: derived.value.aggregate };
}

function finalize(runDir: string): HookResult {
  const resultPath = join(runDir, "result.json");
  const pendingResultPath = join(runDir, ".result.pending.json");
  if (existsSync(pendingResultPath)) {
    return contractError("standalone review", [
      "this run has an incomplete prior finalization — start a new run directory",
    ]);
  }
  if (existsSync(resultPath)) return contractError("standalone review", ["this run has already been finalized"]);
  const aggregate = loadEvidenceBoundAggregate(runDir);
  if (!aggregate.ok) return contractError("standalone review", aggregate.errors);
  if (aggregate.value.findings.some((finding) => finding.severity === "critical")) {
    return contractError("standalone review", ["critical findings require review-panel tally, which validates verdicts and atomically publishes result.json"]);
  }
  if (existsSync(join(runDir, "outcomes.json"))) return contractError("standalone review", ["clean review unexpectedly has panel outcomes"]);
  const finalized = finalizeStandaloneReview(aggregate.value, null);
  if (!finalized.ok) return contractError("standalone review", finalized.errors);
  const json = serializeHistoricalAdjudicatedStandaloneReview(finalized.value) + "\n";
  const target = prepareWriteTargets(runDir, [], ["result.json", ".result.pending.json"]);
  if (!target.ok) return contractError("standalone review boundary", target.errors);
  let stagedCreated = false;
  try {
    writeRunFileExclusiveNoFollow(pendingResultPath, json);
    stagedCreated = true;
    const staged = readRunFileNoFollow(pendingResultPath);
    JSON.parse(staged);
    if (staged !== json) throw new Error("staged result bytes differ from the engine-authored result");
    publishStagedRunFile(pendingResultPath, resultPath);
  } catch (error) {
    let cleanupError: string | null = null;
    try { if (stagedCreated) removeRunFileNoFollow(pendingResultPath); }
    catch (cleanup) { cleanupError = cleanup instanceof Error ? cleanup.message : String(cleanup); }
    return contractError("standalone review", [
      `cannot atomically publish result: ${error instanceof Error ? error.message : String(error)}`,
      ...(cleanupError === null ? [] : [`also failed to remove pending result: ${cleanupError}`]),
    ]);
  }
  return writeCanonicalOutput(json);
}

const handler: HookHandler = async (_stdin, args) => {
  const operation = args[0];
  const runsRoot = argumentValue(args, "--runs-root");
  const runDir = argumentValue(args, "--run-dir");
  if (!operation || !runsRoot || !runDir || !(STANDALONE_REVIEW_OPERATIONS as readonly string[]).includes(operation)) return usageError;
  const boundary = parseRunDirectory(runsRoot, runDir);
  if (!boundary.ok) return contractError("standalone review boundary", boundary.errors);
  const reviewers = operation === "init"
    ? prepareWriteTargets(runDir, ["reviewers"], [])
    : requireRunDirectoriesNoFollow(runDir, ["reviewers"]);
  if (!reviewers.ok) return contractError("standalone review boundary", reviewers.errors);
  if (operation === "finalize") return finalize(runDir);
  const input = argumentValue(args, "--input");
  if (!input) return usageError;
  return operation === "init" ? init(runDir, input) : aggregate(runDir, input);
};

export default handler;
