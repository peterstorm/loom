import { createHash } from "node:crypto";
import {
  AGENT_REQUIRED_SKILLS,
  acceptedAgentResult,
  canonicalRecord,
  parseArtifactDigest,
  parseArtifactRef,
  parseEffectId,
  parseExactRoster,
  parseOrchestrationRunId,
  parseCompleteRoster,
  reconcileEffectReceipt,
  type AcceptedAgentResult,
  type AgentRequestAuthority,
  type ArtifactDigest,
  type AgentRosterSlot,
  type ArtifactRef,
  type CaptureRawTranscript,
  type CompleteRoster,
  type CompleteRosterError,
  type DomainResult,
  type ExactRoster,
  type NonEmpty,
  type OrchestrationRunId,
  type PublicationAuthorityResolver,
  type RawTranscriptCaptured,
  type RequestId,
  type SlotId,
  type SemanticPayloadParseError,
  type SpawnRequest,
} from "./orchestration-contract";
import {
  lowerModelProfile,
  parseLlmProfileId,
  resolveAgentPolicy,
  resolveModelProfile,
  type LlmProfileId,
  type LoomAgentName,
} from "./model-profiles";
import { attributeFindings, findingsUnionError, parseStoredFindings, type Finding, type RefutedFinding } from "./findings";
import { fail, isRecord, ok, sanitizeProse, type ParseResult } from "./panel-kernel";
import { resolveReviewFindings, type ParsedFindings } from "./review-output";
import { parseReviewPath, type ReviewPath } from "./review-packet";

export const STANDALONE_REVIEW_SCHEMA_VERSION = 1 as const;
export const STANDALONE_REVIEW_SUBJECT = "standalone-review" as const;

export const STANDALONE_REVIEWER_ROLES = Object.freeze([
  "code-reviewer",
  "silent-failure-hunter",
  "pr-test-analyzer",
  "type-design-analyzer",
  "comment-analyzer",
  "architecture-tech-lead",
  "code-simplifier",
] as const satisfies readonly LoomAgentName[]);
export type StandaloneReviewerRole = (typeof STANDALONE_REVIEWER_ROLES)[number];

export const STANDALONE_REVIEW_KINDS = Object.freeze([
  "code", "errors", "tests", "types", "comments", "architecture", "simplify", "all",
] as const);
export type StandaloneReviewKind = (typeof STANDALONE_REVIEW_KINDS)[number];

export interface StandaloneReviewMetadata {
  readonly requestedKinds: NonEmpty<StandaloneReviewKind>;
  readonly docsOnly: boolean;
  readonly sourceOrTestChanged: boolean;
  readonly typesChanged: boolean;
  readonly commentsChanged: boolean;
  readonly additions: number;
  readonly fileCount: number;
  readonly newStructure: boolean;
  readonly languages: readonly string[];
}

export interface StandaloneChangedPaths {
  /** Tracked files whose worktree content differs from HEAD, plus untracked non-ignored files. */
  readonly unstaged: readonly string[];
  readonly staged: readonly string[];
  readonly committed: readonly string[];
  readonly baseRevision: string | null;
  readonly headRevision: string;
}

export type StandaloneScopeSource = "explicit" | "changed-path-union";
export type StandaloneScopeSafety = Readonly<{
  path: ReviewPath;
  status: "safe" | "absent";
}>;

/** Complete immutable authority produced before any reviewer is spawnable. */
export interface FrozenStandaloneReviewAuthority {
  readonly schemaVersion: 1;
  readonly kind: "standalone-review-authority";
  readonly runId: OrchestrationRunId;
  readonly scopeSource: StandaloneScopeSource;
  readonly scope: NonEmpty<ReviewPath>;
  readonly scopeSafety: NonEmpty<StandaloneScopeSafety>;
  readonly changedPaths: StandaloneChangedPaths;
  readonly reviewMetadata: StandaloneReviewMetadata;
  readonly reviewers: NonEmpty<StandaloneReviewerRole>;
  readonly roster: ExactRoster<AgentRosterSlot>;
}

export interface PreparedStandaloneReview {
  readonly authority: FrozenStandaloneReviewAuthority;
  /** Initial requests only; attempt-2 requests remain frozen but unissued. */
  readonly initialRequests: NonEmpty<AgentRosterSlot["attempts"][0]>;
}

export type StandalonePreparationError = Readonly<{
  kind: "standalone-review-preparation-blocked";
  errors: NonEmpty<string>;
}>;

export interface PrepareStandaloneReviewInput {
  readonly runId: unknown;
  /** Undefined means derive exactly the canonical changed-path union. */
  readonly explicitScope?: unknown;
  readonly changedPaths: unknown;
  readonly reviewMetadata: unknown;
  readonly scopeSafety: unknown;
  readonly roster: unknown;
}

interface JsonRecord { readonly [key: string]: JsonValue }
type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonRecord;

const resultOk = <T, E = never>(value: T): DomainResult<T, E> => canonicalRecord({ ok: true, value });
const resultFail = <T = never, E = never>(error: E): DomainResult<T, E> => canonicalRecord({ ok: false, error });

export function exactKeys(raw: Record<string, unknown>, allowed: readonly string[], label: string): string[] {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key)).sort();
  const missing = allowed.filter((key) => !Object.hasOwn(raw, key));
  return [
    ...unknown.map((key) => `${label} contains unknown field '${key}'`),
    ...missing.map((key) => `${label}.${key} is required`),
  ];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function uniqueNonEmpty(values: readonly string[], label: string): readonly string[] {
  const errors: string[] = [];
  if (values.length === 0) errors.push(`${label} must be non-empty`);
  if (values.some((value) => value.trim() === "")) errors.push(`${label} must not contain empty values`);
  if (new Set(values).size !== values.length) errors.push(`${label} must be distinct`);
  return errors;
}

/** Parse and freeze the exact repository-relative scope before it becomes authority. */
export function parseStandaloneReviewScope(raw: unknown, label = "review scope"): ParseResult<NonEmpty<ReviewPath>> {
  if (!Array.isArray(raw)) return fail([`${label} must be a non-empty string array`]);
  const errors: string[] = [];
  const scope = raw.flatMap((entry, index): ReviewPath[] => {
    const parsed = parseReviewPath(entry, `${label}[${index}]`);
    if (!parsed.ok) {
      errors.push(...parsed.errors);
      return [];
    }
    return [parsed.value];
  });
  errors.push(...uniqueNonEmpty(scope, label));
  const [head, ...tail] = scope;
  return errors.length > 0 || head === undefined ? fail(errors) : ok(Object.freeze([head, ...tail]));
}

function parsePathList(raw: unknown, label: string, errors: string[]): readonly ReviewPath[] {
  if (!Array.isArray(raw)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  const paths: ReviewPath[] = [];
  raw.forEach((entry, index) => {
    const parsed = parseReviewPath(entry, `${label}[${index}]`);
    if (parsed.ok) paths.push(parsed.value);
    else errors.push(...parsed.errors);
  });
  if (new Set(paths).size !== paths.length) errors.push(`${label} must not contain duplicate paths`);
  return Object.freeze([...paths].sort(compareStrings));
}

function parseChangedPaths(raw: unknown): ParseResult<StandaloneChangedPaths> {
  if (!isRecord(raw)) return fail(["changed_paths must be an object"]);
  const errors = exactKeys(raw, ["unstaged", "staged", "committed", "base_revision", "head_revision"], "changed_paths");
  const unstaged = parsePathList(raw.unstaged, "changed_paths.unstaged", errors);
  const staged = parsePathList(raw.staged, "changed_paths.staged", errors);
  const committed = parsePathList(raw.committed, "changed_paths.committed", errors);
  const baseRevision = raw.base_revision === null ||
      (typeof raw.base_revision === "string" && raw.base_revision.trim() === raw.base_revision && raw.base_revision !== "")
    ? raw.base_revision as string | null
    : null;
  if (raw.base_revision !== null && baseRevision === null) {
    errors.push("changed_paths.base_revision must be null or a non-empty trimmed revision");
  }
  const headRevision = typeof raw.head_revision === "string" && raw.head_revision.trim() === raw.head_revision
    ? raw.head_revision
    : "";
  if (headRevision === "") errors.push("changed_paths.head_revision must be a non-empty trimmed revision");
  return errors.length > 0
    ? fail(errors)
    : ok(Object.freeze({ unstaged, staged, committed, baseRevision, headRevision }));
}

function parseStringSet(raw: unknown, label: string, errors: string[]): readonly string[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    errors.push(`${label} must be an array of non-empty strings`);
    return [];
  }
  const values = raw.map((entry) => (entry as string).trim());
  if (new Set(values).size !== values.length) errors.push(`${label} must be distinct`);
  return Object.freeze(values);
}

function parseReviewMetadata(raw: unknown): ParseResult<StandaloneReviewMetadata> {
  if (!isRecord(raw)) return fail(["review_metadata must be an object"]);
  const keys = [
    "requested_kinds", "docs_only", "source_or_test_changed", "types_changed", "comments_changed",
    "additions", "file_count", "new_structure", "languages",
  ] as const;
  const errors = exactKeys(raw, keys, "review_metadata");
  const requested = parseStringSet(raw.requested_kinds, "review_metadata.requested_kinds", errors);
  const requestedKinds = requested.filter((kind): kind is StandaloneReviewKind =>
    (STANDALONE_REVIEW_KINDS as readonly string[]).includes(kind));
  if (requestedKinds.length !== requested.length) errors.push("review_metadata.requested_kinds contains an unknown review kind");
  const bool = (key: typeof keys[number]): boolean => {
    if (typeof raw[key] !== "boolean") errors.push(`review_metadata.${key} must be boolean`);
    return raw[key] === true;
  };
  const integer = (key: "additions" | "file_count"): number => {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      errors.push(`review_metadata.${key} must be a non-negative safe integer`);
      return 0;
    }
    return value;
  };
  const languages = parseStringSet(raw.languages, "review_metadata.languages", errors);
  const docsOnly = bool("docs_only");
  const sourceOrTestChanged = bool("source_or_test_changed");
  const typesChanged = bool("types_changed");
  const commentsChanged = bool("comments_changed");
  // A docs-only scope always changes comments — comment analysis is the only
  // role that reads docs, so the producer's invariant (`metadata` in
  // handlers/helpers/programs/helpers.ts: commentsChanged = docsOnly || scope
  // has .md/.mdx) must hold at the boundary too. Without it, a contradictory
  // persisted record silently drops comment-analyzer from a docs-only review.
  if (docsOnly && !commentsChanged) {
    errors.push("review_metadata.comments_changed must be true when docs_only is true (a docs-only scope always changes comments)");
  }
  // The producer's OTHER docs-only invariant, and the more dangerous one to
  // leave unproven. `docs_only` is by definition "no source or test file
  // changed", so the pair is mutually exclusive — yet only the comments half
  // was checked, leaving `docs_only && source_or_test_changed` representable.
  // `selectStandaloneReviewers` reads exactly those two fields independently:
  // such a record claims real source changed AND silently drops
  // silent-failure-hunter (gated on `!docsOnly`) while admitting
  // pr-test-analyzer (gated on `sourceOrTestChanged`) — a scope reviewed by a
  // roster no policy would ever select.
  if (docsOnly && sourceOrTestChanged) {
    errors.push("review_metadata.source_or_test_changed must be false when docs_only is true (a docs-only scope changes no source or test file)");
  }
  const additions = integer("additions");
  const fileCount = integer("file_count");
  const newStructure = bool("new_structure");
  const [firstKind, ...otherKinds] = requestedKinds;
  if (firstKind === undefined) errors.push("review_metadata.requested_kinds must be non-empty");
  const nonEmptyKinds = firstKind === undefined
    ? null
    : Object.freeze([firstKind, ...otherKinds]) as NonEmpty<StandaloneReviewKind>;
  return errors.length > 0 || nonEmptyKinds === null
    ? fail(errors)
    : ok(Object.freeze({
        requestedKinds: nonEmptyKinds,
        docsOnly,
        sourceOrTestChanged,
        typesChanged,
        commentsChanged,
        additions,
        fileCount,
        newStructure,
        languages,
      }));
}

/** Deterministic reviewer selection. The result order is canonical spawn order. */
export function selectStandaloneReviewers(metadata: StandaloneReviewMetadata): NonEmpty<StandaloneReviewerRole> {
  const kinds = new Set(metadata.requestedKinds);
  const all = kinds.has("all");
  const selected: StandaloneReviewerRole[] = ["code-reviewer"];
  if (!metadata.docsOnly && (all || kinds.has("code") || kinds.has("errors"))) selected.push("silent-failure-hunter");
  if (metadata.sourceOrTestChanged && (all || kinds.has("code") || kinds.has("tests") || kinds.has("errors"))) {
    selected.push("pr-test-analyzer");
  }
  if (metadata.typesChanged && (all || kinds.has("code") || kinds.has("types"))) selected.push("type-design-analyzer");
  if (metadata.commentsChanged && (all || kinds.has("comments") || metadata.docsOnly)) selected.push("comment-analyzer");
  if (kinds.has("architecture") || all || metadata.additions > 500 || metadata.fileCount > 10 || metadata.newStructure) {
    selected.push("architecture-tech-lead");
  }
  // Explicit `simplify` always selects the simplifier; under `all` it joins the
  // roster only when source or tests actually changed — a docs-only or
  // metadata-only scope has nothing for the distill catalog to act on.
  if (kinds.has("simplify") || (all && metadata.sourceOrTestChanged)) selected.push("code-simplifier");
  return Object.freeze(selected) as NonEmpty<StandaloneReviewerRole>;
}

function parseScopeSafety(raw: unknown, scope: readonly string[]): ParseResult<NonEmpty<StandaloneScopeSafety>> {
  if (!Array.isArray(raw)) return fail(["scope_safety must be an array"]);
  const errors: string[] = [];
  const entries: StandaloneScopeSafety[] = [];
  raw.forEach((entry, index) => {
    const label = `scope_safety[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    errors.push(...exactKeys(entry, ["path", "status"], label));
    const path = parseReviewPath(entry.path, `${label}.path`);
    if (!path.ok) errors.push(...path.errors);
    if (entry.status !== "safe" && entry.status !== "absent") {
      errors.push(`${label}.status must be 'safe' or 'absent'; symlink or redirected scope is unsafe`);
    }
    if (path.ok && (entry.status === "safe" || entry.status === "absent")) {
      entries.push(Object.freeze({ path: path.value, status: entry.status }));
    }
  });
  const observed = entries.map(({ path }) => path);
  if (new Set(observed).size !== observed.length) errors.push("scope_safety paths must be distinct");
  if (observed.length !== scope.length || observed.some((path, index) => path !== scope[index])) {
    errors.push("scope_safety must cover the exact frozen scope in order");
  }
  const [head, ...tail] = entries;
  return errors.length > 0 || head === undefined ? fail(errors) : ok(Object.freeze([head, ...tail]));
}

function preparationFailure(errors: readonly string[]): DomainResult<never, StandalonePreparationError> {
  const [head, ...tail] = errors.length > 0 ? errors : ["standalone review preparation failed"];
  return resultFail(canonicalRecord({
    kind: "standalone-review-preparation-blocked",
    errors: Object.freeze([head!, ...tail]) as NonEmpty<string>,
  }));
}

/**
 * Parse-don't-validate preparation. Every scope, Git, reviewer, model, context,
 * request, attempt, and immutable transcript-slot fact is frozen in one value.
 */
export function prepareStandaloneReview(
  input: PrepareStandaloneReviewInput,
): DomainResult<PreparedStandaloneReview, StandalonePreparationError> {
  const runId = parseOrchestrationRunId(input.runId);
  const changed = parseChangedPaths(input.changedPaths);
  const metadata = parseReviewMetadata(input.reviewMetadata);
  const roster = parseExactRoster(input.roster);
  const errors: string[] = [];
  if (!runId.ok) errors.push(runId.error.message);
  if (!changed.ok) errors.push(...changed.errors);
  if (!metadata.ok) errors.push(...metadata.errors);
  if (!roster.ok) errors.push(...roster.error.violations.map((violation) => `roster: ${violation.kind}`));

  let scopeSource: StandaloneScopeSource = "explicit";
  let scopeResult: ParseResult<NonEmpty<ReviewPath>>;
  if (input.explicitScope === undefined) {
    scopeSource = "changed-path-union";
    if (!changed.ok) {
      scopeResult = fail(["cannot derive review scope from malformed changed-path metadata"]);
    } else {
      const union = [...new Set([
        ...changed.value.unstaged,
        ...changed.value.staged,
        ...changed.value.committed,
      ])].sort(compareStrings);
      scopeResult = parseStandaloneReviewScope(union, "canonical changed-path union");
    }
  } else {
    scopeResult = parseStandaloneReviewScope(input.explicitScope, "explicit review scope");
  }
  if (!scopeResult.ok) errors.push(...scopeResult.errors);
  const safety: ParseResult<NonEmpty<StandaloneScopeSafety>> = scopeResult.ok
    ? parseScopeSafety(input.scopeSafety, scopeResult.value)
    : fail(["scope safety cannot be proved without a valid scope"]);
  if (!safety.ok) errors.push(...safety.errors);

  if (runId.ok && roster.ok) {
    if (roster.value.runId !== runId.value) errors.push("roster run authority does not match the standalone run");
    if (roster.value.program !== "standalone-review") errors.push("roster program must be 'standalone-review'");
  }
  let selected: NonEmpty<StandaloneReviewerRole> | null = null;
  if (metadata.ok) selected = selectStandaloneReviewers(metadata.value);
  if (selected !== null && roster.ok) {
    const roles = roster.value.orderedSlots.map((slot) => slot.attempts[0].role);
    if (roles.length !== selected.length || roles.some((role, index) => role !== selected![index])) {
      errors.push("roster roles must exactly match the deterministic reviewer selection in canonical order");
    }
  }

  if (!runId.ok || !changed.ok || !metadata.ok || !roster.ok || !scopeResult.ok || !safety.ok || selected === null || errors.length > 0) {
    return preparationFailure(errors);
  }

  const authority = Object.freeze({
    schemaVersion: 1 as const,
    kind: "standalone-review-authority" as const,
    runId: runId.value,
    scopeSource,
    scope: scopeResult.value,
    scopeSafety: safety.value,
    changedPaths: changed.value,
    reviewMetadata: metadata.value,
    reviewers: selected,
    roster: roster.value,
  });
  const [firstSlot, ...otherSlots] = authority.roster.orderedSlots;
  const initialRequests = Object.freeze([
    firstSlot.attempts[0],
    ...otherSlots.map((slot) => slot.attempts[0]),
  ]) as NonEmpty<AgentRosterSlot["attempts"][0]>;
  const prepared: PreparedStandaloneReview = Object.freeze({ authority, initialRequests });
  return resultOk(prepared);
}

export interface FreshStandaloneReviewerContexts {
  /** Attempt contexts in semantic-attempt order; roles and destinations are derived internally. */
  readonly attempts: readonly [unknown, unknown];
}

export interface PrepareFreshStandaloneReviewInput
  extends Omit<PrepareStandaloneReviewInput, "roster"> {
  readonly reviewerContexts: readonly FreshStandaloneReviewerContexts[];
}

/**
 * Construct a fresh standalone run without accepting caller-authored role,
 * model, request, slot, or destination attribution. The shell supplies only a
 * fresh run identity and the already-computed immutable context digests.
 */
export function prepareFreshStandaloneReview(
  input: PrepareFreshStandaloneReviewInput,
): DomainResult<PreparedStandaloneReview, StandalonePreparationError> {
  const runId = parseOrchestrationRunId(input.runId);
  const metadata = parseReviewMetadata(input.reviewMetadata);
  if (!runId.ok || !metadata.ok) {
    return preparationFailure([
      ...(runId.ok ? [] : [runId.error.message]),
      ...(metadata.ok ? [] : metadata.errors),
    ]);
  }
  const reviewers = selectStandaloneReviewers(metadata.value);
  if (!Array.isArray(input.reviewerContexts) || input.reviewerContexts.length !== reviewers.length) {
    return preparationFailure([
      `reviewerContexts must contain exactly ${reviewers.length} entries in deterministic reviewer order`,
    ]);
  }

  const authorityErrors: string[] = [];
  const roster = reviewers.map((role, index) => {
    const policy = resolveAgentPolicy(role);
    if (!policy.ok) {
      authorityErrors.push(`${role}: policy resolution failed: ${policy.error.message}`);
      return null;
    }
    const profile = resolveModelProfile(policy.value.profile);
    if (!profile.ok) {
      authorityErrors.push(`${role}: model profile '${policy.value.profile}' failed: ${profile.error.message}`);
      return null;
    }
    const contexts = input.reviewerContexts[index];
    if (contexts === undefined || !Array.isArray(contexts.attempts) || contexts.attempts.length !== 2) {
      authorityErrors.push(`${role}: exactly two immutable attempt context digests are required`);
      return null;
    }
    const slotId = `standalone-slot:${index + 1}:${role}`;
    return {
      slotId,
      attempts: ([1, 2] as const).map((attempt, attemptIndex) => ({
        runId: runId.value,
        requestId: `request:${createHash("sha256")
          .update(`${runId.value}\u0000${role}\u0000${attempt}`)
          .digest("hex")}`,
        slotId,
        program: "standalone-review",
        role,
        attempt,
        modelProfile: policy.value.profile,
        harnessBinding: {
          pi: lowerModelProfile(profile.value, "pi"),
          claude: lowerModelProfile(profile.value, "claude-code"),
        },
        requiredSkill: AGENT_REQUIRED_SKILLS[role],
        contextDigest: contexts.attempts[attemptIndex],
        outputSlot: `transcripts/${slotId}/attempt-${attempt}.raw`,
      })),
    };
  });
  if (roster.some((slot) => slot === null)) {
    return preparationFailure(authorityErrors.length > 0
      ? authorityErrors
      : ["cannot resolve deterministic reviewer model/context authority"]);
  }
  return prepareStandaloneReview({
    ...input,
    roster,
  });
}

export function serializeStandaloneReviewAuthority(authority: FrozenStandaloneReviewAuthority): string {
  return JSON.stringify({
    schema_version: authority.schemaVersion,
    kind: authority.kind,
    run_id: authority.runId,
    scope_source: authority.scopeSource,
    scope: authority.scope,
    scope_safety: authority.scopeSafety,
    changed_paths: {
      unstaged: authority.changedPaths.unstaged,
      staged: authority.changedPaths.staged,
      committed: authority.changedPaths.committed,
      base_revision: authority.changedPaths.baseRevision,
      head_revision: authority.changedPaths.headRevision,
    },
    review_metadata: {
      requested_kinds: authority.reviewMetadata.requestedKinds,
      docs_only: authority.reviewMetadata.docsOnly,
      source_or_test_changed: authority.reviewMetadata.sourceOrTestChanged,
      types_changed: authority.reviewMetadata.typesChanged,
      comments_changed: authority.reviewMetadata.commentsChanged,
      additions: authority.reviewMetadata.additions,
      file_count: authority.reviewMetadata.fileCount,
      new_structure: authority.reviewMetadata.newStructure,
      languages: authority.reviewMetadata.languages,
    },
    reviewers: authority.reviewers,
    roster: authority.roster.orderedSlots,
  }, null, 2);
}

export function parseStandaloneReviewAuthority(raw: unknown): ParseResult<FrozenStandaloneReviewAuthority> {
  if (!isRecord(raw)) return fail(["standalone review authority must be an object"]);
  const allowed = [
    "schema_version", "kind", "run_id", "scope_source", "scope", "scope_safety",
    "changed_paths", "review_metadata", "reviewers", "roster",
  ] as const;
  const errors = exactKeys(raw, allowed, "standalone review authority");
  if (raw.schema_version !== 1) errors.push("standalone review authority.schema_version must be 1");
  if (raw.kind !== "standalone-review-authority") errors.push("standalone review authority.kind is invalid");
  if (raw.scope_source !== "explicit" && raw.scope_source !== "changed-path-union") {
    errors.push("standalone review authority.scope_source is invalid");
  }
  const prepared = prepareStandaloneReview({
    runId: raw.run_id,
    ...(raw.scope_source === "explicit" ? { explicitScope: raw.scope } : {}),
    changedPaths: raw.changed_paths,
    reviewMetadata: raw.review_metadata,
    scopeSafety: raw.scope_safety,
    roster: raw.roster,
  });
  if (!prepared.ok) errors.push(...prepared.error.errors);
  if (prepared.ok) {
    if (raw.scope_source !== prepared.value.authority.scopeSource ||
        JSON.stringify(raw.scope) !== JSON.stringify(prepared.value.authority.scope)) {
      errors.push("standalone review authority scope does not match its declared source");
    }
    if (JSON.stringify(raw.reviewers) !== JSON.stringify(prepared.value.authority.reviewers)) {
      errors.push("standalone review authority reviewers do not match deterministic selection");
    }
  }
  return errors.length > 0 || !prepared.ok ? fail(errors) : ok(prepared.value.authority);
}

export interface RawReviewerBytes {
  readonly encoding: "base64";
  readonly data: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface CapturedReviewerResult {
  readonly schemaVersion: 1;
  readonly kind: "captured-reviewer-result";
  readonly artifact: ArtifactRef;
  /** Canonical byte representation; invalid UTF-8 is never replacement-decoded. */
  readonly rawBytes: RawReviewerBytes;
}

export interface StandaloneReviewerEvidence {
  readonly authorityKind: "request-bound" | "legacy-slot-bound";
  readonly agent: StandaloneReviewerRole;
  readonly slotId: string;
  readonly requestId: string;
  readonly attempt: 1 | 2;
  readonly modelProfile: LlmProfileId | null;
  readonly contextDigest: string | null;
  readonly artifact: ArtifactRef;
}

function parseReviewerBytes(raw: unknown): DomainResult<Uint8Array, SemanticPayloadParseError> {
  if (raw instanceof Uint8Array) {
    return raw.byteLength === 0
      ? resultFail({ message: "captured reviewer bytes must be non-empty" })
      : resultOk(Uint8Array.from(raw));
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((byte) =>
    typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    return resultFail({ message: "captured reviewer bytes must be a non-empty byte array" });
  }
  return resultOk(Uint8Array.from(raw as readonly number[]));
}

function canonicalRawReviewerBytes(bytes: Uint8Array): RawReviewerBytes {
  return canonicalRecord({
    encoding: "base64" as const,
    data: Buffer.from(bytes).toString("base64"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function parseRawReviewerBytes(raw: unknown): DomainResult<RawReviewerBytes, SemanticPayloadParseError> {
  if (!isRecord(raw)) return resultFail({ message: "captured reviewer rawBytes must be an object" });
  const errors = exactKeys(raw, ["encoding", "data", "byteLength", "sha256"], "captured reviewer rawBytes");
  if (errors.length > 0 || raw.encoding !== "base64" || typeof raw.data !== "string" ||
      typeof raw.byteLength !== "number" || !Number.isSafeInteger(raw.byteLength) || raw.byteLength <= 0 ||
      typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) {
    return resultFail({ message: errors.join("; ") || "captured reviewer rawBytes metadata is invalid" });
  }
  const bytes = Buffer.from(raw.data, "base64");
  if (bytes.toString("base64") !== raw.data) return resultFail({ message: "captured reviewer rawBytes data is not canonical base64" });
  const canonical = canonicalRawReviewerBytes(bytes);
  if (canonical.byteLength !== raw.byteLength || canonical.sha256 !== raw.sha256) {
    return resultFail({ message: "captured reviewer rawBytes metadata does not match its exact decoded bytes" });
  }
  return resultOk(canonical);
}

export function capturedReviewerResultFromBytes(
  rawArtifact: unknown,
  rawBytes: unknown,
): DomainResult<CapturedReviewerResult, SemanticPayloadParseError> {
  const artifact = parseArtifactRef(rawArtifact);
  if (!artifact.ok) return resultFail({ message: `captured reviewer artifact is invalid: ${artifact.error.message}` });
  const bytes = parseReviewerBytes(rawBytes);
  if (!bytes.ok) return bytes;
  const encoded = canonicalRawReviewerBytes(bytes.value);
  if (artifact.value.byteLength !== encoded.byteLength) {
    return resultFail({ message: "captured reviewer artifact byteLength does not match exact raw bytes" });
  }
  if (artifact.value.digest !== encoded.sha256) {
    return resultFail({ message: "captured reviewer artifact digest does not match exact raw bytes" });
  }
  return resultOk(canonicalRecord({
    schemaVersion: 1,
    kind: "captured-reviewer-result",
    artifact: artifact.value,
    rawBytes: encoded,
  }));
}

export function capturedReviewerResultFromText(
  rawArtifact: unknown,
  rawOutput: unknown,
): DomainResult<CapturedReviewerResult, SemanticPayloadParseError> {
  return typeof rawOutput === "string" && rawOutput.length > 0
    ? capturedReviewerResultFromBytes(rawArtifact, Buffer.from(rawOutput, "utf-8"))
    : resultFail({ message: "captured reviewer rawOutput must be a non-empty string" });
}

/** Payload parser supplied directly to T1's parseCompleteRoster. */
export function parseCapturedReviewerResult(raw: unknown): DomainResult<CapturedReviewerResult, SemanticPayloadParseError> {
  if (!isRecord(raw)) return resultFail({ message: "captured reviewer result must be an object" });
  const errors = exactKeys(raw, ["schemaVersion", "kind", "artifact", "rawBytes"], "captured reviewer result");
  if (errors.length > 0) return resultFail({ message: errors.join("; ") });
  if (raw.schemaVersion !== 1 || raw.kind !== "captured-reviewer-result") {
    return resultFail({ message: "captured reviewer result schemaVersion or kind is invalid" });
  }
  const encoded = parseRawReviewerBytes(raw.rawBytes);
  if (!encoded.ok) return encoded;
  return capturedReviewerResultFromBytes(raw.artifact, Buffer.from(encoded.value.data, "base64"));
}

export function decodeCapturedReviewerText(captured: CapturedReviewerResult): DomainResult<string, SemanticPayloadParseError> {
  try {
    return resultOk(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(captured.rawBytes.data, "base64")));
  } catch {
    return resultFail({ message: "captured reviewer bytes are not valid UTF-8 semantic output" });
  }
}

/** Stable identity retained by LC-2 when a sibling result is accepted early. */
export function fingerprintCapturedReviewerResult(result: CapturedReviewerResult): string {
  return createHash("sha256").update(JSON.stringify({
    runId: result.artifact.runId,
    slot: result.artifact.slot.path,
    digest: result.artifact.digest,
    byteLength: result.artifact.byteLength,
    rawBytes: result.rawBytes,
  })).digest("hex");
}

declare class StandaloneRosterCompletionMembership {
  private readonly standaloneRosterCompletionMembership: true;
}

export type ProvenStandaloneRosterEntry = Readonly<{
  slotId: SlotId;
  requestId: RequestId;
  attempt: 1 | 2;
  payloadFingerprint: string;
}>;

/**
 * T4 completion authority. A structural T1 CompleteRoster is deliberately not
 * sufficient: this proof exists only after T1 reparses the raw result set
 * against this frozen standalone roster and an independent publication
 * registration resolver.
 */
export type StandaloneRosterCompletionProof = StandaloneRosterCompletionMembership & Readonly<{
  schemaVersion: 1;
  kind: "standalone-roster-completion-proof";
  runId: OrchestrationRunId;
  rosterDigest: ArtifactDigest;
  accepted: NonEmpty<ProvenStandaloneRosterEntry>;
  /** Durable parser input retained so publication authority can be re-proved after restart. */
  results: NonEmpty<AcceptedAgentResult<CapturedReviewerResult>>;
}>;

const standaloneRosterCompletionCache = new WeakMap<object, Readonly<{
  authorityRoster: ExactRoster<AgentRosterSlot>;
  roster: CompleteRoster<AcceptedAgentResult<CapturedReviewerResult>>;
}>>();

/** The sole T4 constructor for roster-completion authority. */
export function proveStandaloneRosterCompletion(
  authority: FrozenStandaloneReviewAuthority,
  resolver: PublicationAuthorityResolver,
  rawResults: unknown,
): DomainResult<StandaloneRosterCompletionProof, CompleteRosterError> {
  const reparsed = parseCompleteRoster(
    resolver,
    authority.roster,
    rawResults,
    parseCapturedReviewerResult,
  );
  if (!reparsed.ok) return reparsed;
  const [firstResult, ...otherResults] = reparsed.value.ordered;
  const toEntry = (result: AcceptedAgentResult<CapturedReviewerResult>): ProvenStandaloneRosterEntry => Object.freeze({
    slotId: result.authority.slotId,
    requestId: result.authority.requestId,
    attempt: result.authority.attempt,
    payloadFingerprint: fingerprintCapturedReviewerResult(result.value),
  });
  const accepted = Object.freeze([
    toEntry(firstResult),
    ...otherResults.map(toEntry),
  ]) as NonEmpty<ProvenStandaloneRosterEntry>;
  const rosterDigest = canonicalDigest(accepted);
  const proof = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "standalone-roster-completion-proof" as const,
    runId: authority.runId,
    rosterDigest,
    accepted,
    results: Object.freeze([firstResult, ...otherResults]) as NonEmpty<AcceptedAgentResult<CapturedReviewerResult>>,
  }) as StandaloneRosterCompletionProof;
  standaloneRosterCompletionCache.set(proof, canonicalRecord({
    authorityRoster: authority.roster,
    roster: reparsed.value,
  }));
  return resultOk(proof);
}

/**
 * Rehydrate roster authority from persisted JSON. The resolver must verify the
 * immutable batch publication receipt/artifact for every retained request.
 */
export function parseStandaloneRosterCompletionProof(
  authority: FrozenStandaloneReviewAuthority,
  resolver: PublicationAuthorityResolver,
  raw: unknown,
): DomainResult<StandaloneRosterCompletionProof, CompleteRosterError> {
  const malformedPersistedCompletion = (message: string): DomainResult<never, CompleteRosterError> =>
    resultFail(canonicalRecord({
      kind: "incomplete-or-invalid-roster" as const,
      violations: Object.freeze([canonicalRecord({
        kind: "malformed-result-boundary" as const,
        field: null,
        index: null,
        reason: "unsafe-inspection" as const,
        message,
      })]) as CompleteRosterError["violations"],
    }));
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.kind !== "standalone-roster-completion-proof" ||
      raw.runId !== authority.runId || !Array.isArray(raw.results)) {
    return malformedPersistedCompletion(
      "persisted standalone roster completion must contain the canonical schema, run authority, and durable result roster",
    );
  }
  const reproved = proveStandaloneRosterCompletion(authority, resolver, raw.results);
  if (!reproved.ok) return reproved;
  if (raw.rosterDigest !== reproved.value.rosterDigest ||
      JSON.stringify(raw.accepted) !== JSON.stringify(reproved.value.accepted)) {
    return malformedPersistedCompletion(
      "persisted standalone roster completion digest or accepted-slot projection disagrees with the re-proved result roster",
    );
  }
  return reproved;
}

function resolveStandaloneRosterCompletion(
  authority: FrozenStandaloneReviewAuthority,
  proof: StandaloneRosterCompletionProof,
): DomainResult<CompleteRoster<AcceptedAgentResult<CapturedReviewerResult>>, SemanticPayloadParseError> {
  const cached = typeof proof === "object" && proof !== null
    ? standaloneRosterCompletionCache.get(proof)
    : undefined;
  if (cached === undefined || cached.authorityRoster !== authority.roster || proof.runId !== authority.runId ||
      proof.rosterDigest !== canonicalDigest(proof.accepted) || !Array.isArray(proof.results)) {
    return resultFail({ message: "standalone aggregation requires the exact opaque roster-completion proof minted for this frozen authority" });
  }
  return resultOk(cached.roster);
}

export type StandaloneCaptureError = Readonly<{
  kind: "standalone-capture-rejected";
  message: string;
}>;

export interface StandaloneCaptureAuthority {
  readonly schemaVersion: 1;
  readonly kind: "standalone-capture-authority";
  readonly authority: FrozenStandaloneReviewAuthority;
  readonly issuedRequests: readonly SpawnRequest[];
}

/** T11 implements this port from durable reservation/publication receipts. */
export type StandaloneIssuedRequestAuthorityResolver = (
  request: SpawnRequest,
) => DomainResult<SpawnRequest, StandaloneCaptureError>;

export interface PreparedStandaloneReviewerCapture {
  readonly kind: "prepared-standalone-reviewer-capture";
  readonly request: AgentRequestAuthority;
  readonly issuedRequest: SpawnRequest;
  readonly intent: CaptureRawTranscript;
  readonly expectedArtifact: ArtifactRef;
  readonly rawBytes: RawReviewerBytes;
}

const standaloneCaptureAuthorityCache = new WeakSet<object>();
const preparedStandaloneCaptureCache = new WeakSet<object>();
const captureFailure = (message: string): DomainResult<never, StandaloneCaptureError> =>
  resultFail(canonicalRecord({ kind: "standalone-capture-rejected", message }));

function sameCaptureRequest(actual: AgentRequestAuthority, expected: AgentRequestAuthority): boolean {
  return actual.runId === expected.runId && actual.requestId === expected.requestId &&
    actual.slotId === expected.slotId && actual.program === expected.program && actual.role === expected.role &&
    actual.attempt === expected.attempt && actual.modelProfile === expected.modelProfile &&
    actual.requiredSkill === expected.requiredSkill && actual.contextDigest === expected.contextDigest &&
    actual.outputSlot.path === expected.outputSlot.path &&
    JSON.stringify(actual.harnessBinding) === JSON.stringify(expected.harnessBinding);
}

/** Bind only T1-issued requests to the frozen standalone authority. */
export function bindStandaloneCaptureAuthority(
  authority: FrozenStandaloneReviewAuthority,
  issuedRequests: readonly SpawnRequest[],
): DomainResult<StandaloneCaptureAuthority, StandaloneCaptureError> {
  if (!Array.isArray(issuedRequests) || issuedRequests.length === 0) return captureFailure("issued request set must be non-empty");
  const seenRequests = new Set<string>();
  const seenSlots = new Set<string>();
  const canonical: SpawnRequest[] = [];
  for (const request of issuedRequests) {
    const issuance = acceptedAgentResult(request, null);
    if (!issuance.ok) return captureFailure(issuance.error.message);
    const slot = authority.roster.byId.get(request.authority.slotId);
    const expected = request.authority.attempt === 1 ? slot?.attempts[0] : slot?.attempts[1];
    if (expected === undefined || !sameCaptureRequest(request.authority, expected) || request.authority.runId !== authority.runId) {
      return captureFailure("issued request does not match frozen standalone run/agent/request/context/model/output authority");
    }
    if (seenRequests.has(request.authority.requestId) || seenSlots.has(request.authority.slotId)) {
      return captureFailure("issued request set contains duplicate request or semantic slot authority");
    }
    seenRequests.add(request.authority.requestId);
    seenSlots.add(request.authority.slotId);
    canonical.push(request);
  }
  const bound = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "standalone-capture-authority" as const,
    authority,
    issuedRequests: Object.freeze(canonical),
  });
  standaloneCaptureAuthorityCache.add(bound);
  return resultOk(bound);
}

/** Rebuild request-bound capture authority only after durable issuance proof. */
export function parseStandaloneCaptureAuthority(
  authority: FrozenStandaloneReviewAuthority,
  rawIssuedRequests: unknown,
  resolveIssuedRequest: StandaloneIssuedRequestAuthorityResolver,
): DomainResult<StandaloneCaptureAuthority, StandaloneCaptureError> {
  if (!Array.isArray(rawIssuedRequests) || rawIssuedRequests.length === 0) {
    return captureFailure("persisted issued request set must be non-empty");
  }
  const parsedRequests: SpawnRequest[] = [];
  for (const rawRequest of rawIssuedRequests) {
    if (!isRecord(rawRequest)) return captureFailure("persisted issued request is malformed");
    const proof = resolveIssuedRequest(rawRequest as unknown as SpawnRequest);
    if (!proof.ok) return proof;
    if (JSON.stringify(proof.value) !== JSON.stringify(rawRequest)) {
      return captureFailure("persisted issued request differs from durable issuance authority");
    }
    parsedRequests.push(proof.value);
  }
  return bindStandaloneCaptureAuthority(authority, parsedRequests);
}

/**
 * Request-bound direct capture boundary. Harnesses submit only the issued
 * request identity and exact bytes; all attribution and destination facts are
 * resolved from internal authority before an effect can be emitted.
 */
export function captureStandaloneReviewerBytes(
  captureAuthority: StandaloneCaptureAuthority,
  requestIdentity: unknown,
  rawBytes: unknown,
): DomainResult<PreparedStandaloneReviewerCapture, StandaloneCaptureError> {
  if (typeof captureAuthority !== "object" || captureAuthority === null || !standaloneCaptureAuthorityCache.has(captureAuthority)) {
    return captureFailure("capture requires parser-bound issued standalone request authority");
  }
  const request = captureAuthority.issuedRequests.find(({ authority }) => authority.requestId === requestIdentity);
  if (request === undefined) return captureFailure("request identity is missing, stale, foreign, or was not issued for this capture authority");
  const bytes = parseReviewerBytes(rawBytes);
  if (!bytes.ok) return captureFailure(bytes.error.message);
  const encoded = canonicalRawReviewerBytes(bytes.value);
  const artifact = parseArtifactRef({
    runId: request.authority.runId,
    slot: request.authority.outputSlot,
    digest: encoded.sha256,
    byteLength: encoded.byteLength,
  });
  const effectId = parseEffectId(`effect:capture:${createHash("sha256").update(request.authority.requestId).digest("hex")}`);
  if (!artifact.ok) return captureFailure(artifact.error.message);
  if (!effectId.ok) return captureFailure(effectId.error.message);
  const prepared = canonicalRecord({
    kind: "prepared-standalone-reviewer-capture" as const,
    request: request.authority,
    issuedRequest: request,
    intent: canonicalRecord({
      kind: "capture-raw-transcript" as const,
      effectId: effectId.value,
      runId: request.authority.runId,
      request: request.authority,
      bytes: Object.freeze([...bytes.value]),
    }),
    expectedArtifact: artifact.value,
    rawBytes: encoded,
  });
  preparedStandaloneCaptureCache.add(prepared);
  return resultOk(prepared);
}

/** Rehydrate a prepared capture by re-deriving its byte identity and destination. */
export function parsePreparedStandaloneReviewerCapture(
  captureAuthority: StandaloneCaptureAuthority,
  raw: unknown,
): DomainResult<PreparedStandaloneReviewerCapture, StandaloneCaptureError> {
  if (!isRecord(raw) || raw.kind !== "prepared-standalone-reviewer-capture" ||
      !isRecord(raw.request) || typeof raw.request.requestId !== "string" || !isRecord(raw.rawBytes)) {
    return captureFailure("persisted prepared standalone capture is malformed");
  }
  const encoded = parseRawReviewerBytes(raw.rawBytes);
  if (!encoded.ok) return captureFailure(encoded.error.message);
  const rebuilt = captureStandaloneReviewerBytes(
    captureAuthority,
    raw.request.requestId,
    Buffer.from(encoded.value.data, "base64"),
  );
  if (!rebuilt.ok) return rebuilt;
  if (JSON.stringify(rebuilt.value.intent) !== JSON.stringify(raw.intent) ||
      JSON.stringify(rebuilt.value.expectedArtifact) !== JSON.stringify(raw.expectedArtifact)) {
    return captureFailure("persisted prepared capture intent or artifact destination was changed");
  }
  return rebuilt;
}

/** Complete capture only from T1's typed receipt reconciliation. */
export function completeStandaloneReviewerCapture(
  prepared: PreparedStandaloneReviewerCapture,
  rawReceipt: unknown,
): DomainResult<AcceptedAgentResult<CapturedReviewerResult>, StandaloneCaptureError> {
  if (typeof prepared !== "object" || prepared === null || !preparedStandaloneCaptureCache.has(prepared)) {
    return captureFailure("capture completion requires the exact prepared request/byte authority");
  }
  const reconciled = reconcileEffectReceipt(prepared.intent, rawReceipt);
  if (!reconciled.ok || reconciled.value.kind !== "raw-transcript-captured") {
    return captureFailure(reconciled.ok ? "capture receipt has the wrong effect kind" : reconciled.error.message);
  }
  const receipt: RawTranscriptCaptured = reconciled.value;
  const captured = capturedReviewerResultFromBytes(receipt.artifact, Buffer.from(prepared.rawBytes.data, "base64"));
  if (!captured.ok) return captureFailure(captured.error.message);
  const accepted = acceptedAgentResult(prepared.issuedRequest, captured.value);
  return accepted.ok ? resultOk(accepted.value) : captureFailure(accepted.error.message);
}

export interface StandaloneReviewAggregate {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly subjectId: typeof STANDALONE_REVIEW_SUBJECT;
  readonly scope: readonly string[];
  readonly reviewerEvidence: readonly StandaloneReviewerEvidence[];
  readonly findings: readonly Finding[];
}

export type StandaloneReviewState =
  | Readonly<{ kind: "clean"; aggregate: StandaloneReviewAggregate }>
  | Readonly<{ kind: "requires-refutation"; aggregate: StandaloneReviewAggregate; criticals: NonEmpty<Finding> }>;

export interface PanelRefutation { readonly lens: string; readonly reason: string }
interface ParsedPanelOutcomeBase {
  readonly findingId: string;
  readonly claim: string;
  readonly upheldBy: readonly string[];
  readonly uncertainFrom: readonly string[];
}
export type ParsedPanelOutcome =
  | Readonly<ParsedPanelOutcomeBase & { survives: true; refutations: readonly PanelRefutation[] }>
  | Readonly<ParsedPanelOutcomeBase & { survives: false; refutations: NonEmpty<PanelRefutation> }>;
export interface ParsedPanelOutcomes {
  readonly lenses: readonly string[];
  readonly threshold: number;
  readonly outcomes: readonly ParsedPanelOutcome[];
}

/** Canonical defensive copy used at every panel/finalization boundary. */
export function canonicalStandalonePanelOutcomes(panel: ParsedPanelOutcomes): ParseResult<ParsedPanelOutcomes> {
  const errors: string[] = [];
  const outcomes = panel.outcomes.flatMap((outcome, index): ParsedPanelOutcome[] => {
    const refutations = Object.freeze(outcome.refutations.map(({ lens, reason }) =>
      Object.freeze({ lens, reason })));
    const base = {
      findingId: outcome.findingId,
      claim: outcome.claim,
      upheldBy: Object.freeze([...outcome.upheldBy]),
      uncertainFrom: Object.freeze([...outcome.uncertainFrom]),
    };
    if (outcome.survives) {
      return [Object.freeze({ ...base, survives: true as const, refutations })];
    }
    const [head, ...tail] = refutations;
    if (head === undefined) {
      errors.push(`panel.outcomes[${index}] refuted outcome requires non-empty refutations`);
      return [];
    }
    return [Object.freeze({
      ...base,
      survives: false as const,
      refutations: Object.freeze([head, ...tail]) as NonEmpty<PanelRefutation>,
    })];
  });
  return errors.length > 0
    ? fail(errors)
    : ok(Object.freeze({
        lenses: Object.freeze([...panel.lenses]),
        threshold: panel.threshold,
        outcomes: Object.freeze(outcomes),
      }));
}

export type StandalonePanelFindingAuthority = Readonly<{
  id: string;
  taskId: typeof STANDALONE_REVIEW_SUBJECT;
  agent: string;
  severity: "critical";
  file: string | null;
  line: number | null;
  claim: string;
}>;

/**
 * Independently frozen expectation for a standalone Refutation Panel. This is
 * read authority, not completion authority: LC-2 additionally requires a T2
 * parser-produced completed panel receipt before it can leave refutation.
 */
export type FrozenStandalonePanelAuthority = Readonly<{
  schemaVersion: 1;
  kind: "frozen-standalone-panel-authority";
  standaloneRunId: OrchestrationRunId;
  panelRunId: OrchestrationRunId;
  findings: NonEmpty<StandalonePanelFindingAuthority>;
  findingBriefDigest: ArtifactDigest;
  lenses: NonEmpty<string>;
  manifestDigest: ArtifactDigest;
  threshold: number;
}>;

export type StandalonePanelAuthorityError = Readonly<{
  kind: "standalone-panel-authority-rejected";
  message: string;
}>;

export interface FreezeStandalonePanelAuthorityInput {
  readonly standaloneRunId: unknown;
  readonly panelRunId: unknown;
  readonly aggregate: StandaloneReviewAggregate;
  readonly panelFindings: unknown;
  readonly lenses: unknown;
  readonly manifestDigest: unknown;
  readonly threshold: unknown;
}

export interface AdjudicatedStandaloneReview {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly scope: readonly string[];
  readonly reviewerEvidence: readonly StandaloneReviewerEvidence[];
  readonly survivingCriticals: readonly Finding[];
  readonly advisories: readonly Finding[];
  readonly refutedCriticals: readonly RefutedFinding[];
  readonly panel: ParsedPanelOutcomes | null;
}

export function findingScopeErrors(scope: readonly string[], findings: readonly Pick<Finding, "file">[], label: string): readonly string[] {
  const allowed = new Set(scope);
  return findings.flatMap((finding, index) => {
    if (finding.file === null) return [];
    const parsed = parseReviewPath(finding.file, `${label}[${index}].file`);
    return parsed.ok && allowed.has(parsed.value)
      ? []
      : [`${label}[${index}].file is outside the frozen review scope: ${finding.file}`];
  });
}

export type StandaloneTranscriptAdmission =
  | Readonly<{ ok: true; findings: ParsedFindings }>
  | Readonly<{ ok: false; problems: readonly string[] }>;

/**
 * ONE parser, ONE admitted result. Per-transcript semantic admission against
 * the frozen scope, returning the parsed findings with the admission: the
 * orchestration façade and aggregation share this validator AND the findings
 * it admits, so (1) a reviewer slot the façade rejects for attempt 2 is
 * exactly the slot aggregation would have refused, and (2) aggregation never
 * re-parses an admitted transcript — a second, independent parse is the exact
 * divergence that could silently drop a reviewer's evidence with nothing to
 * notice (the parse it admitted and the parse it trusted are the same call).
 */
export function admitStandaloneTranscript(
  scope: readonly string[],
  output: string,
  agent: string,
): StandaloneTranscriptAdmission {
  const resolution = resolveReviewFindings(output, agent);
  if (resolution.kind === "evidence-failed") {
    return Object.freeze({ ok: false, problems: Object.freeze([`${agent}: ${resolution.message}`]) });
  }
  const problems = findingScopeErrors(scope, resolution.findings.drafts, `${agent} findings`);
  return problems.length > 0
    ? Object.freeze({ ok: false, problems: Object.freeze(problems) })
    : Object.freeze({ ok: true, findings: resolution.findings });
}

export function aggregateCanonicalTranscripts(
  runId: string,
  scope: readonly string[],
  transcripts: readonly Readonly<{ agent: StandaloneReviewerRole; output: string; evidence: StandaloneReviewerEvidence }>[],
): ParseResult<StandaloneReviewState> {
  const errors: string[] = [];
  const findings: Finding[] = [];
  for (const transcript of transcripts) {
    const admission = admitStandaloneTranscript(scope, transcript.output, transcript.agent);
    if (!admission.ok) {
      errors.push(...admission.problems);
      continue;
    }
    findings.push(...attributeFindings(admission.findings.drafts, transcript.agent));
  }
  if (errors.length > 0) return fail(errors);
  const ids = findings.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) return fail(["attributed standalone finding ids must be distinct across review agents"]);
  const aggregate: StandaloneReviewAggregate = Object.freeze({
    schemaVersion: 1,
    runId,
    subjectId: STANDALONE_REVIEW_SUBJECT,
    scope: Object.freeze([...scope]),
    reviewerEvidence: Object.freeze(transcripts.map(({ evidence }) => evidence)),
    findings: Object.freeze(findings),
  });
  const criticals = findings.filter((finding) => finding.severity === "critical");
  const [head, ...tail] = criticals;
  return head === undefined
    ? ok(Object.freeze({ kind: "clean", aggregate }))
    : ok(Object.freeze({
        kind: "requires-refutation",
        aggregate,
        criticals: Object.freeze([head, ...tail]) as NonEmpty<Finding>,
      }));
}

/**
 * Canonical aggregation accepts only T4's opaque completion proof, minted by
 * re-running T1 parsing with independent publication registration authority.
 */
export function aggregateStandaloneReview(input: {
  readonly authority: FrozenStandaloneReviewAuthority;
  readonly completion: StandaloneRosterCompletionProof;
}): ParseResult<StandaloneReviewState> {
  const { authority } = input;
  const resolved = resolveStandaloneRosterCompletion(authority, input.completion);
  if (!resolved.ok) return fail([resolved.error.message]);
  const roster = resolved.value;
  const errors: string[] = [];
  if (roster.ordered.length !== authority.roster.orderedSlots.length) {
    errors.push("complete reviewer roster length does not match frozen authority");
  }
  const transcripts = roster.ordered.flatMap((result, index) => {
    const expected = authority.roster.orderedSlots[index];
    if (expected === undefined) {
      errors.push(`complete reviewer result ${index} is surplus`);
      return [];
    }
    const canonical = result.authority;
    if (canonical.runId !== authority.runId) errors.push(`reviewer result ${index} belongs to a stale or foreign run`);
    if (canonical.slotId !== expected.slotId) errors.push(`reviewer result ${index} is outside canonical slot order`);
    const expectedAttempt = canonical.attempt === 1 ? expected.attempts[0] : expected.attempts[1];
    if (canonical.requestId !== expectedAttempt.requestId || canonical.contextDigest !== expectedAttempt.contextDigest ||
        canonical.modelProfile !== expectedAttempt.modelProfile || canonical.outputSlot.path !== expectedAttempt.outputSlot.path ||
        canonical.role !== expectedAttempt.role || canonical.program !== "standalone-review") {
      errors.push(`reviewer result ${index} does not match frozen request/model/context/output authority`);
    }
    const captured = result.value;
    if (captured.artifact.runId !== authority.runId || captured.artifact.slot.path !== canonical.outputSlot.path) {
      errors.push(`reviewer result ${index} artifact is bound to a stale, foreign, or mismatched slot`);
    }
    if (!(STANDALONE_REVIEWER_ROLES as readonly string[]).includes(canonical.role)) {
      errors.push(`reviewer result ${index} role is not a standalone reviewer`);
      return [];
    }
    const parsed = parseCapturedReviewerResult(captured);
    if (!parsed.ok) {
      errors.push(`reviewer result ${index}: ${parsed.error.message}`);
      return [];
    }
    const output = decodeCapturedReviewerText(parsed.value);
    if (!output.ok) {
      errors.push(`reviewer result ${index}: ${output.error.message}`);
      return [];
    }
    const evidence: StandaloneReviewerEvidence = Object.freeze({
      authorityKind: "request-bound",
      agent: canonical.role as StandaloneReviewerRole,
      slotId: canonical.slotId,
      requestId: canonical.requestId,
      attempt: canonical.attempt,
      modelProfile: canonical.modelProfile,
      contextDigest: canonical.contextDigest,
      artifact: parsed.value.artifact,
    });
    return [{ agent: canonical.role as StandaloneReviewerRole, output: output.value, evidence }];
  });
  if (errors.length > 0) return fail(errors);
  return aggregateCanonicalTranscripts(authority.runId, authority.scope, transcripts);
}

/** @deprecated Historical CLI adapter only — archived in ./legacy-archive (Section A).
 *  New orchestration must use aggregateStandaloneReview; this entry point and
 *  the re-export below survive only for historical run directories.
 *  Deprecation horizon: retire with the manual standalone-review helper. */
export { aggregateLegacyStandaloneReview } from "./legacy-archive";

export function serializeStandaloneAggregate(aggregate: StandaloneReviewAggregate): string {
  return JSON.stringify({
    schema_version: aggregate.schemaVersion,
    run_id: aggregate.runId,
    subject_id: aggregate.subjectId,
    scope: aggregate.scope,
    reviewer_evidence: aggregate.reviewerEvidence.map((evidence) => ({
      authority_kind: evidence.authorityKind,
      agent: evidence.agent,
      slot_id: evidence.slotId,
      request_id: evidence.requestId,
      attempt: evidence.attempt,
      model_profile: evidence.modelProfile,
      context_digest: evidence.contextDigest,
      artifact: evidence.artifact,
    })),
    findings: aggregate.findings,
  }, null, 2);
}

export function parseReviewerEvidence(raw: unknown, runId: string, label: string): ParseResult<readonly StandaloneReviewerEvidence[]> {
  if (raw === undefined) return ok([]); // historical v1 aggregate compatibility
  if (!Array.isArray(raw)) return fail([`${label} must be an array`]);
  const errors: string[] = [];
  const evidence: StandaloneReviewerEvidence[] = [];
  raw.forEach((entry, index) => {
    const path = `${label}[${index}]`;
    if (!isRecord(entry)) { errors.push(`${path} must be an object`); return; }
    errors.push(...exactKeys(entry, ["authority_kind", "agent", "slot_id", "request_id", "attempt", "model_profile", "context_digest", "artifact"], path));
    const artifact = parseArtifactRef(entry.artifact);
    if (!artifact.ok) errors.push(`${path}.artifact: ${artifact.error.message}`);
    if (artifact.ok && artifact.value.runId !== runId) errors.push(`${path}.artifact belongs to another run`);
    if (entry.authority_kind !== "request-bound" && entry.authority_kind !== "legacy-slot-bound") errors.push(`${path}.authority_kind is invalid`);
    if (typeof entry.agent !== "string" || !(STANDALONE_REVIEWER_ROLES as readonly string[]).includes(entry.agent)) errors.push(`${path}.agent is invalid`);
    if (typeof entry.slot_id !== "string" || entry.slot_id.trim() === "") errors.push(`${path}.slot_id must be non-empty`);
    if (typeof entry.request_id !== "string" || entry.request_id.trim() === "") errors.push(`${path}.request_id must be non-empty`);
    if (entry.attempt !== 1 && entry.attempt !== 2) errors.push(`${path}.attempt must be 1 or 2`);
    const requestBound = entry.authority_kind === "request-bound";
    // A closed-set id has to be parsed against the allowlist, not merely
    // shape-checked: aggregate.json is untrusted on-disk input, and a bare cast
    // would type an off-roster string as a member of LLM_PROFILE_IDS.
    const modelProfile = requestBound ? parseLlmProfileId(entry.model_profile) : null;
    if (modelProfile !== null && !modelProfile.ok) errors.push(`${path}.model_profile: ${modelProfile.error.message}`);
    if (!requestBound && entry.model_profile !== null) errors.push(`${path}.model_profile must be null for legacy evidence`);
    if (requestBound && (typeof entry.context_digest !== "string" || !/^[0-9a-f]{64}$/.test(entry.context_digest))) errors.push(`${path}.context_digest must be a SHA-256 digest for request-bound evidence`);
    if (!requestBound && entry.context_digest !== null) errors.push(`${path}.context_digest must be null for legacy evidence`);
    if (artifact.ok && typeof entry.agent === "string" && typeof entry.slot_id === "string" && typeof entry.request_id === "string" &&
        (entry.attempt === 1 || entry.attempt === 2) && (entry.authority_kind === "request-bound" || entry.authority_kind === "legacy-slot-bound") &&
        (modelProfile === null || modelProfile.ok)) {
      evidence.push(Object.freeze({
        authorityKind: entry.authority_kind,
        agent: entry.agent as StandaloneReviewerRole,
        slotId: entry.slot_id,
        requestId: entry.request_id,
        attempt: entry.attempt,
        modelProfile: modelProfile === null ? null : modelProfile.value,
        contextDigest: requestBound ? entry.context_digest as string : null,
        artifact: artifact.value,
      }));
    }
  });
  for (const field of ["agent", "slotId", "requestId"] as const) {
    const values = evidence.map((entry) => entry[field]);
    if (new Set(values).size !== values.length) errors.push(`${label}.${field} values must be distinct`);
  }
  const slots = evidence.map(({ artifact }) => artifact.slot.path);
  if (new Set(slots).size !== slots.length) errors.push(`${label} artifact slots must be distinct`);
  return errors.length > 0 ? fail(errors) : ok(Object.freeze(evidence));
}

export function parseStandaloneAggregate(raw: unknown): ParseResult<StandaloneReviewAggregate> {
  if (!isRecord(raw)) return fail(["standalone review aggregate must be an object"]);
  const errors = exactKeys(raw, ["schema_version", "run_id", "subject_id", "scope", "findings"], "aggregate")
    .filter((error) => !error.includes("reviewer_evidence"));
  const unknown = Object.keys(raw).filter((key) => !["schema_version", "run_id", "subject_id", "scope", "reviewer_evidence", "findings"].includes(key));
  errors.push(...unknown.map((key) => `aggregate contains unknown field '${key}'`));
  if (raw.schema_version !== 1) errors.push("aggregate.schema_version must be 1");
  const runId = typeof raw.run_id === "string" ? raw.run_id.trim() : "";
  if (runId === "") errors.push("aggregate.run_id must be non-empty");
  if (raw.subject_id !== STANDALONE_REVIEW_SUBJECT) errors.push(`aggregate.subject_id must be '${STANDALONE_REVIEW_SUBJECT}'`);
  const scope = parseStandaloneReviewScope(raw.scope, "aggregate.scope");
  if (!scope.ok) errors.push(...scope.errors);
  if (!Array.isArray(raw.findings)) errors.push("aggregate.findings must be an array");
  const findingError = findingsUnionError(raw.findings, "aggregate.findings");
  if (findingError !== null) errors.push(findingError);
  const findings = parseStoredFindings(raw.findings);
  if (scope.ok) errors.push(...findingScopeErrors(scope.value, findings, "aggregate.findings"));
  const ids = findings.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) errors.push("aggregate finding ids must be distinct");
  const evidence = parseReviewerEvidence(raw.reviewer_evidence, runId, "aggregate.reviewer_evidence");
  if (!evidence.ok) errors.push(...evidence.errors);
  return errors.length > 0 || !scope.ok || !evidence.ok
    ? fail(errors)
    : ok(Object.freeze({ schemaVersion: 1, runId, subjectId: STANDALONE_REVIEW_SUBJECT, scope: scope.value, reviewerEvidence: evidence.value, findings }));
}

function parseStringArray(raw: unknown, path: string, errors: string[]): readonly string[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    errors.push(`${path} must be an array containing only non-empty strings`);
    return [];
  }
  return raw.map((entry) => (entry as string).trim());
}

const UNUSABLE_PANEL_CLAIM = "(finding text was unusable after sanitization — see the task's critical_findings)";

export function canonicalStandalonePanelFindingAuthority(
  criticals: readonly Finding[],
): readonly StandalonePanelFindingAuthority[] {
  return Object.freeze(criticals.map((finding) => Object.freeze({
    id: `${STANDALONE_REVIEW_SUBJECT}:${finding.id}`,
    taskId: STANDALONE_REVIEW_SUBJECT,
    agent: sanitizeProse(finding.agent),
    severity: "critical" as const,
    file: finding.file,
    line: finding.line,
    claim: sanitizeProse(finding.claim) || UNUSABLE_PANEL_CLAIM,
  })));
}

export function canonicalStandalonePanelFindings(
  criticals: readonly Finding[],
): readonly Readonly<{ id: string; claim: string }>[] {
  return Object.freeze(canonicalStandalonePanelFindingAuthority(criticals).map(({ id, claim }) =>
    Object.freeze({ id, claim })));
}

const frozenStandalonePanelAuthorities = new WeakSet<object>();

export function canonicalDigest(value: unknown): ArtifactDigest {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex") as ArtifactDigest;
}

/**
 * Freeze lens/threshold/brief/manifest expectations independently from a
 * serialized result. Callers cannot use result.panel.lenses as this input.
 */
export function freezeStandalonePanelAuthority(
  input: FreezeStandalonePanelAuthorityInput,
): DomainResult<FrozenStandalonePanelAuthority, StandalonePanelAuthorityError> {
  const standaloneRunId = parseOrchestrationRunId(input.standaloneRunId);
  const panelRunId = parseOrchestrationRunId(input.panelRunId);
  const manifestDigest = parseArtifactDigest(input.manifestDigest);
  const criticals = input.aggregate.findings.filter(({ severity }) => severity === "critical");
  const expectedFindings = canonicalStandalonePanelFindingAuthority(criticals);
  const errors: string[] = [];
  if (!standaloneRunId.ok) errors.push(standaloneRunId.error.message);
  if (!panelRunId.ok) errors.push(panelRunId.error.message);
  if (!manifestDigest.ok) errors.push(manifestDigest.error.message);
  if (standaloneRunId.ok && input.aggregate.runId !== standaloneRunId.value) {
    errors.push("panel authority aggregate belongs to another standalone run");
  }
  if (expectedFindings.length === 0) errors.push("panel authority requires at least one canonical critical finding");
  if (!Array.isArray(input.panelFindings) || JSON.stringify(input.panelFindings) !== JSON.stringify(expectedFindings)) {
    errors.push("panel authority findings must exactly match the frozen standalone critical finding brief");
  }
  const lenses = Array.isArray(input.lenses) && input.lenses.every((lens) =>
    typeof lens === "string" && lens.trim() === lens && lens.length > 0)
    ? input.lenses as readonly string[]
    : [];
  if (lenses.length === 0 || new Set(lenses).size !== lenses.length) {
    errors.push("panel authority lenses must be a non-empty distinct ordered roster");
  }
  const floor = Math.floor(lenses.length / 2) + 1;
  if (!Number.isInteger(input.threshold) || (input.threshold as number) < floor ||
      (input.threshold as number) > lenses.length) {
    errors.push(`panel authority threshold must be an integer from strict-majority floor ${floor} through ${lenses.length}`);
  }
  const [firstFinding, ...otherFindings] = expectedFindings;
  const [firstLens, ...otherLenses] = lenses;
  if (errors.length > 0 || !standaloneRunId.ok || !panelRunId.ok || !manifestDigest.ok ||
      firstFinding === undefined || firstLens === undefined) {
    return resultFail(canonicalRecord({
      kind: "standalone-panel-authority-rejected" as const,
      message: errors.join("; ") || "standalone panel authority is invalid",
    }));
  }
  const authority = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "frozen-standalone-panel-authority" as const,
    standaloneRunId: standaloneRunId.value,
    panelRunId: panelRunId.value,
    findings: Object.freeze([firstFinding, ...otherFindings]) as NonEmpty<StandalonePanelFindingAuthority>,
    findingBriefDigest: canonicalDigest(expectedFindings),
    lenses: Object.freeze([firstLens, ...otherLenses]) as NonEmpty<string>,
    manifestDigest: manifestDigest.value,
    threshold: input.threshold as number,
  });
  frozenStandalonePanelAuthorities.add(authority);
  return resultOk(authority);
}

/** Reparse persisted panel read authority against the immutable aggregate artifact. */
export function parseFrozenStandalonePanelAuthority(
  raw: unknown,
  aggregate: StandaloneReviewAggregate,
): DomainResult<FrozenStandalonePanelAuthority, StandalonePanelAuthorityError> {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.kind !== "frozen-standalone-panel-authority") {
    return resultFail(canonicalRecord({
      kind: "standalone-panel-authority-rejected" as const,
      message: "persisted standalone panel authority is malformed",
    }));
  }
  const parsed = freezeStandalonePanelAuthority({
    standaloneRunId: raw.standaloneRunId,
    panelRunId: raw.panelRunId,
    aggregate,
    panelFindings: raw.findings,
    lenses: raw.lenses,
    manifestDigest: raw.manifestDigest,
    threshold: raw.threshold,
  });
  if (!parsed.ok) return parsed;
  if (raw.findingBriefDigest !== parsed.value.findingBriefDigest ||
      JSON.stringify(raw) !== JSON.stringify(parsed.value)) {
    return resultFail(canonicalRecord({
      kind: "standalone-panel-authority-rejected" as const,
      message: "persisted standalone panel authority does not match the canonical finding brief",
    }));
  }
  return parsed;
}

export function isFrozenStandalonePanelAuthority(
  authority: FrozenStandalonePanelAuthority,
): boolean {
  return typeof authority === "object" && authority !== null && frozenStandalonePanelAuthorities.has(authority);
}

/** Parse the review-panel's serialized tally and prove exact critical coverage. */
export function parseStandalonePanelOutcomes(
  raw: unknown,
  criticals: readonly Finding[],
  panelFindings: readonly { readonly id: string; readonly claim: string }[],
  expectedLenses: readonly string[],
): ParseResult<ParsedPanelOutcomes> {
  if (!isRecord(raw)) return fail(["standalone panel outcomes must be an object"]);
  const errors: string[] = exactKeys(raw, ["lenses", "threshold", "surviving", "refuted", "outcomes"], "outcomes");
  const lenses = parseStringArray(raw.lenses, "outcomes.lenses", errors);
  if (new Set(lenses).size !== lenses.length) errors.push("outcomes.lenses must be distinct");
  if (lenses.length !== expectedLenses.length || lenses.some((lens, index) => lens !== expectedLenses[index])) {
    errors.push("outcomes.lenses must exactly match the validated manifest lenses in order");
  }
  const threshold = Number.isInteger(raw.threshold) ? raw.threshold as number : 0;
  const majority = Math.floor(lenses.length / 2) + 1;
  if (threshold < majority || threshold > lenses.length) errors.push("outcomes.threshold must be at least a strict majority and no greater than the lens count");
  if (!Array.isArray(raw.outcomes)) return fail([...errors, "outcomes.outcomes must be an array"]);
  const expected = new Map(criticals.map((finding) => [`${STANDALONE_REVIEW_SUBJECT}:${finding.id}`, finding]));
  const canonicalPanelFindings = canonicalStandalonePanelFindings(criticals);
  const canonicalPanelClaims = new Map(canonicalPanelFindings.map((finding) => [finding.id, finding.claim] as const));
  const expectedPanelClaims = new Map(panelFindings.map((finding) => [finding.id, finding.claim] as const));
  if (expectedPanelClaims.size !== panelFindings.length) errors.push("panel findings must have distinct ids");
  if (panelFindings.length !== canonicalPanelFindings.length || panelFindings.some((finding) =>
    canonicalPanelClaims.get(finding.id) !== finding.claim)) {
    errors.push("panel findings must exactly match claims derived from canonical critical dispositions");
  }
  const expectedIds = [...expected.keys()];
  const panelIds = panelFindings.map((finding) => finding.id);
  if (panelIds.length !== expectedIds.length || panelIds.some((id) => !expected.has(id)) || expectedIds.some((id) => !expectedPanelClaims.has(id))) {
    errors.push("panel findings must exactly cover aggregate critical finding ids");
  }
  const outcomes: ParsedPanelOutcome[] = [];
  for (const [index, entry] of raw.outcomes.entries()) {
    const path = `outcomes.outcomes[${index}]`;
    if (!isRecord(entry)) { errors.push(`${path} must be an object`); continue; }
    errors.push(...exactKeys(entry, [
      "finding_id", "task_id", "claim", "survives", "refuted_by", "reasoning", "upheld_by", "uncertain_from",
    ], path));
    const findingId = typeof entry.finding_id === "string" ? entry.finding_id.trim() : "";
    const finding = expected.get(findingId);
    if (entry.task_id !== STANDALONE_REVIEW_SUBJECT) errors.push(`${path}.task_id must be '${STANDALONE_REVIEW_SUBJECT}'`);
    if (!finding) errors.push(`${path}.finding_id is not an expected critical: ${findingId || "<empty>"}`);
    const claim = typeof entry.claim === "string" ? entry.claim.trim() : "";
    const expectedPanelClaim = expectedPanelClaims.get(findingId);
    if (finding && expectedPanelClaim !== undefined && claim !== expectedPanelClaim) errors.push(`${path}.claim does not match canonical panel finding ${findingId}`);
    if (typeof entry.survives !== "boolean") errors.push(`${path}.survives must be boolean`);
    const refutedBy = parseStringArray(entry.refuted_by, `${path}.refuted_by`, errors);
    const reasoning = parseStringArray(entry.reasoning, `${path}.reasoning`, errors);
    const upheldBy = parseStringArray(entry.upheld_by, `${path}.upheld_by`, errors);
    const uncertainFrom = parseStringArray(entry.uncertain_from, `${path}.uncertain_from`, errors);
    if (refutedBy.length !== reasoning.length) errors.push(`${path} refuted_by/reasoning lengths must match`);
    const votes = [...refutedBy, ...upheldBy, ...uncertainFrom];
    if (new Set(votes).size !== votes.length) errors.push(`${path} lens votes must be distinct across all verdict kinds`);
    if (votes.length !== lenses.length || votes.some((lens) => !lenses.includes(lens))) errors.push(`${path} must account for every panel lens exactly once`);
    if (entry.survives === false && refutedBy.length < threshold) errors.push(`${path} refuted finding must meet threshold`);
    if (entry.survives === true && refutedBy.length >= threshold) errors.push(`${path} surviving finding must be below threshold`);
    const refutations = refutedBy.map((lens, refutationIndex) => ({ lens, reason: reasoning[refutationIndex] ?? "" }));
    if (entry.survives === true) outcomes.push({ findingId, claim, survives: true, refutations, upheldBy, uncertainFrom });
    else {
      const [head, ...tail] = refutations;
      if (head === undefined) errors.push(`${path} refuted finding must carry at least one refutation`);
      else outcomes.push({ findingId, claim, survives: false, refutations: [head, ...tail], upheldBy, uncertainFrom });
    }
  }
  const ids = outcomes.map(({ findingId }) => findingId);
  if (new Set(ids).size !== ids.length) errors.push("panel outcome finding ids must be distinct");
  for (const id of expected.keys()) if (!ids.includes(id)) errors.push(`panel outcomes are missing critical finding: ${id}`);
  if (outcomes.length !== expected.size) errors.push(`panel outcomes must contain exactly ${expected.size} critical findings`);
  const surviving = outcomes.filter((outcome) => outcome.survives).length;
  const refuted = outcomes.length - surviving;
  if (raw.surviving !== surviving) errors.push(`outcomes.surviving must equal derived count ${surviving}`);
  if (raw.refuted !== refuted) errors.push(`outcomes.refuted must equal derived count ${refuted}`);
  if (errors.length > 0) return fail(errors);
  return canonicalStandalonePanelOutcomes({ lenses, threshold, outcomes });
}

/** Pure finalization: a critical can only be surviving or audibly refuted. */
export function finalizeStandaloneReview(
  aggregate: StandaloneReviewAggregate,
  panel: ParsedPanelOutcomes | null,
): ParseResult<AdjudicatedStandaloneReview> {
  const criticals = aggregate.findings.filter((finding) => finding.severity === "critical");
  const advisories = Object.freeze(aggregate.findings.filter((finding) => finding.severity === "advisory"));
  if (criticals.length === 0) {
    return panel === null
      ? ok(Object.freeze({
          schemaVersion: 1,
          runId: aggregate.runId,
          scope: Object.freeze([...aggregate.scope]),
          reviewerEvidence: Object.freeze([...aggregate.reviewerEvidence]),
          survivingCriticals: Object.freeze([]),
          advisories,
          refutedCriticals: Object.freeze([]),
          panel: null,
        }))
      : fail(["a clean standalone review must not carry panel outcomes"]);
  }
  if (panel === null) return fail(["standalone review has unadjudicated critical findings"]);
  const canonicalPanel = canonicalStandalonePanelOutcomes(panel);
  if (!canonicalPanel.ok) return canonicalPanel;
  const byId = new Map(canonicalPanel.value.outcomes.map((outcome) => [outcome.findingId, outcome] as const));
  const survivingCriticals: Finding[] = [];
  const refutedCriticals: RefutedFinding[] = [];
  for (const finding of criticals) {
    const outcome = byId.get(`${STANDALONE_REVIEW_SUBJECT}:${finding.id}`);
    if (!outcome) return fail([`missing adjudication for critical finding ${finding.id}`]);
    if (outcome.survives) survivingCriticals.push(finding);
    else refutedCriticals.push(Object.freeze({
      finding,
      refutations: Object.freeze(outcome.refutations.map(({ lens, reason }) => Object.freeze({ lens, reason }))) as NonEmpty<PanelRefutation>,
    }));
  }
  return ok(Object.freeze({
    schemaVersion: 1,
    runId: aggregate.runId,
    scope: Object.freeze([...aggregate.scope]),
    reviewerEvidence: Object.freeze([...aggregate.reviewerEvidence]),
    survivingCriticals: Object.freeze(survivingCriticals),
    advisories,
    refutedCriticals: Object.freeze(refutedCriticals),
    panel: canonicalPanel.value,
  }));
}

export function serializeAdjudicatedStandaloneReview(result: AdjudicatedStandaloneReview): string {
  return JSON.stringify({
    schema_version: result.schemaVersion,
    run_id: result.runId,
    subject_id: STANDALONE_REVIEW_SUBJECT,
    scope: result.scope,
    reviewer_evidence: result.reviewerEvidence.map((evidence) => ({
      authority_kind: evidence.authorityKind,
      agent: evidence.agent,
      slot_id: evidence.slotId,
      request_id: evidence.requestId,
      attempt: evidence.attempt,
      model_profile: evidence.modelProfile,
      context_digest: evidence.contextDigest,
      artifact: evidence.artifact,
    })),
    surviving_critical_findings: result.survivingCriticals,
    advisory_findings: result.advisories,
    refuted_critical_findings: result.refutedCriticals,
    panel: result.panel === null ? null : {
      lenses: result.panel.lenses,
      threshold: result.panel.threshold,
      surviving: result.panel.outcomes.filter(({ survives }) => survives).length,
      refuted: result.panel.outcomes.filter(({ survives }) => !survives).length,
      outcomes: result.panel.outcomes.map((outcome) => ({
        finding_id: outcome.findingId,
        task_id: STANDALONE_REVIEW_SUBJECT,
        claim: outcome.claim,
        survives: outcome.survives,
        refuted_by: outcome.refutations.map(({ lens }) => lens),
        reasoning: outcome.refutations.map(({ reason }) => reason),
        upheld_by: outcome.upheldBy,
        uncertain_from: outcome.uncertainFrom,
      })),
    },
  }, null, 2);
}

/** Legacy helper output stays explicitly unversioned and never claims v1 authority. */
export function serializeHistoricalAdjudicatedStandaloneReview(result: AdjudicatedStandaloneReview): string {
  const versioned = JSON.parse(serializeAdjudicatedStandaloneReview(result)) as Record<string, unknown>;
  const {
    schema_version: _schemaVersion,
    subject_id: _subjectId,
    reviewer_evidence: _reviewerEvidence,
    ...historical
  } = versioned;
  return JSON.stringify(historical, null, 2);
}

export const STANDALONE_RESULT_SLOT = "result.json" as const;

export function canonicalStandaloneResultArtifact(
  result: AdjudicatedStandaloneReview,
): DomainResult<ArtifactRef, SemanticPayloadParseError> {
  const bytes = Buffer.from(serializeAdjudicatedStandaloneReview(result), "utf-8");
  const artifact = parseArtifactRef({
    runId: result.runId,
    slot: STANDALONE_RESULT_SLOT,
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  });
  return artifact.ok
    ? resultOk(artifact.value)
    : resultFail({ message: `canonical standalone result artifact is invalid: ${artifact.error.message}` });
}

/** @deprecated Compatibility parser for explicitly unversioned historical bytes
 *  only — archived in ./legacy-archive (Section B). Schema-v1 results are
 *  accepted solely by the LC-2 authoritative publication parser, which
 *  requires frozen run/roster/finalization intent and its receipt.
 *  Deprecation horizon: retire once no run directory carries an unversioned
 *  result.json. */
export { parseAdjudicatedStandaloneReview, type HistoricalStandaloneReviewResult } from "./legacy-archive";
