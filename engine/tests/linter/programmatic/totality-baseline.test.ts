/**
 * Both totality rules ship a grandfathered list, and a grandfathered list is
 * only honest while it still describes the tree. `scripts/lint-project.ts`
 * reports stale entries, but a script nobody runs is how the lists decayed to
 * begin with — so the assertion lives here, against the live repository.
 *
 * It is also the only test that proves the two rules and their baselines agree
 * about WHAT they measure: `detected*Keys` runs the same traversal the handler
 * runs, so a key the rule stops producing (or a switch no rule ever sees at the
 * key's path) fails here rather than silently excusing nothing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SWITCH_TOTALITY_BASELINE } from "../../../src/linter/programmatic/switch-totality-baseline";
import { EXHAUSTIVE_BRANCHING_BASELINE } from "../../../src/linter/programmatic/exhaustive-discriminant-branching-baseline";
import { unusedBaselineEntries as unusedBaselineEntriesOf } from "../../../src/linter/programmatic/baseline";
import {
  DEFAULT_SWITCH_TOTALITY_MODULES,
  detectedSwitchKeys,
  handler as switchTotality,
  unusedBaselineEntries as unusedSwitchEntries,
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

describe("switch-totality baseline", () => {
  it("names a site for every grandfathered switch it still excuses", () => {
    const detected = PRODUCTION.flatMap((path) =>
      detectedSwitchKeys(readFileSync(join(REPO_ROOT, path), "utf-8"), path));
    expect(unusedSwitchEntries(detected, SWITCH_TOTALITY_BASELINE)).toEqual([]);
  });

  it("excuses every one of those sites in the live tree, so the list is not just well-formed", () => {
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
  it("names a chain for every grandfathered entry it still excuses", () => {
    const detected = PRODUCTION.flatMap((path) =>
      detectedChainKeys(readFileSync(join(REPO_ROOT, path), "utf-8"), path,
        DEFAULT_MAX_DISCRIMINANT_BRANCHES, DEFAULT_DISCRIMINANT_TAGS));
    expect(unusedBaselineEntriesOf(detected, EXHAUSTIVE_BRANCHING_BASELINE)).toEqual([]);
  });

  it("excuses every chain in the live tree", () => {
    const violations = PRODUCTION.flatMap((path) =>
      chainRule(readFileSync(join(REPO_ROOT, path), "utf-8"), path,
        DEFAULT_MAX_DISCRIMINANT_BRANCHES, DEFAULT_DISCRIMINANT_TAGS));
    expect(violations).toEqual([]);
  });

  it("never grows by accident: a chain in a file the baseline has not seen is a violation", () => {
    const source = [
      "function pick(event: Event): string {",
      '  if (event.kind === "a") return "a";',
      '  if (event.kind === "b") return "b";',
      '  if (event.kind === "c") return "c";',
      '  return "?";',
      "}",
    ].join("\n");
    expect(chainRule(source, "engine/src/core/brand-new.ts", 3, DEFAULT_DISCRIMINANT_TAGS, [])).toHaveLength(1);
  });
});

