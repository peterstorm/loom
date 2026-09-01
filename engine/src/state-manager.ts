/**
 * Anchored atomic State File manager.
 *
 * The State File stays mode 0444 at rest. Hooks and whitelisted helpers stage
 * validated bytes, set mode 0444 before publication, and rename through the
 * anchored parent capability and lock — the retained parent descriptor on
 * Linux, the `O_NOFOLLOW_ANY`-proven real path on darwin.
 * Replaces: state-file-write.sh, resolve-task-graph.sh, loom-config.sh
 */

import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_AGENTS, PHASE_ORDER, REVIEW_SUB_AGENTS, pathExistsFailClosed, taskGraphPath } from "./config";
import {
  parseCanonicalTaskGraphPointer,
  parseErr,
  parseOk,
  parseSessionId,
  sessionScopedPath,
  type ParseResult,
} from "./machine";
import {
  parseNewTestEvidence,
  parseStoredNewTestEvidence,
  REVIEW_STATUSES,
  storedNewTestEvidence,
  TASK_STATUSES,
  type Phase,
} from "./types";
import {
  findingIdCollisionError,
  findingsLockstepError,
  findingsUnionError,
  findingsViewError,
  evidenceFailureError,
  refutationsUnionError,
  resolutionsUnionError,
  reviewRunError,
} from "./core/findings";
import type {
  ActiveWaveGateRegistration,
  CompletedWaveGateRegistration,
  OrphanedWaveGateRetirement,
  WaveReopeningAudit,
  SpecCheck,
  SpecTraceWaveGateRetirement,
  Task,
  TaskGraph,
  WaveReviewEpochAuthority,
  WaveSpecCheckDocumentAuthority,
  WaveSpecCheckDocumentsAuthority,
} from "./types";
import type { DomainResult } from "./core/orchestration-contract";
import type { WaveCompletionCommit, WaveCompletionCommitError } from "./core/wave-gate-machine";
import {
  parseArtifactDigest,
  parseArtifactRef,
  parseBlockedDiagnostic,
  parseEffectId,
  parseOrchestrationRunId,
  parseSlotId,
} from "./core/orchestration-contract";
import {
  derivePendingTaskProof,
  deriveProofObligations,
  parseTaskProof,
  parseTaskTestResult,
} from "./core/proof-obligations";
import { parseDeclaredArtifactBaseline } from "./core/artifact-baseline";
import { parseStoredSpecCheck } from "./core/spec-check";
import { waveHasBlockCause } from "./core/wave-gate-model";
import { parseIssuedReviewPacketRegistration, parseReviewPath } from "./core/review-packet";
import { assertPiCliMutationCompatible, captureLoomRuntimeIdentity } from "./runtime-compatibility";
import { isExactGitSha } from "./core/git-sha";
import { parseSpecTraceContract, specTraceDiagnosticMessages } from "./core/spec-trace";
import { parseTaskVerificationPolicy } from "./core/verification-policy";
import {
  isProtectedVerificationPath,
  parseAcceptedWaveCompletionReceipt,
  type AcceptedWaveCompletionReceipt,
} from "./core/completion-suite";
import {
  canonicalArtifactBaselineDigest,
  parseImplementationAttemptAuthority,
  parseImplementationAttemptHistory,
} from "./core/implementation-completion";
import { parseTaskId, type TaskId } from "./core/task-id";
import {
  anchoredDirectoryHasIdentity,
  anchoredDirectoryIdentity,
  closeAnchorGuarded,
  openDirectoryNoFollow,
  readDirectoryFileNoFollow,
  resolveBaseDirectory,
  withAnchoredDirectoryHandleLock,
  writeDirectoryFileAtomicModeNoFollow,
  type AnchoredDirectory,
  type AnchoredDirectoryIdentity,
} from "./orchestration/no-follow-fs";

export { TASK_ID_PATTERN } from "./core/task-id";
import {
  authorizeWaveCompletionSuite,
  defaultVerificationManifest,
  parseFrozenVerificationManifest,
  type FrozenVerificationManifest,
} from "./core/verification-manifest";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

type TaskGraphFileAuthority = Readonly<{
  kind: "task-graph-file-authority";
  path: string;
  directoryPath: string;
  directoryIdentity: AnchoredDirectoryIdentity;
  leaf: string;
}>;

type StateDirectoryOutcome<T> =
  | Readonly<{ kind: "returned"; value: T }>
  | Readonly<{ kind: "threw"; error: unknown }>;

function finishStateDirectoryOperation<T>(
  directory: AnchoredDirectory,
  operation: string,
  outcome: StateDirectoryOutcome<T>,
): T {
  const failure = closeAnchorGuarded(
    directory,
    outcome.kind === "threw" ? outcome.error : null,
    operation,
  );
  if (failure !== null) throw failure;
  if (outcome.kind === "threw") throw outcome.error;
  return outcome.value;
}

function withStateDirectory<T>(
  directory: AnchoredDirectory,
  operation: string,
  use: () => T,
): T {
  let outcome: StateDirectoryOutcome<T>;
  try {
    outcome = { kind: "returned", value: use() };
  } catch (error) {
    outcome = { kind: "threw", error };
  }
  return finishStateDirectoryOperation(directory, operation, outcome);
}

async function withStateDirectoryAsync<T>(
  directory: AnchoredDirectory,
  operation: string,
  use: () => Promise<T>,
): Promise<T> {
  let outcome: StateDirectoryOutcome<T>;
  try {
    outcome = { kind: "returned", value: await use() };
  } catch (error) {
    outcome = { kind: "threw", error };
  }
  return finishStateDirectoryOperation(directory, operation, outcome);
}

/**
 * Read one session pointer through its subagent base, resolved once.
 *
 * The subagent directory is the BASE for session-scoped files: its configured
 * path may traverse a system symlink (macOS resolves `/tmp` to
 * `/private/tmp`), so it is resolved here rather than walked strictly from the
 * filesystem root — the same reason `ensureResolvedBaseDirectory` resolves a
 * run base. ENOENT propagates: an absent base is the one absent answer, the
 * same one an absent pointer produces. The leaf itself is still read with no
 * component followed.
 */
function readSessionPointerNoFollow(sessionFile: string): string {
  const directory = openDirectoryNoFollow(resolveBaseDirectory(dirname(sessionFile)));
  return withStateDirectory(directory, `session pointer read of ${sessionFile}`, () =>
    readDirectoryFileNoFollow(directory, basename(sessionFile)).toString("utf8"));
}

function captureTaskGraphFileAuthority(path: string, requireExisting: boolean): TaskGraphFileAuthority {
  const parsedPath = parseCanonicalTaskGraphPointer(resolve(path));
  if (!parsedPath.ok) throw new Error(parsedPath.error);
  const directoryPath = dirname(parsedPath.value);
  const directory = openDirectoryNoFollow(directoryPath);
  return withStateDirectory(directory, `TaskGraph authority capture for ${parsedPath.value}`, () => {
    if (requireExisting) readDirectoryFileNoFollow(directory, basename(parsedPath.value));
    return Object.freeze({
      kind: "task-graph-file-authority" as const,
      path: parsedPath.value,
      directoryPath,
      directoryIdentity: anchoredDirectoryIdentity(directory),
      leaf: basename(parsedPath.value),
    });
  });
}

function parseSessionPointerFile(sessionFile: string): string {
  const parsed = parseCanonicalTaskGraphPointer(readSessionPointerNoFollow(sessionFile));
  if (!parsed.ok) throw new Error(`session pointer ${sessionFile} is malformed: ${parsed.error}`);
  return parsed.value;
}

function optionalLocalTaskGraphAuthority(): TaskGraphFileAuthority | null {
  try {
    return captureTaskGraphFileAuthority(taskGraphPath(), true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function resolveTaskGraphFileAuthority(sessionId?: string): TaskGraphFileAuthority | null {
  if (sessionId === undefined) return optionalLocalTaskGraphAuthority();
  const parsed = parseSessionId(sessionId);
  if (parsed === null) {
    throw new Error(
      `resolveTaskGraph: invalid session id ${JSON.stringify(sessionId)} — refusing local task-graph fallback`,
    );
  }
  const sessionFile = sessionScopedPath(parsed, ".task_graph");
  let pointedPath: string;
  try {
    pointedPath = parseSessionPointerFile(sessionFile);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const message = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? `session pointer ${sessionFile} is absent: ${cause}`
      : `cannot read session pointer ${sessionFile}: ${cause}`;
    throw new Error(`resolveTaskGraph: ${message} — refusing local task-graph fallback`);
  }
  return pointedTaskGraphAuthority(pointedPath, sessionFile);
}

/**
 * Capture no-follow file authority for a session pointer's target, or refuse
 * the local fallback with the exact same diagnostic from every caller. One
 * enforcement point for the translate-catch contract: ENOENT names a missing
 * graph, anything else names an inaccessible one.
 */
function pointedTaskGraphAuthority(pointedPath: string, sessionFile: string): TaskGraphFileAuthority {
  try {
    return captureTaskGraphFileAuthority(pointedPath, true);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const description = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? `names missing graph '${pointedPath}'`
      : `names inaccessible graph '${pointedPath}': ${cause}`;
    throw new Error(
      `resolveTaskGraph: session pointer ${sessionFile} ${description} — refusing local task-graph fallback`,
    );
  }
}

/** Resolve a TaskGraph display path after proving no-follow file authority. */
export function resolveTaskGraph(sessionId?: string): string | null {
  return resolveTaskGraphFileAuthority(sessionId)?.path ?? null;
}

/** Explicit Pi-parent compatibility: only an absent pointer selects local authority. */
function resolveLocalSessionTaskGraphAuthority(sessionId: string): TaskGraphFileAuthority | null {
  const parsed = parseSessionId(sessionId);
  if (parsed === null) throw new Error(`resolveTaskGraph: invalid session id ${JSON.stringify(sessionId)}`);
  const sessionFile = sessionScopedPath(parsed, ".task_graph");
  let pointedPath: string;
  try {
    pointedPath = parseSessionPointerFile(sessionFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return optionalLocalTaskGraphAuthority();
    throw new Error(
      `resolveTaskGraph: cannot read session pointer ${sessionFile}: ` +
      `${error instanceof Error ? error.message : String(error)} — refusing local task-graph fallback`,
    );
  }
  return pointedTaskGraphAuthority(pointedPath, sessionFile);
}

// --- Parse, don't validate: disk JSON → TaskGraph ---

/**
 * Prove one wave gate's shape, for the reason every `Task` union field is proven.
 *
 * The cast in `parseTaskGraph` asserts `Record<string, WaveGate>` and used to
 * prove nothing beyond "the container is an object". Four booleans read by gate
 * logic as booleans: `validate-task-execution` blocks on `!gate.reviews_complete`,
 * so `{ reviews_complete: "no" }` loaded clean and read as TRUTHY — the
 * previous-wave review gate silently stopped blocking, which is the failure this
 * boundary exists to make impossible. `tests_passed` is the one two-state
 * "judged / not yet judged" field (`true | null`), and `false` is refused
 * outright — no writer produces it, and a drifted graph carrying it would
 * otherwise mint a failure message nothing in the engine ever wrote.
 */
function waveGateError(v: unknown, wave: string): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return `wave_gates["${wave}"] must be an object`;
  }
  const gate = v as Record<string, unknown>;
  const booleanFields = ["impl_complete", "reviews_complete", "blocked"] as const;
  // Diagnose malformed fields before absent siblings so a partially supplied
  // record points at the value the writer actually got wrong.
  for (const field of booleanFields) {
    if (field in gate && typeof gate[field] !== "boolean") {
      return `wave_gates["${wave}"]: ${field} must be a boolean, got ${JSON.stringify(gate[field])}`;
    }
  }
  if (
    "tests_passed" in gate &&
    gate.tests_passed !== null && typeof gate.tests_passed !== "boolean"
  ) {
    return (
      `wave_gates["${wave}"]: tests_passed must be a boolean or null, ` +
      `got ${JSON.stringify(gate.tests_passed)}`
    );
  }
  if ("tests_passed" in gate && gate.tests_passed === false) {
    return (
      `wave_gates["${wave}"]: tests_passed: false is not a representable gate state ` +
      `(no writer produces it; failing runs are judged by test_result evidence) — ` +
      `set null (not yet judged) or true (passed)`
    );
  }
  for (const field of booleanFields) {
    if (!(field in gate)) return `wave_gates["${wave}"]: missing required field ${field}`;
  }
  if (!("tests_passed" in gate)) return `wave_gates["${wave}"]: missing required field tests_passed`;
  return null;
}

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
  waveGates: Record<string, unknown>,
  tasks: readonly Record<string, unknown>[],
  specCheck: SpecCheck | undefined,
): string | null {
  const causeTasks = tasks.map((task) => ({
    wave: typeof task.wave === "number" ? task.wave : Number.NaN,
    critical_findings: Array.isArray(task.critical_findings)
      ? (task.critical_findings as readonly string[])
      : undefined,
  }));
  for (const [wave, gate] of Object.entries(waveGates)) {
    if ((gate as Record<string, unknown>).blocked !== true) continue;
    // The SAME predicate the writers use to set and clear the flag
    // (`core/wave-gate-model`), so the boundary can never disagree with them
    // about what counts as a cause.
    if (waveHasBlockCause(causeTasks, specCheck, Number(wave))) continue;
    return (
      `wave_gates["${wave}"]: blocked: true has no cause — no task in wave ${wave} carries ` +
      `critical review findings and spec_check does not report a critical finding for it. ` +
      `A causeless block withholds the wave with an empty "BLOCKED due to:" reason list; ` +
      `clear the flag or restore the findings that justify it (\`--fix\` clears it)`
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

const WAVE_REVIEW_EPOCH_FIELDS = ["runId", "wave", "batchEpoch"] as const;
const WAVE_REVIEW_EPOCH_OPTIONAL_FIELDS = ["specCheckDocuments", "specCheckSlotAuthority"] as const;

function parseWaveSpecCheckDocument(
  raw: unknown,
  label: string,
): ParseResult<WaveSpecCheckDocumentAuthority> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return parseErr(`${label} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const fieldsError = exactFieldsError(record, ["path", "contentDigest"], [], label);
  if (fieldsError !== null) return parseErr(fieldsError);
  if (record.path !== null && typeof record.path !== "string") {
    return parseErr(`${label}.path must be a string or null`);
  }
  if ((record.path === null) !== (record.contentDigest === null)) {
    return parseErr(`${label}.path and contentDigest must both be null or both be present`);
  }
  if (record.contentDigest === null) {
    return parseOk(Object.freeze({ path: record.path as string | null, contentDigest: null }));
  }
  const digest = parseArtifactDigest(record.contentDigest);
  return digest.ok
    ? parseOk(Object.freeze({ path: record.path as string | null, contentDigest: digest.value }))
    : parseErr(`${label}.contentDigest: ${digest.error.message}`);
}

function parseWaveSpecCheckDocuments(
  raw: unknown,
): ParseResult<WaveSpecCheckDocumentsAuthority | undefined> {
  if (raw === undefined) return parseOk(undefined);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return parseErr("wave_review_epoch.specCheckDocuments must be an object when present");
  }
  const record = raw as Record<string, unknown>;
  const fieldsError = exactFieldsError(record, ["spec", "plan"], [], "wave_review_epoch.specCheckDocuments");
  if (fieldsError !== null) return parseErr(fieldsError);
  const spec = parseWaveSpecCheckDocument(record.spec, "wave_review_epoch.specCheckDocuments.spec");
  if (!spec.ok) return spec;
  const plan = parseWaveSpecCheckDocument(record.plan, "wave_review_epoch.specCheckDocuments.plan");
  if (!plan.ok) return plan;
  return parseOk(Object.freeze({ spec: spec.value, plan: plan.value }));
}

function parseWaveSpecCheckSlotAuthority(
  raw: unknown,
): ParseResult<WaveReviewEpochAuthority["specCheckSlotAuthority"]> {
  if (raw === undefined) return parseOk(undefined);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
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

/** Parse the exact request-batch authority persisted beside an active Wave Gate. */
function parseWaveNumber(value: unknown, label: string): { ok: true; value: number } | { ok: false; error: string } {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? { ok: true, value }
    : { ok: false, error: `${label} must be an integer >= 1` };
}

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
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
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
  const wave = parseWaveNumber(record.wave, "wave_review_epoch.wave");
  if (!wave.ok) return parseErr(wave.error);
  const batchEpoch = parseArtifactDigest(record.batchEpoch);
  if (!batchEpoch.ok) return parseErr(`wave_review_epoch.batchEpoch: ${batchEpoch.error.message}`);
  const specCheckDocuments = parseWaveSpecCheckDocuments(record.specCheckDocuments);
  if (!specCheckDocuments.ok) return specCheckDocuments;
  const specCheckSlotAuthority = parseWaveSpecCheckSlotAuthority(record.specCheckSlotAuthority);
  if (!specCheckSlotAuthority.ok) return specCheckSlotAuthority;
  return parseOk(Object.freeze({
    runId: runId.value,
    wave: wave.value,
    batchEpoch: batchEpoch.value,
    ...(specCheckDocuments.value === undefined ? {} : { specCheckDocuments: specCheckDocuments.value }),
    ...(specCheckSlotAuthority.value === undefined
      ? {}
      : { specCheckSlotAuthority: specCheckSlotAuthority.value }),
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
  if (typeof raw !== "object" || Array.isArray(raw)) {
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
  return parseErr("active_wave_gate.terminalOutcome.kind must be done or terminal-blocked");
}

/** Parse and re-prove the protected active-run anchor from unknown JSON. */
export function parseActiveWaveGateRegistration(raw: unknown): ParseResult<ActiveWaveGateRegistration> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
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
  const wave = parseWaveNumber(record.wave, "active_wave_gate.wave");
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

const COMPLETED_WAVE_GATE_COMMON_FIELDS = [
  "schemaVersion", "kind", "runId", "wave", "authorityDigest", "revision", "completionReceipt",
] as const;
const COMPLETED_WAVE_GATE_V2_FIELDS = [
  ...COMPLETED_WAVE_GATE_COMMON_FIELDS,
  "completionSuite",
] as const;

type CompletedWaveGateCommon = Omit<CompletedWaveGateRegistration, "schemaVersion" | "completionSuite">;

function parseCompletedWaveGateReceipt(
  raw: unknown,
  runId: CompletedWaveGateRegistration["runId"],
  revision: number,
): ParseResult<CompletedWaveGateRegistration["completionReceipt"]> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
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
  const wave = parseWaveNumber(record.wave, "wave_gate_history.wave");
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
 * The schema tag selects one exact shape: v1 cannot carry a suite and v2 must. */
export function parseCompletedWaveGateRegistration(raw: unknown): ParseResult<CompletedWaveGateRegistration> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return parseErr("wave_gate_history entry must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    return parseErr("wave_gate_history entry schemaVersion must be 1 or 2");
  }
  const fields = record.schemaVersion === 1
    ? COMPLETED_WAVE_GATE_COMMON_FIELDS
    : COMPLETED_WAVE_GATE_V2_FIELDS;
  const fieldsError = exactFieldsError(record, fields, [], "wave_gate_history entry");
  if (fieldsError !== null) return parseErr(fieldsError);
  const common = parseCompletedWaveGateCommon(record);
  if (!common.ok) return common;
  if (record.schemaVersion === 1) {
    return parseOk(Object.freeze({ schemaVersion: 1, ...common.value }));
  }
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
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
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
  const wave = parseWaveNumber(record.wave, "orphaned_wave_gate_history.wave");
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
  if (raw === undefined) return parseOk(undefined);
  if (!Array.isArray(raw)) return parseErr("orphaned_wave_gate_history must be an array when present");
  const history: OrphanedWaveGateRetirement[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = parseOrphanedWaveGateRetirement(raw[index]);
    if (!parsed.ok) return parseErr(`orphaned_wave_gate_history[${index}]: ${parsed.error}`);
    history.push(parsed.value);
  }
  const retiredRunIds = history.map(({ runId }) => runId);
  if (new Set(retiredRunIds).size !== retiredRunIds.length) {
    return parseErr("orphaned_wave_gate_history contains duplicate retired run identities");
  }
  return parseOk(Object.freeze(history));
}

const SPEC_TRACE_WAVE_GATE_RETIREMENT_FIELDS = [
  "schemaVersion", "kind", "runId", "wave", "authorityDigest", "revision", "runsRoot",
  "reason", "supersededBy",
] as const;

function specTraceWaveGateRetirementReasonError(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512 || raw.trim() !== raw) {
    return "spec_trace_wave_gate_retirements.reason must be exact non-blank trimmed text of at most 512 characters";
  }
  return null;
}

function parseSpecTraceSupersededBy(
  raw: unknown,
  runId: SpecTraceWaveGateRetirement["runId"],
): ParseResult<SpecTraceWaveGateRetirement["supersededBy"]> {
  if (raw === null) return parseOk(null);
  const parsedSupersededBy = parseOrchestrationRunId(raw);
  if (!parsedSupersededBy.ok) {
    return parseErr(`spec_trace_wave_gate_retirements.supersededBy: ${parsedSupersededBy.error.message}`);
  }
  if (parsedSupersededBy.value === runId) {
    return parseErr("spec_trace_wave_gate_retirements run cannot supersede itself");
  }
  return parseOk(parsedSupersededBy.value);
}

/** Parse one immutable audit of an abandoned Wave Gate retired for trace v2. */
function parseSpecTraceWaveGateRetirement(raw: unknown): ParseResult<SpecTraceWaveGateRetirement> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
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
  const wave = parseWaveNumber(record.wave, "spec_trace_wave_gate_retirements.wave");
  if (!wave.ok) return parseErr(wave.error);
  const revision = parseIntegerBound(record.revision, "spec_trace_wave_gate_retirements.revision", 0, "a non-negative safe integer");
  if (!revision.ok) return parseErr(revision.error);
  if (typeof record.runsRoot !== "string" || !isAbsolute(record.runsRoot) || resolve(record.runsRoot) !== record.runsRoot) {
    return parseErr("spec_trace_wave_gate_retirements.runsRoot must be an absolute normalized path");
  }
  const reasonError = specTraceWaveGateRetirementReasonError(record.reason);
  if (reasonError !== null) return parseErr(reasonError);
  const reason = record.reason as string;
  const supersededBy = parseSpecTraceSupersededBy(record.supersededBy, runId.value);
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
  if (raw === undefined) return parseOk(undefined);
  if (!Array.isArray(raw)) return parseErr("spec_trace_wave_gate_retirements must be an array when present");
  const retirements: SpecTraceWaveGateRetirement[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = parseSpecTraceWaveGateRetirement(raw[index]);
    if (!parsed.ok) return parseErr(`spec_trace_wave_gate_retirements[${index}]: ${parsed.error}`);
    retirements.push(parsed.value);
  }
  const runIds = retirements.map(({ runId }) => runId);
  if (new Set(runIds).size !== runIds.length) {
    return parseErr("spec_trace_wave_gate_retirements contains duplicate retired run identities");
  }
  const authorityIdentities = retirements.map((entry) =>
    `${entry.wave}:${entry.authorityDigest}:${entry.revision}:${entry.runsRoot}`);
  if (new Set(authorityIdentities).size !== authorityIdentities.length) {
    return parseErr("spec_trace_wave_gate_retirements contains colliding protected authority identities");
  }
  return parseOk(Object.freeze(retirements));
}

/** One task-identity grammar shared by load and operator-validation boundaries. */
export function taskIdError(value: unknown, label: string): string | null {
  if (typeof value !== "string" || value === "") {
    return `${label}: id must be a non-empty string, got ${JSON.stringify(value)}`;
  }
  return parseTaskId(value, `${label}: id`).ok
    ? null
    : `${label}: id must match T\\d+, got ${JSON.stringify(value)}`;
}

export function orphanExecutionReservationError(
  tasks: readonly Record<string, unknown>[],
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

export function taskDependencyErrors(tasks: readonly Record<string, unknown>[]): readonly string[] {
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
      if (
        typeof task.wave === "number" && typeof dependencyTask.wave === "number" &&
        dependencyTask.wave >= task.wave
      ) {
        errors.push(
          `Task ${id} (wave ${task.wave}): depends on '${dependency}' (wave ${dependencyTask.wave}) — deps must be in earlier wave`,
        );
      }
    }
  }
  return errors;
}

/**
 * Prove one task entry at the load boundary.
 *
 * Split into one validator per concern. The ORDER is preserved exactly —
 * each helper runs in the sequence its checks originally ran in, and the
 * first non-null error still wins — so the diagnostic a drifted graph
 * produces is unchanged.
 */
export function taskUnionError(v: unknown, index: number): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return `tasks[${index}] must be an object`;
  }
  const t = v as Record<string, unknown>;
  const identityError = taskIdError(t.id, `tasks[${index}]`);
  if (identityError !== null) return identityError;
  const id = t.id as string;
  // Every validator below proves one family of the Task cast; each documents
  // its own. The first failure wins, so the operator sees the outermost cause.
  return taskShapeError(t, index, id)
    ?? taskBaselineError(t, index, id)
    ?? taskAttemptAuthorityError(t, index, id)
    ?? taskRepositoryCarryError(t, index, id)
    ?? taskPacketError(t, index, id)
    ?? taskStatusError(t, index, id)
    ?? taskEvidenceError(t, index, id)
    ?? taskFindingsError(t, index, id);
}

/** Structural fields the Task cast asserts: names, wave, dependencies, files. */
function taskShapeError(
  t: Record<string, unknown>,
  index: number,
  id: string,
): string | null {
  // drifted or hand-edited graph must fail at the load boundary, not
  // explode later inside typed gate logic that trusts Task's shape.
  if (typeof t.description !== "string" || t.description.trim() === "") {
    return `tasks[${index}] ("${id}"): description must be a non-empty string, got ${JSON.stringify(t.description)}`;
  }
  if (typeof t.agent !== "string" || t.agent.trim() === "") {
    return `tasks[${index}] ("${id}"): agent must be a non-empty string, got ${JSON.stringify(t.agent)}`;
  }
  if (!KNOWN_AGENTS.has(t.agent)) {
    return `tasks[${index}] ("${id}"): unknown agent ${JSON.stringify(t.agent)}`;
  }
  if (typeof t.wave !== "number" || !Number.isInteger(t.wave) || t.wave < 1) {
    return `tasks[${index}] ("${id}"): wave must be an integer >= 1, got ${JSON.stringify(t.wave)}`;
  }
  if (!Array.isArray(t.depends_on) || t.depends_on.some((d) => typeof d !== "string")) {
    return `tasks[${index}] ("${id}"): depends_on must be an array of strings`;
  }
  if (t.file_list !== undefined) {
    if (!Array.isArray(t.file_list)) {
      return `tasks[${index}] ("${id}"): file_list must be an array of canonical repository-relative paths when present`;
    }
    const seen = new Set<string>();
    for (const [pathIndex, rawPath] of t.file_list.entries()) {
      const path = parseReviewPath(rawPath, `tasks[${index}] ("${id}"): file_list[${pathIndex}]`);
      if (!path.ok) return path.errors.join("; ");
      if (isProtectedVerificationPath(path.value)) {
        return (
          `tasks[${index}] ("${id}"): file_list path '${path.value}' is protected verification infrastructure; ` +
          `remove it from this Task`
        );
      }
      if (seen.has(path.value)) return `tasks[${index}] ("${id}"): file_list repeats '${path.value}'`;
      seen.add(path.value);
    }
  }
  if (
    t.files_modified !== undefined &&
    (!Array.isArray(t.files_modified) || t.files_modified.some((f) => typeof f !== "string"))
  ) {
    return `tasks[${index}] ("${id}"): files_modified must be an array of strings when present`;
  }
  return null;
}

/** Declared artifact baselines and their agreement with file_list. */
function taskBaselineError(
  t: Record<string, unknown>,
  index: number,
  id: string,
): string | null {
  const fileListAgreement = (
    raw: unknown,
    field: "artifact_baseline" | "attempt_artifact_baseline",
    coverage: "exact" | "prefix",
    requirement: string,
  ): string | null => {
    const baseline = parseDeclaredArtifactBaseline(raw, `tasks[${index}] ("${id}"): ${field}`);
    if (!baseline.ok) return baseline.errors.join("; ");
    const declaredArtifacts = Array.isArray(t.file_list) ? t.file_list : [];
    const actualArtifacts = baseline.value.map(({ artifact }) => artifact);
    const covers = coverage === "exact"
      ? actualArtifacts.length === declaredArtifacts.length
      : actualArtifacts.length >= declaredArtifacts.length;
    if (
      !covers ||
      declaredArtifacts.some((artifact, artifactIndex) => artifact !== actualArtifacts[artifactIndex])
    ) {
      return `tasks[${index}] ("${id}"): ${field} ${requirement}`;
    }
    return null;
  };
  if (t.artifact_baseline !== undefined) {
    const error = fileListAgreement(
      t.artifact_baseline,
      "artifact_baseline",
      "exact",
      "must exactly match file_list in order",
    );
    if (error !== null) return error;
  }
  if (t.attempt_artifact_baseline !== undefined) {
    const label = `tasks[${index}] ("${id}"): attempt_artifact_baseline`;
    const baseline = parseDeclaredArtifactBaseline(t.attempt_artifact_baseline, label);
    if (!baseline.ok) return baseline.errors.join("; ");
    if (t.active_implementation_attempt !== undefined) {
      const expectedRaw = [
        ...(Array.isArray(t.file_list) ? t.file_list : []),
        ...(Array.isArray(t.files_modified) ? t.files_modified : []),
      ];
      const expected: string[] = [];
      for (const [pathIndex, rawPath] of expectedRaw.entries()) {
        const parsed = parseReviewPath(rawPath, `${label}.registration_scope[${pathIndex}]`);
        if (!parsed.ok) return parsed.errors.join("; ");
        if (!expected.includes(parsed.value)) expected.push(parsed.value);
      }
      const actual = baseline.value.map(({ artifact }) => artifact);
      const actualSet = new Set(actual);
      if (actual.length !== expected.length || actualSet.size !== expected.length ||
          expected.some((path) => !actualSet.has(path))) {
        return `${label} path set must exactly equal unique(file_list + files_modified) at registration scope`;
      }
    } else {
      const error = fileListAgreement(
        t.attempt_artifact_baseline,
        "attempt_artifact_baseline",
        "prefix",
        "must cover file_list first and in order",
      );
      if (error !== null) return error;
    }
  }
  if (t.attempt_repository_baseline !== undefined) {
    const baseline = parseDeclaredArtifactBaseline(
      t.attempt_repository_baseline,
      `tasks[${index}] ("${id}"): attempt_repository_baseline`,
    );
    if (!baseline.ok) return baseline.errors.join("; ");
  }
  return null;
}

/** Modern attempt authority, baseline digest lockstep, and exact receipt history. */
function taskAttemptAuthorityError(
  t: Record<string, unknown>,
  index: number,
  id: string,
): string | null {
  const label = `tasks[${index}] ("${id}")`;
  const history = t.implementation_attempt_history === undefined
    ? undefined
    : parseImplementationAttemptHistory(
        t.implementation_attempt_history,
        `${label}: implementation_attempt_history`,
      );
  if (history !== undefined) {
    if (!history.ok) return history.error.errors.join("; ");
    if (history.value.some((receipt) => receipt.taskId !== id)) {
      return `${label}: implementation_attempt_history receipt taskId must equal ${id}`;
    }
  }
  if (t.legacy_execution_reservation !== undefined && t.legacy_execution_reservation !== true) {
    return `${label}: legacy_execution_reservation must be true when present`;
  }
  if (t.active_implementation_attempt === undefined) return null;
  if (t.legacy_execution_reservation === true) {
    return `${label}: active_implementation_attempt cannot coexist with legacy_execution_reservation`;
  }
  if (t.legacy_missing_proof === true || t.proof === undefined) {
    return `${label}: active_implementation_attempt requires modern authored Proof`;
  }
  const authority = parseImplementationAttemptAuthority(t.active_implementation_attempt);
  if (!authority.ok) return `${label}: invalid active_implementation_attempt: ${authority.error.errors.join("; ")}`;
  if (authority.value.taskId !== id || authority.value.wave !== t.wave) {
    return `${label}: active_implementation_attempt must match Task id and Wave`;
  }
  if (history?.ok && history.value.some((receipt) =>
    receipt.authorityDigest === authority.value.authorityDigest ||
    receipt.reservationId === authority.value.reservationId)) {
    return `${label}: active_implementation_attempt authorityDigest and reservationId must be absent from implementation_attempt_history`;
  }
  if (t.reserved_at !== authority.value.reservedAt) {
    return `${label}: reserved_at must equal active_implementation_attempt.reservedAt`;
  }
  if (t.attempt_artifact_baseline === undefined || t.attempt_repository_baseline === undefined) {
    return `${label}: active_implementation_attempt requires both attempt baselines`;
  }
  const taskDigest = canonicalArtifactBaselineDigest(t.attempt_artifact_baseline);
  const dirtyDigest = canonicalArtifactBaselineDigest(t.attempt_repository_baseline);
  if (!taskDigest.ok || !dirtyDigest.ok) {
    return `${label}: active attempt baseline is invalid: ${[
      ...(taskDigest.ok ? [] : taskDigest.error.errors),
      ...(dirtyDigest.ok ? [] : dirtyDigest.error.errors),
    ].join("; ")}`;
  }
  if (taskDigest.value !== authority.value.taskScopeBaselineDigest ||
      dirtyDigest.value !== authority.value.dirtySetBaselineDigest) {
    return `${label}: active attempt baseline digests do not match active_implementation_attempt`;
  }
  return null;
}

/** Persistent unresolved-attempt repository authority and attributed paths. */
function taskRepositoryCarryError(
  t: Record<string, unknown>,
  index: number,
  id: string,
): string | null {
  const label = `tasks[${index}] ("${id}")`;
  if (t.repository_baseline !== undefined) {
    const baseline = parseDeclaredArtifactBaseline(t.repository_baseline, `${label}: repository_baseline`);
    if (!baseline.ok) return baseline.errors.join("; ");
    if (t.active_implementation_attempt !== undefined && t.attempt_repository_baseline !== undefined) {
      const persistentDigest = canonicalArtifactBaselineDigest(baseline.value);
      const attemptDigest = canonicalArtifactBaselineDigest(t.attempt_repository_baseline);
      if (!persistentDigest.ok || !attemptDigest.ok || persistentDigest.value !== attemptDigest.value) {
        return `${label}: active attempt_repository_baseline must equal retained repository_baseline`;
      }
    }
  }
  if (t.unresolved_repository_paths !== undefined) {
    if (t.repository_baseline === undefined) {
      return `${label}: unresolved_repository_paths requires repository_baseline`;
    }
    if (!Array.isArray(t.unresolved_repository_paths)) {
      return `${label}: unresolved_repository_paths must be an array of canonical repository paths`;
    }
    const canonical: string[] = [];
    for (const [pathIndex, raw] of t.unresolved_repository_paths.entries()) {
      const parsed = parseReviewPath(raw, `${label}: unresolved_repository_paths[${pathIndex}]`);
      if (!parsed.ok) return parsed.errors.join("; ");
      canonical.push(parsed.value);
    }
    if (canonical.length === 0 || new Set(canonical).size !== canonical.length) {
      return `${label}: unresolved_repository_paths must be non-empty and unique when present`;
    }
  }
  if ((t.status === "implemented" || t.status === "completed") && t.repository_baseline !== undefined &&
      t.active_implementation_attempt === undefined) {
    return `${label}: accepted implementation lifecycle cannot retain repository_baseline`;
  }
  return null;
}

/** Issued review packets, recovered writes, and plan context. */
function taskPacketError(
  t: Record<string, unknown>,
  index: number,
  id: string,
): string | null {
  if (t.accepted_review_authority !== undefined) {
    if (typeof t.accepted_review_authority !== "object" || t.accepted_review_authority === null || Array.isArray(t.accepted_review_authority)) {
      return `tasks[${index}] ("${id}"): accepted_review_authority must be an object`;
    }
    const authority = t.accepted_review_authority as Record<string, unknown>;
    const fields = Object.keys(authority).sort();
    const allowed = ["generation", "packet_id", "head_sha", "scope", "run_id", "authority_digest"];
    if (fields.some((field) => !allowed.includes(field)) ||
        !["generation", "packet_id", "head_sha", "scope"].every((field) => fields.includes(field))) {
      return `tasks[${index}] ("${id}"): accepted_review_authority has an invalid field set`;
    }
    if (typeof authority.generation !== "number" || !Number.isInteger(authority.generation) || authority.generation < 0 ||
        typeof authority.packet_id !== "string" || !/^[0-9a-f]{64}$/.test(authority.packet_id) ||
        !isExactGitSha(authority.head_sha)) {
      return `tasks[${index}] ("${id}"): accepted_review_authority has invalid generation, packet_id, or head_sha`;
    }
    if (!Array.isArray(authority.scope) || authority.scope.length === 0) {
      return `tasks[${index}] ("${id}"): accepted_review_authority.scope must be a non-empty canonical path array`;
    }
    const scope = authority.scope.map((path, pathIndex) => parseReviewPath(path, `tasks[${index}] ("${id}"): accepted_review_authority.scope[${pathIndex}]`));
    const scopeError = scope.find((parsed) => !parsed.ok);
    if (scopeError !== undefined && !scopeError.ok) return scopeError.errors.join("; ");
    const scopePaths = scope.map((parsed) => parsed.ok ? parsed.value : "");
    const sortedScopePaths = [...scopePaths].sort();
    if (new Set(scopePaths).size !== scopePaths.length || scopePaths.some((path, pathIndex) => path !== sortedScopePaths[pathIndex])) {
      return `tasks[${index}] ("${id}"): accepted_review_authority.scope must be sorted and unique`;
    }
    if ((authority.run_id === undefined) !== (authority.authority_digest === undefined) ||
        (authority.run_id !== undefined && (!parseOrchestrationRunId(authority.run_id).ok ||
          typeof authority.authority_digest !== "string" || !/^[0-9a-f]{64}$/.test(authority.authority_digest)))) {
      return `tasks[${index}] ("${id}"): accepted_review_authority run authority must be complete and valid when present`;
    }
  }
  if (t.issued_review_packets !== undefined) {
    if (!Array.isArray(t.issued_review_packets)) {
      return `tasks[${index}] ("${id}"): issued_review_packets must be an array`;
    }
    const packetIds = new Set<string>();
    const packetPaths = new Set<string>();
    for (const [packetIndex, raw] of t.issued_review_packets.entries()) {
      const label = `tasks[${index}] ("${id}"): issued_review_packets[${packetIndex}]`;
      const registration = parseIssuedReviewPacketRegistration(raw, label);
      if (!registration.ok) return registration.errors.join("; ");
      if (registration.value.task_id !== id) return `${label}.task_id must equal task id ${id}`;
      if (packetIds.has(registration.value.packet_id)) return `${label}.packet_id duplicates an earlier registration`;
      if (packetPaths.has(registration.value.packet_path)) return `${label}.packet_path duplicates an earlier registration`;
      packetIds.add(registration.value.packet_id);
      packetPaths.add(registration.value.packet_path);
    }
  }
  if (
    t.artifact_baseline_recovered_from !== undefined &&
    !isExactGitSha(t.artifact_baseline_recovered_from)
  ) {
    return `tasks[${index}] ("${id}"): artifact_baseline_recovered_from must be a lowercase 40- or 64-character Git SHA`;
  }
  if (t.recovered_artifact_writes !== undefined) {
    if (t.artifact_baseline_recovered_from === undefined) {
      return `tasks[${index}] ("${id}"): recovered_artifact_writes requires artifact_baseline_recovered_from`;
    }
    if (!Array.isArray(t.recovered_artifact_writes)) {
      return `tasks[${index}] ("${id}"): recovered_artifact_writes must be an array`;
    }
    const packetIds = new Set<string>();
    for (const [recoveryIndex, raw] of t.recovered_artifact_writes.entries()) {
      const label = `tasks[${index}] ("${id}"): recovered_artifact_writes[${recoveryIndex}]`;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return `${label} must be an object`;
      const recovery = raw as Record<string, unknown>;
      if (!isExactGitSha(recovery.baseline_sha)) {
        return `${label}.baseline_sha must be an exact Git SHA`;
      }
      if (t.artifact_baseline_recovered_from !== undefined && recovery.baseline_sha !== t.artifact_baseline_recovered_from) {
        return `${label}.baseline_sha must equal artifact_baseline_recovered_from`;
      }
      if (typeof recovery.packet_id !== "string" || !/^[0-9a-f]{64}$/.test(recovery.packet_id)) {
        return `${label}.packet_id must be a lowercase SHA-256 digest`;
      }
      if (packetIds.has(recovery.packet_id)) return `${label}.packet_id duplicates an earlier recovery`;
      packetIds.add(recovery.packet_id);
      const packetPath = parseReviewPath(recovery.packet_path, `${label}.packet_path`);
      if (!packetPath.ok) return packetPath.errors.join("; ");
      if (!Array.isArray(recovery.modified_paths) || recovery.modified_paths.length === 0) {
        return `${label}.modified_paths must be a non-empty array`;
      }
      const seenPaths = new Set<string>();
      for (const [pathIndex, path] of recovery.modified_paths.entries()) {
        const parsed = parseReviewPath(path, `${label}.modified_paths[${pathIndex}]`);
        if (!parsed.ok) return parsed.errors.join("; ");
        if (seenPaths.has(parsed.value)) return `${label}.modified_paths duplicates ${JSON.stringify(parsed.value)}`;
        if (Array.isArray(t.file_list) && !t.file_list.includes(parsed.value)) {
          return `${label}.modified_paths includes ${JSON.stringify(parsed.value)} outside file_list`;
        }
        seenPaths.add(parsed.value);
      }
    }
  }
  if (t.plan_context !== undefined && typeof t.plan_context !== "string") {
    return `tasks[${index}] ("${id}"): plan_context must be a string when present`;
  }
  return null;
}

/** Status, review status/generation/run, and exact flat lifecycle invariants. */
function taskStatusError(
  t: Record<string, unknown>,
  index: number,
  id: string,
): string | null {
  const label = `tasks[${index}] ("${id}")`;
  if (!(TASK_STATUSES as readonly string[]).includes(t.status as string)) {
    return `${label}: status ${JSON.stringify(t.status)} is not one of ${TASK_STATUSES.join(", ")}`;
  }
  const verification = parseTaskVerificationPolicy(t, label);
  if (!verification.ok) return verification.errors.join("; ");
  if (t.review_status !== undefined && !(REVIEW_STATUSES as readonly string[]).includes(t.review_status as string)) {
    return `${label}: review_status ${JSON.stringify(t.review_status)} is not one of ${REVIEW_STATUSES.join(", ")}`;
  }
  if (t.review_generation !== undefined && (
    typeof t.review_generation !== "number" || !Number.isInteger(t.review_generation) || t.review_generation < 0
  )) return `${label}: review_generation must be a non-negative integer`;
  if (t.review_run !== undefined && t.review_generation === undefined) return `${label}: review_run requires review_generation`;
  if (t.review_run !== undefined && t.review_status !== "pending" && t.review_status !== "evidence_capture_failed") {
    return `${label}: an in-progress review_run requires pending or evidence_capture_failed status`;
  }
  if (t.revalidation_required !== undefined && t.revalidation_required !== true) {
    return `${label}: revalidation_required must be true when present`;
  }
  if (t.revalidation_required === true && t.status !== "pending") {
    return `${label}: revalidation_required requires pending status until fresh task evidence is recorded`;
  }
  if (t.legacy_missing_proof !== undefined && t.legacy_missing_proof !== true) {
    return `${label}: legacy_missing_proof must be true when present`;
  }

  if (t.proof === undefined) {
    if (t.status === "pending") {
      return t.legacy_missing_proof === undefined
        ? null
        : `${label}: pending lifecycle cannot carry legacy_missing_proof`;
    }
    if (t.status === "implemented" || t.status === "completed") return null;
    return `${label}: modern failed lifecycle requires failed Proof`;
  }
  if (t.legacy_missing_proof === true) return `${label}: legacy_missing_proof requires absent Proof`;
  const proof = parseTaskProof(t.proof);
  if (!proof.ok) return `${label}: invalid proof: ${proof.errors.join("; ")}`;
  const expectedObligations = deriveProofObligations({
    verificationPolicy: verification.value.policy,
    declaredArtifacts: Array.isArray(t.file_list) ? t.file_list : [],
  });
  const obligationsMatch = proof.value.obligations.length === expectedObligations.length &&
    proof.value.obligations.every((actual, obligationIndex) => {
      const expected = expectedObligations[obligationIndex];
      return expected !== undefined && actual.kind === expected.kind &&
        (actual.kind !== "declared-artifact-changed" ||
          (expected.kind === "declared-artifact-changed" && actual.artifact === expected.artifact));
    });
  if (!obligationsMatch) return `${label}: proof obligations do not exactly match verification policy and file_list`;
  if (t.status === "pending") {
    return t.revalidation_required === true || proof.value.state !== "satisfied"
      ? null
      : `${label}: status/proof lockstep violated — pending lifecycle without revalidation cannot carry satisfied Proof`;
  }
  if (t.status === "implemented" || t.status === "completed") {
    return proof.value.state === "satisfied"
      ? null
      : `${label}: status/proof lockstep violated — ${t.status} lifecycle requires satisfied Proof`;
  }
  return proof.value.state === "failed"
    ? null
    : `${label}: status/proof lockstep violated — failed lifecycle requires failed Proof`;
}

/** Test evidence. The acceptance DECISION is delegated to parseTaskTestResult —
 *  the ONE validator for the shared TaskTestResult/ProofTestResult union — so
 *  the load boundary can never drift from the proof evaluator on what shape
 *  the persisted field may have. Exact-shape causes pass through verbatim;
 *  older malformed verdicts retain the operator-facing spelling pinned by the
 *  load-guard suite. */
function taskEvidenceError(
  t: Record<string, unknown>,
  index: number,
  id: string,
): string | null {
  const prefix = `tasks[${index}] ("${id}")`;
  const hasWritten = t.new_tests_written !== undefined;
  const hasEvidence = t.new_test_evidence !== undefined;
  if (t.new_test_observation !== undefined && (hasWritten || hasEvidence)) {
    return `${prefix}: new_test_observation cannot coexist with legacy new_tests_written/new_test_evidence`;
  }
  if (t.new_test_observation !== undefined) {
    const parsedObservation = parseStoredNewTestEvidence(t.new_test_observation);
    if (!parsedObservation.ok) return `${prefix}: ${parsedObservation.error}`;
  }
  if (!hasWritten && hasEvidence) {
    return `${prefix}: new_test_evidence requires new_tests_written`;
  }
  if (hasWritten && typeof t.new_tests_written !== "boolean") {
    return `${prefix}: new_tests_written must be a boolean when present`;
  }
  if (hasEvidence && typeof t.new_test_evidence !== "string") {
    return `${prefix}: new_test_evidence must be a string when present`;
  }
  if (t.new_tests_written === true &&
      (typeof t.new_test_evidence !== "string" || t.new_test_evidence.trim() === "")) {
    return `${prefix}: new_tests_written true requires non-empty new_test_evidence`;
  }
  if (t.test_result === undefined) return null;
  const parsed = parseTaskTestResult(t.test_result, `${prefix}: test_result`);
  if (parsed.ok) return null;
  const exactShapeError = parsed.errors.find((error) => error.includes("unexpected field(s)"));
  if (exactShapeError !== undefined) return exactShapeError;
  const r = t.test_result as Record<string, unknown>;
  if (typeof r !== "object" || r === null) return `${prefix}: test_result must be an object`;
  if (r.verdict === "untrusted") {
    return `${prefix}: untrusted test_result requires a boolean passed and a non-empty label naming the weak source`;
  }
  return `${prefix}: test_result.verdict ${JSON.stringify(r.verdict)} is not one of trusted-pass, trusted-fail, untrusted`;
}

/** Findings and every view derived from them. */
function taskFindingsError(
  t: Record<string, unknown>,
  index: number,
  id: string,
): string | null {
  // `findings` and `refuted_findings` are proven for the same reason every
  // union above is: the cast at the bottom of parseTaskGraph asserts
  // `readonly Finding[]`, and a panel helper reading an unproven one surfaces
  // as an unhandled TypeError from inside a pure function rather than as a
  // contract diagnostic. Rejected rather than repaired here — dropping a
  // malformed entry on every read would silently lose a critical, and
  // `repair-task-graph` is the guarded, atomic repair that restores lockstep.
  const findingsError = findingsUnionError(t.findings, `tasks[${index}] ("${id}"): findings`);
  if (findingsError !== null) return findingsError;
  // The two derived views earn their `readonly string[]` type independently of
  // `findings`, because a task can carry a view with no array beside it (every
  // pre-identity graph does) and the lockstep check below returns early on
  // `findings === undefined`. Without this, a `critical_findings: ["real", 42]`
  // on such a task loaded clean and `checkCriticalFindings` threw
  // `f.trim is not a function` out of the wave gate.
  for (const severity of ["critical", "advisory"] as const) {
    const viewError = findingsViewError(
      t[`${severity}_findings`],
      `tasks[${index}] ("${id}"): ${severity}_findings`,
    );
    if (viewError !== null) return viewError;
  }
  // Shape alone is not the invariant. `critical_findings`/`advisory_findings`
  // are DERIVED views, the wave gate counts them, and nothing proved they agree
  // with the array they summarize — so a critical present in only one of the
  // two either never blocked the wave or could never be adjudicated.
  const lockstepError = findingsLockstepError(
    t.findings,
    t.critical_findings,
    t.advisory_findings,
    `tasks[${index}] ("${id}")`,
  );
  if (lockstepError !== null) return lockstepError;
  const refutationsError = refutationsUnionError(
    t.refuted_findings,
    `tasks[${index}] ("${id}"): refuted_findings`,
  );
  if (refutationsError !== null) return refutationsError;
  const resolutionsError = resolutionsUnionError(
    t.resolved_findings,
    `tasks[${index}] ("${id}"): resolved_findings`,
  );
  if (resolutionsError !== null) return resolutionsError;
  const collisionError = findingIdCollisionError(
    t.findings,
    t.refuted_findings,
    `tasks[${index}] ("${id}")`,
    t.resolved_findings,
  );
  if (collisionError !== null) return collisionError;
  const runError = reviewRunError(
    t.review_run,
    t.review_generation,
    t.findings,
    `tasks[${index}] ("${id}"): review_run`,
  );
  if (runError !== null) return runError;
  if (t.review_run !== undefined) {
    const run = t.review_run as Record<string, unknown>;
    if (run.slot_authority !== undefined) {
      const slots = run.slot_authority;
      if (!Array.isArray(slots) || slots.length === 0) {
        return `tasks[${index}] ("${id}"): review_run.slot_authority must be a non-empty array when present`;
      }
      const expectedAgents = run.expected_agents as readonly string[];
      if (slots.length !== expectedAgents.length) {
        return `tasks[${index}] ("${id}"): review_run.slot_authority must cover every expected agent exactly once in order`;
      }
      const slotIds = new Set<string>();
      for (const [slotIndex, rawSlot] of slots.entries()) {
        const label = `tasks[${index}] ("${id}"): review_run.slot_authority[${slotIndex}]`;
        if (typeof rawSlot !== "object" || rawSlot === null || Array.isArray(rawSlot)) return `${label} must be an object`;
        const slot = rawSlot as Record<string, unknown>;
        const fields = Object.keys(slot).sort();
        const expectedFields = ["agent", "attempted", "slot_id"].sort();
        if (fields.length !== expectedFields.length || fields.some((field, fieldIndex) => field !== expectedFields[fieldIndex])) {
          return `${label} must contain exactly agent/slot_id/attempted`;
        }
        if (slot.agent !== expectedAgents[slotIndex]) return `${label}.agent must match expected_agents in order`;
        const slotId = parseSlotId(slot.slot_id);
        if (!slotId.ok) return `${label}.slot_id: ${slotId.error.message}`;
        if (slotIds.has(slotId.value)) return `${label}.slot_id duplicates an earlier Review Run slot`;
        slotIds.add(slotId.value);
        if (slot.attempted !== 1 && slot.attempted !== 2) return `${label}.attempted must be 1 or 2`;
      }
    }
  }
  return evidenceFailureError(t, `tasks[${index}] ("${id}")`, REVIEW_SUB_AGENTS);
}

/** The persisted lifecycle fields shared by the loader and operator validator. */
export function taskGraphLifecycleErrors(obj: Record<string, unknown>): readonly string[] {
  const errors: string[] = [];
  if (!("current_phase" in obj)) errors.push("missing current_phase");
  else if (!(PHASE_ORDER as readonly unknown[]).includes(obj.current_phase)) {
    errors.push(`current_phase ${JSON.stringify(obj.current_phase)} is not one of ${PHASE_ORDER.join(", ")}`);
  }
  if (!("phase_artifacts" in obj)) errors.push("missing phase_artifacts");
  else if (typeof obj.phase_artifacts !== "object" || obj.phase_artifacts === null ||
      Array.isArray(obj.phase_artifacts)) {
    errors.push("phase_artifacts must be an object");
  } else {
    for (const [phase, artifact] of Object.entries(obj.phase_artifacts)) {
      if (!(PHASE_ORDER as readonly string[]).includes(phase)) {
        errors.push(`phase_artifacts contains unknown phase ${JSON.stringify(phase)}`);
      } else if (typeof artifact !== "string") {
        errors.push(`phase_artifacts.${phase} must be a string, got ${JSON.stringify(artifact)}`);
      }
    }
  }
  const skippedPhases = obj.skipped_phases ?? [];
  if (!Array.isArray(skippedPhases)
    || skippedPhases.some((phase) => !(PHASE_ORDER as readonly unknown[]).includes(phase))) {
    errors.push(`skipped_phases must be an array containing only: ${PHASE_ORDER.join(", ")}`);
  }
  return errors;
}

type ParsedWaveGateRegistrations = Readonly<{
  activeWaveGate: ActiveWaveGateRegistration | undefined;
  waveGateHistory: readonly CompletedWaveGateRegistration[] | undefined;
}>;

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
  let activeWaveGate: ActiveWaveGateRegistration | undefined;
  if (obj.active_wave_gate !== undefined) {
    const parsedRegistration = parseActiveWaveGateRegistration(obj.active_wave_gate);
    if (!parsedRegistration.ok) return parseErr(parsedRegistration.error);
    activeWaveGate = parsedRegistration.value;
  }

  let waveGateHistory: readonly CompletedWaveGateRegistration[] | undefined;
  if (obj.wave_gate_history !== undefined) {
    const parsedHistory = parseWaveGateHistory(obj.wave_gate_history, activeWaveGate);
    if (!parsedHistory.ok) return parseErr(parsedHistory.error);
    waveGateHistory = parsedHistory.value;
  }

  if (activeWaveGate?.terminalOutcome === null) {
    const conflict = nonterminalActiveGateConflict(obj, activeWaveGate, waveGateHistory);
    if (conflict !== null) return parseErr(conflict);
  }
  return parseOk({ activeWaveGate, waveGateHistory });
}

function parseWaveReopeningHistory(raw: unknown): ParseResult<readonly WaveReopeningAudit[] | undefined> {
  if (raw === undefined) return parseOk(undefined);
  if (!Array.isArray(raw)) return parseErr("wave_reopening_history must be an array when present");
  const audits: WaveReopeningAudit[] = [];
  for (const [index, rawAudit] of raw.entries()) {
    if (typeof rawAudit !== "object" || rawAudit === null || Array.isArray(rawAudit)) return parseErr(`wave_reopening_history[${index}] must be an object`);
    const audit = rawAudit as Record<string, unknown>;
    const fields = exactFieldsError(audit, ["schemaVersion", "kind", "proofMode", "runId", "wave", "authorityDigest", "completionReceipt", "reopenedTaskIds"], [], `wave_reopening_history[${index}]`);
    if (fields !== null || audit.schemaVersion !== 1 || audit.kind !== "completed-wave-reopened-for-review-integrity" ||
        (audit.proofMode !== "modern-exact-workspace-drift" && audit.proofMode !== "legacy-workspace-authority-unverifiable")) {
      return parseErr(fields ?? `wave_reopening_history[${index}] has invalid schema, kind, or proof mode`);
    }
    const runId = parseOrchestrationRunId(audit.runId);
    const authorityDigest = parseArtifactDigest(audit.authorityDigest);
    if (!runId.ok || !authorityDigest.ok || typeof audit.wave !== "number" || !Number.isInteger(audit.wave) || audit.wave < 1 ||
        !Array.isArray(audit.reopenedTaskIds) || audit.reopenedTaskIds.length === 0 ||
        audit.reopenedTaskIds.some((id) => taskIdError(id, `wave_reopening_history[${index}].reopenedTaskIds`) !== null) ||
        new Set(audit.reopenedTaskIds).size !== audit.reopenedTaskIds.length ||
        typeof audit.completionReceipt !== "object" || audit.completionReceipt === null) {
      return parseErr(`wave_reopening_history[${index}] has invalid authority, receipt, or reopened Task ids`);
    }
    const receipt = audit.completionReceipt as Record<string, unknown>;
    const effectId = parseEffectId(receipt.effectId);
    const receiptRunId = parseOrchestrationRunId(receipt.runId);
    const stateDigest = parseArtifactDigest(receipt.stateDigest);
    const committedRevision = receipt.committedRevision;
    if (!effectId.ok || !receiptRunId.ok || !stateDigest.ok || receipt.kind !== "protected-wave-state-committed" ||
        receiptRunId.value !== runId.value || typeof committedRevision !== "number" ||
        !Number.isSafeInteger(committedRevision) || committedRevision < 1) {
      return parseErr(`wave_reopening_history[${index}] has an invalid completion receipt`);
    }
    audits.push(Object.freeze({ schemaVersion: 1, kind: "completed-wave-reopened-for-review-integrity", proofMode: audit.proofMode,
      runId: runId.value, wave: audit.wave, authorityDigest: authorityDigest.value,
      completionReceipt: Object.freeze({ kind: "protected-wave-state-committed" as const, effectId: effectId.value, runId: runId.value, committedRevision, stateDigest: stateDigest.value }),
      reopenedTaskIds: Object.freeze([...(audit.reopenedTaskIds as string[])]), }));
  }
  const identities = audits.map((audit) => `${audit.runId}:${audit.authorityDigest}`);
  return new Set(identities).size === identities.length ? parseOk(Object.freeze(audits)) : parseErr("wave_reopening_history contains duplicate authority audits");
}

function parseWaveGateHistory(
  raw: unknown,
  activeWaveGate: ActiveWaveGateRegistration | undefined,
): ParseResult<readonly CompletedWaveGateRegistration[]> {
  if (!Array.isArray(raw)) return parseErr("wave_gate_history must be an array when present");
  const parsedHistory: CompletedWaveGateRegistration[] = [];
  for (let index = 0; index < raw.length; index++) {
    const parsed = parseCompletedWaveGateRegistration(raw[index]);
    if (!parsed.ok) return parseErr(`wave_gate_history[${index}]: ${parsed.error}`);
    parsedHistory.push(parsed.value);
  }
  const runIds = parsedHistory.map(({ runId }) => runId);
  if (new Set(runIds).size !== runIds.length) return parseErr("wave_gate_history contains duplicate run identities");
  const waves = parsedHistory.map(({ wave }) => wave);
  if (new Set(waves).size !== waves.length) return parseErr("wave_gate_history contains duplicate completed Waves");
  if (activeWaveGate !== undefined && runIds.includes(activeWaveGate.runId)) {
    return parseErr(`active_wave_gate run ${activeWaveGate.runId} is already terminal in wave_gate_history`);
  }
  return parseOk(Object.freeze(parsedHistory));
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
function frozenJsonCopy(value: unknown, copies = new WeakMap<object, unknown>()): unknown {
  if (typeof value !== "object" || value === null) return value;
  const existing = copies.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    copies.set(value, copy);
    copy.push(...value.map((entry) => frozenJsonCopy(entry, copies)));
    return Object.freeze(copy);
  }
  const copy: Record<string, unknown> = {};
  copies.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = frozenJsonCopy(entry, copies);
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

function taskGraphScalarFieldError(obj: Record<string, unknown>): string | null {
  for (const field of ["spec_dir", "spec_file", "plan_file"] as const) {
    if (obj[field] !== undefined && obj[field] !== null && typeof obj[field] !== "string") {
      return `${field} must be a string or null when present, got ${JSON.stringify(obj[field])}`;
    }
  }
  for (const field of ["plan_title", "github_repo", "updated_at"] as const) {
    if (obj[field] !== undefined && typeof obj[field] !== "string") {
      return `${field} must be a string when present, got ${JSON.stringify(obj[field])}`;
    }
  }
  if (obj.github_issue !== undefined &&
      (typeof obj.github_issue !== "number" || !Number.isInteger(obj.github_issue) || obj.github_issue < 1)) {
    return `github_issue must be an integer >= 1 when present, got ${JSON.stringify(obj.github_issue)}`;
  }
  if (obj.current_wave !== undefined &&
      (typeof obj.current_wave !== "number" || !Number.isInteger(obj.current_wave) || obj.current_wave < 1)) {
    return `current_wave must be an integer >= 1 when present, got ${JSON.stringify(obj.current_wave)}`;
  }
  return null;
}

function migrateParsedTask(
  task: Record<string, unknown>,
  index: number,
  executing: ReadonlySet<string>,
): ParseResult<Record<string, unknown>> {
  const identity = parseTaskId(task.id, `tasks[${index}].id`);
  if (!identity.ok) return parseErr(identity.error.errors.join("; "));
  const verification = parseTaskVerificationPolicy(task, `tasks[${index}]`);
  if (!verification.ok) return parseErr(verification.errors.join("; "));
  let migrated: Record<string, unknown> = { ...task, id: identity.value };
  if (task.proof === undefined && task.status === "pending") {
    migrated = {
      ...migrated,
      proof: derivePendingTaskProof({
        verificationPolicy: verification.value.policy,
        declaredArtifacts: Array.isArray(task.file_list) ? task.file_list : [],
      }),
    };
  } else if (task.proof === undefined && (task.status === "implemented" || task.status === "completed")) {
    migrated = { ...migrated, legacy_missing_proof: true };
  } else if (task.proof !== undefined) {
    const proof = parseTaskProof(task.proof);
    if (!proof.ok) return parseErr(proof.errors.join("; "));
    migrated = { ...migrated, proof: proof.value };
  }
  if (task.active_implementation_attempt !== undefined) {
    const authority = parseImplementationAttemptAuthority(task.active_implementation_attempt);
    if (!authority.ok) return parseErr(authority.error.errors.join("; "));
    migrated = { ...migrated, active_implementation_attempt: authority.value };
  } else if (executing.has(String(task.id))) {
    migrated = { ...migrated, legacy_execution_reservation: true };
  } else {
    const { legacy_execution_reservation: staleLegacyClassification, ...withoutLegacyClassification } = migrated;
    void staleLegacyClassification;
    migrated = withoutLegacyClassification;
  }
  const repositoryCarry = task.repository_baseline ?? (
    task.active_implementation_attempt === undefined ? undefined : task.attempt_repository_baseline
  );
  if (repositoryCarry !== undefined) {
    const baseline = parseDeclaredArtifactBaseline(repositoryCarry, `tasks[${index}].repository_baseline`);
    if (!baseline.ok) return parseErr(baseline.errors.join("; "));
    migrated = { ...migrated, repository_baseline: baseline.value };
  }
  if (task.unresolved_repository_paths !== undefined) {
    if (!Array.isArray(task.unresolved_repository_paths)) {
      return parseErr(`tasks[${index}].unresolved_repository_paths must be an array`);
    }
    const paths: string[] = [];
    for (const [pathIndex, raw] of task.unresolved_repository_paths.entries()) {
      const parsed = parseReviewPath(raw, `tasks[${index}].unresolved_repository_paths[${pathIndex}]`);
      if (!parsed.ok) return parseErr(parsed.errors.join("; "));
      paths.push(parsed.value);
    }
    migrated = { ...migrated, unresolved_repository_paths: Object.freeze(paths.sort()) };
  }
  if (task.implementation_attempt_history !== undefined) {
    const history = parseImplementationAttemptHistory(task.implementation_attempt_history);
    if (!history.ok) return parseErr(history.error.errors.join("; "));
    migrated = { ...migrated, implementation_attempt_history: history.value };
  }
  if (task.test_result !== undefined) {
    const testResult = parseTaskTestResult(task.test_result, `tasks[${index}]: test_result`);
    if (!testResult.ok) return parseErr(testResult.errors.join("; "));
    migrated = { ...migrated, test_result: testResult.value };
  }
  const storedNewTests = task.new_test_observation === undefined
    ? null
    : parseStoredNewTestEvidence(task.new_test_observation);
  if (storedNewTests !== null && !storedNewTests.ok) return parseErr(storedNewTests.error);
  let parsedNewTests;
  if (storedNewTests?.ok) {
    parsedNewTests = storedNewTests.value;
  } else if (task.new_tests_written === undefined && task.new_test_evidence === undefined) {
    parsedNewTests = null;
  } else {
    parsedNewTests = parseNewTestEvidence(task.new_tests_written, task.new_test_evidence);
  }
  const {
    new_tests_written: _legacyNewTestsWritten,
    new_test_evidence: _legacyNewTestEvidence,
    ...withoutLegacyNewTests
  } = migrated;
  void _legacyNewTestsWritten;
  void _legacyNewTestEvidence;
  migrated = parsedNewTests === null
    ? withoutLegacyNewTests
    : { ...withoutLegacyNewTests, ...storedNewTestEvidence(parsedNewTests) };
  return parseOk(migrated);
}

function parseTaskGraphTasks(
  obj: Record<string, unknown>,
  executingTasks: readonly TaskId[],
): ParseResult<readonly unknown[]> {
  const tasks = obj.tasks ?? [];
  if (!Array.isArray(tasks)) return parseErr("tasks must be an array");
  const executing = new Set<string>(executingTasks);
  const parsedTasks: Record<string, unknown>[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const err = taskUnionError(tasks[i], i);
    if (err !== null) return parseErr(err);
    const migrated = migrateParsedTask(tasks[i] as Record<string, unknown>, i, executing);
    if (!migrated.ok) return migrated;
    parsedTasks.push(migrated.value);
  }
  const taskIds = parsedTasks.map((task) => task.id as string);
  const duplicateTaskId = taskIds.find((id, index) => taskIds.indexOf(id) !== index);
  if (duplicateTaskId !== undefined) return parseErr(`duplicate task id: ${duplicateTaskId}`);
  const orphanReservation = orphanExecutionReservationError(parsedTasks, [...executing]);
  if (orphanReservation !== null) return parseErr(orphanReservation);
  const relationError = parsedTasks.flatMap((task) => {
    const id = task.id as string;
    const isExecuting = executing.has(id);
    const modern = task.active_implementation_attempt !== undefined;
    const legacy = task.legacy_execution_reservation === true;
    if (modern && !isExecuting) return [`Task ${id}: active_implementation_attempt requires executing_tasks membership`];
    if (legacy && !isExecuting) return [`Task ${id}: legacy_execution_reservation requires executing_tasks membership`];
    if (isExecuting && !modern && !legacy) return [`Task ${id}: executing reservation is unclassified`];
    return [];
  })[0];
  if (relationError !== undefined) return parseErr(relationError);
  const dependencyError = taskDependencyErrors(parsedTasks)[0];
  if (dependencyError !== undefined) return parseErr(dependencyError);
  const trace = parseSpecTraceContract(obj.spec_trace_version, parsedTasks);
  return trace.ok ? parseOk(parsedTasks) : parseErr(specTraceDiagnosticMessages(trace).join("; "));
}

function parseTaskGraphWaveGates(obj: Record<string, unknown>): ParseResult<Record<string, unknown>> {
  const waveGates = obj.wave_gates ?? {};
  if (typeof waveGates !== "object" || waveGates === null || Array.isArray(waveGates)) {
    return parseErr("wave_gates must be an object");
  }
  for (const [wave, gate] of Object.entries(waveGates as Record<string, unknown>)) {
    // Wave numbers are written as String(wave) with wave >= 1 — canonical
    // decimal, no leading zeros. A key outside that domain ("01", "abc",
    // "-1", "1.0") would load here and persist, even though every writer
    // and reader only ever uses String(wave); reject it at the boundary so
    // the record-key domain matches the type's wave-number semantics.
    if (!/^(0|[1-9]\d*)$/.test(wave) || Number(wave) < 1) {
      return parseErr(`wave_gates key must be a canonical positive integer wave number, got ${JSON.stringify(wave)}`);
    }
    const err = waveGateError(gate, wave);
    if (err !== null) return parseErr(err);
  }
  return parseOk(waveGates as Record<string, unknown>);
}

type ParsedTaskGraphAuthorityFields = Readonly<{
  activeWaveGate: ActiveWaveGateRegistration | undefined;
  waveGateHistory: readonly CompletedWaveGateRegistration[] | undefined;
  waveReviewEpoch: WaveReviewEpochAuthority | undefined;
  verificationManifest: FrozenVerificationManifest | undefined;
  activeWaveCompletionSuite: AcceptedWaveCompletionReceipt | undefined;
}>;

function parseVerificationManifestField(raw: unknown): ParseResult<FrozenVerificationManifest | undefined> {
  if (raw === undefined) return parseOk(undefined);
  const parsed = parseFrozenVerificationManifest(raw);
  return parsed.ok
    ? parseOk(parsed.value)
    : parseErr(`verification_manifest: ${parsed.error.errors.join("; ")}`);
}

function completionRosterConflict(
  receipt: AcceptedWaveCompletionReceipt,
  manifest: FrozenVerificationManifest,
  active: ActiveWaveGateRegistration,
): string | null {
  const authorized = authorizeWaveCompletionSuite(manifest, active, receipt.workspaceDigest);
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
    const expected = authorized.value.checks[index]!;
    const actual = receipt.checks[index]!;
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
  const manifest = verificationManifest ?? defaultVerificationManifest();
  if (receipt.manifestDigest !== manifest.manifestDigest) {
    return parseErr("active_wave_completion_suite.manifestDigest must match verification_manifest authority");
  }
  const rosterConflict = completionRosterConflict(receipt, manifest, activeWaveGate);
  return rosterConflict === null ? parseOk(receipt) : parseErr(rosterConflict);
}

function parseTaskGraphAuthorityFields(obj: Record<string, unknown>): ParseResult<ParsedTaskGraphAuthorityFields> {
  const registrations = parseWaveGateRegistrations(obj);
  if (!registrations.ok) return parseErr(registrations.error);
  const { activeWaveGate, waveGateHistory } = registrations.value;
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
  const verificationManifest = parseVerificationManifestField(obj.verification_manifest);
  if (!verificationManifest.ok) return parseErr(verificationManifest.error);
  const activeWaveCompletionSuite = parseActiveWaveCompletionSuiteField(
    obj.active_wave_completion_suite,
    activeWaveGate,
    verificationManifest.value,
  );
  if (!activeWaveCompletionSuite.ok) return parseErr(activeWaveCompletionSuite.error);
  return parseOk({
    activeWaveGate,
    waveGateHistory,
    waveReviewEpoch: waveReviewEpoch.value,
    verificationManifest: verificationManifest.value,
    activeWaveCompletionSuite: activeWaveCompletionSuite.value,
  });
}

type ParsedTaskGraphHistoryFields = Readonly<{
  reopeningHistory: readonly WaveReopeningAudit[] | undefined;
  orphanedHistory: readonly OrphanedWaveGateRetirement[] | undefined;
  specTraceRetirements: readonly SpecTraceWaveGateRetirement[] | undefined;
}>;

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

function parseTaskGraphHistoryFields(
  obj: Record<string, unknown>,
  activeWaveGate: ActiveWaveGateRegistration | undefined,
  waveGateHistory: readonly CompletedWaveGateRegistration[] | undefined,
): ParseResult<ParsedTaskGraphHistoryFields> {
  const reopeningHistory = parseWaveReopeningHistory(obj.wave_reopening_history);
  if (!reopeningHistory.ok) return parseErr(reopeningHistory.error);
  const orphanedHistory = parseOrphanedWaveGateHistory(obj.orphaned_wave_gate_history);
  if (!orphanedHistory.ok) return parseErr(orphanedHistory.error);
  const specTraceRetirements = parseSpecTraceWaveGateRetirements(obj.spec_trace_wave_gate_retirements);
  if (!specTraceRetirements.ok) return parseErr(specTraceRetirements.error);
  if ((specTraceRetirements.value?.length ?? 0) > 0 && obj.spec_trace_version !== 2) {
    return parseErr("spec_trace_wave_gate_retirements requires spec_trace_version 2");
  }
  const activeConflict = activeWaveGateRetirementConflict(activeWaveGate, orphanedHistory.value, specTraceRetirements.value);
  if (activeConflict !== null) return parseErr(activeConflict);
  const specTraceConflict = specTraceRetirementCollision(waveGateHistory, orphanedHistory.value, specTraceRetirements.value);
  if (specTraceConflict !== null) return parseErr(specTraceConflict);
  const installationConflict = activeWaveGateInstallationAuditConflict(activeWaveGate, orphanedHistory.value);
  if (installationConflict !== null) return parseErr(installationConflict);
  return parseOk({
    reopeningHistory: reopeningHistory.value,
    orphanedHistory: orphanedHistory.value,
    specTraceRetirements: specTraceRetirements.value,
  });
}

type ParsedTaskGraphParts = Readonly<{
  phaseArtifacts: Readonly<Record<string, string>>;
  skippedPhases: readonly Phase[];
  tasks: readonly unknown[];
  executingTasks: readonly TaskId[] | undefined;
  waveGates: Readonly<Record<string, unknown>>;
  specCheck: SpecCheck | undefined;
  authority: ParsedTaskGraphAuthorityFields;
  history: ParsedTaskGraphHistoryFields;
}>;

export type ParsedTask = Task & Readonly<{ id: TaskId }>;
export type ParsedTaskGraph = Omit<TaskGraph, "tasks" | "executing_tasks"> & Readonly<{
  tasks: readonly ParsedTask[];
  executing_tasks?: readonly TaskId[];
}>;

function taskGraphFromParsedParts(obj: Record<string, unknown>, parts: ParsedTaskGraphParts): ParsedTaskGraph {
  // Fresh recursively frozen copies, never aliases of parsed JSON: a caller
  // retaining the raw object cannot mutate nested Task or Wave Gate data and
  // bypass StateManager.update's locked transform.
  const frozenTasks = Object.freeze(parts.tasks.map((task) => frozenJsonCopy(task)));
  const frozenWaveGates = Object.freeze(Object.fromEntries(
    Object.entries(parts.waveGates).map(([wave, gate]) => [wave, frozenJsonCopy(gate)]),
  ));
  const {
    activeWaveGate,
    waveGateHistory,
    waveReviewEpoch,
    verificationManifest,
    activeWaveCompletionSuite,
  } = parts.authority;
  const { reopeningHistory, orphanedHistory, specTraceRetirements } = parts.history;
  // The single blessed cast: every union field above is proven in place.
  return {
    ...obj,
    phase_artifacts: parts.phaseArtifacts,
    skipped_phases: parts.skippedPhases,
    spec_file: obj.spec_file ?? null,
    plan_file: obj.plan_file ?? null,
    tasks: frozenTasks,
    ...(parts.executingTasks === undefined
      ? {}
      : { executing_tasks: parts.executingTasks }),
    wave_gates: frozenWaveGates,
    ...(parts.specCheck === undefined ? {} : { spec_check: parts.specCheck }),
    ...(waveReviewEpoch === undefined ? {} : { wave_review_epoch: waveReviewEpoch }),
    ...(verificationManifest === undefined ? {} : { verification_manifest: verificationManifest }),
    ...(activeWaveCompletionSuite === undefined ? {} : { active_wave_completion_suite: activeWaveCompletionSuite }),
    ...(activeWaveGate === undefined ? {} : { active_wave_gate: activeWaveGate }),
    ...(waveGateHistory === undefined ? {} : { wave_gate_history: waveGateHistory }),
    ...(reopeningHistory === undefined ? {} : { wave_reopening_history: reopeningHistory }),
    ...(orphanedHistory === undefined ? {} : { orphaned_wave_gate_history: orphanedHistory }),
    ...(specTraceRetirements === undefined ? {} : { spec_trace_wave_gate_retirements: specTraceRetirements }),
  } as unknown as ParsedTaskGraph;
}

/**
 * Parse raw disk JSON into a TaskGraph, mirroring parseMachine: every
 * union-typed field (current_phase, task status / review_status /
 * test_result.verdict) is PROVEN in the union before the cast, so a
 * drifted or hand-edited value fails loudly at the load boundary instead
 * of exploding later inside an `.exhaustive()` match (testResultPassed) or
 * silently flowing through typed gate logic. Unknown extra fields pass
 * through untouched (legacyTestsPassedNote still fires downstream);
 * missing tasks/wave_gates default for early phases (populated in Phase 4).
 */
export function parseTaskGraph(raw: unknown): ParseResult<ParsedTaskGraph> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return parseErr("not an object");
  }
  const obj = raw as Record<string, unknown>;
  const lifecycleErrors = taskGraphLifecycleErrors(obj);
  if (lifecycleErrors[0] !== undefined) return parseErr(lifecycleErrors[0]);
  const phaseArtifacts = Object.freeze({ ...(obj.phase_artifacts as Record<string, string>) });
  const skippedPhases = Object.freeze([...(Array.isArray(obj.skipped_phases) ? obj.skipped_phases : [])] as Phase[]);
  const scalarError = taskGraphScalarFieldError(obj);
  if (scalarError !== null) return parseErr(scalarError);
  const executingTasks = parseExecutingTaskIds(obj.executing_tasks);
  if (!executingTasks.ok) return parseErr(executingTasks.error);
  const tasks = parseTaskGraphTasks(obj, executingTasks.value ?? []);
  if (!tasks.ok) return parseErr(tasks.error);
  const waveGates = parseTaskGraphWaveGates(obj);
  if (!waveGates.ok) return parseErr(waveGates.error);
  const specCheck = parseSpecCheckField(obj.spec_check);
  if (!specCheck.ok) return parseErr(specCheck.error);
  const blockedCauseError = blockedGateCauseError(
    waveGates.value,
    tasks.value as Record<string, unknown>[],
    specCheck.value,
  );
  if (blockedCauseError !== null) return parseErr(blockedCauseError);
  const authority = parseTaskGraphAuthorityFields(obj);
  if (!authority.ok) return parseErr(authority.error);
  const history = parseTaskGraphHistoryFields(obj, authority.value.activeWaveGate, authority.value.waveGateHistory);
  if (!history.ok) return parseErr(history.error);

  return parseOk(taskGraphFromParsedParts(obj, {
    phaseArtifacts,
    skippedPhases,
    tasks: tasks.value,
    executingTasks: executingTasks.value,
    waveGates: waveGates.value,
    specCheck: specCheck.value,
    authority: authority.value,
    history: history.value,
  }));
}

/** @deprecated Legacy wave-gate compatibility migration — archived in
 *  ./core/legacy-archive (Section C). New completions use the registered
 *  Wave Gate authority (active_wave_gate); this type + derive path survive
 *  only for graphs that predate registration. Deprecation horizon: retire
 *  once no pre-registration graph can still be completed. */
import {
  deriveLegacyWaveGateCompatibilityAuthority,
  findLegacyWaveGateCompletionReplay,
  type LegacyWaveGateCompatibilityAuthority,
  type LegacyWaveGateCompletionReplayError,
} from "./core/legacy-archive";
export {
  deriveLegacyWaveGateCompatibilityAuthority,
  findLegacyWaveGateCompletionReplay,
};
export type {
  LegacyWaveGateCompatibilityAuthority,
  LegacyWaveGateCompletionReplayError,
};

export type RegisteredWaveGateCompletionReplayError = Readonly<{
  kind: "registered-wave-gate-completion-replay-rejected";
  message: string;
}>;

export function findRegisteredWaveGateCompletionReplay(
  graph: TaskGraph,
  authority: ActiveWaveGateRegistration,
): DomainResult<CompletedWaveGateRegistration | null, RegisteredWaveGateCompletionReplayError> {
  const reject = (message: string): DomainResult<never, RegisteredWaveGateCompletionReplayError> =>
    Object.freeze({
      ok: false,
      error: Object.freeze({ kind: "registered-wave-gate-completion-replay-rejected", message }),
    });
  if (authority.terminalOutcome !== null) {
    return reject(`Pre-read Wave Gate run ${authority.runId} was already terminal rather than active`);
  }
  const history = graph.wave_gate_history ?? [];
  const sameRun = history.find((entry) => entry.runId === authority.runId);
  const sameWave = history.find((entry) => entry.wave === authority.wave);
  const candidate = sameRun ?? sameWave;
  if (candidate === undefined) return Object.freeze({ ok: true, value: null });
  if (
    candidate.runId !== authority.runId || candidate.wave !== authority.wave ||
    candidate.authorityDigest !== authority.authorityDigest || candidate.revision !== authority.revision + 1
  ) {
    return reject(
      `Wave ${authority.wave} terminal history conflicts with pre-read active run ${authority.runId} ` +
      `(expected digest ${authority.authorityDigest} and revision ${authority.revision + 1})`,
    );
  }
  if (
    candidate.completionReceipt.runId !== authority.runId ||
    candidate.completionReceipt.committedRevision !== candidate.revision
  ) {
    return reject(`Wave ${authority.wave} terminal history carries a contradictory completion receipt`);
  }
  return Object.freeze({ ok: true, value: candidate });
}

type ParsedLegacyWaveGateMigrationAuthority = Readonly<{
  registration: ActiveWaveGateRegistration;
  compatibility: LegacyWaveGateCompatibilityAuthority;
}>;

function parseLegacyWaveGateMigrationAuthority(raw: unknown): ParseResult<ParsedLegacyWaveGateMigrationAuthority> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return parseErr("Legacy Wave Gate migration authority must be an object");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["authorityDigest", "kind", "runId", "schemaVersion", "wave"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return parseErr("Legacy Wave Gate migration authority must contain exactly schemaVersion/kind/runId/wave/authorityDigest");
  }
  if (record.schemaVersion !== 1 || record.kind !== "legacy-wave-gate-compatibility") {
    return parseErr("Legacy Wave Gate migration authority tag is invalid");
  }
  const runId = parseOrchestrationRunId(record.runId);
  const digest = parseArtifactDigest(record.authorityDigest);
  if (!runId.ok) return parseErr(runId.error.message);
  if (!digest.ok) return parseErr(digest.error.message);
  const wave = parseWaveNumber(record.wave, "Legacy Wave Gate migration wave");
  if (!wave.ok) return parseErr(wave.error);
  const registration: ActiveWaveGateRegistration = Object.freeze({
    schemaVersion: 1,
    kind: "active-wave-gate",
    runId: runId.value,
    wave: wave.value,
    authorityDigest: digest.value,
    revision: 0,
    terminalOutcome: null,
  });
  const compatibility: LegacyWaveGateCompatibilityAuthority = Object.freeze({
    schemaVersion: 1,
    kind: "legacy-wave-gate-compatibility",
    runId: registration.runId,
    wave: registration.wave,
    authorityDigest: registration.authorityDigest,
  });
  return parseOk({ registration, compatibility });
}

export class StateManager {
  private readonly path: string;
  private readonly authority: TaskGraphFileAuthority;

  constructor(
    path: string,
    authority: TaskGraphFileAuthority = captureTaskGraphFileAuthority(path, false),
  ) {
    this.path = authority.path;
    this.authority = authority;
  }

  static fromSession(sessionId?: string): StateManager | null {
    const authority = resolveTaskGraphFileAuthority(sessionId);
    return authority === null ? null : new StateManager(authority.path, authority);
  }

  /** Pi parent adapter seam; see resolveLocalSessionTaskGraphAuthority. */
  static fromLocalSession(sessionId: string): StateManager | null {
    const authority = resolveLocalSessionTaskGraphAuthority(sessionId);
    return authority === null ? null : new StateManager(authority.path, authority);
  }

  /**
   * `null` means the graph is genuinely ABSENT — ENOENT and nothing else.
   * Bare `existsSync` also returns `false` for EACCES/ELOOP/ENOTDIR/EIO, so an
   * unreadable graph used to be indistinguishable from a missing one and every
   * caller reported "no task graph at X" for a path that was really there.
   * A present-but-unreadable graph now yields a manager whose `load()` reports
   * the real access failure, the same way a corrupt one already does.
   */
  static fromPath(path: string): StateManager | null {
    return pathExistsFailClosed(path) ? new StateManager(path) : null;
  }

  private openAuthorityDirectory(): AnchoredDirectory {
    const directory = openDirectoryNoFollow(this.authority.directoryPath);
    if (anchoredDirectoryHasIdentity(directory, this.authority.directoryIdentity)) return directory;
    const authorityError = new Error(
      `TaskGraph parent authority changed after capture: ${this.authority.directoryPath}`,
    );
    throw closeAnchorGuarded(directory, authorityError, "TaskGraph parent authority rejection");
  }

  private loadFrom(directory: AnchoredDirectory): ParsedTaskGraph {
    const raw = readDirectoryFileNoFollow(directory, this.authority.leaf).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Corrupt state file (invalid JSON): ${this.path} — ${(e as Error).message}`);
    }
    const graph = parseTaskGraph(parsed);
    if (!graph.ok) throw new Error(`Corrupt state file (${graph.error}): ${this.path}`);
    return graph.value;
  }

  load(): ParsedTaskGraph {
    const directory = this.openAuthorityDirectory();
    return withStateDirectory(directory, `TaskGraph load of ${this.path}`, () => this.loadFrom(directory));
  }

  getPath(): string {
    return this.path;
  }

  /**
   * Atomically update state under the TaskGraph lock. The callback runs while
   * that lock is held: ordinary reducers should stay pure, while authority-
   * sensitive callers may re-observe external evidence there to compare and
   * commit one exact snapshot. Keep such observations bounded and fail closed.
   */
  async update(fn: (state: ParsedTaskGraph) => TaskGraph): Promise<void> {
    await this.updateAndReturn((state) => ({ state: fn(state), value: undefined }));
  }

  /** Atomic shell primitive returning the exact lock-time decision committed. */
  async updateAndReturn<T>(
    fn: (state: ParsedTaskGraph) => Readonly<{ state: TaskGraph; value: T }>,
  ): Promise<T> {
    return this.atomicWrite((directory) => fn(this.loadFrom(directory)));
  }

  /** Install one fresh protected active-run anchor, idempotently for exact replay. */
  async registerActiveWaveGate(rawRegistration: unknown): Promise<ActiveWaveGateRegistration> {
    const parsed = parseActiveWaveGateRegistration(rawRegistration);
    if (!parsed.ok) throw new Error(`Invalid active Wave Gate registration: ${parsed.error}`);
    const registration = parsed.value;
    return this.updateAndReturn((state) => {
      if (state.current_phase !== "execute") {
        throw new Error(`Cannot register Wave Gate run outside execute Phase (current: ${state.current_phase})`);
      }
      if (state.current_wave !== registration.wave) {
        throw new Error(`Cannot register Wave Gate wave ${registration.wave}; protected current_wave is ${state.current_wave ?? "missing"}`);
      }
      if (registration.revision !== 0 || registration.terminalOutcome !== null) {
        throw new Error("A fresh active Wave Gate registration must start at revision 0 without a terminal outcome");
      }
      const completed = state.wave_gate_history ?? [];
      if (completed.some((entry) => entry.runId === registration.runId)) {
        throw new Error(`Wave Gate run ${registration.runId} is already terminal`);
      }
      if (completed.some((entry) => entry.wave >= registration.wave)) {
        throw new Error(`Wave ${registration.wave} is already completed or older than terminal Wave history`);
      }
      const existing = state.active_wave_gate;
      if (existing !== undefined) {
        const exactReplay = existing.runId === registration.runId &&
          existing.wave === registration.wave &&
          existing.authorityDigest === registration.authorityDigest && existing.runsRoot === registration.runsRoot &&
          existing.revision === registration.revision && existing.terminalOutcome === null;
        if (exactReplay) return { state, value: existing };
        if (existing.terminalOutcome === null) {
          throw new Error(`Active Wave Gate run ${existing.runId} already owns wave ${existing.wave}`);
        }
        throw new Error(
          `Legacy terminal Wave Gate run ${existing.runId} must be explicitly migrated to terminal history before registering another run`,
        );
      }
      return { state: { ...state, active_wave_gate: registration }, value: registration };
    });
  }

  /** Explicit anti-corruption migration for a historical graph that predates
   * active registrations. No run id, Wave, or digest is invented implicitly. */
  async migrateLegacyWaveGateRegistration(raw: unknown): Promise<ActiveWaveGateRegistration> {
    const parsed = parseLegacyWaveGateMigrationAuthority(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    const { registration, compatibility } = parsed.value;
    return this.updateAndReturn((state) => {
      const terminalReplay = findLegacyWaveGateCompletionReplay(state, compatibility);
      if (!terminalReplay.ok) throw new Error(terminalReplay.error.message);
      if (terminalReplay.value !== null) {
        throw new Error(`Legacy Wave ${registration.wave} is already completed by run ${terminalReplay.value.runId}`);
      }
      const existing = state.active_wave_gate;
      if (existing !== undefined) {
        const exactReplay = existing.runId === registration.runId &&
          existing.wave === registration.wave &&
          existing.authorityDigest === registration.authorityDigest &&
          existing.revision === 0 && existing.terminalOutcome === null;
        if (exactReplay) return { state, value: existing };
        throw new Error("Legacy migration is allowed only when active Wave Gate authority is absent");
      }
      if (state.current_phase !== "execute" || state.current_wave !== registration.wave) {
        throw new Error("Legacy migration must exactly match protected execute/current_wave authority");
      }
      if (state.tasks.every((task) => task.wave !== registration.wave)) {
        throw new Error(`Legacy migration wave ${registration.wave} has no protected Tasks`);
      }
      return { state: { ...state, active_wave_gate: registration }, value: registration };
    });
  }

  /** Lock, re-derive completion through the caller's pure domain function,
   * persist terminal history + advancement together, and return its receipt. */
  async commitActiveWaveGateCompletion(
    derive: (lockedState: TaskGraph) => DomainResult<WaveCompletionCommit, WaveCompletionCommitError>,
  ): Promise<WaveCompletionCommit> {
    return this.updateAndReturn((state) => {
      const active = state.active_wave_gate;
      if (state.current_phase !== "execute" || state.current_wave === undefined || active === undefined) {
        throw new Error("Protected execute/current Wave Gate authority is missing");
      }
      if (active.wave !== state.current_wave || active.terminalOutcome !== null) {
        throw new Error("Protected active/current Wave Gate authority is contradictory or terminal");
      }
      const committed = derive(state);
      if (!committed.ok) throw new Error(committed.error.message);
      const terminal = committed.value.completedRegistration;
      if (
        terminal.runId !== active.runId || terminal.wave !== active.wave ||
        terminal.authorityDigest !== active.authorityDigest || terminal.revision !== active.revision + 1 ||
        committed.value.receipt !== terminal.completionReceipt
      ) {
        throw new Error("Completion result does not terminalize the exact locked active registration");
      }
      const activeSuite = state.active_wave_completion_suite;
      const suiteArchivedExactly = activeSuite === undefined
        ? terminal.schemaVersion === 1
        : terminal.schemaVersion === 2 && terminal.completionSuite === activeSuite;
      if (!suiteArchivedExactly) {
        throw new Error("Completion must archive the exact active Wave completion suite using the matching history schema");
      }
      if (committed.value.graph.active_wave_gate !== undefined ||
          committed.value.graph.active_wave_completion_suite !== undefined) {
        throw new Error("Completion must retire active gate and completion-suite authority before the next Wave can register");
      }
      return { state: committed.value.graph, value: committed.value };
    });
  }

  /**
   * Replace state entirely (used by populate-task-graph and repair-task-graph).
   * A full replacement never reads the outgoing graph, so it deliberately does
   * not route through `updateAndReturn`: recovering a graph the load boundary
   * already rejects is the whole purpose of repair, and loading first would
   * make the corrupt file block its own repair. The replacement is still
   * validated by `atomicWrite` before it can reach disk.
   */
  async replace(state: TaskGraph): Promise<void> {
    await this.atomicWrite(() => ({ state, value: undefined }));
  }

  /** lock → derive/parse → stage read-only bytes → anchored pathname rename → unlock */
  private async atomicWrite<T>(
    produce: (directory: AnchoredDirectory) => Readonly<{ state: TaskGraph; value: T }>,
  ): Promise<T> {
    // This is the final shared write boundary, including replacement/repair
    // paths. Check before lock creation so a skewed fresh CLI leaves the
    // protected graph byte-for-byte and metadata-for-metadata untouched.
    assertPiCliMutationCompatible(process.env, captureLoomRuntimeIdentity(PACKAGE_ROOT));
    const directory = this.openAuthorityDirectory();
    return withStateDirectoryAsync(directory, `TaskGraph atomic write of ${this.path}`, () =>
      withAnchoredDirectoryHandleLock(directory, ".task_graph", () => {
        const produced = produce(directory);
        const parsed = parseTaskGraph(produced.state);
        if (!parsed.ok) throw new Error(`Refusing to persist invalid task graph (${parsed.error}): ${this.path}`);
        writeDirectoryFileAtomicModeNoFollow(
          directory,
          this.authority.leaf,
          JSON.stringify(parsed.value, null, 2),
          0o444,
        );
        return produced.value;
      }));
  }
}
