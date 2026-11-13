/**
 * Both totality rules keep a grandfathered list, and a grandfathered list is
 * only honest while it still describes the tree. `scripts/lint-project.ts`
 * reports stale entries, but a script nobody runs is how the lists decayed to
 * begin with — so the assertion lives here, against the live repository.
 *
 * The lists are PROJECT data: loom's own live in loom's linter `config.json`
 * (`.claude/linter/rules/config.json`, with its byte-identical Pi twin), read
 * through the same loader and owner registry every project's are. This file is
 * the proof that loom is held to the rule the way a target project is — no
 * list keyed to loom's tree ships inside the linter.
 *
 * It is also the only test that proves the rules and their baselines agree
 * about WHAT they measure: each owner's detector runs the same analysis its
 * handler runs, with the same options, so a key the rule stops producing — the
 * site was deleted, renamed, or since PROVEN total — fails here rather than
 * silently excusing nothing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  baselineKey,
  baselineKeyPath,
  staleBaselineEntries,
  unbaselinedSites,
  unusedBaselineEntries,
} from "../../../src/linter/programmatic/baseline";
import { baselineOwners } from "../../../src/linter/programmatic/index";
import { projectRootOf } from "../../../src/linter/programmatic/config";
import { authoritativeLintContext, loadRules } from "../../../src/linter/loader";
import { executeRules } from "../../../src/linter/executor";
import { isLintableName, isNeverSourceDirectory, scopeOf } from "../../../src/linter/project-scope";
import { LOOM_CONFIG, LOOM_RULES_DIR, REPO_ROOT } from "../loom-project-config";
import {
  DEFAULT_DISCRIMINANT_BRANCHING_OPTIONS,
  detectedChainKeys,
  handler as chainRule,
} from "../../../src/linter/programmatic/exhaustive-discriminant-branching";

/** Each owner detects against Loom's own clone corpus, fingerprinted from the files' bytes as `lint-project` does. */
const LOOM_OWNERS = baselineOwners(authoritativeLintContext(LOOM_CONFIG, REPO_ROOT));

/**
 * Every lintable file `lint-project` reads, repo-relative and sorted: the same
 * never-source directories, the same lintable names and the same `exclude`
 * entries (`project-scope.ts`), so this guard sees exactly the tree the rules
 * see — `.mts` and `.cts` included. Test files stay in: each detector skips
 * them itself, as the rule does.
 */
function lintedFiles(dir: string): readonly string[] {
  return readdirSync(dir).sort().flatMap((entry): readonly string[] => {
    if (isNeverSourceDirectory(entry)) return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return lintedFiles(full);
    return isLintableName(entry) ? [full.slice(REPO_ROOT.length + 1).replace(/\\/g, "/")] : [];
  });
}

const LINTED = lintedFiles(REPO_ROOT).filter((path) => scopeOf(path, LOOM_CONFIG.exclude ?? []).kind === "lint");

const readRepoSource = (path: string): string | null => {
  try {
    return readFileSync(join(REPO_ROOT, path), "utf-8");
  } catch {
    return null;
  }
};

describe("loom's own totality baselines", () => {
  it("live in loom's linter config, one list per baselined rule, applied to the whole tree", () => {
    expect(LOOM_OWNERS.map((owner) => [owner.rule, owner.configKey])).toEqual([
      ["switch-totality", "switchTotalityBaseline"],
      ["exhaustive-discriminant-branching", "discriminantBranchingBaseline"],
      ["no-duplicate-block", "duplicateBlockBaseline"],
      ["no-wire-cast", "wireCastBaseline"],
    ]);
    // The drift message is rule-aware: a chain entry never reads as a switch.
    expect(LOOM_OWNERS.map((owner) => owner.site))
      .toEqual(["unproven switch", "unproven if-chain", "copied block", "unparsed wire value"]);
    // Loom grandfathers no wire value typed without being parsed: the rule's
    // "nothing above the baseline" case below is the whole tree, held to zero.
    expect(LOOM_CONFIG.wireCastBaseline).toBeUndefined();
    // Loom does not narrow switch-totality: it holds itself to the default
    // every target project gets.
    expect(LOOM_CONFIG.switchTotalityModules).toBeUndefined();
    expect(LOOM_CONFIG.switchTotalityBaseline?.length).toBeGreaterThan(0);
    expect(projectRootOf(LOOM_RULES_DIR)).toBe(REPO_ROOT);
  });

  it.each(LOOM_OWNERS.map((owner) => [owner.rule, owner] as const))(
    "%s: every grandfathered entry still names a live unproven site",
    (_rule, owner) => {
      expect(staleBaselineEntries(owner, readRepoSource)).toEqual([]);
    },
  );

  it.each(LOOM_OWNERS.map((owner) => [owner.rule, owner] as const))(
    "%s: the baseline excuses every site in the live tree, so a new unproven site fails here",
    (_rule, owner) => {
      const detected = LINTED
        .filter((path) => owner.extensions.some((extension) => path.endsWith(extension)))
        .flatMap((path) => owner.detect(readFileSync(join(REPO_ROOT, path), "utf-8"), path));
      // Every detected site has an entry: nothing above the baseline.
      expect(unbaselinedSites({ detected, baseline: owner.baseline })).toEqual([]);
    },
  );

  it.each(LOOM_OWNERS.map((owner) => [owner.rule, owner] as const))(
    "%s: the list is sorted and free of blank entries, so a diff shows which file moved",
    (_rule, owner) => {
      expect([...owner.baseline]).toEqual([...owner.baseline].sort());
      // A project-relative path, then whatever expression the site branched
      // on — a scrutinee can be `entry["type"]`, not only `x.kind`.
      for (const key of owner.baseline) expect(key).toMatch(/^[^/:][^:]*::\S.*$/);
    },
  );

  it("is excused through the PRODUCTION loader, from an absolute path — the path the edit hook takes", () => {
    // `lintFile` hands rules absolute paths and finds the project root from the
    // rules directory. A baselined site must stay excused on that path, and a
    // fresh copy of the same switch in an unbaselined file must not.
    const [baselined] = LOOM_CONFIG.switchTotalityBaseline!;
    const path = baselineKeyPath(baselined!);
    const rules = loadRules(join(REPO_ROOT, "lint-rules"), LOOM_RULES_DIR, "immediate")
      .filter((rule) => rule.name === "switch-totality");
    const absolute = join(REPO_ROOT, path);
    const source = readFileSync(absolute, "utf-8");
    expect(executeRules(rules, absolute, source, () => undefined, REPO_ROOT)).toEqual([]);
    expect(executeRules(rules, join(REPO_ROOT, "engine/src/core/unbaselined-copy.ts"), source, () => undefined, REPO_ROOT).length)
      .toBeGreaterThan(0);
  });

  it("reports an entry whose file is gone, and one whose site was proven, as stale", () => {
    const [switchOwner] = LOOM_OWNERS;
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

  it("reports a wire-cast entry whose file is gone, and one whose value is now parsed, as stale", () => {
    const wireCastOwner = LOOM_OWNERS.find((candidate) => candidate.rule === "no-wire-cast");
    if (wireCastOwner === undefined) throw new Error("no-wire-cast keeps a baseline");
    const path = "engine/src/core/converted.ts";
    const live = baselineKey("engine/src/core/unparsed.ts", "as Order");
    const stale = [baselineKey(path, "as Order"), baselineKey("engine/src/core/deleted.ts", "order: Order")];
    const owner = { ...wireCastOwner, baseline: [live, ...stale] };
    const sources: Readonly<Record<string, string>> = {
      [path]: "export const order = parseOrder(JSON.parse(text));",
      "engine/src/core/unparsed.ts": "export const order = JSON.parse(text) as Order;",
    };
    expect(staleBaselineEntries(owner, (file) => sources[file] ?? null)).toEqual(stale);
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
  const NO_BASELINE = DEFAULT_DISCRIMINANT_BRANCHING_OPTIONS;

  it("keys a path OUTSIDE engine/src relative to the project root, so a pi/ baseline entry is live", () => {
    // `lintFile` hands rules absolute paths. The old anchor list only knew
    // loom's directory names; the project root makes every path keyable.
    const path = "pi/implementation-brief-expansion.ts";
    const absolute = join(REPO_ROOT, path);
    const source = readFileSync(absolute, "utf-8");
    const options = { ...NO_BASELINE, projectRoot: REPO_ROOT };
    const detected = detectedChainKeys(source, absolute, options);
    expect(detected.length).toBeGreaterThan(0);
    const baseline = detected.filter((key) => key.startsWith(`${path}::`));
    expect(baseline).toEqual(LOOM_CONFIG.discriminantBranchingBaseline!.filter((entry) => entry.startsWith(`${path}::`)));
    expect(unusedBaselineEntries({ detected, baseline })).toEqual([]);
    expect(chainRule(source, absolute, { ...options, baseline })).toEqual([]);
  });

  it("never grows by accident: a chain in a file the baseline has not seen is a violation", () => {
    expect(chainRule(CHAIN, "engine/src/core/brand-new.ts", NO_BASELINE)).toHaveLength(1);
  });

  it("reports a baselined chain's entry unused once a totality proof sits beside it", () => {
    const path = "engine/src/core/brand-new.ts";
    const baseline = [baselineKey(path, "event.kind")];
    expect(unusedBaselineEntries({ detected: detectedChainKeys(CHAIN, path), baseline })).toEqual([]);
    // The chain is now proven by the `never` binding below its tail: the rule
    // no longer flags it, so nothing may keep consuming its entry.
    const proven = CHAIN.replace('  return "?";', "  const unreachable: never = event;\n  return unreachable;");
    expect(chainRule(proven, path, NO_BASELINE)).toEqual([]);
    expect(unusedBaselineEntries({ detected: detectedChainKeys(proven, path), baseline })).toEqual(baseline);
  });

  it("detects no chain in a test file, matching the handler", () => {
    expect(detectedChainKeys(CHAIN, "engine/src/core/brand-new.test.ts")).toEqual([]);
    expect(chainRule(CHAIN, "engine/src/core/brand-new.test.ts", NO_BASELINE)).toEqual([]);
  });
});
