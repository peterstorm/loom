/**
 * Program-path emission wiring (T6), end to end through real Run Directories
 * and real facade CLI starts: a non-Pi (Claude Code) parent's reviewers stay
 * extraction-only and the reason is logged, a Pi parent issues every reviewer
 * under its catalog profile on the one emission-qualified local route with the
 * tool-primary instruction (whatever model the parent itself runs), the Pi
 * issuance read behind the spawn admission port proves publication
 * independently of task markers, and the legacy publication route fails closed
 * against a current registration. These are shell integration tests (bun
 * subprocesses, process.env overlays); the pure decisions they wire are
 * issued-emission-capability.test.ts and spawn-task-emission.test.ts. An
 * unqualified issued Pi route (a retired cloud binding) is no longer reachable
 * through catalog issuance, so its extraction-only qualification is covered
 * only by the pure issued-emission-capability.test.ts.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";
import { git } from "../../../fixtures/git-repository";
import { facadeParentEnvironment, type FacadeParent } from "../../../fixtures/facade-parent";
import { graphFixture, taskFixture } from "../../../fixtures/task-lifecycle";
import { OTHER_CONTEXT_DIGEST, REVIEWER_V2 } from "../../../fixtures/issued-emission";
import { withEnvOverlay } from "../../../fixtures/env-overlay";
import { LOCAL_PI_BINDING } from "../../../fixtures/local-pi-binding";
import { value } from "../../../fixtures/parse-result";
import { catalogAuthority, mustAuthority, reviewerAuthority } from "../../../fixtures/reviewer-request";
import { EMISSION_DESCRIPTOR_MARKER, parseEmissionDescriptor } from "../../../../src/core/issued-emission-capability";
import {
  DESKTOP_VLLM_ROUTE,
  resolveAgentPolicy,
} from "../../../../src/core/model-profiles";
import type { AgentRequestAuthority } from "../../../../src/core/orchestration-contract";
import { parseRequestId } from "../../../../src/core/orchestration-contract/identity";
import { buildContextPacket, buildStandaloneReviewerContextPacketV3, encodeByteSection } from "../../../../src/core/context-packets";
import { CURRENT_REVIEWER_PROTOCOL } from "../../../../src/core/reviewer-contract";
import { STANDALONE_REVIEWER_PROTOCOL_V3 } from "../../../../src/core/standalone-lineage-contract";
import { evaluateTaskProof } from "../../../../src/core/proof-obligations";
import { type RegisteredWaveGateProgram } from "../../../../src/core/wave-gate-program";
import { publishLegacyInitialBatch, publishReviewInitialBatch } from "../../../../src/handlers/helpers/programs/request-publication";
import { renderReviewProgramSpawn, renderSpawnTask } from "../../../../src/handlers/helpers/programs/spawn-task";
import { parseRegisteredFacadeProgram, type RegisteredStandaloneProgram } from "../../../../src/handlers/helpers/programs/registration";
import { createRunDirectory, openRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { RUN_DIR_ENV, RUNS_ROOT_ENV } from "../../../../src/orchestration/harness-capture-runtime";
import { parseTaskGraph } from "../../../../src/state-manager";
import type { TaskGraph } from "../../../../src/types";

const successorSource = value(encodeByteSection(
  "standalone-frozen-source",
  JSON.stringify({ kind: "successor-v3-render-fixture" }),
));
const standaloneV3RegistrationWire = Object.freeze({
  schemaVersion: 3,
  reviewerProtocol: STANDALONE_REVIEWER_PROTOCOL_V3,
  kind: "standalone-review",
  input: Object.freeze({
    schemaVersion: 3,
    kind: "all",
    files: Object.freeze(["src/x.ts"]),
    dryRun: false,
    successor: Object.freeze({
      source: Object.freeze({ locator: "/owned/source", runId: "source", resultDigest: "a".repeat(64) }),
      disposition: Object.freeze({ kind: "historical-decision-unavailable" as const }),
    }),
  }),
  authority: Object.freeze({}),
  currentSource: Object.freeze({
    label: successorSource.label,
    bytes: Object.freeze([...successorSource.bytes]),
    digest: successorSource.digest,
    byteLength: successorSource.byteLength,
  }),
  previousContexts: Object.freeze([]),
});
const standaloneV3Registration: RegisteredStandaloneProgram = (() => {
  const parsed = parseRegisteredFacadeProgram(standaloneV3RegistrationWire);
  if (parsed.kind !== "registered" || parsed.program.kind !== "standalone-review" || parsed.program.schemaVersion !== 3) {
    throw new Error("fixture standalone-review v3 registration unavailable");
  }
  return parsed.program;
})();

// ---------------------------------------------------------------------------
// Real facade CLI starts exercise both a Claude Code parent (extraction-only)
// and a Pi parent issuing the tool-primary reviewer route.
// ---------------------------------------------------------------------------

const waveCliRoots: string[] = [];
afterEach(() => { for (const root of waveCliRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const waveCli = fileURLToPath(new URL("../../../../src/cli.ts", import.meta.url));

const waveSpecText = `# Feature: Wave fixture

## User Scenarios

### US1: [P1] Review a Wave

**Acceptance Scenarios:**
- AS-001: Given evidence, When accepted, Then the Wave progresses

## Functional Requirements

- FR-001: System MUST review the exact Wave

## Out of Scope

- OOS-001: Unrelated work

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Wave evidence | Exact issued evidence |
`;

function waveEmissionProject(): { root: string; runsRoot: string } {
  const root = canonicalTempDir("loom-t6-wave-wiring-");
  waveCliRoots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "runs"));
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "spec.md"), waveSpecText);
  writeFileSync(join(root, "plan.md"), "# Model-free plan\n");
  git(root, ["init", "-q"]);
  git(root, ["add", "src/x.ts", "spec.md", "plan.md"]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]);
  const proof = evaluateTaskProof(
    { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
    { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
  );
  if (proof.state !== "satisfied") throw new Error("fixture requires actual satisfied proof construction");
  const graph: TaskGraph = {
    ...graphFixture([taskFixture({
      id: "T1", description: "review fixture", agent: "code-implementer-agent", wave: 1,
      depends_on: [], status: "implemented", proof, file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
      spec_anchors: ["FR-001", "AS-001"], spec_contributions: [], test_result: { verdict: "trusted-pass" },
      test_evidence: "fixture checks passed", new_tests_written: true, new_test_evidence: "fixture tests present",
      review_generation: 0, review_status: "pending", findings: [],
      critical_findings: [], advisory_findings: [],
    })]),
    spec_file: join(root, "spec.md"), plan_file: join(root, "plan.md"), spec_trace_version: 2,
  };
  const parsedGraph = parseTaskGraph(graph);
  if (!parsedGraph.ok) throw new Error(`fixture task graph refused: ${parsedGraph.error}`);
  writeFileSync(join(root, ".claude", "state", "active_task_graph.json"), JSON.stringify(parsedGraph.value));
  return { root, runsRoot: join(root, "runs") };
}

function standaloneEmissionProject(): { root: string; runsRoot: string } {
  const root = canonicalTempDir("loom-t6-standalone-wiring-");
  waveCliRoots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "runs"));
  writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
  git(root, ["init", "-q"]);
  git(root, ["add", "src/x.ts"]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]);
  return { root, runsRoot: join(root, "runs") };
}

/** A Pi parent running a cloud model itself: issuance must not read it — every
 *  reviewer still lands on the catalog's local emission route. */
const CLOUD_PI_PARENT_MODEL_ENV = Object.freeze({
  PI_PROVIDER: "openai-codex",
  PI_MODEL: "gpt-5.6-sol",
  PI_REASONING_LEVEL: "high",
});

/** In-process renders read the Pi parent flag from this process: pin it to the
 *  non-Pi parent the extraction arm runs under, whatever the ambient worker. */
const withoutPiParent = <T>(operation: () => T | Promise<T>): Promise<T> =>
  withEnvOverlay({ PI_CODING_AGENT: undefined }, operation);

const startFacadeProgram = (
  project: Readonly<{ root: string; runsRoot: string }>,
  program: "wave-gate" | "standalone-review",
  runId: string,
  input: unknown,
  parent: FacadeParent = "pi",
  environment: Readonly<Record<string, string>> = {},
): Promise<Readonly<{ status: number | null; stdout: string; stderr: string }>> =>
  new Promise((resolve, reject) => {
    const child = spawn("bun", [waveCli, "helper", "orchestration", "start", program,
      "--runs-root", project.runsRoot, "--run", runId],
      { cwd: project.root, env: { ...facadeParentEnvironment(parent, project.root), ...environment } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });

/** The facade's `spawn-batch` action, asserted at the one place every CLI
 *  test reads it: the run exited 0 and printed a spawn batch, whose issued
 *  requests are returned. */
const spawnBatchRequests = (
  started: Readonly<{ status: number | null; stdout: string; stderr: string }>,
): readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[] => {
  expect(started.status, started.stderr).toBe(0);
  const action = JSON.parse(started.stdout) as {
    kind: string;
    requests?: readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[];
  };
  expect(action.kind).toBe("spawn-batch");
  return action.requests ?? [];
};

describe("the wave-gate program path projects the frozen issued route (T6)", () => {
  it("keeps a Claude Code parent's reviewers extraction-only, logs the retained reason without changing the base instruction, and renders supplied registration byte-identically to durable fallback", async () => {
    const project = waveEmissionProject();
    const started = await startFacadeProgram(project, "wave-gate", "run.wiring", { wave: 1 }, "claude-code");
    const requests = spawnBatchRequests(started);
    expect(requests.length).toBeGreaterThan(1);
    const specCheck = requests.find(({ authority }) => authority.role === "spec-check-invoker");
    expect(specCheck).toBeDefined();
    // FR-001: the non-producer spec-check request advertises no emission tool.
    expect(specCheck!.task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    const reviewers = requests.filter(({ authority }) => authority.role !== "spec-check-invoker");
    expect(reviewers.length).toBeGreaterThan(0);
    // The frozen binding is the local emission route; only the parent decides.
    for (const { authority } of reviewers) expect(authority.harnessBinding.pi).toMatchObject(DESKTOP_VLLM_ROUTE);
    expect(started.stderr).toContain('"event":"loom-emission-route"');
    expect(started.stderr).toContain('"kind":"extraction-only"');
    expect(started.stderr).toContain("the parent harness is not Pi");
    for (const { task } of reviewers) {
      expect(task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
      expect(task).not.toContain("calling the exact tool loom_emit_reviewer_payload");
      expect(task).toContain("Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.");
      // The delivery joins are retained regardless of emission-tool availability (FR-012).
      expect(task).toContain("LOOM_CONTEXT_READ_COMMAND: ");
      expect(task).toContain("Read the issued Context Packet FIRST; its frozen schema and rubric govern your final output.");
    }

    // The explicit program-path supply renders byte-identically to the
    // durable fallback: the join admits a structurally equal REBUILT
    // registration (not merely the same object) and the claim it sources is
    // the one the durable read produces.
    const opened = openRunDirectory(project.runsRoot, "run.wiring");
    if (!opened.ok) throw new Error(opened.error.message);
    const stored = opened.value.readProgramRegistration();
    if (!stored.ok) throw new Error(stored.error.message);
    const parsed = parseRegisteredFacadeProgram(stored.value);
    if (parsed.kind !== "registered" || parsed.program.kind !== "wave-gate") {
      throw new Error("fixture wave-gate registration unavailable");
    }
    const reviewer = reviewers[0]!;
    const waveAuthority = mustAuthority(reviewer.authority);
    const suppliedRegistration: RegisteredWaveGateProgram = Object.freeze({
      schemaVersion: 2,
      reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
      kind: "wave-gate",
      input: Object.freeze({ wave: parsed.program.input.wave }),
      taskIds: parsed.program.taskIds,
      authorityDigest: parsed.program.authorityDigest,
    });
    const instruction = "Read the immutable context packet at LOOM_CONTEXT_PATH and complete the exact Wave review request.";
    const [supplied, fallback] = await withoutPiParent(() => [
      renderReviewProgramSpawn(opened.value, waveAuthority, instruction, suppliedRegistration).task,
      renderSpawnTask(opened.value, waveAuthority, instruction),
    ] as const);
    expect(supplied).toBe(fallback);
    expect(supplied).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    expect(supplied).not.toContain("calling the exact tool loom_emit_reviewer_payload");
  }, 60_000);
});

describe("positive program-path issuance through a Pi parent (T6)", () => {
  it("issues every Wave reviewer under its catalog profile on the local route with a v2 descriptor and tool-primary instruction, whatever model the Pi parent runs", async () => {
    const project = waveEmissionProject();
    const started = await startFacadeProgram(project, "wave-gate", "run.local-wave", { wave: 1 }, "pi", CLOUD_PI_PARENT_MODEL_ENV);
    const requests = spawnBatchRequests(started);
    expect(requests).toHaveLength(6);
    const specCheck = requests.find(({ authority }) => authority.role === "spec-check-invoker");
    expect(specCheck?.authority.modelProfile).toBe("spec-check-review");
    expect(specCheck?.task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    const { readPiIssuedSpawnRequest } = await import("../../../../../pi/review-run-authority");
    await withEnvOverlay({ [RUNS_ROOT_ENV]: project.runsRoot, [RUN_DIR_ENV]: join(project.runsRoot, "run.local-wave") }, () => {
      for (const { authority, task } of requests.filter(({ authority }) => authority.role !== "spec-check-invoker")) {
        expect(authority.modelProfile).toBe(value(resolveAgentPolicy(authority.role)).profile);
        expect(authority.harnessBinding.pi).toMatchObject(LOCAL_PI_BINDING);
        const descriptor = parseEmissionDescriptor(task);
        expect(descriptor.kind).toBe("issued");
        if (descriptor.kind !== "issued") continue;
        expect(descriptor.contextDigest).toBe(authority.contextDigest);
        expect(descriptor.binding.requestId).toBe(authority.requestId);
        expect(task).toContain("calling the exact tool loom_emit_reviewer_payload exactly once");
        expect(readPiIssuedSpawnRequest("019fca39-f989-7510-8e62-50dadbcad4ff", authority.requestId, authority.contextDigest, authority.role))
          .toMatchObject({ ok: true, value: { route: { kind: "emission" } } });
      }
    });
  }, 60_000);

  it("issues standalone v2 reviewers under their catalog profiles with the exact tool descriptor under a Pi parent", async () => {
    const project = standaloneEmissionProject();
    const started = await startFacadeProgram(project, "standalone-review", "run.local-standalone",
      { kind: "all", files: ["src/x.ts"], dryRun: false }, "pi", CLOUD_PI_PARENT_MODEL_ENV);
    const requests = spawnBatchRequests(started);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.find(({ authority }) => authority.role === "code-reviewer")?.authority.modelProfile).toBe("general-review");
    for (const { authority, task } of requests) {
      expect(authority.modelProfile).toBe(value(resolveAgentPolicy(authority.role)).profile);
      expect(authority.harnessBinding.pi).toMatchObject(LOCAL_PI_BINDING);
      expect(parseEmissionDescriptor(task)).toMatchObject({
        kind: "issued", contextDigest: authority.contextDigest,
        binding: { requestId: authority.requestId, version: "v2" },
      });
      expect(task).toContain("calling the exact tool loom_emit_reviewer_payload exactly once");
    }
  }, 60_000);
});

describe("the Pi issuance read behind the spawn admission port (T6)", () => {
  it("proves the reserved publication and program protocol independently of task markers", async () => {
    const project = waveEmissionProject();
    const started = await startFacadeProgram(project, "wave-gate", "run.issued-port", { wave: 1 });
    const reviewer = spawnBatchRequests(started).find(({ authority }) => authority.role === "code-reviewer");
    if (reviewer === undefined) throw new Error("fixture did not publish a reviewer request");
    const authority = mustAuthority(reviewer.authority);
    const { readPiIssuedSpawnRequest } = await import("../../../../../pi/review-run-authority");
    await withEnvOverlay({ [RUNS_ROOT_ENV]: project.runsRoot, [RUN_DIR_ENV]: join(project.runsRoot, "run.issued-port") }, () => {
      const issued = readPiIssuedSpawnRequest("019fca39-f989-7510-8e62-50dadbcad4ff", authority.requestId, authority.contextDigest, authority.role);
      expect(issued).toMatchObject({ ok: true, value: {
        role: "code-reviewer",
        claim: {
          requestId: authority.requestId, contextDigest: authority.contextDigest,
          producerKind: "reviewer-payload", version: "v2",
          schemaDigest: CURRENT_REVIEWER_PROTOCOL.schemaDigest,
        },
      } });
      expect(readPiIssuedSpawnRequest("019fca39-f989-7510-8e62-50dadbcad4ff", REVIEWER_V2.requestId, authority.contextDigest, authority.role).ok).toBe(false);
      expect(readPiIssuedSpawnRequest("019fca39-f989-7510-8e62-50dadbcad4ff", authority.requestId, OTHER_CONTEXT_DIGEST, authority.role).ok).toBe(false);
      expect(readPiIssuedSpawnRequest("019fca39-f989-7510-8e62-50dadbcad4ff", authority.requestId, authority.contextDigest, "pr-test-analyzer").ok).toBe(false);
    });
  }, 60_000);
});

describe("the standalone successor v3 program path projects the issued route (T6)", () => {
  it("keeps a published successor v3 reviewer extraction-only without a Pi parent and renders supplied registration byte-identically to durable fallback", async () => {
    const project = standaloneEmissionProject();
    const created = createRunDirectory(project.runsRoot, "run.wiring");
    if (!created.ok) throw new Error(created.error.message);
    const handle = created.value;
    const registered = await handle.registerProgram(standaloneV3RegistrationWire);
    if (!registered.ok) throw new Error(registered.error.message);

    const requestId = value(parseRequestId("request:standalone-successor-v3-wiring-1"));
    const packet = value(buildStandaloneReviewerContextPacketV3({
      requestId,
      role: "code-reviewer",
      requiredSkill: "none",
      fixedContext: Object.freeze([]),
      variableContext: Object.freeze([]),
    }));
    const authority = reviewerAuthority("standalone-review", requestId, packet.digest);
    const request = Object.freeze({
      authority,
      context: Object.freeze({
        digest: packet.digest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.digest}.json` }),
      }),
    });
    const published = await publishReviewInitialBatch(
      handle,
      Object.freeze([request]),
      Object.freeze([packet]),
      "standalone-successor-v3",
      standaloneV3Registration,
    );
    if (!published.ok) throw new Error(published.message);

    const instruction = "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.";
    const [supplied, fallback] = await withoutPiParent(() => [
      renderReviewProgramSpawn(handle, authority, instruction, standaloneV3Registration, { standalone: true }).task,
      renderSpawnTask(handle, authority, instruction, { standalone: true }),
    ] as const);

    expect(supplied).toBe(fallback);
    expect(supplied).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    expect(supplied).not.toContain("calling the exact tool loom_emit_reviewer_payload");
  });

  it("renders a published successor v3 reviewer descriptor from its issued catalog binding under a Pi parent", async () => {
    const project = standaloneEmissionProject();
    const created = createRunDirectory(project.runsRoot, "run.wiring");
    if (!created.ok) throw new Error(created.error.message);
    const handle = created.value;
    const registered = await handle.registerProgram(standaloneV3RegistrationWire);
    if (!registered.ok) throw new Error(registered.error.message);
    const requestId = value(parseRequestId("request:standalone-successor-v3-qualified"));
    const packet = value(buildStandaloneReviewerContextPacketV3({
      requestId, role: "code-reviewer", requiredSkill: "none",
      fixedContext: Object.freeze([]), variableContext: Object.freeze([]),
    }));
    const authority = reviewerAuthority("standalone-review", requestId, packet.digest);
    expect(authority.modelProfile).toBe("general-review");
    expect(authority.harnessBinding.pi).toMatchObject(LOCAL_PI_BINDING);
    await withEnvOverlay({ PI_CODING_AGENT: "true" }, async () => {
      const published = await publishReviewInitialBatch(handle, [{ authority, context: {
        digest: packet.digest, slot: { kind: "fixed-artifact-slot", path: `contexts/${packet.digest}.json` },
      } }], [packet], "standalone-successor-v3", standaloneV3Registration);
      if (!published.ok) throw new Error(published.message);
      const task = (published.action as { requests: readonly { task: string }[] }).requests[0]!.task;
      expect(parseEmissionDescriptor(task)).toMatchObject({
        kind: "issued", contextDigest: packet.digest,
        binding: { requestId, version: "v3", toolName: "loom_emit_reviewer_payload" },
      });
      expect(task).toContain("calling the exact tool loom_emit_reviewer_payload exactly once");
      const rendered = renderReviewProgramSpawn(handle, authority,
        "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.",
        standaloneV3Registration, { standalone: true });
      expect(rendered.task).toBe(task);
      // The render hands over the route it rendered from, as data: the retry
      // closes on this value, never on a re-parse of the descriptor above.
      expect(rendered.route).toMatchObject({
        kind: "emission", contextDigest: packet.digest,
        binding: { requestId, version: "v3", toolName: "loom_emit_reviewer_payload" },
      });
    });
  });
});

describe("the standalone-review v2 program path projects the issued route (T6)", () => {
  it("keeps a Claude Code parent's production requests extraction-only and renders supplied registration byte-identically to durable fallback", async () => {
    const project = standaloneEmissionProject();
    const started = await startFacadeProgram(project, "standalone-review", "run.standalone-wiring",
      { kind: "all", files: ["src/x.ts"], dryRun: false }, "claude-code");
    const requests = spawnBatchRequests(started);
    expect(requests.length).toBeGreaterThan(0);
    expect(started.stderr).toContain('"kind":"extraction-only"');
    expect(started.stderr).toContain("the parent harness is not Pi");
    for (const { task } of requests) {
      expect(task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
      expect(task).not.toContain("calling the exact tool loom_emit_reviewer_payload");
    }

    const opened = openRunDirectory(project.runsRoot, "run.standalone-wiring");
    if (!opened.ok) throw new Error(opened.error.message);
    const stored = opened.value.readProgramRegistration();
    if (!stored.ok) throw new Error(stored.error.message);
    const parsed = parseRegisteredFacadeProgram(stored.value);
    if (parsed.kind !== "registered" || parsed.program.kind !== "standalone-review" || parsed.program.schemaVersion !== 2) {
      throw new Error("fixture standalone-review v2 registration unavailable");
    }
    const registration = parsed.program;
    const reviewer = requests[0]!;
    const authority = mustAuthority(reviewer.authority);
    const instruction = "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.";
    const [supplied, fallback] = await withoutPiParent(() => [
      renderReviewProgramSpawn(opened.value, authority, instruction, registration, { standalone: true }).task,
      renderSpawnTask(opened.value, authority, instruction, { standalone: true }),
    ] as const);
    expect(supplied).toBe(fallback);
    expect(supplied).toBe(reviewer.task);
    expect(supplied).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    expect(supplied).not.toContain("calling the exact tool loom_emit_reviewer_payload");
  }, 60_000);
});

describe("the legacy publication route fails closed against a current registration (T6)", () => {
  /** The guard run's own id: the run the facade starts and both legacy-route
   *  requests (the eligible code-reviewer standalone request and the
   *  non-eligible review-verifier refutation-panel request) are issued under. */
  const LEGACY_GUARD_RUN = "run.legacy-guard";

  const runDirectoryFingerprint = (handle: RunDirHandle): readonly string[] =>
    readdirSync(handle.runDirectory, { recursive: true }).map((entry) => String(entry)).sort();

  /** A durable CURRENT standalone-review v2 registration, exactly as the real
   *  facade start freezes it; the eligible-refusal arm reads this registration. */
  const currentProgramRun = async (): Promise<RunDirHandle> => {
    const project = standaloneEmissionProject();
    const started = await startFacadeProgram(project, "standalone-review", LEGACY_GUARD_RUN,
      { kind: "all", files: ["src/x.ts"], dryRun: false });
    expect(started.status, started.stderr).toBe(0);
    const opened = openRunDirectory(project.runsRoot, LEGACY_GUARD_RUN);
    if (!opened.ok) throw new Error(opened.error.message);
    const stored = opened.value.readProgramRegistration();
    if (!stored.ok) throw new Error(stored.error.message);
    const parsed = parseRegisteredFacadeProgram(stored.value);
    if (parsed.kind !== "registered" || parsed.program.kind !== "standalone-review" || parsed.program.schemaVersion !== 2) {
      throw new Error("fixture standalone-review v2 registration unavailable");
    }
    return opened.value;
  };

  it("refuses an emission-eligible reviewer request without writing any receipt or context", async () => {
    const handle = await currentProgramRun();
    const requestId = value(parseRequestId("request:legacy-route-eligible-1"));
    const packet = value(buildStandaloneReviewerContextPacketV3({
      requestId, role: "code-reviewer", requiredSkill: "none",
      fixedContext: Object.freeze([]), variableContext: Object.freeze([]),
    }));
    const authority = reviewerAuthority("standalone-review", requestId, packet.digest, LEGACY_GUARD_RUN);
    const before = runDirectoryFingerprint(handle);
    const refused = await publishLegacyInitialBatch(
      handle,
      Object.freeze([{ authority, context: Object.freeze({
        digest: packet.digest, slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.digest}.json` }),
      }) }]),
      Object.freeze([packet]),
      "standalone-review",
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("legacy route published an emission-eligible request");
    expect(refused.message).toContain("legacy publication route refused an emission-eligible request");
    expect(refused.message).toContain("schemaVersion 2");
    expect(runDirectoryFingerprint(handle)).toEqual(before);
  }, 60_000);

  it("still publishes a non-eligible review-verifier-agent refutation panel request on the legacy route", async () => {
    const handle = await currentProgramRun();
    const requestId = value(parseRequestId("request:legacy-route-panel-1"));
    const note = value(encodeByteSection("fixture-note", "panel retry context"));
    const packet = value(buildContextPacket({
      requestId, role: "review-verifier-agent", requiredSkill: "none",
      outputContract: "refutation-verdict",
      fixedContext: Object.freeze([note]), variableContext: Object.freeze([]),
    }));
    const authority = catalogAuthority({
      role: "review-verifier-agent", program: "refutation-panel", requestId, contextDigest: packet.digest, runId: LEGACY_GUARD_RUN,
    });
    const published = await publishLegacyInitialBatch(
      handle,
      Object.freeze([{ authority, context: Object.freeze({
        digest: packet.digest, slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.digest}.json` }),
      }) }]),
      Object.freeze([packet]),
      "standalone-review",
    );
    if (!published.ok) throw new Error(published.message);
    const task = (published.action as { requests: readonly { task: string }[] }).requests[0]!.task;
    expect(task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    expect(task).not.toContain("calling the exact tool loom_emit_reviewer_payload");
  }, 60_000);
});
