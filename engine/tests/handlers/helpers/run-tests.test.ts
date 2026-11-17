/**
 * `helper run-tests` as a shell (loom#198), over injected ports: a fake
 * runner, a fixed repository root, a runner lock and a clock, so each branch
 * it owns is pinned without a real runner:
 * - the command line: no `--files`, an unknown argument, an absolute or
 *   traversing path, or a repeated file is an error, and nothing runs;
 * - a TaskGraph whose manifest has no affectedRunner is an error;
 * - a finished run prints the summary, then the receipt as the last line,
 *   with the runner's output on stderr; the receipt round-trips, binds the
 *   canonical root and the frozen manifest, and carries the report;
 * - a runner that exits non-zero without a report yields a runner-crash
 *   receipt; one that exits 0 without one yields a receipt with no report;
 * - a timeout or a kill prints no receipt;
 * - a held lock is waited for, within the bound, and released after the run.
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEngineTestRunReceipt } from "../../../src/core/engine-test-run";
import { isRecord } from "../../../src/core/plain-record";
import type { StopCheckCommand } from "../../../src/core/affected-stop-check-types";
import { createRunTestsHandler, RUNNER_LOCK_WAIT_MS, type RunTestsPorts } from "../../../src/handlers/helpers/run-tests";
import type { CompletionCheckRunnerResult } from "../../../src/orchestration/completion-check-runner";
import type { HookResult } from "../../../src/types";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../../../src/utils/workspace-digest";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { stateFileJson, task, writeStateFile } from "../../fixtures/contract-status-fixtures";
import { AFFECTED_REPORT, affectedArgv, argvOf, observedRun } from "../../fixtures/stop-check-runners";
import { junitReport, mutationManifest, type MutationManifestOverrides } from "../../fixtures/task-mutation";
import { taskFixture } from "../../fixtures/task-lifecycle";

const IMPL = "src/ledger.ts";
const TEST = "src/ledger.test.ts";

const savedStatePath = process.env.LOOM_STATE_PATH;
const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
  if (savedStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = savedStatePath;
});

type Workspace = Readonly<{ root: CanonicalRepositoryRoot; statePath: string; manifestDigest: string }>;

function workspace(manifest: MutationManifestOverrides = {}): Workspace {
  const directory = canonicalTempDir("loom-run-tests-helper-");
  temporary.push(directory);
  const parsed = parseCanonicalRepositoryRoot(directory);
  if (!parsed.ok) throw new Error(`fixture root is not canonical: ${directory}`);
  const root = parsed.value;
  mkdirSync(dirname(join(root, TEST)), { recursive: true });
  writeFileSync(join(root, TEST), "// the Task's test\n");
  const raw: unknown = JSON.parse(stateFileJson([taskFixture(task("T1", 1, [IMPL, TEST]))]));
  if (!isRecord(raw)) throw new Error("a State File is a JSON object");
  const frozen = mutationManifest(manifest);
  const statePath = writeStateFile(root, JSON.stringify({ ...raw, verification_manifest: frozen }));
  return { root, statePath, manifestDigest: frozen.manifestDigest };
}

type Ran = Readonly<{ result: HookResult; stdout: string; stderr: string; launches: readonly StopCheckCommand[]; released: number }>;

type FakeRun = Readonly<{ bytes: Uint8Array | null; ending?: Parameters<typeof observedRun>[2] }>;

const RED = junitReport([{ file: TEST, name: "debits", outcome: "failed" }]);

async function helper(
  at: Workspace,
  args: readonly string[] = ["--files", TEST],
  run: FakeRun = { bytes: RED, ending: { ending: { exitCode: 1, timedOut: false, signal: null }, stdoutTail: "1 failing" } },
  overrides: Partial<RunTestsPorts> = {},
): Promise<Ran> {
  process.env.LOOM_STATE_PATH = at.statePath;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const launches: StopCheckCommand[] = [];
  const reports = new Map<string, Uint8Array>();
  let released = 0;
  const handler = createRunTestsHandler({
    write: (text) => { stdout.push(text); },
    writeDiagnostic: (text) => { stderr.push(text); },
    repositoryRoot: () => ({ ok: true, root: at.root }),
    acquireRunner: () => ({ kind: "acquired", release: () => { released++; return null; } }),
    runCheck: async (command): Promise<CompletionCheckRunnerResult> => {
      launches.push(command);
      if (run.bytes !== null) reports.set(join(at.root, AFFECTED_REPORT), run.bytes);
      return observedRun(command, run.bytes, run.ending);
    },
    readReport: (path) => {
      const bytes = reports.get(path);
      if (bytes === undefined) throw new Error(`no report at ${path}`);
      return bytes;
    },
    sleep: async () => undefined,
    now: () => 0,
    ...overrides,
  });
  return { result: await handler("", [...args]), stdout: stdout.join(""), stderr: stderr.join(""), launches, released };
}

describe("helper run-tests: what it refuses", () => {
  it.each<[string, readonly string[], RegExp]>([
    ["no --files", [], /requires --files/],
    ["an unknown argument", ["--files", TEST, "--force"], /unknown or unconsumed argument\(s\): --force/],
    ["an absolute path", ["--files", "/etc/passwd"], /repository-relative/],
    ["a traversing path", ["--files", "../outside.test.ts"], /traversal/],
    ["a repeated file", ["--files", TEST, "--files", TEST], /more than once/],
  ])("refuses %s, running nothing", async (_label, args, message) => {
    const { result, stdout, launches } = await helper(workspace(), args);
    expect(result).toMatchObject({ kind: "error", message: expect.stringMatching(message) });
    expect(stdout).toBe("");
    expect(launches).toEqual([]);
  });

  it("refuses a TaskGraph whose frozen manifest has no affectedRunner", async () => {
    const { result, launches } = await helper(workspace({ affectedRunner: undefined }));
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("declares no affectedRunner") });
    expect(launches).toEqual([]);
  });
});

describe("helper run-tests: a finished run", () => {
  it("runs the frozen runner over the named files and prints the receipt last, the runner's output on stderr", async () => {
    const at = workspace();
    const { result, stdout, stderr, launches, released } = await helper(at);
    expect(result).toEqual({ kind: "passthrough" });
    expect(launches.map(argvOf)).toEqual([affectedArgv(TEST)]);
    expect(stderr).toContain("1 failing");
    expect(stdout).not.toContain("1 failing");
    const lines = stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^run-tests: exit 1 — 1 tests, 1 failed \(junit-xml\) over 1 file\(s\)$/);
    const receipt = parseEngineTestRunReceipt(stdout);
    expect(receipt).toMatchObject({ ok: true, value: { repositoryRoot: at.root, manifestDigest: at.manifestDigest, files: [TEST], exit: 1 } });
    expect(receipt.ok && receipt.value.report).toMatchObject({ source: "junit-xml", failed: 1 });
    expect(released).toBe(1);
  });

  it("a runner that exits non-zero without a report yields a runner-crash receipt", async () => {
    const { stdout } = await helper(workspace(), undefined, { bytes: null, ending: { ending: { exitCode: 2, timedOut: false, signal: null } } });
    const receipt = parseEngineTestRunReceipt(stdout);
    expect(receipt.ok && receipt.value.report).toMatchObject({ source: "runner-crash", total: 1, failed: 1 });
  });

  it("a runner that exits 0 without a report yields a receipt with no report", async () => {
    const { stdout } = await helper(workspace(), undefined, { bytes: null });
    expect(parseEngineTestRunReceipt(stdout)).toMatchObject({ ok: true, value: { exit: 0, report: null } });
  });

  it("a report rewritten after the runner produced it prints no receipt: it is never a crash red", async () => {
    const { result, stdout } = await helper(workspace(), undefined, {
      bytes: RED,
      ending: { ending: { exitCode: 1, timedOut: false, signal: null }, digestOf: new TextEncoder().encode("other bytes") },
    });
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("changed after the runner produced it") });
    expect(stdout).toBe("");
  });

  it("a report the runner wrote but that cannot be read back prints no receipt", async () => {
    const { result, stdout } = await helper(workspace(), undefined, undefined, {
      readReport: () => { throw new Error("EACCES"); },
    });
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("could not be read back: EACCES") });
    expect(stdout).toBe("");
  });
});

describe("helper run-tests: a run that did not finish proves nothing", () => {
  it.each<[string, FakeRun, RegExp]>([
    ["a timeout", { bytes: RED, ending: { ending: { exitCode: null, timedOut: true, signal: null } } }, /timed out/],
    ["a kill", { bytes: RED, ending: { ending: { exitCode: null, timedOut: false, signal: "SIGKILL" } } }, /killed by SIGKILL/],
  ])("prints no receipt after %s", async (_label, run, message) => {
    const { result, stdout, released } = await helper(workspace(), undefined, run);
    expect(result).toMatchObject({ kind: "error", message: expect.stringMatching(message) });
    expect(stdout).toBe("");
    expect(released).toBe(1);
  });
});

describe("helper run-tests: the runner lock", () => {
  it("waits for a held lock and runs once it is free", async () => {
    let attempts = 0;
    const { result, launches } = await helper(workspace(), undefined, undefined, {
      acquireRunner: () => (++attempts < 3 ? { kind: "held", reason: "a stop check holds it" } : { kind: "acquired", release: () => null }),
    });
    expect(result).toEqual({ kind: "passthrough" });
    expect(attempts).toBe(3);
    expect(launches).toHaveLength(1);
  });

  it("gives up once the lock stays held past the bound, running nothing", async () => {
    let clock = 0;
    const { result, launches } = await helper(workspace(), undefined, undefined, {
      acquireRunner: () => ({ kind: "held", reason: "a stop check holds it" }),
      now: () => clock,
      sleep: async () => { clock += RUNNER_LOCK_WAIT_MS; },
    });
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("runner lock stayed held") });
    expect(launches).toEqual([]);
  });
});
