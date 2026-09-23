import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  PLAN_ARTIFACT_DIR,
  SPEC_ARTIFACT_DIR,
  classifyPhaseArtifact,
  parseSpecArtifactDirectory,
  phaseArtifactUpdates,
  projectRootForStateFile,
  resolvesWithin,
} from "../../src/core/phase-artifact-paths";

/**
 * The rule both harnesses record `spec_file`/`plan_file` by. It used to be
 * spelled twice, inline, as `String.includes(".claude/specs/")` — a test that a
 * traversal path passes while resolving outside the tree. These cases pin the
 * resolved reading, with no filesystem involved: nothing here asks whether a
 * path exists, which is exactly why the rule can be tested at all.
 */

/** The seam requires an explicit boundary; no production caller defaults it. */
const BOUNDARY = "/worktree-b";

describe("classifyPhaseArtifact", () => {
  it("accepts a spec and a plan inside their own directories", () => {
    expect(classifyPhaseArtifact(".claude/specs/2026-08-16-thing/spec.md", SPEC_ARTIFACT_DIR, BOUNDARY)).toBe("spec");
    expect(classifyPhaseArtifact(".claude/plans/2026-08-16-thing.md", SPEC_ARTIFACT_DIR, BOUNDARY)).toBe("plan");
  });

  it("refuses a traversal path that merely CONTAINS the directory name", () => {
    // The substring form both harnesses used returned true for this.
    const escape = ".claude/specs/../../../../tmp/evil/spec.md";
    expect(escape.includes(".claude/specs/")).toBe(true);
    expect(classifyPhaseArtifact(escape, SPEC_ARTIFACT_DIR, BOUNDARY)).toBeNull();

    const planEscape = ".claude/plans/../../../../tmp/evil/plan.md";
    expect(planEscape.includes(".claude/plans/")).toBe(true);
    expect(classifyPhaseArtifact(planEscape, SPEC_ARTIFACT_DIR, BOUNDARY)).toBeNull();
  });

  it("scopes a spec to the run's own spec_dir when it has one", () => {
    const specDir = ".claude/specs/2026-08-16-mine";
    expect(classifyPhaseArtifact(`${specDir}/spec.md`, specDir, BOUNDARY)).toBe("spec");
    // A sibling run's spec is a real spec.md in the shared root, and must not
    // be adopted by a run scoped elsewhere.
    expect(classifyPhaseArtifact(".claude/specs/2026-08-16-theirs/spec.md", specDir, BOUNDARY)).toBeNull();
  });

  it("judges the filename by segment, not by suffix", () => {
    // `endsWith("/spec.md")` accepted this; `basename` does not.
    expect(classifyPhaseArtifact(".claude/specs/run/notspec.md", SPEC_ARTIFACT_DIR, BOUNDARY)).toBeNull();
    // `endsWith(".md")` accepts a final segment that is literally `.md`.
    expect(classifyPhaseArtifact(".claude/plans/.md", SPEC_ARTIFACT_DIR, BOUNDARY)).toBeNull();
  });

  it("refuses the directories themselves and the empty path", () => {
    expect(classifyPhaseArtifact(SPEC_ARTIFACT_DIR, SPEC_ARTIFACT_DIR, BOUNDARY)).toBeNull();
    expect(classifyPhaseArtifact(PLAN_ARTIFACT_DIR, SPEC_ARTIFACT_DIR, BOUNDARY)).toBeNull();
    expect(classifyPhaseArtifact("", SPEC_ARTIFACT_DIR, BOUNDARY)).toBeNull();
  });

  it("never classifies a path that escapes its directory, for any tail", () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom("..", "a", "b", "sub"), { minLength: 1, maxLength: 6 }),
      (segments) => {
        const candidate = [SPEC_ARTIFACT_DIR, ...segments, "spec.md"].join("/");
        const classified = classifyPhaseArtifact(candidate, SPEC_ARTIFACT_DIR, BOUNDARY);
        return classified === null || resolvesWithin(candidate, SPEC_ARTIFACT_DIR, BOUNDARY);
      },
    ));
  });
});

describe("projectRootForStateFile", () => {
  it("uses explicit project authority for a noncanonical nested State File", () => {
    expect(projectRootForStateFile("/repo/custom/state.json", "/repo")).toBe("/repo");
  });

  it("rejects a State File outside the explicit project boundary", () => {
    expect(() => projectRootForStateFile("/elsewhere/state.json", "/repo")).toThrow("outside observed project root");
  });

  it("derives the root for both canonical two-level locations", () => {
    expect(projectRootForStateFile("/repo/.claude/state/active_task_graph.json")).toBe("/repo");
    expect(projectRootForStateFile("/repo/.pi/state/active_task_graph.json")).toBe("/repo");
  });

  it("derives the root for the legacy walk-up shape", () => {
    expect(projectRootForStateFile("/repo/active_task_graph.json")).toBe("/repo");
  });

  it("refuses an undocumented one-deep `state/` pointer instead of deriving the parent of the root", () => {
    // The old fallback returned /parent-of-repo for this shape — one level too
    // high against its own documented contract ("the directory containing
    // .claude/"). An accepted pointer at an undocumented location must be
    // refused, not heuristically re-rooted.
    expect(() => projectRootForStateFile("/repo/state/active_task_graph.json"))
      .toThrow("not at a documented canonical location");
    expect(() => projectRootForStateFile("/repo/nested/state/active_task_graph.json"))
      .toThrow("not at a documented canonical location");
  });
});

describe("parseSpecArtifactDirectory", () => {
  it("mints only the default root or a nested run directory", () => {
    expect(parseSpecArtifactDirectory(null)).toMatchObject({ ok: true, value: SPEC_ARTIFACT_DIR });
    expect(parseSpecArtifactDirectory(".claude/specs/run"))
      .toMatchObject({ ok: true, value: ".claude/specs/run" });
  });

  it.each([
    ["absolute path even beneath the ambient project", `${process.cwd()}/.claude/specs/run`],
    ["absolute escape", "/tmp/foreign-specs"],
    ["relative escape", ".claude/specs/../../foreign-specs"],
    ["sibling prefix", ".claude/specs-foreign/run"],
  ])("rejects %s before it can address the filesystem", (_label, path) => {
    expect(parseSpecArtifactDirectory(path)).toMatchObject({
      ok: false,
      message: expect.stringContaining("outside .claude/specs"),
    });
  });
});

describe("resolvesWithin", () => {
  it("resolves relative authority against the supplied project root, never ambient cwd", () => {
    expect(resolvesWithin(".claude/specs/run/spec.md", ".claude/specs/run", "/worktree-b")).toBe(true);
    expect(resolvesWithin("/checkout-a/.claude/specs/run/spec.md", ".claude/specs/run", "/worktree-b")).toBe(false);
    expect(resolvesWithin("/worktree-b/.claude/specs/run/spec.md", ".claude/specs/run", "/worktree-b")).toBe(true);
  });
});

describe("phaseArtifactUpdates", () => {
  it("returns only the fields the writes justify", () => {
    expect(phaseArtifactUpdates([], SPEC_ARTIFACT_DIR, BOUNDARY)).toEqual({});
    expect(phaseArtifactUpdates(["README.md", "engine/src/x.ts"], SPEC_ARTIFACT_DIR, BOUNDARY)).toEqual({});
    expect(phaseArtifactUpdates([".claude/plans/p.md"], SPEC_ARTIFACT_DIR, BOUNDARY)).toEqual({ plan_file: ".claude/plans/p.md" });
  });

  it("lets the last write of each kind win", () => {
    expect(phaseArtifactUpdates([
      ".claude/specs/run/spec.md",
      ".claude/plans/first.md",
      ".claude/plans/second.md",
    ], SPEC_ARTIFACT_DIR, BOUNDARY)).toEqual({
      spec_file: ".claude/specs/run/spec.md",
      plan_file: ".claude/plans/second.md",
    });
  });

  it("drops a traversal write entirely rather than recording it", () => {
    expect(phaseArtifactUpdates([".claude/specs/../../../tmp/evil/spec.md"], SPEC_ARTIFACT_DIR, BOUNDARY)).toEqual({});
  });
});
