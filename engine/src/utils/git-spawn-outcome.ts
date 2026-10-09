/**
 * How a status-returning Git run ended, as a closed value, and how such an
 * ending reads (pure: no process, no I/O). `git-execution-policy.ts` is the
 * one place a Git child is spawned; it parses the raw spawn result here, and
 * every caller classifies and renders the outcome through this module.
 *
 * A status-returning run never loses what the child said: every arm of
 * `GitSpawnOutcome` that ran a child carries both captured streams, and
 * `diagnoseGitOutcome` renders any arm — including a fatal exit whose stderr
 * arrived empty, which Git itself never produces — as a self-explaining
 * diagnostic.
 */
import { match } from "ts-pattern";

/** What a child that ran said: both streams, as captured bytes. */
export type GitCapture = Readonly<{ stdout: Buffer; stderr: Buffer }>;

/**
 * Every way one status-returning Git run can end, closed. Each arm in which a
 * child ran carries both captured streams, so no consumer can be handed an
 * outcome whose diagnostic was dropped on the way:
 *
 * - `spawn-failed` — no child ran (missing executable, bad cwd, …): the
 *   spawn error's code and message. Neither runtime hands back a stream then.
 * - `faulted` — a child ran, but the spawn reported an error other than a
 *   timeout or an over-budget capture (Node's `spawnSync` reports a pipe
 *   read/write fault or a failed kill this way), or reported no ending at
 *   all: the error's code and message, the status or signal the child ended
 *   on when one was reported, and whatever it wrote before the fault.
 * - `timed-out` — the child outlived the run's timeout and was killed.
 * - `over-budget` — a stream outgrew the run's `maxBuffer`; the child was
 *   killed and its captures are truncated.
 * - `signalled` — the child was terminated by a signal it did not ask for.
 * - `exited` — the child exited with `status`; this is the only arm a status
 *   protocol (`0` answered, `1` the clean negative answer) ever reads.
 */
export type GitSpawnOutcome =
  | Readonly<{ kind: "spawn-failed"; code: string | null; message: string }>
  | GitCapture & Readonly<{
    kind: "faulted";
    code: string | null;
    message: string;
    status: number | null;
    signal: NodeJS.Signals | null;
  }>
  | GitCapture & Readonly<{ kind: "timed-out"; timeoutMs: number | null; signal: NodeJS.Signals | null }>
  | GitCapture & Readonly<{ kind: "over-budget"; maxBuffer: number }>
  | GitCapture & Readonly<{ kind: "signalled"; signal: NodeJS.Signals }>
  | GitCapture & Readonly<{ kind: "exited"; status: number }>;

/** An outcome that exited with one of the statuses its caller's protocol accepts. */
export type GitExit<S extends number = number> = Extract<GitSpawnOutcome, { kind: "exited" }> & Readonly<{ status: S }>;

/** The bounds a run was given, which a timed-out or over-budget outcome names. */
export type GitSpawnBounds = Readonly<{ maxBuffer: number; timeout?: number }>;

/** The raw result a `spawnSync` implementation hands back, as loosely as Node
 *  and Bun actually shape it: Bun answers a missing executable with neither
 *  `status` nor captured streams, and a scripted test double may hand back
 *  strings. Everything past `parseGitSpawnResult` sees only the closed ADT. */
export type RawGitSpawnResult = Readonly<{
  error?: (Error & { code?: unknown }) | null;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: Buffer | string | null;
  stderr?: Buffer | string | null;
}>;

const present = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

const captured = (stream: Buffer | string | null | undefined): Buffer =>
  present(stream) ? Buffer.from(stream) : Buffer.alloc(0);

/** Whether the raw result shows that a child ran: it handed back a stream, a
 *  status or a signal. A spawn that started no child hands back none of them
 *  (Node: `output: null`; Bun: `stdout`/`stderr` null and no status). */
const childRan = (raw: RawGitSpawnResult): boolean =>
  present(raw.stdout) || present(raw.stderr) || typeof raw.status === "number" || present(raw.signal);

/** Parse one raw spawn result into its closed outcome; `bounds` are what a
 *  timed-out or over-budget arm names. */
export function parseGitSpawnResult(raw: RawGitSpawnResult, bounds: GitSpawnBounds): GitSpawnOutcome {
  const capture: GitCapture = Object.freeze({ stdout: captured(raw.stdout), stderr: captured(raw.stderr) });
  const signal = raw.signal ?? null;
  const status = typeof raw.status === "number" ? raw.status : null;
  const error = raw.error ?? null;
  const code = error !== null && typeof error.code === "string" ? error.code : null;
  if (code === "ETIMEDOUT") return Object.freeze({ kind: "timed-out", timeoutMs: bounds.timeout ?? null, signal, ...capture });
  if (code === "ENOBUFS") return Object.freeze({ kind: "over-budget", maxBuffer: bounds.maxBuffer, ...capture });
  if (error === null && signal !== null) return Object.freeze({ kind: "signalled", signal, ...capture });
  if (error === null && status !== null) return Object.freeze({ kind: "exited", status, ...capture });
  // A spawn error, or no ending reported at all: a fault when a child ran, so
  // what it wrote is kept; otherwise no child ran.
  const message = error === null ? "the spawn reported no exit status, no signal and no error" : error.message;
  return childRan(raw)
    ? Object.freeze({ kind: "faulted", code, message, status, signal, ...capture })
    : Object.freeze({ kind: "spawn-failed", code, message });
}

/** Whether the outcome is an exit its caller's status protocol accepts. */
export function gitExitedWith<S extends number>(outcome: GitSpawnOutcome, accepted: readonly S[]): outcome is GitExit<S> {
  return outcome.kind === "exited" && (accepted as readonly number[]).includes(outcome.status);
}

/** The clean negative answer of a 0/1 status protocol (`check-ignore -q`,
 *  `rev-parse --verify --quiet`, `merge-base`): exit 1 with both streams blank
 *  (empty or whitespace only — each is read trimmed). An exit 1 that wrote any
 *  other text is an error, never a "no". */
export function gitCleanNegative(outcome: GitSpawnOutcome): outcome is GitExit<1> {
  return gitExitedWith(outcome, [1]) && gitStdoutText(outcome).trim() === "" && gitStderrText(outcome) === "";
}

/** A captured stdout as UTF-8 text, untrimmed. */
export const gitStdoutText = (capture: GitCapture): string => capture.stdout.toString("utf-8");

/** A captured stderr as trimmed UTF-8 text: the diagnostic, or `""`. */
export const gitStderrText = (capture: GitCapture): string => capture.stderr.toString("utf-8").trim();

/** A rendered outcome: `head` names the ending ("exited 128", "terminated on
 *  signal SIGKILL", …); `detail` is Git's own stderr, the spawn error, or the
 *  explanation of a silence — `null` only when the ending itself says it all. */
export type GitDiagnosis = Readonly<{ head: string; detail: string | null }>;

const FATAL_EXIT_STATUS = 128;

/** Whether an exit is FATAL with a blank stderr. Git writes a diagnostic for
 *  every fatal exit (`die()` exits 128, usage errors 129), so this is a
 *  capture lost between the child and this process — never Git's own
 *  silence, and never an answer a caller may classify. It reads an exit
 *  rather than narrowing the outcome union: a `false` answer is still an
 *  exit, only an ordinary one. */
export function gitDiagnosticLost(exit: GitExit): boolean {
  return exit.status >= FATAL_EXIT_STATUS && gitStderrText(exit) === "";
}

function silentExitDetail(exit: GitExit): string {
  const bytes = `stderr empty, stdout ${exit.stdout.byteLength} bytes`;
  return gitDiagnosticLost(exit)
    ? `${bytes} — Git writes a diagnostic for every fatal exit, so the child's stderr was lost before it reached the engine`
    : bytes;
}

/** How a faulted child ended, as far as the spawn reported it. */
function faultedEnding(faulted: Extract<GitSpawnOutcome, { kind: "faulted" }>): string {
  if (faulted.status !== null) return `exited ${faulted.status}`;
  return faulted.signal === null ? "ended" : `terminated on signal ${faulted.signal}`;
}

/** Render any outcome so a failure names its own cause. */
export function diagnoseGitOutcome(outcome: GitSpawnOutcome): GitDiagnosis {
  const stderrOr = (capture: GitCapture, silent: string | null): string | null => {
    const diagnostic = gitStderrText(capture);
    return diagnostic === "" ? silent : diagnostic;
  };
  return Object.freeze(match(outcome)
    .with({ kind: "spawn-failed" }, ({ message }) => ({ head: "could not start", detail: message }))
    .with({ kind: "faulted" }, (faulted) => ({
      head: `${faultedEnding(faulted)} after a spawn fault (${faulted.message})`,
      detail: stderrOr(faulted, null),
    }))
    .with({ kind: "timed-out" }, (timedOut) => ({
      head: timedOut.timeoutMs === null ? "timed out" : `timed out after ${timedOut.timeoutMs} ms`,
      detail: stderrOr(timedOut, null),
    }))
    .with({ kind: "over-budget" }, (overBudget) => ({
      head: `exceeded its ${overBudget.maxBuffer}-byte output budget`,
      detail: stderrOr(overBudget, null),
    }))
    .with({ kind: "signalled" }, (signalled) => ({ head: `terminated on signal ${signalled.signal}`, detail: stderrOr(signalled, null) }))
    .with({ kind: "exited" }, (exited) => ({
      head: `exited ${exited.status}`,
      detail: stderrOr(exited, exited.status === 0 ? null : silentExitDetail(exited)),
    }))
    .exhaustive());
}

/** `diagnoseGitOutcome` as one line: `head` or `head: detail`. */
export function describeGitOutcome(outcome: GitSpawnOutcome): string {
  const { head, detail } = diagnoseGitOutcome(outcome);
  return detail === null ? head : `${head}: ${detail}`;
}
