/**
 * Security-audit grammar: profiles, scope, run metadata, coverage identity,
 * fingerprints, budget admission and prior-run carry rules.
 *
 * This is the leaf volume of the security-audit concept. It parses and it
 * decides; it never reads, writes, spawns or publishes. Everything that does
 * I/O lives in `handlers/helpers/programs/security-audit/`, and the ledger and
 * verdict volumes (`security-coverage`, `security-findings`) consume these
 * names without re-deriving them.
 *
 * Provenance of the vocabulary: `references/security-lenses/` and
 * `ATTRIBUTION.md`. The upstream skill's four incomplete-run tokens, its
 * fingerprint grammar, its prior-status table and its canonical coverage ID
 * encoding are preserved deliberately — the differential test
 * (`engine/tests/security/security-oracle.test.ts`) proves this module and
 * upstream's validator agree about them.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { z } from "zod/v4";
import { match } from "ts-pattern";
import { compareStrings } from "./ordering";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import { isRecord } from "./plain-record";

// --- Wire parsing kit ---

/** One named defect in a wire document: where it is, and what is wrong there.
 *  The ledger, findings and critic parsers all report in this shape, so a
 *  diagnostic reads the same whichever volume refused the document. */
export type WireViolation = Readonly<{ path: string; message: string }>;

export const wireViolation = (path: string, message: string): WireViolation => ({ path, message });

/** A JSON object — not `null`, not an array. Every wire parser asks this before
 *  reading a field, so a scalar where a record belongs is a violation rather than
 *  a property read on a primitive. */
export const isWireRecord = (value: unknown): value is Readonly<Record<string, unknown>> => isRecord(value);

/** Membership in a closed string vocabulary, as a type guard: the one spelling
 *  every security volume uses before matching on a wire tag (an exhaustive
 *  match THROWS on an unknown one). */
export const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

/**
 * Every key `record` carries that `allowed` does not name, as an "unknown
 * field" violation at `base.<key>`. `order` keeps each caller's observable
 * diagnostics: `as-written` reports in the document's key order, `sorted` in
 * code-point order. The one unknown-key reporter of the security volumes.
 */
export const unknownFieldViolations = (
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  base: string,
  order: "as-written" | "sorted" = "as-written",
): WireViolation[] => {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  return (order === "sorted" ? unknown.sort(compareStrings) : unknown).map((key) => wireViolation(`${base}.${key}`, "unknown field"));
};

/**
 * An optional list of strings. Absent is an empty list; present-but-malformed
 * (`"a"`, `[1]`, `{}`) is a named violation and an empty list — never a silent
 * empty list, because a dropped exclusion or fingerprint shrinks the truth the
 * record claims while the document still parses.
 */
export function wireStringList(value: unknown, path: string, violations: WireViolation[]): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    violations.push(wireViolation(path, "expected an array of strings"));
    return [];
  }
  return [...value];
}

// --- Limits ---

export const SECURITY_AUDIT_LIMITS = Object.freeze({
  /** Coverage units one run may hold (upstream's ledger ceiling). */
  units: 10_000,
  /** Entries in any per-unit collection (paths, checks, attempts, blocks). */
  collectionItems: 1_000,
  /** Archived attempts per unit. */
  attemptsPerUnit: 1_000,
  /** Canonical reference text length, before percent-encoding. */
  referenceLength: 1_024,
  /** Free prose length inside one record field. */
  proseLength: 4_096,
  /** Findings one run may publish. */
  findings: 1_000,
  /** Blocks one lens selection may name. */
  companionBlocks: 64,
});

// --- Profiles ---

export const SECURITY_PROFILES = ["quick", "standard", "deep"] as const;
export type SecurityProfile = (typeof SECURITY_PROFILES)[number];

/**
 * How many lens documents one run of each profile may hold in context.
 *
 * A lens is a context cost, and the PROFILE is the operator's declared budget
 * for that cost — so the cap lives here rather than as a default buried in the
 * selector, where a `deep` run silently stopping at three lenses would be a
 * breadth limit nobody chose. A lens trimmed by the cap is always reported in
 * `excluded` with its reason, never dropped quietly.
 */
export const SECURITY_PROFILE_LENSES: Readonly<Record<SecurityProfile, number>> = Object.freeze({
  quick: 2,
  standard: 4,
  deep: 8,
});
/** The tokens upstream fixes for a run that could not be completed. Closed on
 *  purpose: an incomplete run that cannot name its reason is a silent one. */
export const SECURITY_INCOMPLETE_REASONS = [
  "budget_cannot_fund_reconnaissance_and_reserves",
  "budget_cannot_reserve_critics_and_validation",
  "critic_budget_exhausted",
  "validation_budget_exhausted",
] as const;
export type SecurityIncompleteReason = (typeof SECURITY_INCOMPLETE_REASONS)[number];

export type SecurityProfileError = Readonly<{ kind: "invalid-security-profile"; message: string }>;

const isSecurityProfile = (value: unknown): value is SecurityProfile =>
  typeof value === "string" && (SECURITY_PROFILES as readonly string[]).includes(value);

export const parseSecurityProfile = (raw: unknown): DomainResult<SecurityProfile, SecurityProfileError> =>
  isSecurityProfile(raw)
    ? success(raw)
    : failure({ kind: "invalid-security-profile" as const, message: `profile must be one of ${SECURITY_PROFILES.join(", ")}` });

// --- Identity grammar ---

/** A stable, source-derived identifier. It never carries a line number, wave,
 *  agent, severity or verdict: those change between states of one finding. */
export const SECURITY_FINGERPRINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

/** Canonical lowercase agent IDs. Lowercase prevents case-fold collisions; the
 *  Windows device names are excluded because a scratch root may be created. */
export const SECURITY_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_RESERVED_AGENT_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

const VISIBLE_CONTENT = /[^\p{White_Space}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const PATH_FORBIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const WINDOWS_RESERVED_COMPONENT =
  /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu;

/** Valid UTF-16 with no lone surrogate: every later encoder assumes it. */
export function hasValidUnicodeScalarValues(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    const first = value.charCodeAt(index++);
    if (first >= 0xd800 && first <= 0xdbff) {
      if (index >= value.length) return false;
      const second = value.charCodeAt(index++);
      if (second < 0xdc00 || second > 0xdfff) return false;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Prose that a reader can actually see: no zero-width-only strings. */
export function hasVisibleProse(value: string): boolean {
  return hasValidUnicodeScalarValues(value) && VISIBLE_CONTENT.test(value);
}

export function isVisibleText(value: unknown, maxLength: number = SECURITY_AUDIT_LIMITS.proseLength): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    hasVisibleProse(value)
  );
}

export const isSecurityFingerprint = (value: unknown): value is string =>
  typeof value === "string" && SECURITY_FINGERPRINT_PATTERN.test(value);

export const isSecurityAgentId = (value: unknown): value is string =>
  typeof value === "string" &&
  SECURITY_AGENT_ID_PATTERN.test(value) &&
  !WINDOWS_RESERVED_AGENT_ID.test(value);

/**
 * A repository-relative source path the engine may cite. Absolute, traversal,
 * Windows-reserved and non-NFC-suspicious forms all fail: a record that cites
 * a path outside the target is not source evidence.
 */
export function isSafeSourcePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !hasValidUnicodeScalarValues(value) ||
    value.trim() !== value ||
    PATH_FORBIDDEN_CHARACTER.test(value) ||
    value.includes("\\") ||
    value.includes(":")
  ) {
    return false;
  }
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value)) return false;
  return value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== ".." && !/[ .]$/u.test(segment) && !WINDOWS_RESERVED_COMPONENT.test(segment));
}

// --- Coverage identity ---

declare const canonicalRefs: unique symbol;

/** The four semantic coordinates of a coverage unit. `lifecycle` is optional;
 *  when present it must be present in both the unit and its canonical refs.
 *  Branded: only `isCanonicalCoverageRefs` (and so `parseCoverageRefs`)
 *  produces one, so `canonicalCoverageId` and `coverageSemanticKey` read
 *  coordinates that are already canonical references — parse, don't validate. */
export type CoverageRefs = Readonly<{
  surface: string;
  boundary: string;
  subsystem: string;
  attack_class: string;
  lifecycle?: string;
}> & Readonly<{ [canonicalRefs]: true }>;

const REF_FIELDS = ["surface", "boundary", "subsystem", "attack_class"] as const;

function isCanonicalRef(value: unknown): value is string {
  return (
    isVisibleText(value, SECURITY_AUDIT_LIMITS.referenceLength) &&
    !PATH_FORBIDDEN_CHARACTER.test(value) &&
    value.normalize("NFC") === value
  );
}

/** The fields a refs record must hold: the four coordinates, plus `lifecycle`
 *  when the record carries one. */
const expectedRefFields = (record: Readonly<Record<string, unknown>>): readonly string[] =>
  record.lifecycle === undefined ? REF_FIELDS : [...REF_FIELDS, "lifecycle"];

/** The one proof of a `CoverageRefs`: exactly the expected fields, each a
 *  canonical reference. A type guard rather than a cast, so the brand is earned
 *  by the check that names it. */
export function isCanonicalCoverageRefs(value: unknown): value is CoverageRefs {
  if (!isWireRecord(value)) return false;
  const expected = expectedRefFields(value);
  return Object.keys(value).length === expected.length && expected.every((field) => Object.hasOwn(value, field) && isCanonicalRef(value[field]));
}

/** RFC 3986 unreserved bytes stay literal; everything else is percent-encoded.
 *  The encoding is injective over valid references, which is what makes a
 *  canonical coverage ID a safe map key. Injective *because* `:` is reserved:
 *  the field separator `::` can never appear inside a field, so two different
 *  reference tuples cannot encode to one id. */
export function encodeCanonicalRef(value: string): string {
  if (!isCanonicalRef(value)) throw new TypeError("invalid canonical reference");
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e;
    encoded += unreserved ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/** The coordinates in their one fixed field order, `lifecycle` last when present. */
const refCoordinates = (refs: CoverageRefs): readonly string[] =>
  [refs.surface, refs.boundary, refs.subsystem, refs.attack_class, ...(refs.lifecycle === undefined ? [] : [refs.lifecycle])];

/** The unit's identity: the encoded coordinates joined in a fixed field order.
 *  Total over `CoverageRefs`: the brand proves every coordinate canonical, so
 *  `encodeCanonicalRef` cannot refuse one. */
export function canonicalCoverageId(refs: CoverageRefs): string {
  return refCoordinates(refs).map(encodeCanonicalRef).join("::");
}

export type CoverageRefError = Readonly<{
  kind: "invalid-coverage-refs";
  message: string;
}>;

export const parseCoverageRefs = (raw: unknown): DomainResult<CoverageRefs, CoverageRefError> => {
  const refuse = (message: string) => failure({ kind: "invalid-coverage-refs" as const, message });
  if (!isWireRecord(raw)) return refuse("canonical_refs must be an object");
  const expected = expectedRefFields(raw);
  if (Object.keys(raw).length !== expected.length || expected.some((field) => !Object.hasOwn(raw, field))) {
    return refuse(`canonical_refs must hold exactly ${expected.join(", ")}`);
  }
  const malformed = expected.find((field) => !isCanonicalRef(raw[field]));
  if (malformed !== undefined) return refuse(`canonical_refs.${malformed} is not a canonical reference`);
  // A fresh record in the fixed field order, so the caller never holds the
  // document it passed in; the guard re-proves it rather than a cast asserting it.
  const refs: unknown = Object.fromEntries(expected.map((field) => [field, raw[field]]));
  return isCanonicalCoverageRefs(refs) ? success(refs) : refuse("canonical_refs is not a canonical tuple");
};

/** The tuple that must be unique across a ledger: two units with different IDs
 *  but the same semantics are one unit, and a run that assigns both double-counts
 *  coverage. */
export function coverageSemanticKey(refs: CoverageRefs): string {
  return JSON.stringify([refs.surface, refs.boundary, refs.subsystem, refs.attack_class, refs.lifecycle ?? null]);
}

// --- Run metadata ---

const bounded = (max: number) => z.string().min(1).max(max);
const safePathSchema = bounded(4_096).refine(isSafeSourcePath, "expected a repository-relative source path");
/** A commit a diff scope names: a 40- (SHA-1) or 64-hex (SHA-256) object id. */
export const SCOPE_REF_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const digestSchema = z.string().regex(SCOPE_REF_PATTERN);

const scopePathsSchema = z.array(safePathSchema).min(1).max(SECURITY_AUDIT_LIMITS.units).readonly();

/** What a run audits — a discriminated union, so a scope's refs are exactly the
 *  ones its kind means: a `tree` scope names no refs (both `null`), and a
 *  `diff` scope audits the difference between two refs and names BOTH. A diff
 *  with a missing ref identifies no diff, and a tree carrying refs would keep
 *  facts nothing reads; neither parses. */
export const securityScopeSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ paths: scopePathsSchema, kind: z.literal("tree"), baseRef: z.null(), headRef: z.null() }),
    z.strictObject({ paths: scopePathsSchema, kind: z.literal("diff"), baseRef: digestSchema, headRef: digestSchema }),
  ])
  .readonly();
export type SecurityScope = z.infer<typeof securityScopeSchema>;

export const securityRunMetadataSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runId: bounded(192),
    repo: bounded(512),
    target: bounded(4_096),
    profile: z.enum(SECURITY_PROFILES).readonly(),
    scope: securityScopeSchema,
    scopePaths: z.array(safePathSchema).max(SECURITY_AUDIT_LIMITS.units).readonly(),
    sourceRef: z
      .strictObject({
        commit: z.string().regex(/^[0-9a-f]{40}$/),
        worktreeDirty: z.boolean(),
      })
      .readonly(),
    /** Maximum agent invocations across every phase; null means unset. */
    budget: z.number().int().min(1).max(100_000).nullable(),
    executionPolicy: z.literal("sandboxed-source-and-local-only"),
    selectedCompanions: z.array(bounded(2_048)).max(SECURITY_AUDIT_LIMITS.companionBlocks).readonly(),
    priorRuns: z.array(bounded(4_096)).max(SECURITY_AUDIT_LIMITS.collectionItems).readonly(),
    runStatus: z.enum(["in_progress", "complete", "incomplete"]),
    incompleteReason: z.enum(SECURITY_INCOMPLETE_REASONS).nullable(),
    /** Whether `publish` committed this run's records and prose. The commit
     *  point is this flag, written LAST, so a half-written run directory cannot
     *  pass for a published one merely because a file exists. */
    published: z.boolean(),
  })
  /** The closed reason vocabulary is only closed if it is tied to the status: an
   *  incomplete run that cannot name its reason is a silent one, and a complete
   *  run carrying a reason describes a state that does not exist. Publication is
   *  tied to it too: `publish` refuses a run whose coverage has not settled, so
   *  a published run that is still in progress is a document no writer made. */
  .superRefine((value, ctx) => {
    if (value.runStatus === "incomplete" && value.incompleteReason === null) {
      ctx.addIssue({ code: "custom", path: ["incompleteReason"], message: "an incomplete run must name its reason" });
    }
    if (value.runStatus !== "incomplete" && value.incompleteReason !== null) {
      ctx.addIssue({ code: "custom", path: ["incompleteReason"], message: `a ${value.runStatus} run records no incomplete reason` });
    }
    if (value.published && value.runStatus === "in_progress") {
      ctx.addIssue({ code: "custom", path: ["published"], message: "an in_progress run cannot be published" });
    }
  })
  .readonly();
export type SecurityRunMetadata = z.infer<typeof securityRunMetadataSchema>;

export type RunMetadataError = Readonly<{
  kind: "invalid-run-metadata";
  issues: readonly string[];
}>;

export const parseSecurityRunMetadata = (raw: unknown): DomainResult<SecurityRunMetadata, RunMetadataError> => {
  const parsed = securityRunMetadataSchema.safeParse(raw);
  return parsed.success
    ? success(parsed.data)
    : failure({
        kind: "invalid-run-metadata" as const,
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`),
      });
};

// --- Budget admission ---

/** Reconnaissance calls every run reserves before hunting (upstream: parallel
 *  product/authority/surface agents plus one synthesis pass). */
const RECONNAISSANCE_CALLS = 4;

export type WaveAdmission = Readonly<{
  /** How many hunters this wave may launch. */
  hunterAssignments: number;
  /** Invocations left after this wave's hunters, measured from the unspent
   *  budget. The critic and validation `reserved` invocations are still INSIDE
   *  this number — admission guarantees `remaining >= reserved`, it does not
   *  spend the reserve. */
  remaining: number;
  /** Invocations the profile requires beyond the hunters. */
  reserved: number;
}>;

export type BudgetRefusal = Readonly<{
  kind: "budget-refusal";
  reason: SecurityIncompleteReason;
  required: number;
  available: number;
  message: string;
}>;

export type WaveAdmissionRequest = Readonly<{
  profile: SecurityProfile;
  /** Invocations the run may spend in total. */
  budget: number;
  /** Invocations already spent across every phase. */
  spent: number;
  /** Units this wave plans to hunt. */
  plannedHunters: number;
  /** Expected surviving candidates; null means "unknown" → 30% of the balance. */
  expectedCandidates: number | null;
}>;

/**
 * Reserve critics and validation BEFORE hunters (upstream's order, kept because
 * spending hunters into the critic reserve is how a run loses its coverage
 * critic and then claims coverage it never checked).
 *
 * `quick` reserves exactly one final post-wave critic, so a quick run's wave is
 * the last one by construction.
 */
export function admitWave(
  request: WaveAdmissionRequest,
): DomainResult<WaveAdmission, BudgetRefusal> {
  const { profile, budget, spent, plannedHunters, expectedCandidates } = request;
  const finalCleanCritics = profile === "quick" ? 0 : 1;
  const mandatoryCritics = 1 + finalCleanCritics;
  const remaining = budget - spent;

  const verifierCallsPerCandidate = profile === "deep" ? 2 : 1;
  const balanceAfterCritics = Math.max(0, remaining - mandatoryCritics);
  const validationReserve =
    expectedCandidates === null
      ? Math.max(1, Math.ceil(balanceAfterCritics * 0.3))
      : Math.max(1, expectedCandidates * verifierCallsPerCandidate);

  const minimum = RECONNAISSANCE_CALLS + mandatoryCritics + 1;
  if (budget < minimum) {
    return failure({
      kind: "budget-refusal" as const,
      reason: "budget_cannot_fund_reconnaissance_and_reserves" as const,
      required: minimum,
      available: budget,
      message: `budget ${budget} cannot fund ${RECONNAISSANCE_CALLS} reconnaissance calls, ${mandatoryCritics} critics and one validation call`,
    });
  }

  const reserved = mandatoryCritics + validationReserve;
  if (remaining - reserved <= 0) {
    return failure({
      kind: "budget-refusal" as const,
      reason: plannedHunters > 0 ? "critic_budget_exhausted" as const : "budget_cannot_reserve_critics_and_validation" as const,
      required: reserved + 1,
      available: remaining,
      message: `wave needs ${reserved} reserved invocations (critics + validation) and has ${remaining} left`,
    });
  }

  const hunterAssignments = Math.min(plannedHunters, remaining - reserved);
  if (plannedHunters > 0 && hunterAssignments === 0) {
    return failure({
      kind: "budget-refusal" as const,
      reason: "critic_budget_exhausted" as const,
      required: reserved + 1,
      available: remaining,
      message: `no hunter fits beside the ${reserved} reserved invocations`,
    });
  }

  return success({
    hunterAssignments,
    remaining: remaining - hunterAssignments,
    reserved,
  });
}

// --- Prior-run carry rules ---

/** Upstream's prior-status vocabulary, preserved verbatim so a vendored ledger
 *  row can be read by either implementation. */
export const PRIOR_STATUSES = [
  "new",
  "prior_confirmed_same_source",
  "prior_confirmed_changed_source",
  "prior_needs_validation",
  "prior_deferred",
  "prior_blocked",
  "prior_out_of_scope",
  "prior_covered_same_source",
  "prior_covered_changed_source",
  "prior_rejected_claim_changed",
  "none",
] as const;
export type PriorStatus = (typeof PRIOR_STATUSES)[number];

/** The verdict tags of the carry table, as runtime data. */
export const PRIOR_RECORD_VERDICTS = [
  "confirmed", "needs_validation", "rejected", "covered", "deferred", "blocked", "out_of_scope",
] as const;
export type PriorRecordVerdict = (typeof PRIOR_RECORD_VERDICTS)[number];

/** What a prior record was, and whether its relevant source is still current. */
export type PriorRecordFacts = Readonly<{
  verdict: PriorRecordVerdict;
  /** `true`/`false` when the current source was compared; `unknown` when it was not. */
  sourceUnchanged: boolean | null;
}>;
const PRIOR_FACTS_KEYS: readonly string[] = ["verdict", "sourceUnchanged"];

/**
 * Parse prior-run facts from the wire. `derivePriorStatus` matches the verdict
 * exhaustively — that proves the CLOSED union total, but a wire document can
 * carry any string and `.exhaustive()` THROWS on an unknown tag. A seed naming
 * a carry-status token from an earlier ledger row (`prior_confirmed_same_source`)
 * or a `prior` object with no `verdict` aborted `start` with an unnamed
 * pattern-match error instead of the violation this returns.
 *
 * `undefined`/`null` parses to `null`: "no prior record" is a real seed value.
 */
export function parsePriorRecordFacts(
  raw: unknown,
): DomainResult<PriorRecordFacts | null, Readonly<{ path: string; message: string }>> {
  if (raw === undefined || raw === null) return success(null);
  if (!isWireRecord(raw)) {
    return failure({ path: "prior", message: "expected null or prior-run facts" });
  }
  const record = raw;
  const unexpected = Object.keys(record).filter((key) => !PRIOR_FACTS_KEYS.includes(key)).sort(compareStrings);
  if (unexpected.length > 0) {
    return failure({ path: "prior", message: `unexpected field(s): ${unexpected.join(", ")}` });
  }
  if (!(PRIOR_RECORD_VERDICTS as readonly unknown[]).includes(record.verdict)) {
    return failure({ path: "prior.verdict", message: `expected one of ${PRIOR_RECORD_VERDICTS.join(", ")}` });
  }
  const unchanged = record.sourceUnchanged;
  if (unchanged !== null && typeof unchanged !== "boolean") {
    return failure({ path: "prior.sourceUnchanged", message: "expected true, false or null" });
  }
  // Membership was just checked, so this is the parser's own proof, not a cast
  // over unexamined input.
  return success({ verdict: record.verdict as PriorRecordFacts["verdict"], sourceUnchanged: unchanged });
}

/**
 * The carry table. `unknown` is not `unchanged`: an unchecked source is current
 * work, because "we did not look" has never meant "nothing changed".
 */
export function derivePriorStatus(prior: PriorRecordFacts | null): PriorStatus {
  if (prior === null) return "none";
  const unchanged = prior.sourceUnchanged === true;
  return match(prior.verdict)
    .returnType<PriorStatus>()
    .with("confirmed", () => (unchanged ? "prior_confirmed_same_source" : "prior_confirmed_changed_source"))
    .with("covered", () => (unchanged ? "prior_covered_same_source" : "prior_covered_changed_source"))
    .with("needs_validation", () => "prior_needs_validation")
    .with("deferred", () => "prior_deferred")
    .with("blocked", () => "prior_blocked")
    .with("out_of_scope", () => "prior_out_of_scope")
    .with("rejected", () => "prior_rejected_claim_changed")
    .exhaustive();
}

export type CarryAction =
  /** Seed a planned unit, exclude the root cause from hunters, and re-verify it. */
  | Readonly<{ kind: "carry-confirmed" }>
  /** Current planned work: the prior confirmation is only valid for its own source. */
  | Readonly<{ kind: "revalidate" }>
  /** Suppress only the unchanged failed claim, never coverage of the unit. */
  | Readonly<{ kind: "suppress-rejected-claim" }>
  /** Current planned work with the prior record's state as context, not evidence. */
  | Readonly<{ kind: "current-work" }>;

export function carryAction(priorStatus: PriorStatus): CarryAction {
  return match(priorStatus)
    .returnType<CarryAction>()
    .with("prior_confirmed_same_source", () => ({ kind: "carry-confirmed" }))
    .with(
      "prior_confirmed_changed_source",
      "prior_covered_changed_source",
      "prior_needs_validation",
      () => ({ kind: "revalidate" }),
    )
    .with("prior_rejected_claim_changed", () => ({ kind: "suppress-rejected-claim" }))
    .with(
      "prior_covered_same_source",
      "prior_deferred",
      "prior_blocked",
      "prior_out_of_scope",
      "new",
      "none",
      () => ({ kind: "current-work" }),
    )
    .exhaustive();
}
