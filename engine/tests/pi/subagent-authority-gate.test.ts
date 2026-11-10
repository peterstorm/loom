/**
 * The Pi bash authority decision (ADR-0067): one gate dispatching on this
 * process's role — a subagent is refused any authority change (D6, the twin of
 * Claude Code's guard-subagent-authority); a parent's `verify --from` import is
 * proof-checked against persisted attestations.
 *
 * The role comes from the Loom environment marker (`pi/subagent-process.ts`),
 * parsed once into a `PiProcessMarker`. Two policies read it and are tested as
 * distinct: the AUTHORITY role (any marked process is a subagent — the safe
 * direction) and the RULES-GATE exemption (only a provable child is exempt).
 * ONE subprocess case proves the real launcher path end to end — a process
 * spawned with the parent's `process.env` reads itself as a subagent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { piBashAuthorityDecision } from "../../../pi/subagent-authority-gate";
import {
  PI_PARENT_PID_ENV,
  PI_PARENT_SESSION_ENV,
  PI_SUBAGENT_ENV,
  childAgentEnvironment,
  currentPiProcessRole,
  interactiveSubagentNotice,
  markPiParentEnvironment,
  parentMarkerEntries,
  parsePiProcessMarker,
  piProcessRole,
  piRulesGateExemption,
  unmarkedSubagentLaunchNotice,
  type PiProcessRole,
} from "../../../pi/subagent-process";
import { runGuardSubagentAuthority } from "../../src/handlers/pre-tool-use/guard-subagent-authority";
import { registerSecurityAuditRun } from "../../src/orchestration/security-audit-run-registry";

const AS_SUBAGENT: PiProcessRole = { kind: "subagent", parentSession: "parent-session" };
const AS_PARENT: PiProcessRole = { kind: "parent" };
const SUBAGENT_PROCESS_MODULE = join(__dirname, "..", "..", "..", "pi", "subagent-process.ts");

let root: string;
let run: string;

beforeEach(() => {
  root = canonicalTempDir("loom-pi-subagent-authority-");
  vi.stubEnv("LOOM_SUBAGENT_DIR", join(root, "subagents"));
  run = join(root, "audits", "run-1");
  mkdirSync(join(run, "agents", "h", "scratch"), { recursive: true });
  expect(registerSecurityAuditRun(run).ok).toBe(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const ctx = (mode: string, sessionFile: string | undefined, cwd = "/repo") => ({
  mode, cwd, hasUI: false,
  sessionManager: { getSessionFile: () => sessionFile },
}) as never;
const SUBAGENT = () => ctx("json", undefined);
const bash = (command: unknown) => ({ toolName: "bash", input: { command } }) as never;

/** The role a fresh `bun` process reads from `env` — the launcher's view. */
function spawnedRole(env: NodeJS.ProcessEnv): unknown {
  const child = spawnSync("bun", ["-e",
    `const m = await import(${JSON.stringify(SUBAGENT_PROCESS_MODULE)}); console.log(JSON.stringify(m.currentPiProcessRole()));`],
  { encoding: "utf8", env });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}

const PID = 4242;
const roleOf = (env: Record<string, string>) => piProcessRole(parsePiProcessMarker(env), PID);

describe("the Loom marker environment, parsed once (G)", () => {
  it.each([
    ["nothing set", {}, { kind: "unmarked" }],
    ["every variable empty", { [PI_SUBAGENT_ENV]: "", [PI_PARENT_PID_ENV]: "", [PI_PARENT_SESSION_ENV]: "" }, { kind: "unmarked" }],
    ["the explicit child marker", { [PI_SUBAGENT_ENV]: "1", [PI_PARENT_SESSION_ENV]: "s" }, { kind: "child", parentSession: "s" }],
    ["a well-formed parent pid", { [PI_PARENT_PID_ENV]: "77" }, { kind: "inherited", parentPid: 77, parentSession: null }],
  ] as const)("%s", (_name, env, expected) => {
    expect(parsePiProcessMarker(env)).toEqual(expected);
  });

  it.each([
    ["a non-numeric pid", { [PI_PARENT_PID_ENV]: "abc" }, "is not a pid"],
    ["a pid with trailing junk", { [PI_PARENT_PID_ENV]: "77x" }, "is not a pid"],
    ["a zero pid", { [PI_PARENT_PID_ENV]: "0" }, "is not a pid"],
    ["a negative pid", { [PI_PARENT_PID_ENV]: "-5" }, "is not a pid"],
    ["an exponent spelling", { [PI_PARENT_PID_ENV]: "1e3" }, "is not a pid"],
    ["a pid beyond safe integers", { [PI_PARENT_PID_ENV]: "9".repeat(20) }, "is not a pid"],
    ["a subagent flag other than 1", { [PI_SUBAGENT_ENV]: "true" }, "is not \"1\""],
    ["a session without a pid", { [PI_PARENT_SESSION_ENV]: "s" }, `set without ${PI_PARENT_PID_ENV}`],
  ] as const)("%s is the explicit malformed case", (_name, env, reason) => {
    const marker = parsePiProcessMarker(env);
    expect(marker.kind).toBe("malformed");
    expect(marker.kind === "malformed" ? marker.reason : "").toContain(reason);
  });
});

describe("the AUTHORITY role — every marked process but the parent itself is a subagent", () => {
  it.each([
    ["no marker: a parent, whatever its launch flags (even headless json -p --no-session)", {}, "parent"],
    ["the explicit child marker", { [PI_SUBAGENT_ENV]: "1" }, "subagent"],
    ["a parent marker naming ANOTHER pid (launched from a Loom Pi session)", { [PI_PARENT_PID_ENV]: "77" }, "subagent"],
    ["a parent marker naming its OWN pid (the parent itself)", { [PI_PARENT_PID_ENV]: String(PID) }, "parent"],
    ["an empty parent marker", { [PI_PARENT_PID_ENV]: "" }, "parent"],
    ["a malformed (non-numeric) pid — the safe direction", { [PI_PARENT_PID_ENV]: "abc" }, "subagent"],
    ["a session without a pid — the safe direction", { [PI_PARENT_SESSION_ENV]: "s" }, "subagent"],
  ] as const)("%s", (_name, env, expected) => {
    expect(roleOf(env).kind).toBe(expected);
  });

  it("a parent publishes its pid and session; a subagent publishes nothing", () => {
    const entries = (env: Record<string, string>, session: string | null) => parentMarkerEntries(parsePiProcessMarker(env), PID, session);
    expect(entries({}, "sess")).toEqual({ [PI_PARENT_PID_ENV]: String(PID), [PI_PARENT_SESSION_ENV]: "sess" });
    expect(entries({ [PI_PARENT_PID_ENV]: String(PID) }, null)).toEqual({ [PI_PARENT_PID_ENV]: String(PID) });
    expect(entries({ [PI_PARENT_PID_ENV]: "77" }, "sess")).toEqual({});
    expect(entries({ [PI_SUBAGENT_ENV]: "1" }, "sess")).toEqual({});
    expect(entries({ [PI_PARENT_PID_ENV]: "abc" }, "sess")).toEqual({});
  });

  it("a child agent Loom spawns carries the explicit marker; its session rides on the inherited parent entries", () => {
    const env = childAgentEnvironment({ PATH: "/bin", [PI_PARENT_PID_ENV]: String(PID), [PI_PARENT_SESSION_ENV]: "sess" });
    expect(env).toEqual({ PATH: "/bin", [PI_SUBAGENT_ENV]: "1", [PI_PARENT_PID_ENV]: String(PID), [PI_PARENT_SESSION_ENV]: "sess" });
    expect(piProcessRole(parsePiProcessMarker(env), PID)).toEqual({ kind: "subagent", parentSession: "sess" });
    // A parent that has no session yet: the child is still a subagent.
    expect(piProcessRole(parsePiProcessMarker(childAgentEnvironment({ PATH: "/bin" })), PID))
      .toEqual({ kind: "subagent", parentSession: null });
  });

  it("the json-mode launcher path: a process spawned with the parent's process.env is a subagent", () => {
    vi.stubEnv(PI_SUBAGENT_ENV, undefined);
    vi.stubEnv(PI_PARENT_PID_ENV, undefined);
    vi.stubEnv(PI_PARENT_SESSION_ENV, undefined);
    markPiParentEnvironment("parent-session");
    expect(currentPiProcessRole()).toEqual({ kind: "parent" });
    // The installed launcher spawns `pi --mode json -p --no-session` with { ...process.env }.
    expect(spawnedRole({ ...process.env })).toEqual({ kind: "subagent", parentSession: "parent-session" });
  });
});

describe("the two policies stay distinct: authority role vs rules-gate exemption", () => {
  // [marker env, mode, authority role, rules gate]
  it.each([
    ["unmarked", {}, "tui", "parent", "gated"],
    ["unmarked headless parent", {}, "json", "parent", "gated"],
    ["explicit child, rpc", { [PI_SUBAGENT_ENV]: "1" }, "rpc", "subagent", "exempt"],
    ["explicit child, tui", { [PI_SUBAGENT_ENV]: "1" }, "tui", "subagent", "exempt"],
    ["inherited marker, json (the installed launcher's child)", { [PI_PARENT_PID_ENV]: "77" }, "json", "subagent", "exempt"],
    ["inherited marker, print", { [PI_PARENT_PID_ENV]: "77" }, "print", "subagent", "exempt"],
    ["inherited marker, tui (a nested interactive pi)", { [PI_PARENT_PID_ENV]: "77" }, "tui", "subagent", "gated"],
    ["its own marker, json (the parent itself)", { [PI_PARENT_PID_ENV]: String(PID) }, "json", "parent", "gated"],
    ["malformed pid, json", { [PI_PARENT_PID_ENV]: "abc" }, "json", "subagent", "gated"],
    ["malformed pid, tui", { [PI_PARENT_PID_ENV]: "abc" }, "tui", "subagent", "gated"],
  ] as const)("%s", (_name, env, mode, role, gate) => {
    const marker = parsePiProcessMarker(env);
    expect(piProcessRole(marker, PID).kind).toBe(role);
    expect(piRulesGateExemption(marker, PID, mode)).toBe(gate);
  });
});

describe("the interactive-subagent notice", () => {
  const notice = (env: Record<string, string>, mode: string) => interactiveSubagentNotice(parsePiProcessMarker(env), PID, mode);

  it("names a tui process that inherited a parent marker, and says the rules gate still applies", () => {
    const text = notice({ [PI_PARENT_PID_ENV]: "77" }, "tui");
    expect(text).toContain("treated as a SUBAGENT");
    expect(text).toContain(`inherited ${PI_PARENT_PID_ENV}`);
    expect(text).toContain("the rules gate still applies");
  });

  it("names a malformed marker and an explicit child in tui, with the rules-gate outcome of each", () => {
    expect(notice({ [PI_PARENT_PID_ENV]: "abc" }, "tui")).toContain("malformed");
    expect(notice({ [PI_SUBAGENT_ENV]: "1" }, "tui")).toContain("the rules gate exempts it as a child agent");
  });

  it.each([
    ["an unmarked tui parent", {}, "tui"],
    ["the parent's own marker in tui", { [PI_PARENT_PID_ENV]: String(PID) }, "tui"],
    ["a headless child", { [PI_PARENT_PID_ENV]: "77" }, "json"],
    ["an explicit rpc child", { [PI_SUBAGENT_ENV]: "1" }, "rpc"],
  ] as const)("stays quiet for %s", (_name, env, mode) => {
    expect(notice(env, mode)).toBeNull();
  });
});

describe("the unmarked-launch notice (a launcher that dropped the environment)", () => {
  const notice = (env: Record<string, string>, argv: readonly string[]) => unmarkedSubagentLaunchNotice(parsePiProcessMarker(env), argv);

  it.each([
    ["--mode json", ["pi", "--mode", "json", "-p"]],
    ["--mode rpc", ["pi", "--mode=rpc"]],
    ["--no-session", ["pi", "--no-session"]],
  ] as const)("names an unmarked process launched with %s", (flag, argv) => {
    const text = notice({ PATH: "/bin" }, argv);
    expect(text).toContain(flag);
    expect(text).toContain("treats it as a PARENT");
    expect(text).toContain("did not copy the parent's environment (ADR-0067 G)");
  });

  it.each([
    ["an interactive launch", {}, ["pi"]],
    ["a non-subagent mode", {}, ["pi", "--mode", "text"]],
    ["the explicit child marker", { [PI_SUBAGENT_ENV]: "1" }, ["pi", "--mode", "rpc", "--no-session"]],
    ["an inherited parent marker", { [PI_PARENT_PID_ENV]: "77" }, ["pi", "--mode", "json", "--no-session"]],
    ["its own parent marker (a later load in a marked process)", { [PI_PARENT_PID_ENV]: "4242" }, ["pi", "--no-session"]],
    ["a malformed marker", { [PI_PARENT_PID_ENV]: "abc" }, ["pi", "--no-session"]],
  ] as const)("stays quiet for %s", (_name, env, argv) => {
    expect(notice(env, argv)).toBeNull();
  });
});

describe("piBashAuthorityDecision — a SUBAGENT is refused any authority change", () => {
  it("blocks a subagent's authority write operation", async () => {
    const out = await piBashAuthorityDecision(bash(`loom helper security-audit submit --out ${run}`), SUBAGENT(), AS_SUBAGENT);
    expect(out?.block).toBe(true);
    expect(out?.reason).toContain("guard-subagent-authority (ADR-0067 D6)");
  });

  it("blocks a subagent's write onto a registered run's authority file", async () => {
    const out = await piBashAuthorityDecision(bash(`echo x > ${run}/verdicts.json`), SUBAGENT(), AS_SUBAGENT);
    expect(out?.reason).toContain(`${run}/verdicts.json`);
  });

  it("resolves relative paths against the Pi cwd", async () => {
    expect((await piBashAuthorityDecision(bash("echo x > ledger.json"), ctx("json", undefined, run), AS_SUBAGENT))?.block).toBe(true);
  });

  it("allows a subagent's reads, read-only operations and scratch writes", async () => {
    for (const command of [
      `cat ${run}/ledger.json`,
      `loom helper security-audit nonce --out ${run} --artifact agents/h/artifacts/x`,
      `echo x > ${run}/agents/h/scratch/notes.md`,
    ]) {
      expect(await piBashAuthorityDecision(bash(command), SUBAGENT(), AS_SUBAGENT), command).toBeUndefined();
    }
  });

  it("ignores tools other than bash", async () => {
    expect(await piBashAuthorityDecision({ toolName: "write", input: { path: `${run}/ledger.json` } } as never, SUBAGENT(), AS_SUBAGENT))
      .toBeUndefined();
  });

  it("fails closed on malformed bash input", async () => {
    expect((await piBashAuthorityDecision(bash(42), SUBAGENT(), AS_SUBAGENT))?.reason)
      .toContain("guard-subagent-authority: malformed Pi bash input");
    expect((await piBashAuthorityDecision({ toolName: "bash", input: null } as never, SUBAGENT(), AS_SUBAGENT))?.block).toBe(true);
  });

  it("an unreadable registry fails closed on authority-shaped paths", async () => {
    const unreadable = (): readonly string[] => { throw new Error("damaged"); };
    expect((await piBashAuthorityDecision(bash("echo x > /x/findings.json"), SUBAGENT(), AS_SUBAGENT, unreadable))?.reason)
      .toContain("registry is unreadable");
  });
});

describe("piBashAuthorityDecision — a PARENT's import is proof-checked; the persisted proof is the one authority", () => {
  const PARENT = () => ctx("tui", "/s.jsonl");
  const verify = (from: string) => `loom helper security-audit verify --out ${run} --from ${from}`;

  it("blocks a run its persisted attestations cannot prove — here, a run that does not exist", async () => {
    const out = await piBashAuthorityDecision(bash(verify("run.verify-w1-g1-000000000000")), PARENT(), AS_PARENT);
    expect(out?.block).toBe(true);
    expect(out?.reason).toContain("security-verification import proof (ADR-0067)");
    expect(out?.reason).toContain("cannot open verification run");
    expect(out?.reason).not.toContain("witness");
  });

  it("blocks an invocation it cannot place without trusting runtime shell state", async () => {
    for (const [command, reason] of [
      [`loom helper security-audit verify --out "$OUT" --from run.x`, "completed by the shell at runtime"],
      ["loom helper security-audit verify --out audits/run-1 --from run.x", "is relative"],
      [`loom helper security-audit verify --out ${run} --from verification-runs/run.x`, "is a relative path"],
    ] as const) {
      expect((await piBashAuthorityDecision(bash(command), PARENT(), AS_PARENT))?.reason, command).toContain(reason);
    }
  });

  it("lets through, in every parent mode, anything that imports nothing — even authority writes a subagent may not make", async () => {
    for (const parent of [ctx("tui", "/s.jsonl"), ctx("json", "/s.jsonl"), ctx("rpc", "/s.jsonl")]) {
      for (const command of [
        `loom helper security-audit status --out ${run}`,
        `loom helper security-audit verify --out ${run}`,
        `loom helper security-audit submit --out ${run}`,
        `loom helper security-audit verify --out ${run} --from /elsewhere/run.verify-w1-g1-000000000000`,
      ]) {
        expect(await piBashAuthorityDecision(bash(command), parent, AS_PARENT), command).toBeUndefined();
      }
    }
    expect(await piBashAuthorityDecision({ toolName: "read", input: { path: "x" } } as never, PARENT(), AS_PARENT)).toBeUndefined();
  });

  it("fails closed on malformed bash input", async () => {
    expect((await piBashAuthorityDecision(bash(42), PARENT(), AS_PARENT))?.reason)
      .toContain("security-verification import proof: malformed Pi bash input");
  });
});

describe("piBashAuthorityDecision — the role matrix, one command per role", () => {
  const verifyFrom = () => `loom helper security-audit verify --out ${run} --from run.verify-w1-g1-000000000000`;

  it("one verify --from: a subagent is refused by the D6 fence, a parent by the import proof", async () => {
    expect((await piBashAuthorityDecision(bash(verifyFrom()), SUBAGENT(), AS_SUBAGENT))?.reason)
      .toContain("guard-subagent-authority (ADR-0067 D6)");
    expect((await piBashAuthorityDecision(bash(verifyFrom()), ctx("tui", "/s.jsonl"), AS_PARENT))?.reason)
      .toContain("security-verification import proof (ADR-0067)");
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
    expect(await toolCall(event, piCtx("tui", "/s.jsonl"))).toMatchObject({
      block: true,
      reason: expect.stringContaining("guard-subagent-authority (ADR-0067 D6)"),
    });
  });

  it("a crash inside the gate blocks the call, naming the gate", async () => {
    const toolCall = await extensionToolCall();
    vi.stubEnv(PI_SUBAGENT_ENV, "1");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const hostile = { toolName: "bash", toolCallId: "c2", input: { get command(): string { throw new Error("boom"); } } };
      const out = await toolCall(hostile, piCtx("json", undefined)) as { block: boolean; reason: string };
      expect(out.block).toBe(true);
      expect(out.reason).toContain("loom guard 'bash-authority' crashed");
      expect(out.reason).toContain("boom");
    } finally {
      stderr.mockRestore();
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
      const pi = await piBashAuthorityDecision(bash(command), SUBAGENT(), AS_SUBAGENT);
      const claude = await runGuardSubagentAuthority(JSON.stringify({
        session_id: "s", tool_name: "Bash", tool_input: { command }, cwd: "/repo", agent_id: "a",
      }));
      if (pi === undefined) expect(claude, command).toEqual({ kind: "passthrough" });
      else expect(claude, command).toEqual({ kind: "block", message: pi.reason });
    }
  });
});
