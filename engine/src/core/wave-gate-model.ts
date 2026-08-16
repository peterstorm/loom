/**
 * Pure wave-gate domain model. The wave gate's runtime vocabulary lives HERE,
 * not in the legacy catch-all `engine/src/types.ts` — a functional-core module
 * must be reasoned about and tested in isolation from the outer-shell hook
 * contracts (`HookResult`, `PreToolUseInput`) that share that file. `types.ts`
 * re-exports everything below so the schema-root import surface is unchanged;
 * only the dependency ARROW moved: core → pure core model, never core →
 * legacy shell kernel.
 *
 * `Task` itself stays in `types.ts` for now: it is the schema root and carries
 * a web of cross-references (ReviewRun, SpecCheck, orchestration-contract
 * registrations) that are not wave-gate concerns. Extracting those records is
 * tracked as the second half of the wave-gate-model migration.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { match } from "ts-pattern";
import type { ProofTestResult } from "./proof-obligations";

/**
 * Per-task test outcome with its trust provenance IN the data. Trusted
 * verdicts come from the evidence ledger (real exit status cross-checked
 * against a parsed report artifact) and need no qualifier; an untrusted
 * verdict carries what the low-trust source claimed (`passed`) and a label
 * naming exactly how weak that source is. An independent boolean pair
 * would permit the impossible {passed: true, trusted: false → "trusted"?}
 * drift — this shape does not.
 *
 * Aliased to `ProofTestResult` rather than re-declared: both are the SAME
 * persisted `test_result` field, and two byte-identical unions validated by
 * two independent boundaries can drift with no compile error. One definition,
 * one validator.
 */
export type TaskTestResult = ProofTestResult;

/** Did the task's test evidence show a pass at ANY trust level? (Gate checks
 *  that need trust must match on `verdict` instead.) */
export function testResultPassed(result: TaskTestResult | undefined): boolean {
  if (result === undefined) return false;
  return match(result)
    .with({ verdict: "trusted-pass" }, () => true)
    .with({ verdict: "trusted-fail" }, () => false)
    .with({ verdict: "untrusted" }, ({ passed }) => passed)
    .exhaustive();
}

export interface WaveGate {
  readonly impl_complete: boolean;
  /** True after the wave's tests passed; null while not yet judged. `false`
   *  is deliberately UNREPRESENTABLE: no writer in the engine ever produces
   *  it (a failing run is judged by the test_result evidence, not by this
   *  gate flag), and the load boundary rejects a stored `false` so a drifted
   *  graph cannot mint a "Integration tests failed" branch that nothing writes. */
  readonly tests_passed: true | null;
  readonly reviews_complete: boolean;
  /**
   * An ORTHOGONAL VETO, not a phase. `blocked` deliberately coexists with
   * `impl_complete`/`reviews_complete`: every reader computes completion as
   * `impl_complete && tests_passed === true && reviews_complete && !blocked`,
   * so a finished-but-vetoed wave is a real, intended state — two independent
   * reviewers read the trio as a contradictory tri-state, which it is not.
   *
   * What the flag may NOT be is causeless. It has exactly two causes —
   * critical review findings on a task in this wave, and a wave-scoped
   * spec-check with `critical_count > 0` — and `validate-task-execution`
   * enumerates them verbatim when it refuses to run the next wave. A
   * `blocked: true` with neither prints "BLOCKED due to:" followed by nothing
   * and withholds the wave with no reason the operator can act on. The load
   * boundary proves the cause (`blockedGateCauseError`), so a drifted or
   * hand-edited graph cannot mint that dead end.
   */
  readonly blocked: boolean;
}

/** The initial (nothing verified yet) wave gate — the one shape every
 *  writer must start from. A factory instead of a shared literal so adding
 *  a field to WaveGate updates every construction site at once. */
export function newWaveGate(): WaveGate {
  return { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false };
}

// ---------------------------------------------------------------------------
// `blocked` and its causes — ONE definition, shared by writers and the boundary
// ---------------------------------------------------------------------------

/** The minimum a task must expose for the cause rule to read it. */
export interface WaveBlockCauseTask {
  readonly wave: number;
  readonly critical_findings?: readonly string[];
}

/** The minimum a spec-check record must expose for the cause rule to read it. */
export interface WaveBlockCauseSpecCheck {
  readonly wave: number;
  readonly verdict: string;
  readonly critical_count?: number;
}

/**
 * Does wave `wave` have a CAUSE to be blocked, right now?
 *
 * `blocked` has exactly two causes — a task in the wave carrying critical
 * review findings, and a wave-scoped spec-check reporting a critical — and
 * `validate-task-execution` enumerates precisely those two when it refuses to
 * start the next wave. This predicate is that rule, and it is deliberately the
 * ONLY copy: every writer that sets or clears the flag computes it from here,
 * and the load boundary proves the stored flag against it. When the rule lived
 * only in the setters, both clearers were simply missing — `store-review-findings`
 * downgrading the last critical, and the refutation tally refuting every
 * finding, each left `blocked: true` standing over an empty cause set, and the
 * wave dead-ended behind a "BLOCKED due to:" list with nothing in it.
 *
 * A BLANK finding string is not a cause. `wave-gate-machine`'s
 * `checkCriticalFindings` — the check that actually withholds the gate — counts
 * only `finding.trim() !== ""` entries, and `findingsViewError` admits
 * whitespace-only view entries, so counting raw array length here made the
 * "only copy" claim false in the one direction that matters: a wave whose sole
 * critical finding was whitespace passed the gate and then re-blocked against
 * this predicate. Same filter, same answer, one rule.
 */
export function waveHasBlockCause(
  tasks: readonly WaveBlockCauseTask[],
  specCheck: WaveBlockCauseSpecCheck | undefined,
  wave: number,
): boolean {
  const substantive = (findings: readonly string[] | undefined): number =>
    findings?.filter((finding) => finding.trim() !== "").length ?? 0;
  if (tasks.some((task) => task.wave === wave && substantive(task.critical_findings) > 0)) return true;
  return specCheck !== undefined &&
    specCheck.wave === wave &&
    specCheck.verdict !== "EVIDENCE_CAPTURE_FAILED" &&
    (specCheck.critical_count ?? 0) > 0;
}

/**
 * The wave-gate record with `blocked` re-derived from the causes present in
 * `tasks`/`specCheck`. Returns the SAME record object when nothing changes, so
 * a caller can leave `wave_gates` untouched on a no-op.
 */
export function reconcileWaveBlock<Gates extends Readonly<Record<string, WaveGate>>>(
  gates: Gates,
  tasks: readonly WaveBlockCauseTask[],
  specCheck: WaveBlockCauseSpecCheck | undefined,
  wave: number,
): Gates {
  const key = String(wave);
  const existing = gates[key] ?? newWaveGate();
  const blocked = waveHasBlockCause(tasks, specCheck, wave);
  return existing.blocked === blocked && gates[key] !== undefined
    ? gates
    : ({ ...gates, [key]: { ...existing, blocked } } as Gates);
}
