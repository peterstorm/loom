import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildContextPacket, encodeByteSection } from "../../../../src/core/context-packets";
import { captureKey } from "../../../../src/core/harness-capture";
import { lowerModelProfile, resolveAgentPolicy, resolveModelProfile } from "../../../../src/core/model-profiles";
import { parseRequestId, type AgentRequestAuthority } from "../../../../src/core/orchestration-contract";
import { CURRENT_REVIEWER_PROTOCOL, REVIEWER_IMPACT_RUBRIC_V1, REVIEWER_PAYLOAD_SCHEMA_V2 } from "../../../../src/core/reviewer-contract";
import { prepareStandaloneReview, serializeStandaloneReviewAuthority, STANDALONE_REVIEWER_ROLES } from "../../../../src/core/standalone-review";
import { reduceStandaloneReviewMachine, serializeStandaloneReviewMachineState, startStandaloneReviewMachine } from "../../../../src/core/standalone-review-machine";
import { parseRegistration, parseRegisteredFacadeProgram, parsedAuthority, publicationFile, standalonePublicationEffectId, publishLegacyInitialBatch, reviewerProtocolResolver, standaloneRequestId } from "../../../../src/handlers/helpers/programs/helpers";
import { inspectStandaloneFacade, readStandaloneReviewedSource, replayStandaloneResultFromEvidence, type StandaloneCaptureWitness } from "../../../../src/handlers/helpers/programs/standalone";
import { createRunDirectory, openRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { captureHarnessResult } from "../../../../src/orchestration/harness-capture-runtime";
import { disposeFixturePiSessions, fixturePiEnvironment, fixtureSession, withFixturePiSession } from "../../../fixtures/pi-session";
import { readSessionRunBindings } from "../../../../src/orchestration/session-run-bindings";

const packageRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../../../src/cli.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => { disposeFixturePiSessions(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const currentEmpty = JSON.stringify({ schemaVersion: 2, kind: "standalone-review", findings: [] });
const legacyEmpty = "### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 0\n\n```findings\n[]\n```";

function value<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
function git(root: string, args: readonly string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loom-p4-standalone-")));
  roots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "runs"));
  writeFileSync(join(root, "src", "a.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  git(root, ["add", "src/a.ts", "README.md"]);
  git(root, ["commit", "-qm", "fixture baseline"]);
  writeFileSync(join(root, "src", "a.ts"), "export const value = 2;\n");
  writeFileSync(join(root, "README.md"), "# Updated fixture\n");
  return { root, runsRoot: join(root, "runs"), scope: ["README.md", "src/a.ts"] };
}

type Action = Readonly<{ kind: string; requests?: readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[] }>;
/** Child-only real runtime admission. No parent environment or live worktree mutation. */
async function runCli(root: string, args: readonly string[], stdin = ""): Promise<Action> {
  const result = await new Promise<Readonly<{ status: number | null; stdout: string; stderr: string }>>((resolve, reject) => {
    const child = spawn("bun", [cli, "helper", "orchestration", ...args], {
      cwd: root,
      env: fixturePiEnvironment(root),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
  expect(result.status, result.stderr).toBe(0);
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as Action;
}
async function submit(root: string, handle: RunDirHandle, request: AgentRequestAuthority, raw: string): Promise<Action> {
  return (await runCli(root, ["submit", "--runs-root", handle.identity.runsRoot, "--run", handle.runId,
    "--request", request.requestId, "--slot", request.slotId, "--attempt", String(request.attempt)], raw));
}
async function resume(root: string, handle: RunDirHandle): Promise<Action> {
  return (await runCli(root, ["resume", "--runs-root", handle.identity.runsRoot, "--run", handle.runId]));
}
function registered(handle: RunDirHandle) {
  return value(parseRegistration(value(handle.readProgramRegistration())));
}
function witnesses(handle: RunDirHandle): ReadonlyMap<string, StandaloneCaptureWitness> {
  const captured = value(handle.readCapturedAttempts());
  return new Map(value(handle.readIssuedRequests()).flatMap((request) => {
    const key = captureKey(request.slotId, request.attempt);
    if (!captured.has(key)) return [];
    const raw = value(handle.readTranscriptBytes(request));
    return [[key, { requestId: request.requestId, role: request.role, contextDigest: request.contextDigest, digest: hash(raw), byteLength: raw.byteLength }] as const];
  }));
}

/** Legitimate disposable prefix produced by the archived v1 packet recipe, not a modified historical Run. */
async function legacyPrefix(p: ReturnType<typeof project>): Promise<{ handle: RunDirHandle; initial: Action }> {
  const handle = value(createRunDirectory(p.runsRoot, "run.legacy-issued"));
  const head = git(p.root, ["rev-parse", "HEAD"]);
  const source = value(encodeByteSection("standalone-frozen-source", JSON.stringify({ schemaVersion: 1, headRevision: head,
    files: p.scope.map((path) => { const bytes = readFileSync(join(p.root, path));
      return { path, kind: "text", digest: hash(bytes), byteLength: bytes.byteLength, content: bytes.toString("utf8") }; }),
  })));
  const packets = STANDALONE_REVIEWER_ROLES.flatMap((role) => ([1, 2] as const).map((attempt) => {
    const policy = value(resolveAgentPolicy(role));
    return value(buildContextPacket({ requestId: value(parseRequestId(standaloneRequestId(handle.runId, role, attempt))), role,
      requiredSkill: policy.requiredSkill ?? "none", outputContract: "Review the exact frozen scope. Return the Loom Machine Summary and findings contract for your reviewer role.",
      fixedContext: [value(encodeByteSection("standalone-review-authority", JSON.stringify({ runId: handle.runId, scope: p.scope, role, attempt }))), source], variableContext: [],
    }));
  }));
  const prepared = value(prepareStandaloneReview({ runId: handle.runId, explicitScope: p.scope,
    changedPaths: { unstaged: p.scope, staged: [], committed: [], base_revision: null, head_revision: head },
    reviewMetadata: { requested_kinds: ["all"], docs_only: false, source_or_test_changed: true, types_changed: true, comments_changed: true,
      additions: 2, file_count: p.scope.length, new_structure: false, languages: ["md", "ts"] },
    scopeSafety: p.scope.map((path) => ({ path, status: "safe" })),
    roster: STANDALONE_REVIEWER_ROLES.map((role, index) => {
      const policy = value(resolveAgentPolicy(role));
      const profile = value(resolveModelProfile(policy.profile));
      const slotId = `standalone-slot:${index + 1}:${role}`;
      return { slotId, attempts: ([1, 2] as const).map((attempt) => ({ runId: handle.runId, requestId: standaloneRequestId(handle.runId, role, attempt),
        slotId, role, program: "standalone-review", attempt, modelProfile: policy.profile,
        harnessBinding: { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") },
        requiredSkill: policy.requiredSkill, contextDigest: packets[index * 2 + attempt - 1]!.digest, outputSlot: `transcripts/${slotId}/attempt-${attempt}.raw`,
      })) };
    }),
  }));
  const registration = value(parseRegistration({ schemaVersion: 1, kind: "standalone-review", input: { kind: "all", files: p.scope, dryRun: false },
    authority: JSON.parse(serializeStandaloneReviewAuthority(prepared.authority)) }));
  value(await handle.registerProgram(registration));
  const firstPackets = packets.filter((_, index) => index % 2 === 0);
  const published = await withFixturePiSession(p.root, () => publishLegacyInitialBatch(handle, prepared.initialRequests.map((authority) => ({ authority,
    context: { digest: authority.contextDigest, slot: `contexts/${authority.contextDigest}.json` } })), firstPackets, "standalone-review"));
  if (!published.ok) throw new Error(published.message);
  const awaiting = value(reduceStandaloneReviewMachine(startStandaloneReviewMachine(prepared.authority), { kind: "review-batch-published", runId: handle.runId }));
  await handle.writeCheckpoint(serializeStandaloneReviewMachineState(awaiting));
  return { handle, initial: published.action as Action };
}

function executePacketCommand(task: string) {
  const command = /^LOOM_CONTEXT_READ_COMMAND: (.+)$/m.exec(task)?.[1];
  expect(command, "delivery must supply an executable cross-harness packet reader").toBeDefined();
  const result = spawnSync("bash", ["-c", command ?? "exit 127"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { schemaVersion: number; requestId: string; sections: unknown[] };
}

function expectLegacyDelivery(action: Action) {
  expect(action.kind).toBe("spawn-batch");
  for (const { authority, task } of action.requests ?? []) {
    expect(executePacketCommand(task)).toMatchObject({ schemaVersion: 1, requestId: authority.requestId });
    expect(task).toContain("Read the issued Context Packet FIRST.");
    expect(task).toContain(join(packageRoot, "references", "reviewer-protocol-v1", "agents", `${authority.role}.md`));
    expect(task).toContain(join(packageRoot, "references", "reviewer-protocol-v1", "agents", "_shared", "wire-contract.md"));
    expect(task).toContain("current v2 wire, severity and rubric guidance is inapplicable");
    expect(readFileSync(join(packageRoot, "agents", `${authority.role}.md`), "utf8")).toContain("reviewer-protocol-v1");
  }
}

describe("standalone registered protocol delivery and publication", () => {
  it("runs current seven-slot manual submission/retry/publication/reload and checkpoint-independent witness replay through admitted fixture CLI children", async () => {
    const p = project();
    const initial = (await runCli(p.root, ["start", "standalone-review", "--runs-root", p.runsRoot, "--run", "run.current"], JSON.stringify({ kind: "all", files: p.scope, dryRun: false })));
    const handle = value(openRunDirectory(p.runsRoot, "run.current"));
    const session = fixtureSession(p.root);
    const bindings = value(readSessionRunBindings(session.transport, session.sessionId));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ runId: handle.runId, runsRoot: p.runsRoot, runDirectory: handle.runDirectory, resultDigest: null });
    expect(bindings[0]!.requestIds).toEqual(initial.requests!.map(({ authority }) => authority.requestId).sort());
    const registration = registered(handle);
    expect(registration.schemaVersion).toBe(2);
    expect(registration.reviewerProtocol).toEqual(CURRENT_REVIEWER_PROTOCOL);
    const requests = initial.requests!;
    expect(requests.map(({ authority }) => authority.role)).toEqual(STANDALONE_REVIEWER_ROLES);
    for (const request of requests) {
      expect(executePacketCommand(request.task)).toMatchObject({ schemaVersion: 2, requestId: request.authority.requestId });
    }
    for (const { authority, task } of requests) {
      const packet = value(handle.readContext(authority.contextDigest));
      expect(packet.schemaVersion).toBe(2);
      expect(Buffer.from(packet.fixedContext.find(({ label }) => label === "reviewer-payload-schema")!.bytes).toString()).toBe(REVIEWER_PAYLOAD_SCHEMA_V2);
      expect(Buffer.from(packet.fixedContext.find(({ label }) => label === "reviewer-impact-rubric")!.bytes).toString()).toBe(REVIEWER_IMPACT_RUBRIC_V1);
      expect(task).not.toContain("Machine Summary");
      expect(value(reviewerProtocolResolver(handle, registration)(authority)).protocolVersion).toBe(2);
    }
    const originalRegistration = readFileSync(join(handle.runDirectory, "program.json"));
    for (const { authority } of requests.slice(1)) (await submit(p.root, handle, authority, currentEmpty));
    const acceptedSibling = value(handle.readTranscriptBytes(requests[1]!.authority));
    (await submit(p.root, handle, requests[1]!.authority, "conflicting duplicate delivery"));
    expect(value(handle.readTranscriptBytes(requests[1]!.authority))).toEqual(acceptedSibling);
    const rejected = (await submit(p.root, handle, requests[0]!.authority, "CRITICAL_COUNT: 0\nADVISORY_COUNT: 0"));
    const retry = rejected.requests![0]!;
    expect(retry.authority.attempt).toBe(2);
    expect(retry.task).toContain("unchanged reviewer-payload-schema");
    expect(retry.task).not.toContain("End with a `### Machine Summary`");
    expect((await resume(p.root, handle)).requests).toEqual(rejected.requests);
    expect((await submit(p.root, handle, retry.authority, currentEmpty)).kind).toBe("done");
    expect((await resume(p.root, handle)).kind).toBe("done");
    expect(value(await inspectStandaloneFacade(handle, registration)).kind).toBe("done");
    const resultBytes = readFileSync(join(handle.runDirectory, "result.json"));
    const completedBinding = value(readSessionRunBindings(session.transport, session.sessionId))[0]!;
    expect(completedBinding.resultDigest).toBe(hash(resultBytes));
    expect(completedBinding.requestIds).toContain(retry.authority.requestId);
    const result = JSON.parse(resultBytes.toString());
    expect(result.schema_version).toBe(2);
    expect(result.reviewer_evidence).toHaveLength(7);
    expect(result.surviving_critical_findings).toEqual([]);
    expect(readFileSync(join(handle.runDirectory, "program.json"))).toEqual(originalRegistration);
    expect(readStandaloneReviewedSource(handle, registration).ok).toBe(true);
    const witnessed = witnesses(handle);
    unlinkSync(join(handle.runDirectory, "checkpoint.json"));
    const replay = replayStandaloneResultFromEvidence(handle, registration, witnessed);
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    if (replay.ok) expect(Buffer.from(replay.json)).toEqual(resultBytes);
    const wrong = new Map(witnessed);
    const first = [...wrong.entries()][0]!;
    wrong.set(first[0], { ...first[1], digest: "0".repeat(64) });
    expect(replayStandaloneResultFromEvidence(handle, registration, wrong).ok).toBe(false);
  }, 60_000);

  it("delivers the archived contract for all seven historical roles at all four issuance/recovery prefixes without rewriting frozen bytes", async () => {
    const p = project();
    const { handle, initial } = await legacyPrefix(p);
    expect(initial.requests).toHaveLength(7);
    expectLegacyDelivery(initial);
    const registration = registered(handle);
    const frozenRegistration = readFileSync(join(handle.runDirectory, "program.json"));
    const originalPackets = value(handle.readIssuedRequests()).map((request) => [request.contextDigest,
      readFileSync(join(handle.runDirectory, "contexts", `${request.contextDigest}.json`))] as const);
    expectLegacyDelivery((await resume(p.root, handle)));
    const requests = initial.requests!;
    let retryAction = initial;
    for (const { authority } of requests) {
      retryAction = (await submit(p.root, handle, authority, "missing historical markers"));
      expectLegacyDelivery(retryAction);
    }
    expect(retryAction.requests).toHaveLength(7);
    for (const retry of retryAction.requests!) {
      expect(retry.authority.attempt).toBe(2);
      expect(value(handle.readContext(retry.authority.contextDigest)).schemaVersion).toBe(1);
      expect(value(reviewerProtocolResolver(handle, registration)(retry.authority)).protocolVersion).toBe(1);
    }
    const recovered = (await resume(p.root, handle));
    expectLegacyDelivery(recovered);
    expect(recovered.requests).toEqual(retryAction.requests);
    let completed: Action = recovered;
    for (const { authority } of retryAction.requests!) completed = (await submit(p.root, handle, authority, legacyEmpty));
    expect(completed.kind).toBe("done");
    expect((await resume(p.root, handle)).kind).toBe("done");
    expect(JSON.parse(readFileSync(join(handle.runDirectory, "result.json"), "utf8")).schema_version).toBe(1);
    expect(readFileSync(join(handle.runDirectory, "program.json"))).toEqual(frozenRegistration);
    for (const [digest, bytes] of originalPackets) expect(readFileSync(join(handle.runDirectory, "contexts", `${digest}.json`))).toEqual(bytes);
  }, 60_000);

  it.each(["missing", "ambiguous"] as const)("terminal-blocks %s final payloads at attempt two through the real common capture runtime and facade", async (mode) => {
    const p = project();
    const initial = (await runCli(p.root, ["start", "standalone-review", "--runs-root", p.runsRoot, "--run", "run.capture-rejection"], JSON.stringify({ kind: "types", files: ["src/a.ts"], dryRun: false })));
    const handle = value(openRunDirectory(p.runsRoot, "run.capture-rejection"));
    const requests = initial.requests!;
    for (const { authority } of requests.slice(1)) (await submit(p.root, handle, authority, currentEmpty));
    const rejectCapture = async (request: AgentRequestAuthority) => {
      const nativeId = `fixture-final-${mode}-${request.attempt}`;
      value(await handle.recordHarnessCorrelator({ schemaVersion: 1, harness: "claude", nativeId, requestId: request.requestId, role: request.role, attempt: request.attempt }));
      const outcome = await captureHarnessResult({ harness: "claude", runsRoot: p.runsRoot, runDirectory: handle.runDirectory, nativeId,
        candidates: mode === "missing" ? [] : [{ origin: "fixture-final[0]", text: currentEmpty }, { origin: "fixture-final[1]", text: currentEmpty }],
      });
      expect(outcome.kind).toBe("terminal-rejection");
    };
    await rejectCapture(requests[0]!.authority);
    const retry = (await resume(p.root, handle));
    expect(retry.requests).toHaveLength(1);
    expect(retry.requests![0]!.authority.attempt).toBe(2);
    await rejectCapture(retry.requests![0]!.authority);
    expect((await resume(p.root, handle)).kind).toBe("blocked");
    expect((await resume(p.root, handle)).kind).toBe("blocked");
    const checkpoint = JSON.parse(readFileSync(join(handle.runDirectory, "checkpoint.json"), "utf8"));
    expect(checkpoint.kind).toBe("terminal-blocked");
    expect(checkpoint.failed.attempt).toBe(2);
    for (const { authority } of requests.slice(1)) expect(Buffer.from(value(handle.readTranscriptBytes(authority))).toString()).toBe(currentEmpty);
  }, 30_000);

  it("parses whole Wave registration versions strictly without a caller downgrade flag", () => {
    const current = { schemaVersion: 2, kind: "wave-gate", reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
      input: { wave: 1 }, taskIds: ["T1"], authorityDigest: "a".repeat(64) };
    expect(parseRegisteredFacadeProgram(current).kind).toBe("registered");
    const { reviewerProtocol: _removed, ...missing } = current;
    for (const invalid of [missing, { ...current, schemaVersion: 1 }, { ...current, reviewerProtocol: null },
      { ...current, taskIds: ["T1", "T1"] }, { ...current, input: { wave: 1, protocolVersion: 1 } },
      { ...current, restart: { previousRunId: "run.previous", exhaustedSlots: ["slot:1"] }, orphanRecovery: { previousRunId: "run.previous", previousAuthorityDigest: "b".repeat(64) } },
    ]) expect(parseRegisteredFacadeProgram(invalid).kind).toBe("invalid");
    const legacy = { ...missing, schemaVersion: 1 };
    expect(parseRegisteredFacadeProgram(legacy).kind).toBe("registered");
  });

  it("does not resolve protocol from packet hashes or a registration literal when durable registration/publication is missing", async () => {
    const p = project();
    const { handle, initial } = await legacyPrefix(p);
    const registration = registered(handle);
    const request = initial.requests![0]!.authority;
    const authority = value(parsedAuthority(registration));
    expect(value(reviewerProtocolResolver(handle, registration)(request)).subject.scope).toEqual(authority.scope);
    const publicationPath = join(handle.runDirectory, "artifacts", publicationFile(value(standalonePublicationEffectId(authority))));
    const original = readFileSync(publicationPath);
    unlinkSync(publicationPath);
    expect(reviewerProtocolResolver(handle, registration)(request).ok).toBe(false);
    writeFileSync(publicationPath, original);
    expect(reviewerProtocolResolver(handle, registration)({ ...request, contextDigest: "0".repeat(64) as AgentRequestAuthority["contextDigest"] }).ok).toBe(false);
    unlinkSync(join(handle.runDirectory, "program.json"));
    expect(reviewerProtocolResolver(handle, registration)(request).ok).toBe(false);
    expect((await inspectStandaloneFacade(handle, registration)).ok).toBe(false);
  });
});
