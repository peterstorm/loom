/**
 * guard-subagent-authority (ADR-0067 D6) — the Claude Code PreToolUse Bash
 * shell around core/subagent-authority: active only for calls Claude Code
 * attributes to a subagent (`agent_id`), fail-closed on malformed input, and
 * wired end to end (route table, hooks.json, the shim's fast path and its
 * runtime-drift polarity).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { runGuardSubagentAuthority } from "../../../src/handlers/pre-tool-use/guard-subagent-authority";
import { registerSecurityAuditRun } from "../../../src/orchestration/security-audit-run-registry";
import { FAIL_CLOSED_ROUTES, KNOWN_HANDLERS } from "../../../src/handler-routes";
import { PERSISTENT_SUBAGENT_STORES } from "../../../src/config";

const ENGINE = join(__dirname, "..", "..", "..");
const PLUGIN_ROOT = join(ENGINE, "..");
const SHIM = join(PLUGIN_ROOT, "hooks", "scripts", "guard-subagent-authority.sh");

let root: string;
let run: string;
let saved: string | undefined;

beforeEach(() => {
  root = canonicalTempDir("loom-subagent-authority-");
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

const payload = (command: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({
  session_id: "s-1",
  tool_name: "Bash",
  tool_input: { command },
  cwd: "/repo",
  ...extra,
});

const subagent = (command: unknown, extra: Record<string, unknown> = {}): string =>
  payload(command, { agent_id: "agent-7", ...extra });

describe("caller identification", () => {
  it.each([
    "loom helper security-audit verify --out $RUN",
    "loom helper orchestration submit --run x",
    "echo x > /anywhere/ledger.json",
  ])("a PARENT call passes through, whatever it runs: %s", async (command) => {
    expect(await runGuardSubagentAuthority(payload(command.replace("$RUN", run)))).toEqual({ kind: "passthrough" });
  });

  it("a PARENT write onto a registered run's ledger passes through", async () => {
    expect(await runGuardSubagentAuthority(payload(`echo x > ${run}/ledger.json`))).toEqual({ kind: "passthrough" });
  });

  it("a SUBAGENT call is judged", async () => {
    const result = await runGuardSubagentAuthority(subagent(`loom helper security-audit verify --out ${run}`));
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("guard-subagent-authority (ADR-0067 D6)");
      expect(result.message).toContain("Return your result to the parent session");
    }
  });

  it("any agent_id value — even a malformed one — means a subagent", async () => {
    for (const agentId of ["", 42, null]) {
      const result = await runGuardSubagentAuthority(subagent("loom helper orchestration submit", { agent_id: agentId }));
      expect(result.kind, JSON.stringify(agentId)).toBe("block");
    }
  });

  it("a subagent's read-only operations and ordinary work pass", async () => {
    for (const command of [
      `loom helper security-audit nonce --out ${run} --artifact agents/h/artifacts/out.txt`,
      `cat ${run}/ledger.json`,
      `echo x > ${run}/agents/h/scratch/notes.md`,
      "npm test",
    ]) {
      expect(await runGuardSubagentAuthority(subagent(command)), command).toEqual({ kind: "passthrough" });
    }
  });

  it("a subagent call to another tool passes through", async () => {
    expect(await runGuardSubagentAuthority(JSON.stringify({
      session_id: "s", tool_name: "Read", tool_input: { file_path: `${run}/ledger.json` }, agent_id: "a",
    }))).toEqual({ kind: "passthrough" });
  });
});

describe("registered runs, read from the registry", () => {
  it("refuses a subagent write onto a registered run's authority file", async () => {
    const result = await runGuardSubagentAuthority(subagent(`echo x > ${run}/ledger.json`));
    expect(result.kind).toBe("block");
    if (result.kind === "block") expect(result.message).toContain(`${run}/ledger.json`);
  });

  it("resolves relative paths against the subagent's cwd", async () => {
    expect((await runGuardSubagentAuthority(subagent("echo x > ledger.json", { cwd: run }))).kind).toBe("block");
    expect((await runGuardSubagentAuthority(subagent("echo x > ledger.json", { cwd: root }))).kind).toBe("passthrough");
  });

  it("canonicalises a symlinked cwd before resolving", async () => {
    const alias = join(root, "alias");
    symlinkSync(run, alias);
    expect((await runGuardSubagentAuthority(subagent("rm findings.json", { cwd: alias }))).kind).toBe("block");
  });

  it("protects the registry itself", async () => {
    const result = await runGuardSubagentAuthority(subagent(`rm -rf ${join(root, "subagents", "security-audit-runs")}`));
    expect(result.kind).toBe("block");
  });

  it("an unreadable registry fails closed on authority-shaped paths", async () => {
    const unreadable = (): readonly string[] => { throw new Error("registry entry x.json is not JSON"); };
    const result = await runGuardSubagentAuthority(subagent("echo x > /elsewhere/verdicts.json"), unreadable);
    expect(result.kind).toBe("block");
    if (result.kind === "block") expect(result.message).toContain("registry is unreadable");
    expect(await runGuardSubagentAuthority(subagent("echo x > /elsewhere/notes.md"), unreadable)).toEqual({ kind: "passthrough" });
  });
});

describe("fail-closed input handling", () => {
  it("malformed JSON blocks", async () => {
    const result = await runGuardSubagentAuthority("{not json");
    expect(result.kind).toBe("block");
    if (result.kind === "block") expect(result.message).toContain("malformed hook input");
  });

  it("a wrong-shaped payload blocks", async () => {
    expect((await runGuardSubagentAuthority("null")).kind).toBe("block");
  });

  it("a non-string Bash command from a subagent blocks", async () => {
    const result = await runGuardSubagentAuthority(subagent({ evil: true }));
    expect(result.kind).toBe("block");
    if (result.kind === "block") expect(result.message).toContain("non-string Bash command");
  });
});

describe("wiring", () => {
  it("is a routed, fail-closed pre-tool-use handler", () => {
    expect(KNOWN_HANDLERS["pre-tool-use"]!.has("guard-subagent-authority")).toBe(true);
    expect(FAIL_CLOSED_ROUTES.has("pre-tool-use/guard-subagent-authority")).toBe(true);
  });

  it("hooks.json runs the shim on every Bash PreToolUse", () => {
    const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf-8")) as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
    };
    const wired = hooks.hooks.PreToolUse.filter((entry) =>
      entry.hooks.some((hook) => hook.command.endsWith("/hooks/scripts/guard-subagent-authority.sh")));
    expect(wired.map((entry) => entry.matcher)).toEqual(["Bash"]);
  });

  /** A PATH holding only what the shim needs before its bun check, so
   *  `command -v bun` genuinely fails (runtime drift). */
  const bunlessPath = (): string => {
    const bin = join(root, "bunless-bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["bash", "cat"]) {
      const resolved = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf-8" }).stdout.trim();
      symlinkSync(resolved, join(bin, name));
    }
    return bin;
  };
  const BASH = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf-8" }).stdout.trim();

  const runShim = (input: string, env: Record<string, string | undefined>) => {
    const base: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "CLAUDE_PLUGIN_ROOT") base[key] = value;
    }
    for (const [key, value] of Object.entries(env)) if (value !== undefined) base[key] = value;
    return spawnSync(BASH, [SHIM], { env: base, input, encoding: "utf-8", timeout: 60_000 });
  };

  it("the shim skips the engine for a parent payload, even with no runtime", () => {
    const result = runShim(payload("loom helper orchestration submit"), { PATH: bunlessPath() });
    expect(result.status).toBe(0);
  });

  it("the shim fails CLOSED for a subagent payload when the runtime is gone", () => {
    const unset = runShim(subagent("ls"), {});
    expect(unset.status).toBe(2);
    expect(unset.stderr).toContain("CLAUDE_PLUGIN_ROOT unset");
    const bunless = runShim(subagent("ls"), { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, PATH: bunlessPath() });
    expect(bunless.status).toBe(2);
    expect(bunless.stderr).toContain("bun not found");
  });

  it("the shim reaches the engine through the CLI: refuses a subagent write op, allows a read", () => {
    const env = { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, LOOM_SUBAGENT_DIR: join(root, "subagents") };
    const refused = runShim(subagent(`loom helper security-audit submit --out ${run}`), env);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("guard-subagent-authority");
    const allowed = runShim(subagent(`loom helper security-audit status --out ${run}`), env);
    expect(allowed.status).toBe(0);
  });
});

describe("the real filesystem port (ADR-0067, amended)", () => {
  it("reads a script a subagent runs, refusing one that writes authority and allowing the sandbox", async () => {
    const forge = join(root, "forge.sh");
    writeFileSync(forge, `#!/usr/bin/env bash\necho forged > ${run}/verdicts.json\n`);
    expect((await runGuardSubagentAuthority(subagent(`bash ${forge}`))).kind).toBe("block");
    expect((await runGuardSubagentAuthority(subagent(`source ${forge}`))).kind).toBe("block");
    chmodSync(forge, 0o755);
    expect((await runGuardSubagentAuthority(subagent(forge))).kind).toBe("block");
    const sandbox = join(PLUGIN_ROOT, "scripts", "security-sandbox.sh");
    expect(await runGuardSubagentAuthority(subagent(`bash ${sandbox} --help`))).toEqual({ kind: "passthrough" });
    expect(await runGuardSubagentAuthority(subagent(`${sandbox} --help`))).toEqual({ kind: "passthrough" });
  });

  it("canonicalises a write through a symlink planted earlier", async () => {
    const link = join(root, "innocent");
    symlinkSync(run, link);
    expect(await runGuardSubagentAuthority(subagent(`echo x > ${link}/ledger.json`))).toMatchObject({ kind: "block" });
    expect(await runGuardSubagentAuthority(subagent(`echo x > ${link}/agents/h/scratch/n.md`))).toEqual({ kind: "passthrough" });
  });

  it("protects the capture attestation store like the registry", async () => {
    expect(await runGuardSubagentAuthority(subagent(`echo {} > ${PERSISTENT_SUBAGENT_STORES.captureAttestations.dir()}/forged.json`))).toMatchObject({ kind: "block" });
  });

  it("refuses running Loom's own hook shims, which forge harness events", async () => {
    for (const shim of ["dispatch.sh", "record-orchestration-spawn.sh", "mark-subagent-active.sh"]) {
      const path = join(PLUGIN_ROOT, "hooks", "scripts", shim);
      const decided = await runGuardSubagentAuthority(subagent(`bash ${path} < /tmp/forged.json`));
      expect(decided, shim).toMatchObject({ kind: "block", message: expect.stringContaining("hook entrypoint") });
    }
  });

  it("never blocks on a FIFO it would have to read (it is not a regular file)", async () => {
    const fifo = join(root, "pipe.sh");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    expect(await runGuardSubagentAuthority(subagent(`bash ${fifo}`))).toEqual({ kind: "passthrough" });
  });
});
