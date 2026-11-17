/**
 * `helper retro-facts` (ADR-0083): read-only JSON over a live or archived
 * TaskGraph. The derivation itself is pinned in tests/core/retro-facts.test.ts.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRetroFactsHandler } from "../../../src/handlers/helpers/retro-facts";
import { KNOWN_HANDLERS } from "../../../src/handler-routes";
import { newWaveGate } from "../../../src/core/wave-gate-model";
import type { Task, TaskGraph } from "../../../src/types";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { implementationEscalatedTaskFields } from "../../fixtures/implementation-escalation";
import { i6PlanTask } from "../../fixtures/i6-plan-task";
import { i6RunnerManifest } from "../../fixtures/i6-runner-manifest";
import { protectedGraphFixture } from "../../fixtures/task-lifecycle";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An archived-style graph file: Wave 1 active, T1 escalated. */
function archive(): string {
  const root = canonicalTempDir("loom-retro-facts-");
  roots.push(root);
  mkdirSync(join(root, "archive"), { recursive: true });
  const graph: TaskGraph = protectedGraphFixture({
    spec_trace_version: 2, current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: null, current_wave: 1, executing_tasks: [],
    verification_manifest: i6RunnerManifest(), wave_gates: { "1": newWaveGate() },
    tasks: [{ ...i6PlanTask("T1", 1, ["src/t1.ts", "src/t1.test.ts"]), ...implementationEscalatedTaskFields() } as Task],
  });
  const path = join(root, "archive", "completed_task_graph-no-issue-20261117T000000Z.json");
  writeFileSync(path, JSON.stringify(graph));
  return path;
}

async function run(args: readonly string[]): Promise<Readonly<{ result: unknown; out: string }>> {
  let out = "";
  const result = await createRetroFactsHandler((text) => { out += text; })("", [...args]);
  return { result, out };
}

describe("helper retro-facts", () => {
  it("is a routed helper", () => {
    expect(KNOWN_HANDLERS.helper?.has("retro-facts")).toBe(true);
  });

  it("prints every Wave's facts and suggestions for a named graph", async () => {
    const path = archive();
    const { result, out } = await run(["--graph", path]);
    expect(result).toEqual({ kind: "passthrough" });
    const parsed = JSON.parse(out) as { graph: string; facts: { waves: { wave: number; escalations: number }[] }; suggestions: { wave: number }[] };
    expect(parsed.graph).toBe(path);
    expect(parsed.facts.waves).toMatchObject([{ wave: 1, escalations: 1 }]);
    expect(parsed.suggestions.map(({ wave }) => wave)).toEqual([1]);
  });

  it("narrows to one Wave's digest and its suggestion", async () => {
    const { out } = await run(["--wave", "1", "--graph", archive()]);
    expect(JSON.parse(out)).toMatchObject({ wave: { wave: 1 }, engineRevisionAdoptions: 0, suggestion: { wave: 1 } });
  });

  it.each<[readonly string[], string]>([
    [["--wave", "0"], "--wave must be a positive integer"],
    [["--wave", "1", "--wave", "2"], "--wave is given twice"],
    [["--file", "x"], "unknown argument '--file'"],
    [["--graph"], "--graph needs a value"],
  ])("refuses %j", async (args, problem) => {
    expect((await run(args)).result).toMatchObject({ kind: "error", message: expect.stringContaining(problem) });
  });

  it("refuses a Wave the graph does not have, and a path it cannot read", async () => {
    expect((await run(["--wave", "9", "--graph", archive()])).result).toMatchObject({ kind: "error", message: expect.stringContaining("has no Wave 9") });
    expect((await run(["--graph", "/nowhere/graph.json"])).result).toMatchObject({ kind: "error", message: expect.stringContaining("cannot read the TaskGraph") });
  });
});
