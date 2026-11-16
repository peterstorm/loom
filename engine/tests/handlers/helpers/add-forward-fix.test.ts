/**
 * The `helper orchestration add-forward-fix` shell: route traits, the
 * quiescence protocol, a committed fix the loader accepts, and refusals that
 * leave the State File untouched. The decision itself is pinned in
 * tests/core/forward-fix.test.ts.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAddForwardFixOperation } from "../../../src/handlers/helpers/add-forward-fix";
import { ORCHESTRATION_OPERATIONS } from "../../../src/handlers/helpers/orchestration-operations";
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
      message: expect.stringContaining("add-forward-fix refused without changing state: T4 has no failed implementation attempt"),
    });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });
});
