/**
 * Sub-domain volume of the orchestration shared kernel. The module-level
 * contract lives in index.ts (facade); this file owns one region of the
 * kernel and exports its internals so sibling volumes can import them.
 * Pure module: no I/O, no clock, no randomness.
 */
import { CURRENT_PI_CATALOG, currentProfileBindings, parseAgentName, parseLlmProfileId, parseRecordedLlmProfileId, piModelPattern, profileBindingsUnder, recordedProfileBindings, resolveAgentPolicy, type ClaudeCodeBinding, type CurrentProfileBindings, type LlmProfileId, type LocalPiBinding, type LoomAgentName, type PiBinding, type PiLowering, type RecordedLlmProfileId, type RecordedPiLowering } from '../model-profiles';
import { canonicalRecord, describeUnknown, failure, isNonEmpty, parseArtifactByteLength, parseArtifactDigest, parseContextDigest, parseOrchestrationRunId, parseRequestId, parseSlotId, success, type ArtifactByteLength, type ArtifactDigest, type ContextDigest, type DomainResult, type NonEmpty, type OrchestrationRunId, type RequestId, type SemanticAttempt, type SlotId } from './identity';
import { includes, readDenseDataArray, readExactDataRecord, type DataBoundaryError, type DataBoundaryReason } from './bytes';
import { parseFixedArtifactSlot, type ExactHarnessBinding, type FixedArtifactSlot } from './artifacts';
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
 * The profile a request authority names, resolved for the origin it was
 * parsed in. Its one operation, `admitPi`, decides a Pi binding: the matched
 * binding, or why `raw` is none the profile admits. HOW MANY bindings a
 * profile admits is the origin's strategy (`issuedProfile`,
 * `recordedProfile`), so a caller never knows it.
 */
type ProfileAuthority = Readonly<{
  profileId: RecordedLlmProfileId;
  claude: ClaudeCodeBinding;
  admitPi: (raw: unknown) => DomainResult<PiBinding, NonEmpty<AgentRequestAuthorityViolation>>;
}>;

/** Exactly one violation, as the non-empty list a refusal carries. */
const oneViolation = (only: AgentRequestAuthorityViolation): NonEmpty<AgentRequestAuthorityViolation> =>
  Object.freeze([only]) as NonEmpty<AgentRequestAuthorityViolation>;

/** An authority error carrying exactly one violation. */
const singleViolationError = (only: AgentRequestAuthorityViolation): AgentRequestAuthorityError =>
  canonicalRecord({ kind: "invalid-agent-request-authority", violations: oneViolation(only) });

/** Issuance: a catalog profile admits exactly its ONE lowering under the minting catalog, and each differing field is named. */
function issuedProfile(profileId: LlmProfileId, lowering: PiLowering): ProfileAuthority {
  const { claude, pi } = profileBindingsUnder(lowering, profileId);
  return Object.freeze({
    profileId,
    claude,
    admitPi: (raw: unknown) => {
      const violations = Object.freeze(exactBindingViolations(raw, "harnessBinding.pi", pi));
      return isNonEmpty(violations) ? failure(violations) : success<PiBinding>(pi);
    },
  });
}

/**
 * Recorded history: a profile — catalog or retired — admits any binding it
 * has issued. History is checked against a SET, so a well-formed refusal is
 * reported once against everything the profile has issued.
 */
function recordedProfile(profileId: RecordedLlmProfileId): ProfileAuthority {
  const { claude, pi } = recordedProfileBindings(profileId);
  return Object.freeze({
    profileId,
    claude,
    admitPi: (raw: unknown) => {
      const matched = pi.find((candidate) => samePiBinding(raw, candidate));
      if (matched !== undefined) return success(matched);
      const parsed = readExactDataRecord(raw, PI_BINDING_KEYS, "harnessBinding.pi");
      return failure(oneViolation(parsed.ok
        ? violation(
            "model-binding-mismatch",
            "harnessBinding.pi",
            `harnessBinding.pi must be a binding profile '${profileId}' has issued: ${pi.map(piModelPattern).join(", ")}`,
          )
        : authorityBoundaryViolation(parsed.error, "harnessBinding.pi", "model-binding-mismatch")));
    },
  });
}

/**
 * Everything that differs between the two origins a request authority is
 * parsed in, as data: the profile strategy, and the catalog couplings the
 * origin re-checks. The parser below asks the strategy and never branches on
 * the origin itself.
 *
 * Strategy records rather than ts-pattern: this volume is inside the audited
 * reviewer runtime closure (tests/linter/programmatic/machine-purity.test.ts),
 * which grants it no package imports.
 */
type OriginStrategy = Readonly<{
  /** The profile authority a profile id names in this origin, minting under `lowering`. */
  profile: (raw: string, lowering: PiLowering) => DomainResult<ProfileAuthority, Readonly<{ message: string }>>;
  /** Today's role -> profile and role -> Skill couplings this origin checks; a field that did not parse is not compared. */
  policyViolations: (
    role: LoomAgentName,
    profileId: RecordedLlmProfileId | null,
    skill: ParsedRequiredSkill,
  ) => readonly AgentRequestAuthorityViolation[];
}>;

/** The request's `requiredSkill` as parsed: `null` is a parsed "no Skill", distinct from a field that did not parse. */
type ParsedRequiredSkill = ReturnType<typeof parseRequiredSkill>;

const describeSkill = (skill: string | null): string => skill === null ? "<none>" : `'${skill}'`;

const ORIGIN_STRATEGIES: Readonly<Record<AgentRequestAuthorityOrigin, OriginStrategy>> = Object.freeze({
  issue: Object.freeze({
    profile: (raw: string, lowering: PiLowering) => {
      const profileId = parseLlmProfileId(raw);
      return profileId.ok ? success(issuedProfile(profileId.value, lowering)) : failure(canonicalRecord({ message: profileId.error.message }));
    },
    policyViolations: (role, profileId, skill) => {
      const policy = resolveAgentPolicy(role);
      if (!policy.ok) {
        return [violation(
          "policy-resolution-failed",
          "role",
          `cannot resolve policy for parsed role '${role}': ${policy.error.message}`,
        )];
      }
      return [
        ...(profileId !== null && profileId !== policy.value.profile
          ? [violation(
              "model-policy-mismatch",
              "modelProfile",
              `role '${role}' requires profile '${policy.value.profile}', received '${profileId}'`,
            )]
          : []),
        ...(skill.ok && skill.value !== policy.value.requiredSkill
          ? [violation(
              "skill-policy-mismatch",
              "requiredSkill",
              `role '${role}' requires Skill ${describeSkill(policy.value.requiredSkill)}, received ${describeSkill(skill.value)}`,
            )]
          : []),
      ];
    },
  } satisfies OriginStrategy),
  // A stored authority carries its own profile and Skill as recorded facts, so
  // neither role -> profile nor role -> Skill is re-derived from today's tables,
  // and no catalog's lowering is consulted: history admits what it recorded.
  stored: Object.freeze({
    profile: (raw: string) => {
      const profileId = parseRecordedLlmProfileId(raw);
      return profileId.ok ? success(recordedProfile(profileId.value)) : failure(canonicalRecord({ message: profileId.error.message }));
    },
    policyViolations: () => [],
  } satisfies OriginStrategy),
});

/**
 * The profile authority `raw` names under an origin's `strategy`: the seam
 * where a Pi binding is admitted. An issued authority names a catalog profile
 * and admits its lowering under the minting catalog — today's unless a replay
 * names another (`piCatalogAsOf`); a stored one may name a retired profile
 * and admits any binding it has issued.
 */
function parseProfileAuthority(
  raw: unknown,
  strategy: OriginStrategy,
  lowering: PiLowering,
): DomainResult<ProfileAuthority, Readonly<{ message: string }>> {
  if (typeof raw !== "string") {
    return failure(canonicalRecord({ message: `model profile must be a string; received ${describeUnknown(raw)}` }));
  }
  return strategy.profile(raw, lowering);
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
 *            that profile's current lowering. `mintAgentRequestAuthority`,
 *            the one constructor of a `MintedAgentRequestAuthority`, parses
 *            in this origin.
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
  lowering: PiLowering = CURRENT_PI_CATALOG.lowering,
): DomainResult<AgentRequestAuthority, AgentRequestAuthorityError> {
  const request = readExactDataRecord(raw, AGENT_REQUEST_KEYS, "agent request authority");
  if (!request.ok) return failure(singleViolationError(authorityBoundaryViolation(request.error, "request")));

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
  const strategy = ORIGIN_STRATEGIES[origin];
  // An issued authority names a profile the catalog issues today; a stored one
  // may name a profile the catalog has since retired.
  const profile = parseProfileAuthority(fields.modelProfile, strategy, lowering);

  if (!runId.ok) violations.push(violation("invalid-agent-request-field", "runId", runId.error.message));
  if (!requestId.ok) violations.push(violation("invalid-agent-request-field", "requestId", requestId.error.message));
  if (!slotId.ok) violations.push(violation("invalid-agent-request-field", "slotId", slotId.error.message));
  if (!contextDigest.ok) violations.push(violation("invalid-agent-request-field", "contextDigest", contextDigest.error.message));
  if (!outputSlot.ok) violations.push(violation("invalid-agent-request-field", "outputSlot", outputSlot.error.message));
  if (!attempt.ok) violations.push(attempt.error);
  if (!skill.ok) violations.push(skill.error);
  if (!role.ok) violations.push(violation("invalid-agent-request-field", "role", role.error.message));
  if (!profile.ok) violations.push(violation("invalid-agent-request-field", "modelProfile", profile.error.message));
  const program: OrchestrationProgram | null = includes(ORCHESTRATION_PROGRAMS, fields.program) ? fields.program : null;
  if (program === null) {
    violations.push(violation(
      "invalid-agent-request-field",
      "program",
      `program must be one of: ${ORCHESTRATION_PROGRAMS.join(", ")}`,
    ));
  }

  if (role.ok) {
    violations.push(...strategy.policyViolations(role.value, profile.ok ? profile.value.profileId : null, skill));
  }

  const binding = readExactDataRecord(fields.harnessBinding, ["pi", "claude"], "harnessBinding");
  if (!binding.ok) {
    violations.push(authorityBoundaryViolation(binding.error, "harnessBinding", "model-binding-mismatch"));
  }

  // The profile -> harnessBinding check resolves the RECORDED profile id, so it
  // is a self-consistency (tamper) check, never a drift check: the profile
  // authority admits the Pi binding its origin allows.
  let resolvedBinding: ExactHarnessBinding | null = null;
  if (profile.ok) {
    const pi = profile.value.admitPi(binding.ok ? binding.value.pi : undefined);
    const claudeViolations = exactBindingViolations(binding.ok ? binding.value.claude : undefined, "harnessBinding.claude", profile.value.claude);
    violations.push(...(pi.ok ? [] : pi.error), ...claudeViolations);
    if (pi.ok && claudeViolations.length === 0) {
      resolvedBinding = canonicalHarnessBinding(pi.value, profile.value.claude);
    }
  }

  const refused = Object.freeze([...violations]);
  if (isNonEmpty(refused)) return failure(canonicalRecord({ kind: "invalid-agent-request-authority", violations: refused }));

  if (
    !runId.ok || !requestId.ok || !slotId.ok || !contextDigest.ok || !outputSlot.ok ||
    !attempt.ok || !skill.ok || !role.ok || !profile.ok ||
    program === null || resolvedBinding === null
  ) {
    return failure(singleViolationError(
      violation("policy-resolution-failed", "request", "request policy could not be completely resolved"),
    ));
  }

  return success(canonicalRecord({
    runId: runId.value,
    requestId: requestId.value,
    slotId: slotId.value,
    program,
    role: role.value,
    attempt: attempt.value,
    modelProfile: profile.value.profileId,
    harnessBinding: resolvedBinding,
    requiredSkill: skill.value,
    contextDigest: contextDigest.value,
    outputSlot: outputSlot.value,
  }));
}

declare const mintedAgentRequestAuthority: unique symbol;

/** The exact bindings a request carries when it is issued today: the local Pi route and the profile's Claude model. */
export type MintedHarnessBinding = Readonly<{ pi: LocalPiBinding; claude: ClaudeCodeBinding }>;

/**
 * A request authority checked against TODAY's catalog — role -> profile,
 * role -> Skill, and the profile's current binding — once, where it is
 * minted. `mintAgentRequestAuthority` is its only constructor.
 *
 * Constraints the type carries:
 * - it is NARROWER than a recorded authority: a catalog profile
 *   (`LlmProfileId`, never a retired one) on the local Pi binding
 *   (`LocalPiBinding`, never a retired cloud target); only history is as wide
 *   as `AgentRequestAuthority`;
 * - rosters, checkpoints and diagnostics re-read authorities as recorded
 *   history and never repeat the catalog check, so an issuing seam takes this
 *   type and a builder that skipped the check does not compile there;
 * - it is a phantom brand: no runtime field, so serialization, equality and
 *   every reader typed `AgentRequestAuthority` are unchanged. It closes the
 *   forgetting path at compile time; the issuing roster seam
 *   (`issueExactRoster`) re-runs the strict parse against today's catalog, so
 *   a slot cast past the brand that is not current is refused at run time too.
 *
 * Which seams take it, and where coverage stops: docs/model-profiles-and-calibration.md,
 * "Issuance (minting)".
 */
export type MintedAgentRequestAuthority<Attempt extends SemanticAttempt = SemanticAttempt> =
  UnbrandedMintedAuthority<Attempt> & Readonly<{ [mintedAgentRequestAuthority]: true }>;

/** A minted authority's fields, before the brand that only `mintAgentRequestAuthority` attaches. */
type UnbrandedMintedAuthority<Attempt extends SemanticAttempt> =
  Readonly<Omit<AgentRequestAuthority<Attempt>, "modelProfile" | "harnessBinding"> & {
    modelProfile: LlmProfileId;
    harnessBinding: MintedHarnessBinding;
  }>;

/**
 * Strict parse of a whole raw authority claimed to be issued NOW: every
 * catalog coupling is re-derived from the role and checked. It proves the
 * authority is current, but the result is a plain `AgentRequestAuthority`:
 * minting — the one constructor of `MintedAgentRequestAuthority` — is
 * `mintAgentRequestAuthority`, which runs this parse over the catalog's own
 * answers.
 */
export function parseAgentRequestAuthority(
  raw: unknown,
): DomainResult<AgentRequestAuthority, AgentRequestAuthorityError> {
  return parseAgentRequestAuthorityInMode(raw, "issue");
}

/**
 * Everything about one request the ISSUER decides: which run, request, slot,
 * program, role, attempt, context and transcript slot. What the catalog
 * decides — profile, both bindings, required Skill — is not here.
 */
export type AgentRequestIdentity<Attempt extends SemanticAttempt = SemanticAttempt> = Readonly<{
  runId: string;
  requestId: string;
  slotId: string;
  program: OrchestrationProgram;
  role: LoomAgentName;
  attempt: Attempt;
  contextDigest: string;
  outputSlot: string | FixedArtifactSlot;
}>;

/**
 * Mint one request: the catalog's single issuance entry. The role's catalog
 * profile, that profile's current bindings and the role's required Skill are
 * filled here — no issuer derives them — and the result passes the strict
 * issue-mode parse, the one check against today's catalog a request ever gets.
 */
export function mintAgentRequestAuthority<Attempt extends SemanticAttempt>(
  identity: AgentRequestIdentity<Attempt>,
): DomainResult<MintedAgentRequestAuthority<Attempt>, AgentRequestAuthorityError> {
  const minted = mintUnder(identity, CURRENT_PI_CATALOG.lowering);
  if (!minted.ok) return minted;
  // The strict parse proved the request carries exactly these catalog values;
  // the narrow fields are taken from the catalog itself, so only the phantom
  // brand is asserted.
  return success(brandMinted<Attempt>(canonicalRecord({
    ...minted.value.authority,
    modelProfile: minted.value.profileId,
    harnessBinding: mintedHarnessBinding(currentProfileBindings(minted.value.profileId)),
  })));
}

/**
 * Mint one request under `lowering`: the role's catalog profile, that
 * profile's bindings as `lowering` lowers them and the role's required Skill,
 * passed through the strict issue-mode parse against that same lowering. The
 * one issuance path, under today's catalog or a replayed one alike.
 */
function mintUnder<Attempt extends SemanticAttempt>(
  identity: AgentRequestIdentity<Attempt>,
  lowering: PiLowering,
): DomainResult<Readonly<{ authority: AgentRequestAuthority<Attempt>; profileId: LlmProfileId }>, AgentRequestAuthorityError> {
  const policy = resolveAgentPolicy(identity.role);
  if (!policy.ok) {
    return failure(singleViolationError(violation(
      "policy-resolution-failed",
      "role",
      `cannot resolve policy for role '${identity.role}': ${policy.error.message}`,
    )));
  }
  const bindings = profileBindingsUnder(lowering, policy.value.profile);
  const parsed = parseAgentRequestAuthorityInMode({
    ...identity,
    modelProfile: policy.value.profile,
    harnessBinding: { pi: bindings.pi, claude: bindings.claude },
    requiredSkill: policy.value.requiredSkill,
  }, "issue", lowering);
  if (!parsed.ok) return parsed;
  const attempted = authorityForAttempt(parsed.value, identity.attempt);
  return attempted.ok ? success(Object.freeze({ authority: attempted.value, profileId: policy.value.profile })) : attempted;
}

/** The one brand assertion: only `mintAgentRequestAuthority` calls it, after the strict parse. */
const brandMinted = <Attempt extends SemanticAttempt>(
  fields: UnbrandedMintedAuthority<Attempt>,
): MintedAgentRequestAuthority<Attempt> => fields as MintedAgentRequestAuthority<Attempt>;

/** A catalog profile's current bindings in the canonical harness-binding shape, typed as issued. */
function mintedHarnessBinding(bindings: CurrentProfileBindings): MintedHarnessBinding {
  return canonicalRecord({
    pi: canonicalRecord(bindings.pi),
    claude: canonicalRecord({ harness: "claude-code", model: bindings.claude.model }),
  });
}

/**
 * Parse an authority read back from an immutable artifact. The structural
 * checks are the strict parser's, but the profile id and Pi binding are
 * checked against recorded history — a retired profile or a retired Pi target
 * still parses, and the binding must be one the recorded profile has issued
 * (`recordedProfileBindings`) — and the role -> profile and role -> Skill
 * couplings against today's tables are skipped.
 */
export function parseStoredAgentRequestAuthority(
  raw: unknown,
): DomainResult<AgentRequestAuthority, AgentRequestAuthorityError> {
  return parseAgentRequestAuthorityInMode(raw, "stored");
}

/** `authority`, narrowed to the semantic attempt it must authorize. */
function authorityForAttempt<Authority extends AgentRequestAuthority, Attempt extends SemanticAttempt>(
  authority: Authority,
  expectedAttempt: Attempt,
): DomainResult<Authority & AgentRequestAuthority<Attempt>, AgentRequestAuthorityError> {
  return authority.attempt === expectedAttempt
    ? success(authority as Authority & AgentRequestAuthority<Attempt>)
    : failure(singleViolationError(violation(
        "invalid-agent-request-field",
        "attempt",
        `request must authorize semantic attempt ${expectedAttempt}, received ${authority.attempt}`,
      )));
}

/** Read back a stored authority that must authorize `expectedAttempt`. */
export function parseStoredAgentRequestAuthorityForAttempt<Attempt extends SemanticAttempt>(
  raw: unknown,
  expectedAttempt: Attempt,
): DomainResult<AgentRequestAuthority<Attempt>, AgentRequestAuthorityError> {
  const parsed = parseStoredAgentRequestAuthority(raw);
  return parsed.ok ? authorityForAttempt(parsed.value, expectedAttempt) : parsed;
}

export type AgentRosterSlot = Readonly<{
  slotId: SlotId;
  attempts: readonly [AgentRequestAuthority<1>, AgentRequestAuthority<2>];
}>;

/** A roster slot whose two requests were both minted against today's catalog. */
export type MintedAgentRosterSlot = Readonly<{
  slotId: SlotId;
  attempts: readonly [MintedAgentRequestAuthority<1>, MintedAgentRequestAuthority<2>];
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
 * once, where each request is minted (`mintAgentRequestAuthority`), never
 * again when a roster is re-read from a checkpoint or registration; a slot
 * being ISSUED is minted by `mintAgentRosterSlot`.
 */
export function parseAgentRosterSlot(
  rawFirst: unknown,
  rawRetry: unknown,
): DomainResult<AgentRosterSlot, AgentRosterSlotError> {
  return pairRosterSlot(
    parseStoredAgentRequestAuthorityForAttempt(rawFirst, 1),
    parseStoredAgentRequestAuthorityForAttempt(rawRetry, 2),
  );
}

/**
 * Mint one roster slot from the identities of its two requests — the one
 * issuing seam of a fresh slot: each request is minted
 * (`mintAgentRequestAuthority`) and the pair is checked exactly as
 * `parseAgentRosterSlot` checks a recorded one, so a slot cannot be issued
 * from requests that skipped the catalog check. Every issuer of a fresh slot
 * goes through here; each frames a refusal in its own words
 * (`rosterSlotErrorMessages`).
 */
export function mintAgentRosterSlot(
  first: AgentRequestIdentity<1>,
  retry: AgentRequestIdentity<2>,
): DomainResult<MintedAgentRosterSlot, AgentRosterSlotError> {
  return pairRosterSlot<MintedAgentRequestAuthority>(mintAgentRequestAuthority(first), mintAgentRequestAuthority(retry));
}

/**
 * Mint one roster slot as the catalog `lowering` replays stood
 * (`piCatalogAsOf`): each request is minted exactly as `mintAgentRosterSlot`
 * mints it, under that lowering instead of today's. What it mints is history,
 * so the slot is typed as recorded (`AgentRosterSlot`), never as minted.
 */
export function mintAgentRosterSlotAsOf(
  lowering: RecordedPiLowering,
  first: AgentRequestIdentity<1>,
  retry: AgentRequestIdentity<2>,
): DomainResult<AgentRosterSlot, AgentRosterSlotError> {
  const asOf = <Attempt extends SemanticAttempt>(identity: AgentRequestIdentity<Attempt>) => {
    const minted = mintUnder(identity, lowering);
    return minted.ok ? success(minted.value.authority) : minted;
  };
  return pairRosterSlot<AgentRequestAuthority>(asOf(first), asOf(retry));
}

/**
 * Why a slot could not be minted, paired or read back, one line per
 * violation: a request's own authority violations verbatim (the catalog's
 * reason), and `roster slot: <kind>` for a pair violation, naming what the
 * pair disagrees on — `(<field>)` for an attempt-pair mismatch, `(<path>)`
 * for an output path both attempts claim.
 */
export function rosterSlotErrorMessages(error: AgentRosterSlotError): NonEmpty<string> {
  const [head, ...rest] = error.violations.flatMap((entry): readonly string[] => {
    switch (entry.kind) {
      case "malformed-attempt-authority":
        return entry.authorityViolations.map(({ message }) => message);
      case "attempt-pair-mismatch":
        return [`roster slot: ${entry.kind} (${entry.field})`];
      case "duplicate-output-path":
        return [`roster slot: ${entry.kind} (${entry.path})`];
      default:
        return [`roster slot: ${entry.kind}`];
    }
  });
  return Object.freeze([head ?? "roster slot: invalid", ...rest]) as NonEmpty<string>;
}

function pairRosterSlot<Authority extends AgentRequestAuthority>(
  first: DomainResult<Authority & AgentRequestAuthority<1>, AgentRequestAuthorityError>,
  retry: DomainResult<Authority & AgentRequestAuthority<2>, AgentRequestAuthorityError>,
): DomainResult<Readonly<{
  slotId: SlotId;
  attempts: readonly [Authority & AgentRequestAuthority<1>, Authority & AgentRequestAuthority<2>];
}>, AgentRosterSlotError> {
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
    attempts: Object.freeze([first.value, retry.value] as const),
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
  return assembleExactRoster(slots.value.map((rawSlot, index): RosterEntry<AgentRosterSlot> => {
    const slotRecord = readExactDataRecord(rawSlot, ["slotId", "attempts"], `exact roster slot ${index}`);
    if (!slotRecord.ok) return { slot: null, violations: [canonicalRecord({ kind: "malformed-roster-slot", index })] };
    const attempts = readDenseDataArray(slotRecord.value.attempts, `exact roster slot ${index} attempts`);
    if (!attempts.ok || attempts.value.length !== 2) {
      return { slot: null, violations: [canonicalRecord({ kind: "malformed-roster-slot", index })] };
    }
    const parsedSlot = parseAgentRosterSlot(attempts.value[0], attempts.value[1]);
    if (!parsedSlot.ok) return { slot: null, violations: parsedSlot.error.violations };
    return { slot: parsedSlot.value, violations: declaredSlotIdViolations(parsedSlot.value.slotId, slotRecord.value.slotId) };
  }));
}

/**
 * Issue an exact roster from freshly minted slots. The seam enforces its
 * invariant itself rather than trusting the phantom brand: each slot is
 * re-checked against TODAY's catalog with the strict issue-mode parse
 * (`currentSlotEntry`), so a recorded slot cast past the type — a retired
 * profile or binding, a mis-paired attempt — is refused at run time with the
 * catalog's own violations. The cross-slot checks are exactly
 * `parseExactRoster`'s, and the roster keeps the minted slot type, so an
 * issued aggregate carries its catalog proof without a cast.
 */
export function issueExactRoster(
  slots: readonly MintedAgentRosterSlot[],
): DomainResult<ExactRoster<MintedAgentRosterSlot>, ExactRosterError> {
  return assembleExactRoster(slots.map(currentSlotEntry));
}

/**
 * `slot` as a roster entry, with every reason it is not one today's catalog
 * issues: both attempts must pass the strict parse against today's catalog
 * and pair, and the slot must declare its attempts' slot id, exactly as
 * `parseExactRoster` reads a recorded slot. Every slot `mintAgentRosterSlot`
 * returns passes, so for a caller the type admits this only ever refuses a cast.
 */
function currentSlotEntry(slot: MintedAgentRosterSlot): RosterEntry<MintedAgentRosterSlot> {
  const current = <Attempt extends SemanticAttempt>(raw: unknown, attempt: Attempt) => {
    const parsed = parseAgentRequestAuthorityInMode(raw, "issue");
    return parsed.ok ? authorityForAttempt(parsed.value, attempt) : parsed;
  };
  const paired = pairRosterSlot<AgentRequestAuthority>(current(slot.attempts[0], 1), current(slot.attempts[1], 2));
  return paired.ok
    ? { slot, violations: declaredSlotIdViolations(paired.value.slotId, slot.slotId) }
    : { slot: null, violations: paired.error.violations };
}

/** A roster slot must declare the slot id its attempts carry. */
const declaredSlotIdViolations = (attemptsSlotId: SlotId, declared: unknown): readonly RosterViolation[] =>
  declared === attemptsSlotId ? [] : [canonicalRecord({ kind: "attempt-pair-mismatch", slotId: attemptsSlotId, field: "slotId" })];

/** One roster slot as read: the slot, or `null` when it did not parse, and its own violations. */
type RosterEntry<S extends AgentRosterSlot> = Readonly<{ slot: S | null; violations: readonly RosterViolation[] }>;

/**
 * The cross-slot rules of an exact roster — one run, one program, distinct
 * slots, requests, contexts and output paths — over slots already parsed or
 * issued, generic in the slot type so the result keeps it. Violations are
 * reported in slot order, each slot's own before its cross-slot ones; no slot
 * at all is an empty roster.
 */
function assembleExactRoster<S extends AgentRosterSlot>(
  entries: readonly RosterEntry<S>[],
): DomainResult<ExactRoster<S>, ExactRosterError> {
  const violations: RosterViolation[] = [];
  const canonicalSlots: S[] = [];
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

  for (const { slot: canonicalSlot, violations: own } of entries) {
    violations.push(...own);
    if (canonicalSlot === null) continue;
    canonicalSlots.push(canonicalSlot);
    const run: OrchestrationRunId = canonicalRun ?? canonicalSlot.attempts[0].runId;
    const program: OrchestrationProgram = canonicalProgram ?? canonicalSlot.attempts[0].program;
    canonicalRun = run;
    canonicalProgram = program;
    if (canonicalSlot.attempts[0].runId !== run) {
      violations.push(canonicalRecord({ kind: "roster-run-mismatch", slotId: canonicalSlot.slotId }));
    }
    if (canonicalSlot.attempts[0].program !== program) {
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
  }

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

  const orderedSlots = Object.freeze(canonicalSlots) as NonEmpty<S>;
  const exactRoster = canonicalRecord({
    runId: canonicalRun,
    program: canonicalProgram,
    orderedSlots,
    byId: immutableMap(orderedSlots.map((slot) => [slot.slotId, slot] as const)),
  }) as unknown as ExactRoster<S>;
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

