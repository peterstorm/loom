/**
 * Sub-domain volume of the orchestration shared kernel. The module-level
 * contract lives in index.ts (facade); this file owns one region of the
 * kernel and exports its internals so sibling volumes can import them.
 * Pure module: no I/O, no clock, no randomness.
 */
import { parseAgentName, parseLlmProfileId, parseRecordedLlmProfileId, piModelPattern, recordedProfileBindings, resolveAgentPolicy, type ClaudeCodeBinding, type LoomAgentName, type PiBinding, type RecordedLlmProfileId } from '../model-profiles';
import { canonicalRecord, describeUnknown, failure, parseArtifactByteLength, parseArtifactDigest, parseContextDigest, parseOrchestrationRunId, parseRequestId, parseSlotId, success, type ArtifactByteLength, type ArtifactDigest, type ContextDigest, type DomainResult, type NonEmpty, type OrchestrationRunId, type RequestId, type SemanticAttempt, type SlotId } from './identity';
import { includes, readDenseDataArray, readExactDataRecord, type DataBoundaryError, type DataBoundaryReason } from './bytes';
import { AGENT_REQUIRED_SKILLS, parseFixedArtifactSlot, type ExactHarnessBinding, type FixedArtifactSlot } from './artifacts';
import { ORCHESTRATION_PROGRAMS, type OrchestrationProgram } from './programs';
import { type SemanticPayloadDiagnostic } from './errors';

export type AgentRequestAuthority<Attempt extends SemanticAttempt = SemanticAttempt> = Readonly<{
  runId: OrchestrationRunId;
  requestId: RequestId;
  slotId: SlotId;
  program: OrchestrationProgram;
  role: LoomAgentName;
  attempt: Attempt;
  /** The profile the request was issued under; a stored request may name a retired one. */
  modelProfile: RecordedLlmProfileId;
  harnessBinding: ExactHarnessBinding;
  requiredSkill: string | null;
  contextDigest: ContextDigest;
  outputSlot: FixedArtifactSlot;
}>;

export type AgentRequestAuthorityViolation = Readonly<{
  kind:
    | "invalid-agent-request-field"
    | "unknown-agent-request-field"
    | "model-binding-mismatch"
    | "model-policy-mismatch"
    | "skill-policy-mismatch"
    | "policy-resolution-failed";
  field: string;
  message: string;
}>;

export type AgentRequestAuthorityError = Readonly<{
  kind: "invalid-agent-request-authority";
  violations: NonEmpty<AgentRequestAuthorityViolation>;
}>;

export const violation = (
  kind: AgentRequestAuthorityViolation["kind"],
  field: string,
  message: string,
): AgentRequestAuthorityViolation => canonicalRecord({ kind, field, message });

export function parseRequiredSkill(raw: unknown): DomainResult<string | null, AgentRequestAuthorityViolation> {
  return raw === null || (typeof raw === "string" && raw.trim() === raw && /^[a-z0-9][a-z0-9-]*$/.test(raw))
    ? success(raw)
    : failure(violation(
        "invalid-agent-request-field",
        "requiredSkill",
        "requiredSkill must be null or a non-empty canonical Skill name",
      ));
}

export function parseAttempt(raw: unknown): DomainResult<SemanticAttempt, AgentRequestAuthorityViolation> {
  return raw === 1 || raw === 2
    ? success(raw)
    : failure(violation("invalid-agent-request-field", "attempt", "attempt must be 1 or 2"));
}

export const PI_BINDING_KEYS = Object.freeze(["harness", "provider", "model", "thinking"] as const);
export const CLAUDE_BINDING_KEYS = Object.freeze(["harness", "model"] as const);

export function authorityBoundaryViolation(
  error: DataBoundaryError,
  field: string,
  mismatchKind: AgentRequestAuthorityViolation["kind"] = "invalid-agent-request-field",
): AgentRequestAuthorityViolation {
  const nestedField = error.field === null ? field : `${field}.${error.field}`;
  const kind = error.reason === "unknown-field" || error.reason === "symbol-field"
    ? "unknown-agent-request-field"
    : mismatchKind;
  return violation(kind, nestedField, error.message);
}

export function exactBindingViolations(
  raw: unknown,
  field: "harnessBinding.pi" | "harnessBinding.claude",
  expected: PiBinding | ClaudeCodeBinding,
): readonly AgentRequestAuthorityViolation[] {
  const allowed = expected.harness === "pi" ? PI_BINDING_KEYS : CLAUDE_BINDING_KEYS;
  const parsed = readExactDataRecord(raw, allowed, field);
  if (!parsed.ok) {
    return [authorityBoundaryViolation(parsed.error, field, "model-binding-mismatch")];
  }
  const violations: AgentRequestAuthorityViolation[] = [];
  for (const key of allowed) {
    if (parsed.value[key] !== expected[key as keyof typeof expected]) {
      violations.push(violation(
        "model-binding-mismatch",
        `${field}.${key}`,
        `${field}.${key} must exactly match the resolved model profile`,
      ));
    }
  }
  return violations;
}

/**
 * Why a recorded Pi binding is none of the bindings its profile admits. With
 * one admissible binding the per-field exactness violations name the field;
 * with several, a well-formed binding is reported once against the whole set.
 */
function recordedPiBindingViolations(
  raw: unknown,
  profileId: RecordedLlmProfileId,
  allowed: readonly [PiBinding, ...PiBinding[]],
): readonly AgentRequestAuthorityViolation[] {
  if (allowed.length === 1) return exactBindingViolations(raw, "harnessBinding.pi", allowed[0]);
  const parsed = readExactDataRecord(raw, PI_BINDING_KEYS, "harnessBinding.pi");
  if (!parsed.ok) return [authorityBoundaryViolation(parsed.error, "harnessBinding.pi", "model-binding-mismatch")];
  return [violation(
    "model-binding-mismatch",
    "harnessBinding.pi",
    `harnessBinding.pi must be a binding profile '${profileId}' has issued: ${allowed.map(piModelPattern).join(", ")}`,
  )];
}


export function samePiBinding(raw: unknown, expected: PiBinding): boolean {
  const parsed = readExactDataRecord(raw, PI_BINDING_KEYS, "Pi binding");
  return parsed.ok && parsed.value.harness === expected.harness &&
    parsed.value.provider === expected.provider && parsed.value.model === expected.model &&
    parsed.value.thinking === expected.thinking;
}

export function sameClaudeBinding(raw: unknown, expected: ClaudeCodeBinding): boolean {
  const parsed = readExactDataRecord(raw, CLAUDE_BINDING_KEYS, "Claude binding");
  return parsed.ok && parsed.value.harness === expected.harness && parsed.value.model === expected.model;
}

export function sameHarnessBinding(left: ExactHarnessBinding, right: ExactHarnessBinding): boolean {
  return samePiBinding(left.pi, right.pi) && sameClaudeBinding(left.claude, right.claude);
}

/**
 * Field-by-field equality for a request authority — the ONE copy.
 *
 * The former `standalone-review-machine`'s `sameAcceptedAuthority` and `standalone-review`'s
 * `sameCaptureRequest` were byte-identical, and both compared `harnessBinding`
 * with `JSON.stringify` rather than the `sameHarnessBinding` comparator sitting
 * beside them here — so key order in a rehydrated binding could decide whether a
 * captured result matched its issued request. Two copies of an equality rule is
 * one copy too many when the rule decides whether evidence is accepted.
 */
export function sameAgentRequestAuthority(
  actual: AgentRequestAuthority,
  expected: AgentRequestAuthority,
): boolean {
  return actual.runId === expected.runId && actual.requestId === expected.requestId &&
    actual.slotId === expected.slotId && actual.program === expected.program && actual.role === expected.role &&
    actual.attempt === expected.attempt && actual.modelProfile === expected.modelProfile &&
    actual.requiredSkill === expected.requiredSkill && actual.contextDigest === expected.contextDigest &&
    actual.outputSlot.path === expected.outputSlot.path &&
    sameHarnessBinding(actual.harnessBinding, expected.harnessBinding);
}

export function canonicalHarnessBinding(pi: PiBinding, claude: ClaudeCodeBinding): ExactHarnessBinding {
  return canonicalRecord({
    pi: canonicalRecord(pi),
    claude: canonicalRecord({ harness: "claude-code", model: claude.model }),
  });
}

export const AGENT_REQUEST_KEYS = [
  "runId",
  "requestId",
  "slotId",
  "program",
  "role",
  "attempt",
  "modelProfile",
  "harnessBinding",
  "requiredSkill",
  "contextDigest",
  "outputSlot",
] as const;

/**
 * How a request authority reached this parser.
 *
 * "issue"  — the authority is being CONSTRUCTED now from the live catalog.
 *            The role must carry its catalog profile, and the binding must be
 *            that profile's current lowering.
 * "stored" — the authority is being READ BACK from an immutable run artifact,
 *            event, receipt, or publication record. It is HISTORY: "issued
 *            under profile X, ran on model Y." Re-checking history against
 *            today's policy is a category error — promoting an agent to a new
 *            profile, retiring a profile, or retargeting one would otherwise
 *            strand every run already on disk. The binding must still be one
 *            the recorded profile has issued (`recordedProfileBindings`).
 */
export type AgentRequestAuthorityOrigin = "issue" | "stored";

function parseAgentRequestAuthorityInMode(
  raw: unknown,
  origin: AgentRequestAuthorityOrigin,
): DomainResult<AgentRequestAuthority, AgentRequestAuthorityError> {
  const request = readExactDataRecord(raw, AGENT_REQUEST_KEYS, "agent request authority");
  if (!request.ok) {
    return failure(canonicalRecord({
      kind: "invalid-agent-request-authority",
      violations: Object.freeze([
        authorityBoundaryViolation(request.error, "request"),
      ]) as NonEmpty<AgentRequestAuthorityViolation>,
    }));
  }

  const fields = request.value;
  const violations: AgentRequestAuthorityViolation[] = [];
  const runId = parseOrchestrationRunId(fields.runId);
  const requestId = parseRequestId(fields.requestId);
  const slotId = parseSlotId(fields.slotId);
  const contextDigest = parseContextDigest(fields.contextDigest);
  const outputSlot = parseFixedArtifactSlot(fields.outputSlot);
  const attempt = parseAttempt(fields.attempt);
  const skill = parseRequiredSkill(fields.requiredSkill);
  const role: DomainResult<LoomAgentName, Readonly<{ message: string }>> = typeof fields.role === "string"
    ? parseAgentName(fields.role)
    : failure(canonicalRecord({ message: `agent role must be a string; received ${describeUnknown(fields.role)}` }));
  // An issued authority names a profile the catalog issues today; a stored one
  // may name a profile the catalog has since retired.
  const profileId: DomainResult<RecordedLlmProfileId, Readonly<{ message: string }>> = typeof fields.modelProfile === "string"
    ? (origin === "issue" ? parseLlmProfileId : parseRecordedLlmProfileId)(fields.modelProfile)
    : failure(canonicalRecord({ message: `model profile must be a string; received ${describeUnknown(fields.modelProfile)}` }));

  if (!runId.ok) violations.push(violation("invalid-agent-request-field", "runId", runId.error.message));
  if (!requestId.ok) violations.push(violation("invalid-agent-request-field", "requestId", requestId.error.message));
  if (!slotId.ok) violations.push(violation("invalid-agent-request-field", "slotId", slotId.error.message));
  if (!contextDigest.ok) violations.push(violation("invalid-agent-request-field", "contextDigest", contextDigest.error.message));
  if (!outputSlot.ok) violations.push(violation("invalid-agent-request-field", "outputSlot", outputSlot.error.message));
  if (!attempt.ok) violations.push(attempt.error);
  if (!skill.ok) violations.push(skill.error);
  if (!role.ok) violations.push(violation("invalid-agent-request-field", "role", role.error.message));
  if (!profileId.ok) violations.push(violation("invalid-agent-request-field", "modelProfile", profileId.error.message));
  const program: OrchestrationProgram | null = includes(ORCHESTRATION_PROGRAMS, fields.program) ? fields.program : null;
  if (program === null) {
    violations.push(violation(
      "invalid-agent-request-field",
      "program",
      `program must be one of: ${ORCHESTRATION_PROGRAMS.join(", ")}`,
    ));
  }

  // A stored authority carries its own profile and Skill as recorded facts, so
  // neither role -> profile nor role -> Skill is re-derived from today's tables.
  let policyResolved = origin === "stored";
  if (origin === "issue" && role.ok) {
    const policy = resolveAgentPolicy(role.value);
    if (!policy.ok) {
      violations.push(violation(
        "policy-resolution-failed",
        "role",
        `cannot resolve policy for parsed role '${role.value}': ${policy.error.message}`,
      ));
    } else {
      policyResolved = true;
      if (profileId.ok && profileId.value !== policy.value.profile) {
        violations.push(violation(
          "model-policy-mismatch",
          "modelProfile",
          `role '${role.value}' requires profile '${policy.value.profile}', received '${profileId.value}'`,
        ));
      }
      if (skill.ok) {
        const expectedSkill = AGENT_REQUIRED_SKILLS[role.value];
        if (skill.value !== expectedSkill) {
          violations.push(violation(
            "skill-policy-mismatch",
            "requiredSkill",
            `role '${role.value}' requires Skill ${expectedSkill === null ? "<none>" : `'${expectedSkill}'`}, received ${skill.value === null ? "<none>" : `'${skill.value}'`}`,
          ));
        }
      }
    }
  }

  const binding = readExactDataRecord(fields.harnessBinding, ["pi", "claude"], "harnessBinding");
  if (!binding.ok) {
    violations.push(authorityBoundaryViolation(binding.error, "harnessBinding", "model-binding-mismatch"));
  }

  // The profile -> harnessBinding check resolves the RECORDED profile id, so it
  // is a self-consistency (tamper) check, never a drift check: an issued
  // authority must carry the profile's current binding, a stored one any
  // binding that profile has issued.
  let resolvedBinding: ExactHarnessBinding | null = null;
  if (profileId.ok) {
    const recorded = recordedProfileBindings(profileId.value);
    const allowedPi = origin === "issue" ? [recorded.pi[0]] as const : recorded.pi;
    const rawPi = binding.ok ? binding.value.pi : undefined;
    const rawClaude = binding.ok ? binding.value.claude : undefined;
    const matchedPi = allowedPi.find((candidate) => samePiBinding(rawPi, candidate));
    const piViolations = matchedPi === undefined ? recordedPiBindingViolations(rawPi, profileId.value, allowedPi) : [];
    const claudeViolations = exactBindingViolations(rawClaude, "harnessBinding.claude", recorded.claude);
    violations.push(...piViolations, ...claudeViolations);
    if (matchedPi !== undefined && claudeViolations.length === 0) {
      resolvedBinding = canonicalHarnessBinding(matchedPi, recorded.claude);
    }
  }

  const head = violations[0];
  if (head !== undefined) {
    return failure(canonicalRecord({
      kind: "invalid-agent-request-authority",
      violations: Object.freeze([head, ...violations.slice(1)]) as NonEmpty<AgentRequestAuthorityViolation>,
    }));
  }

  if (
    !runId.ok || !requestId.ok || !slotId.ok || !contextDigest.ok || !outputSlot.ok ||
    !attempt.ok || !skill.ok || !role.ok || !profileId.ok || !policyResolved ||
    program === null || resolvedBinding === null
  ) {
    return failure(canonicalRecord({
      kind: "invalid-agent-request-authority",
      violations: Object.freeze([
        violation("policy-resolution-failed", "request", "request policy could not be completely resolved"),
      ]) as NonEmpty<AgentRequestAuthorityViolation>,
    }));
  }

  return success(canonicalRecord({
    runId: runId.value,
    requestId: requestId.value,
    slotId: slotId.value,
    program,
    role: role.value,
    attempt: attempt.value,
    modelProfile: profileId.value,
    harnessBinding: resolvedBinding,
    requiredSkill: origin === "stored" ? skill.value : AGENT_REQUIRED_SKILLS[role.value],
    contextDigest: contextDigest.value,
    outputSlot: outputSlot.value,
  }));
}

/** Strict parse for an authority being issued now. */
export function parseAgentRequestAuthority(
  raw: unknown,
): DomainResult<AgentRequestAuthority, AgentRequestAuthorityError> {
  return parseAgentRequestAuthorityInMode(raw, "issue");
}

/**
 * Parse an authority read back from an immutable artifact. Structural and
 * self-consistency checks are identical to the strict parser; only the two
 * drift-sensitive couplings against the CURRENT policy tables are skipped.
 */
export function parseStoredAgentRequestAuthority(
  raw: unknown,
): DomainResult<AgentRequestAuthority, AgentRequestAuthorityError> {
  return parseAgentRequestAuthorityInMode(raw, "stored");
}

export function parseAgentRequestAuthorityForAttempt<Attempt extends SemanticAttempt>(
  raw: unknown,
  expectedAttempt: Attempt,
  origin: AgentRequestAuthorityOrigin = "issue",
): DomainResult<AgentRequestAuthority<Attempt>, AgentRequestAuthorityError> {
  const parsed = parseAgentRequestAuthorityInMode(raw, origin);
  if (!parsed.ok) return parsed;
  return parsed.value.attempt === expectedAttempt
    ? success(parsed.value as AgentRequestAuthority<Attempt>)
    : failure(canonicalRecord({
        kind: "invalid-agent-request-authority",
        violations: Object.freeze([violation(
          "invalid-agent-request-field",
          "attempt",
          `request must authorize semantic attempt ${expectedAttempt}, received ${parsed.value.attempt}`,
        )]) as NonEmpty<AgentRequestAuthorityViolation>,
      }));
}

export type AgentRosterSlot = Readonly<{
  slotId: SlotId;
  attempts: readonly [AgentRequestAuthority<1>, AgentRequestAuthority<2>];
}>;

export type UnissuedResultCause =
  | Readonly<{ kind: "invalid-publication-identity"; message: string }>
  | Readonly<{ kind: "publication-authority-resolution-failed"; message: string }>
  | Readonly<{ kind: "publication-identity-mismatch"; message: string }>
  | Readonly<{ kind: "issued-request-invalid"; message: string }>
  | Readonly<{
      kind: "issued-request-authority-mismatch";
      fields: NonEmpty<string>;
      message: string;
    }>;

export type RosterViolation =
  | Readonly<{ kind: "empty-roster" }>
  | Readonly<{ kind: "untrusted-exact-roster" }>
  | Readonly<{
      kind: "malformed-roster-boundary";
      field: string | null;
      index: number | null;
      reason: DataBoundaryReason;
      message: string;
    }>
  | Readonly<{ kind: "malformed-roster-slot"; index: number }>
  | Readonly<{ kind: "duplicate-slot"; slotId: SlotId }>
  | Readonly<{ kind: "duplicate-request"; requestId: RequestId }>
  | Readonly<{ kind: "duplicate-context"; contextDigest: ContextDigest }>
  | Readonly<{
      kind: "duplicate-output-path";
      path: string;
      first: Readonly<{ slotId: SlotId; requestId: RequestId; attempt: SemanticAttempt }>;
      duplicate: Readonly<{ slotId: SlotId; requestId: RequestId; attempt: SemanticAttempt }>;
    }>
  | Readonly<{ kind: "attempt-pair-mismatch"; slotId: SlotId; field: string }>
  | Readonly<{
      kind: "malformed-attempt-authority";
      attempt: SemanticAttempt;
      authorityViolations: NonEmpty<AgentRequestAuthorityViolation>;
    }>
  | Readonly<{ kind: "roster-run-mismatch"; slotId: SlotId }>
  | Readonly<{ kind: "roster-program-mismatch"; slotId: SlotId }>
  | Readonly<{ kind: "result-count-mismatch"; expected: number; actual: number }>
  | Readonly<{
      kind: "malformed-result-boundary";
      field: string | null;
      index: number | null;
      reason: DataBoundaryReason;
      message: string;
    }>
  | Readonly<{
      kind: "malformed-result";
      index: number;
      authorityViolations?: NonEmpty<AgentRequestAuthorityViolation>;
    }>
  | Readonly<{
      kind: "unissued-result";
      index: number;
      requestId: RequestId | null;
      cause: UnissuedResultCause;
    }>
  | Readonly<{ kind: "missing-result"; slotId: SlotId }>
  | Readonly<{ kind: "duplicate-result"; slotId: SlotId }>
  | Readonly<{ kind: "surplus-result"; index: number; slotId: SlotId | null }>
  | Readonly<{ kind: "result-binding-mismatch"; slotId: SlotId; field: string }>
  | Readonly<{
      kind: "invalid-result-payload";
      index: number;
      message: string;
      diagnostic: SemanticPayloadDiagnostic;
    }>;

export type AgentRosterSlotError = Readonly<{
  kind: "invalid-agent-roster-slot";
  violations: NonEmpty<RosterViolation>;
}>;

export function authorityPairMismatches(
  first: AgentRequestAuthority<1>,
  retry: AgentRequestAuthority<2>,
): readonly string[] {
  const mismatches: string[] = [];
  if (first.attempt !== 1 || retry.attempt !== 2) mismatches.push("attempt");
  if (first.runId !== retry.runId) mismatches.push("runId");
  if (first.slotId !== retry.slotId) mismatches.push("slotId");
  if (first.program !== retry.program) mismatches.push("program");
  if (first.role !== retry.role) mismatches.push("role");
  if (first.modelProfile !== retry.modelProfile) mismatches.push("modelProfile");
  if (!sameHarnessBinding(first.harnessBinding, retry.harnessBinding)) mismatches.push("harnessBinding");
  if (first.requiredSkill !== retry.requiredSkill) mismatches.push("requiredSkill");
  if (first.outputSlot.path === retry.outputSlot.path) mismatches.push("outputSlot");
  if (first.requestId === retry.requestId) mismatches.push("requestId");
  if (first.contextDigest === retry.contextDigest) mismatches.push("contextDigest");
  return mismatches;
}

/**
 * Parse one roster slot's attempt pair. A roster is read as RECORDED: each
 * attempt parses in "stored" mode, so a roster issued under a since-retired
 * profile or binding still parses. The check against today's catalog happens
 * once, where each request is minted (`parseAgentRequestAuthority`), never
 * again when a roster is re-read from a checkpoint or registration.
 */
export function parseAgentRosterSlot(
  rawFirst: unknown,
  rawRetry: unknown,
): DomainResult<AgentRosterSlot, AgentRosterSlotError> {
  const first = parseAgentRequestAuthorityForAttempt(rawFirst, 1, "stored");
  const retry = parseAgentRequestAuthorityForAttempt(rawRetry, 2, "stored");
  const violations: RosterViolation[] = [];
  if (!first.ok) {
    violations.push(canonicalRecord({
      kind: "malformed-attempt-authority",
      attempt: 1,
      authorityViolations: first.error.violations,
    }));
  }
  if (!retry.ok) {
    violations.push(canonicalRecord({
      kind: "malformed-attempt-authority",
      attempt: 2,
      authorityViolations: retry.error.violations,
    }));
  }
  if (!first.ok || !retry.ok) {
    return failure(canonicalRecord({
      kind: "invalid-agent-roster-slot",
      violations: Object.freeze(violations) as NonEmpty<RosterViolation>,
    }));
  }

  for (const field of authorityPairMismatches(first.value, retry.value)) {
    violations.push(canonicalRecord({ kind: "attempt-pair-mismatch", slotId: first.value.slotId, field }));
  }
  if (first.value.outputSlot.path === retry.value.outputSlot.path) {
    violations.push(canonicalRecord({
      kind: "duplicate-output-path",
      path: first.value.outputSlot.path,
      first: canonicalRecord({
        slotId: first.value.slotId,
        requestId: first.value.requestId,
        attempt: 1,
      }),
      duplicate: canonicalRecord({
        slotId: retry.value.slotId,
        requestId: retry.value.requestId,
        attempt: 2,
      }),
    }));
  }
  if (violations.length > 0) {
    return failure(canonicalRecord({
      kind: "invalid-agent-roster-slot",
      violations: Object.freeze(violations) as NonEmpty<RosterViolation>,
    }));
  }
  return success(canonicalRecord({
    slotId: first.value.slotId,
    attempts: Object.freeze([first.value, retry.value]) as readonly [AgentRequestAuthority<1>, AgentRequestAuthority<2>],
  }));
}

export declare class ExactRosterMembership {
  private readonly exactRosterMembership: true;
}
export declare class CompleteRosterMembership {
  private readonly completeRosterMembership: true;
}
export declare class InitialPublicationIssuanceMembership {
  private readonly initialPublicationIssuanceMembership: true;
}
export declare class InitialBatchPublicationIntentMembership {
  private readonly initialBatchPublicationIntentMembership: true;
}
export declare class InitialPublicationEffectPortMembership {
  private readonly initialPublicationEffectPortMembership: true;
}
export declare class AtomicInitialPublicationClaimPortMembership {
  private readonly atomicInitialPublicationClaimPortMembership: true;
}
/**
 * The `ExactRoster` proof cache. Membership here — not any field the value
 * carries — is what makes a roster trusted, so it is module-private for exactly
 * the reason `publication.ts` gives for its own caches: an exported `WeakSet`
 * hands every importer `.add(handBuiltObject)`, which is the one capability the
 * cache exists to withhold, and direct sub-module imports that bypass the
 * index.ts facade are an established pattern in this repo. `completion.ts` — the
 * only cross-volume reader — is served by the narrow read-only accessor below.
 *
 * The sibling `completeRosterCache` is NOT here: `completion.ts` is its sole
 * minter and sole reader, so it lives private to that volume rather than being
 * exported out of this one.
 */
const exactRosterCache = new WeakSet<object>();

/**
 * Was `value` minted by `parseExactRoster`? Read-only view of the proof cache,
 * granting no way to create one.
 */
export function isRegisteredExactRoster(value: unknown): boolean {
  return typeof value === "object" && value !== null && exactRosterCache.has(value);
}
export type ExactRoster<S extends AgentRosterSlot = AgentRosterSlot> = ExactRosterMembership & Readonly<{
  runId: OrchestrationRunId;
  program: OrchestrationProgram;
  orderedSlots: NonEmpty<S>;
  byId: ReadonlyMap<SlotId, S>;
}>;

export type ExactRosterError = Readonly<{
  kind: "invalid-exact-roster";
  violations: NonEmpty<RosterViolation>;
}>;

/**
 * A real `Map` that refuses every mutator, rather than a record that merely
 * looks like one.
 *
 * The previous view was a `canonicalRecord` carrying `get`/`has`/`entries`/
 * `forEach` as own enumerable FUNCTION properties. It typed as `ReadonlyMap`
 * and read like one, but it was not `instanceof Map`, and both of the contract's
 * value-level operations quietly did the wrong thing with it:
 * `canonicalStructuralEquals` fell past its `Map` arm into `recordsEqual`, which
 * compares those function fields with `Object.is` — so two independently built
 * views of the SAME entries were never equal, which is exactly the checkpoint
 * agreement `canonicalStructuralEquals` exists to decide; and `JSON.stringify`
 * drops function-valued keys, so a roster serialized to `{"size":N}` — a
 * plausible-looking document with the entries silently gone.
 *
 * A proxy over an encapsulated native `Map` keeps both value-level behaviours:
 * `structurallyEqual` takes its `Map` arm and compares by content, while
 * `JSON.stringify` produces `{}`. Unlike a subclass override, the proxy also
 * withholds the native receiver, so `Map.prototype.set.call(view, ...)` fails
 * instead of bypassing the public mutators. `forEach` is adapted separately
 * because native Map would otherwise leak its mutable target as callback arg 3.
 */
export function immutableMap<K, V>(entries: readonly (readonly [K, V])[]): ReadonlyMap<K, V> {
  const target = new Map<K, V>(entries);
  const immutableMutation = (): never => {
    throw new TypeError("roster map is immutable");
  };
  let view: ReadonlyMap<K, V>;
  const proxy = new Proxy(target, {
    get(map, property) {
      if (property === "set" || property === "delete" || property === "clear") return immutableMutation;
      if (property === "forEach") {
        return (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void => {
          map.forEach((value, key) => callback.call(thisArg, value, key, view));
        };
      }
      const value: unknown = Reflect.get(map, property, map);
      if (property === "constructor") return value;
      return typeof value === "function" ? value.bind(map) : value;
    },
  });
  view = proxy;
  return Object.freeze(proxy);
}

export function parseExactRoster(
  rawSlots: unknown,
): DomainResult<ExactRoster<AgentRosterSlot>, ExactRosterError> {
  const slots = readDenseDataArray(rawSlots, "exact roster slots");
  if (!slots.ok) {
    return failure(canonicalRecord({
      kind: "invalid-exact-roster",
      violations: Object.freeze([canonicalRecord({
        kind: "malformed-roster-boundary" as const,
        field: slots.error.field,
        index: slots.error.index,
        reason: slots.error.reason,
        message: slots.error.message,
      })]) as NonEmpty<RosterViolation>,
    }));
  }
  if (slots.value.length === 0) {
    return failure(canonicalRecord({
      kind: "invalid-exact-roster",
      violations: Object.freeze([canonicalRecord({ kind: "empty-roster" as const })]) as NonEmpty<RosterViolation>,
    }));
  }

  const violations: RosterViolation[] = [];
  const canonicalSlots: AgentRosterSlot[] = [];
  const slotIds = new Set<SlotId>();
  const requestIds = new Set<RequestId>();
  const contextDigests = new Set<ContextDigest>();
  const outputPaths = new Map<string, Readonly<{
    slotId: SlotId;
    requestId: RequestId;
    attempt: SemanticAttempt;
  }>>();
  let canonicalRun: OrchestrationRunId | null = null;
  let canonicalProgram: OrchestrationProgram | null = null;

  slots.value.forEach((rawSlot, index) => {
    const slotRecord = readExactDataRecord(rawSlot, ["slotId", "attempts"], `exact roster slot ${index}`);
    if (!slotRecord.ok) {
      violations.push(canonicalRecord({ kind: "malformed-roster-slot", index }));
      return;
    }
    const attempts = readDenseDataArray(slotRecord.value.attempts, `exact roster slot ${index} attempts`);
    if (!attempts.ok || attempts.value.length !== 2) {
      violations.push(canonicalRecord({ kind: "malformed-roster-slot", index }));
      return;
    }
    const parsedSlot = parseAgentRosterSlot(attempts.value[0], attempts.value[1]);
    if (!parsedSlot.ok) {
      violations.push(...parsedSlot.error.violations);
      return;
    }
    const canonicalSlot = parsedSlot.value;
    canonicalSlots.push(canonicalSlot);
    if (slotRecord.value.slotId !== canonicalSlot.slotId) {
      violations.push(canonicalRecord({ kind: "attempt-pair-mismatch", slotId: canonicalSlot.slotId, field: "slotId" }));
    }
    if (canonicalRun === null) canonicalRun = canonicalSlot.attempts[0].runId;
    if (canonicalProgram === null) canonicalProgram = canonicalSlot.attempts[0].program;
    if (canonicalSlot.attempts[0].runId !== canonicalRun) {
      violations.push(canonicalRecord({ kind: "roster-run-mismatch", slotId: canonicalSlot.slotId }));
    }
    if (canonicalSlot.attempts[0].program !== canonicalProgram) {
      violations.push(canonicalRecord({ kind: "roster-program-mismatch", slotId: canonicalSlot.slotId }));
    }
    if (slotIds.has(canonicalSlot.slotId)) violations.push(canonicalRecord({ kind: "duplicate-slot", slotId: canonicalSlot.slotId }));
    slotIds.add(canonicalSlot.slotId);
    for (const request of canonicalSlot.attempts) {
      if (requestIds.has(request.requestId)) violations.push(canonicalRecord({ kind: "duplicate-request", requestId: request.requestId }));
      requestIds.add(request.requestId);
      if (contextDigests.has(request.contextDigest)) violations.push(canonicalRecord({ kind: "duplicate-context", contextDigest: request.contextDigest }));
      contextDigests.add(request.contextDigest);
      const outputAuthority = canonicalRecord({
        slotId: request.slotId,
        requestId: request.requestId,
        attempt: request.attempt,
      });
      const first = outputPaths.get(request.outputSlot.path);
      if (first === undefined) {
        outputPaths.set(request.outputSlot.path, outputAuthority);
      } else {
        violations.push(canonicalRecord({
          kind: "duplicate-output-path",
          path: request.outputSlot.path,
          first,
          duplicate: outputAuthority,
        }));
      }
    }
  });

  const head = violations[0];
  if (head !== undefined || canonicalRun === null || canonicalProgram === null || canonicalSlots.length === 0) {
    const completeViolations = head === undefined
      ? [{ kind: "empty-roster" as const }]
      : [head, ...violations.slice(1)];
    return failure(canonicalRecord({
      kind: "invalid-exact-roster",
      violations: Object.freeze(completeViolations) as NonEmpty<RosterViolation>,
    }));
  }

  const orderedSlots = Object.freeze(canonicalSlots) as NonEmpty<AgentRosterSlot>;
  const exactRoster = canonicalRecord({
    runId: canonicalRun,
    program: canonicalProgram,
    orderedSlots,
    byId: immutableMap(orderedSlots.map((slot) => [slot.slotId, slot] as const)),
  }) as unknown as ExactRoster<AgentRosterSlot>;
  exactRosterCache.add(exactRoster);
  return success(exactRoster);
}

/**
 * The canonical form of an exact roster, ready to serialize: the roster's
 * fields with its DERIVED `byId` view omitted, and nothing else changed (key
 * order kept).
 *
 * `parseExactRoster` builds `byId` from `orderedSlots` and from nothing else,
 * so the view carries no information the array does not already have — while
 * its serialized text is an accident of how a `Map` happens to stringify:
 * `{}` for the real `immutableMap` above, `{"size":N}` for the fake
 * `ReadonlyMap` record it replaced, a form that still sits in durable
 * checkpoints. Comparing canonical forms compares the slots a roster was
 * parsed from, under any of those serializations.
 *
 * Takes a parsed `ExactRoster` or a raw roster read back from disk alike,
 * because the comparisons it serves run over both. A value that is not a
 * record passes through unchanged, so it still compares unequal.
 */
export function canonicalExactRosterJson(roster: unknown): unknown {
  return typeof roster === "object" && roster !== null && !Array.isArray(roster)
    ? Object.fromEntries(Object.entries(roster).filter(([key]) => key !== "byId"))
    : roster;
}

export type ArtifactRef = Readonly<{
  runId: OrchestrationRunId;
  slot: FixedArtifactSlot;
  digest: ArtifactDigest;
  byteLength: ArtifactByteLength;
}>;

export type ArtifactRefError = Readonly<{
  kind: "invalid-artifact-ref";
  field: string;
  message: string;
}>;

export function parseArtifactRef(raw: unknown): DomainResult<ArtifactRef, ArtifactRefError> {
  const artifact = readExactDataRecord(raw, ["runId", "slot", "digest", "byteLength"], "artifact");
  if (!artifact.ok) {
    return failure(canonicalRecord({
      kind: "invalid-artifact-ref",
      field: artifact.error.field ?? "artifact",
      message: artifact.error.message,
    }));
  }
  const runId = parseOrchestrationRunId(artifact.value.runId);
  const slot = parseFixedArtifactSlot(artifact.value.slot);
  const digest = parseArtifactDigest(artifact.value.digest);
  const byteLength = parseArtifactByteLength(artifact.value.byteLength);
  if (!runId.ok) return failure(canonicalRecord({ kind: "invalid-artifact-ref", field: "runId", message: runId.error.message }));
  if (!slot.ok) return failure(canonicalRecord({ kind: "invalid-artifact-ref", field: "slot", message: slot.error.message }));
  if (!digest.ok) return failure(canonicalRecord({ kind: "invalid-artifact-ref", field: "digest", message: digest.error.message }));
  if (!byteLength.ok) return failure(canonicalRecord({ kind: "invalid-artifact-ref", field: "byteLength", message: byteLength.error.message }));
  return success(canonicalRecord({ runId: runId.value, slot: slot.value, digest: digest.value, byteLength: byteLength.value }));
}

