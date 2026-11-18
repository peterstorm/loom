/**
 * The `helper orchestration add-task` and `withdraw-task` shells (ADR-0086):
 * route traits, the quiescence protocol, a committed change the loader
 * accepts, and refusals that leave the State File untouched. The decisions
 * themselves are pinned in tests/core/task-addition.test.ts.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAddTaskOperation, createWithdrawTaskOperation } from "../../../src/handlers/helpers/task-addition-operations";
import { ORCHESTRATION_OPERATIONS } from "../../../src/handlers/helpers/orchestration-operations";
import { orchestrationHandler } from "../../../src/handlers/helpers/orchestration";
import { piRuntimeHandshakeRequired, routeConsumesStdin } from "../../../src/handler-routes";
import { parseTaskGraph } from "../../../src/state-file-wire";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { sealedWaveGraph } from "../../fixtures/sealed-wave";
import { appearsUnderTheLock } from "../../fixtures/subagent-activity";

const cleanup: string[] = [];
let previousStatePath: string | undefined;
afterEach(() => {
  if (previousStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousStatePath;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function installState(): string {
  previousStatePath = process.env.LOOM_STATE_PATH;
  const root = canonicalTempDir("loom-add-task-");
  cleanup.push(root);
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  writeFileSync(statePath, JSON.stringify(sealedWaveGraph()));
  process.env.LOOM_STATE_PATH = statePath;
  return statePath;
}

const ARGS = [
  "--sealed-file", "src/serve.ts", "--before", "T3",
  "--description", "Stop re-parsing selected leads", "--reason", "T3's budget test fails on src/serve.ts",
] as const;
const quiet = () => false;
const loaded = (statePath: string) => parseTaskGraph(JSON.parse(readFileSync(statePath, "utf8")) as unknown);

describe("add-task and withdraw-task route traits", () => {
  it.each(["add-task", "withdraw-task"] as const)("%s takes only flags, requires the Pi runtime handshake and is parent-only", (operation) => {
    expect(ORCHESTRATION_OPERATIONS[operation]).toEqual({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" });
    expect(routeConsumesStdin("helper", "orchestration", [operation, ...ARGS])).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "orchestration", [operation, ...ARGS])).toBe(true);
  });

  it("no longer routes the retired Forward Fix operations", () => {
    expect(Object.keys(ORCHESTRATION_OPERATIONS)).not.toContain("add-forward-fix");
    expect(Object.keys(ORCHESTRATION_OPERATIONS)).not.toContain("withdraw-forward-fix");
  });
});

describe("add-task shell", () => {
  it("commits the Task, its edge and its edit, and the loader accepts the result", async () => {
    const statePath = installState();
    expect(await createAddTaskOperation(quiet)([...ARGS])).toEqual({ kind: "allow" });
    const graph = loaded(statePath);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.value.tasks.map(({ id, wave, status, depends_on }) => [id, wave, status, depends_on])).toEqual([
      ["T1", 1, "completed", []], ["T2", 1, "completed", []], ["T3", 2, "pending", ["T5"]], ["T4", 2, "pending", []], ["T5", 2, "pending", []],
    ]);
    expect(graph.value.wave_plan_edits).toEqual([{
      schemaVersion: 1, kind: "task-added", wave: 2, taskId: "T5", files: ["src/serve.ts"], sealed: ["src/serve.ts"],
      dependsOn: [], dependents: ["T3"], reason: "T3's budget test fails on src/serve.ts", abandonedRunId: null,
    }]);
  });

  it("replays an identical request without writing", async () => {
    const statePath = installState();
    await createAddTaskOperation(quiet)([...ARGS]);
    const after = readFileSync(statePath, "utf8");
    expect(await createAddTaskOperation(quiet)([...ARGS])).toEqual({ kind: "allow" });
    expect(readFileSync(statePath, "utf8")).toBe(after);
  });

  it("refuses malformed arguments before reading any graph", async () => {
    const result = await createAddTaskOperation(quiet)(["--description", "d", "--reason", "r"]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("add-task: name at least one --file or --sealed-file") });
  });

  it("refuses without writing while a subagent is active", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const result = await createAddTaskOperation(() => true)([...ARGS]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("Adding a Task refused while a subagent is active") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("re-checks for a subagent under the lock and refuses without writing when one appeared", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const { probe, observations } = appearsUnderTheLock();
    const result = await createAddTaskOperation(probe)([...ARGS]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("became active before adding a Task could commit") });
    expect(observations()).toBe(2);
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses a precondition without writing", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const result = await createAddTaskOperation(quiet)(["--file", "src/serve.ts", "--description", "d", "--reason", "r"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("add-task refused without changing state (path-not-addable): src/serve.ts belongs to T1"),
    });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("reports a non-refusal failure as a failed operation, never as a refusal", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    let calls = 0;
    // Quiet before the lock; the probe then fails under it, which is no refusal.
    const result = await createAddTaskOperation(() => {
      calls += 1;
      if (calls > 1) throw new Error("ledger unreadable");
      return false;
    })([...ARGS]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("add-task failed;") });
    if (result.kind === "error") {
      expect(result.message).toContain("ledger unreadable");
      expect(result.message).not.toContain("refused without changing state");
    }
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });
});

describe("withdraw-task", () => {
  const WITHDRAW = ["--task", "T5", "--reason", "the fix belongs in T4"] as const;
  const dispatch = (args: readonly string[]) => orchestrationHandler(() => {
    throw new Error("add-task and withdraw-task advance no program and need no emission");
  })("", [...args]);

  /** A State File holding a committed, never-dispatched added Task T5, and its bytes. */
  const installAdded = async (): Promise<Readonly<{ statePath: string; before: string }>> => {
    const statePath = installState();
    expect(await createAddTaskOperation(quiet)([...ARGS])).toEqual({ kind: "allow" });
    return { statePath, before: readFileSync(statePath, "utf8") };
  };

  it("adds and withdraws through the dispatcher, names the released Tasks, and the loader accepts the result", async () => {
    const statePath = installState();
    expect(await dispatch(["add-task", ...ARGS])).toEqual({ kind: "allow" });
    const written: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      expect(await dispatch(["withdraw-task", ...WITHDRAW])).toEqual({ kind: "allow" });
    } finally {
      process.stdout.write = write;
    }
    expect(written.join("")).toContain("Wave 2: T5 withdrawn; T3 no longer waits for it.");
    const graph = loaded(statePath);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.value.tasks.some(({ id }) => id === "T5")).toBe(false);
    expect(graph.value.tasks.find(({ id }) => id === "T3")?.depends_on).toEqual([]);
    expect(graph.value.wave_plan_edits?.map(({ kind, taskId }) => [kind, taskId])).toEqual([["task-added", "T5"], ["task-withdrawn", "T5"]]);
  });

  it("refuses a Task add-task did not append, without writing", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const result = await createWithdrawTaskOperation(quiet)(["--task", "T4", "--reason", "r"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("withdraw-task refused without changing state (not-an-added-task)"),
    });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("replays a committed withdrawal without writing", async () => {
    const { statePath } = await installAdded();
    expect(await createWithdrawTaskOperation(quiet)([...WITHDRAW])).toEqual({ kind: "allow" });
    const after = readFileSync(statePath, "utf8");
    expect(await createWithdrawTaskOperation(quiet)([...WITHDRAW])).toEqual({ kind: "allow" });
    expect(readFileSync(statePath, "utf8")).toBe(after);
  });

  it("refuses malformed arguments before reading any graph", async () => {
    const result = await createWithdrawTaskOperation(quiet)(["--task", "T5"]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("withdraw-task: --reason must say why") });
  });

  it("reports a missing task graph", async () => {
    const statePath = installState();
    rmSync(statePath);
    const result = await createWithdrawTaskOperation(quiet)([...WITHDRAW]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("withdraw-task: No task graph at") });
  });

  it("refuses without writing while a subagent is active", async () => {
    const { statePath, before } = await installAdded();
    const result = await createWithdrawTaskOperation(() => true)([...WITHDRAW]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("Withdrawing a Task refused while a subagent is active") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("re-checks for a subagent under the lock and refuses without writing when one appeared", async () => {
    const { statePath, before } = await installAdded();
    const { probe, observations } = appearsUnderTheLock();
    const result = await createWithdrawTaskOperation(probe)([...WITHDRAW]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("refused without changing state (subagent-active): A subagent became active before withdrawing a Task could commit"),
    });
    expect(observations()).toBe(2);
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });
});
