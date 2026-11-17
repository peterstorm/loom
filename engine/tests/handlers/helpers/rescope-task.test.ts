/**
 * The `helper orchestration rescope-task` shell (loom#198, Cause 3): route
 * traits, the quiescence protocol, the start_sha baseline read, and refusals
 * that leave the State File untouched. The decision itself is pinned in
 * tests/core/task-rescope.test.ts.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRescopeTaskOperation, type BaselineReader } from "../../../src/handlers/helpers/rescope-task";
import { ORCHESTRATION_OPERATIONS } from "../../../src/handlers/helpers/orchestration-operations";
import { piRuntimeHandshakeRequired, routeConsumesStdin } from "../../../src/handler-routes";
import { newWaveGate } from "../../../src/core/wave-gate-model";
import type { Task, TaskGraph } from "../../../src/types";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { i6RunnerManifest } from "../../fixtures/i6-runner-manifest";
import { appearsUnderTheLock } from "../../fixtures/subagent-activity";
import { i6PendingTaskFixture, protectedGraphFixture } from "../../fixtures/task-lifecycle";

const cleanup: string[] = [];
let previousStatePath: string | undefined;
afterEach(() => {
  if (previousStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousStatePath;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A pending new-tests Task of Wave 1 under the I6-era manifest. */
const pendingTask = (id: string, fileList: readonly string[], extra: Partial<Task> = {}): Task => i6PendingTaskFixture({
  id, description: id, agent: "code-implementer-agent", wave: 1, depends_on: [],
  file_list: [...fileList], spec_anchors: [], spec_contributions: [], review_status: "pending",
  verification_policy: { regression: { kind: "required" }, new_tests: { kind: "required" } },
  ...extra,
});

/** Wave 1 current with pending T1 (no test file) and T2, in `root` (a fresh temp dir by default). */
function installState(t1: Task = pendingTask("T1", ["src/t1.ts"]), root = canonicalTempDir("loom-rescope-task-")): string {
  previousStatePath = process.env.LOOM_STATE_PATH;
  cleanup.push(root);
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  const graph: TaskGraph = protectedGraphFixture({
    spec_trace_version: 2,
    current_phase: "execute",
    current_wave: 1,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    executing_tasks: [],
    verification_manifest: i6RunnerManifest(),
    wave_gates: { "1": newWaveGate() },
    tasks: [t1, pendingTask("T2", ["src/t2.ts", "src/t2.test.ts"])],
  });
  writeFileSync(statePath, JSON.stringify(graph));
  process.env.LOOM_STATE_PATH = statePath;
  return statePath;
}

const ARGS = ["--task", "T1", "--add-file", "src/t1.test.ts", "--reason", "T1 needs its test file"] as const;
const quiet = () => false;
const noRead: BaselineReader = () => { throw new Error("no baseline read is owed"); };

type Written = Readonly<{ tasks: readonly Task[]; wave_plan_edits?: readonly Readonly<Record<string, unknown>>[] }>;
const written = (statePath: string): Written => JSON.parse(readFileSync(statePath, "utf8")) as Written;

describe("rescope-task route traits", () => {
  it("takes only flags, requires the Pi runtime handshake and is parent-only, like every mutating operation", () => {
    expect(ORCHESTRATION_OPERATIONS["rescope-task"]).toEqual({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" });
    expect(routeConsumesStdin("helper", "orchestration", ["rescope-task", ...ARGS])).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "orchestration", ["rescope-task", ...ARGS])).toBe(true);
  });
});

describe("rescope-task shell", () => {
  it("commits the re-scope and its audit, reading no baseline when the Task carries none", async () => {
    const statePath = installState();
    expect(await createRescopeTaskOperation(quiet, noRead)([...ARGS])).toEqual({ kind: "allow" });
    const graph = written(statePath);
    expect(graph.tasks.find(({ id }) => id === "T1")?.file_list).toEqual(["src/t1.ts", "src/t1.test.ts"]);
    expect(graph.wave_plan_edits).toEqual([{
      schemaVersion: 1, kind: "task-rescoped", wave: 1, taskId: "T1",
      added: ["src/t1.test.ts"], removed: [], baselineRevision: null, reason: "T1 needs its test file",
    }]);
  });

  it("is idempotent: a repeat leaves the State File byte-identical", async () => {
    const statePath = installState();
    await createRescopeTaskOperation(quiet, noRead)([...ARGS]);
    const once = readFileSync(statePath, "utf8");
    expect(await createRescopeTaskOperation(quiet, noRead)([...ARGS])).toEqual({ kind: "allow" });
    expect(readFileSync(statePath, "utf8")).toBe(once);
  });

  it("reads the added files at the Task's start_sha and extends its baseline", async () => {
    const start = "b".repeat(40);
    const statePath = installState(pendingTask("T1", ["src/t1.ts"], {
      start_sha: start,
      artifact_baseline: [{ artifact: "src/t1.ts", snapshot: { kind: "sha256", digest: "1".repeat(64) } }],
    }));
    const reads: unknown[] = [];
    const reader: BaselineReader = (_statePath, duty) => {
      reads.push(duty);
      return { revision: duty.revision, entries: [{ artifact: "src/t1.test.ts", snapshot: { kind: "missing" } }] };
    };
    expect(await createRescopeTaskOperation(quiet, reader)([...ARGS])).toEqual({ kind: "allow" });
    expect(reads).toEqual([{ revision: start, paths: ["src/t1.test.ts"] }]);
    const t1 = written(statePath).tasks.find(({ id }) => id === "T1");
    expect(t1?.artifact_baseline?.map(({ artifact }) => artifact)).toEqual(["src/t1.ts", "src/t1.test.ts"]);
    expect(written(statePath).wave_plan_edits?.[0]).toMatchObject({ baselineRevision: start });
  });

  it("refuses without writing when the baseline read fails", async () => {
    const statePath = installState(pendingTask("T1", ["src/t1.ts"], {
      start_sha: "b".repeat(40),
      artifact_baseline: [{ artifact: "src/t1.ts", snapshot: { kind: "sha256", digest: "1".repeat(64) } }],
    }));
    const before = readFileSync(statePath, "utf8");
    const failing: BaselineReader = () => { throw new Error("bad object bbbb"); };
    expect(await createRescopeTaskOperation(quiet, failing)([...ARGS]))
      .toEqual({ kind: "error", message: "rescope-task refused without changing state: bad object bbbb" });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("reads the start_sha baseline from Git through the production reader", async () => {
    const root = canonicalTempDir("loom-rescope-task-git-");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "--quiet");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "t1.test.ts"), "// written before the Task started\n");
    git("add", ".");
    git("-c", "user.email=loom@example.invalid", "-c", "user.name=loom", "commit", "--quiet", "-m", "start");
    const start = git("rev-parse", "HEAD");
    writeFileSync(join(root, "src", "t1.test.ts"), "// changed after the Task started\n");
    const statePath = installState(pendingTask("T1", ["src/t1.ts"], {
      start_sha: start,
      artifact_baseline: [{ artifact: "src/t1.ts", snapshot: { kind: "missing" } }],
    }), root);

    expect(await createRescopeTaskOperation(quiet)([...ARGS])).toEqual({ kind: "allow" });

    const baseline = written(statePath).tasks.find(({ id }) => id === "T1")?.artifact_baseline;
    const added = baseline?.find(({ artifact }) => artifact === "src/t1.test.ts");
    expect(added?.snapshot.kind).toBe("sha256");
    const startBytes = execFileSync("git", ["show", `${start}:src/t1.test.ts`], { cwd: root });
    const { createHash } = await import("node:crypto");
    expect(added?.snapshot).toEqual({ kind: "sha256", digest: createHash("sha256").update(startBytes).digest("hex") });
  });

  it("refuses malformed arguments before reading any graph", async () => {
    const result = await createRescopeTaskOperation(quiet, noRead)(["--task", "T1", "--reason", "r"]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("name at least one --add-file or --remove-file") });
  });

  it("refuses without writing while a subagent is active", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const result = await createRescopeTaskOperation(() => true, noRead)([...ARGS]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("refused while a subagent is active") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("re-checks for a subagent under the lock and refuses without writing when one appeared", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const { probe, observations } = appearsUnderTheLock();
    const result = await createRescopeTaskOperation(probe, noRead)([...ARGS]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("became active before the task re-scope could commit") });
    expect(observations()).toBe(2);
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses a decision without writing, naming the cause", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const result = await createRescopeTaskOperation(quiet, noRead)(["--task", "T2", "--remove-file", "src/t2.test.ts", "--reason", "r"]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringMatching(/^rescope-task refused without changing state: Task T2 requires new tests/) });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });
});
