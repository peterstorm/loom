/**
 * The orchestrator's Task/Agent PostToolUse drains its session's stop-check
 * notes into the model's context (#121), and hooks/scripts/surface-stop-check-notes.sh
 * pays for a bun spawn only when some note sidecar exists.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { STOP_CHECK_NOTES_HEADING } from "../../../src/core/stop-check-note";
import { surfaceStopCheckNotes } from "../../../src/handlers/post-tool-use/surface-stop-check-notes";
import { publishStopCheckNote, stopCheckNotePath } from "../../../src/stop-check-note-sidecar";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const directory = (prefix = "loom-surface-notes-"): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
};

const call = (tool: string, session = "session-a") => ({ session_id: session, tool_name: tool, tool_input: {}, tool_response: {} });

describe("surfaceStopCheckNotes", () => {
  it("hands the model and the operator every note of the session, once", () => {
    const dir = directory();
    publishStopCheckNote("session-a", "agent-1", { taskId: "T2", message: "affected-test stop check did not decide (timed out)" }, dir);
    publishStopCheckNote("session-b", "agent-2", { taskId: "T7", message: "another session" }, dir);

    const result = surfaceStopCheckNotes(call("Agent"), dir);

    expect(result).toEqual({
      kind: "post-tool-use-context",
      context: `${STOP_CHECK_NOTES_HEADING}\n- T2: affected-test stop check did not decide (timed out)`,
      systemMessage: `${STOP_CHECK_NOTES_HEADING}\n- T2: affected-test stop check did not decide (timed out)`,
    });
    expect(surfaceStopCheckNotes(call("Task"), dir)).toEqual({ kind: "passthrough" });
    expect(readdirSync(dir)).toEqual(["session-b.agent-2.stop-check-note.json"]);
  });

  it.each<[string, unknown]>([
    ["a non-spawn tool", call("Bash")],
    ["Pi's subagent tool", call("subagent")],
    ["no session id", { tool_name: "Agent" }],
    ["a non-object input", "Agent"],
    ["a call made inside a subagent (Claude stamps agent_id)", { ...call("Agent"), agent_id: "agent-7" }],
  ])("passes through untouched for %s, draining nothing", (_label, input) => {
    const dir = directory();
    publishStopCheckNote("session-a", "agent-1", { taskId: "T2", message: "kept" }, dir);
    expect(surfaceStopCheckNotes(input, dir)).toEqual({ kind: "passthrough" });
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("names a sidecar it cannot read to both channels, beside the notes it could", () => {
    const dir = directory();
    publishStopCheckNote("session-a", "agent-1", { taskId: "T2", message: "lock held" }, dir);
    writeFileSync(stopCheckNotePath("session-a", "agent-2", dir), "{broken");

    const result = surfaceStopCheckNotes(call("Agent"), dir);

    expect(result.kind).toBe("post-tool-use-context");
    if (result.kind !== "post-tool-use-context") return;
    expect(result.context).toContain("- T2: lock held");
    expect(result.context).toContain("Loom could not read 1 stop-check note(s)");
    expect(result.systemMessage).toBe(result.context);
  });
});

describe("surface-stop-check-notes.sh", () => {
  const BASH = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf-8" }).stdout.trim();
  const SHIM = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "hooks", "scripts", "surface-stop-check-notes.sh");

  /** A plugin root whose engine entry records that it was reached. */
  function stubPluginRoot(): string {
    const root = directory("loom-notes-shim-root-");
    mkdirSync(join(root, "engine", "src"), { recursive: true });
    writeFileSync(join(root, "engine", "src", "cli.ts"), "console.log(JSON.stringify({ reached: process.argv.slice(2) }));\n");
    return root;
  }

  const runShim = (env: Readonly<Record<string, string>>) => {
    const result = spawnSync(BASH, [SHIM], {
      input: JSON.stringify(call("Agent")),
      encoding: "utf-8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
    return { status: result.status, stdout: result.stdout.trim() };
  };

  it("exits 0 without spawning the engine when no note sidecar exists", () => {
    expect(runShim({ CLAUDE_PLUGIN_ROOT: stubPluginRoot(), LOOM_SUBAGENT_DIR: directory() })).toEqual({ status: 0, stdout: "" });
  });

  it("reaches the engine route when a note sidecar exists", () => {
    const dir = directory();
    publishStopCheckNote("session-a", "agent-1", { taskId: "T2", message: "m" }, dir);
    const { status, stdout } = runShim({ CLAUDE_PLUGIN_ROOT: stubPluginRoot(), LOOM_SUBAGENT_DIR: dir });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ reached: ["post-tool-use", "surface-stop-check-notes"] });
  });

  it("fails open with an operator message when the runtime is unavailable", () => {
    const dir = directory();
    publishStopCheckNote("session-a", "agent-1", { taskId: "T2", message: "m" }, dir);
    const { status, stdout } = runShim({ LOOM_SUBAGENT_DIR: dir });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ systemMessage: expect.stringContaining("runtime unavailable") });
  });
});
