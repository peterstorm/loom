/**
 * Standalone Review aggregate: preparation, issued evidence, lineage and LC-2 publication.
 * Publication membership and successor source admission deliberately share this owner:
 * exporting a raw-result registrar to separate them would bypass the LC-2 proof chain.
 * The lineage, successor-reviewer and machine entry modules retain their existing APIs;
 * this implementation never imports those entry modules.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { match } from "ts-pattern";
import { readExactDataRecord } from "./orchestration-contract/bytes";
import { parseEffectReceipt } from "./orchestration-contract/effects";
import { failure, success } from "./orchestration-contract/identity";
import { parseBoundedReviewerJson, parseStandaloneReviewerPayloadV3 } from "./reviewer-protocol";
import {
  STANDALONE_LINEAGE_LIMITS, STANDALONE_REVIEWER_PROTOCOL_V3, parseStandaloneReviewerProtocolV3,
  findingOriginSchema, standaloneLineageInventorySchema, standalonePublicationReferenceSchema,
  standaloneDispositionSchema, standaloneSuccessorSelectionSchema, standalonePreviousSnapshotSchema,
  type FindingOrigin, type StandaloneLineageRow, type StandalonePublicationReference,
  type StandaloneDispositionRecord, type StandaloneReviewerPayloadV3, type StandaloneResolutionAssessment,
  type StandalonePreviousSnapshot, type StandaloneSnapshot,
} from "./standalone-lineage-contract";
import { buildStandaloneReviewerContextPacketV3, encodeByteSection, parseStandaloneReviewerContextPacketV3,
  type ByteSection, type StandaloneReviewerContextPacketV3 } from "./context-packets";
import {
  parseRefutationPanelAuthority, parseRefutationPanelCheckpoint, replayPersistentRefutationPanel,
  resumePersistentRefutationPanel, type RefutationPanelAuthority, type RefutationPanelCheckpoint,
  type RefutationPanelState,
} from "./panel-program";
import type { ReviewerProtocolFailure } from "./reviewer-contract";
import {
  AGENT_REQUIRED_SKILLS,
  acceptedAgentResult,
  canonicalRecord,
  canonicalStructuralEquals,
  parseArtifactDigest,
  parseArtifactRef,
  parseBlockedDiagnostic,
  parseEffectId,
  parseExactRoster,
  parseOrchestrationRunId,
  parseCompleteRoster,
  parseRequestId,
  parseSlotId,
  reconcileEffectReceipt,
  type AcceptedAgentResult,
  type AgentRequestAuthority,
  type ArtifactDigest,
  type AgentRosterSlot,
  type ArtifactRef,
  type ArtifactSetPublished,
  type EffectIntent,
  type EffectReceipt,
  type InfrastructureRetryDiagnostic,
  type PublishArtifactSet,
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
  sameAgentRequestAuthority,
} from "./orchestration-contract";
import {
  lowerModelProfile,
  parseLlmProfileId,
  resolveAgentPolicy,
  resolveModelProfile,
  type LlmProfileId,
  type LoomAgentName,
} from "./model-profiles";
import { reviewFindingCounts, attributeFindings, findingsUnionError, parseStoredFindings, type Finding, type RefutedFinding } from "./findings";
import { fail, isRecord, ok, sanitizeProse, type ParseResult } from "./panel-kernel";
import { resolveReviewFindings, parseReviewerEvidence as parseIssuedReviewerEvidence, type ParsedFindings, type IssuedStandaloneReviewerProtocol, type ReviewerProtocolAuthorityResolver } from "./review-output";
import { parseReviewPath, sha256Bytes, type ReviewPath } from "./review-packet";
import { compareStrings } from "./ordering";
import { projectFindingForPanel, type BriefFinding } from "./review-panel";

import { STANDALONE_REVIEW_SUBJECT, CURRENT_REVIEWER_PROTOCOL, parseReviewerProtocolDescriptor, type ReviewerProtocolDescriptor } from "./reviewer-contract";
export { STANDALONE_REVIEW_SUBJECT } from "./reviewer-contract";

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

export type StandaloneReviewMetadata = (
  | Readonly<{ docsOnly: true; sourceOrTestChanged: false; commentsChanged: true }>
  | Readonly<{ docsOnly: false; sourceOrTestChanged: boolean; commentsChanged: boolean }>
) & Readonly<{
  requestedKinds: NonEmpty<StandaloneReviewKind>;
  typesChanged: boolean;
  readonly additions: number;
  readonly fileCount: number;
  readonly newStructure: boolean;
  readonly languages: readonly string[];
}>;

export interface StandaloneChangedPaths {
  /**
   * Tracked files whose worktree content differs from the INDEX, plus untracked
   * non-ignored files. The producer runs `git diff --name-only` without
   * `--cached`, so a path already staged with no further edits appears in
   * `staged` alone, not here.
   */
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
type StandaloneReviewProtocol =
  | Readonly<{ schemaVersion: 1; reviewerProtocol?: never }>
  | Readonly<{ schemaVersion: 2; reviewerProtocol: ReviewerProtocolDescriptor }>
  | Readonly<{ schemaVersion: 3; reviewerProtocol: typeof STANDALONE_REVIEWER_PROTOCOL_V3; successor: PreparedStandaloneSuccessor }>;
type StandaloneAggregateProtocol = Exclude<StandaloneReviewProtocol, { schemaVersion: 3 }> |
  (Extract<StandaloneReviewProtocol, { schemaVersion: 3 }> & Readonly<{ lineage: StandaloneSuccessorLineage }>);
export type StandaloneReviewerProtocolResolver = (request: AgentRequestAuthority) => DomainResult<
  Extract<ReturnType<ReviewerProtocolAuthorityResolver>, { ok: true }>["value"] | IssuedStandaloneSuccessorReviewer, ReviewerProtocolFailure>;

export type FrozenStandaloneReviewAuthority = StandaloneReviewProtocol & Readonly<{
  readonly kind: "standalone-review-authority";
  readonly runId: OrchestrationRunId;
  readonly scopeSource: StandaloneScopeSource;
  readonly scope: NonEmpty<ReviewPath>;
  readonly scopeSafety: NonEmpty<StandaloneScopeSafety>;
  readonly changedPaths: StandaloneChangedPaths;
  readonly reviewMetadata: StandaloneReviewMetadata;
  readonly reviewers: NonEmpty<StandaloneReviewerRole>;
  readonly roster: ExactRoster<AgentRosterSlot>;
}>;

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
  readonly successor?: PreparedStandaloneSuccessor;
}



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

/**
 * A git revision at this boundary, exactly as the sibling boundaries SHA it:
 * `parseGitSha` (review-packet.ts) and `reviewedSourceSchema.headRevision`
 * (the standalone pi-goal repository, src/integration/loom-review.ts).
 * Producers emit the full hex from `git rev-parse`/`git merge-base`; accepting
 * any other string let a tampered frozen authority name a branch where only a
 * SHA was meant.
 */
const GIT_REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function parseChangedPaths(raw: unknown): ParseResult<StandaloneChangedPaths> {
  if (!isRecord(raw)) return fail(["changed_paths must be an object"]);
  const errors = exactKeys(raw, ["unstaged", "staged", "committed", "base_revision", "head_revision"], "changed_paths");
  const unstaged = parsePathList(raw.unstaged, "changed_paths.unstaged", errors);
  const staged = parsePathList(raw.staged, "changed_paths.staged", errors);
  const committed = parsePathList(raw.committed, "changed_paths.committed", errors);
  const baseRevision = raw.base_revision === null ||
      (typeof raw.base_revision === "string" && raw.base_revision.trim() === raw.base_revision && GIT_REVISION.test(raw.base_revision))
    ? raw.base_revision as string | null
    : null;
  if (raw.base_revision !== null && baseRevision === null) {
    errors.push("changed_paths.base_revision must be null or a 40/64-hex git SHA without surrounding whitespace");
  }
  const headRevision = typeof raw.head_revision === "string" && raw.head_revision.trim() === raw.head_revision && GIT_REVISION.test(raw.head_revision)
    ? raw.head_revision
    : "";
  if (headRevision === "") errors.push("changed_paths.head_revision must be a 40/64-hex git SHA without surrounding whitespace");
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

function boolField(raw: Readonly<Record<string, unknown>>, key: string, errors: string[]): boolean {
  if (typeof raw[key] !== "boolean") errors.push(`review_metadata.${key} must be boolean`);
  return raw[key] === true;
}

function integerField(raw: Readonly<Record<string, unknown>>, key: "additions" | "file_count", errors: string[]): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    errors.push(`review_metadata.${key} must be a non-negative safe integer`);
    return 0;
  }
  return value;
}

function checkDocsOnlyInvariants(docsOnly: boolean, sourceOrTestChanged: boolean, commentsChanged: boolean, errors: string[]): void {
  // A docs-only scope always changes comments — comment-analyzer is the role
  // selected specifically for docs, so the producer's invariant (`metadata` in
  // handlers/helpers/programs/helpers.ts: commentsChanged = docsOnly || scope
  // has .md/.mdx) must hold at the boundary too. The check's remaining value is
  // rejecting the contradictory record outright: without it, the caller's ok
  // branch silently NORMALIZES docs_only=true to commentsChanged=true, so the
  // contradiction hides behind accepted output instead of failing at the
  // untrusted-JSON boundary (parse-don't-validate honesty).
  if (docsOnly && !commentsChanged) {
    errors.push("review_metadata.comments_changed must be true when docs_only is true (a docs-only scope always changes comments)");
  }
  // The producer's OTHER docs-only invariant, and the more dangerous one to
  // leave unproven. `docs_only` is by definition "no source or test file
  // changed" — `classifyScope` derives it as the docs pattern AND
  // `!sourceOrTestChanged`, precisely so the pair cannot both be true — yet
  // only the comments half was checked here, leaving
  // `docs_only && source_or_test_changed` representable at the boundary.
  // The check's remaining value is rejecting that record outright: without it,
  // the caller's ok branch normalizes it to {docsOnly: true,
  // sourceOrTestChanged: false, commentsChanged: true}, so the contradictory
  // pair never reaches `selectStandaloneReviewers` — the metadata passed to
  // selection claims docs-only (not real source changed), pr-test-analyzer is
  // never admitted, and the silent-failure-hunter drop is the same accepted
  // docs-only behavior `classifyScope` produces for a genuinely docs-only
  // scope. Rejecting the record keeps the contradiction audible instead of
  // silently normalized.
  if (docsOnly && sourceOrTestChanged) {
    errors.push("review_metadata.source_or_test_changed must be false when docs_only is true (a docs-only scope changes no source or test file)");
  }
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
  const languages = parseStringSet(raw.languages, "review_metadata.languages", errors);
  const docsOnly = boolField(raw, "docs_only", errors);
  const sourceOrTestChanged = boolField(raw, "source_or_test_changed", errors);
  const typesChanged = boolField(raw, "types_changed", errors);
  const commentsChanged = boolField(raw, "comments_changed", errors);
  checkDocsOnlyInvariants(docsOnly, sourceOrTestChanged, commentsChanged, errors);
  const additions = integerField(raw, "additions", errors);
  const fileCount = integerField(raw, "file_count", errors);
  const newStructure = boolField(raw, "new_structure", errors);
  const [firstKind, ...otherKinds] = requestedKinds;
  if (firstKind === undefined) errors.push("review_metadata.requested_kinds must be non-empty");
  const nonEmptyKinds = firstKind === undefined
    ? null
    : Object.freeze([firstKind, ...otherKinds]) as NonEmpty<StandaloneReviewKind>;
  return errors.length > 0 || nonEmptyKinds === null
    ? fail(errors)
    : ok(Object.freeze({
        requestedKinds: nonEmptyKinds,
        ...(docsOnly
          ? { docsOnly: true as const, sourceOrTestChanged: false as const, commentsChanged: true as const }
          : { docsOnly: false as const, sourceOrTestChanged, commentsChanged }),
        typesChanged,
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
  if (input.successor !== undefined) {
    if (!isPreparedStandaloneSuccessor(input.successor) || input.successor.runId !== input.runId ||
        !scopeResult.ok || JSON.stringify(scopeResult.value) !== JSON.stringify(input.successor.snapshot.map(row => row.path))) {
      errors.push("successor requires exact nominal lineage Run and frozen scope");
    } else {
      selected = input.successor.reviewers;
      if (safety.ok && safety.value.some((entry, index) => (entry.status === "absent") !== (input.successor!.snapshot[index]!.kind === "absent"))) {
        errors.push("successor scope safety must match its frozen presence/absence observation");
      }
      if (metadata.ok && selectStandaloneReviewers(metadata.value).some(role => !selected!.includes(role))) {
        errors.push("successor roster must retain deterministic current reviewer selection");
      }
    }
  }
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
    ...(input.successor === undefined ? { schemaVersion: 1 as const } :
      { schemaVersion: 3 as const, reviewerProtocol: STANDALONE_REVIEWER_PROTOCOL_V3, successor: input.successor }),
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
 * model, request, slot, or destination attribution. The shell supplies scope,
 * changed-path metadata, scope safety, optional successor authority, a fresh
 * run identity, and already-computed immutable context digests.
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
  if (input.successor !== undefined && !isPreparedStandaloneSuccessor(input.successor)) return preparationFailure(["successor membership is required"]);
  const reviewers = input.successor === undefined ? selectStandaloneReviewers(metadata.value) : input.successor.reviewers;
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
    return preparationFailure(authorityErrors);
  }
  const prepared = prepareStandaloneReview({ ...input, roster });
  return prepared.ok ? resultOk(Object.freeze({
    authority: prepared.value.authority.schemaVersion === 3 ? prepared.value.authority
      : Object.freeze({ ...prepared.value.authority, schemaVersion: 2, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL }),
    initialRequests: prepared.value.initialRequests,
  })) : prepared;
}

export function serializeStandaloneReviewAuthority(authority: FrozenStandaloneReviewAuthority): string {
  return JSON.stringify({
    schema_version: authority.schemaVersion,
    ...(authority.schemaVersion !== 1 ? { reviewer_protocol: authority.reviewerProtocol } : {}),
    ...(authority.schemaVersion === 3 ? { successor: authority.successor } : {}),
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

export function parseStandaloneReviewAuthority(raw: unknown, successor?: PreparedStandaloneSuccessor): ParseResult<FrozenStandaloneReviewAuthority> {
  if (!isRecord(raw)) return fail(["standalone review authority must be an object"]);
  const allowed = [
    "schema_version", "kind", "run_id", "scope_source", "scope", "scope_safety",
    "changed_paths", "review_metadata", "reviewers", "roster",
  ] as const;
  const errors = exactKeys(raw, [...allowed, ...(raw.schema_version !== 1 ? ["reviewer_protocol"] : []),
    ...(raw.schema_version === 3 ? ["successor"] : [])], "standalone review authority");
  if (raw.schema_version !== 1 && raw.schema_version !== 2 && raw.schema_version !== 3) errors.push("standalone review authority.schema_version must be 1, 2 or 3");
  if (raw.schema_version === 3 && (successor === undefined || !isPreparedStandaloneSuccessor(successor) ||
      !canonicalStructuralEquals(raw.successor, successor))) errors.push("v3 authority requires independently authenticated exact successor lineage");
  const descriptor = raw.schema_version === 3 ? parseStandaloneReviewerProtocolV3(raw.reviewer_protocol)
    : raw.schema_version === 2 ? parseReviewerProtocolDescriptor(raw.reviewer_protocol) : null;
  if (descriptor !== null && !descriptor.ok) errors.push(descriptor.error.message);
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
    ...(raw.schema_version === 3 ? { successor } : {}),
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
  if (errors.length > 0 || !prepared.ok) return fail(errors);
  if (prepared.value.authority.schemaVersion === 3) return ok(prepared.value.authority);
  return descriptor !== null && descriptor.ok && descriptor.value.version === 2
    ? ok(Object.freeze({ ...prepared.value.authority, schemaVersion: 2, reviewerProtocol: descriptor.value }))
    : ok(prepared.value.authority);
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
  /** Branded like every other slot/request identity in this module: the value
   *  comes from untrusted `aggregate.json`, so it is PARSED against
   *  `SAFE_AUTHORITY_ID`, not merely shape-checked for non-emptiness. */
  readonly slotId: SlotId;
  readonly requestId: RequestId;
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
    sha256: sha256Bytes(bytes),
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
  return canonicalDigest({
    runId: result.artifact.runId,
    slot: result.artifact.slot.path,
    digest: result.artifact.digest,
    byteLength: result.artifact.byteLength,
    rawBytes: result.rawBytes,
  });
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
  authority: FrozenStandaloneReviewAuthority;
  authoritySerialization: string;
  roster: CompleteRoster<AcceptedAgentResult<CapturedReviewerResult>>;
  findings: readonly ParsedFindings[];
  successorReports: readonly AdmittedStandaloneSuccessorEvidence[];
}>>();

/** The sole T4 constructor for roster-completion authority. */
export function proveStandaloneRosterCompletion(
  authority: FrozenStandaloneReviewAuthority,
  resolver: PublicationAuthorityResolver,
  rawResults: unknown,
  reviewerProtocols: StandaloneReviewerProtocolResolver,
): DomainResult<StandaloneRosterCompletionProof, CompleteRosterError> {
  const reparsed = parseCompleteRoster(
    resolver,
    authority.roster,
    rawResults,
    parseCapturedReviewerResult,
  );
  if (!reparsed.ok) return reparsed;
  const findings: ParsedFindings[] = [];
  const successorReports: AdmittedStandaloneSuccessorEvidence[] = [];
  for (const result of reparsed.value.ordered) {
    const protocol = reviewerProtocols(result.authority);
    if (authority.schemaVersion === 3) {
      if (!protocol.ok || protocol.value.protocolVersion !== 3 || protocol.value.prepared !== authority.successor ||
          !sameAgentRequestAuthority(protocol.value.request, result.authority)) return completionProtocolFailure("v3 issued authority differs from frozen successor", successorReports.length);
      const admitted = admitStandaloneSuccessorReviewer(protocol.value, Buffer.from(result.value.rawBytes.data, "base64"));
      if (!admitted.ok) return completionProtocolFailure(admitted.error.message, successorReports.length);
      successorReports.push(admitted.value);
      continue;
    }
    if (!protocol.ok || protocol.value.protocolVersion === 3 || protocol.value.subject.kind !== "standalone-review" ||
        protocol.value.protocolVersion !== authority.schemaVersion ||
        !sameAgentRequestAuthority(protocol.value.request, result.authority) ||
        JSON.stringify(protocol.value.subject.scope) !== JSON.stringify(authority.scope) ||
        protocol.value.subject.runId !== authority.runId ||
        JSON.stringify(protocol.value.reviewerProtocol) !== JSON.stringify(authority.reviewerProtocol)) {
      return completionProtocolFailure("reviewer protocol does not match the exact frozen standalone request", findings.length);
    }
    const admission = admitStandaloneTranscript(protocol.value as IssuedStandaloneReviewerProtocol, Buffer.from(result.value.rawBytes.data, "base64"));
    if (!admission.ok) return completionProtocolFailure(admission.problems.join("; "), findings.length);
    findings.push(admission.findings);
  }
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
    authority,
    authoritySerialization: serializeStandaloneReviewAuthority(authority),
    roster: reparsed.value,
    findings: Object.freeze(findings),
    successorReports: Object.freeze(successorReports),
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
  reviewerProtocols: StandaloneReviewerProtocolResolver,
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
  const reproved = proveStandaloneRosterCompletion(authority, resolver, raw.results, reviewerProtocols);
  if (!reproved.ok) return reproved;
  if (raw.rosterDigest !== reproved.value.rosterDigest ||
      JSON.stringify(raw.accepted) !== JSON.stringify(reproved.value.accepted)) {
    return malformedPersistedCompletion(
      "persisted standalone roster completion digest or accepted-slot projection disagrees with the re-proved result roster",
    );
  }
  return reproved;
}

function completionProtocolFailure(message: string, index: number): DomainResult<never, CompleteRosterError> {
  return resultFail(canonicalRecord({ kind: "incomplete-or-invalid-roster", violations: Object.freeze([
    canonicalRecord({ kind: "malformed-result-boundary", field: null, index, reason: "unsafe-inspection", message }),
  ]) as CompleteRosterError["violations"] }));
}

function resolveStandaloneRosterCompletion(
  authority: FrozenStandaloneReviewAuthority,
  proof: StandaloneRosterCompletionProof,
): DomainResult<Readonly<{ roster: CompleteRoster<AcceptedAgentResult<CapturedReviewerResult>>; findings: readonly ParsedFindings[]; successorReports: readonly AdmittedStandaloneSuccessorEvidence[] }>, SemanticPayloadParseError> {
  const cached = typeof proof === "object" && proof !== null
    ? standaloneRosterCompletionCache.get(proof)
    : undefined;
  if (cached === undefined || cached.authority !== authority || proof.runId !== authority.runId ||
      cached.authoritySerialization !== serializeStandaloneReviewAuthority(authority) ||
      proof.rosterDigest !== canonicalDigest(proof.accepted) || !Array.isArray(proof.results)) {
    return resultFail({ message: "standalone aggregation requires the exact opaque roster-completion proof minted for this frozen authority" });
  }
  return resultOk(cached);
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
    if (expected === undefined || !sameAgentRequestAuthority(request.authority, expected) || request.authority.runId !== authority.runId) {
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
  // One canonical derivation shared by the core intent, the durable runtime
  // receipt and the witness reader: the attempt is part of every durable
  // capture receipt's identity, so a receipt reconciled directly against this
  // intent cannot diverge from the runtime-recorded form.
  const effectId = parseEffectId(`effect:capture:${createHash("sha256").update(`${request.authority.requestId}:${request.authority.attempt}`).digest("hex")}`);
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

export type StandaloneReviewAggregate = StandaloneAggregateProtocol & Readonly<{
  readonly runId: string;
  readonly subjectId: typeof STANDALONE_REVIEW_SUBJECT;
  readonly scope: readonly string[];
  readonly reviewerEvidence: readonly StandaloneReviewerEvidence[];
  readonly findings: readonly Finding[];
}>;

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

export type StandalonePanelFindingAuthority = Extract<BriefFinding, { protocolVersion: 2 }> | Readonly<{
  protocolVersion?: never;
  basis?: never;
  reason?: never;
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
export type FrozenStandalonePanelAuthority = (
  | Readonly<{ schemaVersion: 1 | 2 }>
  | Readonly<{ schemaVersion: 3; successorEvidence: Readonly<{
      lineageDigest: string; snapshotDigest: string; reports: readonly AdmittedStandaloneSuccessorEvidence[];
    }> }>
) & Readonly<{
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

export type AdjudicatedStandaloneReview = StandaloneAggregateProtocol & Readonly<{
  readonly runId: string;
  readonly scope: readonly string[];
  readonly reviewerEvidence: readonly StandaloneReviewerEvidence[];
  readonly survivingCriticals: readonly Finding[];
  readonly advisories: readonly Finding[];
  readonly refutedCriticals: readonly RefutedFinding[];
  readonly panel: ParsedPanelOutcomes | null;
}>;

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
  authority: IssuedStandaloneReviewerProtocol,
  rawBytes: Uint8Array,
): StandaloneTranscriptAdmission {
  const parsed = parseIssuedReviewerEvidence(authority, rawBytes);
  if (parsed.ok || parsed.error.code !== "authority-unavailable") {
    if (authority.protocolVersion === 1 && authority.subject.kind === "standalone-review") {
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes); }
      catch { return Object.freeze({ ok: false, problems: Object.freeze([`${authority.request.role}: transcript is not valid UTF-8`]) }); }
      // Preserve historical rejection diagnostics; admitted evidence is never parsed a second time.
      if (!parsed.ok) {
        const historical = admitLegacyStandaloneTranscript(authority.subject.scope, text, authority.request.role);
        if (!historical.ok) return historical;
      }
    }
  }
  if (parsed.ok && parsed.value.kind === "standalone-review") return Object.freeze({ ok: true, findings: parsed.value.findings });
  return Object.freeze({ ok: false, problems: Object.freeze([parsed.ok ? "standalone reviewer authority required" : parsed.error.message]) });
}

/** Historical archive only; registered completion always consumes issued protocol authority. */
function admitLegacyStandaloneTranscript(
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
    const admission = admitLegacyStandaloneTranscript(scope, transcript.output, transcript.agent);
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

function standaloneReviewerEvidence(
  authority: FrozenStandaloneReviewAuthority,
  roster: CompleteRoster<AcceptedAgentResult<CapturedReviewerResult>>,
): ParseResult<readonly Readonly<{ agent: StandaloneReviewerRole; evidence: StandaloneReviewerEvidence }>[]> {
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
    return [{ agent: canonical.role as StandaloneReviewerRole, evidence }];
  });
  return errors.length > 0 ? fail(errors) : ok(Object.freeze(transcripts));
}

/** Canonical aggregation consumes only the exact opaque completion proof and its cached admission. */
export function aggregateStandaloneReview(input: {
  readonly authority: FrozenStandaloneReviewAuthority;
  readonly completion: StandaloneRosterCompletionProof;
}): ParseResult<StandaloneReviewState> {
  const { authority } = input;
  const resolved = resolveStandaloneRosterCompletion(authority, input.completion);
  if (!resolved.ok) return fail([resolved.error.message]);
  const evidence = standaloneReviewerEvidence(authority, resolved.value.roster);
  if (!evidence.ok) return evidence;
  const transcripts = evidence.value;
  if (authority.schemaVersion === 3) {
    const lineage = deriveStandaloneSuccessorLineage(authority.successor,
      resolved.value.roster.ordered.map(result => result.authority), resolved.value.successorReports, null);
    if (!lineage.ok) return fail([lineage.error.message]);
    const aggregate: StandaloneReviewAggregate = Object.freeze({ schemaVersion: 3, reviewerProtocol: authority.reviewerProtocol,
      successor: authority.successor, lineage: lineage.value, runId: authority.runId, subjectId: STANDALONE_REVIEW_SUBJECT,
      scope: authority.scope, reviewerEvidence: Object.freeze(transcripts.map(({ evidence }) => evidence)),
      findings: Object.freeze(lineage.value.inventory.map(findingOf)) });
    return ok(standaloneAggregateRoute(aggregate));
  }
  const findings = Object.freeze(transcripts.flatMap(({ agent }, index) => attributeFindings(resolved.value.findings[index]!.drafts, agent)));
  if (new Set(findings.map(({ id }) => id)).size !== findings.length) return fail(["attributed standalone finding ids must be distinct across review agents"]);
  const aggregate: StandaloneReviewAggregate = Object.freeze({
    ...standaloneProtocol(authority), runId: authority.runId, subjectId: STANDALONE_REVIEW_SUBJECT,
    scope: authority.scope, reviewerEvidence: Object.freeze(transcripts.map(({ evidence }) => evidence)), findings,
  });
  return ok(standaloneAggregateRoute(aggregate));
}

function standaloneAggregateRoute(aggregate: StandaloneReviewAggregate): StandaloneReviewState {
  const [head, ...tail] = standaloneCurrentPanelCriticals(aggregate);
  return head === undefined ? Object.freeze({ kind: "clean", aggregate })
    : Object.freeze({ kind: "requires-refutation", aggregate, criticals: Object.freeze([head, ...tail]) as NonEmpty<Finding> });
}

function standaloneProtocol(value: Exclude<StandaloneReviewProtocol, { schemaVersion: 3 }>): Exclude<StandaloneReviewProtocol, { schemaVersion: 3 }> {
  return value.schemaVersion === 2
    ? Object.freeze({ schemaVersion: 2, reviewerProtocol: value.reviewerProtocol })
    : Object.freeze({ schemaVersion: 1 });
}

function reviewerEvidenceValue(evidence: StandaloneReviewerEvidence) {
  return {
    authority_kind: evidence.authorityKind,
    agent: evidence.agent,
    slot_id: evidence.slotId,
    request_id: evidence.requestId,
    attempt: evidence.attempt,
    model_profile: evidence.modelProfile,
    context_digest: evidence.contextDigest,
    artifact: evidence.artifact,
  };
}

export function serializeStandaloneAggregate(aggregate: StandaloneReviewAggregate): string {
  return JSON.stringify({
    schema_version: aggregate.schemaVersion,
    ...(aggregate.schemaVersion !== 1 ? { reviewer_protocol: aggregate.reviewerProtocol } : {}),
    ...(aggregate.schemaVersion === 3 ? { successor: aggregate.successor, lineage: aggregate.lineage } : {}),
    run_id: aggregate.runId,
    subject_id: aggregate.subjectId,
    scope: aggregate.scope,
    reviewer_evidence: aggregate.reviewerEvidence.map(reviewerEvidenceValue),
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
    const slotId = parseSlotId(entry.slot_id);
    if (!slotId.ok) errors.push(`${path}.slot_id: ${slotId.error.message}`);
    const requestId = parseRequestId(entry.request_id);
    if (!requestId.ok) errors.push(`${path}.request_id: ${requestId.error.message}`);
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
    if (artifact.ok && typeof entry.agent === "string" && slotId.ok && requestId.ok &&
        (entry.attempt === 1 || entry.attempt === 2) && (entry.authority_kind === "request-bound" || entry.authority_kind === "legacy-slot-bound") &&
        (modelProfile === null || modelProfile.ok)) {
      evidence.push(Object.freeze({
        authorityKind: entry.authority_kind,
        agent: entry.agent as StandaloneReviewerRole,
        slotId: slotId.value,
        requestId: requestId.value,
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

export function parseStandaloneAggregate(raw: unknown, proof?: Readonly<{
  authority: FrozenStandaloneReviewAuthority; completion: StandaloneRosterCompletionProof;
}>): ParseResult<StandaloneReviewAggregate> {
  if (!isRecord(raw)) return fail(["standalone review aggregate must be an object"]);
  if (raw.schema_version === 3) {
    if (proof === undefined || proof.authority.schemaVersion !== 3) return fail(["v3 aggregate requires frozen successor and current roster proof"]);
    const rebuilt = aggregateStandaloneReview(proof);
    return rebuilt.ok && JSON.stringify(raw) === JSON.stringify(JSON.parse(serializeStandaloneAggregate(rebuilt.value.aggregate)))
      ? ok(rebuilt.value.aggregate) : fail(["v3 aggregate differs from independently re-proved current evidence"]);
  }
  // `reviewer_evidence` is ALLOWED but not REQUIRED, which is one exclusion,
  // not two passes: this used to run exactKeys over the required-only list,
  // strip every resulting error whose text merely CONTAINED
  // "reviewer_evidence" by substring, and then recompute unknown fields
  // against the correct list anyway.
  const errors = exactKeys(
    raw,
    ["schema_version", "run_id", "subject_id", "scope", "reviewer_evidence", "findings", ...(raw.schema_version === 2 ? ["reviewer_protocol"] : [])],
    "aggregate",
  ).filter((error) => raw.schema_version !== 1 || error !== "aggregate.reviewer_evidence is required");
  if (raw.schema_version !== 1 && raw.schema_version !== 2) errors.push("aggregate.schema_version must be 1 or 2");
  const descriptor = raw.schema_version === 2 ? parseReviewerProtocolDescriptor(raw.reviewer_protocol) : null;
  if (descriptor !== null && !descriptor.ok) errors.push(descriptor.error.message);
  const runId = typeof raw.run_id === "string" ? raw.run_id.trim() : "";
  if (runId === "") errors.push("aggregate.run_id must be non-empty");
  if (raw.subject_id !== STANDALONE_REVIEW_SUBJECT) errors.push(`aggregate.subject_id must be '${STANDALONE_REVIEW_SUBJECT}'`);
  const scope = parseStandaloneReviewScope(raw.scope, "aggregate.scope");
  if (!scope.ok) errors.push(...scope.errors);
  if (!Array.isArray(raw.findings)) errors.push("aggregate.findings must be an array");
  const findingError = findingsUnionError(raw.findings, "aggregate.findings");
  if (findingError !== null) errors.push(findingError);
  const findings = parseStoredFindings(raw.findings);
  if (findings.some((finding) => (finding.protocolVersion === 2) !== (raw.schema_version === 2))) {
    errors.push("aggregate Finding protocol differs from aggregate authority");
  }
  if (scope.ok) errors.push(...findingScopeErrors(scope.value, findings, "aggregate.findings"));
  const ids = findings.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) errors.push("aggregate finding ids must be distinct");
  const evidence = parseReviewerEvidence(raw.reviewer_evidence, runId, "aggregate.reviewer_evidence");
  if (!evidence.ok) errors.push(...evidence.errors);
  return errors.length > 0 || !scope.ok || !evidence.ok
    ? fail(errors)
    : ok(Object.freeze({
        ...(descriptor !== null && descriptor.ok ? { schemaVersion: 2 as const, reviewerProtocol: descriptor.value } : { schemaVersion: 1 as const }),
        runId, subjectId: STANDALONE_REVIEW_SUBJECT, scope: scope.value, reviewerEvidence: evidence.value, findings,
      }));
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
  return Object.freeze(criticals.map((finding): StandalonePanelFindingAuthority => {
    if (finding.protocolVersion === 2) {
      const projected = projectFindingForPanel(STANDALONE_REVIEW_SUBJECT, finding);
      if (projected.protocolVersion !== 2) throw new Error("current panel projection lost its protocol invariant");
      return projected;
    }
    return Object.freeze({
    id: `${STANDALONE_REVIEW_SUBJECT}:${finding.id}`,
    taskId: STANDALONE_REVIEW_SUBJECT,
    agent: sanitizeProse(finding.agent),
    severity: "critical" as const,
    // Sanitized for the same reason as `claim`: this record is substituted into
    // verifier prompts, and a path is just as much reviewer-controlled text as
    // the claim beside it. Mirrors `buildFindingBrief` in core/review-panel.
    file: finding.file === null ? null : sanitizeProse(finding.file) || null,
    line: finding.line,
    claim: sanitizeProse(finding.claim) || UNUSABLE_PANEL_CLAIM,
    });
  }));
}

export function canonicalStandalonePanelFindings(
  criticals: readonly Finding[],
): readonly Readonly<{ id: string; claim: string }>[] {
  return Object.freeze(canonicalStandalonePanelFindingAuthority(criticals).map(({ id, claim }) =>
    Object.freeze({ id, claim })));
}

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
  const criticals = standaloneCurrentPanelCriticals(input.aggregate);
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
    ...(input.aggregate.schemaVersion === 3 ? { schemaVersion: 3 as const, successorEvidence: canonicalRecord({
      lineageDigest: input.aggregate.successor.lineageDigest, snapshotDigest: input.aggregate.successor.snapshotDigest,
      reports: input.aggregate.lineage.reports,
    }) } : { schemaVersion: input.aggregate.schemaVersion }),
    kind: "frozen-standalone-panel-authority" as const,
    standaloneRunId: standaloneRunId.value,
    panelRunId: panelRunId.value,
    findings: Object.freeze([firstFinding, ...otherFindings]) as NonEmpty<StandalonePanelFindingAuthority>,
    findingBriefDigest: canonicalDigest(expectedFindings),
    lenses: Object.freeze([firstLens, ...otherLenses]) as NonEmpty<string>,
    manifestDigest: manifestDigest.value,
    threshold: input.threshold as number,
  });
  return resultOk(authority);
}

/** Reparse persisted panel read authority against the immutable aggregate artifact. */
export function parseFrozenStandalonePanelAuthority(
  raw: unknown,
  aggregate: StandaloneReviewAggregate,
): DomainResult<FrozenStandalonePanelAuthority, StandalonePanelAuthorityError> {
  if (!isRecord(raw) || raw.schemaVersion !== aggregate.schemaVersion || raw.kind !== "frozen-standalone-panel-authority") {
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
    let claim = typeof entry.claim === "string" ? entry.claim : "";
    if (finding?.protocolVersion !== 2) claim = claim.trim();
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

/** Only new criticals and evidence-bound reopening proposals belong to the current panel. */
export function standaloneCurrentPanelCriticals(aggregate: StandaloneReviewAggregate): readonly Finding[] {
  if (aggregate.schemaVersion !== 3) return aggregate.findings.filter(finding => finding.severity === "critical");
  return aggregate.lineage.inventory.flatMap((row, index) => aggregate.lineage.dispositions[index]!.state === "pending-panel" ? [findingOf(row)] : []);
}

function finalizeStandaloneSuccessor(aggregate: Extract<StandaloneReviewAggregate, { schemaVersion: 3 }>,
  panel: ParsedPanelOutcomes | null): ParseResult<AdjudicatedStandaloneReview> {
  const criticals = standaloneCurrentPanelCriticals(aggregate);
  if ((criticals.length === 0) !== (panel === null)) return fail(["successor requires exactly its current critical panel work"]);
  if (panel !== null && (panel.outcomes.length !== criticals.length || criticals.some(finding =>
      !panel.outcomes.some(outcome => outcome.findingId === `${STANDALONE_REVIEW_SUBJECT}:${finding.id}`)))) return fail(["successor panel coverage differs from fresh work"]);
  const lineage = deriveStandaloneSuccessorLineage(aggregate.successor,
    aggregate.lineage.reports.map(report => report.request), aggregate.lineage.reports, panel);
  if (!lineage.ok) return fail([lineage.error.message]);
  const survivingCriticals: Finding[] = [];
  const refutedCriticals: RefutedFinding[] = [];
  const advisories: Finding[] = [];
  for (const [index, row] of lineage.value.inventory.entries()) {
    const finding = findingOf(row);
    const state = lineage.value.dispositions[index]!.state;
    if (finding.severity === "advisory") advisories.push(finding);
    else if (state === "active") survivingCriticals.push(finding);
    else if (state === "refuted") {
      const decision = row.history.at(-1);
      if (decision?.kind !== "adjudication" || decision.refutations.length === 0) return fail(["refuted history lacks its original votes"]);
      refutedCriticals.push(Object.freeze({ finding, refutations: decision.refutations as NonEmpty<PanelRefutation> }));
    }
  }
  return ok(Object.freeze({ schemaVersion: 3, reviewerProtocol: aggregate.reviewerProtocol,
    successor: aggregate.successor, lineage: lineage.value, runId: aggregate.runId, scope: aggregate.scope,
    reviewerEvidence: aggregate.reviewerEvidence, survivingCriticals: Object.freeze(survivingCriticals),
    advisories: Object.freeze(advisories), refutedCriticals: Object.freeze(refutedCriticals), panel }));
}

/** Legacy v1/v2 finalization: a critical can only be surviving or audibly refuted. */
export function finalizeStandaloneReview(
  aggregate: StandaloneReviewAggregate,
  panel: ParsedPanelOutcomes | null,
): ParseResult<AdjudicatedStandaloneReview> {
  if (aggregate.schemaVersion === 3) return finalizeStandaloneSuccessor(aggregate, panel);
  const criticals = aggregate.findings.filter((finding) => finding.severity === "critical");
  const advisories = Object.freeze(aggregate.findings.filter((finding) => finding.severity === "advisory"));
  if (criticals.length === 0) {
    return panel === null
      ? ok(Object.freeze({
          ...standaloneProtocol(aggregate),
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
    ...standaloneProtocol(aggregate),
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
    ...(result.schemaVersion !== 1 ? { reviewer_protocol: result.reviewerProtocol } : {}),
    ...(result.schemaVersion === 3 ? { successor: result.successor, lineage: result.lineage } : {}),
    run_id: result.runId,
    subject_id: STANDALONE_REVIEW_SUBJECT,
    scope: result.scope,
    reviewer_evidence: result.reviewerEvidence.map(reviewerEvidenceValue),
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
export function serializeHistoricalAdjudicatedStandaloneReview(result: Extract<AdjudicatedStandaloneReview, { schemaVersion: 1 }>): string {
  const versioned = JSON.parse(serializeAdjudicatedStandaloneReview(result)) as Record<string, unknown>;
  const {
    schema_version: _schemaVersion,
    subject_id: _subjectId,
    reviewer_evidence: _reviewerEvidence,
    ...historical
  } = versioned;
  return JSON.stringify(historical, null, 2);
}

function summaryData(value: unknown): string {
  return JSON.stringify(value).replace(/[&<>|`]/g, (character) => `&#${character.codePointAt(0)};`)
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`)
    .replace(/([*_\[\]\\])/g, "\\$1");
}

function renderStandaloneSuccessorSummary(result: Extract<AdjudicatedStandaloneReview, { schemaVersion: 3 }>): string {
  const { counts, currentCriticalCoverage, inventory, dispositions } = result.lineage;
  const policy = result.successor.disposition;
  return [
    `Standalone successor: ${counts.new} new; ${counts.inherited} inherited; ${counts.total} total Findings.`,
    `Current dispositions: ${counts.survivingCritical} surviving critical; ${counts.refutedCritical} refuted critical; ${counts.resolved} resolved; ${counts.advisory} advisory.`,
    `Current critical coverage: ${currentCriticalCoverage.kind}; ${counts.currentCriticalCoverageLimited} limited origins.`,
    "Advisory policy is DECLARED; Repair-Checked is not semantic resolution. Original assertions and historical decisions remain retained.", "",
    "| State | Provenance | ID | Origin | Original Run | Severity | Location | Claim | Advisory policy |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...inventory.map((row, index) => {
      const finding = findingOf(row);
      const origin = standaloneOriginReference(row.origin);
      const decision = policy.kind === "selected-record" ? policy.disposition.record.entries.find(entry => entry.origin === origin) : undefined;
      return `| ${dispositions[index]!.state} | ${dispositions[index]!.provenance} | ${summaryData(finding.id)} | ${origin} | ${summaryData(row.origin.runId)} | ${finding.severity} | ${summaryData({ file: finding.file, line: finding.line })} | ${summaryData(finding.claim)} | ${summaryData(decision ?? policy.kind)} |`;
    }), "",
    ...inventory.map(row => `${summaryData(row.finding.id)} retained detail: ${summaryData({ origin: row.origin,
      finding: row.finding, history: row.history, assessment: result.lineage.assessments.find(entry => entry.origin === standaloneOriginReference(row.origin)) ?? null })}`),
  ].join("\n");
}

/** Human read model only: emitted and surviving counts have distinct, derived meanings. */
export function renderStandaloneReviewSummary(result: AdjudicatedStandaloneReview): string {
  if (result.schemaVersion === 3) return renderStandaloneSuccessorSummary(result);
  const rows = [
    ...result.survivingCriticals.map((finding) => ({ disposition: "surviving", finding })),
    ...result.refutedCriticals.map(({ finding }) => ({ disposition: "refuted", finding })),
    ...result.advisories.map((finding) => ({ disposition: "advisory", finding })),
  ];
  const counts = reviewFindingCounts(rows.map(({ finding }) => finding));
  return [
    `Emitted/admitted: ${counts.critical} critical; ${counts.advisory} advisory.`,
    `After refutation: ${result.survivingCriticals.length} surviving critical; ${result.refutedCriticals.length} refuted critical; ${result.advisories.length} advisory.`,
    "", "| Disposition | ID | Reviewer | Severity | Location | Claim |", "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(({ disposition, finding }) =>
      `| ${disposition} | ${summaryData(finding.id)} | ${summaryData(finding.agent)} | ${finding.severity} | ${summaryData({ file: finding.file, line: finding.line })} | ${summaryData(finding.claim)} |`),
    "",
    ...rows.flatMap(({ finding }) => finding.protocolVersion !== 2 ? [] : [
      `${summaryData(finding.id)} detail: ${summaryData(finding.severity === "critical"
        ? { basis: finding.basis } : { reason: finding.reason, basis: finding.basis })}`,
    ]),
  ].join("\n");
}

// Finding Origin, disposition and successor preparation share publication custody with LC-2.
type StandaloneLineageError = Readonly<{
  kind: "standalone-lineage-rejected";
  code: "invalid-data" | "limit-exceeded" | "source-unavailable" | "identity-mismatch" | "invalid-history" |
    "invalid-disposition" | "scope-narrowed" | "roster-narrowed" | "invalid-assessments" | "ordinal-exhausted";
  message: string;
}>;
const rejectLineage = (code: StandaloneLineageError["code"], message: string): DomainResult<never, StandaloneLineageError> =>
  failure(canonicalRecord({ kind: "standalone-lineage-rejected", code, message }));
const freeze = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);

/** Content reference, not authority; current origins have no forward result-digest reference. */
export const standaloneOriginReference = (origin: FindingOrigin): string => origin.kind === "published" ? canonicalDigest(origin) : canonicalDigest({ kind: "current",
  runId: origin.runId, requestId: origin.requestId, transcriptDigest: origin.transcriptDigest,
  role: origin.role, ordinal: origin.ordinal });
export const standaloneDecisionReference = (decision: StandaloneLineageRow["history"][number]): string => canonicalDigest(decision);

export function parseFindingOrigin(raw: unknown): DomainResult<FindingOrigin, StandaloneLineageError> {
  const inspected = readExactDataRecord(raw, ["kind", "runId", "requestId", "transcriptDigest", "role", "ordinal", "publication"], "Finding Origin");
  if (!inspected.ok) return rejectLineage("invalid-data", "Finding Origin must contain only own data fields.");
  const value = inspected.value;
  const publication = value.kind === "published" || value.kind === "published-successor"
    ? readExactDataRecord(value.publication, ["locator", "runId", "resultDigest"], "original publication") : success(undefined);
  if (!publication.ok) return rejectLineage("invalid-data", "Original publication must contain only own data fields.");
  const parsed = findingOriginSchema.safeParse(value.kind !== "current" ? { ...value, publication: publication.value } : value);
  if (!parsed.success) return rejectLineage("invalid-data", "Finding Origin is malformed.");
  if (parsed.data.kind !== "current" && parsed.data.runId !== parsed.data.publication.runId) {
    return rejectLineage("identity-mismatch", "Origin and original publication must name the same Run.");
  }
  return success(parsed.data);
}

function historyProblem(row: StandaloneLineageRow): boolean {
  return row.history.some(decision => match(decision)
    .with({ kind: "adjudication" }, value => {
      const votes = [...value.refutations.map(vote => vote.lens), ...value.upheldBy, ...value.uncertainFrom];
      return findingOf(row).severity !== "critical" || new Set(value.lenses).size !== value.lenses.length ||
        new Set(votes).size !== votes.length || votes.length !== value.lenses.length ||
        votes.some(lens => !value.lenses.includes(lens)) ||
        value.threshold < Math.floor(value.lenses.length / 2) + 1 || value.threshold > value.lenses.length ||
        value.survives !== (value.refutations.length < value.threshold);
    })
    .with({ kind: "resolution" }, { kind: "successor-resolution" }, value => new Set(value.assessments.map(entry => entry.role)).size !== value.assessments.length ||
      new Set(value.assessments.map(entry => entry.requestId)).size !== value.assessments.length)
    .exhaustive());
}

export function findingOf(row: StandaloneLineageRow): Finding {
  return "draft" in row.finding
    ? canonicalRecord({ ...row.finding.draft, protocolVersion: 2, id: row.finding.id, agent: row.finding.agent })
    : row.finding;
}

/** Bounded immutable data reader. Its output cannot be substituted for an authenticated source. */
export function parseStandaloneLineageInventory(bytes: Uint8Array): DomainResult<readonly StandaloneLineageRow[], StandaloneLineageError> {
  const decoded = parseBoundedReviewerJson(bytes, STANDALONE_LINEAGE_LIMITS.retainedBytes);
  if (!decoded.ok) return rejectLineage(decoded.error.code === "payload-too-large" ? "limit-exceeded" : "invalid-data", decoded.error.message);
  if (!Array.isArray(decoded.value) || decoded.value.length > STANDALONE_LINEAGE_LIMITS.inventory || decoded.value.some(row =>
    isRecord(row) && Array.isArray(row.history) && row.history.length > STANDALONE_LINEAGE_LIMITS.historyPerOrigin)) {
    return rejectLineage("limit-exceeded", "Inventory/history count exceeds its pre-copy budget.");
  }
  const parsed = standaloneLineageInventorySchema.safeParse(decoded.value);
  if (!parsed.success) return rejectLineage("invalid-data", "Lineage inventory does not conform to its bounded grammar.");
  const seen = new Set<string>();
  for (const row of parsed.data) {
    const origin = parseFindingOrigin(row.origin);
    const key = standaloneOriginReference(row.origin);
    if (!origin.ok || seen.has(key) || row.finding.id !== `${row.origin.role}-${row.origin.ordinal}` || row.finding.agent !== row.origin.role) {
      return rejectLineage("identity-mismatch", "Inventory must preserve unique full origins and exact engine-attributed IDs/roles.");
    }
    seen.add(key);
    if (historyProblem(row)) return rejectLineage("invalid-history", "Historical decisions must preserve full votes and strict-majority outcomes.");
  }
  return success(parsed.data);
}

type StandaloneSuccessorReviewHistory = Readonly<{
  publication: StandalonePublicationReference; runId: string; snapshotDigest: string; lineageDigest: string;
  reports: StandaloneSuccessorLineage["reports"]; assessments: StandaloneSuccessorLineage["assessments"];
  currentCriticalCoverage: StandaloneSuccessorLineage["currentCriticalCoverage"];
  disposition: StandaloneDispositionSelection;
}>;
declare const sourceBrand: unique symbol;
export type StandaloneLineageSource = Readonly<{
  [sourceBrand]: true; publication: StandalonePublicationReference; inventory: readonly StandaloneLineageRow[];
  scope: readonly string[]; reviewers: readonly string[]; snapshot: StandalonePreviousSnapshot;
  reviewHistory: readonly StandaloneSuccessorReviewHistory[];
}>;
const sources = new WeakSet<object>();
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function storedFinding(finding: Finding, agent: FindingOrigin["role"]): StandaloneLineageRow["finding"] {
  if (finding.protocolVersion !== 2) return canonicalRecord({ ...finding, agent });
  const { id, protocolVersion, agent: _agent, ...draft } = finding;
  return canonicalRecord({ id, agent, protocolVersion, draft });
}

/** The shell supplies the no-follow authenticated locator; LC-2 membership proves publication.
 * A successor's local origins/decisions receive enclosing publication exactly once at this join.
 */
export function prepareStandaloneLineageSource(result: AuthoritativeStandaloneReviewResult, locator: string,
  observedSnapshot?: StandalonePreviousSnapshot,
): DomainResult<StandaloneLineageSource, StandaloneLineageError> {
  if (!isAuthoritativeStandaloneReviewResult(result)) return rejectLineage("source-unavailable", "Lineage requires an LC-2 published result, not self-consistent result bytes.");
  const count = result.schemaVersion === 3 ? result.lineage.inventory.length
    : result.survivingCriticals.length + result.refutedCriticals.length + result.advisories.length;
  if (count > STANDALONE_LINEAGE_LIMITS.inventory || result.scope.length > STANDALONE_LINEAGE_LIMITS.paths ||
      (observedSnapshot !== undefined && observedSnapshot.length > STANDALONE_LINEAGE_LIMITS.paths)) {
    return rejectLineage("limit-exceeded", "Source inventory or observed scope exceeds its 4096-entry budget.");
  }
  const published = readStandaloneReviewPublication(result, STANDALONE_LINEAGE_LIMITS.retainedBytes);
  if (!published.ok) return rejectLineage("source-unavailable", published.error.message);
  const publication = standalonePublicationReferenceSchema.safeParse({ locator, runId: result.runId, resultDigest: published.value.digest });
  if (!publication.success) return rejectLineage("invalid-data", "Source publication locator or identity is malformed.");
  if (result.schemaVersion === 3) {
    const rows = result.lineage.inventory.map(row => canonicalRecord({ ...row,
      origin: row.origin.kind === "current" ? canonicalRecord({ ...row.origin, kind: "published-successor" as const, publication: publication.data }) : row.origin,
      history: freeze(row.history.map(decision => "kind" in decision.publication
        ? canonicalRecord({ ...decision, publication: publication.data }) : decision)),
    }));
    const inventory = parseStandaloneLineageInventory(bytes(rows));
    if (!inventory.ok) return inventory;
    if (observedSnapshot !== undefined && !canonicalStructuralEquals(observedSnapshot, result.successor.snapshot)) {
      return rejectLineage("identity-mismatch", "V3 source observation differs from its frozen published snapshot.");
    }
    const source: Omit<StandaloneLineageSource, typeof sourceBrand> = canonicalRecord({ publication: publication.data, inventory: inventory.value,
      snapshot: result.successor.snapshot, scope: result.scope, reviewers: result.successor.reviewers,
      reviewHistory: freeze([...result.successor.reviewHistory, canonicalRecord({ publication: publication.data,
        runId: result.runId, snapshotDigest: result.successor.snapshotDigest, lineageDigest: result.successor.lineageDigest,
        reports: result.lineage.reports, assessments: result.lineage.assessments, currentCriticalCoverage: result.lineage.currentCriticalCoverage,
        disposition: result.successor.disposition })]) });
    const minted = source as StandaloneLineageSource;
    sources.add(minted);
    return success(minted);
  }
  const findings = [...result.survivingCriticals, ...result.refutedCriticals.map(row => row.finding), ...result.advisories];
  const rows: StandaloneLineageRow[] = [];
  for (const evidence of result.reviewerEvidence) {
    const attributed = findings.filter(finding => finding.agent === evidence.agent).sort((a, b) => Number(a.id.split("-").at(-1)) - Number(b.id.split("-").at(-1)));
    for (const finding of attributed) {
      const origin = parseFindingOrigin({ kind: "published", runId: result.runId, requestId: evidence.requestId,
        transcriptDigest: evidence.artifact.digest, role: evidence.agent, ordinal: Number(finding.id.split("-").at(-1)), publication: publication.data });
      if (!origin.ok) return origin;
      const outcome = result.panel?.outcomes.find(row => row.findingId === `standalone-review:${finding.id}`);
      const history = outcome === undefined || result.panel === null ? [] : [{ kind: "adjudication" as const,
        publication: publication.data, lenses: result.panel.lenses, threshold: result.panel.threshold,
        survives: outcome.survives, refutations: outcome.refutations, upheldBy: outcome.upheldBy, uncertainFrom: outcome.uncertainFrom }];
      rows.push(canonicalRecord({ origin: origin.value, finding: storedFinding(finding, origin.value.role), history: freeze(history) }));
    }
  }
  if (rows.length !== count) return rejectLineage("identity-mismatch", "Every original Finding must join one accepted reviewer transcript.");
  const inventory = parseStandaloneLineageInventory(bytes(rows));
  if (!inventory.ok) return inventory;
  const snapshot = standalonePreviousSnapshotSchema.safeParse(observedSnapshot ?? result.scope.map(path => ({ kind: "historical-unknown", path })));
  if (!snapshot.success || !canonicalStructuralEquals(snapshot.data.map(row => row.path), result.scope)) {
    return rejectLineage("identity-mismatch", "Observed predecessor snapshot must cover its exact published scope in order.");
  }
  const source: Omit<StandaloneLineageSource, typeof sourceBrand> = canonicalRecord({ publication: publication.data, inventory: inventory.value, snapshot: snapshot.data,
    scope: freeze(result.scope), reviewers: freeze(result.reviewerEvidence.map(row => row.agent)), reviewHistory: freeze([]) });
  const minted = source as StandaloneLineageSource;
  sources.add(minted);
  return success(minted);
}

declare const dispositionBrand: unique symbol;
export type PreparedStandaloneDisposition = Readonly<{ [dispositionBrand]: true; record: StandaloneDispositionRecord; digest: string }>;
const dispositions = new WeakMap<object, readonly StandaloneDispositionRevision[]>();
/** Complete DECLARED policy data; corrections consume receipt-backed previous authority. */
export function prepareStandaloneDisposition(source: StandaloneLineageSource, input: Uint8Array,
  previous?: PublishedStandaloneDisposition,
): DomainResult<PreparedStandaloneDisposition, StandaloneLineageError> {
  if (!sources.has(source)) return rejectLineage("source-unavailable", "Disposition requires the exact prepared published source.");
  const decoded = parseBoundedReviewerJson(input, STANDALONE_LINEAGE_LIMITS.retainedBytes);
  if (!decoded.ok) return rejectLineage("invalid-data", decoded.error.message);
  if (isRecord(decoded.value) && Array.isArray(decoded.value.entries) && decoded.value.entries.length > STANDALONE_LINEAGE_LIMITS.inventory) {
    return rejectLineage("limit-exceeded", "Disposition inventory exceeds its pre-copy budget.");
  }
  const parsed = standaloneDispositionSchema.safeParse(decoded.value);
  if (!parsed.success) return rejectLineage("invalid-disposition", "Disposition record must contain complete bounded DECLARED policy.");
  const record = parsed.data;
  const advisories = source.inventory.filter(row => findingOf(row).severity === "advisory").map(row => standaloneOriginReference(row.origin));
  if (!canonicalStructuralEquals(record.source, source.publication) || record.entries.length !== advisories.length ||
      record.entries.some((row, index) => row.origin !== advisories[index])) return rejectLineage("invalid-disposition", "Policy must cover every advisory exactly once in source order, and no critical.");
  if (record.revision.kind === "correction") {
    if (previous === undefined || !publishedDispositions.has(previous) || record.revision.previousDigest !== previous.digest ||
        !canonicalStructuralEquals(previous.record.source, record.source)) return rejectLineage("invalid-disposition", "Correction must name the exact prior revision of this source.");
  } else if (previous !== undefined) return rejectLineage("invalid-disposition", "Only a correction may supply a prior revision.");
  if (previous !== undefined && previous.history.length >= STANDALONE_LINEAGE_LIMITS.historyPerOrigin - 1) {
    return rejectLineage("limit-exceeded", "Disposition chain exceeds 64 exact revisions.");
  }
  const dispositionDigest: string = canonicalDigest(record);
  const prepared = canonicalRecord({ record, digest: dispositionDigest }) as PreparedStandaloneDisposition;
  dispositions.set(prepared, previous === undefined ? freeze([]) : freeze([...previous.history,
    canonicalRecord({ record: previous.record, digest: previous.digest, publication: previous.publication })]));
  return success(prepared);
}

export type StandaloneDispositionPublicationReference = Readonly<{ locator: string; runId: string; dispositionDigest: string }>;
type StandaloneDispositionRevision = Readonly<{
  record: StandaloneDispositionRecord; digest: string; publication: StandaloneDispositionPublicationReference }>;
declare const publishedDispositionBrand: unique symbol;
export type PublishedStandaloneDisposition = StandaloneDispositionRevision & Readonly<{ [publishedDispositionBrand]: true;
  history: readonly StandaloneDispositionRevision[] }>;
const publishedDispositions = new WeakSet<object>();
/** Port evidence is observed by the shell (or an in-memory adapter), never inferred from a self-hash. */
export type StandaloneDispositionPublicationReader = (reference: StandaloneDispositionPublicationReference) => DomainResult<
  Readonly<{ receipt: unknown; recordBytes: Uint8Array }>, Readonly<{ message: string }>>;

export function readPublishedStandaloneDisposition(prepared: PreparedStandaloneDisposition,
  reference: StandaloneDispositionPublicationReference, read: StandaloneDispositionPublicationReader,
): DomainResult<PublishedStandaloneDisposition, StandaloneLineageError> {
  if (!dispositions.has(prepared)) return rejectLineage("invalid-disposition", "Publication requires a prepared declaration.");
  const referenceFields = readExactDataRecord(reference, ["locator", "runId", "dispositionDigest"], "disposition publication reference");
  if (!referenceFields.ok) return rejectLineage("invalid-disposition", "Publication reference must contain only own data fields.");
  const parsedReference = standalonePublicationReferenceSchema.safeParse({ locator: referenceFields.value.locator, runId: referenceFields.value.runId, resultDigest: referenceFields.value.dispositionDigest });
  if (!parsedReference.success || parsedReference.data.resultDigest !== prepared.digest) return rejectLineage("invalid-disposition", "Selected publication revision differs from the declaration.");
  const lookup = canonicalRecord({ locator: parsedReference.data.locator, runId: parsedReference.data.runId, dispositionDigest: prepared.digest });
  const observed = read(lookup);
  if (!observed.ok) return rejectLineage("source-unavailable", observed.error.message);
  if (observed.value.recordBytes.byteLength > STANDALONE_LINEAGE_LIMITS.retainedBytes) return rejectLineage("limit-exceeded", "Published disposition exceeds byte budget.");
  const expected = bytes(prepared.record);
  if (expected.length !== observed.value.recordBytes.length || expected.some((byte, index) => byte !== observed.value.recordBytes[index])) return rejectLineage("invalid-disposition", "Published disposition bytes differ from registered declaration.");
  const receipt = parseEffectReceipt(observed.value.receipt);
  if (!receipt.ok || receipt.value.kind !== "artifact-set-published" || receipt.value.runId !== lookup.runId ||
      receipt.value.effectId !== `effect:standalone-disposition:${prepared.digest}` || receipt.value.artifacts.length !== 1) return rejectLineage("invalid-disposition", "Disposition receipt does not match its exact Run/effect.");
  const artifact = receipt.value.artifacts[0];
  if (artifact.runId !== lookup.runId || artifact.slot.path !== "artifacts/disposition.json" || artifact.digest !== prepared.digest || artifact.byteLength !== expected.length) return rejectLineage("invalid-disposition", "Disposition receipt differs from exact published bytes.");
  const published = canonicalRecord({ record: prepared.record, digest: prepared.digest,
    publication: lookup, history: dispositions.get(prepared)! }) as PublishedStandaloneDisposition;
  publishedDispositions.add(published);
  return success(published);
}

export type StandaloneDispositionSelection =
  | Readonly<{ kind: "historical-decision-unavailable" }>
  | Readonly<{ kind: "selected-record"; disposition: PublishedStandaloneDisposition }>;

function freezeDispositionSelection(selection: StandaloneDispositionSelection): StandaloneDispositionSelection {
  return selection.kind === "selected-record"
    ? canonicalRecord({ kind: "selected-record", disposition: selection.disposition })
    : canonicalRecord({ kind: "historical-decision-unavailable" });
}

/** Read-only publication inventory. References and counts are engine projections, never parent arithmetic. */
export function projectStandaloneLineageSource(source: StandaloneLineageSource, selection: StandaloneDispositionSelection) {
  if (!sources.has(source)) return rejectLineage("source-unavailable", "Source inspection requires published source membership.");
  if (selection.kind === "selected-record" && (!publishedDispositions.has(selection.disposition) ||
      !canonicalStructuralEquals(selection.disposition.record.source, source.publication))) {
    return rejectLineage("invalid-disposition", "Source inspection requires the exact selected published disposition.");
  }
  const revisions = selection.kind === "selected-record" ? [...selection.disposition.history, selection.disposition] : [];
  const policies = revisions.map(revision => ({ revision,
    entries: new Map(revision.record.entries.map(entry => [entry.origin, entry] as const)) }));
  const inventory = freeze(source.inventory.map(row => {
    const originReference = standaloneOriginReference(row.origin);
    const finding = findingOf(row);
    const latest = row.history.at(-1);
    const state = match(latest)
      .with(undefined, () => "active" as const)
      .with({ kind: "resolution" }, { kind: "successor-resolution" }, () => "resolved" as const)
      .with({ kind: "adjudication" }, decision => decision.survives ? "active" as const : "refuted" as const)
      .exhaustive();
    const policy = freeze(policies.flatMap(({ revision, entries }) => {
      const entry = entries.get(originReference);
      return entry === undefined ? [] : [canonicalRecord({ publication: revision.publication, digest: revision.digest,
        provenance: revision.record.provenance, ...entry })];
    }));
    return canonicalRecord({ originReference, origin: row.origin, finding, state, history: row.history,
      decisionReferences: freeze(row.history.map(standaloneDecisionReference)), policy });
  }));
  return success(canonicalRecord({ schemaVersion: 1 as const, kind: "standalone-lineage-source" as const,
    source: source.publication, scope: source.scope, reviewers: source.reviewers, snapshot: source.snapshot,
    disposition: freezeDispositionSelection(selection), inventory,
    counts: canonicalRecord({ total: inventory.length,
      survivingCritical: inventory.filter(row => row.finding.severity === "critical" && row.state === "active").length,
      refutedCritical: inventory.filter(row => row.finding.severity === "critical" && row.state === "refuted").length,
      resolved: inventory.filter(row => row.state === "resolved").length,
      advisory: inventory.filter(row => row.finding.severity === "advisory").length }),
    advisoryInventory: freeze(inventory.filter(row => row.finding.severity === "advisory").map(row => canonicalRecord({
      origin: row.originReference, findingId: row.finding.id }))),
  }));
}

declare const successorBrand: unique symbol;
export type PreparedStandaloneSuccessor = Readonly<{
  [successorBrand]: true; runId: string; source: StandalonePublicationReference;
  inventory: readonly StandaloneLineageRow[]; disposition: StandaloneDispositionSelection;
  snapshot: StandaloneSnapshot; previousSnapshot: StandalonePreviousSnapshot;
  reviewHistory: readonly StandaloneSuccessorReviewHistory[];
  snapshotDigest: string; reviewers: readonly [FindingOrigin["role"], ...FindingOrigin["role"][]]; lineageDigest: string;
}>;
const successors = new WeakSet<object>();
const isPreparedStandaloneSuccessor = (value: PreparedStandaloneSuccessor): boolean => successors.has(value);

/** Preparation consumes nominal published policy; a prepared but unpublished declaration cannot select policy. */
export function prepareStandaloneSuccessor(source: StandaloneLineageSource, input: Uint8Array,
  disposition: StandaloneDispositionSelection,
): DomainResult<PreparedStandaloneSuccessor, StandaloneLineageError> {
  if (!sources.has(source)) return rejectLineage("source-unavailable", "Successor requires a prepared published predecessor.");
  if (source.reviewHistory.length >= STANDALONE_LINEAGE_LIMITS.historyPerOrigin) return rejectLineage("limit-exceeded", "Successor chain exceeds 64 retained current review generations.");
  const decoded = parseBoundedReviewerJson(input, STANDALONE_LINEAGE_LIMITS.retainedBytes);
  if (!decoded.ok) return rejectLineage("invalid-data", decoded.error.message);
  if (isRecord(decoded.value) && Array.isArray(decoded.value.snapshot) && decoded.value.snapshot.length > STANDALONE_LINEAGE_LIMITS.paths) {
    return rejectLineage("limit-exceeded", "Successor snapshot exceeds its pre-copy path budget.");
  }
  const selection = standaloneSuccessorSelectionSchema.safeParse(decoded.value);
  if (!selection.success) return rejectLineage("invalid-data", "Successor selection is malformed.");
  const { runId, snapshot, reviewers } = selection.data;
  if (runId === source.publication.runId) return rejectLineage("identity-mismatch", "A successor requires a fresh Run identity.");
  const scope = snapshot.map(row => row.path);
  if (new Set(scope).size !== scope.length || source.scope.some(path => !scope.includes(path)) || snapshot.some(row => row.kind === "historical-unknown")) {
    return rejectLineage("scope-narrowed", "Successor must freeze known bytes/absence for every predecessor path; scope may only expand.");
  }
  if (new Set(reviewers).size !== reviewers.length || source.reviewers.some(role => !reviewers.some(current => current === role))) {
    return rejectLineage("roster-narrowed", "Successor must retain all predecessor reviewer roles without duplicates.");
  }
  if (disposition.kind === "selected-record" && (!publishedDispositions.has(disposition.disposition) ||
      !canonicalStructuralEquals(disposition.disposition.record.source, source.publication))) {
    return rejectLineage("invalid-disposition", "Selected policy must be the exact published revision of this source.");
  }
  const frozenPolicy = freezeDispositionSelection(disposition);
  const snapshotDigest: string = canonicalDigest(snapshot);
  const base = canonicalRecord({ runId, source: source.publication, inventory: source.inventory, disposition: frozenPolicy,
    snapshot, previousSnapshot: source.snapshot, reviewHistory: source.reviewHistory, snapshotDigest, reviewers });
  const successorLineageDigest: string = canonicalDigest(base);
  const minimum = { schemaVersion: 3, kind: "standalone-successor-review", lineageDigest: successorLineageDigest, snapshotDigest: base.snapshotDigest,
    priorAssessments: source.inventory.map(row => ({ origin: standaloneOriginReference(row.origin), verdict: "not-assessable", reason: "x" })), findings: [] };
  if (bytes(minimum).length > STANDALONE_LINEAGE_LIMITS.responseBytes || bytes(base).length > STANDALONE_LINEAGE_LIMITS.retainedBytes) {
    return rejectLineage("limit-exceeded", "Successor lineage or minimum exact coverage exceeds its byte budget.");
  }
  const prepared = canonicalRecord({ ...base, lineageDigest: successorLineageDigest }) as PreparedStandaloneSuccessor;
  successors.add(prepared);
  return success(prepared);
}

function active(prepared: PreparedStandaloneSuccessor, row: StandaloneLineageRow): boolean {
  const policy = prepared.disposition;
  if (policy.kind === "selected-record" && policy.disposition.record.entries.some(entry =>
    entry.origin === standaloneOriginReference(row.origin) && entry.decision === "dismissed")) return false;
  const latest = row.history.at(-1);
  return latest === undefined || (latest.kind === "adjudication" && latest.survives);
}
function decisionReferences(prepared: PreparedStandaloneSuccessor, row: StandaloneLineageRow): readonly string[] {
  const historical = row.history.map(standaloneDecisionReference);
  const policy = prepared.disposition;
  if (policy.kind !== "selected-record") return historical;
  return [...historical, ...[...policy.disposition.history, policy.disposition].filter(revision =>
    revision.record.entries.some(entry => entry.origin === standaloneOriginReference(row.origin))).map(revision => revision.digest)];
}

/** Unknown historical inputs leave relevance a reviewer assertion, not an engine-observed change. */
function changedStandaloneInput(prepared: PreparedStandaloneSuccessor, path: string): "observed-changed" | "historical-unknown" | "unchanged" {
  const current = prepared.snapshot.find(entry => entry.path === path);
  if (current === undefined) return "unchanged";
  const previous = prepared.previousSnapshot.find(entry => entry.path === path);
  if (previous === undefined || previous.kind === "historical-unknown") return "historical-unknown";
  if (current.kind !== previous.kind) return "observed-changed";
  if (current.kind === "present" && previous.kind === "present") {
    // An unobserved mode cannot certify either equality or a mode-only repair.
    return current.digest !== previous.digest || (previous.mode !== null && current.mode !== previous.mode)
      ? "observed-changed" : "unchanged";
  }
  return "unchanged";
}

/** Atomic semantic join; the issued-request layer adds reviewer/request/transcript provenance. */
export function assessStandaloneSuccessor(prepared: PreparedStandaloneSuccessor, payload: StandaloneReviewerPayloadV3): DomainResult<StandaloneReviewerPayloadV3, StandaloneLineageError> {
  if (!successors.has(prepared)) return rejectLineage("source-unavailable", "Assessments require parser-prepared successor data.");
  if (payload.lineageDigest !== prepared.lineageDigest || payload.snapshotDigest !== prepared.snapshotDigest) return rejectLineage("identity-mismatch", "Assessment source/lineage does not match the frozen successor.");
  if (payload.priorAssessments.length !== prepared.inventory.length) return rejectLineage("invalid-assessments", "Every origin requires one assessment in issued order.");
  for (const [index, row] of prepared.inventory.entries()) {
    const assessment = payload.priorAssessments[index];
    if (assessment === undefined || assessment.origin !== standaloneOriginReference(row.origin)) return rejectLineage("invalid-assessments", "Missing, foreign, duplicate or reordered origin assessment.");
    const references = decisionReferences(prepared, row);
    const valid = match(assessment)
      .with({ verdict: "retained" }, value => references.includes(value.decisionDigest))
      .with({ verdict: "reopen" }, value => references.includes(value.proposal.decisionDigest))
      .with({ verdict: "repaired" }, value => active(prepared, row) && changedStandaloneInput(prepared, value.change.path) !== "unchanged")
      .with({ verdict: "still-present" }, () => active(prepared, row))
      .with({ verdict: "not-assessable" }, () => true)
      .exhaustive();
    if (!valid) return rejectLineage("invalid-assessments", "Assessment must respect the exact prior decision and explicitly reopen retired history.");
  }
  const origins = new Set(prepared.inventory.map(row => standaloneOriginReference(row.origin)));
  if (payload.findings.some(row => (row.draft.file !== null && !prepared.snapshot.some(entry => entry.path === row.draft.file)) ||
      (row.relation.kind === "distinct-related" && !origins.has(row.relation.origin)))) return rejectLineage("invalid-assessments", "New Findings require scoped locations and exact distinct-related origins.");
  return success(payload);
}

type StandaloneAssessmentProjection = Readonly<{
  origin: string; state: "active" | "retained" | "resolved" | "reopening-required" | "coverage-limited";
  assessments: readonly StandaloneResolutionAssessment[];
}>;
/** Whole-roster semantic aggregation, never an installable or Refutation Panel authority. */
export function aggregateStandaloneAssessments(prepared: PreparedStandaloneSuccessor,
  reports: readonly Readonly<{ role: string; payload: StandaloneReviewerPayloadV3 }>[],
): DomainResult<readonly StandaloneAssessmentProjection[], StandaloneLineageError> {
  if (!successors.has(prepared)) return rejectLineage("source-unavailable", "Aggregation requires exact prepared successor data.");
  if (reports.length !== prepared.reviewers.length || reports.some((report, index) => report.role !== prepared.reviewers[index])) return rejectLineage("invalid-assessments", "Aggregation requires the complete ordered current roster.");
  for (const report of reports) {
    const assessed = assessStandaloneSuccessor(prepared, report.payload);
    if (!assessed.ok) return assessed;
  }
  return success(freeze(prepared.inventory.map((row, index): StandaloneAssessmentProjection => {
    const assessments = freeze(reports.map(report => report.payload.priorAssessments[index]!));
    const state = match(assessments)
      .when(values => values.some(value => value.verdict === "not-assessable"), () => "coverage-limited" as const)
      .when(values => values.some(value => value.verdict === "reopen"), () => "reopening-required" as const)
      .when(values => values.every(value => value.verdict === "repaired"), () => "resolved" as const)
      .otherwise(() => active(prepared, row) ? "active" as const : "retained" as const);
    return canonicalRecord({ origin: standaloneOriginReference(row.origin), state, assessments });
  })));
}

/** All inventory rows, including retired history, participate. The caller supplies accepted transcript identity. */
export function attributeStandaloneSuccessorFindings(prepared: PreparedStandaloneSuccessor,
  input: Readonly<{ role: string; requestId: string; transcriptDigest: string; payload: StandaloneReviewerPayloadV3 }>,
): DomainResult<readonly StandaloneLineageRow[], StandaloneLineageError> {
  const admitted = assessStandaloneSuccessor(prepared, input.payload);
  if (!admitted.ok) return admitted;
  if (!prepared.reviewers.some(role => role === input.role)) return rejectLineage("identity-mismatch", "Only a current expected reviewer may receive attribution.");
  const highWater = prepared.inventory.reduce((highest, row) => row.origin.role === input.role ? Math.max(highest, row.origin.ordinal) : highest, 0);
  if (input.payload.findings.length > Number.MAX_SAFE_INTEGER - highWater) return rejectLineage("ordinal-exhausted", "Standalone Finding ordinal space is exhausted.");
  if (input.payload.findings.length === 0) return success(freeze([]));
  const origin = parseFindingOrigin({ kind: "current", runId: prepared.runId, requestId: input.requestId,
    transcriptDigest: input.transcriptDigest, role: input.role, ordinal: Math.min(highWater + 1, Number.MAX_SAFE_INTEGER) });
  if (!origin.ok) return origin;
  const findings = attributeFindings(input.payload.findings.map(row => ({ protocolVersion: 2 as const, ...row.draft })), input.role, highWater + 1);
  return success(freeze(findings.map((finding, index) => canonicalRecord({ origin: canonicalRecord({ ...origin.value, ordinal: highWater + index + 1 }),
    finding: storedFinding(finding, origin.value.role), history: freeze([]) }))));
}

// Issued successor admission and aggregation use the same private prepared membership.
const rejected = (message: string): DomainResult<never, ReviewerProtocolFailure> => failure(canonicalRecord({
  kind: "reviewer-protocol-failed", code: "authority-mismatch", path: "/standalone-successor", message,
}));
const subject = (prepared: PreparedStandaloneSuccessor, request: Pick<AgentRequestAuthority, "role" | "attempt">) => canonicalRecord({
  runId: prepared.runId, role: request.role, attempt: request.attempt,
  lineageDigest: prepared.lineageDigest, snapshotDigest: prepared.snapshotDigest,
});

/** Independent protocol registration projection; full LC-2 authority also freezes roster and nominal successor. */
export function standaloneSuccessorReviewerRegistration(prepared: PreparedStandaloneSuccessor) {
  return canonicalRecord({ schemaVersion: 3 as const, program: "standalone-review" as const, runId: prepared.runId,
    reviewerProtocol: STANDALONE_REVIEWER_PROTOCOL_V3, lineageDigest: prepared.lineageDigest, snapshotDigest: prepared.snapshotDigest });
}

/** Both semantic attempts bind prepared lineage, not the later registration/result digest. */
export function buildStandaloneSuccessorReviewerContext(prepared: PreparedStandaloneSuccessor,
  request: Pick<AgentRequestAuthority, "runId" | "requestId" | "role" | "attempt" | "requiredSkill">,
  variableContext: readonly ByteSection[],
): DomainResult<StandaloneReviewerContextPacketV3, ReviewerProtocolFailure> {
  if (!isPreparedStandaloneSuccessor(prepared) || request.runId !== prepared.runId || !prepared.reviewers.some(role => role === request.role)) {
    return rejected("Successor context requires the exact prepared source and expected reviewer.");
  }
  const authority = encodeByteSection("standalone-successor-authority", JSON.stringify(subject(prepared, request)));
  const lineage = encodeByteSection("standalone-lineage", JSON.stringify(prepared));
  if (!authority.ok || !lineage.ok) return rejected("Prepared lineage could not be encoded.");
  const packet = buildStandaloneReviewerContextPacketV3({ requestId: request.requestId, role: request.role,
    requiredSkill: request.requiredSkill ?? "none", fixedContext: [authority.value, lineage.value], variableContext });
  return packet.ok ? success(packet.value) : rejected(packet.error.message);
}

declare const issuedBrand: unique symbol;
export type IssuedStandaloneSuccessorReviewer = Readonly<{
  [issuedBrand]: true; protocolVersion: 3; request: AgentRequestAuthority;
  packet: StandaloneReviewerContextPacketV3; prepared: PreparedStandaloneSuccessor;
}>;
const issuedProtocols = new WeakSet<object>();

/** Publication membership is re-proved before inspecting untrusted packet/registration data. */
export function parseIssuedStandaloneSuccessorReviewer(input: Readonly<{
  request: SpawnRequest; packet: StandaloneReviewerContextPacketV3; registration: unknown; prepared: PreparedStandaloneSuccessor;
}>): DomainResult<IssuedStandaloneSuccessorReviewer, ReviewerProtocolFailure> {
  const issued = acceptedAgentResult(input.request, null);
  if (!issued.ok || !isPreparedStandaloneSuccessor(input.prepared)) return rejected("Successor admission requires publication-issued request and prepared lineage membership.");
  const request = issued.value.authority;
  const parsed = parseStandaloneReviewerContextPacketV3(input.packet);
  if (!parsed.ok || parsed.value.schemaVersion !== 3) return rejected("Successor admission requires the explicit standalone v3 Context Packet.");
  const packet = parsed.value;
  const expected = standaloneSuccessorReviewerRegistration(input.prepared);
  const registration = readExactDataRecord(input.registration, Object.keys(expected), "standalone successor registration");
  if (!registration.ok || !canonicalStructuralEquals(registration.value, expected) || request.program !== "standalone-review" ||
      request.runId !== input.prepared.runId || packet.requestId !== request.requestId || packet.role !== request.role ||
      packet.requiredSkill !== (request.requiredSkill ?? "none") || packet.digest !== request.contextDigest ||
      input.request.context.digest !== packet.digest || input.request.context.slot.path !== `contexts/${packet.digest}.json`) {
    return rejected("Independent registration, published request and Context Packet must join exactly.");
  }
  const variable = packet.variableContext;
  const rebuilt = buildStandaloneSuccessorReviewerContext(input.prepared, request, variable);
  if (!rebuilt.ok || rebuilt.value.digest !== packet.digest) return rejected("Published Context Packet does not contain the exact prepared lineage and request subject.");
  const authority = canonicalRecord({ protocolVersion: 3 as const, request, packet, prepared: input.prepared }) as IssuedStandaloneSuccessorReviewer;
  issuedProtocols.add(authority);
  return success(authority);
}

declare const evidenceBrand: unique symbol;
type AdmittedStandaloneSuccessorEvidence = Readonly<{
  [evidenceBrand]: true; request: AgentRequestAuthority; lineageDigest: string; transcriptDigest: string;
  payload: StandaloneReviewerPayloadV3;
  newFindings: Extract<ReturnType<typeof attributeStandaloneSuccessorFindings>, { ok: true }>["value"];
}>;
const admittedEvidence = new WeakSet<object>();

export function admitStandaloneSuccessorReviewer(authority: IssuedStandaloneSuccessorReviewer,
  raw: Uint8Array,
): DomainResult<AdmittedStandaloneSuccessorEvidence, ReviewerProtocolFailure | StandaloneLineageError> {
  if (!issuedProtocols.has(authority)) return rejected("Successor evidence requires minted issued protocol authority.");
  const parsed = parseStandaloneReviewerPayloadV3(raw);
  if (!parsed.ok) return parsed;
  const assessed = assessStandaloneSuccessor(authority.prepared, parsed.value);
  if (!assessed.ok) return assessed;
  const transcriptDigest = sha256Bytes(raw);
  const findings = attributeStandaloneSuccessorFindings(authority.prepared, { role: authority.request.role,
    requestId: authority.request.requestId, transcriptDigest, payload: assessed.value });
  if (!findings.ok) return findings;
  const evidence = canonicalRecord({ request: authority.request, lineageDigest: authority.prepared.lineageDigest,
    transcriptDigest, payload: assessed.value, newFindings: findings.value }) as AdmittedStandaloneSuccessorEvidence;
  admittedEvidence.add(evidence);
  return success(evidence);
}

/** Current roster only; LC-2 additionally enforces each slot's expected semantic attempt. */
export function aggregateIssuedStandaloneSuccessorEvidence(prepared: PreparedStandaloneSuccessor,
  requests: readonly AgentRequestAuthority[], reports: readonly AdmittedStandaloneSuccessorEvidence[],
): DomainResult<readonly StandaloneAssessmentProjection[], ReviewerProtocolFailure | StandaloneLineageError> {
  if (!isPreparedStandaloneSuccessor(prepared) || reports.length !== requests.length || reports.some(report => !admittedEvidence.has(report))) {
    return rejected("Whole-roster aggregation requires exact admitted evidence membership.");
  }
  if (reports.some((report, index) => report.lineageDigest !== prepared.lineageDigest ||
      !sameAgentRequestAuthority(report.request, requests[index]!))) return rejected("Current evidence does not match the exact expected request/attempt roster.");
  return aggregateStandaloneAssessments(prepared, reports.map(report => ({ role: report.request.role, payload: report.payload })));
}

type StandaloneSuccessorLineage = Readonly<{
  inventory: readonly StandaloneLineageRow[];
  reports: readonly AdmittedStandaloneSuccessorEvidence[];
  assessments: readonly StandaloneAssessmentProjection[];
  dispositions: readonly Readonly<{ origin: string; provenance: "new" | "inherited";
    state: "active" | "refuted" | "resolved" | "policy-retired" | "pending-panel" }>[];
  currentCriticalCoverage:
    | Readonly<{ kind: "complete"; origins: readonly [] }>
    | Readonly<{ kind: "limited"; origins: readonly [string, ...string[]] }>;
  counts: Readonly<{ new: number; inherited: number; total: number; survivingCritical: number;
    refutedCritical: number; resolved: number; advisory: number; currentCriticalCoverageLimited: number }>;
}>;

function successorDispositionState(
  prepared: PreparedStandaloneSuccessor,
  reports: readonly AdmittedStandaloneSuccessorEvidence[],
  row: StandaloneLineageRow,
  index: number,
  provenance: "new" | "inherited",
  panel: ParsedPanelOutcomes | null,
): StandaloneSuccessorLineage["dispositions"][number]["state"] {
  const finding = findingOf(row);
  const reopening = provenance === "inherited" &&
    reports.some(report => report.payload.priorAssessments[index]?.verdict === "reopen");
  if (finding.severity === "critical" && (provenance === "new" || reopening)) {
    const outcome = panel?.outcomes.find(value => value.findingId === `standalone-review:${finding.id}`);
    if (outcome === undefined) return "pending-panel";
    return outcome.survives ? "active" : "refuted";
  }
  if (finding.severity === "advisory" && prepared.disposition.kind === "selected-record" &&
      prepared.disposition.disposition.record.entries.some(entry =>
        entry.origin === standaloneOriginReference(row.origin) && entry.decision === "dismissed")) {
    return "policy-retired";
  }
  const latest = row.history.at(-1);
  if (latest?.kind === "adjudication" && !latest.survives) return "refuted";
  if (latest?.kind === "resolution" || latest?.kind === "successor-resolution") return "resolved";
  return "active";
}

/** Current panel work and history are derived from the exact full-roster admission, not from caller partitions. */
function deriveStandaloneSuccessorLineage(prepared: PreparedStandaloneSuccessor,
  requests: readonly AgentRequestAuthority[], reports: readonly AdmittedStandaloneSuccessorEvidence[],
  panel: ParsedPanelOutcomes | null,
): DomainResult<StandaloneSuccessorLineage, ReviewerProtocolFailure | StandaloneLineageError> {
  const projected = aggregateIssuedStandaloneSuccessorEvidence(prepared, requests, reports);
  if (!projected.ok) return projected;
  const inherited = prepared.inventory.map((row, index): StandaloneLineageRow => {
    const assessment = projected.value[index]!;
    if (assessment.state !== "resolved") return row;
    const assessments = reports.flatMap((report, reportIndex) => {
      const value = report.payload.priorAssessments[index]!;
      if (value.verdict !== "repaired") return [];
      const changedInput = changedStandaloneInput(prepared, value.change.path);
      if (changedInput === "unchanged") return [];
      return [canonicalRecord({ runId: prepared.runId, requestId: report.request.requestId,
        transcriptDigest: report.transcriptDigest, contextDigest: report.request.contextDigest,
        role: prepared.reviewers[reportIndex]!,
        reason: value.reason, change: value.change, changedInput })];
    });
    return canonicalRecord({ ...row, history: Object.freeze([...row.history, canonicalRecord({
      kind: "successor-resolution" as const, publication: canonicalRecord({ kind: "enclosing-publication" as const }),
      runId: prepared.runId, snapshotDigest: prepared.snapshotDigest, assessments: Object.freeze(assessments),
    })]) });
  });
  const all = [...inherited, ...reports.flatMap(report => report.newFindings)];
  const dispositions = all.map((row, index): StandaloneSuccessorLineage["dispositions"][number] => {
    const provenance = index < inherited.length ? "inherited" : "new";
    return canonicalRecord({
      origin: standaloneOriginReference(row.origin),
      provenance,
      state: successorDispositionState(prepared, reports, row, index, provenance, panel),
    });
  });
  const inventory = all.map((row, index): StandaloneLineageRow => {
    if (panel === null || !(dispositions[index]!.provenance === "new" ||
        reports.some(report => report.payload.priorAssessments[index]?.verdict === "reopen"))) return row;
    const outcome = panel.outcomes.find(value => value.findingId === `standalone-review:${row.finding.id}`);
    return outcome === undefined ? row : canonicalRecord({ ...row, history: Object.freeze([...row.history, canonicalRecord({
      kind: "adjudication" as const, publication: canonicalRecord({ kind: "enclosing-publication" as const }),
      lenses: panel.lenses, threshold: panel.threshold, survives: outcome.survives,
      refutations: outcome.refutations, upheldBy: outcome.upheldBy, uncertainFrom: outcome.uncertainFrom,
    })]) });
  });
  if (inventory.length > STANDALONE_LINEAGE_LIMITS.inventory || inventory.some(row => row.history.length > STANDALONE_LINEAGE_LIMITS.historyPerOrigin)) {
    return rejected("Successor inventory/history exceeds its retained budget.");
  }
  const limited = projected.value.filter((value, index) => value.state === "coverage-limited" &&
    findingOf(prepared.inventory[index]!).severity === "critical").map(value => value.origin);
  const count = (state: StandaloneSuccessorLineage["dispositions"][number]["state"], critical = false) =>
    dispositions.filter((value, index) => value.state === state && (!critical || findingOf(inventory[index]!).severity === "critical")).length;
  const [firstLimited, ...remainingLimited] = limited;
  const coverage: StandaloneSuccessorLineage["currentCriticalCoverage"] = firstLimited === undefined
    ? canonicalRecord({ kind: "complete", origins: Object.freeze([]) })
    : canonicalRecord({ kind: "limited", origins: Object.freeze([firstLimited, ...remainingLimited]) });
  return success(canonicalRecord({ inventory: Object.freeze(inventory), reports: Object.freeze([...reports]),
    assessments: projected.value, dispositions: Object.freeze(dispositions),
    currentCriticalCoverage: coverage,
    counts: canonicalRecord({ new: inventory.length - inherited.length, inherited: inherited.length, total: inventory.length,
      survivingCritical: count("active", true), refutedCritical: count("refuted", true), resolved: count("resolved"),
      advisory: inventory.filter(row => findingOf(row).severity === "advisory").length, currentCriticalCoverageLimited: limited.length }),
  }));
}

// LC-2 is the sole owner of ready-state and published-result membership.
type StandaloneRefutationAuthorityError = Readonly<{
  kind: "standalone-refutation-authority-rejected";
  message: string;
}>;

export type StandaloneRefutationCompletionReceipt = Readonly<{
  schemaVersion: 1;
  kind: "standalone-refutation-completed";
  /** The SAME branded identities `FrozenStandalonePanelAuthority` carries. The
   *  reducer below compares these four fields against that authority field by
   *  field; as plain `string` the comparison typechecked even if a run id and a
   *  digest were transposed at the construction site. */
  standaloneRunId: OrchestrationRunId;
  panelRunId: OrchestrationRunId;
  panelAuthority: FrozenStandalonePanelAuthority;
  findingBriefDigest: ArtifactDigest;
  manifestDigest: ArtifactDigest;
  threshold: number;
  outcomeDigest: string;
  completedPanelStateDigest: string;
  panel: ParsedPanelOutcomes;
  /** Parser-produced T2 state used by the in-process reducer. */
  completedPanelState: RefutationPanelState;
  /** Canonical T2 event checkpoint retained when completion crossed a durable boundary. */
  completedPanelCheckpoint: RefutationPanelCheckpoint | null;
}>;

const machineFailure = (message: string): Readonly<{ ok: false; error: StandaloneRefutationAuthorityError }> =>
  canonicalRecord({ ok: false, error: canonicalRecord({
    kind: "standalone-refutation-authority-rejected" as const,
    message,
  }) });

function deepFreezeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((entry) => deepFreezeJson(entry));
    return Object.freeze(value) as T;
  }
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((entry) => deepFreezeJson(entry));
    return Object.freeze(value);
  }
  return value;
}

function panelOutcomeValue(panel: ParsedPanelOutcomes): unknown {
  return {
    lenses: panel.lenses,
    threshold: panel.threshold,
    outcomes: panel.outcomes.map((outcome) => ({
      findingId: outcome.findingId,
      claim: outcome.claim,
      survives: outcome.survives,
      refutations: outcome.refutations,
      upheldBy: outcome.upheldBy,
      uncertainFrom: outcome.uncertainFrom,
    })),
  };
}

function refutationManifestValue(authority: RefutationPanelAuthority): unknown {
  return {
    schemaVersion: authority.schemaVersion,
    panel: authority.panel,
    runId: authority.runId,
    findings: authority.findings,
    lenses: authority.lenses,
    verifierSlots: authority.verifierRoster.orderedSlots,
  };
}

/** Freeze standalone→T2 panel authority before any completion can be accepted. */
export function freezeStandaloneRefutationPanelAuthority(input: Readonly<{
  standaloneAuthority: FrozenStandaloneReviewAuthority;
  aggregate: StandaloneReviewAggregate;
  panelAuthority: RefutationPanelAuthority;
  threshold: number;
}>): Readonly<{ ok: true; value: FrozenStandalonePanelAuthority }> |
  Readonly<{ ok: false; error: StandaloneRefutationAuthorityError }> {
  const canonical = parseRefutationPanelAuthority({
    runId: input.panelAuthority.runId,
    findings: input.panelAuthority.findings,
    lenses: input.panelAuthority.lenses,
    verifierSlots: input.panelAuthority.verifierRoster.orderedSlots,
  });
  if (!canonical.ok) return machineFailure(canonical.error.message);
  if (input.aggregate.runId !== input.standaloneAuthority.runId) {
    return machineFailure("standalone aggregate and frozen standalone authority belong to different runs");
  }
  const manifestDigest = parseArtifactDigest(canonicalDigest(refutationManifestValue(canonical.value)));
  if (!manifestDigest.ok) return machineFailure(manifestDigest.error.message);
  const frozen = freezeStandalonePanelAuthority({
    standaloneRunId: input.standaloneAuthority.runId,
    panelRunId: canonical.value.runId,
    aggregate: input.aggregate,
    panelFindings: canonical.value.findings,
    lenses: canonical.value.lenses,
    manifestDigest: manifestDigest.value,
    threshold: input.threshold,
  });
  if (!frozen.ok) return machineFailure(frozen.error.message);
  return canonicalRecord({ ok: true, value: frozen.value });
}

/**
 * Produce opaque completion authority only from a T2 parser/reducer-produced
 * done state whose exact authority and deterministic decision remain frozen.
 */
function replaySerializedRefutationCompletion(
  raw: unknown,
  resolver: PublicationAuthorityResolver,
): Readonly<{ ok: true; value: Extract<RefutationPanelState, { stage: "done" }> }> |
  Readonly<{ ok: false; message: string }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "persisted Refutation Panel completion must be an object" };
  }
  const record = raw as Record<string, unknown>;
  const authority = parseSerializedRefutationAuthority(record.authority);
  if (!authority.ok) return { ok: false, message: authority.error.message };
  if (record.panel !== "refutation" || record.stage !== "done" || !Array.isArray(record.slots) ||
      typeof record.decision !== "object" || record.decision === null || Array.isArray(record.decision)) {
    return { ok: false, message: "persisted Refutation Panel completion state is malformed or non-terminal" };
  }
  const verdictEvents: unknown[] = [];
  for (const slot of record.slots) {
    if (typeof slot !== "object" || slot === null || Array.isArray(slot)) {
      return { ok: false, message: "persisted Refutation Panel completion contains a malformed slot" };
    }
    const progress = slot as Record<string, unknown>;
    if (progress.status !== "accepted" || typeof progress.result !== "object" || progress.result === null ||
        Array.isArray(progress.result)) {
      return { ok: false, message: "persisted Refutation Panel completion requires every verifier slot to be accepted" };
    }
    const result = progress.result as Record<string, unknown>;
    verdictEvents.push({
      schemaVersion: 1,
      type: "refutation-verdict-accepted",
      request: result.request,
      value: result.value,
    });
  }
  const replayed = replayPersistentRefutationPanel(authority.value, [
    ...verdictEvents,
    { schemaVersion: 1, type: "refutation-tally-completed", decision: record.decision },
  ], resolver);
  if (!replayed.ok) return { ok: false, message: replayed.error.message };
  if (replayed.value.state.stage !== "done") {
    return { ok: false, message: "persisted Refutation Panel event replay did not reach done" };
  }
  if (!canonicalStructuralEquals(
    serializableCompletedPanelState(replayed.value.state),
    serializableCompletedPanelState({ ...record, authority: authority.value }),
  )) {
    return { ok: false, message: "persisted Refutation Panel state disagrees with verified T2 replay" };
  }
  return { ok: true, value: replayed.value.state };
}

export function parseStandaloneRefutationCompletion(input: Readonly<{
  panelAuthority: FrozenStandalonePanelAuthority;
  aggregate: StandaloneReviewAggregate;
  /** Untrusted live/legacy T2 state, or a canonical T2 checkpoint for compatibility. */
  completedPanelState?: unknown;
  /** T2's canonical event-backed completion checkpoint. */
  completedPanelCheckpoint?: unknown;
  /** Required when either persisted T2 representation must be replayed after restart. */
  publicationResolver?: PublicationAuthorityResolver;
}>): Readonly<{ ok: true; value: StandaloneRefutationCompletionReceipt }> |
  Readonly<{ ok: false; error: StandaloneRefutationAuthorityError }> {
  const persistedPanelAuthority = parseFrozenStandalonePanelAuthority(input.panelAuthority, input.aggregate);
  if (!persistedPanelAuthority.ok) {
    return machineFailure(`refutation completion panel authority is invalid: ${persistedPanelAuthority.error.message}`);
  }

  const stateLooksLikeCheckpoint = typeof input.completedPanelState === "object" &&
    input.completedPanelState !== null &&
    !Array.isArray(input.completedPanelState) &&
    (input.completedPanelState as Record<string, unknown>).schemaVersion === 2 &&
    (input.completedPanelState as Record<string, unknown>).kind === "refutation-panel-checkpoint";
  if (stateLooksLikeCheckpoint && input.completedPanelCheckpoint !== undefined &&
      input.completedPanelCheckpoint !== null &&
      !canonicalStructuralEquals(input.completedPanelState, input.completedPanelCheckpoint)) {
    return machineFailure("duplicate canonical Refutation Panel checkpoint inputs disagree");
  }
  const rawCheckpoint = input.completedPanelCheckpoint ??
    (stateLooksLikeCheckpoint ? input.completedPanelState : undefined);
  const rawState = stateLooksLikeCheckpoint ? undefined : input.completedPanelState;

  let checkpoint: RefutationPanelCheckpoint | null = null;
  let checkpointCompleted: Extract<RefutationPanelState, { stage: "done" }> | null = null;
  if (rawCheckpoint !== undefined && rawCheckpoint !== null) {
    if (input.publicationResolver === undefined) {
      return machineFailure("canonical Refutation Panel checkpoint replay requires publication authority");
    }
    const parsedCheckpoint = parseRefutationPanelCheckpoint(
      rawCheckpoint,
      input.publicationResolver,
    );
    if (!parsedCheckpoint.ok) return machineFailure(parsedCheckpoint.error.message);
    if (parsedCheckpoint.value.state.stage !== "done") {
      return machineFailure("canonical Refutation Panel checkpoint has not reached completed state");
    }
    checkpoint = deepFreezeJson(
      JSON.parse(JSON.stringify(rawCheckpoint)) as RefutationPanelCheckpoint,
    );
    checkpointCompleted = parsedCheckpoint.value.state;
  }

  const resumed = rawState === undefined
    ? null
    : resumePersistentRefutationPanel(rawState as RefutationPanelState);
  const replayed = rawState !== undefined && resumed?.ok === false && input.publicationResolver !== undefined
    ? replaySerializedRefutationCompletion(rawState, input.publicationResolver)
    : null;
  let stateCompleted: Extract<RefutationPanelState, { stage: "done" }> | null = null;
  if (resumed?.ok === true && resumed.value.state.stage === "done") {
    stateCompleted = resumed.value.state;
  } else if (replayed?.ok === true) {
    stateCompleted = replayed.value;
  }
  if (checkpointCompleted !== null && stateCompleted !== null && !canonicalStructuralEquals(
    serializableCompletedPanelState(checkpointCompleted),
    serializableCompletedPanelState(stateCompleted),
  )) {
    return machineFailure("canonical Refutation Panel checkpoint and supplied completed state disagree");
  }
  const completed = checkpointCompleted ?? stateCompleted;
  if (completed === null) {
    if (replayed !== null && !replayed.ok) return machineFailure(replayed.message);
    if (resumed?.ok === true) return machineFailure("refutation panel has not reached completed state");
    if (resumed?.ok === false) return machineFailure(resumed.error.message);
    return machineFailure("refutation completion requires a completed T2 state or canonical checkpoint");
  }
  const completedManifestDigest = canonicalDigest(refutationManifestValue(completed.authority));
  const independentlyFrozen = freezeStandalonePanelAuthority({
    standaloneRunId: input.aggregate.runId,
    panelRunId: completed.authority.runId,
    aggregate: input.aggregate,
    panelFindings: completed.authority.findings,
    lenses: completed.authority.lenses,
    manifestDigest: completedManifestDigest,
    threshold: input.panelAuthority.threshold,
  });
  if (!independentlyFrozen.ok || JSON.stringify(independentlyFrozen.value) !== JSON.stringify(persistedPanelAuthority.value) ||
      completed.authority.runId !== input.panelAuthority.panelRunId ||
      completedManifestDigest !== input.panelAuthority.manifestDigest ||
      completed.decision.threshold !== input.panelAuthority.threshold ||
      JSON.stringify(completed.decision.lenses) !== JSON.stringify(input.panelAuthority.lenses)) {
    return machineFailure("completed Refutation Panel does not match the exact frozen run/manifest/lens/threshold authority");
  }
  const rawOutcomes = {
    lenses: completed.decision.lenses,
    threshold: completed.decision.threshold,
    surviving: completed.decision.outcomes.filter(({ survives }) => survives).length,
    refuted: completed.decision.outcomes.filter(({ survives }) => !survives).length,
    outcomes: completed.decision.outcomes.map((outcome) => ({
      finding_id: outcome.finding.id,
      task_id: outcome.finding.taskId,
      claim: outcome.finding.claim,
      survives: outcome.survives,
      refuted_by: outcome.refutations.map(({ lens }) => lens),
      reasoning: outcome.refutations.map(({ reason }) => reason),
      upheld_by: outcome.upheldBy,
      uncertain_from: outcome.uncertainFrom,
    })),
  };
  const criticals = standaloneCurrentPanelCriticals(input.aggregate);
  const panel = parseStandalonePanelOutcomes(
    rawOutcomes,
    criticals,
    input.panelAuthority.findings.map(({ id, claim }) => ({ id, claim })),
    input.panelAuthority.lenses,
  );
  if (!panel.ok) return machineFailure(panel.errors.join("; "));
  const outcomeDigest = canonicalDigest(panelOutcomeValue(panel.value));
  const completedPanelStateDigest = canonicalDigest({
    stage: completed.stage,
    manifestDigest: completedManifestDigest,
    slots: completed.slots,
    decision: completed.decision,
  });
  const receipt = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "standalone-refutation-completed" as const,
    standaloneRunId: input.panelAuthority.standaloneRunId,
    panelRunId: input.panelAuthority.panelRunId,
    panelAuthority: input.panelAuthority,
    findingBriefDigest: input.panelAuthority.findingBriefDigest,
    manifestDigest: input.panelAuthority.manifestDigest,
    threshold: input.panelAuthority.threshold,
    outcomeDigest,
    completedPanelStateDigest,
    panel: panel.value,
    completedPanelState: completed,
    completedPanelCheckpoint: checkpoint,
  });
  return canonicalRecord({ ok: true, value: receipt });
}

type AcceptedStandaloneSlot = Readonly<{
  slotId: SlotId;
  requestId: RequestId;
  attempt: 1 | 2;
  /** Canonical payload plus artifact byte identity accepted for this slot. */
  payloadFingerprint: string;
}>;

type PendingStandaloneSlot = Readonly<{
  slotId: SlotId;
  expectedAttempt: 1 | 2;
  /**
   * Why attempt 1 was refused, carried durably so the attempt-2 spawn prompt can
   * name the ACTUAL defect. The rejection diagnostic used to live only in the
   * pass-local `rejected` set of `resumeStandaloneFacade`, so a resume that
   * merely re-issued an already-recorded retry lost it and fell back to a
   * generic message — telling the reviewer to fix its scope when the real defect
   * was a missing Machine Summary block. Always null while `expectedAttempt` is
   * 1; null selects the supported generic fallback when no non-empty diagnostic
   * survived, including but not limited to legacy checkpoints.
   */
  rejectionDiagnostic: string | null;
}>;

interface StandaloneStateBase {
  readonly authority: FrozenStandaloneReviewAuthority;
  readonly accepted: readonly AcceptedStandaloneSlot[];
  readonly pending: readonly PendingStandaloneSlot[];
}

type StandalonePreparingState = Readonly<StandaloneStateBase & { kind: "preparing" }>;
type StandaloneAwaitingResultsState = Readonly<StandaloneStateBase & { kind: "awaiting-results" }>;
type StandaloneAggregatingState = Readonly<StandaloneStateBase & {
  kind: "aggregating";
  completion: StandaloneRosterCompletionProof;
}>;
type StandaloneAwaitingRefutationState = Readonly<StandaloneStateBase & {
  kind: "awaiting-refutation";
  completion: StandaloneRosterCompletionProof;
  aggregate: StandaloneReviewAggregate;
  panelAuthority: FrozenStandalonePanelAuthority;
  refutationAuthority: RefutationPanelAuthority;
}>;
export type StandaloneReadyToFinalizeState = Readonly<StandaloneStateBase & {
  kind: "ready-to-finalize";
  completion: StandaloneRosterCompletionProof;
  aggregate: StandaloneReviewAggregate;
  panel: ParsedPanelOutcomes | null;
  /** Null when there is no current Refutation Panel work; inherited active criticals may remain. */
  refutationCompletion: StandaloneRefutationCompletionReceipt | null;
  rosterDigest: string;
  reviewerEvidenceDigest: string;
  aggregateDigest: string;
  provenOutcomeDigest: string;
  finalizationDigest: string;
  result: AdjudicatedStandaloneReview;
  publicationIntent: PublishArtifactSet;
}>;

declare class AuthoritativeStandaloneReviewResultMembership {
  private readonly authoritativeStandaloneReviewResultMembership: true;
}

/** Opaque versioned result authority consumed by downstream remediation (T5). */
export type AuthoritativeStandaloneReviewResult =
  AuthoritativeStandaloneReviewResultMembership & AdjudicatedStandaloneReview;

const readyFinalizationCache = new WeakSet<object>();
const authoritativeStandaloneResultCache = new WeakSet<object>();
const standaloneResultPublications = new WeakMap<object, Readonly<{ artifact: ArtifactRef; serialization: string }>>();

export type StandaloneDoneState = Readonly<StandaloneStateBase & {
  kind: "done";
  result: AuthoritativeStandaloneReviewResult;
  outcome: ArtifactRef;
  publicationReceipt: ArtifactSetPublished;
}>;
type StandaloneTerminalBlockedState = Readonly<StandaloneStateBase & {
  kind: "terminal-blocked";
  failed: Readonly<{ slotId: SlotId; requestId: RequestId; attempt: 2; message: string }>;
}>;

type StandaloneRecoverablePredecessor =
  | StandalonePreparingState
  | StandaloneAwaitingResultsState
  | StandaloneAggregatingState
  | StandaloneAwaitingRefutationState
  | StandaloneReadyToFinalizeState;

type StandaloneRecoverableBlockedState = Readonly<StandaloneStateBase & {
  kind: "recoverable-blocked";
  predecessor: StandaloneRecoverablePredecessor;
  diagnostic: InfrastructureRetryDiagnostic;
  expectedIntent: EffectIntent;
  expectedIntentDigest: string;
}>;

export type StandaloneReviewMachineState =
  | StandaloneRecoverablePredecessor
  | StandaloneRecoverableBlockedState
  | StandaloneDoneState
  | StandaloneTerminalBlockedState;

type AuthoritativeStandaloneResultError = Readonly<{
  kind: "standalone-result-authority-rejected";
  message: string;
}>;

const authoritativeResultFailure = (message: string): Readonly<{
  ok: false;
  error: AuthoritativeStandaloneResultError;
}> => canonicalRecord({
  ok: false,
  error: canonicalRecord({ kind: "standalone-result-authority-rejected" as const, message }),
});

function prepareResultPublicationIntent(
  result: AdjudicatedStandaloneReview,
): Readonly<{ ok: true; value: PublishArtifactSet }> |
  Readonly<{ ok: false; error: AuthoritativeStandaloneResultError }> {
  const artifact = canonicalStandaloneResultArtifact(result);
  if (!artifact.ok) return authoritativeResultFailure(artifact.error.message);
  if (result.schemaVersion === 3 && artifact.value.byteLength > STANDALONE_LINEAGE_LIMITS.retainedBytes) {
    return authoritativeResultFailure("canonical v3 result exceeds its retained lineage byte budget");
  }
  const effectId = parseEffectId(`effect:standalone-result:${canonicalDigest({
    runId: result.runId,
    artifact: artifact.value,
  })}`);
  if (!effectId.ok) return authoritativeResultFailure(effectId.error.message);
  return canonicalRecord({
    ok: true,
    value: canonicalRecord({
      kind: "publish-artifact-set" as const,
      effectId: effectId.value,
      runId: artifact.value.runId,
      artifacts: Object.freeze([artifact.value]) as readonly [ArtifactRef],
    }),
  });
}

function readyToFinalize(
  state: StandaloneAggregatingState | StandaloneAwaitingRefutationState,
  event: Extract<StandaloneReviewMachineEvent, { kind: "aggregate-clean" | "refutation-completed" }>,
  aggregate: StandaloneReviewAggregate,
  panel: ParsedPanelOutcomes | null,
): StandaloneMachineResult {
  const finalized = finalizeStandaloneReview(aggregate, panel);
  if (!finalized.ok) {
    return rejectTransition(state, event, "aggregate-route-mismatch", finalized.errors.join("; "));
  }
  if (finalized.value.reviewerEvidence.length === 0 ||
      finalized.value.reviewerEvidence.some(({ authorityKind }) => authorityKind !== "request-bound")) {
    return rejectTransition(state, event, "aggregate-route-mismatch",
      `schema-v${aggregate.schemaVersion} finalization requires exact non-empty request-bound reviewer evidence`);
  }
  const publication = prepareResultPublicationIntent(finalized.value);
  if (!publication.ok) {
    return rejectTransition(state, event, "publication-receipt-mismatch", publication.error.message);
  }
  const ready = canonicalRecord({
    ...state,
    kind: "ready-to-finalize" as const,
    aggregate,
    panel: finalized.value.panel,
    refutationCompletion: event.kind === "refutation-completed" ? event.completion : null,
    rosterDigest: state.completion.rosterDigest,
    reviewerEvidenceDigest: canonicalDigest(finalized.value.reviewerEvidence),
    aggregateDigest: canonicalDigest(serializeStandaloneAggregate(aggregate)),
    provenOutcomeDigest: canonicalDigest(panel === null ? { kind: "clean" } : panelOutcomeValue(finalized.value.panel!)),
    finalizationDigest: canonicalDigest(serializeAdjudicatedStandaloneReview(finalized.value)),
    result: finalized.value,
    publicationIntent: publication.value,
  });
  readyFinalizationCache.add(ready);
  return machineSuccess(ready);
}

/**
 * The version-aware result parser requires the opaque ready state produced
 * from roster/panel proof plus the exact engine-issued publication receipt.
 */
export function parseAuthoritativeStandaloneReviewResult(
  ready: StandaloneReadyToFinalizeState,
  rawResult: unknown,
  rawReceipt: unknown,
): Readonly<{ ok: true; value: AuthoritativeStandaloneReviewResult; receipt: ArtifactSetPublished }> |
  Readonly<{ ok: false; error: AuthoritativeStandaloneResultError }> {
  if (typeof ready !== "object" || ready === null || !readyFinalizationCache.has(ready)) {
    return authoritativeResultFailure("schema-v1 result parsing requires an opaque LC-2 ready-to-finalize authority");
  }
  const reaggregated = aggregateStandaloneReview({
    authority: ready.authority,
    completion: ready.completion,
  });
  if (!reaggregated.ok ||
      canonicalDigest(serializeStandaloneAggregate(reaggregated.value.aggregate)) !== ready.aggregateDigest ||
      ready.completion.rosterDigest !== ready.rosterDigest) {
    return authoritativeResultFailure("frozen roster proof or aggregate digest changed before result publication");
  }
  const finalized = finalizeStandaloneReview(ready.aggregate, ready.panel);
  if (!finalized.ok || finalized.value.reviewerEvidence.length === 0 ||
      canonicalDigest(finalized.value.reviewerEvidence) !== ready.reviewerEvidenceDigest ||
      canonicalDigest(ready.panel === null ? { kind: "clean" } : panelOutcomeValue(finalized.value.panel!)) !== ready.provenOutcomeDigest ||
      canonicalDigest(serializeAdjudicatedStandaloneReview(finalized.value)) !== ready.finalizationDigest) {
    return authoritativeResultFailure("proven panel outcome, reviewer evidence, aggregate, or finalization changed before publication");
  }
  let expectedRaw: unknown;
  try {
    expectedRaw = JSON.parse(serializeAdjudicatedStandaloneReview(finalized.value));
  } catch {
    return authoritativeResultFailure(`engine-authored schema-v${ready.authority.schemaVersion} finalization is not canonical JSON`);
  }
  if (!isDeepStrictEqual(rawResult, expectedRaw)) {
    return authoritativeResultFailure(`schema-v${ready.authority.schemaVersion} result bytes do not match the exact independently frozen finalization`);
  }
  const reconciled = reconcileEffectReceipt(ready.publicationIntent, rawReceipt);
  if (!reconciled.ok || reconciled.value.kind !== "artifact-set-published") {
    return authoritativeResultFailure(reconciled.ok
      ? "result publication receipt has the wrong effect kind"
      : reconciled.error.message);
  }
  const authoritative = finalized.value as AuthoritativeStandaloneReviewResult;
  authoritativeStandaloneResultCache.add(authoritative);
  standaloneResultPublications.set(authoritative, canonicalRecord({ artifact: ready.publicationIntent.artifacts[0],
    serialization: serializeAdjudicatedStandaloneReview(finalized.value) }));
  return canonicalRecord({ ok: true, value: authoritative, receipt: reconciled.value });
}

export function isAuthoritativeStandaloneReviewResult(
  result: AuthoritativeStandaloneReviewResult,
): boolean {
  return typeof result === "object" && result !== null && authoritativeStandaloneResultCache.has(result);
}

/** Exact publication identity retained by LC-2, not a digest re-authored from supplied result data. */
export function readStandaloneReviewPublication(result: AuthoritativeStandaloneReviewResult, maximumByteLength: number):
  Readonly<{ ok: true; value: ArtifactRef }> | Readonly<{ ok: false; error: AuthoritativeStandaloneResultError }> {
  const publication = standaloneResultPublications.get(result);
  if (publication === undefined) return authoritativeResultFailure("standalone source requires LC-2 publication membership");
  if (!Number.isSafeInteger(maximumByteLength) || maximumByteLength < 1 || publication.artifact.byteLength > maximumByteLength) {
    return authoritativeResultFailure("standalone source publication exceeds its retained byte budget");
  }
  try {
    if (serializeAdjudicatedStandaloneReview(result) !== publication.serialization) {
      return authoritativeResultFailure("standalone source changed after its original result publication");
    }
    return canonicalRecord({ ok: true, value: publication.artifact });
  } catch {
    return authoritativeResultFailure("standalone source could not be inspected safely");
  }
}

export type StandaloneReviewMachineEvent =
  | Readonly<{ kind: "review-batch-published"; runId: string }>
  | Readonly<{ kind: "result-accepted"; result: AcceptedAgentResult<CapturedReviewerResult> }>
  | Readonly<{
      kind: "result-rejected";
      request: Readonly<{ runId: string; slotId: SlotId; requestId: RequestId; attempt: 1 | 2 }>;
      message: string;
    }>
  | Readonly<{
      kind: "complete-roster-proved";
      completion: StandaloneRosterCompletionProof;
    }>
  | Readonly<{ kind: "aggregate-clean"; aggregate: StandaloneReviewAggregate }>
  | Readonly<{
      kind: "aggregate-has-criticals";
      aggregate: StandaloneReviewAggregate;
      panelAuthority: FrozenStandalonePanelAuthority;
      refutationAuthority: RefutationPanelAuthority;
    }>
  | Readonly<{
      kind: "refutation-completed";
      completion: StandaloneRefutationCompletionReceipt;
    }>
  | Readonly<{ kind: "result-published"; result: unknown; receipt: ArtifactSetPublished }>
  | Readonly<{
      kind: "recoverable-effect-failed";
      diagnostic: InfrastructureRetryDiagnostic;
      intent: EffectIntent;
    }>
  | Readonly<{ kind: "recovery-receipt-accepted"; receipt: EffectReceipt }>;

type StandaloneMachineError = Readonly<{
  kind:
    | "undeclared-transition"
    | "foreign-run-event"
    | "unknown-slot"
    | "duplicate-result"
    | "stale-attempt"
    | "roster-mismatch"
    | "aggregate-route-mismatch"
    | "publication-receipt-mismatch"
    | "recovery-receipt-mismatch";
  state: StandaloneReviewMachineState["kind"];
  event: StandaloneReviewMachineEvent["kind"];
  message: string;
}>;

type StandaloneMachineResult =
  | Readonly<{ ok: true; value: StandaloneReviewMachineState }>
  | Readonly<{ ok: false; error: StandaloneMachineError }>;

export const STANDALONE_REVIEW_DECLARED_TRANSITIONS = Object.freeze({
  preparing: Object.freeze(["review-batch-published", "recoverable-effect-failed"]),
  "awaiting-results": Object.freeze([
    "result-accepted", "result-rejected", "complete-roster-proved", "recoverable-effect-failed",
  ]),
  aggregating: Object.freeze(["aggregate-clean", "aggregate-has-criticals", "recoverable-effect-failed"]),
  "awaiting-refutation": Object.freeze(["refutation-completed", "recoverable-effect-failed"]),
  "ready-to-finalize": Object.freeze(["result-published", "recoverable-effect-failed"]),
  "recoverable-blocked": Object.freeze(["recoverable-effect-failed", "recovery-receipt-accepted"]),
  done: Object.freeze([]),
  "terminal-blocked": Object.freeze([]),
} as const satisfies Readonly<Record<
  StandaloneReviewMachineState["kind"],
  readonly StandaloneReviewMachineEvent["kind"][]
>>);

export function isDeclaredStandaloneReviewTransition(
  state: StandaloneReviewMachineState["kind"],
  event: StandaloneReviewMachineEvent["kind"],
): boolean {
  return (STANDALONE_REVIEW_DECLARED_TRANSITIONS[state] as readonly string[]).includes(event);
}

const machineSuccess = (value: StandaloneReviewMachineState): StandaloneMachineResult =>
  canonicalRecord({ ok: true, value });

const rejectTransition = (
  state: StandaloneReviewMachineState,
  event: StandaloneReviewMachineEvent,
  kind: StandaloneMachineError["kind"],
  message: string,
): StandaloneMachineResult => canonicalRecord({
  ok: false,
  error: canonicalRecord({ kind, state: state.kind, event: event.kind, message }),
});

function stateBase(authority: FrozenStandaloneReviewAuthority): StandaloneStateBase {
  return canonicalRecord({
    authority,
    accepted: Object.freeze([]),
    pending: Object.freeze(authority.roster.orderedSlots.map((slot) => canonicalRecord({
      slotId: slot.slotId,
      expectedAttempt: 1 as const,
      rejectionDiagnostic: null,
    }))),
  });
}

export function startStandaloneReviewMachine(
  authority: FrozenStandaloneReviewAuthority,
): StandalonePreparingState {
  return canonicalRecord({ kind: "preparing", ...stateBase(authority) });
}

function eventRunId(event: StandaloneReviewMachineEvent): string | null {
  switch (event.kind) {
    case "review-batch-published": return event.runId;
    case "result-accepted": return event.result.authority.runId;
    case "result-rejected": return event.request.runId;
    case "complete-roster-proved": return event.completion.runId;
    case "aggregate-clean":
    case "aggregate-has-criticals": return event.aggregate.runId;
    case "refutation-completed": return typeof event.completion === "object" && event.completion !== null
      ? event.completion.standaloneRunId
      : null;
    case "result-published": return event.receipt.runId;
    case "recoverable-effect-failed": return event.diagnostic.runId;
    case "recovery-receipt-accepted": return event.receipt.runId;
  }
}


function acceptedPayloadMatchesAuthority(
  result: AcceptedAgentResult<CapturedReviewerResult>,
): boolean {
  const parsed = parseCapturedReviewerResult(result.value);
  return parsed.ok && parsed.value.artifact.runId === result.authority.runId &&
    parsed.value.artifact.slot.path === result.authority.outputSlot.path;
}

function rosterAttempt<First, Second>(
  slot: Readonly<{ attempts: readonly [First, Second] }> | undefined,
  attempt: 1 | 2,
): First | Second | undefined {
  return slot?.attempts[attempt - 1];
}

function withAccepted(
  state: StandaloneAwaitingResultsState,
  result: AcceptedAgentResult<CapturedReviewerResult>,
): StandaloneMachineResult {
  const authority = result.authority;
  const pendingIndex = state.pending.findIndex(({ slotId }) => slotId === authority.slotId);
  if (pendingIndex < 0) {
    const duplicate = state.accepted.some(({ slotId }) => slotId === authority.slotId);
    return rejectTransition(state, { kind: "result-accepted", result }, duplicate ? "duplicate-result" : "unknown-slot",
      duplicate ? `slot ${authority.slotId} already has an accepted result` : `slot ${authority.slotId} is not in the frozen roster`);
  }
  const pending = state.pending[pendingIndex]!;
  if (pending.expectedAttempt !== authority.attempt) {
    return rejectTransition(state, { kind: "result-accepted", result }, "stale-attempt",
      `slot ${authority.slotId} expects attempt ${pending.expectedAttempt}, received ${authority.attempt}`);
  }
  const slot = state.authority.roster.byId.get(authority.slotId);
  const expected = rosterAttempt(slot, authority.attempt);
  if (expected === undefined || !sameAgentRequestAuthority(authority, expected) || !acceptedPayloadMatchesAuthority(result)) {
    return rejectTransition(state, { kind: "result-accepted", result }, "roster-mismatch",
      "accepted result does not match frozen run/agent/request/context/model/output or artifact authority");
  }
  const remaining = state.pending.filter((_, index) => index !== pendingIndex);
  if (remaining.length === 0) {
    return rejectTransition(state, { kind: "result-accepted", result }, "undeclared-transition",
      "the final result must enter through complete-roster-proved, not result-accepted (incomplete)");
  }
  return machineSuccess(canonicalRecord({
    ...state,
    accepted: Object.freeze([...state.accepted, canonicalRecord({
      slotId: authority.slotId,
      requestId: authority.requestId,
      attempt: authority.attempt,
      payloadFingerprint: fingerprintCapturedReviewerResult(result.value),
    })]),
    pending: Object.freeze(remaining),
  }));
}

function withRejected(
  state: StandaloneAwaitingResultsState,
  event: Extract<StandaloneReviewMachineEvent, { kind: "result-rejected" }>,
): StandaloneMachineResult {
  const pendingIndex = state.pending.findIndex(({ slotId }) => slotId === event.request.slotId);
  if (pendingIndex < 0) {
    const duplicate = state.accepted.some(({ slotId }) => slotId === event.request.slotId);
    return rejectTransition(state, event, duplicate ? "duplicate-result" : "unknown-slot",
      duplicate ? "an accepted slot cannot later be rejected" : "rejected result slot is not pending");
  }
  const pending = state.pending[pendingIndex]!;
  if (pending.expectedAttempt !== event.request.attempt) {
    return rejectTransition(state, event, "stale-attempt",
      `slot ${event.request.slotId} expects attempt ${pending.expectedAttempt}, received ${event.request.attempt}`);
  }
  const slot = state.authority.roster.byId.get(event.request.slotId);
  const expected = rosterAttempt(slot, event.request.attempt);
  if (expected === undefined || expected.requestId !== event.request.requestId) {
    return rejectTransition(state, event, "roster-mismatch", "rejected request does not match frozen slot authority");
  }
  const message = event.message.trim();
  if (event.request.attempt === 2) {
    return machineSuccess(canonicalRecord({
      ...state,
      kind: "terminal-blocked",
      failed: canonicalRecord({
        slotId: event.request.slotId,
        requestId: event.request.requestId,
        attempt: 2 as const,
        message: message || "reviewer result failed its second and final semantic attempt",
      }),
    }));
  }
  return machineSuccess(canonicalRecord({
    ...state,
    pending: Object.freeze(state.pending.map((entry, index) => index === pendingIndex
      ? canonicalRecord({
          slotId: entry.slotId,
          expectedAttempt: 2 as const,
          // Durable so EVERY later resume that re-issues this retry can name the
          // real defect, not just the pass that recorded the rejection.
          rejectionDiagnostic: message || null,
        })
      : entry)),
  }));
}

function withCompleteRoster(
  state: StandaloneAwaitingResultsState,
  event: Extract<StandaloneReviewMachineEvent, { kind: "complete-roster-proved" }>,
): StandaloneMachineResult {
  const canonical = aggregateStandaloneReview({
    authority: state.authority,
    completion: event.completion,
  });
  if (!canonical.ok) {
    return rejectTransition(state, event, "roster-mismatch", canonical.errors.join("; "));
  }
  const expectedSlots = state.authority.roster.orderedSlots;
  const proven = event.completion.accepted;
  if (proven.length !== expectedSlots.length) {
    return rejectTransition(state, event, "roster-mismatch", "completion proof length differs from frozen roster");
  }
  const acceptedBySlot = new Map(state.accepted.map((entry) => [entry.slotId, entry] as const));
  for (let index = 0; index < expectedSlots.length; index++) {
    const expectedSlot = expectedSlots[index]!;
    const result = proven[index]!;
    const expectedAttempt = state.pending.find(({ slotId }) => slotId === expectedSlot.slotId)?.expectedAttempt;
    const accepted = acceptedBySlot.get(expectedSlot.slotId);
    if (result.slotId !== expectedSlot.slotId) {
      return rejectTransition(state, event, "roster-mismatch", "completion proof does not preserve canonical slot order");
    }
    if (accepted !== undefined && (
      accepted.requestId !== result.requestId || accepted.attempt !== result.attempt ||
      accepted.payloadFingerprint !== result.payloadFingerprint
    )) {
      return rejectTransition(state, event, "roster-mismatch", "completion proof replaces previously accepted payload or artifact bytes");
    }
    if (accepted === undefined && expectedAttempt !== result.attempt) {
      return rejectTransition(state, event, "stale-attempt", "completion proof uses a stale or unissued semantic attempt");
    }
  }
  return machineSuccess(canonicalRecord({
    kind: "aggregating",
    authority: state.authority,
    accepted: Object.freeze([...proven]),
    pending: Object.freeze([]),
    completion: event.completion,
  }));
}

function recoverable(
  state: StandaloneRecoverablePredecessor | StandaloneRecoverableBlockedState,
  event: Extract<StandaloneReviewMachineEvent, { kind: "recoverable-effect-failed" }>,
): StandaloneMachineResult {
  if (event.diagnostic.runId !== state.authority.runId || event.intent.runId !== state.authority.runId ||
      event.diagnostic.effectId !== event.intent.effectId) {
    return rejectTransition(state, event, "recovery-receipt-mismatch",
      "recoverable diagnostic and failed EffectIntent must identify this exact standalone run/effect");
  }
  if (state.kind === "recoverable-blocked" && JSON.stringify(state.expectedIntent) !== JSON.stringify(event.intent)) {
    return rejectTransition(state, event, "recovery-receipt-mismatch",
      "a repeated recoverable failure cannot replace the exact blocked EffectIntent");
  }
  const predecessor = state.kind === "recoverable-blocked" ? state.predecessor : state;
  return machineSuccess(canonicalRecord({
    kind: "recoverable-blocked",
    authority: state.authority,
    accepted: state.accepted,
    pending: state.pending,
    predecessor,
    diagnostic: event.diagnostic,
    expectedIntent: state.kind === "recoverable-blocked" ? state.expectedIntent : event.intent,
    expectedIntentDigest: state.kind === "recoverable-blocked" ? state.expectedIntentDigest : canonicalDigest(event.intent),
  }));
}

/** Exact LC-2 reducer. Undeclared state/event pairs are rejected, never absorbed. */
export function reduceStandaloneReviewMachine(
  state: StandaloneReviewMachineState,
  event: StandaloneReviewMachineEvent,
): StandaloneMachineResult {
  if (!isDeclaredStandaloneReviewTransition(state.kind, event.kind)) {
    return rejectTransition(state, event, "undeclared-transition", `event ${event.kind} is not declared from ${state.kind}`);
  }
  const runId = eventRunId(event);
  if (runId !== null && runId !== state.authority.runId) {
    return rejectTransition(state, event, "foreign-run-event", "event belongs to a stale or foreign standalone run");
  }

  if (event.kind === "recoverable-effect-failed") {
    if (state.kind === "done" || state.kind === "terminal-blocked") {
      return rejectTransition(state, event, "undeclared-transition", "terminal states are monotonic");
    }
    return recoverable(state, event);
  }

  switch (state.kind) {
    case "preparing":
      return event.kind === "review-batch-published"
        ? machineSuccess(canonicalRecord({ ...state, kind: "awaiting-results" }))
        : rejectTransition(state, event, "undeclared-transition", "preparing accepts only review-batch-published or recoverable-effect-failed");

    case "awaiting-results":
      if (event.kind === "result-accepted") return withAccepted(state, event.result);
      if (event.kind === "result-rejected") return withRejected(state, event);
      if (event.kind === "complete-roster-proved") return withCompleteRoster(state, event);
      return rejectTransition(state, event, "undeclared-transition", "awaiting-results received an undeclared event");

    case "aggregating": {
      if (event.kind !== "aggregate-clean" && event.kind !== "aggregate-has-criticals") {
        return rejectTransition(state, event, "undeclared-transition", "aggregating accepts only one aggregate route");
      }
      const canonical = aggregateStandaloneReview({ authority: state.authority, completion: state.completion });
      if (!canonical.ok || serializeStandaloneAggregate(canonical.value.aggregate) !== serializeStandaloneAggregate(event.aggregate)) {
        return rejectTransition(state, event, "roster-mismatch", "aggregate does not match the complete captured reviewer roster");
      }
      const criticals = standaloneCurrentPanelCriticals(event.aggregate);
      if (event.kind === "aggregate-clean" && criticals.length !== 0) {
        return rejectTransition(state, event, "aggregate-route-mismatch", "aggregate-clean requires zero critical findings");
      }
      if (event.kind === "aggregate-has-criticals" && criticals.length === 0) {
        return rejectTransition(state, event, "aggregate-route-mismatch", "aggregate-has-criticals requires at least one critical finding");
      }
      if (event.kind === "aggregate-has-criticals") {
        const reproved = freezeStandaloneRefutationPanelAuthority({
          standaloneAuthority: state.authority,
          aggregate: event.aggregate,
          panelAuthority: event.refutationAuthority,
          threshold: event.panelAuthority.threshold,
        });
        if (!reproved.ok || JSON.stringify(reproved.value) !== JSON.stringify(event.panelAuthority)) {
          return rejectTransition(state, event, "aggregate-route-mismatch",
            "critical route requires persisted T2 authority matching the exact standalone finding brief");
        }
      }
      return event.kind === "aggregate-clean"
        ? readyToFinalize(state, event, event.aggregate, null)
        : machineSuccess(canonicalRecord({
            ...state,
            kind: "awaiting-refutation",
            completion: state.completion,
            aggregate: event.aggregate,
            panelAuthority: event.panelAuthority,
            refutationAuthority: event.refutationAuthority,
          }));
    }

    case "awaiting-refutation":
      if (event.kind !== "refutation-completed") {
        return rejectTransition(state, event, "undeclared-transition", "awaiting-refutation accepts only refutation-completed");
      }
      if (typeof event.completion !== "object" || event.completion === null ||
          !("completedPanelState" in event.completion)) {
        return rejectTransition(state, event, "aggregate-route-mismatch",
          "refutation completion requires a durable completed T2 panel state");
      }
      const completionProof = parseStandaloneRefutationCompletion({
        panelAuthority: state.panelAuthority,
        aggregate: state.aggregate,
        completedPanelState: event.completion.completedPanelState,
      });
      if (!completionProof.ok ||
          JSON.stringify(completionProof.value.panelAuthority) !== JSON.stringify(state.panelAuthority) ||
          JSON.stringify(event.completion.panelAuthority) !== JSON.stringify(state.panelAuthority) ||
          event.completion.standaloneRunId !== state.authority.runId ||
          event.completion.panelRunId !== state.panelAuthority.panelRunId ||
          event.completion.findingBriefDigest !== state.panelAuthority.findingBriefDigest ||
          event.completion.manifestDigest !== state.panelAuthority.manifestDigest ||
          event.completion.threshold !== state.panelAuthority.threshold ||
          event.completion.outcomeDigest !== completionProof.value.outcomeDigest ||
          event.completion.completedPanelStateDigest !== completionProof.value.completedPanelStateDigest ||
          canonicalDigest(panelOutcomeValue(event.completion.panel)) !== completionProof.value.outcomeDigest) {
        return rejectTransition(state, event, "aggregate-route-mismatch",
          "refutation completion requires the opaque parser-produced receipt for this exact frozen panel authority");
      }
      const canonicalResult = finalizeStandaloneReview(state.aggregate, event.completion.panel);
      if (!canonicalResult.ok) {
        return rejectTransition(state, event, "aggregate-route-mismatch", "completed Refutation Panel cannot finalize the frozen standalone aggregate");
      }
      return readyToFinalize(state, event, state.aggregate, event.completion.panel);

    case "ready-to-finalize":
      if (event.kind !== "result-published") {
        return rejectTransition(state, event, "undeclared-transition", "ready-to-finalize accepts only result-published");
      }
      const published = parseAuthoritativeStandaloneReviewResult(state, event.result, event.receipt);
      if (!published.ok) {
        return rejectTransition(state, event, "publication-receipt-mismatch", published.error.message);
      }
      return machineSuccess(canonicalRecord({
        ...state,
        kind: "done",
        result: published.value,
        outcome: state.publicationIntent.artifacts[0],
        publicationReceipt: published.receipt,
      }));

    case "recoverable-blocked":
      if (event.kind !== "recovery-receipt-accepted") {
        return rejectTransition(state, event, "undeclared-transition", "recoverable-blocked accepts only recovery-receipt-accepted or another recoverable failure");
      }
      if (canonicalDigest(state.expectedIntent) !== state.expectedIntentDigest) {
        return rejectTransition(state, event, "recovery-receipt-mismatch",
          "the blocked EffectIntent changed after it was recorded");
      }
      const recoveryReconciled = reconcileEffectReceipt(state.expectedIntent, event.receipt);
      if (!recoveryReconciled.ok) {
        return rejectTransition(state, event, "recovery-receipt-mismatch",
          `recovery receipt does not reconcile with the exact blocked ${state.expectedIntent.kind} intent: ${recoveryReconciled.error.message}`);
      }
      return machineSuccess(state.predecessor);

    case "done":
    case "terminal-blocked":
      return rejectTransition(state, event, "undeclared-transition", "terminal states are monotonic and reject late input");
  }
}

function serializableRefutationAuthority(authority: RefutationPanelAuthority): unknown {
  return {
    runId: authority.runId,
    findings: authority.findings,
    lenses: authority.lenses,
    verifierSlots: authority.verifierRoster.orderedSlots,
  };
}

/**
 * The lossy shape a persisted panel checkpoint actually carries: the verifier
 * roster Map is projected to its parser inputs, so this is deliberately NOT a
 * RefutationPanelState — the compiler tracks that seam instead of an
 * `as unknown as` cast bridging it. Only the parsed `authority` is restored;
 * every other field stays the persisted JSON it was.
 */
type SerializedRefutationPanelState = Readonly<{ authority: RefutationPanelAuthority }> & Record<string, unknown>;

function serializableCompletedPanelState(
  state: Readonly<{ authority: RefutationPanelAuthority }> & Record<string, unknown>,
): unknown {
  return { ...state, authority: serializableRefutationAuthority(state.authority) };
}

function serializableRefutationCompletion(
  receipt: Readonly<{ completedPanelState: Readonly<{ authority: RefutationPanelAuthority }> }>,
): unknown {
  return { ...receipt, completedPanelState: serializableCompletedPanelState(receipt.completedPanelState) };
}

/** Versioned durable LC-2 checkpoint; Maps are projected to their parser inputs. */
export function serializeStandaloneReviewMachineState(state: StandaloneReviewMachineState): string {
  const record: Record<string, unknown> = {
    ...state,
    schema_version: state.authority.schemaVersion,
    authority: JSON.parse(serializeStandaloneReviewAuthority(state.authority)),
  };
  // Discriminant-preserving narrowing keeps durable fields aligned with the
  // exact union members that own them, so checkpoint serialization stays exhaustive.
  if ("refutationAuthority" in state) {
    record.refutationAuthority = serializableRefutationAuthority(state.refutationAuthority);
  }
  if ("refutationCompletion" in state && state.refutationCompletion !== undefined) {
    record.refutationCompletion = state.refutationCompletion === null
      ? null
      : serializableRefutationCompletion(state.refutationCompletion);
  }
  if ("aggregate" in state) {
    record.aggregate = JSON.parse(serializeStandaloneAggregate(state.aggregate));
  }
  if (state.kind === "recoverable-blocked") {
    record.predecessor = JSON.parse(serializeStandaloneReviewMachineState(state.predecessor));
  }
  if (state.kind === "done" || state.kind === "ready-to-finalize") {
    record.result = JSON.parse(serializeAdjudicatedStandaloneReview(state.result));
  }
  return JSON.stringify(record);
}

function parseSerializedRefutationAuthority(raw: unknown) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return parseRefutationPanelAuthority({ runId: undefined, findings: undefined, lenses: undefined, verifierSlots: undefined });
  }
  const record = raw as Record<string, unknown>;
  const verifierRoster = typeof record.verifierRoster === "object" && record.verifierRoster !== null
    ? record.verifierRoster as Record<string, unknown>
    : null;
  return parseRefutationPanelAuthority({
    runId: record.runId,
    findings: record.findings,
    lenses: record.lenses,
    verifierSlots: record.verifierSlots ?? verifierRoster?.orderedSlots,
  });
}

function restoreRefutationPanelState(raw: unknown): SerializedRefutationPanelState | null {
  if (typeof raw !== "object" || raw === null || !("authority" in raw)) return null;
  const record = raw as Record<string, unknown>;
  const parsed = parseSerializedRefutationAuthority(record.authority);
  return parsed.ok ? { ...record, authority: parsed.value } : null;
}

function restoreRefutationCompletion(
  raw: unknown,
  aggregate: StandaloneReviewAggregate,
  panelAuthority: FrozenStandalonePanelAuthority,
  publicationResolver: PublicationAuthorityResolver,
): StandaloneRefutationCompletionReceipt | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const completedPanelState = restoreRefutationPanelState(record.completedPanelState);
  if (completedPanelState === null && record.completedPanelCheckpoint === undefined) return null;
  const parsed = parseStandaloneRefutationCompletion({
    panelAuthority,
    aggregate,
    ...(completedPanelState === null ? {} : { completedPanelState }),
    ...(record.completedPanelCheckpoint === undefined || record.completedPanelCheckpoint === null
      ? {}
      : { completedPanelCheckpoint: record.completedPanelCheckpoint }),
    publicationResolver,
  });
  if (!parsed.ok) return null;
  const supplied = {
    ...record,
    completedPanelState: completedPanelState ?? parsed.value.completedPanelState,
    completedPanelCheckpoint: record.completedPanelCheckpoint ?? null,
  };
  return canonicalStructuralEquals(
    serializableRefutationCompletion(parsed.value),
    serializableRefutationCompletion(supplied),
  ) ? parsed.value : null;
}

type StandaloneMachineStateParseError = Readonly<{
  kind: "standalone-machine-state-rejected";
  message: string;
}>;

function parsePersistedStandaloneProgress(
  authority: FrozenStandaloneReviewAuthority,
  rawAccepted: unknown,
  rawPending: unknown,
): Readonly<{ ok: true; accepted: readonly AcceptedStandaloneSlot[]; pending: readonly PendingStandaloneSlot[] }> |
  Readonly<{ ok: false; message: string }> {
  if (!Array.isArray(rawAccepted) || !Array.isArray(rawPending)) {
    return { ok: false, message: "checkpoint accepted and pending slot projections must be arrays" };
  }
  const accepted: AcceptedStandaloneSlot[] = [];
  const pending: PendingStandaloneSlot[] = [];
  const observed = new Set<string>();
  for (const entry of rawAccepted) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, message: "checkpoint accepted slot projection is malformed" };
    }
    const record = entry as Record<string, unknown>;
    const slot = authority.roster.orderedSlots.find(({ slotId }) => slotId === record.slotId);
    // The persisted attempt is validated as 1 or 2 before it indexes the frozen
    // attempt tuple; broader lifecycle parsing enforces attempt cardinality.
    const attempt = record.attempt === 1 || record.attempt === 2
      ? slot?.attempts[record.attempt - 1]
      : undefined;
    if (slot === undefined || attempt === undefined || record.requestId !== attempt.requestId ||
        typeof record.payloadFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(record.payloadFingerprint) ||
        observed.has(slot.slotId)) {
      return { ok: false, message: "checkpoint accepted slot does not match frozen request/attempt authority" };
    }
    observed.add(slot.slotId);
    accepted.push(canonicalRecord({
      slotId: slot.slotId,
      requestId: attempt.requestId,
      attempt: attempt.attempt,
      payloadFingerprint: record.payloadFingerprint,
    }));
  }
  for (const entry of rawPending) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, message: "checkpoint pending slot projection is malformed" };
    }
    const record = entry as Record<string, unknown>;
    const slot = authority.roster.orderedSlots.find(({ slotId }) => slotId === record.slotId);
    if (slot === undefined || (record.expectedAttempt !== 1 && record.expectedAttempt !== 2) || observed.has(slot.slotId)) {
      return { ok: false, message: "checkpoint pending slot does not match frozen roster authority" };
    }
    // A pre-existing checkpoint has no `rejectionDiagnostic` at all; it replays
    // as null (the retry prompt then falls back to the generic contract
    // reminder). Any other shape is a corrupt projection, not a legacy one.
    const rawDiagnostic = record.rejectionDiagnostic;
    if (rawDiagnostic !== undefined && rawDiagnostic !== null && typeof rawDiagnostic !== "string") {
      return { ok: false, message: "checkpoint pending slot rejection diagnostic must be a string or null" };
    }
    const rejectionDiagnostic = typeof rawDiagnostic === "string" ? rawDiagnostic.trim() : "";
    if (rejectionDiagnostic !== "" && record.expectedAttempt !== 2) {
      return { ok: false, message: "checkpoint pending slot carries a rejection diagnostic without an attempt-2 expectation" };
    }
    observed.add(slot.slotId);
    pending.push(canonicalRecord({
      slotId: slot.slotId,
      expectedAttempt: record.expectedAttempt,
      rejectionDiagnostic: rejectionDiagnostic === "" ? null : rejectionDiagnostic,
    }));
  }
  if (observed.size !== authority.roster.orderedSlots.length) {
    return { ok: false, message: "checkpoint slot projections do not exactly cover the frozen roster" };
  }
  return { ok: true, accepted: Object.freeze(accepted), pending: Object.freeze(pending) };
}

/**
 * Rebuild every process-local parser brand from persisted receipts/artifacts,
 * then replay the minimum LC-2 prefix. No checkpoint field authenticates itself.
 */
export function parseStandaloneReviewMachineState(
  raw: unknown,
  publicationResolver: PublicationAuthorityResolver,
  reviewerProtocols: StandaloneReviewerProtocolResolver,
  registeredAuthority: FrozenStandaloneReviewAuthority,
): Readonly<{ ok: true; value: StandaloneReviewMachineState }> |
  Readonly<{ ok: false; error: StandaloneMachineStateParseError }> {
  const failure = (message: string) => canonicalRecord({
    ok: false as const,
    error: canonicalRecord({ kind: "standalone-machine-state-rejected" as const, message }),
  });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return failure("checkpoint must be an object");
  const record = raw as Record<string, unknown>;
  if (record.schema_version !== registeredAuthority.schemaVersion || typeof record.kind !== "string") return failure("checkpoint schema_version or kind differs from registered authority");
  const authority = parseStandaloneReviewAuthority(record.authority,
    registeredAuthority.schemaVersion === 3 ? registeredAuthority.successor : undefined);
  if (!authority.ok) return failure(authority.errors.join("; "));
  if (serializeStandaloneReviewAuthority(authority.value) !== serializeStandaloneReviewAuthority(registeredAuthority)) {
    return failure("checkpoint authority differs from independently parsed program registration");
  }

  const started = startStandaloneReviewMachine(authority.value);
  if (record.kind === "preparing") return canonicalRecord({ ok: true as const, value: started });

  if (record.kind === "recoverable-blocked") {
    const predecessor = parseStandaloneReviewMachineState(record.predecessor, publicationResolver, reviewerProtocols, registeredAuthority);
    if (!predecessor.ok) return failure(`recoverable predecessor is invalid: ${predecessor.error.message}`);
    if (predecessor.value.kind === "recoverable-blocked" || predecessor.value.kind === "done" ||
        predecessor.value.kind === "terminal-blocked") {
      return failure("recoverable predecessor must be a non-terminal LC-2 state");
    }
    if (serializeStandaloneReviewAuthority(predecessor.value.authority) !== serializeStandaloneReviewAuthority(authority.value)) {
      return failure("recoverable predecessor authority differs from the blocked checkpoint authority");
    }
    const progress = parsePersistedStandaloneProgress(authority.value, record.accepted, record.pending);
    if (!progress.ok || !canonicalStructuralEquals(progress.accepted, predecessor.value.accepted) ||
        !canonicalStructuralEquals(progress.pending, predecessor.value.pending)) {
      return failure(progress.ok
        ? "recoverable checkpoint progress differs from its predecessor"
        : progress.message);
    }
    const diagnostic = parseBlockedDiagnostic(record.diagnostic);
    if (!diagnostic.ok || diagnostic.value.kind !== "effect-blocked") {
      return failure(diagnostic.ok
        ? "recoverable checkpoint requires an infrastructure retry diagnostic"
        : diagnostic.error.message);
    }
    const parsedIntentProbe = reconcileEffectReceipt(record.expectedIntent, null);
    if (parsedIntentProbe.ok || parsedIntentProbe.error.effectId === null) {
      return failure(parsedIntentProbe.ok
        ? "recoverable checkpoint EffectIntent unexpectedly reconciled with an empty receipt"
        : parsedIntentProbe.error.message);
    }
    if (typeof record.expectedIntentDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.expectedIntentDigest) ||
        canonicalDigest(record.expectedIntent) !== record.expectedIntentDigest) {
      return failure("recoverable checkpoint EffectIntent digest is invalid or stale");
    }
    const blocked = reduceStandaloneReviewMachine(predecessor.value, {
      kind: "recoverable-effect-failed",
      diagnostic: diagnostic.value,
      intent: record.expectedIntent as EffectIntent,
    });
    if (!blocked.ok || blocked.value.kind !== "recoverable-blocked" ||
        blocked.value.expectedIntentDigest !== record.expectedIntentDigest) {
      return failure(blocked.ok ? "recoverable checkpoint did not replay to blocked" : blocked.error.message);
    }
    return canonicalRecord({ ok: true as const, value: blocked.value });
  }

  const awaiting = reduceStandaloneReviewMachine(started, {
    kind: "review-batch-published",
    runId: authority.value.runId,
  });
  if (!awaiting.ok) return failure(awaiting.error.message);
  if (record.kind === "awaiting-results") {
    const progress = parsePersistedStandaloneProgress(authority.value, record.accepted, record.pending);
    return progress.ok
      ? canonicalRecord({ ok: true as const, value: canonicalRecord({
          ...awaiting.value,
          accepted: progress.accepted,
          pending: progress.pending,
        }) })
      : failure(progress.message);
  }
  if (record.kind === "terminal-blocked") {
    const progress = parsePersistedStandaloneProgress(authority.value, record.accepted, record.pending);
    if (!progress.ok) return failure(progress.message);
    if (typeof record.failed !== "object" || record.failed === null || Array.isArray(record.failed)) {
      return failure("terminal-blocked checkpoint failed result is malformed");
    }
    const failed = record.failed as Record<string, unknown>;
    if (Object.keys(failed).sort().join(",") !== ["attempt", "message", "requestId", "slotId"].sort().join(",") ||
        failed.attempt !== 2 || typeof failed.message !== "string" || failed.message.trim() !== failed.message ||
        failed.message.length === 0) {
      return failure("terminal-blocked checkpoint failed result fields are invalid");
    }
    const projectedAwaiting = canonicalRecord({
      ...awaiting.value,
      accepted: progress.accepted,
      pending: progress.pending,
    });
    const terminal = reduceStandaloneReviewMachine(projectedAwaiting, {
      kind: "result-rejected",
      request: {
        runId: authority.value.runId,
        slotId: failed.slotId as SlotId,
        requestId: failed.requestId as RequestId,
        attempt: 2,
      },
      message: failed.message,
    });
    if (!terminal.ok || terminal.value.kind !== "terminal-blocked" ||
        !canonicalStructuralEquals(terminal.value.failed, failed)) {
      return failure(terminal.ok ? "terminal-blocked checkpoint did not replay exactly" : terminal.error.message);
    }
    return canonicalRecord({ ok: true as const, value: terminal.value });
  }

  const completion = parseStandaloneRosterCompletionProof(authority.value, publicationResolver, record.completion, reviewerProtocols);
  if (!completion.ok) return failure(completion.error.violations.map((violation) => violation.kind).join("; "));
  // A retried slot's accepted proof entry is at attempt 2. Replay the exact
  // rejection that advanced it — derived from the persisted accepted
  // projection, never from prose — so the checkpoint replays to the same
  // aggregating state the live run checkpointed. Without this, replaying
  // complete-roster-proved against a pristine pending (every slot at attempt
  // 1) refuses the retried slot's attempt-2 entry as stale and the whole
  // checkpoint becomes unrecoverable.
  const progress = parsePersistedStandaloneProgress(authority.value, record.accepted, record.pending);
  if (!progress.ok) return failure(progress.message);
  let replayBase: StandaloneReviewMachineState = awaiting.value;
  for (const entry of progress.accepted) {
    if (entry.attempt !== 2) continue;
    const slot = authority.value.roster.byId.get(entry.slotId);
    const attemptOne = slot?.attempts[0];
    if (attemptOne === undefined || attemptOne.requestId === entry.requestId) {
      return failure("checkpoint accepted attempt-2 entry lacks a canonical attempt-1 predecessor");
    }
    const rejected = reduceStandaloneReviewMachine(replayBase, {
      kind: "result-rejected",
      request: { runId: authority.value.runId, slotId: entry.slotId, requestId: attemptOne.requestId, attempt: 1 },
      message: "recovered from the persisted attempt-2 acceptance projection",
    });
    if (!rejected.ok || rejected.value.kind !== "awaiting-results") {
      return failure(rejected.ok ? "checkpoint attempt-2 acceptance did not replay to awaiting results" : rejected.error.message);
    }
    replayBase = rejected.value;
  }
  const aggregating = reduceStandaloneReviewMachine(replayBase, {
    kind: "complete-roster-proved",
    completion: completion.value,
  });
  if (!aggregating.ok) return failure(aggregating.error.message);
  if (!canonicalStructuralEquals(aggregating.value.accepted, progress.accepted)) {
    return failure("checkpoint replayed accepted-slot progress differs from the persisted projection");
  }
  if (record.kind === "aggregating") return canonicalRecord({ ok: true as const, value: aggregating.value });

  const aggregate = parseStandaloneAggregate(record.aggregate, { authority: authority.value, completion: completion.value });
  if (!aggregate.ok) return failure(aggregate.errors.join("; "));
  const criticals = standaloneCurrentPanelCriticals(aggregate.value);
  let readyOrAwaiting: StandaloneReviewMachineState;
  if (criticals.length === 0) {
    const ready = reduceStandaloneReviewMachine(aggregating.value, { kind: "aggregate-clean", aggregate: aggregate.value });
    if (!ready.ok) return failure(ready.error.message);
    readyOrAwaiting = ready.value;
  } else {
    const panelAuthority = parseFrozenStandalonePanelAuthority(record.panelAuthority, aggregate.value);
    if (!panelAuthority.ok) return failure(panelAuthority.error.message);
    const refutationAuthority = parseSerializedRefutationAuthority(record.refutationAuthority);
    if (!refutationAuthority.ok) return failure(refutationAuthority.error.message);
    const routed = reduceStandaloneReviewMachine(aggregating.value, {
      kind: "aggregate-has-criticals",
      aggregate: aggregate.value,
      panelAuthority: panelAuthority.value,
      refutationAuthority: refutationAuthority.value,
    });
    if (!routed.ok) return failure(routed.error.message);
    if (record.kind === "awaiting-refutation") return canonicalRecord({ ok: true as const, value: routed.value });
    const refutation = restoreRefutationCompletion(
      record.refutationCompletion,
      aggregate.value,
      panelAuthority.value,
      publicationResolver,
    );
    if (refutation === null) return failure("checkpoint lacks a valid durable Refutation Panel completion receipt");
    const ready = reduceStandaloneReviewMachine(routed.value, { kind: "refutation-completed", completion: refutation });
    if (!ready.ok) return failure(ready.error.message);
    readyOrAwaiting = ready.value;
  }
  if (readyOrAwaiting.kind !== "ready-to-finalize") return failure("checkpoint did not replay to ready-to-finalize");
  if (record.kind === "ready-to-finalize") {
    if (authority.value.schemaVersion === 3 && !canonicalStructuralEquals(record,
        JSON.parse(serializeStandaloneReviewMachineState(readyOrAwaiting)))) return failure("v3 ready checkpoint differs from re-proved finalization");
    return canonicalRecord({ ok: true as const, value: readyOrAwaiting });
  }
  if (record.kind !== "done") return failure(`unsupported or inconsistent checkpoint kind: ${record.kind}`);
  const done = reduceStandaloneReviewMachine(readyOrAwaiting, {
    kind: "result-published",
    result: record.result,
    receipt: record.publicationReceipt as ArtifactSetPublished,
  });
  if (done.ok && authority.value.schemaVersion === 3 && !canonicalStructuralEquals(record,
      JSON.parse(serializeStandaloneReviewMachineState(done.value)))) return failure("v3 done checkpoint differs from re-proved publication");
  return done.ok ? canonicalRecord({ ok: true as const, value: done.value }) : failure(done.error.message);
}

export const STANDALONE_RESULT_SLOT = "result.json" as const;

export function canonicalStandaloneResultArtifact(
  result: AdjudicatedStandaloneReview,
): DomainResult<ArtifactRef, SemanticPayloadParseError> {
  const bytes = Buffer.from(serializeAdjudicatedStandaloneReview(result), "utf-8");
  const artifact = parseArtifactRef({
    runId: result.runId,
    slot: STANDALONE_RESULT_SLOT,
    digest: sha256Bytes(bytes),
    byteLength: bytes.byteLength,
  });
  return artifact.ok
    ? resultOk(artifact.value)
    : resultFail({ message: `canonical standalone result artifact is invalid: ${artifact.error.message}` });
}
