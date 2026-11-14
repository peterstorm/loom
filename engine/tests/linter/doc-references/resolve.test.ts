/**
 * The resolution half of no-dangling-doc-reference: each frame a path may be
 * written in, the order they are tried in, and every `DanglingReason` arm.
 */

import { describe, expect, it } from "vitest";
import { resolveReference, type ReferenceFrame, type Resolution } from "../../../src/linter/doc-references/resolve";
import type { DocReference } from "../../../src/linter/doc-references/types";
import { fakeIndex, VALID_SPEC } from "./fake-snapshot";

const INDEX = fakeIndex(
  {
    "README.md": "# Loom\n\n## Scope\n",
    "docs/guide.md": "# Guide\n\n## Setup\n",
    "docs/adr/ADR-0042-two-seams.md": "# ADR-0042",
    "engine/src/core/parse-spec.ts": "export function parseSpec() {}",
    "engine/src/linter/clones/clone-detection.ts": "export const detectClones = 1;",
    "engine/src/linter/programmatic/rule.ts": "export const ruleName = \"coverage-ledger.json\";",
    "engine/src/machine/ledger.ts": "export const ledger = { voteTally: 1 };",
    "engine/src/linter/README.md": "# Linter",
    "lint-rules/README.md": "# Rules",
    "lint-rules/no-io.json": "{}",
  },
  {
    ".claude/specs/good/spec.md": VALID_SPEC,
    ".claude/specs/bad/spec.md": "# Not a spec\n",
  },
);

const FRAME: ReferenceFrame = { from: "engine/src/linter/programmatic/rule.ts", sourceRoots: ["engine/src"] };
const DOC_FRAME: ReferenceFrame = { from: "docs/guide.md", sourceRoots: ["engine/src"] };

const resolve = (reference: DocReference, frame: ReferenceFrame = FRAME): Resolution => resolveReference(reference, frame, INDEX);

const path = (text: string, anchor: string | null = null): DocReference => {
  const directory = text.endsWith("/");
  return { kind: "path", line: 1, text, path: directory ? text.slice(0, -1) : text, directory, anchor };
};
const fileName = (name: string): DocReference => ({ kind: "file-name", line: 1, text: name, name });
const link = (target: string, anchor: string | null = null): DocReference => ({ kind: "link", line: 1, text: target, path: target, anchor });
const token = (text: string): DocReference => {
  const [first = "", ...rest] = (text.endsWith("()") ? text.slice(0, -2) : text).split(".");
  return { kind: "token", line: 1, text, segments: [first, ...rest] };
};
const spec = (text: string): DocReference => ({ kind: "spec", line: 1, text, path: text });
const specId = (text: string, of: string): DocReference => ({ kind: "spec-id", line: 1, text, spec: of });
const adr = (text: string): DocReference => ({ kind: "adr", line: 1, text });

describe("a path resolves in named frames, nearest first", () => {
  it.each([
    ["the referring file's directory", "rule.ts", "engine/src/linter/programmatic/rule.ts"],
    ["a directory above it", "clones/clone-detection.ts", "engine/src/linter/clones/clone-detection.ts"],
    ["the project root", "lint-rules/no-io.json", "lint-rules/no-io.json"],
    ["a source root, from a doc outside it", "core/parse-spec.ts", "engine/src/core/parse-spec.ts"],
    ["a module specifier without its extension", "machine/ledger", "engine/src/machine/ledger.ts"],
    ["a directory", "docs/adr/", "docs/adr"],
  ])("%s: `%s`", (_frame, written, located) => {
    expect(resolve(path(written))).toEqual({ ok: true, value: { via: "entry", path: located } });
  });

  it("takes the nearest frame when two hold the path: a README beside the linter before the root's", () => {
    expect(resolve(path("linter/README.md"))).toEqual({ ok: true, value: { via: "entry", path: "engine/src/linter/README.md" } });
    expect(resolve(path("lint-rules/README.md"))).toEqual({ ok: true, value: { via: "entry", path: "lint-rules/README.md" } });
  });

  it("refuses a suffix: a path must say where its file is", () => {
    expect(resolve(path("programmatic/clone-detection.ts"), DOC_FRAME)).toEqual({
      ok: false,
      error: {
        kind: "no-such-path",
        tried: ["docs/programmatic/clone-detection.ts", "programmatic/clone-detection.ts", "engine/src/programmatic/clone-detection.ts"],
      },
    });
  });

  it("tries a climbing path only in the frames it stays inside, and nothing outside the project", () => {
    // From the source root engine/src, ../../ is the project root; from docs/ and the root it leaves the project.
    expect(resolve(path("../../outside.md"), DOC_FRAME)).toEqual({ ok: false, error: { kind: "no-such-path", tried: ["outside.md"] } });
    expect(resolve(path("../../../outside.md"), DOC_FRAME)).toEqual({ ok: false, error: { kind: "no-such-path", tried: [] } });
  });

  it("refuses an absolute path as such: it names one machine's checkout", () => {
    expect(resolve(path("/home/me/loom/README.md"))).toEqual({ ok: false, error: { kind: "absolute-path", path: "/home/me/loom/README.md" } });
  });

  it("asks a directory reference for a directory: a file of that name is not one", () => {
    expect(resolve(path("README.md/"), DOC_FRAME)).toMatchObject({ ok: false, error: { kind: "no-such-path" } });
  });

  it("checks an anchor on a Markdown target against its headings, and leaves one on any other file alone", () => {
    expect(resolve(path("docs/guide.md", "setup"))).toMatchObject({ ok: true });
    expect(resolve(path("docs/guide.md", "teardown"))).toEqual({
      ok: false,
      error: { kind: "no-such-heading", target: "docs/guide.md", anchor: "teardown" },
    });
    expect(resolve(path("core/parse-spec.ts", "L12"), DOC_FRAME)).toMatchObject({ ok: true });
  });
});

describe("a bare file name", () => {
  it("names a file in a frame", () => {
    expect(resolve(fileName("README.md"), DOC_FRAME)).toEqual({ ok: true, value: { via: "entry", path: "README.md" } });
  });

  it("or a name the source text holds: a string constant", () => {
    expect(resolve(fileName("coverage-ledger.json"), DOC_FRAME)).toEqual({ ok: true, value: { via: "source" } });
  });

  it("dangles when it is neither, naming each frame it tried", () => {
    expect(resolve(fileName("LOOM-DELTAS.md"), DOC_FRAME)).toEqual({
      ok: false,
      error: { kind: "no-such-path", tried: ["docs/LOOM-DELTAS.md", "LOOM-DELTAS.md", "engine/src/LOOM-DELTAS.md"] },
    });
  });
});

describe("a Markdown link resolves as GitHub resolves it", () => {
  it("against the referring file's directory, or the root for /…", () => {
    expect(resolve(link("../README.md", "scope"), DOC_FRAME)).toEqual({ ok: true, value: { via: "entry", path: "README.md" } });
    expect(resolve(link("/lint-rules/README.md"), DOC_FRAME)).toEqual({ ok: true, value: { via: "entry", path: "lint-rules/README.md" } });
    expect(resolve(link("adr/"), DOC_FRAME)).toEqual({ ok: true, value: { via: "entry", path: "docs/adr" } });
  });

  it("never in a source root or an ancestor: a link has one meaning", () => {
    expect(resolve(link("core/parse-spec.ts"), DOC_FRAME)).toEqual({ ok: false, error: { kind: "no-such-path", tried: ["docs/core/parse-spec.ts"] } });
  });

  it("an empty path is the document itself, so its anchor is one of the document's headings", () => {
    expect(resolve(link("", "setup"), DOC_FRAME)).toMatchObject({ ok: true });
    expect(resolve(link("", "missing"), DOC_FRAME)).toEqual({
      ok: false,
      error: { kind: "no-such-heading", target: "docs/guide.md", anchor: "missing" },
    });
  });

  it("a link out of the project names nothing", () => {
    expect(resolve(link("../../x.md"), DOC_FRAME)).toEqual({ ok: false, error: { kind: "no-such-path", tried: ["../../x.md"] } });
  });
});

describe("a token resolves in the source text", () => {
  it.each([
    ["a symbol", "parseSpec"],
    ["a call", "parseSpec()"],
    ["a dotted path whose whole word is held", "ledger.voteTally"],
    ["a dotted path whose every segment is held", "detectClones.ruleName"],
  ])("%s: `%s`", (_label, text) => {
    expect(resolve(token(text))).toEqual({ ok: true, value: { via: "source" } });
  });

  it("dangles naming each segment the source does not hold", () => {
    expect(resolve(token("ledger.voteReason.kind"))).toEqual({ ok: false, error: { kind: "not-in-source", missing: ["voteReason", "kind"] } });
  });
});

describe("a plan's spec header and spec ids", () => {
  const PLAN: ReferenceFrame = { from: ".claude/plans/p.md", sourceRoots: [] };

  it("resolves a spec that parses", () => {
    expect(resolve(spec(".claude/specs/good/spec.md"), PLAN)).toEqual({ ok: true, value: { via: "spec", spec: ".claude/specs/good/spec.md" } });
  });

  it("dangles on a missing spec, a spec that does not parse, and an absolute one", () => {
    expect(resolve(spec(".claude/specs/none/spec.md"), PLAN)).toMatchObject({ ok: false, error: { kind: "spec-missing" } });
    expect(resolve(spec(".claude/specs/bad/spec.md"), PLAN)).toMatchObject({
      ok: false,
      error: { kind: "spec-unreadable", spec: ".claude/specs/bad/spec.md", detail: expect.any(String) },
    });
    expect(resolve(spec("/abs/spec.md"), PLAN)).toEqual({ ok: false, error: { kind: "absolute-path", path: "/abs/spec.md" } });
  });

  it("resolves an id the spec defines, and dangles on one it does not", () => {
    expect(resolve(specId("FR-002", ".claude/specs/good/spec.md"), PLAN)).toMatchObject({ ok: true, value: { via: "spec" } });
    expect(resolve(specId("FR-028", ".claude/specs/good/spec.md"), PLAN)).toEqual({
      ok: false,
      error: { kind: "id-not-in-spec", spec: ".claude/specs/good/spec.md" },
    });
  });

  it.each([".claude/specs/none/spec.md", ".claude/specs/bad/spec.md", "/abs/spec.md"])(
    "does not judge an id twice when its spec %s already fails the header",
    (of) => {
      expect(resolve(specId("FR-028", of), PLAN)).toEqual({ ok: true, value: { via: "spec-unavailable", spec: of } });
    },
  );
});

describe("an ADR id", () => {
  it("resolves when a file in docs/adr carries it, and dangles naming the directory when none does", () => {
    expect(resolve(adr("ADR-0042"))).toEqual({ ok: true, value: { via: "adr" } });
    expect(resolve(adr("ADR-0099"))).toEqual({ ok: false, error: { kind: "no-such-adr", directory: "docs/adr" } });
  });
});
