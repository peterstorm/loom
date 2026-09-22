import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { attributeFindings } from "../../../../src/core/findings";
import { evaluateTaskProof } from "../../../../src/core/proof-obligations";
import { WAVE_REVIEW_AGENTS } from "../../../../src/core/model-profiles";
import type { AgentRequestAuthority } from "../../../../src/core/orchestration-contract";
import { CURRENT_REVIEWER_PROTOCOL, REVIEWER_PAYLOAD_EXAMPLE_V2, REVIEWER_PAYLOAD_SCHEMA_V2, REVIEWER_IMPACT_RUBRIC_V1, type ReviewerDraftV2 } from "../../../../src/core/reviewer-contract";
import { parseRegisteredFacadeProgram, publishInitialBatch, reviewerProtocolResolver } from "../../../../src/handlers/helpers/programs/helpers";
import { handleWaveReviewContext, installWaveReviewRuns, waveGateAuthorityDigest, waveRequests, deriveWaveAttemptTwo, persistedWaveAttemptTwoCompatibilityProblem, currentWaveTaskReviewRetries, markWaveTaskReviewRetriesIssued } from "../../../../src/handlers/helpers/programs/wave-gate";
import { createRunDirectory, openRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { captureHarnessResult } from "../../../../src/orchestration/harness-capture-runtime";
import { parseTaskGraph, StateManager } from "../../../../src/state-manager";
import { disposeFixturePiSessions, fixturePiEnvironment, withFixturePiSession } from "../../../fixtures/pi-session";
import type { Finding, TaskGraph } from "../../../../src/types";
import { graphFixture, taskFixture } from "../../../fixtures/task-lifecycle";

const packageRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../../../src/cli.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => { disposeFixturePiSessions(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function value<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
function git(root: string, args: readonly string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}
const critical = REVIEWER_PAYLOAD_EXAMPLE_V2.findings.find((finding) => finding.severity === "critical")!;
const criticalDraft: ReviewerDraftV2 = { ...critical, file: "src/x.ts", line: 1, claim: "  exact current claim\nwith detail  " };
const advisory: ReviewerDraftV2 = { severity: "advisory", file: "src/x.ts", line: 1, claim: " optional cleanup ", reason: " clearer operator explanation " };
const mixedPriors = (): readonly Finding[] => [
  ...attributeFindings([{ severity: "critical", file: "src/x.ts", line: 1, claim: "historical defect" }], "old-reviewer"),
  ...attributeFindings([{ ...criticalDraft, protocolVersion: 2 }], "earlier-current"),
];
const specText = `# Feature: Wave fixture

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
const specPass = "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED\n";

function project(priors: readonly Finding[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loom-p4-wave-")));
  roots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "runs"));
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "spec.md"), specText);
  writeFileSync(join(root, "plan.md"), "# Model-free plan\n");
  git(root, ["init", "-q"]);
  git(root, ["add", "src/x.ts", "spec.md", "plan.md"]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]);
  const proof = evaluateTaskProof({ newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
    { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true });
  if (proof.state !== "satisfied") throw new Error("fixture requires actual satisfied proof construction");
  const graph: TaskGraph = { ...graphFixture([taskFixture({ id: "T1", description: "review fixture", agent: "code-implementer-agent", wave: 1,
    depends_on: [], status: "implemented", proof, file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
    spec_anchors: ["FR-001", "AS-001"], spec_contributions: [], test_result: { verdict: "trusted-pass" },
    test_evidence: "fixture checks passed", new_tests_written: true, new_test_evidence: "fixture tests present",
    review_generation: 0, review_status: "pending", findings: [...priors],
    critical_findings: priors.filter(({ severity }) => severity === "critical").map(({ claim }) => claim), advisory_findings: [],
  })]), spec_file: join(root, "spec.md"), plan_file: join(root, "plan.md"), spec_trace_version: 2 };
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  writeFileSync(statePath, JSON.stringify(value(parseTaskGraph(graph))));
  return { root, statePath, runsRoot: join(root, "runs") };
}
type Action = Readonly<{ kind: string; requests?: readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[];
  diagnostic?: { message: string }; request?: { requestId: string }; outcome?: unknown }>;
async function cliResult(p: ReturnType<typeof project>, args: readonly string[], stdin = "") {
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bun", [cli, "helper", "orchestration", ...args], { cwd: p.root,
      env: fixturePiEnvironment(p.root),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
  return result;
}
async function runCli(p: ReturnType<typeof project>, args: readonly string[], stdin = ""): Promise<Action> {
  const result = await cliResult(p, args, stdin);
  expect(result.status, result.stderr).toBe(0);
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as Action;
}
async function start(p: ReturnType<typeof project>, runId = "run.current") {
  const action = await runCli(p, ["start", "wave-gate", "--runs-root", p.runsRoot, "--run", runId], JSON.stringify({ wave: 1 }));
  expect(action.kind, JSON.stringify(action)).toBe("spawn-batch");
  return { action, handle: value(openRunDirectory(p.runsRoot, runId)) };
}
const resume = (p: ReturnType<typeof project>, handle: RunDirHandle) => runCli(p, ["resume", "--runs-root", p.runsRoot, "--run", handle.runId]);
const graph = (p: ReturnType<typeof project>) => value(parseTaskGraph(JSON.parse(readFileSync(p.statePath, "utf8"))));
function registration(handle: RunDirHandle) {
  const parsed = parseRegisteredFacadeProgram(value(handle.readProgramRegistration()));
  if (parsed.kind !== "registered" || parsed.program.kind !== "wave-gate") throw new Error("expected actual Wave registration");
  return parsed.program;
}
function payload(handle: RunDirHandle, request: AgentRequestAuthority, findings: readonly ReviewerDraftV2[] = [], verdict = "resolved_by_remediation") {
  const packet = value(handle.readContext(request.contextDigest));
  const context = handleWaveReviewContext([packet], packet.digest);
  if (context.kind !== "loaded" || context.value.task === null || context.value.taskRun === null) throw new Error("expected issued Task context");
  const priors = context.value.task.priorFindings.map(({ id }) => ({ finding_id: id, verdict, reason: "  verified against issued bytes\nexact reason  " }));
  if (packet.schemaVersion === 2) return JSON.stringify({ schemaVersion: 2, kind: "wave-review", packetId: context.value.packetId,
    generation: context.value.taskRun.generation, prior_findings: priors, findings });
  return ["### Machine Summary", `REVIEW_GENERATION: ${context.value.taskRun.generation}`, `REVIEW_PACKET_ID: ${context.value.packetId}`,
    "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "```findings", "[]", "```", "```review_lifecycle", JSON.stringify({ prior_findings: priors }), "```"].join("\n");
}
function submit(p: ReturnType<typeof project>, handle: RunDirHandle, request: AgentRequestAuthority, raw: string) {
  return runCli(p, ["submit", "--runs-root", p.runsRoot, "--run", handle.runId,
    "--request", request.requestId, "--slot", request.slotId, "--attempt", String(request.attempt)], raw);
}
async function capture(handle: RunDirHandle, request: AgentRequestAuthority, raw: string | Uint8Array) {
  value(await handle.captureTranscript(request, [...(typeof raw === "string" ? Buffer.from(raw) : raw)]));
}

/** A genuine disposable v1 prefix, generated by the retained producer and protected install operation. */
async function legacyPrefix(p: ReturnType<typeof project>) {
  const handle = value(createRunDirectory(p.runsRoot, "run.legacy"));
  const manager = new StateManager(p.statePath);
  const initial = manager.load();
  const registered = { schemaVersion: 1 as const, kind: "wave-gate" as const, input: { wave: 1 }, taskIds: ["T1"],
    authorityDigest: waveGateAuthorityDigest(1, ["T1"], initial) };
  value(await handle.registerProgram(registered));
  await manager.registerActiveWaveGate({ schemaVersion: 1, kind: "active-wave-gate", runId: handle.runId, wave: 1,
    authorityDigest: registered.authorityDigest, revision: 0, terminalOutcome: null, runsRoot: p.runsRoot }, ["T1"]);
  return withFixturePiSession(p.root, async () => {
    const batch = waveRequests(handle, registered, manager.load(), 1, p.root);
    const published = await publishInitialBatch(handle, batch.requests, batch.packets, "wave-gate-current");
    if (!published.ok) throw new Error(published.message);
    await installWaveReviewRuns(manager, registered, batch);
    return { handle, action: published.action as Action };
  });
}
function legacyDelivery(action: Action) {
  expect(action.kind, JSON.stringify(action)).toBe("spawn-batch");
  for (const { authority, task } of action.requests ?? []) {
    if (authority.role === "spec-check-invoker") continue;
    expect(task).toContain(join(packageRoot, "references", "reviewer-protocol-v1", "agents", `${authority.role}.md`));
    expect(task).toContain(join(packageRoot, "references", "reviewer-protocol-v1", "agents", "_shared", "wire-contract.md"));
    expect(task).toContain("current v2 wire, severity and rubric guidance is inapplicable");
  }
}

describe("registered Wave reviewer protocol", () => {
  it("publishes current five-slot authority, resolves a mixed prior roster only on completion, preserves full current basis and completes/replays", async () => {
    const priors = mixedPriors();
    const p = project(priors);
    const { handle, action } = await start(p);
    const issued = action.requests!;
    expect(issued.map(({ authority }) => authority.role)).toEqual(["spec-check-invoker", ...WAVE_REVIEW_AGENTS]);
    expect(registration(handle).reviewerProtocol).toEqual(CURRENT_REVIEWER_PROTOCOL);
    const run = graph(p).tasks[0]!.review_run!;
    expect(run.reviewer_protocol).toEqual(CURRENT_REVIEWER_PROTOCOL);
    for (const { authority } of issued.slice(1)) {
      expect(run.slot_authority!.find(({ agent }) => agent === authority.role)).toEqual({ agent: authority.role,
        slot_id: authority.slotId, attempted: 1, request_id: authority.requestId, context_digest: authority.contextDigest });
      const packet = value(handle.readContext(authority.contextDigest));
      expect(packet.schemaVersion).toBe(2);
      expect(Buffer.from(packet.fixedContext.find(({ label }) => label === "reviewer-payload-schema")!.bytes).toString()).toBe(REVIEWER_PAYLOAD_SCHEMA_V2);
      expect(Buffer.from(packet.fixedContext.find(({ label }) => label === "reviewer-impact-rubric")!.bytes).toString()).toBe(REVIEWER_IMPACT_RUBRIC_V1);
      expect(value(reviewerProtocolResolver(handle, registration(handle))(authority)).protocolVersion).toBe(2);
    }
    const reviewers = issued.slice(1);
    await capture(handle, issued[0]!.authority, specPass);
    for (const { authority } of reviewers.slice(0, 4)) {
      await submit(p, handle, authority, payload(handle, authority));
      expect(graph(p).tasks[0]!.findings).toEqual(priors);
      expect(graph(p).tasks[0]!.resolved_findings ?? []).toEqual([]);
    }
    const final = await submit(p, handle, reviewers[4]!.authority, payload(handle, reviewers[4]!.authority));
    expect(final.kind, JSON.stringify(final)).toBe("done");
    const completed = graph(p).tasks[0]!;
    expect(completed.findings).toEqual([]);
    expect(completed.resolved_findings?.map(({ finding }) => finding)).toEqual(priors);
    expect(completed.accepted_review_authority?.reviewer_protocol).toEqual(CURRENT_REVIEWER_PROTOCOL);
    expect(completed.review_run).toBeUndefined();
    const before = readFileSync(p.statePath);
    expect(await resume(p, handle)).toEqual(final);
    expect(readFileSync(p.statePath)).toEqual(before);
  }, 60_000);

  it("rejects a whole malformed current payload, atomically replaces retry slot authority, preserves accepted siblings, and awaits advisory approval", async () => {
    const p = project();
    const { handle, action } = await start(p);
    const requests = action.requests!;
    await capture(handle, requests[0]!.authority, specPass);
    for (const { authority } of requests.slice(2)) await submit(p, handle, authority, payload(handle, authority));
    const sibling = value(handle.readTranscriptBytes(requests[2]!.authority));
    const first = requests[1]!.authority;
    const malformed = JSON.stringify({ schemaVersion: 2, kind: "wave-review", findings: [criticalDraft] });
    const retried = await submit(p, handle, first, malformed);
    expect(retried.kind, JSON.stringify(retried)).toBe("spawn-batch");
    expect(retried.requests).toHaveLength(1);
    const retry = retried.requests![0]!;
    expect(retry.authority.attempt).toBe(2);
    expect(retry.task).toContain("unchanged reviewer-payload-schema");
    expect(retry.task).not.toContain("review_lifecycle block");
    const task = graph(p).tasks[0]!;
    expect(task.findings).toEqual([]);
    expect(task.review_run?.evidence).toHaveLength(4);
    expect(task.review_run?.slot_authority?.find(({ agent }) => agent === first.role)).toEqual({ agent: first.role,
      slot_id: first.slotId, attempted: 2, request_id: retry.authority.requestId, context_digest: retry.authority.contextDigest });
    const firstPacket = value(handle.readContext(first.contextDigest));
    const secondPacket = value(handle.readContext(retry.authority.contextDigest));
    expect(secondPacket.fixedContext).toEqual(firstPacket.fixedContext);
    expect(persistedWaveAttemptTwoCompatibilityProblem(first, retry.authority, firstPacket, secondPacket)).toBeNull();
    expect(await resume(p, handle)).toEqual(retried);
    const awaiting = await submit(p, handle, retry.authority, payload(handle, retry.authority, [advisory]));
    expect(awaiting.kind, JSON.stringify(awaiting)).toBe("await-user");
    expect(graph(p).tasks[0]!.findings).toMatchObject([{ ...advisory, protocolVersion: 2 }]);
    expect(value(handle.readTranscriptBytes(requests[2]!.authority))).toEqual(sibling);
    expect(await resume(p, handle)).toEqual(awaiting);
    const done = await runCli(p, ["decide", "--runs-root", p.runsRoot, "--run", handle.runId, "--request", awaiting.request!.requestId], JSON.stringify({ kind: "approve" }));
    expect(done.kind, JSON.stringify(done)).toBe("done");
    expect(await resume(p, handle)).toEqual(done);
  }, 60_000);

  it.each(["diagnostic-rich", "unchanged-context"] as const)("delivers all five legacy roles at all four prefixes with %s retry bytes preserved", async (kind) => {
    const p = project();
    const { handle, action } = await legacyPrefix(p);
    legacyDelivery(action);
    const originalProgram = readFileSync(join(handle.runDirectory, "program.json"));
    const originals = action.requests!.map(({ authority }) => [authority.contextDigest,
      readFileSync(join(handle.runDirectory, "contexts", `${authority.contextDigest}.json`))] as const);
    legacyDelivery(await resume(p, handle));
    await capture(handle, action.requests![0]!.authority, specPass);
    for (const { authority } of action.requests!.slice(1)) await capture(handle, authority, "historical malformed response");
    if (kind === "unchanged-context") {
      for (const { authority } of action.requests!.slice(1)) {
        const retry = deriveWaveAttemptTwo(handle, authority);
        const published = await publishInitialBatch(handle, [retry.request], [retry.packet], `wave-gate-retry:${authority.slotId}`);
        if (!published.ok) throw new Error(published.message);
        legacyDelivery(published.action as Action);
      }
    }
    const retries = await resume(p, handle);
    legacyDelivery(retries);
    expect(retries.requests).toHaveLength(5);
    expect(retries.requests!.every(({ authority }) => authority.attempt === 2)).toBe(true);
    expect(await resume(p, handle)).toEqual(retries);
    legacyDelivery(await resume(p, handle));
    for (const { authority } of retries.requests!) await capture(handle, authority, payload(handle, authority));
    expect((await resume(p, handle)).kind).toBe("done");
    expect((await resume(p, handle)).kind).toBe("done");
    expect(readFileSync(join(handle.runDirectory, "program.json"))).toEqual(originalProgram);
    for (const [digest, bytes] of originals) expect(readFileSync(join(handle.runDirectory, "contexts", `${digest}.json`))).toEqual(bytes);
  }, 60_000);

  it("retains whole mixed current/historical Finding authority through published verifier contexts, strict-majority refutation and done replay", async () => {
    const priors = mixedPriors();
    const p = project(priors);
    const { handle, action } = await start(p);
    await capture(handle, action.requests![0]!.authority, specPass);
    for (const [index, { authority }] of action.requests!.slice(1).entries()) {
      await capture(handle, authority, payload(handle, authority, index === 0 ? [{ ...criticalDraft, claim: "new current defect" }] : [], "still_present"));
    }
    const panel = await resume(p, handle);
    expect(panel.kind, JSON.stringify(panel)).toBe("spawn-batch");
    expect(panel.requests).toHaveLength(3);
    const originalFindings = graph(p).tasks[0]!.findings!;
    expect(originalFindings).toHaveLength(3);
    for (const [index, { authority }] of panel.requests!.entries()) {
      expect(authority.role).toBe("review-verifier-agent");
      const context = value(handle.readContext(authority.contextDigest));
      const section = context.fixedContext.find(({ label }) => label === "wave-refutation-authority")!;
      const material = JSON.parse(Buffer.from(section.bytes).toString()) as { lens: string; findings: readonly { id: string; protocolVersion?: 2; basis?: unknown }[] };
      expect(material.findings).toHaveLength(3);
      expect(material.findings[0]!.protocolVersion).toBeUndefined();
      expect(material.findings.slice(1).every(({ protocolVersion, basis }) => protocolVersion === 2 && basis !== undefined)).toBe(true);
      expect(material.findings[1]).toMatchObject({ protocolVersion: 2, basis: critical.basis });
      await capture(handle, authority, JSON.stringify({ criterion: material.lens,
        verdicts: material.findings.map(({ id }) => ({ finding_id: id, verdict: index < 2 ? "refuted" : "upheld", reasoning: "asserted precondition does not hold" })) }));
    }
    const done = await resume(p, handle);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    expect(graph(p).tasks[0]!.findings).toEqual([]);
    expect(graph(p).tasks[0]!.refuted_findings?.map(({ finding }) => finding)).toEqual(originalFindings);
    expect(await resume(p, handle)).toEqual(done);
  }, 60_000);

  it("refuses a shortened protected current reviewer roster rather than finalizing partial prior resolution", async () => {
    const priors = mixedPriors();
    const p = project(priors);
    const { handle, action } = await start(p);
    const first = action.requests![1]!.authority;
    await new StateManager(p.statePath).update((locked) => ({ ...locked, tasks: locked.tasks.map((task) => {
      const run = task.review_run;
      if (run?.reviewer_protocol === undefined) throw new Error("fixture must have a genuine installed current run");
      return { ...task, review_run: { ...run, expected_agents: [first.role], slot_authority: [run.slot_authority[0]] } };
    }) }));
    await capture(handle, first, payload(handle, first));
    await capture(handle, action.requests![0]!.authority, specPass);
    expect(await resume(p, handle)).toMatchObject({ kind: "blocked", diagnostic: { message: expect.stringContaining("exact slot authority") } });
    expect(graph(p).tasks[0]!.findings).toEqual(priors);
    expect(graph(p).tasks[0]!.resolved_findings ?? []).toEqual([]);
    expect(graph(p).tasks[0]!.review_run?.evidence).toEqual([]);
  }, 30_000);

  it("does not downgrade accepted current authority after its descriptor is removed", async () => {
    const p = project();
    const { handle, action } = await start(p);
    for (const { authority } of action.requests!.slice(1)) await capture(handle, authority, payload(handle, authority));
    expect((await resume(p, handle)).kind).toBe("spawn-batch");
    await new StateManager(p.statePath).update((locked) => ({ ...locked, tasks: locked.tasks.map((task) => {
      const accepted = task.accepted_review_authority;
      if (accepted?.reviewer_protocol === undefined) throw new Error("fixture must have genuine accepted current authority");
      const { reviewer_protocol: _removed, ...missing } = accepted;
      return { ...task, accepted_review_authority: missing };
    }) }));
    await capture(handle, action.requests![0]!.authority, specPass);
    expect(await resume(p, handle)).toMatchObject({ kind: "blocked", diagnostic: { message: expect.stringContaining("exact accepted reviewer protocol authority") } });
  }, 30_000);

  it("rejects invalid UTF-8, reordered priors, foreign scope, missing basis and legacy-looking output without admitting partial current Findings", async () => {
    const priors = mixedPriors();
    const p = project(priors);
    const { handle, action } = await start(p);
    await capture(handle, action.requests![0]!.authority, specPass);
    for (const [index, { authority }] of action.requests!.slice(1).entries()) {
      const valid = JSON.parse(payload(handle, authority, [criticalDraft])) as { prior_findings: unknown[]; findings: unknown[] };
      const corrupt: readonly (string | Uint8Array)[] = [new Uint8Array([0xff]),
        JSON.stringify({ ...valid, prior_findings: [...valid.prior_findings].reverse() }),
        JSON.stringify({ ...valid, findings: [{ ...criticalDraft, file: "outside.ts" }] }),
        JSON.stringify({ ...valid, findings: [{ severity: "critical", claim: "missing basis", file: null, line: null }] }),
        "CRITICAL_COUNT: 0\nADVISORY_COUNT: 0"];
      await capture(handle, authority, corrupt[index]!);
    }
    const retries = await resume(p, handle);
    expect(retries.kind, JSON.stringify(retries)).toBe("spawn-batch");
    expect(retries.requests).toHaveLength(5);
    expect(graph(p).tasks[0]!.review_run?.evidence).toEqual([]);
    expect(graph(p).tasks[0]!.findings).toEqual(priors);
    for (const { authority } of retries.requests!) await capture(handle, authority, "{}");
    expect(await resume(p, handle)).toMatchObject({ kind: "blocked", diagnostic: { message: expect.stringContaining("attempt 2 exhausted") } });
    expect(graph(p).tasks[0]!.review_run?.evidence).toEqual([]);
    expect(graph(p).tasks[0]!.resolved_findings ?? []).toEqual([]);
  }, 60_000);

  it.each(["missing", "ambiguous", "marker-only"] as const)("terminal-blocks %s final payload retries and preserves accepted current Findings on exhausted restart without resolving partial priors", async (mode) => {
    const priors = mixedPriors();
    const p = project(priors);
    const { handle, action } = await start(p);
    const requests = action.requests!;
    await capture(handle, requests[0]!.authority, specPass);
    for (const [index, { authority }] of requests.slice(2).entries()) await capture(handle, authority,
      payload(handle, authority, index === 0 ? [criticalDraft, advisory] : [], "still_present"));
    const reject = async (request: AgentRequestAuthority) => {
      if (mode === "marker-only") {
        value(await handle.rejectCapture(request, "capture failed before its journal append"));
        return;
      }
      const nativeId = `fixture-${mode}-${request.attempt}`;
      value(await handle.recordHarnessCorrelator({ schemaVersion: 1, harness: "claude", nativeId, requestId: request.requestId,
        role: request.role, attempt: request.attempt }));
      const outcome = await captureHarnessResult({ harness: "claude", runsRoot: p.runsRoot, runDirectory: handle.runDirectory, nativeId,
        candidates: mode === "missing" ? [] : [{ origin: "fixture-1", text: "{}" }, { origin: "fixture-2", text: "{}" }] });
      expect(outcome.kind).toBe("terminal-rejection");
    };
    await reject(requests[1]!.authority);
    const retry = await resume(p, handle);
    expect(retry.kind, JSON.stringify(retry)).toBe("spawn-batch");
    expect(retry.requests).toHaveLength(1);
    const retryAuthority = await currentWaveTaskReviewRetries(handle, registration(handle), graph(p), value(handle.readIssuedRequests()));
    await reject(retry.requests![0]!.authority);
    expect(await resume(p, handle)).toMatchObject({ kind: "blocked", diagnostic: { message: expect.stringContaining("attempt 2 exhausted") } });
    expect((await resume(p, handle)).kind).toBe("blocked");
    const restarted = await runCli(p, ["restart", "--runs-root", p.runsRoot, "--run", handle.runId, "--new-run", "run.restarted"]);
    expect(restarted.kind, JSON.stringify(restarted)).toBe("spawn-batch");
    const preserved = graph(p).tasks[0]!;
    expect(preserved.findings?.slice(0, 2)).toEqual(priors);
    expect(preserved.findings?.slice(2)).toMatchObject([{ ...criticalDraft, protocolVersion: 2 }, { ...advisory, protocolVersion: 2 }]);
    expect(preserved.resolved_findings ?? []).toEqual([]);
    expect(preserved.review_run?.reviewer_protocol).toEqual(CURRENT_REVIEWER_PROTOCOL);
    const beforeStale = readFileSync(p.statePath);
    await markWaveTaskReviewRetriesIssued(new StateManager(p.statePath), retryAuthority);
    expect(readFileSync(p.statePath)).toEqual(beforeStale);
    const stale = requests[2]!.authority;
    const refused = await cliResult(p, ["submit", "--runs-root", p.runsRoot, "--run", handle.runId,
      "--request", stale.requestId, "--slot", stale.slotId, "--attempt", "1"], payload(handle, stale));
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("exact current Review Packet slot");
    expect(refused.stderr).toContain(": request does not belong to the exact current Wave Review Packet slot");
    expect(readFileSync(p.statePath)).toEqual(beforeStale);
  }, 60_000);
});
