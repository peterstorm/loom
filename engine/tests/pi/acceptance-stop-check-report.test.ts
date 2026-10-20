/**
 * Pi runs the stop checks report-only, at the call site that settles an
 * implementation result: a failing owed acceptance testcase is one operator
 * line, never a block and never a processing error, and a result without a
 * Task runs nothing. The child's epoch here records no writes, so the affected
 * check is off and only the acceptance check runs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { piStopResponse, reportImplementationStopChecks } from "../../../pi/subagent-stop";
import { STOP_CHECK_NOTES_HEADING } from "../../src/core/stop-check-note";
import {
  REPORT_ONLY_STOP_CHECK_PORTS,
  type StopCheckShellPorts,
} from "../../src/handlers/subagent-stop/acceptance-stop-check";
import type { LedgerObservation } from "../../src/core/red-then-green-types";
import { freezeVerificationManifest } from "../../src/core/verification-manifest";
import type { TaskGraph } from "../../src/types";
import { parseCanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { contract, frozenPaths, surface, task } from "../fixtures/contract-status-fixtures";
import { observedRun } from "../fixtures/stop-check-runners";

const SURFACE = surface("payload");
const REPORT = ".loom/completion-reports/acceptance.junit.xml";
const NAME = "AS-001: one valid call wins";

function graph(): TaskGraph {
  const manifest = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2, kind: "loom-verification-manifest", checks: [],
    acceptanceRunner: { executable: "vitest", args: ["run", "{files}"], cwd: ".", timeoutMs: 60_000, report: { kind: "required-file", path: REPORT } },
  })));
  if (!manifest.ok) throw new Error(manifest.error.errors.join("; "));
  return {
    current_phase: "execute", phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: "plan.md", wave_gates: {},
    tasks: [task("T1", 1, [SURFACE.types, SURFACE.acceptance]), task("T2", 2, ["src/payload.ts"], ["AS-001"])],
    acceptance_contracts: [contract({
      id: "CT-1", surface: SURFACE, anchors: ["AS-001"],
      freeze: { state: "frozen", wave: 1, paths: frozenPaths(SURFACE, "a"), roster: [{ file: SURFACE.acceptance, name: NAME, anchors: ["AS-001"] }] as never },
    })],
    verification_manifest: manifest.value,
  };
}

const failingReport = new TextEncoder().encode(
  `<testsuites><testsuite name="s" tests="1"><testcase classname="${SURFACE.acceptance}" name="${NAME}">` +
  `<failure type="AssertionError"/></testcase></testsuite></testsuites>`);

const root = (() => {
  const parsed = parseCanonicalRepositoryRoot(canonicalTempDir("loom-pi-stop-check-"));
  if (!parsed.ok) throw new Error("root fixture");
  return parsed.value;
})();

/** The report-only ports, with a runner that reports the owed testcase failing. */
function failingPorts(): StopCheckShellPorts & { runs: number } {
  const value = {
    ...REPORT_ONLY_STOP_CHECK_PORTS,
    runs: 0,
    repositoryRoot: () => ({ ok: true as const, root }),
    acquireRunner: () => ({ kind: "acquired" as const, release: () => null }),
    readReport: () => failingReport,
    runCheck: async (check) => {
      value.runs++;
      return observedRun(check, failingReport, { ending: { exitCode: 1, timedOut: false, signal: null } });
    },
  } satisfies StopCheckShellPorts & { runs: number };
  return value;
}

/** The child's epoch: read, with no writes, so no file changed. */
const NO_WRITES: LedgerObservation = { kind: "read", events: [] };

const manager = (load: () => TaskGraph) => ({ load, getPath: () => "/repo/.pi/state/active_task_graph.json" });

afterEach(() => vi.restoreAllMocks());

describe("Pi reportImplementationStopChecks", () => {
  it("prints a failing owed testcase as one report-only line and resolves, never blocking", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const ports = failingPorts();
    const note = await reportImplementationStopChecks(manager(graph), "T2", NO_WRITES, ports);
    expect(note?.taskId).toBe("T2");
    expect(note?.message).toMatch(/^stop checks \(report-only on Pi; the agent has already ended\): T2\n/);
    expect(note?.message).toContain(NAME);
    expect(stderr).toHaveBeenCalledWith(`loom(pi): ${note?.message}\n`);
    expect(ports.runs).toBe(1);
  });

  it("runs nothing for a result with no Task", async () => {
    const ports = failingPorts();
    expect(await reportImplementationStopChecks(manager(graph), null, NO_WRITES, ports)).toBeNull();
    expect(ports.runs).toBe(0);
  });

  it("turns an unloadable graph into a note instead of a thrown processing error", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const note = await reportImplementationStopChecks(manager(() => { throw new Error("state file is corrupt"); }), "T2", NO_WRITES, failingPorts());
    expect(note?.message).toContain("crashed and did not decide: state file is corrupt");
  });

  it("keeps no block count, so a repeated failure is reported every time", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const ports = failingPorts();
    for (let stop = 0; stop < 5; stop++) {
      expect((await reportImplementationStopChecks(manager(graph), "T2", NO_WRITES, ports))?.message).toContain("report-only on Pi");
    }
  });
});

describe("the parent model sees each Pi stop-check note (#121)", () => {
  it("sends the bare report line to an injected operator sink instead of stderr", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const lines: string[] = [];
    const note = await reportImplementationStopChecks(manager(graph), "T2", NO_WRITES, failingPorts(), (line) => lines.push(line));
    expect(lines).toEqual([note?.message]);
    expect(stderr).not.toHaveBeenCalled();
  });

  const note = { taskId: "T2", message: "stop checks (report-only on Pi; the agent has already ended): T2\n- failing" };
  const original = { content: [{ type: "text" as const, text: "child output" }] };

  it("appends the notes to the batch's own result, leaving isError as Pi reported it", () => {
    expect(piStopResponse(original, [], [note])).toEqual({
      content: [{ type: "text", text: "child output" }, { type: "text", text: `${STOP_CHECK_NOTES_HEADING}\n- T2: stop checks (report-only on Pi; the agent has already ended): T2\n  - failing` }],
    });
  });

  it("keeps the notes after the processing errors that replace the result", () => {
    const response = piStopResponse(original, ["settlement refused"], [note]);
    expect(response).toMatchObject({ isError: true });
    expect(response?.content.map((item) => (item as { text: string }).text)).toEqual([
      "Loom Pi subagent evidence processing failed:\n- settlement refused",
      expect.stringContaining(STOP_CHECK_NOTES_HEADING),
    ]);
  });

  it("leaves the result untouched with neither", () => {
    expect(piStopResponse(original, [], [])).toBeUndefined();
  });
});
