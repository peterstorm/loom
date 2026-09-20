/**
 * Reconcile attestation (D4 option 2): the reconcile oracle measures drift
 * against the ATTEMPT baseline (`attempt_artifact_baseline`), never the
 * population baseline — the work predates the attempt, so population-relative
 * changes ARE the attested bytes, not writes. Transcript attribution is
 * refused: cumulative `files_modified` from earlier attempts must not read as
 * drift this attempt never produced.
 *
 * The happy path cannot be fully green by construction: reconcile re-derives
 * proof from stored evidence, and a fresh attestation Task has no completion
 * observation, so the honest outcome is `task-completed` failing while the
 * `declared-artifact-attested` obligation holds (bytes unchanged). Drift —
 * any byte move inside the attempt scope — settles as
 * `attempt-scope-drifted` (plus declared-artifact detail when applicable), never as attested.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { afterEach, describe, expect, it } from "vitest";
import {
  ATTESTATION_VERIFICATION_POLICY,
  attestedTask,
} from "../../../src/handlers/helpers/attest-implementation";
import { derivePendingTaskProof } from "../../../src/core/proof-obligations";
import { serializeVerificationPolicy } from "../../../src/core/verification-policy";
import { captureDeclaredArtifactBaseline } from "../../../src/utils/artifact-baseline";
import { parseTaskGraph } from "../../../src/state-manager";

const ENGINE = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(ENGINE, "src", "cli.ts");

const cleanup: string[] = [];
let previousLoomStatePath: string | undefined;

afterEach(() => {
  if (previousLoomStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousLoomStatePath;
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly statePath: string;
}

/** Git repo with one committed declared artifact and an attestation Task whose
 * attempt baseline is the CURRENT bytes of that artifact. */
function fixture(initialBytes: string): Fixture {
  previousLoomStatePath = process.env.LOOM_STATE_PATH;
  const root = canonicalTempDir("loom-reconcile-attestation-");
  cleanup.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "loom@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Loom Test"], { cwd: root });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), initialBytes);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "wave 0 already did the work"], { cwd: root });

  const attemptBaseline = captureDeclaredArtifactBaseline(root, ["src/a.ts"]);
  const attested = attestedTask({
    id: "T1",
    description: "pre-existing work",
    agent: "code-implementer-agent",
    wave: 1,
    status: "pending",
    depends_on: [],
    file_list: ["src/a.ts"],
    proof: derivePendingTaskProof({
      verificationPolicy: ATTESTATION_VERIFICATION_POLICY,
      declaredArtifacts: ["src/a.ts"],
      declaredArtifactExpectation: "attested",
    }),
    verification_policy: serializeVerificationPolicy(ATTESTATION_VERIFICATION_POLICY),
    attempt_artifact_baseline: attemptBaseline,
  } as never);
  const graph = {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: [],
    tasks: [attested],
    wave_gates: {
      "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false },
    },
  };
  const parsed = parseTaskGraph(graph);
  if (!parsed.ok) throw new Error(parsed.error);
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  writeFileSync(statePath, JSON.stringify(graph, null, 2));
  process.env.LOOM_STATE_PATH = statePath;
  return { root, statePath };
}

const reconcile = (root: string) =>
  spawnSync("bun", [CLI, "helper", "reconcile-implementation-proof", "--wave", "1"], {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env },
  });

const storedTask = (statePath: string) => {
  const raw = JSON.parse(readFileSync(statePath, "utf-8")) as { tasks: Record<string, unknown>[] };
  const reparsed = parseTaskGraph(raw);
  if (!reparsed.ok) throw new Error(`rewritten graph does not parse: ${reparsed.error}`);
  return reparsed.value.tasks[0]!;
};

describe("reconcile attestation oracle", () => {
  it("keeps attested artifacts satisfied on unchanged bytes and fails only on the missing completion", () => {
    const { root, statePath } = fixture("export const done = true;\n");
    const run = reconcile(root);
    // No completion observation and no stored test result are persisted, so
    // the honest reconcile outcome is a failed proof whose failures are only
    // the unobserved completion and test result — the attested obligation
    // holds because no byte moved since the attempt baseline.
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("T1: status=pending, proof=failed, failures=[task-not-completed, test-result-missing]");
    const task = storedTask(statePath);
    expect(task.proof?.state).toBe("failed");
    expect(task.proof?.state === "failed" && task.proof.failures.map((failure) => failure.kind).sort()).toEqual([
      "task-not-completed",
      "test-result-missing",
    ]);
    // The attestation surface survives reconcile: mode, attempt baseline,
    // policy, and the attested obligation stay byte-identical in kind.
    expect(task.implementation_attestation).toBe(true);
    expect(task.verification_policy).toEqual({
      regression: { kind: "required" },
      new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
    });
  });

  it("settles a byte move since the attempt baseline as declared-artifact-drifted", () => {
    const { root, statePath } = fixture("export const done = true;\n");
    // The child (or anything) wrote to the declared artifact after the attempt
    // baseline was captured — attestation forbids writes, so this is drift.
    writeFileSync(join(root, "src", "a.ts"), "export const done = false;\n");
    const run = reconcile(root);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("declared-artifact-drifted:src/a.ts");
    const task = storedTask(statePath);
    expect(task.proof?.state).toBe("failed");
    expect(task.proof?.state === "failed" && task.proof.failures.map((failure) => failure.kind).sort()).toEqual([
      "attempt-scope-drifted",
      "declared-artifact-drifted",
      "task-not-completed",
      "test-result-missing",
    ]);
  });

  it("refuses an attestation Task with no attempt baseline and changes no state", () => {
    const { root, statePath } = fixture("export const done = true;\n");
    const stripped = JSON.parse(readFileSync(statePath, "utf-8")) as { tasks: Record<string, unknown>[] };
    delete (stripped.tasks[0] as Record<string, unknown>).attempt_artifact_baseline;
    const before = JSON.stringify(stripped, null, 2);
    writeFileSync(statePath, before);

    const run = reconcile(root);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(
      "attestation Task T1 has no attempt_artifact_baseline to attest against; " +
      "dispatch an attestation attempt first — the attest program only prepares the Task",
    );
    expect(run.stderr).toContain("failed without changing state");
    expect(readFileSync(statePath, "utf-8")).toBe(before);
  });
});
