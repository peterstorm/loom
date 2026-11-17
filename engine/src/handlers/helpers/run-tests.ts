/**
 * `helper run-tests` (loom#198, Cause 1): run the frozen Verification
 * Manifest's `affectedRunner` over the test files an implementation agent
 * names, and print the engine's receipt of that run as the LAST stdout line.
 * Usage: bun cli.ts helper run-tests --files <path> [--files <path>]...
 *
 * In a graph that froze engine-run test evidence (`test_evidence`), this is
 * the only test run that proves I6: the evidence recorder mints an engine-run
 * TestRun from the receipt (`machine/extract-evidence.ts`), and settlement
 * admits only such runs. The agent chooses the files; the engine chooses the
 * runner, its arguments, its working directory, its timeout and its report
 * path, all from the frozen manifest.
 *
 * A shell around `affectedRunnerCheck` (the command), the completion check
 * runner (which resets the report before it runs and contains the process
 * tree), and the pure `engineRunReport` / `formatEngineTestRunReceipt`. The
 * run holds the per-repository runner lock the stop checks hold, so a stop
 * check and this run never write the same report at once; a held lock is
 * waited for, within a bound.
 *
 * The runner's own output goes to stderr, before the receipt: nothing a test
 * prints can become the last stdout line. A run that finished prints its
 * receipt and exits 0, whatever its tests did (the receipt carries the
 * runner's exit). A run that did not finish (timed out, killed, could not
 * start) prints no receipt and is an error: it proves nothing.
 *
 * It never writes the State File or the ledger.
 */

import { join } from "node:path";
import type { HookHandler, TaskGraph } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { nonEmpty, type NonEmpty } from "../../core/orchestration-contract";
import { parseReviewPath } from "../../core/review-packet";
import { sha256Bytes } from "../../core/digest";
import { engineRunReport, formatEngineTestRunReceipt, type EngineTestRunReceipt } from "../../core/engine-test-run";
import { engineRunUnavailableReason } from "../../core/test-evidence-authority";
import { affectedRunnerCheck } from "../../core/verification-manifest";
import type { StopCheckCommand, StopCheckRunnerLock } from "../../core/affected-stop-check-types";
import type { CompletionCheckRunnerResult } from "../../orchestration/completion-check-runner";
import type { CanonicalRepositoryRoot } from "../../utils/workspace-digest";
import { describeCause } from "../../utils/describe-cause";
import { PRODUCTION_STOP_CHECK_PORTS, type StopCheckShellPorts } from "../subagent-stop/acceptance-stop-check";
import { argumentValues, unconsumedValueArguments } from "./cli-args";

const FLAGS: ReadonlySet<string> = new Set(["--files"]);

/** How long a run waits for a stop check (or another run) to release the runner lock. */
export const RUNNER_LOCK_WAIT_MS = 10 * 60 * 1000;
const RUNNER_LOCK_POLL_MS = 1000;

/** What the helper reaches the world through. */
export type RunTestsPorts = Readonly<{
  /** Engine-authored stdout: the summary line and, last, the receipt. */
  write: (text: string) => void;
  /** The runner's own output and every diagnostic. */
  writeDiagnostic: (text: string) => void;
  repositoryRoot: StopCheckShellPorts["repositoryRoot"];
  acquireRunner: (root: CanonicalRepositoryRoot) => StopCheckRunnerLock;
  runCheck: (check: StopCheckCommand, root: CanonicalRepositoryRoot) => Promise<CompletionCheckRunnerResult>;
  readReport: (path: string) => Uint8Array;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}>;

const PRODUCTION_PORTS: RunTestsPorts = Object.freeze({
  write: (text: string) => {
    process.stdout.write(text);
  },
  writeDiagnostic: (text: string) => {
    process.stderr.write(text);
  },
  repositoryRoot: PRODUCTION_STOP_CHECK_PORTS.repositoryRoot,
  acquireRunner: PRODUCTION_STOP_CHECK_PORTS.acquireRunner,
  runCheck: PRODUCTION_STOP_CHECK_PORTS.runCheck,
  readReport: PRODUCTION_STOP_CHECK_PORTS.readReport,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});

type Refusal = Readonly<{ ok: false; message: string }>;
const refuse = (message: string): Refusal => ({ ok: false, message: `run-tests: ${message}` });

/** The distinct repository-relative test files the caller named, or the refusal of the command line. */
function parseFilesArgument(args: readonly string[]): Readonly<{ ok: true; files: NonEmpty<string> }> | Refusal {
  const unconsumed = unconsumedValueArguments(args, FLAGS);
  if (unconsumed.length > 0) return refuse(`unknown or unconsumed argument(s): ${unconsumed.join(" ")}`);
  const values = argumentValues(args, "--files");
  if (values === null) return refuse("every --files needs a path");
  const files = nonEmpty([...values]);
  if (files === null) return refuse("requires --files <test file> (repeat it for each of the Task's test files)");
  for (const file of files) {
    const path = parseReviewPath(file, `--files ${file}`);
    if (!path.ok) return refuse(path.errors.join("; "));
  }
  if (new Set(files).size !== files.length) return refuse("names a file more than once");
  return { ok: true, files };
}

/** Wait for the runner lock, within `RUNNER_LOCK_WAIT_MS`. */
async function acquireWithin(root: CanonicalRepositoryRoot, ports: RunTestsPorts): Promise<StopCheckRunnerLock> {
  const deadline = ports.now() + RUNNER_LOCK_WAIT_MS;
  let lock = ports.acquireRunner(root);
  while (lock.kind === "held" && ports.now() < deadline) {
    await ports.sleep(RUNNER_LOCK_POLL_MS);
    lock = ports.acquireRunner(root);
  }
  return lock;
}

/** The report bytes the runner produced, read back while the lock is held, or null when they changed or cannot be read. */
function readBackReport(root: CanonicalRepositoryRoot, report: Readonly<{ path: string; digest: string }>, ports: RunTestsPorts): string | null {
  try {
    const bytes = ports.readReport(join(root, report.path));
    return sha256Bytes(bytes) === report.digest ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : null;
  } catch {
    return null;
  }
}

/** The runner's captured output, for the agent to read on stderr. */
function runnerOutput(run: CompletionCheckRunnerResult): string {
  const diagnostics = run.ok ? run.value.diagnostics : "diagnostics" in run.error ? run.error.diagnostics : null;
  if (diagnostics === null) return "";
  return [
    diagnostics.stdoutTail === "" ? "" : `--- runner stdout${diagnostics.stdoutTruncated ? " (tail)" : ""} ---\n${diagnostics.stdoutTail}\n`,
    diagnostics.stderrTail === "" ? "" : `--- runner stderr${diagnostics.stderrTruncated ? " (tail)" : ""} ---\n${diagnostics.stderrTail}\n`,
  ].join("");
}

/** The receipt of one finished run, or why the run proves nothing. */
function receiptOf(
  run: CompletionCheckRunnerResult,
  files: NonEmpty<string>,
  graph: Readonly<{ root: CanonicalRepositoryRoot; manifestDigest: string }>,
  ports: RunTestsPorts,
): Readonly<{ ok: true; receipt: EngineTestRunReceipt }> | Refusal {
  if (!run.ok) return refuse(`the runner did not complete: ${run.error.message}`);
  const outcome = run.value.checkResult.outcome;
  if (outcome.kind === "spawn-failed") return refuse(`the runner could not start: ${outcome.message}`);
  if (outcome.timedOut) return refuse("the runner timed out; a partial run proves nothing");
  if (outcome.signal !== null) return refuse(`the runner was killed by ${outcome.signal}; a partial run proves nothing`);
  if (outcome.exitCode === null) return refuse("the runner's exit is unknown");
  const reportText = outcome.report.kind === "produced" ? readBackReport(graph.root, outcome.report, ports) : null;
  return {
    ok: true,
    receipt: Object.freeze({
      repositoryRoot: graph.root,
      manifestDigest: graph.manifestDigest,
      files,
      exit: outcome.exitCode,
      report: engineRunReport(files, outcome.exitCode, reportText),
    }),
  };
}

/** One line a reader can scan: the exit and what the report says. */
function summaryLine(receipt: EngineTestRunReceipt): string {
  const report = receipt.report === null
    ? "no readable report"
    : `${receipt.report.total} tests, ${receipt.report.failed} failed (${receipt.report.source})`;
  return `run-tests: exit ${receipt.exit} — ${report} over ${receipt.files.length} file(s)\n`;
}

function loadGraph(): Readonly<{ ok: true; graph: TaskGraph; statePath: string }> | Refusal {
  const statePath = taskGraphPath();
  const manager = StateManager.fromPath(statePath);
  if (manager === null) return refuse(`no task graph at ${statePath}`);
  try {
    return { ok: true, graph: manager.load(), statePath: manager.getPath() };
  } catch (cause) {
    return refuse(describeCause(cause));
  }
}

export function createRunTestsHandler(ports: RunTestsPorts = PRODUCTION_PORTS): HookHandler {
  return async (_stdin, args) => {
    const parsed = parseFilesArgument(args);
    if (!parsed.ok) return { kind: "error", message: parsed.message };
    const loaded = loadGraph();
    if (!loaded.ok) return { kind: "error", message: loaded.message };
    const manifest = loaded.graph.verification_manifest;
    const unavailable = engineRunUnavailableReason(manifest);
    if (unavailable !== null || manifest?.affectedRunner === undefined) {
      return { kind: "error", message: `run-tests: ${unavailable ?? "no affectedRunner"}; there is no engine runner to run` };
    }
    const command = affectedRunnerCheck(manifest.affectedRunner, parsed.files);
    if (!command.ok) return { kind: "error", message: `run-tests: ${command.error.errors.join("; ")}` };
    const root = ports.repositoryRoot(loaded.statePath);
    if (!root.ok) return { kind: "error", message: `run-tests: ${root.reason}` };

    const lock = await acquireWithin(root.root, ports);
    if (lock.kind === "held") return { kind: "error", message: `run-tests: the runner lock stayed held: ${lock.reason}` };
    let outcome: ReturnType<typeof receiptOf>;
    let run: CompletionCheckRunnerResult;
    try {
      run = await ports.runCheck(command.value, root.root);
      // The report is read back while the lock is held, so no stop check can overwrite it first.
      outcome = receiptOf(run, parsed.files, { root: root.root, manifestDigest: manifest.manifestDigest }, ports);
    } finally {
      const released = lock.release();
      if (released !== null) ports.writeDiagnostic(`run-tests: ${released}\n`);
    }
    ports.writeDiagnostic(runnerOutput(run));
    if (!outcome.ok) return { kind: "error", message: outcome.message };
    ports.write(summaryLine(outcome.receipt));
    ports.write(`${formatEngineTestRunReceipt(outcome.receipt)}\n`);
    return { kind: "passthrough" };
  };
}

export default createRunTestsHandler();
