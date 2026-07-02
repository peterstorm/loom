import { describe, it, expect } from "vitest";
import { parsePlanModels, hasModels } from "../../src/parsers/parse-plan-models";

const FULL_PLAN = `# Plan: Order Processing

**Spec:** .claude/specs/2026-07-02-orders/spec.md

## Summary

Orders move through a lifecycle; fulfillment is a pipeline.

## Architectural Decisions

### AD-1: Typed reducer over XState

**Choice:** plain typed reducer
**Why:** no new dependency

## Lifecycles

### LC-1: Order lifecycle

**Machine file:** \`src/domain/order/order-machine.ts\`
**Kind:** typed-reducer
**States:** draft, submitted, paid, shipped, cancelled

| Event | From | To |
|---|---|---|
| submit | draft | submitted |
| pay | submitted | paid |

### LC-2: Refund lifecycle

**Machine file:** src/domain/refund/refund-machine.ts

## Pipeline

**AuthoredDag:** \`.claude/plans/2026-07-02-orders.dag.authored.json\`

| Node | Kind | Purpose |
|---|---|---|
| fetch-order | fetch | load order |

## Invariants

### INV-1: No state string literals outside the machine

**Tier:** checkable
**Rule file:** \`.claude/linter/rules/inv-1-no-raw-order-states.json\`
**Statement:** Order state names appear only in order-machine.ts.

### INV-2: Refunds complete within 30 days

**Tier:** advisory
**Statement:** Business SLA — not deterministically observable.

## Testing Strategy

| Component | Unit Tests |
|-----------|-----------|
| machine | transitions |
`;

describe("parsePlanModels", () => {
  it("returns empty models for a plan without model sections", () => {
    const models = parsePlanModels("# Plan: X\n\n## Summary\n\nNothing.\n\n## Component Design\n\nStuff.");
    expect(models.lifecycles).toEqual([]);
    expect(models.pipeline).toBeNull();
    expect(models.invariants).toEqual([]);
    expect(hasModels(models)).toBe(false);
  });

  it("parses lifecycles with and without backticks on the machine file", () => {
    const models = parsePlanModels(FULL_PLAN);
    expect(models.lifecycles).toEqual([
      { id: "LC-1", title: "Order lifecycle", machineFile: "src/domain/order/order-machine.ts" },
      { id: "LC-2", title: "Refund lifecycle", machineFile: "src/domain/refund/refund-machine.ts" },
    ]);
  });

  it("parses the pipeline AuthoredDag path", () => {
    const models = parsePlanModels(FULL_PLAN);
    expect(models.pipeline).toEqual({ dagFile: ".claude/plans/2026-07-02-orders.dag.authored.json" });
  });

  it("parses invariants with tiers and rule files", () => {
    const models = parsePlanModels(FULL_PLAN);
    expect(models.invariants).toEqual([
      { id: "INV-1", title: "No state string literals outside the machine", tier: "checkable", ruleFile: ".claude/linter/rules/inv-1-no-raw-order-states.json" },
      { id: "INV-2", title: "Refunds complete within 30 days", tier: "advisory", ruleFile: null },
    ]);
    expect(hasModels(models)).toBe(true);
  });

  it("represents a lifecycle missing its machine file as null (parser is total)", () => {
    const models = parsePlanModels("## Lifecycles\n\n### LC-1: Orphan lifecycle\n\n**States:** a, b\n");
    expect(models.lifecycles).toEqual([{ id: "LC-1", title: "Orphan lifecycle", machineFile: null }]);
  });

  it("represents a Pipeline section without an AuthoredDag line as dagFile null", () => {
    const models = parsePlanModels("## Pipeline\n\nSome prose but no dag.\n");
    expect(models.pipeline).toEqual({ dagFile: null });
  });

  it("represents an unrecognized tier as null", () => {
    const models = parsePlanModels("## Invariants\n\n### INV-1: Weird\n\n**Tier:** enforced-ish\n");
    expect(models.invariants).toEqual([{ id: "INV-1", title: "Weird", tier: null, ruleFile: null }]);
  });

  it("tier matching is case-insensitive", () => {
    const models = parsePlanModels("## Invariants\n\n### INV-1: X\n\n**Tier:** Checkable\n**Rule file:** r.json\n");
    expect(models.invariants[0].tier).toBe("checkable");
  });

  it("stops a section at the next ## heading (no bleed between sections)", () => {
    const models = parsePlanModels("## Lifecycles\n\n### LC-1: A\n\n**Machine file:** m.ts\n\n## Invariants\n\n### INV-1: B\n\n**Tier:** advisory\n");
    expect(models.lifecycles).toHaveLength(1);
    expect(models.invariants).toHaveLength(1);
    expect(models.invariants[0].ruleFile).toBeNull();
  });

  it("ignores LC/INV headings outside their sections", () => {
    const models = parsePlanModels("## Notes\n\n### LC-1: Not a lifecycle\n\n**Machine file:** x.ts\n");
    expect(models.lifecycles).toEqual([]);
  });

  it("does not treat ### Pipeline subsections as the Pipeline section", () => {
    const models = parsePlanModels("## Component Design\n\n### Pipeline\n\n**AuthoredDag:** x.json\n");
    expect(models.pipeline).toBeNull();
  });

  it("empty field value is treated as absent", () => {
    const models = parsePlanModels("## Lifecycles\n\n### LC-1: A\n\n**Machine file:**   \n");
    expect(models.lifecycles[0].machineFile).toBeNull();
  });
});
