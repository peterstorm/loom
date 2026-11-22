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
import { failure, isNonEmpty, success, type DomainResult, type NonEmpty } from "./orchestration-contract/identity";
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
 * A zod error parameter: an ABSENT field is `required`, any other refusal is
 * `message`. Every security schema states its domain message through this, so
 * "the field is missing" and "the field is wrong" never read alike.
 */
export const expecting = (message: string) => ({
  error: (issue: Readonly<{ input?: unknown }>): string => (issue.input === undefined ? "required" : message),
});

/** The fallback wording for an issue a schema did not word itself: one table,
 *  so every security document reads the same whichever volume refused it. */
const defaultWireMessage = (issue: z.core.$ZodRawIssue): string | undefined =>
  match(issue)
    .with({ code: "invalid_type" }, ({ expected, input }) =>
      input === undefined ? "required" : `expected ${/^[aeiou]/.test(expected) ? "an" : "a"} ${expected}`)
    .with({ code: "unrecognized_keys" }, () => "unknown field")
    .with({ code: "too_small", origin: "array" }, ({ minimum }) =>
      `requires at least ${String(minimum)} ${minimum === 1 ? "entry" : "entries"}`)
    .with({ code: "too_big", origin: "array" }, ({ maximum }) => `too many entries (at most ${String(maximum)})`)
    .with({ code: "too_big", origin: "string" }, ({ maximum }) => `longer than ${String(maximum)} characters`)
    .with({ code: "invalid_value" }, ({ values }) => `expected ${values.map((value) => JSON.stringify(value)).join(" or ")}`)
    .otherwise(() => undefined);

/** A zod path as the security volumes print it: `root.key[index]`. An empty
 *  `root` makes the first key the head (`kind`, `units[0].status`); an empty
 *  path is the root itself, `$` when there is none. */
export const wirePath = (root: string, path: readonly PropertyKey[]): string =>
  path.reduce<string>((at, key) =>
    (typeof key === "number" ? `${at}[${key}]` : at === "" ? String(key) : `${at}.${String(key)}`), root) || "$";

/**
 * The one adapter from zod issues to `WireViolation`s, in zod's own traversal
 * order (deterministic: the schema's field order, then the document's). An
 * unknown-key issue names each key at its own path, so a document with two
 * strays reads as two defects.
 */
const wireViolationsOf = (issues: readonly z.core.$ZodIssue[], root: string): readonly WireViolation[] =>
  issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => wireViolation(wirePath(root, [...issue.path, key]), issue.message))
      : [wireViolation(wirePath(root, issue.path), issue.message)]);

/**
 * Parse `raw` with `schema`: the parsed value, or every violation at once,
 * pathed from `root`. The one boundary where zod's `{ success, data }` becomes a
 * `DomainResult` for the security volumes.
 */
export const parseWire = <Schema extends z.ZodType>(
  schema: Schema,
  raw: unknown,
  root = "$",
): DomainResult<z.output<Schema>, readonly WireViolation[]> => {
  const parsed = schema.safeParse(raw, { error: defaultWireMessage });
  return parsed.success ? success(parsed.data) : failure(wireViolationsOf(parsed.error.issues, root));
};

/** A schema whose value is whatever `parse` proves — the bridge from an
 *  existing smart constructor (branded ids, canonical refs) into a zod shape, so
 *  the constructor stays the one owner of its rule. A refusal reports
 *  `message` when given, else the constructor's own error message. */
export const parsedBy = <T>(
  parse: (raw: unknown) => DomainResult<T, Readonly<{ message: string }>>,
  message?: string,
) =>
  z.unknown().transform((raw, ctx): T => {
    const parsed = parse(raw);
    if (parsed.ok) return parsed.value;
    ctx.addIssue({ code: "custom", message: raw === undefined ? "required" : message ?? parsed.error.message });
    return z.NEVER;
  });

/** A refinement over a list: every entry whose `keyOf` repeats an earlier one is
 *  a `duplicate entry`, named at its own index. Duplicates matter beyond
 *  tidiness — a repeated path inflates the reviewed-path count a coverage claim
 *  rests on, and a repeated trace step pads a finding. */
const distinctEntries = <T>(keyOf: (entry: T) => string) =>
  (entries: readonly T[], ctx: z.core.$RefinementCtx<readonly T[]>): void => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const key = keyOf(entry);
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: [index], message: "duplicate entry" });
      seen.add(key);
    });
  };

/** A list of at most `collectionItems` entries, no two with the same `keyOf`. */
export const listOf = <Entry extends z.ZodType>(entry: Entry, keyOf: (entry: z.output<Entry>) => string) =>
  z.array(entry).max(SECURITY_AUDIT_LIMITS.collectionItems).superRefine(distinctEntries(keyOf)).readonly();

/** `listOf`, and never empty: the type is `NonEmpty`, so a reader of the parsed
 *  value never re-checks the emptiness `message` already refused. */
export const nonEmptyListOf = <Entry extends z.ZodType>(
  entry: Entry,
  keyOf: (entry: z.output<Entry>) => string,
  message = "requires at least one entry",
) =>
  z
    .array(entry)
    .max(SECURITY_AUDIT_LIMITS.collectionItems)
    .transform((values, ctx): NonEmpty<z.output<Entry>> => {
      if (isNonEmpty(values)) return values;
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    })
    .superRefine(distinctEntries(keyOf))
    .readonly();

/** A list that holds nothing: the state a status keeps empty, as a type. */
export const emptyList = (message: string) =>
  z.tuple([], { error: (issue) => (issue.code === "too_big" ? message : undefined) }).readonly();

/** Identity, as a `keyOf` for lists of strings. */
export const itself = (value: string): string => value;

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

/** A positive integer (a wave, a source line): the one spelling of that
 *  predicate across the security volumes. */
export const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

export const isSecurityFingerprint = (value: unknown): value is string =>
  typeof value === "string" && SECURITY_FINGERPRINT_PATTERN.test(value);

declare const securityAgentId: unique symbol;

/** A canonical agent id: one word of `[a-z0-9_-]`, so it names a scratch root
 *  and rides bare in a printed shell command (no character a shell reads
 *  specially). Branded: only `isSecurityAgentId` proves one. */
export type SecurityAgentId = string & Readonly<{ [securityAgentId]: true }>;

export const isSecurityAgentId = (value: unknown): value is SecurityAgentId =>
  typeof value === "string" &&
  SECURITY_AGENT_ID_PATTERN.test(value) &&
  !WINDOWS_RESERVED_AGENT_ID.test(value);

// --- Field schemas: the grammar above, as zod shapes ---

/** Bounded, trimmed visible text (`isVisibleText`): the coverage volume's prose. */
export const visibleTextSchema = z.custom<string>((value) => isVisibleText(value), expecting("expected visible text"));
export const sourcePathSchema = z.custom<string>(isSafeSourcePath, expecting("expected a repository-relative source path"));
export const fingerprintSchema = z.custom<string>(isSecurityFingerprint, expecting("expected a stable source-derived fingerprint"));
export const agentIdSchema = z.custom<SecurityAgentId>(isSecurityAgentId, expecting("expected a canonical lowercase agent ID"));
export const positiveIntegerSchema = z.custom<number>(isPositiveInteger, expecting("expected a positive integer"));
/** A JSON list of strings, entries unchecked beyond their type. */
export const stringListSchema = z.array(z.string(expecting("expected a string")), expecting("expected an array of strings")).readonly();

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
  const refs: unknown = Object.freeze(Object.fromEntries(expected.map((field) => [field, raw[field]])));
  return isCanonicalCoverageRefs(refs) ? success(refs) : refuse("canonical_refs is not a canonical tuple");
};

/** A canonical refs tuple as a field schema: `parseCoverageRefs` stays the one
 *  proof of the brand. */
export const coverageRefsSchema = parsedBy(parseCoverageRefs);

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
/** A commit object id, branded by the one parse that proves the pattern, so a
 *  diff scope's refs carry the rule in their type. */
export const commitIdSchema = z.string().regex(SCOPE_REF_PATTERN).brand<"CommitId">();
export type CommitId = z.output<typeof commitIdSchema>;

const scopePathsSchema = z.array(safePathSchema).min(1).max(SECURITY_AUDIT_LIMITS.units).readonly();

/** What a run audits — a discriminated union, so a scope's refs are exactly the
 *  ones its kind means: a `tree` scope names no refs (both `null`), and a
 *  `diff` scope audits the difference between two refs and names BOTH. A diff
 *  with a missing ref identifies no diff, and a tree carrying refs would keep
 *  facts nothing reads; neither parses. */
export const securityScopeSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ paths: scopePathsSchema, kind: z.literal("tree"), baseRef: z.null(), headRef: z.null() }),
    z.strictObject({ paths: scopePathsSchema, kind: z.literal("diff"), baseRef: commitIdSchema, headRef: commitIdSchema }),
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

/**
 * Prior-run facts as the wire carries them: what a prior record was, and
 * whether its relevant source is still current (`true`/`false` when the current
 * source was compared, `null` when it was not). `derivePriorStatus` matches the
 * verdict exhaustively — that proves the CLOSED union total, but a wire
 * document can carry any string and `.exhaustive()` THROWS on an unknown tag, so
 * the verdict is parsed here first. A seed naming a carry-status token from an
 * earlier ledger row (`prior_confirmed_same_source`) is a named violation.
 */
export const priorRecordFactsSchema = z
  .strictObject({
    verdict: z.enum(PRIOR_RECORD_VERDICTS, expecting(`expected one of ${PRIOR_RECORD_VERDICTS.join(", ")}`)),
    sourceUnchanged: z.boolean(expecting("expected true, false or null")).nullable(),
  })
  .readonly();
export type PriorRecordFacts = z.output<typeof priorRecordFactsSchema>;

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
