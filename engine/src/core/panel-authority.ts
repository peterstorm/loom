/**
 * Durable panel authority (schema v2): the issued roster authority an
 * authority-bound panel runs under, and the typed failure vocabulary every
 * durable panel operation reports in.
 *
 * New panel sessions persist only JSON data. Runtime issuance proofs are
 * rehydrated from T1's independently loaded publication authority before a
 * durable event reaches either pure reducer (`persistent-panel`). This module
 * answers the authority questions those reducers ask: is a roster canonical
 * for its semantic entries, and which lens, criterion or candidate does a
 * roster slot answer for.
 *
 * Pure module: no I/O, no clock, no randomness.
 */
import {
  PANEL_LENSES,
  architectureCriterion,
  candidateFilename,
  type ArchitectureCriterion,
  type CandidateFilename,
  type PanelLens,
} from "./panel-contract";
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
  parseExactRoster,
  parseOrchestrationRunId,
  parseRequestId,
  parseSlotId,
  type AgentRequestAuthority,
  type DomainResult,
  type ExactRoster,
  type NonEmpty,
  type OrchestrationRunId,
  type RequestId,
  type SlotId,
} from "./orchestration-contract";

export const persistentSuccess = <T>(value: T): PersistentPanelResult<T> =>
  Object.freeze({ ok: true, value });
export const persistentFailure = <T = never>(error: PersistentPanelError): PersistentPanelResult<T> =>
  Object.freeze({ ok: false, error: Object.freeze(error) });

export type PersistentPanelError = Readonly<{
  kind:
    | "invalid-authority"
    | "malformed-result"
    | "malformed-event"
    | "malformed-history"
    | "malformed-checkpoint"
    | "unknown-request"
    | "duplicate-result"
    | "stale-request"
    | "request-binding-mismatch"
    | "request-rehydration-failed"
    | "unexpected-event"
    | "terminal-state"
    | "incomplete-roster"
    | "invalid-aggregate"
    | "persistence-receipt-mismatch";
  panel: "architecture" | "refutation";
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

/** The run-bound legacy ordinal identity of one panel slot — slot
 *  `<stage>:<ordinal>` and requests `<runId>:<stage>:<ordinal>:<attempt>` —
 *  or null when those identities do not parse. */
function legacyOrdinalBinding(
  runId: OrchestrationRunId,
  stage: "candidate" | "judge" | "verifier",
  ordinal: number,
): CanonicalPanelSlotBinding | null {
  const slotId = parseSlotId(`${stage}:${ordinal}`);
  const requests = ([1, 2] as const).map((attempt) => parseRequestId(`${runId}:${stage}:${ordinal}:${attempt}`));
  if (!slotId.ok || !requests[0].ok || !requests[1].ok) return null;
  return Object.freeze({
    slotId: slotId.value,
    requestIds: Object.freeze([requests[0].value, requests[1].value]) as readonly [RequestId, RequestId],
  });
}

function parseCanonicalPanelSlotBinding(
  runId: OrchestrationRunId,
  stage: "candidate" | "judge" | "verifier",
  ordinal: number,
  semanticEntry: string,
  findingIds: readonly string[] = [],
): CanonicalPanelSlotBinding | null {
  const legacy = legacyOrdinalBinding(runId, stage, ordinal);
  if (legacy === null) return null;
  if (stage !== "verifier" || findingIds.length === 0) return legacy;

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
  program: "architecture-panel" | "refutation-panel",
  role: "arch-designer-agent" | "arch-judge-agent" | "review-verifier-agent",
  semanticEntries: readonly string[],
  stage: "candidate" | "judge" | "verifier",
  findingIds: readonly string[] = [],
  semanticRunId: OrchestrationRunId = runId,
): readonly string[] {
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
    const expected = parseCanonicalPanelSlotBinding(semanticRunId, stage, index + 1, semanticEntry, findingIds);
    if (expected === null) {
      // The semantic entry cannot derive a canonical slot binding (e.g. a
      // legacy lens no longer in the current table). Admit ONLY the exact
      // run-bound legacy ordinal identity below; a weaker, shapeless ordinal
      // match would re-pair this slot with whatever semantic entry now lives
      // at its position.
      const legacy = legacyOrdinalBinding(runId, stage, index + 1);
      if (legacy === null || !bindingMatches(legacy)) {
        errors.push(
          `${stage} slot ${index + 1} for ${JSON.stringify(semanticEntry)} has non-canonical slot/request identity`,
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
        `${stage} slot ${index + 1} for ${JSON.stringify(semanticEntry)} has non-canonical slot/request identity`,
      );
    }
  }
  return errors;
}

/**
 * The ordered entry slot `slotId` answers for, or `null` when the roster holds
 * no such slot.
 *
 * A roster is paired POSITIONALLY with an ordered list — `candidateLenses`,
 * `judgeCriteria`, or the refutation `lenses`. Slot `i` answers for entry `i`,
 * and the roster carries nothing that independently names its entry, so equal
 * cardinality is the whole of what the pairing itself can prove. This function is
 * therefore the only sanctioned way to cross from a slot to its entry.
 *
 * `orderedSlots.findIndex(...)` returns -1 for an unknown slot, and indexing a
 * parallel array with -1 yields `undefined` — which a `!` assertion then passes
 * downstream as if it were a real lens, criterion, or candidate id. Returning
 * `null` makes that case a refusal the caller must handle instead of a lie the
 * type system was told to ignore.
 */
function boundEntryForSlot<T>(
  roster: ExactRoster,
  ordered: readonly T[],
  slotId: SlotId,
): T | null {
  const index = roster.orderedSlots.findIndex((slot) => slot.slotId === slotId);
  if (index < 0 || index >= ordered.length) return null;
  return ordered[index] ?? null;
}

function crossRosterErrors(left: ExactRoster, right: ExactRoster): readonly string[] {
  const errors: string[] = [];
  const slots = new Set(left.orderedSlots.map(({ slotId }) => slotId));
  const requests = new Set(left.orderedSlots.flatMap(({ attempts }) => attempts.map(({ requestId }) => requestId)));
  const contexts = new Set(left.orderedSlots.flatMap(({ attempts }) => attempts.map(({ contextDigest }) => contextDigest)));
  const outputs = new Set(left.orderedSlots.flatMap(({ attempts }) => attempts.map(({ outputSlot }) => outputSlot.path)));
  for (const slot of right.orderedSlots) {
    if (slots.has(slot.slotId)) errors.push(`slot id is reused across architecture phases: ${slot.slotId}`);
    for (const request of slot.attempts) {
      if (requests.has(request.requestId)) errors.push(`request id is reused across architecture phases: ${request.requestId}`);
      if (contexts.has(request.contextDigest)) errors.push(`context is reused across architecture phases: ${request.contextDigest}`);
      if (outputs.has(request.outputSlot.path)) errors.push(`output slot is reused across architecture phases: ${request.outputSlot.path}`);
    }
  }
  return errors;
}

export type ArchitecturePanelAuthority = Readonly<{
  schemaVersion: 2;
  panel: "architecture";
  runId: OrchestrationRunId;
  candidateLenses: readonly [PanelLens, ...PanelLens[]];
  candidateIds: readonly [CandidateFilename, ...CandidateFilename[]];
  judgeCriteria: readonly [ArchitectureCriterion, ...ArchitectureCriterion[]];
  candidateRoster: ExactRoster;
  judgeRoster: ExactRoster;
}>;

export type ArchitecturePanelAuthorityInput = Readonly<{
  runId: unknown;
  candidateLenses: unknown;
  judgeCriteria: unknown;
  candidateSlots: unknown;
  judgeSlots: unknown;
}>;

type ParsedPanelRunId = ReturnType<typeof parseOrchestrationRunId>;
type ParsedExactRoster = ReturnType<typeof parseExactRoster>;

/** Parse the panel's closed vocabulary entries and collect their exact errors,
 * in the authority parser's canonical order (the joined diagnostic message is
 * part of the contract the fixtures pin). */
function architectureVocabularyEntries(
  lenses: readonly [string, ...string[]] | null,
  criteria: readonly [string, ...string[]] | null,
): {
  readonly parsedLenses: readonly PanelLens[];
  readonly mintedCriteria: readonly ArchitectureCriterion[];
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  if (lenses === null) errors.push("candidate lenses must be a non-empty distinct ordered list");
  if (criteria === null) errors.push("judge criteria must be a non-empty distinct ordered list");
  const parsedLenses = lenses?.filter((lens): lens is PanelLens => (PANEL_LENSES as readonly string[]).includes(lens)) ?? [];
  if (lenses !== null && parsedLenses.length !== lenses.length) errors.push("candidate lenses contain an unknown architecture lens");
  // Criteria are minted through the closed vocabulary, not asserted into
  // the brand: a checkpoint criterion outside deriveJudgeCriteria's
  // vocabulary cannot come from a validated digest and is rejected.
  const mintedCriteria = criteria === null
    ? []
    : criteria.flatMap((criterion) => {
        const minted = architectureCriterion(criterion);
        return minted === null ? [] : [minted];
      });
  if (criteria !== null && mintedCriteria.length !== criteria.length) {
    errors.push("judge criteria contain a criterion outside the validated interview vocabulary");
  }
  return { parsedLenses, mintedCriteria, errors };
}

/** Roster-shape, roster-authority, and cross-roster errors for the
 * architecture authority, in the parser's canonical diagnostic order. */
function architectureRosterAuthorityErrors(args: Readonly<{
  runId: ParsedPanelRunId;
  lenses: readonly [string, ...string[]] | null;
  criteria: readonly [string, ...string[]] | null;
  candidateRoster: ParsedExactRoster;
  judgeRoster: ParsedExactRoster;
}>): readonly string[] {
  const errors: string[] = [];
  if (!args.candidateRoster.ok) errors.push(...args.candidateRoster.error.violations.map(({ kind }) => `candidate roster: ${kind}`));
  if (!args.judgeRoster.ok) errors.push(...args.judgeRoster.error.violations.map(({ kind }) => `judge roster: ${kind}`));
  if (args.runId.ok && args.lenses !== null && args.candidateRoster.ok) {
    errors.push(...rosterAuthorityErrors(
      args.candidateRoster.value,
      args.runId.value,
      "architecture-panel",
      "arch-designer-agent",
      args.lenses,
      "candidate",
    ));
  }
  if (args.runId.ok && args.criteria !== null && args.judgeRoster.ok) {
    errors.push(...rosterAuthorityErrors(
      args.judgeRoster.value,
      args.runId.value,
      "architecture-panel",
      "arch-judge-agent",
      args.criteria,
      "judge",
    ));
  }
  if (args.candidateRoster.ok && args.judgeRoster.ok) errors.push(...crossRosterErrors(args.candidateRoster.value, args.judgeRoster.value));
  return errors;
}

export function parseArchitecturePanelAuthority(raw: ArchitecturePanelAuthorityInput): PersistentPanelResult<ArchitecturePanelAuthority> {
  try {
    const input = safeRecord(raw, ["runId", "candidateLenses", "judgeCriteria", "candidateSlots", "judgeSlots"]);
    if (input === null) return persistentFailure(panelError("architecture", "invalid-authority", "architecture authority must be an exact data record"));
    const runId = parseOrchestrationRunId(input.runId);
    const lenses = nonEmptyDistinctStrings(input.candidateLenses);
    const criteria = nonEmptyDistinctStrings(input.judgeCriteria);
    const candidateRoster = parseExactRoster(input.candidateSlots);
    const judgeRoster = parseExactRoster(input.judgeSlots);
    const vocab = architectureVocabularyEntries(lenses, criteria);
    const errors: string[] = [];
    if (!runId.ok) errors.push(runId.error.message);
    errors.push(...vocab.errors);
    errors.push(...architectureRosterAuthorityErrors({ runId, lenses, criteria, candidateRoster, judgeRoster }));
    if (errors.length > 0 || !runId.ok || lenses === null || criteria === null || !candidateRoster.ok || !judgeRoster.ok || vocab.parsedLenses.length === 0) {
      return persistentFailure(panelError("architecture", "invalid-authority", errors.join("; ") || "architecture authority is invalid"));
    }
    const canonicalLenses = Object.freeze(vocab.parsedLenses) as readonly [PanelLens, ...PanelLens[]];
    const canonicalCriteria = Object.freeze(vocab.mintedCriteria) as unknown as readonly [ArchitectureCriterion, ...ArchitectureCriterion[]];
    return persistentSuccess(Object.freeze({
      schemaVersion: 2 as const,
      panel: "architecture" as const,
      runId: runId.value,
      candidateLenses: canonicalLenses,
      candidateIds: Object.freeze(canonicalLenses.map(candidateFilename)) as readonly [CandidateFilename, ...CandidateFilename[]],
      judgeCriteria: canonicalCriteria,
      candidateRoster: candidateRoster.value,
      judgeRoster: judgeRoster.value,
    }));
  } catch {
    return persistentFailure(panelError("architecture", "invalid-authority", "architecture authority could not be safely inspected"));
  }
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
 * Resolve the lens a verifier slot answers for, refusing a slot the verifier
 * roster does not hold instead of pairing the result with `undefined`.
 */
export function boundRefutationLens(
  authority: RefutationPanelAuthority,
  slotId: SlotId,
): PersistentPanelResult<ReviewLens> {
  const lens = boundEntryForSlot(authority.verifierRoster, authority.lenses, slotId);
  return lens === null
    ? persistentFailure(panelError("refutation", "request-binding-mismatch", `slot ${slotId} is bound to no refutation lens`, { slotId }))
    : persistentSuccess(lens);
}

/**
 * The criterion a judge slot answers for, refused rather than assumed.
 *
 * Both judge paths — the event reducer and the direct submission — used to do
 * `judgeRoster.orderedSlots.findIndex(...)` and then `judgeCriteria[index]!`,
 * which is precisely the pattern `boundEntryForSlot`'s doc exists to forbid: an
 * unknown slot yields -1, indexing with -1 yields `undefined`, and the `!` hands
 * that downstream as if it were a real criterion. The verdict parser would then
 * check the submission against `undefined` and admit whatever it was given.
 */
export function boundJudgeCriterion(
  authority: ArchitecturePanelAuthority,
  slotId: SlotId,
): PersistentPanelResult<ArchitectureCriterion> {
  const criterion = boundEntryForSlot(authority.judgeRoster, authority.judgeCriteria, slotId);
  return criterion === null
    ? persistentFailure(panelError("architecture", "request-binding-mismatch", `slot ${slotId} is bound to no judge criterion`, { slotId }))
    : persistentSuccess(criterion);
}

/**
 * Resolve the lens and candidate id a designer slot answers for. Both come from
 * the same ordinal, so they are resolved together — pairing a lens from one
 * position with a candidate id from another is the mismatch this prevents.
 */
export function boundCandidateEntry(
  authority: ArchitecturePanelAuthority,
  slotId: SlotId,
): PersistentPanelResult<Readonly<{ lens: PanelLens; candidate: CandidateFilename }>> {
  const lens = boundEntryForSlot(authority.candidateRoster, authority.candidateLenses, slotId);
  const candidate = boundEntryForSlot(authority.candidateRoster, authority.candidateIds, slotId);
  return lens === null || candidate === null
    ? persistentFailure(panelError("architecture", "request-binding-mismatch", `slot ${slotId} is bound to no candidate lens`, { slotId }))
    : persistentSuccess(Object.freeze({ lens, candidate }));
}

export function parseRefutationPanelAuthority(raw: RefutationPanelAuthorityInput): PersistentPanelResult<RefutationPanelAuthority> {
  try {
    const input = safeRecord(raw, ["runId", "identityRunId", "findings", "lenses", "verifierSlots"]) ??
      safeRecord(raw, ["runId", "findings", "lenses", "verifierSlots"]);
    if (input === null) return persistentFailure(panelError("refutation", "invalid-authority", "refutation authority must be an exact data record"));
    const runId = parseOrchestrationRunId(input.runId);
    const identityRunId = parseOrchestrationRunId(input.identityRunId ?? input.runId);
    const rawFindings = safeArray(input.findings);
    const lenses = nonEmptyDistinctStrings(input.lenses);
    const roster = parseExactRoster(input.verifierSlots);
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
        "refutation-panel",
        "review-verifier-agent",
        lenses,
        "verifier",
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


const _architectureLensRemainsDisjoint: Exclude<PanelLens, ReviewLens> = "simplicity-first";
const _refutationLensRemainsDisjoint: Exclude<ReviewLens, PanelLens> = "reproduction";
void _architectureLensRemainsDisjoint;
void _refutationLensRemainsDisjoint;
