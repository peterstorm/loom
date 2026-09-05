import { sha256Hex } from "./review-packet";
import type {
  Finding,
  Task,
  TaskGraph,
  WaveSpecCheckDocumentAuthority,
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
import { buildContextPacket, encodeByteSection, type ContextPacket } from "./context-packets";
import { lowerModelProfile, resolveAgentPolicy, resolveModelProfile, WAVE_REVIEW_AGENTS } from "./model-profiles";
import {
  canonicalRecord,
  parseAgentRequestAuthority,
  parseArtifactDigest,
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
  settledCriticalCount,
  specIndexDigest,
  specIndexPath,
  type CoverageTask,
  type RecordedHash,
  type SpecIndexAvailability,
} from "./requirement-coverage";
export type { SpecIndexAvailability } from "./requirement-coverage";
import { parseSpecContentHash } from "./parse-spec";

/**
 * One spec-check observation: the serializable document authority together with
 * the Spec Index projected from the very bytes its digest names.
 *
 * The shell produces both from a single read, and `prepareWaveReviewBatch`
 * PROVES the pairing rather than trusting it: the index carries the digest of
 * the bytes it was parsed from, and that digest is compared with the document
 * authority's own. Declared here, where the consumer lives, and re-exported by
 * the shell producer so the contract has exactly one owner.
 */
export type WaveSpecCheckObservation = Readonly<{
  authority: WaveSpecCheckDocumentsAuthority;
  specIndex: SpecIndexAvailability;
}>;

export type WaveReviewRegistrationAuthority = Readonly<{
  schemaVersion: 1;
  kind: "wave-gate";
  input: Readonly<{ wave: number }>;
  taskIds: readonly string[];
  authorityDigest: string;
  restart?: Readonly<{ previousRunId: string; exhaustedSlots: readonly string[] }>;
  orphanRecovery?: Readonly<{ previousRunId: string; previousAuthorityDigest: string }>;
}>;

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

function parseWaveSpecCheckDocument(raw: unknown): WaveSpecCheckDocumentAuthority | null {
  if (!exactObject(raw, ["path", "contentDigest"]) ||
      (raw.path !== null && typeof raw.path !== "string")) return null;
  if (raw.path === null) {
    return raw.contentDigest === null ? Object.freeze({ path: null, contentDigest: null }) : null;
  }
  if (raw.contentDigest === null) return null;
  const digest = parseArtifactDigest(raw.contentDigest);
  return digest.ok ? Object.freeze({ path: raw.path, contentDigest: digest.value }) : null;
}

function parseWaveSpecCheckDocuments(raw: unknown): WaveSpecCheckDocumentsAuthority | null {
  if (!exactObject(raw, ["spec", "plan"])) return null;
  const spec = parseWaveSpecCheckDocument(raw.spec);
  const plan = parseWaveSpecCheckDocument(raw.plan);
  return spec === null || plan === null ? null : Object.freeze({ spec, plan });
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
    completionAnchors: Object.freeze([...(task.spec_anchors ?? [])]),
    contributions: Object.freeze([...(task.spec_contributions ?? [])]),
    declaredFiles: Object.freeze([...(task.file_list ?? [])]),
    modifiedFiles: Object.freeze([...(task.files_modified ?? [])]),
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
    // `raw` is typed `string` by the TaskGraph interface, but nothing on the
    // load path parses `spec_anchor_hashes` — `migrateParsedTask` spreads the
    // record through verbatim — so a hand-edited graph can put a number or an
    // object here. Rendering it later did `stored.slice(0, 16)` and threw a
    // TypeError out of a function whose contract is a stated refusal, aborting
    // the Wave Gate. Describe whatever was actually there instead.
    const recorded: RecordedHash = hash === null
      ? Object.freeze({
          kind: "unreadable",
          stored: typeof raw === "string" ? raw : `<non-string ${typeof raw}>`,
        })
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
    completionAnchors: Object.freeze([...(task.spec_anchors ?? [])]),
    declaredFiles: Object.freeze([...(task.file_list ?? [])]),
    modifiedFiles: Object.freeze([...(task.files_modified ?? [])]),
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
  if (specIndexDigest(specCheckObservation.specIndex) !== null &&
      specIndexDigest(specCheckObservation.specIndex) !== specCheckDocuments.spec.contentDigest) {
    return failure("Spec Index was parsed from bytes other than the observed spec-check document");
  }

  const specCheckScope = waveSpecCheckScope(tasks);
  const requirementCoverage = projectRequirementCoverage(
    specCheckObservation.specIndex,
    coverageTasks(graph, registration.input.wave),
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
        schemaVersion: registration.schemaVersion,
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
    const packet = buildContextPacket({
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
    });
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
      requests: Object.freeze(requests),
      packets: Object.freeze(packets),
      taskRuns: Object.freeze(taskRuns),
    }),
  });
}

/**
 * The settled CRITICAL floor for one spec-check capture, or `null` when no
 * projection was available to floor against.
 *
 * The single derivation every harness uses. `reconcileSpecCheck` owns applying
 * it; this owns computing it, from the same `coverageTasks` lift the packet was
 * built from, so the number the Agent was shown and the number the engine
 * enforces come from one place.
 */
export function settledSpecCheckFloor(
  specIndex: SpecIndexAvailability,
  graph: TaskGraph,
  wave: number,
): number | null {
  const coverage = projectRequirementCoverage(specIndex, coverageTasks(graph, wave));
  return coverage.kind === "projected" ? settledCriticalCount(coverage) : null;
}
