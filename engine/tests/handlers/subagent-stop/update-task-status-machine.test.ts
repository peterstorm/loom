/**
 * Round-10 Fix 7 + gap 17, over exact Claude implementation attempts:
 * - machine-bound agents don't self-report completion: unmet terminal
 *   requirements (missingRequirements over the epoch fold) cap a
 *   trusted-pass at untrusted, labeled "machine-incomplete: <reqs>"
 * - a stop that carries no sidecar while attempts execute cannot name the
 *   attempt it settles: it preserves every reservation and touches no Task
 * - an observation the locked settlement cannot make (unsafe modified paths,
 *   new-test collection) settles a non-consuming infrastructure receipt,
 *   releases the reservation and resets review
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { runUpdateTaskStatus } from "../../../src/handlers/subagent-stop/update-task-status";
import { capVerdictForMachineCompletion } from "../../../src/core/implementation-evidence";
import { SUBAGENT_DIR } from "../../../src/config";
import type { EvidenceRecord, Requirement } from "../../../src/machine";
import { reportSummary } from "../../machine/report-summary";
import { executingGraphFixture, graphFixture, taskFixture } from "../../fixtures/task-lifecycle";
import {
  ARMED_ARTIFACT,
  ARMED_EPOCH,
  REGRESSION_ONLY,
  armedClaudeImplementation,
  writesTranscript,
} from "../../fixtures/claude-implementation-attempt";
import { AGENT_COMMAND_ORIGIN } from "../../../src/machine/types";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const run = `uts-machine-${process.pid}-${Date.now()}`;
const sid = (name: string) => `${run}-${name}`;

let dirs: string[] = [];
let sessionFiles: string[] = [];
const disposals: (() => void)[] = [];

function tempDir(): string {
  const dir = canonicalTempDir("loom-uts-machine-");
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  for (const f of sessionFiles) rmSync(f, { recursive: true, force: true });
  sessionFiles = [];
  for (const dispose of disposals.splice(0)) dispose();
  delete process.env.LOOM_MACHINES_DIR;
  vi.restoreAllMocks();
});

function pointSessionAt(session: string, statePath: string): void {
  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  const pointer = `${SUBAGENT_DIR}/${session}.task_graph`;
  writeFileSync(pointer, statePath);
  sessionFiles.push(pointer);
}

/** A machine whose terminal phase demands TWO trusted passes — one trusted
 *  pass then resolves trusted-pass while missingRequirements stays non-empty,
 *  exercising the cap. */
function writeStrictMachine(): void {
  const machines = tempDir();
  writeFileSync(join(machines, "code-implementer-agent.machine.json"), JSON.stringify({
    agent: "code-implementer-agent",
    enforcedTools: ["Edit", "Write", "MultiEdit"],
    phases: [
      { id: "work", allowedTools: ["Edit", "Write", "MultiEdit"], advance: { event: "TestRunPassed", min: 2 } },
      { id: "done", terminal: true, allowedTools: ["Edit", "Write", "MultiEdit"], requires: [{ event: "TestRunPassed", min: 2 }] },
    ],
  }));
  process.env.LOOM_MACHINES_DIR = machines;
}

const stopInput = (s: string) =>
  JSON.stringify({ session_id: s, agent_id: "a-1", agent_type: "code-implementer-agent" });

describe("capVerdictForMachineCompletion (pure)", () => {
  const missing: Requirement[] = [{ event: "TestRunPassed", min: 2 }];
  const trustedPass = { result: { verdict: "trusted-pass" as const }, evidence: "ledger: exit 0" };

  it("caps a trusted-pass at untrusted with a machine-incomplete label naming the requirements", () => {
    const capped = capVerdictForMachineCompletion(trustedPass, missing);
    expect(capped.result).toEqual({
      verdict: "untrusted",
      passed: true,
      label: "machine-incomplete: TestRunPassed ≥ 2", provenance: "unverified" as const,
    });
    expect(capped.evidence).toContain("machine-incomplete: TestRunPassed ≥ 2");
    expect(capped.evidence).toContain("ledger: exit 0");
  });

  it("no missing requirements → resolution untouched", () => {
    expect(capVerdictForMachineCompletion(trustedPass, [])).toBe(trustedPass);
  });

  it("a trusted-fail is ground truth of non-completion — never rewritten", () => {
    const fail = { result: { verdict: "trusted-fail" as const }, evidence: "ledger: exit 1" };
    expect(capVerdictForMachineCompletion(fail, missing)).toBe(fail);
  });

  it("untrusted resolutions are already at the floor — untouched", () => {
    const untrusted = {
      result: { verdict: "untrusted" as const, passed: true, label: "transcript-regex (fallback)", provenance: "unverified" as const },
      evidence: "vitest: Tests 5 passed",
    };
    expect(capVerdictForMachineCompletion(untrusted, missing)).toBe(untrusted);
  });
});

/** Arms T1, changes the declared artifact as its transcript says, and stops the Agent. */
async function stopArmedImplementation(label: string, events: readonly EvidenceRecord[]) {
  const armed = await armedClaudeImplementation({ label, verificationPolicy: REGRESSION_ONLY });
  disposals.push(armed.dispose);
  writeFileSync(join(armed.root, ARMED_ARTIFACT), "export const value = 2;\n");
  writeFileSync(armed.transcript, writesTranscript("Changed the artifact.", [ARMED_ARTIFACT]));
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const result = await runUpdateTaskStatus(armed.stopInput, [], { kind: "snapshot", events }, armed.observation);
  const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
  stderrSpy.mockRestore();
  return { armed, result, stderr, state: JSON.parse(readFileSync(armed.statePath, "utf-8")) };
}

describe("machine terminal requirements gate the persisted verdict (Fix 7)", () => {
  const epoch = ARMED_EPOCH;
  const pass = { kind: "TestRun" as const, origin: AGENT_COMMAND_ORIGIN, command: "npm test", exit: 0, report: reportSummary(5, 0) };

  it("a trusted-pass with unmet requirements lands as untrusted machine-incomplete", async () => {
    writeStrictMachine();
    // One trusted pass — enough for resolveTestEvidence's trusted-pass, NOT
    // enough for the strict machine's TestRunPassed ≥ 2 terminal requirement.
    const { result, stderr, state } = await stopArmedImplementation("incomplete", [{ epoch, event: pass }]);

    expect(result.kind, JSON.stringify(result)).toBe("passthrough");
    expect(stderr).toContain("unmet terminal requirements");
    expect(state.tasks[0].status).toBe("pending");
    expect(state.tasks[0].proof.state).toBe("failed");
    expect(state.tasks[0].test_result).toEqual({
      verdict: "untrusted",
      passed: true,
      label: "machine-incomplete: TestRunPassed ≥ 2", provenance: "unverified" as const,
    });
  }, 30000);

  it("control: requirements met → the trusted-pass persists untouched", async () => {
    writeStrictMachine();
    const { result, state } = await stopArmedImplementation("complete", [{ epoch, event: pass }, { epoch, event: pass }]);

    expect(result.kind, JSON.stringify(result)).toBe("passthrough");
    expect(state.tasks[0].test_result).toEqual({ verdict: "trusted-pass" });
    expect(state.tasks[0].status).toBe("implemented");
  }, 30000);
});

describe("locked implementation settlement failures", () => {
  it("settles an infrastructure receipt and releases execution when modified-path evidence is unsafe", async () => {
    const armed = await armedClaudeImplementation({ label: "unsafe-path", verificationPolicy: REGRESSION_ONLY });
    disposals.push(armed.dispose);
    writeFileSync(armed.transcript, writesTranscript("Retry finished.", ["../outside.ts"]));

    const result = await runUpdateTaskStatus(armed.stopInput, [], { kind: "snapshot", events: [] }, armed.observation);

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("unsafe modified-file evidence for T1"),
    });
    const persisted = JSON.parse(readFileSync(armed.statePath, "utf-8"));
    expect(persisted.tasks[0]).toMatchObject({ status: "pending", revalidation_required: true });
    expect(persisted.tasks[0].active_implementation_attempt).toBeUndefined();
    expect(persisted.tasks[0].implementation_attempt_history).toContainEqual(expect.objectContaining({
      transition: "infrastructure-blocked",
      consumesSemanticAttempt: false,
    }));
    expect(persisted.executing_tasks).toEqual([]);
  }, 30000);

  it("settles an infrastructure receipt, releases execution and resets review when new-test collection fails", async () => {
    const armed = await armedClaudeImplementation({
      label: "new-test-unavailable",
      verificationPolicy: {
        regression: { kind: "waived", reason: "documentation-only" },
        newTests: { kind: "required" },
      },
      seed: (graph) => ({
        ...graph,
        tasks: graph.tasks.map((task) => ({ ...task, review_status: "passed" as const })),
      }),
    });
    disposals.push(armed.dispose);
    // A start revision Git cannot resolve: the new-test diff cannot be collected.
    const registered = JSON.parse(readFileSync(armed.statePath, "utf-8"));
    chmodSync(armed.statePath, 0o644);
    writeFileSync(armed.statePath, JSON.stringify({
      ...registered,
      tasks: registered.tasks.map((task: Record<string, unknown>) => ({ ...task, start_sha: "not-a-git-revision" })),
    }));
    chmodSync(armed.statePath, 0o444);
    writeFileSync(join(armed.root, ARMED_ARTIFACT), "export const value = 2;\n");
    writeFileSync(armed.transcript, writesTranscript("Changed the artifact.", [ARMED_ARTIFACT]));

    const result = await runUpdateTaskStatus(armed.stopInput, [], { kind: "snapshot", events: [] }, armed.observation);

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("T1 completion infrastructure unavailable"),
    });
    const persisted = JSON.parse(readFileSync(armed.statePath, "utf-8"));
    expect(persisted.tasks[0]).toMatchObject({ status: "pending", revalidation_required: true, review_status: "pending" });
    expect(persisted.tasks[0].failure_reason).toContain("new-test observation unavailable");
    expect(persisted.tasks[0].active_implementation_attempt).toBeUndefined();
    expect(persisted.tasks[0].implementation_attempt_history).toContainEqual(expect.objectContaining({
      transition: "infrastructure-blocked",
      consumesSemanticAttempt: false,
    }));
    expect(persisted.executing_tasks).toEqual([]);
  }, 30000);
});

describe("a stop without its sidecar while attempts execute (gap 17)", () => {
  it("errors, preserves every reservation and touches no Task", async () => {
    const s = sid("unbound");
    const dir = tempDir();
    const statePath = join(dir, "active_task_graph.json");
    const graph = executingGraphFixture(graphFixture([
      taskFixture({ id: "T1", description: "impl", agent: "code-implementer-agent", wave: 1, depends_on: [] }),
      taskFixture({ id: "T2", description: "impl", agent: "code-implementer-agent", wave: 1, depends_on: [] }),
    ]), ["T1", "T2"]);
    writeFileSync(statePath, JSON.stringify(graph));
    pointSessionAt(s, statePath);
    const before = readFileSync(statePath);

    // No sidecar observation: the stop cannot name which attempt it settles.
    const result = await runUpdateTaskStatus(stopInput(s), [], { kind: "snapshot", events: [] });

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("execution authority was preserved"),
    });
    expect(readFileSync(statePath).equals(before)).toBe(true);
  }, 30000);
});
