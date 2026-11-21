/**
 * The coverage-ledger state machine: the one place coverage is assigned,
 * settled, reassigned and archived.
 *
 * A ledger is a sorted array of coverage units. A unit is one cell of the
 * deterministic coverage matrix — `(surface, boundary, subsystem, attack_class
 * [, lifecycle])` — and it is settled exactly once per wave. The rules this
 * module enforces are the ones that make "we covered everything" a checkable
 * claim rather than a sentence:
 *
 * - a unit in flight has an owner, and the owner is fresh after every
 *   reassignment (an owner that keeps its own archived evidence is not fresh);
 * - a settled unit carries owned, non-empty reviewed paths whose union is
 *   exactly its checks' paths, so no path is claimed without a check;
 * - a local check cites an artifact under that check owner's own
 *   `agents/<agent_id>/artifacts/` root and never reuses an archived one;
 * - ids are canonical derivations of the semantic tuple, sorted, unique, and a
 *   collision between different semantics is an error rather than a merge;
 * - unassigned units that a budget cut short are `deferred` with a reason, not
 *   invisible.
 *
 * The status-dependent rules are not checks: `CoverageUnit` is a union on
 * `status`, so a planned unit with an owner, a covered unit without evidence or
 * a candidate without fingerprints cannot be written down. What a type cannot
 * say — path ownership, fresh owners, canonical identity, ledger placement — is
 * ONE refinement per shape, attached to the schema the type is derived from.
 *
 * Provenance: this is a port of the coverage-ledger contract vendored from
 * `cloudflare/security-audit-skill@c1c8a8c` (`validate-coverage-ledger.cjs`).
 * The differential test in `engine/tests/security/security-coverage.test.ts`
 * pins agreement with that validator, so an intentional divergence has to be
 * a failing test rather than a silent drift.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { z } from "zod/v4";
import { compareStrings } from "./ordering";
import { catalogProfileOfAgent } from "./model-profiles";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import { securityFindingsSchema, type SecurityFinding } from "./security-findings";
import {
  SECURITY_AUDIT_LIMITS,
  SECURITY_INCOMPLETE_REASONS,
  PRIOR_STATUSES,
  agentIdSchema,
  canonicalCoverageId,
  coverageRefsSchema,
  coverageSemanticKey,
  derivePriorStatus,
  emptyList,
  expecting,
  fingerprintSchema,
  isOneOf,
  isSafeSourcePath,
  isSecurityAgentId,
  isVisibleText,
  isWireRecord,
  itself,
  listOf,
  nonEmptyListOf,
  parseWire,
  positiveIntegerSchema,
  priorRecordFactsSchema,
  sourcePathSchema,
  stringListSchema,
  visibleTextSchema,
  wirePath,
  wireViolation,
  type SecurityAgentId,
  type SecurityIncompleteReason,
  type WireViolation,
} from "./security-audit-contract";

// --- Vocabulary ---

export const COVERAGE_STATUSES = [
  "planned",
  "not_applicable",
  "out_of_scope",
  "in_progress",
  "covered",
  "candidate",
  "blocked",
  "deferred",
] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/** The three dispositions a hunter may settle an assigned unit with — the end
 *  of a HUNT, each with evidence. Not the end of a unit's lifecycle: a
 *  `blocked` unit still awaits a decision (see `COVERAGE_PHASES`). */
export const TERMINAL_DISPOSITIONS = ["covered", "candidate", "blocked"] as const;
export type TerminalDisposition = (typeof TERMINAL_DISPOSITIONS)[number];

/** Where a unit stands in the run's completeness claim. */
type CoveragePhase =
  /** Planned, not yet assigned. */
  | "awaiting-hunt"
  /** Assigned, the hunt not yet settled. */
  | "hunting"
  /** The hunt ended `blocked`: only a critic's reassignment (then a new hunt,
   *  or a deferral) moves it on. */
  | "awaiting-decision"
  /** Nothing left to do: hunted with evidence, or settled without a hunt
   *  (`not_applicable`, `out_of_scope`). */
  | "settled"
  /** Settled as a gap with a reason: the run reports it, never claims it. */
  | "disclosed-gap";

/** The one statement of the coverage lifecycle: every status's phase. Total
 *  over `CoverageStatus` by type, and `coverageSettled`, `coverageComplete`
 *  and `runStatusOf` are all read from it, so the completeness claim the report
 *  rests on has one definition. */
const COVERAGE_PHASES: Readonly<Record<CoverageStatus, CoveragePhase>> = {
  planned: "awaiting-hunt",
  in_progress: "hunting",
  blocked: "awaiting-decision",
  covered: "settled",
  candidate: "settled",
  not_applicable: "settled",
  out_of_scope: "settled",
  deferred: "disclosed-gap",
};

// --- Owned artifacts ---

/** An artifact path under one owner's own artifacts root, parsed: the run-relative
 *  `agents/<owner>/artifacts/<file…>` and the owner id it names. */
export type OwnedArtifactPath = Readonly<{ path: string; owner: SecurityAgentId }>;

/** The one reading of an owned artifact path: a safe run-relative path whose
 *  first three segments are `agents`, a canonical owner id and `artifacts`, with
 *  at least one segment below. Validation and nonce admission both read it here,
 *  so "whose artifact is this" has one answer. */
export function parseOwnedArtifactPath(value: unknown): OwnedArtifactPath | null {
  if (!isSafeSourcePath(value)) return null;
  const [root, owner, artifacts, ...below] = value.split("/");
  return root === "agents" && isSecurityAgentId(owner) && artifacts === "artifacts" && below.length > 0
    ? { path: value, owner }
    : null;
}

// --- Local checks ---

/** One check's shape for one `method`, in the ledger's own key order. A
 *  `source` check cites no artifact; a `local` check claims something OBSERVED,
 *  so it names its receipt. */
const checkShape = <const Method extends string, Artifact extends z.ZodType>(method: Method, artifact: Artifact) =>
  z.strictObject({
    agent_id: agentIdSchema,
    reviewed_paths: nonEmptyListOf(sourcePathSchema, itself, "a check must review at least one path"),
    invariant: visibleTextSchema,
    method: z.literal(method),
    result: visibleTextSchema,
    artifact,
  });

const sourceCheckShape = checkShape("source", z.null(expecting("a source check must use null")));
const localCheckVariants = z.discriminatedUnion(
  "method",
  [sourceCheckShape, checkShape("local", z.string(expecting("a local check must name its receipt")))],
  { error: (issue) => (isWireRecord(issue.input) ? "expected source or local" : "expected an object") },
);

/** The keys one local check may carry: the ledger's own shape, which the
 *  hunter's unit result uses verbatim. Derived from the schema. */
export const CHECK_KEYS: readonly string[] = sourceCheckShape.keyof().options;

/**
 * THE local-check schema: one check, wherever it arrives — a hunter's unit
 * result (`submit`) or a stored ledger (`parseLedger`) — read against one
 * contract, so a malformed check is refused at the wire with the message the
 * ledger would give. A local check's receipt lies under that check owner's own
 * `agents/<agent_id>/artifacts/` root.
 */
const localCheckSchema = localCheckVariants
  .superRefine((check, ctx) => {
    if (check.method === "local" && parseOwnedArtifactPath(check.artifact)?.owner !== check.agent_id) {
      ctx.addIssue({ code: "custom", path: ["artifact"], message: "a local check cites an artifact under its own agent's artifacts root" });
    }
  })
  .readonly();
export type LocalCheck = z.output<typeof localCheckSchema>;

const localChecksSchema = z.array(localCheckSchema).max(SECURITY_AUDIT_LIMITS.collectionItems).readonly();

// --- The unit, one variant per status ---

const excludedBlockSchema = z.strictObject({ block: visibleTextSchema, reason: visibleTextSchema }).readonly();

const owner = (status: CoverageStatus) =>
  z.custom<SecurityAgentId>(isSecurityAgentId, expecting(`status ${status} requires an owner (a canonical lowercase agent ID)`));
const unassigned = (status: CoverageStatus) => z.null(expecting(`status ${status} must be unassigned`));
const keptEmpty = (status: CoverageStatus) => emptyList(`status ${status} keeps this empty`);
const reviewedPaths = (status: CoverageStatus) => nonEmptyListOf(sourcePathSchema, itself, `status ${status} requires entries`);
const settledChecks = (status: CoverageStatus) =>
  localChecksSchema.refine((checks) => checks.length > 0, `status ${status} requires entries`);
const unresolvedFacts = (status: CoverageStatus) =>
  nonEmptyListOf(visibleTextSchema, itself, `status ${status} requires unresolved facts`);

/** What a hunt leaves behind, per terminal disposition: an owner and owned
 *  evidence always; fingerprints exactly when a candidate was filed; unresolved
 *  facts exactly when the hunt was blocked (a candidate MAY carry some). The
 *  live unit and its archived attempts share these shapes. */
const settledEvidence = {
  covered: {
    status: z.literal("covered"),
    agent_id: owner("covered"),
    reviewed_paths: reviewedPaths("covered"),
    local_checks: settledChecks("covered"),
    result_fingerprints: keptEmpty("covered"),
    unresolved: keptEmpty("covered"),
  },
  candidate: {
    status: z.literal("candidate"),
    agent_id: owner("candidate"),
    reviewed_paths: reviewedPaths("candidate"),
    local_checks: settledChecks("candidate"),
    result_fingerprints: nonEmptyListOf(fingerprintSchema, itself, "candidate requires fingerprints"),
    unresolved: listOf(visibleTextSchema, itself),
  },
  blocked: {
    status: z.literal("blocked"),
    agent_id: owner("blocked"),
    reviewed_paths: reviewedPaths("blocked"),
    local_checks: settledChecks("blocked"),
    result_fingerprints: keptEmpty("blocked"),
    unresolved: unresolvedFacts("blocked"),
  },
} as const;

/** A unit nobody holds: no owner, no evidence; a gap names why it is not hunted. */
const unhunted = <const Status extends "planned" | "not_applicable" | "out_of_scope" | "deferred">(status: Status) => ({
  status: z.literal(status),
  agent_id: unassigned(status),
  reviewed_paths: keptEmpty(status),
  local_checks: keptEmpty(status),
  result_fingerprints: keptEmpty(status),
});

const attemptVariant = <const Shape extends z.ZodRawShape>(evidence: Shape) =>
  z.strictObject({ wave: positiveIntegerSchema, ...evidence, reassignment_reason: visibleTextSchema });

/** One archived attempt: a settled hunt and the critic's reason for redoing it. */
const coverageAttemptSchema = z
  .discriminatedUnion(
    "status",
    [attemptVariant(settledEvidence.covered), attemptVariant(settledEvidence.candidate), attemptVariant(settledEvidence.blocked)],
    { error: (issue) => (isWireRecord(issue.input) ? "archived attempts settle as covered, candidate or blocked" : "expected an object") },
  )
  .superRefine((attempt, ctx) => checkPathOwnership(attempt, ctx))
  .readonly();
export type CoverageAttempt = z.output<typeof coverageAttemptSchema>;

/** What every unit carries whatever its status: its cell, its hunting material,
 *  its history and its wave. */
const unitCellShape = {
  coverage_id: z.string(expecting("expected the canonical coverage ID")),
  canonical_refs: coverageRefsSchema,
  surface: z.string(expecting("expected a string")),
  boundary: z.string(expecting("expected a string")),
  subsystem: z.string(expecting("expected a string")),
  attack_class: z.string(expecting("expected a string")),
  lifecycle: z.string(expecting("expected a string")).optional(),
  starting_paths: nonEmptyListOf(sourcePathSchema, itself),
  ordinary_attack_class_block: visibleTextSchema.nullable(),
  selected_companion_blocks: listOf(visibleTextSchema, itself),
  excluded_blocks: z.array(excludedBlockSchema).max(SECURITY_AUDIT_LIMITS.collectionItems).readonly(),
  prior_status: z.enum(PRIOR_STATUSES, expecting(`expected one of ${PRIOR_STATUSES.join(", ")}`)),
  attempts: z.array(coverageAttemptSchema).max(SECURITY_AUDIT_LIMITS.attemptsPerUnit, "too many archived attempts").readonly(),
  wave: positiveIntegerSchema,
};

const unitVariant = <const Shape extends z.ZodRawShape>(state: Shape) => z.strictObject({ ...unitCellShape, ...state });

/**
 * One coverage unit. A union on `status`: each status names exactly which
 * owner and evidence it holds (`planned` holds nothing, `deferred` holds the
 * reason, `covered` holds owned evidence, …), so no transition has to re-check
 * a status-dependent rule — the state it would guard cannot be built.
 */
const coverageUnitSchema = z
  .discriminatedUnion(
    "status",
    [
      unitVariant({ ...unhunted("planned"), unresolved: keptEmpty("planned") }),
      unitVariant({ ...unhunted("not_applicable"), unresolved: unresolvedFacts("not_applicable") }),
      unitVariant({ ...unhunted("out_of_scope"), unresolved: unresolvedFacts("out_of_scope") }),
      unitVariant({ ...unhunted("deferred"), unresolved: unresolvedFacts("deferred") }),
      unitVariant({
        status: z.literal("in_progress"),
        agent_id: owner("in_progress"),
        reviewed_paths: keptEmpty("in_progress"),
        local_checks: keptEmpty("in_progress"),
        result_fingerprints: keptEmpty("in_progress"),
        unresolved: keptEmpty("in_progress"),
      }),
      unitVariant(settledEvidence.covered),
      unitVariant(settledEvidence.candidate),
      unitVariant(settledEvidence.blocked),
    ],
    { error: (issue) => (isWireRecord(issue.input) ? `expected one of ${COVERAGE_STATUSES.join(", ")}` : "expected an object") },
  )
  .superRefine((unit, ctx) => {
    checkCanonicalIdentity(unit, ctx);
    checkPathOwnership(unit, ctx);
    checkExclusions(unit, ctx);
    checkAttemptHistory(unit, ctx);
  })
  .readonly();

export type CoverageUnit = z.output<typeof coverageUnitSchema>;
/** A unit a hunt settled: the three terminal dispositions. */
type SettledUnit = Extract<CoverageUnit, Readonly<{ status: TerminalDisposition }>>;
type PlannedUnit = Extract<CoverageUnit, Readonly<{ status: "planned" }>>;

const isSettledUnit = (unit: CoverageUnit): unit is SettledUnit => isOneOf(TERMINAL_DISPOSITIONS, unit.status);

const phaseOf = (unit: CoverageUnit): CoveragePhase => COVERAGE_PHASES[unit.status];

/** The ledger's name for the shared wire diagnostic. */
export type CoverageViolation = WireViolation;

type Ctx = z.core.$RefinementCtx;

/** The id is the canonical derivation of the refs, and the semantic fields are
 *  the refs' own: a unit whose id says one cell and whose `surface` says
 *  another names two cells at once. */
function checkCanonicalIdentity(
  unit: Readonly<Pick<CoverageUnit, "coverage_id" | "canonical_refs" | "surface" | "boundary" | "subsystem" | "attack_class" | "lifecycle">>,
  ctx: Ctx,
): void {
  const refs = unit.canonical_refs;
  const expected = canonicalCoverageId(refs);
  if (unit.coverage_id !== expected) {
    ctx.addIssue({ code: "custom", path: ["coverage_id"], message: `expected canonical ID ${JSON.stringify(expected)}` });
  }
  if (unit.surface !== refs.surface || unit.boundary !== refs.boundary || unit.subsystem !== refs.subsystem ||
      unit.attack_class !== refs.attack_class || unit.lifecycle !== refs.lifecycle) {
    ctx.addIssue({ code: "custom", message: "semantic fields must equal canonical_refs" });
  }
}

/** The reviewed paths are exactly the union of the checks' owned paths: a
 *  claimed path without a check is an unreviewed claim. */
function checkPathOwnership(
  holder: Readonly<{ reviewed_paths: readonly string[]; local_checks: readonly LocalCheck[] }>,
  ctx: Ctx,
): void {
  const owned = new Set(holder.local_checks.flatMap((check) => check.reviewed_paths));
  const claimed = new Set(holder.reviewed_paths);
  for (const reviewed of claimed) {
    if (!owned.has(reviewed)) ctx.addIssue({ code: "custom", path: ["reviewed_paths"], message: `${JSON.stringify(reviewed)} has no check owner` });
  }
  for (const reviewed of owned) {
    if (!claimed.has(reviewed)) {
      ctx.addIssue({ code: "custom", path: ["local_checks"], message: `owned path ${JSON.stringify(reviewed)} is absent from reviewed_paths` });
    }
  }
}

/** Exclusions are unique, and never name a selected block. */
function checkExclusions(unit: Readonly<Pick<CoverageUnit, "excluded_blocks" | "selected_companion_blocks">>, ctx: Ctx): void {
  const seen = new Set<string>();
  unit.excluded_blocks.forEach((entry, index) => {
    if (seen.has(entry.block)) ctx.addIssue({ code: "custom", path: ["excluded_blocks", index, "block"], message: "duplicate block" });
    seen.add(entry.block);
    if (unit.selected_companion_blocks.includes(entry.block)) {
      ctx.addIssue({ code: "custom", path: ["excluded_blocks", index, "block"], message: "block is also selected" });
    }
  });
}

/** What a unit's archived attempts have spent so far: their owners and their
 *  local artifacts. Local to one `checkAttemptHistory`. */
type AttemptHistory = Readonly<{ owners: Set<string>; artifacts: Set<string> }>;

/**
 * Every archived attempt is earlier than the one before it is not, runs under a
 * fresh owner, and reuses nothing an earlier attempt spent; the live attempt
 * then starts fresh: its owner and its checks belong to no archived attempt,
 * and it cites no archived artifact.
 */
function checkAttemptHistory(
  unit: Readonly<Pick<CoverageUnit, "attempts" | "wave" | "agent_id" | "local_checks">>,
  ctx: Ctx,
): void {
  const history: AttemptHistory = { owners: new Set(), artifacts: new Set() };
  unit.attempts.forEach((attempt, index) => {
    const at = ["attempts", index] as const;
    const previous = unit.attempts[index - 1];
    if (previous !== undefined && attempt.wave <= previous.wave) {
      ctx.addIssue({ code: "custom", path: [...at, "wave"], message: "archived waves must strictly increase" });
    }
    if (attempt.wave >= unit.wave) {
      ctx.addIssue({ code: "custom", path: [...at, "wave"], message: `archived wave must precede current wave ${unit.wave}` });
    }
    const fresh = !history.owners.has(attempt.agent_id);
    if (!fresh) ctx.addIssue({ code: "custom", path: [...at, "agent_id"], message: "assignment owner must be fresh for each attempt" });
    checkEvidenceIsFresh(attempt.local_checks, { at, priorOwnerMessage: "prior owner evidence belongs in its earlier attempt", spend: true }, history, ctx);
    // The attempt's own owner joins the prior set only AFTER its checks are read:
    // an attempt's evidence is its own, not a prior owner's.
    if (fresh) history.owners.add(attempt.agent_id);
  });
  if (unit.agent_id !== null && history.owners.has(unit.agent_id)) {
    ctx.addIssue({ code: "custom", path: ["agent_id"], message: "the current owner must be fresh after a reassignment" });
  }
  checkEvidenceIsFresh(unit.local_checks, { at: [], priorOwnerMessage: "prior owner evidence must stay archived", spend: false }, history, ctx);
}

/**
 * The one freshness rule for a list of checks against what earlier attempts
 * spent: no check cites a prior owner, and none cites an artifact a prior
 * attempt (or, for an archived attempt, an earlier check of its own) already
 * spent. `spend` is the archived side's extra step — its local artifacts join
 * the spent set as they are read, so a later attempt cannot cite them; the live
 * attempt spends nothing.
 */
function checkEvidenceIsFresh(
  checks: readonly LocalCheck[],
  rule: Readonly<{ at: readonly PropertyKey[]; priorOwnerMessage: string; spend: boolean }>,
  history: AttemptHistory,
  ctx: Ctx,
): void {
  checks.forEach((check, index) => {
    const at = [...rule.at, "local_checks", index];
    if (history.owners.has(check.agent_id)) ctx.addIssue({ code: "custom", path: [...at, "agent_id"], message: rule.priorOwnerMessage });
    if (check.artifact !== null && history.artifacts.has(check.artifact)) {
      ctx.addIssue({ code: "custom", path: [...at, "artifact"], message: "an archived artifact cannot be reused" });
    }
    if (rule.spend && check.method === "local") history.artifacts.add(check.artifact);
  });
}

// --- The ledger ---

/** One ledger's placement: every semantic tuple and every id once, ids sorted. */
function checkPlacement(units: readonly CoverageUnit[], ctx: Ctx): void {
  const byId = new Map<string, number>();
  const bySemantics = new Map<string, Readonly<{ id: string; index: number }>>();
  units.forEach((unit, index) => {
    const semanticKey = coverageSemanticKey(unit.canonical_refs);
    const sameCell = bySemantics.get(semanticKey);
    if (sameCell === undefined) bySemantics.set(semanticKey, { id: unit.coverage_id, index });
    else if (sameCell.id !== unit.coverage_id) {
      ctx.addIssue({ code: "custom", path: [index, "canonical_refs"], message: `semantic tuple already uses ${JSON.stringify(sameCell.id)} at index ${sameCell.index}` });
    }
    const sameId = byId.get(unit.coverage_id);
    if (sameId === undefined) byId.set(unit.coverage_id, index);
    else ctx.addIssue({ code: "custom", path: [index, "coverage_id"], message: `duplicate coverage ID at index ${sameId}` });
    const before = units[index - 1];
    if (before !== undefined && compareStrings(before.coverage_id, unit.coverage_id) > 0) {
      ctx.addIssue({ code: "custom", path: [index, "coverage_id"], message: "units must be sorted lexicographically" });
    }
  });
}

/**
 * A stored ledger: a top-level array of at least one unit (an empty ledger
 * would make `every(...)` claim complete coverage of nothing — the seed path
 * refuses it, so the read path must too), each unit valid in its own right and
 * placed once, in canonical order.
 */
const coverageLedgerSchema = z
  .array(coverageUnitSchema, expecting("expected a top-level array"))
  .min(1, "a run always seeds at least one unit")
  .max(SECURITY_AUDIT_LIMITS.units, `exceeds ${SECURITY_AUDIT_LIMITS.units} coverage units`)
  .superRefine(checkPlacement)
  .readonly();

export type CoverageLedger = z.output<typeof coverageLedgerSchema>;

export type CoverageError = Readonly<{
  kind: "invalid-coverage-operation";
  violations: readonly CoverageViolation[];
}>;

const invalid = (violations: readonly CoverageViolation[]): CoverageError => ({
  kind: "invalid-coverage-operation",
  violations,
});

/**
 * Parse a stored ledger document — the read path's one parser, and the only
 * place a ledger the engine did not just build is admitted. Deterministic and
 * total over any JSON: every violation comes back, in a stable order. The
 * ledger returned is the parser's own deep-frozen copy, never the caller's
 * array, so a caller that mutates the raw document later cannot rewrite a
 * ledger this parser reported as proven.
 */
export function parseLedger(raw: unknown): DomainResult<CoverageLedger, CoverageError> {
  const parsed = parseWire(coverageLedgerSchema, raw);
  return parsed.ok ? parsed : failure(invalid(parsed.error));
}

/** A unit a transition rebuilt, parsed as the unit it claims to be and named
 *  at its place in `ledger`. Only the rules the unit's type does not carry can
 *  refuse it — the wave order its history implies, the paths its checks own. */
function rebuiltUnit(ledger: CoverageLedger, candidate: unknown, coverageId: string): DomainResult<CoverageUnit, readonly CoverageViolation[]> {
  return parseWire(coverageUnitSchema, candidate, `$[${ledger.findIndex((unit) => unit.coverage_id === coverageId)}]`);
}

/** Canonical order: lexicographic by canonical id. Every returned ledger is
 *  sorted, so two runs that produce the same units produce the same bytes. */
export const sortLedger = (ledger: CoverageLedger): CoverageLedger =>
  [...ledger].sort((left, right) => compareStrings(left.coverage_id, right.coverage_id));

const replaceUnit = (ledger: CoverageLedger, next: CoverageUnit): CoverageLedger =>
  ledger.map((unit) => (unit.coverage_id === next.coverage_id ? next : unit));

/** Membership in a list a status may keep empty (`readonly []`): read as the
 *  string list it is. */
const lists = (values: readonly string[], value: string): boolean => values.includes(value);

// --- Seeding ---

/** The coverage seed a run starts from, as `start`'s `units` payload carries it.
 *  Closed on purpose: a misspelled optional field (`lifeCycle`) would be dropped
 *  while the seed still parsed, seeding a different cell. Absent lists are
 *  empty, an absent block is none, an absent prior is no prior record; the
 *  entries themselves are judged by the unit the seed builds. */
const coverageSeedSchema = z.strictObject({
  refs: coverageRefsSchema,
  starting_paths: stringListSchema.default([]),
  ordinary_attack_class_block: visibleTextSchema.nullable().default(null),
  selected_companion_blocks: stringListSchema.default([]),
  excluded_blocks: z.array(excludedBlockSchema).readonly().default([]),
  /** Prior-run facts; the carry status is derived, never caller-supplied. */
  prior: priorRecordFactsSchema.nullable().default(null),
  lifecycle: z.string(expecting("expected a string")).optional(),
  wave: z.number(expecting("expected a number")).optional(),
  status: z.enum(COVERAGE_STATUSES, expecting(`expected one of ${COVERAGE_STATUSES.join(", ")}`)).optional(),
  unresolved: stringListSchema.optional(),
});
export type CoverageSeed = z.output<typeof coverageSeedSchema>;

const coverageSeedsSchema = z
  .array(coverageSeedSchema, expecting("expected a top-level array"))
  .min(1, "a run must seed at least one unit")
  .max(SECURITY_AUDIT_LIMITS.units, `exceeds ${SECURITY_AUDIT_LIMITS.units} coverage units`);

/** The statuses a unit may START in: nothing is in flight or hunted yet. */
const SEEDABLE_STATUSES = ["planned", "not_applicable", "out_of_scope", "deferred"] as const;

/**
 * A seeded unit is `planned` (or explicitly `not_applicable`/`out_of_scope`/
 * `deferred` with the reason it is not hunted) with no owner and no evidence.
 * The identity is derived from the refs, so two seeds with the same semantics
 * cannot both enter a ledger by accident. The unit is parsed by the ledger's own
 * unit schema, so construction and validation are one rule, and every violation
 * is reported at once — named by the seed field it came from.
 */
export function seedCoverageUnit(seed: CoverageSeed): DomainResult<CoverageUnit, CoverageError> {
  return seedUnitAt(seed, "");
}

function seedUnitAt(seed: CoverageSeed, root: string): DomainResult<CoverageUnit, CoverageError> {
  const status = seed.status ?? "planned";
  if (!isOneOf(SEEDABLE_STATUSES, status)) {
    return failure(invalid([wireViolation(wirePath(root, ["status"]), `a seeded unit may only start ${SEEDABLE_STATUSES.join(", ")}`)]));
  }
  const refs = seed.refs;
  // A seed that names a lifecycle its refs do not carry (or carry differently)
  // would seed the lifecycle-less cell — a different cell than it named.
  const lifecycle = seed.lifecycle !== undefined && refs.lifecycle !== seed.lifecycle
    ? [wireViolation(wirePath(root, ["lifecycle"]), "lifecycle and canonical_refs.lifecycle disagree")]
    : [];
  const unit = parseWire(coverageUnitSchema, {
    coverage_id: canonicalCoverageId(refs),
    canonical_refs: refs,
    surface: refs.surface,
    boundary: refs.boundary,
    subsystem: refs.subsystem,
    attack_class: refs.attack_class,
    ...(refs.lifecycle === undefined ? {} : { lifecycle: refs.lifecycle }),
    starting_paths: seed.starting_paths,
    ordinary_attack_class_block: seed.ordinary_attack_class_block,
    selected_companion_blocks: seed.selected_companion_blocks,
    excluded_blocks: seed.excluded_blocks,
    prior_status: derivePriorStatus(seed.prior),
    attempts: [],
    wave: seed.wave ?? 1,
    status,
    agent_id: null,
    reviewed_paths: [],
    local_checks: [],
    result_fingerprints: [],
    unresolved: seed.unresolved ?? [],
  }, root);
  const violations = [...lifecycle, ...(unit.ok ? [] : unit.error)];
  return unit.ok && violations.length === 0 ? unit : failure(invalid(violations));
}

/**
 * Parse the coverage units a run is seeded with.
 *
 * The seeding payload arrives from the parent — a lens pass or an operator —
 * as JSON, so it is parsed here rather than trusted: every field is checked,
 * each violation names its index, and a seed list that names the same
 * semantic tuple twice is refused instead of silently deduped (a duplicate
 * seed means the enumeration produced the same cell twice, which is worth
 * seeing). Each seeded unit is already a parsed unit, so the ledger needs no
 * second pass beyond the duplicate-cell rule and the canonical sort.
 */
export function parseCoverageSeeds(raw: unknown): DomainResult<CoverageLedger, CoverageError> {
  const seeds = parseWire(coverageSeedsSchema, raw, "units");
  if (!seeds.ok) return failure(invalid(seeds.error));
  const units: CoverageUnit[] = [];
  const violations: CoverageViolation[] = [];
  seeds.value.forEach((seed, index) => {
    const seeded = seedUnitAt(seed, `units[${index}]`);
    if (seeded.ok) units.push(seeded.value);
    else violations.push(...seeded.error.violations);
  });
  const seen = new Set<string>();
  for (const unit of units) {
    const key = coverageSemanticKey(unit.canonical_refs);
    if (seen.has(key)) violations.push(wireViolation("units", `duplicate coverage cell ${JSON.stringify(unit.coverage_id)}`));
    seen.add(key);
  }
  return violations.length === 0 ? success(sortLedger(units)) : failure(invalid(violations));
}

// --- Fingerprint ownership ---

/**
 * The unit that filed a fingerprint: the one whose live result lists it, else
 * the one whose ARCHIVED attempt does — a reassignment moves a unit's
 * `result_fingerprints` into `attempts` and clears the live list, and the
 * finding it filed is still that unit's. `null` when no unit ever filed it.
 * The ledger's one answer to "who filed this", so a report cannot lose a
 * finding's boundary because its unit was reassigned and re-hunted.
 */
export function unitOfFingerprint(ledger: CoverageLedger, fingerprint: string): CoverageUnit | null {
  return ledger.find((unit) => lists(unit.result_fingerprints, fingerprint)) ??
    ledger.find((unit) => unit.attempts.some((attempt) => lists(attempt.result_fingerprints, fingerprint))) ??
    null;
}

// --- Owner identity ---

/** Separates a catalog agent from the attempt it is running. No catalog agent
 *  name contains it (pinned by a test over the catalog), so the split is
 *  unambiguous. */
const OWNER_ATTEMPT_SEPARATOR = "--";
const OWNER_ATTEMPT_SUFFIX = /--([2-9]|[1-9][0-9]+)$/;

/**
 * The catalog agent an owner id names. An owner id is EITHER the catalog agent
 * itself (a unit's first attempt) OR `<catalog-agent>--<n>` for a later one.
 *
 * Two rules meet on `agent_id`: an owner must be fresh after every reassignment,
 * and every owner must resolve to a catalog profile so verifier independence
 * can be proved. One string cannot be both a fresh per-attempt identity and a
 * catalog name — a reassigned unit could be neither re-hunted under the catalog
 * name (not fresh) nor published under another one (unplaceable). The owner id
 * is therefore an attempt identity that CARRIES its catalog agent, and this is
 * the one place that reads it back.
 */
export const catalogAgentOfOwner = (ownerId: string): string => ownerId.replace(OWNER_ATTEMPT_SUFFIX, "");

/** The owner id a unit's next attempt runs under: the catalog agent for the
 *  first attempt, then the lowest `--<n>` no archived attempt has used. Minted
 *  HERE, from the unit's own history, so freshness holds by construction rather
 *  than by a caller remembering which names it already spent. */
const freshOwnerId = (unit: CoverageUnit, catalogAgent: string): string => {
  const spent = new Set<string>(unit.attempts.map((attempt) => attempt.agent_id));
  if (!spent.has(catalogAgent)) return catalogAgent;
  let attempt = unit.attempts.length + 1;
  while (spent.has(`${catalogAgent}${OWNER_ATTEMPT_SEPARATOR}${attempt}`)) attempt += 1;
  return `${catalogAgent}${OWNER_ATTEMPT_SEPARATOR}${attempt}`;
};

// --- Assignment ---

/** `agentId` names a CATALOG agent; the owner id the unit records is minted from
 *  it (see `catalogAgentOfOwner`). */
export type Assignment = Readonly<{ coverageId: string; agentId: string; wave?: number }>;

export type AssignmentError =
  | CoverageError
  | Readonly<{ kind: "unknown-coverage-id"; coverageId: string }>
  | Readonly<{ kind: "unit-not-planned"; coverageId: string; status: CoverageStatus }>
  /** The Agent Catalog cannot place the agent, so the run could not later say
   *  which model profile hunted — refused here, not at publish. */
  | Readonly<{ kind: "unknown-hunter"; coverageId: string; agentId: string }>;

/** `ownerId` is a parsed agent id, so the `assign` line can print it bare in a
 *  shell command (`LoomCommands.auditNonce`). */
export type AssignedUnit = Readonly<{ coverageId: string; ownerId: SecurityAgentId; wave: number }>;

export type AssignmentResult = Readonly<{ ledger: CoverageLedger; assigned: readonly AssignedUnit[] }>;

/**
 * Assign planned units to a wave's hunters. A unit that is not `planned` cannot
 * be assigned — reassignment goes through `mergeCritic`, which archives the
 * prior attempt first.
 *
 * The caller names a catalog agent; the unit records a fresh owner id minted
 * from it, which the result reports so the hunter can be told the id it must
 * settle under.
 *
 * `wave` is optional: an assignment that names none keeps the unit's current
 * wave. The default lives HERE, with the transition it describes, so no caller
 * has to look the unit up to supply it. A wave the unit's history forbids (one
 * no later than an archived attempt's) is refused by the unit's own schema.
 */
export function assignUnits(
  ledger: CoverageLedger,
  assignments: readonly Assignment[],
): DomainResult<AssignmentResult, AssignmentError> {
  let next = ledger;
  const assigned: AssignedUnit[] = [];
  for (const assignment of assignments) {
    const unit = next.find((candidate) => candidate.coverage_id === assignment.coverageId);
    if (unit === undefined) return failure({ kind: "unknown-coverage-id" as const, coverageId: assignment.coverageId });
    if (unit.status !== "planned") {
      return failure({ kind: "unit-not-planned" as const, coverageId: unit.coverage_id, status: unit.status });
    }
    if (!isSecurityAgentId(assignment.agentId) || catalogProfileOfAgent(assignment.agentId) === null) {
      return failure({ kind: "unknown-hunter" as const, coverageId: unit.coverage_id, agentId: assignment.agentId });
    }
    const ownerId = freshOwnerId(unit, assignment.agentId);
    // The attempt suffix lengthens the catalog name; past the grammar's 64
    // characters the minted id is no agent id, and no unit may record it.
    if (!isSecurityAgentId(ownerId)) {
      return failure(invalid([wireViolation("agent_id", `the next owner of ${unit.coverage_id}, ${JSON.stringify(ownerId)}, is not a canonical agent ID`)]));
    }
    const wave = assignment.wave ?? unit.wave;
    const inFlight = rebuiltUnit(next, { ...unit, status: "in_progress", agent_id: ownerId, wave }, unit.coverage_id);
    if (!inFlight.ok) return failure(invalid(inFlight.error));
    next = replaceUnit(next, inFlight.value);
    assigned.push({ coverageId: unit.coverage_id, ownerId, wave });
  }
  return success({ ledger: next, assigned });
}

// --- Settlement ---

/** The keys a hunter's unit result may carry. Closed on purpose: an invented
 *  spelling (`unitStatus`, `localChecks`) would otherwise be IGNORED while the
 *  required fields happen to be present, and the run would record a status the
 *  hunter never wrote. The entries of each list are judged when the unit is
 *  settled, by the ledger's own unit schema. */
const unitResultSchema = z.strictObject({
  coverageId: z.custom<string>((value) => isVisibleText(value), expecting("expected the canonical coverage ID")),
  agentId: z.custom<SecurityAgentId>(isSecurityAgentId, expecting("expected a catalog agent id")),
  wave: positiveIntegerSchema,
  status: z.enum(TERMINAL_DISPOSITIONS, expecting("expected covered, candidate or blocked")),
  reviewedPaths: stringListSchema,
  checks: localChecksSchema,
  fingerprints: stringListSchema.optional(),
  unresolved: stringListSchema.optional(),
});
export type UnitResult = z.output<typeof unitResultSchema>;

/** Exported so the docs test pins the docs to THIS list rather than to a
 *  hand-copied one. Derived from the schema. */
export const UNIT_RESULT_KEYS: readonly string[] = unitResultSchema.keyof().options;

/**
 * Parse the settlement payload a hunter's parent submits.
 *
 * `recordUnitResult` checks the SETTLEMENT (owner, wave, resulting unit); this
 * checks the SHAPE, because a missing `checks` array would otherwise surface
 * deep inside the unit builder rather than naming the field. The optional
 * `fingerprints` and `unresolved` lists are absent or well-formed: a
 * present-but-malformed one is a violation, because dropping a candidate's
 * fingerprints silently turns a filed claim into a settlement with none.
 */
export function parseUnitResults(raw: unknown): DomainResult<readonly UnitResult[], CoverageError> {
  const parsed = parseWire(z.array(unitResultSchema, expecting("expected a top-level array")).readonly(), raw, "units");
  return parsed.ok ? parsed : failure(invalid(parsed.error));
}

export type SettlementError =
  | CoverageError
  | Readonly<{ kind: "unknown-coverage-id"; coverageId: string }>
  | Readonly<{ kind: "unit-not-in-flight"; coverageId: string; status: CoverageStatus }>
  | Readonly<{ kind: "wrong-owner"; coverageId: string; expected: string | null; actual: string }>
  | Readonly<{ kind: "wrong-wave"; coverageId: string; expected: number; actual: number }>
  | Readonly<{ kind: "settlement-invalid"; coverageId: string; violations: readonly CoverageViolation[] }>;

/**
 * Settle one in-flight unit with a hunter's structured result. The owner and
 * wave must match the assignment: a sibling cannot settle another hunter's
 * unit, and a stale attempt cannot settle the current wave. A unit settles
 * ONCE per wave: a second settlement is refused rather than allowed to
 * overwrite the first, because silently replacing a `blocked` disposition with
 * a `covered` one is how an incomplete run becomes a complete claim. A
 * reassignment goes through `mergeCritic`, which archives the prior attempt.
 *
 * The settled unit is PARSED as the disposition it claims: a `covered` result
 * with no checks, a candidate with no fingerprints or a path no check owns is
 * refused here, naming the unit's own fields.
 */
export function recordUnitResult(
  ledger: CoverageLedger,
  result: UnitResult,
): DomainResult<CoverageLedger, SettlementError> {
  const unit = ledger.find((candidate) => candidate.coverage_id === result.coverageId);
  if (unit === undefined) return failure({ kind: "unknown-coverage-id" as const, coverageId: result.coverageId });
  if (unit.status !== "in_progress") {
    return failure({ kind: "unit-not-in-flight" as const, coverageId: unit.coverage_id, status: unit.status });
  }
  if (unit.agent_id !== result.agentId) {
    return failure({ kind: "wrong-owner" as const, coverageId: unit.coverage_id, expected: unit.agent_id, actual: result.agentId });
  }
  if (unit.wave !== result.wave) {
    return failure({ kind: "wrong-wave" as const, coverageId: unit.coverage_id, expected: unit.wave, actual: result.wave });
  }
  const settled = rebuiltUnit(ledger, {
    ...unit,
    status: result.status,
    reviewed_paths: result.reviewedPaths,
    local_checks: result.checks,
    result_fingerprints: result.fingerprints ?? [],
    unresolved: result.unresolved ?? [],
  }, unit.coverage_id);
  if (!settled.ok) return failure({ kind: "settlement-invalid" as const, coverageId: unit.coverage_id, violations: settled.error });
  return success(replaceUnit(ledger, settled.value));
}

// --- Critics ---

/** One cell the critic says the ledger is missing, with the evidence a hunter
 *  needs to hunt it. Its paths and blocks are judged when it is seeded. */
const coverageProposalSchema = z.strictObject({
  refs: coverageRefsSchema,
  startingPaths: stringListSchema.default([]),
  ordinaryAttackClassBlock: visibleTextSchema.nullable().default(null),
  selectedCompanionBlocks: stringListSchema.default([]),
  excludedBlocks: z.array(excludedBlockSchema).readonly().default([]),
});
export type CoverageProposal = z.output<typeof coverageProposalSchema>;

/** The keys one proposed unit may carry. Exported for the same reason as
 *  `UNIT_RESULT_KEYS`: a doc that names a key this list omits is an agent whose
 *  output the engine refuses. */
export const CRITIC_PROPOSAL_KEYS: readonly string[] = coverageProposalSchema.keyof().options;

/** A coverage critic's document. Fail-closed: every key is allowlisted, the
 *  identity is required (a document the run cannot prove came from the critic
 *  cannot license `publish` to call a run complete), and the three collections
 *  are required — a critic that sends `{}` has not said "nothing to report", it
 *  has said nothing. */
const coverageCriticShape = z.strictObject({
  schemaVersion: z.literal(1, expecting("expected 1")),
  kind: z.literal("security-coverage-critic", expecting("expected security-coverage-critic")),
  missingUnits: z.array(coverageProposalSchema, expecting("expected an array of proposals")).readonly(),
  reassignIds: stringListSchema,
  resolvedPriorLeads: stringListSchema,
  stop: z.boolean(expecting("expected a boolean")).default(false),
});

export const CRITIC_KEYS: readonly string[] = coverageCriticShape.keyof().options;

const coverageCriticSchema = coverageCriticShape.transform(({ missingUnits, reassignIds, resolvedPriorLeads, stop }) =>
  ({ missingUnits, reassignIds, resolvedPriorLeads, stop }));
export type CoverageCriticResult = z.output<typeof coverageCriticSchema>;

/**
 * Parse a coverage critic's proposal set. `mergeCritic` decides what each
 * proposal MEANS; this decides whether the payload is a critic result at all,
 * so a typo in `missingUnits` is a named violation rather than an empty merge
 * that looks like "the critic found nothing".
 */
export function parseCriticResult(raw: unknown): DomainResult<CoverageCriticResult, CoverageError> {
  const parsed = parseWire(coverageCriticSchema, raw, "critic");
  return parsed.ok ? parsed : failure(invalid(parsed.error));
}

/** One `string → string` map. Absent is `{}`; anything else that is not an
 *  object of strings is refused — dropping a malformed map would leave a
 *  reassignment without its reason (which `mergeCritic` then refuses, naming
 *  the unit) or make a resolution unplaceable, while the payload still parsed. */
const stringMapSchema = z
  .record(z.string(), z.string(expecting("expected a string")), expecting("expected an object of string values"))
  .readonly()
  .default({});

/** The two maps a critic merge is given beside the critic's own document. Read
 *  from the wrapper the critic arrived in, whose own keys the shell closes. */
const criticMergeMapsSchema = z.object({
  /** coverage id → why the critic reassigned it (archived on the attempt). */
  reassignmentReasons: stringMapSchema,
  /** lead fingerprint → the coverage id of the unit that carries it. */
  priorLeadOwners: stringMapSchema,
});
export type CriticMergeMaps = z.output<typeof criticMergeMapsSchema>;

/** Parse the merge maps that travel beside a critic document. */
export function parseCriticMergeMaps(raw: unknown): DomainResult<CriticMergeMaps, CoverageError> {
  const parsed = parseWire(criticMergeMapsSchema, raw, "");
  return parsed.ok ? parsed : failure(invalid(parsed.error));
}

export type CriticMerge = Readonly<{
  ledger: CoverageLedger;
  accepted: readonly string[];
  reassigned: readonly string[];
  resolved: readonly string[];
}>;

export type CriticError =
  | CoverageError
  | Readonly<{ kind: "reassign-unit-has-no-evidence"; coverageId: string; status: CoverageStatus }>
  /** Every reassignment is archived with the critic's own reason: an attempt
   *  archived under a generic sentence is a history nobody can read back. */
  | Readonly<{ kind: "missing-reassignment-reason"; coverageId: string }>
  /** A resolution the engine cannot place is not a resolution: silently dropping
   *  it would let the run keep reporting a lead the critic considered settled. */
  | Readonly<{ kind: "unplaceable-resolution"; fingerprint: string; reason: string }>;

/**
 * Merge a coverage critic's proposals. Three effects, each mechanical and each
 * its own phase, applied in this order to the ledger the previous one left:
 *
 * - `acceptProposals`: a proposal enters as `planned` unless its semantic tuple
 *   is already present (dedupe). The canonical id is an injective encoding of
 *   that same tuple, so "same tuple, different id" cannot occur — there is no
 *   collision to report;
 * - `reassignUnits`: a reassigned unit archives its live evidence into
 *   `attempts` with the critic's reason (required per reassigned id), increments
 *   its wave, and clears the live evidence, so the next hunter starts fresh by
 *   construction;
 * - `resolveLeads`: a resolved prior lead is recorded on the unit that owns it.
 *
 * Every unit a phase builds is a parsed unit, and each phase keeps the ledger
 * sorted with every cell once, so the merged ledger needs no second pass.
 */
export function mergeCritic(
  ledger: CoverageLedger,
  critic: CoverageCriticResult,
  options: Readonly<{ wave: number; reassignmentReasons: Readonly<Record<string, string>>; priorLeadOwners?: Readonly<Record<string, string>> }>,
): DomainResult<CriticMerge, CriticError> {
  const proposals = acceptProposals(ledger, critic.missingUnits, options.wave);
  if (!proposals.ok) return proposals;
  const reassignment = reassignUnits(proposals.value.ledger, critic.reassignIds, options);
  if (!reassignment.ok) return reassignment;
  const resolution = resolveLeads(reassignment.value.ledger, critic.resolvedPriorLeads, options.priorLeadOwners ?? {});
  if (!resolution.ok) return resolution;
  return success({
    ledger: resolution.value.ledger,
    accepted: proposals.value.accepted,
    reassigned: reassignment.value.reassigned,
    resolved: resolution.value.resolved,
  });
}

/** Phase 1: each missing unit the critic proposes, seeded `planned` at `wave`
 *  unless its cell is already in the ledger. */
function acceptProposals(
  ledger: CoverageLedger,
  proposals: readonly CoverageProposal[],
  wave: number,
): DomainResult<Readonly<{ ledger: CoverageLedger; accepted: readonly string[] }>, CriticError> {
  let next = ledger;
  const accepted: string[] = [];
  const present = new Set(ledger.map((unit) => coverageSemanticKey(unit.canonical_refs)));
  for (const proposal of proposals) {
    const key = coverageSemanticKey(proposal.refs);
    if (present.has(key)) continue;
    const seeded = seedCoverageUnit({
      refs: proposal.refs,
      starting_paths: proposal.startingPaths,
      ordinary_attack_class_block: proposal.ordinaryAttackClassBlock,
      selected_companion_blocks: proposal.selectedCompanionBlocks,
      excluded_blocks: proposal.excludedBlocks,
      prior: null,
      wave,
    });
    if (!seeded.ok) return seeded;
    next = sortLedger([...next, seeded.value]);
    present.add(key);
    accepted.push(seeded.value.coverage_id);
  }
  return success({ ledger: next, accepted });
}

/** A settled unit's hunt as an archived attempt, and the unit planned again one
 *  wave on: nothing live is kept, so the next hunter starts fresh. */
function archived(unit: SettledUnit, reason: string): PlannedUnit {
  const {
    coverage_id, canonical_refs, surface, boundary, subsystem, attack_class, lifecycle, starting_paths,
    ordinary_attack_class_block, selected_companion_blocks, excluded_blocks, prior_status, attempts, wave, ...hunt
  } = unit;
  return {
    coverage_id, canonical_refs, surface, boundary, subsystem, attack_class,
    ...(lifecycle === undefined ? {} : { lifecycle }),
    starting_paths, ordinary_attack_class_block, selected_companion_blocks, excluded_blocks, prior_status,
    attempts: [...attempts, { ...hunt, wave, reassignment_reason: reason }],
    wave: wave + 1,
    status: "planned",
    agent_id: null,
    reviewed_paths: [],
    local_checks: [],
    result_fingerprints: [],
    unresolved: [],
  };
}

/** Phase 2: each unit the critic reassigns, its settled attempt archived with
 *  the critic's reason and the unit planned again one wave on. A reassigned id
 *  with no visible reason is refused: the archive records only what the run
 *  can name. A settled unit always has the owner its attempt is archived
 *  under — its type says so. */
function reassignUnits(
  ledger: CoverageLedger,
  coverageIds: readonly string[],
  options: Readonly<{ reassignmentReasons: Readonly<Record<string, string>> }>,
): DomainResult<Readonly<{ ledger: CoverageLedger; reassigned: readonly string[] }>, CriticError> {
  let next = ledger;
  const reassigned: string[] = [];
  for (const coverageId of coverageIds) {
    const unit = next.find((candidate) => candidate.coverage_id === coverageId);
    if (unit === undefined) return failure(invalid([wireViolation("reassignIds", `unknown coverage ID ${coverageId}`)]));
    if (!isSettledUnit(unit)) return failure({ kind: "reassign-unit-has-no-evidence" as const, coverageId, status: unit.status });
    const reason = options.reassignmentReasons[coverageId];
    if (!isVisibleText(reason)) return failure({ kind: "missing-reassignment-reason" as const, coverageId });
    next = replaceUnit(next, archived(unit, reason));
    reassigned.push(coverageId);
  }
  return success({ ledger: next, reassigned });
}

/** Phase 3: each prior lead the critic resolved, removed from the unit that
 *  carries it. A resolution the engine cannot place is a refusal, and so is one
 *  that would leave a unit without the facts its status requires (a blocked
 *  unit's last unresolved fact). */
function resolveLeads(
  ledger: CoverageLedger,
  fingerprints: readonly string[],
  owners: Readonly<Record<string, string>>,
): DomainResult<Readonly<{ ledger: CoverageLedger; resolved: readonly string[] }>, CriticError> {
  let next = ledger;
  const resolved: string[] = [];
  for (const fingerprint of fingerprints) {
    const ownerId = owners[fingerprint];
    if (ownerId === undefined) {
      return failure({ kind: "unplaceable-resolution" as const, fingerprint, reason: "no owning unit recorded" });
    }
    const unit = next.find((candidate) => candidate.coverage_id === ownerId);
    if (unit === undefined) {
      return failure({ kind: "unplaceable-resolution" as const, fingerprint, reason: `unknown coverage ID ${ownerId}` });
    }
    if (!lists(unit.unresolved, fingerprint)) {
      return failure({ kind: "unplaceable-resolution" as const, fingerprint, reason: `${ownerId} does not carry this lead` });
    }
    const rest = rebuiltUnit(next, { ...unit, unresolved: unit.unresolved.filter((entry) => entry !== fingerprint) }, ownerId);
    if (!rest.ok) return failure(invalid(rest.error));
    next = replaceUnit(next, rest.value);
    resolved.push(fingerprint);
  }
  return success({ ledger: next, resolved });
}

/** One planned unit deferred: unassigned, with the reason as its one
 *  unresolved fact. Total: a planned unit already holds no owner and no
 *  evidence, and the caller proved the reason visible. */
const asDeferred = (unit: PlannedUnit, reason: string): CoverageUnit => ({ ...unit, status: "deferred", unresolved: [reason] });

const deferralReasonRefused = (): CoverageError => invalid([wireViolation("reason", "a deferred unit requires a visible reason")]);

/** Units a budget could not reach become explicitly `deferred`. The reason is
 *  mandatory: a deferred unit without one is a silent gap wearing a label.
 *  Returns a `DomainResult` like every other transition, so a blank `--reason`
 *  is a refusal the caller can render rather than an escaped `TypeError`. */
export function deferPlannedUnits(
  ledger: CoverageLedger,
  reason: string,
): DomainResult<CoverageLedger, CoverageError> {
  if (!isVisibleText(reason)) return failure(deferralReasonRefused());
  return success(ledger.map((unit) => (unit.status === "planned" ? asDeferred(unit, reason) : unit)));
}

export type DeferralError =
  | CoverageError
  | Readonly<{ kind: "unknown-coverage-id"; coverageId: string }>
  | Readonly<{ kind: "unit-not-planned"; coverageId: string; status: CoverageStatus }>;

/**
 * Defer ONE unit — the case where a hunter reports a surface it could not reach.
 * Same rule as the bulk path: the reason lands in `unresolved`, so neither the
 * report nor a later run has to guess why the unit was never covered.
 *
 * Only a `planned` unit may be deferred. Deferring an in-flight unit would erase
 * the owner's live attempt without archiving it, and deferring a settled one
 * would rewrite a record that already has a disposition.
 */
export function deferUnit(
  ledger: CoverageLedger,
  coverageId: string,
  reason: string,
): DomainResult<CoverageLedger, DeferralError> {
  if (!isVisibleText(reason)) return failure(deferralReasonRefused());
  const unit = ledger.find((candidate) => candidate.coverage_id === coverageId);
  if (unit === undefined) return failure({ kind: "unknown-coverage-id" as const, coverageId });
  if (unit.status !== "planned") return failure({ kind: "unit-not-planned" as const, coverageId, status: unit.status });
  return success(replaceUnit(ledger, asDeferred(unit, reason)));
}

// --- Reporting ---

export type CoverageSummary = Readonly<{
  total: number;
  byStatus: Readonly<Record<CoverageStatus, number>>;
  candidates: readonly string[];
  deferred: readonly string[];
  blocked: readonly string[];
}>;

export function summarizeCoverage(ledger: CoverageLedger): CoverageSummary {
  // Typed `Record<CoverageStatus, number>`: a status added to the vocabulary
  // is a compile error here until it is counted, so none can be omitted.
  const byStatus: Record<CoverageStatus, number> = {
    planned: 0,
    not_applicable: 0,
    out_of_scope: 0,
    in_progress: 0,
    covered: 0,
    candidate: 0,
    blocked: 0,
    deferred: 0,
  };
  for (const unit of ledger) byStatus[unit.status] += 1;
  return {
    total: ledger.length,
    byStatus,
    candidates: ledger.filter((unit) => unit.status === "candidate").map((unit) => unit.coverage_id),
    deferred: ledger.filter((unit) => unit.status === "deferred").map((unit) => unit.coverage_id),
    blocked: ledger.filter((unit) => unit.status === "blocked").map((unit) => unit.coverage_id),
  };
}

/** The profile of a run, derived from its ledger in ONE place. `start` and
 *  `publish` both ask this question, and answering it twice produced two
 *  predicates that disagreed about the same ledger. */
export type RunStatusProjection = Readonly<{
  runStatus: "in_progress" | "complete" | "incomplete";
  incompleteReason: SecurityIncompleteReason | null;
}>;

/** Where an incomplete run's reason token came from: a deferred unit RECORDED
 *  it, or no deferred unit named an upstream token and the run reports the
 *  class a deferral belongs to — `inferred`, so the report says so rather than
 *  attributing a cause the ledger never wrote. */
export type IncompleteReasonSource = "recorded" | "inferred";

/** The upstream token a deferred unit recorded as its reason, if any. */
const recordedIncompleteReason = (ledger: CoverageLedger): SecurityIncompleteReason | undefined =>
  ledger
    .flatMap((unit): readonly string[] => (unit.status === "deferred" ? unit.unresolved : []))
    .find((reason): reason is SecurityIncompleteReason => isOneOf(SECURITY_INCOMPLETE_REASONS, reason));

/**
 * A run is `in_progress` while any unit awaits a hunt, is being hunted, or
 * ended its hunt `blocked` and awaits a critic's decision (`COVERAGE_PHASES`);
 * `complete` once every unit is settled and none is a disclosed gap; and
 * `incomplete` when settled coverage still holds deferred units.
 *
 * The reason comes from the deferred units' own recorded reason when it names an
 * upstream token; otherwise it is the class a deferral belongs to — coverage
 * stopped before the remaining units were verified — and
 * `incompleteReasonSource` reports it as INFERRED, so the report never presents
 * it as a cause the ledger recorded. The ledger's prose stays authoritative and
 * the report prints it beside the token.
 */
export function runStatusOf(ledger: CoverageLedger): RunStatusProjection {
  if (!coverageSettled(ledger)) return { runStatus: "in_progress", incompleteReason: null };
  if (coverageComplete(ledger)) return { runStatus: "complete", incompleteReason: null };
  return { runStatus: "incomplete", incompleteReason: recordedIncompleteReason(ledger) ?? "validation_budget_exhausted" };
}

/** Whether an incomplete run's reason was recorded by a deferred unit or
 *  inferred by `runStatusOf`. `null` for a run that is not incomplete. */
export function incompleteReasonSource(ledger: CoverageLedger): IncompleteReasonSource | null {
  if (runStatusOf(ledger).runStatus !== "incomplete") return null;
  return recordedIncompleteReason(ledger) === undefined ? "inferred" : "recorded";
}

/** A run may claim COMPLETE coverage only when every unit is `settled` — not
 *  awaiting a hunt or a decision, not in flight, not a disclosed gap. An empty
 *  ledger claims nothing: `every` over `[]` would call it complete. */
export function coverageComplete(ledger: CoverageLedger): boolean {
  return ledger.length > 0 && ledger.every((unit) => phaseOf(unit) === "settled");
}

/** SETTLED coverage allows disclosed deferrals: every unit reached `settled` or
 *  `disclosed-gap`, so some may be gaps with a reason. A settled run reports; a
 *  complete run claims. An empty ledger is not settled coverage of anything. */
export function coverageSettled(ledger: CoverageLedger): boolean {
  return ledger.length > 0 && ledger.every((unit) => phaseOf(unit) === "settled" || phaseOf(unit) === "disclosed-gap");
}

// --- The hunter's envelope ---

/** The hunter result's own identity. It is NOT a reviewer payload: it carries
 *  unit settlements and upstream report records, and a label borrowed from the
 *  reviewer wire claimed a conformance it never had (ADR-0066 D2, amended). */
export const HUNTER_RESULT_KIND = "security-hunter-result";
export const HUNTER_RESULT_SCHEMA_VERSION = 1;

/** Sort a hunter's RAW findings list into fingerprint order before it is parsed,
 *  so a hunter is not refused for its filing order. Same order as
 *  `sortByFingerprint`; entries with no fingerprint compare equal, so the parser
 *  — not a comparator returning NaN — names the actual violation. A non-list
 *  passes through untouched so the parser sees the shape it was sent. */
function sortWireByFingerprint(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const fingerprintOf = (entry: unknown): string | null =>
    isWireRecord(entry) && typeof entry.fingerprint === "string" ? entry.fingerprint : null;
  return [...raw].sort((left: unknown, right: unknown) => {
    const a = fingerprintOf(left);
    const b = fingerprintOf(right);
    return a === null || b === null ? 0 : compareStrings(a, b);
  });
}

const hunterResultShape = z.strictObject(
  {
    schemaVersion: z.literal(HUNTER_RESULT_SCHEMA_VERSION, expecting(`expected ${HUNTER_RESULT_SCHEMA_VERSION}`)),
    kind: z.literal(HUNTER_RESULT_KIND, {
      error: (issue) => `expected ${JSON.stringify(HUNTER_RESULT_KIND)}, got ${JSON.stringify(issue.input) ?? "nothing"} — ` +
        "a hunter returns its own envelope, not a reviewer payload",
    }),
    units: z.array(unitResultSchema, expecting("expected an array of unit results (empty when only filing findings)")).readonly(),
    findings: z.preprocess(sortWireByFingerprint, securityFindingsSchema).optional(),
  },
  { error: (issue) => (issue.code === "invalid_type" ? `expected a ${HUNTER_RESULT_KIND} object` : undefined) },
);

/** The keys a hunter result may carry. Exported so the docs test pins the
 *  hunter doc's block to THIS list. */
export const HUNTER_RESULT_KEYS: readonly string[] = hunterResultShape.keyof().options;

/**
 * What `submit` reads: `{ schemaVersion: 1, kind: "security-hunter-result",
 * units: [...], findings?: [...] }`. Strict on purpose — an unknown top-level key
 * is refused rather than ignored, and a payload in another program's envelope is
 * refused by its kind. `findings` are the upstream report records, sorted by
 * fingerprint before the parse (filing order is not a defect; a duplicate still
 * is). A result that carries neither a unit nor a finding says nothing.
 */
const hunterResultSchema = hunterResultShape
  .superRefine((result, ctx) => {
    if (result.units.length === 0 && (result.findings ?? []).length === 0) {
      ctx.addIssue({ code: "custom", message: "the hunter result carries neither unit results nor findings" });
    }
  })
  .transform(({ units, findings }) => ({ units, findings: findings ?? ([] satisfies readonly SecurityFinding[]) }));

export type HunterResult = z.output<typeof hunterResultSchema>;

export type HunterResultError = Readonly<{ kind: "invalid-hunter-result"; violations: readonly WireViolation[] }>;

export function parseHunterResult(raw: unknown): DomainResult<HunterResult, HunterResultError> {
  const parsed = parseWire(hunterResultSchema, raw, "");
  return parsed.ok ? parsed : failure({ kind: "invalid-hunter-result", violations: parsed.error });
}

// --- Nonce admission ---

export type ArtifactAdmission = Readonly<{
  artifact: OwnedArtifactPath;
  /** The in-flight units the owner holds — the hunts this receipt may serve. */
  coverageIds: readonly string[];
}>;

export type ArtifactAdmissionRefusal =
  | Readonly<{ kind: "malformed-artifact-path"; artifact: string; message: string }>
  | Readonly<{ kind: "no-in-flight-unit"; artifact: string; owner: SecurityAgentId; message: string }>
  | Readonly<{ kind: "archived-artifact"; artifact: string; coverageId: string; message: string }>;

/**
 * May the engine hand out the sandbox nonce for this artifact path? Only for a
 * path under the artifacts root of an owner the ledger currently has hunting:
 * a nonce is a binding a hunter copies into one sandbox run, so it is issued for
 * a live hunt, never for a guessed owner, a settled one, or an artifact an
 * archived attempt already cited (an archived artifact can never be cited again,
 * so its receipt could never count).
 */
export function admitArtifactNonce(
  ledger: CoverageLedger,
  artifact: string,
): DomainResult<ArtifactAdmission, ArtifactAdmissionRefusal> {
  const owned = parseOwnedArtifactPath(artifact);
  if (owned === null) {
    return failure({
      kind: "malformed-artifact-path" as const,
      artifact,
      message: `${JSON.stringify(artifact)} is not an owned artifact path — expected agents/<owner-id>/artifacts/<file>, run-relative`,
    });
  }
  const coverageIds = ledger
    .filter((unit) => unit.status === "in_progress" && unit.agent_id === owned.owner)
    .map((unit) => unit.coverage_id);
  if (coverageIds.length === 0) {
    return failure({
      kind: "no-in-flight-unit" as const,
      artifact,
      owner: owned.owner,
      message: `no in_progress unit is owned by ${owned.owner} — a nonce is issued only to the current owner of a unit in flight (the owner id \`assign\` printed)`,
    });
  }
  const archivedBy = ledger.find((unit) =>
    unit.attempts.some((attempt) => attempt.local_checks.some((check) => check.artifact === artifact)));
  if (archivedBy !== undefined) {
    return failure({
      kind: "archived-artifact" as const,
      artifact,
      coverageId: archivedBy.coverage_id,
      message: `${artifact} is already cited by an archived attempt of ${archivedBy.coverage_id} — an archived artifact cannot be reused; name a new file`,
    });
  }
  return success({ artifact: owned, coverageIds });
}
