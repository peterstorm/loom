import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { artifactWriteRoots, deriveArtifactWriteScope } from "../../src/core/artifact-write-scope";

describe("artifact write-scope derivation — role policy", () => {
  it("read-only spawns get nothing even when their prompts name artifact paths", () => {
    // A REALISTIC judge prompt: the manifest and interview paths it must READ
    // are exactly the paths that used to mint it a scoped write grant.
    const judge = [
      "Architecture judging",
      "Candidate manifest: .claude/specs/2026-08-12-foo/panel-runs/run.abc/manifest.json",
      "Validated interview digest: .claude/specs/2026-08-12-foo/panel-runs/run.abc/interview.json",
      "Score the candidates. Return pure JSON.",
    ].join("\n");
    expect(deriveArtifactWriteScope("arch-judge-agent", judge)).toBeNull();

    // Decompose reads the plan and spec — no grant even with plans paths.
    expect(deriveArtifactWriteScope(
      "decompose-agent",
      "Decompose .claude/plans/2026-08-12-foo.md into a task graph",
    )).toBeNull();

    // Verifiers/reviewers/spec-check/simplifiers: read-only contracts.
    expect(deriveArtifactWriteScope(
      "review-verifier-agent",
      "Refutation lens: reproduction. Brief: .claude/specs/2026-08-12-foo/panel-runs/run.abc/brief.json",
    )).toBeNull();
    expect(deriveArtifactWriteScope("code-reviewer", "Task: T1\nReview the implementation.")).toBeNull();
    expect(deriveArtifactWriteScope("spec-check-agent", "Spec at .claude/specs/2026-08-12-foo/spec.md")).toBeNull();
    expect(deriveArtifactWriteScope("code-simplifier", "Simplify the code")).toBeNull();
  });

  it("panel writers scope to their prompt-derived artifact dirs", () => {
    const designer = [
      "Write your candidate to .claude/specs/2026-08-12-foo/panel-runs/run.abc/candidates/candidate-simplicity-first.md",
      "Interview: .claude/specs/2026-08-12-foo/panel-runs/run.abc/interview.md",
    ].join("\n");
    expect(deriveArtifactWriteScope("arch-designer-agent", designer)).toEqual([
      ".claude/specs/2026-08-12-foo/panel-runs/run.abc/candidates",
    ]);
    // The interviewer's digest output scopes to the run dir.
    expect(deriveArtifactWriteScope(
      "arch-interviewer-agent",
      "Write the digest to .claude/specs/x/panel-runs/run.y/interview.md",
    )).toEqual([".claude/specs/x/panel-runs/run.y"]);
    // A panel writer without any path token gets nothing (no wide fallback).
    expect(deriveArtifactWriteScope("arch-designer-agent", "Design one candidate through your lens.")).toBeNull();
  });

  it("phase writers keep prompt-derived scope and phase fallback", () => {
    expect(deriveArtifactWriteScope(
      "specify-agent",
      "Output location: `.claude/specs/2026-08-12-foo/spec.md`",
    )).toEqual([".claude/specs/2026-08-12-foo"]);
    expect(deriveArtifactWriteScope("specify-agent", "Specify the feature.")).toEqual([".claude/specs"]);
    expect(deriveArtifactWriteScope("architecture-agent", "Write the plan.")).toEqual([".claude/plans"]);
    expect(deriveArtifactWriteScope(
      "plan-alignment-agent",
      "Align the plan at .claude/plans/2026-08-12-foo.md",
    )).toEqual([".claude/plans"]);
  });

  it("namespace prefixes do not defeat the role policy", () => {
    expect(deriveArtifactWriteScope("loom:arch-judge-agent", "manifest: .claude/specs/x/manifest.json")).toBeNull();
    expect(deriveArtifactWriteScope(
      "loom:arch-designer-agent",
      "write to .claude/specs/x/panel-runs/run.y/candidates/candidate-a.md",
    )).toEqual([".claude/specs/x/panel-runs/run.y/candidates"]);
  });
});

describe("artifact write-scope derivation — granularity filter", () => {
  it("a bare `.claude/specs` mention is dropped when a specific dir is named", () => {
    const task = [
      "the panel-run dir under .claude/specs/",
      "candidate: .claude/specs/2026-08-12-foo/panel-runs/run.abc/candidates/candidate-x.md",
    ].join("\n");
    expect(deriveArtifactWriteScope("arch-designer-agent", task)).toEqual([
      ".claude/specs/2026-08-12-foo/panel-runs/run.abc/candidates",
    ]);
  });

  it("distinct sibling dirs are all retained", () => {
    const task = [
      "spec: .claude/specs/2026-08-12-foo/spec.md",
      "extra: .claude/specs/2026-08-12-bar/notes.md",
    ].join("\n");
    expect(deriveArtifactWriteScope("specify-agent", task)).toEqual([
      ".claude/specs/2026-08-12-foo",
      ".claude/specs/2026-08-12-bar",
    ]);
  });

  it("property: the filter never returns a strict-prefix pair, and only narrows", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.constantFrom("a", "b", "c", "/", "-", "."), { minLength: 1, maxLength: 24 }), { minLength: 0, maxLength: 8 }),
        (fragments) => {
          const tokens = fragments
            .map((chars) => `.claude/specs/${chars.join("")}`)
            .filter((t) => t !== ".claude/specs/");
          const scope = deriveArtifactWriteScope(
            "arch-designer-agent",
            tokens.map((t) => `path: ${t}`).join("\n"),
          );
          if (scope === null) return; // no token matched: nothing to check
          // Every returned dir must be a member of the input token set.
          for (const dir of scope) {
            if (!tokens.some((t) => t === dir || t.startsWith(`${dir}/`))) throw new Error(`scope ${dir} not derived from input`);
          }
          // No strict-prefix pair survives the filter.
          for (const dir of scope) {
            for (const other of scope) {
              if (other !== dir && other.startsWith(`${dir}/`)) {
                throw new Error(`strict prefix pair survived: ${dir} ⊂ ${other}`);
              }
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("artifactWriteRoots — role-only roots (Claude Code policy)", () => {
  it("phase writers get their phase's canonical artifact dir", () => {
    for (const agent of ["brainstorm-agent", "specify-agent", "clarify-agent", "plan-alignment-agent"]) {
      expect(artifactWriteRoots(agent), agent).toEqual([".claude/specs"]);
    }
    expect(artifactWriteRoots("architecture-agent")).toEqual([".claude/plans"]);
  });

  it("panel writers get the spec tree", () => {
    expect(artifactWriteRoots("arch-interviewer-agent")).toEqual([".claude/specs"]);
    expect(artifactWriteRoots("arch-designer-agent")).toEqual([".claude/specs"]);
  });

  it("read-only and implementation roles get nothing", () => {
    for (const agent of [
      "arch-judge-agent", "decompose-agent", "review-verifier-agent", "code-reviewer",
      "spec-check-invoker", "code-simplifier", "code-implementer-agent", "not-an-agent", "",
    ]) {
      expect(artifactWriteRoots(agent), agent).toBeNull();
    }
  });

  it("strips the plugin namespace like the Pi policy does", () => {
    expect(artifactWriteRoots("loom:specify-agent")).toEqual([".claude/specs"]);
    expect(artifactWriteRoots("loom:arch-judge-agent")).toBeNull();
  });

  it("agrees with the Pi policy on WHO writes: same roles, and the same roots as Pi's no-path fallback", () => {
    const agents = [
      "brainstorm-agent", "specify-agent", "clarify-agent", "plan-alignment-agent", "architecture-agent",
      "arch-interviewer-agent", "arch-designer-agent", "arch-judge-agent", "decompose-agent", "code-reviewer",
    ];
    for (const agent of agents) {
      const pi = deriveArtifactWriteScope(agent, "write .claude/specs/x/out.md");
      expect(artifactWriteRoots(agent) === null, agent).toBe(pi === null);
    }
    for (const agent of ["brainstorm-agent", "specify-agent", "clarify-agent", "plan-alignment-agent", "architecture-agent"]) {
      expect(artifactWriteRoots(agent), agent).toEqual(deriveArtifactWriteScope(agent, "no artifact path here"));
    }
  });
});
