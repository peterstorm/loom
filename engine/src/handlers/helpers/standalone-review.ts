import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isReviewAgent } from "../../config";
import type { HookHandler, HookResult } from "../../types";
import {
  aggregateStandaloneReview,
  finalizeStandaloneReview,
  parseStandaloneAggregate,
  parseStandaloneReviewScope,
  serializeAdjudicatedStandaloneReview,
  serializeStandaloneAggregate,
  type StandaloneReviewAggregate,
  type StandaloneReviewTranscript,
} from "../../core/standalone-review";
import { argumentValue, contractError, parseRunDirectory, prepareWriteTargets, writeCanonicalOutput } from "./panel-run";

export const STANDALONE_REVIEW_OPERATIONS = ["init", "aggregate", "finalize"] as const;
const USAGE =
  `Usage: helper standalone-review <${STANDALONE_REVIEW_OPERATIONS.join("|")}> ` +
  "--runs-root <dir> --run-dir <dir> [--input <review-plan.json|review-input.json>]";
const usageError: HookResult = { kind: "error", message: USAGE };

type Parse<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };
interface ReviewInputEntry { readonly agent: string; readonly transcript: string }
interface ReviewSession {
  readonly runId: string;
  readonly scope: readonly string[];
  readonly expectedAgents: readonly string[];
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

function parseAgents(raw: unknown, label: string, errors: string[]): readonly string[] {
  const agents = Array.isArray(raw) && raw.every((agent) => typeof agent === "string" && agent.trim() !== "")
    ? raw.map((agent) => (agent as string).trim().replace(/^loom:/, "")) : [];
  if (agents.length === 0) errors.push(`${label} must be a non-empty string array`);
  if (new Set(agents).size !== agents.length) errors.push(`${label} must be distinct`);
  for (const agent of agents) {
    if (!isReviewAgent(agent)) errors.push(`${label} contains a non-Machine-Summary reviewer: ${agent}`);
  }
  return agents;
}

function parseReviewPlan(raw: unknown, runId: string): Parse<ReviewSession> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: ["review plan must be an object"] };
  const record = raw as Record<string, unknown>;
  const errors: string[] = [];
  const parsedScope = parseStandaloneReviewScope(record.scope, "review plan.scope");
  if (!parsedScope.ok) errors.push(...parsedScope.errors);
  const expectedAgents = parseAgents(record.expected_agents, "review plan.expected_agents", errors);
  return errors.length > 0 || !parsedScope.ok
    ? { ok: false, errors }
    : { ok: true, value: { runId, scope: parsedScope.value, expectedAgents } };
}

function serializeSession(session: ReviewSession): string {
  return JSON.stringify({
    schema_version: 1,
    run_id: session.runId,
    scope: session.scope,
    expected_agents: session.expectedAgents,
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

function parseObservedReviews(raw: unknown, expectedAgents: readonly string[]): Parse<readonly ReviewInputEntry[]> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: ["review input must be an object"] };
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.reviews) || record.reviews.length === 0) {
    return { ok: false, errors: ["review input.reviews must be a non-empty array"] };
  }
  const errors: string[] = [];
  const reviews: ReviewInputEntry[] = [];
  for (const [index, entry] of record.reviews.entries()) {
    const path = `review input.reviews[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) { errors.push(`${path} must be an object`); continue; }
    const item = entry as Record<string, unknown>;
    const agent = typeof item.agent === "string" ? item.agent.trim().replace(/^loom:/, "") : "";
    const transcript = typeof item.transcript === "string" ? item.transcript.trim() : "";
    if (agent === "") errors.push(`${path}.agent must be non-empty`);
    if (transcript === "") errors.push(`${path}.transcript must be non-empty`);
    reviews.push({ agent, transcript });
  }
  const observed = reviews.map(({ agent }) => agent);
  if (new Set(observed).size !== observed.length) errors.push("review input agents must be distinct");
  if (observed.length !== expectedAgents.length || observed.some((agent, index) => agent !== expectedAgents[index])) {
    errors.push("review input.reviews must match the pre-spawn session expected_agents exactly, in spawn order");
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: reviews };
}

function loadTranscripts(runDir: string, reviews: readonly ReviewInputEntry[]): Parse<readonly StandaloneReviewTranscript[]> {
  const expectedParent = resolve(join(runDir, "reviewers"));
  const errors: string[] = [];
  const transcripts: StandaloneReviewTranscript[] = [];
  const seenRealpaths = new Set<string>();
  const seenFiles = new Set<string>();
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
      transcripts.push({ agent: review.agent, output: readFileSync(path, "utf-8") });
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
  try { writeFileSync(sessionPath, json, { flag: "wx" }); }
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
  const result = aggregateStandaloneReview({ runId: session.value.runId, scope: session.value.scope, transcripts: loaded.value });
  if (!result.ok) return contractError("standalone review", result.errors);
  const json = serializeStandaloneAggregate(result.value.aggregate) + "\n";
  const target = prepareWriteTargets(runDir, [], ["aggregate.json", ".aggregate.pending.json"]);
  if (!target.ok) return contractError("standalone review boundary", target.errors);
  try {
    writeFileSync(pendingPath, json, { flag: "wx" });
    const staged = parseStandaloneAggregate(JSON.parse(readFileSync(pendingPath, "utf-8")));
    if (!staged.ok) throw new Error(`staged aggregate failed validation: ${staged.errors.join("; ")}`);
    renameSync(pendingPath, aggregatePath);
  } catch (error) {
    try { if (existsSync(pendingPath)) unlinkSync(pendingPath); } catch { /* preserve original diagnostic */ }
    return contractError("standalone review", [
      `cannot atomically publish aggregate: ${error instanceof Error ? error.message : String(error)}`,
    ]);
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

  const derived = aggregateStandaloneReview({
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
  if (existsSync(resultPath)) return contractError("standalone review", ["this run has already been finalized"]);
  const aggregate = loadEvidenceBoundAggregate(runDir);
  if (!aggregate.ok) return contractError("standalone review", aggregate.errors);
  if (aggregate.value.findings.some((finding) => finding.severity === "critical")) {
    return contractError("standalone review", ["critical findings require review-panel tally, which validates verdicts and atomically publishes result.json"]);
  }
  if (existsSync(join(runDir, "outcomes.json"))) return contractError("standalone review", ["clean review unexpectedly has panel outcomes"]);
  const finalized = finalizeStandaloneReview(aggregate.value, null);
  if (!finalized.ok) return contractError("standalone review", finalized.errors);
  const json = serializeAdjudicatedStandaloneReview(finalized.value) + "\n";
  const target = prepareWriteTargets(runDir, [], ["result.json"]);
  if (!target.ok) return contractError("standalone review boundary", target.errors);
  try { writeFileSync(resultPath, json, { flag: "wx" }); }
  catch (error) { return contractError("standalone review", [`cannot write result: ${error instanceof Error ? error.message : String(error)}`]); }
  return writeCanonicalOutput(json);
}

const handler: HookHandler = async (_stdin, args) => {
  const operation = args[0];
  const runsRoot = argumentValue(args, "--runs-root");
  const runDir = argumentValue(args, "--run-dir");
  if (!operation || !runsRoot || !runDir || !(STANDALONE_REVIEW_OPERATIONS as readonly string[]).includes(operation)) return usageError;
  const boundary = parseRunDirectory(runsRoot, runDir);
  if (!boundary.ok) return contractError("standalone review boundary", boundary.errors);
  mkdirSync(join(runDir, "reviewers"), { recursive: true });
  if (operation === "finalize") return finalize(runDir);
  const input = argumentValue(args, "--input");
  if (!input) return usageError;
  return operation === "init" ? init(runDir, input) : aggregate(runDir, input);
};

export default handler;
