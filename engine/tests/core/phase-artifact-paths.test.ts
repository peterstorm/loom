import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  PLAN_ARTIFACT_DIR,
  SPEC_ARTIFACT_DIR,
  classifyPhaseArtifact,
  phaseArtifactUpdates,
  resolvesWithin,
} from "../../src/core/phase-artifact-paths";

/**
 * The rule both harnesses record `spec_file`/`plan_file` by. It used to be
 * spelled twice, inline, as `String.includes(".claude/specs/")` — a test that a
 * traversal path passes while resolving outside the tree. These cases pin the
 * resolved reading, with no filesystem involved: nothing here asks whether a
 * path exists, which is exactly why the rule can be tested at all.
 */
describe("classifyPhaseArtifact", () => {
  it("accepts a spec and a plan inside their own directories", () => {
    expect(classifyPhaseArtifact(".claude/specs/2026-08-16-thing/spec.md")).toBe("spec");
    expect(classifyPhaseArtifact(".claude/plans/2026-08-16-thing.md")).toBe("plan");
  });

  it("refuses a traversal path that merely CONTAINS the directory name", () => {
    // The substring form both harnesses used returned true for this.
    const escape = ".claude/specs/../../../../tmp/evil/spec.md";
    expect(escape.includes(".claude/specs/")).toBe(true);
    expect(classifyPhaseArtifact(escape)).toBeNull();

    const planEscape = ".claude/plans/../../../../tmp/evil/plan.md";
    expect(planEscape.includes(".claude/plans/")).toBe(true);
    expect(classifyPhaseArtifact(planEscape)).toBeNull();
  });

  it("scopes a spec to the run's own spec_dir when it has one", () => {
    const specDir = ".claude/specs/2026-08-16-mine";
    expect(classifyPhaseArtifact(`${specDir}/spec.md`, specDir)).toBe("spec");
    // A sibling run's spec is a real spec.md in the shared root, and must not
    // be adopted by a run scoped elsewhere.
    expect(classifyPhaseArtifact(".claude/specs/2026-08-16-theirs/spec.md", specDir)).toBeNull();
  });

  it("judges the filename by segment, not by suffix", () => {
    // `endsWith("/spec.md")` accepted this; `basename` does not.
    expect(classifyPhaseArtifact(".claude/specs/run/notspec.md")).toBeNull();
    // `endsWith(".md")` accepts a final segment that is literally `.md`.
    expect(classifyPhaseArtifact(".claude/plans/.md")).toBeNull();
  });

  it("refuses the directories themselves and the empty path", () => {
    expect(classifyPhaseArtifact(SPEC_ARTIFACT_DIR)).toBeNull();
    expect(classifyPhaseArtifact(PLAN_ARTIFACT_DIR)).toBeNull();
    expect(classifyPhaseArtifact("")).toBeNull();
  });

  it("never classifies a path that escapes its directory, for any tail", () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom("..", "a", "b", "sub"), { minLength: 1, maxLength: 6 }),
      (segments) => {
        const candidate = [SPEC_ARTIFACT_DIR, ...segments, "spec.md"].join("/");
        const classified = classifyPhaseArtifact(candidate);
        return classified === null || resolvesWithin(candidate, SPEC_ARTIFACT_DIR);
      },
    ));
  });
});

describe("phaseArtifactUpdates", () => {
  it("returns only the fields the writes justify", () => {
    expect(phaseArtifactUpdates([])).toEqual({});
    expect(phaseArtifactUpdates(["README.md", "engine/src/x.ts"])).toEqual({});
    expect(phaseArtifactUpdates([".claude/plans/p.md"])).toEqual({ plan_file: ".claude/plans/p.md" });
  });

  it("lets the last write of each kind win", () => {
    expect(phaseArtifactUpdates([
      ".claude/specs/run/spec.md",
      ".claude/plans/first.md",
      ".claude/plans/second.md",
    ])).toEqual({
      spec_file: ".claude/specs/run/spec.md",
      plan_file: ".claude/plans/second.md",
    });
  });

  it("drops a traversal write entirely rather than recording it", () => {
    expect(phaseArtifactUpdates([".claude/specs/../../../tmp/evil/spec.md"])).toEqual({});
  });
});
