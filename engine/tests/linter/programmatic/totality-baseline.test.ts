/**
 * Both totality rules ship a grandfathered list, and a grandfathered list is
 * only honest while it still describes the tree. `scripts/lint-project.ts`
 * reports stale entries, but a script nobody runs is how the lists decayed to
 * begin with — so the assertion lives here, against the live repository.
 *
 * It is also the only test that proves the rules and their baselines agree
 * about WHAT they measure: each owner's detector runs the same analysis its
 * handler runs, so a key the rule stops producing — the site was deleted,
 * renamed, or since PROVEN total — fails here rather than silently excusing
 * nothing. Both the script and this test iterate `BASELINE_OWNERS`, so a
 * baselined rule cannot be left out of either.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SWITCH_TOTALITY_BASELINE } from "../../../src/linter/programmatic/switch-totality-baseline";
import { EXHAUSTIVE_BRANCHING_BASELINE } from "../../../src/linter/programmatic/exhaustive-discriminant-branching-baseline";
import { baselineKey, staleBaselineEntries, unusedBaselineEntries } from "../../../src/linter/programmatic/baseline";
import { BASELINE_OWNERS } from "../../../src/linter/programmatic/index";
import {
  DEFAULT_SWITCH_TOTALITY_MODULES,
  handler as switchTotality,
} from "../../../src/linter/programmatic/switch-totality";
import {
  DEFAULT_MAX_DISCRIMINANT_BRANCHES,
  DEFAULT_DISCRIMINANT_TAGS,
  detectedChainKeys,
  handler as chainRule,
} from "../../../src/linter/programmatic/exhaustive-discriminant-branching";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Every `.ts`/`.tsx` the rules can see, repo-relative and sorted. */
function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [full] : [];
  }).sort();
}

const RELATIVE = sourceFiles(REPO_ROOT).map((full) => full.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"));
const PRODUCTION = RELATIVE.filter((path) => !path.includes(".test.") && !path.includes(".spec."));

const readRepoSource = (path: string): string | null => {
  try {
    return readFileSync(join(REPO_ROOT, path), "utf-8");
  } catch {
    return null;
  }
};

describe("the baseline owner registry", () => {
  it("registers both baselined rules, each with its own list", () => {
    expect(BASELINE_OWNERS.map((owner) => [owner.rule, owner.baseline])).toEqual([
      ["switch-totality", SWITCH_TOTALITY_BASELINE],
      ["exhaustive-discriminant-branching", EXHAUSTIVE_BRANCHING_BASELINE],
    ]);
    // The drift message is rule-aware: a chain entry never reads as a switch.
    expect(BASELINE_OWNERS.map((owner) => owner.site)).toEqual(["unproven switch", "unproven if-chain"]);
  });

  it.each(BASELINE_OWNERS.map((owner) => [owner.rule, owner] as const))(
    "%s: every grandfathered entry still names a live unproven site",
    (_rule, owner) => {
      expect(staleBaselineEntries(owner, readRepoSource)).toEqual([]);
    },
  );

  it("reports an entry whose file is gone, and one whose site was proven, as stale", () => {
    const [switchOwner] = BASELINE_OWNERS;
    const path = "engine/src/core/converted.ts";
    const owner = { ...switchOwner!, baseline: [baselineKey(path, "x.kind"), baselineKey("engine/src/core/deleted.ts", "y.kind")] };
    const proven = [
      `switch (x.kind) {`,
      `  case "a": return 1;`,
      `  case "b": return 2;`,
      `  default: {`,
      `    const unreachable: never = x;`,
      `    return unreachable;`,
      `  }`,
      `}`,
    ].join("\n");
    expect(staleBaselineEntries(owner, (file) => (file === path ? proven : null))).toEqual(owner.baseline);
  });
});

describe("switch-totality baseline", () => {
  it("excuses every one of its sites in the live tree, so the list is not just well-formed", () => {
    const violations = PRODUCTION
      .filter((path) => DEFAULT_SWITCH_TOTALITY_MODULES.some((module) => path.includes(module)))
      .flatMap((path) => switchTotality(readFileSync(join(REPO_ROOT, path), "utf-8"), path));
    expect(violations).toEqual([]);
  });

  it("keeps the list sorted and free of blank entries, so a diff shows which file moved", () => {
    expect([...SWITCH_TOTALITY_BASELINE]).toEqual([...SWITCH_TOTALITY_BASELINE].sort());
    for (const key of SWITCH_TOTALITY_BASELINE) {
      expect(key).toMatch(/^engine\/(?:src\/(?:core|machine)\/[^:]+|handlers\/[^:]+|linter\/[^:]+|[^:]+)::[A-Za-z_$][\w$.]*$/);
    }
  });
});

describe("exhaustive-discriminant-branching baseline", () => {
  const CHAIN = [
    "function pick(event: Event): string {",
    '  if (event.kind === "a") return "a";',
    '  if (event.kind === "b") return "b";',
    '  if (event.kind === "c") return "c";',
    '  return "?";',
    "}",
  ].join("\n");

  it("excuses every chain in the live tree", () => {
    const violations = PRODUCTION.flatMap((path) =>
      chainRule(readFileSync(join(REPO_ROOT, path), "utf-8"), path,
        DEFAULT_MAX_DISCRIMINANT_BRANCHES, DEFAULT_DISCRIMINANT_TAGS));
    expect(violations).toEqual([]);
  });

  it("normalizes a path OUTSIDE the module anchors, so a pi/ baseline entry is live", () => {
    // `lintFile` hands rules absolute paths. Anchoring only on `engine/src/*`
    // left a `pi/…` path absolute, so every key written for that tree was dead
    // and the rule reported the very site it was supposed to grandfather.
    const path = "pi/implementation-brief-expansion.ts";
    const absolute = join(REPO_ROOT, path);
    const source = readFileSync(absolute, "utf-8");
    const detected = detectedChainKeys(source, absolute, DEFAULT_MAX_DISCRIMINANT_BRANCHES, DEFAULT_DISCRIMINANT_TAGS);
    expect(detected.length).toBeGreaterThan(0);
    const baseline = detected.filter((key) => key.startsWith(`${path}::`));
    expect(baseline).toEqual([EXHAUSTIVE_BRANCHING_BASELINE.find((entry) => entry.startsWith(`${path}::`))]);
    expect(unusedBaselineEntries(detected, baseline)).toEqual([]);
    expect(chainRule(source, absolute, DEFAULT_MAX_DISCRIMINANT_BRANCHES, DEFAULT_DISCRIMINANT_TAGS)).toEqual([]);
  });

  it("never grows by accident: a chain in a file the baseline has not seen is a violation", () => {
    expect(chainRule(CHAIN, "engine/src/core/brand-new.ts", 3, DEFAULT_DISCRIMINANT_TAGS, [])).toHaveLength(1);
  });

  it("reports a baselined chain's entry unused once a totality proof sits beside it", () => {
    const path = "engine/src/core/brand-new.ts";
    const baseline = [baselineKey(path, "event.kind")];
    expect(unusedBaselineEntries(detectedChainKeys(CHAIN, path), baseline)).toEqual([]);
    // The chain is now proven by the `never` binding below its tail: the rule
    // no longer flags it, so nothing may keep consuming its entry.
    const proven = CHAIN.replace('  return "?";', "  const unreachable: never = event;\n  return unreachable;");
    expect(chainRule(proven, path, 3, DEFAULT_DISCRIMINANT_TAGS, [])).toEqual([]);
    expect(unusedBaselineEntries(detectedChainKeys(proven, path), baseline)).toEqual(baseline);
  });

  it("detects no chain in a test file, matching the handler", () => {
    expect(detectedChainKeys(CHAIN, "engine/src/core/brand-new.test.ts")).toEqual([]);
    expect(chainRule(CHAIN, "engine/src/core/brand-new.test.ts", 3, DEFAULT_DISCRIMINANT_TAGS, [])).toEqual([]);
  });
});
