/**
 * Atomic state file manager with chmod-based protection + locking
 *
 * State file stays chmod 444 at rest. Hooks and whitelisted helpers
 * (populate-task-graph, complete-wave-gate, set-phase, …) write via this
 * manager.
 * Replaces: state-file-write.sh, resolve-task-graph.sh, loom-config.sh
 */

import { readFileSync, writeFileSync, chmodSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { withLock } from "./utils/lock";
import { PHASE_ORDER, taskGraphPath } from "./config";
import { parseErr, parseOk, parseSessionId, sessionScopedPath, type ParseResult } from "./machine";
import { REVIEW_STATUSES, TASK_STATUSES } from "./types";
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
import type { TaskGraph } from "./types";
import { deriveProofObligations, parseTaskProof } from "./core/proof-obligations";
import { parseDeclaredArtifactBaseline } from "./core/artifact-baseline";
import { parseStoredSpecCheck } from "./core/spec-check";
import { parseIssuedReviewPacketRegistration, parseReviewPath } from "./core/review-packet";

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

/** Pure: the union-typed fields of one raw task, proven or precisely refused.
 *  Returns an error string, or null when the task's unions all parse. */
/**
 * Prove one wave gate's shape, for the reason every `Task` union field is proven.
 *
 * The cast in `parseTaskGraph` asserts `Record<string, WaveGate>` and used to
 * prove nothing beyond "the container is an object". Four booleans read by gate
 * logic as booleans: `validate-task-execution` blocks on `!gate.reviews_complete`,
 * so `{ reviews_complete: "no" }` loaded clean and read as TRUTHY — the
 * previous-wave review gate silently stopped blocking, which is the failure this
 * boundary exists to make impossible. `tests_passed` is the one tri-state, and
 * `null` there means "not yet judged", not "absent".
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
 */
function specCheckError(v: unknown): string | null {
  if (v === undefined) return null;
  const parsed = parseStoredSpecCheck(v);
  return parsed.ok ? null : parsed.errors.join("; ");
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

export function taskUnionError(v: unknown, index: number): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return `tasks[${index}] must be an object`;
  }
  const t = v as Record<string, unknown>;
  const identityError = taskIdError(t.id, `tasks[${index}]`);
  if (identityError !== null) return identityError;
  const id = t.id as string;
  // Structural fields the cast below asserts — proven, not assumed: a
  // drifted or hand-edited graph must fail at the load boundary, not
  // explode later inside typed gate logic that trusts Task's shape.
  if (typeof t.description !== "string" || t.description.trim() === "") {
    return `tasks[${index}] ("${id}"): description must be a non-empty string, got ${JSON.stringify(t.description)}`;
  }
  if (typeof t.agent !== "string" || t.agent.trim() === "") {
    return `tasks[${index}] ("${id}"): agent must be a non-empty string, got ${JSON.stringify(t.agent)}`;
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
  if (t.artifact_baseline !== undefined) {
    const baseline = parseDeclaredArtifactBaseline(
      t.artifact_baseline,
      `tasks[${index}] ("${id}"): artifact_baseline`,
    );
    if (!baseline.ok) return baseline.errors.join("; ");
  }
  if (t.attempt_artifact_baseline !== undefined) {
    const baseline = parseDeclaredArtifactBaseline(
      t.attempt_artifact_baseline,
      `tasks[${index}] ("${id}"): attempt_artifact_baseline`,
    );
    if (!baseline.ok) return baseline.errors.join("; ");
    const declaredArtifacts = Array.isArray(t.file_list) ? t.file_list : [];
    const actualArtifacts = baseline.value.map(({ artifact }) => artifact);
    if (
      actualArtifacts.length < declaredArtifacts.length ||
      declaredArtifacts.some((artifact, artifactIndex) => artifact !== actualArtifacts[artifactIndex])
    ) {
      return `tasks[${index}] ("${id}"): attempt_artifact_baseline must cover file_list first and in order`;
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
  if (t.plan_context !== undefined && typeof t.plan_context !== "string") {
    return `tasks[${index}] ("${id}"): plan_context must be a string when present`;
  }
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
  if (t.test_result !== undefined) {
    if (typeof t.test_result !== "object" || t.test_result === null) {
      return `tasks[${index}] ("${id}"): test_result must be an object`;
    }
    const r = t.test_result as Record<string, unknown>;
    if (r.verdict === "untrusted") {
      if (typeof r.passed !== "boolean" || typeof r.label !== "string") {
        return `tasks[${index}] ("${id}"): untrusted test_result requires a boolean passed and a string label`;
      }
    } else if (r.verdict !== "trusted-pass" && r.verdict !== "trusted-fail") {
      return `tasks[${index}] ("${id}"): test_result.verdict ${JSON.stringify(r.verdict)} is not one of trusted-pass, trusted-fail, untrusted`;
    }
  }
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
  return evidenceFailureError(t, `tasks[${index}] ("${id}")`);
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
  const phaseArtifacts = obj.phase_artifacts as Record<string, string>;
  const skippedPhases = (obj.skipped_phases ?? []) as string[];
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
  const waveGates = obj.wave_gates ?? {};
  if (typeof waveGates !== "object" || waveGates === null || Array.isArray(waveGates)) {
    return parseErr("wave_gates must be an object");
  }
  for (const [wave, gate] of Object.entries(waveGates as Record<string, unknown>)) {
    const err = waveGateError(gate, wave);
    if (err !== null) return parseErr(err);
  }
  const specErr = specCheckError(obj.spec_check);
  if (specErr !== null) return parseErr(specErr);
  // The single blessed cast: every union field above is proven in place.
  return parseOk({
    ...obj,
    phase_artifacts: phaseArtifacts,
    skipped_phases: skippedPhases,
    spec_file: obj.spec_file ?? null,
    plan_file: obj.plan_file ?? null,
    tasks,
    wave_gates: waveGates,
  } as unknown as TaskGraph);
}

export class StateManager {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  static fromSession(sessionId?: string): StateManager | null {
    const path = resolveTaskGraph(sessionId);
    return path ? new StateManager(path) : null;
  }

  static fromPath(path: string): StateManager | null {
    return existsSync(path) ? new StateManager(path) : null;
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
    await this.atomicWrite(() => fn(this.load()));
  }

  /** Replace state entirely (used by populate-task-graph) */
  async replace(state: TaskGraph): Promise<void> {
    await this.atomicWrite(() => state);
  }

  /** lock → chmod 644 → produce/parse → write tmp → rename → chmod 444 → unlock */
  private async atomicWrite(produce: () => TaskGraph): Promise<void> {
    const lockFile = `${dirname(this.path)}/.task_graph`;
    const tmp = `${this.path}.tmp`;
    await withLock(lockFile, () => {
      chmodSync(this.path, 0o644);
      let primaryError: unknown = null;
      let committed = false;
      try {
        const parsed = parseTaskGraph(produce());
        if (!parsed.ok) throw new Error(`Refusing to persist invalid task graph (${parsed.error}): ${this.path}`);
        writeFileSync(tmp, JSON.stringify(parsed.value, null, 2));
        renameSync(tmp, this.path);
        committed = true;
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
        chmodSync(this.path, 0o444);
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
        throw new Error(
          `Task graph ${committed ? "was committed but" : "was not committed and"} read-only permission restoration failed: ${this.path}: ${permissionError instanceof Error ? permissionError.message : String(permissionError)}`,
          { cause: permissionError },
        );
      }
    });
  }
}
