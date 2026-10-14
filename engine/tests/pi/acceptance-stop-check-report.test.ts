/**
 * Pi runs the Acceptance Stop Check report-only, at the call site that
 * settles an implementation result: a failing owed testcase is one operator
 * line, never a block and never a processing error, and a result without a
 * Task runs nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportAcceptanceStopCheck } from "../../../pi/subagent-stop";
import {
  REPORT_ONLY_STOP_CHECK_PORTS,
  type StopCheckPorts,
} from "../../src/handlers/subagent-stop/acceptance-stop-check";
import { freezeVerificationManifest } from "../../src/core/verification-manifest";
import { sha256Bytes } from "../../src/core/digest";
import type { CompletionCheckRunnerResult } from "../../src/orchestration/completion-check-runner";
import type { TaskGraph } from "../../src/types";
import { parseCanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { contract, frozenPaths, surface, task } from "../fixtures/contract-status-fixtures";

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
function failingPorts(): StopCheckPorts & { runs: number } {
  const value = {
    ...REPORT_ONLY_STOP_CHECK_PORTS,
    runs: 0,
    repositoryRoot: () => ({ ok: true as const, root }),
    acquireRunner: () => ({ kind: "acquired" as const, release: () => null }),
    readReport: () => failingReport,
    runCheck: async (check) => {
      value.runs++;
      return {
        ok: true,
        value: {
          checkResult: { checkId: check.checkId, scope: "wave", outcome: { kind: "observed", exitCode: 1, timedOut: false, signal: null,
            report: { kind: "produced", path: REPORT, digest: sha256Bytes(failingReport), byteLength: failingReport.byteLength } } },
          diagnostics: { stdoutTail: "", stderrTail: "", stdoutTruncated: false, stderrTruncated: false },
        },
      } as CompletionCheckRunnerResult;
    },
  } satisfies StopCheckPorts & { runs: number };
  return value;
}

const manager = (load: () => TaskGraph) => ({ load, getPath: () => "/repo/.pi/state/active_task_graph.json" });

afterEach(() => vi.restoreAllMocks());

describe("Pi reportAcceptanceStopCheck", () => {
  it("prints a failing owed testcase as one report-only line and resolves, never blocking", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const ports = failingPorts();
    const line = await reportAcceptanceStopCheck(manager(graph), "T2", ports);
    expect(line).toMatch(/^loom\(pi\): acceptance stop check \(report-only on Pi; the agent has already ended\): T2 /);
    expect(line).toContain(NAME);
    expect(stderr).toHaveBeenCalledWith(`${line}\n`);
    expect(ports.runs).toBe(1);
  });

  it("runs nothing for a result with no Task", async () => {
    const ports = failingPorts();
    expect(await reportAcceptanceStopCheck(manager(graph), null, ports)).toBeNull();
    expect(ports.runs).toBe(0);
  });

  it("turns an unloadable graph into a note instead of a thrown processing error", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const line = await reportAcceptanceStopCheck(manager(() => { throw new Error("state file is corrupt"); }), "T2", failingPorts());
    expect(line).toContain("crashed and did not decide: state file is corrupt");
  });

  it("keeps no block count, so a repeated failure is reported every time", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const ports = failingPorts();
    for (let stop = 0; stop < 5; stop++) {
      expect(await reportAcceptanceStopCheck(manager(graph), "T2", ports)).toContain("report-only on Pi");
    }
  });
});
