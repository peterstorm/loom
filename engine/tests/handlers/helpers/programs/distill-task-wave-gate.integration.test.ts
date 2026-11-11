/**
 * A registered Wave Gate over a Wave that carries a Distill Task (ADR-0068
 * §6), driven through the real CLI façade: the Distill Task is registered
 * with its Wave, issued no reviewer, and completes with the Wave unreviewed.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BASE_WAVE_REVIEW_AGENTS } from "../../../../src/core/agent-catalog-projections";
import type { AgentRequestAuthority } from "../../../../src/core/orchestration-contract";
import { readWaveReviewContext } from "../../../../src/core/wave-review-authority";
import { parseRegisteredFacadeProgram } from "../../../../src/handlers/helpers/programs/registration";
import { openRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { parseTaskGraph } from "../../../../src/state-manager";
import type { TaskGraph } from "../../../../src/types";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";
import { collectedChild } from "../../../fixtures/collected-child";
import { facadeParentEnvironment } from "../../../fixtures/facade-parent";
import { git as gitWithEnvironment, PINNED_COMMIT_DATES } from "../../../fixtures/git-repository";
import { value } from "../../../fixtures/parse-result";
import { disposeFixturePiSessions } from "../../../fixtures/pi-session";
import { distillTaskFixture, graphFixture, satisfiedProof, taskFixture } from "../../../fixtures/task-lifecycle";

const cli = fileURLToPath(new URL("../../../../src/cli.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => { disposeFixturePiSessions(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const specText = `# Feature: Distilled Wave fixture

## User Scenarios

### US1: Review a distilled Wave

**Acceptance Scenarios:**
- AS-001: Given evidence, When accepted, Then the Wave progresses

## Functional Requirements

- FR-001: System MUST review the exact Wave

## Out of Scope

- OOS-001: Unrelated work

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Wave evidence | Exact issued evidence |
`;
const specPass = "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED\n";

type Project = Readonly<{ root: string; statePath: string; runsRoot: string }>;
type Action = Readonly<{ kind: string; requests?: readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[];
  diagnostic?: { message: string }; outcome?: unknown }>;

/** Wave 1: implemented T1 over `src/x.ts`, and its Distill Task T2 over the same file in `distillStatus`. */
function project(distillStatus: "pending" | "implemented"): Project {
  const root = canonicalTempDir("loom-distill-wave-");
  roots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "runs"));
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "spec.md"), specText);
  writeFileSync(join(root, "plan.md"), "# Model-free plan\n");
  gitWithEnvironment(root, ["init", "-q"], PINNED_COMMIT_DATES);
  gitWithEnvironment(root, ["add", "src/x.ts", "spec.md", "plan.md"], PINNED_COMMIT_DATES);
  gitWithEnvironment(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"], PINNED_COMMIT_DATES);
  const graph: TaskGraph = { ...graphFixture([
    taskFixture({ id: "T1", description: "review fixture", agent: "code-implementer-agent", wave: 1,
      depends_on: [], status: "implemented", proof: satisfiedProof(["src/x.ts"]), file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
      spec_anchors: ["FR-001", "AS-001"], spec_contributions: [], test_result: { verdict: "trusted-pass" },
      test_evidence: "fixture checks passed", new_tests_written: true, new_test_evidence: "fixture tests present",
      review_generation: 0, review_status: "pending", critical_findings: [], advisory_findings: [] }),
    distillTaskFixture({ id: "T2", wave: 1, scope: ["src/x.ts"], status: distillStatus, files_modified: [], review_generation: 0 }),
  ]), spec_file: join(root, "spec.md"), plan_file: join(root, "plan.md"), spec_trace_version: 2 };
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  writeFileSync(statePath, JSON.stringify(value(parseTaskGraph(graph))));
  return { root, statePath, runsRoot: join(root, "runs") };
}

function cliResult(p: Project, args: readonly string[], stdin = "") {
  return collectedChild("bun", [cli, "helper", "orchestration", ...args], { cwd: p.root, env: facadeParentEnvironment("pi", p.root) }, stdin);
}
async function runCli(p: Project, args: readonly string[], stdin = ""): Promise<Action> {
  const result = await cliResult(p, args, stdin);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Action;
}
const startArgs = (p: Project) => ["start", "wave-gate", "--runs-root", p.runsRoot, "--run", "run.distilled"];
const graph = (p: Project) => value(parseTaskGraph(JSON.parse(readFileSync(p.statePath, "utf8"))));

function reviewerPayload(handle: RunDirHandle, request: AgentRequestAuthority): string {
  const packet = value(handle.readContext(request.contextDigest));
  const context = readWaveReviewContext([packet], packet.digest);
  if (context.kind !== "loaded" || context.value.taskRun === null) throw new Error("expected issued Task context");
  return JSON.stringify({ schemaVersion: 2, kind: "wave-review", packetId: context.value.packetId,
    generation: context.value.taskRun.generation, prior_findings: [], findings: [] });
}

describe("registered Wave Gate over a Wave with a Distill Task", () => {
  it("registers the Distill Task, issues reviewers for its sibling only, and completes both", async () => {
    const p = project("implemented");
    const action = await runCli(p, startArgs(p), JSON.stringify({ wave: 1 }));
    expect(action.kind, JSON.stringify(action)).toBe("spawn-batch");
    const handle = value(openRunDirectory(p.runsRoot, "run.distilled"));
    const registered = parseRegisteredFacadeProgram(value(handle.readProgramRegistration()));
    if (registered.kind !== "registered" || registered.program.kind !== "wave-gate") throw new Error("expected Wave registration");
    expect(registered.program.taskIds).toEqual(["T1", "T2"]);

    const issued = action.requests!;
    expect(issued.map(({ authority }) => authority.role)).toEqual(["spec-check-invoker", ...BASE_WAVE_REVIEW_AGENTS]);
    for (const { authority } of issued.slice(1)) {
      const packet = value(handle.readContext(authority.contextDigest));
      const context = readWaveReviewContext([packet], packet.digest);
      expect(context.kind === "loaded" && context.value.taskRun?.taskId).toBe("T1");
    }
    const [t1, t2] = graph(p).tasks;
    expect(t1!.review_run?.expected_agents).toEqual(BASE_WAVE_REVIEW_AGENTS);
    expect(t2).toMatchObject({ status: "implemented", review_status: "pending" });
    expect(t2!.review_run).toBeUndefined();

    value(await handle.captureTranscript(issued[0]!.authority, [...Buffer.from(specPass)]));
    let last: Action = action;
    for (const { authority } of issued.slice(1)) {
      last = await runCli(p, ["submit", "--runs-root", p.runsRoot, "--run", handle.runId, "--request", authority.requestId,
        "--slot", authority.slotId, "--attempt", String(authority.attempt)], reviewerPayload(handle, authority));
    }
    expect(last.kind, JSON.stringify(last)).toBe("done");

    const completed = graph(p);
    expect(completed.tasks.map(({ id, status, review_status }) => ({ id, status, review_status }))).toEqual([
      { id: "T1", status: "completed", review_status: "passed" },
      { id: "T2", status: "completed", review_status: "pending" },
    ]);
    expect(completed.tasks[0]!.accepted_review_authority).toBeDefined();
    expect(completed.tasks[1]!.accepted_review_authority).toBeUndefined();
    expect(completed.active_wave_gate).toBeUndefined();
    expect(completed.wave_gate_history).toHaveLength(1);

    // The completed run replays: the Distill Task owes its roster no published protocol.
    const before = readFileSync(p.statePath);
    expect(await runCli(p, ["resume", "--runs-root", p.runsRoot, "--run", handle.runId])).toEqual(last);
    expect(readFileSync(p.statePath)).toEqual(before);
  }, 90_000);

  it("refuses to start while the Distill Task is still pending, changing no state", async () => {
    const p = project("pending");
    const before = readFileSync(p.statePath);
    const refused = await cliResult(p, startArgs(p), JSON.stringify({ wave: 1 }));
    expect(`${refused.stdout}${refused.stderr}`).toContain("Not all tasks have satisfied implementation proof");
    expect(`${refused.stdout}${refused.stderr}`).toContain("T2 (status=pending");
    expect(readFileSync(p.statePath)).toEqual(before);
  }, 30_000);
});
