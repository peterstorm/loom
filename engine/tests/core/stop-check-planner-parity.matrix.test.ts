/**
 * INV-1 parity matrix: one planner decides both stop checks.
 *
 * Every row is a TaskGraph, a Task and the Task's changed files. Each sibling
 * entry point consumes the same input, and each must act on exactly the
 * commands `planStopChecks` (the owner) forms, in order, acceptance first:
 * - the live Claude stop shell, `runStopChecks` with blocking ports;
 * - the Pi report-only stop, `reportImplementationStopChecks`, fed the
 *   attempt's epoch as a ledger observation;
 * - the `helper stop-check-plan` view, `stopChecksPlanView` and the
 *   `renderStopChecksPlan` lines it prints.
 * None of them may re-derive what is owed, which files run or how a command
 * is formed, so any drift shows up as a row where they disagree.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportImplementationStopChecks } from "../../../pi/subagent-stop";
import { planStopChecks } from "../../src/core/acceptance-contract/stop-check-planner";
import { renderStopChecksPlan, stopChecksPlanView } from "../../src/core/acceptance-contract/stop-check-plan";
import { MAX_AFFECTED_RUNNER_TIMEOUT_MS, type ChangedFiles } from "../../src/core/affected-stop-check-types";
import { changedFilesAtStop } from "../../src/core/changed-files";
import { sha256Bytes } from "../../src/core/digest";
import { freezeVerificationManifest, type FrozenVerificationManifest } from "../../src/core/verification-manifest";
import { UNKEPT_BLOCK_COUNTERS, type StopCheckShellPorts } from "../../src/handlers/subagent-stop/acceptance-stop-check";
import { runStopChecks } from "../../src/handlers/subagent-stop/stop-checks";
import type { Evidence } from "../../src/machine";
import type { CompletionCheckRunnerResult } from "../../src/orchestration/completion-check-runner";
import type { TaskGraph } from "../../src/types";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { contract, frozenPaths, surface, task } from "../fixtures/contract-status-fixtures";

const SURFACE = surface("payload");
const ACCEPTANCE_REPORT = ".loom/completion-reports/acceptance.junit.xml";
const AFFECTED_REPORT = ".loom/completion-reports/affected.junit.xml";
const OWED = "AS-001: one valid call wins";

const ACCEPTANCE_RUNNER = {
  executable: "vitest",
  args: ["run", "--reporter=junit", `--outputFile=${ACCEPTANCE_REPORT}`, "{files}"],
  cwd: ".",
  timeoutMs: 120_000,
  report: { kind: "required-file", path: ACCEPTANCE_REPORT },
};
const AFFECTED_RUNNER = {
  executable: "vitest",
  args: ["related", "--run", "--reporter=junit", `--outputFile=${AFFECTED_REPORT}`, "{files}"],
  cwd: ".",
  timeoutMs: MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  report: { kind: "required-file", path: AFFECTED_REPORT },
};
const NODE_AFFECTED_RUNNER = {
  executable: "node",
  args: ["--test", "--test-reporter=junit", `--test-reporter-destination=${AFFECTED_REPORT}`, "{files}"],
  cwd: ".",
  timeoutMs: MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  report: { kind: "required-file", path: AFFECTED_REPORT },
};

type RunnerChoice = boolean | Readonly<Record<string, unknown>>;

function manifest(acceptance: RunnerChoice, affected: Readonly<Record<string, unknown>> | null): FrozenVerificationManifest {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    kind: "loom-verification-manifest",
    checks: [],
    ...(acceptance === false ? {} : { acceptanceRunner: acceptance === true ? ACCEPTANCE_RUNNER : acceptance }),
    ...(affected === null ? {} : { affectedRunner: affected }),
  })));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return frozen.value;
}

function graph(frozen: FrozenVerificationManifest): TaskGraph {
  return {
    current_phase: "execute", phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: "plan.md", wave_gates: {},
    tasks: [
      task("T1", 1, [SURFACE.types, SURFACE.acceptance]),
      task("T2", 2, ["src/payload.ts", "src/payload.test.ts"], ["AS-001"]),
      task("T3", 2, ["src/ledger.ts", "src/ledger.test.js", "engine/ledger.ts"]),
    ],
    acceptance_contracts: [contract({
      id: "CT-1", surface: SURFACE, anchors: ["AS-001"],
      freeze: { state: "frozen", wave: 1, paths: frozenPaths(SURFACE, "a"), roster: [{ file: SURFACE.acceptance, name: OWED, anchors: ["AS-001"] }] as never },
    })],
    verification_manifest: frozen,
  };
}

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repositoryRoot(): CanonicalRepositoryRoot {
  const dir = canonicalTempDir("loom-planner-parity-");
  roots.push(dir);
  const parsed = parseCanonicalRepositoryRoot(dir);
  if (!parsed.ok) throw new Error("root fixture");
  return parsed.value;
}

type Command = Readonly<{ argv: readonly string[]; cwd: string; reportPath: string }>;

/** Ports whose runner records each command and reports every check passing. */
function recordingPorts(root: CanonicalRepositoryRoot, reportOnly: boolean): Readonly<{ ports: StopCheckShellPorts; launched: Command[] }> {
  const launched: Command[] = [];
  const reports = new Map<string, Uint8Array>();
  const ports: StopCheckShellPorts = {
    repositoryRoot: () => ({ ok: true, root }),
    acquireRunner: () => ({ kind: "acquired", release: () => null }),
    runCheck: async (command) => {
      const reportPath = command.reportPolicy.kind === "required-file" ? command.reportPolicy.path : "";
      launched.push({ argv: [command.executable, ...command.args], cwd: command.cwd, reportPath });
      const bytes = new TextEncoder().encode(`<testsuites><testsuite name="s" tests="1"><testcase classname="${SURFACE.acceptance}" name="${OWED}"/></testsuite></testsuites>`);
      reports.set(join(root, reportPath), bytes);
      return {
        ok: true,
        value: {
          checkResult: { checkId: command.checkId, scope: "wave", outcome: { kind: "observed", exitCode: 0, timedOut: false, signal: null, report: { kind: "produced", path: reportPath, digest: sha256Bytes(bytes), byteLength: bytes.byteLength } } },
          diagnostics: { stdoutTail: "", stderrTail: "", stdoutTruncated: false, stderrTruncated: false },
        },
      } as CompletionCheckRunnerResult;
    },
    readReport: (path) => reports.get(path) ?? new Uint8Array(),
    blocks: {
      ...UNKEPT_BLOCK_COUNTERS,
      record: () => { if (reportOnly) throw new Error("report-only ports record no block"); },
    },
    pathExists: () => true,
    now: () => 0,
  };
  return { ports, launched };
}

/** The commands the owner's plan forms, in the order the shell must run them. */
function plannedCommands(g: TaskGraph, taskId: string, changed: ChangedFiles): readonly Command[] {
  const plan = planStopChecks(g, taskId, changed);
  if (plan.kind === "unknown-task") return [];
  const on = [plan.acceptance, plan.affected].flatMap((arm) => arm.kind === "on" ? [arm] : []);
  return on.map(({ command, reportPath }) => ({ argv: [command.executable, ...command.args], cwd: command.cwd, reportPath }));
}

/** The commands the view shows, in its order. */
function viewedCommands(g: TaskGraph, taskId: string, changed: ChangedFiles): readonly Command[] {
  const view = stopChecksPlanView(g, taskId, changed);
  if (view.kind === "unknown-task") return [];
  return [view.acceptance, view.affected].flatMap((arm) => arm.kind === "on" ? [{ argv: arm.command.argv, cwd: arm.command.cwd, reportPath: arm.command.reportPath }] : []);
}

/** The argv lines the rendered plan prints, acceptance first. */
const renderedArgv = (g: TaskGraph, taskId: string, changed: ChangedFiles): readonly (readonly string[])[] => {
  const rendering = renderStopChecksPlan(g, taskId, changed);
  return rendering.kind === "rendered"
    ? rendering.lines.flatMap((line) => line.trimStart().startsWith("argv: ") ? [JSON.parse(line.trimStart().slice("argv: ".length)) as string[]] : [])
    : [];
};

type Row = Readonly<{ label: string; acceptance: RunnerChoice; affected: Readonly<Record<string, unknown>> | null; taskId: string; files: readonly string[] }>;

const ROWS: readonly Row[] = [
  { label: "a claimant with both runners and changed files", acceptance: true, affected: AFFECTED_RUNNER, taskId: "T2", files: ["src/payload.ts", "src/payload.test.ts"] },
  { label: "a non-claimant with both runners and changed files", acceptance: true, affected: AFFECTED_RUNNER, taskId: "T3", files: ["src/ledger.ts"] },
  { label: "a claimant with only the acceptance runner", acceptance: true, affected: null, taskId: "T2", files: ["src/payload.ts"] },
  { label: "a claimant with no changed files", acceptance: true, affected: AFFECTED_RUNNER, taskId: "T2", files: [] },
  { label: "a non-claimant with only the affected runner", acceptance: false, affected: AFFECTED_RUNNER, taskId: "T3", files: ["src/ledger.ts", "src/ledger.test.js"] },
  { label: "changed files partly outside the affected runner cwd", acceptance: false, affected: { ...AFFECTED_RUNNER, cwd: "engine" }, taskId: "T3", files: ["src/ledger.ts", "engine/ledger.ts"] },
  { label: "changed files only outside the affected runner cwd", acceptance: false, affected: { ...AFFECTED_RUNNER, cwd: "engine" }, taskId: "T3", files: ["src/ledger.ts"] },
  { label: "an affected command the builder refuses", acceptance: true, affected: NODE_AFFECTED_RUNNER, taskId: "T3", files: ["src/ledger.test.js", "-e"] },
  { label: "an acceptance command the builder refuses", acceptance: { ...ACCEPTANCE_RUNNER, cwd: "engine" }, affected: AFFECTED_RUNNER, taskId: "T2", files: ["src/payload.ts"] },
  { label: "no runner frozen", acceptance: false, affected: null, taskId: "T3", files: ["src/ledger.ts"] },
  { label: "an unknown Task", acceptance: true, affected: AFFECTED_RUNNER, taskId: "T9", files: ["src/ledger.ts"] },
];

describe("INV-1: the live stop shells and the plan view act on the one plan", () => {
  it.each(ROWS)("AS-034: for $label, the Claude shell, the Pi report-only stop and the view show the owner's commands", async ({ acceptance, affected, taskId, files }) => {
    const root = repositoryRoot();
    const g = graph(manifest(acceptance, affected));
    const events = files.map((path): Evidence => ({ kind: "FileWrite", path: join(root, path), via: "tool" }));
    const changed = changedFilesAtStop(events, root, () => true);
    const planned = plannedCommands(g, taskId, changed);

    const claude = recordingPorts(root, false);
    await runStopChecks({
      loadGraph: () => g,
      stateFilePath: join(root, ".loom/active_task_graph.json"),
      taskId,
      agentKey: "session.agent",
      changedFiles: () => ({ kind: "observed", changed }),
      hookStartedAtMs: 0,
    }, claude.ports);

    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pi = recordingPorts(root, true);
    await reportImplementationStopChecks({ load: () => g, getPath: () => join(root, ".pi/active_task_graph.json") }, taskId, { kind: "read", events }, pi.ports);

    expect(claude.launched).toEqual(planned);
    expect(pi.launched).toEqual(planned);
    expect(viewedCommands(g, taskId, changed)).toEqual(planned);
    expect(renderedArgv(g, taskId, changed)).toEqual(planned.map(({ argv }) => argv));
  });

  it("covers every planner arm: each acceptance and affected kind appears in some row", () => {
    const kinds = new Set(ROWS.flatMap(({ acceptance, affected, taskId, files }) => {
      const root = "/repo";
      const changed = changedFilesAtStop(files.map((path): Evidence => ({ kind: "FileWrite", path: join(root, path), via: "tool" })), root, () => true);
      const plan = planStopChecks(graph(manifest(acceptance, affected)), taskId, changed);
      return plan.kind === "unknown-task"
        ? ["unknown-task"]
        : [
            `acceptance:${plan.acceptance.kind === "on" ? "on" : plan.acceptance.reason.kind}`,
            `affected:${plan.affected.kind === "on" ? "on" : plan.affected.reason.kind}`,
          ];
    }));
    expect([...kinds].sort()).toEqual([
      "acceptance:command-refused",
      "acceptance:no-runner",
      "acceptance:nothing-owed",
      "acceptance:on",
      "affected:command-refused",
      "affected:no-changed-files",
      "affected:no-runner",
      "affected:on",
      "unknown-task",
    ]);
  });
});
