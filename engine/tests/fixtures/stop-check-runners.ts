/**
 * The stop-check runner fixtures every stop-check suite shares:
 * - `ACCEPTANCE_RUNNER` and `AFFECTED_RUNNER`, the two `vitest` runners an
 *   operator would freeze under the manifest keys `acceptanceRunner` and
 *   `affectedRunner`, and their report paths beneath the protected report root;
 * - `affectedArgv`, `argvOf` and `checkNameOf`: the argv a command launches,
 *   and which check it is, told apart by report path;
 * - `parsedRun` and `observedRun`, completion runner results admitted by the
 *   production parser, so a fake can never hand the shell a result production
 *   would refuse, and no fake needs a cast;
 * - `recordingStopCheckPorts`, the in-memory `StopCheckShellPorts` that runs
 *   every check to a produced report and records what it launched.
 *
 * A suite that needs a different runner (another cwd, another timeout) spells
 * its own; these are the defaults, not the only legal shape.
 */

import { join } from "node:path";
import {
  MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  type ChangedFilePath,
  type StopCheckBlockCounters,
  type StopCheckCommand,
  type StopCheckName,
} from "../../src/core/affected-stop-check-types";
import { parseCompletionCheckResult } from "../../src/core/completion-suite";
import { sha256Bytes } from "../../src/core/digest";
import { UNKEPT_BLOCK_COUNTERS, type StopCheckShellPorts } from "../../src/handlers/subagent-stop/acceptance-stop-check";
import type { CompletionCheckRunnerResult } from "../../src/orchestration/completion-check-runner";
import type { CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";

export const ACCEPTANCE_REPORT = ".loom/completion-reports/acceptance.junit.xml";
export const AFFECTED_REPORT = ".loom/completion-reports/affected.junit.xml";

/** `vitest run` over the owed acceptance files, from the repository root. */
export const ACCEPTANCE_RUNNER = Object.freeze({
  executable: "vitest",
  args: Object.freeze(["run", "--reporter=junit", `--outputFile=${ACCEPTANCE_REPORT}`, "{files}"]),
  cwd: ".",
  timeoutMs: 120_000,
  report: Object.freeze({ kind: "required-file", path: ACCEPTANCE_REPORT }),
});

/** `vitest related` over the changed files, from the repository root, at the longest allowed timeout. */
export const AFFECTED_RUNNER = Object.freeze({
  executable: "vitest",
  args: Object.freeze(["related", "--run", "--reporter=junit", `--outputFile=${AFFECTED_REPORT}`, "{files}"]),
  cwd: ".",
  timeoutMs: MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  report: Object.freeze({ kind: "required-file", path: AFFECTED_REPORT }),
});

/** The affected runner's argv before its files: everything but `{files}`. */
export const AFFECTED_ARGV_PREFIX: readonly string[] = Object.freeze([AFFECTED_RUNNER.executable, ...AFFECTED_RUNNER.args.slice(0, -1)]);

/** The argv the affected runner launches over `files`. */
export const affectedArgv = (...files: string[]): readonly string[] => [...AFFECTED_ARGV_PREFIX, ...files];

/** The argv a formed command launches. */
export const argvOf = (command: StopCheckCommand): readonly string[] => [command.executable, ...command.args];

/** Which check a formed command runs, told apart by its report path. A command for neither report fails the test. */
export function checkNameOf(command: StopCheckCommand): StopCheckName {
  const path = command.reportPolicy.kind === "required-file" ? command.reportPolicy.path : null;
  if (path === ACCEPTANCE_REPORT) return "acceptance";
  if (path === AFFECTED_REPORT) return "affected";
  throw new Error(`fixture runner launched a command for an unknown report path ${String(path)}`);
}

/**
 * A completed runner result whose check result is spelled as plain JSON (any
 * outcome a fake needs: a timeout, a signal, a missing report, a failed
 * spawn) and admitted by the production parser. A refused shape fails the test.
 */
export function parsedRun(checkResult: unknown, stdoutTail = ""): CompletionCheckRunnerResult {
  const parsed = parseCompletionCheckResult(checkResult);
  if (!parsed.ok) throw new Error(`fixture check result refused: ${JSON.stringify(parsed.error)}`);
  return {
    ok: true,
    value: { checkResult: parsed.value, diagnostics: { stdoutTail, stderrTail: "", stdoutTruncated: false, stderrTruncated: false } },
  };
}

/** How an observed run ended. A clean exit is the default. */
export type RunEnding = Readonly<{ exitCode: number | null; timedOut: boolean; signal: string | null }>;

export const CLEAN_EXIT: RunEnding = Object.freeze({ exitCode: 0, timedOut: false, signal: null });

export type ObservedRunOptions = Readonly<{
  /** Defaults to a clean exit. */
  ending?: RunEnding;
  stdoutTail?: string;
  /** The bytes the runner reported a digest of, when they differ from the
   *  bytes left on disk: a report rewritten after the runner produced it. */
  digestOf?: Uint8Array;
}>;

/** `command` having run, leaving `bytes` as its report, or no report when null. */
export function observedRun(command: StopCheckCommand, bytes: Uint8Array | null, options: ObservedRunOptions = {}): CompletionCheckRunnerResult {
  const policy = command.reportPolicy;
  const digested = options.digestOf ?? bytes;
  const report = policy.kind === "not-required"
    ? { kind: "not-required" }
    : digested === null
      ? { kind: "missing", path: policy.path }
      : { kind: "produced", path: policy.path, digest: sha256Bytes(digested), byteLength: digested.byteLength };
  return parsedRun({ checkId: command.checkId, scope: "wave", outcome: { kind: "observed", ...(options.ending ?? CLEAN_EXIT), report } }, options.stdoutTail);
}

export type RecordingStopCheckPortsOptions = Readonly<{
  root: CanonicalRepositoryRoot;
  /** The report bytes a launch of `command` produces. */
  report: (command: StopCheckCommand) => Uint8Array;
  /** Defaults to `UNKEPT_BLOCK_COUNTERS`: nothing is counted. */
  blocks?: StopCheckBlockCounters;
  /** Defaults to every changed file existing. */
  pathExists?: (root: CanonicalRepositoryRoot, path: ChangedFilePath) => boolean;
  /** The clock's first reading; defaults to 0. */
  startMs?: number;
  /** How far each launch advances the clock; defaults to 0. */
  msPerRun?: number;
}>;

/**
 * In-memory stop-check ports that run every launched check to a clean exit
 * with the report `options.report` gives, under a lock that is always free.
 * `launches` holds each formed command in launch order.
 */
export function recordingStopCheckPorts(options: RecordingStopCheckPortsOptions): Readonly<{ ports: StopCheckShellPorts; launches: readonly StopCheckCommand[] }> {
  const launches: StopCheckCommand[] = [];
  const reports = new Map<string, Uint8Array>();
  const clock = { ms: options.startMs ?? 0 };
  const ports: StopCheckShellPorts = {
    repositoryRoot: () => ({ ok: true, root: options.root }),
    acquireRunner: () => ({ kind: "acquired", release: () => null }),
    runCheck: async (command) => {
      launches.push(command);
      const bytes = options.report(command);
      if (command.reportPolicy.kind === "required-file") reports.set(join(options.root, command.reportPolicy.path), bytes);
      clock.ms += options.msPerRun ?? 0;
      return observedRun(command, bytes);
    },
    readReport: (path) => reports.get(path) ?? new Uint8Array(),
    blocks: options.blocks ?? UNKEPT_BLOCK_COUNTERS,
    pathExists: options.pathExists ?? (() => true),
    now: () => clock.ms,
  };
  return { ports, launches };
}
