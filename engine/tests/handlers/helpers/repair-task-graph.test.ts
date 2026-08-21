import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prepareTaskGraphRepair } from "../../../src/handlers/helpers/repair-task-graph";
import { parseTaskGraph, StateManager } from "../../../src/state-manager";

const ENGINE = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(ENGINE, "src", "cli.ts");
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function graph(taskFields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    plan_title: "Repair plan",
    plan_file: ".claude/plans/repair.md",
    spec_file: ".claude/specs/repair.md",
    current_wave: 1,
    executing_tasks: [],
    tasks: [{
      id: "T2",
      description: "repair state",
      agent: "code-implementer-agent",
      wave: 1,
      status: "pending",
      depends_on: [],
      review_status: "pending",
      ...taskFields,
    }],
    wave_gates: {
      "1": {
        impl_complete: false,
        tests_passed: null,
        reviews_complete: false,
        blocked: false,
      },
    },
  };
}

function corruptEvidencePair(): Record<string, unknown> {
  return graph({
    review_status: "pending",
    review_error: "stale reviewer failure",
    review_evidence_failures: ["code-reviewer"],
  });
}

/** A plan declaring no model sections — the genuine opt-out, so the binding
 *  gate passes and these cases exercise the structural repair alone. */
const NO_MODELS_PLAN = "# Repair plan\n\nNothing to bind.\n";

/** A plan whose LC-1 declares no machine file: a descriptive model, which the
 *  executable-models policy refuses. Not structurally fixable. */
const UNBOUND_MODEL_PLAN = "# Repair plan\n\n## Lifecycles\n\n### LC-1: Order\n\nNo machine file.\n";

const planDeps = (content: string) => ({
  readFile: (_path: string) => ({ ok: true as const, content }),
});

function fixtureState(
  raw: string,
  plan: string = NO_MODELS_PLAN,
): { readonly root: string; readonly statePath: string } {
  const root = mkdtempSync(join(tmpdir(), "loom-repair-task-graph-"));
  cleanup.push(root);
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  writeFileSync(statePath, raw);
  chmodSync(statePath, 0o444);
  // The repair path enforces executable-model bindings, so the graph's
  // plan_file must actually exist for the CLI cases to reach the structural
  // assertions they are about.
  mkdirSync(join(root, ".claude", "plans"), { recursive: true });
  writeFileSync(join(root, ".claude", "plans", "repair.md"), plan);
  return { root, statePath };
}

function runRepair(root: string, statePath: string) {
  return spawnSync("bun", [CLI, "helper", "repair-task-graph"], {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, LOOM_STATE_PATH: statePath },
  });
}

describe("prepareTaskGraphRepair", () => {
  const repair = (raw: unknown, plan = NO_MODELS_PLAN) => prepareTaskGraphRepair(raw, planDeps(plan));

  it("restores the review evidence-failure biconditional and is idempotent", () => {
    expect(parseTaskGraph(corruptEvidencePair()).ok).toBe(false);

    const once = repair(corruptEvidencePair());
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(once.state.tasks[0]).toMatchObject({ review_status: "pending" });
    expect(once.state.tasks[0]?.review_error).toBeUndefined();
    expect(once.state.tasks[0]?.review_evidence_failures).toBeUndefined();

    const twice = repair(once.state);
    expect(twice).toEqual({ ok: true, state: once.state, notes: [] });
  });

  // Each case is WRAPPED in its own array because `it.each` spreads an array
  // case into the callback's arguments. The `[]` case therefore used to call
  // this with zero arguments, which makes the runner read the declared `entry`
  // parameter as a `done` callback and time the case out after 5s — so the
  // whole table failed for a reason unrelated to anything it asserts.
  it.each([[null], [42], ["task"], [[]], [true]])(
    "returns a typed refusal instead of throwing for malformed task entry %j",
    (entry) => {
      const malformed = { ...graph(), tasks: [entry] };
      expect(() => repair(malformed)).not.toThrow();
      const prepared = repair(malformed);
      expect(prepared.ok).toBe(false);
      if (!prepared.ok) expect(prepared.errors.join("\n")).toContain("tasks[0] must be an object");
    },
  );

  it("refuses a fixFull repair that would discard finding data", () => {
    const prepared = repair(graph({
      findings: [{ severity: "critical" }],
      critical_findings: [],
      advisory_findings: [],
    }));

    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.errors.join("\n")).toContain("Refusing lossy repair");
  });

  // This helper installs through StateManager.replace, bypassing load() — so it
  // is the second path that writes tasks into the active graph. `validateFull`
  // is structural and carries no binding check, so without an explicit gate a
  // structurally-repairable graph could be installed with its executable-model
  // bindings never verified.
  it("refuses a structurally repairable graph whose executable-model bindings are invalid", () => {
    const prepared = repair(corruptEvidencePair(), UNBOUND_MODEL_PLAN);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.errors.join("\n")).toContain("Executable-model binding");
    expect(prepared.errors.join("\n")).toContain("LC-1");
  });

  it("refuses a repair whose plan_file cannot be read rather than skipping the check", () => {
    const prepared = prepareTaskGraphRepair(corruptEvidencePair(), {
      readFile: () => ({ ok: false as const, error: "ENOENT" }),
    });

    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.errors.join("\n")).toContain("Executable-model binding");
  });
});

describe("repair-task-graph CLI", () => {
  it("loads rejected JSON directly, validates it, and atomically installs a loadable 0444 graph", () => {
    const { root, statePath } = fixtureState(JSON.stringify(corruptEvidencePair(), null, 2));
    expect(() => StateManager.fromPath(statePath)?.load()).toThrow(/Corrupt state file/);

    const result = runRepair(root, statePath);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Repaired task graph atomically");
    const repaired = StateManager.fromPath(statePath)?.load();
    expect(repaired?.tasks[0]?.review_status).toBe("pending");
    expect(repaired?.tasks[0]?.review_error).toBeUndefined();
    expect(repaired?.tasks[0]?.review_evidence_failures).toBeUndefined();
    expect(statSync(statePath).mode & 0o777).toBe(0o444);
  });

  it("leaves malformed non-object task entries untouched and reports a typed refusal", () => {
    const raw = JSON.stringify({ ...graph(), tasks: [null] }, null, 2);
    const { root, statePath } = fixtureState(raw);

    const result = runRepair(root, statePath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("tasks[0] must be an object");
    expect(readFileSync(statePath, "utf-8")).toBe(raw);
  });

  it("leaves the original bytes untouched when repair would lose evidence", () => {
    const raw = JSON.stringify(graph({
      findings: [{ severity: "critical" }],
      critical_findings: [],
      advisory_findings: [],
    }), null, 2);
    const { root, statePath } = fixtureState(raw);

    const result = runRepair(root, statePath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing lossy repair");
    expect(readFileSync(statePath, "utf-8")).toBe(raw);
    expect(statSync(statePath).mode & 0o777).toBe(0o444);
  });
});
