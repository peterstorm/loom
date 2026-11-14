/**
 * no-dangling-doc-reference end to end: what a scope governs, how a dangling
 * reference reads, how the baseline excuses it — and the historical RED: the
 * certified doc-dangling findings from Loom's review history, replayed on a
 * seeded copy, each named with its reason, each fixed form passing.
 *
 * The cross-file case runs through the production loader on a real project
 * directory: deleting an export fails the full tier on a doc nobody edited,
 * which no check of the edited file alone can see.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  describeDangling,
  detectedDocReferenceKeys,
  handler,
  readingOf,
  RULE_NAME,
  type DocReferenceOptions,
} from "../../../src/linter/programmatic/no-dangling-doc-reference";
import type { DanglingReason, DocReference, DocReferenceScope } from "../../../src/linter/doc-references/types";
import { baselineKey } from "../../../src/linter/programmatic/baseline";
import { lintFile, lintFiles } from "../../../src/linter/index";
import { fakeIndex, VALID_SPEC, type FakeProject } from "../doc-references/fake-snapshot";
import { REPO_ROOT, LOOM_RULES_DIR } from "../loom-project-config";

const reasoned = (path: string) => ({ path, reason: "test scope" });

const SCOPE: DocReferenceScope = {
  govern: [reasoned("docs/"), reasoned("agents/"), reasoned("engine/src/")],
  plans: [reasoned(".claude/plans/")],
  exclude: [reasoned("docs/vendored/")],
  sourceRoots: ["engine/src"],
};

const optionsFor = (project: FakeProject, unwalked: FakeProject = {}, baseline: readonly string[] = []): DocReferenceOptions => ({
  scope: SCOPE,
  baseline: baseline.map((key) => key as `${string}::${string}`),
  projectRoot: "/repo",
  index: fakeIndex(project, unwalked),
});

describe("readingOf", () => {
  it.each([
    ["docs/guide.md", "document"],
    ["agents/verifier.md", "document"],
    ["engine/src/core/x.ts", "source-comments"],
    [".claude/plans/p.md", "plan"],
    ["docs/vendored/lens.md", null],
    ["skills/react/SKILL.md", null],
    ["engine/tests/x.test.ts", null],
  ])("%s → %s", (path, reading) => {
    expect(readingOf(path, SCOPE)).toBe(reading);
  });

  it("governs nothing without a scope", () => {
    expect(readingOf("docs/guide.md", null)).toBeNull();
  });
});

describe("describeDangling", () => {
  const ref: DocReference = { kind: "path", line: 1, text: "docs/x.md", path: "docs/x.md", directory: false, anchor: null };
  /** One reason per arm — a Record over the union, so a new arm fails to compile until it is described here. */
  const REASONS: { readonly [K in DanglingReason["kind"]]: Extract<DanglingReason, { kind: K }> } = {
    "absolute-path": { kind: "absolute-path", path: "/home/me/x.md" },
    "no-such-path": { kind: "no-such-path", tried: ["docs/docs/x.md", "docs/x.md"] },
    "no-such-heading": { kind: "no-such-heading", target: "docs/x.md", anchor: "setup" },
    "not-in-source": { kind: "not-in-source", missing: ["voteReason"] },
    "spec-missing": { kind: "spec-missing", tried: [] },
    "spec-unreadable": { kind: "spec-unreadable", spec: "s.md", detail: "missing required section" },
    "id-not-in-spec": { kind: "id-not-in-spec", spec: "s.md" },
    "no-such-adr": { kind: "no-such-adr", directory: "docs/adr" },
  };

  it.each(Object.values(REASONS).map((reason) => [reason.kind, reason] as const))(
    "%s: one sentence quoting the reference and naming why nothing answers",
    (_kind, reason) => {
      const sentence = describeDangling(ref, reason);
      expect(sentence).toContain("`docs/x.md`");
      expect(sentence).not.toMatch(/\n|undefined|\(tried \)/);
    },
  );

  it("names every frame a path was tried in, or that it left the project from all of them", () => {
    expect(describeDangling(ref, REASONS["no-such-path"])).toContain("tried `docs/docs/x.md`, `docs/x.md`");
    expect(describeDangling(ref, { kind: "no-such-path", tried: [] })).toContain("leads out of the project from every frame");
  });
});

describe("handler and baseline", () => {
  const project: FakeProject = {
    "docs/guide.md": "# Guide\n\n`gone.md` and `gone.md` again, `alsoGone`.\n",
    "engine/src/x.ts": "export const kept = 1;",
  };
  const guide = project["docs/guide.md"]!;

  it("reports each dangling reference at its line, under the rule's name", () => {
    const violations = handler(guide, "/repo/docs/guide.md", optionsFor(project));
    expect(violations.map(({ rule, line }) => [rule, line])).toEqual([[RULE_NAME, 3], [RULE_NAME, 3], [RULE_NAME, 3]]);
  });

  it("keys each site path::reference, project-relative from the absolute path the hook hands it", () => {
    expect(detectedDocReferenceKeys(guide, "/repo/docs/guide.md", optionsFor(project))).toEqual([
      baselineKey("docs/guide.md", "gone.md"),
      baselineKey("docs/guide.md", "gone.md"),
      baselineKey("docs/guide.md", "alsoGone"),
    ]);
  });

  it("spends one baseline entry per occurrence: a second copy of an excused reference is still reported", () => {
    const options = optionsFor(project, {}, ["docs/guide.md::gone.md", "docs/guide.md::alsoGone"]);
    expect(handler(guide, "/repo/docs/guide.md", options).map(({ text }) => text)).toEqual([
      expect.stringContaining("`gone.md`"),
    ]);
  });

  it("refuses a document whose fence never closes, at the fence", () => {
    const violations = handler("intro\n```\n`gone.md`\n", "/repo/docs/guide.md", optionsFor(project));
    expect(violations).toEqual([expect.objectContaining({ line: 2, text: expect.stringContaining("never closed") })]);
    expect(detectedDocReferenceKeys("```\n", "docs/guide.md", optionsFor(project))).toEqual([baselineKey("docs/guide.md", "(unclosed fence)")]);
  });

  it("reads nothing outside the scope, and nothing at all with no scope", () => {
    expect(handler(guide, "/repo/skills/x/SKILL.md", optionsFor(project))).toEqual([]);
    expect(handler(guide, "/repo/docs/guide.md", { ...optionsFor(project), scope: null })).toEqual([]);
  });
});

describe("historical RED: the certified doc-dangling findings, replayed", () => {
  /** The seeded copy: what the code looked like when each finding was filed. */
  const SOURCE: FakeProject = {
    "engine/src/stop-check-planner.ts": "export function planStopChecks() {}",
    "engine/src/run-files.ts": "export const LEDGER_FILE = \"ledger.json\";\nexport const verdictReason = \"reason\";",
    "engine/tests/verdict.test.ts": "expect(() => parse({ voteReason: \"x\" })).toThrow();",
    "references/WEB-PROTOCOL-AND-AUTH.md": "# Web\n\n## Browser session attack classes\n",
  };
  const SPECS: FakeProject = { ".claude/specs/feature/spec.md": VALID_SPEC };

  type Case = Readonly<{ name: string; path: string; red: string; green: string; reason: DanglingReason["kind"] }>;
  const CASES: readonly Case[] = [
    {
      name: "the LOOM-DELTAS.md mention",
      path: "docs/review.md",
      red: "Deltas are listed in `LOOM-DELTAS.md`.",
      green: "Deltas were listed in LOOM-DELTAS.md, since retired.",
      reason: "no-such-path",
    },
    {
      name: "the bad anchor",
      path: "docs/review.md",
      red: "See `references/WEB-PROTOCOL-AND-AUTH.md#authentication-and-session-handling`.",
      green: "See `references/WEB-PROTOCOL-AND-AUTH.md#browser-session-attack-classes`.",
      reason: "no-such-heading",
    },
    {
      name: "planStopCheck in a comment after its export was deleted",
      path: "engine/src/affected-stop-check-types.ts",
      red: "/** Mirrors `planStopCheck`. */\nexport type Affected = string;",
      green: "/** Mirrors `planStopChecks`. */\nexport type Affected = string;",
      reason: "not-in-source",
    },
    {
      name: "voteReason in an agent doc, a name only a test still uses",
      path: "agents/verifier.md",
      red: "Return the ballot with a `voteReason`.",
      green: "Return the ballot with a `verdictReason`.",
      reason: "not-in-source",
    },
    {
      name: "coverage-ledger.json, a run file the code never writes",
      path: "docs/review.md",
      red: "The hunters append to `coverage-ledger.json`.",
      green: "The hunters append to `ledger.json`.",
      reason: "no-such-path",
    },
    {
      name: "FR-028, an id its spec lacks",
      path: ".claude/plans/feature.md",
      red: "**Spec:** .claude/specs/feature/spec.md\n\nCovers FR-028.",
      green: "**Spec:** .claude/specs/feature/spec.md\n\nCovers FR-002.",
      reason: "id-not-in-spec",
    },
  ];

  /** The rule's reason for each reference it flags, read through the pure halves the handler composes. */
  const reasonsOf = (content: string, path: string): readonly string[] =>
    handler(content, path, optionsFor({ ...SOURCE, [path]: content }, SPECS)).map(({ text }) => text);

  it.each(CASES.map((c) => [c.name, c] as const))("%s: named with its reason", (_name, c) => {
    const messages = reasonsOf(c.red, c.path);
    expect(messages).toHaveLength(1);
    const expected: Readonly<Record<DanglingReason["kind"], RegExp>> = {
      "absolute-path": /absolute path/,
      "no-such-path": /names (nothing in the project|no file in)/,
      "no-such-heading": /has no heading or anchor/,
      "not-in-source": /the source holds no/,
      "spec-missing": /does not exist/,
      "spec-unreadable": /does not parse/,
      "id-not-in-spec": /is not defined in/,
      "no-such-adr": /names no ADR/,
    };
    expect(messages[0]).toMatch(expected[c.reason]);
  });

  it.each(CASES.map((c) => [c.name, c] as const))("%s: the fixed form passes", (_name, c) => {
    expect(reasonsOf(c.green, c.path)).toEqual([]);
  });
});

describe("cross-file: the full tier reads an unedited doc against the edited code", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function project(files: FakeProject): string {
    const root = mkdtempSync(join(tmpdir(), "doc-ref-"));
    roots.push(root);
    const config = {
      docReferences: {
        govern: [{ path: "docs/", reason: "the project's docs" }],
        sourceRoots: ["src"],
      },
    };
    const all: FakeProject = { ...files, ".claude/linter/rules/config.json": JSON.stringify(config) };
    for (const [path, content] of Object.entries(all)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const lintDoc = (root: string) => lintFiles(
    [join(root, "docs/stop-check.md")],
    "full",
    join(REPO_ROOT, "lint-rules"),
    join(root, ".claude/linter/rules"),
    60_000,
  ).get(join(root, "docs/stop-check.md"));

  it("passes while the export exists, and fails once it is deleted — with the doc untouched", () => {
    const doc = "# Stop check\n\nThe planner's `planStopCheck` decides it; see `planner.ts`.\n";
    const before = project({ "docs/stop-check.md": doc, "src/planner.ts": "export function planStopCheck() {}" });
    expect(lintDoc(before)).toEqual({ kind: "pass" });

    const after = project({ "docs/stop-check.md": doc, "src/planner.ts": "export function decideStop() {}" });
    expect(lintDoc(after)).toMatchObject({
      kind: "violations",
      violations: [expect.objectContaining({ rule: RULE_NAME, line: 3, text: expect.stringContaining("planStopCheck") })],
    });
  });
});

describe("budget: one edit on Loom's own tree", () => {
  it("stays inside the per-edit deadline, the index build charged to first-call setup", () => {
    const edited = join(REPO_ROOT, "engine/src/linter/doc-references/resolve.ts");
    // The default timeout is the edit hook's own budget: the rule's setup must not be charged to it.
    expect(lintFile(edited, "immediate", join(REPO_ROOT, "lint-rules"), LOOM_RULES_DIR)).toEqual({ kind: "pass" });
  });
});
