/**
 * The Wave Gate drive's phase seam: the context every resume phase receives,
 * the blocked action every refusal reports, the uncaught-failure report, the
 * re-derivation budget that bounds one invocation, and the phase result each
 * resume phase returns to the reducer in wave-gate.ts.
 */
import type { RegisteredWaveGateProgram } from '../../../core/wave-gate-program';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import type { StateManager } from '../../../state-manager';
import type { FacadeDriveResult } from './program-result';

declare const WAVE_RESUME_CONTEXT: unique symbol;

/**
 * What every resume phase of one reducer invocation shares. The reducer builds
 * it once, through `waveResumeContext`, after proving the registration owns
 * the protected active Wave. The brand makes that constructor the only way to
 * build one, so no context — a hand-built test fixture included — can carry a
 * `wave` that disagrees with its own registration.
 *
 * Staleness contract:
 * - `registration` and `wave` are durable Run Directory authority and never
 *   change within a run. `wave` is derived from `registration.input.wave`,
 *   already proven to be the protected current Wave.
 * - `captured` is the captured-attempt set, read once before the first phase.
 *   Only the harness captures transcripts; no phase does. Captures only
 *   accumulate, so the snapshot can miss one that landed during this
 *   invocation but never names one that is absent. A phase that misses a
 *   capture spawns or waits on it, and the next invocation applies it.
 * - Protected TaskGraph state and the issued-request journal are deliberately
 *   absent. The issuance phase writes both, so it alone receives the
 *   pre-issuance graph and journal as its own inputs and hands later phases
 *   their successors (`IssuedWaveReviewBatch.refreshed` / `currentIssued`);
 *   carried here, the pre-issuance snapshots would reach phases they are stale
 *   for. Every other phase reads `manager.load()` itself after any write it
 *   depends on.
 */
export type WaveResumeContext = Readonly<{
  handle: RunDirHandle;
  manager: StateManager;
  registration: RegisteredWaveGateProgram;
  wave: number;
  captured: ReadonlySet<string>;
  readonly [WAVE_RESUME_CONTEXT]: true;
}>;

/** Build the one phase context of a reducer invocation, deriving `wave` from
 *  the registration, as the reducer's first phase: it proceeds with the
 *  context, or settles the invocation as blocked when the registration names
 *  no exact Wave, which no context may represent. */
export function waveResumeContext(
  handle: RunDirHandle,
  manager: StateManager,
  registration: RegisteredWaveGateProgram,
  captured: ReadonlySet<string>,
): WavePhase<WaveResumeContext> {
  const wave = registration.input.wave;
  if (wave === null) return settled(waveBlocked(handle, "registered Wave Gate authority lacks an exact Wave"));
  return proceed(Object.freeze({ handle, manager, registration, wave, captured }) as WaveResumeContext);
}

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
 * Upper bound on same-invocation re-derivations of the Wave Gate reducer.
 * Every legitimate re-derivation consumes durable progress (a captured retry
 * applied, an accepted spec-check retry, a tally that retired a finding, an
 * installed completion suite), each at most once per resume invocation, so
 * exceeding this is a reducer defect, not a large run. The bound converts a
 * hypothetical spin into a loud blocked diagnostic instead of an engine hang.
 */
const MAX_WAVE_GATE_REDERIVATIONS = 64;

declare const WAVE_REDERIVATIONS: unique symbol;

/**
 * The re-derivations one resume invocation has made. An invocation starts
 * with `NO_WAVE_REDERIVATIONS`, and `spendWaveRederivation` is the only way
 * to make another, so no re-entry of the reducer can skip the bound.
 */
export type WaveRederivations = Readonly<{ made: number; readonly [WAVE_REDERIVATIONS]: true }>;

export const NO_WAVE_REDERIVATIONS = Object.freeze({ made: 0 }) as WaveRederivations;

/** Spend one re-derivation, or refuse with the spin diagnostic once the bound is spent. Pure and total. */
export function spendWaveRederivation(
  spent: WaveRederivations,
): Readonly<{ ok: true; value: WaveRederivations }> | Readonly<{ ok: false; error: string }> {
  return spent.made >= MAX_WAVE_GATE_REDERIVATIONS
    ? { ok: false, error: `Wave Gate resume exceeded ${MAX_WAVE_GATE_REDERIVATIONS} re-derivations without durable progress; refusing to spin` }
    : { ok: true, value: Object.freeze({ made: spent.made + 1 }) as WaveRederivations };
}

/**
 * What one resume phase decided:
 * - "settled" — the phase produced this invocation's answer (spawn, await,
 *   blocked, done, or a failed drive);
 * - "rederive" — the phase consumed durable progress, so the reducer must
 *   re-derive from the new protected state (bounded by `WaveRederivations`);
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
