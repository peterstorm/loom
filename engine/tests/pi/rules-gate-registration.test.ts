/**
 * registerRulesGate — the Pi shell around the shared core: which processes and
 * calls are gated, and the shape of the block it returns.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRulesGate } from "../../../pi/rules-gate";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

const handlersFor = (): Map<string, Handler> => {
  const handlers = new Map<string, Handler>();
  registerRulesGate({ on: (name: string, h: Handler) => void handlers.set(name, h) } as never);
  return handlers;
};

const ctx = (mode: string, sessionFile: string | undefined, entries: unknown[] = []) => ({
  mode, cwd: "/", hasUI: false,
  sessionManager: { getSessionFile: () => sessionFile, buildContextEntries: () => entries },
});
const editEvent = (path: string) => ({ type: "tool_call", toolName: "edit", toolCallId: "t1", input: { path } });

let dir: string;
let target: string;
const saved = { gate: process.env["LOOM_GATE"], modes: process.env["LOOM_GATE_MODES"] };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-gate-"));
  target = join(dir, "x.ts");
  writeFileSync(target, "export const x = 1;\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  for (const [k, v] of [["LOOM_GATE", saved.gate], ["LOOM_GATE_MODES", saved.modes]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("registerRulesGate", () => {
  it("blocks a code edit with empty context in an interactive session", async () => {
    const out = await handlersFor().get("tool_call")!(editEvent(target), ctx("tui", "/sess.jsonl")) as { block: boolean; reason: string };
    expect(out.block).toBe(true);
    expect(out.reason).toContain("architecture.md");
  });

  it("does not gate non-code targets or non-mutating tools", async () => {
    const h = handlersFor().get("tool_call")!;
    expect(await h(editEvent(join(dir, "n.md")), ctx("tui", "/s"))).toBeUndefined();
    expect(await h({ type: "tool_call", toolName: "read", toolCallId: "t", input: { path: target } }, ctx("tui", "/s"))).toBeUndefined();
  });

  it("exempts the subagent process signature (json mode, no session file)", async () => {
    expect(await handlersFor().get("tool_call")!(editEvent(target), ctx("json", undefined))).toBeUndefined();
  });

  it("gates json mode when it has a session file", async () => {
    expect(await handlersFor().get("tool_call")!(editEvent(target), ctx("json", "/s.jsonl"))).toMatchObject({ block: true });
  });

  it("honours LOOM_GATE=off and LOOM_GATE_MODES", async () => {
    const h = handlersFor().get("tool_call")!;
    process.env["LOOM_GATE"] = "off";
    expect(await h(editEvent(target), ctx("tui", "/s"))).toBeUndefined();
    delete process.env["LOOM_GATE"];
    process.env["LOOM_GATE_MODES"] = "rpc";
    expect(await h(editEvent(target), ctx("tui", "/s"))).toBeUndefined();
    expect(await h(editEvent(target), ctx("rpc", "/s"))).toMatchObject({ block: true });
  });

  it("gates a bash redirect into a code file", async () => {
    const out = await handlersFor().get("tool_call")!(
      { type: "tool_call", toolName: "bash", toolCallId: "t", input: { command: `echo x > ${target}` } }, ctx("tui", "/s"),
    ) as { reason: string };
    expect(out.reason).toContain("mutate code files via bash");
  });
});
