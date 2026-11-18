/**
 * The `helper orchestration disposition` shell (ADR-0090): route traits, the
 * quiescence protocol, the anchor bytes it observes, and refusals that leave
 * the State File untouched. The decision itself is pinned in
 * tests/core/advisory-disposition.test.ts.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anchorDigest } from "../../../src/core/advisory-disposition";
import { reviewedWorkspaceObservation } from "../../../src/core/reviewed-workspace";
import { taskReviewScope } from "../../../src/core/wave-review-authority";
import { newWaveGate } from "../../../src/core/wave-gate-model";
import { createAdvisoryDispositionOperation, type ReviewedWorkspaceObserver } from "../../../src/handlers/helpers/advisory-disposition";
import { ORCHESTRATION_OPERATIONS } from "../../../src/handlers/helpers/orchestration-operations";
import { piRuntimeHandshakeRequired, routeConsumesStdin } from "../../../src/handler-routes";
import type { TaskGraph } from "../../../src/types";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { findingFixture } from "../../fixtures/finding";
import { i6PlanTask } from "../../fixtures/i6-plan-task";
import { i6RunnerManifest } from "../../fixtures/i6-runner-manifest";
import { value } from "../../fixtures/parse-result";
import { appearsUnderTheLock } from "../../fixtures/subagent-activity";
import { protectedGraphFixture } from "../../fixtures/task-lifecycle";

const cleanup: string[] = [];
let previousStatePath: string | undefined;
afterEach(() => {
  if (previousStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousStatePath;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const ADVICE = findingFixture("code-reviewer-1", "advisory", "src/t1.ts");

/** Wave 1 current: T1 carries one advisory, T2 none. */
function installState(): string {
  previousStatePath = process.env.LOOM_STATE_PATH;
  const root = canonicalTempDir("loom-advisory-disposition-");
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
    tasks: [
      i6PlanTask("T1", 1, ["src/t1.ts", "src/t1.test.ts"], {
        findings: [ADVICE], critical_findings: [], advisory_findings: [ADVICE.claim],
      }),
      i6PlanTask("T2", 1, ["src/t2.ts", "src/t2.test.ts"]),
    ],
  });
  writeFileSync(statePath, JSON.stringify(graph));
  process.env.LOOM_STATE_PATH = statePath;
  return statePath;
}

/** The reviewed bytes of each Task, as its declared files holding `content`. */
const observer = (content: string): ReviewedWorkspaceObserver => (tasks) => tasks.map((task) => {
  const scope = taskReviewScope(task);
  return value(reviewedWorkspaceObservation(task.id, scope, scope.map((path) => ({ path, bytes: Buffer.from(`${path}:${content}`) }))));
});

const STDIN = JSON.stringify({ dispositions: [{ finding: "T1:code-reviewer-1", decision: "deferred", reason: "next Wave owns it", target: "Wave 2" }] });
const quiet = () => false;
type Written = Readonly<{ advisory_dispositions?: readonly Readonly<Record<string, unknown>>[] }>;
const written = (statePath: string): Written => JSON.parse(readFileSync(statePath, "utf8")) as Written;

describe("disposition route traits", () => {
  it("reads stdin, requires the Pi runtime handshake and is parent-only, like every mutating operation", () => {
    expect(ORCHESTRATION_OPERATIONS.disposition).toEqual({ input: "stdin", runtimeSkew: "handshake-required", subagent: "parent-only" });
    expect(routeConsumesStdin("helper", "orchestration", ["disposition"])).toBe(true);
    expect(piRuntimeHandshakeRequired("helper", "orchestration", ["disposition"])).toBe(true);
  });
});

describe("disposition shell", () => {
  it("commits the record anchored to the observed bytes, and repeating it changes nothing", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const statePath = installState();
    const observe = observer("v1");
    expect(await createAdvisoryDispositionOperation(quiet, observe)(STDIN)).toEqual({ kind: "allow" });
    const [t1] = JSON.parse(readFileSync(statePath, "utf8")).tasks;
    const [workspace] = observe([t1]);
    expect(written(statePath).advisory_dispositions).toEqual([{
      schemaVersion: 1, wave: 1, taskId: "T1", findingId: "code-reviewer-1", decision: "deferred",
      reason: "next Wave owns it", target: "Wave 2", anchor: anchorDigest("src/t1.ts", workspace!.artifacts),
    }]);
    const before = readFileSync(statePath, "utf8");
    expect(await createAdvisoryDispositionOperation(quiet, observe)(STDIN)).toEqual({ kind: "allow" });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("reports only once committed: a failed report is never a refusal that left the record behind", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => { throw new Error("stdout closed"); });
    const statePath = installState();
    await expect(createAdvisoryDispositionOperation(quiet, observer("v1"))(STDIN)).rejects.toThrow("stdout closed");
    expect(written(statePath).advisory_dispositions).toHaveLength(1);
  });

  it("observes only the named Tasks of the active Wave", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    installState();
    const seen: string[] = [];
    const recording: ReviewedWorkspaceObserver = (tasks) => {
      seen.push(...tasks.map(({ id }) => id));
      return observer("v1")(tasks);
    };
    expect(await createAdvisoryDispositionOperation(quiet, recording)(STDIN)).toEqual({ kind: "allow" });
    expect(seen).toEqual(["T1"]);
  });

  it("refuses malformed input before reading any graph", async () => {
    const result = await createAdvisoryDispositionOperation(quiet, observer("v1"))(JSON.stringify({ dispositions: [] }));
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("dispositions must be a non-empty array") });
  });

  it("refuses an advisory the active Wave does not hold, without writing", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const stdin = JSON.stringify({ dispositions: [{ finding: "T2:code-reviewer-1", decision: "fixed", reason: "done" }] });
    const result = await createAdvisoryDispositionOperation(quiet, observer("v1"))(stdin);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("is not an advisory of a Task in the active Wave 1") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses without writing when the workspace cannot be observed", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    const failing: ReviewedWorkspaceObserver = () => { throw new Error("git is unavailable"); };
    expect(await createAdvisoryDispositionOperation(quiet, failing)(STDIN)).toMatchObject({
      kind: "error", message: expect.stringContaining("git is unavailable"),
    });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses without writing while a subagent is active, before or under the lock", async () => {
    const statePath = installState();
    const before = readFileSync(statePath, "utf8");
    expect(await createAdvisoryDispositionOperation(() => true, observer("v1"))(STDIN)).toMatchObject({
      kind: "error", message: expect.stringContaining("refused while a subagent is active"),
    });
    expect(await createAdvisoryDispositionOperation(appearsUnderTheLock().probe, observer("v1"))(STDIN)).toMatchObject({ kind: "error" });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });
});
