/**
 * loom#198, Cause 5: the CLI exits only after its output has drained. A Bun
 * child writes far more than a pipe buffer holds to a reader that is attached
 * but paused, then exits through `exitAfterFlush`; every byte must arrive and
 * the exit code must be the one asked for. A stray handle cannot keep it
 * alive past the forced exit. The first case pins the defect: an immediate
 * `process.exit` loses most of the output.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FORCED_EXIT_MS } from "../../src/utils/exit-after-flush";

const MODULE = join(__dirname, "..", "..", "src", "utils", "exit-after-flush.ts");
const BYTES = 1024 * 1024;

type Observed = Readonly<{ stdout: number; stderr: number; exit: number | null; elapsedMs: number }>;

function runChild(body: string): Promise<Observed> {
  const script = [
    `import { exitAfterFlush } from ${JSON.stringify(MODULE)};`,
    `process.stdout.write("x".repeat(${BYTES}));`,
    `process.stderr.write("y".repeat(${BYTES / 4}));`,
    body,
  ].join("\n");
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = 0;
    let stderr = 0;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.length; });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.length; });
    // The reader is attached but reads nothing for a while: the pipes are full when the child asks to exit.
    child.stdout.pause();
    child.stderr.pause();
    setTimeout(() => { child.stdout.resume(); child.stderr.resume(); }, 300);
    child.on("error", reject);
    child.on("close", (exit) => resolve({ stdout, stderr, exit, elapsedMs: Date.now() - started }));
  });
}

describe("exitAfterFlush", () => {
  it("is needed: an immediate process.exit drops output a paused reader has not taken", async () => {
    expect((await runChild("process.exit(3);")).stdout).toBeLessThan(BYTES);
  }, 20_000);

  it("delivers every byte written before it to a paused reader, then exits with the code", async () => {
    expect(await runChild("exitAfterFlush(3);")).toMatchObject({ stdout: BYTES, stderr: BYTES / 4, exit: 3 });
  }, 20_000);

  it("still exits, with every byte, when a stray handle would keep the process alive", async () => {
    const observed = await runChild("setInterval(() => {}, 1000); exitAfterFlush(4);");
    expect(observed).toMatchObject({ stdout: BYTES, stderr: BYTES / 4, exit: 4 });
    // The forced exit, not the handle, ended it: no sooner than its bound, and well before the test's.
    expect(observed.elapsedMs).toBeGreaterThanOrEqual(FORCED_EXIT_MS);
    expect(observed.elapsedMs).toBeLessThan(15_000);
  }, 30_000);
});
