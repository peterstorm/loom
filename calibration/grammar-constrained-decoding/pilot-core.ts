/**
 * Grammar-constrained decoding calibration pilot — the PURE functional core
 * (Plan AD-11; AS-004, AS-015, AS-016, AS-017).
 *
 * Everything here is a total function over plain data: preregistration and
 * observation parsing (parse, don't validate — zod is the single source of
 * truth for the persisted shapes), the deterministic paired schedule, the
 * dispatch-to-ingestion counters folded into per-route/schema cell summaries,
 * the guardrail evaluations and the release decision. No clock, no
 * filesystem, no network, no process: the runner
 * (`scripts/run-model-calibration.ts --pilot`) is the imperative shell that
 * gathers facts, dispatches, and persists what this module returns.
 *
 * Honesty invariants encoded in the types:
 *
 * - A release decision of `done-allowed` can only carry cells whose every
 *   guardrail verdict is `pass` (or `not-applicable` for a guardrail the
 *   preregistration declares inapplicable to that cell's qualification). A
 *   `violated`, `inconclusive` or `not-measured` guardrail is unrepresentable
 *   inside it.
 * - Per-route/schema cells are never aggregated away: every preregistered
 *   cell yields exactly one CellOutcome — measured, qualification-only
 *   (explicit extraction-only qualification, no fabricated samples) or
 *   not-measured (with the blocking reason and the partial observation count).
 * - Terminal failures and timeouts are retained as their own series and enter
 *   the latency distribution as unbounded (+∞) samples: successful samples
 *   alone can never make p95 look better than the operation was.
 * - Provider-enforced structural failures (constraints the route was verified
 *   to enforce) and engine-only refusals are separate series; on a route that
 *   enforces nothing, schema violations are reported as unenforced, never as
 *   provider guarantees.
 * - Raw generated argument bytes are not observable through Pi; the duplicate
 *   key measurement is reported as not claimed, never as zero.
 */

import { createHash } from "node:crypto";
import { match } from "ts-pattern";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Kernel
// ---------------------------------------------------------------------------

export type Result<T, E> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export const ok = <T>(value: T): Result<T, never> => Object.freeze({ ok: true as const, value });
export const err = <E>(error: E): Result<never, E> => Object.freeze({ ok: false as const, error });

export type NonEmpty<T> = readonly [T, ...T[]];

/** The one NonEmpty constructor: a length proof, not a claim. */
function nonEmpty<T>(values: readonly T[]): NonEmpty<T> | null {
  const [first, ...rest] = values;
  return first === undefined ? null : Object.freeze([first, ...rest] as const);
}

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

const issuesOf = (error: z.ZodError): readonly string[] =>
  Object.freeze(error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`));

/** SHA-256 over exact bytes — the content address of a preregistration or a
 *  workload fixture file. Pure (no I/O); hashing is a function of its input. */
export function contentDigest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Ubiquitous vocabulary
// ---------------------------------------------------------------------------

/** The required route/schema cells of AD-11 (reviewer v2/v3, judge v1, refutation v1). */
export const CELL_KEYS = [
  "reviewer-payload/v2",
  "reviewer-payload/v3",
  "judge-verdict/v1",
  "refutation-verdict/v1",
] as const;
export type CellKey = (typeof CELL_KEYS)[number];

const PILOT_ARMS = ["emission-enabled", "extraction-only"] as const;
export type PilotArm = (typeof PILOT_ARMS)[number];

const SEVERITIES = ["minor", "major", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
/** The independent defect-severity rubric's ordinal weights — the same
 *  rubric for both arms (AS-016). */
const SEVERITY_WEIGHT: Readonly<Record<Severity, number>> = Object.freeze({ minor: 1, major: 2, critical: 3 });

/** AS-015/NFR-001: the spec-fixed p95 bound. A preregistration may tighten it, never loosen it. */
const SPEC_P95_RATIO_BOUND = 1.25;
/** AD-11: the minimum operational pilot size per required cell. */
const SPEC_MINIMUM_PAIRS_PER_CELL = 100;
/** AD-9: the one existing request-slot budget (semantic attempts 1 and 2). */
export const SPEC_SEMANTIC_ATTEMPT_BUDGET = 2;

// ---------------------------------------------------------------------------
// Preregistration (recorded BEFORE any window; content-addressed)
// ---------------------------------------------------------------------------

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 hex digest");
const text = z.string().min(1);

const qualificationSchema = z.discriminatedUnion("kind", [
  /** Capable route (spec glossary): accepts AND enforces the declared constraints. */
  z.object({
    kind: z.literal("constrained-emission"),
    enforcedConstraints: z.array(text).min(1),
    evidence: text,
  }).strict(),
  /** Accepts the exact tool schema but enforces nothing; engine parsing is authoritative. */
  z.object({ kind: z.literal("unconstrained-emission"), evidence: text }).strict(),
  /** The route cannot carry the exact tool schema: no emission arm exists. */
  z.object({ kind: z.literal("extraction-only"), reason: text, evidence: text }).strict(),
]);
export type RouteQualification = DeepReadonly<z.infer<typeof qualificationSchema>>;
/** A route that carries the exact tool schema, so an emission arm exists and
 *  the cell is dispatched; an extraction-only cell is never measured. */
export type EmissionRouteQualification = Exclude<RouteQualification, { kind: "extraction-only" }>;

const knownDefectSchema = z.object({ defectId: text, severity: z.enum(SEVERITIES) }).strict();

const workloadCaseSchema = z.object({
  caseId: text,
  difficulty: z.enum(["easy", "hard"]),
  /** Held-out known-defect case: quality (escaped-defect severity) is assessed on it. */
  heldOutKnownDefectCase: z.boolean(),
  knownDefects: z.array(knownDefectSchema),
  /** Pointer to the fixed input (corpus snapshot or workload fixture). */
  source: text,
}).strict().superRefine((entry, ctx) => {
  if (entry.heldOutKnownDefectCase && entry.knownDefects.length === 0) {
    ctx.addIssue({ code: "custom", message: "a held-out known-defect case must name its known defects", path: ["knownDefects"] });
  }
  const ids = entry.knownDefects.map((defect) => defect.defectId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "known defect ids must be unique within a case", path: ["knownDefects"] });
  }
});

const cellSchema = z.object({
  cell: z.enum(CELL_KEYS),
  toolName: text,
  /** Registry schema digest (bare SHA-256 hex of the frozen schema bytes). */
  schemaDigest: hex64,
  qualification: qualificationSchema,
  workload: z.object({
    repeatsPerCase: z.number().int().min(1),
    cases: z.array(workloadCaseSchema).min(1),
  }).strict(),
}).strict();

const preregistrationSchema = z.object({
  schemaVersion: z.literal(1),
  id: text,
  recordedAt: z.iso.datetime({ offset: true }),
  route: z.object({
    harness: z.literal("pi"),
    provider: text,
    api: text,
    baseUrl: z.url(),
    model: text,
    thinking: text,
    piVersion: text,
  }).strict(),
  /** Content address of the workload fixture file the cases' `source` pointers resolve in. */
  workloadFixturesDigest: hex64,
  minimumPairsPerCell: z.number().int().min(SPEC_MINIMUM_PAIRS_PER_CELL),
  semanticAttemptBudget: z.literal(SPEC_SEMANTIC_ATTEMPT_BUDGET),
  perAttemptTimeoutMs: z.number().int().positive(),
  scheduleSeed: z.number().int().nonnegative(),
  guardrails: z.object({
    p95RatioBound: z.number().gt(1).max(SPEC_P95_RATIO_BOUND),
    confidenceLevel: z.number().gt(0.5).lt(1),
    bootstrapResamples: z.number().int().min(200),
    bootstrapSeed: z.number().int().nonnegative(),
    /** Escaped-defect severity points per request the emission arm may not exceed. */
    qualityNonInferiorityMargin: z.number().min(0),
    requiredIndependentAssessors: z.number().int().min(2),
  }).strict(),
  cells: z.array(cellSchema),
}).strict().superRefine((prereg, ctx) => {
  for (const key of CELL_KEYS) {
    const count = prereg.cells.filter((cell) => cell.cell === key).length;
    if (count !== 1) ctx.addIssue({ code: "custom", message: `required cell ${key} must be preregistered exactly once (found ${count})`, path: ["cells"] });
  }
  prereg.cells.forEach((cell, index) => {
    const path = ["cells", index];
    const ids = cell.workload.cases.map((entry) => entry.caseId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: `${cell.cell}: case ids must be unique`, path });
    if (cell.qualification.kind === "extraction-only") return;
    const pairs = cell.workload.cases.length * cell.workload.repeatsPerCase;
    if (pairs < prereg.minimumPairsPerCell) {
      ctx.addIssue({ code: "custom", message: `${cell.cell}: ${pairs} paired requests < preregistered minimum ${prereg.minimumPairsPerCell}`, path });
    }
    for (const difficulty of ["easy", "hard"] as const) {
      if (!cell.workload.cases.some((entry) => entry.difficulty === difficulty)) {
        ctx.addIssue({ code: "custom", message: `${cell.cell}: workload needs at least one ${difficulty} case`, path });
      }
    }
    if (!cell.workload.cases.some((entry) => entry.heldOutKnownDefectCase)) {
      ctx.addIssue({ code: "custom", message: `${cell.cell}: workload needs at least one held-out known-defect case`, path });
    }
  });
});

export type Preregistration = DeepReadonly<z.infer<typeof preregistrationSchema>>;
export type CellPreregistration = Preregistration["cells"][number];
export type WorkloadCase = CellPreregistration["workload"]["cases"][number];

export function parsePreregistration(raw: unknown): Result<Preregistration, readonly string[]> {
  const parsed = preregistrationSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data as Preregistration) : err(issuesOf(parsed.error));
}

// ---------------------------------------------------------------------------
// Deterministic paired schedule (matched requests, counterbalanced order)
// ---------------------------------------------------------------------------

/** Seeded PRNG (mulberry32): the schedule and the bootstrap are reproducible
 *  from the preregistered seeds. Its state is local to one returned closure. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(values: readonly T[], seed: number): readonly T[] {
  const random = seededRandom(seed);
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap] as T, copy[index] as T];
  }
  return Object.freeze(copy);
}

export type ScheduledPair = Readonly<{
  pairId: string;
  cell: CellKey;
  caseId: string;
  difficulty: "easy" | "hard";
  repeat: number;
  /** ABBA counterbalancing within a cell, so warm-cache/drift effects do not
   *  systematically favour either arm. */
  armOrder: readonly [PilotArm, PilotArm];
}>;

const EMISSION_FIRST: readonly [PilotArm, PilotArm] = Object.freeze(["emission-enabled", "extraction-only"] as const);
const EXTRACTION_FIRST: readonly [PilotArm, PilotArm] = Object.freeze(["extraction-only", "emission-enabled"] as const);

/** Every paired request the preregistration commits to, in the seeded global
 *  dispatch order. Extraction-only-qualified cells schedule nothing: their
 *  outcome is the explicit qualification, never fabricated samples. */
export function buildPairSchedule(prereg: Preregistration): readonly ScheduledPair[] {
  const pairs = prereg.cells.flatMap((cell) => {
    if (cell.qualification.kind === "extraction-only") return [];
    const ordered = cell.workload.cases.flatMap((entry) =>
      Array.from({ length: cell.workload.repeatsPerCase }, (_unused, repeat) => ({ entry, repeat })));
    return ordered.map(({ entry, repeat }, index): ScheduledPair => Object.freeze({
      pairId: `${cell.cell}#${entry.caseId}#r${repeat + 1}`,
      cell: cell.cell,
      caseId: entry.caseId,
      difficulty: entry.difficulty,
      repeat: repeat + 1,
      armOrder: index % 4 === 0 || index % 4 === 3 ? EMISSION_FIRST : EXTRACTION_FIRST,
    }));
  });
  return shuffled(pairs, prereg.scheduleSeed);
}

// ---------------------------------------------------------------------------
// Dispatch-to-ingestion observations (what the shell records per attempt)
// ---------------------------------------------------------------------------

/**
 * How one errored emission-tool result is classified. Pi's in-child argument
 * validation (the frozen JSON Schema, before execute) reports
 * "Validation failed for tool …"; the engine's execute refusal throws
 * "<code>: <message>" with the admission's own code (AD-3).
 */
const toolErrorSchema = z.discriminatedUnion("class", [
  z.object({ class: z.literal("harness-schema-validation") }).strict(),
  z.object({ class: z.literal("engine-refusal"), code: text }).strict(),
  z.object({ class: z.literal("unclassified"), excerpt: z.string() }).strict(),
]);
export type ToolError = DeepReadonly<z.infer<typeof toolErrorSchema>>;

export function classifyEmissionToolError(resultText: string): ToolError {
  if (resultText.startsWith("Validation failed for tool ")) return Object.freeze({ class: "harness-schema-validation" as const });
  const engine = /^([a-z][a-z0-9-]*): /.exec(resultText);
  if (engine?.[1] !== undefined) return Object.freeze({ class: "engine-refusal" as const, code: engine[1] });
  return Object.freeze({ class: "unclassified" as const, excerpt: resultText.slice(0, 200) });
}

/** Rejections the extraction-only arm can produce: it observes no emission
 *  call, so only the final message and the frozen parser can refuse. */
const extractionRejectionCauses = [
  /** Zero emission calls (or extraction-only arm) and the final message was unusable. */
  z.object({ kind: z.literal("extraction-failure"), detail: z.string() }).strict(),
  /** A payload was selected but the frozen ingestion parser refused it. */
  z.object({ kind: z.literal("payload-refused"), detail: z.string() }).strict(),
] as const;

const rejectionCauseSchema = z.discriminatedUnion("kind", [
  ...extractionRejectionCauses,
  /** One complete call refused by engine admission with no usable fallback. */
  z.object({ kind: z.literal("refused-call-no-fallback"), detail: z.string() }).strict(),
  /** Two or more distinct emission calls (AD-9 ambiguity). */
  z.object({ kind: z.literal("duplicate-call"), calls: z.number().int().min(2) }).strict(),
  /** Incomplete/failed/misbound observation (an errored tool result lands here on Pi). */
  z.object({ kind: z.literal("observation-refused"), detail: z.string() }).strict(),
]);
export type RejectionCause = DeepReadonly<z.infer<typeof rejectionCauseSchema>>;

const payloadDigestField = { payloadDigest: hex64 };
const infrastructureFailureSchema = z.object({ kind: z.literal("infrastructure-failure"), reason: z.string() }).strict();
const timeoutSchema = z.object({ kind: z.literal("timeout"), afterMs: z.number().nonnegative() }).strict();

/**
 * The emission-enabled arm's outcomes. An accepted source is coherent with
 * its fallback flag by construction: `fallbackOverRefusal` (extraction
 * selected over exactly one engine-refused call, AD-9 row 3) exists only on
 * the extraction source; an accepted emission-tool payload never carries it.
 */
const emissionOutcomeSchema = z.discriminatedUnion("kind", [
  z.discriminatedUnion("source", [
    z.object({ kind: z.literal("accepted"), source: z.literal("emission-tool"), fallbackOverRefusal: z.literal(false), ...payloadDigestField }).strict(),
    z.object({ kind: z.literal("accepted"), source: z.literal("extraction"), fallbackOverRefusal: z.boolean(), ...payloadDigestField }).strict(),
  ]),
  z.object({ kind: z.literal("rejected"), cause: rejectionCauseSchema }).strict(),
  /** The readiness barrier refused before any model request. */
  z.object({ kind: z.literal("startup-refused"), reason: z.string() }).strict(),
  infrastructureFailureSchema,
  timeoutSchema,
]);

/**
 * The extraction-only arm's outcomes: the PR #52-only baseline has no
 * readiness barrier and no emission tool, so it accepts only by final-message
 * extraction (never over a refused call) and rejects only for extraction or
 * ingestion causes.
 */
const extractionOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), source: z.literal("extraction"), fallbackOverRefusal: z.literal(false), ...payloadDigestField }).strict(),
  z.object({ kind: z.literal("rejected"), cause: z.discriminatedUnion("kind", [...extractionRejectionCauses]) }).strict(),
  infrastructureFailureSchema,
  timeoutSchema,
]);

const attemptCounters = {
  attempt: z.number().int().min(1).max(SPEC_SEMANTIC_ATTEMPT_BUDGET),
  /** Wall clock of this attempt from child spawn (startup included). */
  elapsedMs: z.number().nonnegative(),
  modelRequests: z.number().int().nonnegative(),
};

const emissionAttemptSchema = z.object({
  ...attemptCounters,
  /** Readiness-barrier time; null when the barrier never completed. */
  readinessMs: z.number().nonnegative().nullable(),
  /** Distinct emission tool-call identities observed. */
  emissionCalls: z.number().int().nonnegative(),
  /** Every errored emission tool result, in order (each is a Pi in-child re-prompt). */
  toolErrors: z.array(toolErrorSchema),
  toolAcknowledged: z.boolean(),
  /** Model turns after the first successful tool acknowledgment. */
  followUpTurnsAfterAck: z.number().int().nonnegative(),
  outcome: emissionOutcomeSchema,
}).strict();

/** The extraction-only arm is offered no emission tool and passes no
 *  readiness barrier: its emission counters are fixed by the arm. */
const extractionAttemptSchema = z.object({
  ...attemptCounters,
  readinessMs: z.null(),
  emissionCalls: z.literal(0),
  toolErrors: z.tuple([]),
  toolAcknowledged: z.literal(false),
  followUpTurnsAfterAck: z.literal(0),
  outcome: extractionOutcomeSchema,
}).strict();

export type EmissionArmAttempt = DeepReadonly<z.infer<typeof emissionAttemptSchema>>;
export type ExtractionArmAttempt = DeepReadonly<z.infer<typeof extractionAttemptSchema>>;
export type AttemptObservation = EmissionArmAttempt | ExtractionArmAttempt;

const sampleFields = {
  pairId: text,
  cell: z.enum(CELL_KEYS),
  caseId: text,
};
const sampleMeasures = {
  /** Initial producer dispatch → accepted ingestion (or terminal failure),
   *  including startup, readiness, tool acknowledgments, follow-up turns,
   *  in-child re-prompts and the semantic retry. */
  dispatchToIngestionMs: z.number().nonnegative(),
  /** Pi exposes parsed arguments only — never the generated bytes. */
  rawArgumentObservation: z.literal("unavailable"),
};

/** One arm's sample, discriminated by arm: every attempt is that arm's attempt. */
const sampleSchema = z.discriminatedUnion("arm", [
  z.object({
    ...sampleFields,
    arm: z.literal("emission-enabled"),
    ...sampleMeasures,
    attempts: z.array(emissionAttemptSchema).min(1).max(SPEC_SEMANTIC_ATTEMPT_BUDGET),
  }).strict(),
  z.object({
    ...sampleFields,
    arm: z.literal("extraction-only"),
    ...sampleMeasures,
    attempts: z.array(extractionAttemptSchema).min(1).max(SPEC_SEMANTIC_ATTEMPT_BUDGET),
  }).strict(),
]).superRefine((sample, ctx) => {
  sample.attempts.forEach((attempt, index) => {
    if (attempt.attempt !== index + 1) ctx.addIssue({ code: "custom", message: "attempts must be numbered 1..n in order", path: ["attempts", index] });
    const isLast = index === sample.attempts.length - 1;
    if (!isLast && attempt.outcome.kind !== "rejected") {
      ctx.addIssue({ code: "custom", message: "only a semantic rejection may be followed by another attempt", path: ["attempts", index] });
    }
    if (isLast && attempt.outcome.kind === "rejected" && attempt.attempt < SPEC_SEMANTIC_ATTEMPT_BUDGET) {
      ctx.addIssue({ code: "custom", message: "a semantic rejection before the budget's last attempt must be followed by the retry", path: ["attempts", index] });
    }
  });
});
export type SampleObservation = DeepReadonly<z.infer<typeof sampleSchema>>;

export function parseSampleObservation(raw: unknown): Result<SampleObservation, readonly string[]> {
  const parsed = sampleSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data as SampleObservation) : err(issuesOf(parsed.error));
}

// ---------------------------------------------------------------------------
// Preflight: frozen runtime identity + route reachability (pure decision)
// ---------------------------------------------------------------------------

const routeProbeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reachable"), servedModels: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("unreachable"), reason: z.string() }).strict(),
]);
export type RouteProbe = DeepReadonly<z.infer<typeof routeProbeSchema>>;

/** Retained digests parse as strictly as the preregistered digests they are compared with. */
const registryCellSchema = z.object({ toolName: z.string(), schemaDigest: hex64 }).strict().nullable();

const preflightFactsSchema = z.object({
  /** Frozen registry cells as the staged runtime computes them (null = no cell). */
  registry: z.object({
    "reviewer-payload/v2": registryCellSchema,
    "reviewer-payload/v3": registryCellSchema,
    "judge-verdict/v1": registryCellSchema,
    "refutation-verdict/v1": registryCellSchema,
  }).strict(),
  workloadFixturesDigest: hex64,
  piVersion: z.string().nullable(),
  /** Content-addressed Runtime Revision of the staged checkout children load. */
  stagedRuntimeRevision: text,
  /** Revision published by the operator's loaded Pi extension, when observable. */
  loadedRuntimeRevision: z.string().nullable(),
  route: routeProbeSchema,
}).strict();
export type PreflightFacts = DeepReadonly<z.infer<typeof preflightFactsSchema>>;

/** Retained facts are re-parsed, so a re-decision re-derives the preflight
 *  verdict instead of trusting a stored one. */
export function parsePreflightFacts(raw: unknown): Result<PreflightFacts, readonly string[]> {
  const parsed = preflightFactsSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data as PreflightFacts) : err(issuesOf(parsed.error));
}

export type PreflightBlock =
  | Readonly<{ kind: "schema-digest-mismatch"; cell: CellKey; preregistered: string; staged: string | null }>
  | Readonly<{ kind: "tool-name-mismatch"; cell: CellKey; preregistered: string; staged: string | null }>
  | Readonly<{ kind: "workload-fixtures-changed"; preregistered: string; observed: string }>
  | Readonly<{ kind: "pi-version-mismatch"; preregistered: string; observed: string | null }>
  | Readonly<{ kind: "route-unreachable"; reason: string }>
  | Readonly<{ kind: "served-model-absent"; model: string; served: readonly string[] }>
  | Readonly<{ kind: "loaded-runtime-mismatch"; staged: string; loaded: string }>;

export type RuntimeIdentityRecord = Readonly<{
  stagedRuntimeRevision: string;
  /** Staging and the loaded runtime stay distinct: `unobserved` is never a match. */
  loadedRuntime:
    | Readonly<{ kind: "unobserved" }>
    | Readonly<{ kind: "matches-staged"; revision: string }>
    | Readonly<{ kind: "differs"; revision: string }>;
  piVersion: string | null;
}>;

export type PreflightDecision =
  | Readonly<{ kind: "ready"; runtime: RuntimeIdentityRecord }>
  | Readonly<{ kind: "blocked"; blocks: NonEmpty<PreflightBlock>; runtime: RuntimeIdentityRecord }>;

/** Staging and the loaded runtime stay distinct: `unobserved` is never a match. */
function loadedRuntimeRecord(loaded: string | null, staged: string): RuntimeIdentityRecord["loadedRuntime"] {
  if (loaded === null) return Object.freeze({ kind: "unobserved" as const });
  if (loaded === staged) return Object.freeze({ kind: "matches-staged" as const, revision: loaded });
  return Object.freeze({ kind: "differs" as const, revision: loaded });
}

export function decidePreflight(prereg: Preregistration, facts: PreflightFacts): PreflightDecision {
  const blocks: PreflightBlock[] = [];
  for (const cell of prereg.cells) {
    const staged = facts.registry[cell.cell];
    if (staged?.schemaDigest !== cell.schemaDigest) {
      blocks.push({ kind: "schema-digest-mismatch", cell: cell.cell, preregistered: cell.schemaDigest, staged: staged?.schemaDigest ?? null });
    }
    if (staged?.toolName !== cell.toolName) {
      blocks.push({ kind: "tool-name-mismatch", cell: cell.cell, preregistered: cell.toolName, staged: staged?.toolName ?? null });
    }
  }
  if (facts.workloadFixturesDigest !== prereg.workloadFixturesDigest) {
    blocks.push({ kind: "workload-fixtures-changed", preregistered: prereg.workloadFixturesDigest, observed: facts.workloadFixturesDigest });
  }
  if (facts.piVersion !== prereg.route.piVersion) {
    blocks.push({ kind: "pi-version-mismatch", preregistered: prereg.route.piVersion, observed: facts.piVersion });
  }
  match(facts.route)
    .with({ kind: "unreachable" }, (route) => { blocks.push({ kind: "route-unreachable", reason: route.reason }); })
    .with({ kind: "reachable" }, (route) => {
      if (!route.servedModels.includes(prereg.route.model)) {
        blocks.push({ kind: "served-model-absent", model: prereg.route.model, served: route.servedModels });
      }
    })
    .exhaustive();
  const loaded = facts.loadedRuntimeRevision;
  if (loaded !== null && loaded !== facts.stagedRuntimeRevision) {
    blocks.push({ kind: "loaded-runtime-mismatch", staged: facts.stagedRuntimeRevision, loaded });
  }
  const runtime: RuntimeIdentityRecord = Object.freeze({
    stagedRuntimeRevision: facts.stagedRuntimeRevision,
    loadedRuntime: loadedRuntimeRecord(loaded, facts.stagedRuntimeRevision),
    piVersion: facts.piVersion,
  });
  const blocked = nonEmpty(blocks.map((block) => Object.freeze(block)));
  return blocked === null
    ? Object.freeze({ kind: "ready" as const, runtime })
    : Object.freeze({ kind: "blocked" as const, blocks: blocked, runtime });
}

// ---------------------------------------------------------------------------
// Statistics (pure, deterministic)
// ---------------------------------------------------------------------------

/** Nearest-rank quantile over values that may include +∞ (terminal failures). */
export function nearestRankQuantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] as number;
}

export type Interval = Readonly<{ lower: number; upper: number; level: number }>;

/** Percentile bootstrap interval of a statistic over paired items. NaN
 *  statistics (undefined resamples) rank as +∞, so they widen the upper bound
 *  conservatively instead of disappearing. */
export function bootstrapInterval<T>(
  items: readonly T[],
  statistic: (sample: readonly T[]) => number,
  resamples: number,
  seed: number,
  level: number,
): Interval {
  if (items.length === 0) return Object.freeze({ lower: Number.NaN, upper: Number.NaN, level });
  const random = seededRandom(seed);
  const estimates = Array.from({ length: resamples }, () => {
    const resample = Array.from({ length: items.length }, () => items[Math.floor(random() * items.length)] as T);
    const value = statistic(resample);
    return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
  }).sort((left, right) => left - right);
  const tail = (1 - level) / 2;
  return Object.freeze({
    lower: nearestRankQuantile(estimates, tail),
    upper: nearestRankQuantile(estimates, 1 - tail),
    level,
  });
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;

const median = (values: readonly number[]): number => nearestRankQuantile(values, 0.5);

/** A latency quantile as JSON-safe data: +∞ is a terminal-failure-dominated quantile. */
export type LatencyQuantile =
  | Readonly<{ kind: "finite"; ms: number }>
  | Readonly<{ kind: "terminal-failure-dominated" }>
  | Readonly<{ kind: "no-samples" }>;

function quantileRecord(value: number): LatencyQuantile {
  if (Number.isNaN(value)) return Object.freeze({ kind: "no-samples" as const });
  if (Number.isFinite(value)) return Object.freeze({ kind: "finite" as const, ms: value });
  return Object.freeze({ kind: "terminal-failure-dominated" as const });
}

/** JSON cannot carry ±∞/NaN; an interval bound that is not finite is recorded as null (unbounded/undefined). */
export type JsonInterval = Readonly<{ lower: number | null; upper: number | null; level: number }>;
const jsonInterval = (interval: Interval): JsonInterval => Object.freeze({
  lower: Number.isFinite(interval.lower) ? interval.lower : null,
  upper: Number.isFinite(interval.upper) ? interval.upper : null,
  level: interval.level,
});
const finiteOrNull = (value: number): number | null => (Number.isFinite(value) ? value : null);

// ---------------------------------------------------------------------------
// Per-sample derivations (the dispatch-to-ingestion counters)
// ---------------------------------------------------------------------------

export type SampleTerminal =
  | Readonly<{ kind: "accepted"; source: "emission-tool" | "extraction"; fallbackOverRefusal: boolean }>
  | Readonly<{ kind: "terminal-failure"; cause: "semantic-exhausted" | "startup-refused" | "infrastructure" | "timeout" }>;

function sampleTerminal(sample: SampleObservation): SampleTerminal {
  const last = sample.attempts[sample.attempts.length - 1] as AttemptObservation;
  return match(last.outcome)
    .with({ kind: "accepted" }, (outcome): SampleTerminal =>
      Object.freeze({ kind: "accepted" as const, source: outcome.source, fallbackOverRefusal: outcome.fallbackOverRefusal }))
    .with({ kind: "rejected" }, (): SampleTerminal => Object.freeze({ kind: "terminal-failure" as const, cause: "semantic-exhausted" as const }))
    .with({ kind: "startup-refused" }, (): SampleTerminal => Object.freeze({ kind: "terminal-failure" as const, cause: "startup-refused" as const }))
    .with({ kind: "infrastructure-failure" }, (): SampleTerminal => Object.freeze({ kind: "terminal-failure" as const, cause: "infrastructure" as const }))
    .with({ kind: "timeout" }, (): SampleTerminal => Object.freeze({ kind: "terminal-failure" as const, cause: "timeout" as const }))
    .exhaustive();
}

/** The retry-cause vocabulary: every retry (semantic attempt 2, or a Pi
 *  in-child re-prompt after an errored tool result) is attributed to one. */
const RETRY_CAUSES = [
  "provider-structural",
  "unenforced-schema-violation",
  "engine-only-refusal",
  "unclassified-tool-error",
  "extraction-failure",
  "duplicate-call",
  "observation-refused",
  "payload-refused",
] as const;
export type RetryCause = (typeof RETRY_CAUSES)[number];

const structuralCause = (qualification: RouteQualification): RetryCause =>
  qualification.kind === "constrained-emission" ? "provider-structural" : "unenforced-schema-violation";

const toolErrorCause = (error: ToolError, qualification: RouteQualification): RetryCause =>
  match(error)
    .with({ class: "harness-schema-validation" }, () => structuralCause(qualification))
    .with({ class: "engine-refusal" }, (): RetryCause => "engine-only-refusal")
    .with({ class: "unclassified" }, (): RetryCause => "unclassified-tool-error")
    .exhaustive();

/** The cause a semantic rejection is attributed to. An observation refusal
 *  caused by an errored tool result is attributed to that error's class: on
 *  Pi every errored result becomes an incomplete frame. */
function rejectionRetryCause(attempt: AttemptObservation, cause: RejectionCause, qualification: RouteQualification): RetryCause {
  const firstError = attempt.toolErrors[0];
  return match(cause)
    .with({ kind: "extraction-failure" }, (): RetryCause => "extraction-failure")
    .with({ kind: "duplicate-call" }, (): RetryCause => "duplicate-call")
    .with({ kind: "payload-refused" }, (): RetryCause => "payload-refused")
    .with({ kind: "refused-call-no-fallback" }, (): RetryCause =>
      firstError === undefined ? "engine-only-refusal" : toolErrorCause(firstError, qualification))
    .with({ kind: "observation-refused" }, (): RetryCause =>
      firstError === undefined ? "observation-refused" : toolErrorCause(firstError, qualification))
    .exhaustive();
}

export type RetryEvent = Readonly<{ kind: "semantic-retry" | "in-child-reprompt"; cause: RetryCause }>;

export function sampleRetries(sample: SampleObservation, qualification: RouteQualification): readonly RetryEvent[] {
  const reprompts = sample.attempts.flatMap((attempt) =>
    attempt.toolErrors.map((error): RetryEvent => Object.freeze({ kind: "in-child-reprompt" as const, cause: toolErrorCause(error, qualification) })));
  const semantic = sample.attempts.slice(0, -1).flatMap((attempt): RetryEvent[] =>
    attempt.outcome.kind === "rejected"
      ? [Object.freeze({ kind: "semantic-retry" as const, cause: rejectionRetryCause(attempt, attempt.outcome.cause, qualification) })]
      : []);
  return Object.freeze([...semantic, ...reprompts]);
}

// ---------------------------------------------------------------------------
// Escaped-defect severity (AS-016): blinded, same rubric, disagreements kept
// ---------------------------------------------------------------------------

const blindingKeySchema = z.object({
  schemaVersion: z.literal(1),
  windowId: text,
  entries: z.array(z.object({ blindId: text, pairId: text, arm: z.enum(PILOT_ARMS) }).strict()),
}).strict().superRefine((key, ctx) => {
  const ids = key.entries.map((entry) => entry.blindId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "blind ids must be unique", path: ["entries"] });
});
export type BlindingKey = DeepReadonly<z.infer<typeof blindingKeySchema>>;

export function parseBlindingKey(raw: unknown): Result<BlindingKey, readonly string[]> {
  const parsed = blindingKeySchema.safeParse(raw);
  return parsed.success ? ok(parsed.data as BlindingKey) : err(issuesOf(parsed.error));
}

/** An assessor id names its retained file (`assessments/<assessorId>.json`),
 *  so it is parsed as a path-safe token: no separator, no traversal. */
const assessorIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "must be a path-safe assessor id ([A-Za-z0-9._-], starting alphanumeric)");

const assessmentSchema = z.object({
  schemaVersion: z.literal(1),
  assessorId: assessorIdSchema,
  method: text,
  /** The assessor saw blind ids only — never the arm. */
  blinded: z.literal(true),
  entries: z.array(z.object({
    blindId: text,
    escapedDefects: z.array(z.object({ defectId: text, severity: z.enum(SEVERITIES) }).strict()),
  }).strict()),
}).strict().superRefine((assessment, ctx) => {
  const ids = assessment.entries.map((entry) => entry.blindId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "an assessor scores each blind id at most once", path: ["entries"] });
});
export type QualityAssessment = DeepReadonly<z.infer<typeof assessmentSchema>>;

export function parseQualityAssessment(raw: unknown): Result<QualityAssessment, readonly string[]> {
  const parsed = assessmentSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data as QualityAssessment) : err(issuesOf(parsed.error));
}

export type EscapedDefect = Readonly<{ defectId: string; severity: Severity }>;

export type ObservedEscape = Readonly<{
  pairId: string;
  arm: PilotArm;
  defectId: string;
  /** Who observed it: an assessor id, or `terminal-failure` when no payload was accepted. */
  observedBy: readonly string[];
  severity: Severity;
}>;

export type AssessorDisagreement = Readonly<{
  pairId: string;
  arm: PilotArm;
  byAssessor: Readonly<Record<string, readonly EscapedDefect[]>>;
}>;

export type QualityComparison = Readonly<{
  heldOutPairs: number;
  assessors: readonly string[];
  meanEscapedSeverity: Readonly<Record<PilotArm, number | null>>;
  /** Paired effect: emission − extraction escaped-severity points per request. */
  pairedDifference: Readonly<{ mean: number | null; interval: JsonInterval }>;
  observedEscapes: readonly ObservedEscape[];
  disagreements: readonly AssessorDisagreement[];
}>;

const severityScore = (defects: readonly EscapedDefect[]): number =>
  defects.reduce((sum, defect) => sum + SEVERITY_WEIGHT[defect.severity], 0);

const sameEscapes = (left: readonly EscapedDefect[], right: readonly EscapedDefect[]): boolean => {
  const canon = (defects: readonly EscapedDefect[]): string =>
    JSON.stringify([...defects].map((defect) => `${defect.defectId}:${defect.severity}`).sort());
  return canon(left) === canon(right);
};

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

const GUARDRAIL_IDS = [
  "measurement-complete",
  "latency-p95",
  "terminal-failure-non-increase",
  "provider-structural-retries",
  "escaped-defect-severity",
] as const;
export type GuardrailId = (typeof GUARDRAIL_IDS)[number];

/** Which acceptance scenario each guardrail evidences. */
const GUARDRAIL_REQUIREMENT: Readonly<Record<GuardrailId, string>> = Object.freeze({
  "measurement-complete": "AS-017",
  "latency-p95": "AS-015",
  "terminal-failure-non-increase": "AS-015",
  "provider-structural-retries": "AS-004",
  "escaped-defect-severity": "AS-016",
});

export type PassingVerdict = "pass" | "not-applicable";
export type GuardrailVerdict = PassingVerdict | "violated" | "inconclusive" | "not-measured";

export type GuardrailOutcome<V extends GuardrailVerdict = GuardrailVerdict, G extends GuardrailId = GuardrailId> = Readonly<{
  guardrail: G;
  verdict: V;
  detail: string;
}>;

/** One outcome per guardrail, each typed by the id it is keyed under, so a
 *  record whose key and outcome id disagree cannot be written. */
export type GuardrailRecord<V extends GuardrailVerdict = GuardrailVerdict> = Readonly<{
  [G in GuardrailId]: GuardrailOutcome<V, G>;
}>;

const outcome = <G extends GuardrailId, V extends GuardrailVerdict>(guardrail: G, verdict: V, detail: string): GuardrailOutcome<V, G> =>
  Object.freeze({ guardrail, verdict, detail });

export type ArmSummary = Readonly<{
  samples: number;
  accepted: number;
  terminalFailures: Readonly<Record<"semantic-exhausted" | "startup-refused" | "infrastructure" | "timeout", number>>;
  /** Over ALL samples, terminal failures ranked +∞. */
  p50: LatencyQuantile;
  p95: LatencyQuantile;
  /** Descriptive only: accepted samples (never the guardrail basis). */
  acceptedOnlyP50: LatencyQuantile;
  acceptedOnlyP95: LatencyQuantile;
  semanticRetries: number;
  inChildReprompts: number;
  retryCauses: Readonly<Record<RetryCause, number>>;
  modelRequestsPerSampleMean: number | null;
  followUpTurnsAfterAckTotal: number;
}>;

export type EmissionArmRates = Readonly<{
  /** Samples with ≥1 emission call in any attempt. */
  toolUseRate: number | null;
  /** Samples with zero emission calls in every attempt. */
  nonEmissionRate: number | null;
  /** Accepted via extraction (fallback) over all emission-arm samples. */
  fallbackRate: number | null;
  /** Of those, extraction selected over exactly one engine-refused call. */
  fallbackOverRefusalRate: number | null;
  duplicateCallRate: number | null;
  acceptedViaEmissionRate: number | null;
}>;

export type StructuralSeries = Readonly<{
  qualification: RouteQualification["kind"];
  /** Retries attributed to constraints the route was VERIFIED to enforce;
   *  not-applicable on a route that enforces nothing. */
  providerEnforcedStructuralRetries: number | "not-applicable";
  unenforcedSchemaViolationRetries: number;
  engineOnlyRefusalRetries: number;
  unclassifiedToolErrorRetries: number;
  extractionFailures: number;
  nonEmissionSamples: number;
  duplicateCallRejections: number;
  observationRefusals: number;
  rawArgumentObservation: Readonly<{
    emissionCallsWithUnavailableRawBytes: number;
    duplicateKeyMeasurement: "not-claimed";
  }>;
}>;

export type CellMeasurement = Readonly<{
  scheduledPairs: number;
  observedPairs: number;
  arms: Readonly<Record<PilotArm, ArmSummary>>;
  latency: Readonly<{
    p95Ratio: number | null;
    p95RatioInterval: JsonInterval;
    bound: number;
    /** Effect size: median paired difference (emission − extraction) over
     *  pairs where both arms reached accepted ingestion. */
    medianPairedDifferenceMs: number | null;
    medianPairedDifferenceInterval: JsonInterval;
    bothAcceptedPairs: number;
  }>;
  terminal: Readonly<{
    rate: Readonly<Record<PilotArm, number>>;
    difference: number;
    interval: JsonInterval;
  }>;
  emissionRates: EmissionArmRates;
  structural: StructuralSeries;
  byDifficulty: Readonly<Record<"easy" | "hard", Readonly<Record<PilotArm, Readonly<{ samples: number; accepted: number; p95: LatencyQuantile }>>>>>;
  quality: QualityComparison | null;
}>;

declare const derivedFromMeasurement: unique symbol;

/**
 * A measured cell: its guardrail verdicts together with the measurement they
 * were derived from. Only `measureCell` constructs one — it computes both
 * from the same observed pairs — so a record pairing verdicts with a
 * measurement they were not derived from cannot be written outside it.
 */
export type MeasuredCell = Readonly<{
  kind: "measured";
  cell: CellKey;
  qualification: EmissionRouteQualification;
  measurement: CellMeasurement;
  guardrails: GuardrailRecord;
}> & Readonly<{ [derivedFromMeasurement]: true }>;

export type CellOutcome =
  | MeasuredCell
  | Readonly<{
      kind: "qualification-only";
      cell: CellKey;
      qualification: Extract<RouteQualification, { kind: "extraction-only" }>;
      detail: string;
    }>
  | Readonly<{
      kind: "not-measured";
      cell: CellKey;
      qualification: EmissionRouteQualification;
      reason: string;
      scheduledPairs: number;
      observedPairs: number;
      partialObservations: number;
    }>;

// ---------------------------------------------------------------------------
// Release decision (AS-017): illegal "done" states are unrepresentable
// ---------------------------------------------------------------------------

export type PassedCellEvidence = Readonly<{
  cell: CellKey;
  guardrails: GuardrailRecord<PassingVerdict>;
}>;

export type GuardrailViolation = Readonly<{ cell: CellKey; guardrail: GuardrailId; requirement: string; detail: string }>;

export type MissingMeasurement =
  | Readonly<{ kind: "preflight-blocked"; blocks: NonEmpty<PreflightBlock> }>
  | Readonly<{ kind: "no-qualified-capable-route"; detail: string }>
  | Readonly<{ kind: "cell-not-measured"; cell: CellKey; reason: string }>
  | Readonly<{ kind: "guardrail-unresolved"; cell: CellKey; guardrail: GuardrailId; requirement: string; verdict: "inconclusive" | "not-measured"; detail: string }>;

export type ReleaseDecision =
  | Readonly<{
      kind: "done-allowed";
      measuredCells: NonEmpty<PassedCellEvidence>;
      qualificationOnlyCells: readonly CellKey[];
    }>
  | Readonly<{
      kind: "blocked-guardrail-violated";
      violations: NonEmpty<GuardrailViolation>;
      /** Missing measurements are retained alongside, never hidden by the block. */
      alsoMissing: readonly MissingMeasurement[];
      consequence: "design-reconsideration-required";
    }>
  | Readonly<{
      kind: "incomplete-missing-measurement";
      missing: NonEmpty<MissingMeasurement>;
    }>;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type QualityInputs = Readonly<{
  key: BlindingKey | null;
  assessments: readonly QualityAssessment[];
}>;

export type PilotEvidence = Readonly<{
  preregistration: Preregistration;
  preflight: PreflightDecision;
  observations: readonly SampleObservation[];
  quality: QualityInputs;
}>;

export type PilotEvaluation = Readonly<{
  cells: readonly CellOutcome[];
  decision: ReleaseDecision;
}>;

export type EvaluationError = Readonly<{ kind: "inconsistent-evidence"; problems: NonEmpty<string> }>;

const latencyOf = (sample: SampleObservation): number =>
  sampleTerminal(sample).kind === "accepted" ? sample.dispatchToIngestionMs : Number.POSITIVE_INFINITY;

const rate = (count: number, total: number): number | null => (total === 0 ? null : count / total);

type RetryTally = Readonly<{ causes: Readonly<Record<RetryCause, number>>; semanticRetries: number; inChildReprompts: number }>;

/** The one retry fold every summary reads (cause counts + retry kinds). */
function tallyRetries(samples: readonly SampleObservation[], qualification: RouteQualification): RetryTally {
  const retries = samples.flatMap((sample) => sampleRetries(sample, qualification));
  return Object.freeze({
    causes: Object.freeze(Object.fromEntries(RETRY_CAUSES.map((cause) =>
      [cause, retries.filter((retry) => retry.cause === cause).length])) as Record<RetryCause, number>),
    semanticRetries: retries.filter((retry) => retry.kind === "semantic-retry").length,
    inChildReprompts: retries.filter((retry) => retry.kind === "in-child-reprompt").length,
  });
}

function summarizeArm(samples: readonly SampleObservation[], qualification: RouteQualification): ArmSummary {
  const terminals = samples.map(sampleTerminal);
  const failures = { "semantic-exhausted": 0, "startup-refused": 0, infrastructure: 0, timeout: 0 };
  for (const terminal of terminals) if (terminal.kind === "terminal-failure") failures[terminal.cause] += 1;
  const { causes, semanticRetries, inChildReprompts } = tallyRetries(samples, qualification);
  const all = samples.map(latencyOf);
  const accepted = all.filter(Number.isFinite);
  return Object.freeze({
    samples: samples.length,
    accepted: accepted.length,
    terminalFailures: Object.freeze(failures),
    p50: quantileRecord(nearestRankQuantile(all, 0.5)),
    p95: quantileRecord(nearestRankQuantile(all, 0.95)),
    acceptedOnlyP50: quantileRecord(nearestRankQuantile(accepted, 0.5)),
    acceptedOnlyP95: quantileRecord(nearestRankQuantile(accepted, 0.95)),
    semanticRetries,
    inChildReprompts,
    retryCauses: causes,
    modelRequestsPerSampleMean: finiteOrNull(mean(samples.map((sample) =>
      sample.attempts.reduce((sum, attempt) => sum + attempt.modelRequests, 0)))),
    followUpTurnsAfterAckTotal: samples.reduce((sum, sample) =>
      sum + sample.attempts.reduce((inner, attempt) => inner + attempt.followUpTurnsAfterAck, 0), 0),
  });
}

function emissionRates(samples: readonly SampleObservation[]): EmissionArmRates {
  const total = samples.length;
  const terminals = samples.map(sampleTerminal);
  const anyCall = samples.filter((sample) => sample.attempts.some((attempt) => attempt.emissionCalls > 0)).length;
  const fallback = terminals.filter((terminal) => terminal.kind === "accepted" && terminal.source === "extraction");
  const duplicates = samples.filter((sample) => sample.attempts.some((attempt) =>
    attempt.outcome.kind === "rejected" && attempt.outcome.cause.kind === "duplicate-call")).length;
  return Object.freeze({
    toolUseRate: rate(anyCall, total),
    nonEmissionRate: rate(total - anyCall, total),
    fallbackRate: rate(fallback.length, total),
    fallbackOverRefusalRate: rate(fallback.filter((terminal) => terminal.kind === "accepted" && terminal.fallbackOverRefusal).length, total),
    duplicateCallRate: rate(duplicates, total),
    acceptedViaEmissionRate: rate(terminals.filter((terminal) => terminal.kind === "accepted" && terminal.source === "emission-tool").length, total),
  });
}

function structuralSeries(samples: readonly SampleObservation[], qualification: RouteQualification): StructuralSeries {
  const { causes } = tallyRetries(samples, qualification);
  const rejections = (kind: RejectionCause["kind"]): number => samples.reduce((sum, sample) =>
    sum + sample.attempts.filter((attempt) => attempt.outcome.kind === "rejected" && attempt.outcome.cause.kind === kind).length, 0);
  return Object.freeze({
    qualification: qualification.kind,
    providerEnforcedStructuralRetries: qualification.kind === "constrained-emission" ? causes["provider-structural"] : "not-applicable" as const,
    unenforcedSchemaViolationRetries: causes["unenforced-schema-violation"],
    engineOnlyRefusalRetries: causes["engine-only-refusal"],
    unclassifiedToolErrorRetries: causes["unclassified-tool-error"],
    extractionFailures: rejections("extraction-failure"),
    nonEmissionSamples: samples.filter((sample) => sample.attempts.every((attempt) => attempt.emissionCalls === 0)).length,
    duplicateCallRejections: rejections("duplicate-call"),
    observationRefusals: rejections("observation-refused"),
    rawArgumentObservation: Object.freeze({
      emissionCallsWithUnavailableRawBytes: samples.reduce((sum, sample) =>
        sum + sample.attempts.reduce((inner, attempt) => inner + attempt.emissionCalls, 0), 0),
      duplicateKeyMeasurement: "not-claimed" as const,
    }),
  });
}

type Pair = Readonly<{ scheduled: ScheduledPair; emission: SampleObservation; extraction: SampleObservation }>;

function latencyGuardrail(pairs: readonly Pair[], prereg: Preregistration): Readonly<{
  measurement: CellMeasurement["latency"];
  guardrail: GuardrailOutcome<GuardrailVerdict, "latency-p95">;
}> {
  const { p95RatioBound: bound, bootstrapResamples, bootstrapSeed, confidenceLevel } = prereg.guardrails;
  const ratioOf = (sample: readonly Pair[]): number =>
    nearestRankQuantile(sample.map((pair) => latencyOf(pair.emission)), 0.95) /
    nearestRankQuantile(sample.map((pair) => latencyOf(pair.extraction)), 0.95);
  const ratio = ratioOf(pairs);
  const interval = bootstrapInterval(pairs, ratioOf, bootstrapResamples, bootstrapSeed, confidenceLevel);
  const both = pairs.filter((pair) => Number.isFinite(latencyOf(pair.emission)) && Number.isFinite(latencyOf(pair.extraction)));
  const differences = both.map((pair) => latencyOf(pair.emission) - latencyOf(pair.extraction));
  const differenceInterval = bootstrapInterval(differences, median, bootstrapResamples, bootstrapSeed + 1, confidenceLevel);
  const fixed3 = (value: number, nonFinite: string): string => (Number.isFinite(value) ? value.toFixed(3) : nonFinite);
  const describe = `p95 ratio ${fixed3(ratio, String(ratio))} (bootstrap ${(confidenceLevel * 100).toFixed(0)}% interval ` +
    `${fixed3(interval.lower, "∞")}–${fixed3(interval.upper, "∞")}) vs bound ${bound}`;
  return Object.freeze({
    measurement: Object.freeze({
      p95Ratio: finiteOrNull(ratio),
      p95RatioInterval: jsonInterval(interval),
      bound,
      medianPairedDifferenceMs: finiteOrNull(median(differences)),
      medianPairedDifferenceInterval: jsonInterval(differenceInterval),
      bothAcceptedPairs: both.length,
    }),
    guardrail: latencyVerdict(ratio, interval, bound, describe),
  });
}

function latencyVerdict(ratio: number, interval: Interval, bound: number, describe: string): GuardrailOutcome<GuardrailVerdict, "latency-p95"> {
  if (Number.isNaN(ratio)) {
    return outcome("latency-p95", "inconclusive", `both arms' p95 is dominated by terminal failures or undefined; ${describe}`);
  }
  if (ratio > bound) return outcome("latency-p95", "violated", describe);
  if (interval.upper <= bound) return outcome("latency-p95", "pass", describe);
  return outcome("latency-p95", "inconclusive", `${describe}: the interval crosses the bound — inconclusive is not a pass`);
}

function terminalGuardrail(pairs: readonly Pair[], prereg: Preregistration): Readonly<{
  measurement: CellMeasurement["terminal"];
  guardrail: GuardrailOutcome<GuardrailVerdict, "terminal-failure-non-increase">;
}> {
  const failed = (sample: SampleObservation): number => (sampleTerminal(sample).kind === "terminal-failure" ? 1 : 0);
  const emissionFailures = pairs.reduce((sum, pair) => sum + failed(pair.emission), 0);
  const extractionFailures = pairs.reduce((sum, pair) => sum + failed(pair.extraction), 0);
  const total = pairs.length;
  const difference = (emissionFailures - extractionFailures) / total;
  const interval = bootstrapInterval(
    pairs.map((pair) => failed(pair.emission) - failed(pair.extraction)),
    mean,
    prereg.guardrails.bootstrapResamples,
    prereg.guardrails.bootstrapSeed + 2,
    prereg.guardrails.confidenceLevel,
  );
  const describe = `terminal failures emission ${emissionFailures}/${total} vs extraction-only ${extractionFailures}/${total}`;
  return Object.freeze({
    measurement: Object.freeze({
      rate: Object.freeze({ "emission-enabled": emissionFailures / total, "extraction-only": extractionFailures / total }),
      difference,
      interval: jsonInterval(interval),
    }),
    guardrail: emissionFailures > extractionFailures
      ? outcome("terminal-failure-non-increase", "violated", `${describe}: the rate increased`)
      : outcome("terminal-failure-non-increase", "pass", describe),
  });
}

function structuralGuardrail(series: StructuralSeries): GuardrailOutcome<GuardrailVerdict, "provider-structural-retries"> {
  if (series.providerEnforcedStructuralRetries === "not-applicable") {
    return outcome("provider-structural-retries", "not-applicable",
      `route qualified ${series.qualification}: it was verified to enforce no JSON Schema constraint; ` +
      `${series.unenforcedSchemaViolationRetries} unenforced schema-violation retries and ${series.engineOnlyRefusalRetries} engine-only refusal retries reported separately`);
  }
  if (series.providerEnforcedStructuralRetries === 0) {
    return outcome("provider-structural-retries", "pass", "zero retries attributed to provider-enforced constraint violations");
  }
  return outcome("provider-structural-retries", "violated",
    `${series.providerEnforcedStructuralRetries} retries attributed to violations of constraints the route was verified to enforce`);
}

function compareQuality(
  cell: CellPreregistration,
  pairs: readonly Pair[],
  prereg: Preregistration,
  quality: QualityInputs,
): Result<Readonly<{ comparison: QualityComparison | null; guardrail: GuardrailOutcome<GuardrailVerdict, "escaped-defect-severity"> }>, readonly string[]> {
  const casesById = new Map(cell.workload.cases.map((entry) => [entry.caseId, entry] as const));
  const heldOut = pairs.filter((pair) => casesById.get(pair.scheduled.caseId)?.heldOutKnownDefectCase === true);
  if (heldOut.length === 0) {
    return ok({ comparison: null, guardrail: outcome("escaped-defect-severity", "not-measured", "no held-out known-defect pair was observed") });
  }
  const assessors = [...new Set(quality.assessments.map((assessment) => assessment.assessorId))].sort();
  if (quality.assessments.length !== assessors.length) return err(["each assessor may submit exactly one assessment"]);
  const required = prereg.guardrails.requiredIndependentAssessors;
  const blindByPairArm = new Map((quality.key?.entries ?? []).map((entry) => [`${entry.pairId}|${entry.arm}`, entry.blindId] as const));
  const problems: string[] = [];
  const missing: string[] = [];
  const escapesFor = (pair: Pair, arm: PilotArm): Readonly<{ score: number; escapes: readonly ObservedEscape[]; disagreement: AssessorDisagreement | null }> => {
    const entry = casesById.get(pair.scheduled.caseId) as WorkloadCase;
    const sample = arm === "emission-enabled" ? pair.emission : pair.extraction;
    if (sampleTerminal(sample).kind === "terminal-failure") {
      // No accepted payload: every known defect escaped, at its preregistered severity.
      return {
        score: severityScore(entry.knownDefects),
        escapes: entry.knownDefects.map((defect) => Object.freeze({
          pairId: pair.scheduled.pairId, arm, defectId: defect.defectId, observedBy: Object.freeze(["terminal-failure"]), severity: defect.severity,
        })),
        disagreement: null,
      };
    }
    const blindId = blindByPairArm.get(`${pair.scheduled.pairId}|${arm}`);
    if (blindId === undefined) {
      missing.push(`${pair.scheduled.pairId}/${arm}: no blinding-key entry`);
      return { score: Number.NaN, escapes: [], disagreement: null };
    }
    const known = new Set(entry.knownDefects.map((defect) => defect.defectId));
    const byAssessor: Record<string, readonly EscapedDefect[]> = {};
    for (const assessment of quality.assessments) {
      const scored = assessment.entries.find((candidate) => candidate.blindId === blindId);
      if (scored === undefined) {
        missing.push(`${pair.scheduled.pairId}/${arm}: assessor ${assessment.assessorId} did not score blind id ${blindId}`);
        continue;
      }
      for (const defect of scored.escapedDefects) {
        if (!known.has(defect.defectId)) problems.push(`assessor ${assessment.assessorId} names unknown defect ${defect.defectId} for ${blindId}`);
      }
      byAssessor[assessment.assessorId] = scored.escapedDefects;
    }
    const scoredSets = Object.values(byAssessor);
    const disagree = scoredSets.some((defects) => !sameEscapes(defects, scoredSets[0] ?? []));
    // Conservative adjudication, identical for both arms: the maximum severity any assessor observed.
    const escapes = new Map<string, ObservedEscape>();
    for (const [assessorId, defects] of Object.entries(byAssessor)) {
      for (const defect of defects) {
        const seen = escapes.get(defect.defectId);
        const severity = seen !== undefined && SEVERITY_WEIGHT[seen.severity] >= SEVERITY_WEIGHT[defect.severity] ? seen.severity : defect.severity;
        escapes.set(defect.defectId, Object.freeze({
          pairId: pair.scheduled.pairId, arm, defectId: defect.defectId,
          observedBy: Object.freeze([...(seen?.observedBy ?? []), assessorId]), severity,
        }));
      }
    }
    const adjudicated = [...escapes.values()];
    return {
      score: severityScore(adjudicated),
      escapes: adjudicated,
      disagreement: disagree ? Object.freeze({ pairId: pair.scheduled.pairId, arm, byAssessor: Object.freeze(byAssessor) }) : null,
    };
  };
  const scored = heldOut.map((pair) => ({ pair, emission: escapesFor(pair, "emission-enabled"), extraction: escapesFor(pair, "extraction-only") }));
  if (problems.length > 0) return err(problems);
  const observedEscapes = scored.flatMap((item) => [...item.emission.escapes, ...item.extraction.escapes]);
  const disagreements = scored.flatMap((item) => [item.emission.disagreement, item.extraction.disagreement])
    .filter((value): value is AssessorDisagreement => value !== null);
  const notEnoughAssessors = assessors.length < required;
  if (notEnoughAssessors || missing.length > 0) {
    return ok({
      comparison: Object.freeze({
        heldOutPairs: heldOut.length,
        assessors,
        meanEscapedSeverity: Object.freeze({ "emission-enabled": null, "extraction-only": null }),
        pairedDifference: Object.freeze({ mean: null, interval: Object.freeze({ lower: null, upper: null, level: prereg.guardrails.confidenceLevel }) }),
        observedEscapes,
        disagreements,
      }),
      guardrail: outcome("escaped-defect-severity", "not-measured", [
        ...(notEnoughAssessors ? [`${assessors.length} blinded independent assessor(s) < preregistered ${required}`] : []),
        ...(missing.length > 0 ? [`${missing.length} held-out request(s) unscored (first: ${missing[0]})`] : []),
      ].join("; ")),
    });
  }
  const differences = scored.map((item) => item.emission.score - item.extraction.score);
  const meanDifference = mean(differences);
  const interval = bootstrapInterval(differences, mean, prereg.guardrails.bootstrapResamples, prereg.guardrails.bootstrapSeed + 3, prereg.guardrails.confidenceLevel);
  const margin = prereg.guardrails.qualityNonInferiorityMargin;
  const describe = `mean paired escaped-severity difference ${meanDifference.toFixed(3)} (interval ${interval.lower.toFixed(3)}–${interval.upper.toFixed(3)}), margin ${margin}`;
  return ok({
    comparison: Object.freeze({
      heldOutPairs: heldOut.length,
      assessors,
      meanEscapedSeverity: Object.freeze({
        "emission-enabled": mean(scored.map((item) => item.emission.score)),
        "extraction-only": mean(scored.map((item) => item.extraction.score)),
      }),
      pairedDifference: Object.freeze({ mean: meanDifference, interval: jsonInterval(interval) }),
      observedEscapes,
      disagreements,
    }),
    guardrail: qualityVerdict(meanDifference, interval, margin, describe),
  });
}

function qualityVerdict(meanDifference: number, interval: Interval, margin: number, describe: string): GuardrailOutcome<GuardrailVerdict, "escaped-defect-severity"> {
  if (interval.lower > 0 || meanDifference > margin) {
    return outcome("escaped-defect-severity", "violated", `${describe}: worse than the PR #52-only extraction baseline`);
  }
  if (meanDifference <= 0 && interval.upper <= margin) return outcome("escaped-defect-severity", "pass", describe);
  return outcome("escaped-defect-severity", "inconclusive", `${describe}: non-inferiority not established — inconclusive is not a pass`);
}

function byDifficulty(pairs: readonly Pair[]): CellMeasurement["byDifficulty"] {
  const arm = (selected: readonly SampleObservation[]) => Object.freeze({
    samples: selected.length,
    accepted: selected.filter((sample) => sampleTerminal(sample).kind === "accepted").length,
    p95: quantileRecord(nearestRankQuantile(selected.map(latencyOf), 0.95)),
  });
  const of = (difficulty: "easy" | "hard") => {
    const chosen = pairs.filter((pair) => pair.scheduled.difficulty === difficulty);
    return Object.freeze({
      "emission-enabled": arm(chosen.map((pair) => pair.emission)),
      "extraction-only": arm(chosen.map((pair) => pair.extraction)),
    });
  };
  return Object.freeze({ easy: of("easy"), hard: of("hard") });
}

function evaluateCell(
  cell: CellPreregistration,
  schedule: readonly ScheduledPair[],
  observations: readonly SampleObservation[],
  evidence: PilotEvidence,
): Result<CellOutcome, readonly string[]> {
  const { qualification } = cell;
  if (qualification.kind === "extraction-only") {
    return ok(Object.freeze({
      kind: "qualification-only" as const,
      cell: cell.cell,
      qualification,
      detail: `explicit extraction-only qualification (${qualification.reason}); no emission arm exists, so no constrained samples are recorded`,
    }));
  }
  const scheduled = schedule.filter((pair) => pair.cell === cell.cell);
  const mine = observations.filter((sample) => sample.cell === cell.cell);
  const find = (pairId: string, arm: PilotArm) => mine.find((sample) => sample.pairId === pairId && sample.arm === arm);
  const pairs: Pair[] = scheduled.flatMap((pair) => {
    const emission = find(pair.pairId, "emission-enabled");
    const extraction = find(pair.pairId, "extraction-only");
    return emission !== undefined && extraction !== undefined ? [{ scheduled: pair, emission, extraction }] : [];
  });
  const notMeasured = (reason: string): Result<CellOutcome, never> => ok(Object.freeze({
    kind: "not-measured" as const,
    cell: cell.cell,
    qualification,
    reason,
    scheduledPairs: scheduled.length,
    observedPairs: pairs.length,
    partialObservations: mine.length,
  }));
  if (evidence.preflight.kind === "blocked") {
    return notMeasured(`preflight blocked: ${evidence.preflight.blocks.map((block) => block.kind).join(", ")}`);
  }
  if (pairs.length < scheduled.length) {
    return notMeasured(`${pairs.length}/${scheduled.length} preregistered pairs observed in both arms`);
  }
  return measureCell(cell, qualification, scheduled.length, pairs, evidence);
}

/** The one constructor of a `MeasuredCell`: every measurement value and the
 *  guardrail verdict read from it come from the same complete set of pairs. */
function measureCell(
  cell: CellPreregistration,
  qualification: EmissionRouteQualification,
  scheduledPairs: number,
  pairs: readonly Pair[],
  evidence: PilotEvidence,
): Result<MeasuredCell, readonly string[]> {
  const latency = latencyGuardrail(pairs, evidence.preregistration);
  const terminal = terminalGuardrail(pairs, evidence.preregistration);
  const emissionSamples = pairs.map((pair) => pair.emission);
  const structural = structuralSeries(emissionSamples, qualification);
  const quality = compareQuality(cell, pairs, evidence.preregistration, evidence.quality);
  if (!quality.ok) return quality;
  const measurement: CellMeasurement = Object.freeze({
    scheduledPairs,
    observedPairs: pairs.length,
    arms: Object.freeze({
      "emission-enabled": summarizeArm(emissionSamples, qualification),
      "extraction-only": summarizeArm(pairs.map((pair) => pair.extraction), qualification),
    }),
    latency: latency.measurement,
    terminal: terminal.measurement,
    emissionRates: emissionRates(emissionSamples),
    structural,
    byDifficulty: byDifficulty(pairs),
    quality: quality.value.comparison,
  });
  const guardrails: GuardrailRecord = Object.freeze({
    "measurement-complete": outcome("measurement-complete", "pass", `${pairs.length}/${scheduledPairs} preregistered pairs observed in both arms`),
    "latency-p95": latency.guardrail,
    "terminal-failure-non-increase": terminal.guardrail,
    "provider-structural-retries": structuralGuardrail(structural),
    "escaped-defect-severity": quality.value.guardrail,
  });
  return ok(Object.freeze({ kind: "measured" as const, cell: cell.cell, qualification, measurement, guardrails }) as MeasuredCell);
}

function consistencyProblems(evidence: PilotEvidence, schedule: readonly ScheduledPair[]): readonly string[] {
  const scheduledIds = new Map(schedule.map((pair) => [pair.pairId, pair] as const));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const sample of evidence.observations) {
    const pair = scheduledIds.get(sample.pairId);
    const identity = `${sample.pairId}|${sample.arm}`;
    if (pair === undefined) problems.push(`observation ${identity} is not a preregistered pair`);
    else if (pair.cell !== sample.cell || pair.caseId !== sample.caseId) problems.push(`observation ${identity} contradicts its scheduled cell/case`);
    if (seen.has(identity)) problems.push(`observation ${identity} is recorded twice`);
    seen.add(identity);
  }
  if (evidence.preflight.kind === "blocked" && evidence.observations.length > 0) {
    problems.push("a blocked preflight dispatches nothing, yet samples are recorded");
  }
  return problems;
}

const isPassing = (guardrail: GuardrailOutcome): guardrail is GuardrailOutcome<PassingVerdict> =>
  guardrail.verdict === "pass" || guardrail.verdict === "not-applicable";

const allPassing = (guardrails: GuardrailRecord): guardrails is GuardrailRecord<PassingVerdict> =>
  GUARDRAIL_IDS.every((id) => isPassing(guardrails[id]));

/** What one cell contributes to the release decision, in cell order. */
type CellFindings = Readonly<{
  violations: readonly GuardrailViolation[];
  missing: readonly MissingMeasurement[];
  passed: readonly PassedCellEvidence[];
  qualificationOnly: readonly CellKey[];
}>;

const NO_FINDINGS: CellFindings = Object.freeze({ violations: [], missing: [], passed: [], qualificationOnly: [] });

/** Window-level gaps that precede every per-cell finding. */
function preregistrationGaps(evidence: PilotEvidence): readonly MissingMeasurement[] {
  const blocked: readonly MissingMeasurement[] = evidence.preflight.kind === "blocked"
    ? [Object.freeze({ kind: "preflight-blocked" as const, blocks: evidence.preflight.blocks })]
    : [];
  const { cells } = evidence.preregistration;
  if (!cells.some((cell) => cell.qualification.kind === "constrained-emission")) {
    return [...blocked, Object.freeze({
      kind: "no-qualified-capable-route" as const,
      detail: "no preregistered cell is qualified constrained-emission on the intended deployment route; " +
        "AD-11: without a qualified capable route the constrained feature cannot be declared measured/done",
    })];
  }
  // Capability is per cell: a measured (emission-arm) cell on an unconstrained
  // route passes AS-004 only as not-applicable, so one capable cell must not
  // carry the others to done. Extraction-only cells stay qualification-only.
  const unconstrained = cells.filter((cell) => cell.qualification.kind === "unconstrained-emission").map((cell) => cell.cell);
  if (unconstrained.length === 0) return blocked;
  return [...blocked, Object.freeze({
    kind: "no-qualified-capable-route" as const,
    detail: `cells ${unconstrained.join(", ")} are qualified unconstrained-emission on the intended deployment route; ` +
      "AD-11: every measured cell needs a qualified capable route before the constrained feature can be declared measured/done",
  })];
}

function cellFindings(cell: CellOutcome): CellFindings {
  return match(cell)
    .with({ kind: "qualification-only" }, (only): CellFindings => ({ ...NO_FINDINGS, qualificationOnly: [only.cell] }))
    .with({ kind: "not-measured" }, (unmeasured): CellFindings => ({
      ...NO_FINDINGS,
      missing: [Object.freeze({ kind: "cell-not-measured" as const, cell: unmeasured.cell, reason: unmeasured.reason })],
    }))
    .with({ kind: "measured" }, measuredCellFindings)
    .exhaustive();
}

function measuredCellFindings(measured: MeasuredCell): CellFindings {
  const guardrails = GUARDRAIL_IDS.map((id) => measured.guardrails[id]);
  const violations = guardrails.flatMap((guardrail): readonly GuardrailViolation[] => guardrail.verdict === "violated"
    ? [Object.freeze({ cell: measured.cell, guardrail: guardrail.guardrail, requirement: GUARDRAIL_REQUIREMENT[guardrail.guardrail], detail: guardrail.detail })]
    : []);
  const missing = guardrails.flatMap((guardrail): readonly MissingMeasurement[] => match(guardrail.verdict)
    .with("inconclusive", "not-measured", (verdict) => [Object.freeze({
      kind: "guardrail-unresolved" as const, cell: measured.cell, guardrail: guardrail.guardrail,
      requirement: GUARDRAIL_REQUIREMENT[guardrail.guardrail], verdict, detail: guardrail.detail,
    })])
    .with("pass", "not-applicable", "violated", () => [])
    .exhaustive());
  const passed: readonly PassedCellEvidence[] = allPassing(measured.guardrails)
    ? [Object.freeze({ cell: measured.cell, guardrails: measured.guardrails })]
    : [];
  return { violations, missing, passed, qualificationOnly: [] };
}

/** The release decision. Precedence: any violated guardrail blocks done (and
 *  demands design reconsideration — never more windows until one looks
 *  favourable); otherwise any missing, not-measured or inconclusive
 *  measurement leaves the claim incomplete; only a complete, all-passing
 *  record with every measured cell on a qualified capable route allows done. */
function decideRelease(evidence: PilotEvidence, cells: readonly CellOutcome[]): ReleaseDecision {
  const perCell = cells.map(cellFindings);
  const violations = perCell.flatMap((findings) => findings.violations);
  const missing = [...preregistrationGaps(evidence), ...perCell.flatMap((findings) => findings.missing)];
  const passed = perCell.flatMap((findings) => findings.passed);
  const qualificationOnly = perCell.flatMap((findings) => findings.qualificationOnly);
  const violated = nonEmpty(violations);
  if (violated !== null) {
    return Object.freeze({
      kind: "blocked-guardrail-violated" as const,
      violations: violated,
      alsoMissing: Object.freeze(missing),
      consequence: "design-reconsideration-required" as const,
    });
  }
  const incomplete = nonEmpty(missing);
  if (incomplete !== null) return Object.freeze({ kind: "incomplete-missing-measurement" as const, missing: incomplete });
  const measuredCells = nonEmpty(passed);
  if (measuredCells === null) {
    const none: MissingMeasurement = Object.freeze({
      kind: "no-qualified-capable-route" as const,
      detail: "no cell carried a measured emission arm",
    });
    return Object.freeze({ kind: "incomplete-missing-measurement" as const, missing: Object.freeze([none] as const) });
  }
  return Object.freeze({ kind: "done-allowed" as const, measuredCells, qualificationOnlyCells: Object.freeze(qualificationOnly) });
}

/** Evaluate a whole window: one outcome per preregistered cell (never
 *  aggregated away) plus the release decision. Inconsistent evidence — samples
 *  for unscheduled pairs, duplicated samples, samples behind a blocked
 *  preflight, assessments naming unknown defects — is refused, not repaired. */
export function evaluatePilot(evidence: PilotEvidence): Result<PilotEvaluation, EvaluationError> {
  const schedule = buildPairSchedule(evidence.preregistration);
  const problems = [...consistencyProblems(evidence, schedule)];
  const cells: CellOutcome[] = [];
  for (const cell of evidence.preregistration.cells) {
    const evaluated = evaluateCell(cell, schedule, evidence.observations, evidence);
    if (evaluated.ok) cells.push(evaluated.value);
    else problems.push(...evaluated.error.map((problem) => `${cell.cell}: ${problem}`));
  }
  const refused = nonEmpty(problems);
  if (refused !== null) return err(Object.freeze({ kind: "inconsistent-evidence" as const, problems: refused }));
  return ok(Object.freeze({ cells: Object.freeze(cells), decision: decideRelease(evidence, cells) }));
}
