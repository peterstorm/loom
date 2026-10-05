/**
 * The Wave Gate drive's outcomes: the blocked action every refusal reports,
 * the uncaught-failure report, and the phase result each resume phase returns
 * to the reducer in wave-gate.ts.
 */
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import type { FacadeDriveResult } from './program-result';

export function waveBlocked(handle: RunDirHandle, message: string): FacadeDriveResult {
  return { ok: true, action: { kind: "blocked", runId: handle.runId, diagnostic: { kind: "wave-gate-blocked", message } } };
}

/** Preserve uncaught programming/infrastructure diagnostics at the outer shell. */
export function reportUncaughtWaveGateFailure(runId: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`loom: uncaught internal Wave Gate failure in ${runId}\n${diagnostic}\n`);
  return `internal Wave Gate failure: ${message}`;
}

/**
 * What one resume phase decided:
 * - "settled" — the phase produced this invocation's answer (spawn, await,
 *   blocked, done, or a failed drive);
 * - "rederive" — the phase consumed durable progress, so the reducer must
 *   re-derive from the new protected state (bounded by the reducer's depth);
 * - "proceed" — nothing for this phase to do; continue with its value.
 */
export type WavePhase<T = undefined> =
  | Readonly<{ kind: "settled"; result: FacadeDriveResult }>
  | Readonly<{ kind: "rederive" }>
  | Readonly<{ kind: "proceed"; value: T }>;

export const settled = (result: FacadeDriveResult): WavePhase<never> => ({ kind: "settled", result });
export const rederive: WavePhase<never> = Object.freeze({ kind: "rederive" });
export function proceed(): WavePhase<undefined>;
export function proceed<T>(value: T): WavePhase<T>;
export function proceed<T>(value?: T): WavePhase<T | undefined> {
  return { kind: "proceed", value };
}
