import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureNativeReview } from "../../../fixtures/native-review-capture";
import { captureClaudeResult, claudeFinalPayloadCandidates } from "../../../../src/handlers/subagent-stop/capture-orchestration-result";
import type { AgentRequestAuthority } from "../../../../src/core/orchestration-contract";
import { captureKey } from "../../../../src/core/harness-capture";
import { STANDALONE_REVIEWER_ROLES } from "../../../../src/core/standalone-review";
import { graphFixture, taskFixture } from "../../../fixtures/task-lifecycle";
import { evaluateTaskProof } from "../../../../src/core/proof-obligations";
import { parseTaskGraph } from "../../../../src/state-manager";
import { handleWaveReviewContext } from "../../../../src/handlers/helpers/programs/wave-gate";
import { parseRegisteredFacadeProgram, parseRegistration } from "../../../../src/handlers/helpers/programs/helpers";
import { startStandaloneFacade, resumeStandaloneFacade, replayStandaloneResultFromEvidence } from "../../../../src/handlers/helpers/programs/standalone";
import { createRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { disposeFixturePiSessions, fixturePiEnvironment, withFixturePiSession as inDirectory } from "../../../fixtures/pi-session";

const packageRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const roots: string[] = [];
afterEach(() => { disposeFixturePiSessions(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const empty = JSON.stringify({ schemaVersion: 2, kind: "standalone-review", findings: [] });
type Action = Readonly<{ kind: string; requests?: readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[] }>;
function value<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loom-p4-native-")));
  roots.push(root);
  mkdirSync(join(root, "src")); mkdirSync(join(root, "runs"));
  writeFileSync(join(root, "src/a.ts"), "export const fixture = 1;\n");
  writeFileSync(join(root, "README.md"), "# Scripted fixture\n");
  for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"],
    ["add", "src/a.ts", "README.md"], ["commit", "-qm", "fixture baseline"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  writeFileSync(join(root, "src/a.ts"), "export const fixture = 2;\n");
  writeFileSync(join(root, "README.md"), "# Updated scripted fixture\n");
  return root;
}
function cli(root: string, args: readonly string[], input = "") {
  return spawnSync("bun", [join(packageRoot, "engine/src/cli.ts"), "helper", "orchestration", ...args], {
    cwd: root, encoding: "utf8", input,
    env: fixturePiEnvironment(root),
  });
}
async function start(root: string) {
  const handle = value(createRunDirectory(join(root, "runs"), "run.native"));
  const started = await inDirectory(root, () => startStandaloneFacade(handle,
    { kind: "all", files: ["README.md", "src/a.ts"], dryRun: false }));
  if (!started.ok) throw new Error(started.message);
  return { initial: started.action as Action, handle };
}
async function resume(root: string, handle: RunDirHandle): Promise<Action> {
  const registered = value(parseRegistration(value(handle.readProgramRegistration())));
  const resumed = await inDirectory(root, () => resumeStandaloneFacade(handle, registered));
  if (!resumed.ok) throw new Error(resumed.message);
  return resumed.action as Action;
}
function inspect(root: string, handle: RunDirHandle, json = false) {
  return cli(root, ["inspect", "--runs-root", handle.identity.runsRoot, "--run", handle.runId, ...(json ? ["--json"] : [])]);
}

describe("registered native reviewer protocol closure (scripted fixture payloads, not live reviews)", () => {
  it.each(["claude", "pi"] as const)("captures all seven %s roles exactly, retries invalid JSON, publishes and replays canonical inspection", async (harness) => {
    const root = fixture();
    const { initial, handle } = await start(root);
    const requests = initial.requests!;
    expect(requests.map(({ authority }) => authority.role)).toEqual(STANDALONE_REVIEWER_ROLES);
    for (const { authority, task } of requests) {
      const command = /^LOOM_CONTEXT_READ_COMMAND: (.+)$/m.exec(task)?.[1];
      expect(command, `${harness} delivery must be executable`).toBeDefined();
      const read = spawnSync("bash", ["-c", command ?? "exit 127"], { encoding: "utf8" });
      expect(read.status, read.stderr).toBe(0);
      expect(JSON.parse(read.stdout)).toMatchObject({ schemaVersion: 2, requestId: authority.requestId, role: authority.role });
    }
    for (const { authority } of requests.slice(1)) {
      const result = await captureNativeReview(root, handle, authority, harness, [empty]);
      expect(result.captured, result.diagnostic).toBe(true);
    }
    const first = requests[0]!.authority;
    expect((await captureNativeReview(root, handle, first, harness, ["{\"schemaVersion\":2,\"schemaVersion\":2}"])).captured).toBe(true);
    const retry = await resume(root, handle);
    expect(retry.requests).toHaveLength(1);
    expect(retry.requests![0]!.authority.attempt).toBe(2);
    expect((await captureNativeReview(root, handle, retry.requests![0]!.authority, harness, [empty])).captured).toBe(true);
    const done = await resume(root, handle);
    expect(done.kind).toBe("done");
    expect(await resume(root, handle)).toEqual(done);
    const bytes = readFileSync(join(handle.runDirectory, "result.json"));
    const result = JSON.parse(bytes.toString());
    expect(result.schema_version).toBe(2);
    expect(result.surviving_critical_findings).toEqual([]);
    expect(result.reviewer_evidence).toHaveLength(7);
    for (const { authority } of requests.slice(1)) {
      expect(Buffer.from(value(handle.readTranscriptBytes(authority))).toString()).toBe(empty);
    }
    const sibling = requests[1]!.authority;
    await captureNativeReview(root, handle, sibling, harness, ["conflicting duplicate"]);
    expect(Buffer.from(value(handle.readTranscriptBytes(sibling))).toString()).toBe(empty);
    const captured = value(handle.readCapturedAttempts());
    const witnesses = new Map(value(handle.readIssuedRequests()).flatMap((request) => {
      const key = captureKey(request.slotId, request.attempt);
      if (!captured.has(key)) return [];
      const raw = value(handle.readTranscriptBytes(request));
      return [[key, { requestId: request.requestId, role: request.role, contextDigest: request.contextDigest,
        digest: createHash("sha256").update(raw).digest("hex"), byteLength: raw.byteLength }] as const];
    }));
    unlinkSync(join(handle.runDirectory, "checkpoint.json"));
    const registration = value(parseRegistration(value(handle.readProgramRegistration())));
    const replay = replayStandaloneResultFromEvidence(handle, registration, witnesses);
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    if (replay.ok) expect(Buffer.from(replay.json)).toEqual(bytes);
  });

  it.each((["claude", "pi"] as const).flatMap((harness) => ["missing", "ambiguous", "missing-basis", "foreign-path", "duplicate-json"].map((failure) => ({ harness, failure }))))(
    "$harness $failure exhausts attempt two without synthetic product Findings or sibling loss", async ({ harness, failure }) => {
      const root = fixture(); const { initial, handle } = await start(root);
      for (const { authority } of initial.requests!.slice(1)) {
        expect((await captureNativeReview(root, handle, authority, harness, [empty])).captured).toBe(true);
      }
      const payloads = failure === "missing" ? [] : failure === "ambiguous" ? [empty, empty] : [failure === "duplicate-json"
        ? '{"schemaVersion":2,"kind":"standalone-review","findings":[],"findings":[]}'
        : JSON.stringify({ schemaVersion: 2, kind: "standalone-review", findings: [failure === "missing-basis"
          ? { severity: "critical", file: "src/a.ts", line: 1, claim: "Scripted invalid critical floor fixture" }
          : { severity: "advisory", file: "foreign.ts", line: 1, claim: "Scripted foreign location", reason: "Negative admission fixture" }] })];
      let request = initial.requests![0]!.authority;
      for (const attempt of [1, 2]) {
        const capture = await captureNativeReview(root, handle, request, harness, payloads);
        expect(capture.captured, capture.diagnostic).toBe(failure !== "missing" && failure !== "ambiguous");
        const next = await resume(root, handle);
        if (attempt === 1) {
          expect(next.requests).toHaveLength(1);
          request = next.requests![0]!.authority;
          expect(request.attempt).toBe(2);
        } else expect(next.kind).toBe("blocked");
      }
      expect((await resume(root, handle)).kind).toBe("blocked");
      const checkpoint = JSON.parse(readFileSync(join(handle.runDirectory, "checkpoint.json"), "utf8"));
      expect(checkpoint.kind).toBe("terminal-blocked");
      expect(checkpoint.failed.attempt).toBe(2);
      for (const { authority } of initial.requests!.slice(1)) expect(Buffer.from(value(handle.readTranscriptBytes(authority))).toString()).toBe(empty);
    });

  it.each(["read", "locator"])("current Claude %s infrastructure failure preserves attempt one and accepted siblings", async (fault) => {
    const root = fixture(); const { initial, handle } = await start(root);
    for (const { authority } of initial.requests!.slice(1)) await captureNativeReview(root, handle, authority, "pi", [empty]);
    const request = initial.requests![0]!.authority;
    const nativeId = `fixture-${request.requestId}`;
    value(await handle.recordHarnessCorrelator({ schemaVersion: 1, harness: "claude", nativeId,
      requestId: request.requestId, role: request.role, attempt: request.attempt }));
    const path = join(handle.runDirectory, "fixture-unavailable.jsonl");
    if (fault === "read") writeFileSync(path, JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: empty }] } }));
    const failed = await captureClaudeResult({ session_id: "fixture-native-review", agent_id: nativeId,
      agent_type: request.role, agent_transcript_path: path }, handle.identity.runsRoot, handle.runDirectory,
      fault === "read" ? () => claudeFinalPayloadCandidates(join(handle.runDirectory, "missing-after-location.jsonl")) : undefined);
    expect(failed.kind, JSON.stringify(failed)).toBe("retriable-failure");
    expect(value(handle.readCaptureRejection(request))).toBeNull();
    const reissued = await resume(root, handle);
    expect(reissued.requests).toHaveLength(1);
    expect(reissued.requests![0]!.authority).toEqual(request);
    for (const { authority } of initial.requests!.slice(1)) expect(Buffer.from(value(handle.readTranscriptBytes(authority))).toString()).toBe(empty);
    expect((await captureNativeReview(root, handle, request, "claude", [empty])).captured).toBe(true);
    expect((await resume(root, handle)).kind).toBe("done");
  });

  it.each(["human", "json", "tamper"])("actual inspection CLI %s uses canonical published authority", async (mode) => {
    const root = fixture(); const { initial, handle } = await start(root);
    for (const { authority } of initial.requests!) await captureNativeReview(root, handle, authority, "pi", [empty]);
    expect((await resume(root, handle)).kind).toBe("done");
    if (mode === "tamper") {
      const result = join(handle.runDirectory, "result.json");
      writeFileSync(result, readFileSync(result, "utf8") + " ");
    }
    const inspected = inspect(root, handle, mode === "json");
    if (mode === "human") expect(inspected.stdout).toContain("Emitted/admitted: 0 critical; 0 advisory.");
    if (mode === "json") expect(JSON.parse(inspected.stdout).state).toEqual({ kind: "observed", value: "done" });
    if (mode === "tamper") {
      expect(inspected.stdout).toContain("unavailable");
      expect(inspected.stdout).not.toContain("Emitted/admitted:");
    }
  });

  it("inspection refuses stripped registration authority rather than rendering forged done counts", async () => {
    const root = fixture(); const { handle } = await start(root);
    const path = join(handle.runDirectory, "program.json");
    const registration = JSON.parse(readFileSync(path, "utf8"));
    delete registration.reviewerProtocol;
    writeFileSync(path, JSON.stringify(registration));
    const inspected = JSON.parse(inspect(root, handle, true).stdout);
    expect(inspected.state.kind).toBe("unavailable");
    expect(inspect(root, handle).stdout).not.toContain("Emitted/admitted:");
  });
});

async function waveFixture() {
  const root = fixture();
  mkdirSync(join(root, ".claude/state"), { recursive: true });
  writeFileSync(join(root, "plan.md"), "# Model-free fixture plan\n");
  writeFileSync(join(root, "spec.md"), `# Feature: Native fixture

## User Scenarios

### US1: [P1] Review a Wave

**Acceptance Scenarios:**
- AS-001: Given fixture evidence, When admitted, Then the Wave progresses

## Functional Requirements

- FR-001: System MUST review exact fixture evidence

## Out of Scope

- OOS-001: Live reviews

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Fixture | Scripted test data |
`);
  const proof = evaluateTaskProof({ newTestsRequired: true, declaredArtifacts: ["src/a.ts"] },
    { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/a.ts"], newTestsWritten: true });
  if (proof.state !== "satisfied") throw new Error("fixture proof construction failed");
  const graph = value(parseTaskGraph({ ...graphFixture([taskFixture({ id: "T1", description: "scripted native fixture",
    agent: "code-implementer-agent", wave: 1, depends_on: [], status: "implemented", proof,
    file_list: ["src/a.ts"], files_modified: ["src/a.ts"], spec_anchors: ["FR-001", "AS-001"], spec_contributions: [],
    test_result: { verdict: "trusted-pass" }, test_evidence: "scripted fixture evidence", new_tests_written: true,
    new_test_evidence: "scripted fixture evidence", review_generation: 0, review_status: "pending", findings: [],
    critical_findings: [], advisory_findings: [] })]), spec_file: join(root, "spec.md"), plan_file: join(root, "plan.md"), spec_trace_version: 2 }));
  const statePath = join(root, ".claude/state/active_task_graph.json");
  writeFileSync(statePath, JSON.stringify(graph));
  const handle = value(createRunDirectory(join(root, "runs"), "run.native-wave"));
  const started = await inDirectory(root, async () => {
    // config owns an import-time State File path: reload inside this disposable
    // fixture rather than calling a driver bound to the test runner's cwd.
    vi.resetModules();
    const driver = await import("../../../../src/handlers/helpers/programs/wave-gate");
    return driver.startWaveGateFacade(handle, { wave: 1 });
  });
  if (!started.ok) throw new Error(started.message);
  return { root, statePath, handle, initial: started.action as Action };
}
async function resumeWave(root: string, handle: RunDirHandle): Promise<Action> {
  const registered = parseRegisteredFacadeProgram(value(handle.readProgramRegistration()));
  if (registered.kind !== "registered" || registered.program.kind !== "wave-gate") throw new Error("missing Wave registration");
  const registration = registered.program;
  const resumed = await inDirectory(root, async () => {
    const driver = await import("../../../../src/handlers/helpers/programs/wave-gate");
    return driver.resumeWaveGateFacade(handle, registration);
  });
  if (!resumed.ok) throw new Error(resumed.message);
  return resumed.action as Action;
}
function wavePayload(handle: RunDirHandle, request: AgentRequestAuthority): string {
  const packet = value(handle.readContext(request.contextDigest));
  const context = handleWaveReviewContext([packet], packet.digest);
  if (context.kind !== "loaded" || context.value.taskRun === null) throw new Error("missing issued Wave subject");
  return JSON.stringify({ schemaVersion: 2, kind: "wave-review", packetId: context.value.packetId,
    generation: context.value.taskRun.generation, prior_findings: [], findings: [] });
}

describe("current Wave native capture settles only through the registered facade", () => {
  it.each(["claude", "pi"] as const)("%s missing registered authority fails visibly without legacy Task mutation", async (harness) => {
    const { root, statePath, handle, initial } = await waveFixture();
    const request = initial.requests![1]!.authority;
    const raw = wavePayload(handle, request);
    const before = readFileSync(statePath);
    unlinkSync(join(handle.runDirectory, "program.json"));
    const capture = await captureNativeReview(root, handle, request, harness, [raw]);
    if (harness === "claude") {
      expect(capture.captured).toBe(false);
      expect(capture.diagnostic).toContain("registered Wave reviewer authority unavailable");
    }
    const resumed = cli(root, ["resume", "--runs-root", handle.identity.runsRoot, "--run", handle.runId]);
    expect(resumed.status).not.toBe(0);
    expect(resumed.stdout).not.toContain('"kind": "done"');
    expect(readFileSync(statePath)).toEqual(before);
  });

  it.each(["claude", "pi"] as const)("%s capture preserves protected state until resume and identical manual submission is inert", async (harness) => {
    const { root, statePath, handle, initial } = await waveFixture();
    expect(initial.requests).toHaveLength(6);
    const spec = initial.requests![0]!.authority;
    value(await handle.captureTranscript(spec, [...Buffer.from("SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED\n")]));
    const before = readFileSync(statePath);
    for (const { authority } of initial.requests!.slice(1)) {
      const raw = wavePayload(handle, authority);
      const captured = await captureNativeReview(root, handle, authority, harness, [raw]);
      expect(captured.captured, captured.diagnostic).toBe(true);
      expect(readFileSync(statePath)).toEqual(before);
      expect(Buffer.from(value(handle.readTranscriptBytes(authority))).toString()).toBe(raw);
    }
    const first = initial.requests![1]!.authority;
    const admitted = await inDirectory(root, async () => {
      const driver = await import("../../../../src/handlers/helpers/programs/wave-gate");
      return driver.applyWaveFacadeSubmission(handle, first, wavePayload(handle, first));
    });
    expect(admitted.ok, JSON.stringify(admitted)).toBe(true);
    const done = await resumeWave(root, handle);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    const completed = readFileSync(statePath);
    for (const { authority } of initial.requests!.slice(1)) {
      const raw = wavePayload(handle, authority);
      const manual = await inDirectory(root, async () => {
        const driver = await import("../../../../src/handlers/helpers/programs/wave-gate");
        return driver.applyWaveFacadeSubmission(handle, authority, raw);
      });
      expect(manual).toMatchObject({ ok: false, message: expect.stringContaining("exact current Review Packet slot") });
      await captureNativeReview(root, handle, authority, harness, [raw]);
      expect(readFileSync(statePath)).toEqual(completed);
    }
    expect(await resumeWave(root, handle)).toEqual(done);
  });

  it.each((["claude", "pi"] as const).flatMap((harness) => ["missing", "ambiguous"].map((failure) => ({ harness, failure }))))(
    "$harness $failure terminalizes only the second native attempt", async ({ harness, failure }) => {
      const { root, handle, initial } = await waveFixture();
      const spec = initial.requests![0]!.authority;
      value(await handle.captureTranscript(spec, [...Buffer.from("SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED\n")]));
      for (const { authority } of initial.requests!.slice(2)) await captureNativeReview(root, handle, authority, harness, [wavePayload(handle, authority)]);
      let request = initial.requests![1]!.authority;
      for (const attempt of [1, 2]) {
        expect((await captureNativeReview(root, handle, request, harness, failure === "missing" ? [] : ["one", "two"])).captured).toBe(false);
        const next = await resumeWave(root, handle);
        if (attempt === 1) {
          expect(next.requests).toHaveLength(1);
          request = next.requests![0]!.authority;
          expect(request.attempt).toBe(2);
        } else expect(next.kind).toBe("blocked");
      }
      expect((await resumeWave(root, handle)).kind).toBe("blocked");
      for (const { authority } of initial.requests!.slice(2)) expect(Buffer.from(value(handle.readTranscriptBytes(authority))).toString()).toBe(wavePayload(handle, authority));
    });
});
