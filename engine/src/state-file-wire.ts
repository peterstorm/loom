/**
 * State File wire grammar — pure at-rest parsing, shared by the loader and the
 * operator validator.
 *
 * Every function here is `(unknown → ParseResult)` or `(parsed parts → error
 * strings)`: no filesystem, no lock, no session authority. The authority
 * machine that reads bytes through anchored no-follow handles and publishes
 * under the TaskGraph lock lives in `state-manager.ts`, which re-exports this
 * module's public surface so the import surface is unchanged.
 *
 * Parse, don't validate: every union-typed field is PROVEN in the union and
 * installed as its parsed value, so a drifted or hand-edited value fails loudly
 * at the load boundary instead of exploding later inside typed gate logic.
 */

import { isAbsolute, join, resolve } from "node:path";
import { parseErr, parseOk, type ParseResult } from "./machine";
import {
  isWaveReviewRunRetirement,
  parseStoredNewTestEvidence,
  REVIEW_STATUSES,
  type TaskCommonMetadata,
  type TaskLifecycle,
  type TaskStatus,
  TASK_STATUSES,
  type Phase,
} from "./types";
import { repeatedRetiredRun } from "./core/retired-wave-review-runs";
import { parseSealedSubjectDigest } from "./core/review-subject";
import { parseReviewNarrowing } from "./core/review-narrowing";
import {
  findingIdCollisionError,
  findingsLockstepError,
  parseStoredFindingsField,
  parseStoredRefutationsField,
  parseStoredResolutionsField,
  findingsViewError,
  evidenceFailureError,
  reviewRunError,
} from "./core/findings";
import type {
  ActiveWaveGateRegistration,
  CompletedWaveGateRegistration,
  ForwardFixAudit,
  ForwardFixWithdrawal,
  OrphanedWaveGateRetirement,
  RetiredWaveReviewRun,
  OwnerObligation,
  WaveReopeningAudit,
  ReopenedTaskIds,
  TaskReopeningAudit,
  EngineRevisionAdoption,
  EngineRevisionPin,
  WavePlanEdit,
  RetroRecord,
  RetroScope,
  SpecCheck,
  SpecTraceAmendment,
  SpecAmendment,
  SpecAmendmentRejudgement,
  IndexedSpecIndexObservation,
  SpecTraceAmendmentChange,
  SpecTraceOwnership,
  SpecTraceWaveGateRetirement,
  Task,
  TaskGraph,
  WaveReviewEpochAuthority,
  WaveSpecCheckDocumentsAuthority,
} from "./types";
import {
  parseArtifactDigest,
  parseArtifactRef,
  parseBlockedDiagnostic,
  parseEffectId,
  parseOrchestrationRunId,
  parseSlotId,
  canonicalStructuralEquals,
  isNonEmpty,
  nonEmpty,
  nonEmptyOf,
  type NonEmpty,
  type OrchestrationRunId,
} from "./core/orchestration-contract";
import {
  derivePendingTaskProof,
  deriveProofObligations,
  parseTaskProof,
  parseTaskTestResult,
  redThenGreenScope,
  taskRedThenGreenEra,
  testsOnlyScopeOfProof,
  writtenContract,
  type RedThenGreenScope,
  type ProofObligation,
  type ProofTestResult,
  type TaskProof,
  type TestsOnlyScope,
} from "./core/proof-obligations";
import {
  classifyTestsOnlyScope,
  parseReopenBaseline,
  parseTestsOnlyScope,
  partitionsFileList,
  reopeningNeedsOf,
} from "./core/reopen-scope";
import { parseDeclaredArtifactBaseline, type DeclaredArtifactBaseline } from "./core/artifact-baseline";
import {
  parseSettledFloor,
  parseSpecIndexObservation,
  specIndexObservationPath,
  type SpecIndexObservation,
} from "./core/requirement-coverage";
import { parseStoredSpecCheck } from "./core/spec-check";
import { parseProofBoundaryObservation } from "./core/proof-boundary-observation";
import { parsePlanDesignReview } from "./core/plan-design-review";
import { reconcileWaveBlock, waveHasBlockCause, type WaveGate } from "./core/wave-gate-model";
import { parseWaveSpecCheckDocumentsAuthority, type WaveSpecCheckDocumentRejection, type WaveSpecCheckDocumentsRejection } from "./core/wave-review-authority";
import { parseIssuedReviewPacketRegistration, parseReviewPath } from "./core/review-packet";
import { isExactGitSha } from "./core/git-sha";
import { isAdoptionReason, isEngineRevision, MAX_ENGINE_REVISION_REASON_LENGTH } from "./core/engine-revision-pin";
import { dependencyAddedEdit, parsePlanEditReason, taskAddedEdit, taskRescopedEdit, taskWithdrawnEdit } from "./core/wave-plan-edit";
import { retroRecordEntry, retroScopeKnown } from "./core/retro-record";
import { parseAdvisoryDispositions } from "./core/advisory-disposition";
import { dependencyCycles } from "./core/task-dependencies";
import {
  amendmentHistoryError,
  parseSpecTraceContract,
  parseTraceOwnership,
  specTraceDiagnosticMessages,
} from "./core/spec-trace";
import {
  claimsDistillPassWaiver,
  DISTILL_PASS,
  isDistillVerificationPolicy,
  parseTaskVerificationPolicy,
  type ParsedTaskVerificationPolicy,
} from "./core/verification-policy";
import { isDistillTask, taskRolePolicy } from "./core/distill-task";
import { taskArtifactExpectation, taskArtifactScope } from "./core/task-artifact-expectation";
import { MAX_TASK_REOPENING_REASON_LENGTH, sweptDistillTaskIdsOf } from "./core/task-reopening";
import { reopenedTaskIds, type ReopenedTaskIdsRefusal } from "./core/task-revalidation";
import {
  isProtectedVerificationPath,
  parseAcceptedWaveCompletionReceipt,
  type AcceptedWaveCompletionReceipt,
} from "./core/completion-suite";
import {
  canonicalArtifactBaselineDigest,
  parseImplementationAttemptAuthority,
  parseImplementationAttemptHistory,
  parseImplementationSettlementReceiptId,
  type ImplementationAttemptAuthority,
  type ImplementationAttemptSettlementReceipt,
} from "./core/implementation-completion";
import {
  deriveImplementationRetryDisposition,
  implementationAttemptContextMatchesAuthority,
  parseImplementationAttemptContext,
  renderImplementationRetryContext,
  type ImplementationAttemptContext,
  type ImplementationRetryDisposition,
} from "./core/implementation-retry";
import { parseTaskId, type TaskId } from "./core/task-id";
import {
  authorizeWaveCompletionSuite,
  parseFrozenVerificationManifest,
  type FrozenVerificationManifest,
} from "./core/verification-manifest";
import { parseWaveReviewerProtocolDescriptor } from "./core/reviewer-contract";
import { parseTestEvidenceField } from "./core/test-evidence-authority";
import { PHASE_ORDER } from "./config";
import { KNOWN_AGENTS, REVIEW_SUB_AGENTS } from "./core/agent-catalog-projections";
import { isRecord } from "./core/plain-record";
import {
  contractWriter,
  frozenPaths,
  parseAcceptanceContracts,
  type AcceptanceContract,
  type ContractWriterProblem,
} from "./core/acceptance-contract";
import {
  ownerCheckAuthorityOf,
  parseOwnerObligations,
  waveOwnerDuty,
  type OwnerCheckAuthority,
} from "./core/owner-verification/obligations";
import { aliasClassClashes, aliasCollisions, parseContractId, parseIdentifier } from "./core/skeleton/bindings";
import { skeletonLanguageOf } from "./core/skeleton/language";
import type {
  BoundExport,
  ExportBinding,
  Identifier,
  PathSkeletonOutcome,
  SkeletonLanguage,
  SkeletonOrigin,
  SkeletonOutcome,
  SkeletonRecord,
  UnsupportedReason,
} from "./core/skeleton/types";

/**
 * Prove one wave gate's shape, for the reason every `Task` union field is proven.
 *
 * The TaskGraph asserts `Record<string, WaveGate>`, and the load used to
 * prove nothing beyond "the container is an object". Four booleans read by gate
 * logic as booleans: `validate-task-execution` blocks on `!gate.reviews_complete`,
 * so `{ reviews_complete: "no" }` loaded clean and read as TRUTHY — the
 * previous-wave review gate silently stopped blocking, which is the failure this
 * boundary exists to make impossible. `tests_passed` is the one two-state
 * "judged / not yet judged" field (`true | null`), and `false` is refused
 * outright — no writer produces it, and a drifted graph carrying it would
 * otherwise mint a failure message nothing in the engine ever wrote.
 */
function parseWaveGate(raw: unknown, wave: string): ParseResult<WaveGate> {
  const label = `wave_gates["${wave}"]`;
  if (!isRecord(raw)) return parseErr(`${label} must be an object`);
  // Diagnose malformed fields before absent siblings so a partially supplied
  // record points at the value the writer actually got wrong.
  const malformed = WAVE_GATE_FLAGS.find((field) => field in raw && typeof raw[field] !== "boolean");
  if (malformed !== undefined) return parseErr(`${label}: ${malformed} must be a boolean, got ${JSON.stringify(raw[malformed])}`);
  const { impl_complete: implComplete, reviews_complete: reviewsComplete, blocked, tests_passed: testsPassed } = raw;
  if ("tests_passed" in raw && testsPassed !== null && typeof testsPassed !== "boolean") {
    return parseErr(`${label}: tests_passed must be a boolean or null, got ${JSON.stringify(testsPassed)}`);
  }
  if ("tests_passed" in raw && testsPassed === false) {
    return parseErr(
      `${label}: tests_passed: false is not a representable gate state ` +
      `(no writer produces it; failing runs are judged by test_result evidence) — ` +
      `set null (not yet judged) or true (passed)`,
    );
  }
  // Every present flag is a boolean and a present tests_passed is true or
  // null, so what is not one now is absent.
  if (typeof implComplete !== "boolean") return parseErr(`${label}: missing required field impl_complete`);
  if (typeof reviewsComplete !== "boolean") return parseErr(`${label}: missing required field reviews_complete`);
  if (typeof blocked !== "boolean") return parseErr(`${label}: missing required field blocked`);
  if (testsPassed !== true && testsPassed !== null) return parseErr(`${label}: missing required field tests_passed`);
  return parseOk({ ...raw, impl_complete: implComplete, tests_passed: testsPassed, reviews_complete: reviewsComplete, blocked });
}

/** A Wave Gate's boolean flags, in the order a malformed one is diagnosed. */
const WAVE_GATE_FLAGS = ["impl_complete", "reviews_complete", "blocked"] as const;

/**
 * Prove the spec-check record, routed through the smart constructor that exists
 * for it. `parseSpecCheckVerdict` was written to keep free text out of the
 * gate's typed logic and the load path never called it, so a drifted `verdict`
 * reached `complete-wave-gate` unchallenged.
 *
 * The PARSED value is returned, not just its errors: the parser rebuilds and
 * freezes the record, and installing that is what makes the proof survive.
 * Keeping the raw object from the JSON document instead would leave the holder
 * of that reference able to write `critical_count` back out of the
 * count/findings-length equality proven here.
 */
function parseSpecCheckField(v: unknown):
  | Readonly<{ ok: true; value: SpecCheck | undefined }>
  | Readonly<{ ok: false; error: string }> {
  if (v === undefined) return { ok: true, value: undefined };
  const parsed = parseStoredSpecCheck(v);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: parsed.errors.join("; ") };
}

/**
 * Prove every `blocked: true` gate has a CAUSE.
 *
 * `blocked` is an orthogonal veto — it legitimately coexists with
 * `impl_complete`/`reviews_complete` (see `WaveGate`), so no combination of the
 * flags is contradictory on its own. What IS meaningless is a veto with no
 * reason behind it: the flag has exactly two causes, and the finding/spec-check
 * callers invoke `reconcileWaveBlock` against `core/wave-gate-model.ts`
 * `waveHasBlockCause` after rewriting their evidence. That reconciliation
 * clears the flag when the last cause dies, using the writers' own predicate so
 * the load boundary cannot disagree with them. Its absence is not cosmetic:
 * `validate-task-execution` renders a causeless gate as
 *
 *     BLOCKED: Wave N review gate not passed.
 *     Wave N is BLOCKED due to:
 *     Run: /wave-gate
 *
 * — a refusal with an empty reason list, and `/wave-gate` cannot clear a block
 * whose cause it cannot find. The wave dead-ends. Proving the cause at load
 * means a drifted or hand-edited graph is rejected with a diagnostic instead of
 * reaching that state, exactly as the `tests_passed: false` rule above does.
 *
 * The two causes, verbatim from the writers:
 *   1. `store-review-findings` / the Pi mirror set `blocked: true` when a task
 *      in that wave stores critical review findings.
 *   2. `store-spec-check-findings` / the Pi mirror set it when the wave's
 *      spec-check reports `critical_count > 0`.
 */
function blockedGateCauseError(
  waveGates: Readonly<Record<string, WaveGate>>,
  tasks: readonly ParsedTask[],
  specCheck: SpecCheck | undefined,
): string | null {
  for (const [wave, gate] of Object.entries(waveGates)) {
    if (!gate.blocked) continue;
    // The SAME predicate the writers use to set and clear the flag
    // (`core/wave-gate-model`), so the boundary can never disagree with them
    // about what counts as a cause.
    if (waveHasBlockCause(tasks, specCheck, Number(wave))) continue;
    return (
      `wave_gates["${wave}"]: blocked: true has no cause — no task in wave ${wave} carries ` +
      `critical review findings and spec_check does not report a critical finding for it. ` +
      `A causeless block withholds the wave with an empty "BLOCKED due to:" reason list; ` +
      `clear the flag or restore the findings that justify it — no \`--fix\` path repairs this invariant`
    );
  }
  return null;
}

/**
 * Which required fields are absent and which unknown ones are present, as one
 * error — or `null` when the record's key set is exactly right.
 *
 * The three protected wave-gate registration parsers each hand-rolled this same
 * pair of filters against their own FIELDS constant. They are the load-boundary
 * proofs for protected state, so a copy that forgot to `.sort()` its unknown
 * list, or checked `in` against the wrong constant, would weaken exactly the
 * check that keeps a hand-edited State File out.
 */
function exactFieldsError(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): string | null {
  const allowed = new Set<string>([...required, ...optional]);
  const unknownFields = Object.keys(record).filter((field) => !allowed.has(field));
  if (unknownFields.length > 0) return `${label} contains unknown field(s): ${unknownFields.sort().join(", ")}`;
  const missingFields = required.filter((field) => !(field in record));
  return missingFields.length > 0 ? `${label} is missing field(s): ${missingFields.join(", ")}` : null;
}

/**
 * An optional append-only log under its wire name `field`: absent, or an
 * array whose every entry parses under its `field[index]` label and whose
 * entries then hold together (`collectionError`). An entry parser is handed
 * the entries before it, for a rule that refuses at the first entry
 * repeating an earlier one. The first refusal wins.
 */
function parseOptionalLog<T>(
  raw: unknown,
  field: string,
  parseEntry: (entry: unknown, label: string, earlier: readonly T[]) => ParseResult<T>,
  collectionError: (entries: readonly T[]) => string | null = () => null,
): ParseResult<readonly T[] | undefined> {
  if (raw === undefined) return parseOk(undefined);
  if (!Array.isArray(raw)) return parseErr(`${field} must be an array when present`);
  const entries: T[] = [];
  for (const [index, entry] of raw.entries()) {
    const parsed = parseEntry(entry, `${field}[${index}]`, entries);
    if (!parsed.ok) return parsed;
    entries.push(parsed.value);
  }
  const error = collectionError(entries);
  return error === null ? parseOk(Object.freeze(entries)) : parseErr(error);
}

/** A refusal its parser words without a location, prefixed with the `label` it occurred under. */
function labelled<T>(label: string, parsed: ParseResult<T>): ParseResult<T> {
  return parsed.ok ? parsed : parseErr(`${label}: ${parsed.error}`);
}

/** Why two entries share an identity, as `message`, or null when every identity is distinct. */
const repeatedIdentity = (identities: readonly string[], message: string): string | null =>
  new Set(identities).size === identities.length ? null : message;

const WAVE_REVIEW_EPOCH_FIELDS = ["runId", "wave", "batchEpoch"] as const;
const WAVE_REVIEW_EPOCH_OPTIONAL_FIELDS = ["specCheckDocuments", "specCheckSlotAuthority", "settledSpecCheckFloor"] as const;

/** Decorate the shared Wave Review Epoch Authority grammar's rejection facts
 *  with this transport's exact load-guard prose. The labels and messages are
 *  byte-identical to the pre-shared-parser diagnostics the load-guard suite
 *  pins; the acceptance itself is now the ONE shared parser, so the load
 *  boundary and the reviewer-context decode cannot drift. */
function specCheckDocumentRejectionMessage(label: string, rejection: WaveSpecCheckDocumentRejection): string {
  switch (rejection.kind) {
    case "not-an-object": return `${label} must be an object`;
    case "unknown-fields": return `${label} contains unknown field(s): ${[...rejection.fields].sort().join(", ")}`;
    case "missing-fields": return `${label} is missing field(s): ${rejection.fields.join(", ")}`;
    case "path-not-string-or-null": return `${label}.path must be a string or null`;
    case "path-blank": return `${label}.path must not be blank when present`;
    case "null-lockstep": return `${label}.path and contentDigest must both be null or both be present`;
    case "invalid-digest": return `${label}.contentDigest: ${rejection.message}`;
  }
}

function specCheckDocumentsRejectionMessage(label: string, rejection: WaveSpecCheckDocumentsRejection): string {
  return rejection.kind === "member"
    ? specCheckDocumentRejectionMessage(`${label}.${rejection.member}`, rejection.failure)
    : specCheckDocumentRejectionMessage(label, rejection);
}

function parseWaveSpecCheckDocuments(
  raw: unknown,
): ParseResult<WaveSpecCheckDocumentsAuthority | undefined> {
  if (raw === undefined) return parseOk(undefined);
  if (!isRecord(raw)) {
    return parseErr("wave_review_epoch.specCheckDocuments must be an object when present");
  }
  const parsed = parseWaveSpecCheckDocumentsAuthority(raw);
  return parsed.ok
    ? parseOk(parsed.value)
    : parseErr(specCheckDocumentsRejectionMessage("wave_review_epoch.specCheckDocuments", parsed.rejection));
}

function parseWaveSpecCheckSlotAuthority(
  raw: unknown,
): ParseResult<WaveReviewEpochAuthority["specCheckSlotAuthority"]> {
  if (raw === undefined) return parseOk(undefined);
  if (!isRecord(raw)) {
    return parseErr("wave_review_epoch.specCheckSlotAuthority must be an object when present");
  }
  const record = raw as Record<string, unknown>;
  const fieldsError = exactFieldsError(
    record,
    ["slot_id", "attempted"],
    [],
    "wave_review_epoch.specCheckSlotAuthority",
  );
  if (fieldsError !== null) return parseErr(fieldsError);
  const slotId = parseSlotId(record.slot_id);
  if (!slotId.ok) {
    return parseErr(`wave_review_epoch.specCheckSlotAuthority.slot_id: ${slotId.error.message}`);
  }
  if (record.attempted !== 1 && record.attempted !== 2) {
    return parseErr("wave_review_epoch.specCheckSlotAuthority.attempted must be 1 or 2");
  }
  return parseOk(Object.freeze({ slot_id: slotId.value, attempted: record.attempted }));
}

/** Parse one inclusive safe-integer lower bound with its caller-owned diagnostic. */
function parseIntegerBound(
  value: unknown,
  label: string,
  min: number,
  minDescription: string,
): { ok: true; value: number } | { ok: false; error: string } {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min
    ? { ok: true, value }
    : { ok: false, error: `${label} must be ${minDescription}` };
}

function parseWaveReviewEpoch(raw: unknown): ParseResult<WaveReviewEpochAuthority | undefined> {
  if (raw === undefined) return parseOk(undefined);
  if (!isRecord(raw)) {
    return parseErr("wave_review_epoch must be an object when present");
  }
  const record = raw as Record<string, unknown>;
  const fieldsError = exactFieldsError(
    record,
    WAVE_REVIEW_EPOCH_FIELDS,
    WAVE_REVIEW_EPOCH_OPTIONAL_FIELDS,
    "wave_review_epoch",
  );
  if (fieldsError !== null) return parseErr(fieldsError);
  const runId = parseOrchestrationRunId(record.runId);
  if (!runId.ok) return parseErr(`wave_review_epoch.runId: ${runId.error.message}`);
  const wave = parseIntegerBound(
    record.wave,
    "wave_review_epoch.wave",
    1,
    "an integer >= 1 within the safe-integer range",
  );
  if (!wave.ok) return parseErr(wave.error);
  const batchEpoch = parseArtifactDigest(record.batchEpoch);
  if (!batchEpoch.ok) return parseErr(`wave_review_epoch.batchEpoch: ${batchEpoch.error.message}`);
  const specCheckDocuments = parseWaveSpecCheckDocuments(record.specCheckDocuments);
  if (!specCheckDocuments.ok) return specCheckDocuments;
  const specCheckSlotAuthority = parseWaveSpecCheckSlotAuthority(record.specCheckSlotAuthority);
  if (!specCheckSlotAuthority.ok) return specCheckSlotAuthority;
  // Absent is a historical epoch and stays absent; present-but-unrecognized is
  // corruption and must not silently degrade the floor to "no floor".
  const settledSpecCheckFloor = record.settledSpecCheckFloor === undefined
    ? null
    : parseSettledFloor(record.settledSpecCheckFloor);
  if (record.settledSpecCheckFloor !== undefined && settledSpecCheckFloor === null) {
    return parseErr("wave_review_epoch.settledSpecCheckFloor is not a recognized settled floor");
  }
  return parseOk(Object.freeze({
    runId: runId.value,
    wave: wave.value,
    batchEpoch: batchEpoch.value,
    ...(specCheckDocuments.value === undefined ? {} : { specCheckDocuments: specCheckDocuments.value }),
    ...(specCheckSlotAuthority.value === undefined
      ? {}
      : { specCheckSlotAuthority: specCheckSlotAuthority.value }),
    ...(settledSpecCheckFloor === null ? {} : { settledSpecCheckFloor }),
  }));
}

const ACTIVE_WAVE_GATE_FIELDS = [
  "schemaVersion", "kind", "runId", "wave", "authorityDigest", "revision", "terminalOutcome",
] as const;
const ACTIVE_WAVE_GATE_OPTIONAL_FIELDS = ["runsRoot"] as const;

function parseActiveWaveGateTerminalOutcome(
  raw: unknown,
  runId: ActiveWaveGateRegistration["runId"],
): ParseResult<ActiveWaveGateRegistration["terminalOutcome"]> {
  if (raw === null) return parseOk(null);
  if (!isRecord(raw)) {
    return parseErr("active_wave_gate.terminalOutcome must be null or an object");
  }
  const terminal = raw as Record<string, unknown>;
  if (terminal.kind === "done") {
    const keys = Object.keys(terminal);
    if (keys.length !== 2 || !keys.includes("outcome")) {
      return parseErr("active_wave_gate.terminalOutcome done must contain exactly kind and outcome");
    }
    const outcome = parseArtifactRef(terminal.outcome);
    if (!outcome.ok) return parseErr(`active_wave_gate.terminalOutcome.outcome: ${outcome.error.message}`);
    if (outcome.value.runId !== runId) return parseErr("active_wave_gate done outcome belongs to a different run");
    return parseOk(Object.freeze({ kind: "done", outcome: outcome.value }));
  }
  if (terminal.kind === "terminal-blocked") {
    const keys = Object.keys(terminal);
    if (keys.length !== 2 || !keys.includes("diagnostic")) {
      return parseErr("active_wave_gate.terminalOutcome terminal-blocked must contain exactly kind and diagnostic");
    }
    const diagnostic = parseBlockedDiagnostic(terminal.diagnostic);
    if (!diagnostic.ok) return parseErr(`active_wave_gate.terminalOutcome.diagnostic: ${diagnostic.error.message}`);
    if (diagnostic.value.kind !== "terminal-blocked") {
      return parseErr("active_wave_gate terminal-blocked outcome requires a terminal diagnostic");
    }
    if (diagnostic.value.runId !== runId) {
      return parseErr("active_wave_gate terminal diagnostic belongs to a different run");
    }
    return parseOk(Object.freeze({ kind: "terminal-blocked", diagnostic: diagnostic.value }));
  }
  if (terminal.kind === "terminal-abandoned") {
    const keys = Object.keys(terminal);
    if (keys.length !== 3 || !keys.includes("reason") || !keys.includes("supersededBy")) {
      return parseErr("active_wave_gate.terminalOutcome terminal-abandoned must contain exactly kind, reason, and supersededBy");
    }
    const reasonError = specTraceWaveGateRetirementReasonError(terminal.reason, "active_wave_gate.terminalOutcome");
    if (reasonError !== null) return parseErr(reasonError);
    const supersededBy = parseSpecTraceSupersededBy(terminal.supersededBy, runId, "active_wave_gate.terminalOutcome");
    if (!supersededBy.ok) {
      return parseErr(supersededBy.error);
    }
    return parseOk(Object.freeze({
      kind: "terminal-abandoned" as const,
      reason: terminal.reason as string,
      supersededBy: supersededBy.value,
    }));
  }
  return parseErr("active_wave_gate.terminalOutcome.kind must be done, terminal-blocked, or terminal-abandoned");
}

/** Parse and re-prove the protected active-run anchor from unknown JSON. */
export function parseActiveWaveGateRegistration(raw: unknown): ParseResult<ActiveWaveGateRegistration> {
  if (!isRecord(raw)) {
    return parseErr("active_wave_gate must be an object");
  }
  const record = raw as Record<string, unknown>;
  const fieldsError = exactFieldsError(record, ACTIVE_WAVE_GATE_FIELDS, ACTIVE_WAVE_GATE_OPTIONAL_FIELDS, "active_wave_gate");
  if (fieldsError !== null) return parseErr(fieldsError);
  if (record.schemaVersion !== 1) return parseErr("active_wave_gate.schemaVersion must be 1");
  if (record.kind !== "active-wave-gate") return parseErr("active_wave_gate.kind must be active-wave-gate");
  const runId = parseOrchestrationRunId(record.runId);
  if (!runId.ok) return parseErr(`active_wave_gate.runId: ${runId.error.message}`);
  const authorityDigest = parseArtifactDigest(record.authorityDigest);
  if (!authorityDigest.ok) return parseErr(`active_wave_gate.authorityDigest: ${authorityDigest.error.message}`);
  const wave = parseIntegerBound(
    record.wave,
    "active_wave_gate.wave",
    1,
    "an integer >= 1 within the safe-integer range",
  );
  if (!wave.ok) return parseErr(wave.error);
  const revision = parseIntegerBound(record.revision, "active_wave_gate.revision", 0, "a non-negative safe integer");
  if (!revision.ok) return parseErr(revision.error);
  if (record.runsRoot !== undefined &&
      (typeof record.runsRoot !== "string" || !isAbsolute(record.runsRoot) || resolve(record.runsRoot) !== record.runsRoot)) {
    return parseErr("active_wave_gate.runsRoot must be an absolute normalized path when present");
  }
  const terminalOutcome = parseActiveWaveGateTerminalOutcome(record.terminalOutcome, runId.value);
  if (!terminalOutcome.ok) return parseErr(terminalOutcome.error);

  return parseOk(Object.freeze({
    schemaVersion: 1,
    kind: "active-wave-gate",
    runId: runId.value,
    wave: wave.value,
    authorityDigest: authorityDigest.value,
    revision: revision.value,
    ...(record.runsRoot === undefined ? {} : { runsRoot: record.runsRoot as string }),
    terminalOutcome: terminalOutcome.value,
  }));
}

const COMPLETED_WAVE_GATE_FIELDS = [
  "schemaVersion", "kind", "runId", "wave", "authorityDigest", "revision", "completionReceipt", "completionSuite",
] as const;

type CompletedWaveGateCommon = Omit<CompletedWaveGateRegistration, "schemaVersion" | "completionSuite">;

function parseCompletedWaveGateReceipt(
  raw: unknown,
  runId: CompletedWaveGateRegistration["runId"],
  revision: number,
): ParseResult<CompletedWaveGateRegistration["completionReceipt"]> {
  if (!isRecord(raw)) {
    return parseErr("wave_gate_history.completionReceipt must be an object");
  }
  const receipt = raw as Record<string, unknown>;
  const receiptKeys = Object.keys(receipt).sort();
  const expectedReceiptKeys = ["committedRevision", "effectId", "kind", "runId", "stateDigest"].sort();
  if (receiptKeys.length !== expectedReceiptKeys.length || receiptKeys.some((key, index) => key !== expectedReceiptKeys[index])) {
    return parseErr("wave_gate_history.completionReceipt must contain exactly kind/effectId/runId/committedRevision/stateDigest");
  }
  if (receipt.kind !== "protected-wave-state-committed") {
    return parseErr("wave_gate_history.completionReceipt.kind must be protected-wave-state-committed");
  }
  const effectId = parseEffectId(receipt.effectId);
  const receiptRunId = parseOrchestrationRunId(receipt.runId);
  const stateDigest = parseArtifactDigest(receipt.stateDigest);
  if (!effectId.ok) return parseErr(`wave_gate_history.completionReceipt.effectId: ${effectId.error.message}`);
  if (!receiptRunId.ok) return parseErr(`wave_gate_history.completionReceipt.runId: ${receiptRunId.error.message}`);
  if (!stateDigest.ok) return parseErr(`wave_gate_history.completionReceipt.stateDigest: ${stateDigest.error.message}`);
  if (receiptRunId.value !== runId) return parseErr("wave_gate_history completion receipt belongs to a different run");
  if (receipt.committedRevision !== revision) return parseErr("wave_gate_history completion receipt revision must equal terminal revision");
  return parseOk(Object.freeze({
    kind: "protected-wave-state-committed",
    effectId: effectId.value,
    runId,
    committedRevision: revision,
    stateDigest: stateDigest.value,
  }));
}

function parseCompletedWaveGateCommon(record: Record<string, unknown>): ParseResult<CompletedWaveGateCommon> {
  if (record.kind !== "completed-wave-gate") {
    return parseErr(`wave_gate_history entry must be completed-wave-gate schemaVersion ${record.schemaVersion}`);
  }
  const runId = parseOrchestrationRunId(record.runId);
  const authorityDigest = parseArtifactDigest(record.authorityDigest);
  if (!runId.ok) return parseErr(`wave_gate_history.runId: ${runId.error.message}`);
  if (!authorityDigest.ok) return parseErr(`wave_gate_history.authorityDigest: ${authorityDigest.error.message}`);
  const wave = parseIntegerBound(
    record.wave,
    "wave_gate_history.wave",
    1,
    "an integer >= 1 within the safe-integer range",
  );
  if (!wave.ok) return parseErr(wave.error);
  const revision = parseIntegerBound(record.revision, "wave_gate_history.revision", 1, "a positive safe integer");
  if (!revision.ok) return parseErr(revision.error);
  const completionReceipt = parseCompletedWaveGateReceipt(record.completionReceipt, runId.value, revision.value);
  if (!completionReceipt.ok) return parseErr(completionReceipt.error);
  return parseOk(Object.freeze({
    kind: "completed-wave-gate" as const,
    runId: runId.value,
    wave: wave.value,
    authorityDigest: authorityDigest.value,
    revision: revision.value,
    completionReceipt: completionReceipt.value,
  }));
}

function parseCompletedWaveGateSuite(
  record: Record<string, unknown>,
  common: CompletedWaveGateCommon,
): ParseResult<AcceptedWaveCompletionReceipt> {
  const completionSuite = parseAcceptedWaveCompletionReceipt(record.completionSuite);
  if (!completionSuite.ok) {
    return parseErr(`wave_gate_history.completionSuite: ${completionSuite.error.errors.join("; ")}`);
  }
  const suite = completionSuite.value;
  if (suite.runId !== common.runId || suite.wave !== common.wave ||
      suite.authorityDigest !== common.authorityDigest) {
    return parseErr("wave_gate_history completionSuite must match terminal run/Wave/authority");
  }
  if (suite.revision + 1 !== common.revision) {
    return parseErr("wave_gate_history completionSuite revision must equal terminal revision minus 1");
  }
  if (suite.runId !== common.completionReceipt.runId ||
      suite.revision + 1 !== common.completionReceipt.committedRevision) {
    return parseErr("wave_gate_history completionSuite contradicts completionReceipt authority");
  }
  return parseOk(suite);
}

/** Parse immutable terminal history independently from active next-Wave authority.
 * Schema v2 is the one shape: every completed Wave archives the suite receipt
 * that authorized it (the suite-less v1 is refused at load, ADR-0098). */
export function parseCompletedWaveGateRegistration(raw: unknown): ParseResult<CompletedWaveGateRegistration> {
  if (!isRecord(raw)) {
    return parseErr("wave_gate_history entry must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 2) {
    return parseErr("wave_gate_history entry schemaVersion must be 2");
  }
  const fieldsError = exactFieldsError(record, COMPLETED_WAVE_GATE_FIELDS, [], "wave_gate_history entry");
  if (fieldsError !== null) return parseErr(fieldsError);
  const common = parseCompletedWaveGateCommon(record);
  if (!common.ok) return common;
  const completionSuite = parseCompletedWaveGateSuite(record, common.value);
  return completionSuite.ok
    ? parseOk(Object.freeze({ schemaVersion: 2, ...common.value, completionSuite: completionSuite.value }))
    : completionSuite;
}

const ORPHANED_WAVE_GATE_RETIREMENT_FIELDS = [
  "schemaVersion", "kind", "runId", "wave", "authorityDigest", "revision", "reason", "runsRoot", "runDirectory",
  "replacementRunId", "replacementAuthorityDigest",
] as const;

/** Parse one immutable nonterminal retirement audit entry. */
function parseOrphanedWaveGateRetirement(raw: unknown): ParseResult<OrphanedWaveGateRetirement> {
  if (!isRecord(raw)) {
    return parseErr("orphaned_wave_gate_history entry must be an object");
  }
  const record = raw as Record<string, unknown>;
  const fieldsError = exactFieldsError(record, ORPHANED_WAVE_GATE_RETIREMENT_FIELDS, [], "orphaned_wave_gate_history entry");
  if (fieldsError !== null) return parseErr(fieldsError);
  if (record.schemaVersion !== 1 || record.kind !== "orphaned-wave-gate-retirement" ||
      record.reason !== "authoritative-run-directory-missing") {
    return parseErr("orphaned_wave_gate_history entry has invalid schema, kind, or reason");
  }
  const runId = parseOrchestrationRunId(record.runId);
  const replacementRunId = parseOrchestrationRunId(record.replacementRunId);
  const authorityDigest = parseArtifactDigest(record.authorityDigest);
  const replacementAuthorityDigest = parseArtifactDigest(record.replacementAuthorityDigest);
  if (!runId.ok) return parseErr(`orphaned_wave_gate_history.runId: ${runId.error.message}`);
  if (!replacementRunId.ok) return parseErr(`orphaned_wave_gate_history.replacementRunId: ${replacementRunId.error.message}`);
  if (runId.value === replacementRunId.value) {
    return parseErr("orphaned_wave_gate_history replacement run must differ from retired run");
  }
  if (!authorityDigest.ok) return parseErr(`orphaned_wave_gate_history.authorityDigest: ${authorityDigest.error.message}`);
  if (!replacementAuthorityDigest.ok) {
    return parseErr(`orphaned_wave_gate_history.replacementAuthorityDigest: ${replacementAuthorityDigest.error.message}`);
  }
  const wave = parseIntegerBound(
    record.wave,
    "orphaned_wave_gate_history.wave",
    1,
    "an integer >= 1 within the safe-integer range",
  );
  if (!wave.ok) return parseErr(wave.error);
  const revision = parseIntegerBound(record.revision, "orphaned_wave_gate_history.revision", 0, "a non-negative safe integer");
  if (!revision.ok) return parseErr(revision.error);
  if (typeof record.runsRoot !== "string" || !isAbsolute(record.runsRoot) || resolve(record.runsRoot) !== record.runsRoot ||
      typeof record.runDirectory !== "string" || record.runDirectory !== join(record.runsRoot, runId.value)) {
    return parseErr("orphaned_wave_gate_history must carry the exact normalized authoritative runsRoot/runDirectory");
  }
  return parseOk(Object.freeze({
    schemaVersion: 1,
    kind: "orphaned-wave-gate-retirement",
    runId: runId.value,
    wave: wave.value,
    authorityDigest: authorityDigest.value,
    revision: revision.value,
    reason: "authoritative-run-directory-missing",
    runsRoot: record.runsRoot,
    runDirectory: record.runDirectory,
    replacementRunId: replacementRunId.value,
    replacementAuthorityDigest: replacementAuthorityDigest.value,
  }));
}

function parseOrphanedWaveGateHistory(raw: unknown): ParseResult<readonly OrphanedWaveGateRetirement[] | undefined> {
  return parseOptionalLog(
    raw,
    "orphaned_wave_gate_history",
    (entry, label) => labelled(label, parseOrphanedWaveGateRetirement(entry)),
    (history) => repeatedIdentity(history.map(({ runId }) => runId), "orphaned_wave_gate_history contains duplicate retired run identities"),
  );
}

const RETIRED_WAVE_REVIEW_RUN_FIELDS = ["schemaVersion", "kind", "runId", "wave", "authorityDigest", "retirement"] as const;

/** Parse one Successor Carry provenance record (ADR-0091). */
function parseRetiredWaveReviewRun(raw: unknown, label: string): ParseResult<RetiredWaveReviewRun> {
  if (!isRecord(raw)) return parseErr(`${label} must be an object`);
  const record = raw as Record<string, unknown>;
  const fieldsError = exactFieldsError(record, RETIRED_WAVE_REVIEW_RUN_FIELDS, [], label);
  if (fieldsError !== null) return parseErr(fieldsError);
  const retirement = record.retirement;
  if (record.schemaVersion !== 1 || record.kind !== "retired-wave-review-run" || !isWaveReviewRunRetirement(retirement)) {
    return parseErr(`${label} has an invalid schema, kind, or retirement`);
  }
  const runId = parseOrchestrationRunId(record.runId);
  if (!runId.ok) return parseErr(`${label}.runId: ${runId.error.message}`);
  const authorityDigest = parseArtifactDigest(record.authorityDigest);
  if (!authorityDigest.ok) return parseErr(`${label}.authorityDigest: ${authorityDigest.error.message}`);
  const wave = parseIntegerBound(record.wave, `${label}.wave`, 1, "an integer >= 1 within the safe-integer range");
  if (!wave.ok) return parseErr(wave.error);
  return parseOk(Object.freeze({
    schemaVersion: 1,
    kind: "retired-wave-review-run",
    runId: runId.value,
    wave: wave.value,
    authorityDigest: authorityDigest.value,
    retirement,
  }));
}

/** Parse the append-only Successor Carry provenance; a run is retired once. */
function parseRetiredWaveReviewRuns(raw: unknown): ParseResult<readonly RetiredWaveReviewRun[] | undefined> {
  return parseOptionalLog(raw, "retired_wave_review_runs", parseRetiredWaveReviewRun, (runs) => {
    const repeated = repeatedRetiredRun(runs);
    return repeated === null ? null : `retired_wave_review_runs retires run ${repeated.runId} twice`;
  });
}

const SPEC_TRACE_WAVE_GATE_RETIREMENT_FIELDS = [
  "schemaVersion", "kind", "runId", "wave", "authorityDigest", "revision", "runsRoot",
  "reason", "supersededBy",
] as const;

function specTraceWaveGateRetirementReasonError(raw: unknown, label: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512 || raw.trim() !== raw) {
    return `${label}.reason must be exact non-blank trimmed text of at most 512 characters`;
  }
  return null;
}

function parseSpecTraceSupersededBy(
  raw: unknown,
  runId: ActiveWaveGateRegistration["runId"],
  label: string,
): ParseResult<ActiveWaveGateRegistration["runId"] | null> {
  if (raw === null) return parseOk(null);
  const parsedSupersededBy = parseOrchestrationRunId(raw);
  if (!parsedSupersededBy.ok) {
    return parseErr(`${label}.supersededBy: ${parsedSupersededBy.error.message}`);
  }
  if (parsedSupersededBy.value === runId) {
    return parseErr(`${label} run cannot supersede itself`);
  }
  return parseOk(parsedSupersededBy.value);
}

/** Parse one immutable audit of an abandoned Wave Gate retired for trace v2. */
function parseSpecTraceWaveGateRetirement(raw: unknown): ParseResult<SpecTraceWaveGateRetirement> {
  if (!isRecord(raw)) {
    return parseErr("spec_trace_wave_gate_retirements entry must be an object");
  }
  const record = raw as Record<string, unknown>;
  const fieldsError = exactFieldsError(
    record,
    SPEC_TRACE_WAVE_GATE_RETIREMENT_FIELDS,
    [],
    "spec_trace_wave_gate_retirements entry",
  );
  if (fieldsError !== null) return parseErr(fieldsError);
  if (record.schemaVersion !== 1 || record.kind !== "spec-trace-wave-gate-retirement") {
    return parseErr("spec_trace_wave_gate_retirements entry has invalid schema or kind");
  }
  const runId = parseOrchestrationRunId(record.runId);
  const authorityDigest = parseArtifactDigest(record.authorityDigest);
  if (!runId.ok) return parseErr(`spec_trace_wave_gate_retirements.runId: ${runId.error.message}`);
  if (!authorityDigest.ok) {
    return parseErr(`spec_trace_wave_gate_retirements.authorityDigest: ${authorityDigest.error.message}`);
  }
  const wave = parseIntegerBound(
    record.wave,
    "spec_trace_wave_gate_retirements.wave",
    1,
    "an integer >= 1 within the safe-integer range",
  );
  if (!wave.ok) return parseErr(wave.error);
  const revision = parseIntegerBound(record.revision, "spec_trace_wave_gate_retirements.revision", 0, "a non-negative safe integer");
  if (!revision.ok) return parseErr(revision.error);
  if (typeof record.runsRoot !== "string" || !isAbsolute(record.runsRoot) || resolve(record.runsRoot) !== record.runsRoot) {
    return parseErr("spec_trace_wave_gate_retirements.runsRoot must be an absolute normalized path");
  }
  const reasonError = specTraceWaveGateRetirementReasonError(record.reason, "spec_trace_wave_gate_retirements");
  if (reasonError !== null) return parseErr(reasonError);
  const reason = record.reason as string;
  const supersededBy = parseSpecTraceSupersededBy(record.supersededBy, runId.value, "spec_trace_wave_gate_retirements");
  if (!supersededBy.ok) return parseErr(supersededBy.error);
  return parseOk(Object.freeze({
    schemaVersion: 1,
    kind: "spec-trace-wave-gate-retirement",
    runId: runId.value,
    wave: wave.value,
    authorityDigest: authorityDigest.value,
    revision: revision.value,
    runsRoot: record.runsRoot,
    reason,
    supersededBy: supersededBy.value,
  }));
}

function parseSpecTraceWaveGateRetirements(
  raw: unknown,
): ParseResult<readonly SpecTraceWaveGateRetirement[] | undefined> {
  return parseOptionalLog(
    raw,
    "spec_trace_wave_gate_retirements",
    (entry, label) => labelled(label, parseSpecTraceWaveGateRetirement(entry)),
    (retirements) =>
      repeatedIdentity(
        retirements.map(({ runId }) => runId),
        "spec_trace_wave_gate_retirements contains duplicate retired run identities",
      ) ?? repeatedIdentity(
        retirements.map((entry) => `${entry.wave}:${entry.authorityDigest}:${entry.revision}:${entry.runsRoot}`),
        "spec_trace_wave_gate_retirements contains colliding protected authority identities",
      ),
  );
}

const SPEC_TRACE_AMENDMENT_FIELDS = [
  "schemaVersion", "kind", "wave", "retiredRunId", "changes", "specIndexObservation",
] as const;

function parseOwnershipRecord(raw: unknown, label: string): ParseResult<SpecTraceOwnership> {
  if (!isRecord(raw)) return parseErr(`${label} must be an object`);
  const record = raw as Record<string, unknown>;
  const fieldsError = exactFieldsError(record, ["spec_anchors", "spec_contributions"], [], label);
  if (fieldsError !== null) return parseErr(fieldsError);
  const trace = parseTraceOwnership(record.spec_anchors, record.spec_contributions);
  return trace === null
    ? parseErr(`${label} spec_anchors and spec_contributions must be string arrays`)
    : parseOk(trace);
}

function parseSpecTraceAmendmentChange(raw: unknown, label: string): ParseResult<SpecTraceAmendmentChange> {
  if (!isRecord(raw)) return parseErr(`${label} must be an object`);
  const record = raw as Record<string, unknown>;
  const fieldsError = exactFieldsError(record, ["taskId", "before", "after"], [], label);
  if (fieldsError !== null) return parseErr(fieldsError);
  const idError = taskIdError(record.taskId, label);
  if (idError !== null) return parseErr(idError);
  const before = parseOwnershipRecord(record.before, `${label}.before`);
  if (!before.ok) return before;
  const after = parseOwnershipRecord(record.after, `${label}.after`);
  if (!after.ok) return after;
  return parseOk(Object.freeze({ taskId: record.taskId as string, before: before.value, after: after.value }));
}

/** Parse one immutable audit of an in-place v2 Requirement trace amendment. */
function parseSpecTraceAmendment(raw: unknown): ParseResult<SpecTraceAmendment> {
  if (!isRecord(raw)) return parseErr("spec_trace_amendments entry must be an object");
  const record = raw as Record<string, unknown>;
  const fieldsError = exactFieldsError(record, SPEC_TRACE_AMENDMENT_FIELDS, [], "spec_trace_amendments entry");
  if (fieldsError !== null) return parseErr(fieldsError);
  if (record.schemaVersion !== 1 || record.kind !== "spec-trace-amendment") {
    return parseErr("spec_trace_amendments entry has invalid schema or kind");
  }
  const wave = parseIntegerBound(
    record.wave,
    "spec_trace_amendments.wave",
    1,
    "an integer >= 1 within the safe-integer range",
  );
  if (!wave.ok) return parseErr(wave.error);
  const retiredRunId = record.retiredRunId === null ? null : parseOrchestrationRunId(record.retiredRunId);
  if (retiredRunId !== null && !retiredRunId.ok) {
    return parseErr(`spec_trace_amendments.retiredRunId: ${retiredRunId.error.message}`);
  }
  if (!Array.isArray(record.changes) || record.changes.length === 0) {
    return parseErr("spec_trace_amendments.changes must be a non-empty array");
  }
  const changes: SpecTraceAmendmentChange[] = [];
  for (const [index, rawChange] of record.changes.entries()) {
    const change = parseSpecTraceAmendmentChange(rawChange, `spec_trace_amendments.changes[${index}]`);
    if (!change.ok) return change;
    changes.push(change.value);
  }
  if (new Set(changes.map(({ taskId }) => taskId)).size !== changes.length) {
    return parseErr("spec_trace_amendments.changes names a Task more than once");
  }
  const observation = parseSpecIndexObservation(record.specIndexObservation);
  if (!observation.ok) return parseErr(`spec_trace_amendments.specIndexObservation: ${observation.error}`);
  const [first, ...rest] = changes;
  return parseOk(Object.freeze({
    schemaVersion: 1,
    kind: "spec-trace-amendment",
    wave: wave.value,
    retiredRunId: retiredRunId === null ? null : retiredRunId.value,
    changes: Object.freeze([first, ...rest]) as SpecTraceAmendment["changes"],
    specIndexObservation: observation.value,
  }));
}

const SPEC_AMENDMENT_FIELDS = [
  "schemaVersion", "kind", "wave", "reason", "before", "after", "rewritten", "added", "withdrawn", "rejudge", "retiredRunId",
] as const;

/** Distinct strings under `label`, or why not. */
function parseDistinctStrings(raw: unknown, label: string): ParseResult<readonly string[]> {
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === "string" && entry !== "")) {
    return parseErr(`${label} must be an array of non-empty strings`);
  }
  return new Set(raw).size === raw.length ? parseOk(Object.freeze([...raw] as string[])) : parseErr(`${label} repeats an id`);
}

/** The completed claims an amendment changed: exact `{taskId, claim}` pairs, each once, naming a Task and a changed id. */
function parseRejudgements(
  raw: unknown,
  label: string,
  taskIds: ReadonlySet<unknown>,
  changed: ReadonlySet<string>,
): ParseResult<readonly SpecAmendmentRejudgement[]> {
  if (!Array.isArray(raw)) return parseErr(`${label} must be an array`);
  const rejudge: SpecAmendmentRejudgement[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const at = `${label}[${index}]`;
    if (!isRecord(entry) || exactFieldsError(entry as Record<string, unknown>, ["taskId", "claim"], [], at) !== null) {
      return parseErr(`${at} must be exactly {taskId, claim}`);
    }
    const { taskId, claim } = entry as Record<string, unknown>;
    if (typeof taskId !== "string" || !taskIds.has(taskId)) return parseErr(`${at}.taskId names no Task of this TaskGraph`);
    if (typeof claim !== "string" || !changed.has(claim)) return parseErr(`${at}.claim must be an id the amendment rewrote or withdrew`);
    const key = `${taskId}\u0000${claim}`;
    if (seen.has(key)) return parseErr(`${at} repeats ${taskId}:${claim}`);
    seen.add(key);
    rejudge.push(Object.freeze({ taskId, claim }));
  }
  return parseOk(Object.freeze(rejudge));
}

/** A parsed Spec Index observation `raw`, which must be the indexed arm. */
function parseIndexedObservation(raw: unknown, label: string): ParseResult<IndexedSpecIndexObservation> {
  const parsed = parseSpecIndexObservation(raw);
  if (!parsed.ok) return parseErr(`${label}: ${parsed.error}`);
  return parsed.value.kind === "indexed" ? parseOk(parsed.value) : parseErr(`${label} must be an indexed observation`);
}

/** One immutable Spec Amendment audit (ADR-0087), bound to the roster: every re-judgement names a Task. */
function parseSpecAmendment(raw: unknown, label: string, tasks: readonly ParsedTask[]): ParseResult<SpecAmendment> {
  if (!isRecord(raw)) return parseErr(`${label} must be an object`);
  const record = raw as Record<string, unknown>;
  const fieldsError = exactFieldsError(record, SPEC_AMENDMENT_FIELDS, [], label);
  if (fieldsError !== null) return parseErr(fieldsError);
  if (record.schemaVersion !== 1 || record.kind !== "spec-amended") return parseErr(`${label} has invalid schema or kind`);
  const wave = parseIntegerBound(record.wave, `${label}.wave`, 1, "an integer >= 1 within the safe-integer range");
  if (!wave.ok) return parseErr(wave.error);
  const reason = parsePlanEditReason(record.reason);
  if (!reason.ok) return parseErr(`${label}.reason ${reason.error}`);
  const before = parseIndexedObservation(record.before, `${label}.before`);
  if (!before.ok) return before;
  const after = parseIndexedObservation(record.after, `${label}.after`);
  if (!after.ok) return after;
  const rewritten = parseDistinctStrings(record.rewritten, `${label}.rewritten`);
  if (!rewritten.ok) return rewritten;
  const added = parseDistinctStrings(record.added, `${label}.added`);
  if (!added.ok) return added;
  const withdrawn = parseDistinctStrings(record.withdrawn, `${label}.withdrawn`);
  if (!withdrawn.ok) return withdrawn;
  const all = [...rewritten.value, ...added.value, ...withdrawn.value];
  if (new Set(all).size !== all.length) return parseErr(`${label} lists one id as more than one of rewritten, added and withdrawn`);
  const rejudge = parseRejudgements(
    record.rejudge, `${label}.rejudge`, new Set(tasks.map((task) => task.id)), new Set([...rewritten.value, ...withdrawn.value]),
  );
  if (!rejudge.ok) return rejudge;
  const retiredRunId = parseNullableRunId(record.retiredRunId, `${label}.retiredRunId`);
  if (!retiredRunId.ok) return retiredRunId;
  return parseOk(Object.freeze({
    schemaVersion: 1,
    kind: "spec-amended",
    wave: wave.value,
    reason: reason.value,
    before: before.value,
    after: after.value,
    rewritten: rewritten.value,
    added: added.value,
    withdrawn: withdrawn.value,
    rejudge: rejudge.value,
    retiredRunId: retiredRunId.value,
  }));
}

function parseSpecAmendments(raw: unknown, tasks: readonly ParsedTask[]): ParseResult<readonly SpecAmendment[] | undefined> {
  return parseOptionalLog(raw, "spec_amendments", (entry, label) => parseSpecAmendment(entry, label, tasks));
}

function parseSpecTraceAmendments(raw: unknown): ParseResult<readonly SpecTraceAmendment[] | undefined> {
  return parseOptionalLog(raw, "spec_trace_amendments", (entry, label) => labelled(label, parseSpecTraceAmendment(entry)));
}

const TASK_REOPENING_AUDIT_FIELDS = [
  "schemaVersion", "kind", "wave", "reopenedTaskIds", "reason", "abandonedRunId",
] as const;

/** The one field a reopening audit gained with the Distill Task (ADR-0068);
 *  audits written before it carry none. */
const SWEPT_DISTILL_TASK_IDS_FIELD = "sweptDistillTaskIds";

/** A non-empty list of distinct Task ids under `label`, or why it is not one. */
function parseDistinctTaskIds(raw: unknown, label: string): ParseResult<NonEmpty<TaskId>> {
  const ids: readonly unknown[] = Array.isArray(raw) ? raw : [];
  const parsed: TaskId[] = [];
  for (const id of ids) {
    const taskId = parseTaskIdAt(id, label);
    if (!taskId.ok) return taskId;
    parsed.push(taskId.value);
  }
  const taskIds = nonEmpty(parsed);
  if (taskIds === null) return parseErr(`${label} must be a non-empty array`);
  return new Set(taskIds).size === taskIds.length
    ? parseOk(taskIds)
    : parseErr(`${label} names a Task more than once`);
}

/** Why `reopenedTaskIds` refused an audit's ids, in the State File's words. */
function reopenedTaskIdsRefusalMessage(refusal: ReopenedTaskIdsRefusal, label: string): string {
  const path = `${label}.${SWEPT_DISTILL_TASK_IDS_FIELD}`;
  switch (refusal.kind) {
    case "swept-not-reopened":
      return `${path}: ${refusal.taskId} is not among ${label}.reopenedTaskIds`;
    case "swept-every-reopened":
      return `${path} names every reopened Task; a Distill Task is swept only with another Task of its Wave`;
    default: {
      const unhandled: never = refusal;
      return unhandled;
    }
  }
}

/**
 * The ids of one reopening audit under `label`: its parsed `reopened` ids and
 * the Distill Tasks its raw `sweptDistillTaskIds` field says were swept back
 * with them. The field may be absent; present, it is a non-empty list of
 * distinct Task ids, and `reopenedTaskIds` holds it to the rule both audits
 * share (drawn from `reopened`, never all of it). `distillTaskIds` are the
 * roster's Distill Tasks when the audit's Tasks are still on the roster, so a
 * swept id naming any other Task is refused; null skips that check. A swept id
 * outside `reopened` is reported first, then one that is no Distill Task, then
 * a sweep of every reopened Task.
 */
function parseReopenedTaskIds(
  rawSwept: unknown,
  label: string,
  reopened: NonEmpty<TaskId>,
  distillTaskIds: ReadonlySet<string> | null,
): ParseResult<ReopenedTaskIds> {
  const path = `${label}.${SWEPT_DISTILL_TASK_IDS_FIELD}`;
  let swept: readonly TaskId[] = [];
  if (rawSwept !== undefined) {
    if (!Array.isArray(rawSwept) || rawSwept.length === 0) return parseErr(`${path} must be a non-empty array when present`);
    const parsed = parseDistinctTaskIds(rawSwept, path);
    if (!parsed.ok) return parsed;
    swept = parsed.value;
  }
  const ids = reopenedTaskIds(reopened, swept);
  if (!ids.ok && ids.error.kind === "swept-not-reopened") return parseErr(reopenedTaskIdsRefusalMessage(ids.error, label));
  const notDistill = distillTaskIds === null ? undefined : swept.find((id) => !distillTaskIds.has(id));
  if (notDistill !== undefined) return parseErr(`${path}: ${notDistill} is not a Distill Task`);
  return ids.ok ? parseOk(ids.value) : parseErr(reopenedTaskIdsRefusalMessage(ids.error, label));
}

/** Parse one immutable audit of implemented active-Wave Tasks reopened for
 *  re-implementation. Every reopened id must name a Task of the audited Wave. */
function parseTaskReopeningAudit(
  raw: unknown,
  label: string,
  tasks: readonly ParsedTask[],
): ParseResult<TaskReopeningAudit> {
  if (!isRecord(raw)) return parseErr(`${label} must be an object`);
  const record = raw as Record<string, unknown>;
  const fieldsError = exactFieldsError(record, TASK_REOPENING_AUDIT_FIELDS, [SWEPT_DISTILL_TASK_IDS_FIELD, "needs"], label);
  if (fieldsError !== null) return parseErr(fieldsError);
  if (record.schemaVersion !== 1 || record.kind !== "implemented-tasks-reopened") {
    return parseErr(`${label} has invalid schema or kind`);
  }
  const wave = parseIntegerBound(record.wave, `${label}.wave`, 1, "an integer >= 1 within the safe-integer range");
  if (!wave.ok) return parseErr(wave.error);
  const reopened = parseDistinctTaskIds(record.reopenedTaskIds, `${label}.reopenedTaskIds`);
  if (!reopened.ok) return reopened;
  const foreign = reopened.value.find((id) => !tasks.some((task) => task.id === id && task.wave === wave.value));
  if (foreign !== undefined) return parseErr(`${label}.reopenedTaskIds: ${foreign} is not a Task of Wave ${wave.value}`);
  const distillTaskIds = new Set(tasks.filter(isDistillTask).flatMap(({ id }) => typeof id === "string" ? [id] : []));
  const reopenedIds = parseReopenedTaskIds(record[SWEPT_DISTILL_TASK_IDS_FIELD], label, reopened.value, distillTaskIds);
  if (!reopenedIds.ok) return reopenedIds;
  const reason = parseBoundedReason(record.reason, label);
  if (!reason.ok) return reason;
  const abandonedRunId = record.abandonedRunId === null ? null : parseOrchestrationRunId(record.abandonedRunId);
  if (abandonedRunId !== null && !abandonedRunId.ok) {
    return parseErr(`${label}.abandonedRunId: ${abandonedRunId.error.message}`);
  }
  // Only a tests-only reopening records what it needed (ADR-0093): an absent
  // field is the default full re-implementation, never spelled out.
  if (record.needs !== undefined && record.needs !== "tests") return parseErr(`${label}.needs must be "tests" when present`);
  return parseOk(Object.freeze({
    schemaVersion: 1,
    kind: "implemented-tasks-reopened",
    wave: wave.value,
    ...reopenedIds.value,
    reason: reason.value,
    abandonedRunId: abandonedRunId === null ? null : abandonedRunId.value,
    ...(record.needs === "tests" ? { needs: "tests" as const } : {}),
  }));
}

/** An abandoned run's authority is retired by the one reopening that names it,
 *  so no two audits may name the same run. */
function parseTaskReopeningHistory(
  raw: unknown,
  tasks: readonly ParsedTask[],
): ParseResult<readonly TaskReopeningAudit[] | undefined> {
  return parseOptionalLog(
    raw,
    "task_reopening_history",
    (entry, label) => parseTaskReopeningAudit(entry, label, tasks),
    (audits) => repeatedIdentity(
      audits.flatMap(({ abandonedRunId }) => abandonedRunId === null ? [] : [abandonedRunId]),
      "task_reopening_history names one abandoned Wave Gate run in two audits",
    ),
  );
}

const TASK_RESCOPED_EDIT_FIELDS = [
  "schemaVersion", "kind", "wave", "taskId", "added", "removed", "baselineRevision", "reason",
] as const;

const isStringArray = (raw: unknown): raw is readonly string[] => Array.isArray(raw) && raw.every((entry) => typeof entry === "string");

/**
 * What a plan edit may name: the roster, and the Tasks `withdraw-task` removed
 * from it (ADR-0086), whose earlier edits stay in the history.
 */
type PlanEditRoster = Readonly<{ tasks: readonly ParsedTask[]; withdrawn: ReadonlySet<string> }>;

/** Whether `id` names a Task of the roster or a withdrawn one. */
const knownToPlanEdits = (roster: PlanEditRoster, id: unknown): boolean =>
  typeof id === "string" && (roster.withdrawn.has(id) || roster.tasks.some((task) => task.id === id));

/**
 * The fields every plan edit shares: exactly `fields` (plus any of
 * `optional`), schema 1, a Wave of at least 1, and a Task id naming a Task of
 * that Wave, or a withdrawn Task (`wavePlanHistoryError` places it).
 */
function parsePlanEditHeader(
  record: Record<string, unknown>,
  fields: readonly string[],
  optional: readonly string[],
  label: string,
  roster: PlanEditRoster,
): ParseResult<Readonly<{ wave: number; taskId: string }>> {
  const fieldsError = exactFieldsError(record, fields, optional, label);
  if (fieldsError !== null) return parseErr(fieldsError);
  if (record.schemaVersion !== 1) return parseErr(`${label} has invalid schema or kind`);
  const wave = parseIntegerBound(record.wave, `${label}.wave`, 1, "an integer >= 1 within the safe-integer range");
  if (!wave.ok) return parseErr(wave.error);
  const idError = taskIdError(record.taskId, `${label}.taskId`);
  if (idError !== null) return parseErr(idError);
  const taskId = record.taskId as string;
  if (!roster.withdrawn.has(taskId) && !roster.tasks.some((task) => task.id === taskId && task.wave === wave.value)) {
    return parseErr(`${label}.taskId: ${taskId} is not a Task of Wave ${wave.value}`);
  }
  return parseOk(Object.freeze({ wave: wave.value, taskId }));
}

/** A `task-rescoped` edit of a Task in the named Wave, built by the one constructor (`core/wave-plan-edit.ts`). */
function parseTaskRescopedEdit(
  record: Record<string, unknown>,
  label: string,
  roster: PlanEditRoster,
): ParseResult<WavePlanEdit> {
  const header = parsePlanEditHeader(record, TASK_RESCOPED_EDIT_FIELDS, ["sealed"], label, roster);
  if (!header.ok) return header;
  const { wave, taskId } = header.value;
  if (!isStringArray(record.added) || !isStringArray(record.removed)) return parseErr(`${label}.added and .removed must be arrays of paths`);
  const revision = record.baselineRevision;
  if (revision !== null && typeof revision !== "string") return parseErr(`${label}.baselineRevision must be an exact Git commit id or null`);
  const sealed = record.sealed ?? [];
  if (!isStringArray(sealed)) return parseErr(`${label}.sealed must be an array of paths when present`);
  if (record.sealed !== undefined && sealed.length === 0) return parseErr(`${label}.sealed is omitted, not empty, when nothing sealed was added`);
  const reason = parsePlanEditReason(record.reason);
  if (!reason.ok) return parseErr(`${label}.reason ${reason.error}`);
  const edit = taskRescopedEdit({
    wave, taskId, added: record.added, removed: record.removed, baselineRevision: revision, sealed, reason: reason.value,
  });
  return edit.ok ? parseOk(edit.value) : parseErr(`${label} ${edit.error}`);
}

const DEPENDENCY_ADDED_EDIT_FIELDS = ["schemaVersion", "kind", "wave", "taskId", "dependsOn", "reason"] as const;

/** A `dependency-added` edit of a Task in the named Wave, built by the one constructor (`core/wave-plan-edit.ts`). */
function parseDependencyAddedEdit(
  record: Record<string, unknown>,
  label: string,
  roster: PlanEditRoster,
): ParseResult<WavePlanEdit> {
  const header = parsePlanEditHeader(record, DEPENDENCY_ADDED_EDIT_FIELDS, [], label, roster);
  if (!header.ok) return header;
  const { wave, taskId } = header.value;
  if (!isStringArray(record.dependsOn)) return parseErr(`${label}.dependsOn must be an array of Task ids`);
  const unknown = record.dependsOn.find((id) => !knownToPlanEdits(roster, id));
  if (unknown !== undefined) return parseErr(`${label}.dependsOn: ${unknown} is not a Task of this TaskGraph`);
  const reason = parsePlanEditReason(record.reason);
  if (!reason.ok) return parseErr(`${label}.reason ${reason.error}`);
  const edit = dependencyAddedEdit({ wave, taskId, dependsOn: record.dependsOn, reason: reason.value });
  return edit.ok ? parseOk(edit.value) : parseErr(`${label} ${edit.error}`);
}

const TASK_ADDED_EDIT_FIELDS = [
  "schemaVersion", "kind", "wave", "taskId", "files", "dependsOn", "dependents", "reason", "abandonedRunId",
] as const;

/** A `task-added` edit (ADR-0086), built by the one constructor (`core/wave-plan-edit.ts`); its edges name known Tasks. */
function parseTaskAddedEdit(record: Record<string, unknown>, label: string, roster: PlanEditRoster): ParseResult<WavePlanEdit> {
  const header = parsePlanEditHeader(record, TASK_ADDED_EDIT_FIELDS, ["sealed"], label, roster);
  if (!header.ok) return header;
  const { wave, taskId } = header.value;
  if (!isStringArray(record.files)) return parseErr(`${label}.files must be an array of paths`);
  const sealed = record.sealed ?? [];
  if (!isStringArray(sealed)) return parseErr(`${label}.sealed must be an array of paths when present`);
  if (record.sealed !== undefined && sealed.length === 0) return parseErr(`${label}.sealed is omitted, not empty, when nothing sealed was added`);
  if (!isStringArray(record.dependsOn) || !isStringArray(record.dependents)) {
    return parseErr(`${label}.dependsOn and .dependents must be arrays of Task ids`);
  }
  const unknown = [...record.dependsOn, ...record.dependents].find((id) => !knownToPlanEdits(roster, id));
  if (unknown !== undefined) return parseErr(`${label} names ${unknown}, which is not a Task of this TaskGraph`);
  const reason = parsePlanEditReason(record.reason);
  if (!reason.ok) return parseErr(`${label}.reason ${reason.error}`);
  const abandoned = parseNullableRunId(record.abandonedRunId, `${label}.abandonedRunId`);
  if (!abandoned.ok) return abandoned;
  const edit = taskAddedEdit({
    wave, taskId, files: record.files, sealed, dependsOn: record.dependsOn, dependents: record.dependents,
    reason: reason.value, abandonedRunId: abandoned.value,
  });
  return edit.ok ? parseOk(edit.value) : parseErr(`${label} ${edit.error}`);
}

const TASK_WITHDRAWN_EDIT_FIELDS = ["schemaVersion", "kind", "wave", "taskId", "reason", "abandonedRunId"] as const;

/** A `task-withdrawn` edit (ADR-0086), built by the one constructor (`core/wave-plan-edit.ts`). */
function parseTaskWithdrawnEdit(record: Record<string, unknown>, label: string, roster: PlanEditRoster): ParseResult<WavePlanEdit> {
  const header = parsePlanEditHeader(record, TASK_WITHDRAWN_EDIT_FIELDS, [], label, roster);
  if (!header.ok) return header;
  const { wave, taskId } = header.value;
  const reason = parsePlanEditReason(record.reason);
  if (!reason.ok) return parseErr(`${label}.reason ${reason.error}`);
  const abandoned = parseNullableRunId(record.abandonedRunId, `${label}.abandonedRunId`);
  if (!abandoned.ok) return abandoned;
  const edit = taskWithdrawnEdit({ wave, taskId, reason: reason.value, abandonedRunId: abandoned.value });
  return edit.ok ? parseOk(edit.value) : parseErr(`${label} ${edit.error}`);
}

type PlanEditParser = (record: Record<string, unknown>, label: string, roster: PlanEditRoster) => ParseResult<WavePlanEdit>;

/** One parser per edit kind (loom#199); keyed by the union's kinds, so a new kind without a parser does not compile. */
const PLAN_EDIT_PARSERS: Readonly<Record<WavePlanEdit["kind"], PlanEditParser>> = Object.freeze({
  "task-rescoped": parseTaskRescopedEdit,
  "dependency-added": parseDependencyAddedEdit,
  "task-added": parseTaskAddedEdit,
  "task-withdrawn": parseTaskWithdrawnEdit,
});

const isPlanEditKind = (kind: unknown): kind is WavePlanEdit["kind"] => typeof kind === "string" && Object.hasOwn(PLAN_EDIT_PARSERS, kind);

/** One audited plan edit, parsed by its kind's parser; `kind` is wire data, so any other value is refused. */
function parseWavePlanEdit(raw: unknown, label: string, roster: PlanEditRoster): ParseResult<WavePlanEdit> {
  if (!isRecord(raw)) return parseErr(`${label} must be an object`);
  const record = raw as Record<string, unknown>;
  return isPlanEditKind(record.kind) ? PLAN_EDIT_PARSERS[record.kind](record, label, roster) : parseErr(`${label} has invalid schema or kind`);
}

/** The Task ids `raw`'s `task-withdrawn` edits name; each is proven by `wavePlanHistoryError`. */
function withdrawnTaskIdsOf(raw: readonly unknown[]): ReadonlySet<string> {
  return new Set(raw.flatMap((entry) =>
    isRecord(entry) && entry.kind === "task-withdrawn" && typeof entry.taskId === "string" ? [entry.taskId] : []));
}

/**
 * Why the added and withdrawn Tasks contradict each other or the roster, or
 * null. A Task is added at most once and withdrawn at most once, only after
 * it was added and in the same Wave; a withdrawn Task has left the roster.
 */
function wavePlanHistoryError(edits: readonly WavePlanEdit[], tasks: readonly ParsedTask[]): string | null {
  const added = new Map<string, number>();
  const withdrawn = new Set<string>();
  for (const [index, edit] of edits.entries()) {
    const label = `wave_plan_edits[${index}]`;
    if (edit.kind === "task-added") {
      if (added.has(edit.taskId)) return `${label} adds ${edit.taskId} a second time`;
      added.set(edit.taskId, edit.wave);
    } else if (edit.kind === "task-withdrawn") {
      if (added.get(edit.taskId) !== edit.wave) return `${label} withdraws ${edit.taskId}, which no earlier edit added to Wave ${edit.wave}`;
      if (withdrawn.has(edit.taskId)) return `${label} withdraws ${edit.taskId} a second time`;
      if (tasks.some((task) => task.id === edit.taskId)) return `${label} withdraws ${edit.taskId}, which is still on the roster`;
      withdrawn.add(edit.taskId);
    }
  }
  return null;
}

function parseWavePlanEdits(
  raw: unknown,
  tasks: readonly ParsedTask[],
): ParseResult<readonly WavePlanEdit[] | undefined> {
  const roster: PlanEditRoster = { tasks, withdrawn: withdrawnTaskIdsOf(Array.isArray(raw) ? raw : []) };
  return parseOptionalLog(
    raw,
    "wave_plan_edits",
    (entry, label) => parseWavePlanEdit(entry, label, roster),
    (edits) => wavePlanHistoryError(edits, tasks),
  );
}

/** A retro scope's exact wire shape: `{kind:"run"}` or `{kind:"wave",wave}`, else null. */
function parseRetroScope(scope: Record<string, unknown>): RetroScope | null {
  const keys = Object.keys(scope).length;
  if (scope.kind === "run" && keys === 1) return { kind: "run" };
  if (scope.kind === "wave" && typeof scope.wave === "number" && keys === 2) return { kind: "wave", wave: scope.wave };
  return null;
}

/** `retro_records`, each built by the one constructor (`core/retro-record.ts`). */
function parseRetroRecords(raw: unknown, tasks: readonly ParsedTask[]): ParseResult<readonly RetroRecord[] | undefined> {
  const waves = tasks.map(({ wave }) => wave);
  return parseOptionalLog(raw, "retro_records", (entry, label) => parseRetroRecord(entry, label, waves));
}

/** One retro record: a skip of the whole run, or a recorded retro of a run or of a Wave the TaskGraph holds. */
function parseRetroRecord(raw: unknown, label: string, waves: readonly number[]): ParseResult<RetroRecord> {
  if (!isRecord(raw)) return parseErr(`${label} must be an object`);
  if (raw.schemaVersion !== 1) return parseErr(`${label} has invalid schema or kind`);
  const scope = raw.scope;
  if (!isRecord(scope)) return parseErr(`${label}.scope must be an object`);
  if (raw.kind === "retro-skipped") {
    const fieldsError = exactFieldsError(raw, ["schemaVersion", "kind", "scope", "reason"], [], label);
    if (fieldsError !== null) return parseErr(fieldsError);
    if (scope.kind !== "run" || Object.keys(scope).length !== 1) return parseErr(`${label}: a skip covers the whole run`);
    if (typeof raw.reason !== "string") return parseErr(`${label}.reason must be a string`);
    const built = retroRecordEntry({ kind: "retro-skipped", reason: raw.reason });
    return built.ok ? parseOk(built.value) : parseErr(`${label} ${built.error}`);
  }
  if (raw.kind !== "retro-recorded") return parseErr(`${label} has invalid schema or kind`);
  const fieldsError = exactFieldsError(raw, ["schemaVersion", "kind", "scope", "path", "digest"], [], label);
  if (fieldsError !== null) return parseErr(fieldsError);
  const parsedScope = parseRetroScope(scope);
  if (parsedScope === null) return parseErr(`${label}.scope must be {kind:"run"} or {kind:"wave",wave}`);
  if (typeof raw.path !== "string" || typeof raw.digest !== "string") return parseErr(`${label}.path and .digest must be strings`);
  const built = retroRecordEntry({ kind: "retro-recorded", scope: parsedScope, path: raw.path, digest: raw.digest });
  if (!built.ok) return parseErr(`${label} ${built.error}`);
  return retroScopeKnown(built.value.scope, waves)
    ? parseOk(built.value)
    : parseErr(`${label}.scope names a Wave the TaskGraph does not hold`);
}

const FORWARD_FIX_AUDIT_FIELDS = [
  "schemaVersion", "kind", "wave", "fixTaskId", "heldTaskIds", "sealedPaths", "reason", "abandonedRunId",
] as const;

/** `null`, or the orchestration run id `raw` names; one branch for the absent case. */
function parseNullableRunId(raw: unknown, label: string): ParseResult<OrchestrationRunId | null> {
  if (raw === null) return parseOk(null);
  const runId = parseOrchestrationRunId(raw);
  return runId.ok ? parseOk(runId.value) : parseErr(`${label}: ${runId.error.message}`);
}

/** The audit's sealed paths: non-empty, distinct and canonical. */
function parseForwardFixSealedPaths(raw: unknown, label: string): ParseResult<NonEmpty<string>> {
  if (!Array.isArray(raw)) return parseErr(`${label} must be a non-empty array`);
  const paths: string[] = [];
  for (const [index, entry] of raw.entries()) {
    const path = parseReviewPath(entry, `${label}[${index}]`);
    if (!path.ok) return parseErr(path.errors.join("; "));
    if (paths.includes(path.value)) return parseErr(`${label} names '${path.value}' more than once`);
    paths.push(path.value);
  }
  const sealed = nonEmpty(paths);
  return sealed === null ? parseErr(`${label} must be a non-empty array`) : parseOk(sealed);
}

/** One Forward Fix audit's own shape, which needs no roster: exact fields,
 *  distinct held Tasks other than the fix Task, canonical sealed paths, a
 *  bounded reason and an optional abandoned run. A live audit is then bound to
 *  the roster (`forwardFixRosterError`); a withdrawn one is not, because its
 *  fix Task left the roster. */
function parseForwardFixAuditShape(raw: unknown, label: string): ParseResult<ForwardFixAudit> {
  if (!isRecord(raw)) return parseErr(`${label} must be an object`);
  const record = raw as Record<string, unknown>;
  const fieldsError = exactFieldsError(record, FORWARD_FIX_AUDIT_FIELDS, [], label);
  if (fieldsError !== null) return parseErr(fieldsError);
  if (record.schemaVersion !== 1 || record.kind !== "forward-fix-added") return parseErr(`${label} has invalid schema or kind`);
  const wave = parseIntegerBound(record.wave, `${label}.wave`, 1, "an integer >= 1 within the safe-integer range");
  if (!wave.ok) return parseErr(wave.error);
  const fixTaskId = parseTaskIdAt(record.fixTaskId, `${label}.fixTaskId`);
  if (!fixTaskId.ok) return fixTaskId;
  const held = parseDistinctTaskIds(record.heldTaskIds, `${label}.heldTaskIds`);
  if (!held.ok) return held;
  if (held.value.some((id) => id === fixTaskId.value)) {
    return parseErr(`${label}.heldTaskIds: ${fixTaskId.value} is the fix Task itself`);
  }
  const sealedPaths = parseForwardFixSealedPaths(record.sealedPaths, `${label}.sealedPaths`);
  if (!sealedPaths.ok) return sealedPaths;
  const reason = parseBoundedReason(record.reason, label);
  if (!reason.ok) return reason;
  const abandoned = parseNullableRunId(record.abandonedRunId, `${label}.abandonedRunId`);
  if (!abandoned.ok) return abandoned;
  return parseOk(Object.freeze({
    schemaVersion: 1,
    kind: "forward-fix-added",
    wave: wave.value,
    fixTaskId: fixTaskId.value,
    heldTaskIds: held.value,
    sealedPaths: sealedPaths.value,
    reason: reason.value,
    abandonedRunId: abandoned.value,
  }));
}

/** Why a live audit contradicts the roster, or null: its fix Task and held
 *  Tasks are Tasks of the audited Wave, the fix is no Distill Task, and every
 *  sealed path is the fix Task's own and was written by an earlier Wave. */
function forwardFixRosterError(audit: ForwardFixAudit, label: string, tasks: readonly ParsedTask[]): string | null {
  const fix = tasks.find((task) => task.id === audit.fixTaskId);
  if (fix === undefined || fix.wave !== audit.wave) return `${label}.fixTaskId: ${audit.fixTaskId} is not a Task of Wave ${audit.wave}`;
  if (isDistillTask(fix)) return `${label}.fixTaskId: ${audit.fixTaskId} is a Distill Task`;
  const foreign = audit.heldTaskIds.find((id) => !tasks.some((task) => task.id === id && task.wave === audit.wave));
  if (foreign !== undefined) return `${label}.heldTaskIds: ${foreign} is not a Task of Wave ${audit.wave}`;
  const fixFiles: readonly unknown[] = Array.isArray(fix.file_list) ? fix.file_list : [];
  const outside = audit.sealedPaths.find((path) => !fixFiles.includes(path));
  if (outside !== undefined) return `${label}.sealedPaths names '${outside}', which is not in the fix Task's file_list`;
  const unsealed = audit.sealedPaths.find((path) => !tasks.some((task) =>
    typeof task.wave === "number" && task.wave < audit.wave && Array.isArray(task.file_list) && task.file_list.includes(path)));
  return unsealed === undefined
    ? null
    : `${label}.sealedPaths names '${unsealed}', which no Task of a Wave before ${audit.wave} wrote`;
}

/** A fix Task is appended by exactly one audit, so no two audits name the same fix Task. */
function parseForwardFixHistory(
  raw: unknown,
  tasks: readonly ParsedTask[],
): ParseResult<readonly ForwardFixAudit[] | undefined> {
  return parseOptionalLog(raw, "forward_fix_history", (entry, label, earlier: readonly ForwardFixAudit[]) => {
    const parsed = parseForwardFixAuditShape(entry, label);
    if (!parsed.ok) return parsed;
    const rosterError = forwardFixRosterError(parsed.value, label, tasks);
    if (rosterError !== null) return parseErr(rosterError);
    return earlier.some(({ fixTaskId }) => fixTaskId === parsed.value.fixTaskId)
      ? parseErr(`forward_fix_history names fix Task ${parsed.value.fixTaskId} in two audits`)
      : parsed;
  });
}

const FORWARD_FIX_WITHDRAWAL_FIELDS = ["schemaVersion", "kind", "audit", "reason"] as const;

/**
 * Withdrawn Forward Fixes: each record holds a well-formed audit whose fix
 * Task is no longer on the roster, and no fix Task is withdrawn twice. A
 * withdrawn id is never minted again, so its presence on the roster means the
 * graph contradicts itself. That also keeps it out of every live audit, whose
 * fix Task the history parser binds to the roster.
 */
function parseForwardFixWithdrawals(
  raw: unknown,
  tasks: readonly ParsedTask[],
): ParseResult<readonly ForwardFixWithdrawal[] | undefined> {
  return parseOptionalLog(raw, "forward_fix_withdrawals", (entry, label, earlier: readonly ForwardFixWithdrawal[]) => {
    if (!isRecord(entry)) return parseErr(`${label} must be an object`);
    const fieldsError = exactFieldsError(entry, FORWARD_FIX_WITHDRAWAL_FIELDS, [], label);
    if (fieldsError !== null) return parseErr(fieldsError);
    if (entry.schemaVersion !== 1 || entry.kind !== "forward-fix-withdrawn") return parseErr(`${label} has invalid schema or kind`);
    const audit = parseForwardFixAuditShape(entry.audit, `${label}.audit`);
    if (!audit.ok) return audit;
    const { fixTaskId } = audit.value;
    if (tasks.some((task) => task.id === fixTaskId)) return parseErr(`${label}: withdrawn fix Task ${fixTaskId} is still on the roster`);
    if (earlier.some((withdrawal) => withdrawal.audit.fixTaskId === fixTaskId)) {
      return parseErr(`forward_fix_withdrawals withdraws fix Task ${fixTaskId} twice`);
    }
    const reason = parseBoundedReason(entry.reason, label);
    if (!reason.ok) return reason;
    return parseOk(Object.freeze({ schemaVersion: 1 as const, kind: "forward-fix-withdrawn" as const, audit: audit.value, reason: reason.value }));
  });
}

/** An audit's operator reason under `label`: a trimmed non-blank string of at most the reopening bound. */
function parseBoundedReason(raw: unknown, label: string): ParseResult<string> {
  return typeof raw === "string" && raw.trim() === raw && raw.length > 0 && raw.length <= MAX_TASK_REOPENING_REASON_LENGTH
    ? parseOk(raw)
    : parseErr(`${label}.reason must be a trimmed non-blank string of at most ${MAX_TASK_REOPENING_REASON_LENGTH} characters`);
}

/** `value` as the Task id it is under `label`, or why it is not one. */
function parseTaskIdAt(value: unknown, label: string): ParseResult<TaskId> {
  if (typeof value !== "string" || value === "") {
    return parseErr(`${label}: id must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  const parsed = parseTaskId(value, `${label}: id`);
  return parsed.ok
    ? parseOk(parsed.value)
    : parseErr(`${label}: id must match T\\d+, got ${JSON.stringify(value)}`);
}

/** One task-identity grammar shared by load and operator-validation boundaries. */
export function taskIdError(value: unknown, label: string): string | null {
  const parsed = parseTaskIdAt(value, label);
  return parsed.ok ? null : parsed.error;
}

/** The Task fields the roster rules read: a raw Task record and a parsed Task are both one. */
type RosterTaskView = Readonly<{ id?: unknown; wave?: unknown; depends_on?: unknown }>;

export function orphanExecutionReservationError(
  tasks: readonly RosterTaskView[],
  executingTasks: unknown,
): string | null {
  if (!Array.isArray(executingTasks)) return null;
  const taskIds = new Set(tasks.flatMap((task) => typeof task.id === "string" ? [task.id] : []));
  const orphan = executingTasks.find((id) => typeof id === "string" && !taskIds.has(id));
  return orphan === undefined
    ? null
    : `orphan execution reservation ${orphan}: executing_tasks must name an existing Task; ` +
      "run helper repair-task-graph to remove corrupt orphan reservations";
}

/**
 * The same-Wave edges `wave_plan_edits` records, as `"<task>→<dependency>"`
 * keys: those `add-dependency` added (ADR-0081), and an added Task's own edges
 * and its dependents' edges to it (`add-task`, ADR-0086). Only an audited edit
 * makes a same-Wave edge legal; a decompose payload carries none.
 */
export function auditedSameWaveEdges(rawEdits: unknown): ReadonlySet<string> {
  if (!Array.isArray(rawEdits)) return new Set();
  return new Set(rawEdits.flatMap((edit): readonly string[] => {
    if (!isRecord(edit) || typeof edit.taskId !== "string") return [];
    const taskId = edit.taskId;
    if (edit.kind === "dependency-added" && isStringArray(edit.dependsOn)) {
      return edit.dependsOn.map((dependency) => `${taskId}→${dependency}`);
    }
    if (edit.kind === "task-added" && isStringArray(edit.dependsOn) && isStringArray(edit.dependents)) {
      return [
        ...edit.dependsOn.map((dependency) => `${taskId}→${dependency}`),
        ...edit.dependents.map((dependent) => `${dependent}→${taskId}`),
      ];
    }
    return [];
  }));
}

/**
 * Every illegal `depends_on` edge: a self or unknown dependency, and a
 * dependency in a later Wave, or in the same Wave unless `auditedSameWave`
 * records it (ADR-0081). Only when there is none, every cycle.
 */
export function taskDependencyErrors(
  tasks: readonly RosterTaskView[],
  auditedSameWave: ReadonlySet<string> = new Set(),
): readonly string[] {
  const byId = new Map(
    tasks.flatMap((task) => typeof task.id === "string" ? [[task.id, task] as const] : []),
  );
  const errors: string[] = [];
  for (const task of tasks) {
    if (typeof task.id !== "string" || !Array.isArray(task.depends_on)) continue;
    const id = task.id;
    for (const dependency of task.depends_on) {
      if (typeof dependency !== "string") continue;
      if (dependency === id) {
        errors.push(`Task ${id}: self-dependency`);
        continue;
      }
      const dependencyTask = byId.get(dependency);
      if (!dependencyTask) {
        errors.push(`Task ${id}: depends on non-existent '${dependency}'`);
        continue;
      }
      if (typeof task.wave !== "number" || typeof dependencyTask.wave !== "number") continue;
      if (dependencyTask.wave === task.wave && auditedSameWave.has(`${id}→${dependency}`)) continue;
      if (dependencyTask.wave >= task.wave) {
        errors.push(
          `Task ${id} (wave ${task.wave}): depends on '${dependency}' (wave ${dependencyTask.wave}) — deps must be in earlier wave ` +
            "(or added within the Wave by helper orchestration add-dependency)",
        );
      }
    }
  }
  if (errors.length > 0) return errors;
  const graph = tasks.flatMap((task) =>
    typeof task.id === "string" && typeof task.wave === "number" && isStringArray(task.depends_on)
      ? [{ id: task.id, wave: task.wave, depends_on: task.depends_on }]
      : []);
  return dependencyCycles(graph);
}

// ---------------------------------------------------------------------------
// One stored Task
// ---------------------------------------------------------------------------

/** One stored Task's prefix in every load diagnostic: its position and id. */
const taskLabel = (index: number, id: string): string => `tasks[${index}] ("${id}")`;

/** `{ [field]: value }` for a present value, `{}` for an absent one: an absent field stays absent. */
function present<K extends string, V>(field: K, value: V | undefined): Partial<Readonly<Record<K, V>>> {
  const absent: Partial<Readonly<Record<K, V>>> = {};
  return value === undefined ? absent : { ...absent, [field]: value };
}

/** A leaf parser's diagnostics as this boundary's one error: every diagnostic, in order. */
function fromErrors<T>(
  result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; errors: readonly string[] }>,
): ParseResult<T> {
  return result.ok ? parseOk(result.value) : parseErr(result.errors.join("; "));
}

/** `fromErrors` for the leaf parsers that wrap their diagnostics in an error record. */
function fromErrorList<T>(
  result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: Readonly<{ errors: readonly string[] }> }>,
): ParseResult<T> {
  return result.ok ? parseOk(result.value) : parseErr(result.error.errors.join("; "));
}

/** A stored Task's id and its position, or why the entry is no Task. */
function parseStoredTaskIdentity(
  raw: unknown,
  index: number,
): ParseResult<Readonly<{ record: Readonly<Record<string, unknown>>; id: TaskId; label: string }>> {
  if (!isRecord(raw)) return parseErr(`tasks[${index}] must be an object`);
  const id = parseTaskIdAt(raw.id, `tasks[${index}]`);
  return id.ok ? parseOk({ record: raw, id: id.value, label: taskLabel(index, id.value) }) : id;
}

/**
 * Parse one stored Task at the load boundary: every field once, in the order
 * the load-guard suite pins, each cross-field rule judged on parsed values,
 * and the first refusal wins, so the operator sees the outermost cause. A
 * pending Task stored without a Proof is given the pending Proof its policy
 * derives, and an active attempt's repository baseline is carried into
 * `repository_baseline`.
 *
 * `scope` is the TaskGraph's I6 scope (`redThenGreenScope` of its
 * `verification_manifest` and `acceptance_contracts`, INV-6), whose
 * `taskRedThenGreenEra` decides whether this Task's stored obligations must
 * include `red-then-green`: never for an Acceptance Contract writer. It is
 * required: the obligation check matches exactly that era's derivation, so no
 * caller can prove a Task against "either era".
 */
export function parseStoredTask(raw: unknown, index: number, scope: RedThenGreenScope): ParseResult<ParsedTask> {
  const identity = parseStoredTaskIdentity(raw, index);
  if (!identity.ok) return identity;
  const { record: t, id, label } = identity.value;
  const shape = parseStoredTaskShape(t, label);
  if (!shape.ok) return shape;
  const baselines = parseStoredTaskBaselines(t, label, shape.value);
  if (!baselines.ok) return baselines;
  const attempt = parseStoredAttempt(t, label, id, shape.value.wave, baselines.value);
  if (!attempt.ok) return attempt;
  const carry = parseStoredRepositoryCarry(t, label, baselines.value);
  if (!carry.ok) return carry;
  const packetError = taskPacketError(t, label, id, shape.value);
  if (packetError !== null) return parseErr(packetError);
  const lifecycle = parseStoredLifecycle(t, label, id, shape.value, scope);
  if (!lifecycle.ok) return lifecycle;
  const evidence = parseStoredTaskEvidence(t, label);
  if (!evidence.ok) return evidence;
  const findings = readStoredTaskFindings(t, label);
  if (findings.errors[0] !== undefined) return parseErr(findings.errors[0]);
  const hashes = parseSpecAnchorHashes(t.spec_anchor_hashes, index);
  if (!hashes.ok) return hashes;
  const skeletons = parseSkeletonOutcomesField(t.skeleton_outcomes, shape.value.file_list, `tasks[${index}].skeleton_outcomes`);
  if (!skeletons.ok) return skeletons;
  return parseOk(loadedTask(t, {
    id,
    ...shape.value,
    ...lifecycle.value.lifecycle,
    ...lifecycle.value.reopening,
    ...present("spec_anchor_hashes", hashes.value),
    ...attempt.value,
    ...carry.value,
    ...evidence.value,
    ...findings.fields,
    ...present("skeleton_outcomes", skeletons.value),
  }));
}

/**
 * Every refusal the load boundary has for one stored Task, for the operator's
 * validator: the one `parseStoredTask` stops at, and every findings-aggregate
 * rule's. Those rules read only the review fields, so each is reported though
 * an earlier one refused; the rest of the parse depends on what precedes it.
 */
export function storedTaskErrors(raw: unknown, index: number, scope: RedThenGreenScope): readonly string[] {
  const parsed = parseStoredTask(raw, index, scope);
  // A non-canonical id is its own refusal; the review fields are still judged under it.
  const findings = isRecord(raw) && typeof raw.id === "string" ? readStoredTaskFindings(raw, taskLabel(index, raw.id)).errors : [];
  return [...new Set([...findings, ...(parsed.ok ? [] : [parsed.error])])];
}

/** The Task fields this boundary parses into values of their own. */
type InstalledTaskFields = Readonly<{ id: TaskId }> & StoredTaskShape & TaskLifecycle & Partial<Pick<Task,
  | "reopen_scope" | "reopen_baseline" | "spec_anchor_hashes" | "skeleton_outcomes" | "repository_baseline"
  | "findings" | "refuted_findings" | "resolved_findings" | "test_result" | "new_test_observation"
  | "implementation_attempt_history" | "implementation_retry_protocol" | "implementation_retry_history_start"
  | "implementation_retry_predecessor_receipt_id" | "active_implementation_attempt" | "active_implementation_context"
>>;

/**
 * The loaded Task: its wire record with every parsed value installed in place
 * (a derived Proof or a carried repository baseline appended), as one fresh
 * recursively frozen copy, so no holder of the raw document can reach it.
 *
 * The record is the one place wire data meets the Task type. It supplies the
 * fields the parse proves but stores as written (the review run, the review
 * acceptances, issued packets, recovered writes, the verification policy, the
 * artifact baselines, the review-evidence pair, the derived findings views)
 * and the few no rule has ever proven (`test_evidence`, `start_sha`,
 * `failure_reason`, `retry_count`, an unattempted `reserved_at`; the Spec trace
 * contract proves `spec_anchors` and `spec_contributions` graph-wide).
 */
function loadedTask(record: Readonly<Record<string, unknown>>, installed: InstalledTaskFields): ParsedTask {
  const wire = record as Partial<TaskCommonMetadata>;
  return frozenJsonCopy({ ...wire, ...installed });
}

/** A stored Task's names, Wave, dependencies and files. */
type StoredTaskShape = Pick<Task, "description" | "agent" | "wave" | "depends_on" | "file_list" | "files_modified">;

/** Structural fields: a drifted or hand-edited graph fails here, not inside typed gate logic. */
function parseStoredTaskShape(t: Readonly<Record<string, unknown>>, label: string): ParseResult<StoredTaskShape> {
  const { description, agent, wave, depends_on: dependsOn, files_modified: filesModified } = t;
  if (typeof description !== "string" || description.trim() === "") {
    return parseErr(`${label}: description must be a non-empty string, got ${JSON.stringify(description)}`);
  }
  if (typeof agent !== "string" || agent.trim() === "") {
    return parseErr(`${label}: agent must be a non-empty string, got ${JSON.stringify(agent)}`);
  }
  if (!KNOWN_AGENTS.has(agent)) return parseErr(`${label}: unknown agent ${JSON.stringify(agent)}`);
  if (typeof wave !== "number" || !Number.isSafeInteger(wave) || wave < 1) {
    return parseErr(`${label}: wave must be an integer >= 1 within the safe-integer range, got ${JSON.stringify(wave)}`);
  }
  if (!isStringArray(dependsOn)) return parseErr(`${label}: depends_on must be an array of strings`);
  const fileList = parseStoredFileList(t.file_list, label);
  if (!fileList.ok) return fileList;
  if (filesModified !== undefined && !isStringArray(filesModified)) {
    return parseErr(`${label}: files_modified must be an array of strings when present`);
  }
  return parseOk({
    description,
    agent,
    wave,
    depends_on: dependsOn,
    ...present("file_list", fileList.value),
    ...present("files_modified", filesModified),
  });
}

/** A stored `file_list`: absent, or distinct canonical paths, none of them protected verification infrastructure. */
function parseStoredFileList(raw: unknown, label: string): ParseResult<readonly string[] | undefined> {
  if (raw === undefined) return parseOk(undefined);
  if (!Array.isArray(raw)) {
    return parseErr(`${label}: file_list must be an array of canonical repository-relative paths when present`);
  }
  const paths: string[] = [];
  for (const [pathIndex, rawPath] of raw.entries()) {
    const path = storedPath(rawPath, `${label}: file_list[${pathIndex}]`);
    if (!path.ok) return path;
    if (isProtectedVerificationPath(path.value)) {
      return parseErr(`${label}: file_list path '${path.value}' is protected verification infrastructure; remove it from this Task`);
    }
    if (paths.includes(path.value)) return parseErr(`${label}: file_list repeats '${path.value}'`);
    paths.push(path.value);
  }
  return parseOk(paths);
}

/** A stored artifact baseline field under `label`: absent, or the parsed baseline. */
function parseStoredBaseline(raw: unknown, label: string): ParseResult<readonly DeclaredArtifactBaseline[] | undefined> {
  return raw === undefined ? parseOk(undefined) : fromErrors(parseDeclaredArtifactBaseline(raw, label));
}

/** Whether a baseline's artifacts are `fileList`, in order: exactly, or as its prefix. */
function baselineDeclaresFileList(
  baseline: readonly DeclaredArtifactBaseline[],
  fileList: readonly string[],
  coverage: "exact" | "prefix",
): boolean {
  const actual = baseline.map(({ artifact }) => artifact);
  const sized = coverage === "exact" ? actual.length === fileList.length : actual.length >= fileList.length;
  return sized && fileList.every((artifact, artifactIndex) => artifact === actual[artifactIndex]);
}

/** The attempt baselines a stored Task carries, parsed for the rules that compare them. */
type StoredAttemptBaselines = Readonly<{
  attemptArtifact: readonly DeclaredArtifactBaseline[] | undefined;
  attemptRepository: readonly DeclaredArtifactBaseline[] | undefined;
}>;

/** Declared artifact baselines and their agreement with `file_list` (or, under an active attempt, its registration scope). */
function parseStoredTaskBaselines(
  t: Readonly<Record<string, unknown>>,
  label: string,
  shape: StoredTaskShape,
): ParseResult<StoredAttemptBaselines> {
  const fileList = shape.file_list ?? [];
  const artifact = parseStoredBaseline(t.artifact_baseline, `${label}: artifact_baseline`);
  if (!artifact.ok) return artifact;
  if (artifact.value !== undefined && !baselineDeclaresFileList(artifact.value, fileList, "exact")) {
    return parseErr(`${label}: artifact_baseline must exactly match file_list in order`);
  }
  const attemptLabel = `${label}: attempt_artifact_baseline`;
  const attemptArtifact = parseStoredBaseline(t.attempt_artifact_baseline, attemptLabel);
  if (!attemptArtifact.ok) return attemptArtifact;
  if (attemptArtifact.value !== undefined && t.active_implementation_attempt !== undefined) {
    const scopeError = registrationScopeError(attemptArtifact.value, shape, attemptLabel);
    if (scopeError !== null) return parseErr(scopeError);
  } else if (attemptArtifact.value !== undefined && !baselineDeclaresFileList(attemptArtifact.value, fileList, "prefix")) {
    return parseErr(`${attemptLabel} must cover file_list first and in order`);
  }
  const attemptRepository = parseStoredBaseline(t.attempt_repository_baseline, `${label}: attempt_repository_baseline`);
  if (!attemptRepository.ok) return attemptRepository;
  return parseOk({ attemptArtifact: attemptArtifact.value, attemptRepository: attemptRepository.value });
}

/** Why an active attempt's artifact baseline is not exactly unique(file_list + files_modified), or null. */
function registrationScopeError(
  baseline: readonly DeclaredArtifactBaseline[],
  shape: StoredTaskShape,
  label: string,
): string | null {
  const expected: string[] = [];
  for (const [pathIndex, rawPath] of [...(shape.file_list ?? []), ...(shape.files_modified ?? [])].entries()) {
    const parsed = storedPath(rawPath, `${label}.registration_scope[${pathIndex}]`);
    if (!parsed.ok) return parsed.error;
    if (!expected.includes(parsed.value)) expected.push(parsed.value);
  }
  const actual = new Set(baseline.map(({ artifact }) => artifact));
  return baseline.length !== expected.length || actual.size !== expected.length || expected.some((path) => !actual.has(path))
    ? `${label} path set must exactly equal unique(file_list + files_modified) at registration scope`
    : null;
}

/** The implementation lineage fields a stored Task carries. */
type StoredLineageFields = Partial<Pick<Task,
  | "implementation_attempt_history" | "implementation_retry_protocol" | "implementation_retry_history_start"
  | "implementation_retry_predecessor_receipt_id"
>>;

/** A stored Task's implementation lineage and the retry disposition it derives. */
type StoredAttemptLineage = Readonly<{
  fields: StoredLineageFields;
  disposition: Exclude<ImplementationRetryDisposition, Readonly<{ kind: "invalid" }>>;
}>;

/** Exact receipt history and protocol-2 retry markers, proven as one lineage. */
function parseStoredAttemptLineage(t: Readonly<Record<string, unknown>>, label: string, id: TaskId): ParseResult<StoredAttemptLineage> {
  const history = t.implementation_attempt_history === undefined
    ? parseOk(undefined)
    : fromErrorList(parseImplementationAttemptHistory(t.implementation_attempt_history, `${label}: implementation_attempt_history`));
  if (!history.ok) return history;
  if (history.value?.some((receipt) => receipt.taskId !== id)) {
    return parseErr(`${label}: implementation_attempt_history receipt taskId must equal ${id}`);
  }
  const markers = parseStoredRetryMarkers(t, label, history.value?.length ?? 0);
  if (!markers.ok) return markers;
  const fields: StoredLineageFields = { ...present("implementation_attempt_history", history.value), ...markers.value };
  const disposition = deriveImplementationRetryDisposition({
    id,
    ...fields,
    ...(t.implementation_attestation === true ? { implementation_attestation: true } : {}),
  });
  return disposition.kind === "invalid"
    ? parseErr(`${label}: invalid implementation retry lineage: ${disposition.errors.join("; ")}`)
    : parseOk({ fields, disposition });
}

/** The protocol-2 retry markers: all absent, or protocol 2 with a history start inside the history. */
function parseStoredRetryMarkers(
  t: Readonly<Record<string, unknown>>,
  label: string,
  historyLength: number,
): ParseResult<Omit<StoredLineageFields, "implementation_attempt_history">> {
  const {
    implementation_retry_protocol: protocol,
    implementation_retry_history_start: start,
    implementation_retry_predecessor_receipt_id: predecessor,
  } = t;
  if (protocol === undefined && start === undefined && predecessor === undefined) return parseOk({});
  if (protocol !== 2 || typeof start !== "number" || !Number.isSafeInteger(start) || start < 0 || start > historyLength) {
    return parseErr(`${label}: implementation retry protocol 2 requires a valid history start index`);
  }
  const markers = { implementation_retry_protocol: 2 as const, implementation_retry_history_start: start };
  if (predecessor === undefined) return parseOk(markers);
  const receiptId = fromErrorList(
    parseImplementationSettlementReceiptId(predecessor, `${label}: implementation_retry_predecessor_receipt_id`),
  );
  return receiptId.ok ? parseOk({ ...markers, implementation_retry_predecessor_receipt_id: receiptId.value }) : receiptId;
}

/** The active attempt authority and the context frozen with it. */
type StoredActiveAttempt = Partial<Pick<Task, "active_implementation_attempt" | "active_implementation_context">>;

/** Modern attempt authority, its lineage, baseline digest lockstep and exact receipt history. */
function parseStoredAttempt(
  t: Readonly<Record<string, unknown>>,
  label: string,
  id: TaskId,
  wave: number,
  baselines: StoredAttemptBaselines,
): ParseResult<StoredLineageFields & StoredActiveAttempt> {
  const lineage = parseStoredAttemptLineage(t, label, id);
  if (!lineage.ok) return lineage;
  const active = parseStoredActiveAttempt(t, label, Object.freeze({ id, wave }), lineage.value, baselines);
  return active.ok ? parseOk({ ...lineage.value.fields, ...active.value }) : active;
}

function parseStoredActiveAttempt(
  t: Readonly<Record<string, unknown>>,
  label: string,
  task: Readonly<{ id: TaskId; wave: number }>,
  lineage: StoredAttemptLineage,
  baselines: StoredAttemptBaselines,
): ParseResult<StoredActiveAttempt> {
  if (t.active_implementation_attempt === undefined) {
    return t.active_implementation_context === undefined
      ? parseOk({})
      : parseErr(`${label}: active_implementation_context requires active_implementation_attempt`);
  }
  if (t.proof === undefined) return parseErr(`${label}: active_implementation_attempt requires modern authored Proof`);
  const parsed = parseImplementationAttemptAuthority(t.active_implementation_attempt);
  if (!parsed.ok) return parseErr(`${label}: invalid active_implementation_attempt: ${parsed.error.errors.join("; ")}`);
  const authority = parsed.value;
  if (authority.taskId !== task.id || authority.wave !== task.wave) {
    return parseErr(`${label}: active_implementation_attempt must match Task id and Wave`);
  }
  const { disposition, fields } = lineage;
  if (disposition.kind === "escalated") return parseErr(`${label}: escalated implementation lineage cannot carry an active attempt`);
  const protocol = fields.implementation_retry_protocol;
  if (protocol === undefined && authority.semanticAttempt === 2) {
    return parseErr(`${label}: semantic attempt 2 requires protocol-2 retry lineage`);
  }
  if (protocol === 2 && authority.semanticAttempt !== disposition.semanticAttempt) {
    return parseErr(`${label}: active_implementation_attempt semantic attempt contradicts settlement history`);
  }
  const context = parseStoredAttemptContext(t, label, authority, lineage);
  if (!context.ok) return context;
  const lockstep = activeAttemptLockstepError(t, label, authority, fields.implementation_attempt_history, baselines);
  return lockstep === null
    ? parseOk({ active_implementation_attempt: authority, ...present("active_implementation_context", context.value) })
    : parseErr(lockstep);
}

/** The context frozen before the active Agent dispatch: required under protocol 2, and the current retry's when retrying. */
function parseStoredAttemptContext(
  t: Readonly<Record<string, unknown>>,
  label: string,
  authority: ImplementationAttemptAuthority,
  lineage: StoredAttemptLineage,
): ParseResult<ImplementationAttemptContext | undefined> {
  if (lineage.fields.implementation_retry_protocol === 2 && t.active_implementation_context === undefined) {
    return parseErr(`${label}: protocol-2 active implementation requires active_implementation_context`);
  }
  if (t.active_implementation_context === undefined) return parseOk(undefined);
  const context = fromErrors(parseImplementationAttemptContext(t.active_implementation_context, `${label}: active_implementation_context`));
  if (!context.ok) return context;
  if (!implementationAttemptContextMatchesAuthority(context.value, authority)) {
    return parseErr(`${label}: active_implementation_context must match active_implementation_attempt`);
  }
  const { disposition } = lineage;
  const { retryContext, predecessorReceiptId } = context.value;
  return disposition.kind === "retry" && (
    retryContext === null ||
    predecessorReceiptId !== disposition.predecessor.receiptId ||
    renderImplementationRetryContext(retryContext) !== disposition.promptAppendix
  )
    ? parseErr(`${label}: active retry context must match the current retry-required receipt`)
    : context;
}

/** Why an active attempt disagrees with its history, reservation time or the attempt baselines it froze, or null. */
function activeAttemptLockstepError(
  t: Readonly<Record<string, unknown>>,
  label: string,
  authority: ImplementationAttemptAuthority,
  history: readonly ImplementationAttemptSettlementReceipt[] | undefined,
  baselines: StoredAttemptBaselines,
): string | null {
  if (history?.some((receipt) =>
    receipt.authorityDigest === authority.authorityDigest || receipt.reservationId === authority.reservationId)) {
    return `${label}: active_implementation_attempt authorityDigest and reservationId must be absent from implementation_attempt_history`;
  }
  if (t.reserved_at !== authority.reservedAt) return `${label}: reserved_at must equal active_implementation_attempt.reservedAt`;
  if (baselines.attemptArtifact === undefined || baselines.attemptRepository === undefined) {
    return `${label}: active_implementation_attempt requires both attempt baselines`;
  }
  const taskDigest = canonicalArtifactBaselineDigest(t.attempt_artifact_baseline);
  const dirtyDigest = canonicalArtifactBaselineDigest(t.attempt_repository_baseline);
  if (!taskDigest.ok || !dirtyDigest.ok) {
    const errors = [...(taskDigest.ok ? [] : taskDigest.error.errors), ...(dirtyDigest.ok ? [] : dirtyDigest.error.errors)];
    return `${label}: active attempt baseline is invalid: ${errors.join("; ")}`;
  }
  return taskDigest.value !== authority.taskScopeBaselineDigest || dirtyDigest.value !== authority.dirtySetBaselineDigest
    ? `${label}: active attempt baseline digests do not match active_implementation_attempt`
    : null;
}

/**
 * Persistent unresolved-attempt repository authority, and the carry of an
 * active attempt's repository baseline into it. Every settlement retires the
 * attempt boundary (implementation-application's RETIRED_ATTEMPT_BOUNDARY), so
 * an accepted lifecycle never retains it.
 */
function parseStoredRepositoryCarry(
  t: Readonly<Record<string, unknown>>,
  label: string,
  baselines: StoredAttemptBaselines,
): ParseResult<Pick<Task, "repository_baseline">> {
  const persistent = parseStoredBaseline(t.repository_baseline, `${label}: repository_baseline`);
  if (!persistent.ok) return persistent;
  const attemptActive = t.active_implementation_attempt !== undefined;
  if (persistent.value !== undefined && attemptActive && baselines.attemptRepository !== undefined) {
    const persistentDigest = canonicalArtifactBaselineDigest(persistent.value);
    const attemptDigest = canonicalArtifactBaselineDigest(t.attempt_repository_baseline);
    if (!persistentDigest.ok || !attemptDigest.ok || persistentDigest.value !== attemptDigest.value) {
      return parseErr(`${label}: active attempt_repository_baseline must equal retained repository_baseline`);
    }
  }
  if ((t.status === "implemented" || t.status === "completed") && persistent.value !== undefined && !attemptActive) {
    return parseErr(`${label}: accepted implementation lifecycle cannot retain repository_baseline`);
  }
  return parseOk(present("repository_baseline", persistent.value ?? (attemptActive ? baselines.attemptRepository : undefined)));
}

/**
 * Which stored acceptance a record is, and so what it must agree with:
 * - `accepted`: the Task's live `accepted_review_authority`. Legacy or current;
 *   a current one closed exactly the Task's `review_generation`.
 * - `basis`: the `review_basis` a reopening kept (ADR-0094). Always current,
 *   and from an earlier generation, since the reopening advanced it.
 */
type StoredAcceptance =
  | Readonly<{ kind: "accepted"; reviewGeneration: unknown }>
  | Readonly<{ kind: "basis" }>;

const ACCEPTANCE_REQUIRED_FIELDS = ["generation", "packet_id", "head_sha", "scope"] as const;
const ACCEPTANCE_OPTIONAL_FIELDS = ["run_id", "authority_digest", "reviewer_protocol", "subject_digest", "narrowing"] as const;

/**
 * The one rule for a stored review acceptance, under `prefix` and wire name
 * `field`: an exact field set, a supported descriptor with complete run
 * authority on a current one, a canonical sorted unique non-empty scope, and
 * the sealed Subject Digest (ADR-0091) and narrowing (ADR-0094) only on a
 * current one. `stored` says what else the record must agree with.
 */
function storedAcceptanceError(raw: unknown, prefix: string, field: string, stored: StoredAcceptance): string | null {
  if (!isRecord(raw)) return `${prefix}: ${field} must be an object`;
  const authority = raw as Record<string, unknown>;
  const current = Object.hasOwn(authority, "reviewer_protocol");
  if (stored.kind === "basis" && !current) {
    return `${prefix}: ${field} must be a current acceptance naming its reviewer protocol`;
  }
  const fields = Object.keys(authority).sort();
  const allowed: readonly string[] = [...ACCEPTANCE_REQUIRED_FIELDS, ...ACCEPTANCE_OPTIONAL_FIELDS];
  if (current &&
      (!parseWaveReviewerProtocolDescriptor(authority.reviewer_protocol).ok || authority.run_id === undefined ||
        authority.authority_digest === undefined)) {
    return `${prefix}: current ${field} requires supported descriptor and run authority`;
  }
  if (Object.hasOwn(authority, "subject_digest") && (!current || parseSealedSubjectDigest(authority.subject_digest) === null)) {
    return `${prefix}: ${field}.subject_digest must be a SHA-256 digest on a current acceptance`;
  }
  if (Object.hasOwn(authority, "narrowing") && (!current || parseReviewNarrowing(authority.narrowing) === null)) {
    return `${prefix}: ${field}.narrowing must be a narrowing record on a current acceptance`;
  }
  if (fields.some((name) => !allowed.includes(name)) ||
      !ACCEPTANCE_REQUIRED_FIELDS.every((name) => fields.includes(name))) {
    return `${prefix}: ${field} has an invalid field set`;
  }
  if (typeof authority.generation !== "number" || !Number.isSafeInteger(authority.generation) || authority.generation < 0 ||
      typeof authority.packet_id !== "string" || !/^[0-9a-f]{64}$/.test(authority.packet_id) ||
      !isExactGitSha(authority.head_sha)) {
    return `${prefix}: ${field} has invalid generation, packet_id, or head_sha`;
  }
  const scopeError = storedAcceptanceScopeError(authority, prefix, field, current, stored);
  if (scopeError !== null) return scopeError;
  if ((authority.run_id === undefined) !== (authority.authority_digest === undefined) ||
      (authority.run_id !== undefined && (!parseOrchestrationRunId(authority.run_id).ok ||
        typeof authority.authority_digest !== "string" || !/^[0-9a-f]{64}$/.test(authority.authority_digest)))) {
    return `${prefix}: ${field} run authority must be complete and valid when present`;
  }
  return null;
}

/**
 * Why a stored acceptance's scope is invalid, or null when it is valid.
 * Invalid means: not a non-empty array of canonical review paths, not sorted
 * and unique, or, on a current live acceptance, closed at a generation other
 * than the Task's. A basis (always current) closed an earlier generation than
 * the Task's, so only its scope is pinned.
 */
function storedAcceptanceScopeError(
  authority: Record<string, unknown>,
  prefix: string,
  field: string,
  current: boolean,
  stored: StoredAcceptance,
): string | null {
  if (!Array.isArray(authority.scope) || authority.scope.length === 0) {
    return `${prefix}: ${field}.scope must be a non-empty canonical path array`;
  }
  const rawScope: readonly unknown[] = authority.scope;
  const scope = rawScope.map((path, pathIndex) => storedPath(path, `${prefix}: ${field}.scope[${pathIndex}]`));
  const scopeError = scope.find((parsed) => !parsed.ok);
  if (scopeError !== undefined && !scopeError.ok) return scopeError.error;
  const scopePaths = scope.map((parsed) => parsed.ok ? parsed.value : "");
  const canonicalScope = scopePaths.every((path, pathIndex) => path === rawScope[pathIndex]);
  if (current && stored.kind === "accepted" && (authority.generation !== stored.reviewGeneration || !canonicalScope)) {
    return `${prefix}: current ${field} must match exact generation and canonical scope`;
  }
  if (stored.kind === "basis" && !canonicalScope) {
    return `${prefix}: ${field}.scope must contain canonical review paths`;
  }
  const sortedScopePaths = [...scopePaths].sort();
  return new Set(scopePaths).size !== scopePaths.length || scopePaths.some((path, pathIndex) => path !== sortedScopePaths[pathIndex])
    ? `${prefix}: ${field}.scope must be sorted and unique`
    : null;
}

/** The review acceptances, issued packets, recovered writes and plan context: proven, and kept as stored. */
function taskPacketError(t: Readonly<Record<string, unknown>>, label: string, id: TaskId, shape: StoredTaskShape): string | null {
  const acceptanceError = taskAcceptanceError(t, label);
  if (acceptanceError !== null) return acceptanceError;
  const packetsError = issuedReviewPacketsError(t.issued_review_packets, label, id);
  if (packetsError !== null) return packetsError;
  const recoveredFrom = t.artifact_baseline_recovered_from;
  if (recoveredFrom !== undefined && !isExactGitSha(recoveredFrom)) {
    return `${label}: artifact_baseline_recovered_from must be a lowercase 40- or 64-character Git SHA`;
  }
  if (t.recovered_artifact_writes !== undefined) {
    if (recoveredFrom === undefined) return `${label}: recovered_artifact_writes requires artifact_baseline_recovered_from`;
    if (!Array.isArray(t.recovered_artifact_writes)) return `${label}: recovered_artifact_writes must be an array`;
    const packetIds = new Set<string>();
    for (const [recoveryIndex, raw] of t.recovered_artifact_writes.entries()) {
      const recoveryLabel = `${label}: recovered_artifact_writes[${recoveryIndex}]`;
      const recovery = recoveredArtifactWriteRecord(raw, recoveryLabel, recoveredFrom);
      if (!recovery.ok) return recovery.error;
      if (packetIds.has(recovery.value.packetId)) return `${recoveryLabel}.packet_id duplicates an earlier recovery`;
      packetIds.add(recovery.value.packetId);
      const pathsError = recoveredWritePathsError(recovery.value.record, recoveryLabel, shape.file_list);
      if (pathsError !== null) return pathsError;
    }
  }
  return t.plan_context !== undefined && typeof t.plan_context !== "string"
    ? `${label}: plan_context must be a string when present`
    : null;
}

/** The live acceptance and the Review Basis a reopening kept, which a new acceptance supersedes. */
function taskAcceptanceError(t: Readonly<Record<string, unknown>>, label: string): string | null {
  if (t.accepted_review_authority !== undefined) {
    const acceptedError = storedAcceptanceError(
      t.accepted_review_authority, label, "accepted_review_authority", { kind: "accepted", reviewGeneration: t.review_generation },
    );
    if (acceptedError !== null) return acceptedError;
  }
  if (t.review_basis === undefined) return null;
  // A basis is the acceptance a reopening cleared (ADR-0094); a new
  // acceptance supersedes it, so the two never stand side by side.
  if (t.accepted_review_authority !== undefined) {
    return `${label}: review_basis cannot stand beside an accepted_review_authority, which supersedes it`;
  }
  return storedAcceptanceError(t.review_basis, label, "review_basis", { kind: "basis" });
}

/** Engine-issued packet registrations: each this Task's, under a distinct packet id and path. */
function issuedReviewPacketsError(raw: unknown, label: string, id: TaskId): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return `${label}: issued_review_packets must be an array`;
  const packetIds = new Set<string>();
  const packetPaths = new Set<string>();
  for (const [packetIndex, entry] of raw.entries()) {
    const packetLabel = `${label}: issued_review_packets[${packetIndex}]`;
    const registration = fromErrors(parseIssuedReviewPacketRegistration(entry, packetLabel));
    if (!registration.ok) return registration.error;
    const { task_id: taskId, packet_id: packetId, packet_path: packetPath } = registration.value;
    if (taskId !== id) return `${packetLabel}.task_id must equal task id ${id}`;
    if (packetIds.has(packetId)) return `${packetLabel}.packet_id duplicates an earlier registration`;
    if (packetPaths.has(packetPath)) return `${packetLabel}.packet_path duplicates an earlier registration`;
    packetIds.add(packetId);
    packetPaths.add(packetPath);
  }
  return null;
}

/** One recovered artifact write's record and packet id: recovered from the Task's recovery commit. */
function recoveredArtifactWriteRecord(
  raw: unknown,
  label: string,
  recoveredFrom: unknown,
): ParseResult<Readonly<{ record: Readonly<Record<string, unknown>>; packetId: string }>> {
  if (!isRecord(raw)) return parseErr(`${label} must be an object`);
  if (!isExactGitSha(raw.baseline_sha)) return parseErr(`${label}.baseline_sha must be an exact Git SHA`);
  if (raw.baseline_sha !== recoveredFrom) return parseErr(`${label}.baseline_sha must equal artifact_baseline_recovered_from`);
  return typeof raw.packet_id === "string" && /^[0-9a-f]{64}$/.test(raw.packet_id)
    ? parseOk({ record: raw, packetId: raw.packet_id })
    : parseErr(`${label}.packet_id must be a lowercase SHA-256 digest`);
}

/** A recovered write's packet path and modified paths, after its packet id. */
function recoveredWritePathsError(
  recovery: Readonly<Record<string, unknown>>,
  label: string,
  fileList: readonly string[] | undefined,
): string | null {
  const packetPath = storedPath(recovery.packet_path, `${label}.packet_path`);
  if (!packetPath.ok) return packetPath.error;
  if (!Array.isArray(recovery.modified_paths) || recovery.modified_paths.length === 0) {
    return `${label}.modified_paths must be a non-empty array`;
  }
  const seenPaths = new Set<string>();
  for (const [pathIndex, path] of recovery.modified_paths.entries()) {
    const parsed = storedPath(path, `${label}.modified_paths[${pathIndex}]`);
    if (!parsed.ok) return parsed.error;
    if (seenPaths.has(parsed.value)) return `${label}.modified_paths duplicates ${JSON.stringify(parsed.value)}`;
    if (fileList !== undefined && !fileList.includes(parsed.value)) {
      return `${label}.modified_paths includes ${JSON.stringify(parsed.value)} outside file_list`;
    }
    seenPaths.add(parsed.value);
  }
  return null;
}

const isEmptyOrAbsent = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.length === 0);

/**
 * The Distill Task's fixed shape (ADR-0068), and the one waiver only it may
 * carry. Population is the only writer of a Distill Task, so every field it
 * stamps is exact here: the engine-only policy, no dependency (its Wave's
 * other Tasks gate it, not `depends_on`), no Requirement trace, and a
 * non-empty Distill Scope. Attestation mode is refused: its Proof is
 * `behaviour-preserved`, and an attested Proof cannot be both.
 */
function taskDistillError(
  t: Readonly<Record<string, unknown>>,
  label: string,
  verification: ParsedTaskVerificationPolicy,
): string | null {
  if (!isDistillTask(t)) {
    return claimsDistillPassWaiver(verification.policy)
      ? `${label}: waiver reason ${DISTILL_PASS} is engine-only and belongs to a Distill Task alone`
      : null;
  }
  if (t.implementation_attestation !== undefined) {
    return `${label}: a Distill Task cannot be in attestation mode`;
  }
  if (verification.source !== "explicit" || !isDistillVerificationPolicy(verification.policy)) {
    return `${label}: a Distill Task must carry exactly the verification_policy that waives regression and new_tests as ${DISTILL_PASS}`;
  }
  if (!isEmptyOrAbsent(t.depends_on)) return `${label}: a Distill Task must have empty depends_on`;
  if (!isEmptyOrAbsent(t.spec_anchors)) return `${label}: a Distill Task must have empty spec_anchors`;
  if (!isEmptyOrAbsent(t.spec_contributions)) return `${label}: a Distill Task must have empty spec_contributions`;
  return Array.isArray(t.file_list) && t.file_list.length > 0
    ? null
    : `${label}: a Distill Task must have a non-empty file_list (its Distill Scope)`;
}

/** A Wave carries at most one Distill Task: the second one found, as its refusal. */
function distillTaskPerWaveError(tasks: readonly ParsedTask[]): string | null {
  const firstByWave = new Map<number, ParsedTask>();
  for (const task of tasks.filter(isDistillTask)) {
    const first = firstByWave.get(task.wave);
    if (first !== undefined) {
      return `Task ${task.id}: Wave ${task.wave} already has the Distill Task ${first.id}; a Wave carries at most one`;
    }
    firstByWave.set(task.wave, task);
  }
  return null;
}

/**
 * The tests-only scope a stored Task's Proof was derived under, or null
 * (ADR-0093): its `reopen_scope` while one is in force, which must parse
 * against `file_list`, sit on a pending Task, and carry a captured
 * `reopen_baseline` once an attempt has registered; or, once the lineage
 * settled implemented, the scope its tests-only Proof records. Either way the
 * Task must be one a tests-only reopening could scope: no attestation, no
 * Distill Task, no Acceptance Contract writer, regression required. That the
 * scope names a tests-only reopening of this Task and matches the frozen
 * classification is proven against the TaskGraph (`testsOnlyLinkError`).
 */
function taskTestsOnlyScope(
  t: Readonly<Record<string, unknown>>,
  proof: TaskProof,
  task: Readonly<{ id: TaskId; status: TaskStatus; fileList: readonly string[] }>,
  verification: ParsedTaskVerificationPolicy,
  scope: RedThenGreenScope,
  label: string,
): ParseResult<TestsOnlyReading> {
  const refused = (problem: string): ParseResult<TestsOnlyReading> => parseErr(`${label}: ${problem}`);
  const reading = t.reopen_scope !== undefined
    ? liveTestsOnlyScope(t, task.status, task.fileList)
    : settledTestsOnlyScope(task.status, proof, task.fileList);
  if (!reading.ok) return refused(reading.error);
  if (reading.value.scope === null) return reading;
  if (t.implementation_attestation === true) return refused("a tests-only Task cannot be in attestation mode");
  if (isDistillTask(t)) return refused("a Distill Task cannot be reopened for tests only");
  if (writtenContract(scope, task.id) !== undefined) return refused("an Acceptance Contract writer cannot be reopened for tests only");
  if (verification.policy.regression.kind !== "required") return refused("a tests-only Task requires regression verification");
  return reading;
}

/** The tests-only scope a stored Task's Proof was derived under, and the live reopening fields that carry it. */
type TestsOnlyReading = Readonly<{
  scope: TestsOnlyScope | null;
  reopening: Partial<Pick<Task, "reopen_scope" | "reopen_baseline">>;
}>;

/** A pending Task's live `reopen_scope`, with its `reopen_baseline` captured once an attempt registered. */
function liveTestsOnlyScope(
  t: Readonly<Record<string, unknown>>,
  status: TaskStatus,
  fileList: readonly string[],
): ParseResult<TestsOnlyReading> {
  const parsed = fromErrors(parseTestsOnlyScope(t.reopen_scope, fileList, "reopen_scope"));
  if (!parsed.ok) return parsed;
  if (status !== "pending") return parseErr("a tests-only reopen_scope requires pending status; its lineage's settlement ends it");
  const baseline = t.reopen_baseline === undefined ? parseOk(undefined) : fromErrors(parseReopenBaseline(t.reopen_baseline, fileList));
  if (!baseline.ok) return baseline;
  if (baseline.value === undefined && (t.active_implementation_attempt !== undefined || t.attempt_artifact_baseline !== undefined)) {
    return parseErr("a registered tests-only attempt requires its captured reopen_baseline");
  }
  return parseOk({
    scope: parsed.value,
    reopening: { reopen_scope: parsed.value, ...present("reopen_baseline", baseline.value) },
  });
}

/** The scope an implemented or completed Task's settled tests-only Proof records, or null. */
function settledTestsOnlyScope(status: TaskStatus, proof: TaskProof, fileList: readonly string[]): ParseResult<TestsOnlyReading> {
  const settled = status === "implemented" || status === "completed" ? testsOnlyScopeOfProof(proof.obligations) : null;
  return settled === null || partitionsFileList(settled.testFiles, settled.implementationFiles, fileList)
    ? parseOk({ scope: settled, reopening: {} })
    : parseErr("a settled tests-only Proof's test and implementation files must partition file_list in its order");
}

/**
 * Every tests-only scope the Tasks carry or their settled Proofs record,
 * proven against data the scope does not supply (ADR-0093): the audit at its
 * `reopening` position is a `needs: "tests"` reopening of the Task's Wave
 * that named the Task, and its two file lists are exactly the frozen
 * Test-File Classification of the Task's `file_list`. The first violation, or
 * null.
 */
function testsOnlyLinkError(
  tasks: readonly ParsedTask[],
  audits: readonly TaskReopeningAudit[] | undefined,
  manifest: FrozenVerificationManifest | undefined,
): string | null {
  for (const parsed of tasks) {
    const settled = parsed.status === "implemented" || parsed.status === "completed";
    const claimed = parsed.reopen_scope ?? (settled && parsed.proof !== undefined ? testsOnlyScopeOfProof(parsed.proof.obligations) : null);
    if (claimed === null) continue;
    const label = `Task ${parsed.id}: tests-only reopening ${claimed.reopening}`;
    const audit = audits?.[claimed.reopening];
    if (audit === undefined) return `${label} names no task_reopening_history entry`;
    if (reopeningNeedsOf(audit) !== "tests") return `${label} names a reopening that did not record needs "tests"`;
    const named = (ids: readonly string[]) => ids.some((taskId) => taskId === parsed.id);
    if (audit.wave !== parsed.wave || !named(audit.reopenedTaskIds) || named(sweptDistillTaskIdsOf(audit))) {
      return `${label} names a reopening that did not name this Task`;
    }
    const frozen = classifyTestsOnlyScope(parsed.file_list ?? [], manifest, claimed.reopening);
    if (!frozen.ok || !canonicalStructuralEquals(frozen.value, claimed)) {
      return `${label}'s test and implementation files are not the frozen Test-File Classification of its file_list`;
    }
  }
  return null;
}

/** A stored Task's lifecycle arm, and the live tests-only reopening fields its Proof was derived under. */
type StoredLifecycle = Readonly<{
  lifecycle: TaskLifecycle;
  reopening: Partial<Pick<Task, "reopen_scope" | "reopen_baseline">>;
}>;

/**
 * Status, Proof and their exact flat lifecycle invariants. A pending Task
 * stored without a Proof (it carries no reopen_scope: that needs the Proof its
 * scope derives) is given the pending Proof its policy derives.
 */
function parseStoredLifecycle(
  t: Readonly<Record<string, unknown>>,
  label: string,
  id: TaskId,
  shape: StoredTaskShape,
  scope: RedThenGreenScope,
): ParseResult<StoredLifecycle> {
  const parsed = parseStoredTaskStatus(t, label);
  if (!parsed.ok) return parsed;
  const { status, verification } = parsed.value;
  const fileList = shape.file_list ?? [];
  const revalidation = t.revalidation_required === true;
  if (t.reopen_baseline !== undefined && t.reopen_scope === undefined) {
    return parseErr(`${label}: reopen_baseline belongs to a tests-only reopen_scope and cannot stand without one`);
  }
  if (t.proof === undefined) {
    if (t.reopen_scope !== undefined) return parseErr(`${label}: a tests-only reopen_scope requires the Proof its scope derives`);
    if (status !== "pending") return parseErr(`${label}: ${status} lifecycle requires a frozen Proof`);
    const proof = derivePendingTaskProof({
      verificationPolicy: verification.policy,
      declaredArtifacts: fileList,
      ...taskArtifactScope({ agent: shape.agent, implementation_attestation: t.implementation_attestation }),
      redThenGreen: taskRedThenGreenEra(scope, id),
    });
    return parseOk({ lifecycle: revalidation ? { status, proof, revalidation_required: true } : { status, proof }, reopening: {} });
  }
  const proof = fromErrors(parseTaskProof(t.proof));
  if (!proof.ok) return parseErr(`${label}: invalid proof: ${proof.error}`);
  const testsOnly = taskTestsOnlyScope(t, proof.value, { id, status, fileList }, verification, scope, label);
  if (!testsOnly.ok) return testsOnly;
  // The one expectation rule (`taskArtifactScope`): a Distill Task's stored
  // Proof must be exactly task-completed and behaviour-preserved, and a
  // tests-only Task's exactly its scope's.
  const expected = deriveProofObligations({
    verificationPolicy: verification.policy,
    declaredArtifacts: fileList,
    ...(testsOnly.value.scope === null
      ? { declaredArtifactExpectation: taskArtifactExpectation(t) }
      : { testsOnly: testsOnly.value.scope }),
    redThenGreen: taskRedThenGreenEra(scope, id),
  });
  if (!proofObligationsMatch(proof.value.obligations, expected)) {
    return parseErr(`${label}: proof obligations do not exactly match verification policy and file_list`);
  }
  const lifecycle = storedLifecycle(status, proof.value, revalidation, label);
  return lifecycle.ok ? parseOk({ lifecycle: lifecycle.value, reopening: testsOnly.value.reopening }) : lifecycle;
}

const isTaskStatus = (raw: unknown): raw is TaskStatus => (TASK_STATUSES as readonly unknown[]).includes(raw);

/** Status, verification policy, attestation, review status/generation/run and revalidation, each proven alone. */
function parseStoredTaskStatus(
  t: Readonly<Record<string, unknown>>,
  label: string,
): ParseResult<Readonly<{ status: TaskStatus; verification: ParsedTaskVerificationPolicy }>> {
  const { status, implementation_attestation: attestation } = t;
  if (!isTaskStatus(status)) return parseErr(`${label}: status ${JSON.stringify(status)} is not one of ${TASK_STATUSES.join(", ")}`);
  const verification = fromErrors(parseTaskVerificationPolicy(t, label));
  if (!verification.ok) return verification;
  if (attestation !== undefined && attestation !== true) return parseErr(`${label}: implementation_attestation must be true when present`);
  const distillError = taskDistillError(t, label, verification.value);
  if (distillError !== null) return parseErr(distillError);
  const { regression, newTests } = verification.value.policy;
  if (attestation === true && regression.kind !== "required") return parseErr(`${label}: attestation mode requires regression verification`);
  if (attestation === true && newTests.kind !== "waived") {
    return parseErr(`${label}: attestation mode requires a verification policy that waives new tests — the dispatched child must not author new work`);
  }
  const reviewError = storedReviewStateError(t, label);
  if (reviewError !== null) return parseErr(reviewError);
  if (t.revalidation_required !== undefined && t.revalidation_required !== true) {
    return parseErr(`${label}: revalidation_required must be true when present`);
  }
  return t.revalidation_required === true && status !== "pending"
    ? parseErr(`${label}: revalidation_required requires pending status until fresh task evidence is recorded`)
    : parseOk({ status, verification: verification.value });
}

/** Why a stored review status, generation or in-progress run is invalid, or null. */
function storedReviewStateError(t: Readonly<Record<string, unknown>>, label: string): string | null {
  const { review_status: reviewStatus, review_generation: generation, review_run: run } = t;
  if (reviewStatus !== undefined && !(REVIEW_STATUSES as readonly unknown[]).includes(reviewStatus)) {
    return `${label}: review_status ${JSON.stringify(reviewStatus)} is not one of ${REVIEW_STATUSES.join(", ")}`;
  }
  if (generation !== undefined && (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0)) {
    return `${label}: review_generation must be a non-negative safe integer`;
  }
  if (run !== undefined && generation === undefined) return `${label}: review_run requires review_generation`;
  return run !== undefined && reviewStatus !== "pending" && reviewStatus !== "evidence_capture_failed"
    ? `${label}: an in-progress review_run requires pending or evidence_capture_failed status`
    : null;
}

/** Whether stored obligations are exactly the derived ones: same kinds in order, same artifacts and tests-only file sets. */
function proofObligationsMatch(actual: readonly ProofObligation[], expected: readonly ProofObligation[]): boolean {
  return actual.length === expected.length && actual.every((obligation, obligationIndex) => {
    const derived = expected[obligationIndex];
    if (derived === undefined || obligation.kind !== derived.kind) return false;
    if (obligation.kind === "test-files-changed" || obligation.kind === "implementation-files-unchanged") {
      return canonicalStructuralEquals(obligation, derived);
    }
    return obligation.kind === "declared-artifact-changed" || obligation.kind === "declared-artifact-attested"
      ? (derived.kind === "declared-artifact-changed" || derived.kind === "declared-artifact-attested") &&
        obligation.artifact === derived.artifact
      : true;
  });
}

/** The lifecycle arm a status and its stored Proof form: the status/proof lockstep. */
function storedLifecycle(status: TaskStatus, proof: TaskProof, revalidation: boolean, label: string): ParseResult<TaskLifecycle> {
  if (status === "pending" && revalidation) return parseOk({ status, proof, revalidation_required: true });
  if (status === "pending") {
    return proof.state === "satisfied"
      ? parseErr(`${label}: status/proof lockstep violated — pending lifecycle without revalidation cannot carry satisfied Proof`)
      : parseOk({ status, proof });
  }
  if (status === "implemented" || status === "completed") {
    return proof.state === "satisfied"
      ? parseOk({ status, proof })
      : parseErr(`${label}: status/proof lockstep violated — ${status} lifecycle requires satisfied Proof`);
  }
  return proof.state === "failed"
    ? parseOk({ status, proof })
    : parseErr(`${label}: status/proof lockstep violated — failed lifecycle requires failed Proof`);
}

/** The stored test evidence: the new-test observation, then the test result. */
type StoredTaskEvidence = Partial<Pick<Task, "test_result" | "new_test_observation">>;

function parseStoredTaskEvidence(t: Readonly<Record<string, unknown>>, label: string): ParseResult<StoredTaskEvidence> {
  const observation = t.new_test_observation === undefined ? undefined : parseStoredNewTestEvidence(t.new_test_observation);
  if (observation !== undefined && !observation.ok) return parseErr(`${label}: ${observation.error}`);
  const testResult = t.test_result === undefined ? parseOk(undefined) : parseStoredTestResult(t.test_result, label);
  if (!testResult.ok) return testResult;
  return parseOk({
    ...present("test_result", testResult.value),
    ...present("new_test_observation", observation?.value),
  });
}

/** A stored test result. The acceptance DECISION is delegated to parseTaskTestResult —
 *  the ONE validator for the shared TaskTestResult/ProofTestResult union — so
 *  the load boundary can never drift from the proof evaluator on what shape
 *  the persisted field may have. Exact-shape causes pass through verbatim;
 *  older malformed verdicts retain the operator-facing spelling pinned by the
 *  load-guard suite. */
function parseStoredTestResult(raw: unknown, label: string): ParseResult<ProofTestResult> {
  const parsed = parseTaskTestResult(raw, `${label}: test_result`);
  if (parsed.ok) return parseOk(parsed.value);
  const exactShapeError = parsed.errors.find((error) => error.includes("unexpected field(s)"));
  if (exactShapeError !== undefined) return parseErr(exactShapeError);
  if (typeof raw !== "object" || raw === null) return parseErr(`${label}: test_result must be an object`);
  const verdict = isRecord(raw) ? raw.verdict : undefined;
  return verdict === "untrusted"
    ? parseErr(`${label}: untrusted test_result requires a boolean passed and a non-empty label naming the weak source`)
    : parseErr(`${label}: test_result.verdict ${JSON.stringify(verdict)} is not one of trusted-pass, trusted-fail, untrusted`);
}

/** A stored Task's parsed findings, refutations and resolutions, installed once every findings rule holds. */
type StoredFindingsFields = Partial<Pick<Task, "findings" | "refuted_findings" | "resolved_findings">>;

/**
 * Every findings-aggregate rule's refusal for one stored Task, in rule order,
 * and the parsed records when there is none. The records are proven for the
 * same reason every union is: `Task` asserts `readonly Finding[]`, and a panel
 * helper reading an unproven one surfaces as an unhandled TypeError from inside
 * a pure function rather than as a contract diagnostic. Rejected rather than
 * repaired — dropping a malformed entry on every read would silently lose a
 * critical, and `repair-task-graph` is the guarded, atomic repair.
 *
 * The two derived views earn their `readonly string[]` type independently of
 * `findings` (a pre-identity Task carries a view with no array beside it), and
 * then their lockstep with it: a critical present in only one of the two
 * either never blocked the Wave or could never be adjudicated.
 */
function readStoredTaskFindings(
  t: Readonly<Record<string, unknown>>,
  label: string,
): Readonly<{ errors: readonly string[]; fields: StoredFindingsFields }> {
  const findings = parseStoredFindingsField(t.findings, `${label}: findings`);
  const refutations = parseStoredRefutationsField(t.refuted_findings, `${label}: refuted_findings`);
  const resolutions = parseStoredResolutionsField(t.resolved_findings, `${label}: resolved_findings`);
  const runError = reviewRunError(t.review_run, t.review_generation, t.findings, `${label}: review_run`);
  const errors = [
    findings.ok ? null : findings.error,
    findingsViewError(t.critical_findings, `${label}: critical_findings`),
    findingsViewError(t.advisory_findings, `${label}: advisory_findings`),
    findingsLockstepError(t.findings, t.critical_findings, t.advisory_findings, label),
    refutations.ok ? null : refutations.error,
    resolutions.ok ? null : resolutions.error,
    findingIdCollisionError(t.findings, t.refuted_findings, label, t.resolved_findings),
    runError,
    // `reviewRunError` proves the run the slot authority is read against.
    runError === null ? slotAuthorityError(t.review_run, `${label}: review_run.slot_authority`) : null,
    evidenceFailureError(t, label, REVIEW_SUB_AGENTS),
  ].filter((error): error is string => error !== null);
  if (errors.length > 0 || !findings.ok || !refutations.ok || !resolutions.ok) return { errors, fields: {} };
  return {
    errors,
    fields: {
      ...present("findings", findings.value),
      ...present("refuted_findings", refutations.value),
      ...present("resolved_findings", resolutions.value),
    },
  };
}

/** A proven Review Run's engine-owned slot authority: one exact slot per expected agent, in order, under distinct ids. */
function slotAuthorityError(run: unknown, label: string): string | null {
  if (!isRecord(run) || run.slot_authority === undefined) return null;
  const { slot_authority: slots, expected_agents: expectedAgents } = run;
  if (!Array.isArray(slots) || slots.length === 0) return `${label} must be a non-empty array when present`;
  if (!Array.isArray(expectedAgents) || slots.length !== expectedAgents.length) {
    return `${label} must cover every expected agent exactly once in order`;
  }
  const slotIds = new Set<string>();
  for (const [slotIndex, rawSlot] of slots.entries()) {
    const slotLabel = `${label}[${slotIndex}]`;
    const slot = parseAuthoritySlot(rawSlot, slotLabel, expectedAgents[slotIndex], run.reviewer_protocol !== undefined);
    if (!slot.ok) return slot.error;
    if (slotIds.has(slot.value.slotId)) return `${slotLabel}.slot_id duplicates an earlier Review Run slot`;
    slotIds.add(slot.value.slotId);
    if (slot.value.attempted !== 1 && slot.value.attempted !== 2) return `${slotLabel}.attempted must be 1 or 2`;
  }
  return null;
}

/** One slot authority entry's exact field set, agent and slot id. */
function parseAuthoritySlot(
  raw: unknown,
  label: string,
  expectedAgent: unknown,
  current: boolean,
): ParseResult<Readonly<{ slotId: string; attempted: unknown }>> {
  if (!isRecord(raw)) return parseErr(`${label} must be an object`);
  const fields = Object.keys(raw).sort();
  // A current slot a restart carried also names its origin (ADR-0089);
  // `reviewRunError` has already proven that origin and its evidence.
  const currentFields = ["agent", "attempted", "slot_id", "request_id", "context_digest",
    ...(Object.hasOwn(raw, "carried_from") ? ["carried_from"] : [])];
  const expectedFields = (current ? currentFields : ["agent", "attempted", "slot_id"]).sort();
  if (fields.length !== expectedFields.length || fields.some((field, fieldIndex) => field !== expectedFields[fieldIndex])) {
    return parseErr(`${label} must contain exactly agent/slot_id/attempted`);
  }
  if (raw.agent !== expectedAgent) return parseErr(`${label}.agent must match expected_agents in order`);
  const slotId = parseSlotId(raw.slot_id);
  return slotId.ok ? parseOk({ slotId: slotId.value, attempted: raw.attempted }) : parseErr(`${label}.slot_id: ${slotId.error.message}`);
}

/**
 * A stored `spec_anchor_hashes`, parsed before `Task` can assert
 * `Record<string, string>`. Non-string values are corrupt protected authority,
 * not alternate spellings of a hash, so they fail here instead of being
 * rewritten into plausible data.
 */
function parseSpecAnchorHashes(raw: unknown, index: number): ParseResult<Readonly<Record<string, string>> | undefined> {
  if (raw === undefined) return parseOk(undefined);
  if (!isRecord(raw)) {
    return parseErr(`tasks[${index}].spec_anchor_hashes must be a record of strings when present, got ${JSON.stringify(raw)}`);
  }
  const entries = Object.entries(raw);
  const invalid = entries.find(([, value]) => typeof value !== "string");
  if (invalid !== undefined) {
    return parseErr(`tasks[${index}].spec_anchor_hashes[${JSON.stringify(invalid[0])}] must be a string, got ${JSON.stringify(invalid[1])}`);
  }
  const hashes = entries.flatMap(([claim, hash]) => typeof hash === "string" ? [[claim, hash] as const] : []);
  return parseOk(Object.freeze(Object.fromEntries(hashes)));
}

/** The persisted lifecycle fields' every refusal, shared by the loader and operator validator. */
export function taskGraphLifecycleErrors(obj: Record<string, unknown>): readonly string[] {
  const phase = parseCurrentPhase(obj);
  const artifacts = parsePhaseArtifacts(obj);
  const skipped = parseSkippedPhases(obj);
  return [...(phase.ok ? [] : [phase.error]), ...(artifacts.ok ? [] : artifacts.errors), ...(skipped.ok ? [] : [skipped.error])];
}

/** The lifecycle fields, or the first of `taskGraphLifecycleErrors`. */
function parseTaskGraphLifecycle(obj: Readonly<Record<string, unknown>>): ParseResult<TaskGraphLifecycle> {
  const phase = parseCurrentPhase(obj);
  if (!phase.ok) return phase;
  const artifacts = parsePhaseArtifacts(obj);
  if (!artifacts.ok) return parseErr(artifacts.errors[0]);
  const skipped = parseSkippedPhases(obj);
  if (!skipped.ok) return skipped;
  return parseOk({ current_phase: phase.value, phase_artifacts: artifacts.value, skipped_phases: skipped.value });
}

type TaskGraphLifecycle = Pick<TaskGraph, "current_phase" | "phase_artifacts" | "skipped_phases">;

const isPhase = (raw: unknown): raw is Phase => (PHASE_ORDER as readonly unknown[]).includes(raw);

function parseCurrentPhase(obj: Readonly<Record<string, unknown>>): ParseResult<Phase> {
  if (!("current_phase" in obj)) return parseErr("missing current_phase");
  const phase = obj.current_phase;
  return isPhase(phase) ? parseOk(phase) : parseErr(`current_phase ${JSON.stringify(phase)} is not one of ${PHASE_ORDER.join(", ")}`);
}

/** `phase_artifacts`: the artifact path per known phase, or every entry's refusal. */
function parsePhaseArtifacts(obj: Readonly<Record<string, unknown>>):
  | Readonly<{ ok: true; value: TaskGraph["phase_artifacts"] }>
  | Readonly<{ ok: false; errors: NonEmpty<string> }> {
  if (!("phase_artifacts" in obj)) return { ok: false, errors: nonEmptyOf("missing phase_artifacts") };
  if (!isRecord(obj.phase_artifacts)) return { ok: false, errors: nonEmptyOf("phase_artifacts must be an object") };
  const errors: string[] = [];
  const artifacts: (readonly [Phase, string])[] = [];
  for (const [phase, artifact] of Object.entries(obj.phase_artifacts)) {
    if (!isPhase(phase)) errors.push(`phase_artifacts contains unknown phase ${JSON.stringify(phase)}`);
    else if (typeof artifact !== "string") errors.push(`phase_artifacts.${phase} must be a string, got ${JSON.stringify(artifact)}`);
    else artifacts.push([phase, artifact]);
  }
  return isNonEmpty(errors) ? { ok: false, errors } : { ok: true, value: Object.freeze(Object.fromEntries(artifacts)) };
}

/** `skipped_phases`: absent (none), or known phases. */
function parseSkippedPhases(obj: Readonly<Record<string, unknown>>): ParseResult<readonly Phase[]> {
  const skipped = obj.skipped_phases ?? [];
  return Array.isArray(skipped) && skipped.every(isPhase)
    ? parseOk(Object.freeze([...skipped]))
    : parseErr(`skipped_phases must be an array containing only: ${PHASE_ORDER.join(", ")}`);
}

/** The Wave Gate registrations' wire fields. */
type ParsedWaveGateRegistrations = Pick<TaskGraph, "active_wave_gate" | "wave_gate_history">;

/**
 * Parse the active and terminal Wave Gate registrations together.
 *
 * They are validated as a PAIR because the interesting rules are relational: a
 * run cannot be simultaneously active and terminal, terminal Waves cannot
 * overlap or precede the active one, and a nonterminal active registration
 * must agree with the protected phase and wave. Splitting them apart would let
 * each half look individually valid while contradicting the other.
 */
function parseWaveGateRegistrations(
  obj: Record<string, unknown>,
): ParseResult<ParsedWaveGateRegistrations> {
  const active = obj.active_wave_gate === undefined ? parseOk(undefined) : parseActiveWaveGateRegistration(obj.active_wave_gate);
  if (!active.ok) return active;
  const activeWaveGate = active.value;
  const history = parseOptionalLog(
    obj.wave_gate_history,
    "wave_gate_history",
    (entry, label) => labelled(label, parseCompletedWaveGateRegistration(entry)),
    (completed) => waveGateHistoryError(completed, activeWaveGate),
  );
  if (!history.ok) return history;
  const conflict = activeWaveGate?.terminalOutcome === null
    ? nonterminalActiveGateConflict(obj, activeWaveGate, history.value)
    : null;
  return conflict === null
    ? parseOk({
        ...present("active_wave_gate", activeWaveGate),
        ...present("wave_gate_history", history.value),
      })
    : parseErr(conflict);
}

/** Why the terminal registrations repeat a run or a Wave, or hold the active run, or null. */
function waveGateHistoryError(
  completed: readonly CompletedWaveGateRegistration[],
  activeWaveGate: ActiveWaveGateRegistration | undefined,
): string | null {
  const runIds = completed.map(({ runId }) => runId);
  const repeated = repeatedIdentity(runIds, "wave_gate_history contains duplicate run identities") ??
    repeatedIdentity(completed.map(({ wave }) => String(wave)), "wave_gate_history contains duplicate completed Waves");
  if (repeated !== null) return repeated;
  return activeWaveGate !== undefined && runIds.includes(activeWaveGate.runId)
    ? `active_wave_gate run ${activeWaveGate.runId} is already terminal in wave_gate_history`
    : null;
}

function parseWaveReopeningHistory(raw: unknown): ParseResult<readonly WaveReopeningAudit[] | undefined> {
  return parseOptionalLog(raw, "wave_reopening_history", parseWaveReopeningAudit, (audits) => repeatedIdentity(
    audits.map((audit) => `${audit.runId}:${audit.authorityDigest}`),
    "wave_reopening_history contains duplicate authority audits",
  ));
}

/** One completed Wave's review-integrity reopening: its run authority, completion receipt and reopened Tasks. */
function parseWaveReopeningAudit(raw: unknown, label: string): ParseResult<WaveReopeningAudit> {
  if (!isRecord(raw)) return parseErr(`${label} must be an object`);
  const fields = exactFieldsError(raw, ["schemaVersion", "kind", "proofMode", "runId", "wave", "authorityDigest", "completionReceipt", "reopenedTaskIds"], [SWEPT_DISTILL_TASK_IDS_FIELD], label);
  const { proofMode, wave } = raw;
  if (fields !== null || raw.schemaVersion !== 1 || raw.kind !== "completed-wave-reopened-for-review-integrity" ||
      (proofMode !== "modern-exact-workspace-drift" && proofMode !== "legacy-workspace-authority-unverifiable")) {
    return parseErr(fields ?? `${label} has invalid schema, kind, or proof mode`);
  }
  const runId = parseOrchestrationRunId(raw.runId);
  const authorityDigest = parseArtifactDigest(raw.authorityDigest);
  const reopened = parseDistinctTaskIds(raw.reopenedTaskIds, `${label}.reopenedTaskIds`);
  if (!runId.ok || !authorityDigest.ok || typeof wave !== "number" || !Number.isSafeInteger(wave) || wave < 1 ||
      !reopened.ok ||
      typeof raw.completionReceipt !== "object" || raw.completionReceipt === null) {
    return parseErr(`${label} has invalid authority, receipt, or reopened Task ids`);
  }
  const receipt = parseReopenedWaveReceipt(raw.completionReceipt, runId.value);
  if (receipt === null) return parseErr(`${label} has an invalid completion receipt`);
  // The audited Tasks may have left the roster since, so no roster check here.
  const reopenedIds = parseReopenedTaskIds(raw[SWEPT_DISTILL_TASK_IDS_FIELD], label, reopened.value, null);
  if (!reopenedIds.ok) return reopenedIds;
  return parseOk(Object.freeze({ schemaVersion: 1 as const, kind: "completed-wave-reopened-for-review-integrity" as const, proofMode,
    runId: runId.value, wave, authorityDigest: authorityDigest.value, completionReceipt: receipt, ...reopenedIds.value }));
}

/** The protected-state commit receipt a reopened Wave completed under, in its run; null when it is not one. */
function parseReopenedWaveReceipt(raw: unknown, runId: OrchestrationRunId): WaveReopeningAudit["completionReceipt"] | null {
  // A non-record (an array) reads as a receipt with no fields, and so refuses.
  const receipt: Readonly<Record<string, unknown>> = isRecord(raw) ? raw : {};
  const effectId = parseEffectId(receipt.effectId);
  const receiptRunId = parseOrchestrationRunId(receipt.runId);
  const stateDigest = parseArtifactDigest(receipt.stateDigest);
  const committedRevision = receipt.committedRevision;
  if (!effectId.ok || !receiptRunId.ok || !stateDigest.ok || receipt.kind !== "protected-wave-state-committed" ||
      receiptRunId.value !== runId || typeof committedRevision !== "number" ||
      !Number.isSafeInteger(committedRevision) || committedRevision < 1) {
    return null;
  }
  return Object.freeze({ kind: "protected-wave-state-committed" as const, effectId: effectId.value, runId, committedRevision, stateDigest: stateDigest.value });
}

/** An in-flight gate must agree with the protected phase, wave, and history. */
function nonterminalActiveGateConflict(
  obj: Record<string, unknown>,
  activeWaveGate: ActiveWaveGateRegistration,
  waveGateHistory: readonly CompletedWaveGateRegistration[] | undefined,
): string | null {
  if (obj.current_phase !== "execute") {
    return `nonterminal active_wave_gate run ${activeWaveGate.runId} requires current_phase execute, got ${String(obj.current_phase)}`;
  }
  if (obj.current_wave !== activeWaveGate.wave) {
    return `nonterminal active_wave_gate wave ${activeWaveGate.wave} must match protected current_wave ${obj.current_wave ?? "missing"}`;
  }
  const terminalOverlap = waveGateHistory?.find((entry) => entry.wave >= activeWaveGate.wave);
  if (terminalOverlap !== undefined) {
    return `nonterminal active_wave_gate wave ${activeWaveGate.wave} overlaps terminal wave_gate_history ` +
      `Wave ${terminalOverlap.wave} run ${terminalOverlap.runId}; active authority must be newer than terminal history`;
  }
  return null;
}

/** Create a recursively frozen defensive copy of JSON-shaped protected data. */
function frozenJsonCopy<T>(value: T): T {
  return copyFrozenJson(value, new WeakMap()) as T;
}

/**
 * The structural copy behind `frozenJsonCopy`, untyped because it rebuilds a
 * value key by key: the copy has exactly the original's JSON shape, which is
 * what lets `frozenJsonCopy` return it under the original's type.
 */
function copyFrozenJson(value: unknown, copies: WeakMap<object, unknown>): unknown {
  if (typeof value !== "object" || value === null) return value;
  const existing = copies.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    copies.set(value, copy);
    copy.push(...value.map((entry) => copyFrozenJson(entry, copies)));
    return Object.freeze(copy);
  }
  const copy: Record<string, unknown> = {};
  copies.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = copyFrozenJson(entry, copies);
  }
  return Object.freeze(copy);
}

function parseExecutingTaskIds(raw: unknown): ParseResult<readonly TaskId[] | undefined> {
  if (raw === undefined) return parseOk(undefined);
  if (!Array.isArray(raw)) {
    return parseErr("executing_tasks must be an array of distinct canonical Task IDs when present");
  }
  const parsed: TaskId[] = [];
  const seen = new Set<TaskId>();
  for (const entry of raw) {
    const taskId = parseTaskId(entry, "executing_tasks entry");
    if (!taskId.ok || seen.has(taskId.value)) {
      return parseErr("executing_tasks must be an array of distinct canonical Task IDs when present");
    }
    seen.add(taskId.value);
    parsed.push(taskId.value);
  }
  return parseOk(Object.freeze(parsed));
}

/** The document paths and the scalar fields, each optional; the two document paths default to null. */
type TaskGraphScalars = Pick<TaskGraph,
  "spec_file" | "plan_file" | "spec_dir" | "plan_title" | "github_repo" | "updated_at" | "github_issue" | "current_wave">;

function parseTaskGraphScalars(obj: Readonly<Record<string, unknown>>): ParseResult<TaskGraphScalars> {
  const specDir = optionalNullableString(obj, "spec_dir");
  if (!specDir.ok) return specDir;
  const specFile = optionalNullableString(obj, "spec_file");
  if (!specFile.ok) return specFile;
  const planFile = optionalNullableString(obj, "plan_file");
  if (!planFile.ok) return planFile;
  const planTitle = optionalString(obj, "plan_title");
  if (!planTitle.ok) return planTitle;
  const githubRepo = optionalString(obj, "github_repo");
  if (!githubRepo.ok) return githubRepo;
  const updatedAt = optionalString(obj, "updated_at");
  if (!updatedAt.ok) return updatedAt;
  const { github_issue: githubIssue, current_wave: currentWave } = obj;
  if (githubIssue !== undefined && (typeof githubIssue !== "number" || !Number.isInteger(githubIssue) || githubIssue < 1)) {
    return parseErr(`github_issue must be an integer >= 1 when present, got ${JSON.stringify(githubIssue)}`);
  }
  if (currentWave !== undefined && (typeof currentWave !== "number" || !Number.isSafeInteger(currentWave) || currentWave < 1)) {
    return parseErr(`current_wave must be an integer >= 1 within the safe-integer range when present, got ${JSON.stringify(currentWave)}`);
  }
  return parseOk({
    // The order a document path a raw graph omits takes in the loaded one.
    spec_file: specFile.value ?? null,
    plan_file: planFile.value ?? null,
    ...present("spec_dir", specDir.value),
    ...present("plan_title", planTitle.value),
    ...present("github_repo", githubRepo.value),
    ...present("updated_at", updatedAt.value),
    ...present("github_issue", githubIssue),
    ...present("current_wave", currentWave),
  });
}

function optionalNullableString(obj: Readonly<Record<string, unknown>>, field: string): ParseResult<string | null | undefined> {
  const value = obj[field];
  return value === undefined || value === null || typeof value === "string"
    ? parseOk(value)
    : parseErr(`${field} must be a string or null when present, got ${JSON.stringify(value)}`);
}

function optionalString(obj: Readonly<Record<string, unknown>>, field: string): ParseResult<string | undefined> {
  const value = obj[field];
  return value === undefined || typeof value === "string"
    ? parseOk(value)
    : parseErr(`${field} must be a string when present, got ${JSON.stringify(value)}`);
}

/** The raw document without `keys`, every other key kept in order: the fields no section parser installs. */
function withoutKeys(record: Readonly<Record<string, unknown>>, ...keys: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

function parseTaskGraphTasks(
  obj: Record<string, unknown>,
  executingTasks: readonly TaskId[],
  scope: RedThenGreenScope,
): ParseResult<Pick<ParsedTaskGraph, "tasks" | "spec_trace_version">> {
  const tasks = obj.tasks ?? [];
  if (!Array.isArray(tasks)) return parseErr("tasks must be an array");
  const parsedTasks: ParsedTask[] = [];
  for (const [index, raw] of tasks.entries()) {
    const task = parseStoredTask(raw, index, scope);
    if (!task.ok) return task;
    parsedTasks.push(task.value);
  }
  const rosterError = taskRosterError(parsedTasks, executingTasks, obj.wave_plan_edits);
  if (rosterError !== null) return parseErr(rosterError);
  const trace = parseSpecTraceContract(obj.spec_trace_version, parsedTasks);
  if (!trace.ok) return parseErr(specTraceDiagnosticMessages(trace).join("; "));
  const tasksField = { tasks: Object.freeze(parsedTasks) };
  return parseOk(obj.spec_trace_version === 2 ? { ...tasksField, spec_trace_version: 2 } : tasksField);
}

/** The first rule the loaded Tasks break together: distinct ids, one Distill Task per Wave, reservations, dependencies. */
function taskRosterError(
  tasks: readonly ParsedTask[],
  executingTasks: readonly TaskId[],
  wavePlanEdits: unknown,
): string | null {
  const taskIds = tasks.map(({ id }) => id);
  const duplicateTaskId = taskIds.find((id, index) => taskIds.indexOf(id) !== index);
  if (duplicateTaskId !== undefined) return `duplicate task id: ${duplicateTaskId}`;
  const distillWaveError = distillTaskPerWaveError(tasks);
  if (distillWaveError !== null) return distillWaveError;
  const orphanReservation = orphanExecutionReservationError(tasks, executingTasks);
  if (orphanReservation !== null) return orphanReservation;
  const executing = new Set<string>(executingTasks);
  const unreserved = tasks.find((task) => task.active_implementation_attempt !== undefined && !executing.has(task.id));
  if (unreserved !== undefined) return `Task ${unreserved.id}: active_implementation_attempt requires executing_tasks membership`;
  return taskDependencyErrors(tasks, auditedSameWaveEdges(wavePlanEdits))[0] ?? null;
}

function parseTaskGraphWaveGates(obj: Record<string, unknown>): ParseResult<Readonly<Record<string, WaveGate>>> {
  const waveGates = obj.wave_gates ?? {};
  if (!isRecord(waveGates)) {
    return parseErr("wave_gates must be an object");
  }
  const parsed: (readonly [string, WaveGate])[] = [];
  for (const [wave, raw] of Object.entries(waveGates)) {
    // Wave numbers are written as String(wave) with wave >= 1 — canonical
    // decimal, no leading zeros. A key outside that domain ("01", "abc",
    // "-1", "1.0") would load here and persist, even though every writer
    // and reader only ever uses String(wave); reject it at the boundary so
    // the record-key domain matches the type's wave-number semantics.
    if (!/^(0|[1-9]\d*)$/.test(wave) || !Number.isSafeInteger(Number(wave)) || Number(wave) < 1) {
      return parseErr(`wave_gates key must be a canonical positive safe-integer wave number, got ${JSON.stringify(wave)}`);
    }
    const gate = parseWaveGate(raw, wave);
    if (!gate.ok) return gate;
    parsed.push([wave, gate.value]);
  }
  return parseOk(Object.fromEntries(parsed));
}

/** The Wave Gate authority's wire fields: registrations, review epoch and the active Wave's completion suite. */
type TaskGraphAuthority = Pick<TaskGraph, "active_wave_gate" | "wave_gate_history" | "wave_review_epoch" | "active_wave_completion_suite">;

function parseVerificationManifestField(raw: unknown): ParseResult<FrozenVerificationManifest | undefined> {
  if (raw === undefined) return parseOk(undefined);
  const parsed = parseFrozenVerificationManifest(raw);
  return parsed.ok
    ? parseOk(parsed.value)
    : parseErr(`verification_manifest: ${parsed.error.errors.join("; ")}`);
}

/**
 * The engine revision pin (loom#198 Cause 4, `core/engine-revision-pin.ts`):
 * absent on a graph populated before it existed; `self-hosted`; or `pinned`
 * to a runtime revision with its adoptions as an unbroken chain that ends at
 * that revision, each with a bounded reason.
 */
function parseEngineRevisionField(raw: unknown): ParseResult<EngineRevisionPin | undefined> {
  if (raw === undefined) return parseOk(undefined);
  if (!isRecord(raw)) return parseErr("engine_revision must be an object when present");
  const record = raw as Record<string, unknown>;
  if (record.kind === "self-hosted") {
    const fieldsError = exactFieldsError(record, ["schemaVersion", "kind"], [], "engine_revision");
    if (fieldsError !== null) return parseErr(fieldsError);
    return record.schemaVersion === 1
      ? parseOk(Object.freeze({ schemaVersion: 1 as const, kind: "self-hosted" as const }))
      : parseErr("engine_revision has an unsupported schemaVersion");
  }
  if (record.kind !== "pinned") return parseErr("engine_revision.kind must be pinned or self-hosted");
  const fieldsError = exactFieldsError(record, ["schemaVersion", "kind", "revision", "adoptions"], [], "engine_revision");
  if (fieldsError !== null) return parseErr(fieldsError);
  if (record.schemaVersion !== 1) return parseErr("engine_revision has an unsupported schemaVersion");
  if (!isEngineRevision(record.revision)) return parseErr("engine_revision.revision must be a runtime revision (sha256:<64 hex>)");
  if (!Array.isArray(record.adoptions)) return parseErr("engine_revision.adoptions must be an array");
  const adoptions: EngineRevisionAdoption[] = [];
  for (const [index, entry] of record.adoptions.entries()) {
    const label = `engine_revision.adoptions[${index}]`;
    if (!isRecord(entry)) return parseErr(`${label} must be an object`);
    const adoption = entry as Record<string, unknown>;
    const entryFields = exactFieldsError(adoption, ["from", "to", "reason"], [], label);
    if (entryFields !== null) return parseErr(entryFields);
    if (adoption.from !== null && !isEngineRevision(adoption.from)) return parseErr(`${label}.from must be a runtime revision or null`);
    if (!isEngineRevision(adoption.to)) return parseErr(`${label}.to must be a runtime revision`);
    if (adoption.from === adoption.to) return parseErr(`${label} moves the pin nowhere`);
    const reason = adoption.reason;
    if (!isAdoptionReason(reason)) {
      return parseErr(`${label}.reason must be a trimmed non-blank string of at most ${MAX_ENGINE_REVISION_REASON_LENGTH} characters`);
    }
    const previous = adoptions.at(-1);
    if (previous !== undefined && adoption.from !== previous.to) return parseErr(`${label} does not start where the previous adoption ended`);
    adoptions.push(Object.freeze({ from: adoption.from, to: adoption.to, reason }));
  }
  const last = adoptions.at(-1);
  if (last !== undefined && last.to !== record.revision) return parseErr("engine_revision.revision is not where its last adoption ended");
  return parseOk(Object.freeze({
    schemaVersion: 1 as const,
    kind: "pinned" as const,
    revision: record.revision,
    adoptions: Object.freeze(adoptions),
  }));
}

/**
 * What a graph froze before its Tasks are proven: the Verification Manifest,
 * the test-evidence mode bound to it (loom#198; parsed against the manifest it
 * names, so a graph never loads a mode its own manifest cannot run), and the
 * Acceptance Contracts' shape.
 */
function parseFrozenVerificationFields(obj: Record<string, unknown>): ParseResult<Readonly<{
  fields: Pick<TaskGraph, "verification_manifest" | "test_evidence" | "engine_revision">;
  contractShapes: readonly AcceptanceContract[] | undefined;
}>> {
  const verificationManifest = parseVerificationManifestField(obj.verification_manifest);
  if (!verificationManifest.ok) return verificationManifest;
  const testEvidence = parseTestEvidenceField(obj.test_evidence, verificationManifest.value);
  if (!testEvidence.ok) return testEvidence;
  const engineRevision = parseEngineRevisionField(obj.engine_revision);
  if (!engineRevision.ok) return engineRevision;
  const contractShapes = parseAcceptanceContractsShape(obj.acceptance_contracts);
  if (!contractShapes.ok) return contractShapes;
  return parseOk({
    fields: {
      ...present("verification_manifest", verificationManifest.value),
      ...present("test_evidence", testEvidence.value),
      ...present("engine_revision", engineRevision.value),
    },
    contractShapes: contractShapes.value,
  });
}

/** The graph fields the owner check's authority derives from: the contracts
 *  name the Tasks whose stubs owe nothing (`owesInWave`). */
type OwnerStampedGraph = Pick<TaskGraph, "tasks" | "owner_obligations" | "acceptance_contracts">;

function completionRosterConflict(
  receipt: AcceptedWaveCompletionReceipt,
  manifest: FrozenVerificationManifest,
  active: ActiveWaveGateRegistration,
  owner: OwnerCheckAuthority | null,
): string | null {
  const authorized = authorizeWaveCompletionSuite(manifest, active, receipt.workspaceDigest, owner);
  if (!authorized.ok) {
    return `active_wave_completion_suite authority cannot be reconstructed: ${authorized.error.errors.join("; ")}`;
  }
  if (receipt.suiteDigest !== authorized.value.suiteDigest) {
    return "active_wave_completion_suite.suiteDigest does not match verification_manifest authority";
  }
  if (receipt.checks.length !== authorized.value.checks.length) {
    return "active_wave_completion_suite checks must exactly match the verification_manifest roster";
  }
  for (let index = 0; index < authorized.value.checks.length; index += 1) {
    const expected = authorized.value.checks[index];
    const actual = receipt.checks[index];
    if (actual.checkId !== expected.checkId || actual.scope !== expected.scope) {
      return "active_wave_completion_suite checks must exactly match the verification_manifest roster";
    }
    if (actual.outcome.kind !== "observed") {
      return `active_wave_completion_suite check ${actual.checkId} is not an observed success`;
    }
    const reportMatches = expected.reportPolicy.kind === "not-required"
      ? actual.outcome.report.kind === "not-required"
      : actual.outcome.report.kind === "produced" && actual.outcome.report.path === expected.reportPolicy.path;
    if (!reportMatches) {
      return `active_wave_completion_suite check ${actual.checkId} contradicts its manifest report policy`;
    }
  }
  return null;
}

function parseActiveWaveCompletionSuiteField(
  raw: unknown,
  activeWaveGate: ActiveWaveGateRegistration | undefined,
  verificationManifest: FrozenVerificationManifest | undefined,
  stamped: OwnerStampedGraph,
): ParseResult<AcceptedWaveCompletionReceipt | undefined> {
  if (raw === undefined) return parseOk(undefined);
  const parsed = parseAcceptedWaveCompletionReceipt(raw);
  if (!parsed.ok) {
    return parseErr(`active_wave_completion_suite: ${parsed.error.errors.join("; ")}`);
  }
  if (activeWaveGate === undefined || activeWaveGate.terminalOutcome !== null) {
    return parseErr("active_wave_completion_suite requires a nonterminal active_wave_gate");
  }
  const receipt = parsed.value;
  const mismatches = [
    receipt.runId === activeWaveGate.runId ? null : "runId",
    receipt.wave === activeWaveGate.wave ? null : "wave",
    receipt.revision === activeWaveGate.revision ? null : "revision",
    receipt.authorityDigest === activeWaveGate.authorityDigest ? null : "authorityDigest",
  ].filter((field): field is string => field !== null);
  if (mismatches.length > 0) {
    return parseErr(`active_wave_completion_suite must match active_wave_gate: ${mismatches.join(", ")}`);
  }
  if (verificationManifest === undefined) {
    return parseErr("active_wave_completion_suite requires verification_manifest authority");
  }
  if (receipt.manifestDigest !== verificationManifest.manifestDigest) {
    return parseErr("active_wave_completion_suite.manifestDigest must match verification_manifest authority");
  }
  // The owner check joins the roster exactly as the gate authorized it: from the
  // graph's own stamp, for the active Wave (AD-1).
  const owner = ownerCheckAuthorityOf(waveOwnerDuty(stamped, activeWaveGate.wave));
  const rosterConflict = completionRosterConflict(receipt, verificationManifest, activeWaveGate, owner);
  return rosterConflict === null ? parseOk(receipt) : parseErr(rosterConflict);
}

function parseTaskGraphAuthorityFields(
  obj: Record<string, unknown>,
  verificationManifest: FrozenVerificationManifest | undefined,
  stamped: OwnerStampedGraph,
): ParseResult<TaskGraphAuthority> {
  const registrations = parseWaveGateRegistrations(obj);
  if (!registrations.ok) return parseErr(registrations.error);
  const activeWaveGate = registrations.value.active_wave_gate;
  const waveReviewEpoch = parseWaveReviewEpoch(obj.wave_review_epoch);
  if (!waveReviewEpoch.ok) return parseErr(waveReviewEpoch.error);
  if (activeWaveGate !== undefined && waveReviewEpoch.value !== undefined &&
      (waveReviewEpoch.value.runId !== activeWaveGate.runId || waveReviewEpoch.value.wave !== activeWaveGate.wave)) {
    return parseErr(
      `wave_review_epoch must match active_wave_gate run/Wave authority ` +
      `(expected ${activeWaveGate.runId}/Wave ${activeWaveGate.wave})`,
    );
  }
  const documents = waveReviewEpoch.value?.specCheckDocuments;
  if (documents !== undefined &&
      (documents.spec.path !== (obj.spec_file ?? null) || documents.plan.path !== (obj.plan_file ?? null))) {
    return parseErr("wave_review_epoch.specCheckDocuments paths must match spec_file/plan_file authority");
  }
  const activeWaveCompletionSuite = parseActiveWaveCompletionSuiteField(
    obj.active_wave_completion_suite,
    activeWaveGate,
    verificationManifest,
    stamped,
  );
  if (!activeWaveCompletionSuite.ok) return parseErr(activeWaveCompletionSuite.error);
  return parseOk({
    ...registrations.value,
    ...present("wave_review_epoch", waveReviewEpoch.value),
    ...present("active_wave_completion_suite", activeWaveCompletionSuite.value),
  });
}

/** The append-only audit histories' wire fields. */
type TaskGraphHistory = Pick<TaskGraph,
  | "wave_reopening_history" | "task_reopening_history" | "forward_fix_history" | "forward_fix_withdrawals"
  | "retro_records" | "advisory_dispositions" | "orphaned_wave_gate_history" | "spec_trace_wave_gate_retirements"
  | "retired_wave_review_runs" | "spec_trace_amendments" | "spec_amendments" | "wave_plan_edits"
>;

function activeWaveGateRetirementConflict(
  activeWaveGate: ActiveWaveGateRegistration | undefined,
  orphanedHistory: readonly OrphanedWaveGateRetirement[] | undefined,
  specTraceRetirements: readonly SpecTraceWaveGateRetirement[] | undefined,
): string | null {
  if (activeWaveGate === undefined) return null;
  if (orphanedHistory?.some(({ runId }) => runId === activeWaveGate.runId)) {
    return `active_wave_gate run ${activeWaveGate.runId} is already retired in orphaned_wave_gate_history`;
  }
  return specTraceRetirements?.some(({ runId }) => runId === activeWaveGate.runId)
    ? `active_wave_gate run ${activeWaveGate.runId} is already retired for Spec trace v2`
    : null;
}

function specTraceRetirementCollision(
  waveGateHistory: readonly CompletedWaveGateRegistration[] | undefined,
  orphanedHistory: readonly OrphanedWaveGateRetirement[] | undefined,
  specTraceRetirements: readonly SpecTraceWaveGateRetirement[] | undefined,
): string | null {
  const specTraceRunIds = new Set(specTraceRetirements?.map(({ runId }) => runId) ?? []);
  const completedCollision = waveGateHistory?.find(({ runId }) => specTraceRunIds.has(runId));
  if (completedCollision !== undefined) {
    return `Spec trace retired run ${completedCollision.runId} collides with completed wave_gate_history`;
  }
  const orphanedCollision = orphanedHistory?.find(({ runId }) => specTraceRunIds.has(runId));
  return orphanedCollision === undefined
    ? null
    : `Spec trace retired run ${orphanedCollision.runId} collides with orphaned_wave_gate_history`;
}

function activeWaveGateInstallationAuditConflict(
  activeWaveGate: ActiveWaveGateRegistration | undefined,
  orphanedHistory: readonly OrphanedWaveGateRetirement[] | undefined,
): string | null {
  if (activeWaveGate === undefined) return null;
  const installedBy = orphanedHistory?.filter(({ replacementRunId }) => replacementRunId === activeWaveGate.runId) ?? [];
  if (installedBy.length > 1) {
    return `active_wave_gate run ${activeWaveGate.runId} has multiple orphan-recovery installation audits`;
  }
  const audit = installedBy[0];
  if (audit !== undefined && (audit.wave !== activeWaveGate.wave ||
      audit.replacementAuthorityDigest !== activeWaveGate.authorityDigest ||
      activeWaveGate.runsRoot !== audit.runsRoot)) {
    return `active_wave_gate run ${activeWaveGate.runId} contradicts its orphan-recovery installation audit`;
  }
  return null;
}

/**
 * The history fields, then every tests-only scope (live or recorded in a
 * settled Proof) proven against the reopening audit it names and the frozen
 * classification (ADR-0093): the audits are the only independent record of
 * which reopenings were tests-only.
 */
function parseTaskGraphLinkedHistory(
  obj: Record<string, unknown>,
  authority: TaskGraphAuthority,
  tasks: readonly ParsedTask[],
  verificationManifest: FrozenVerificationManifest | undefined,
): ParseResult<TaskGraphHistory> {
  const audits = parseTaskGraphAuditLogs(obj, tasks);
  if (!audits.ok) return audits;
  const retirements = parseTaskGraphRetirementLogs(obj, authority, tasks);
  if (!retirements.ok) return retirements;
  const testsOnlyLink = testsOnlyLinkError(tasks, audits.value.task_reopening_history, verificationManifest);
  return testsOnlyLink === null ? parseOk({ ...audits.value, ...retirements.value }) : parseErr(testsOnlyLink);
}

/** The reopening, plan-edit, Forward Fix, retro and advisory logs, each against the roster it names. */
function parseTaskGraphAuditLogs(obj: Record<string, unknown>, tasks: readonly ParsedTask[]): ParseResult<Pick<TaskGraph,
  | "wave_reopening_history" | "task_reopening_history" | "wave_plan_edits" | "forward_fix_history"
  | "forward_fix_withdrawals" | "retro_records" | "advisory_dispositions"
>> {
  const reopeningHistory = parseWaveReopeningHistory(obj.wave_reopening_history);
  if (!reopeningHistory.ok) return reopeningHistory;
  const taskReopeningHistory = parseTaskReopeningHistory(obj.task_reopening_history, tasks);
  if (!taskReopeningHistory.ok) return taskReopeningHistory;
  const wavePlanEdits = parseWavePlanEdits(obj.wave_plan_edits, tasks);
  if (!wavePlanEdits.ok) return wavePlanEdits;
  const forwardFixHistory = parseForwardFixHistory(obj.forward_fix_history, tasks);
  if (!forwardFixHistory.ok) return forwardFixHistory;
  const forwardFixWithdrawals = parseForwardFixWithdrawals(obj.forward_fix_withdrawals, tasks);
  if (!forwardFixWithdrawals.ok) return forwardFixWithdrawals;
  const retroRecords = parseRetroRecords(obj.retro_records, tasks);
  if (!retroRecords.ok) return retroRecords;
  const advisoryDispositions = parseAdvisoryDispositions(obj.advisory_dispositions);
  if (!advisoryDispositions.ok) return parseErr(advisoryDispositions.error);
  return parseOk({
    ...present("wave_reopening_history", reopeningHistory.value),
    ...present("task_reopening_history", taskReopeningHistory.value),
    ...present("wave_plan_edits", wavePlanEdits.value),
    ...present("forward_fix_history", forwardFixHistory.value),
    ...present("forward_fix_withdrawals", forwardFixWithdrawals.value),
    ...present("retro_records", retroRecords.value),
    ...present("advisory_dispositions", advisoryDispositions.value),
  });
}

/** The Wave Gate retirement and Spec amendment logs, against the registrations they retire and the roster. */
function parseTaskGraphRetirementLogs(
  obj: Record<string, unknown>,
  authority: TaskGraphAuthority,
  tasks: readonly ParsedTask[],
): ParseResult<Pick<TaskGraph,
  | "orphaned_wave_gate_history" | "spec_trace_wave_gate_retirements" | "retired_wave_review_runs"
  | "spec_trace_amendments" | "spec_amendments"
>> {
  const { active_wave_gate: activeWaveGate, wave_gate_history: waveGateHistory } = authority;
  const orphanedHistory = parseOrphanedWaveGateHistory(obj.orphaned_wave_gate_history);
  if (!orphanedHistory.ok) return orphanedHistory;
  const specTraceRetirements = parseSpecTraceWaveGateRetirements(obj.spec_trace_wave_gate_retirements);
  if (!specTraceRetirements.ok) return specTraceRetirements;
  if ((specTraceRetirements.value?.length ?? 0) > 0 && obj.spec_trace_version !== 2) {
    return parseErr("spec_trace_wave_gate_retirements requires spec_trace_version 2");
  }
  const conflict = activeWaveGateRetirementConflict(activeWaveGate, orphanedHistory.value, specTraceRetirements.value) ??
    specTraceRetirementCollision(waveGateHistory, orphanedHistory.value, specTraceRetirements.value) ??
    activeWaveGateInstallationAuditConflict(activeWaveGate, orphanedHistory.value);
  if (conflict !== null) return parseErr(conflict);
  const retiredReviewRuns = parseRetiredWaveReviewRuns(obj.retired_wave_review_runs);
  if (!retiredReviewRuns.ok) return retiredReviewRuns;
  // A retired run's tombstone is gone: the registration that still names it
  // was never retired.
  if (activeWaveGate !== undefined && retiredReviewRuns.value?.some(({ runId }) => runId === activeWaveGate.runId)) {
    return parseErr(`active_wave_gate run ${activeWaveGate.runId} is already in retired_wave_review_runs`);
  }
  const specTraceAmendments = parseSpecTraceAmendments(obj.spec_trace_amendments);
  if (!specTraceAmendments.ok) return specTraceAmendments;
  const specAmendments = parseSpecAmendments(obj.spec_amendments, tasks);
  if (!specAmendments.ok) return specAmendments;
  if ((specTraceAmendments.value?.length ?? 0) > 0 && obj.spec_trace_version !== 2) {
    return parseErr("spec_trace_amendments requires spec_trace_version 2");
  }
  // parseTaskGraphTasks already proved every v2 Task id and trace array.
  const amendmentTraceError = amendmentHistoryError(specTraceAmendments.value, tasks);
  if (amendmentTraceError !== null) return parseErr(amendmentTraceError);
  return parseOk({
    ...present("orphaned_wave_gate_history", orphanedHistory.value),
    ...present("spec_trace_wave_gate_retirements", specTraceRetirements.value),
    ...present("retired_wave_review_runs", retiredReviewRuns.value),
    ...present("spec_trace_amendments", specTraceAmendments.value),
    ...present("spec_amendments", specAmendments.value),
  });
}

function renderWriterProblem(contract: AcceptanceContract, problem: ContractWriterProblem): string {
  switch (problem.kind) {
    case "unwritten":
      return `frozen path '${problem.path}' is not in ${contract.contractTask}'s file_list`;
    case "shared":
      return `frozen path '${problem.path}' is in the file_list of ${problem.taskIds.join(" and ")}; only ${contract.contractTask} may write it`;
    case "split":
      return `frozen paths are written by ${problem.taskIds.join(" and ")}; only ${contract.contractTask} may write them`;
  }
}

/**
 * The persisted contracts' exact shape, which needs no Task: parsed before
 * the Tasks because their writers decide each Task's I6 era (INV-6).
 */
function parseAcceptanceContractsShape(raw: unknown): ParseResult<readonly AcceptanceContract[] | undefined> {
  if (raw === undefined) return parseOk(undefined);
  const parsed = parseAcceptanceContracts(raw);
  return parsed.ok ? parseOk(parsed.value) : parseErr(parsed.error);
}

/**
 * The population stamp (AD-2). Absent stays absent: a graph populated before
 * owner verification owes nothing (FR-004). Present, `[]` included, it is
 * parsed by the owner-verification core beside the obligation's constructor.
 */
function parseOwnerObligationsField(raw: unknown): ParseResult<readonly OwnerObligation[] | undefined> {
  if (raw === undefined) return parseOk(undefined);
  const parsed = parseOwnerObligations(raw);
  return parsed.ok ? parseOk(parsed.value) : parseErr(parsed.error);
}

/**
 * The shape-parsed contracts bound to the roster: each names a Task that
 * exists and is, by the one writer rule, the only Task listing every path the
 * contract freezes; and a freeze names a Wave no earlier than that Task's. A
 * contract whose writer vanished could never be observed RED.
 */
function bindAcceptanceContracts(
  contracts: readonly AcceptanceContract[] | undefined,
  tasks: readonly ParsedTask[],
): ParseResult<readonly AcceptanceContract[] | undefined> {
  if (contracts === undefined) return parseOk(undefined);
  for (const contract of contracts) {
    const writer = tasks.find(({ id }) => id === contract.contractTask);
    if (writer === undefined) {
      return parseErr(`acceptance_contracts ${contract.id}: contract task ${contract.contractTask} is not in tasks`);
    }
    const views = tasks.map((task) => ({
      id: String(task.id),
      file_list: Array.isArray(task.file_list) ? task.file_list.filter((file): file is string => typeof file === "string") : [],
    }));
    const writes = contractWriter(frozenPaths(contract), views);
    if (!writes.ok) {
      return parseErr(`acceptance_contracts ${contract.id}: ${writes.error.map((problem) => renderWriterProblem(contract, problem)).join("; ")}`);
    }
    if (writes.value !== contract.contractTask) {
      return parseErr(`acceptance_contracts ${contract.id}: the frozen paths are written by ${writes.value}, not contract task ${contract.contractTask}`);
    }
    if (contract.freeze.state === "frozen" && typeof writer.wave === "number" && contract.freeze.wave < writer.wave) {
      return parseErr(`acceptance_contracts ${contract.id}: freeze.wave ${contract.freeze.wave} precedes contract task ${contract.contractTask}'s Wave ${writer.wave}`);
    }
  }
  return parseOk(contracts);
}

// ---------------------------------------------------------------------------
// G2 skeletons (AD-4): export_bindings, skeletons, tasks[].skeleton_outcomes
// ---------------------------------------------------------------------------

const EXPORT_BINDING_FIELDS = ["path", "contract", "exports"] as const;
const BOUND_EXPORT_FIELDS = ["name", "alias"] as const;
const SKELETON_RECORD_FIELDS = ["path", "contract", "language", "origin", "engineSha256", "typesSha256", "stale"] as const;
const PATH_OUTCOME_FIELDS = ["path", "outcome"] as const;
const SKELETON_SHA256 = /^[0-9a-f]{64}$/;

/** Exhaustive by construction: a new variant of either union fails to compile here. */
const SKELETON_ORIGINS = {
  spawn: true,
  "contract-stub": true,
  revision: true,
} as const satisfies Record<SkeletonOrigin, true>;
const SKELETON_LANGUAGES = { typescript: true, java: true } as const satisfies Record<SkeletonLanguage, true>;
const UNSUPPORTED_REASONS = {
  "other-extension": true,
  "java-outside-main-root": true,
  "java-invalid-name": true,
  "jvm-non-java": true,
} as const satisfies Record<UnsupportedReason, true>;

const isMember = <K extends string>(members: Readonly<Record<K, true>>, value: unknown): value is K =>
  typeof value === "string" && Object.hasOwn(members, value);

/** An exact record proven field by field, or the first reason it is none. */
function exactRecord(
  raw: unknown,
  required: readonly string[],
  label: string,
): ParseResult<Readonly<Record<string, unknown>>> {
  if (!isRecord(raw)) return parseErr(`${label} must be an object`);
  const fieldsError = exactFieldsError(raw, required, [], label);
  return fieldsError === null ? parseOk(raw) : parseErr(fieldsError);
}

/** A repository path as every State File path is stored: canonical and relative. */
function storedPath(raw: unknown, label: string): ParseResult<string> {
  return fromErrors(parseReviewPath(raw, label));
}

function parseIdentifierField(raw: unknown, label: string): ParseResult<Identifier> {
  if (typeof raw !== "string") return parseErr(`${label} must be a string`);
  const identifier = parseIdentifier(raw);
  return identifier.ok ? parseOk(identifier.value) : parseErr(`${label} '${raw}' is no identifier (${identifier.error})`);
}

function parseBoundExport(raw: unknown, label: string): ParseResult<BoundExport> {
  const fields = exactRecord(raw, BOUND_EXPORT_FIELDS, label);
  if (!fields.ok) return fields;
  const name = parseIdentifierField(fields.value.name, `${label}.name`);
  if (!name.ok) return name;
  const alias = parseIdentifierField(fields.value.alias, `${label}.alias`);
  if (!alias.ok) return alias;
  return parseOk(Object.freeze({ name: name.value, alias: alias.value }));
}

/** The contracts a binding or record may name: the stamped ones freezing a types file. */
const typedContractIds = (contracts: readonly AcceptanceContract[] | undefined): ReadonlySet<string> =>
  new Set((contracts ?? []).filter(({ types }) => types.kind === "file").map(({ id }) => id));

function parseExportBinding(raw: unknown, label: string, typedContracts: ReadonlySet<string>): ParseResult<ExportBinding> {
  const fields = exactRecord(raw, EXPORT_BINDING_FIELDS, label);
  if (!fields.ok) return fields;
  const path = storedPath(fields.value.path, `${label}.path`);
  if (!path.ok) return path;
  const rawContract = fields.value.contract;
  if (typeof rawContract !== "string") return parseErr(`${label}.contract must be a string`);
  const contractId = parseContractId(rawContract);
  if (!contractId.ok) return parseErr(`${label}.contract '${rawContract}' is no contract id CT-<n> (${contractId.error})`);
  const contract = contractId.value;
  if (!typedContracts.has(contract)) {
    return parseErr(`${label} binds '${path.value}' to ${contract}, which is no stamped acceptance contract with a types file`);
  }
  const rawExports = fields.value.exports;
  if (!Array.isArray(rawExports)) return parseErr(`${label}.exports must be a non-empty array`);
  const exports: BoundExport[] = [];
  for (const [index, entry] of rawExports.entries()) {
    const bound = parseBoundExport(entry, `${label}.exports[${index}]`);
    if (!bound.ok) return bound;
    if (exports.some(({ name }) => name === bound.value.name)) {
      return parseErr(`${label} binds the export name '${bound.value.name}' more than once`);
    }
    exports.push(bound.value);
  }
  // The plan grammar's `name-collides-with-alias`, by its one rule: only a
  // TypeScript skeleton imports the alias and declares the name in one scope.
  const [collision] = aliasCollisions(path.value, exports);
  if (collision !== undefined) {
    return parseErr(`${label} binds the export name '${collision}', which is also an alias of the binding (name-collides-with-alias)`);
  }
  // And `alias-collides-with-class`: a Java skeleton imports every alias, so
  // none may be the file's own class name.
  const [classClash] = aliasClassClashes(path.value, exports);
  if (classClash !== undefined) {
    return parseErr(`${label} binds the alias '${classClash}', the Java file's own class name (alias-collides-with-class)`);
  }
  const [first, ...rest] = exports;
  if (first === undefined) return parseErr(`${label}.exports must be a non-empty array`);
  const nonEmpty: NonEmpty<BoundExport> = [first, ...rest];
  // `Object.freeze` types an array as `readonly T[]`, so freeze in place and keep the tuple type.
  Object.freeze(nonEmpty);
  return parseOk(Object.freeze({ path: path.value, contract, exports: nonEmpty }));
}

/**
 * The population stamp, in plan order. Absent stays absent: a graph populated
 * before G2 binds nothing. Present, `[]` included, each binding is an exact
 * record of a canonical path bound once, to a stamped contract (a parsed
 * `ContractId`) that freezes a types file, with distinct validated
 * identifiers and, on a TypeScript path, no export name that is also an alias
 * of the binding (`aliasCollisions`), and on a Java path no alias that is the
 * file's own class name (`aliasClassClashes`).
 */
function parseExportBindingsField(
  raw: unknown,
  contracts: readonly AcceptanceContract[] | undefined,
): ParseResult<readonly ExportBinding[] | undefined> {
  if (raw === undefined) return parseOk(undefined);
  if (!Array.isArray(raw)) return parseErr("export_bindings must be an array");
  const typedContracts = typedContractIds(contracts);
  const bindings: ExportBinding[] = [];
  for (const [index, entry] of raw.entries()) {
    const binding = parseExportBinding(entry, `export_bindings[${index}]`, typedContracts);
    if (!binding.ok) return binding;
    if (bindings.some(({ path }) => path === binding.value.path)) {
      return parseErr(`export_bindings binds '${binding.value.path}' more than once`);
    }
    bindings.push(binding.value);
  }
  return parseOk(Object.freeze(bindings));
}

function parseStale(raw: unknown, label: string): ParseResult<SkeletonRecord["stale"]> {
  if (raw === null) return parseOk(null);
  const fields = exactRecord(raw, ["revision"], label);
  if (!fields.ok) return fields;
  const revision = fields.value.revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 1
    ? parseOk(Object.freeze({ revision }))
    : parseErr(`${label}.revision must be a positive safe integer, got ${JSON.stringify(revision)}`);
}

function parseDigestField(raw: unknown, label: string): ParseResult<string> {
  return typeof raw === "string" && SKELETON_SHA256.test(raw)
    ? parseOk(raw)
    : parseErr(`${label} must be a lowercase SHA-256 digest, got ${JSON.stringify(raw)}`);
}

/**
 * One engine-written skeleton record. Its path is a stamped binding's, under
 * that binding's contract, and its language is the one `skeletonLanguageOf`
 * (INV-6) gives the path — a record of an unsupported path describes a file
 * the engine never writes.
 */
function parseSkeletonRecord(raw: unknown, label: string, bindings: readonly ExportBinding[]): ParseResult<SkeletonRecord> {
  const fields = exactRecord(raw, SKELETON_RECORD_FIELDS, label);
  if (!fields.ok) return fields;
  const { contract, language, origin } = fields.value;
  const path = storedPath(fields.value.path, `${label}.path`);
  if (!path.ok) return path;
  if (typeof contract !== "string") return parseErr(`${label}.contract must be a string`);
  if (!isMember(SKELETON_LANGUAGES, language)) return parseErr(`${label}.language must be typescript or java, got ${JSON.stringify(language)}`);
  if (!isMember(SKELETON_ORIGINS, origin)) return parseErr(`${label}.origin must be spawn, contract-stub or revision, got ${JSON.stringify(origin)}`);
  const engineSha256 = parseDigestField(fields.value.engineSha256, `${label}.engineSha256`);
  if (!engineSha256.ok) return engineSha256;
  const typesSha256 = parseDigestField(fields.value.typesSha256, `${label}.typesSha256`);
  if (!typesSha256.ok) return typesSha256;
  const stale = parseStale(fields.value.stale, `${label}.stale`);
  if (!stale.ok) return stale;
  const binding = bindings.find((candidate) => candidate.path === path.value);
  if (binding === undefined) return parseErr(`${label} records '${path.value}', which export_bindings has not bound`);
  if (binding.contract !== contract) {
    return parseErr(`${label} records '${path.value}' under ${contract}, but export_bindings binds it to ${binding.contract}`);
  }
  const target = skeletonLanguageOf(path.value);
  if (target.kind === "unsupported") return parseErr(`${label} records '${path.value}', which is no skeleton target (${target.reason})`);
  if (target.language !== language) return parseErr(`${label} records '${path.value}' as ${language}, but the path is ${target.language}`);
  return parseOk(Object.freeze({
    path: path.value,
    contract,
    language,
    origin,
    engineSha256: engineSha256.value,
    typesSha256: typesSha256.value,
    stale: stale.value,
  }));
}

/**
 * The engine-written skeleton records (FR-031), sorted by path with no path
 * twice (strictly ascending by code unit). Absent stays absent: none written.
 */
function parseSkeletonsField(
  raw: unknown,
  bindings: readonly ExportBinding[] | undefined,
): ParseResult<readonly SkeletonRecord[] | undefined> {
  if (raw === undefined) return parseOk(undefined);
  if (!Array.isArray(raw)) return parseErr("skeletons must be an array");
  const records: SkeletonRecord[] = [];
  for (const [index, entry] of raw.entries()) {
    const record = parseSkeletonRecord(entry, `skeletons[${index}]`, bindings ?? []);
    if (!record.ok) return record;
    const previous = records.at(-1);
    if (previous !== undefined && !(previous.path < record.value.path)) {
      return parseErr(`skeletons must be sorted by path with no path twice: '${record.value.path}' follows '${previous.path}'`);
    }
    records.push(record.value);
  }
  return parseOk(Object.freeze(records));
}

function parseSkeletonOutcome(raw: unknown, label: string): ParseResult<SkeletonOutcome> {
  if (!isRecord(raw)) return parseErr(`${label} must be an object`);
  const exact = (required: readonly string[], outcome: SkeletonOutcome): ParseResult<SkeletonOutcome> => {
    const fieldsError = exactFieldsError(raw, required, [], label);
    return fieldsError === null ? parseOk(Object.freeze(outcome)) : parseErr(fieldsError);
  };
  switch (raw.kind) {
    case "skeleton-written":
      return isMember(SKELETON_ORIGINS, raw.origin)
        ? exact(["kind", "origin"], { kind: "skeleton-written", origin: raw.origin })
        : parseErr(`${label}.origin must be spawn, contract-stub or revision, got ${JSON.stringify(raw.origin)}`);
    case "unsupported-language":
      return isMember(UNSUPPORTED_REASONS, raw.reason)
        ? exact(["kind", "reason"], { kind: "unsupported-language", reason: raw.reason })
        : parseErr(`${label}.reason is no unsupported-language reason, got ${JSON.stringify(raw.reason)}`);
    case "no-bound-exports":
      return exact(["kind"], { kind: "no-bound-exports" });
    case "contract-has-no-types-file":
      return exact(["kind"], { kind: "contract-has-no-types-file" });
    case "exists-not-skeletonized":
      return exact(["kind"], { kind: "exists-not-skeletonized" });
    case "absent-no-skeleton-owed":
      return exact(["kind"], { kind: "absent-no-skeleton-owed" });
    default:
      return parseErr(`${label}.kind is no skeleton outcome, got ${JSON.stringify(raw.kind)}`);
  }
}

/**
 * A Task's recorded skeleton outcomes (FR-030): one outcome ADT per path, each
 * path in the Task's own file_list. Absent stays absent: not yet registered.
 * Each outcome is checked against the graph's stamp and records once both are
 * parsed (`recordedOutcomesError`).
 */
function parseSkeletonOutcomesField(
  raw: unknown,
  fileList: unknown,
  label: string,
): ParseResult<readonly PathSkeletonOutcome[] | undefined> {
  if (raw === undefined) return parseOk(undefined);
  if (!Array.isArray(raw)) return parseErr(`${label} must be an array`);
  const declared = Array.isArray(fileList) ? fileList : [];
  const outcomes: PathSkeletonOutcome[] = [];
  for (const [index, entry] of raw.entries()) {
    const entryLabel = `${label}[${index}]`;
    const fields = exactRecord(entry, PATH_OUTCOME_FIELDS, entryLabel);
    if (!fields.ok) return fields;
    const path = storedPath(fields.value.path, `${entryLabel}.path`);
    if (!path.ok) return path;
    if (!declared.includes(path.value)) return parseErr(`${entryLabel} records '${path.value}', which is not in the Task's file_list`);
    if (outcomes.some((recorded) => recorded.path === path.value)) {
      return parseErr(`${label} records '${path.value}' more than once`);
    }
    const outcome = parseSkeletonOutcome(fields.value.outcome, `${entryLabel}.outcome`);
    if (!outcome.ok) return outcome;
    outcomes.push(Object.freeze({ path: path.value, outcome: outcome.value }));
  }
  return parseOk(Object.freeze(outcomes));
}

/** The graph's G2 fields. */
type TaskGraphSkeletons = Pick<TaskGraph, "export_bindings" | "skeletons">;

/**
 * Why one recorded outcome contradicts the graph's stamp and records, or
 * null. Registration derives every outcome from the stamp and records it
 * commits in the same update, and nothing but re-population (which resets
 * the outcomes) changes a binding or removes a record, so each outcome kind
 * pins what the graph must hold for its path:
 * - `skeleton-written` has its record in `skeletons` (whose origin a later
 *   Contract Revision may change, so the origins are not compared);
 * - `unsupported-language` is bound, and `skeletonLanguageOf` (INV-6) gives
 *   the path exactly that reason;
 * - `no-bound-exports` and `contract-has-no-types-file` are unbound;
 * - `absent-no-skeleton-owed` is bound at a skeleton target, on a Task that
 *   holds no Skeleton (`TaskRolePolicy.holdsSkeletons`): a holder of such a
 *   path is written one.
 */
function recordedOutcomeConflict(
  { path, outcome }: PathSkeletonOutcome,
  fields: Readonly<{ exportBindings: readonly ExportBinding[]; skeletons: readonly SkeletonRecord[]; holdsSkeletons: boolean }>,
): string | null {
  const binding = fields.exportBindings.find((candidate) => candidate.path === path);
  switch (outcome.kind) {
    case "skeleton-written":
      return fields.skeletons.some((record) => record.path === path)
        ? null
        : `records '${path}' as skeleton-written, but skeletons holds no record of it`;
    case "unsupported-language": {
      if (binding === undefined) return `records '${path}' as unsupported-language, but export_bindings does not bind it`;
      const target = skeletonLanguageOf(path);
      if (target.kind === "supported") return `records '${path}' as unsupported-language, but the path is a ${target.language} skeleton target`;
      return target.reason === outcome.reason
        ? null
        : `records '${path}' as unsupported-language (${outcome.reason}), but the path is unsupported as ${target.reason}`;
    }
    case "no-bound-exports":
    case "contract-has-no-types-file":
      return binding === undefined ? null : `records '${path}' as ${outcome.kind}, but export_bindings binds it to ${binding.contract}`;
    case "exists-not-skeletonized":
      return null;
    case "absent-no-skeleton-owed":
      if (fields.holdsSkeletons) return `records '${path}' as absent-no-skeleton-owed, but the Task holds its own Skeletons`;
      if (binding === undefined) return `records '${path}' as absent-no-skeleton-owed, but export_bindings does not bind it`;
      return skeletonLanguageOf(path).kind === "supported"
        ? null
        : `records '${path}' as absent-no-skeleton-owed, but the path is no skeleton target`;
  }
}

/**
 * Every Task's recorded skeleton outcomes against the graph's G2 fields: a
 * graph with no `export_bindings` stamp was populated before G2 and records
 * no outcome, and each outcome agrees with the stamp and records
 * (`recordedOutcomeConflict`).
 */
function recordedOutcomesError(tasks: readonly ParsedTask[], fields: TaskGraphSkeletons): string | null {
  for (const [index, task] of tasks.entries()) {
    const outcomes = task.skeleton_outcomes;
    if (outcomes === undefined) continue;
    const label = `${taskLabel(index, task.id)}.skeleton_outcomes`;
    if (fields.export_bindings === undefined) {
      return `${label} is recorded, but the TaskGraph has no export_bindings stamp; a graph populated before G2 records no skeleton outcome`;
    }
    const stamped = {
      exportBindings: fields.export_bindings,
      skeletons: fields.skeletons ?? [],
      holdsSkeletons: taskRolePolicy(task).holdsSkeletons,
    };
    for (const [entry, recorded] of outcomes.entries()) {
      const conflict = recordedOutcomeConflict(recorded, stamped);
      if (conflict !== null) return `${label}[${entry}] ${conflict}`;
    }
  }
  return null;
}

/** The graph's G2 fields, bound to its stamped contracts, and every Task's recorded outcomes checked against them. */
function parseTaskGraphSkeletonFields(
  obj: Record<string, unknown>,
  contracts: readonly AcceptanceContract[] | undefined,
  tasks: readonly ParsedTask[],
): ParseResult<TaskGraphSkeletons> {
  const exportBindings = parseExportBindingsField(obj.export_bindings, contracts);
  if (!exportBindings.ok) return exportBindings;
  const skeletons = parseSkeletonsField(obj.skeletons, exportBindings.value);
  if (!skeletons.ok) return skeletons;
  const fields: TaskGraphSkeletons = { ...present("export_bindings", exportBindings.value), ...present("skeletons", skeletons.value) };
  // parseTaskGraphTasks already proved each Task's outcomes against its own file_list.
  const outcomesError = recordedOutcomesError(tasks, fields);
  return outcomesError === null ? parseOk(fields) : parseErr(outcomesError);
}

/** A loaded Task: its id is a parsed `TaskId`. */
export type ParsedTask = Task & Readonly<{ id: TaskId }>;
/** A loaded TaskGraph: every Task and execution reservation names a parsed `TaskId`. */
export type ParsedTaskGraph = Omit<TaskGraph, "tasks" | "executing_tasks"> & Readonly<{
  tasks: readonly ParsedTask[];
  executing_tasks?: readonly TaskId[];
}>;

/** The document fields: lifecycle, document paths and scalars, and the observations of the documents. */
type TaskGraphDocuments = TaskGraphLifecycle & TaskGraphScalars &
  Pick<TaskGraph, "spec_index_observation" | "proof_boundary_observation" | "plan_design_review">;

function parseTaskGraphDocumentFields(obj: Record<string, unknown>): ParseResult<TaskGraphDocuments> {
  const lifecycle = parseTaskGraphLifecycle(obj);
  if (!lifecycle.ok) return lifecycle;
  const scalars = parseTaskGraphScalars(obj);
  if (!scalars.ok) return scalars;
  const specIndexObservation = obj.spec_index_observation === undefined
    ? parseOk<SpecIndexObservation | undefined>(undefined)
    : parseSpecIndexObservation(obj.spec_index_observation);
  if (!specIndexObservation.ok) return parseErr(specIndexObservation.error);
  if (specIndexObservation.value !== undefined &&
      specIndexObservationPath(specIndexObservation.value) !== scalars.value.spec_file) {
    return parseErr("spec_index_observation path must match protected spec_file authority");
  }
  // Legacy graphs predate the observation; absence stays absent (unknown).
  const proofBoundaryObservation = obj.proof_boundary_observation === undefined
    ? undefined
    : parseProofBoundaryObservation(obj.proof_boundary_observation);
  if (proofBoundaryObservation !== undefined && !proofBoundaryObservation.ok) {
    return parseErr(proofBoundaryObservation.error);
  }
  // A graph initialized before the plan design review carries no record;
  // absence stays absent and the gate reads it as not required.
  const planDesignReview = obj.plan_design_review === undefined
    ? undefined
    : parsePlanDesignReview(obj.plan_design_review);
  if (planDesignReview !== undefined && !planDesignReview.ok) return parseErr(planDesignReview.error);
  return parseOk({
    // The order a field a raw graph omits takes in the loaded one.
    phase_artifacts: lifecycle.value.phase_artifacts,
    skipped_phases: lifecycle.value.skipped_phases,
    ...scalars.value,
    current_phase: lifecycle.value.current_phase,
    ...present("spec_index_observation", specIndexObservation.value),
    ...present("proof_boundary_observation", proofBoundaryObservation?.value),
    ...present("plan_design_review", planDesignReview?.value),
  });
}

/** The Wave Gates, after an UNKNOWN spec-check's block migration, and the spec-check record. */
type TaskGraphGating = Pick<TaskGraph, "wave_gates" | "spec_check">;

/**
 * Parse the wave gates and spec-check, migrate an UNKNOWN spec-check's block,
 * then prove every remaining `blocked: true` gate has a cause.
 */
function parseTaskGraphGating(
  obj: Record<string, unknown>,
  tasks: readonly ParsedTask[],
): ParseResult<TaskGraphGating> {
  const waveGates = parseTaskGraphWaveGates(obj);
  if (!waveGates.ok) return waveGates;
  const specCheck = parseSpecCheckField(obj.spec_check);
  if (!specCheck.ok) return parseErr(specCheck.error);
  const rawSpecCheck = isRecord(obj.spec_check) ? obj.spec_check : null;
  // UNKNOWN was a captured-count state. Its migration deliberately discards
  // those unusable counts, so reconcile the old spec-check-only block from the
  // migrated evidence before enforcing the no-causeless-block invariant.
  const migratedWaveGates = rawSpecCheck?.verdict === "UNKNOWN" && specCheck.value !== undefined
    ? reconcileWaveBlock(waveGates.value, tasks, specCheck.value, specCheck.value.wave)
    : waveGates.value;
  const blockedCauseError = blockedGateCauseError(migratedWaveGates, tasks, specCheck.value);
  if (blockedCauseError !== null) return parseErr(blockedCauseError);
  // A fresh recursively frozen copy, never an alias of parsed JSON: a caller
  // retaining the raw object cannot mutate a Wave Gate and bypass
  // StateManager.update's locked transform.
  return parseOk({ wave_gates: frozenJsonCopy(migratedWaveGates), ...present("spec_check", specCheck.value) });
}

/** What the graph owes: its bound Acceptance Contracts and its stamped Owner Obligations. */
function parseTaskGraphObligationFields(
  obj: Record<string, unknown>,
  contractShapes: readonly AcceptanceContract[] | undefined,
  tasks: readonly ParsedTask[],
): ParseResult<Pick<TaskGraph, "acceptance_contracts" | "owner_obligations">> {
  const acceptanceContracts = bindAcceptanceContracts(contractShapes, tasks);
  if (!acceptanceContracts.ok) return acceptanceContracts;
  const ownerObligations = parseOwnerObligationsField(obj.owner_obligations);
  if (!ownerObligations.ok) return ownerObligations;
  return parseOk({
    ...present("acceptance_contracts", acceptanceContracts.value),
    ...present("owner_obligations", ownerObligations.value),
  });
}

/** Task fields only an engine older than the current shapes wrote (ADR-0098). */
const LEGACY_TASK_FIELDS = [
  "legacy_execution_reservation",
  "legacy_missing_proof",
  "new_tests_written",
  "new_test_evidence",
  "unresolved_repository_paths",
] as const;

/**
 * The first State File shape no current writer produces, or null (ADR-0098).
 * Executing without an attempt predates attempt authority; an implemented or
 * completed Task without a Proof predates frozen Proof; an executing graph
 * without a manifest, and a terminal Wave Gate archived without a completion
 * suite, predate the Verification Manifest. Earlier phases carry no manifest
 * legitimately: population freezes it in the write that enters `execute`.
 */
function legacyStateFileShape(obj: Record<string, unknown>): string | null {
  if (obj.current_phase === "execute" && obj.verification_manifest === undefined) {
    return "an execute-phase TaskGraph without verification_manifest";
  }
  const history: readonly unknown[] = Array.isArray(obj.wave_gate_history) ? obj.wave_gate_history : [];
  const unsuited = history.filter(isRecord).find((entry) => entry.schemaVersion === 1);
  if (unsuited !== undefined) {
    return `a schema-1 wave_gate_history entry (Wave ${JSON.stringify(unsuited.wave)} completed without a completion suite)`;
  }
  const executing: readonly unknown[] = Array.isArray(obj.executing_tasks) ? obj.executing_tasks : [];
  const tasks: readonly unknown[] = Array.isArray(obj.tasks) ? obj.tasks : [];
  for (const task of tasks.filter(isRecord)) {
    const id = JSON.stringify(task.id);
    const field = LEGACY_TASK_FIELDS.find((name) => task[name] !== undefined);
    if (field !== undefined) return `Task ${id} carrying ${field}`;
    if (executing.includes(task.id) && task.active_implementation_attempt === undefined) {
      return `Task ${id} in executing_tasks without active_implementation_attempt`;
    }
    if ((task.status === "implemented" || task.status === "completed") && task.proof === undefined) {
      return `${task.status} Task ${id} without a frozen proof`;
    }
  }
  return null;
}

/** The operator message for a refused legacy shape: what it is, and the way forward. */
function legacyStateFileRefusal(shape: string): string {
  return `legacy State File refused (ADR-0098): ${shape}. This engine no longer migrates State Files ` +
    "written before attempt authority, frozen Proof and the Verification Manifest. Finish the run on the " +
    "engine release that wrote it, or move the State File aside and run /loom again from its spec and plan " +
    "to re-populate the TaskGraph.";
}

/**
 * Parse raw disk JSON into a TaskGraph, mirroring parseMachine: every
 * union-typed field (current_phase, task status / review_status /
 * test_result.verdict) is PROVEN in the union, so a drifted or hand-edited
 * value fails loudly at the load boundary instead of exploding later inside an
 * `.exhaustive()` match (testResultPassed) or silently flowing through typed
 * gate logic. Each section parser returns its TaskGraph fields under their
 * wire names; the graph is the raw document with every section's parsed
 * fields installed over it. Unknown extra fields pass through untouched
 * (legacyTestsPassedNote still fires downstream); missing tasks/wave_gates
 * default for early phases (populated in Phase 4).
 */
export function parseTaskGraph(raw: unknown): ParseResult<ParsedTaskGraph> {
  if (!isRecord(raw)) return parseErr("not an object");
  const obj = raw;
  const legacyShape = legacyStateFileShape(obj);
  if (legacyShape !== null) return parseErr(legacyStateFileRefusal(legacyShape));
  const documents = parseTaskGraphDocumentFields(obj);
  if (!documents.ok) return documents;
  const executingTasks = parseExecutingTaskIds(obj.executing_tasks);
  if (!executingTasks.ok) return executingTasks;
  // The frozen manifest and the contracts' shape are parsed before the Tasks:
  // the manifest decides the graph's I6 era and the contracts name the
  // writers it exempts, and so which obligations each stored Proof must carry
  // (INV-6). The contracts are bound to the roster once the Tasks are proven.
  const frozen = parseFrozenVerificationFields(obj);
  if (!frozen.ok) return frozen;
  const { fields: verification, contractShapes } = frozen.value;
  const manifest = verification.verification_manifest;
  const tasks = parseTaskGraphTasks(obj, executingTasks.value ?? [], redThenGreenScope(manifest, contractShapes ?? []));
  if (!tasks.ok) return tasks;
  const gating = parseTaskGraphGating(obj, tasks.value.tasks);
  if (!gating.ok) return gating;
  const obligations = parseTaskGraphObligationFields(obj, contractShapes, tasks.value.tasks);
  if (!obligations.ok) return obligations;
  const skeletons = parseTaskGraphSkeletonFields(obj, obligations.value.acceptance_contracts, tasks.value.tasks);
  if (!skeletons.ok) return skeletons;
  const authority = parseTaskGraphAuthorityFields(obj, manifest, { tasks: tasks.value.tasks, ...obligations.value });
  if (!authority.ok) return authority;
  const history = parseTaskGraphLinkedHistory(obj, authority.value, tasks.value.tasks, manifest);
  if (!history.ok) return history;
  return parseOk({
    // `test_evidence` and `engine_revision` are installed only as their parsed
    // values, after the fields a raw graph may omit.
    ...withoutKeys(obj, "test_evidence", "engine_revision"),
    ...documents.value,
    ...tasks.value,
    ...present("executing_tasks", executingTasks.value),
    ...gating.value,
    ...verification,
    ...authority.value,
    ...history.value,
    ...obligations.value,
    ...skeletons.value,
  });
}
