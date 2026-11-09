/**
 * Security verification (ADR-0065): the security audit's verifier spawns as an
 * issued, captured, bound program instead of ballots read from stdin.
 *
 * This module is the program's functional core. It decides
 *
 *   - which confirmed candidates still need a ballot, and how they group into
 *     verification BRIEFS (deterministic, every eligible candidate exactly once);
 *   - the identity of each brief's verifier slot and its two requests;
 *   - what a verifier may return (the D2 wire: votes WITHOUT identity), and what
 *     one brief's result admits — never a verdict outside the brief, never a
 *     missing or duplicated fingerprint;
 *   - the BINDING each admitted vote carries, read from the minted request
 *     authority and the capture digest only (D3), so a ballot's role and profile
 *     are the spawn's, not the payload's;
 *   - the published result a verification run ends with, and how `verify --from`
 *     imports it: authenticated against the audit it was issued for, refused
 *     when the audit's ledger or findings moved since (D4).
 *
 * Pure module: no I/O, no clock, no randomness. Every refusal is data.
 */

import { match } from "ts-pattern";
import { sha256Hex } from "./digest";
import { compareStrings } from "./ordering";
import { parseLlmProfileId } from "./model-profiles";
import {
  canonicalStructuralEquals,
  failure,
  parseSlotId,
  success,
  type DomainResult,
  type NonEmpty,
} from "./orchestration-contract/identity";
import {
  parseAgentRosterSlot,
  parseStoredAgentRequestAuthorityForAttempt,
  rosterSlotErrorMessages,
  sameAgentRequestAuthority,
  type AgentRequestAuthority,
  type AgentRosterSlot,
  type AgentRosterSlotIdentities,
} from "./orchestration-contract/roster";
import {
  SECURITY_VERIFICATION_PROGRAM,
  SECURITY_VERIFIER_ROLE,
  normalizedMissingFact,
  parseVerificationVerdicts,
  unknownKeyViolations,
  voteViolations,
  type VerdictViolation,
  type VerificationVerdict,
} from "./security-adjudication";
import { isWireRecord } from "./security-audit-contract";
import type { ConfirmedFinding, SecurityFinding } from "./security-findings";
import { quoteShellArgument } from "./shell-quoting";
import { ballotsAttested, type AttestationLookup } from "./capture-attestation";

/**
 * At most this many fingerprints share one verifier spawn. Four keeps a brief
 * small enough that the verifier reads every trace in full, while an audit
 * with many confirmed claims needs a quarter of the spawns one-per-claim
 * would; a malformed answer retries only its own brief.
 */
export const MAX_BRIEF_FINGERPRINTS = 4;

/** The verifier's result kind (the D2 wire). */
export const VERIFICATION_RESULT_KIND = "security-verification-result" as const;
/** The published result kind a verification run ends with (D3). */
export const VERIFICATION_PUBLISHED_KIND = "security-verification-published" as const;
/** The Context Packet section a verifier reads its brief from. */
export const VERIFICATION_BRIEF_SECTION = "security-verification-brief";

/** The keys of the verifier's result envelope and of one vote in it. Exported
 *  so the agent-doc test pins the verifier document to THESE lists. */
export const VERIFICATION_RESULT_KEYS: readonly string[] = ["schemaVersion", "kind", "verdicts"];
export const VERIFIER_VOTE_KEYS: readonly string[] = ["fingerprint", "vote", "reason", "missingFact"];

// --- The audit a verification run is issued against ---

/** The audit run a verification run names (the disposition `source` shape plus
 *  the two digests its briefs were derived from). */
export type AuditReference = Readonly<{
  locator: string;
  runId: string;
  ledgerDigest: string;
  findingsDigest: string;
}>;

/** The `start security-verification` input (D1, amended): `generation` numbers
 *  the attempts at verifying ONE claim set against ONE audit state — a run
 *  that blocked, or whose captures cannot be imported, is replaced by the next
 *  generation instead of colliding with itself. */
export type SecurityVerificationStart = Readonly<{
  schemaVersion: 1;
  audit: AuditReference;
  wave: number;
  generation: number;
}>;

/** How many generations one claim set may run through before `status` stops
 *  offering another: a claim set that blocks this often needs a person. */
export const MAX_VERIFICATION_GENERATIONS = 16;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const isSha256 = (value: unknown): value is string => typeof value === "string" && SHA256_HEX.test(value);

/** An absolute, normalized path: no empty, `.` or `..` segment, no trailing slash. */
const isCanonicalLocator = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && value.length <= 4_096 &&
  (value === "/" || value.slice(1).split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."));

const isAuditRunId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 192 && !/[\u0000-\u001f]/.test(value);

const isWave = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const exactKeys = (record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));

/** Parse the audit reference a start input or a registration names. */
export function parseAuditReference(raw: unknown): DomainResult<AuditReference, string> {
  if (!isWireRecord(raw) || !exactKeys(raw, ["locator", "runId", "ledgerDigest", "findingsDigest"])) {
    return failure("audit must contain exactly locator, runId, ledgerDigest and findingsDigest");
  }
  if (!isCanonicalLocator(raw.locator)) return failure("audit.locator must be an absolute canonical path");
  if (!isAuditRunId(raw.runId)) return failure("audit.runId must be the audit's run id");
  if (!isSha256(raw.ledgerDigest) || !isSha256(raw.findingsDigest)) {
    return failure("audit.ledgerDigest and audit.findingsDigest must be sha256 digests");
  }
  return success({ locator: raw.locator, runId: raw.runId, ledgerDigest: raw.ledgerDigest, findingsDigest: raw.findingsDigest });
}

const isGeneration = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_VERIFICATION_GENERATIONS;

export function parseSecurityVerificationStart(raw: unknown): DomainResult<SecurityVerificationStart, string> {
  if (!isWireRecord(raw) || !exactKeys(raw, ["schemaVersion", "audit", "wave", "generation"]) || raw.schemaVersion !== 1) {
    return failure("security-verification input must contain exactly schemaVersion 1, audit, wave and generation");
  }
  const audit = parseAuditReference(raw.audit);
  if (!audit.ok) return audit;
  if (!isWave(raw.wave)) return failure("security-verification wave must be a positive integer");
  if (!isGeneration(raw.generation)) {
    return failure(`security-verification generation must be an integer in 1..${MAX_VERIFICATION_GENERATIONS}`);
  }
  return success({ schemaVersion: 1, audit: audit.value, wave: raw.wave, generation: raw.generation });
}

/**
 * Whether the audit as it stands now is the audit a verification run was issued
 * against. A run issued against older findings or an older ledger verified a
 * claim set that no longer exists, so its ballots are refused, not merged.
 */
export function authenticateAudit(expected: AuditReference, observed: AuditReference): DomainResult<void, string> {
  if (expected.locator !== observed.locator || expected.runId !== observed.runId) {
    return failure(`verification run was issued for audit ${expected.runId} at ${expected.locator}, not ${observed.runId} at ${observed.locator}`);
  }
  if (expected.findingsDigest !== observed.findingsDigest) {
    return failure(`audit findings changed since the verification run was issued (findings ${expected.findingsDigest} → ${observed.findingsDigest}); start a new verification run`);
  }
  if (expected.ledgerDigest !== observed.ledgerDigest) {
    return failure(`audit ledger changed since the verification run was issued (ledger ${expected.ledgerDigest} → ${observed.ledgerDigest}); start a new verification run`);
  }
  return success(undefined);
}

// --- Briefs ---

/** One verifier spawn's assignment: a slot and the fingerprints it must vote on. */
export type VerificationBrief = Readonly<{
  slotId: string;
  fingerprints: NonEmpty<string>;
}>;

/** The confirmed candidates no ballot names yet, sorted and distinct. */
export function eligibleFingerprints(
  findings: readonly SecurityFinding[],
  verdicts: readonly VerificationVerdict[],
): readonly string[] {
  const balloted = new Set(verdicts.map((verdict) => verdict.fingerprint));
  const eligible = new Set(findings
    .filter((finding) => finding.verdict === "confirmed" && !balloted.has(finding.fingerprint))
    .map((finding) => finding.fingerprint));
  return [...eligible].sort(compareStrings);
}

/**
 * A brief's slot id: derived from everything its run is issued against — the
 * audit run, its ledger and findings digests, the wave, the generation — and
 * the exact fingerprints, so the same brief of the same issuance always names
 * the same slot, and no two verification runs ever share a slot or request id
 * (a harness resolves a spawn to its run by request id).
 */
export const verificationSlotId = (issue: SecurityVerificationStart, fingerprints: readonly string[]): string =>
  `security-verification-slot:${sha256Hex(JSON.stringify([
    issue.audit.runId, issue.audit.ledgerDigest, issue.audit.findingsDigest, issue.wave, issue.generation, fingerprints,
  ])).slice(0, 32)}`;

/** A slot's two request ids, in attempt order. */
export const verificationRequestIds = (slotId: string): readonly [string, string] => [`${slotId}:1`, `${slotId}:2`];

/**
 * The briefs a verification run issues: every confirmed candidate without a
 * ballot, sorted by fingerprint and cut into consecutive briefs of at most
 * `MAX_BRIEF_FINGERPRINTS`, each bound to `issue`. Deterministic, and each
 * eligible candidate lands in exactly one brief.
 */
export function deriveVerificationBriefs(input: Readonly<{
  issue: SecurityVerificationStart;
  findings: readonly SecurityFinding[];
  verdicts: readonly VerificationVerdict[];
}>): readonly VerificationBrief[] {
  const eligible = eligibleFingerprints(input.findings, input.verdicts);
  const briefs: VerificationBrief[] = [];
  for (let start = 0; start < eligible.length; start += MAX_BRIEF_FINGERPRINTS) {
    const chunk = eligible.slice(start, start + MAX_BRIEF_FINGERPRINTS);
    const [head, ...rest] = chunk;
    if (head === undefined) continue;
    const fingerprints: NonEmpty<string> = [head, ...rest];
    briefs.push({ slotId: verificationSlotId(input.issue, fingerprints), fingerprints });
  }
  return briefs;
}

/** How many hex digits of each audit digest the run name binds. */
const NAMED_DIGEST_PREFIX = 8;

/**
 * The one name a verification run's directory has:
 * `run.verify-w<wave>-g<generation>-<id>`, the id derived from the brief slots
 * (which bind the whole issuance and the fingerprints), the first
 * eight hex of the ledger and findings digests the run is issued against, and
 * the generation. Distinct claim sets AND distinct audit states get distinct
 * runs — a run refused as stale never collides with the run that replaces it,
 * even when its claim set is unchanged — and a blocked or unimportable run is
 * replaced by its next generation.
 */
export const verificationRunName = (input: SecurityVerificationStart, briefs: readonly VerificationBrief[]): string => {
  const id = sha256Hex(JSON.stringify([
    briefs.map((brief) => brief.slotId),
    input.audit.ledgerDigest.slice(0, NAMED_DIGEST_PREFIX),
    input.audit.findingsDigest.slice(0, NAMED_DIGEST_PREFIX),
    input.generation,
  ])).slice(0, 12);
  return `run.verify-w${input.wave}-g${input.generation}-${id}`;
};

/** What `status` offers the operator: the exact start input and run name of the
 *  verification run the audit owes now, or nothing when no claim awaits a ballot. */
export type VerificationStartPlan = Readonly<{
  input: SecurityVerificationStart;
  run: string;
  briefs: readonly VerificationBrief[];
}>;

/** What the runs root holds under one generation's run name. */
export type GenerationState =
  /** Nothing: this generation can be started. */
  | "absent"
  /** In flight or finished and importable: this generation is the one to drive. */
  | "live"
  /** Blocked, malformed, or finished but unimportable (a capture without its
   *  attestation, a result that does not replay): never usable again. */
  | "dead";

/**
 * The verification run the audit owes now: the claim set its findings and
 * ballots leave unballoted, under the FIRST generation that is not dead.
 * `observe` reports what the runs root holds under a candidate run name (the
 * shell reads it). Null when no claim awaits a ballot; a refusal when every
 * generation is dead.
 */
export function planVerificationStart(input: Readonly<{
  audit: AuditReference;
  wave: number;
  findings: readonly SecurityFinding[];
  verdicts: readonly VerificationVerdict[];
  observe: (run: string) => GenerationState;
}>): DomainResult<VerificationStartPlan | null, string> {
  if (eligibleFingerprints(input.findings, input.verdicts).length === 0) return success(null);
  for (let generation = 1; generation <= MAX_VERIFICATION_GENERATIONS; generation++) {
    const start: SecurityVerificationStart = { schemaVersion: 1, audit: input.audit, wave: input.wave, generation };
    const briefs = deriveVerificationBriefs({ issue: start, findings: input.findings, verdicts: input.verdicts });
    const run = verificationRunName(start, briefs);
    if (input.observe(run) !== "dead") return success({ input: start, run, briefs });
  }
  return failure(`every one of the ${MAX_VERIFICATION_GENERATIONS} verification generations of this claim set is blocked or unimportable; ` +
    "inspect them under verification-runs/ before verifying again");
}

/** The exact command that starts a planned run, its input on a here-document.
 *  Every path is one shell-quoted word, whatever it contains. */
export function renderVerificationStart(plan: VerificationStartPlan, runsRoot: string): string {
  return [
    `loom helper orchestration start ${SECURITY_VERIFICATION_PROGRAM} --runs-root ${quoteShellArgument(runsRoot)} ` +
      `--run ${quoteShellArgument(plan.run)} <<'LOOM_VERIFICATION_START'`,
    JSON.stringify(plan.input),
    "LOOM_VERIFICATION_START",
  ].join("\n");
}

// --- Registration ---

export type RegisteredSecurityVerificationProgram = Readonly<{
  schemaVersion: 1;
  kind: typeof SECURITY_VERIFICATION_PROGRAM;
  runId: string;
  input: SecurityVerificationStart;
  briefs: readonly VerificationBrief[];
  registrationDigest: string;
}>;

/** Register a verification run: its name must be the one its briefs derive, and
 *  it must have something to verify. */
export function registerSecurityVerification(
  runId: string,
  input: SecurityVerificationStart,
  briefs: readonly VerificationBrief[],
): DomainResult<RegisteredSecurityVerificationProgram, string> {
  if (briefs.length === 0) return failure(`audit ${input.audit.runId} has no confirmed candidate without a ballot; there is nothing to verify`);
  const expected = verificationRunName(input, briefs);
  if (runId !== expected) return failure(`this verification run must be named ${expected}, not ${runId}`);
  for (const brief of briefs) {
    if (brief.slotId !== verificationSlotId(input, brief.fingerprints)) {
      return failure(`brief ${brief.slotId} does not derive from its fingerprints`);
    }
  }
  const base = { schemaVersion: 1 as const, kind: SECURITY_VERIFICATION_PROGRAM, runId, input, briefs };
  return success({ ...base, registrationDigest: sha256Hex(JSON.stringify(base)) });
}

function parseBrief(raw: unknown): DomainResult<VerificationBrief, string> {
  if (!isWireRecord(raw) || !exactKeys(raw, ["slotId", "fingerprints"]) || !parseSlotId(raw.slotId).ok) {
    return failure("a registered brief must contain exactly slotId and fingerprints");
  }
  const fingerprints = raw.fingerprints;
  if (!Array.isArray(fingerprints) || fingerprints.length === 0 || fingerprints.length > MAX_BRIEF_FINGERPRINTS ||
      !fingerprints.every((value): value is string => typeof value === "string")) {
    return failure(`brief ${String(raw.slotId)} must name 1..${MAX_BRIEF_FINGERPRINTS} fingerprints`);
  }
  const [head, ...rest] = fingerprints;
  return success({ slotId: String(raw.slotId), fingerprints: [head as string, ...rest] });
}

/** Read a stored registration back: every field re-derived and the digest
 *  recomputed, so a hand-edited registration is refused, not trusted. */
export function parseRegisteredSecurityVerificationProgram(raw: unknown): DomainResult<RegisteredSecurityVerificationProgram, string> {
  const keys = ["schemaVersion", "kind", "runId", "input", "briefs", "registrationDigest"];
  if (!isWireRecord(raw) || !exactKeys(raw, keys) || raw.schemaVersion !== 1 || raw.kind !== SECURITY_VERIFICATION_PROGRAM ||
      typeof raw.runId !== "string" || !Array.isArray(raw.briefs)) {
    return failure(`security-verification registration must contain exactly ${keys.join(", ")}`);
  }
  const input = parseSecurityVerificationStart(raw.input);
  if (!input.ok) return input;
  const briefs: VerificationBrief[] = [];
  for (const entry of raw.briefs as readonly unknown[]) {
    const brief = parseBrief(entry);
    if (!brief.ok) return brief;
    briefs.push(brief.value);
  }
  const rebuilt = registerSecurityVerification(raw.runId, input.value, briefs);
  if (!rebuilt.ok) return rebuilt;
  return rebuilt.value.registrationDigest === raw.registrationDigest
    ? rebuilt
    : failure("security-verification registration digest mismatch");
}

// --- Requests and packets ---

/** A brief's two request identities, as the issuer mints them (`program`,
 *  `role` and `outputSlot` fixed here; profile and binding by the catalog). */
export function verifierSlotIdentities(
  verificationRunId: string,
  brief: VerificationBrief,
  contextDigests: readonly [string, string],
): AgentRosterSlotIdentities {
  const [first, retry] = verificationRequestIds(brief.slotId);
  const identity = <Attempt extends 1 | 2>(attempt: Attempt, requestId: string, contextDigest: string) => ({
    runId: verificationRunId,
    requestId,
    slotId: brief.slotId,
    program: SECURITY_VERIFICATION_PROGRAM,
    role: SECURITY_VERIFIER_ROLE,
    attempt,
    contextDigest,
    outputSlot: `transcripts/${brief.slotId}/attempt-${attempt}.raw`,
  });
  return [identity(1, first, contextDigests[0]), identity(2, retry, contextDigests[1])];
}

/**
 * A slot's requests as HISTORY (ADR-0023): when its attempt-1 request is on
 * record, both attempts carry the recorded profile, bindings and Skill — the
 * retry is read from the same issuance — and the recorded attempt 1 must be
 * exactly the request this slot's identity derives. Re-minting a recorded slot
 * would compare today's catalog with the recorded one and strand the run.
 */
export function recordedVerifierSlot(
  identities: AgentRosterSlotIdentities,
  recorded: AgentRequestAuthority,
): DomainResult<AgentRosterSlot, string> {
  const fromRecord = { modelProfile: recorded.modelProfile, harnessBinding: recorded.harnessBinding, requiredSkill: recorded.requiredSkill };
  const first = parseStoredAgentRequestAuthorityForAttempt({ ...identities[0], ...fromRecord }, 1);
  const retry = parseStoredAgentRequestAuthorityForAttempt({ ...identities[1], ...fromRecord }, 2);
  if (!first.ok || !retry.ok) return failure(`recorded verifier request ${recorded.requestId} cannot be read back`);
  if (!sameAgentRequestAuthority(first.value, recorded)) {
    return failure(`recorded verifier request ${recorded.requestId} differs from the brief's deterministic request`);
  }
  const slot = parseAgentRosterSlot(first.value, retry.value);
  return slot.ok ? success(slot.value) : failure(rosterSlotErrorMessages(slot.error).join("; "));
}

/** The audit facts a verifier reads beside its candidates. */
export type BriefAudit = Readonly<{ target: string; commit: string }>;

/**
 * The text of one attempt's brief section: the candidates' full records, the
 * pinned revision, the request it answers and the result contract. The request
 * id and attempt are part of the bytes, so each attempt's packet — and its
 * context digest — is distinct, as a slot's attempt pair requires.
 */
export function verificationBriefText(input: Readonly<{
  registration: Pick<RegisteredSecurityVerificationProgram, "input">;
  brief: VerificationBrief;
  findings: readonly SecurityFinding[];
  audit: BriefAudit;
  requestId: string;
  attempt: 1 | 2;
}>): DomainResult<string, string> {
  const candidates: ConfirmedFinding[] = [];
  for (const fingerprint of input.brief.fingerprints) {
    const record = input.findings.find((finding): finding is ConfirmedFinding =>
      finding.fingerprint === fingerprint && finding.verdict === "confirmed");
    if (record === undefined) return failure(`brief ${input.brief.slotId} names ${fingerprint}, which is no confirmed candidate of the audit`);
    candidates.push(record);
  }
  return success(JSON.stringify({
    schemaVersion: 1,
    kind: VERIFICATION_BRIEF_SECTION,
    audit: { runId: input.registration.input.audit.runId, target: input.audit.target, commit: input.audit.commit },
    wave: input.registration.input.wave,
    requestId: input.requestId,
    attempt: input.attempt,
    fingerprints: input.brief.fingerprints,
    candidates,
    result: { kind: VERIFICATION_RESULT_KIND, verdictKeys: VERIFIER_VOTE_KEYS },
  }));
}

// --- The verifier's result (D2) and per-brief admission ---

/** One vote as the verifier returns it: no agent, profile or wave. */
export type VerifierVote = Readonly<{
  fingerprint: string;
  vote: "critical" | "advisory";
  reason: string;
  missingFact: string | null;
}>;

const describeViolations = (violations: readonly VerdictViolation[]): string =>
  violations.map((violation) => `${violation.path}: ${violation.message}`).join("; ");

/** Parse the D2 envelope: exact keys, the result kind, and every vote's four
 *  fields. Identity keys (`agent`, `profile`, `wave`) are unknown fields. */
export function parseVerificationResultWire(raw: unknown): DomainResult<readonly VerifierVote[], readonly VerdictViolation[]> {
  if (!isWireRecord(raw)) return failure([{ path: "$", message: "expected one JSON object" }]);
  const violations = unknownKeyViolations(raw, VERIFICATION_RESULT_KEYS, "$");
  if (raw.schemaVersion !== 1) violations.push({ path: "$.schemaVersion", message: "expected 1" });
  if (raw.kind !== VERIFICATION_RESULT_KIND) violations.push({ path: "$.kind", message: `expected ${VERIFICATION_RESULT_KIND}` });
  if (!Array.isArray(raw.verdicts)) {
    violations.push({ path: "$.verdicts", message: "expected an array" });
    return failure(violations);
  }
  const votes: VerifierVote[] = [];
  (raw.verdicts as readonly unknown[]).forEach((entry, index) => {
    const base = `$.verdicts[${index}]`;
    if (!isWireRecord(entry)) {
      violations.push({ path: base, message: "expected an object" });
      return;
    }
    const local = [...unknownKeyViolations(entry, VERIFIER_VOTE_KEYS, base), ...voteViolations(entry, base)];
    if (!Object.hasOwn(entry, "missingFact")) local.push({ path: `${base}.missingFact`, message: "required (null when none)" });
    if (local.length > 0) {
      violations.push(...local);
      return;
    }
    votes.push({
      fingerprint: String(entry.fingerprint),
      vote: entry.vote === "critical" ? "critical" : "advisory",
      reason: String(entry.reason),
      missingFact: normalizedMissingFact(entry.missingFact),
    });
  });
  return violations.length > 0 ? failure(violations) : success(votes);
}

/**
 * Admit one brief's captured result: the D2 envelope, then the brief rule —
 * every vote names a fingerprint IN the brief, no fingerprint is voted twice,
 * and every fingerprint in the brief is voted on. The votes come back in brief
 * order. A refusal is the diagnostic the single retry is told.
 */
export function admitVerificationResult(brief: VerificationBrief, text: string): DomainResult<readonly VerifierVote[], string> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return failure("the result is not one JSON object");
  }
  const parsed = parseVerificationResultWire(raw);
  if (!parsed.ok) return failure(describeViolations(parsed.error));
  const assigned = new Set<string>(brief.fingerprints);
  const seen = new Set<string>();
  for (const vote of parsed.value) {
    if (!assigned.has(vote.fingerprint)) return failure(`verdict for ${vote.fingerprint}, which is not in this brief (${brief.fingerprints.join(", ")})`);
    if (seen.has(vote.fingerprint)) return failure(`duplicate verdict for ${vote.fingerprint}`);
    seen.add(vote.fingerprint);
  }
  const missing = brief.fingerprints.filter((fingerprint) => !seen.has(fingerprint));
  if (missing.length > 0) return failure(`no verdict for ${missing.join(", ")}`);
  return success(brief.fingerprints.map((fingerprint) => parsed.value.find((vote) => vote.fingerprint === fingerprint)!));
}

/**
 * Bind admitted votes to the spawn that cast them (D3). Every binding field is
 * read from the minted request authority or the capture digest; a request that
 * is not a security-verification verifier request binds nothing.
 */
export function bindBallots(input: Readonly<{
  votes: readonly VerifierVote[];
  authority: AgentRequestAuthority;
  captureDigest: string;
  wave: number;
}>): DomainResult<readonly VerificationVerdict[], string> {
  const { authority } = input;
  if (authority.program !== SECURITY_VERIFICATION_PROGRAM || authority.role !== SECURITY_VERIFIER_ROLE) {
    return failure(`request ${authority.requestId} is a ${authority.program}/${authority.role} request, not a security verifier request`);
  }
  const profile = parseLlmProfileId(authority.modelProfile);
  if (!profile.ok) return failure(`request ${authority.requestId} was minted under ${authority.modelProfile}, which is no catalog profile`);
  if (!isSha256(input.captureDigest)) return failure("capture digest must be a sha256 digest");
  const binding = {
    program: SECURITY_VERIFICATION_PROGRAM,
    runId: authority.runId,
    requestId: authority.requestId,
    slotId: authority.slotId,
    attempt: authority.attempt,
    role: SECURITY_VERIFIER_ROLE,
    profile: profile.value,
    captureDigest: input.captureDigest,
  } as const;
  return success(input.votes.map((vote) => ({ ...vote, wave: input.wave, binding })));
}

// --- One slot's decision, and the run's ---

/** What the run directory holds for one attempt of a slot. */
export type AttemptEvidence =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "capture-rejected"; diagnostic: string }>
  | Readonly<{ kind: "captured"; text: string; digest: string }>;

/** What one slot needs next. */
export type SlotDecision =
  | Readonly<{ kind: "awaiting"; attempt: 1 | 2; diagnostic: string | null }>
  | Readonly<{ kind: "admitted"; attempt: 1 | 2; votes: readonly VerifierVote[]; digest: string }>
  | Readonly<{ kind: "blocked"; message: string }>;

/** An attempt's outcome: admitted votes, or the diagnostic that refused it. */
function judgeAttempt(brief: VerificationBrief, evidence: Exclude<AttemptEvidence, { kind: "absent" }>):
  DomainResult<Readonly<{ votes: readonly VerifierVote[]; digest: string }>, string> {
  return match(evidence)
    .with({ kind: "capture-rejected" }, ({ diagnostic }) => failure(`capture rejected: ${diagnostic}`))
    .with({ kind: "captured" }, ({ text, digest }) => {
      const admitted = admitVerificationResult(brief, text);
      return admitted.ok ? success({ votes: admitted.value, digest }) : admitted;
    })
    .exhaustive();
}

/**
 * One slot's next step, from its two attempts' durable evidence: attempt 1 is
 * awaited until it lands; a refused attempt 1 gets exactly one retry, told why;
 * a refused attempt 2 blocks the run. The decision is recomputed from the run
 * directory on every drive, so nothing about it needs a checkpoint.
 */
export function decideVerificationSlot(brief: VerificationBrief, first: AttemptEvidence, retry: AttemptEvidence): SlotDecision {
  if (first.kind === "absent") return { kind: "awaiting", attempt: 1, diagnostic: null };
  const judgedFirst = judgeAttempt(brief, first);
  if (judgedFirst.ok) return { kind: "admitted", attempt: 1, ...judgedFirst.value };
  if (retry.kind === "absent") return { kind: "awaiting", attempt: 2, diagnostic: judgedFirst.error };
  const judgedRetry = judgeAttempt(brief, retry);
  return judgedRetry.ok
    ? { kind: "admitted", attempt: 2, ...judgedRetry.value }
    : { kind: "blocked", message: `brief ${brief.slotId} exhausted its retry: ${judgedRetry.error}` };
}

/** Where a whole run stands: spawns still owed, a terminal block, or every
 *  brief admitted. A blocked brief blocks the run — its claims can never be
 *  ballotted by this run — so it takes precedence over spawns still owed. */
export type VerificationProgress<Slot> =
  | Readonly<{ kind: "awaiting"; slots: readonly Readonly<{ slot: Slot; attempt: 1 | 2; diagnostic: string | null }>[] }>
  | Readonly<{ kind: "blocked"; messages: readonly string[] }>
  | Readonly<{ kind: "complete"; admitted: readonly Readonly<{ slot: Slot; attempt: 1 | 2; votes: readonly VerifierVote[]; digest: string }>[] }>;

export function foldVerificationProgress<Slot>(
  decisions: readonly Readonly<{ slot: Slot; decision: SlotDecision }>[],
): VerificationProgress<Slot> {
  const blocked = decisions.flatMap(({ decision }) => decision.kind === "blocked" ? [decision.message] : []);
  if (blocked.length > 0) return { kind: "blocked", messages: blocked };
  const awaiting = decisions.flatMap(({ slot, decision }) =>
    decision.kind === "awaiting" ? [{ slot, attempt: decision.attempt, diagnostic: decision.diagnostic }] : []);
  if (awaiting.length > 0) return { kind: "awaiting", slots: awaiting };
  return {
    kind: "complete",
    admitted: decisions.flatMap(({ slot, decision }) =>
      decision.kind === "admitted" ? [{ slot, attempt: decision.attempt, votes: decision.votes, digest: decision.digest }] : []),
  };
}

// --- The published result (D3) ---

export type SecurityVerificationResult = Readonly<{
  schemaVersion: 1;
  kind: typeof VERIFICATION_PUBLISHED_KIND;
  program: typeof SECURITY_VERIFICATION_PROGRAM;
  runId: string;
  registrationDigest: string;
  audit: AuditReference;
  wave: number;
  ballots: readonly VerificationVerdict[];
}>;

/**
 * The result a completed run publishes: every ballot bound, sorted by the
 * ballot parser's own order, and covering exactly the registered briefs'
 * fingerprints once each.
 */
export function buildVerificationResult(
  registration: RegisteredSecurityVerificationProgram,
  ballots: readonly VerificationVerdict[],
): DomainResult<SecurityVerificationResult, string> {
  const parsed = parseVerificationVerdicts(ballots);
  if (!parsed.ok) return failure(describeViolations(parsed.error.violations));
  const covered = coverageProblem(registration, parsed.value);
  if (covered !== null) return failure(covered);
  return success({
    schemaVersion: 1,
    kind: VERIFICATION_PUBLISHED_KIND,
    program: SECURITY_VERIFICATION_PROGRAM,
    runId: registration.runId,
    registrationDigest: registration.registrationDigest,
    audit: registration.input.audit,
    wave: registration.input.wave,
    ballots: parsed.value,
  });
}

/** Ballots that do not cover the registered fingerprints exactly once each, or
 *  that another run issued. */
function coverageProblem(registration: RegisteredSecurityVerificationProgram, ballots: readonly VerificationVerdict[]): string | null {
  const foreign = ballots.find((ballot) => ballot.binding.runId !== registration.runId || ballot.wave !== registration.input.wave);
  if (foreign !== undefined) return `ballot on ${foreign.fingerprint} was not issued by run ${registration.runId} for wave ${registration.input.wave}`;
  const expected = registration.briefs.flatMap((brief) => brief.fingerprints).sort(compareStrings);
  const actual = ballots.map((ballot) => ballot.fingerprint).sort(compareStrings);
  return canonicalStructuralEquals(expected, actual)
    ? null
    : `ballots cover ${actual.join(", ") || "nothing"}, not exactly the registered ${expected.join(", ")}`;
}

/** The exact bytes `result.json` holds. */
export const serializeVerificationResult = (result: SecurityVerificationResult): string =>
  `${JSON.stringify(result, null, 2)}\n`;

/** Read a published result back. */
export function parseVerificationResult(raw: unknown): DomainResult<SecurityVerificationResult, string> {
  const keys = ["schemaVersion", "kind", "program", "runId", "registrationDigest", "audit", "wave", "ballots"];
  if (!isWireRecord(raw) || !exactKeys(raw, keys) || raw.schemaVersion !== 1 || raw.kind !== VERIFICATION_PUBLISHED_KIND ||
      raw.program !== SECURITY_VERIFICATION_PROGRAM || typeof raw.runId !== "string" || !isSha256(raw.registrationDigest) || !isWave(raw.wave)) {
    return failure(`a published verification result must contain exactly ${keys.join(", ")}`);
  }
  const audit = parseAuditReference(raw.audit);
  if (!audit.ok) return audit;
  const ballots = parseVerificationVerdicts(raw.ballots);
  if (!ballots.ok) return failure(describeViolations(ballots.error.violations));
  return success({
    schemaVersion: 1, kind: VERIFICATION_PUBLISHED_KIND, program: SECURITY_VERIFICATION_PROGRAM, runId: raw.runId,
    registrationDigest: raw.registrationDigest, audit: audit.value, wave: raw.wave, ballots: ballots.value,
  });
}

// --- Import (D4) ---

export type VerificationImport = Readonly<{
  verdicts: readonly VerificationVerdict[];
  /** How many ballots this import added: 0 when the run was already imported. */
  added: number;
}>;

/**
 * Import a verification run's published result into the audit's ballots.
 *
 * The result must be the one its registration describes, issued for THIS audit
 * against the ledger and findings as they are now (`authenticateAudit`), and
 * cover exactly its registered briefs. A run already imported verbatim imports
 * nothing; a run whose ballots are partly present is refused, because the audit
 * would then hold a ballot set no verification run published.
 */
export function importVerificationResult(input: Readonly<{
  registration: RegisteredSecurityVerificationProgram;
  result: SecurityVerificationResult;
  audit: AuditReference;
  existing: readonly VerificationVerdict[];
}>): DomainResult<VerificationImport, string> {
  const { registration, result } = input;
  if (result.runId !== registration.runId || result.registrationDigest !== registration.registrationDigest ||
      !canonicalStructuralEquals(result.audit, registration.input.audit) || result.wave !== registration.input.wave) {
    return failure(`result.json does not describe verification run ${registration.runId} as registered`);
  }
  const authentic = authenticateAudit(registration.input.audit, input.audit);
  if (!authentic.ok) return authentic;
  const covered = coverageProblem(registration, result.ballots);
  if (covered !== null) return failure(covered);
  const present = input.existing.filter((ballot) => ballot.binding.runId === result.runId);
  if (present.length > 0) {
    return canonicalStructuralEquals(present, result.ballots)
      ? success({ verdicts: input.existing, added: 0 })
      : failure(`the audit already holds a different ballot set from verification run ${result.runId}`);
  }
  const contested = crossRunConflict([...input.existing, ...result.ballots]);
  if (contested !== null) return failure(contested);
  const combined = parseVerificationVerdicts([...input.existing, ...result.ballots]);
  return combined.ok
    ? success({ verdicts: combined.value, added: result.ballots.length })
    : failure(describeViolations(combined.error.violations));
}

/**
 * One fingerprint, one verification run (ADR-0065, amended). Eligibility
 * already hands a fingerprint to a run only while no ballot names it, so two
 * runs voting on one claim means two generations of one claim set were both
 * finished; importing the second would let a re-run outvote the first. The
 * audit keeps the first import and refuses every later run's ballots on it.
 */
function crossRunConflict(ballots: readonly VerificationVerdict[]): string | null {
  const runOf = new Map<string, string>();
  for (const ballot of ballots) {
    const prior = runOf.get(ballot.fingerprint);
    if (prior !== undefined && prior !== ballot.binding.runId) {
      return `${ballot.fingerprint} already carries a ballot from verification run ${prior}; ` +
        `verification run ${ballot.binding.runId} cannot cast another on it`;
    }
    runOf.set(ballot.fingerprint, ballot.binding.runId);
  }
  return null;
}

// --- verdicts.json as a cache (ADR-0065, amended) ---

/** What the shell proved about one verification run a cached ballot names. */
export type VerificationRunProof =
  | Readonly<{
      kind: "proven";
      registration: RegisteredSecurityVerificationProgram;
      /** The result the run's captured evidence replays NOW. */
      replayed: SecurityVerificationResult;
      /** The run directory, realpath-canonical (the attestations' spelling). */
      runDirectory: string;
      attestations: (requestId: string) => AttestationLookup;
    }>
  | Readonly<{ kind: "unprovable"; reason: string }>;

export type CachedBallotAdmission = Readonly<{
  /** The ballots adjudication may count. */
  admitted: readonly VerificationVerdict[];
  /** One named publication blocker per run whose cached ballots failed. */
  blockers: readonly string[];
}>;

/**
 * `verdicts.json` is a CACHE of imports, never authority. Before adjudication
 * counts a ballot, its run must still prove it: a registered
 * security-verification run of THIS audit (locator and run id — the run's
 * ledger and findings digests may be older, since later waves move them),
 * whose captured evidence replays to a result holding exactly the cached
 * ballots of that run, each backed by its capture attestation. A run that
 * fails contributes no ballot and one named blocker; a fingerprint voted by
 * two runs is a blocker too. Pure: the shell supplies one proof per run.
 */
export function admitCachedBallots(input: Readonly<{
  audit: Pick<AuditReference, "locator" | "runId">;
  verdicts: readonly VerificationVerdict[];
  proofs: ReadonlyMap<string, VerificationRunProof>;
}>): CachedBallotAdmission {
  const runs = [...new Set(input.verdicts.map((ballot) => ballot.binding.runId))].sort(compareStrings);
  const admitted: VerificationVerdict[] = [];
  const blockers: string[] = [];
  for (const runId of runs) {
    const cached = input.verdicts.filter((ballot) => ballot.binding.runId === runId);
    const problem = cachedRunProblem(input.audit, runId, cached, input.proofs.get(runId));
    if (problem === null) admitted.push(...cached);
    else blockers.push(`ballots of verification run ${runId} (${cached.map((ballot) => ballot.fingerprint).join(", ")}) are not counted: ${problem}`);
  }
  const contested = crossRunConflict(input.verdicts);
  if (contested !== null) blockers.push(contested);
  return { admitted, blockers };
}

function cachedRunProblem(
  audit: Pick<AuditReference, "locator" | "runId">,
  runId: string,
  cached: readonly VerificationVerdict[],
  proof: VerificationRunProof | undefined,
): string | null {
  if (proof === undefined) return `no proof was read for run ${runId}`;
  if (proof.kind === "unprovable") return proof.reason;
  const issuedFor = proof.registration.input.audit;
  if (proof.registration.runId !== runId || proof.replayed.runId !== runId) return `run ${runId} is not the run its ballots name`;
  if (issuedFor.locator !== audit.locator || issuedFor.runId !== audit.runId) {
    return `run ${runId} was issued for audit ${issuedFor.runId} at ${issuedFor.locator}, not this audit`;
  }
  if (!canonicalStructuralEquals(cached, proof.replayed.ballots)) {
    return `verdicts.json does not hold exactly the ballots run ${runId} replays from its captured evidence`;
  }
  const attested = ballotsAttested(cached, proof.runDirectory, proof.attestations);
  return attested.ok ? null : attested.error;
}
