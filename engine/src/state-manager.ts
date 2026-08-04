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
import { PHASE_ORDER, TASK_GRAPH_PATH } from "./config";
import { parseErr, parseOk, parseSessionId, sessionScopedPath, type ParseResult } from "./machine";
import { REVIEW_STATUSES, TASK_STATUSES } from "./types";
import {
  findingIdCollisionError,
  findingsLockstepError,
  findingsUnionError,
  findingsViewError,
  evidenceFailureError,
  refutationsUnionError,
} from "./core/findings";
import type { TaskGraph } from "./types";
import { parseTaskProof } from "./core/proof-obligations";
import { parseDeclaredArtifactBaseline } from "./core/artifact-baseline";
import { parseStoredSpecCheck } from "./core/spec-check";

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

  if (existsSync(TASK_GRAPH_PATH)) return TASK_GRAPH_PATH;

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

export function taskUnionError(v: unknown, index: number): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return `tasks[${index}] must be an object`;
  }
  const t = v as Record<string, unknown>;
  const id = typeof t.id === "string" ? t.id : `#${index}`;
  // Structural fields the cast below asserts — proven, not assumed: a
  // drifted or hand-edited graph must fail at the load boundary, not
  // explode later inside typed gate logic that trusts Task's shape.
  if (typeof t.id !== "string" || t.id === "") {
    return `tasks[${index}]: id must be a non-empty string, got ${JSON.stringify(t.id)}`;
  }
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
  if (
    t.file_list !== undefined &&
    (!Array.isArray(t.file_list) || t.file_list.some((f) => typeof f !== "string"))
  ) {
    return `tasks[${index}] ("${id}"): file_list must be an array of strings when present`;
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
  if (t.plan_context !== undefined && typeof t.plan_context !== "string") {
    return `tasks[${index}] ("${id}"): plan_context must be a string when present`;
  }
  if (!(TASK_STATUSES as readonly string[]).includes(t.status as string)) {
    return `tasks[${index}] ("${id}"): status ${JSON.stringify(t.status)} is not one of ${TASK_STATUSES.join(", ")}`;
  }
  if (t.review_status !== undefined && !(REVIEW_STATUSES as readonly string[]).includes(t.review_status as string)) {
    return `tasks[${index}] ("${id}"): review_status ${JSON.stringify(t.review_status)} is not one of ${REVIEW_STATUSES.join(", ")}`;
  }
  if (t.proof !== undefined) {
    const proof = parseTaskProof(t.proof);
    if (!proof.ok) {
      return `tasks[${index}] ("${id}"): invalid proof: ${proof.errors.join("; ")}`;
    }
    const statusClaimsImplementation = t.status === "implemented" || t.status === "completed";
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
  // `validate-task-graph --fix` is the repair that restores lockstep.
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
  const collisionError = findingIdCollisionError(
    t.findings,
    t.refuted_findings,
    `tasks[${index}] ("${id}")`,
  );
  if (collisionError !== null) return collisionError;
  return evidenceFailureError(t, `tasks[${index}] ("${id}")`);
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
  if (!("current_phase" in obj)) return parseErr("missing current_phase");
  if (!("phase_artifacts" in obj)) return parseErr("missing phase_artifacts");
  if (!(PHASE_ORDER as readonly string[]).includes(obj.current_phase as string)) {
    return parseErr(
      `current_phase ${JSON.stringify(obj.current_phase)} is not one of ${PHASE_ORDER.join(", ")}`,
    );
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
  return parseOk({ ...obj, tasks, wave_gates: waveGates } as unknown as TaskGraph);
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

  /** lock → chmod 644 → produce → write tmp → rename → chmod 444 → unlock */
  private async atomicWrite(produce: () => TaskGraph): Promise<void> {
    const lockFile = `${dirname(this.path)}/.task_graph`;
    const tmp = `${this.path}.tmp`;
    await withLock(lockFile, () => {
      chmodSync(this.path, 0o644);
      try {
        writeFileSync(tmp, JSON.stringify(produce(), null, 2));
        renameSync(tmp, this.path);
      } catch (e) {
        // Clean up orphaned .tmp file
        try { unlinkSync(tmp); } catch {}
        throw e;
      } finally {
        chmodSync(this.path, 0o444);
      }
    });
  }
}
