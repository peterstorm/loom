/**
 * SubagentStop wiring of regression attribution (ADR-0080): the handler
 * builds the settling Task's regression scope from the TaskGraph roster, so a
 * trusted failure only in an unsettled sibling's test file lands as this
 * Task's pass, and the same failure stands once that sibling has settled.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { failing, passing, report } from "../../fixtures/red-then-green-status-fixtures";
import { runUpdateTaskStatus } from "../../../src/handlers/subagent-stop/update-task-status";
import { SUBAGENT_DIR } from "../../../src/config";
import { parseEpoch, type EvidenceRecord } from "../../../src/machine";
import { AGENT_COMMAND_ORIGIN } from "../../../src/machine/types";
import type { TaskStatus } from "../../../src/types";

const OWN_TEST = "tests/own.test.ts";
const SIBLING_TEST = "tests/sibling.test.ts";
const run = `regression-scope-${process.pid}-${Date.now()}`;
const originalCwd = process.cwd();
let cleanup: string[] = [];

beforeEach(() => {
  const cwd = canonicalTempDir("loom-regression-scope-");
  cleanup.push(cwd);
  process.chdir(cwd);
  vi.stubEnv("LOOM_STATE_PATH", join(cwd, "active_task_graph.json"));
  vi.stubEnv("CLAUDE_PROJECT_DIR", cwd);
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(cwd, "claude-config"));
  vi.stubEnv("LOOM_ORCHESTRATION_RUNS_ROOT", undefined);
  vi.stubEnv("LOOM_ORCHESTRATION_RUN_DIR", undefined);
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
  cleanup = [];
});

/** T1 settles; T2 is its Wave sibling declaring the failing test file. */
function writeState(session: string, siblingStatus: TaskStatus): string {
  const dir = process.cwd();
  const statePath = join(dir, "active_task_graph.json");
  const task = (id: string, status: TaskStatus, file_list: readonly string[]) => ({
    id, description: "impl", agent: "code-implementer-agent", wave: 1, status, depends_on: [],
    new_tests_required: false, file_list,
  });
  writeFileSync(statePath, JSON.stringify({
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: ["T1"],
    tasks: [task("T1", "implemented", [OWN_TEST]), task("T2", siblingStatus, [SIBLING_TEST])],
    wave_gates: { "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false } },
  }));
  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  const pointer = `${SUBAGENT_DIR}/${session}.task_graph`;
  writeFileSync(pointer, statePath);
  cleanup.push(pointer);
  return statePath;
}

async function settle(siblingStatus: TaskStatus) {
  const session = `${run}-${siblingStatus}`;
  const statePath = writeState(session, siblingStatus);
  const snapshot: readonly EvidenceRecord[] = [{
    epoch: parseEpoch("a-1:code-implementer-agent")!,
    event: {
      kind: "TestRun",
      origin: AGENT_COMMAND_ORIGIN,
      command: "npm test",
      exit: 1,
      report: report([failing(SIBLING_TEST), passing(OWN_TEST)]),
    },
  }];
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const result = await runUpdateTaskStatus(
    JSON.stringify({ session_id: session, agent_id: "a-1", agent_type: "code-implementer-agent" }),
    [],
    { kind: "snapshot", events: snapshot },
  );
  expect(result.kind).toBe("passthrough");
  return JSON.parse(readFileSync(statePath, "utf-8")).tasks[0];
}

describe("SubagentStop regression scope", () => {
  it("lands a failure only in an unsettled sibling's test file as this Task's trusted pass, naming the sibling", async () => {
    const task = await settle("pending");
    expect(task.test_result).toEqual({ verdict: "trusted-pass" });
    expect(task.test_evidence).toContain(`failures attributed to unsettled Tasks: ${SIBLING_TEST} (T2)`);
  }, 30000);

  it("keeps the same failure on this Task once the sibling has settled", async () => {
    const task = await settle("implemented");
    expect(task.test_result).toEqual({ verdict: "trusted-fail" });
    expect(task.test_evidence).toContain("ledger: exit 1");
  }, 30000);
});
