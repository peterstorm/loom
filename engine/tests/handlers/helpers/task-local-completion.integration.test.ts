import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createImplementationAttemptAuthority } from "../../../src/core/implementation-completion";
import { derivePendingTaskProof } from "../../../src/core/proof-obligations";
import { observeTaskLocalCompletion } from "../../../src/handlers/helpers/task-local-completion";
import {
  captureDeclaredArtifactBaseline,
  captureRepositoryChangeBaseline,
} from "../../../src/utils/artifact-baseline";
import { taskFixture } from "../../fixtures/task-lifecycle";

const roots: string[] = [];

function repository() {
  const root = mkdtempSync(join(tmpdir(), "loom-task-local-suite-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "loom@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Loom Test"], { cwd: root });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "sibling.ts"), "export const sibling = 1;\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "seed"], { cwd: root });
  const attemptBaseline = captureDeclaredArtifactBaseline(root, ["src/a.ts"]);
  const repositoryBaseline = captureRepositoryChangeBaseline(root);
  const created = createImplementationAttemptAuthority({
    taskId: "T1",
    wave: 1,
    semanticAttempt: 1,
    reservationId: "task-local-shell",
    headSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    reservedAt: "2026-08-24T00:00:00.000Z",
    taskScopeBaseline: attemptBaseline,
    dirtySetBaseline: repositoryBaseline,
  });
  if (!created.ok) throw new Error(created.error.errors.join("; "));
  const task = taskFixture({
    id: "T1",
    description: "observe",
    agent: "code-implementer-agent",
    wave: 1,
    status: "pending",
    depends_on: [],
    file_list: ["src/a.ts"],
    new_tests_required: false,
    proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: ["src/a.ts"] }),
    artifact_baseline: attemptBaseline,
    attempt_artifact_baseline: attemptBaseline,
    attempt_repository_baseline: repositoryBaseline,
    active_implementation_attempt: created.value,
    reserved_at: created.value.reservedAt,
  });
  return { root, task, authority: created.value };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Task-local completion observation shell", () => {
  it("observes exact accepted Task bytes without running a Task command", () => {
    const fixture = repository();
    writeFileSync(join(fixture.root, "src/a.ts"), "export const a = 2;\n");
    const observed = observeTaskLocalCompletion({
      repositoryRoot: fixture.root,
      task: fixture.task,
      authority: fixture.authority,
      parserModifiedPaths: [join(fixture.root, "src/a.ts")],
      parserPathLabel: "test transcript paths",
    });
    expect(observed.suite.checks[0]?.outcome).toEqual({
      kind: "accepted",
      changedPaths: ["src/a.ts"],
    });
    expect(observed.cumulativeProofArtifactChanges).toEqual(["src/a.ts"]);
  });

  it("keeps a foreign transcript path semantic even when it names an existing file", () => {
    const fixture = repository();
    const observed = observeTaskLocalCompletion({
      repositoryRoot: fixture.root,
      task: fixture.task,
      authority: fixture.authority,
      parserModifiedPaths: ["sibling.ts"],
      parserPathLabel: "test transcript paths",
    });
    expect(observed.suite.checks[0]?.outcome).toEqual({
      kind: "out-of-scope-writes",
      paths: ["sibling.ts"],
    });
  });

  it("uses sibling dirty-set movement only as invalidation evidence", () => {
    const fixture = repository();
    writeFileSync(join(fixture.root, "sibling.ts"), "export const sibling = 2;\n");
    const observed = observeTaskLocalCompletion({
      repositoryRoot: fixture.root,
      task: fixture.task,
      authority: fixture.authority,
      parserModifiedPaths: [],
      parserPathLabel: "test transcript paths",
    });
    expect(observed.suite.checks[0]?.outcome).toEqual({ kind: "accepted", changedPaths: [] });
    expect(observed.cumulativeProofArtifactChanges).toEqual([]);
    expect(observed.exactTaskBytesChanged).toBe(false);
    expect(observed.invalidationBytesChanged).toBe(true);
  });

  it.each([
    ["missing baseline", { attempt_artifact_baseline: undefined }],
    ["unsafe parser path", null],
  ])("maps %s uncertainty to infrastructure unavailable", (_name, mutation) => {
    const fixture = repository();
    const task = mutation === null ? fixture.task : taskFixture({ ...fixture.task, ...mutation });
    const observed = observeTaskLocalCompletion({
      repositoryRoot: fixture.root,
      task,
      authority: fixture.authority,
      parserModifiedPaths: mutation === null ? ["../escape.ts"] : [],
      parserPathLabel: "test transcript paths",
    });
    expect(observed.suite.checks[0]?.outcome).toMatchObject({ kind: "observation-unavailable" });
    expect(observed.exactTaskBytesChanged).toBe(true);
  });
});
