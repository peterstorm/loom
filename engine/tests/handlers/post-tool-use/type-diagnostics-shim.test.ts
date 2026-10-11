/**
 * hooks/scripts/type-diagnostics.sh — the fast-path prefilter in front of the
 * engine. The plugin root is a stub whose cli.ts records that it was reached,
 * so these tests pin exactly which hook inputs pay for a bun spawn, and that
 * every path out of the shim exits 0 (fail-open).
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTypeScriptSource } from "../../../src/core/type-diagnostics";

const BASH = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf-8" }).stdout.trim();
const SHIM = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "hooks", "scripts", "type-diagnostics.sh");

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

/** A plugin root whose engine entry echoes its arguments and the stdin it received. */
function stubPluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "loom-shim-root-"));
  temporary.push(root);
  mkdirSync(join(root, "engine", "src"), { recursive: true });
  writeFileSync(
    join(root, "engine", "src", "cli.ts"),
    "const stdin = await Bun.stdin.text();\nconsole.log(JSON.stringify({ reached: process.argv.slice(2), stdin }));\n",
  );
  return root;
}

/** A PATH holding only what the shim needs besides bun. */
function pathWithoutBun(): string {
  const bin = mkdtempSync(join(tmpdir(), "loom-shim-bin-"));
  temporary.push(bin);
  for (const tool of ["cat", "grep"]) {
    const found = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim();
    symlinkSync(found, join(bin, tool));
  }
  return bin;
}

function runShim(stdin: string, env: Readonly<Record<string, string | undefined>>) {
  const result = spawnSync(BASH, [SHIM], {
    input: stdin,
    encoding: "utf-8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  return { status: result.status, stdout: result.stdout.trim() };
}

const hookInput = (toolInput: Record<string, unknown>, tool = "Edit") =>
  JSON.stringify({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: toolInput });

describe("type-diagnostics.sh", () => {
  it.each<[string, string]>([
    ["file_path", "src/a.ts"],
    ["file_path", "/repo/src/view.tsx"],
    ["file_path", "src/esm.mts"],
    ["file_path", "src/cjs.cts"],
    ["path", "src/a.ts"],
  ])("hands a TypeScript edit (%s: %s) to the engine's type-diagnostics route", (key, path) => {
    const input = hookInput({ [key]: path });
    const run = runShim(input, { CLAUDE_PLUGIN_ROOT: stubPluginRoot() });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ reached: ["post-tool-use", "type-diagnostics"], stdin: `${input}\n` });
  });

  it("matches the path key with whitespace around the colon", () => {
    const run = runShim('{"tool_name":"Write","tool_input":{"file_path" :  "src/a.ts"}}', { CLAUDE_PLUGIN_ROOT: stubPluginRoot() });
    expect(JSON.parse(run.stdout).reached).toEqual(["post-tool-use", "type-diagnostics"]);
  });

  it.each(["README.md", "src/a.js", "src/a.ts.bak", "src/tsconfig.json"])("skips the engine for a non-TypeScript edit (%s)", (path) => {
    const run = runShim(hookInput({ file_path: path }), { CLAUDE_PLUGIN_ROOT: stubPluginRoot() });
    expect(run).toEqual({ status: 0, stdout: "" });
  });

  it.each([
    "src/a.ts", "src/a.tsx", "src/a.mts", "src/a.cts",
    "src/a.d.ts", "src/a.d.mts", "src/a.d.cts", "src/a.js", "src/a.ts.bak", "README.md", "src/types.d.tsx",
  ])("forwards %s to the engine exactly when the core would check it", (path) => {
    const run = runShim(hookInput({ file_path: path }), { CLAUDE_PLUGIN_ROOT: stubPluginRoot() });
    expect(run.status).toBe(0);
    expect(run.stdout !== "").toBe(isTypeScriptSource(path));
  });

  it("skips the engine when switched off with LOOM_TYPE_DIAGNOSTICS=off", () => {
    const run = runShim(hookInput({ file_path: "src/a.ts" }), { CLAUDE_PLUGIN_ROOT: stubPluginRoot(), LOOM_TYPE_DIAGNOSTICS: "off" });
    expect(run).toEqual({ status: 0, stdout: "" });
  });

  it("tells the operator, without failing, when the plugin root is unset", () => {
    const run = runShim(hookInput({ file_path: "src/a.ts" }), {});
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).systemMessage).toMatch(/runtime unavailable/);
  });

  it("tells the operator, without failing, when bun is not on PATH", () => {
    const run = runShim(hookInput({ file_path: "src/a.ts" }), { CLAUDE_PLUGIN_ROOT: stubPluginRoot(), PATH: pathWithoutBun() });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).systemMessage).toMatch(/runtime unavailable/);
  });
});
