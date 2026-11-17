/**
 * Retro records (ADR-0083): the one constructor, the State File round trip,
 * and the `helper record-retro` shell that appends them under the lock.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRecordRetroHandler } from "../../../src/handlers/helpers/record-retro";
import { KNOWN_HANDLERS } from "../../../src/handler-routes";
import { WHITELISTED_HELPERS } from "../../../src/core/guard-state-file";
import { retroRecordEntry, runRetroRecorded } from "../../../src/core/retro-record";
import { newWaveGate } from "../../../src/core/wave-gate-model";
import { parseTaskGraph } from "../../../src/state-file-wire";
import type { TaskGraph } from "../../../src/types";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { i6PlanTask } from "../../fixtures/i6-plan-task";
import { i6RunnerManifest } from "../../fixtures/i6-runner-manifest";
import { protectedGraphFixture } from "../../fixtures/task-lifecycle";

const DIGEST = "a".repeat(64);

describe("retroRecordEntry", () => {
  it("builds a written retro for the run or a Wave, and a skip for the run", () => {
    expect(retroRecordEntry({ kind: "retro-recorded", scope: { kind: "run" }, path: ".claude/retros/run.md", digest: DIGEST })).toEqual({
      ok: true, value: { schemaVersion: 1, kind: "retro-recorded", scope: { kind: "run" }, path: ".claude/retros/run.md", digest: DIGEST },
    });
    expect(retroRecordEntry({ kind: "retro-recorded", scope: { kind: "wave", wave: 3 }, path: ".claude/retros/w3.md", digest: DIGEST }).ok).toBe(true);
    expect(retroRecordEntry({ kind: "retro-skipped", reason: "a one-Wave spike" })).toEqual({
      ok: true, value: { schemaVersion: 1, kind: "retro-skipped", scope: { kind: "run" }, reason: "a one-Wave spike" },
    });
  });

  it.each<[string, Parameters<typeof retroRecordEntry>[0], string]>([
    ["a path outside the retro directory", { kind: "retro-recorded", scope: { kind: "run" }, path: "docs/retro.md", digest: DIGEST }, "under .claude/retros/"],
    ["a non-Markdown path", { kind: "retro-recorded", scope: { kind: "run" }, path: ".claude/retros/run.txt", digest: DIGEST }, "Markdown"],
    ["an escaping path", { kind: "retro-recorded", scope: { kind: "run" }, path: "../.claude/retros/run.md", digest: DIGEST }, "path"],
    ["a malformed digest", { kind: "retro-recorded", scope: { kind: "run" }, path: ".claude/retros/run.md", digest: "xyz" }, "sha256"],
    ["Wave 0", { kind: "retro-recorded", scope: { kind: "wave", wave: 0 }, path: ".claude/retros/w.md", digest: DIGEST }, "scope.wave"],
    ["a blank skip reason", { kind: "retro-skipped", reason: "  " }, "reason"],
  ])("refuses %s", (_label, input, problem) => {
    expect(retroRecordEntry(input)).toMatchObject({ ok: false, error: expect.stringContaining(problem) });
  });

  it("counts only a run-scope record as covering the run", () => {
    const wave = retroRecordEntry({ kind: "retro-recorded", scope: { kind: "wave", wave: 1 }, path: ".claude/retros/w1.md", digest: DIGEST });
    if (!wave.ok) throw new Error(wave.error);
    expect(runRetroRecorded([wave.value])).toBe(false);
    expect(runRetroRecorded(undefined)).toBe(false);
  });
});

const roots: string[] = [];
let previousStatePath: string | undefined;
afterEach(() => {
  if (previousStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousStatePath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project with a live graph (Wave 1) and a retro file; returns the root and the state path. */
function project(retroText = "# Retro\n\nWhat happened.\n"): Readonly<{ root: string; statePath: string; retroDigest: string }> {
  previousStatePath = process.env.LOOM_STATE_PATH;
  const root = canonicalTempDir("loom-record-retro-");
  roots.push(root);
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  mkdirSync(join(root, ".claude", "retros"), { recursive: true });
  writeFileSync(join(root, ".claude", "retros", "run.md"), retroText);
  const graph: TaskGraph = protectedGraphFixture({
    spec_trace_version: 2, current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: null, current_wave: 1, executing_tasks: [],
    verification_manifest: i6RunnerManifest(), wave_gates: { "1": newWaveGate() },
    tasks: [i6PlanTask("T1", 1, ["src/t1.ts", "src/t1.test.ts"])],
  });
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  writeFileSync(statePath, JSON.stringify(graph));
  process.env.LOOM_STATE_PATH = statePath;
  return { root, statePath, retroDigest: createHash("sha256").update(retroText).digest("hex") };
}

const recorded = (statePath: string): unknown => (JSON.parse(readFileSync(statePath, "utf8")) as { retro_records?: unknown }).retro_records;

describe("helper record-retro", () => {
  it("is routed and whitelisted by the state guard, since it writes the State File", () => {
    expect(KNOWN_HANDLERS.helper?.has("record-retro")).toBe(true);
    expect(WHITELISTED_HELPERS).toContain("record-retro");
  });

  it("records a written retro bound to its bytes, idempotently, and the graph loads back", async () => {
    const { statePath, retroDigest } = project();
    const args = ["--file", ".claude/retros/run.md"];
    expect(await createRecordRetroHandler()("", args)).toEqual({ kind: "allow" });
    const once = readFileSync(statePath, "utf8");
    expect(recorded(statePath)).toEqual([{ schemaVersion: 1, kind: "retro-recorded", scope: { kind: "run" }, path: ".claude/retros/run.md", digest: retroDigest }]);
    expect(parseTaskGraph(JSON.parse(once)).ok).toBe(true);
    expect(await createRecordRetroHandler()("", args)).toEqual({ kind: "allow" });
    expect(readFileSync(statePath, "utf8")).toBe(once);
  });

  it("records a Wave-scoped retro and a run skip", async () => {
    const { statePath } = project();
    expect(await createRecordRetroHandler()("", ["--file", ".claude/retros/run.md", "--wave", "1"])).toEqual({ kind: "allow" });
    expect(await createRecordRetroHandler()("", ["--skip", "--reason", "a one-Wave spike"])).toEqual({ kind: "allow" });
    expect(recorded(statePath)).toMatchObject([{ scope: { kind: "wave", wave: 1 } }, { kind: "retro-skipped", scope: { kind: "run" } }]);
  });

  it.each<[readonly string[], string]>([
    [[], "name the retro with --file"],
    [["--skip"], "--skip needs --reason"],
    [["--skip", "--reason", "r", "--file", ".claude/retros/run.md"], "--skip takes only --reason"],
    [["--file", ".claude/retros/run.md", "--reason", "r"], "--reason belongs to --skip"],
    [["--file", ".claude/retros/run.md", "--wave", "x"], "--wave must be a positive integer"],
    [["--file", "docs/run.md"], "under .claude/retros/"],
    [["--file", ".claude/retros/missing.md"], "refused without changing state"],
    [["--file", ".claude/retros/run.md", "--wave", "9"], "has no Wave 9"],
  ])("refuses %j without writing", async (args, problem) => {
    const { statePath } = project();
    const before = readFileSync(statePath, "utf8");
    expect(await createRecordRetroHandler()("", [...args])).toMatchObject({ kind: "error", message: expect.stringContaining(problem) });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses an empty retro file", async () => {
    project("");
    expect(await createRecordRetroHandler()("", ["--file", ".claude/retros/run.md"])).toMatchObject({ kind: "error", message: expect.stringContaining("is empty") });
  });
});
