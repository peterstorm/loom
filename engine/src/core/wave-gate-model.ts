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
  readonly tests_passed: boolean | null;
  readonly reviews_complete: boolean;
  readonly blocked: boolean;
}

/** The initial (nothing verified yet) wave gate — the one shape every
 *  writer must start from. A factory instead of a shared literal so adding
 *  a field to WaveGate updates every construction site at once. */
export function newWaveGate(): WaveGate {
  return { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false };
}
