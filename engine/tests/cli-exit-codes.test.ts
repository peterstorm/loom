/**
 * The CLI maps a handler's result to the exit code its harness reads (loom#198,
 * Cause 5: the mapping now runs through `exitAfterFlush`): passthrough exits 0
 * with its stdout, an error 1 and a block 2, each with its message on stderr.
 * Hook semantics hang on 2 meaning block.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = join(__dirname, "..", "src", "cli.ts");
const run = (args: readonly string[], input = "") =>
  spawnSync("bun", [CLI, ...args], { input, encoding: "utf8", env: { ...process.env, PI_CODING_AGENT: "" } });

describe("CLI exit codes", () => {
  it("exits 0 with the handler's stdout on passthrough", () => {
    const result = run(["helper", "suggest-affected-runner", "--preset", "vitest"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"affectedRunner"');
  });

  it("exits 1 with the message on stderr on an error", () => {
    const result = run(["helper", "suggest-affected-runner", "--preset", "no-such-runner"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown preset no-such-runner");
    expect(result.stdout).toBe("");
  });

  it("exits 2 with the message on stderr on a block", () => {
    const result = run(["pre-tool-use", "guard-state-file"], JSON.stringify({ tool_name: "Bash", tool_input: { command: 42 } }));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("non-string Bash command");
  });
});
