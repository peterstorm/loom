/**
 * Atomic state file manager with chmod-based protection + locking
 *
 * State file stays chmod 444 at rest. Hooks and whitelisted helpers
 * (populate-task-graph, complete-wave-gate, set-phase, …) write via this
 * manager.
 * Replaces: state-file-write.sh, resolve-task-graph.sh, loom-config.sh
 */

import { readFileSync, writeFileSync, chmodSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock } from "./utils/lock";
import { KNOWN_AGENTS, PHASE_ORDER, REVIEW_SUB_AGENTS, pathExistsFailClosed, taskGraphPath } from "./config";
import { parseErr, parseOk, parseSessionId, sessionScopedPath, type ParseResult } from "./machine";
import { REVIEW_STATUSES, TASK_STATUSES, type Phase } from "./types";
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
import type { ActiveWaveGateRegistration, CompletedWaveGateRegistration, OrphanedWaveGateRetirement, SpecCheck, TaskGraph } from "./types";
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
import { deriveProofObligations, parseTaskProof, parseTaskTestResult } from "./core/proof-obligations";
import { parseDeclaredArtifactBaseline } from "./core/artifact-baseline";
import { parseStoredSpecCheck } from "./core/spec-check";
import { waveHasBlockCause } from "./core/wave-gate-model";
import { parseIssuedReviewPacketRegistration, parseReviewPath } from "./core/review-packet";
import { assertPiCliMutationCompatible, captureLoomRuntimeIdentity } from "./runtime-compatibility";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Resolve task graph path for cross-repo access. The session id comes from
 *  hook input, so it is PARSED before naming a file under SUBAGENT_DIR — an
 *  unparseable id is ignored loudly (fail closed: no session pointer read)
 *  and resolution falls back to the local task graph. */
export function resolveTaskGraph(sessionId?: string): string | null {
  if (sessionId) {
    const parsed = parseSessionId(sessionId);
    if (parsed === null) {
      process.stderr.write(
        `resolveTaskGraph: invalid session id ${JSON.stringify(sessionId)} — ignoring session task-graph pointer\n`,
      );
    } else {
      const sessionFile = sessionScopedPath(parsed, ".task_graph");
      if (existsSync(sessionFile)) {
        try {
          const absPath = readFileSync(sessionFile, "utf-8").trim();
          if (existsSync(absPath)) return absPath;
          // A dangling pointer silently re-targets every session-scoped
          // handler at the LOCAL graph — say so instead of quietly diverging.
          process.stderr.write(
            `resolveTaskGraph: session pointer ${sessionFile} names missing graph '${absPath}' — falling back to local task graph\n`,
          );
        } catch (e) {
          process.stderr.write(
            `resolveTaskGraph: cannot read session pointer ${sessionFile}: ${e instanceof Error ? e.message : String(e)} — falling back to local task graph\n`,
          );
        }
      }
    }
  }

  const localTaskGraph = taskGraphPath();
  if (existsSync(localTaskGraph)) return localTaskGraph;

  return null;
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
 * reason behind it: the flag has exactly two causes, and `update-task-status`
 * already clears it when the last one dies, with a comment promising "the flag
 * now tracks its causes, exactly like the load boundary's cross-field proof" —
 * a proof that did not exist. Its absence is not cosmetic:
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

const ACTIVE_WAVE_GATE_FIELDS = [
  "schemaVersion", "kind", "runId", "wave", "authorityDigest", "revision", "terminalOutcome",
] as const;
const ACTIVE_WAVE_GATE_OPTIONAL_FIELDS = ["runsRoot"] as const;

/** Parse and re-prove the protected active-run anchor from unknown JSON. */
export function parseActiveWaveGateRegistration(raw: unknown): ParseResult<ActiveWaveGateRegistration> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return parseErr("active_wave_gate must be an object");
  }
  const record = raw as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter((field) =>
    !(ACTIVE_WAVE_GATE_FIELDS as readonly string[]).includes(field) &&
    !(ACTIVE_WAVE_GATE_OPTIONAL_FIELDS as readonly string[]).includes(field));
  const missingFields = ACTIVE_WAVE_GATE_FIELDS.filter((field) => !(field in record));
  if (unknownFields.length > 0) return parseErr(`active_wave_gate contains unknown field(s): ${unknownFields.sort().join(", ")}`);
  if (missingFields.length > 0) return parseErr(`active_wave_gate is missing field(s): ${missingFields.join(", ")}`);
  if (record.schemaVersion !== 1) return parseErr("active_wave_gate.schemaVersion must be 1");
  if (record.kind !== "active-wave-gate") return parseErr("active_wave_gate.kind must be active-wave-gate");
  const runId = parseOrchestrationRunId(record.runId);
  if (!runId.ok) return parseErr(`active_wave_gate.runId: ${runId.error.message}`);
  const authorityDigest = parseArtifactDigest(record.authorityDigest);
  if (!authorityDigest.ok) return parseErr(`active_wave_gate.authorityDigest: ${authorityDigest.error.message}`);
  if (typeof record.wave !== "number" || !Number.isInteger(record.wave) || record.wave < 1) {
    return parseErr("active_wave_gate.wave must be an integer >= 1");
  }
  if (typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 0) {
    return parseErr("active_wave_gate.revision must be a non-negative safe integer");
  }
  if (record.runsRoot !== undefined &&
      (typeof record.runsRoot !== "string" || !isAbsolute(record.runsRoot) || resolve(record.runsRoot) !== record.runsRoot)) {
    return parseErr("active_wave_gate.runsRoot must be an absolute normalized path when present");
  }

  let terminalOutcome: ActiveWaveGateRegistration["terminalOutcome"] = null;
  if (record.terminalOutcome !== null) {
    if (typeof record.terminalOutcome !== "object" || Array.isArray(record.terminalOutcome)) {
      return parseErr("active_wave_gate.terminalOutcome must be null or an object");
    }
    const terminal = record.terminalOutcome as Record<string, unknown>;
    if (terminal.kind === "done") {
      const keys = Object.keys(terminal);
      if (keys.length !== 2 || !keys.includes("outcome")) {
        return parseErr("active_wave_gate.terminalOutcome done must contain exactly kind and outcome");
      }
      const outcome = parseArtifactRef(terminal.outcome);
      if (!outcome.ok) return parseErr(`active_wave_gate.terminalOutcome.outcome: ${outcome.error.message}`);
      if (outcome.value.runId !== runId.value) return parseErr("active_wave_gate done outcome belongs to a different run");
      terminalOutcome = Object.freeze({ kind: "done", outcome: outcome.value });
    } else if (terminal.kind === "terminal-blocked") {
      const keys = Object.keys(terminal);
      if (keys.length !== 2 || !keys.includes("diagnostic")) {
        return parseErr("active_wave_gate.terminalOutcome terminal-blocked must contain exactly kind and diagnostic");
      }
      const diagnostic = parseBlockedDiagnostic(terminal.diagnostic);
      if (!diagnostic.ok) return parseErr(`active_wave_gate.terminalOutcome.diagnostic: ${diagnostic.error.message}`);
      if (diagnostic.value.kind !== "terminal-blocked") {
        return parseErr("active_wave_gate terminal-blocked outcome requires a terminal diagnostic");
      }
      if (diagnostic.value.runId !== runId.value) return parseErr("active_wave_gate terminal diagnostic belongs to a different run");
      terminalOutcome = Object.freeze({ kind: "terminal-blocked", diagnostic: diagnostic.value });
    } else {
      return parseErr("active_wave_gate.terminalOutcome.kind must be done or terminal-blocked");
    }
  }

  return parseOk(Object.freeze({
    schemaVersion: 1,
    kind: "active-wave-gate",
    runId: runId.value,
    wave: record.wave,
    authorityDigest: authorityDigest.value,
    revision: record.revision,
    ...(record.runsRoot === undefined ? {} : { runsRoot: record.runsRoot as string }),
    terminalOutcome,
  }));
}

const COMPLETED_WAVE_GATE_FIELDS = [
  "schemaVersion", "kind", "runId", "wave", "authorityDigest", "revision", "completionReceipt",
] as const;

/** Parse immutable terminal history independently from active next-Wave authority. */
export function parseCompletedWaveGateRegistration(raw: unknown): ParseResult<CompletedWaveGateRegistration> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return parseErr("wave_gate_history entry must be an object");
  }
  const record = raw as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter((field) => !(COMPLETED_WAVE_GATE_FIELDS as readonly string[]).includes(field));
  const missingFields = COMPLETED_WAVE_GATE_FIELDS.filter((field) => !(field in record));
  if (unknownFields.length > 0) return parseErr(`wave_gate_history entry contains unknown field(s): ${unknownFields.sort().join(", ")}`);
  if (missingFields.length > 0) return parseErr(`wave_gate_history entry is missing field(s): ${missingFields.join(", ")}`);
  if (record.schemaVersion !== 1 || record.kind !== "completed-wave-gate") {
    return parseErr("wave_gate_history entry must be completed-wave-gate schemaVersion 1");
  }
  const runId = parseOrchestrationRunId(record.runId);
  const authorityDigest = parseArtifactDigest(record.authorityDigest);
  if (!runId.ok) return parseErr(`wave_gate_history.runId: ${runId.error.message}`);
  if (!authorityDigest.ok) return parseErr(`wave_gate_history.authorityDigest: ${authorityDigest.error.message}`);
  if (typeof record.wave !== "number" || !Number.isInteger(record.wave) || record.wave < 1) {
    return parseErr("wave_gate_history.wave must be an integer >= 1");
  }
  if (typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    return parseErr("wave_gate_history.revision must be a positive safe integer");
  }
  if (typeof record.completionReceipt !== "object" || record.completionReceipt === null || Array.isArray(record.completionReceipt)) {
    return parseErr("wave_gate_history.completionReceipt must be an object");
  }
  const receipt = record.completionReceipt as Record<string, unknown>;
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
  if (receiptRunId.value !== runId.value) return parseErr("wave_gate_history completion receipt belongs to a different run");
  if (receipt.committedRevision !== record.revision) return parseErr("wave_gate_history completion receipt revision must equal terminal revision");
  return parseOk(Object.freeze({
    schemaVersion: 1,
    kind: "completed-wave-gate",
    runId: runId.value,
    wave: record.wave,
    authorityDigest: authorityDigest.value,
    revision: record.revision,
    completionReceipt: Object.freeze({
      kind: "protected-wave-state-committed",
      effectId: effectId.value,
      runId: runId.value,
      committedRevision: record.revision,
      stateDigest: stateDigest.value,
    }),
  }));
}

const ORPHANED_WAVE_GATE_RETIREMENT_FIELDS = [
  "schemaVersion", "kind", "runId", "wave", "authorityDigest", "revision", "reason", "runsRoot", "runDirectory",
  "replacementRunId", "replacementAuthorityDigest",
] as const;

/** Parse one immutable nonterminal retirement audit entry. */
export function parseOrphanedWaveGateRetirement(raw: unknown): ParseResult<OrphanedWaveGateRetirement> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return parseErr("orphaned_wave_gate_history entry must be an object");
  }
  const record = raw as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter((field) =>
    !(ORPHANED_WAVE_GATE_RETIREMENT_FIELDS as readonly string[]).includes(field));
  const missingFields = ORPHANED_WAVE_GATE_RETIREMENT_FIELDS.filter((field) => !(field in record));
  if (unknownFields.length > 0) {
    return parseErr(`orphaned_wave_gate_history entry contains unknown field(s): ${unknownFields.sort().join(", ")}`);
  }
  if (missingFields.length > 0) {
    return parseErr(`orphaned_wave_gate_history entry is missing field(s): ${missingFields.join(", ")}`);
  }
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
  if (typeof record.wave !== "number" || !Number.isInteger(record.wave) || record.wave < 1) {
    return parseErr("orphaned_wave_gate_history.wave must be an integer >= 1");
  }
  if (typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 0) {
    return parseErr("orphaned_wave_gate_history.revision must be a non-negative safe integer");
  }
  if (typeof record.runsRoot !== "string" || !isAbsolute(record.runsRoot) || resolve(record.runsRoot) !== record.runsRoot ||
      typeof record.runDirectory !== "string" || record.runDirectory !== join(record.runsRoot, runId.value)) {
    return parseErr("orphaned_wave_gate_history must carry the exact normalized authoritative runsRoot/runDirectory");
  }
  return parseOk(Object.freeze({
    schemaVersion: 1,
    kind: "orphaned-wave-gate-retirement",
    runId: runId.value,
    wave: record.wave,
    authorityDigest: authorityDigest.value,
    revision: record.revision,
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

export const TASK_ID_PATTERN = /^T\d+$/;

/** One task-identity grammar shared by load and operator-validation boundaries. */
export function taskIdError(value: unknown, label: string): string | null {
  if (typeof value !== "string" || value === "") {
    return `${label}: id must be a non-empty string, got ${JSON.stringify(value)}`;
  }
  return TASK_ID_PATTERN.test(value)
    ? null
    : `${label}: id must match T\\d+, got ${JSON.stringify(value)}`;
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
  // Both baselines answer the same question — does the declared baseline agree
  // with file_list, in order — and differ only in whether file_list must be the
  // WHOLE baseline or just its prefix. One comparison, two coverage rules.
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
    const error = fileListAgreement(
      t.attempt_artifact_baseline,
      "attempt_artifact_baseline",
      "prefix",
      "must cover file_list first and in order",
    );
    if (error !== null) return error;
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

/** Issued review packets, recovered writes, and plan context. */
function taskPacketError(
  t: Record<string, unknown>,
  index: number,
  id: string,
): string | null {
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
    (typeof t.artifact_baseline_recovered_from !== "string" ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(t.artifact_baseline_recovered_from))
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
      if (typeof recovery.baseline_sha !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(recovery.baseline_sha)) {
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
  if (
    t.spec_anchors !== undefined &&
    (!Array.isArray(t.spec_anchors) ||
      t.spec_anchors.some((anchor) => typeof anchor !== "string" || anchor.trim() === ""))
  ) {
    return `tasks[${index}] ("${id}"): spec_anchors must be an array of non-empty strings when present`;
  }
  if (t.plan_context !== undefined && typeof t.plan_context !== "string") {
    return `tasks[${index}] ("${id}"): plan_context must be a string when present`;
  }
  return null;
}

/** Status, review status/generation/run, and proof obligations. */
function taskStatusError(
  t: Record<string, unknown>,
  index: number,
  id: string,
): string | null {
  if (!(TASK_STATUSES as readonly string[]).includes(t.status as string)) {
    return `tasks[${index}] ("${id}"): status ${JSON.stringify(t.status)} is not one of ${TASK_STATUSES.join(", ")}`;
  }
  if (t.review_status !== undefined && !(REVIEW_STATUSES as readonly string[]).includes(t.review_status as string)) {
    return `tasks[${index}] ("${id}"): review_status ${JSON.stringify(t.review_status)} is not one of ${REVIEW_STATUSES.join(", ")}`;
  }
  if (t.review_generation !== undefined && (
    typeof t.review_generation !== "number" || !Number.isInteger(t.review_generation) || t.review_generation < 0
  )) {
    return `tasks[${index}] ("${id}"): review_generation must be a non-negative integer`;
  }
  if (t.review_run !== undefined && t.review_generation === undefined) {
    return `tasks[${index}] ("${id}"): review_run requires review_generation`;
  }
  if (t.review_run !== undefined && t.review_status !== "pending" && t.review_status !== "evidence_capture_failed") {
    return `tasks[${index}] ("${id}"): an in-progress review_run requires pending or evidence_capture_failed status`;
  }
  const statusClaimsImplementation = t.status === "implemented" || t.status === "completed";
  if (t.proof !== undefined) {
    const proof = parseTaskProof(t.proof);
    if (!proof.ok) {
      return `tasks[${index}] ("${id}"): invalid proof: ${proof.errors.join("; ")}`;
    }
    const expectedObligations = deriveProofObligations({
      newTestsRequired: t.new_tests_required !== false,
      declaredArtifacts: Array.isArray(t.file_list) ? t.file_list : [],
    });
    const obligationsMatch = proof.value.obligations.length === expectedObligations.length &&
      proof.value.obligations.every((actual, obligationIndex) => {
        const expected = expectedObligations[obligationIndex];
        return expected !== undefined && actual.kind === expected.kind &&
          (actual.kind !== "declared-artifact-changed" ||
            (expected.kind === "declared-artifact-changed" && actual.artifact === expected.artifact));
      });
    if (!obligationsMatch) {
      return `tasks[${index}] ("${id}"): proof obligations do not exactly match new_tests_required and file_list`;
    }
    if (statusClaimsImplementation !== (proof.value.state === "satisfied")) {
      return (
        `tasks[${index}] ("${id}"): status/proof lockstep violated — ` +
        `implemented/completed iff proof.state is satisfied`
      );
    }
  }
  return null;
}

/** Test evidence. The acceptance DECISION is delegated to parseTaskTestResult —
 *  the ONE validator for the shared TaskTestResult/ProofTestResult union — so
 *  the load boundary can never drift from the proof evaluator on what shape
 *  the persisted field may have. Only the operator-facing message spelling is
 *  re-derived here, preserving the diagnostics the load-guard suite pins. */
function taskEvidenceError(
  t: Record<string, unknown>,
  index: number,
  id: string,
): string | null {
  if (t.test_result === undefined) return null;
  const prefix = `tasks[${index}] ("${id}")`;
  const parsed = parseTaskTestResult(t.test_result, `${prefix}: test_result`);
  if (parsed.ok) return null;
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
export function parseTaskGraph(raw: unknown): ParseResult<TaskGraph> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return parseErr("not an object");
  }
  const obj = raw as Record<string, unknown>;
  const lifecycleErrors = taskGraphLifecycleErrors(obj);
  if (lifecycleErrors[0] !== undefined) return parseErr(lifecycleErrors[0]);
  const phaseArtifacts = Object.freeze({ ...(obj.phase_artifacts as Record<string, string>) });
  const skippedPhases = Object.freeze([...(Array.isArray(obj.skipped_phases) ? obj.skipped_phases : [])] as Phase[]);
  for (const field of ["spec_dir", "spec_file", "plan_file"] as const) {
    if (obj[field] !== undefined && obj[field] !== null && typeof obj[field] !== "string") {
      return parseErr(`${field} must be a string or null when present, got ${JSON.stringify(obj[field])}`);
    }
  }
  for (const field of ["plan_title", "github_repo", "updated_at"] as const) {
    if (obj[field] !== undefined && typeof obj[field] !== "string") {
      return parseErr(`${field} must be a string when present, got ${JSON.stringify(obj[field])}`);
    }
  }
  if (obj.github_issue !== undefined
    && (typeof obj.github_issue !== "number" || !Number.isInteger(obj.github_issue) || obj.github_issue < 1)) {
    return parseErr(`github_issue must be an integer >= 1 when present, got ${JSON.stringify(obj.github_issue)}`);
  }
  if (obj.executing_tasks !== undefined
    && (!Array.isArray(obj.executing_tasks)
      || obj.executing_tasks.some((id) => typeof id !== "string" || id.trim() === "")
      || new Set(obj.executing_tasks).size !== obj.executing_tasks.length)) {
    return parseErr("executing_tasks must be an array of distinct non-empty strings when present");
  }
  if (
    obj.current_wave !== undefined &&
    (typeof obj.current_wave !== "number" || !Number.isInteger(obj.current_wave) || obj.current_wave < 1)
  ) {
    return parseErr(`current_wave must be an integer >= 1 when present, got ${JSON.stringify(obj.current_wave)}`);
  }
  const tasks = obj.tasks ?? [];
  if (!Array.isArray(tasks)) return parseErr("tasks must be an array");
  for (let i = 0; i < tasks.length; i++) {
    const err = taskUnionError(tasks[i], i);
    if (err !== null) return parseErr(err);
  }
  const taskIds = tasks.map((task) => (task as Record<string, unknown>).id as string);
  const duplicateTaskId = taskIds.find((id, index) => taskIds.indexOf(id) !== index);
  if (duplicateTaskId !== undefined) return parseErr(`duplicate task id: ${duplicateTaskId}`);
  const dependencyError = taskDependencyErrors(tasks as Record<string, unknown>[])[0];
  if (dependencyError !== undefined) return parseErr(dependencyError);
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
  const specCheck = parseSpecCheckField(obj.spec_check);
  if (!specCheck.ok) return parseErr(specCheck.error);

  const blockedCauseError = blockedGateCauseError(
    waveGates as Record<string, unknown>,
    tasks as Record<string, unknown>[],
    specCheck.value,
  );
  if (blockedCauseError !== null) return parseErr(blockedCauseError);

  const registrations = parseWaveGateRegistrations(obj);
  if (!registrations.ok) return parseErr(registrations.error);
  const { activeWaveGate, waveGateHistory } = registrations.value;
  const orphanedHistory = parseOrphanedWaveGateHistory(obj.orphaned_wave_gate_history);
  if (!orphanedHistory.ok) return parseErr(orphanedHistory.error);
  if (activeWaveGate !== undefined && orphanedHistory.value?.some(({ runId }) => runId === activeWaveGate.runId)) {
    return parseErr(`active_wave_gate run ${activeWaveGate.runId} is already retired in orphaned_wave_gate_history`);
  }
  if (activeWaveGate !== undefined) {
    const installedBy = orphanedHistory.value?.filter(({ replacementRunId }) => replacementRunId === activeWaveGate.runId) ?? [];
    if (installedBy.length > 1) {
      return parseErr(`active_wave_gate run ${activeWaveGate.runId} has multiple orphan-recovery installation audits`);
    }
    const audit = installedBy[0];
    if (audit !== undefined && (audit.wave !== activeWaveGate.wave ||
        audit.replacementAuthorityDigest !== activeWaveGate.authorityDigest ||
        activeWaveGate.runsRoot !== audit.runsRoot)) {
      return parseErr(`active_wave_gate run ${activeWaveGate.runId} contradicts its orphan-recovery installation audit`);
    }
  }

  // Fresh frozen copies, never aliases of the parsed JSON: a caller holding
  // the graph — or the raw object it came from — must not be able to mutate a
  // task or a gate in place and bypass StateManager.update's locked transform.
  // Shallow copies are sufficient: every nested array/record field is already
  // parsed to a fresh readonly array/record by the validators above or by the
  // blessed cast consumers, and freezing the container prevents in-place field
  // assignment, which is the mutation the invariant forbids.
  const frozenTasks = Object.freeze(tasks.map((task) => {
    const proven = task as Record<string, unknown>;
    return Object.freeze({ ...proven });
  }));
  const frozenWaveGates = Object.freeze(
    Object.fromEntries(
      Object.entries(waveGates as Record<string, unknown>).map(([wave, gate]) => [
        wave,
        Object.freeze({ ...(gate as Record<string, unknown>) }),
      ]),
    ),
  );

  // The single blessed cast: every union field above is proven in place.
  return parseOk({
    ...obj,
    phase_artifacts: phaseArtifacts,
    skipped_phases: skippedPhases,
    spec_file: obj.spec_file ?? null,
    plan_file: obj.plan_file ?? null,
    tasks: frozenTasks,
    wave_gates: frozenWaveGates,
    ...(specCheck.value === undefined ? {} : { spec_check: specCheck.value }),
    ...(activeWaveGate === undefined ? {} : { active_wave_gate: activeWaveGate }),
    ...(waveGateHistory === undefined ? {} : { wave_gate_history: waveGateHistory }),
    ...(orphanedHistory.value === undefined ? {} : { orphaned_wave_gate_history: orphanedHistory.value }),
  } as unknown as TaskGraph);
}

/** @deprecated Legacy wave-gate compatibility migration — archived in
 *  ./core/legacy-archive (Section C). New completions use the registered
 *  Wave Gate authority (active_wave_gate); this type + derive path survive
 *  only for graphs that predate registration. Deprecation horizon: retire
 *  once no pre-registration graph can still be completed. */
export {
  deriveLegacyWaveGateCompatibilityAuthority,
  type LegacyWaveGateCompatibilityAuthority,
} from "./core/legacy-archive";
// Local use inside state-manager itself: the re-export above does not bind
// the names locally, so import them (aliased to avoid the TS duplicate-name
// conflict with the re-export) for the completion-replay call site.
import {
  findLegacyWaveGateCompletionReplay,
  type LegacyWaveGateCompatibilityAuthority as LegacyWaveGateCompatibilityAuthorityLocal,
} from "./core/legacy-archive";

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

/** @deprecated Legacy terminal-history replay — archived in ./core/legacy-archive
 *  (Section C); findRegisteredWaveGateCompletionReplay is canonical. */
export {
  findLegacyWaveGateCompletionReplay,
  type LegacyWaveGateCompletionReplayError,
} from "./core/legacy-archive";

export type StateFilePermissionPort = (path: string, mode: number) => void;

/** The protected graph was durably renamed, but restoring its read-only mode
 * failed. The committed value is retained so callers can report the exact
 * receipt instead of misclassifying the failure as an idempotent lock replay. */
export class PostCommitStateProtectionError<T> extends Error {
  readonly kind = "post-commit-state-protection-failed" as const;

  constructor(
    readonly statePath: string,
    readonly committedValue: T,
    readonly permissionCause: unknown,
  ) {
    super(
      `Task graph was committed but read-only permission restoration failed: ${statePath}: ` +
      `${permissionCause instanceof Error ? permissionCause.message : String(permissionCause)}`,
      { cause: permissionCause },
    );
    this.name = "PostCommitStateProtectionError";
  }
}

export class StateManager {
  private readonly path: string;
  private readonly setPermissions: StateFilePermissionPort;

  constructor(path: string, setPermissions: StateFilePermissionPort = chmodSync) {
    this.path = path;
    this.setPermissions = setPermissions;
  }

  static fromSession(sessionId?: string): StateManager | null {
    const path = resolveTaskGraph(sessionId);
    return path ? new StateManager(path) : null;
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

  load(): TaskGraph {
    const raw = readFileSync(this.path, "utf-8");
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

  getPath(): string {
    return this.path;
  }

  /** Atomically update state via pure transform: (state) => state */
  async update(fn: (state: TaskGraph) => TaskGraph): Promise<void> {
    await this.updateAndReturn((state) => ({ state: fn(state), value: undefined }));
  }

  /** Atomic shell primitive for effects that must return the locked decision they committed. */
  async updateAndReturn<T>(
    fn: (state: TaskGraph) => Readonly<{ state: TaskGraph; value: T }>,
  ): Promise<T> {
    return this.atomicWrite(() => fn(this.load()));
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
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("Legacy Wave Gate migration authority must be an object");
    }
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const expected = ["authorityDigest", "kind", "runId", "schemaVersion", "wave"].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw new Error("Legacy Wave Gate migration authority must contain exactly schemaVersion/kind/runId/wave/authorityDigest");
    }
    if (record.schemaVersion !== 1 || record.kind !== "legacy-wave-gate-compatibility") {
      throw new Error("Legacy Wave Gate migration authority tag is invalid");
    }
    const runId = parseOrchestrationRunId(record.runId);
    const digest = parseArtifactDigest(record.authorityDigest);
    if (!runId.ok) throw new Error(runId.error.message);
    if (!digest.ok) throw new Error(digest.error.message);
    if (typeof record.wave !== "number" || !Number.isInteger(record.wave) || record.wave < 1) {
      throw new Error("Legacy Wave Gate migration wave must be an integer >= 1");
    }
    const registration: ActiveWaveGateRegistration = Object.freeze({
      schemaVersion: 1,
      kind: "active-wave-gate",
      runId: runId.value,
      wave: record.wave,
      authorityDigest: digest.value,
      revision: 0,
      terminalOutcome: null,
    });
    const compatibility: LegacyWaveGateCompatibilityAuthorityLocal = Object.freeze({
      schemaVersion: 1,
      kind: "legacy-wave-gate-compatibility",
      runId: registration.runId,
      wave: registration.wave,
      authorityDigest: registration.authorityDigest,
    });
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
      if (committed.value.graph.active_wave_gate !== undefined) {
        throw new Error("Completion must retire active authority before the next Wave can register");
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

  /** lock → chmod 644 → produce/parse → write tmp → rename → chmod 444 → unlock */
  private async atomicWrite<T>(produce: () => Readonly<{ state: TaskGraph; value: T }>): Promise<T> {
    // This is the final shared write boundary, including replacement/repair
    // paths. Check before lock creation or chmod so a skewed fresh CLI leaves
    // the protected graph byte-for-byte and metadata-for-metadata untouched.
    assertPiCliMutationCompatible(process.env, captureLoomRuntimeIdentity(PACKAGE_ROOT));
    const lockFile = `${dirname(this.path)}/.task_graph`;
    const tmp = `${this.path}.tmp`;
    return withLock(lockFile, () => {
      this.setPermissions(this.path, 0o644);
      let primaryError: unknown = null;
      let committed = false;
      let value: T | undefined;
      try {
        const produced = produce();
        const parsed = parseTaskGraph(produced.state);
        if (!parsed.ok) throw new Error(`Refusing to persist invalid task graph (${parsed.error}): ${this.path}`);
        writeFileSync(tmp, JSON.stringify(parsed.value, null, 2));
        renameSync(tmp, this.path);
        committed = true;
        value = produced.value;
      } catch (error) {
        primaryError = error;
        if (!committed && existsSync(tmp)) {
          try {
            unlinkSync(tmp);
          } catch (cleanupError) {
            primaryError = new AggregateError(
              [error, cleanupError],
              `Task graph write failed and temporary-file cleanup failed: ${this.path}`,
            );
          }
        }
      }

      let permissionError: unknown = null;
      try {
        this.setPermissions(this.path, 0o444);
      } catch (error) {
        permissionError = error;
      }

      if (primaryError !== null && permissionError !== null) {
        throw new AggregateError(
          [primaryError, permissionError],
          `Task graph write and permission restoration both failed: ${this.path}`,
        );
      }
      if (primaryError !== null) throw primaryError;
      if (permissionError !== null) {
        if (committed) {
          throw new PostCommitStateProtectionError(this.path, value as T, permissionError);
        }
        throw new Error(
          `Task graph was not committed and read-only permission restoration failed: ${this.path}: ${permissionError instanceof Error ? permissionError.message : String(permissionError)}`,
          { cause: permissionError },
        );
      }
      return value as T;
    });
  }
}
