/**
 * Durable panel authority (schema v2): the issued roster authority the
 * authority-bound refutation panel runs under, and the typed failure
 * vocabulary every durable panel operation reports in.
 *
 * New panel sessions persist only JSON data. Runtime issuance proofs are
 * rehydrated from T1's independently loaded publication authority before a
 * durable event reaches the pure reducer (`persistent-panel`). This module
 * answers the authority questions that reducer asks: is a roster canonical
 * for its semantic entries, and which lens does a roster slot answer for.
 *
 * Pure module: no I/O, no clock, no randomness.
 */
import type { PanelLens } from "./panel-contract";
import {
  REVIEW_LENSES,
  parseCurrentBriefFinding,
  parseReviewLens,
  parseWaveFindingId,
  type BriefFinding,
  type ReviewLens,
  type WaveFindingId,
} from "./review-panel";
import { fail, ok, sanitizeProse, type ParseResult } from "./panel-kernel";
import { parseReviewPath } from "./review-packet";
import { sha256Hex } from "./digest";
import { safeArray, safeRecord } from "./exact-data";
import {
  issueExactRoster,
  parseExactRoster,
  parseOrchestrationRunId,
  parseRequestId,
  parseSlotId,
  type AgentRequestAuthority,
  type AgentRosterSlotIdentities,
  type DomainResult,
  type ExactRoster,
  type ExactRosterError,
  type MintedAgentRosterSlot,
  type NonEmpty,
  type OrchestrationRunId,
  type RequestId,
  type RosterIssuanceError,
  type SlotId,
} from "./orchestration-contract";
import { failure, success } from "./orchestration-contract/identity";

export const persistentSuccess = <T>(value: T): PersistentPanelResult<T> =>
  Object.freeze({ ok: true, value });
export const persistentFailure = <T = never>(error: PersistentPanelError): PersistentPanelResult<T> =>
  Object.freeze({ ok: false, error: Object.freeze(error) });

export type PersistentPanelError = Readonly<{
  kind:
    | "invalid-authority"
    | "malformed-result"
    | "malformed-event"
    | "malformed-checkpoint"
    | "unknown-request"
    | "duplicate-result"
    | "stale-request"
    | "request-binding-mismatch"
    | "request-rehydration-failed"
    | "unexpected-event"
    | "terminal-state"
    | "incomplete-roster"
    | "invalid-aggregate";
  /** The one persistent panel; kept on the durable error so its diagnostics stay self-describing. */
  panel: "refutation";
  message: string;
  requestId?: string;
  slotId?: string;
  rehydration?: Readonly<{ kind: "invalid-accepted-agent-result"; field?: string; message: string }>;
}>;

export type PersistentPanelResult<T> = DomainResult<T, PersistentPanelError>;

export const boundedPanelMessage = (message: string): string => message.length <= 4_096
  ? message
  : `${message.slice(0, 4_083)}…[truncated]`;

export const panelError = (
  panel: PersistentPanelError["panel"],
  kind: PersistentPanelError["kind"],
  message: string,
  request?: Readonly<{
    requestId?: string;
    slotId?: string;
    rehydration?: PersistentPanelError["rehydration"];
  }>,
): PersistentPanelError => Object.freeze({ kind, panel, message: boundedPanelMessage(message), ...request });

function nonEmptyDistinctStrings(raw: unknown): readonly [string, ...string[]] | null {
  const values = safeArray(raw);
  if (values === null || values.length === 0 ||
      values.some((value) => typeof value !== "string" || value.trim() !== value || value.length === 0)) return null;
  const strings = values as string[];
  if (new Set(strings).size !== strings.length) return null;
  return Object.freeze([...strings]) as readonly [string, ...string[]];
}

export function authorityMatches(left: AgentRequestAuthority, right: AgentRequestAuthority): boolean {
  return left.runId === right.runId && left.requestId === right.requestId &&
    left.slotId === right.slotId && left.program === right.program && left.role === right.role &&
    left.attempt === right.attempt && left.modelProfile === right.modelProfile &&
    left.requiredSkill === right.requiredSkill && left.contextDigest === right.contextDigest &&
    left.outputSlot.path === right.outputSlot.path &&
    left.harnessBinding.pi.harness === right.harnessBinding.pi.harness &&
    left.harnessBinding.pi.provider === right.harnessBinding.pi.provider &&
    left.harnessBinding.pi.model === right.harnessBinding.pi.model &&
    left.harnessBinding.pi.thinking === right.harnessBinding.pi.thinking &&
    left.harnessBinding.claude.harness === right.harnessBinding.claude.harness &&
    left.harnessBinding.claude.model === right.harnessBinding.claude.model;
}

/**
 * The two request identities a refutation verifier slot owns — attempt 1 and its
 * single retry — derived from the run, the lens, and the finding set.
 */
export type RefutationVerifierBinding = Readonly<{
  slotId: SlotId;
  requestIds: readonly [RequestId, RequestId];
}>;

/** Single source of truth for semantic refutation verifier request authority. */
export function deriveRefutationVerifierBinding(
  runId: OrchestrationRunId,
  lens: ReviewLens,
  findingIds: NonEmpty<WaveFindingId>,
): ParseResult<RefutationVerifierBinding> {
  const slotHash = sha256Hex(JSON.stringify([runId, lens, findingIds])).slice(0, 32);
  const slotId = parseSlotId(`refutation-slot:${slotHash}`);
  const firstRequestId = parseRequestId(`refutation-request:${slotHash}:1`);
  const secondRequestId = parseRequestId(`refutation-request:${slotHash}:2`);
  const errors = [
    slotId.ok ? null : slotId.error.message,
    firstRequestId.ok ? null : firstRequestId.error.message,
    secondRequestId.ok ? null : secondRequestId.error.message,
  ].filter((message): message is string => message !== null);
  if (!slotId.ok || !firstRequestId.ok || !secondRequestId.ok) return fail(errors);
  return ok(Object.freeze({
    slotId: slotId.value,
    requestIds: Object.freeze([firstRequestId.value, secondRequestId.value] as const),
  }));
}

type CanonicalPanelSlotBinding = RefutationVerifierBinding;

/** The run-bound legacy ordinal identity of one verifier slot — slot
 *  `verifier:<ordinal>` and requests `<runId>:verifier:<ordinal>:<attempt>` —
 *  or null when those identities do not parse. */
function legacyOrdinalBinding(
  runId: OrchestrationRunId,
  ordinal: number,
): CanonicalPanelSlotBinding | null {
  const slotId = parseSlotId(`verifier:${ordinal}`);
  const requests = ([1, 2] as const).map((attempt) => parseRequestId(`${runId}:verifier:${ordinal}:${attempt}`));
  if (!slotId.ok || !requests[0].ok || !requests[1].ok) return null;
  return Object.freeze({
    slotId: slotId.value,
    requestIds: Object.freeze([requests[0].value, requests[1].value]) as readonly [RequestId, RequestId],
  });
}

function parseCanonicalPanelSlotBinding(
  runId: OrchestrationRunId,
  ordinal: number,
  semanticEntry: string,
  findingIds: readonly string[],
): CanonicalPanelSlotBinding | null {
  const legacy = legacyOrdinalBinding(runId, ordinal);
  if (legacy === null) return null;
  if (findingIds.length === 0) return legacy;

  // Refutation identities derive from the semantic lens and exact finding set
  // rather than a caller-selected ordinal. Recompute the same authority used
  // by every producer so swapping complete slots cannot relabel verdicts.
  const lens = parseReviewLens(semanticEntry);
  const parsedFindingIds = findingIds.map(parseWaveFindingId);
  const [firstFindingId, ...otherFindingIds] = parsedFindingIds;
  if (lens === null || firstFindingId === null || firstFindingId === undefined ||
      otherFindingIds.some((findingId) => findingId === null)) return null;
  const binding = deriveRefutationVerifierBinding(
    runId,
    lens,
    [firstFindingId, ...(otherFindingIds as WaveFindingId[])],
  );
  return binding.ok ? binding.value : null;
}

function rosterAuthorityErrors(
  roster: ExactRoster,
  runId: OrchestrationRunId,
  semanticEntries: readonly string[],
  findingIds: readonly string[],
  semanticRunId: OrchestrationRunId,
): readonly string[] {
  const program = "refutation-panel";
  const role = "review-verifier-agent";
  const errors: string[] = [];
  if (roster.runId !== runId) errors.push("roster run does not match panel run");
  if (roster.program !== program) errors.push(`roster program must be ${program}`);
  if (roster.orderedSlots.length !== semanticEntries.length) {
    errors.push(`roster must contain exactly ${semanticEntries.length} slot(s)`);
  }
  for (const [index, slot] of roster.orderedSlots.entries()) {
    if (slot.attempts.some((request) => request.role !== role)) errors.push(`slot ${slot.slotId} must be assigned to ${role}`);
    if (slot.attempts.some((request) => request.slotId !== slot.slotId)) {
      errors.push(`slot ${slot.slotId} holds an attempt bound to a different slot`);
    }
    const semanticEntry = semanticEntries[index];
    if (semanticEntry === undefined) continue;
    const bindingMatches = (binding: CanonicalPanelSlotBinding): boolean =>
      slot.slotId === binding.slotId &&
      slot.attempts.every((request, attemptIndex) => request.requestId === binding.requestIds[attemptIndex]);
    const expected = parseCanonicalPanelSlotBinding(semanticRunId, index + 1, semanticEntry, findingIds);
    if (expected === null) {
      // The semantic entry cannot derive a canonical slot binding (e.g. a
      // legacy lens no longer in the current table). Admit ONLY the exact
      // run-bound legacy ordinal identity below; a weaker, shapeless ordinal
      // match would re-pair this slot with whatever semantic entry now lives
      // at its position.
      const legacy = legacyOrdinalBinding(runId, index + 1);
      if (legacy === null || !bindingMatches(legacy)) {
        errors.push(
          `verifier slot ${index + 1} for ${JSON.stringify(semanticEntry)} has non-canonical slot/request identity`,
        );
      }
      continue;
    }
    // The semantic slot binding is DERIVED from the semantic entry (and, for
    // verifier slots, the exact finding set). Require it whenever it is
    // derivable — ordering/labeling a roster by loose ordinal shape would let
    // a reordered lens or finding list silently relabel previously issued
    // requests as authoritative evidence for different semantics.
    if (!bindingMatches(expected)) {
      errors.push(
        `verifier slot ${index + 1} for ${JSON.stringify(semanticEntry)} has non-canonical slot/request identity`,
      );
    }
  }
  return errors;
}

/** Parse the strict canonical critical-Finding list for the refutation
 * authority, collecting per-entry errors in list order (the joined
 * diagnostic message is part of the contract the fixtures pin). */
function refutationFindings(raw: readonly unknown[] | null): {
  readonly findings: readonly BriefFinding[];
  readonly errors: readonly string[];
} {
  const findings: BriefFinding[] = [];
  if (raw === null || raw.length === 0) {
    return { findings, errors: ["refutation findings must be a non-empty canonical critical Finding list"] };
  }
  const errors: string[] = [];
  raw.forEach((entry, index) => {
    const parsed = parseStrictBriefFinding(entry);
    if (parsed.ok) findings.push(parsed.value);
    else errors.push(`findings[${index}]: ${parsed.error.message}`);
  });
  return { findings, errors };
}

function parseStrictBriefFinding(raw: unknown): DomainResult<BriefFinding, Readonly<{ message: string }>> {
  const finding = safeRecord(raw, ["id", "taskId", "agent", "severity", "file", "line", "claim", "protocolVersion", "basis", "reason"]);
  if (finding === null) return { ok: false, error: { message: "Finding must be an exact data record" } };
  if (["protocolVersion", "basis", "reason"].some((key) => Object.hasOwn(finding, key))) {
    const parsed = parseCurrentBriefFinding(finding);
    if (!parsed.ok) return { ok: false, error: { message: parsed.errors.join("; ") } };
    return parsed.value.severity === "critical"
      ? { ok: true, value: parsed.value }
      : { ok: false, error: { message: "Finding severity must be critical" } };
  }
  const id = parseWaveFindingId(finding.id);
  const taskId = typeof finding.taskId === "string" ? sanitizeProse(finding.taskId) : "";
  const agent = typeof finding.agent === "string" ? sanitizeProse(finding.agent) : "";
  const claim = typeof finding.claim === "string" ? sanitizeProse(finding.claim) : "";
  const file = finding.file === null ? null : parseReviewPath(finding.file, "Finding file");
  let line: number | null | undefined;
  if (finding.line === null) {
    line = null;
  } else if (typeof finding.line === "number" && Number.isSafeInteger(finding.line) && finding.line > 0) {
    line = finding.line;
  } else {
    line = undefined;
  }
  const errors: string[] = [];
  if (id === null) errors.push("Finding id must be a wave-scoped task-id:finding-id without whitespace or extra colons");
  if (taskId.length === 0) errors.push("Finding taskId must be non-empty after sanitization");
  if (agent.length === 0) errors.push("Finding agent must be non-empty after sanitization");
  if (claim.length === 0) errors.push("Finding claim must be non-empty after sanitization");
  if (finding.severity !== "critical") errors.push("Finding severity must be critical");
  if (file !== null && !file.ok) errors.push(...file.errors);
  if (line === undefined) errors.push("Finding line must be null or a positive safe integer");
  if (id !== null && taskId.length > 0 && !id.startsWith(`${taskId}:`)) errors.push(`Finding id must be scoped by task ${taskId}`);
  if (errors.length > 0 || id === null || line === undefined || (file !== null && !file.ok)) {
    return { ok: false, error: { message: errors.join("; ") } };
  }
  const parsedFile = file === null ? null : file.value;
  return { ok: true, value: Object.freeze({
    id,
    taskId,
    agent,
    severity: "critical" as const,
    file: parsedFile,
    line,
    claim,
  }) };
}

/**
 * A refutation panel's authority, however it was obtained — issued now
 * (`issueRefutationPanelAuthority`), parsed from a checkpoint, or reconstructed
 * from its record. No consumer branches on which, so the provenance is not
 * part of the type; the minted proof is enforced where a panel is issued.
 */
export type RefutationPanelAuthority = Readonly<{
  schemaVersion: 2;
  panel: "refutation";
  runId: OrchestrationRunId;
  /** Semantic panel instance identity; Wave panels bind this to readiness. */
  identityRunId: OrchestrationRunId;
  findings: readonly [BriefFinding, ...BriefFinding[]];
  lenses: readonly [ReviewLens, ...ReviewLens[]];
  verifierRoster: ExactRoster;
}>;

export type RefutationPanelAuthorityInput = Readonly<{
  runId: unknown;
  identityRunId?: unknown;
  findings: unknown;
  lenses: unknown;
  verifierSlots: unknown;
}>;

/**
 * The lens a verifier slot answers for, refused rather than assumed.
 *
 * The verifier roster is paired POSITIONALLY with the ordered `lenses`: slot
 * `i` answers for lens `i`, and the roster carries nothing that independently
 * names its lens, so equal cardinality is the whole of what the pairing itself
 * can prove. This is therefore the only sanctioned way to cross from a slot to
 * its lens. An unknown slot, or one whose ordinal lies past the lens list, is a
 * typed refusal — never `undefined` passed downstream as if it were a lens.
 */
export function boundRefutationLens(
  authority: RefutationPanelAuthority,
  slotId: SlotId,
): PersistentPanelResult<ReviewLens> {
  const index = authority.verifierRoster.orderedSlots.findIndex((slot) => slot.slotId === slotId);
  const lens = index < 0 ? undefined : authority.lenses[index];
  return lens === undefined
    ? persistentFailure(panelError("refutation", "request-binding-mismatch", `slot ${slotId} is bound to no refutation lens`, { slotId }))
    : persistentSuccess(lens);
}

/** Parse a refutation panel authority from untrusted data: an issued
 *  `RefutationPanelAuthorityInput`, or a checkpoint's `authority` field read
 *  back from disk. No shape is assumed of `raw`. */
export function parseRefutationPanelAuthority(raw: unknown): PersistentPanelResult<RefutationPanelAuthority> {
  return refutationPanelAuthority(raw, parseExactRoster);
}

/**
 * The refutation panel authority `raw` describes, over the verifier roster
 * `rosterOf` produces from its `verifierSlots` — the one input the parsing
 * and issuing seams differ in. Every other check is the same for both.
 */
function refutationPanelAuthority(
  raw: unknown,
  rosterOf: (verifierSlots: unknown) => DomainResult<ExactRoster, ExactRosterError>,
): PersistentPanelResult<RefutationPanelAuthority> {
  try {
    const input = safeRecord(raw, ["runId", "identityRunId", "findings", "lenses", "verifierSlots"]) ??
      safeRecord(raw, ["runId", "findings", "lenses", "verifierSlots"]);
    if (input === null) return persistentFailure(panelError("refutation", "invalid-authority", "refutation authority must be an exact data record"));
    const roster = rosterOf(input.verifierSlots);
    const runId = parseOrchestrationRunId(input.runId);
    const identityRunId = parseOrchestrationRunId(input.identityRunId ?? input.runId);
    const rawFindings = safeArray(input.findings);
    const lenses = nonEmptyDistinctStrings(input.lenses);
    const parsedFindings = refutationFindings(rawFindings);
    const findings = [...parsedFindings.findings];
    const errors: string[] = [];
    if (!runId.ok) errors.push(runId.error.message);
    if (!identityRunId.ok) errors.push(identityRunId.error.message);
    errors.push(...parsedFindings.errors);
    if (new Set(findings.map(({ id }) => id)).size !== findings.length) errors.push("refutation findings must be distinct");
    if (lenses === null) errors.push("refutation lenses must be a non-empty distinct ordered list");
    const parsedLenses = lenses?.filter((lens): lens is ReviewLens => (REVIEW_LENSES as readonly string[]).includes(lens)) ?? [];
    if (lenses !== null && parsedLenses.length !== lenses.length) errors.push("refutation lenses contain an unknown review lens");
    if (!roster.ok) errors.push(...roster.error.violations.map(({ kind }) => `verifier roster: ${kind}`));
    if (runId.ok && lenses !== null && roster.ok) {
      errors.push(...rosterAuthorityErrors(
        roster.value,
        runId.value,
        lenses,
        findings.map(({ id }) => id),
        identityRunId.ok ? identityRunId.value : runId.value,
      ));
    }
    if (errors.length > 0 || !runId.ok || !identityRunId.ok || !roster.ok || parsedLenses.length === 0 || findings.length === 0) {
      return persistentFailure(panelError("refutation", "invalid-authority", errors.join("; ") || "refutation authority is invalid"));
    }
    return persistentSuccess(Object.freeze({
      schemaVersion: 2 as const,
      panel: "refutation" as const,
      runId: runId.value,
      identityRunId: identityRunId.value,
      findings: Object.freeze(findings) as readonly [BriefFinding, ...BriefFinding[]],
      lenses: Object.freeze(parsedLenses) as readonly [ReviewLens, ...ReviewLens[]],
      verifierRoster: roster.value,
    }));
  } catch {
    return persistentFailure(panelError("refutation", "invalid-authority", "refutation authority could not be safely inspected"));
  }
}

/** A refutation panel being ISSUED now: each verifier slot as the identities of its two requests, which issuance mints. */
export type IssuedRefutationPanelAuthorityInput = RefutationPanelAuthorityInput & Readonly<{
  verifierSlots: readonly AgentRosterSlotIdentities[];
}>;

/** A verifier slot today's catalog would not mint: issuance is refused before the panel is checked. */
type UnmintableVerifierSlot = Extract<RosterIssuanceError, Readonly<{ kind: "unmintable-roster-slot" }>>;

/** Why a refutation panel could not be issued: a verifier slot today's catalog would not mint, or the panel itself. */
export type RefutationPanelIssuanceError = UnmintableVerifierSlot | PersistentPanelError;

/**
 * A roster issuance split at the one point the panel cares about: an
 * unmintable slot refuses issuance outright; any other outcome — the issued
 * roster or its aggregate violations — is the roster the panel check reads,
 * exactly as a parsed roster would be.
 */
function mintableRoster(
  issued: DomainResult<ExactRoster<MintedAgentRosterSlot>, RosterIssuanceError>,
): DomainResult<DomainResult<ExactRoster, ExactRosterError>, UnmintableVerifierSlot> {
  if (issued.ok) return success(issued);
  const { error } = issued;
  return error.kind === "unmintable-roster-slot" ? failure(error) : success(failure(error));
}

/**
 * Issue a refutation panel authority: the issuing seam. Its verifier roster
 * is issued from the slots' identities (`issueExactRoster`, which mints each
 * slot against today's catalog and owns the aggregate), never re-read from
 * untyped data; a slot the catalog will not mint is refused before the panel
 * is checked (`mintableRoster`), and every other check is exactly
 * `parseRefutationPanelAuthority`'s.
 */
export function issueRefutationPanelAuthority(
  input: IssuedRefutationPanelAuthorityInput,
): DomainResult<RefutationPanelAuthority, RefutationPanelIssuanceError> {
  const roster = mintableRoster(issueExactRoster(input.verifierSlots));
  return roster.ok ? refutationPanelAuthority(input, () => roster.value) : roster;
}

// PanelLens (design lenses) and ReviewLens (refutation lenses) must stay
// disjoint: these assignments fail to compile if a value joins both unions.
const _architectureLensRemainsDisjoint: Exclude<PanelLens, ReviewLens> = "simplicity-first";
const _refutationLensRemainsDisjoint: Exclude<ReviewLens, PanelLens> = "reproduction";
void _architectureLensRemainsDisjoint;
void _refutationLensRemainsDisjoint;
