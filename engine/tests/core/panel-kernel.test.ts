import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  ARCHITECTURE_LAYOUT,
  REVIEW_LAYOUT,
  coverageErrors,
  ok,
  parseCriteriaSet,
  parseRunManifest,
  parseVerdictEnvelope,
  requireEntry,
  sanitizeProse,
  type VerdictEnvelope,
} from "../../src/core/panel-kernel";

/**
 * The kernel is the code BOTH panels depend on, and it was reachable only
 * through them: every guard below is shared, and a regression in one would show
 * up as a confusing failure in whichever consumer happened to exercise it first.
 * These are the shared guards, tested where they live.
 */

const RUN_DIR = "/runs/run.1";

describe("parseRunManifest — the shared item-set authority", () => {
  const spec = {
    label: "test manifest",
    contextMdKey: "brief_file",
    contextJsonKey: "brief_json",
    itemsKey: "findings",
    itemIdKey: "id",
    itemNoun: ["finding", "findings"] as const,
    expectedIds: ["a", "b"] as const,
    filenameOf: (id: string) => `finding-${id}.json`,
  };

  const wellFormed = {
    run_id: "run.1",
    brief_file: join(RUN_DIR, REVIEW_LAYOUT.contextMd),
    brief_json: join(RUN_DIR, REVIEW_LAYOUT.contextJson),
    findings: ["a", "b"].map((id) => ({
      id,
      filename: `finding-${id}.json`,
      path: join(RUN_DIR, REVIEW_LAYOUT.itemDir, `finding-${id}.json`),
    })),
  };

  it("accepts the exact ordered set", () => {
    const result = parseRunManifest(wellFormed, RUN_DIR, REVIEW_LAYOUT, spec);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("reports a non-object item rather than throwing inside a pure function", () => {
    const result = parseRunManifest(
      { ...wellFormed, findings: ["a string, not an entry", wellFormed.findings[1]] },
      RUN_DIR,
      REVIEW_LAYOUT,
      spec,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("manifest.findings[0] must be an object");
      // And the item it named is then MISSING, which is the diagnostic that
      // tells the orchestrator what to re-emit.
      expect(result.errors).toContain("manifest is missing finding: a");
    }
  });

  it("collects every error at once — a re-run should learn all its mistakes", () => {
    const result = parseRunManifest(
      { ...wellFormed, run_id: "wrong", brief_file: "/elsewhere/brief.md" },
      RUN_DIR,
      REVIEW_LAYOUT,
      spec,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the two panels' layouts apart at the type level", () => {
    // RunLayout<Panel> is a phantom tag: the two layouts are structurally
    // identical, so nothing but the tag stops a review run being validated
    // against the architecture layout.
    expect(ARCHITECTURE_LAYOUT.panel).toBe("architecture");
    expect(REVIEW_LAYOUT.panel).toBe("review");
    expect(ARCHITECTURE_LAYOUT.contextMd).not.toBe(REVIEW_LAYOUT.contextMd);
  });
});

describe("parseVerdictEnvelope — the shared agent-output boundary", () => {
  interface Vote {
    readonly itemId: string;
    readonly verdict: string;
  }
  const spec = {
    label: "test verdict",
    entriesKey: "verdicts",
    itemIdKey: "item",
    itemNoun: ["item", "items"] as const,
    parseEntry: (raw: Record<string, unknown>): ReturnType<typeof ok<Vote>> =>
      ok({ itemId: String(raw.item), verdict: String(raw.verdict) }),
  };

  const envelope = (verdicts: unknown[]) => JSON.stringify({ criterion: "intent", verdicts });

  it("reports a non-object entry instead of letting parseEntry see garbage", () => {
    const result = parseVerdictEnvelope(
      envelope(["not an object", { item: "b", verdict: "upheld" }]),
      "intent",
      ["a", "b"],
      spec,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("verdicts[0] must be an object");
      expect(result.errors.some((e) => e.includes("missing"))).toBe(true);
    }
  });

  it("rejects a foreign item id", () => {
    const result = parseVerdictEnvelope(
      envelope([{ item: "a", verdict: "upheld" }, { item: "z", verdict: "upheld" }]),
      "intent",
      ["a", "b"],
      spec,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("verdicts[1] has unknown item: z");
  });

  it("rejects a criterion the caller did not ask for", () => {
    const result = parseVerdictEnvelope(
      envelope([{ item: "a", verdict: "upheld" }]),
      "blast-radius",
      ["a"],
      spec,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('criterion must equal "blast-radius"');
  });
});

describe("requireEntry — the shared no-silent-default guard", () => {
  const envelope: VerdictEnvelope<{ id: string }> = {
    criterion: "intent",
    entries: [{ id: "a" }],
  };
  const byCriterion = new Map([["intent", envelope]]);

  it("returns the entry when coverage held", () => {
    expect(requireEntry(byCriterion, "intent", "a", (e) => e.id)).toEqual({ id: "a" });
  });

  it("THROWS rather than defaulting when the entry is absent", () => {
    // The whole point: the plausible defaults it replaces (`?? 0` for a score,
    // "abstain" for a vote) are exactly the values that would silently change
    // which architecture wins or whether a finding survives. Every caller runs
    // coverageErrors first, so a miss here is a broken invariant, not input.
    expect(() => requireEntry(byCriterion, "intent", "b", (e) => e.id)).toThrow(
      /panel kernel invariant/,
    );
  });

  it("throws for an absent criterion too, not just an absent item", () => {
    expect(() => requireEntry(byCriterion, "reproduction", "a", (e) => e.id)).toThrow(
      /panel kernel invariant/,
    );
  });

  it("is exactly the guard coverageErrors makes unreachable", () => {
    // The pairing: coverageErrors reports the gap, requireEntry refuses to
    // paper over it. If the first is ever weakened the second is what fails.
    const gaps = coverageErrors(byCriterion, ["intent"], ["a", "b"], (e) => e.id, "must judge each");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("must judge each");
  });
});

describe("sanitizeProse", () => {
  it("strips braces that would read as unsubstituted placeholders", () => {
    expect(sanitizeProse("  the {value} of {x}  ")).toBe("the value of x");
  });
});

describe("parseCriteriaSet — the cross-verdict coverage rule", () => {
  // The one rule in the kernel only a verdict SET can exercise: two verdicts
  // sharing a criterion silently produce a wrong aggregate, and the
  // per-verdict check (parseVerdictEnvelope) cannot see across verdicts.
  it("accepts a set covering the expected criteria exactly once, in any order", () => {
    expect(parseCriteriaSet(["intent", "reproduction"], ["intent", "reproduction"])).toEqual(ok(undefined));
    expect(parseCriteriaSet(["reproduction", "intent"], ["intent", "reproduction"])).toEqual(ok(undefined));
  });

  it("rejects TWO verdicts sharing one criterion (the silent-wrong-aggregate case)", () => {
    const result = parseCriteriaSet(["intent", "intent"], ["intent", "reproduction"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("; ")).toContain("duplicate verdict for criterion: intent");
      // The duplicate consumed the slot the missing criterion needed.
      expect(result.errors.join("; ")).toContain("missing verdict for criterion: reproduction");
    }
  });

  it("rejects a verdict naming a criterion nothing collected", () => {
    const result = parseCriteriaSet(["intent", "fabrication"], ["intent", "reproduction"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("; ")).toContain("unexpected verdict criterion: fabrication");
      expect(result.errors.join("; ")).toContain("missing verdict for criterion: reproduction");
    }
  });

  it("rejects a verdict-count mismatch (too few and too many)", () => {
    const short = parseCriteriaSet(["intent"], ["intent", "reproduction"]);
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.errors.join("; ")).toContain("expected exactly 2 verdict(s); received 1");
    const long = parseCriteriaSet(["a", "b", "c"], ["a", "b"]);
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.errors.join("; ")).toContain("expected exactly 2 verdict(s); received 3");
  });

  it("rejects an empty or non-distinct expected set (a config error, not a coverage gap)", () => {
    const empty = parseCriteriaSet([], []);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors.join("; ")).toContain("criteria must be non-empty");
    const duplicated = parseCriteriaSet(["intent"], ["intent", "intent"]);
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.errors.join("; ")).toContain("criteria must be distinct");
  });

  it("rejects an empty verdict set against non-empty expectations", () => {
    const result = parseCriteriaSet([], ["intent"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("; ")).toContain("expected exactly 1 verdict(s); received 0");
  });
});
