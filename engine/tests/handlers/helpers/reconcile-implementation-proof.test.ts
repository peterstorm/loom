import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateTaskProof, PI_STRUCTURED_EVIDENCE_POLICY } from "../../../src/core/proof-obligations";
import { createReviewPacket, parseBaseSha, parseHeadSha, serializeReviewPacket, type BaseSha, type HeadSha } from "../../../src/core/review-packet";

const base = (hex: string): BaseSha => {
  const parsed = parseBaseSha(hex);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
};
const head = (hex: string): HeadSha => {
  const parsed = parseHeadSha(hex);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
};
import {
  parseRecoveredBaselineSha,
  parseRecoveryPacketBindings,
  reconcileTaskFromStoredEvidence,
  reconciliationFailureMessage,
} from "../../../src/handlers/helpers/reconcile-implementation-proof";
import type { Task } from "../../../src/types";
import { NEW_TEST_EVIDENCE_NOT_WRITTEN, parseNewTestEvidence } from "../../../src/types";
import { taskFixture, observedEvidence } from "../../fixtures/task-lifecycle";
import { CONFORMANCE_NOT_OWED } from "../../../src/core/skeleton/conformance-verdict";
import { legacyDefaultVerificationManifest } from "../../../src/core/verification-manifest";

/**
 * The failed Proof of a no-new-tests Task over `fileList` whose attempt
 * completed and passed its tests, but whose poisoned baseline hid the
 * declared artifacts' change: the shape historical recovery repairs.
 */
const unresolvedProof = (fileList: readonly string[]): Task["proof"] => evaluateTaskProof(
  { declaredArtifactExpectation: "changed", newTestsRequired: false, declaredArtifacts: fileList },
  observedEvidence({ taskCompleted: true, filesModified: [], newTestsWritten: false }),
  PI_STRUCTURED_EVIDENCE_POLICY,
);

const ENGINE = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(ENGINE, "src", "cli.ts");
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const testResult = {
  verdict: "untrusted" as const,
  passed: true,
  label: "pi-structured: bun: 25 pass", provenance: "pi-structured" as const,
};

function failedTask(taskCompleted = true): Task {
  const proof = evaluateTaskProof(
    { declaredArtifactExpectation: "changed", newTestsRequired: true, declaredArtifacts: ["src/a.ts"] },
    observedEvidence({ taskCompleted, testResult, filesModified: [], newTestsWritten: false, newTestEvidence: "" }),
    PI_STRUCTURED_EVIDENCE_POLICY,
  );
  if (proof.state !== "failed") throw new Error("failed Task fixture must carry failed Proof");
  return taskFixture({
    id: "T5",
    description: "implementation",
    agent: "code-implementer-agent",
    wave: 2,
    status: "pending",
    depends_on: [],
    file_list: ["src/a.ts"],
    files_modified: ["src/a.ts"],
    new_tests_required: true,
    new_test_observation: parseNewTestEvidence(true, "1 new test method, 2 assertions"),
    test_result: testResult,
    test_evidence: "bun: 25 pass",
    proof,
  });
}

describe("reconciliation failure diagnostics", () => {
  it("retains the pre-commit unchanged-state diagnostic", () => {
    expect(reconciliationFailureMessage(new Error("proof mismatch"))).toBe(
      "reconcile-implementation-proof failed without changing state: proof mismatch",
    );
  });
});

describe("recovery arguments", () => {
  it("parses repeated task-bound packet arguments and rejects malformed mappings", () => {
    expect(parseRecoveryPacketBindings([
      "--packet", "T5=.claude/reviews/one.json",
      "--packet", "T5=.claude/reviews/two.json",
      "--packet", "T6=.claude/reviews/six.json",
    ])).toEqual([
      { taskId: "T5", packetPath: ".claude/reviews/one.json" },
      { taskId: "T5", packetPath: ".claude/reviews/two.json" },
      { taskId: "T6", packetPath: ".claude/reviews/six.json" },
    ]);
    expect(() => parseRecoveryPacketBindings(["--packet", "missing-separator"]))
      .toThrow(/TASK_ID=/);
  });

  it("accepts one exact Git SHA and rejects malformed or repeated overrides", () => {
    const sha = "a".repeat(40);
    expect(parseRecoveredBaselineSha(["--wave", "2", "--baseline-sha", sha])).toBe(sha);
    expect(parseRecoveredBaselineSha(["--wave", "2"])).toBeNull();
    expect(() => parseRecoveredBaselineSha(["--baseline-sha", "HEAD~1"]))
      .toThrow(/lowercase 40- or 64-character/);
    expect(() => parseRecoveredBaselineSha([
      "--baseline-sha", sha, "--baseline-sha", sha,
    ])).toThrow(/only once/);
  });
});

/**
 * A repository whose Wave 2 commit `poisonedStart` sits on `historical`,
 * with `artifact` implemented in it and T5's Review Packet issued over
 * `declared`; the State File directory is created, the file is not.
 */
function poisonedRecoveryRepository(label: string, artifact: string, declared: string) {
  const root = canonicalTempDir(label);
  cleanup.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();
  git("init", "--quiet");
  git("config", "user.email", "loom@example.invalid");
  git("config", "user.name", "Loom Test");
  git("commit", "--quiet", "--allow-empty", "-m", "before wave 2");
  const historical = git("rev-parse", "HEAD");
  mkdirSync(dirname(join(root, artifact)), { recursive: true });
  const implemented = "export const implemented = true;\n";
  writeFileSync(join(root, artifact), implemented);
  git("add", ".");
  git("commit", "--quiet", "-m", "wave 2 implementation");
  const poisonedStart = git("rev-parse", "HEAD");
  const packet = createReviewPacket({
    task: { id: "T5", description: "implementation" },
    baseSha: base(historical),
    headSha: head(poisonedStart),
    declaredPaths: [declared],
    modifiedPaths: [declared],
    artifacts: [{ path: artifact, diff: "+implemented\n", postimage: Buffer.from(implemented) }],
    planContext: "",
    proofObligations: [],
  });
  if (!packet.ok) throw new Error(packet.errors.join("; "));
  const packetRelative = ".claude/reviews/T5.json";
  mkdirSync(join(root, ".claude", "reviews"), { recursive: true });
  writeFileSync(join(root, packetRelative), serializeReviewPacket(packet.value));
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  return { root, historical, poisonedStart, implemented, packet, packetRelative, statePath };
}

/**
 * Wave 2 after its spec-check passed and its gate completed, with T5 pending
 * on an unresolved Proof after a failed review evidence capture; `task`
 * adds or overrides T5's fields.
 */
function gatedRecoveryGraph(task: Record<string, unknown>) {
  return {
    current_phase: "execute", verification_manifest: legacyDefaultVerificationManifest(), phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: null, current_wave: 2, executing_tasks: [],
    spec_check: {
      wave: 2, run_at: "before recovery", verdict: "PASSED",
      critical_count: 0, high_count: 0,
      critical_findings: [], high_findings: [], medium_findings: [],
    },
    wave_gates: {
      "2": { impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false },
    },
    tasks: [{
      id: "T5", description: "implementation", agent: "code-implementer-agent",
      wave: 2, status: "pending", proof: unresolvedProof(["src/a.ts"]), depends_on: [], new_tests_required: false,
      review_status: "evidence_capture_failed",
      review_error: "review transcript missing evidence",
      review_evidence_failures: ["code-reviewer"],
      file_list: ["src/a.ts"], files_modified: ["latest-only.ts"],
      ...task,
    }],
  };
}

describe("historical baseline recovery CLI", () => {
  it("refuses a non-Git State File with its exact refusal message and a byte-identical State File", () => {
    const root = canonicalTempDir("loom-proof-nongit-");
    cleanup.push(root);
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    mkdirSync(join(root, ".claude", "state"), { recursive: true });
    writeFileSync(statePath, JSON.stringify(gatedRecoveryGraph({}), null, 2));
    const before = readFileSync(statePath);

    const refusal = spawnSync("bun", [CLI, "helper", "reconcile-implementation-proof", "--wave", "2"], {
      cwd: root, encoding: "utf-8", env: { ...process.env, LOOM_STATE_PATH: statePath },
    });
    expect(refusal.status).not.toBe(0);
    expect(refusal.stderr).toContain("reconcile-implementation-proof requires a git repository");
    expect(readFileSync(statePath).equals(before)).toBe(true);
  });

  it("atomically replaces poisoned boundaries with an audited ancestor commit", () => {
    const { root, historical, poisonedStart, implemented, packet, packetRelative, statePath } =
      poisonedRecoveryRepository("loom-proof-recovery-", "src/a.ts", "src/a.ts");
    writeFileSync(statePath, JSON.stringify(gatedRecoveryGraph({
      start_sha: poisonedStart,
      artifact_baseline: [{
        artifact: "src/a.ts",
        snapshot: {
          kind: "sha256",
          digest: createHash("sha256").update(implemented).digest("hex"),
        },
      }],
    }), null, 2));

    const withoutOverride = spawnSync("bun", [CLI, "helper", "reconcile-implementation-proof", "--wave", "2"], {
      cwd: root, encoding: "utf-8", env: { ...process.env, LOOM_STATE_PATH: statePath },
    });
    expect(withoutOverride.status).not.toBe(0);

    const beforePacketlessRecovery = readFileSync(statePath, "utf-8");
    const packetlessRecovery = spawnSync("bun", [
      CLI, "helper", "reconcile-implementation-proof", "--wave", "2",
      "--baseline-sha", historical,
    ], {
      cwd: root, encoding: "utf-8", env: { ...process.env, LOOM_STATE_PATH: statePath },
    });
    expect(packetlessRecovery.status).not.toBe(0);
    expect(packetlessRecovery.stderr).toContain("requires at least one --packet binding");
    expect(readFileSync(statePath, "utf-8")).toBe(beforePacketlessRecovery);

    const unregistered = spawnSync("bun", [
      CLI, "helper", "reconcile-implementation-proof", "--wave", "2",
      "--baseline-sha", historical,
      "--packet", `T5=${packetRelative}`,
    ], {
      cwd: root, encoding: "utf-8", env: { ...process.env, LOOM_STATE_PATH: statePath },
    });
    expect(unregistered.status).not.toBe(0);
    expect(unregistered.stderr).toContain("is not registered as engine-issued");

    const registeredState = JSON.parse(readFileSync(statePath, "utf-8"));
    registeredState.tasks[0].issued_review_packets = [{
      task_id: "T5",
      packet_id: packet.value.packetId,
      packet_path: packetRelative,
      base_sha: historical,
      head_sha: poisonedStart,
      scope: ["src/a.ts"],
    }];
    chmodSync(statePath, 0o600);
    writeFileSync(statePath, JSON.stringify(registeredState, null, 2));

    const invalidPacketRelative = ".claude/reviews/T6-bound-as-T5.json";
    const wrongTaskPacket = createReviewPacket({
      task: { id: "T6", description: "wrong task" },
      baseSha: base(historical),
      headSha: head(poisonedStart),
      declaredPaths: ["src/a.ts"],
      modifiedPaths: ["src/a.ts"],
      artifacts: [{ path: "src/a.ts", diff: "+implemented\n", postimage: Buffer.from(implemented) }],
      planContext: "",
      proofObligations: [],
    });
    if (!wrongTaskPacket.ok) throw new Error(wrongTaskPacket.errors.join("; "));
    writeFileSync(join(root, invalidPacketRelative), serializeReviewPacket(wrongTaskPacket.value));
    const beforeAtomicFailure = readFileSync(statePath, "utf-8");
    const atomicFailure = spawnSync("bun", [
      CLI, "helper", "reconcile-implementation-proof", "--wave", "2",
      "--baseline-sha", historical,
      "--packet", `T5=${packetRelative}`,
      "--packet", `T5=${invalidPacketRelative}`,
    ], {
      cwd: root, encoding: "utf-8", env: { ...process.env, LOOM_STATE_PATH: statePath },
    });
    expect(atomicFailure.status).not.toBe(0);
    expect(readFileSync(statePath, "utf-8")).toBe(beforeAtomicFailure);

    // The trusted baseline did not contain this path. Returning to that exact
    // state cannot discharge a declared-artifact change, even with a packet.
    rmSync(join(root, "src", "a.ts"));
    const unchangedFromBaseline = spawnSync("bun", [
      CLI, "helper", "reconcile-implementation-proof", "--wave", "2",
      "--baseline-sha", historical,
      "--packet", `T5=${packetRelative}`,
    ], {
      cwd: root, encoding: "utf-8", env: { ...process.env, LOOM_STATE_PATH: statePath },
    });
    expect(unchangedFromBaseline.status).not.toBe(0);
    expect(unchangedFromBaseline.stderr).toContain("current bytes do not differ from recovered baseline");
    expect(readFileSync(statePath, "utf-8")).toBe(beforeAtomicFailure);

    // A later legitimate edit no longer equals the packet postimage, but it
    // still differs from the trusted baseline and retains T5's packet-proven
    // cumulative write attribution.
    const laterBytes = "export const driftedLater = true;\n";
    writeFileSync(join(root, "src", "a.ts"), laterBytes);
    // Both linked worktrees begin at the same HEAD. Only the State File's
    // worktree differs from the historical baseline; ambient bytes do not.
    const ambient = canonicalTempDir("loom-proof-ambient-");
    cleanup.push(ambient);
    execFileSync("git", ["worktree", "add", "--detach", ambient, "HEAD"], { cwd: root });
    rmSync(join(ambient, "src", "a.ts"));
    const recovered = spawnSync("bun", [
      CLI, "helper", "reconcile-implementation-proof", "--wave", "2",
      "--baseline-sha", historical,
      "--packet", `T5=${packetRelative}`,
    ], {
      cwd: ambient, encoding: "utf-8", env: { ...process.env, LOOM_STATE_PATH: statePath },
    });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe(laterBytes);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0]).toMatchObject({
      status: "pending", revalidation_required: true,
      start_sha: historical,
      artifact_baseline_recovered_from: historical,
      proof: { state: "satisfied" },
      files_modified: ["latest-only.ts", "src/a.ts"],
      artifact_baseline: [{ artifact: "src/a.ts", snapshot: { kind: "missing" } }],
      recovered_artifact_writes: [{
        baseline_sha: historical,
        packet_id: packet.value.packetId,
        packet_path: packetRelative,
        modified_paths: ["src/a.ts"],
      }],
    });
    expect(state.tasks[0].review_status).toBe("pending");
    expect(state.tasks[0].review_error).toBeUndefined();
    expect(state.tasks[0].review_evidence_failures).toBeUndefined();
    expect(state.spec_check).toBeUndefined();
    // The recovered Proof is satisfied but awaits revalidation, so the Wave is not yet implemented.
    expect(state.wave_gates["2"]).toMatchObject({
      impl_complete: false, tests_passed: null, reviews_complete: false,
    });
  });
});

describe("directory artifact packet recovery", () => {
  it("recovers a declared directory from the packet leaves below it", () => {
    const { root, historical, poisonedStart, packet, packetRelative, statePath } =
      poisonedRecoveryRepository("loom-proof-directory-recovery-", "src/feature/a.ts", "src/feature");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", verification_manifest: legacyDefaultVerificationManifest(), phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, current_wave: 2, executing_tasks: [],
      wave_gates: {},
      tasks: [{
        id: "T5", description: "implementation", agent: "code-implementer-agent",
        wave: 2, status: "pending", proof: unresolvedProof(["src/feature"]), depends_on: [], new_tests_required: false,
        file_list: ["src/feature"], files_modified: ["latest-only.ts"],
        start_sha: poisonedStart,
        artifact_baseline: [{ artifact: "src/feature", snapshot: { kind: "missing" } }],
        issued_review_packets: [{
          task_id: "T5",
          packet_id: packet.value.packetId,
          packet_path: packetRelative,
          base_sha: historical,
          head_sha: poisonedStart,
          scope: ["src/feature"],
        }],
      }],
    }, null, 2));

    const recovered = spawnSync("bun", [
      CLI, "helper", "reconcile-implementation-proof", "--wave", "2",
      "--baseline-sha", historical,
      "--packet", `T5=${packetRelative}`,
    ], {
      cwd: root, encoding: "utf-8", env: { ...process.env, LOOM_STATE_PATH: statePath },
    });
    expect(recovered.status, recovered.stderr).toBe(0);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0]).toMatchObject({
      status: "pending", revalidation_required: true,
      proof: { state: "satisfied" },
      files_modified: ["latest-only.ts", "src/feature"],
      recovered_artifact_writes: [{ packet_id: packet.value.packetId, modified_paths: ["src/feature"] }],
    });
  });
});

describe("reconcileTaskFromStoredEvidence", () => {
  it("revokes stale new-test credit when the current cumulative diff contains no tests", () => {
    const reconciled = reconcileTaskFromStoredEvidence(
      failedTask(),
      ["src/a.ts"],
      NEW_TEST_EVIDENCE_NOT_WRITTEN,
      undefined,
      CONFORMANCE_NOT_OWED,
    );

    expect(reconciled.status).toBe("pending");
    expect(reconciled.proof?.state).toBe("failed");
    expect(reconciled.new_test_observation).toEqual({
      kind: "not-written",
      written: false,
      evidence: "",
    });
    if (reconciled.proof?.state === "failed") {
      expect(reconciled.proof.failures.map((failure) => failure.kind)).toEqual(["new-tests-not-observed"]);
    }
  });

  it("reopens an implemented task when deleted tests invalidate a previously satisfied proof", () => {
    const satisfiedProof = evaluateTaskProof(
      { declaredArtifactExpectation: "changed", newTestsRequired: true, declaredArtifacts: ["src/a.ts"] },
      observedEvidence({
        taskCompleted: true,
        testResult,
        filesModified: ["src/a.ts"],
        newTestsWritten: true,
        newTestEvidence: "1 new test method, 2 assertions",
      }),
      PI_STRUCTURED_EVIDENCE_POLICY,
    );
    if (satisfiedProof.state !== "satisfied") throw new Error("fixture must carry satisfied Proof");
    const withProof: Task = {
      ...failedTask(),
      status: "implemented",
      proof: satisfiedProof,
      revalidation_required: undefined,
    };

    const reconciled = reconcileTaskFromStoredEvidence(
      withProof,
      ["src/a.ts"],
      NEW_TEST_EVIDENCE_NOT_WRITTEN,
      undefined,
      CONFORMANCE_NOT_OWED,
    );

    expect(reconciled.status).toBe("pending");
    expect(reconciled.proof?.state).toBe("failed");
    expect(reconciled.new_test_observation?.written).toBe(false);
  });

  it("reconciles both asymmetric Verification Policy directions", () => {
    const baseTask = failedTask();
    const regressionWaived = reconcileTaskFromStoredEvidence(
      {
        ...baseTask,
        new_tests_required: undefined,
        test_result: undefined,
        verification_policy: {
          regression: { kind: "waived", reason: "documentation-only" },
          new_tests: { kind: "required" },
        },
      },
      ["src/a.ts"],
      parseNewTestEvidence(true, "1 new test method, 2 assertions"),
      undefined,
      CONFORMANCE_NOT_OWED,
    );
    const newTestsWaived = reconcileTaskFromStoredEvidence(
      {
        ...baseTask,
        new_tests_required: undefined,
        verification_policy: {
          regression: { kind: "required" },
          new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
        },
      },
      ["src/a.ts"],
      NEW_TEST_EVIDENCE_NOT_WRITTEN,
      undefined,
      CONFORMANCE_NOT_OWED,
    );

    expect(regressionWaived.status).toBe("pending");
    expect(regressionWaived.revalidation_required).toBe(true);
    expect(regressionWaived.proof?.state).toBe("satisfied");
    expect(regressionWaived.proof?.obligations).toEqual([
      { kind: "task-completed" },
      { kind: "new-tests" },
      { kind: "declared-artifact-changed", artifact: "src/a.ts" },
    ]);
    expect(newTestsWaived.status).toBe("pending");
    expect(newTestsWaived.revalidation_required).toBe(true);
    expect(newTestsWaived.proof?.state).toBe("satisfied");
    expect(newTestsWaived.proof?.obligations).toEqual([
      { kind: "task-completed" },
      { kind: "regression-test-pass" },
      { kind: "declared-artifact-changed", artifact: "src/a.ts" },
    ]);
  });

  it("never invents completion when the prior proof did not observe it", () => {
    const reconciled = reconcileTaskFromStoredEvidence(
      failedTask(false),
      ["src/a.ts"],
      parseNewTestEvidence(true, "1 new test method, 2 assertions"),
      undefined,
      CONFORMANCE_NOT_OWED,
    );

    expect(reconciled.status).toBe("pending");
    expect(reconciled.proof?.state).toBe("failed");
    if (reconciled.proof?.state === "failed") {
      expect(reconciled.proof.failures.map((failure) => failure.kind)).toEqual(["task-not-completed"]);
    }
  });
});
