import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseStructuredTestReportBytes } from "../../src/core/structured-test-report";

// These reporter smokes use disposable directories only, never a Loom Run writer.
describe("real reporter bytes at the parser seam", () => {
  it.each([
    ["pass", "test('pass', () => {});", 1, 0, 0],
    ["all skipped", "test.skip('skip', () => {});", 0, 0, 0],
    ["failure", "test('fail', () => { throw Error('expected'); });", 1, 1, 1],
    ["cancellation", "test('cancel', () => new Promise(() => {}));", 1, 1, 1],
    ["nested suites", "describe('outer', () => { describe('inner', () => { test('pass', () => {}); test.skip('skip', () => {}); }); test('pass2', () => {}); });", 2, 0, 0],
    ["failing TODO", "test.todo('todo', () => { throw Error('expected'); });", 0, 0, 0],
    ["nested failure", "describe('outer', () => { describe('inner', () => { test('fail', () => { throw Error('expected'); }); test.skip('skip', () => {}); }); test('pass', () => {}); });", 2, 1, 1],
  ])("Node JUnit: %s", (_name, body, total, failed, exit) => {
    const directory = mkdtempSync(join(tmpdir(), "loom-parser-node-"));
    try {
      const file = join(directory, "reporter.test.mjs");
      writeFileSync(file, `import { test, describe } from 'node:test';\n${body}\n`);
      // The per-test timeout makes the never-settling case cancel deterministically:
      // Node 24.14 waits on the pending promise instead of cancelling at loop drain.
      const child = spawnSync(process.execPath, ["--test", "--test-timeout=2000", "--test-reporter=junit", file], { cwd: directory, timeout: 10000 });
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status).toBe(exit);
      expect(parseStructuredTestReportBytes(child.stdout)).toEqual({ ok: true, value: { total, failed, source: "junit-xml" } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["pass", "test('pass', () => {}); test.skip('skip', () => {});", 1, 0, 0],
    ["all skipped", "test.skip('skip', () => {}); test.todo('todo');", 0, 0, 0],
    ["failure", "test('fail', () => { throw Error('expected'); });", 1, 1, 1],
  ])("Vitest JSON: %s", (_name, body, total, failed, exit) => {
    const directory = mkdtempSync(join(tmpdir(), "loom-parser-vitest-"));
    try {
      const file = join(directory, "reporter.test.mjs");
      const report = join(directory, "report.json");
      writeFileSync(file, `import { test } from ${JSON.stringify(resolve("node_modules/vitest/dist/index.js"))};\n${body}\n`);
      const child = spawnSync(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "--root", directory,
        "--reporter=json", "--outputFile", report, "--maxWorkers=1", "--no-file-parallelism"], { cwd: directory, timeout: 10000 });
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status, child.stderr.toString()).toBe(exit);
      expect(parseStructuredTestReportBytes(readFileSync(report))).toEqual({ ok: true, value: { total, failed, source: "vitest-json" } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
});
