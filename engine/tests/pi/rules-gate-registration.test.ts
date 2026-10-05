/**
 * registerRulesGate — the Pi shell around the shared core: which processes and
 * calls are gated, and the shape of the block it returns.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
const saved = {
  gate: process.env["LOOM_GATE"], modes: process.env["LOOM_GATE_MODES"],
  rules: process.env["LOOM_RULES_DIR"], skills: process.env["LOOM_SKILLS_DIR"],
};

beforeAll(() => {
  dir = canonicalTempDir("pi-gate-");
  target = join(dir, "x.ts");
  writeFileSync(target, "export const x = 1;\n");
  mkdirSync(join(dir, "rules"));
  writeFileSync(join(dir, "rules", "architecture.md"), "a\nb\n");
  writeFileSync(join(dir, "rules", "typescript-patterns.md"), "t\n");
  for (const name of ["deepen", "distill"]) {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), `# ${name}\nbody\n`);
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  for (const [k, v] of [
    ["LOOM_GATE", saved.gate], ["LOOM_GATE_MODES", saved.modes],
    ["LOOM_RULES_DIR", saved.rules], ["LOOM_SKILLS_DIR", saved.skills],
  ] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

/** Pi context entries: a completed `read` per path, then the adherence marker. */
const readsThenMarker = (paths: readonly string[], limit?: number): unknown[] => [
  ...paths.flatMap((path, i) => [
    { type: "message", id: `a${i}`, message: { role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path, ...(limit ? { limit } : {}) } }] } },
    { type: "message", id: `r${i}`, message: { role: "toolResult", toolCallId: `c${i}`, isError: false } },
  ]),
  { type: "message", id: "mk", message: { role: "assistant", content: [{ type: "text", text: "LOOM: applying architecture.md — pure core" }] } },
];

describe("registerRulesGate", () => {
  it("blocks a code edit with empty context in an interactive session", async () => {
    const out = await handlersFor().get("tool_call")!(editEvent(target), ctx("tui", "/sess.jsonl")) as { block: boolean; reason: string };
    expect(out.block).toBe(true);
    expect(out.reason).toContain("architecture.md");
  });

  // Pi has no Skill tool: before the SKILL.md path counted, no Pi agent could satisfy the gate.
  it("allows an edit once the rules, the skills' SKILL.md files, and the target were read in full", async () => {
    process.env["LOOM_RULES_DIR"] = join(dir, "rules");
    process.env["LOOM_SKILLS_DIR"] = join(dir, "skills");
    const entries = readsThenMarker([
      join(dir, "rules", "architecture.md"), join(dir, "rules", "typescript-patterns.md"),
      join(dir, "skills", "deepen", "SKILL.md"), join(dir, "skills", "distill", "SKILL.md"), target,
    ]);
    expect(await handlersFor().get("tool_call")!(editEvent(target), ctx("tui", "/s", entries))).toBeUndefined();
  });

  it("blocks with Pi wording — the SKILL.md read and /skill:, never the Skill tool", async () => {
    process.env["LOOM_RULES_DIR"] = join(dir, "rules");
    process.env["LOOM_SKILLS_DIR"] = join(dir, "skills");
    const skillFile = join(dir, "skills", "deepen", "SKILL.md");
    const partial = readsThenMarker([join(dir, "rules", "architecture.md"), skillFile], 1);
    const out = await handlersFor().get("tool_call")!(editEvent(target), ctx("tui", "/s", partial)) as { reason: string };
    expect(out.reason).toContain(`skill:deepen — read ${skillFile} in full (or ask the user to run /skill:deepen)`);
    expect(out.reason).not.toContain("Skill tool");
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
