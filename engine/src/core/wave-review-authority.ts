import { sha256Hex } from "./review-packet";
import type {
  Finding,
  Task,
  TaskGraph,
  WaveSpecCheckDocumentAuthority,
  WaveReviewEpochAuthority,
  WaveSpecCheckDocumentsAuthority,
} from "../types";
export type { WaveSpecCheckDocumentAuthority, WaveSpecCheckDocumentsAuthority } from "../types";
import { parseStoredFindings } from "./findings";
import {
  parseTaskProof,
  parseTaskTestResult,
  type ProofTestResult,
  type TaskProof,
} from "./proof-obligations";
import { buildContextPacket, buildReviewerContextPacket, encodeByteSection, type ContextPacket } from "./context-packets";
import { parseReviewerProtocolDescriptor, type ReviewerProtocolDescriptor } from "./reviewer-contract";
import { lowerModelProfile, resolveAgentPolicy, resolveModelProfile, WAVE_REVIEW_AGENTS } from "./model-profiles";
import {
  canonicalRecord,
  parseAgentRequestAuthority,
  parseArtifactDigest,
  canonicalStructuralEquals,
  parseOrchestrationRunId,
  parseRequestId,
  parseSlotId,
  type ArtifactDigest,
  type DomainResult,
  type InitialSpawnRequestInput,
  type OrchestrationRunId,
} from "./orchestration-contract";
import type { ReviewedWorkspaceObservation } from "./reviewed-workspace";
import {
  projectRequirementCoverage,
  renderRequirementCoverage,
  settledFloorOf,
  unprojectedFloor,
  specIndexDigest,
  specIndexPath,
  type CoverageTask,
  type RecordedHash,
  type SettledFloor,
  type SpecIndexAvailability,
} from "./requirement-coverage";
export type { SpecIndexAvailability } from "./requirement-coverage";
import { parseSpecContentHash } from "./parse-spec";

/**
 * One spec-check observation: the serializable document authority together with
 * the Spec Index projected from the very bytes its digest names.
 *
 * The shell produces both from a single read. `prepareWaveReviewBatch` proves
 * byte pairing for both successful and failed parses: every bytes-backed Spec
 * Index outcome carries the digest compared with document authority. Only
 * no-byte outcomes remain digest-less. Declared where the consumer lives and
 * re-exported by the shell producer so the contract has exactly one owner.
 */
export type WaveSpecCheckObservation = Readonly<{
  authority: WaveSpecCheckDocumentsAuthority;
  specIndex: SpecIndexAvailability;
}>;

export type WaveReviewRegistrationAuthority = Readonly<{
  kind: "wave-gate";
  input: Readonly<{ wave: number }>;
  taskIds: readonly string[];
  authorityDigest: string;
  restart?: Readonly<{ previousRunId: string; exhaustedSlots: readonly string[] }>;
  orphanRecovery?: Readonly<{ previousRunId: string; previousAuthorityDigest: string }>;
}> & (Readonly<{ schemaVersion: 1; reviewerProtocol?: never }> |
  Readonly<{ schemaVersion: 2; reviewerProtocol: ReviewerProtocolDescriptor }>);

/** Exact protected snapshot identity used by publication and locked install. */
export function waveGateAuthorityDigest(
  wave: number,
  taskIds: readonly string[],
  graph: TaskGraph,
): string {
  return sha256Hex(JSON.stringify({ wave, taskIds, graph }));
}

export type WaveTaskRunAuthority = Readonly<{
  taskId: string;
  generation: number;
  packetId: ArtifactDigest;
  /** Existing batch epoch identity for reviewer-slot authority. */
  headSha: ArtifactDigest;
  /** Exact declared-workspace byte snapshot for completion integrity. */
  workspaceHeadSha?: ArtifactDigest;
}>;

export type WaveRequestBatch = Readonly<{
  batchEpoch: ArtifactDigest;
  specCheckDocuments: WaveSpecCheckDocumentsAuthority;
  /** The floor derived from the exact projection rendered into this batch's packet. */
  settledFloor: SettledFloor;
  requests: readonly InitialSpawnRequestInput[];
  packets: readonly ContextPacket[];
  taskRuns: readonly WaveTaskRunAuthority[];
}>;

export type WaveSpecCheckTaskAuthority = Readonly<{
  id: string;
  description: string;
  completionAnchors: readonly string[];
  contributions: readonly string[];
  declaredFiles: readonly string[];
  /** What the Task actually touched. Distinct from `declaredFiles`: declaring
   * nothing is a decompose defect, modifying nothing is an implementation
   * defect, and the Requirement Coverage Projection reports them separately. */
  modifiedFiles: readonly string[];
}>;

export type WaveReviewPreparationError = Readonly<{
  kind: "wave-review-preparation-rejected";
  message: string;
}>;

const failure = (message: string): DomainResult<WaveRequestBatch, WaveReviewPreparationError> =>
  canonicalRecord({ ok: false, error: canonicalRecord({ kind: "wave-review-preparation-rejected", message }) });

type WaveReviewContextBase = Readonly<{
  runId: OrchestrationRunId;
  wave: number;
  authorityDigest: ArtifactDigest;
  batchEpoch: ArtifactDigest;
  specFile: string | null;
  planFile: string | null;
  /** Null only for contexts published before byte-bound spec-check authority. */
  specCheckDocuments: WaveSpecCheckDocumentsAuthority | null;
}>;

export type WaveReviewTaskAuthority = Readonly<{
  id: string;
  description: string;
  agent: string;
  reviewGeneration: number;
  planContext: string | null;
  specAnchors: readonly string[];
  specContributions: readonly string[];
  declaredFiles: readonly string[];
  modifiedFiles: readonly string[];
  proof: TaskProof | null;
  testResult: ProofTestResult | null;
  priorFindings: readonly Finding[];
}>;

export type WaveReviewContextAuthority =
  | Readonly<WaveReviewContextBase & {
      subject: Readonly<{ role: "spec-check-invoker"; taskId: null }>;
      taskRun: null;
      task: null;
      specCheckScope: readonly WaveSpecCheckTaskAuthority[];
      packetId: null;
    }>
  | Readonly<WaveReviewContextBase & {
      subject: Readonly<{ role: (typeof WAVE_REVIEW_AGENTS)[number]; taskId: string }>;
      taskRun: WaveTaskRunAuthority;
      task: WaveReviewTaskAuthority;
      specCheckScope: null;
      packetId: ArtifactDigest;
    }>;

export type WaveReviewContextRead =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "corrupt"; message: string }>
  | Readonly<{ kind: "loaded"; value: WaveReviewContextAuthority }>;

const corruptWaveContext = (message: string): WaveReviewContextRead => ({ kind: "corrupt", message });

const exactObject = (raw: unknown, keys: readonly string[]): raw is Record<string, unknown> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
  Object.keys(raw).length === keys.length && keys.every((key) => Object.hasOwn(raw, key));

const parseStringArray = (raw: unknown): readonly string[] | null =>
  Array.isArray(raw) && raw.every((entry) => typeof entry === "string")
    ? Object.freeze([...raw])
    : null;

/**
 * The ONE Wave Review Epoch Authority spec-check-documents grammar.
 *
 * This persisted authority has exactly two transports — the State File load
 * guard (state-manager.ts) and the reviewer-context decode
 * (`decodeWaveReviewContextAuthority` below) — and it used to be maintained as
 * two hand-written parsers whose acceptance agreed only by manual discipline.
 * A future single-copy edit could silently desynchronize the load boundary from
 * the context decode, so a Wave Gate could block after protected installation
 * with `wave-review-authority specCheckDocuments is invalid` about a graph the
 * loader itself accepted (or vice versa). One parser, typed rejection facts:
 * each transport decorates them with its own exact refusal prose, and
 * acceptance cannot drift because there is only one acceptance.
 *
 * Unknown fields are returned UNSORTED; the load guard sorts them for its
 * diagnostic, matching its established `exactFieldsError` shape. Missing
 * fields are returned in required-field order. Neither transport accepts an
 * optional field.
 */
export type WaveSpecCheckDocumentRejection =
  | Readonly<{ kind: "not-an-object" }>
  | Readonly<{ kind: "unknown-fields"; fields: readonly string[] }>
  | Readonly<{ kind: "missing-fields"; fields: readonly string[] }>
  | Readonly<{ kind: "path-not-string-or-null" }>
  | Readonly<{ kind: "path-blank" }>
  | Readonly<{ kind: "null-lockstep" }>
  | Readonly<{ kind: "invalid-digest"; message: string }>;

export type WaveSpecCheckDocumentParse =
  | Readonly<{ ok: true; value: WaveSpecCheckDocumentAuthority }>
  | Readonly<{ ok: false; rejection: WaveSpecCheckDocumentRejection }>;

export type WaveSpecCheckDocumentsRejection =
  | Readonly<{ kind: "not-an-object" }>
  | Readonly<{ kind: "unknown-fields"; fields: readonly string[] }>
  | Readonly<{ kind: "missing-fields"; fields: readonly string[] }>
  | Readonly<{ kind: "member"; member: "spec" | "plan"; failure: WaveSpecCheckDocumentRejection }>;

export type WaveSpecCheckDocumentsParse =
  | Readonly<{ ok: true; value: WaveSpecCheckDocumentsAuthority }>
  | Readonly<{ ok: false; rejection: WaveSpecCheckDocumentsRejection }>;

/** The three field-set rejections the two authority levels share. */
type WaveSpecCheckFieldsRejection =
  | Readonly<{ kind: "not-an-object" }>
  | Readonly<{ kind: "unknown-fields"; fields: readonly string[] }>
  | Readonly<{ kind: "missing-fields"; fields: readonly string[] }>;

const specCheckDocumentFieldRejection = (
  raw: unknown,
  required: readonly string[],
): WaveSpecCheckFieldsRejection | null => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return Object.freeze({ kind: "not-an-object" });
  }
  const record = raw as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter((field) => !required.includes(field));
  if (unknownFields.length > 0) return Object.freeze({ kind: "unknown-fields", fields: Object.freeze(unknownFields) });
  const missingFields = required.filter((field) => !Object.hasOwn(record, field));
  if (missingFields.length > 0) return Object.freeze({ kind: "missing-fields", fields: Object.freeze(missingFields) });
  return null;
};

export function parseWaveSpecCheckDocumentAuthority(raw: unknown): WaveSpecCheckDocumentParse {
  const shape = specCheckDocumentFieldRejection(raw, ["path", "contentDigest"]);
  if (shape !== null) return { ok: false, rejection: shape };
  const record = raw as Record<string, unknown>;
  if (record.path !== null && typeof record.path !== "string") {
    return { ok: false, rejection: Object.freeze({ kind: "path-not-string-or-null" }) };
  }
  // A blank path can never name a document: the shell mints this authority
  // from a real read at a real path, and `null` is the explicit no-document
  // state — so blank is only hand-edit or corruption, not an alternate
  // spelling of either legitimate arm.
  if (typeof record.path === "string" && record.path.trim() === "") {
    return { ok: false, rejection: Object.freeze({ kind: "path-blank" }) };
  }
  if ((record.path === null) !== (record.contentDigest === null)) {
    return { ok: false, rejection: Object.freeze({ kind: "null-lockstep" }) };
  }
  if (record.path === null) {
    return { ok: true, value: Object.freeze({ path: null, contentDigest: null }) };
  }
  const digest = parseArtifactDigest(record.contentDigest);
  return digest.ok
    ? { ok: true, value: Object.freeze({ path: record.path, contentDigest: digest.value }) }
    : { ok: false, rejection: Object.freeze({ kind: "invalid-digest", message: digest.error.message }) };
}

export function parseWaveSpecCheckDocumentsAuthority(raw: unknown): WaveSpecCheckDocumentsParse {
  const shape = specCheckDocumentFieldRejection(raw, ["spec", "plan"]);
  if (shape !== null) return { ok: false, rejection: shape };
  const record = raw as Record<string, unknown>;
  const spec = parseWaveSpecCheckDocumentAuthority(record.spec);
  if (!spec.ok) {
    return { ok: false, rejection: Object.freeze({ kind: "member", member: "spec", failure: spec.rejection } as const) };
  }
  const plan = parseWaveSpecCheckDocumentAuthority(record.plan);
  if (!plan.ok) {
    return { ok: false, rejection: Object.freeze({ kind: "member", member: "plan", failure: plan.rejection } as const) };
  }
  return { ok: true, value: Object.freeze({ spec: spec.value, plan: plan.value }) };
}

function parseWaveSpecCheckDocuments(raw: unknown): WaveSpecCheckDocumentsAuthority | null {
  const parsed = parseWaveSpecCheckDocumentsAuthority(raw);
  return parsed.ok ? parsed.value : null;
}

export function waveSpecCheckDocumentsMatch(
  left: WaveSpecCheckDocumentsAuthority | null | undefined,
  right: WaveSpecCheckDocumentsAuthority | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return left.spec.path === right.spec.path && left.spec.contentDigest === right.spec.contentDigest &&
    left.plan.path === right.plan.path && left.plan.contentDigest === right.plan.contentDigest;
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function hasBlank(values: readonly string[]): boolean {
  return values.some((value) => value.trim() === "");
}

function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((value) => right.includes(value));
}

function parseWaveSpecCheckScope(raw: unknown): readonly WaveSpecCheckTaskAuthority[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const scope: WaveSpecCheckTaskAuthority[] = [];
  for (const entry of raw) {
    // Both shapes, exactly as `specCheckDocuments` and `workspaceHeadSha` are
    // already handled elsewhere in this file: a scope entry published before
    // `modifiedFiles` existed is a schema generation behind, not damaged bytes.
    // Refusing it would report an engine's own persisted packet as corrupt and
    // block a Wave Gate that merely outlived an upgrade.
    const legacyFields = ["id", "description", "completionAnchors", "contributions", "declaredFiles"];
    if (!exactObject(entry, legacyFields) && !exactObject(entry, [...legacyFields, "modifiedFiles"])) {
      return null;
    }
    const completionAnchors = parseStringArray(entry.completionAnchors);
    const contributions = parseStringArray(entry.contributions);
    const declaredFiles = parseStringArray(entry.declaredFiles);
    const modifiedFiles = entry.modifiedFiles === undefined
      ? (Object.freeze([]) as readonly string[])
      : parseStringArray(entry.modifiedFiles);
    if (typeof entry.id !== "string" || entry.id.trim() === "" ||
        typeof entry.description !== "string" || completionAnchors === null || contributions === null ||
        declaredFiles === null || modifiedFiles === null ||
        hasDuplicates(completionAnchors) || hasDuplicates(contributions) ||
        hasDuplicates(declaredFiles) ||
        hasBlank(completionAnchors) || hasBlank(contributions) ||
        hasBlank(declaredFiles) ||
        // `modifiedFiles` is checked for blanks but NOT for duplicates. The
        // state schema validates `files_modified` only as an array of strings,
        // so a stricter decoder here would reject a packet the engine itself
        // built one step earlier from a graph the StateManager accepted.
        hasBlank(modifiedFiles) ||
        scopesOverlap(completionAnchors, contributions)) return null;
    scope.push(Object.freeze({
      id: entry.id,
      description: entry.description,
      completionAnchors,
      contributions,
      declaredFiles,
      modifiedFiles,
    }));
  }
  return new Set(scope.map(({ id }) => id)).size === scope.length ? Object.freeze(scope) : null;
}

type WaveContextParse<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; message: string }>;

function parseWaveReviewTaskAuthority(
  raw: unknown,
  taskId: string,
  generation: number,
): WaveContextParse<WaveReviewTaskAuthority> {
  if (!exactObject(raw, [
    "id", "description", "agent", "reviewGeneration", "planContext", "specAnchors", "specContributions",
    "declaredFiles", "modifiedFiles", "proof", "testResult", "priorFindings",
  ])) return { ok: false, message: "wave-review-authority task has an invalid schema" };
  const specAnchors = parseStringArray(raw.specAnchors);
  const specContributions = parseStringArray(raw.specContributions);
  const declaredFiles = parseStringArray(raw.declaredFiles);
  const modifiedFiles = parseStringArray(raw.modifiedFiles);
  const priorFindings = parseStoredFindings(raw.priorFindings);
  const proof = raw.proof === null ? null : parseTaskProof(raw.proof);
  const testResult = raw.testResult === null
    ? null
    : parseTaskTestResult(raw.testResult, "wave-review-authority task.testResult");
  if (raw.id !== taskId || raw.reviewGeneration !== generation) {
    return { ok: false, message: "wave-review-authority task identity/generation does not match Task Run authority" };
  }
  if (proof !== null && !proof.ok) {
    return { ok: false, message: `wave-review-authority task.proof is invalid: ${proof.errors.join("; ")}` };
  }
  if (testResult !== null && !testResult.ok) {
    return { ok: false, message: `wave-review-authority task.testResult is invalid: ${testResult.errors.join("; ")}` };
  }
  if (typeof raw.description !== "string" || typeof raw.agent !== "string" || raw.agent.trim() === "" ||
      (raw.planContext !== null && typeof raw.planContext !== "string") || specAnchors === null ||
      specContributions === null || declaredFiles === null || modifiedFiles === null || !Array.isArray(raw.priorFindings) ||
      priorFindings.length !== raw.priorFindings.length) {
    return { ok: false, message: "wave-review-authority task fields are invalid" };
  }
  return {
    ok: true,
    value: Object.freeze({
      id: taskId,
      description: raw.description,
      agent: raw.agent,
      reviewGeneration: generation,
      planContext: raw.planContext,
      specAnchors,
      specContributions,
      declaredFiles,
      modifiedFiles,
      proof: proof === null ? null : proof.value,
      testResult: testResult === null ? null : testResult.value,
      priorFindings: Object.freeze(priorFindings),
    }),
  };
}

function parseWaveContextBase(record: Record<string, unknown>): WaveContextParse<WaveReviewContextBase> {
  const runId = parseOrchestrationRunId(record.runId);
  const authorityDigest = parseArtifactDigest(record.authorityDigest);
  const batchEpoch = parseArtifactDigest(record.batchEpoch);
  if (!runId.ok) return { ok: false, message: `wave-review-authority runId: ${runId.error.message}` };
  if (!Number.isSafeInteger(record.wave) || (record.wave as number) < 1) {
    return { ok: false, message: "wave-review-authority wave must be a positive safe integer" };
  }
  if (!authorityDigest.ok) {
    return { ok: false, message: `wave-review-authority authorityDigest: ${authorityDigest.error.message}` };
  }
  if (!batchEpoch.ok) return { ok: false, message: `wave-review-authority batchEpoch: ${batchEpoch.error.message}` };
  if ((record.specFile !== null && typeof record.specFile !== "string") ||
      (record.planFile !== null && typeof record.planFile !== "string")) {
    return { ok: false, message: "wave-review-authority specFile/planFile is invalid" };
  }
  const specCheckDocuments = record.specCheckDocuments === undefined
    ? null
    : parseWaveSpecCheckDocuments(record.specCheckDocuments);
  if (record.specCheckDocuments !== undefined && specCheckDocuments === null) {
    return { ok: false, message: "wave-review-authority specCheckDocuments is invalid" };
  }
  return { ok: true, value: Object.freeze({
    runId: runId.value,
    wave: record.wave as number,
    authorityDigest: authorityDigest.value,
    batchEpoch: batchEpoch.value,
    specFile: record.specFile as string | null,
    planFile: record.planFile as string | null,
    specCheckDocuments,
  }) };
}

function parseWaveTaskRun(raw: unknown): WaveContextParse<WaveTaskRunAuthority | null> {
  if (raw === null) return { ok: true, value: null };
  if (!exactObject(raw, ["taskId", "generation", "packetId", "headSha"]) &&
      !exactObject(raw, ["taskId", "generation", "packetId", "headSha", "workspaceHeadSha"])) {
    return { ok: false, message: "wave-review-authority taskRun has an invalid schema" };
  }
  const packetId = parseArtifactDigest(raw.packetId);
  const headSha = parseArtifactDigest(raw.headSha);
  const workspaceHeadSha = raw.workspaceHeadSha === undefined ? null : parseArtifactDigest(raw.workspaceHeadSha);
  if (typeof raw.taskId !== "string" || !Number.isSafeInteger(raw.generation) || (raw.generation as number) < 0 ||
      !packetId.ok || !headSha.ok || (workspaceHeadSha !== null && !workspaceHeadSha.ok)) {
    return { ok: false, message: "wave-review-authority taskRun fields are invalid" };
  }
  return { ok: true, value: Object.freeze({
    taskId: raw.taskId,
    generation: raw.generation as number,
    packetId: packetId.value,
    headSha: headSha.value,
    ...(workspaceHeadSha === null ? {} : { workspaceHeadSha: workspaceHeadSha.value }),
  }) };
}

function parseSpecCheckContext(
  record: Record<string, unknown>,
  common: WaveReviewContextBase,
  subject: Record<string, unknown>,
  taskRun: WaveTaskRunAuthority | null,
): WaveReviewContextRead {
  if (subject.taskId !== null || taskRun !== null || record.task !== null || record.packetId !== null) {
    return corruptWaveContext("wave-review-authority spec-check subject cannot carry Task authority");
  }
  const specCheckScope = parseWaveSpecCheckScope(record.specCheckScope);
  if (specCheckScope === null) {
    return corruptWaveContext("wave-review-authority spec-check subject requires a valid immutable current-Wave scope");
  }
  return { kind: "loaded", value: Object.freeze({
    ...common,
    subject: Object.freeze({ role: "spec-check-invoker" as const, taskId: null }),
    taskRun: null,
    task: null,
    specCheckScope,
    packetId: null,
  }) };
}

function parseTaskReviewerContext(
  record: Record<string, unknown>,
  common: WaveReviewContextBase,
  subject: Record<string, unknown>,
  taskRun: WaveTaskRunAuthority | null,
): WaveReviewContextRead {
  if (record.specCheckScope !== null || typeof subject.taskId !== "string" || taskRun === null ||
      subject.taskId !== taskRun.taskId || record.packetId !== taskRun.packetId) {
    return corruptWaveContext("wave-review-authority Task reviewer subject lacks matching Task authority");
  }
  const task = parseWaveReviewTaskAuthority(record.task, subject.taskId, taskRun.generation);
  if (!task.ok) return corruptWaveContext(task.message);
  return { kind: "loaded", value: Object.freeze({
    ...common,
    subject: Object.freeze({
      role: subject.role as (typeof WAVE_REVIEW_AGENTS)[number],
      taskId: subject.taskId,
    }),
    taskRun,
    task: task.value,
    specCheckScope: null,
    packetId: taskRun.packetId,
  }) };
}

/** Parse the producer-owned wave-review-authority wire contract into branded authority. */
function decodeWaveReviewContextAuthority(raw: unknown): WaveReviewContextRead {
  const legacyFields = [
    "runId", "wave", "authorityDigest", "batchEpoch", "subject", "taskRun", "task", "specCheckScope",
    "packetId", "specFile", "planFile",
  ] as const;
  if (!exactObject(raw, legacyFields) && !exactObject(raw, [...legacyFields, "specCheckDocuments"])) {
    return corruptWaveContext("wave-review-authority section has an invalid top-level schema");
  }
  const common = parseWaveContextBase(raw);
  if (!common.ok) return corruptWaveContext(common.message);
  if (!exactObject(raw.subject, ["role", "taskId"])) {
    return corruptWaveContext("wave-review-authority subject has an invalid schema");
  }
  const subject = raw.subject;
  const isSpecCheck = subject.role === "spec-check-invoker";
  const isTaskReviewer = typeof subject.role === "string" &&
    (WAVE_REVIEW_AGENTS as readonly string[]).includes(subject.role);
  if ((!isSpecCheck && !isTaskReviewer) ||
      (subject.taskId !== null && (typeof subject.taskId !== "string" || subject.taskId.trim() === ""))) {
    return corruptWaveContext("wave-review-authority subject role/taskId is invalid");
  }
  const taskRun = parseWaveTaskRun(raw.taskRun);
  if (!taskRun.ok) return corruptWaveContext(taskRun.message);
  return isSpecCheck
    ? parseSpecCheckContext(raw, common.value, subject, taskRun.value)
    : parseTaskReviewerContext(raw, common.value, subject, taskRun.value);
}

/**
 * Read one request's persisted wave-review-authority section as a tri-state.
 *
 * Absent and corrupt are OPPOSITE facts: absent means either no packet matches
 * the requested digest or the matching packet carries no Wave authority;
 * corrupt means engine-published authority bytes are damaged, and the caller
 * must fail loudly instead of silently treating captured evidence as unrelated.
 */
export function readWaveReviewContext(
  packets: readonly ContextPacket[],
  digest: string,
): WaveReviewContextRead {
  const packet = packets.find((candidate) => candidate.digest === digest);
  const section = packet?.fixedContext.find(({ label }) => label === "wave-review-authority");
  if (section === undefined) return { kind: "absent" };
  try {
    const raw: unknown = JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(Uint8Array.from(section.bytes)),
    );
    return decodeWaveReviewContextAuthority(raw);
  } catch (error) {
    return {
      kind: "corrupt",
      message: `wave-review-authority section is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * One shared Task→row-fields lift, consumed by both Task→row serializations.
 *
 * `waveSpecCheckScope` (packet serialization) and `coverageTasks` (projection
 * join input) differ for good reasons — description, `inCurrentWave`, and
 * `anchorHashes` diverge — but these four field expressions are the same
 * mapping written at two seams. A domain change to the Task→row shape would
 * otherwise require two edits, and a field carried by one serialization could be
 * dropped by the other. One lift makes that defect structurally impossible —
 * a new field lands here once, and both serializations derive from it.
 */
const taskRowFields = (task: Task): Readonly<{
  completionAnchors: readonly string[];
  contributions: readonly string[];
  declaredFiles: readonly string[];
  modifiedFiles: readonly string[];
}> =>
  Object.freeze({
    completionAnchors: Object.freeze([...(task.spec_anchors ?? [])]),
    contributions: Object.freeze([...(task.spec_contributions ?? [])]),
    declaredFiles: Object.freeze([...(task.file_list ?? [])]),
    modifiedFiles: Object.freeze([...(task.files_modified ?? [])]),
  });

/**
 * Immutable current-Wave spec-check scope. Only `completionAnchors` assert
 * Requirement Completion Claims. Every serialized field directly contributes
 * to Context Packet identity; complete TaskGraph bytes, including descriptions,
 * contribute to `batchEpoch` transitively through `authorityDigest`. Drift in
 * descriptions, contributions, or declared files therefore invalidates stale
 * request authority.
 */
export function waveSpecCheckScope(tasks: readonly Task[]): readonly WaveSpecCheckTaskAuthority[] {
  return Object.freeze(tasks.map((task) => Object.freeze({
    id: task.id,
    description: task.description,
    ...taskRowFields(task),
  })));
}

/**
 * Lift protected Task state into the Requirement Coverage Projection's join
 * input.
 *
 * Recorded hashes cross the boundary through `parseSpecContentHash`, and a
 * value that is not the shape `specContentHash` mints is KEPT as an unreadable
 * record rather than dropped. Dropping it made a truncated or tampered hash
 * indistinguishable from one that was never recorded — the projection then
 * stated "no hash was recorded" about a graph that did record one, and graded
 * the row down while doing it. A value no engine could have written is corrupt
 * authority, and the projection says so.
 */
const parsedAnchorHashes = (stored: Task["spec_anchor_hashes"]): ReadonlyMap<string, RecordedHash> =>
  new Map(Object.entries(stored ?? {}).map(([claim, raw]) => {
    const hash = parseSpecContentHash(raw);
    // The load boundary proves `spec_anchor_hashes`: `migrateParsedTask`
    // rejects every non-string value before this lift runs, so `raw` is always
    // a string here. The unreadable arm keeps covering strings that are not the
    // shape `specContentHash` mints: a truncated or tampered hash stays
    // distinguishable from one that was never recorded, and the projection
    // says so instead of grading the row down silently.
    const recorded: RecordedHash = hash === null
      ? Object.freeze({ kind: "unreadable", stored: raw })
      : Object.freeze({ kind: "readable", hash });
    return [claim, recorded] as const;
  }));

/**
 * The projection's join input for one graph. Exported so the SubagentStop
 * enforcement path derives the settled floor from the SAME lift the packet was
 * built from, rather than a second, drift-prone copy of it.
 */
export function coverageTasks(graph: TaskGraph, currentWave: number): readonly CoverageTask[] {
  return Object.freeze(graph.tasks.map((task) => Object.freeze({
    id: task.id,
    inCurrentWave: task.wave === currentWave,
    ...taskRowFields(task),
    anchorHashes: parsedAnchorHashes(task.spec_anchor_hashes),
  })));
}

/**
 * The sole Wave review authority derivation.
 *
 * The shell contributes only the exact registered run and byte observations.
 * This pure function freezes the roster, packet/context bytes, model policy,
 * request/slot identities, and both Task and spec-check authority.
 *
 * The Requirement Coverage Projection deliberately stays out of `batchEpoch`,
 * and NOT because the epoch already covers its inputs — it does not. Two
 * projection inputs are absent from the epoch payload: `spec_anchor_hashes`,
 * which decides every `DriftFact`, and the `spec_anchors` of Tasks outside the
 * current Wave, which decide the unclaimed lists. (`registration.authorityDigest`
 * hashes the whole graph, but only as of gate registration, while resume
 * recomputes against a refreshed one.)
 *
 * The real argument is narrower and does not need that coverage: the projection
 * travels in packet bytes whose digest is part of Agent Request Authority, so
 * its integrity is already proven where it is consumed. Adding it to the epoch
 * would re-derive every slot id in the batch on upgrade and orphan captures
 * already written against the old ones, for a guarantee the packet digest
 * already gives.
 */
export function prepareWaveReviewBatch(
  runId: OrchestrationRunId,
  registration: WaveReviewRegistrationAuthority,
  graph: TaskGraph,
  attempt: 1 | 2,
  workspace: readonly ReviewedWorkspaceObservation[],
  specCheckObservation: WaveSpecCheckObservation,
): DomainResult<WaveRequestBatch, WaveReviewPreparationError> {
  if (registration.schemaVersion === 2) {
    const protocol = parseReviewerProtocolDescriptor(registration.reviewerProtocol);
    if (!protocol.ok) return failure(protocol.error.message);
  }
  const specCheckDocuments = specCheckObservation.authority;
  const currentWaveTasks = graph.tasks.filter((task) => task.wave === registration.input.wave);
  const tasks: Task[] = [];
  for (const taskId of registration.taskIds) {
    const task = graph.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) return failure(`registered Wave Task ${taskId} disappeared`);
    tasks.push(task);
  }
  if (tasks.some((task) => task.wave !== registration.input.wave) ||
      currentWaveTasks.length !== tasks.length || currentWaveTasks.some((task, index) => task.id !== tasks[index]?.id)) {
    return failure("registered Wave Task roster drifted from the exact protected current-Wave roster");
  }
  const workspaceByTask = new Map<string, ReviewedWorkspaceObservation>();
  for (const observation of workspace) {
    if (workspaceByTask.has(observation.taskId)) {
      return failure(`Task ${observation.taskId} has duplicate workspace observations`);
    }
    workspaceByTask.set(observation.taskId, observation);
  }
  if (workspaceByTask.size !== tasks.length || tasks.some(({ id }) => !workspaceByTask.has(id))) {
    return failure("current Wave workspace observations differ from the exact registered Task roster");
  }
  if (specCheckDocuments.spec.path !== (graph.spec_file ?? null) ||
      specCheckDocuments.plan.path !== (graph.plan_file ?? null)) {
    return failure("spec-check document observations do not match protected spec_file/plan_file authority");
  }
  // Prove, do not assume, that the index and the digest name the same bytes of
  // the same protected document. The path check alone would still admit an
  // observation assembled from two unrelated reads; comparing the digest the
  // index was parsed from against the document authority's own closes that.
  if (specIndexPath(specCheckObservation.specIndex) !== (graph.spec_file ?? null)) {
    return failure("Spec Index observation does not name the protected spec_file");
  }
  const observedSpecIndexDigest = specIndexDigest(specCheckObservation.specIndex);
  if (observedSpecIndexDigest !== null &&
      observedSpecIndexDigest !== specCheckDocuments.spec.contentDigest) {
    return failure("Spec Index was parsed from bytes other than the observed spec-check document");
  }

  const specCheckScope = waveSpecCheckScope(tasks);
  const requirementCoverage = projectRequirementCoverage(
    specCheckObservation.specIndex,
    coverageTasks(graph, registration.input.wave),
    graph.spec_index_observation,
  );
  const batchEpoch = parseArtifactDigest(sha256Hex(JSON.stringify({
    runId,
    wave: registration.input.wave,
    authorityDigest: registration.authorityDigest,
    tasks: tasks.map((task) => ({
      id: task.id,
      generation: task.review_generation ?? 0,
      files: task.file_list ?? [],
      modified: task.files_modified ?? [],
      completionAnchors: task.spec_anchors ?? [],
      contributions: task.spec_contributions ?? [],
      priorFindingIds: task.review_run?.prior_finding_ids ?? (task.findings ?? []).map(({ id }) => id),
      reviewedHeadSha: workspaceByTask.get(task.id)?.headSha ?? null,
    })),
    specFile: graph.spec_file ?? null,
    planFile: graph.plan_file ?? null,
    specCheckDocuments,
  })));
  if (!batchEpoch.ok) return failure(batchEpoch.error.message);

  const taskRuns: WaveTaskRunAuthority[] = [];
  for (const task of tasks) {
    const observation = workspaceByTask.get(task.id);
    if (observation === undefined) return failure(`Task ${task.id} workspace snapshot is missing`);
    const packetId = parseArtifactDigest(sha256Hex(`${batchEpoch.value}|packet|${task.id}`));
    const workspaceHeadSha = parseArtifactDigest(observation.headSha);
    if (!packetId.ok) return failure(packetId.error.message);
    if (!workspaceHeadSha.ok) return failure(workspaceHeadSha.error.message);
    taskRuns.push(Object.freeze({
      taskId: task.id,
      generation: task.review_generation ?? 0,
      packetId: packetId.value,
      headSha: batchEpoch.value,
      workspaceHeadSha: workspaceHeadSha.value,
    }));
  }

  const subjects = [
    { role: "spec-check-invoker" as const, taskId: null as string | null },
    ...tasks.flatMap((task) => WAVE_REVIEW_AGENTS.map((role) => ({ role, taskId: task.id as string | null }))),
  ];
  const requests: InitialSpawnRequestInput[] = [];
  const packets: ContextPacket[] = [];
  for (const subject of subjects) {
    const taskRun = subject.taskId === null ? null : taskRuns.find(({ taskId }) => taskId === subject.taskId) ?? null;
    // Slot and request identity hash the AUTHORITY, never the registration
    // object. Spreading `registration` here made every Wave slot depend on
    // unrelated recovery bookkeeping (`restart`, `orphanRecovery`) and on the
    // caller's JSON key order — either of which re-derives every slot id in the
    // batch and orphans the captures already written against the old ones. What
    // a slot represents is the reviewed Wave: run, Wave, roster, and the
    // registration's own digest.
    const identity = JSON.stringify({
      runId,
      registration: {
        schemaVersion: subject.taskId === null ? 1 : registration.schemaVersion,
        ...(subject.taskId !== null && registration.schemaVersion === 2
          ? { reviewerProtocol: registration.reviewerProtocol } : {}),
        kind: registration.kind,
        wave: registration.input.wave,
        taskIds: registration.taskIds,
        authorityDigest: registration.authorityDigest,
      },
      batchEpoch: batchEpoch.value,
      subject,
      taskRun,
    });
    const hash = sha256Hex(identity);
    const slotId = parseSlotId(`wave-slot:${hash.slice(0, 32)}`);
    const requestId = parseRequestId(`wave-request:${hash.slice(0, 32)}:${attempt}`);
    if (!slotId.ok) return failure(slotId.error.message);
    if (!requestId.ok) return failure(requestId.error.message);
    const policy = resolveAgentPolicy(subject.role);
    if (!policy.ok) return failure(policy.error.message);
    const profile = resolveModelProfile(policy.value.profile);
    if (!profile.ok) return failure(profile.error.message);
    const task = subject.taskId === null ? null : tasks.find(({ id }) => id === subject.taskId) ?? null;
    const section = encodeByteSection("wave-review-authority", JSON.stringify({
      runId,
      wave: registration.input.wave,
      authorityDigest: registration.authorityDigest,
      batchEpoch: batchEpoch.value,
      subject,
      taskRun,
      specCheckScope: subject.taskId === null ? specCheckScope : null,
      task: task === null ? null : {
        id: task.id,
        description: task.description,
        agent: task.agent,
        reviewGeneration: task.review_generation ?? 0,
        planContext: task.plan_context ?? null,
        specAnchors: task.spec_anchors ?? [],
        specContributions: task.spec_contributions ?? [],
        declaredFiles: task.file_list ?? [],
        modifiedFiles: task.files_modified ?? [],
        proof: task.proof ?? null,
        testResult: task.test_result ?? null,
        priorFindings: task.findings ?? [],
      },
      packetId: taskRun?.packetId ?? null,
      specFile: graph.spec_file,
      planFile: graph.plan_file,
      specCheckDocuments,
    }));
    if (!section.ok) return failure(section.error.message);
    // The projection rides in its own section rather than inside the authority
    // JSON: it is rendered text the Agent consumes directly, its integrity is
    // already proven by the packet digest, and no engine control flow decodes
    // it — so widening the authority schema would buy a parser nobody calls.
    // Only the spec-check subject receives it; no reviewer has a use for it.
    const coverageSection = subject.taskId === null
      ? encodeByteSection("requirement-coverage", renderRequirementCoverage(requirementCoverage))
      : null;
    if (coverageSection !== null && !coverageSection.ok) return failure(coverageSection.error.message);
    const packetInput = {
      requestId: requestId.value,
      role: subject.role,
      requiredSkill: policy.value.requiredSkill ?? "none",
      outputContract: subject.role === "spec-check-invoker"
        ? `Run the Wave ${registration.input.wave} spec alignment check and emit its exact Machine Summary.`
        : `Review Task ${subject.taskId} from the immutable packet and emit the exact Machine Summary and findings contract.`,
      fixedContext: Object.freeze(
        coverageSection === null ? [section.value] : [section.value, coverageSection.value],
      ),
      variableContext: Object.freeze([]),
    };
    const packet = subject.taskId !== null && registration.schemaVersion === 2
      ? buildReviewerContextPacket(packetInput)
      : buildContextPacket(packetInput);
    if (!packet.ok) return failure(packet.error.message);
    const authority = parseAgentRequestAuthority({
      runId,
      requestId: requestId.value,
      slotId: slotId.value,
      program: "wave-gate",
      role: subject.role,
      attempt,
      modelProfile: profile.value.id,
      harnessBinding: {
        pi: lowerModelProfile(profile.value, "pi"),
        claude: lowerModelProfile(profile.value, "claude-code"),
      },
      requiredSkill: policy.value.requiredSkill,
      contextDigest: packet.value.digest,
      outputSlot: `transcripts/${slotId.value}/attempt-${attempt}.raw`,
    });
    if (!authority.ok) {
      return failure(authority.error.violations.map(({ message }) => message).join("; "));
    }
    packets.push(packet.value);
    requests.push(Object.freeze({
      authority: authority.value,
      context: Object.freeze({
        digest: packet.value.digest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.value.digest}.json` }),
      }),
    }));
  }

  return canonicalRecord({
    ok: true,
    value: Object.freeze({
      batchEpoch: batchEpoch.value,
      specCheckDocuments,
      // Derived from `requirementCoverage` itself—the same value the packet
      // section above renders—so the Finding identities/count recorded on the
      // epoch and those the Agent reads are one expression, not two agreeing ones.
      settledFloor: settledFloorOf(requirementCoverage),
      requests: Object.freeze(requests),
      packets: Object.freeze(packets),
      taskRuns: Object.freeze(taskRuns),
    }),
  });
}

/** How an installed epoch relates to the freshly prepared batch. */
export type WaveReviewEpochReplayDecision =
  | Readonly<{ kind: "exact" }>
  | Readonly<{ kind: "upgrade-floor" }>
  | Readonly<{ kind: "different" }>;

/**
 * Parse epoch replay authority into an exhaustive decision.
 *
 * Exact replay retains captured spec-check evidence. A byte/slot-identical
 * historical epoch with no floor—or with a matching count-only legacy floor—
 * is an explicit upgrade: installation writes the packet's identity-bearing
 * floor and clears prior evidence. Every other mismatch is different authority.
 */
export function decideWaveReviewEpochReplay(
  existing: WaveReviewEpochAuthority | undefined,
  batch: WaveRequestBatch,
  runId: OrchestrationRunId,
  wave: number,
  specCheckSlotId: string,
): WaveReviewEpochReplayDecision {
  if (existing === undefined || existing.runId !== runId || existing.wave !== wave ||
      existing.batchEpoch !== batch.batchEpoch ||
      !waveSpecCheckDocumentsMatch(existing.specCheckDocuments, batch.specCheckDocuments) ||
      existing.specCheckSlotAuthority?.slot_id !== specCheckSlotId) {
    return Object.freeze({ kind: "different" });
  }
  if (existing.settledSpecCheckFloor === undefined) {
    return Object.freeze({ kind: "upgrade-floor" });
  }
  if (existing.settledSpecCheckFloor.kind === "legacy-settled") {
    return batch.settledFloor.kind === "settled" &&
        existing.settledSpecCheckFloor.count === batch.settledFloor.count
      ? Object.freeze({ kind: "upgrade-floor" })
      : Object.freeze({ kind: "different" });
  }
  return canonicalStructuralEquals(existing.settledSpecCheckFloor, batch.settledFloor)
    ? Object.freeze({ kind: "exact" })
    : Object.freeze({ kind: "different" });
}

/**
 * The settled CRITICAL floor for one spec-check capture: the identities and
 * count the Agent was shown, read back from the epoch that showed them.
 *
 * Deliberately NOT a re-projection. Re-deriving at capture time reads
 * `spec_anchor_hashes` and the `spec_anchors` of Tasks outside the reviewed
 * Wave, neither of which `batchEpoch` covers, so an edit between packet and
 * capture could raise the enforced floor above the rendered one and fail a
 * report that matched everything the Agent could see. Reading it back makes
 * rendered and enforced the same value by construction rather than by argument.
 *
 * Both absences are real states, and both are stated rather than defaulted: no
 * epoch means the capture is not packet-correlated (a legacy graph, or an
 * operator override), and an epoch without the field predates its recording.
 */
export function epochSettledFloor(epoch: WaveReviewEpochAuthority | undefined): SettledFloor {
  if (epoch === undefined) {
    return unprojectedFloor("this capture is not packet-correlated, so the Agent was shown no projection");
  }
  return epoch.settledSpecCheckFloor
    ?? unprojectedFloor("this Wave review epoch predates recorded Requirement Coverage floor authority");
}
