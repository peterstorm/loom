/**
 * The Task mutation check's fixture repository (ADR-0071): a real temp Git
 * repository in which one Task has added a guard to `src/ledger.mjs`, with a
 * runner that really executes the Task's tests.
 *
 * - The base commit holds `src/ledger.mjs` without the guard and the runner
 *   `scripts/runner.mjs`. The Task's work is left uncommitted: the guard on
 *   line 2, and the test file `tests` selects.
 * - The frozen `affectedRunner` is `node scripts/runner.mjs {files}`. For each
 *   implementation file it is given, the runner imports the sibling
 *   `<name>.test.mjs`, runs every case it exports and writes a JUnit
 *   report. A test file that fails to load is reported as Vitest reports it:
 *   one failing testcase named after its file. A file with no test leaves a
 *   report of no testcase.
 * - The TaskGraph is on disk at `.loom/active_task_graph.json`, T1 owing the
 *   check from the base commit.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../../src/core/plain-record";
import { freezeVerificationManifest, type FrozenVerificationManifest, type TaskMutationCheckSetting } from "../../src/core/verification-manifest";
import { StateManager } from "../../src/state-manager";
import type { TaskGraph } from "../../src/types";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "./canonical-temp-dir";
import { stateFileJson, task, writeStateFile } from "./contract-status-fixtures";
import { taskFixture } from "./task-lifecycle";

export const LEDGER = Object.freeze({
  impl: "src/ledger.mjs",
  test: "src/ledger.test.mjs",
  runner: "scripts/runner.mjs",
  report: ".loom/completion-reports/affected.junit.xml",
  taskId: "T1",
});

/**
 * The tests the Task wrote. `strong` asserts the guard on both sides of its
 * boundary; `weak` never makes the guard's condition true; `red` fails on the
 * unmutated code; `none` writes no test file.
 */
export type LedgerTests = "strong" | "weak" | "red" | "none";

export type TaskMutationRepoOptions = Readonly<{
  tests: LedgerTests;
  taskMutationCheck?: TaskMutationCheckSetting;
  /** `absent` leaves the Task without a `start_sha`. */
  startSha?: "base" | "absent";
}>;

export type TaskMutationRepo = Readonly<{
  root: CanonicalRepositoryRoot;
  statePath: string;
  graph: TaskGraph;
  /** Rewrite one of the Task's files in the real workspace. */
  write: (path: string, text: string) => void;
  /** The repository's worktree paths, the main one first. */
  worktrees: () => readonly string[];
}>;

const BASE_IMPL = "export function debit(balance, amount) {\n  return balance - amount;\n}\n";

/** The Task's implementation: line 2 is the one line it added. */
export const GUARDED_IMPL = [
  "export function debit(balance, amount) {",
  '  if (amount <= 0) throw new RangeError("amount must be positive");',
  "  return balance - amount;",
  "}",
  "",
].join("\n");

const CASES: Readonly<Record<Exclude<LedgerTests, "none">, readonly string[]>> = Object.freeze({
  weak: ['  { name: "debits", run: () => equal(debit(10, 3), 7) },'],
  strong: [
    '  { name: "debits", run: () => equal(debit(10, 3), 7) },',
    '  { name: "refuses zero", run: () => throws(() => debit(10, 0)) },',
    '  { name: "refuses a negative amount", run: () => throws(() => debit(10, -1)) },',
  ],
  red: ['  { name: "debits", run: () => equal(debit(10, 3), 8) },'],
});

export const ledgerTestText = (tests: Exclude<LedgerTests, "none">): string => [
  'import { debit } from "./ledger.mjs";',
  "const equal = (actual, expected) => { if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`); };",
  'const throws = (run) => { try { run(); } catch { return; } throw new Error("expected a throw"); };',
  "export const cases = [",
  ...CASES[tests],
  "];",
  "",
].join("\n");

const RUNNER = `import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPORT = ${JSON.stringify(LEDGER.report)};
const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const testcases = [];
for (const file of process.argv.slice(2)) {
  const test = file.replace(/\\.mjs$/, ".test.mjs");
  if (!existsSync(test)) continue;
  let cases;
  try {
    ({ cases } = await import(pathToFileURL(resolve(test)).href));
  } catch {
    testcases.push({ file: test, name: test, failed: true });
    continue;
  }
  for (const { name, run } of cases) {
    let failed = false;
    try { run(); } catch { failed = true; }
    testcases.push({ file: test, name, failed });
  }
}
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, '<testsuites><testsuite name="ledger" tests="' + testcases.length + '">' +
  testcases.map(({ file, name, failed }) =>
    '<testcase classname="' + escape(file) + '" name="' + escape(name) + '">' + (failed ? "<failure/>" : "") + "</testcase>").join("") +
  "</testsuite></testsuites>");
process.exit(testcases.some(({ failed }) => failed) ? 1 : 0);
`;

const created: string[] = [];

/** Remove every fixture repository built so far. */
export function cleanupTaskMutationRepos(): void {
  for (let directory = created.pop(); directory !== undefined; directory = created.pop()) rmSync(directory, { recursive: true, force: true });
}

const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function manifestOf(setting: TaskMutationCheckSetting | undefined): FrozenVerificationManifest {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    kind: "loom-verification-manifest",
    checks: [],
    testFileSuffixes: [".test.mjs"],
    affectedRunner: {
      executable: "node", args: [LEDGER.runner, "{files}"], cwd: ".", timeoutMs: 30_000,
      report: { kind: "required-file", path: LEDGER.report },
    },
    ...(setting === undefined ? {} : { taskMutationCheck: setting }),
  })));
  if (!frozen.ok) throw new Error(`fixture manifest refused: ${frozen.error.errors.join("; ")}`);
  return frozen.value;
}

/** Build one fixture repository; `cleanupTaskMutationRepos` removes it. */
export function taskMutationRepo(options: TaskMutationRepoOptions): TaskMutationRepo {
  const directory = canonicalTempDir("loom-task-mutation-");
  created.push(directory);
  const parsed = parseCanonicalRepositoryRoot(directory);
  if (!parsed.ok) throw new Error(`fixture root is not canonical: ${directory}`);
  const root = parsed.value;
  git(root, "init", "-q");
  git(root, "config", "user.email", "loom-tests@example.invalid");
  git(root, "config", "user.name", "Loom Tests");
  write(root, ".gitignore", ".loom/\n");
  write(root, LEDGER.impl, BASE_IMPL);
  write(root, LEDGER.runner, RUNNER);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture base");
  const base = git(root, "rev-parse", "HEAD");

  write(root, LEDGER.impl, GUARDED_IMPL);
  if (options.tests !== "none") write(root, LEDGER.test, ledgerTestText(options.tests));

  const owing = taskFixture({
    ...task(LEDGER.taskId, 1, [LEDGER.impl, LEDGER.test]),
    ...(options.startSha === "absent" ? {} : { start_sha: base }),
  });
  const raw: unknown = JSON.parse(stateFileJson([owing]));
  if (!isRecord(raw)) throw new Error("a State File is a JSON object");
  const statePath = writeStateFile(root, JSON.stringify({ ...raw, verification_manifest: manifestOf(options.taskMutationCheck) }));
  return Object.freeze({
    root,
    statePath,
    graph: new StateManager(statePath).load(),
    write: (path: string, text: string) => write(root, path, text),
    worktrees: () => git(root, "worktree", "list", "--porcelain").split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length)),
  });
}
