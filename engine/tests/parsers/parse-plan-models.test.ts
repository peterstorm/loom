import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlanModels, hasModels, renderStray, type Stray } from "../../src/parsers/parse-plan-models";

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
    expect(models.strays).toEqual([]);
    expect(hasModels(models)).toBe(false);
  });

  it("parses a full well-formed plan with zero strays", () => {
    const models = parsePlanModels(FULL_PLAN);
    expect(models.strays).toEqual([]);
    expect(models.lifecycles).toEqual([
      { id: "LC-1", title: "Order lifecycle", machineFile: "src/domain/order/order-machine.ts" },
      { id: "LC-2", title: "Refund lifecycle", machineFile: "src/domain/refund/refund-machine.ts" },
    ]);
    expect(models.pipeline).toEqual({
      dagFile: ".claude/plans/2026-07-02-orders.dag.authored.json",
      declaredNodes: ["fetch-order"],
    });
    expect(models.invariants).toEqual([
      { id: "INV-1", title: "No state string literals outside the machine", tier: "checkable", ruleFile: ".claude/linter/rules/inv-1-no-raw-order-states.json" },
      { id: "INV-2", title: "Refunds complete within 30 days", tier: "advisory", ruleFile: null },
    ]);
    expect(hasModels(models)).toBe(true);
  });

  it("represents a lifecycle missing its machine file as null (parser is total)", () => {
    const models = parsePlanModels("## Lifecycles\n\n### LC-1: Orphan lifecycle\n\n**States:** a, b\n");
    expect(models.lifecycles).toEqual([{ id: "LC-1", title: "Orphan lifecycle", machineFile: null }]);
    expect(models.strays).toEqual([]);
  });

  it("represents a Pipeline section without an AuthoredDag line as dagFile null", () => {
    const models = parsePlanModels("## Pipeline\n\nSome prose but no dag.\n");
    expect(models.pipeline).toEqual({ dagFile: null, declaredNodes: [] });
  });

  it("extracts node names from the Pipeline table's first column (header/separator skipped)", () => {
    const plan = [
      "## Pipeline",
      "",
      "**AuthoredDag:** `x.dag.authored.json`",
      "",
      "| Node | Kind | Purpose |",
      "|---|---|---|",
      "| fetch-order | fetch | load order |",
      "| `enrich` | llm | classify risk |",
      "| review | human-review | approve |",
    ].join("\n");
    const models = parsePlanModels(plan);
    expect(models.pipeline).toEqual({
      dagFile: "x.dag.authored.json",
      declaredNodes: ["fetch-order", "enrich", "review"],
    });
  });

  it("represents an unrecognized tier as null", () => {
    const models = parsePlanModels("## Invariants\n\n### INV-1: Weird\n\n**Tier:** enforced-ish\n");
    expect(models.invariants).toEqual([{ id: "INV-1", title: "Weird", tier: null, ruleFile: null }]);
  });

  it("tier matching is case-insensitive", () => {
    const models = parsePlanModels("## Invariants\n\n### INV-1: X\n\n**Tier:** Checkable\n**Rule file:** r.json\n");
    expect(models.invariants[0].tier).toBe("checkable");
  });

  it("section headings are case-insensitive", () => {
    const models = parsePlanModels("## lifecycles\n\n### LC-1: A\n\n**Machine file:** m.ts\n");
    expect(models.lifecycles).toHaveLength(1);
    expect(models.strays).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const models = parsePlanModels("## Lifecycles\r\n\r\n### LC-1: A\r\n\r\n**Machine file:** m.ts\r\n");
    expect(models.lifecycles).toEqual([{ id: "LC-1", title: "A", machineFile: "m.ts" }]);
    expect(models.strays).toEqual([]);
  });

  it("stops a section at the next ## heading (no bleed between sections)", () => {
    const models = parsePlanModels("## Lifecycles\n\n### LC-1: A\n\n**Machine file:** m.ts\n\n## Invariants\n\n### INV-1: B\n\n**Tier:** advisory\n");
    expect(models.lifecycles).toHaveLength(1);
    expect(models.invariants).toHaveLength(1);
    expect(models.invariants[0].ruleFile).toBeNull();
    expect(models.strays).toEqual([]);
  });

  it("empty field value is treated as absent", () => {
    const models = parsePlanModels("## Lifecycles\n\n### LC-1: A\n\n**Machine file:**   \n");
    expect(models.lifecycles[0].machineFile).toBeNull();
  });

  describe("strays — a typo is never an opt-out", () => {
    it("flags LC headings outside the Lifecycles section", () => {
      const models = parsePlanModels("## Notes\n\n### LC-1: Not a lifecycle\n\n**Machine file:** x.ts\n");
      expect(models.lifecycles).toEqual([]);
      expect(models.strays).toContainEqual({
        kind: "misplaced-heading",
        heading: "LC-1: Not a lifecycle",
        home: "Lifecycles",
      });
      // the misplaced Machine file label is flagged too
      expect(models.strays).toContainEqual({
        kind: "misplaced-label",
        label: "Machine file",
        home: "Lifecycles",
      });
      expect(hasModels(models)).toBe(true);
    });

    it("flags a near-miss section heading with a trailing colon", () => {
      const models = parsePlanModels("## Lifecycles:\n\n### LC-1: Order\n\n**Machine file:** m.ts\n");
      expect(models.lifecycles).toEqual([]);
      expect(models.strays).toContainEqual({ kind: "near-miss-heading", heading: "## Lifecycles:" });
    });

    it("flags a decorated section heading", () => {
      const models = parsePlanModels("## Invariants (enforced)\n\n### INV-1: B\n\n**Tier:** checkable\n");
      expect(models.invariants).toEqual([]);
      expect(models.strays).toContainEqual({ kind: "near-miss-heading", heading: "## Invariants (enforced)" });
    });

    it("flags a pluralized Pipeline heading", () => {
      const models = parsePlanModels("## Pipelines\n\n**AuthoredDag:** x.json\n");
      expect(models.pipeline).toBeNull();
      expect(models.strays).toContainEqual({ kind: "near-miss-heading", heading: "## Pipelines" });
    });

    it("flags a malformed block id inside its section (letter in the number)", () => {
      const models = parsePlanModels("## Invariants\n\n### INV-A1: Typo id\n\n**Tier:** checkable\n");
      expect(models.invariants).toEqual([]);
      expect(models.strays).toContainEqual({
        kind: "bad-block-grammar",
        heading: "INV-A1: Typo id",
        section: "Invariants",
        prefix: "INV",
      });
    });

    it("flags a lowercase block id (block grammar is case-sensitive by policy)", () => {
      const models = parsePlanModels("## Lifecycles\n\n### lc-1: Order\n\n**Machine file:** m.ts\n");
      expect(models.lifecycles).toEqual([]);
      expect(models.strays.some((s) => s.kind === "bad-block-grammar" && s.heading === "lc-1: Order")).toBe(true);
    });

    it("flags a block heading missing its colon", () => {
      const models = parsePlanModels("## Lifecycles\n\n### LC-1 Order\n\n**Machine file:** m.ts\n");
      expect(models.lifecycles).toEqual([]);
      expect(models.strays.some((s) => s.kind === "bad-block-grammar")).toBe(true);
    });

    it("flags non-model ### headings inside a model section", () => {
      const models = parsePlanModels("## Lifecycles\n\n### Order lifecycle\n\n**Machine file:** m.ts\n");
      expect(models.strays).toContainEqual({
        kind: "bad-block-grammar",
        heading: "Order lifecycle",
        section: "Lifecycles",
        prefix: "LC",
      });
    });

    it("flags model field labels outside their sections", () => {
      const models = parsePlanModels("## Component Design\n\n### Pipeline\n\n**AuthoredDag:** x.json\n");
      expect(models.pipeline).toBeNull();
      expect(models.strays).toContainEqual({ kind: "misplaced-label", label: "AuthoredDag", home: "Pipeline" });
    });

    it("a well-formed plan quoting the template inside a code fence produces no strays", () => {
      const fenced = "# Plan\n\n## Summary\n\nExample from the template:\n\n```markdown\n## Lifecycles\n\n### LC-1: Example\n\n**Machine file:** `example.ts`\n```\n";
      const models = parsePlanModels(fenced);
      expect(models.lifecycles).toEqual([]);
      expect(models.strays).toEqual([]);
      expect(hasModels(models)).toBe(false);
    });

    it("fences inside a real section do not truncate it", () => {
      const plan = "## Lifecycles\n\n### LC-1: A\n\n```ts\n## not a heading\n```\n\n**Machine file:** m.ts\n";
      const models = parsePlanModels(plan);
      expect(models.lifecycles).toEqual([{ id: "LC-1", title: "A", machineFile: "m.ts" }]);
      expect(models.strays).toEqual([]);
    });

    it("an UNTERMINATED fence is a stray, not a silent opt-out", () => {
      const plan = "# Plan\n\nSnippet:\n\n```bash\necho hi\n\n## Lifecycles\n\n### LC-1: Order\n\n**Machine file:** m.ts\n";
      const models = parsePlanModels(plan);
      expect(models.lifecycles).toEqual([]); // blanked by the open fence…
      expect(models.strays).toContainEqual({ kind: "unterminated-fence" }); // …but loudly
      expect(hasModels(models)).toBe(true);
    });

    it("a ``` fence is not closed early by a ~~~ line (and vice versa)", () => {
      const plan = "## Lifecycles\n\n### LC-1: A\n\n```md\n~~~\n### LC-9: Phantom\n~~~\n```\n\n**Machine file:** m.ts\n";
      const models = parsePlanModels(plan);
      expect(models.lifecycles).toEqual([{ id: "LC-1", title: "A", machineFile: "m.ts" }]);
      expect(models.strays).toEqual([]);
    });

    it("a declared section with zero blocks is a stray", () => {
      const lc = parsePlanModels("## Lifecycles\n\nProse about lifecycles but no blocks.\n");
      expect(lc.strays).toContainEqual({ kind: "empty-section", section: "Lifecycles" });
      expect(hasModels(lc)).toBe(true);
      const inv = parsePlanModels("## Invariants\n\nNothing formal.\n");
      expect(inv.strays).toContainEqual({ kind: "empty-section", section: "Invariants" });
    });
  });
});

describe("renderStray — every variant renders its context", () => {
  it("produces the human-readable message for each stray kind", () => {
    const cases: Array<[Stray, string]> = [
      [{ kind: "unterminated-fence" }, "unterminated code fence"],
      [{ kind: "empty-section", section: "Lifecycles" }, "'## Lifecycles' section is declared but contains no '### ' blocks"],
      [{ kind: "near-miss-heading", heading: "## Lifecycles:" }, "near-miss section heading '## Lifecycles:'"],
      [
        { kind: "bad-block-grammar", heading: "INV-A1: x", section: "Invariants", prefix: "INV" },
        "heading '### INV-A1: x' inside '## Invariants' does not match '### INV-<n>: <title>'",
      ],
      [
        { kind: "misplaced-heading", heading: "LC-1: Order", home: "Lifecycles" },
        "heading '### LC-1: Order' found outside its '## Lifecycles' section",
      ],
      [
        { kind: "misplaced-label", label: "AuthoredDag", home: "Pipeline" },
        "'**AuthoredDag:**' line found outside a '## Pipeline' section",
      ],
    ];
    for (const [stray, expected] of cases) {
      expect(renderStray(stray)).toContain(expected);
    }
  });
});

describe("template conformance — the shipped plan template parses cleanly", () => {
  it("references/plan-template.md model sections match the parser grammar", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const templatePath = join(here, "..", "..", "..", "references", "plan-template.md");
    const raw = readFileSync(templatePath, "utf-8");
    // The template body is one ```markdown fence containing nested ``` fences —
    // match greedily to the last closer in the file
    const fence = /```markdown\n([\s\S]*)\n```/.exec(raw);
    expect(fence).not.toBeNull();
    const models = parsePlanModels(fence![1]);

    expect(models.strays).toEqual([]);
    expect(models.lifecycles).toHaveLength(1);
    expect(models.lifecycles[0].id).toBe("LC-1");
    expect(models.lifecycles[0].machineFile).not.toBeNull();
    expect(models.pipeline).not.toBeNull();
    expect(models.pipeline!.dagFile).not.toBeNull();
    expect(models.invariants).toHaveLength(2);
    expect(models.invariants[0].tier).toBe("checkable");
    expect(models.invariants[0].ruleFile).not.toBeNull();
    expect(models.invariants[1].tier).toBe("advisory");
  });
});
