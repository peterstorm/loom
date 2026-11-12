/**
 * `helper mutation-check` as a shell (ADR-0071), over injected ports: a fake
 * runner, a fixed repository root and a record directory of its own, so each
 * branch the handler owns is pinned without Git or a real runner:
 * - the command line: a missing `--task` and an unknown argument are errors;
 * - the TaskGraph: none at the path, or one that does not load, is an error;
 *   a Task it does not hold is an error;
 * - a Task that owes nothing is a printed answer, and nothing runs;
 * - no repository root, or declared files that cannot be digested, is a
 *   printed `unavailable`, and nothing runs;
 * - the digest before and after the run: files that changed while it ran make
 *   the result `unavailable`, recorded under the digest observed before, so
 *   the next stop reads it as stale;
 * - a record that cannot be written is an error that still carries the result.
 */

import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "../../../src/core/plain-record";
import { renderTaskMutationReport, taskMutationDuty, type TaskMutationResult } from "../../../src/core/task-mutation-check";
import { createMutationCheckHandler, type MutationCheckPorts } from "../../../src/handlers/helpers/mutation-check";
import { observeTaskMutation, readTaskMutationRecord } from "../../../src/orchestration/task-mutation-record";
import type { TaskMutationRunInput } from "../../../src/orchestration/task-mutation-runner";
import { StateManager } from "../../../src/state-manager";
import type { HookResult } from "../../../src/types";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../../../src/utils/workspace-digest";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { stateFileJson, task, writeStateFile } from "../../fixtures/contract-status-fixtures";
import { taskFixture } from "../../fixtures/task-lifecycle";
import { mutationManifest, START_SHA, talliedResult, type MutationManifestOverrides } from "../../fixtures/task-mutation";

const IMPL = "src/ledger.ts";
const TEST = "src/ledger.test.ts";
const CLEAN = talliedResult({ killed: 2, candidates: 3 });

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

function tempDir(prefix: string): string {
  const directory = canonicalTempDir(prefix);
  temporary.push(directory);
  return directory;
}

type Workspace = Readonly<{ root: CanonicalRepositoryRoot; statePath: string; records: string; write: (path: string, text: string) => void }>;

/** A repository root holding T1's declared files and a TaskGraph under which T1 owes the check. */
function workspace(manifest: MutationManifestOverrides = {}): Workspace {
  const directory = tempDir("loom-mutation-check-helper-");
  const parsed = parseCanonicalRepositoryRoot(directory);
  if (!parsed.ok) throw new Error(`fixture root is not canonical: ${directory}`);
  const root = parsed.value;
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write(IMPL, "export const debit = (balance: number, amount: number): number => balance - amount;\n");
  write(TEST, "// the Task's test\n");
  const raw: unknown = JSON.parse(stateFileJson([taskFixture({ ...task("T1", 1, [IMPL, TEST]), start_sha: START_SHA })]));
  if (!isRecord(raw)) throw new Error("a State File is a JSON object");
  const statePath = writeStateFile(root, JSON.stringify({ ...raw, verification_manifest: mutationManifest(manifest) }));
  return { root, statePath, records: tempDir("loom-mutation-check-records-"), write };
}

type Ran = Readonly<{ result: HookResult; printed: string; runs: number }>;

/** Run the handler over `at` with `run` as its runner; what it returned, printed, and how often it ran. */
async function helper(
  at: Workspace,
  args: readonly string[] = ["--task", "T1"],
  overrides: Partial<MutationCheckPorts> = {},
  run: (input: TaskMutationRunInput) => Promise<TaskMutationResult> = async () => CLEAN,
): Promise<Ran> {
  process.env.LOOM_STATE_PATH = at.statePath;
  const printed: string[] = [];
  let runs = 0;
  const handler = createMutationCheckHandler({
    write: (text) => { printed.push(text); },
    repositoryRoot: () => ({ ok: true, root: at.root }),
    run: async (input) => { runs++; return run(input); },
    now: () => 0,
    recordDirectory: at.records,
    ...overrides,
  });
  return { result: await handler("", [...args]), printed: printed.join(""), runs };
}

/** How T1's record stands against its files now. */
function standing(at: Workspace) {
  const graph = new StateManager(at.statePath).load();
  const duty = taskMutationDuty(graph, "T1");
  if (duty.kind !== "owed") throw new Error("the fixture Task owes the check");
  const observed = observeTaskMutation("/opt/loom", () => at.records)(duty, at.root);
  return observed.kind === "observed" ? observed.standing : observed;
}

describe("helper mutation-check: what it refuses", () => {
  it.each<[string, readonly string[], RegExp]>([
    ["no --task", [], /mutation-check requires --task <task-id>/],
    ["an unknown argument", ["--task", "T1", "--force"], /unknown or unconsumed argument\(s\): --force/],
    ["a Task the TaskGraph does not hold", ["--task", "T9"], /mutation-check: Task T9 is not in the TaskGraph at /],
  ])("refuses %s as an error, printing and running nothing", async (_label, args, message) => {
    const { result, printed, runs } = await helper(workspace(), args);
    expect(result).toMatchObject({ kind: "error", message: expect.stringMatching(message) });
    expect(printed).toBe("");
    expect(runs).toBe(0);
  });

  it("refuses a missing TaskGraph as an error", async () => {
    const at = workspace();
    rmSync(at.statePath);
    const { result, runs } = await helper(at);
    expect(result).toEqual({ kind: "error", message: `No task graph at ${at.statePath}` });
    expect(runs).toBe(0);
  });

  it("refuses a TaskGraph that does not load as an error", async () => {
    const at = workspace();
    writeFileSync(at.statePath, "{ not a task graph");
    const { result, printed, runs } = await helper(at);
    expect(result.kind).toBe("error");
    expect(printed).toBe("");
    expect(runs).toBe(0);
  });
});

describe("helper mutation-check: answers that run nothing", () => {
  it("prints that a Task owes nothing, exits 0, and writes no record", async () => {
    const at = workspace({ taskMutationCheck: "off" });
    const { result, printed, runs } = await helper(at);
    expect(result).toEqual({ kind: "passthrough" });
    expect(printed).toBe('Task mutation check for T1: not owed — the verification manifest sets taskMutationCheck to "off".\n');
    expect(runs).toBe(0);
    expect(readdirSync(at.records)).toEqual([]);
  });

  it("prints unavailable when the repository root cannot be resolved", async () => {
    const at = workspace();
    const { result, printed, runs } = await helper(at, undefined, { repositoryRoot: () => ({ ok: false, reason: "no Git repository here" }) });
    expect(result).toEqual({ kind: "passthrough" });
    expect(printed).toBe("Task mutation check for T1: unavailable — no Git repository here. It did not decide and will not block your stop.\n");
    expect(runs).toBe(0);
    expect(readdirSync(at.records)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("prints unavailable when a declared file cannot be digested, and runs nothing", async () => {
    const at = workspace();
    chmodSync(join(at.root, IMPL), 0o000);
    try {
      const { result, printed, runs } = await helper(at);
      expect(result).toEqual({ kind: "passthrough" });
      expect(printed).toMatch(/^Task mutation check for T1: unavailable — the Task's files could not be digested: src\/ledger\.ts cannot be read/);
      expect(runs).toBe(0);
    } finally {
      chmodSync(join(at.root, IMPL), 0o600);
    }
  });
});

describe("helper mutation-check: a run and its record", () => {
  it("prints the run's result and records it under the digest of these bytes", async () => {
    const at = workspace();
    const inconclusive = talliedResult({ invalid: 2, candidates: 2 });
    const { result, printed, runs } = await helper(at, undefined, {}, async () => inconclusive);
    expect(result).toEqual({ kind: "passthrough" });
    expect(runs).toBe(1);
    expect(printed).toBe(`${renderTaskMutationReport("T1", inconclusive)}\n`);
    expect(standing(at)).toEqual({ kind: "current", result: inconclusive });
  });

  it("hands the runner the owed duty, the root and its clock", async () => {
    const at = workspace();
    const seen: TaskMutationRunInput[] = [];
    await helper(at, undefined, {}, async (input) => { seen.push(input); return CLEAN; });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ root: at.root, duty: { kind: "owed", taskId: "T1", mutable: [IMPL], declared: [IMPL, TEST] } });
  });

  it("is unavailable, recorded under the digest observed before, when a declared file changed while it ran", async () => {
    const at = workspace();
    const { printed } = await helper(at, undefined, {}, async () => {
      at.write(TEST, "// edited while the check ran\n");
      return CLEAN;
    });
    expect(printed).toContain("unavailable — the Task's files changed while the check ran; run it again once they are settled");
    const recorded = readTaskMutationRecord(at.root, "T1", at.records);
    expect(recorded).toMatchObject({ ok: true, value: { kind: "recorded", taskId: "T1", result: { kind: "unavailable" } } });
    expect(standing(at)).toEqual({ kind: "stale" });
  });

  it.skipIf(process.getuid?.() === 0)("is unavailable when a declared file can no longer be digested after the run", async () => {
    const at = workspace();
    try {
      const { printed } = await helper(at, undefined, {}, async () => {
        chmodSync(join(at.root, TEST), 0o000);
        return CLEAN;
      });
      expect(printed).toContain("unavailable — the Task's files changed while the check ran");
    } finally {
      chmodSync(join(at.root, TEST), 0o600);
    }
  });

  it("returns an unwritable record as an error that still carries the result", async () => {
    const at = workspace();
    const blocked = join(at.records, "not-a-directory");
    writeFileSync(blocked, "");
    const { result, printed, runs } = await helper(at, undefined, { recordDirectory: blocked });
    expect(runs).toBe(1);
    expect(printed).toBe("");
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/^mutation-check: the record could not be written \(.*\); the result was:\nTask mutation check for T1: clean — /s),
    });
  });
});
