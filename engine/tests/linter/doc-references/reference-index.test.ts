/**
 * What a reference is resolved against. The source corpus is the subtle part:
 * a doc must not be kept alive by a comment naming the same deleted thing, nor
 * by a test that merely USES a refused name — so each feeding rule is pinned.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  codeText,
  corpusRoleOf,
  declaredNames,
  EMPTY_REFERENCE_INDEX,
  referenceIndex,
  wordsOf,
} from "../../../src/linter/doc-references/reference-index";
import type { ProjectSnapshot } from "../../../src/linter/doc-references/types";
import { fakeIndex, fakeSnapshot, VALID_SPEC } from "./fake-snapshot";

describe("corpusRoleOf", () => {
  it.each([
    ["engine/src/core/parse-spec.ts", "source"],
    ["pi/extension.mjs", "source"],
    ["src/main/java/Shop.java", "source"],
    [".claude/linter/rules/config.json", "source"],
    ["hooks/scripts/lint-file.sh", "source"],
    [".github/workflows/verify.yml", "source"],
    ["deploy/compose.yaml", "source"],
    ["Cargo.toml", "source"],
    ["engine/tests/linter/markdown.test.ts", "test-declarations"],
    ["engine/src/core/x.spec.ts", "test-declarations"],
    ["engine/tests/support/or-fail.ts", "test-declarations"],
    ["src/__mocks__/fs.ts", "test-declarations"],
    ["engine/tests/fixtures/run/state.json", "none"],
    ["testdata/sample.sh", "none"],
    ["tests/fixtures/workflow.yml", "none"],
    ["package-lock.json", "none"],
    ["engine/npm-shrinkwrap.json", "none"],
    ["docs/adr/README.md", "none"],
    ["styles/site.css", "none"],
  ])("%s → %s", (path, role) => {
    expect(corpusRoleOf(path)).toBe(role);
  });
});

describe("declaredNames", () => {
  it("reads every declaration that begins a line, through its modifiers", () => {
    const source = [
      "export const TYPESCRIPT_COMPILER_API_SEAMS = [];",
      "  function* walk() {}",
      "export default async function load() {}",
      "export abstract class Base {}",
      "type Shape = {};",
      "public record Order() {}",
      "data class Line(val x: Int)",
      "private val limit = 3",
      "fun main() {}",
      "object Registry",
    ].join("\n");
    expect(declaredNames(source)).toEqual([
      "TYPESCRIPT_COMPILER_API_SEAMS", "walk", "load", "Base", "Shape", "Order", "Line", "limit", "main", "Registry",
    ]);
  });

  it("reads no name a comment, a call or a mid-line mention holds", () => {
    const source = [
      "// const commented = 1;",
      " * type documented",
      "/* class Blocked */",
      "expect(parse({ voteReason: 1 })).toThrow();",
      "for (const looped of items) {}",
      "it(\"names the type of\", () => {});",
    ].join("\n");
    expect(declaredNames(source)).toEqual([]);
  });
});

describe("codeText", () => {
  it("drops a C-family file's comments and keeps its strings", () => {
    const text = codeText("x.ts", "// gone\nconst kept = \"also kept\"; /* gone too */");
    expect(text).toContain("kept");
    expect(text).toContain("also kept");
    expect(text).not.toContain("gone");
  });

  it("drops a shell script's comment lines", () => {
    expect(codeText("x.sh", "#!/bin/sh\n  # gone\necho kept")).toBe("echo kept");
  });

  it.each(["x.yml", "x.yaml", "x.toml"])("drops a %s file's comment lines, as a script's", (path) => {
    expect(codeText(path, "# gone\njobs:\n  # gone too\n  kept: true")).toBe("jobs:\n  kept: true");
  });

  it("keeps a JSON file whole: it has no comments", () => {
    expect(codeText("x.json", "{\"a\": 1}")).toBe("{\"a\": 1}");
  });
});

/** The specification `wordsOf` implements, written for clarity, not speed. */
function wordsOracle(text: string): ReadonlySet<string> {
  const words = [...text.matchAll(/[A-Za-z0-9_$][A-Za-z0-9_$.-]*/g)].flatMap(([run]) => {
    const trimmed = run.replace(/[.-]+$/, "");
    const parts = trimmed.split(/([.-])/);
    const segments = Math.ceil(parts.length / 2);
    return Array.from({ length: segments }, (_, first) =>
      Array.from({ length: Math.min(8, segments - first) }, (__, span) =>
        parts.slice(first * 2, (first + span) * 2 + 1).join("")))
      .flat()
      .filter((word) => word !== "");
  });
  return new Set(words);
}

describe("wordsOf", () => {
  it("holds each run and each stretch of it between dot and hyphen boundaries", () => {
    expect([...wordsOf("see coverage-ledger.json.")].sort()).toEqual([
      "coverage", "coverage-ledger", "coverage-ledger.json", "json", "ledger", "ledger.json", "see",
    ]);
  });

  it("holds a word only bounded by non-word characters: voteReasons does not hold voteReason", () => {
    expect(wordsOf("voteReasons").has("voteReason")).toBe(false);
  });

  it("spans at most eight segments", () => {
    const words = wordsOf("a.b.c.d.e.f.g.h.i");
    expect(words.has("a.b.c.d.e.f.g.h")).toBe(true);
    expect(words.has("a.b.c.d.e.f.g.h.i")).toBe(false);
    expect(words.has("b.c.d.e.f.g.h.i")).toBe(true);
  });

  it("agrees with the plain specification on any text", () => {
    const text = fc.array(fc.constantFrom("a", "B", "_", "$", "1", ".", "-", " ", "\"", "/"), { maxLength: 40 })
      .map((characters) => characters.join(""));
    fc.assert(fc.property(text, (sample) => {
      expect([...wordsOf(sample)].sort()).toEqual([...wordsOracle(sample)].sort());
    }));
  });
});

describe("referenceIndex — the source text", () => {
  const index = fakeIndex({
    "src/ledger.ts": "// the planStopCheck helper\nexport const LEDGER_FILE = \"coverage-ledger.json\";",
    "src/run.sh": "# echo commentedOut\necho runScript",
    ".github/workflows/verify.yml": "jobs:\n  # retiredJob:\n  workspace-gate:\n    env:\n      NPM_TOKEN: x",
    "tests/ledger.test.ts": "export function seededLedger() {}\nexpect(parse({ voteReason: 1 })).toThrow();",
    "tests/fixtures/state.json": "{\"fixtureOnly\": true}",
    "skills/distill/SKILL.md": "`notSource`",
  });

  it.each([
    ["a source identifier", "LEDGER_FILE", true],
    ["a string constant", "coverage-ledger.json", true],
    ["a stretch of a string constant", "ledger.json", true],
    ["a script's word", "runScript", true],
    ["a CI job a workflow defines", "workspace-gate", true],
    ["a secret a workflow reads", "NPM_TOKEN", true],
    ["a name only a workflow comment holds", "retiredJob", false],
    ["a name a test declares", "seededLedger", true],
    ["a path segment", "distill", true],
    ["a file stem", "SKILL", true],
    ["a name only a source comment holds", "planStopCheck", false],
    ["a name only a script comment holds", "commentedOut", false],
    ["a name a test only uses", "voteReason", false],
    ["a fixture's key", "fixtureOnly", false],
    ["a Markdown file's word", "notSource", false],
  ])("%s: %s → %s", (_label, word, held) => {
    expect(index.inSource(word)).toBe(held);
  });
});

describe("referenceIndex — anchors, specs and ADR ids", () => {
  const index = fakeIndex(
    {
      "docs/guide.md": "# Guide\n\n## Setup\n\n<a id=\"pinned\"></a>\n\n```md\n## Fenced heading\n```\n\n## Setup\n",
      "docs/broken.md": "# Broken\n\n```\nnever closed\n",
      "docs/adr/ADR-0042-two-seams.md": "# ADR-0042",
      "docs/adr/ADR-0007.md": "# ADR-0007",
      "docs/adr/0029-adr-tools-numbering.md": "# 29. adr-tools numbering",
      "docs/adr/adr-0031-lower-case.md": "# ADR 31",
      "docs/adr/2024-11-retro-notes.md": "# a dated note, not an ADR",
      "docs/adr/README.md": "# Index",
    },
    {
      ".claude/specs/good/spec.md": VALID_SPEC,
      ".claude/specs/bad/spec.md": "# Not a spec\n",
    },
  );

  it("holds a document's heading slugs, numbered repeats and HTML anchors — never a fenced heading", () => {
    expect([...index.anchorsOf("docs/guide.md")].sort()).toEqual(["guide", "pinned", "setup", "setup-1"]);
  });

  it("holds no anchor for a missing file or one with an unclosed fence", () => {
    expect(index.anchorsOf("docs/missing.md").size).toBe(0);
    expect(index.anchorsOf("docs/broken.md").size).toBe(0);
  });

  it("reads a spec's ids through the engine's spec parser", () => {
    const spec = index.specOf(".claude/specs/good/spec.md");
    expect(spec.kind === "read" ? [...spec.ids].sort() : spec).toEqual(["AS-001", "FR-001", "FR-002", "OOS-001"]);
  });

  it("reports a spec the parser refuses as unreadable, with the parser's reason, and an absent one as missing", () => {
    expect(index.specOf(".claude/specs/bad/spec.md")).toMatchObject({ kind: "unreadable", detail: expect.any(String) });
    expect(index.specOf(".claude/specs/none/spec.md")).toEqual({ kind: "missing" });
    expect(index.specOf(".claude/specs")).toEqual({ kind: "missing" });
  });

  it("holds the ADR id every file in docs/adr is named for, in the ADR- and the adr-tools numbering — never a date", () => {
    expect([...index.adrIds()].sort()).toEqual(["ADR-0007", "ADR-0029", "ADR-0031", "ADR-0042"]);
  });

  it("answers what is at a path, beneath an unwalked directory too", () => {
    expect(index.entryAt("docs/guide.md")).toBe("file");
    expect(index.entryAt("docs/adr")).toBe("directory");
    expect(index.entryAt(".claude/specs/good/spec.md")).toBe("file");
    expect(index.entryAt("docs/missing.md")).toBeNull();
  });
});

describe("referenceIndex — reads lazily, and once", () => {
  /** A snapshot that counts what is asked of it. */
  function counted(snapshot: ProjectSnapshot): Readonly<{ snapshot: ProjectSnapshot; walks: () => number; reads: () => number }> {
    let walks = 0;
    let reads = 0;
    return {
      snapshot: {
        files: () => { walks += 1; return snapshot.files(); },
        entryAt: snapshot.entryAt,
        read: (path) => { reads += 1; return snapshot.read(path); },
      },
      walks: () => walks,
      reads: () => reads,
    };
  }

  it("walks and reads nothing until a question needs it, then reads each source file once", () => {
    const probe = counted(fakeSnapshot({ "src/a.ts": "export const alpha = 1;", "src/b.ts": "export const beta = 2;" }));
    const index = referenceIndex(probe.snapshot);
    expect(index.entryAt("src/a.ts")).toBe("file");
    expect([probe.walks(), probe.reads()]).toEqual([0, 0]);
    expect(index.inSource("alpha")).toBe(true);
    expect(index.inSource("beta")).toBe(true);
    expect(index.inSource("gamma")).toBe(false);
    expect([probe.walks(), probe.reads()]).toEqual([1, 2]);
  });

  it("holds nothing for no project", () => {
    expect(EMPTY_REFERENCE_INDEX.inSource("anything")).toBe(false);
    expect(EMPTY_REFERENCE_INDEX.entryAt("README.md")).toBeNull();
    expect(EMPTY_REFERENCE_INDEX.adrIds().size).toBe(0);
  });
});
