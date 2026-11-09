/**
 * Pi twin of guard-subagent-authority (ADR-0067 D6): active only in a process
 * carrying the explicit subagent environment marker (`pi/subagent-process.ts`),
 * judging bash through the same core and observed context as Claude Code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { piSubagentAuthorityDecision } from "../../../pi/subagent-authority-gate";
import {
  PI_PARENT_PID_ENV,
  PI_PARENT_SESSION_ENV,
  PI_SUBAGENT_ENV,
  childAgentEnvironment,
  currentPiProcessRole,
  markPiParentEnvironment,
  parentMarkerEntries,
  piProcessRole,
  type PiProcessRole,
} from "../../../pi/subagent-process";
import { spawnSync } from "node:child_process";

const AS_SUBAGENT: PiProcessRole = { kind: "subagent", parentSession: "parent-session" };
const AS_PARENT: PiProcessRole = { kind: "parent" };
import { runGuardSubagentAuthority } from "../../src/handlers/pre-tool-use/guard-subagent-authority";
import { registerSecurityAuditRun } from "../../src/orchestration/security-audit-run-registry";

let root: string;
let run: string;
let saved: string | undefined;

beforeEach(() => {
  root = canonicalTempDir("loom-pi-subagent-authority-");
  saved = process.env.LOOM_SUBAGENT_DIR;
  process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
  run = join(root, "audits", "run-1");
  mkdirSync(join(run, "agents", "h", "scratch"), { recursive: true });
  expect(registerSecurityAuditRun(run).ok).toBe(true);
});

afterEach(() => {
  if (saved === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

const ctx = (mode: string, sessionFile: string | undefined, cwd = "/repo") => ({
  mode, cwd, hasUI: false,
  sessionManager: { getSessionFile: () => sessionFile },
}) as never;
const SUBAGENT = () => ctx("json", undefined);
const bash = (command: unknown) => ({ toolName: "bash", input: { command } }) as never;

describe("which Pi process is a subagent — the explicit environment marker (G)", () => {
  const PID = 4242;
  it.each([
    ["no marker: a parent, whatever its launch flags (even headless json -p --no-session)", {}, "parent"],
    ["the explicit child marker", { [PI_SUBAGENT_ENV]: "1" }, "subagent"],
    ["a parent marker naming ANOTHER pid (launched from a Loom Pi session)", { [PI_PARENT_PID_ENV]: "77" }, "subagent"],
    ["a parent marker naming its OWN pid (the parent itself)", { [PI_PARENT_PID_ENV]: String(PID) }, "parent"],
    ["an empty parent marker", { [PI_PARENT_PID_ENV]: "" }, "parent"],
  ] as const)("%s", (_name, env, expected) => {
    expect(piProcessRole(env, PID).kind).toBe(expected);
  });

  it("a parent publishes its pid and session; a subagent publishes nothing", () => {
    expect(parentMarkerEntries({}, PID, "sess")).toEqual({ [PI_PARENT_PID_ENV]: String(PID), [PI_PARENT_SESSION_ENV]: "sess" });
    expect(parentMarkerEntries({ [PI_PARENT_PID_ENV]: String(PID) }, PID, null)).toEqual({ [PI_PARENT_PID_ENV]: String(PID) });
    expect(parentMarkerEntries({ [PI_PARENT_PID_ENV]: "77" }, PID, "sess")).toEqual({});
    expect(parentMarkerEntries({ [PI_SUBAGENT_ENV]: "1" }, PID, "sess")).toEqual({});
  });

  it("a child agent Loom spawns carries the explicit marker and its launching session", () => {
    const env = childAgentEnvironment({ PATH: "/bin", [PI_PARENT_PID_ENV]: String(PID), [PI_PARENT_SESSION_ENV]: "sess" }, null);
    expect(env).toMatchObject({ PATH: "/bin", [PI_SUBAGENT_ENV]: "1", [PI_PARENT_SESSION_ENV]: "sess" });
    expect(piProcessRole(env, PID)).toEqual({ kind: "subagent", parentSession: "sess" });
  });

  it("the json-mode launcher path: a process spawned with the parent's process.env is a subagent, the parent is not", () => {
    vi.stubEnv(PI_SUBAGENT_ENV, undefined);
    vi.stubEnv(PI_PARENT_PID_ENV, undefined);
    vi.stubEnv(PI_PARENT_SESSION_ENV, undefined);
    try {
      markPiParentEnvironment("parent-session");
      expect(currentPiProcessRole()).toEqual({ kind: "parent" });
      // The installed launcher spawns `pi --mode json -p --no-session` with { ...process.env }.
      const module = join(__dirname, "..", "..", "..", "pi", "subagent-process.ts");
      const child = spawnSync("bun", ["-e",
        `const m = await import(${JSON.stringify(module)}); console.log(JSON.stringify(m.currentPiProcessRole()));`],
      { encoding: "utf8", env: { ...process.env } });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ kind: "subagent", parentSession: "parent-session" });
      // A headless parent started WITHOUT the marker is a parent.
      const headless = spawnSync("bun", ["-e",
        `const m = await import(${JSON.stringify(module)}); console.log(JSON.stringify(m.currentPiProcessRole()));`],
      { encoding: "utf8", env: { PATH: process.env.PATH } });
      expect(JSON.parse(headless.stdout)).toEqual({ kind: "parent" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("piSubagentAuthorityDecision", () => {
  it("blocks a subagent's authority write operation", () => {
    const out = piSubagentAuthorityDecision(bash(`loom helper security-audit submit --out ${run}`), SUBAGENT(), AS_SUBAGENT);
    expect(out?.block).toBe(true);
    expect(out?.reason).toContain("guard-subagent-authority (ADR-0067 D6)");
  });

  it("blocks a subagent's write onto a registered run's authority file", () => {
    const out = piSubagentAuthorityDecision(bash(`echo x > ${run}/verdicts.json`), SUBAGENT(), AS_SUBAGENT);
    expect(out?.reason).toContain(`${run}/verdicts.json`);
  });

  it("resolves relative paths against the Pi cwd", () => {
    expect(piSubagentAuthorityDecision(bash("echo x > ledger.json"), ctx("json", undefined, run), AS_SUBAGENT)?.block).toBe(true);
  });

  it("allows a subagent's reads, read-only operations and scratch writes", () => {
    for (const command of [
      `cat ${run}/ledger.json`,
      `loom helper security-audit nonce --out ${run} --artifact agents/h/artifacts/x`,
      `echo x > ${run}/agents/h/scratch/notes.md`,
    ]) {
      expect(piSubagentAuthorityDecision(bash(command), SUBAGENT(), AS_SUBAGENT), command).toBeUndefined();
    }
  });

  it("never decides in the parent session", () => {
    for (const parent of [ctx("tui", "/s.jsonl"), ctx("json", "/s.jsonl"), ctx("rpc", "/s.jsonl")]) {
      expect(piSubagentAuthorityDecision(bash(`loom helper security-audit verify --out ${run}`), parent, AS_PARENT)).toBeUndefined();
    }
  });

  it("ignores tools other than bash", () => {
    expect(piSubagentAuthorityDecision({ toolName: "write", input: { path: `${run}/ledger.json` } } as never, SUBAGENT(), AS_SUBAGENT))
      .toBeUndefined();
  });

  it("fails closed on malformed bash input", () => {
    expect(piSubagentAuthorityDecision(bash(42), SUBAGENT(), AS_SUBAGENT)?.reason).toContain("malformed Pi bash input");
    expect(piSubagentAuthorityDecision({ toolName: "bash", input: null } as never, SUBAGENT(), AS_SUBAGENT)?.block).toBe(true);
  });


  it("an unreadable registry fails closed on authority-shaped paths", () => {
    const unreadable = (): readonly string[] => { throw new Error("damaged"); };
    expect(piSubagentAuthorityDecision(bash("echo x > /x/findings.json"), SUBAGENT(), AS_SUBAGENT, unreadable)?.reason)
      .toContain("registry is unreadable");
  });
});

describe("the Pi extension's tool_call chain", () => {
  type Handler = (event: unknown, context: unknown) => unknown;
  const extensionToolCall = async (): Promise<Handler> => {
    const extensionSpecifier = "../../../pi/extension.ts";
    const module = await import(/* @vite-ignore */ extensionSpecifier) as { default: (pi: unknown) => void };
    const handlers: Handler[] = [];
    module.default({
      on: (name: string, handler: Handler) => { if (name === "tool_call") handlers.push(handler); },
      registerCommand: () => undefined,
      registerTool: () => undefined,
    });
    expect(handlers).toHaveLength(1);
    return handlers[0]!;
  };
  const piCtx = (mode: string | undefined, sessionFile: string | undefined) => ({
    mode, cwd: "/repo", hasUI: false,
    sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad4a2", getSessionFile: () => sessionFile },
  });

  it("refuses a subagent process's authority write and lets the parent's through this gate", async () => {
    const toolCall = await extensionToolCall();
    const event = { toolName: "bash", toolCallId: "c1", input: { command: `loom helper security-audit verify --out ${run}` } };
    // The parent: no marker naming another process — even in headless json mode.
    const parent = await toolCall(event, piCtx("json", undefined)) as { reason?: string } | undefined;
    expect(parent?.reason ?? "").not.toContain("guard-subagent-authority");
    vi.stubEnv(PI_SUBAGENT_ENV, "1");
    try {
      expect(await toolCall(event, piCtx("tui", "/s.jsonl"))).toMatchObject({
        block: true,
        reason: expect.stringContaining("guard-subagent-authority (ADR-0067 D6)"),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a crash inside the gate blocks the call, naming the gate", async () => {
    const toolCall = await extensionToolCall();
    vi.stubEnv(PI_SUBAGENT_ENV, "1");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const hostile = { toolName: "bash", toolCallId: "c2", input: { get command(): string { throw new Error("boom"); } } };
      const out = await toolCall(hostile, piCtx("json", undefined)) as { block: boolean; reason: string };
      expect(out.block).toBe(true);
      expect(out.reason).toContain("guard-subagent-authority");
      expect(out.reason).toContain("boom");
    } finally {
      stderr.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe("parity with the Claude Code adapter", () => {
  const matrix = (): readonly string[] => [
    `loom helper security-audit verify --out ${run}`,
    `loom helper security-audit status --out ${run}`,
    "bun engine/src/cli.ts helper orchestration submit",
    `rm -rf ${run}`,
    `cat ${run}/ledger.json > ${run}/agents/h/scratch/copy.json`,
    `cd ${run} && echo x > findings.json`,
    "npm test",
  ];

  it("both harnesses refuse exactly the same subagent commands, with the same text", async () => {
    for (const command of matrix()) {
      const pi = piSubagentAuthorityDecision(bash(command), SUBAGENT(), AS_SUBAGENT);
      const claude = await runGuardSubagentAuthority(JSON.stringify({
        session_id: "s", tool_name: "Bash", tool_input: { command }, cwd: "/repo", agent_id: "a",
      }));
      if (pi === undefined) expect(claude, command).toEqual({ kind: "passthrough" });
      else expect(claude, command).toEqual({ kind: "block", message: pi.reason });
    }
  });
});
