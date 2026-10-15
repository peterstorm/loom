import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import stopCheckPlan, { createStopCheckPlanHandler } from "../../../src/handlers/helpers/stop-check-plan";
import { renderStopCheckPlan } from "../../../src/core/acceptance-contract/stop-check-plan";
import { UNKNOWN_TASK_PREFIX, type RenderStopCheckPlanFn } from "../../../src/core/stop-check-plan-types";
import { WHITELISTED_HELPERS } from "../../../src/config";
import { KNOWN_HANDLERS, PI_RUNTIME_HANDSHAKE_ROUTES, piRuntimeHandshakeRequired } from "../../../src/handler-routes";
import { StateManager } from "../../../src/state-manager";
import type { HookResult, TaskGraph } from "../../../src/types";
import { gitProject, statePathIn, task, writeStateFile } from "../../fixtures/contract-status-fixtures";
import { frozenContract, frozenRunnerManifest, stopCheckGraph } from "../../fixtures/stop-check-plan-fixtures";

const REPO_ROOT = resolve(__dirname, "../../../..");
const CLI = "engine/src/cli.ts";

const LEDGER_TYPES = "engine/src/core/ledger-types.ts";
const LEDGER = "engine/tests/acceptance/ledger.acceptance.test.ts";
const DEBIT = "ledger > AS-001: a debit lowers the balance";

const cleanup: string[] = [];
let inheritedStatePath: string | undefined;
beforeEach(() => {
  inheritedStatePath = process.env.LOOM_STATE_PATH;
});
afterEach(() => {
  if (inheritedStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = inheritedStatePath;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const project = (): string => gitProject("loom-stop-check-plan-handler-", cleanup);

/** A graph whose T2 owes CT-1's debit testcase under a frozen runner: the check is on for T2. */
const onGraphJson = (): string => stopCheckGraph({
  tasks: [task("T1", 1, [LEDGER_TYPES, LEDGER]), task("T2", 2, ["engine/src/core/ledger.ts"], ["AS-001"])],
  contracts: [frozenContract({
    id: "CT-1",
    types: LEDGER_TYPES,
    files: [{ path: LEDGER, anchors: ["AS-001"] }],
    roster: [{ file: LEDGER, name: DEBIT, anchors: ["AS-001"] }],
  })],
  manifest: frozenRunnerManifest(),
}).json;

/** Writes raw State File text; returns its path and points LOOM_STATE_PATH at it. */
function stateFileText(text: string): string {
  const statePath = writeStateFile(project(), text);
  process.env.LOOM_STATE_PATH = statePath;
  return statePath;
}

type Captured = { readonly writes: string[]; readonly write: (text: string) => void };
const captured = (): Captured => {
  const writes: string[] = [];
  return { writes, write: (text) => { writes.push(text); } };
};

/** A renderer double that records every call and answers `rendering`. */
function recordingRender(rendering: ReturnType<RenderStopCheckPlanFn>): Readonly<{
  render: RenderStopCheckPlanFn;
  calls: Array<Readonly<{ graph: TaskGraph; taskId: string }>>;
}> {
  const calls: Array<Readonly<{ graph: TaskGraph; taskId: string }>> = [];
  return { calls, render: (graph, taskId) => { calls.push({ graph, taskId }); return rendering; } };
}

const RENDERED: ReturnType<RenderStopCheckPlanFn> = { kind: "rendered", lines: ["T2 (Wave 2): a", "  b"] };

const run = (sink: Captured, args: string[], render?: RenderStopCheckPlanFn): Promise<HookResult> =>
  createStopCheckPlanHandler(sink.write, render)("", args);

const errorMessage = (result: HookResult): string => {
  expect(result.kind).toBe("error");
  return result.kind === "error" ? result.message : "";
};

describe("stop-check-plan helper routing", () => {
  it("is routed only as a read-only helper: not whitelisted in the guard, no Pi runtime handshake", () => {
    expect(KNOWN_HANDLERS.helper?.has("stop-check-plan")).toBe(true);
    expect(WHITELISTED_HELPERS).not.toContain("stop-check-plan");
    expect(PI_RUNTIME_HANDSHAKE_ROUTES.has("helper/stop-check-plan")).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "stop-check-plan")).toBe(false);
  });

  it("exports a default handler bound to stdout", () => {
    expect(typeof stopCheckPlan).toBe("function");
  });
});

describe("stop-check-plan helper arguments", () => {
  it.each([
    ["no arguments", []],
    ["a valueless --task", ["--task"]],
  ])("refuses %s as a missing --task, before touching the TaskGraph or renderer", async (_label, args) => {
    stateFileText(onGraphJson());
    const sink = captured();
    const double = recordingRender(RENDERED);

    const message = errorMessage(await run(sink, args, double.render));

    expect(message).toContain("--task <task-id>");
    expect(double.calls).toEqual([]);
    expect(sink.writes).toEqual([]);
  });

  it.each([
    ["a trailing positional", ["--task", "T2", "extra"], "extra"],
    ["an unknown flag", ["--task", "T2", "--json"], "--json"],
    ["a leading positional", ["T2", "--task", "T2"], "T2"],
    ["a flag where the --task value belongs", ["--task", "--json"], "--json"],
    ["an empty --task value", ["--task", ""], "unconsumed argument(s): "],
  ])("refuses %s naming the unconsumed argument", async (_label, args, unconsumed) => {
    stateFileText(onGraphJson());
    const sink = captured();
    const double = recordingRender(RENDERED);

    const message = errorMessage(await run(sink, args, double.render));

    expect(message).toContain("unknown or unconsumed argument");
    expect(message).toContain(unconsumed);
    expect(double.calls).toEqual([]);
    expect(sink.writes).toEqual([]);
  });
});

describe("stop-check-plan helper load boundary", () => {
  it("AS-004: a missing TaskGraph is refused with the path it looked for and writes nothing", async () => {
    const statePath = statePathIn(project());
    process.env.LOOM_STATE_PATH = statePath;
    const sink = captured();
    const double = recordingRender(RENDERED);

    const result = await run(sink, ["--task", "T1"], double.render);

    expect(result).toEqual({ kind: "error", message: `No task graph at ${statePath}` });
    expect(double.calls).toEqual([]);
    expect(sink.writes).toEqual([]);
  });

  it("a corrupt TaskGraph is not treated as missing: the error carries the parser's message", async () => {
    const statePath = stateFileText("{ not json");
    const sink = captured();
    const double = recordingRender(RENDERED);

    const message = errorMessage(await run(sink, ["--task", "T1"], double.render));

    expect(message).toContain("Corrupt state file (invalid JSON)");
    expect(message).toContain(statePath);
    expect(message).not.toContain("No task graph");
    expect(double.calls).toEqual([]);
    expect(sink.writes).toEqual([]);
  });

  it("a graph the parser rejects surfaces the parser's error", async () => {
    stateFileText(JSON.stringify({ tasks: "not-a-list" }));
    const sink = captured();

    const message = errorMessage(await run(sink, ["--task", "T1"], recordingRender(RENDERED).render));

    expect(message).toContain("Corrupt state file");
    expect(sink.writes).toEqual([]);
  });

  it("a renderer throw is a defect and crashes rather than reading as a refusal", async () => {
    stateFileText(onGraphJson());
    const defect: RenderStopCheckPlanFn = () => { throw new Error("renderer defect"); };

    await expect(run(captured(), ["--task", "T2"], defect)).rejects.toThrow("renderer defect");
  });
});

describe("stop-check-plan helper rendering", () => {
  it("writes a rendered plan's lines, newline-terminated, and succeeds", async () => {
    stateFileText(onGraphJson());
    const sink = captured();
    const double = recordingRender(RENDERED);

    const result = await run(sink, ["--task", "T2"], double.render);

    expect(result).toEqual({ kind: "passthrough" });
    expect(sink.writes).toEqual(["T2 (Wave 2): a\n  b\n"]);
    expect(double.calls.map(({ taskId }) => taskId)).toEqual(["T2"]);
    expect(double.calls[0]!.graph.tasks.map(({ id }) => id)).toEqual(["T1", "T2"]);
  });

  it("AS-004: an unknown-task rendering is refused with the renderer's message and writes nothing", async () => {
    stateFileText(onGraphJson());
    const sink = captured();
    const message = `${UNKNOWN_TASK_PREFIX} T9 in the TaskGraph`;

    const result = await run(sink, ["--task", "T9"], recordingRender({ kind: "unknown-task", taskId: "T9", message }).render);

    expect(result).toEqual({ kind: "error", message });
    expect(sink.writes).toEqual([]);
  });

  it("AS-004: with the real renderer, an unknown Task id is refused naming the id", async () => {
    stateFileText(onGraphJson());
    const sink = captured();

    const result = await run(sink, ["--task", "T9"]);

    expect(result).toEqual({ kind: "error", message: `${UNKNOWN_TASK_PREFIX} T9 in the TaskGraph` });
    expect(sink.writes).toEqual([]);
  });

  it("FR-005: is read-only: the State File bytes and mtime are unchanged and no lock is left behind", async () => {
    const statePath = stateFileText(onGraphJson());
    const before = readFileSync(statePath);
    const mtimeBefore = statSync(statePath).mtimeMs;
    const entriesBefore = readdirSync(dirname(statePath)).sort();

    await run(captured(), ["--task", "T2"]);
    await run(captured(), ["--task", "T9"]);
    await run(captured(), ["--task", "T1"]);

    expect(readFileSync(statePath).equals(before)).toBe(true);
    expect(statSync(statePath).mtimeMs).toBe(mtimeBefore);
    expect(readdirSync(dirname(statePath)).sort()).toEqual(entriesBefore);
    expect(entriesBefore).toEqual(["active_task_graph.json"]);
  });
});

describe("stop-check-plan through the real CLI", () => {
  it("prints exactly the renderer's lines for an on-plan Task and exits 0", () => {
    const statePath = writeStateFile(project(), onGraphJson());
    const manager = StateManager.fromPath(statePath);
    if (manager === null) throw new Error("fixture State File was not written");
    const expected = renderStopCheckPlan(manager.load(), "T2");
    if (expected.kind !== "rendered") throw new Error("fixture Task T2 is unknown to the renderer");

    const result = spawnSync("bun", [CLI, "helper", "stop-check-plan", "--task", "T2"], {
      cwd: REPO_ROOT,
      env: { ...process.env, LOOM_STATE_PATH: statePath },
      input: "",
      encoding: "utf-8",
      timeout: 30_000,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${expected.lines.join("\n")}\n`);
    expect(result.status).toBe(0);
  });
});
