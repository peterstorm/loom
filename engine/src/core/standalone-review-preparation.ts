/**
 * Standalone Review preparation: parse-don't-validate construction of the frozen
 * authority — scope, Git, reviewer, model, context, request, attempt and transcript-slot
 * facts — before any reviewer is spawnable, and its exact reparse from persisted
 * registration. A successor binding is admitted only through custody membership.
 */
import { sha256Hex } from "./digest";
import {
  AGENT_REQUIRED_SKILLS, canonicalRecord, canonicalStructuralEquals, parseExactRoster, parseOrchestrationRunId,
  type AgentRosterSlot, type DomainResult, type NonEmpty,
} from "./orchestration-contract";
import { failure, success } from "./orchestration-contract/identity";
import { issuedReviewerProfile, lowerModelProfile, resolveAgentPolicy, type ReviewerIssueRoute } from "./model-profiles";
import { compareStrings } from "./ordering";
import { fail, isRecord, ok, type ParseResult } from "./panel-kernel";
import type { ReviewPath } from "./review-packet";
import { CURRENT_REVIEWER_PROTOCOL, parseReviewerProtocolDescriptor } from "./reviewer-contract";
import { STANDALONE_REVIEWER_PROTOCOL_V3, parseStandaloneReviewerProtocolV3 } from "./standalone-lineage-contract";
import { isPreparedStandaloneSuccessor } from "./standalone-review";
import type { FrozenStandaloneReviewAuthority, PreparedStandaloneSuccessor } from "./standalone-review-model";
import {
  exactKeys, parseChangedPaths, parseReviewMetadata, parseScopeSafety, parseStandaloneReviewScope, selectStandaloneReviewers,
  type StandaloneReviewerRole, type StandaloneScopeSafety, type StandaloneScopeSource,
} from "./standalone-review-scope";

interface PreparedStandaloneReview {
  readonly authority: FrozenStandaloneReviewAuthority;
  /** Initial requests only; attempt-2 requests remain frozen but unissued. */
  readonly initialRequests: NonEmpty<AgentRosterSlot["attempts"][0]>;
}

type StandalonePreparationError = Readonly<{
  kind: "standalone-review-preparation-blocked";
  errors: NonEmpty<string>;
}>;

interface PrepareStandaloneReviewInput {
  readonly runId: unknown;
  /** Undefined means derive exactly the canonical changed-path union. */
  readonly explicitScope?: unknown;
  readonly changedPaths: unknown;
  readonly reviewMetadata: unknown;
  readonly scopeSafety: unknown;
  readonly roster: unknown;
  readonly successor?: PreparedStandaloneSuccessor;
}

function preparationFailure(errors: readonly string[]): DomainResult<never, StandalonePreparationError> {
  const [head, ...tail] = errors.length > 0 ? errors : ["standalone review preparation failed"];
  return failure(canonicalRecord({
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
  return success(prepared);
}

interface FreshStandaloneReviewerContexts {
  /** Attempt contexts in semantic-attempt order; roles and destinations are derived internally. */
  readonly attempts: readonly [unknown, unknown];
}

interface PrepareFreshStandaloneReviewInput
  extends Omit<PrepareStandaloneReviewInput, "roster"> {
  readonly reviewerContexts: readonly FreshStandaloneReviewerContexts[];
  /** Frozen in each issued attempt's modelProfile/harnessBinding. */
  readonly reviewerIssueRoute?: ReviewerIssueRoute;
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
    const profile = issuedReviewerProfile(role, "standalone-review", input.reviewerIssueRoute ?? "catalog");
    if (!profile.ok) {
      authorityErrors.push(`${role}: model profile resolution failed: ${profile.error.message}`);
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
        requestId: `request:${sha256Hex(`${runId.value}\u0000${role}\u0000${attempt}`)}`,
        slotId,
        program: "standalone-review",
        role,
        attempt,
        modelProfile: profile.value.id,
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
  return prepared.ok ? success(Object.freeze({
    authority: prepared.value.authority.schemaVersion === 3 ? prepared.value.authority
      : Object.freeze({ ...prepared.value.authority, schemaVersion: 2, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL }),
    initialRequests: prepared.value.initialRequests,
  })) : prepared;
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
