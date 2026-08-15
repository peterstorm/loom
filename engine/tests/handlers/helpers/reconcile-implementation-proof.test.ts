import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
} from "../../../src/handlers/helpers/reconcile-implementation-proof";
import type { Task } from "../../../src/types";

const ENGINE = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(ENGINE, "src", "cli.ts");
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const testResult = {
  verdict: "untrusted" as const,
  passed: true,
  label: "pi-structured: bun: 25 pass",
};

function failedTask(taskCompleted = true): Task {
  const proof = evaluateTaskProof(
    { newTestsRequired: true, declaredArtifacts: ["src/a.ts"] },
    {
      taskCompleted,
      testResult,
      filesModified: [],
      newTestsWritten: false,
      newTestEvidence: "",
    },
    PI_STRUCTURED_EVIDENCE_POLICY,
  );
  return {
    id: "T5",
    description: "implementation",
    agent: "code-implementer-agent",
    wave: 2,
    status: "pending",
    depends_on: [],
    file_list: ["src/a.ts"],
    files_modified: ["src/a.ts"],
    new_tests_required: true,
    new_tests_written: true,
    new_test_evidence: "1 new test method, 2 assertions",
    test_result: testResult,
    test_evidence: "bun: 25 pass",
    proof,
  };
}

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

describe("historical baseline recovery CLI", () => {
  it("atomically replaces poisoned boundaries with an audited ancestor commit", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-proof-recovery-"));
    cleanup.push(root);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "loom@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Loom Test"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "before wave 2"], { cwd: root });
    const historical = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
    mkdirSync(join(root, "src"));
    const implemented = "export const implemented = true;\n";
    writeFileSync(join(root, "src", "a.ts"), implemented);
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "wave 2 implementation"], { cwd: root });
    const poisonedStart = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
    const proof = evaluateTaskProof(
      { newTestsRequired: false, declaredArtifacts: ["src/a.ts"] },
      { taskCompleted: true, filesModified: [] },
    );
    const packet = createReviewPacket({
      task: { id: "T5", description: "implementation" },
      baseSha: base(historical),
      headSha: head(poisonedStart),
      declaredPaths: ["src/a.ts"],
      modifiedPaths: ["src/a.ts"],
      artifacts: [{ path: "src/a.ts", diff: "+implemented\n", postimage: Buffer.from(implemented) }],
      planContext: "",
      proofObligations: [],
    });
    if (!packet.ok) throw new Error(packet.errors.join("; "));
    const packetRelative = ".claude/reviews/T5.json";
    mkdirSync(join(root, ".claude", "reviews"), { recursive: true });
    writeFileSync(join(root, packetRelative), serializeReviewPacket(packet.value));
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    mkdirSync(join(root, ".claude", "state"), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
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
        wave: 2, status: "pending", depends_on: [], new_tests_required: false,
        review_status: "evidence_capture_failed",
        review_error: "review transcript missing evidence",
        review_evidence_failures: ["code-reviewer"],
        file_list: ["src/a.ts"], files_modified: ["latest-only.ts"], proof,
        start_sha: poisonedStart,
        artifact_baseline: [{
          artifact: "src/a.ts",
          snapshot: {
            kind: "sha256",
            digest: createHash("sha256").update(implemented).digest("hex"),
          },
        }],
      }],
    }, null, 2));

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
    const recovered = spawnSync("bun", [
      CLI, "helper", "reconcile-implementation-proof", "--wave", "2",
      "--baseline-sha", historical,
      "--packet", `T5=${packetRelative}`,
    ], {
      cwd: root, encoding: "utf-8", env: { ...process.env, LOOM_STATE_PATH: statePath },
    });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe(laterBytes);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0]).toMatchObject({
      status: "implemented",
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
    expect(state.wave_gates["2"]).toMatchObject({
      impl_complete: true, tests_passed: null, reviews_complete: false,
    });
  });
});

describe("reconcileTaskFromStoredEvidence", () => {
  it("revokes stale new-test credit when the current cumulative diff contains no tests", () => {
    const reconciled = reconcileTaskFromStoredEvidence(
      failedTask(),
      ["src/a.ts"],
      { written: false, evidence: "" },
    );

    expect(reconciled.status).toBe("pending");
    expect(reconciled.proof?.state).toBe("failed");
    expect(reconciled.new_tests_written).toBe(false);
    expect(reconciled.new_test_evidence).toBe("");
    if (reconciled.proof?.state === "failed") {
      expect(reconciled.proof.failures.map((failure) => failure.kind)).toEqual(["new-tests-not-observed"]);
    }
  });

  it("reopens an implemented task when deleted tests invalidate a previously satisfied proof", () => {
    const withProof = {
      ...failedTask(),
      status: "implemented" as const,
      proof: evaluateTaskProof(
        { newTestsRequired: true, declaredArtifacts: ["src/a.ts"] },
        {
          taskCompleted: true,
          testResult,
          filesModified: ["src/a.ts"],
          newTestsWritten: true,
          newTestEvidence: "1 new test method, 2 assertions",
        },
        PI_STRUCTURED_EVIDENCE_POLICY,
      ),
    };
    expect(withProof.proof.state).toBe("satisfied");

    const reconciled = reconcileTaskFromStoredEvidence(
      withProof,
      ["src/a.ts"],
      { written: false, evidence: "" },
    );

    expect(reconciled.status).toBe("pending");
    expect(reconciled.proof?.state).toBe("failed");
    expect(reconciled.new_tests_written).toBe(false);
  });

  it("never invents completion when the prior proof did not observe it", () => {
    const reconciled = reconcileTaskFromStoredEvidence(
      failedTask(false),
      ["src/a.ts"],
      { written: true, evidence: "1 new test method, 2 assertions" },
    );

    expect(reconciled.status).toBe("pending");
    expect(reconciled.proof?.state).toBe("failed");
    if (reconciled.proof?.state === "failed") {
      expect(reconciled.proof.failures.map((failure) => failure.kind)).toEqual(["task-not-completed"]);
    }
  });
});
