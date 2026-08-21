import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import handler from "../../src/handlers/helpers/validate-task-graph";
import populate from "../../src/handlers/helpers/populate-task-graph";
import {
  validateModelBindings,
  checkPlanModelBindings,
  pathsMatch,
  type ModelBindingDeps,
} from "../../src/handlers/helpers/validate-model-bindings";
import type { PlanModels } from "../../src/parsers/parse-plan-models";

function errorsOf(r: { ok: true } | { ok: false; errors: readonly string[] }): readonly string[] {
  return r.ok ? [] : r.errors;
}

function expectError(r: { ok: true } | { ok: false; errors: readonly string[] }, substring: string): void {
  expect(r.ok).toBe(false);
  expect(errorsOf(r).some((e) => e.includes(substring))).toBe(true);
}

const NO_MODELS: PlanModels = { lifecycles: [], pipeline: null, invariants: [], strays: [] };

const NO_FILES: ModelBindingDeps = { readFile: (path) => ({ ok: false, error: `ENOENT: ${path}` }) };

function depsWith(files: Record<string, string>): ModelBindingDeps {
  return {
    readFile: (path) => path in files
      ? { ok: true, content: files[path]! }
      : { ok: false, error: `ENOENT: ${path}` },
  };
}

function task(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: "T1", description: "x", agent: "code-implementer-agent", wave: 1, depends_on: [], ...overrides };
}

describe("pathsMatch", () => {
  it("matches exact normalized paths", () => {
    expect(pathsMatch("src/order-machine.ts", "./src/order-machine.ts")).toBe(true);
  });

  it("matches an absolute task path against a relative declaration", () => {
    expect(pathsMatch("/repo/src/order-machine.ts", "src/order-machine.ts")).toBe(true);
  });

  it("does NOT let a bare-basename task entry satisfy a pathed declaration", () => {
    expect(pathsMatch("order-machine.ts", "src/domain/order/order-machine.ts")).toBe(false);
  });

  it("does NOT match a different file with the same basename", () => {
    expect(pathsMatch("src/other/machine.ts", "src/order/machine.ts")).toBe(false);
  });

  it("a declaration with no directory segment only matches exactly", () => {
    expect(pathsMatch("order-machine.ts", "order-machine.ts")).toBe(true);
    expect(pathsMatch("deep/tree/order-machine.ts", "order-machine.ts")).toBe(false);
  });
});

describe("validateModelBindings", () => {
  it("passes trivially when the plan declares no models", () => {
    expect(validateModelBindings(NO_MODELS, [], NO_FILES).ok).toBe(true);
  });

  it("turns every parser stray into an error (typos are not opt-outs)", () => {
    const models: PlanModels = {
      ...NO_MODELS,
      strays: [
        { kind: "near-miss-heading", heading: "## Lifecycles:" },
        { kind: "bad-block-grammar", heading: "INV-A1: x", section: "Invariants", prefix: "INV" },
      ],
    };
    const result = validateModelBindings(models, [], NO_FILES);
    expect(errorsOf(result)).toHaveLength(2);
    expectError(result, "Model declaration problem");
    // rendered context survives into the error text
    expectError(result, "near-miss section heading '## Lifecycles:'");
    expectError(result, "'### INV-A1: x' inside '## Invariants'");
  });

  describe("lifecycles", () => {
    it("rejects a lifecycle with no machine file (descriptive model)", () => {
      const models: PlanModels = { ...NO_MODELS, lifecycles: [{ id: "LC-1", title: "Order", machineFile: null }] };
      const result = validateModelBindings(models, [task({})], NO_FILES);
      expectError(result, "LC-1");
      expectError(result, "descriptive model");
    });

    it("rejects a lifecycle whose machine file is in no task's file_list", () => {
      const models: PlanModels = { ...NO_MODELS, lifecycles: [{ id: "LC-1", title: "Order", machineFile: "src/order-machine.ts" }] };
      const result = validateModelBindings(models, [task({ file_list: ["src/other.ts"] })], NO_FILES);
      expectError(result, "not in any task's file_list");
    });

    it("rejects a bare-basename file_list entry against a pathed declaration", () => {
      const models: PlanModels = { ...NO_MODELS, lifecycles: [{ id: "LC-1", title: "Order", machineFile: "src/domain/order-machine.ts" }] };
      const result = validateModelBindings(models, [task({ file_list: ["order-machine.ts"] })], NO_FILES);
      expectError(result, "not in any task's file_list");
    });

    it("accepts an exact file_list binding", () => {
      const models: PlanModels = { ...NO_MODELS, lifecycles: [{ id: "LC-1", title: "Order", machineFile: "src/order-machine.ts" }] };
      const result = validateModelBindings(models, [task({ file_list: ["src/order-machine.ts", "src/order-machine.test.ts"] })], NO_FILES);
      expect(result.ok).toBe(true);
    });

    it("binds a relative plan path to an absolute task path (suffix match)", () => {
      const models: PlanModels = { ...NO_MODELS, lifecycles: [{ id: "LC-1", title: "Order", machineFile: "src/order-machine.ts" }] };
      const result = validateModelBindings(models, [task({ file_list: ["/repo/src/order-machine.ts"] })], NO_FILES);
      expect(result.ok).toBe(true);
    });

    it("binds a ./-prefixed path", () => {
      const models: PlanModels = { ...NO_MODELS, lifecycles: [{ id: "LC-1", title: "Order", machineFile: "./src/order-machine.ts" }] };
      const result = validateModelBindings(models, [task({ file_list: ["src/order-machine.ts"] })], NO_FILES);
      expect(result.ok).toBe(true);
    });
  });

  describe("pipeline", () => {
    it("rejects a Pipeline section with no AuthoredDag path", () => {
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: null, declaredNodes: [] } };
      expectError(validateModelBindings(models, [], NO_FILES), "AuthoredDag");
    });

    it("rejects a missing AuthoredDag file", () => {
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: "plans/x.dag.authored.json", declaredNodes: [] } };
      expectError(validateModelBindings(models, [], NO_FILES), "cannot read AuthoredDag");
    });

    it("rejects invalid JSON and preserves the parse error detail", () => {
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: "x.json", declaredNodes: [] } };
      const result = validateModelBindings(models, [], depsWith({ "x.json": "{nope" }));
      expectError(result, "not valid JSON:");
      // the message carries the underlying SyntaxError text, not just a label
      expect(errorsOf(result).some((e) => e.length > "Pipeline: AuthoredDag file 'x.json' is not valid JSON:".length + 3)).toBe(true);
    });

    it("rejects an AuthoredDag without a nodes array", () => {
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: "x.json", declaredNodes: [] } };
      expectError(validateModelBindings(models, [], depsWith({ "x.json": JSON.stringify({ name: "p" }) })), "'nodes' array");
    });

    it("accepts a structurally sound AuthoredDag (deep validation is fugue's)", () => {
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: "x.json", declaredNodes: [] } };
      const result = validateModelBindings(models, [], depsWith({ "x.json": JSON.stringify({ name: "p", nodes: [{ id: "a" }] }) }));
      expect(result.ok).toBe(true);
    });

    it("accepts when every plan-declared node appears in the sidecar", () => {
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: "x.json", declaredNodes: ["fetch-order", "enrich"] } };
      const dag = JSON.stringify({ nodes: [{ id: "fetch-order" }, { id: "enrich", kind: "llm" }] });
      expect(validateModelBindings(models, [], depsWith({ "x.json": dag })).ok).toBe(true);
    });

    it("rejects when a plan-declared node is absent from the sidecar (drift)", () => {
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: "x.json", declaredNodes: ["fetch-order", "review"] } };
      const dag = JSON.stringify({ nodes: [{ id: "fetch-order" }] }); // 'review' dropped
      const result = validateModelBindings(models, [], depsWith({ "x.json": dag }));
      expectError(result, "have drifted");
      expect(errorsOf(result).some((e) => e.includes("review"))).toBe(true);
    });

    it("flags substring-collision drift: declared 'fetch' is NOT satisfied by a sidecar node 'fetch-order'", () => {
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: "x.json", declaredNodes: ["fetch"] } };
      const dag = JSON.stringify({ nodes: [{ id: "fetch-order" }] }); // substring, not the same node
      const result = validateModelBindings(models, [], depsWith({ "x.json": dag }));
      expectError(result, "have drifted");
      expect(errorsOf(result).some((e) => e.includes("fetch"))).toBe(true);
    });

    it("does not accept a declared node name found only in node metadata", () => {
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: "x.json", declaredNodes: ["review"] } };
      const dag = JSON.stringify({ nodes: [{ id: "fetch", description: "then review" }] });
      expectError(validateModelBindings(models, [], depsWith({ "x.json": dag })), "have drifted");
    });

    it.each([
      [{ nodes: ["fetch"] }, "nodes[0] must be an object"],
      [{ nodes: [{ kind: "fetch" }] }, "nodes[0].id"],
      [{ nodes: [{ id: " fetch " }] }, "surrounding whitespace"],
      [{ nodes: [{ id: "fetch" }, { id: "fetch" }] }, "duplicates 'fetch'"],
    ])("rejects malformed or duplicate AuthoredDag node identities", (dag, message) => {
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: "x.json", declaredNodes: [] } };
      expectError(validateModelBindings(models, [], depsWith({ "x.json": JSON.stringify(dag) })), message);
    });
  });

  describe("invariants", () => {
    it("rejects a missing tier with the missing-specific message", () => {
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-1", title: "X", tier: { status: "absent" }, ruleFile: null }] };
      const result = validateModelBindings(models, [], NO_FILES);
      expectError(result, "missing '**Tier:**'");
      expectError(result, "'checkable' or 'advisory'");
    });

    it("rejects an unrecognized tier, naming the raw text it saw", () => {
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-1", title: "X", tier: { status: "unrecognized", raw: "enforced-ish" }, ruleFile: null }] };
      const result = validateModelBindings(models, [], NO_FILES);
      expectError(result, "unrecognized '**Tier:**' 'enforced-ish'");
      expectError(result, "'checkable' or 'advisory'");
    });

    it("rejects a checkable invariant with no rule file", () => {
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-1", title: "X", tier: { status: "ok", tier: "checkable" }, ruleFile: null }] };
      expectError(validateModelBindings(models, [], NO_FILES), "must be a lint rule");
    });

    it("rejects an ADVISORY invariant that declares a rule file (mis-tiered intent)", () => {
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-1", title: "X", tier: { status: "ok", tier: "advisory" }, ruleFile: "r.json" }] };
      expectError(validateModelBindings(models, [], NO_FILES), "advisory invariants are never enforced");
    });

    it("rejects a checkable invariant whose rule file does not exist", () => {
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-1", title: "X", tier: { status: "ok", tier: "checkable" }, ruleFile: ".claude/linter/rules/inv-1.json" }] };
      expectError(validateModelBindings(models, [], NO_FILES), "cannot read rule file");
    });

    it("rejects a rule file that is not a rule-shaped JSON object", () => {
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-1", title: "X", tier: { status: "ok", tier: "checkable" }, ruleFile: "r.json" }] };
      expectError(validateModelBindings(models, [], depsWith({ "r.json": JSON.stringify({ pattern: "x" }) })), "'kind' and 'name'");
    });

    it("rejects a rule file with invalid JSON and preserves the parse error", () => {
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-1", title: "X", tier: { status: "ok", tier: "checkable" }, ruleFile: "r.json" }] };
      expectError(validateModelBindings(models, [], depsWith({ "r.json": "{{" })), "not valid JSON:");
    });

    it("accepts a checkable invariant bound to an existing rule file", () => {
      const rule = JSON.stringify({ kind: "regex", name: "inv-1", description: "d", extensions: [".ts"], pattern: "x", fixHint: "f", enabled: true });
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-1", title: "X", tier: { status: "ok", tier: "checkable" }, ruleFile: "r.json" }] };
      expect(validateModelBindings(models, [], depsWith({ "r.json": rule })).ok).toBe(true);
    });

    it("accepts an advisory invariant with no rule file (honest prose)", () => {
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-2", title: "SLA", tier: { status: "ok", tier: "advisory" }, ruleFile: null }] };
      expect(validateModelBindings(models, [], NO_FILES).ok).toBe(true);
    });
  });

  it("accumulates errors across all model kinds", () => {
    const models: PlanModels = {
      lifecycles: [{ id: "LC-1", title: "A", machineFile: null }],
      pipeline: { dagFile: null, declaredNodes: [] },
      invariants: [{ id: "INV-1", title: "B", tier: { status: "ok", tier: "checkable" }, ruleFile: null }],
      strays: [{ kind: "near-miss-heading", heading: "## Lifecycles:" }],
    };
    expect(errorsOf(validateModelBindings(models, [], NO_FILES))).toHaveLength(4);
  });
});

describe("checkPlanModelBindings (fail-closed entry point)", () => {
  const PLAN_WITH_LC = "# Plan\n\n## Lifecycles\n\n### LC-1: Order\n\n**Machine file:** `src/order-machine.ts`\n";

  it("errors on a non-string plan file", () => {
    expectError(checkPlanModelBindings(42, [], NO_FILES), "plan_file must be a non-empty string");
    expectError(checkPlanModelBindings(undefined, [], NO_FILES), "plan_file must be a non-empty string");
    expectError(checkPlanModelBindings("  ", [], NO_FILES), "plan_file must be a non-empty string");
  });

  it("errors with the concrete read cause when the plan file is unavailable", () => {
    const result = checkPlanModelBindings("/nonexistent/plan.md", [], NO_FILES);
    expectError(result, "cannot read plan_file");
    expectError(result, "ENOENT: /nonexistent/plan.md");
  });

  it("passes when the plan is readable and declares no models (genuine opt-out)", () => {
    const deps = depsWith({ "plan.md": "# Plan\n\n## Summary\n\nNo models.\n" });
    expect(checkPlanModelBindings("plan.md", [], deps).ok).toBe(true);
  });

  it("validates bindings when the plan declares models", () => {
    const deps = depsWith({ "plan.md": PLAN_WITH_LC });
    expectError(checkPlanModelBindings("plan.md", [task({ file_list: [] })], deps), "LC-1");
    expect(checkPlanModelBindings("plan.md", [task({ file_list: ["src/order-machine.ts"] })], deps).ok).toBe(true);
  });

  it("errors when the plan declares near-miss model markers", () => {
    const deps = depsWith({ "plan.md": "# Plan\n\n## Lifecycles:\n\n### LC-1: Order\n\n**Machine file:** m.ts\n" });
    expectError(checkPlanModelBindings("plan.md", [], deps), "Model declaration problem");
  });
});

describe("validate-task-graph handler integration (plan file on disk)", () => {
  let dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "loom-plan-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
    vi.restoreAllMocks();
  });

  function graphJson(planFile: unknown, fileList: string[]): string {
    return JSON.stringify({
      current_phase: "execute",
      phase_artifacts: {},
      skipped_phases: [],
      plan_title: "t",
      spec_file: "spec.md",
      plan_file: planFile,
      tasks: [{ id: "T1", description: "impl", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [], spec_anchors: [], new_tests_required: true, plan_context: "", file_list: fileList }],
    });
  }

  it("passes when the plan's lifecycle binds to a task file", async () => {
    const dir = tempDir();
    const planFile = join(dir, "plan.md");
    writeFileSync(planFile, "# Plan\n\n## Lifecycles\n\n### LC-1: Order\n\n**Machine file:** `src/order-machine.ts`\n");
    const result = await handler(graphJson(planFile, ["src/order-machine.ts"]), ["-"]);
    expect(result.kind).toBe("passthrough");
  });

  it("errors when the plan declares a lifecycle no task implements", async () => {
    const dir = tempDir();
    const planFile = join(dir, "plan.md");
    writeFileSync(planFile, "# Plan\n\n## Lifecycles\n\n### LC-1: Order\n\n**Machine file:** `src/order-machine.ts`\n");
    const result = await handler(graphJson(planFile, ["src/other.ts"]), ["-"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("LC-1");
  });

  it("FAILS CLOSED with the filesystem cause when plan_file does not exist", async () => {
    const result = await handler(graphJson("/nonexistent/plan.md", []), ["-"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("cannot read plan_file");
      expect(result.message).toMatch(/ENOENT|no such file/i);
    }
  });

  it("rejects a non-string plan_file at schema level (no silent skip)", async () => {
    const result = await handler(graphJson(42, []), ["-"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("'plan_file' must be a string");
  });

  it("passes untouched when the plan declares no models", async () => {
    const dir = tempDir();
    const planFile = join(dir, "plan.md");
    writeFileSync(planFile, "# Plan\n\n## Summary\n\nNo models here.\n");
    const result = await handler(graphJson(planFile, []), ["-"]);
    expect(result.kind).toBe("passthrough");
  });

  it("--fix surfaces binding errors on stderr instead of dropping them", async () => {
    const dir = tempDir();
    const planFile = join(dir, "plan.md");
    writeFileSync(planFile, "# Plan\n\n## Lifecycles\n\n### LC-1: Order\n\n**Machine file:** `src/order-machine.ts`\n");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const result = await handler(graphJson(planFile, []), ["--fix", "-"]);
    expect(result.kind).toBe("passthrough");
    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toContain("Executable-model binding issues");
    expect(stderrText).toContain("LC-1");
    stdoutSpy.mockRestore();
  });
});

describe("populate-task-graph enforces model bindings (the state-write funnel)", () => {
  let dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "loom-populate-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
    delete process.env.LOOM_STATE_PATH;
  });

  // The handler resolves LOOM_STATE_PATH lazily (taskGraphPath() at call
  // time), so pointing it at a per-test state file needs no module reload —
  // this runs identically under `bun test` and `vitest run`.
  function pointStateAt(statePath: string): typeof populate {
    process.env.LOOM_STATE_PATH = statePath;
    return populate;
  }

  function decomposeJson(planFile: string, fileList: string[]): string {
    return JSON.stringify({
      plan_title: "t",
      spec_file: "spec.md",
      plan_file: planFile,
      tasks: [{ id: "T1", description: "impl", agent: "code-implementer-agent", wave: 1, depends_on: [], spec_anchors: [], new_tests_required: true, plan_context: "", file_list: fileList }],
    });
  }

  function writeState(dir: string, planFile: string | null): string {
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: planFile,
      tasks: [],
      wave_gates: {},
    }));
    return statePath;
  }

  it("blocks population when the plan declares an unbound lifecycle", async () => {
    const dir = tempDir();
    const planFile = join(dir, "plan.md");
    writeFileSync(planFile, "# Plan\n\n## Lifecycles\n\n### LC-1: Order\n\n**Machine file:** `src/order-machine.ts`\n");
    const statePath = writeState(dir, planFile);
    const populateHandler = pointStateAt(statePath);
    const result = await populateHandler(decomposeJson(planFile, ["src/other.ts"]), []);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("task graph not populated");
      expect(result.message).toContain("LC-1");
    }
  });

  it("prefers the plan_file recorded in state over the decompose payload (no re-pointing)", async () => {
    const dir = tempDir();
    const realPlan = join(dir, "plan.md");
    writeFileSync(realPlan, "# Plan\n\n## Lifecycles\n\n### LC-1: Order\n\n**Machine file:** `src/order-machine.ts`\n");
    const decoyPlan = join(dir, "decoy.md");
    writeFileSync(decoyPlan, "# Plan\n\nNo models.\n");
    const statePath = writeState(dir, realPlan);
    const populateHandler = pointStateAt(statePath);
    // decompose tries to point at a model-free plan; state's plan wins
    const result = await populateHandler(decomposeJson(decoyPlan, ["src/other.ts"]), []);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("LC-1");
  });

  it("populates when bindings hold — and actually writes the tasks", async () => {
    const dir = tempDir();
    const planFile = join(dir, "plan.md");
    writeFileSync(planFile, "# Plan\n\n## Lifecycles\n\n### LC-1: Order\n\n**Machine file:** `src/order-machine.ts`\n");
    const statePath = writeState(dir, planFile);
    const populateHandler = pointStateAt(statePath);
    const result = await populateHandler(decomposeJson(planFile, ["src/order-machine.ts", "src/order-machine.test.ts"]), []);
    expect(result.kind).toBe("passthrough");
    const written = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(written.tasks).toHaveLength(1);
    expect(written.plan_file).toBe(planFile);
  });

  it("PERSISTS the validated plan path, not the decompose payload's (wave-gate stays armed)", async () => {
    const dir = tempDir();
    const realPlan = join(dir, "plan.md");
    writeFileSync(realPlan, "# Plan\n\n## Lifecycles\n\n### LC-1: Order\n\n**Machine file:** `src/order-machine.ts`\n");
    const decoyPlan = join(dir, "decoy.md");
    writeFileSync(decoyPlan, "# Plan\n\nNo models.\n");
    const statePath = writeState(dir, realPlan);
    const populateHandler = pointStateAt(statePath);
    // bindings PASS (task implements the machine) but payload points at the decoy
    const result = await populateHandler(decomposeJson(decoyPlan, ["src/order-machine.ts"]), []);
    expect(result.kind).toBe("passthrough");
    const written = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(written.plan_file).toBe(realPlan); // NOT the decoy
  });

  it("falls back to the architecture phase artifact when state plan_file is null", async () => {
    const dir = tempDir();
    const realPlan = join(dir, "plan.md");
    writeFileSync(realPlan, "# Plan\n\n## Lifecycles\n\n### LC-1: Order\n\n**Machine file:** `src/order-machine.ts`\n");
    const decoyPlan = join(dir, "decoy.md");
    writeFileSync(decoyPlan, "# Plan\n\nNo models.\n");
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute",
      phase_artifacts: { architecture: realPlan },
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      tasks: [],
      wave_gates: {},
    }));
    const populateHandler = pointStateAt(statePath);
    // payload re-points at the decoy AND omits the machine file — must be blocked
    const result = await populateHandler(decomposeJson(decoyPlan, ["src/other.ts"]), []);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("LC-1");
  });
});

describe("validateFull path-field type checks", () => {
  it("rejects non-string spec_file and plan_title", async () => {
    const { validateFull } = await import("../../src/handlers/helpers/validate-task-graph");
    const base = {
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      plan_title: "t", plan_file: "p.md", spec_file: "s.md",
      tasks: [{ id: "T1", description: "x", agent: "code-implementer-agent", wave: 1, depends_on: [] }],
    };
    const specResult = validateFull({ ...base, spec_file: 42 });
    expect(specResult.ok).toBe(false);
    expect(errorsOf(specResult).some((e) => e.includes("'spec_file' must be a string"))).toBe(true);
    const titleResult = validateFull({ ...base, plan_title: {} });
    expect(titleResult.ok).toBe(false);
    expect(errorsOf(titleResult).some((e) => e.includes("'plan_title' must be a string"))).toBe(true);
  });
});
