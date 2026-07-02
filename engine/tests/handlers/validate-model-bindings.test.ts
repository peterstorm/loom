import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import handler, { validateModelBindings, type ModelBindingDeps } from "../../src/handlers/helpers/validate-task-graph";
import type { PlanModels } from "../../src/parsers/parse-plan-models";

function errorsOf(r: { ok: true } | { ok: false; errors: readonly string[] }): readonly string[] {
  return r.ok ? [] : r.errors;
}

const NO_MODELS: PlanModels = { lifecycles: [], pipeline: null, invariants: [] };

const NO_FILES: ModelBindingDeps = { readFile: () => null };

function depsWith(files: Record<string, string>): ModelBindingDeps {
  return { readFile: (p) => files[p] ?? null };
}

function task(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: "T1", description: "x", agent: "code-implementer-agent", wave: 1, depends_on: [], ...overrides };
}

describe("validateModelBindings", () => {
  it("passes trivially when the plan declares no models", () => {
    expect(validateModelBindings(NO_MODELS, [], NO_FILES).ok).toBe(true);
  });

  describe("lifecycles", () => {
    it("rejects a lifecycle with no machine file (descriptive model)", () => {
      const models: PlanModels = { ...NO_MODELS, lifecycles: [{ id: "LC-1", title: "Order", machineFile: null }] };
      const result = validateModelBindings(models, [task({})], NO_FILES);
      expect(result.ok).toBe(false);
      expect(errorsOf(result)[0]).toContain("LC-1");
      expect(errorsOf(result)[0]).toContain("descriptive model");
    });

    it("rejects a lifecycle whose machine file is in no task's file_list", () => {
      const models: PlanModels = { ...NO_MODELS, lifecycles: [{ id: "LC-1", title: "Order", machineFile: "src/order-machine.ts" }] };
      const result = validateModelBindings(models, [task({ file_list: ["src/other.ts"] })], NO_FILES);
      expect(result.ok).toBe(false);
      expect(errorsOf(result)[0]).toContain("not in any task's file_list");
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
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: null } };
      const result = validateModelBindings(models, [], NO_FILES);
      expect(result.ok).toBe(false);
      expect(errorsOf(result)[0]).toContain("AuthoredDag");
    });

    it("rejects a missing AuthoredDag file", () => {
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: "plans/x.dag.authored.json" } };
      const result = validateModelBindings(models, [], NO_FILES);
      expect(result.ok).toBe(false);
      expect(errorsOf(result)[0]).toContain("not found");
    });

    it("rejects an AuthoredDag that is not valid JSON", () => {
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: "x.json" } };
      const result = validateModelBindings(models, [], depsWith({ "x.json": "{nope" }));
      expect(result.ok).toBe(false);
      expect(errorsOf(result)[0]).toContain("not valid JSON");
    });

    it("rejects an AuthoredDag without a nodes array", () => {
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: "x.json" } };
      const result = validateModelBindings(models, [], depsWith({ "x.json": JSON.stringify({ name: "p" }) }));
      expect(result.ok).toBe(false);
      expect(errorsOf(result)[0]).toContain("'nodes' array");
    });

    it("accepts a structurally sound AuthoredDag (deep validation is fugue's)", () => {
      const models: PlanModels = { ...NO_MODELS, pipeline: { dagFile: "x.json" } };
      const result = validateModelBindings(models, [], depsWith({ "x.json": JSON.stringify({ name: "p", nodes: [{ id: "a" }] }) }));
      expect(result.ok).toBe(true);
    });
  });

  describe("invariants", () => {
    it("rejects a missing/unrecognized tier", () => {
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-1", title: "X", tier: null, ruleFile: null }] };
      const result = validateModelBindings(models, [], NO_FILES);
      expect(result.ok).toBe(false);
      expect(errorsOf(result)[0]).toContain("'checkable' or 'advisory'");
    });

    it("rejects a checkable invariant with no rule file", () => {
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-1", title: "X", tier: "checkable", ruleFile: null }] };
      const result = validateModelBindings(models, [], NO_FILES);
      expect(result.ok).toBe(false);
      expect(errorsOf(result)[0]).toContain("must be a lint rule");
    });

    it("rejects a checkable invariant whose rule file does not exist", () => {
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-1", title: "X", tier: "checkable", ruleFile: ".claude/linter/rules/inv-1.json" }] };
      const result = validateModelBindings(models, [], NO_FILES);
      expect(result.ok).toBe(false);
      expect(errorsOf(result)[0]).toContain("not found");
    });

    it("rejects a rule file that is not a rule-shaped JSON object", () => {
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-1", title: "X", tier: "checkable", ruleFile: "r.json" }] };
      const result = validateModelBindings(models, [], depsWith({ "r.json": JSON.stringify({ pattern: "x" }) }));
      expect(result.ok).toBe(false);
      expect(errorsOf(result)[0]).toContain("'kind' and 'name'");
    });

    it("accepts a checkable invariant bound to an existing rule file", () => {
      const rule = JSON.stringify({ kind: "regex", name: "inv-1", description: "d", extensions: [".ts"], pattern: "x", fixHint: "f", enabled: true });
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-1", title: "X", tier: "checkable", ruleFile: "r.json" }] };
      const result = validateModelBindings(models, [], depsWith({ "r.json": rule }));
      expect(result.ok).toBe(true);
    });

    it("accepts an advisory invariant with no rule file (honest prose)", () => {
      const models: PlanModels = { ...NO_MODELS, invariants: [{ id: "INV-2", title: "SLA", tier: "advisory", ruleFile: null }] };
      expect(validateModelBindings(models, [], NO_FILES).ok).toBe(true);
    });
  });

  describe("handler integration (plan file on disk)", () => {
    let dirs: string[] = [];

    function tempDir(): string {
      const dir = mkdtempSync(join(tmpdir(), "loom-plan-"));
      dirs.push(dir);
      return dir;
    }

    afterEach(() => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
      dirs = [];
    });

    function graphJson(planFile: string, fileList: string[]): string {
      return JSON.stringify({
        plan_title: "t",
        spec_file: "spec.md",
        plan_file: planFile,
        tasks: [{ id: "T1", description: "impl", agent: "code-implementer-agent", wave: 1, depends_on: [], spec_anchors: [], new_tests_required: true, plan_context: "", file_list: fileList }],
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

    it("skips binding checks (warns) when plan_file does not exist", async () => {
      const result = await handler(graphJson("/nonexistent/plan.md", []), ["-"]);
      expect(result.kind).toBe("passthrough");
    });

    it("passes untouched when the plan declares no models", async () => {
      const dir = tempDir();
      const planFile = join(dir, "plan.md");
      writeFileSync(planFile, "# Plan\n\n## Summary\n\nNo models here.\n");
      const result = await handler(graphJson(planFile, []), ["-"]);
      expect(result.kind).toBe("passthrough");
    });
  });

  it("accumulates errors across all model kinds", () => {
    const models: PlanModels = {
      lifecycles: [{ id: "LC-1", title: "A", machineFile: null }],
      pipeline: { dagFile: null },
      invariants: [{ id: "INV-1", title: "B", tier: "checkable", ruleFile: null }],
    };
    const result = validateModelBindings(models, [], NO_FILES);
    expect(errorsOf(result)).toHaveLength(3);
  });
});
