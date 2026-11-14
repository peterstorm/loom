/**
 * Lint coverage (`linter/lint-coverage.ts`): every opt-in rule family of a
 * set-up project is configured, declined with its reason, or a gap; a project
 * with no rules directory has no setup at all. The `declined` list is parsed
 * strictly by the config loader (`programmatic/config.ts`).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  coverageCheckFailedNote,
  coverageGapLine,
  coverageGaps,
  coverageReminder,
  lintCoverage,
  sessionReminder,
  type LintCoverage,
  type ProjectCoverage,
} from "../../src/linter/lint-coverage";
import { OPT_IN_CONFIG_KEYS, parseProjectConfig, type OptInConfigKey, type ProgrammaticConfig } from "../../src/linter/programmatic/config";
import { parseCoverageIgnoreList, type IgnoreListParse } from "../../src/core/lint-coverage-ignore";

const COMMANDS = { init: "bun lint-project.ts --init", ignore: "bun cli.ts helper lint-coverage ignore --reason \"<why>\"" };

/** The config value that turns each family on. */
const ON: Readonly<Record<OptInConfigKey, unknown>> = {
  boundaries: [{ module: "src/domain/", allow: ["src/domain/"], deny: [] }],
  pureModules: ["src/domain/"],
  requireGovernance: ["src/"],
  docReferences: { govern: [{ path: "docs/", reason: "the docs name the tree" }] },
};

const parsed = (document: Record<string, unknown>): ProgrammaticConfig => {
  const result = parseProjectConfig(document, "config.json");
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

/** Each family's decision: on, declined, or left out. */
const decisionArb = fc.constantFrom("configured", "declined", "gap");
const decisionsArb = fc.record({
  boundaries: decisionArb,
  pureModules: decisionArb,
  requireGovernance: decisionArb,
  docReferences: decisionArb,
});

const documentOf = (decisions: Readonly<Record<OptInConfigKey, string>>): Record<string, unknown> => ({
  ...Object.fromEntries(OPT_IN_CONFIG_KEYS.filter((key) => decisions[key] === "configured").map((key) => [key, ON[key]])),
  declined: OPT_IN_CONFIG_KEYS.filter((key) => decisions[key] === "declined").map((key) => ({ key, reason: `no ${key} here` })),
});

describe("lintCoverage", () => {
  it("a project with no rules directory has no setup, and no gaps to fail on", () => {
    expect(lintCoverage(null)).toEqual({ kind: "no-setup" });
    expect(coverageGaps(lintCoverage(null))).toEqual([]);
  });

  it("an empty config leaves every family a gap", () => {
    expect(coverageGaps(lintCoverage({}))).toEqual([...OPT_IN_CONFIG_KEYS]);
  });

  it("an empty boundaries or pureModules list checks nothing, so it is a gap", () => {
    expect(coverageGaps(lintCoverage(parsed({ boundaries: [], pureModules: [] })))).toEqual(["boundaries", "pureModules", "requireGovernance", "docReferences"]);
  });

  it("property: every family has exactly the status its config gives it, in key order", () => {
    fc.assert(fc.property(decisionsArb, (decisions) => {
      const coverage = lintCoverage(parsed(documentOf(decisions)));
      expect(coverage.kind).toBe("set-up");
      if (coverage.kind !== "set-up") return;
      expect(coverage.families.map(({ key }) => key)).toEqual([...OPT_IN_CONFIG_KEYS]);
      for (const family of coverage.families) expect(family.kind).toBe(decisions[family.key]);
      expect(coverageGaps(coverage)).toEqual(OPT_IN_CONFIG_KEYS.filter((key) => decisions[key] === "gap"));
    }));
  });

  it("property: a declined family carries the reason it was declined with", () => {
    fc.assert(fc.property(fc.constantFrom(...OPT_IN_CONFIG_KEYS), fc.string({ minLength: 1 }).filter((s) => s.trim() !== ""), (key, reason) => {
      const coverage = lintCoverage(parsed({ declined: [{ key, reason }] }));
      expect(coverage.kind === "set-up" && coverage.families.find((family) => family.key === key)).toEqual({ key, kind: "declined", reason });
    }));
  });
});

describe("the declined list, parsed strictly", () => {
  const refusal = (document: Record<string, unknown>): string => {
    const result = parseProjectConfig(document, "config.json");
    return result.ok ? "accepted" : result.error;
  };

  it("property: a family both configured and declined is refused, never read one way", () => {
    fc.assert(fc.property(fc.constantFrom(...OPT_IN_CONFIG_KEYS), (key) => {
      expect(refusal({ [key]: ON[key], declined: [{ key, reason: "both" }] })).toContain(`'${key}' is both configured and declined — keep one`);
    }));
  });

  it("accepts declining a family whose list is empty: an empty list turns nothing on, as coverage says", () => {
    for (const key of ["boundaries", "pureModules"] as const) {
      const coverage = lintCoverage(parsed({ [key]: [], declined: [{ key, reason: "no layers here" }] }));
      expect(coverage.kind === "set-up" && coverage.families.find((family) => family.key === key))
        .toEqual({ key, kind: "declined", reason: "no layers here" });
    }
  });

  it("property: the parse refuses a decline exactly when coverage would call the family configured", () => {
    const valueArb = fc.record({
      boundaries: fc.constantFrom([], ON.boundaries),
      pureModules: fc.constantFrom([], ON.pureModules),
      requireGovernance: fc.constant(ON.requireGovernance),
      docReferences: fc.constant(ON.docReferences),
    });
    fc.assert(fc.property(fc.constantFrom(...OPT_IN_CONFIG_KEYS), valueArb, (key, values) => {
      const configured = lintCoverage(parsed({ [key]: values[key] }));
      const isOn = configured.kind === "set-up" && configured.families.some((family) => family.key === key && family.kind === "configured");
      const withDecline = parseProjectConfig({ [key]: values[key], declined: [{ key, reason: "why" }] }, "config.json");
      expect(withDecline.ok).toBe(!isOn);
    }));
  });

  it("refuses a non-array, an unknown key, a key that is not opt-in, an empty reason and a key declined twice", () => {
    expect(refusal({ declined: {} })).toContain("'declined' must be an array of { key, reason }");
    expect(refusal({ declined: [{ key: "boundaries", reason: "x", why: "y" }] })).toContain("unknown key");
    expect(refusal({ declined: [{ key: "maxFunctionLines", reason: "x" }] })).toContain("must be one of boundaries, pureModules, requireGovernance, docReferences");
    expect(refusal({ declined: [{ key: "boundaries", reason: "  " }] })).toContain("every declined family states why");
    expect(refusal({ declined: [{ key: "boundaries", reason: "a" }, { key: "boundaries", reason: "b" }] })).toContain("'declined' lists 'boundaries' twice");
  });
});

describe("coverageGapLine", () => {
  it("names the family, what it checks, and both ways to decide it", () => {
    expect(coverageGapLine("docReferences")).toBe(
      "coverage: 'docReferences' is off, so doc and comment references that resolve (no-dangling-doc-reference) checks nothing — " +
      "configure it (lint-project --init infers what it can) or add { \"key\": \"docReferences\", \"reason\": \"…\" } to 'declined'",
    );
  });
});

describe("coverageReminder", () => {
  const setUp = (gaps: readonly OptInConfigKey[]): LintCoverage => lintCoverage(parsed(documentOf(
    Object.fromEntries(OPT_IN_CONFIG_KEYS.map((key) => [key, gaps.includes(key) ? "gap" : "declined"])) as Record<OptInConfigKey, string>,
  )));

  it("says nothing for a fully covered project", () => {
    expect(coverageReminder("/repo", setUp([]), COMMANDS)).toBeNull();
  });

  it("tells a project with no setup what it is missing and how to turn it on or silence it", () => {
    const reminder = coverageReminder("/repo", lintCoverage(null), COMMANDS);
    expect(reminder?.forOperator).toBe("Loom lint: /repo has no lint setup — ask Claude to turn it on, or silence this for the repository.");
    expect(reminder?.forModel).toContain("`/repo` has no Loom lint setup");
    expect(reminder?.forModel).toContain(`\`${COMMANDS.init}\``);
    expect(reminder?.forModel).toContain(`\`${COMMANDS.ignore}\``);
    expect(reminder?.forModel.startsWith("<!-- LOOM LINT COVERAGE -->")).toBe(true);
    expect(reminder?.forModel.endsWith("<!-- END LOOM LINT COVERAGE -->")).toBe(true);
  });

  it("property: a set-up project's reminder names exactly its gaps", () => {
    fc.assert(fc.property(fc.subarray([...OPT_IN_CONFIG_KEYS], { minLength: 1 }), (gaps) => {
      const reminder = coverageReminder("/repo", setUp(gaps), COMMANDS);
      expect(reminder).not.toBeNull();
      for (const key of OPT_IN_CONFIG_KEYS) {
        expect(reminder?.forModel.includes(`- \`${key}\`:`)).toBe(gaps.includes(key));
      }
      expect(reminder?.forOperator).toContain(`(${gaps.join(", ")})`);
    }));
  });
});

describe("sessionReminder — what the session hears, from what the shell read", () => {
  const ignoreList = (paths: readonly string[]): IgnoreListParse =>
    parseCoverageIgnoreList({ ignore: paths.map((path) => ({ path, reason: "not mine" })) });
  const UNREADABLE: IgnoreListParse = { ok: false, error: "/cfg/list.json is not JSON" };
  const NO_SETUP: ProjectCoverage = { kind: "covered", root: "/repo", coverage: lintCoverage(null) };
  const REFUSED: ProjectCoverage = { kind: "config-refused", root: "/repo", error: "unknown key 'exlude'" };

  it("says nothing outside a project, whatever the ignore list holds", () => {
    expect(sessionReminder({ kind: "no-project" }, UNREADABLE, COMMANDS)).toBeNull();
    expect(sessionReminder({ kind: "no-project" }, ignoreList([]), COMMANDS)).toBeNull();
  });

  it("an unreadable ignore list is said, never read as 'ignore everything'", () => {
    const reminder = sessionReminder(NO_SETUP, UNREADABLE, COMMANDS);
    expect(reminder?.forOperator).toBe("Loom lint: the lint-coverage ignore list cannot be read (/cfg/list.json is not JSON); fix or delete it.");
    expect(reminder?.forModel).toBe(reminder?.forOperator);
  });

  it("a refused config is said, so every failing edit has its cause", () => {
    expect(sessionReminder(REFUSED, ignoreList([]), COMMANDS)?.forOperator)
      .toBe("Loom lint: the rules config of /repo is refused, so every edit's lint fails: unknown key 'exlude'");
  });

  it("property: an ignored project is silent, refused or not; otherwise the coverage decides", () => {
    const projectArb = fc.constantFrom<ProjectCoverage>(NO_SETUP, REFUSED, { kind: "covered", root: "/repo", coverage: lintCoverage({}) });
    fc.assert(fc.property(projectArb, fc.boolean(), (project, ignored) => {
      const reminder = sessionReminder(project, ignoreList(ignored ? ["/repo"] : ["/other"]), COMMANDS);
      if (ignored) expect(reminder).toBeNull();
      else if (project.kind === "covered") expect(reminder).toEqual(coverageReminder("/repo", project.coverage, COMMANDS));
      else expect(reminder?.forOperator).toContain("is refused");
    }));
  });
});

describe("coverageCheckFailedNote", () => {
  it("is the one line both harnesses say when the check itself fails", () => {
    expect(coverageCheckFailedNote(new Error("EACCES"))).toBe("Loom lint: the coverage check could not run: EACCES");
    expect(coverageCheckFailedNote("boom")).toBe("Loom lint: the coverage check could not run: boom");
  });
});
