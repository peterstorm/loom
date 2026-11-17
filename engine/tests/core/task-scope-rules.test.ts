/**
 * loom#198, Cause 3: graph invariants checked at population, not discovered
 * at settlement or a Wave Gate.
 * - `rosterScopeProblems`: an I6-owing Task with no test file, and I6-owing
 *   Tasks under a manifest with no engine runner;
 * - `unownedRequirements`: a completable Requirement no Task completes;
 * - the runner presets every manifest admits, and the detection order;
 * - population refuses each, with the fix in the message.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { frozenNonTestFiles, rosterScopeProblems, renderTaskScopeProblem, taskTestFileProblem, type ScopeAuthority, type ScopedTask } from "../../src/core/task-scope-rules";
import { unownedRequirements } from "../../src/core/requirement-coverage";
import {
  affectedRunnerHint,
  affectedRunnerHintFor,
  RUNNER_PRESET_IDS,
  RUNNER_PRESETS,
  suggestRunnerPreset,
  type RepositoryRunnerFacts,
} from "../../src/core/runner-presets";
import { defaultVerificationManifest, freezeVerificationManifest, legacyDefaultVerificationManifest } from "../../src/core/verification-manifest";
import { parseAuthoredTaskRoster, populateTaskGraph, type AuthoredTask } from "../../src/core/task-graph-population";
import { i6RunnerManifest } from "../fixtures/i6-runner-manifest";
import { indexedSpec } from "../fixtures/spec-index-fixture";

const REQUIRED = { regression: { kind: "required" as const }, newTests: { kind: "required" as const } };
const WAIVED = { regression: { kind: "required" as const }, newTests: { kind: "waived" as const, reason: "existing-tests-sufficient" as const } };
const scoped = (id: string, fileList: readonly string[], policy: ScopedTask["policy"] = REQUIRED): ScopedTask => ({ id, fileList, policy });
const under = (manifest: ScopeAuthority["manifest"] = i6RunnerManifest(), contracts: ScopeAuthority["contracts"] = []): ScopeAuthority => ({ manifest, contracts });

describe("rosterScopeProblems", () => {
  it("refuses an I6-owing Task whose file_list holds no test file, naming the frozen suffixes", () => {
    const manifest = i6RunnerManifest();
    expect(taskTestFileProblem(scoped("T1", ["src/a.ts"]), under(manifest)))
      .toMatchObject({ kind: "no-test-file", taskId: "T1", suffixes: expect.arrayContaining([".test.ts"]) });
    expect(taskTestFileProblem(scoped("T1", ["src/a.ts", "src/a.test.ts"]), under(manifest))).toBeNull();
  });

  it("asks nothing of a Task that owes no I6: waived new tests, a contract writer, or a pre-I6 graph", () => {
    const manifest = i6RunnerManifest();
    expect(taskTestFileProblem(scoped("T1", ["src/a.ts"], WAIVED), under(manifest))).toBeNull();
    expect(taskTestFileProblem(scoped("T1", ["src/a.ts"]), under(manifest, [{ id: "CT-1", contractTask: "T1" }]))).toBeNull();
    expect(taskTestFileProblem(scoped("T1", ["src/a.ts"]), { manifest: undefined, contracts: [] })).toBeNull();
  });

  it("refuses I6-owing Tasks once, together, when the manifest declares no engine runner", () => {
    const manifest = defaultVerificationManifest();
    const problems = rosterScopeProblems(
      [scoped("T1", ["src/a.ts", "src/a.test.ts"]), scoped("T2", ["src/b.ts"], WAIVED), scoped("T3", ["src/c.ts", "src/c.test.ts"])],
      under(manifest),
    );
    expect(problems).toEqual([{ kind: "no-engine-runner", taskIds: ["T1", "T3"] }]);
    expect(renderTaskScopeProblem(problems[0]!)).toContain("declare an affectedRunner");
  });

  it("is empty exactly when every I6-owing Task names a test file and a runner is declared", () => {
    const manifest = i6RunnerManifest();
    const task = fc.record({
      hasTest: fc.boolean(),
      owes: fc.boolean(),
    });
    fc.assert(fc.property(fc.array(task, { maxLength: 6 }), (tasks) => {
      const roster = tasks.map(({ hasTest, owes }, index) =>
        scoped(`T${index + 1}`, hasTest ? [`src/t${index}.ts`, `src/t${index}.test.ts`] : [`src/t${index}.ts`], owes ? REQUIRED : WAIVED));
      const expected = tasks.every(({ hasTest, owes }) => hasTest || !owes);
      expect(rosterScopeProblems(roster, under(manifest)).length === 0).toBe(expected);
    }));
  });
});

describe("frozenNonTestFiles", () => {
  it("names the files the frozen classification does not call a test, in order", () => {
    expect(frozenNonTestFiles(i6RunnerManifest(), ["src/a.ts", "src/a.test.ts", "src/b.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("names none on a graph frozen before the classification existed, or with no manifest", () => {
    expect(frozenNonTestFiles(legacyDefaultVerificationManifest(), ["src/a.ts"])).toEqual([]);
    expect(frozenNonTestFiles(undefined, ["src/a.ts"])).toEqual([]);
  });
});

describe("unownedRequirements", () => {
  const spec = indexedSpec("spec.md");
  if (spec.kind !== "indexed") throw new Error("fixture spec must index");

  it("names every FR, then every AS, that no completion claim names", () => {
    expect(unownedRequirements(spec.index, ["FR-001", "AS-002"])).toEqual(["FR-002", "AS-001"]);
    expect(unownedRequirements(spec.index, ["FR-001", "FR-002", "AS-001", "AS-002"])).toEqual([]);
  });
});

describe("runner presets", () => {
  it.each(RUNNER_PRESET_IDS)("the %s preset is an affectedRunner the manifest parser admits", (preset) => {
    const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
      schemaVersion: 2, kind: "loom-verification-manifest", checks: [], affectedRunner: RUNNER_PRESETS[preset],
    })));
    expect(frozen.ok, frozen.ok ? "" : frozen.error.errors.join("; ")).toBe(true);
  });

  const facts = (overrides: Partial<RepositoryRunnerFacts> = {}): RepositoryRunnerFacts =>
    ({ packages: new Set(), testScript: null, packageJsonProblem: null, bunLockfile: false, ...overrides });

  it("takes the test script first, then installed packages, then a Bun lockfile", () => {
    expect(suggestRunnerPreset(facts({ testScript: "vitest run", packages: new Set(["mocha"]) }))?.preset).toBe("vitest");
    expect(suggestRunnerPreset(facts({ testScript: "mocha -r ts-node/register", packages: new Set(["ts-node"]) }))?.preset).toBe("mocha-ts-node");
    expect(suggestRunnerPreset(facts({ testScript: "node --test" }))?.preset).toBe("node-test");
    expect(suggestRunnerPreset(facts({ packages: new Set(["jest"]) }))?.preset).toBe("jest");
    expect(suggestRunnerPreset(facts({ packages: new Set(["mocha"]) }))?.preset).toBe("mocha");
    expect(suggestRunnerPreset(facts({ bunLockfile: true }))?.preset).toBe("bun");
    expect(suggestRunnerPreset(facts())).toBeNull();
  });

  it("prints the detected preset with why, or the generic shape, and how to install it", () => {
    const detected = affectedRunnerHint({ preset: "mocha", because: "package.json depends on mocha" }, ".loom/verification-manifest.json");
    expect(detected).toContain("Suggested runner: mocha (package.json depends on mocha)");
    expect(detected).toContain('"affectedRunner"');
    expect(detected).toContain("helper write-verification-manifest");
    expect(affectedRunnerHint(null, ".loom/verification-manifest.json")).toContain("No known test runner was detected.");
  });

  it("names a package.json it could not read instead of only printing the generic shape", () => {
    const hint = affectedRunnerHintFor(facts({ packageJsonProblem: "package.json is not valid JSON: Unexpected token" }), ".loom/verification-manifest.json");
    expect(hint).toContain("No known test runner was detected (package.json is not valid JSON: Unexpected token; fix it to get a suggestion)");
  });
});

describe("population refuses an unprovable scope or an unowned Requirement", () => {
  const authored = (id: string, anchors: readonly string[], fileList: readonly string[], newTests: "required" | "waived" = "required"): AuthoredTask => ({
    id, description: id, agent: "code-implementer-agent", wave: 1, depends_on: [], spec_anchors: [...anchors], spec_contributions: [],
    verification_policy: {
      regression: { kind: "required" },
      new_tests: newTests === "required" ? { kind: "required" } : { kind: "waived", reason: "existing-tests-sufficient" },
    },
    file_list: [...fileList],
  });
  const populate = (tasks: readonly AuthoredTask[], manifest = i6RunnerManifest()) => {
    const roster = parseAuthoredTaskRoster(tasks);
    if (!roster.ok) throw new Error(roster.error);
    return populateTaskGraph(
      { current_phase: "decompose", phase_artifacts: {}, skipped_phases: [], spec_file: "spec.md", plan_file: "plan.md", tasks: [], wave_gates: {} },
      {
        planTitle: "scope", validatedPlanFile: "plan.md", tasks: roster.value, verificationManifest: manifest,
        specIndex: indexedSpec("spec.md"), observedSpecFile: "spec.md", force: false,
        proofBoundary: { kind: "absent", cause: "fixture" }, contracts: [], invariants: [],
      },
    );
  };
  const ALL = ["FR-001", "FR-002", "AS-001", "AS-002"];

  it("populates a roster that owns every Requirement and can prove its I6", () => {
    expect(populate([authored("T1", ALL, ["src/a.ts", "src/a.test.ts"])])).toMatchObject({ ok: true });
  });

  it("refuses an I6-owing Task with no test file", () => {
    expect(populate([authored("T1", ALL, ["src/a.ts"])])).toMatchObject({ ok: false, error: { kind: "unprovable-task-scope" } });
  });

  it("refuses I6-owing Tasks under a manifest with no engine runner", () => {
    expect(populate([authored("T1", ALL, ["src/a.ts", "src/a.test.ts"])], defaultVerificationManifest()))
      .toMatchObject({ ok: false, error: { kind: "unprovable-task-scope", message: expect.stringContaining("declares no affectedRunner") } });
  });

  it("populates without a runner when no Task owes I6", () => {
    expect(populate([authored("T1", ALL, ["src/a.ts"], "waived")], defaultVerificationManifest())).toMatchObject({ ok: true });
  });

  it("refuses a Requirement no Task completes, naming each", () => {
    const result = populate([authored("T1", ["FR-001", "AS-001"], ["src/a.ts"], "waived")]);
    expect(result).toMatchObject({ ok: false, error: { kind: "unowned-requirement" } });
    if (!result.ok) expect(result.error.message).toContain("FR-002, AS-002 have no completion owner");
  });

  it("does not let a contribution own a Requirement", () => {
    const contributor = { ...authored("T1", ["FR-001", "AS-001", "AS-002"], ["src/a.ts"], "waived"), spec_contributions: ["FR-002"] };
    const result = populate([contributor]);
    expect(result).toMatchObject({ ok: false, error: { kind: "unowned-requirement" } });
    if (!result.ok) expect(result.error.message).toContain("FR-002");
  });

  it("names every problem in one refusal: a Task with no test file and an unowned Requirement", () => {
    const result = populate([authored("T1", ["FR-001", "AS-001", "AS-002"], ["src/a.ts"])]);
    expect(result).toMatchObject({ ok: false, error: { kind: "unprovable-task-scope" } });
    if (!result.ok) {
      expect(result.error.problems?.map(({ kind }) => kind)).toEqual(["no-test-file", "unowned-requirements"]);
      expect(result.error.message).toContain("T1");
      expect(result.error.message).toContain("FR-002");
    }
  });
});
