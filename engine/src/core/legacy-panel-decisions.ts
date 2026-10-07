/**
 * The legacy panel program's decisions: registration, the verdict-source
 * selection policy, submission settlement, and deterministic operations
 * (AD-8/AD-9, FR-006/009/011/012).
 *
 * The same selection policy the persistent panel submissions use, shared
 * through core/panel-verdict-source's vocabulary. One attempt's emission
 * evidence is decided from its already-read durable panel-verdict-source
 * record (the accepted call's exact-replay authority) or the caller's live
 * observation; every later decision over the same attempt reproduces the same
 * selection, the same selected bytes, and the same accepted call identity —
 * never a re-parse of pre-selection transcript bytes, and never a silent
 * extraction baseline over evidence that says otherwise.
 *
 * Every export here takes already-read evidence and decides:
 * `registeredPanelProgram`, `parseRegisteredPanelProgram`,
 * `logicalPanelRequestId`, `parsePanelVerdictSourceRecordBytes`,
 * `joinPanelAttemptIssuance`, `selectPanelAttemptVerdictSource`,
 * `panelSubmissionProblem`, `settlePanelAttempt`, and
 * `executeDeterministicPanelOperation`. The Run Directory reads, the
 * write-ahead record publication, the operation evidence adapter and the
 * panel driver loop live in the shell (handlers/helpers/programs/legacy-panel).
 *
 * Pure module: no I/O, no clock, no randomness. Enrolled in
 * DEFAULT_PURE_MODULES together with legacy-archive and the emission kernel
 * its verdict-source selection reaches through panel-verdict-source
 * (emission-ingestion, emission-tool, emission-observation, harness-capture), so
 * machine-purity.test.ts audits the whole transitive closure, not only this
 * file's text.
 */
import {
  parseArtifactByteLength,
  parseArtifactDigest,
  type AgentRequestAuthority,
  type ArtifactDigest,
  type DomainResult,
} from "./orchestration-contract";
import {
  describePanelRefusalPair,
  describePanelVerdictEmissionParseFailure,
  foldPanelVerdictEmission,
  panelVerdictSelectionRejection,
  panelVerdictSourceProvenance,
  panelVerdictSourceRecord,
  parsePanelVerdictSourceRecord,
  replayPanelVerdictSourceSelection,
  type PanelVerdictEmissionSelection,
  type PanelVerdictSource,
  type PanelVerdictSourceRecord,
  type PanelVerdictSourceSelection,
} from "./panel-verdict-source";
import { countRefutationVotes, defaultRefutationThreshold, parseRefutationVerdict, type RefutationVerdict } from "./review-panel";
import { aggregateVerdicts, architectureCriterion, candidateFilename, parseArchitectureCandidate, parseArchitectureFinalization, parseJudgeVerdict, type ArchitectureCriterion, type JudgeVerdict } from "./panel-contract";
import type { VerdictEnvelope } from "./panel-kernel";
import {
  translateLegacyPanelJournal,
  type LegacyArchitecturePanelJournal,
  type LegacyPanelJournal,
  type LegacyRefutationPanelJournal,
} from "./legacy-archive";
import { isRecord } from "./plain-record";
import { sha256Bytes } from "./digest";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** `context` is the exact immutable caller context from which role-specific packets derive. */
export type RegisteredPanelProgram =
  | Readonly<{ schemaVersion: 1; kind: "architecture"; input: LegacyArchitecturePanelJournal["input"]; context: unknown }>
  | Readonly<{ schemaVersion: 1; kind: "refutation"; input: LegacyRefutationPanelJournal["input"]; context: unknown }>;

/** The registration of one translated legacy journal; its panel names the registered kind. */
export function registeredPanelProgram(journal: LegacyPanelJournal, context: unknown): RegisteredPanelProgram {
  return journal.panel === "architecture"
    ? Object.freeze({ schemaVersion: 1, kind: "architecture", input: journal.input, context })
    : Object.freeze({ schemaVersion: 1, kind: "refutation", input: journal.input, context });
}

export function parseRegisteredPanelProgram(raw: unknown): RegisteredPanelProgram | null {
  if (!isRecord(raw)) return null;
  if (raw["schemaVersion"] !== 1 ||
      (raw["kind"] !== "architecture" && raw["kind"] !== "refutation") ||
      typeof raw["input"] !== "object" || raw["input"] === null) return null;
  const translated = translateLegacyPanelJournal(raw["kind"], { input: raw["input"], events: [] });
  return translated.ok
    ? registeredPanelProgram(translated.value, Object.hasOwn(raw, "context") ? raw["context"] : raw["input"])
    : null;
}

/** The request id the panel program reasons about: a retried attempt's reserved id minus its `:attempt-2` suffix. */
export function logicalPanelRequestId(requestId: string, attempt: 1 | 2): string {
  return attempt === 2 && requestId.endsWith(":attempt-2")
    ? requestId.slice(0, -":attempt-2".length)
    : requestId;
}

// ---------------------------------------------------------------------------
// Verdict-source resolution
// ---------------------------------------------------------------------------

export type PanelAttemptVerdictSource =
  | Readonly<{ kind: "baseline" }>
  | Readonly<{ kind: "selected"; selection: PanelVerdictSourceSelection; record: PanelVerdictSourceRecord | null }>;

const BASELINE_VERDICT_SOURCE: PanelAttemptVerdictSource = Object.freeze({ kind: "baseline" as const });

/** The bytes a selection accepts: the admitted emission arguments when the
 *  selection is emission, otherwise the attempt's own raw bytes. */
const selectedVerdictBytes = (selection: PanelVerdictSourceSelection | null, raw: string): string =>
  selection !== null && selection.kind === "emission-tool-arguments" ? selection.rawJson : raw;

/** The selection a resolved source carries (null for the extraction
 *  baseline) beside the bytes its verdict parse reads. */
const verdictParseTarget = (
  source: PanelAttemptVerdictSource,
  raw: string,
): Readonly<{ selection: PanelVerdictSourceSelection | null; target: string }> => {
  const selection = source.kind === "selected" ? source.selection : null;
  return { selection, target: selectedVerdictBytes(selection, raw) };
};

/** One panel attempt as its scan holds it: the reserved request, the attempt's raw bytes, and any live emission input. */
export type PanelAttempt = Readonly<{
  request: AgentRequestAuthority;
  raw: string;
  emission?: PanelVerdictEmissionSelection;
}>;

declare const ISSUANCE_JOINED: unique symbol;
/** A panel attempt whose live emission input passed every caller-side issuance join. */
export type JoinedPanelAttempt = PanelAttempt & Readonly<{ [ISSUANCE_JOINED]: true }>;

/**
 * The caller-side issuance joins of one panel attempt's emission input,
 * checked BEFORE any evidence is read: a binding that does not certify this
 * attempt's request, or that certifies the WRONG VERDICT KIND for the panel
 * program the attempt belongs to, is a caller defect — never an attempt
 * observation. A judge-verdict binding on a refutation verifier attempt would
 * otherwise fold into a selection the authoritative parse can only refuse
 * later — consuming the attempt on a defect that is not the model's. Panel
 * programs receive exactly their own verdict kind (judge criteria for the
 * architecture panel, refutation for the refutation panel); a non-panel
 * program carries no panel verdict kind, so only the request identity applies
 * there. (The legacy seam takes both verdict kinds in one union, so its kind
 * join is the runtime check the persistent seam's refinement types do at
 * compile time.) Returns the refusal message, or null when every join holds.
 */
function panelAttemptIssuanceJoinError(attempt: PanelAttempt): string | null {
  if (attempt.emission === undefined) return null;
  if (attempt.emission.binding.requestId !== attempt.request.requestId) {
    return `issued emission binding certifies request ${attempt.emission.binding.requestId}, not the submitted request ${attempt.request.requestId}`;
  }
  let panelVerdictKind: "judge-verdict" | "refutation-verdict" | null = null;
  if (attempt.request.program === "refutation-panel") panelVerdictKind = "refutation-verdict";
  else if (attempt.request.program === "architecture-panel") panelVerdictKind = "judge-verdict";
  if (panelVerdictKind === null || attempt.emission.binding.kind.kind === panelVerdictKind) return null;
  return `issued emission binding certifies producer kind ${attempt.emission.binding.kind.kind}, not the ${panelVerdictKind} kind the ${attempt.request.program} attempt ${attempt.request.requestId} belongs to`;
}

/** Parse one attempt into its joined form: the only constructor of `JoinedPanelAttempt`. */
export function joinPanelAttemptIssuance(attempt: PanelAttempt): DomainResult<JoinedPanelAttempt, string> {
  const error = panelAttemptIssuanceJoinError(attempt);
  return error === null ? { ok: true, value: attempt as JoinedPanelAttempt } : { ok: false, error };
}

/** The digest identity of the bytes one attempt's seam authoritatively parsed. */
function panelAttemptPayloadIdentity(rawJson: string): { digest: ArtifactDigest; byteLength: number } | null {
  const bytes = Buffer.from(rawJson, "utf-8");
  const digest = parseArtifactDigest(sha256Bytes(bytes));
  const byteLength = parseArtifactByteLength(bytes.length);
  return digest.ok && byteLength.ok ? { digest: digest.value, byteLength: byteLength.value } : null;
}

/**
 * Parse one attempt's durable panel verdict source record bytes. Absent is the
 * ordinary no-emission-evidence state; present-but-malformed is unavailable
 * evidence and fails closed — never a silent extraction baseline over a
 * record that says otherwise.
 */
export function parsePanelVerdictSourceRecordBytes(
  requestId: string,
  bytes: Uint8Array | null,
): DomainResult<PanelVerdictSourceRecord | null, string> {
  if (bytes === null) return { ok: true, value: null };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf-8"));
  } catch (error) {
    return { ok: false, error: `the durable panel verdict source for request ${requestId} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parsePanelVerdictSourceRecord(raw);
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, error: `the durable panel verdict source for request ${requestId} is malformed: ${parsed.error}` };
}

/** The durable-record arm of the resolution: the recorded selection is
 * authoritative and is replayed through the same seam (AD-9), and the
 * replayed bytes must still certify the record's payload identity — a
 * mismatching record refuses instead of being rewritten. */
function replayPanelAttemptDurableRecord(attempt: PanelAttempt, record: PanelVerdictSourceRecord): DomainResult<PanelAttemptVerdictSource, string> {
  if (record.requestId !== attempt.request.requestId) {
    return { ok: false, error: `the durable panel verdict source for request ${record.requestId} does not describe request ${attempt.request.requestId}` };
  }
  const replayed = replayPanelVerdictSourceSelection(record, attempt.raw);
  if (!replayed.ok) {
    return { ok: false, error: `durable panel verdict source for request ${attempt.request.requestId} could not be replayed: ${replayed.error}` };
  }
  const payload = selectedVerdictBytes(replayed.value, attempt.raw);
  const identity = panelAttemptPayloadIdentity(payload);
  if (identity === null || identity.digest !== record.payloadDigest || identity.byteLength !== record.payloadByteLength) {
    return { ok: false, error: `the durable panel verdict source for request ${attempt.request.requestId} does not describe the accepted attempt bytes` };
  }
  return { ok: true, value: Object.freeze({ kind: "selected" as const, selection: replayed.value, record }) };
}

/**
 * Resolve what emission evidence ONE joined panel attempt carries, given its
 * already-read durable record.
 *
 * The durable record is authoritative when present: its accepted call is
 * replayed through the ONE selection seam and its payload identity is
 * re-verified against the bytes this scan holds, so a replayed emission
 * selection reproduces the same selected bytes and call identity — and a
 * tampered or stale record refuses instead of degrading. Otherwise a live
 * emission input selects. With neither, the attempt is the extraction
 * baseline it always was.
 */
export function selectPanelAttemptVerdictSource(
  attempt: JoinedPanelAttempt,
  record: PanelVerdictSourceRecord | null,
): DomainResult<PanelAttemptVerdictSource, string> {
  if (record !== null) return replayPanelAttemptDurableRecord(attempt, record);
  if (attempt.emission !== undefined) {
    const selection = foldPanelVerdictEmission(attempt.emission, attempt.raw);
    return { ok: true, value: Object.freeze({ kind: "selected" as const, selection, record: null }) };
  }
  return { ok: true, value: BASELINE_VERDICT_SOURCE };
}

// ---------------------------------------------------------------------------
// Submission decision
// ---------------------------------------------------------------------------

function panelVerdictSelectionProblem(source: PanelAttemptVerdictSource): string | null {
  if (source.kind !== "selected") return null;
  if (source.selection.kind !== "duplicate-emission-call" && source.selection.kind !== "observation-refused") return null;
  return panelVerdictSelectionRejection(source.selection).message;
}

function panelVerdictParseProblem(
  selection: PanelVerdictSourceSelection | null,
  errors: readonly string[],
  label: "judge verdict" | "refutation verdict",
): string {
  if (selection === null) return errors.join("; ");
  if (selection.kind === "emission-tool-arguments") {
    return describePanelVerdictEmissionParseFailure(selection.call.toolCallId, label, errors.join("; "));
  }
  if (selection.kind === "extraction-over-refused-call") {
    return describePanelRefusalPair(selection.emissionRefusal, errors.join("; "));
  }
  return errors.join("; ");
}

function panelVerdictSelectionUpgradeRefusal(source: PanelAttemptVerdictSource, logicalRequestId: string): string | null {
  return source.kind === "selected"
    ? `request ${logicalRequestId} is an extraction-only panel slot that advertises no emission tool; an observed emission call cannot upgrade it`
    : null;
}

/** Why one logical panel result is refused under its resolved verdict source, or null when it is accepted. */
export function panelSubmissionProblem(
  registration: RegisteredPanelProgram,
  logicalRequestId: string,
  raw: string,
  source: PanelAttemptVerdictSource = BASELINE_VERDICT_SOURCE,
): string | null {
  if (registration.kind === "refutation") {
    const match = /^refutation:verifier:(\d+)$/.exec(logicalRequestId);
    const input = registration.input;
    const index = match === null ? -1 : Number(match[1]) - 1;
    const lens = input.lenses[index];
    if (lens === undefined) return `request ${logicalRequestId} is not a canonical verifier slot`;
    const selectionProblem = panelVerdictSelectionProblem(source);
    if (selectionProblem !== null) return selectionProblem;
    const { selection, target } = verdictParseTarget(source, raw);
    const parsed = parseRefutationVerdict(target, lens, input.criticalFindingIds);
    return parsed.ok ? null : panelVerdictParseProblem(selection, parsed.errors, "refutation verdict");
  }

  const input = registration.input;
  const candidateMatch = /^architecture:candidate:(\d+)$/.exec(logicalRequestId);
  if (candidateMatch !== null) {
    const index = Number(candidateMatch[1]) - 1;
    const lens = input.candidateLenses[index];
    if (lens === undefined) return `request ${logicalRequestId} is not a canonical candidate slot`;
    const upgradeRefusal = panelVerdictSelectionUpgradeRefusal(source, logicalRequestId);
    if (upgradeRefusal !== null) return upgradeRefusal;
    const parsed = parseArchitectureCandidate(raw, lens);
    return parsed.ok ? null : parsed.errors.join("; ");
  }

  const judgeMatch = /^architecture:judge:(\d+)$/.exec(logicalRequestId);
  if (judgeMatch !== null) {
    const criterion = input.judgeCriteria[Number(judgeMatch[1]) - 1];
    if (criterion === undefined) return `request ${logicalRequestId} is not a canonical judge slot`;
    // The criterion is minted through the closed vocabulary, never asserted
    // into the brand: the journal is checkpoint-loaded (untrusted) input, and
    // a criterion outside deriveJudgeCriteria's vocabulary cannot come from a
    // validated digest.
    const branded = architectureCriterion(criterion);
    if (branded === null) return `request ${logicalRequestId} carries judge criterion ${JSON.stringify(criterion)}, which is outside the validated interview vocabulary`;
    const selectionProblem = panelVerdictSelectionProblem(source);
    if (selectionProblem !== null) return selectionProblem;
    const { selection, target } = verdictParseTarget(source, raw);
    const verdict = parseJudgeVerdict(target, branded, input.candidateLenses.map(candidateFilename));
    return verdict.ok ? null : panelVerdictParseProblem(selection, verdict.errors, "judge verdict");
  }

  if (logicalRequestId === "architecture:finalize") {
    const upgradeRefusal = panelVerdictSelectionUpgradeRefusal(source, logicalRequestId);
    if (upgradeRefusal !== null) return upgradeRefusal;
    const parsed = parseArchitectureFinalization(raw, input.candidateLenses.map(candidateFilename));
    return parsed.ok ? null : parsed.errors.join("; ");
  }

  return `request ${logicalRequestId} is not a canonical architecture result slot`;
}

/** One logical panel submission under decision. */
export type PanelSubmission = PanelAttempt & Readonly<{
  registration: RegisteredPanelProgram;
  logicalRequestId: string;
}>;

/**
 * How one panel attempt settles: its problem (null = accepted), its accepted
 * source, and — only when a LIVE emission selection was accepted — the
 * write-ahead source record the shell must publish BEFORE the outcome is
 * declared. Replayed selections never republish (the durable record already
 * carries them), and rejected selections publish nothing: the rejection's
 * diagnostics travel with the outcome event.
 */
export type PanelAttemptSettlement = Readonly<{
  problem: string | null;
  source: PanelVerdictSource | null;
  publication: PanelVerdictSourceRecord | null;
}>;

export function settlePanelAttempt(
  submission: PanelSubmission,
  resolved: PanelAttemptVerdictSource,
): DomainResult<PanelAttemptSettlement, string> {
  const settledWith = (problem: string | null, source: PanelVerdictSource | null, publication: PanelVerdictSourceRecord | null = null) =>
    ({ ok: true as const, value: Object.freeze({ problem, source, publication }) });
  const problem = panelSubmissionProblem(submission.registration, submission.logicalRequestId, submission.raw, resolved);
  if (problem !== null) return settledWith(problem, null);
  if (resolved.kind === "baseline") return settledWith(null, null);
  if (resolved.record !== null) return settledWith(null, resolved.record.source);
  const selection = resolved.selection;
  if (selection.kind === "duplicate-emission-call" || selection.kind === "observation-refused") {
    // Unreachable — a rejected selection always produced a problem above. The
    // guard carries the invariant instead of handing rejected arms to the
    // provenance mapping.
    return { ok: false, error: "panel verdict invariant: a rejected selection settled without a problem" };
  }
  const binding = submission.emission?.binding;
  if (binding === undefined) {
    return { ok: false, error: "panel verdict invariant: a live selection exists without an issued emission binding" };
  }
  const source = panelVerdictSourceProvenance(binding, selection);
  const acceptedRawJson = selectedVerdictBytes(selection, submission.raw);
  const identity = panelAttemptPayloadIdentity(acceptedRawJson);
  if (identity === null) {
    return { ok: false, error: `the accepted panel verdict bytes for request ${submission.request.requestId} have no bounded digest identity` };
  }
  const record = panelVerdictSourceRecord({
    requestId: submission.request.requestId,
    slotId: submission.request.slotId,
    attempt: submission.request.attempt,
    source,
    acceptedCall: selection.kind === "emission-tool-arguments" ? selection.call : undefined,
    payloadDigest: identity.digest,
    payloadByteLength: identity.byteLength,
  });
  if (!record.ok) {
    return { ok: false, error: `the panel verdict source record for request ${submission.request.requestId} could not be constructed: ${record.error}` };
  }
  return settledWith(null, source, record.value);
}

// ---------------------------------------------------------------------------
// Deterministic panel operations
// ---------------------------------------------------------------------------

export type DeterministicOperationArtifact = Readonly<{ relativePath: string; bytes: readonly number[] }>;

/** One evidence lookup's result: the looked-up text, or why it is unavailable. */
export type PanelEvidenceLookup<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; message: string }>;

/**
 * The captured evidence one deterministic operation reads, per logical panel
 * request: the latest captured attempt's raw bytes, and the parse target its
 * verdict source selects — the attempt's own raw bytes, EXCEPT when its
 * durable verdict source record replays an emission selection; then the
 * selection's bytes, reproduced by the same seam that accepted them (a replay
 * that refuses fails the operation closed instead of re-parsing raw bytes the
 * acceptance never used).
 */
export type PanelOperationEvidence = Readonly<{
  capturedRaw: (logicalRequestId: string) => PanelEvidenceLookup<string>;
  parseTarget: (logicalRequestId: string) => PanelEvidenceLookup<string>;
}>;

function operationArtifact(relativePath: string, value: unknown): DeterministicOperationArtifact {
  return Object.freeze({
    relativePath,
    bytes: Object.freeze([...Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf-8")]),
  });
}

/** The artifacts one deterministic panel operation publishes, derived from its captured evidence. */
export function executeDeterministicPanelOperation(
  runId: string,
  registration: RegisteredPanelProgram,
  operationId: string,
  evidence: PanelOperationEvidence,
): Readonly<{ ok: true; artifacts: readonly DeterministicOperationArtifact[] }> |
  Readonly<{ ok: false; message: string }> {
  if (registration.kind === "refutation") {
    const input = registration.input;
    if (operationId === "refutation-prepare-verifiers") {
      return {
        ok: true,
        artifacts: Object.freeze([operationArtifact("operations/refutation-prepare-verifiers.json", {
          schemaVersion: 1, runId, findingIds: input.criticalFindingIds, lenses: input.lenses,
        })]),
      };
    }
    if (operationId !== "refutation-tally") {
      return { ok: false, message: `unsupported refutation operation ${operationId}` };
    }
    const verdicts: Readonly<{ lens: (typeof input.lenses)[number]; verdict: VerdictEnvelope<RefutationVerdict> }>[] = [];
    for (const [index, lens] of input.lenses.entries()) {
      const target = evidence.parseTarget(`refutation:verifier:${index + 1}`);
      if (!target.ok) return target;
      const parsed = parseRefutationVerdict(target.value, lens, input.criticalFindingIds);
      if (!parsed.ok) return { ok: false, message: parsed.errors.join("; ") };
      verdicts.push(Object.freeze({ lens, verdict: parsed.value }));
    }
    // The threshold formula and the k-of-n rule are DOMAIN rules and live in
    // the core (`defaultRefutationThreshold` / `countRefutationVotes`), which
    // the persistent panel path already delegates to.
    const threshold = defaultRefutationThreshold(input.lenses.length);
    // The verdict parser proves every finding is covered; a verdict that
    // still lacks one refuses here as a typed failure, never an undefined vote.
    const outcomes = [];
    for (const findingId of input.criticalFindingIds) {
      const judgements = [];
      for (const { lens, verdict } of verdicts) {
        const entry = verdict.entries.find((candidate) => candidate.findingId === findingId);
        if (entry === undefined) return { ok: false, message: `the ${lens} refutation verdict carries no entry for finding ${findingId}` };
        judgements.push(Object.freeze({ lens, entry }));
      }
      const tallied = countRefutationVotes(judgements, threshold);
      outcomes.push(Object.freeze({
        finding_id: findingId,
        survives: tallied.survives,
        refuted_by: Object.freeze(tallied.refutations.map(({ lens }) => lens)),
        votes: Object.freeze(judgements.map(({ lens, entry }) => Object.freeze({ lens, vote: entry }))),
      }));
    }
    const result = Object.freeze({
      schemaVersion: 1,
      kind: "refutation-panel-result",
      runId,
      lenses: input.lenses,
      threshold,
      outcomes: Object.freeze(outcomes),
    });
    return {
      ok: true,
      artifacts: Object.freeze([
        operationArtifact("operations/refutation-tally.json", result),
        operationArtifact("result.json", result),
      ]),
    };
  }

  const input = registration.input;
  const candidates = input.candidateLenses.map(candidateFilename);
  if (operationId === "architecture-prepare-candidates") {
    return {
      ok: true,
      artifacts: Object.freeze([operationArtifact("operations/architecture-prepare-candidates.json", {
        schemaVersion: 1, runId, lenses: input.candidateLenses, candidates,
      })]),
    };
  }
  if (operationId === "architecture-prepare-judges") {
    const accepted = [];
    for (let index = 0; index < input.candidateLenses.length; index += 1) {
      const raw = evidence.capturedRaw(`architecture:candidate:${index + 1}`);
      if (!raw.ok) return raw;
      const problem = panelSubmissionProblem(registration, `architecture:candidate:${index + 1}`, raw.value);
      if (problem !== null) return { ok: false, message: problem };
      accepted.push(JSON.parse(raw.value) as unknown);
    }
    return {
      ok: true,
      artifacts: Object.freeze([operationArtifact("operations/architecture-prepare-judges.json", {
        schemaVersion: 1, candidates: accepted, criteria: input.judgeCriteria,
      })]),
    };
  }
  if (operationId === "architecture-aggregate") {
    // Checkpoint-loaded criteria are minted through the closed vocabulary
    // (the same parse boundary the panel authority mints at), never asserted
    // into the brand; a foreign criterion refuses here instead of binding.
    const criteria: ArchitectureCriterion[] = [];
    for (const criterion of input.judgeCriteria) {
      const branded = architectureCriterion(criterion);
      if (branded === null) return { ok: false, message: `judge criterion ${JSON.stringify(criterion)} is outside the validated interview vocabulary` };
      criteria.push(branded);
    }
    const verdicts: JudgeVerdict[] = [];
    for (const [index, criterion] of criteria.entries()) {
      const target = evidence.parseTarget(`architecture:judge:${index + 1}`);
      if (!target.ok) return target;
      const parsed = parseJudgeVerdict(target.value, criterion, candidates);
      if (!parsed.ok) return { ok: false, message: parsed.errors.join("; ") };
      verdicts.push(parsed.value);
    }
    const ranking = aggregateVerdicts(verdicts, criteria, candidates);
    if (!ranking.ok) return { ok: false, message: ranking.errors.join("; ") };
    return {
      ok: true,
      artifacts: Object.freeze([
        operationArtifact("operations/architecture-aggregate.json", {
          schemaVersion: 1, kind: "architecture-ranking", runId, ranking: ranking.value,
        }),
        operationArtifact("ranking.json", ranking.value),
      ]),
    };
  }
  return { ok: false, message: `unsupported architecture operation ${operationId}` };
}
