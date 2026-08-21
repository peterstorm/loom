import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parsePlanModels, hasModels, renderStray, type PlanModels, type PlanInvariant, type Stray } from "../../src/parsers/parse-plan-models";
import { validateModelBindings, type ModelBindingDeps } from "../../src/handlers/helpers/validate-model-bindings";

const NO_FILES: ModelBindingDeps = { readFile: (path) => ({ ok: false, error: `ENOENT: ${path}` }) };

const STRAY_KINDS: ReadonlyArray<Stray["kind"]> = [
  "unterminated-fence",
  "empty-section",
  "near-miss-heading",
  "bad-block-grammar",
  "misplaced-heading",
  "misplaced-label",
];

function isWellShapedStray(s: Stray): boolean {
  return (
    typeof s === "object" &&
    s !== null &&
    STRAY_KINDS.includes(s.kind) &&
    typeof renderStray(s) === "string" &&
    renderStray(s).length > 0
  );
}

function isWellShapedTier(t: PlanInvariant["tier"]): boolean {
  if (t.status === "absent") return true;
  if (t.status === "unrecognized") return typeof t.raw === "string";
  return t.tier === "checkable" || t.tier === "advisory";
}

function isWellShaped(models: PlanModels): boolean {
  return (
    Array.isArray(models.lifecycles) &&
    models.lifecycles.every((lc) => /^LC-\d+$/.test(lc.id) && typeof lc.title === "string" && (lc.machineFile === null || typeof lc.machineFile === "string")) &&
    (models.pipeline === null || models.pipeline.dagFile === null || typeof models.pipeline.dagFile === "string") &&
    Array.isArray(models.invariants) &&
    models.invariants.every((inv) => /^INV-\d+$/.test(inv.id) && isWellShapedTier(inv.tier)) &&
    Array.isArray(models.strays) &&
    models.strays.every(isWellShapedStray)
  );
}

describe("parsePlanModels — properties", () => {
  it("is total: never throws and always returns a well-shaped PlanModels for arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4000 }), (input) => {
        const models = parsePlanModels(input);
        return isWellShaped(models);
      }),
      { numRuns: 500 }
    );
  });

  it("is total on unicode input", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 2000 }), (input) => {
        const models = parsePlanModels(input);
        return isWellShaped(models);
      }),
      { numRuns: 300 }
    );
  });

  it("round-trips generated well-formed plans with zero strays", () => {
    const slug = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/);
    const arbLifecycle = fc.record({
      n: fc.integer({ min: 1, max: 9 }),
      title: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,30}$/),
      file: slug.map((s) => `src/${s}/machine.ts`),
    });
    const arbInvariant = fc.record({
      n: fc.integer({ min: 1, max: 9 }),
      title: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,30}$/),
      tier: fc.constantFrom("checkable", "advisory"),
      rule: slug.map((s) => `.claude/linter/rules/inv-${s}.json`),
    });

    fc.assert(
      fc.property(
        fc.uniqueArray(arbLifecycle, { maxLength: 3, selector: (l) => l.n }),
        fc.uniqueArray(arbInvariant, { maxLength: 3, selector: (i) => i.n }),
        (lifecycles, invariants) => {
          const parts: string[] = ["# Plan: Generated\n"];
          if (lifecycles.length > 0) {
            parts.push("## Lifecycles\n");
            for (const lc of lifecycles) {
              parts.push(`### LC-${lc.n}: ${lc.title.trim() || "T"}\n\n**Machine file:** \`${lc.file}\`\n`);
            }
          }
          if (invariants.length > 0) {
            parts.push("## Invariants\n");
            for (const inv of invariants) {
              const ruleLine = inv.tier === "checkable" ? `**Rule file:** \`${inv.rule}\`\n` : "";
              parts.push(`### INV-${inv.n}: ${inv.title.trim() || "T"}\n\n**Tier:** ${inv.tier}\n${ruleLine}`);
            }
          }
          const models = parsePlanModels(parts.join("\n"));
          return (
            models.strays.length === 0 &&
            models.lifecycles.length === lifecycles.length &&
            models.invariants.length === invariants.length &&
            models.lifecycles.every((lc, i) => lc.machineFile === lifecycles[i].file) &&
            models.invariants.every((inv, i) => inv.tier.status === "ok" && inv.tier.tier === invariants[i].tier)
          );
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe("validateModelBindings — properties", () => {
  it("advisory invariants without rule files never contribute errors", () => {
    const arbAdvisory = fc.record({
      id: fc.integer({ min: 1, max: 99 }).map((n) => `INV-${n}`),
      title: fc.string({ maxLength: 30 }),
      tier: fc.constant({ status: "ok" as const, tier: "advisory" as const }),
      ruleFile: fc.constant(null),
    });
    fc.assert(
      fc.property(fc.array(arbAdvisory, { maxLength: 5 }), (invariants) => {
        const result = validateModelBindings(
          { lifecycles: [], pipeline: null, invariants, strays: [] },
          [],
          NO_FILES
        );
        return result.ok;
      }),
      { numRuns: 100 }
    );
  });

  it("error count equals the number of unbound/undeclared lifecycles", () => {
    // Each lifecycle gets a unique machine path and one of three states:
    // declared+bound (no error), declared+unbound (1 error), undeclared file (1 error)
    const arbState = fc.constantFrom("bound", "unbound", "no-file");
    fc.assert(
      fc.property(fc.array(arbState, { maxLength: 6 }), (states) => {
        const lifecycles = states.map((state, i) => ({
          id: `LC-${i + 1}`,
          title: `L${i + 1}`,
          machineFile: state === "no-file" ? null : `src/m${i + 1}/machine.ts`,
        }));
        const tasks = states.flatMap((state, i) =>
          state === "bound" ? [{ id: `T${i + 1}`, file_list: [`src/m${i + 1}/machine.ts`] }] : []
        );
        const models: PlanModels = { lifecycles, pipeline: null, invariants: [], strays: [] };
        const result = validateModelBindings(models, tasks, NO_FILES);
        const expected = states.filter((s) => s !== "bound").length;
        const actual = result.ok ? 0 : result.errors.length;
        return actual === expected;
      }),
      { numRuns: 200 }
    );
  });

  it("a lifecycle bound in any task's file_list never errors, regardless of other tasks", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ file_list: fc.array(fc.constantFrom("a.ts", "b.ts", "src/x.ts"), { maxLength: 3 }) }), { maxLength: 4 }),
        (otherTasks) => {
          const models: PlanModels = {
            lifecycles: [{ id: "LC-1", title: "T", machineFile: "src/machine.ts" }],
            pipeline: null,
            invariants: [],
            strays: [],
          };
          const tasks = [...otherTasks, { id: "TX", file_list: ["src/machine.ts"] }];
          return validateModelBindings(models, tasks, NO_FILES).ok;
        }
      ),
      { numRuns: 100 }
    );
  });

  it("hasModels is false only when validation is vacuous", () => {
    const empty: PlanModels = { lifecycles: [], pipeline: null, invariants: [], strays: [] };
    expect(hasModels(empty)).toBe(false);
    expect(validateModelBindings(empty, [], NO_FILES).ok).toBe(true);
  });
});
