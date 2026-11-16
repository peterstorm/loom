/**
 * The `helper orchestration add-forward-fix` and `withdraw-forward-fix`
 * shells: route traits, the quiescence protocol, a committed change the
 * loader accepts, and refusals that leave the State File untouched. The
 * decisions themselves are pinned in tests/core/forward-fix.test.ts.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAddForwardFixOperation, createWithdrawForwardFixOperation } from "../../../src/handlers/helpers/forward-fix-operations";
import { ORCHESTRATION_OPERATIONS } from "../../../src/handlers/helpers/orchestration-operations";
import { orchestrationHandler } from "../../../src/handlers/helpers/orchestration";
import { piRuntimeHandshakeRequired, routeConsumesStdin } from "../../../src/handler-routes";
import { parseTaskGraph } from "../../../src/state-file-wire";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { sealedWaveGraph } from "../../fixtures/forward-fix";
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
  const root = canonicalTempDir("loom-forward-fix-");
  cleanup.push(root);
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  writeFileSync(statePath, JSON.stringify(sealedWaveGraph()));
  process.env.LOOM_STATE_PATH = statePath;
  return statePath;
}

const ARGS = [
  "--wave", "2", "--hold", "T3", "--file", "src/serve.ts",
  "--description", "Stop re-parsing selected leads", "--reason", "T3's budget test fails on src/serve.ts",
] as const;
const quiet = () => false;

describe("add-forward-fix route traits", () => {
  it("takes only flags, requires the Pi runtime handshake and is parent-only, like every mutating operation", () => {
    expect(ORCHESTRATION_OPERATIONS["add-forward-fix"]).toEqual({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" });
    expect(routeConsumesStdin("helper", "orchestration", ["add-forward-fix", ...ARGS])).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "orchestration", ["add-forward-fix", ...ARGS])).toBe(true);
  });
});

describe("add-forward-fix shell", () => {
  it("commits the fix Task and its audit, and the loader accepts the result", async () => {
    const statePath = installState();
    expect(await createAddForwardFixOperation(quiet)([...ARGS])).toEqual({ kind: "allow" });
    const raw: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    const loaded = parseTaskGraph(raw);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.tasks.map(({ id, wave, status }) => [id, wave, status])).toEqual([
      ["T1", 1, "completed"], ["T2", 1, "completed"], ["T3", 2, "pending"], ["T4", 2, "pending"], ["T5", 2, "pending"],
    ]);
    expect(loaded.value.forward_fix_history).toEqual([{
      schemaVersion: 1, kind: "forward-fix-added", wave: 2, fixTaskId: "T5", heldTaskIds: ["T3"],
      sealedPaths: ["src/serve.ts"], reason: "T3's budget test fails on src/serve.ts", abandonedRunId: null,
    }]);
  });

  it("replays an identical request without writing", async () => {
    const statePath = installState();
    await createAddForwardFixOperation(quiet)([...ARGS]);
    const after = readFileSync(statePath, "utf8");
    expect(await createAddForwardFixOperation(quiet)([...ARGS])).toEqual({ kind: "allow" });
    expect(readFileSync(statePath, "utf8")).toBe(after);
  });

  it("refuses malformed arguments before reading any graph", async () => {
    const result = await createAddForwardFixOperation(quiet)(["--wave", "2", "--hold", "T3"]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("--file must name at least one path") });
  });

  it("refuses without writing while a subagent is active", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const result = await createAddForwardFixOperation(() => true)([...ARGS]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("Forward fix refused while a subagent is active") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("re-checks for a subagent under the lock and refuses without writing when one appeared", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const { probe, observations } = appearsUnderTheLock();
    const result = await createAddForwardFixOperation(probe)([...ARGS]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("became active before the forward fix could commit") });
    expect(observations()).toBe(2);
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses a precondition without writing", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const result = await createAddForwardFixOperation(quiet)(["--wave", "2", "--hold", "T4", "--file", "src/serve.ts", "--description", "d", "--reason", "r"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining(
        "add-forward-fix refused without changing state (no-failed-judgement): T4 has no failed implementation attempt",
      ),
    });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("reports a non-refusal failure as a failed operation, never as a refusal", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    let calls = 0;
    // Quiet before the lock; the probe then fails under it, which is no refusal.
    const result = await createAddForwardFixOperation(() => {
      calls += 1;
      if (calls > 1) throw new Error("ledger unreadable");
      return false;
    })([...ARGS]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("add-forward-fix failed;") });
    if (result.kind === "error") {
      expect(result.message).toContain("ledger unreadable");
      expect(result.message).not.toContain("refused without changing state");
    }
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });
});

describe("add-forward-fix through the orchestration dispatcher", () => {
  it("routes `helper orchestration add-forward-fix` to the operation", async () => {
    const statePath = installState();
    const result = await orchestrationHandler(() => {
      throw new Error("add-forward-fix advances no program and needs no emission");
    })("", ["add-forward-fix", ...ARGS]);
    expect(result).toEqual({ kind: "allow" });
    const loaded = parseTaskGraph(JSON.parse(readFileSync(statePath, "utf8")) as unknown);
    expect(loaded.ok && loaded.value.forward_fix_history?.map(({ fixTaskId }) => fixTaskId)).toEqual(["T5"]);
  });
});

describe("withdraw-forward-fix", () => {
  const WITHDRAW = ["--wave", "2", "--task", "T5", "--reason", "its text fails the brief"] as const;
  const dispatch = (args: readonly string[]) => orchestrationHandler(() => {
    throw new Error("withdraw-forward-fix advances no program and needs no emission");
  })("", [...args]);

  it("takes only flags, requires the Pi runtime handshake and is parent-only", () => {
    expect(ORCHESTRATION_OPERATIONS["withdraw-forward-fix"]).toEqual({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" });
    expect(routeConsumesStdin("helper", "orchestration", ["withdraw-forward-fix", ...WITHDRAW])).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "orchestration", ["withdraw-forward-fix", ...WITHDRAW])).toBe(true);
  });

  it("withdraws a never-dispatched fix through the dispatcher and the loader accepts the result", async () => {
    const statePath = installState();
    expect(await dispatch(["add-forward-fix", ...ARGS])).toEqual({ kind: "allow" });
    expect(await dispatch(["withdraw-forward-fix", ...WITHDRAW])).toEqual({ kind: "allow" });
    const loaded = parseTaskGraph(JSON.parse(readFileSync(statePath, "utf8")) as unknown);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.tasks.some(({ id }) => id === "T5")).toBe(false);
    expect(loaded.value.forward_fix_history).toEqual([]);
    expect(loaded.value.forward_fix_withdrawals?.map(({ audit }) => audit.fixTaskId)).toEqual(["T5"]);
  });

  it("refuses a Task that is no Forward Fix without writing", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const result = await createWithdrawForwardFixOperation(quiet)(["--wave", "2", "--task", "T4", "--reason", "r"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("withdraw-forward-fix refused without changing state (not-a-forward-fix)"),
    });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  /** A State File holding a committed, never-dispatched Forward Fix T5, and its bytes. */
  const installFix = async (): Promise<Readonly<{ statePath: string; before: string }>> => {
    const statePath = installState();
    expect(await createAddForwardFixOperation(quiet)([...ARGS])).toEqual({ kind: "allow" });
    return { statePath, before: readFileSync(statePath, "utf8") };
  };

  it("replays a committed withdrawal without writing", async () => {
    const { statePath } = await installFix();
    expect(await createWithdrawForwardFixOperation(quiet)([...WITHDRAW])).toEqual({ kind: "allow" });
    const after = readFileSync(statePath, "utf8");
    expect(await createWithdrawForwardFixOperation(quiet)([...WITHDRAW])).toEqual({ kind: "allow" });
    expect(readFileSync(statePath, "utf8")).toBe(after);
  });

  it("refuses malformed arguments before reading any graph", async () => {
    const result = await createWithdrawForwardFixOperation(quiet)(["--wave", "2", "--task", "T5"]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("withdraw-forward-fix: --reason must say why") });
  });

  it("reports a missing task graph", async () => {
    const statePath = installState();
    rmSync(statePath);
    const result = await createWithdrawForwardFixOperation(quiet)([...WITHDRAW]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("withdraw-forward-fix: No task graph at") });
  });

  it("refuses without writing while a subagent is active", async () => {
    const { statePath, before } = await installFix();
    const result = await createWithdrawForwardFixOperation(() => true)([...WITHDRAW]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("Forward fix withdrawal refused while a subagent is active") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("re-checks for a subagent under the lock and refuses without writing when one appeared", async () => {
    const { statePath, before } = await installFix();
    const { probe, observations } = appearsUnderTheLock();
    const result = await createWithdrawForwardFixOperation(probe)([...WITHDRAW]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("refused without changing state (subagent-active): A subagent became active before the forward fix withdrawal could commit"),
    });
    expect(observations()).toBe(2);
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("reports a non-refusal failure as a failed operation, never as a refusal", async () => {
    const { statePath, before } = await installFix();
    let calls = 0;
    const result = await createWithdrawForwardFixOperation(() => {
      calls += 1;
      if (calls > 1) throw new Error("ledger unreadable");
      return false;
    })([...WITHDRAW]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("withdraw-forward-fix failed;") });
    if (result.kind === "error") {
      expect(result.message).toContain("ledger unreadable");
      expect(result.message).not.toContain("refused without changing state");
    }
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });
});
