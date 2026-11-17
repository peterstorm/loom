/**
 * The direct-edit guard admits a retrospective (ADR-0083): while the TaskGraph
 * is live, the session may write a Markdown file directly in the repository's
 * retro directory, and nothing else the admission does not already allow.
 */
import { describe, expect, it } from "vitest";
import { retroDocumentWrite, shouldBlockDirectEdit, type EditSite } from "../../src/core/block-direct-edits";

const ROOT = "/repo";
const PROTECTED = "/tmp/claude-subagents";
const site = (...paths: [string, ...string[]]): EditSite => ({
  repository: { kind: "resolved", roots: [ROOT], protectedRoots: [PROTECTED] },
  targets: { kind: "resolved", paths },
});

describe("retroDocumentWrite", () => {
  it("admits Markdown files directly in the retro directory", () => {
    expect(retroDocumentWrite(site(`${ROOT}/.claude/retros/2026-11-17-run.md`))).toBe(true);
    expect(retroDocumentWrite(site(`${ROOT}/.claude/retros/a.md`, `${ROOT}/.claude/retros/b.md`))).toBe(true);
  });

  it.each<[string, EditSite]>([
    ["a non-Markdown file", site(`${ROOT}/.claude/retros/run.txt`)],
    ["a nested directory", site(`${ROOT}/.claude/retros/nested/run.md`)],
    ["another .claude directory", site(`${ROOT}/.claude/plans/run.md`)],
    ["source code", site(`${ROOT}/src/index.ts`)],
    ["a mix with one outside the retro directory", site(`${ROOT}/.claude/retros/run.md`, `${ROOT}/src/index.ts`)],
    ["a protected Loom directory", site(`${PROTECTED}/.claude/retros/run.md`)],
    ["unresolved targets", { repository: { kind: "resolved", roots: [ROOT], protectedRoots: [PROTECTED] }, targets: { kind: "unresolved", reason: "x" } }],
    ["an unresolved repository", { repository: { kind: "unresolved" }, targets: { kind: "resolved", paths: [`${ROOT}/.claude/retros/run.md`] } }],
  ])("refuses %s", (_label, candidate) => {
    expect(retroDocumentWrite(candidate)).toBe(false);
  });
});

describe("shouldBlockDirectEdit and retro documents", () => {
  const decide = (candidate: EditSite) =>
    shouldBlockDirectEdit("Write", "session-1", () => true, () => [], { locateEdit: () => candidate });

  it("lets the session write its retro while the TaskGraph is live", () => {
    expect(decide(site(`${ROOT}/.claude/retros/run.md`))).toEqual({ kind: "allow" });
  });

  it("still blocks every other write inside the repository", () => {
    expect(decide(site(`${ROOT}/src/index.ts`)).kind).toBe("block");
    expect(decide(site(`${ROOT}/.claude/retros/run.txt`)).kind).toBe("block");
  });
});
