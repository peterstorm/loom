import { spawnSync } from "node:child_process";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";
import { collectedChild } from "../../../fixtures/collected-child";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { attributeFindings } from "../../../../src/core/findings";
import { freezeVerificationManifest } from "../../../../src/core/verification-manifest";
import type { WaveGateInstallProgram } from "../../../../src/core/wave-gate-registration";
import { evaluateTaskProof } from "../../../../src/core/proof-obligations";
import { BASE_WAVE_REVIEW_AGENTS, ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS } from "../../../../src/core/agent-catalog-projections";
import { OWNER_MAP_SECTION, renderOwnerMapSection } from "../../../../src/core/owner-verification/owner-map";
import { CONTRACT_SURFACE_SECTION, isContractSurfaceRole, renderContractSurfaceSection } from "../../../../src/core/contract-surface-section";
import { contract } from "../../../fixtures/contract-status-fixtures";
import { ownerObligation } from "../../../fixtures/owner-obligation";
import type { AgentRequestAuthority } from "../../../../src/core/orchestration-contract";
import { EMISSION_DESCRIPTOR_MARKER, parseEmissionDescriptor } from "../../../../src/core/issued-emission-capability";
import { REVIEWER_EXTRACTION_RETRY_INSTRUCTION, reviewerRetryInstruction } from "../../../../src/core/reviewer-retry";
import { REVIEWER_PROTOCOL_V2, REVIEWER_PAYLOAD_EXAMPLE_V2, REVIEWER_IMPACT_RUBRIC_V1, WAVE_REVIEWER_PAYLOAD_SCHEMA_V4,
  WAVE_REVIEWER_PROTOCOL_V4, type ReviewerDraftV2, type ReviewerProtocolDescriptor } from "../../../../src/core/reviewer-contract";
import { WAVE_V4_ENVELOPE_HINT } from "../../../../src/core/reviewer-protocol";
import { parseReviewerEvidence } from "../../../../src/core/review-output";
import { WAVE_V4_PAYLOAD_LINE, reviewerPayloadKindLine } from "../../../../src/core/spawn-task-text";
import {
  issuedWavePacketIdentity, issuedWaveReviewerPayload, waveReviewerPayload, waveReviewerPayloadV4WithIdentity,
} from "../../../fixtures/wave-reviewer-payload";
import { parseRegisteredFacadeProgram } from "../../../../src/handlers/helpers/programs/registration";
import { publishLegacyInitialBatch } from "../../../../src/handlers/helpers/programs/request-publication";
import { renderExtractionOnlyTask } from "../../../../src/handlers/helpers/programs/spawn-task";
import { reviewerProtocolResolver } from "../../../../src/handlers/helpers/programs/reviewer-protocol-resolution";
import { readWaveReviewContext, waveGateAuthorityDigest } from "../../../../src/core/wave-review-authority";
import { installWaveReviewRuns, waveRequests } from "../../../../src/handlers/helpers/programs/wave-review-requests";
import { deriveWaveAttemptTwo, currentWaveTaskReviewRetries, markWaveTaskReviewRetriesIssued } from "../../../../src/handlers/helpers/programs/wave-review-retries";
import { persistedWaveAttemptTwoCompatibilityProblem, waveReviewerSlotProblem } from "../../../../src/core/wave-gate-membership";
import { prepareExhaustedWaveGateRestart } from "../../../../src/core/wave-gate-replacement";
import { captureKey } from "../../../../src/core/harness-capture";
import { issuedWaveProtocol } from "../../../../src/handlers/helpers/programs/wave-review-context";
import { createRunDirectory, openRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { captureHarnessResult } from "../../../../src/orchestration/harness-capture-runtime";
import { parseActiveWaveGateRegistration, parseTaskGraph, registerActiveWaveGate, StateManager } from "../../../../src/state-manager";
import { disposeFixturePiSessions, withFixturePiSession } from "../../../fixtures/pi-session";
import { parseNewTestEvidence, type CurrentReviewRun, type DraftFinding, type Finding, type Task, type TaskGraph } from "../../../../src/types";
import { supersedeAbandonedWaveGateReview } from "../../../../src/core/wave-gate-registration";
import type { RegisteredWaveGateProgram } from "../../../../src/core/wave-gate-program";
import { observeRestartCarry } from "../../../../src/handlers/helpers/programs/wave-gate-replacement";
import { parseWaveFrozenSource, WAVE_FROZEN_SOURCE_SECTION } from "../../../../src/core/wave-frozen-source";
import { graphFixture, taskFixture, trustedPassEvidence } from "../../../fixtures/task-lifecycle";
import { git as gitWithEnvironment, PINNED_COMMIT_DATES } from "../../../fixtures/git-repository";
import { facadeParentEnvironment, type FacadeParent } from "../../../fixtures/facade-parent";
import { expectParentIndependentIssuance, withoutEmissionRouteDelta } from "../../../fixtures/emission-route-delta";
import { value } from "../../../fixtures/parse-result";
import { parseSpec } from "../../../../src/core/parse-spec";
import { parseTaskReopeningArgs, reopenImplementedTasks } from "../../../../src/core/task-reopening";
import { successionPredecessorOf } from "../../../../src/core/wave-gate-registration";
import { planSuccessorCarry } from "../../../../src/core/wave-review-carry";
import { observeReviewedWorkspace } from "../../../../src/handlers/helpers/reviewed-workspace";
import { withOrigin } from "../../../fixtures/wave-gate-origin";
import { recordedAnchorHashes } from "../../../../src/core/requirement-coverage";

const packageRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../../../src/cli.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => { disposeFixturePiSessions(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// Deterministic commit SHAs: frozen-source sections embed workspaceHead, and
// sections minted by separate fixture projects are compared byte-for-byte.
const git = (root: string, args: readonly string[]) => gitWithEnvironment(root, args, PINNED_COMMIT_DATES);
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
/** Why `OWNED_X` owes no mutation: the fixture's manifest freezes no affected runner. */
const OWNED_X_EXEMPTION = "the fixture manifest freezes no affected runner";
/** One owned Invariant whose owner module is the fixture Task's only file, so the Task touches its family. */
const OWNED_X = ownerObligation({
  invariant: "INV-1", title: "x is decided only by its owner", statement: "Every entry point reads x through src/x.ts.",
  owner: "src/x.ts", siblings: [], matrixTest: "tests/x.matrix.test.ts", mutation: { kind: "exempt", reason: OWNED_X_EXEMPTION },
});
/** The plan that derives exactly `OWNED_X`, so the gate's plan integrity check agrees with the stamp. */
const OWNED_X_PLAN = [
  "# Model-free plan", "", "## Invariants", "",
  `### ${OWNED_X.invariant}: ${OWNED_X.title}`, "",
  "**Tier:** advisory",
  "**Owner module:** `src/x.ts`",
  "**Sibling entry points:** none",
  "**Matrix test:** `tests/x.matrix.test.ts`",
  `**Statement:** ${OWNED_X.statement}`,
  `**Mutation exemption:** ${OWNED_X_EXEMPTION}`, "",
].join("\n");
/** `OWNED_X`'s matrix test: it reaches the owner, so the gate's coverage check passes. */
const OWNED_X_MATRIX_TEST = 'import { expect, it } from "vitest";\nimport { x } from "../src/x";\n\nit("reads x through its owner", () => expect(x).toBe(1));\n';
const X_SURFACE = { types: "src/x.ts", acceptance: "tests/x.acceptance.test.ts" };
/** One Acceptance Contract whose Contract Task is the fixture Task and whose types file is the file that Task modified. */
const X_CONTRACT = contract({
  id: "CT-1", title: "x", contractTask: "T1", surface: X_SURFACE, anchors: ["AS-001"], freeze: { state: "awaiting-red" },
});
/** `X_CONTRACT`'s frozen paths: the file list its Contract Task declares. */
const X_CONTRACT_FILES = [X_SURFACE.types, X_SURFACE.acceptance];
/** A graph whose Task declares `X_CONTRACT_FILES`, stamped with `X_CONTRACT`: that Task is then a Contract Task writing a types file. */
const asContractTask = (state: TaskGraph): TaskGraph => ({ ...state, acceptance_contracts: [X_CONTRACT] });
/** The report `RED_ACCEPTANCE_CHECK` writes, beneath the protected completion report root. */
const RED_ACCEPTANCE_REPORT = ".loom/completion-reports/acceptance.xml";
/** A project check standing in for the acceptance runner: it reports `X_CONTRACT`'s one AS-001 testcase failing, as its RED Wave requires. */
const RED_ACCEPTANCE_SCRIPT = [
  'import { mkdirSync, writeFileSync } from "node:fs";',
  'mkdirSync(".loom/completion-reports", { recursive: true });',
  `writeFileSync(${JSON.stringify(RED_ACCEPTANCE_REPORT)}, ${JSON.stringify([
    '<?xml version="1.0" encoding="UTF-8" ?>',
    '<testsuites name="vitest tests" tests="1" failures="1" errors="0">',
    `<testsuite name="${X_SURFACE.acceptance}" tests="1" failures="1" errors="0" skipped="0">`,
    `<testcase classname="${X_SURFACE.acceptance}" name="AS-001: the Wave progresses">`,
    '<failure message="expected 1 to be 2" type="AssertionError">expected 1 to be 2</failure>',
    "</testcase>",
    "</testsuite>",
    "</testsuites>",
  ].join("\n"))});`,
  "process.exit(1);",
  "",
].join("\n");
/** The manifest whose one Wave check is `RED_ACCEPTANCE_SCRIPT`. */
const RED_ACCEPTANCE_MANIFEST = value(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
  schemaVersion: 1,
  kind: "loom-verification-manifest",
  checks: [{
    id: "project:acceptance",
    scope: "wave",
    executable: "node",
    args: ["acceptance.mjs"],
    cwd: ".",
    timeoutMs: 10_000,
    report: { kind: "required-file", path: RED_ACCEPTANCE_REPORT },
  }],
}))));
/**
 * Make `p`'s Task the Contract Task of `X_CONTRACT` before its Wave Gate
 * starts, as population would: the contract stamped, its acceptance file
 * written, and a frozen check that observes that file RED.
 */
async function contractWave(p: ReturnType<typeof project>): Promise<void> {
  writeFileSync(join(p.root, ".gitignore"), "runs/\n.loom/completion-reports/\n");
  writeFileSync(join(p.root, "acceptance.mjs"), RED_ACCEPTANCE_SCRIPT);
  mkdirSync(join(p.root, "tests"), { recursive: true });
  writeFileSync(join(p.root, X_SURFACE.acceptance),
    'import { expect, it } from "vitest";\nimport { x } from "../src/x";\n\nit("AS-001: the Wave progresses", () => expect(x).toBe(2));\n');
  await new StateManager(p.statePath).update((state) => ({ ...asContractTask(state), verification_manifest: RED_ACCEPTANCE_MANIFEST }));
}

/** One implemented Wave 1 Task with satisfied proof over `declaredFiles`. */
function implementedTask(id: string, declaredFiles: readonly string[], modified: string,
  trace: Pick<Task, "spec_anchors" | "spec_contributions">, priors: readonly Finding[] = []): Task {
  const proof = evaluateTaskProof({ declaredArtifactExpectation: "changed", newTestsRequired: true, declaredArtifacts: declaredFiles },
    trustedPassEvidence(declaredFiles));
  if (proof.state !== "satisfied") throw new Error("fixture requires actual satisfied proof construction");
  return taskFixture({ id, description: `review fixture ${id}`, agent: "code-implementer-agent", wave: 1,
    depends_on: [], status: "implemented", proof, file_list: [...declaredFiles], files_modified: [modified],
    ...trace, test_result: { verdict: "trusted-pass" },
    test_evidence: "fixture checks passed", new_test_observation: parseNewTestEvidence(true, "fixture tests present"),
    review_generation: 0, review_status: "pending", findings: [...priors],
    critical_findings: priors.filter(({ severity }) => severity === "critical").map(({ claim }) => claim), advisory_findings: [],
  });
}

/** `secondTask` adds T2 over `src/y.ts`, contributing to the Requirement T1 completes. */
function project(priors: readonly Finding[] = [], declaredFiles: readonly string[] = ["src/x.ts"], secondTask = false) {
  const root = canonicalTempDir("loom-p4-wave-");
  roots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "runs"));
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "src", "y.ts"), "export const y = 2;\n");
  writeFileSync(join(root, "spec.md"), specText);
  writeFileSync(join(root, "plan.md"), "# Model-free plan\n");
  writeFileSync(join(root, ".gitignore"), "runs/\n");
  git(root, ["init", "-q"]);
  git(root, ["add", ".gitignore", "src/x.ts", "src/y.ts", "spec.md", "plan.md"]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]);
  const tasks = [
    implementedTask("T1", declaredFiles, "src/x.ts", { spec_anchors: ["FR-001", "AS-001"], spec_contributions: [] }, priors),
    ...(secondTask ? [implementedTask("T2", ["src/y.ts"], "src/y.ts", { spec_anchors: [], spec_contributions: ["FR-001"] })] : []),
  ];
  const graph: TaskGraph = { ...graphFixture(tasks), spec_file: join(root, "spec.md"), plan_file: join(root, "plan.md"), spec_trace_version: 2 };
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  writeFileSync(statePath, JSON.stringify(value(parseTaskGraph(graph))));
  return { root, statePath, runsRoot: join(root, "runs") };
}
/** Stamp `OWNED_X` on `p` as population would: its plan derives the obligation and its matrix test exists. */
async function ownXFamily(p: ReturnType<typeof project>): Promise<void> {
  writeFileSync(join(p.root, "plan.md"), OWNED_X_PLAN);
  mkdirSync(join(p.root, "tests"), { recursive: true });
  writeFileSync(join(p.root, "tests", "x.matrix.test.ts"), OWNED_X_MATRIX_TEST);
  await new StateManager(p.statePath).update((locked) => ({ ...locked, owner_obligations: [OWNED_X] }));
}
type Action = Readonly<{ kind: string; requests?: readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[];
  diagnostic?: { message: string }; request?: { requestId: string }; outcome?: unknown }>;
async function cliResult(p: ReturnType<typeof project>, args: readonly string[], stdin = "", parent: FacadeParent = "pi") {
  return collectedChild("bun", [cli, "helper", "orchestration", ...args], { cwd: p.root, env: facadeParentEnvironment(parent, p.root) }, stdin);
}
async function runCli(p: ReturnType<typeof project>, args: readonly string[], stdin = "", parent: FacadeParent = "pi"): Promise<Action> {
  const result = await cliResult(p, args, stdin, parent);
  expect(result.status, result.stderr).toBe(0);
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as Action;
}
async function start(p: ReturnType<typeof project>, runId = "run.current", parent: FacadeParent = "pi") {
  const action = await runCli(p, ["start", "wave-gate", "--runs-root", p.runsRoot, "--run", runId], JSON.stringify({ wave: 1 }), parent);
  expect(action.kind, JSON.stringify(action)).toBe("spawn-batch");
  return { action, handle: value(openRunDirectory(p.runsRoot, runId)) };
}
const resume = (p: ReturnType<typeof project>, handle: RunDirHandle) => runCli(p, ["resume", "--runs-root", p.runsRoot, "--run", handle.runId]);
const graph = (p: ReturnType<typeof project>) => value(parseTaskGraph(JSON.parse(readFileSync(p.statePath, "utf8"))));
/**
 * The State File without its Wave completion suite. A resume installs the
 * Wave's accepted completion suite before any review install, so a refused
 * review install leaves everything else byte-for-byte as it was.
 */
const withoutCompletionSuite = (bytes: Buffer): unknown => {
  const { active_wave_completion_suite: _suite, ...rest } = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  return rest;
};
/** A restart observation under which nothing can carry: these tests pin the full-reset restart. */
const NO_CARRY_OBSERVED = { workspaces: [], issuedRosters: new Map<string, readonly string[]>() };
/** The pre-fix shape of an owner-mapped Task's run: the five base reviewers bound, architecture-tech-lead absent. */
const toBaseFive = (state: TaskGraph): TaskGraph => ({ ...state, tasks: state.tasks.map((task) => {
  const run = task.review_run;
  if (run?.reviewer_protocol === undefined) throw new Error("fixture must have a genuine installed current run");
  const [first, ...rest] = run.slot_authority;
  return { ...task, review_run: { ...run, expected_agents: BASE_WAVE_REVIEW_AGENTS,
    slot_authority: [first, ...rest.slice(0, BASE_WAVE_REVIEW_AGENTS.length - 1)] } };
}) });
function registration(handle: RunDirHandle) {
  const parsed = parseRegisteredFacadeProgram(value(handle.readProgramRegistration()));
  if (parsed.kind !== "registered" || parsed.program.kind !== "wave-gate") throw new Error("expected actual Wave registration");
  return parsed.program;
}
function payload(handle: RunDirHandle, request: AgentRequestAuthority, findings: readonly ReviewerDraftV2[] = [], verdict = "resolved_by_remediation") {
  const packet = value(handle.readContext(request.contextDigest));
  const context = readWaveReviewContext([packet], packet.digest);
  if (context.kind !== "loaded" || context.value.task === null || context.value.taskRun === null) throw new Error("expected issued Task context");
  const priors = context.value.task.priorFindings.map(({ id }) => ({ finding_id: id, verdict, reason: "  verified against issued bytes\nexact reason  " }));
  // The issued descriptor selects the envelope (ADR-0084): v4 for a Wave Gate
  // registered now, v2 for one registered before it.
  if (packet.schemaVersion === 2) return issuedWaveReviewerPayload(packet, { prior_findings: priors, findings });
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

/**
 * Installs a run's protected active Wave 1 authority as `start` does once the
 * program is registered: a fresh, unterminated registration at revision 0.
 */
async function registerWaveGate(
  manager: StateManager,
  run: Readonly<{ runId: string; runsRoot: string; authorityDigest: string }>,
  program: WaveGateInstallProgram,
) {
  return registerActiveWaveGate(manager, value(parseActiveWaveGateRegistration({
    schemaVersion: 1, kind: "active-wave-gate", wave: 1, revision: 0, terminalOutcome: null,
    runId: run.runId, runsRoot: run.runsRoot, authorityDigest: run.authorityDigest,
  })), program);
}

/** A genuine disposable v1 prefix, generated by the retained producer and protected install operation. */
async function legacyPrefix(p: ReturnType<typeof project>) {
  const handle = value(createRunDirectory(p.runsRoot, "run.legacy"));
  const manager = new StateManager(p.statePath);
  const initial = manager.load();
  const registered = { schemaVersion: 1 as const, kind: "wave-gate" as const, input: { wave: 1 }, taskIds: ["T1"],
    authorityDigest: waveGateAuthorityDigest(1, ["T1"], initial) };
  value(await handle.registerProgram(registered));
  await registerWaveGate(manager, { runId: handle.runId, runsRoot: p.runsRoot, authorityDigest: registered.authorityDigest },
    { taskIds: ["T1"] });
  return withFixturePiSession(p.root, async () => {
    const batch = waveRequests(
      handle,
      registered,
      manager.load(),
      1,
      { kind: "state-layout", root: p.root },
    );
    const published = await publishLegacyInitialBatch(handle, batch.requests, batch.packets, "wave-gate-current");
    if (!published.ok) throw new Error(published.message);
    await installWaveReviewRuns(manager, registered, batch);
    return { handle, action: published.action as Action };
  });
}
/**
 * A Wave Gate registered under `reviewerProtocol` exactly as `start` registers
 * one — program first, then protected active authority — and issued by the
 * real façade resume. With `REVIEWER_PROTOCOL_V2` it is a run registered
 * before ADR-0084, which keeps v2 until it ends.
 */
async function registeredPrefix(p: ReturnType<typeof project>, reviewerProtocol: ReviewerProtocolDescriptor) {
  const handle = value(createRunDirectory(p.runsRoot, "run.registered"));
  const manager = new StateManager(p.statePath);
  const taskIds = ["T1"];
  const registered = { schemaVersion: 2 as const, reviewerProtocol, kind: "wave-gate" as const, input: { wave: 1 }, taskIds,
    authorityDigest: waveGateAuthorityDigest(1, taskIds, manager.load()) };
  value(await handle.registerProgram(registered));
  await registerWaveGate(manager, { runId: handle.runId, runsRoot: p.runsRoot, authorityDigest: registered.authorityDigest },
    { taskIds });
  const action = await resume(p, handle);
  expect(action.kind, JSON.stringify(action)).toBe("spawn-batch");
  return { handle, action };
}

/** The issued Review Packet identity of a Task review request, read from its published packet. */
const identityOf = (handle: RunDirHandle, request: AgentRequestAuthority) =>
  issuedWavePacketIdentity(value(handle.readContext(request.contextDigest)));

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
    expect(issued.map(({ authority }) => authority.role)).toEqual(["spec-check-invoker", ...BASE_WAVE_REVIEW_AGENTS]);
    expect(registration(handle).reviewerProtocol).toEqual(WAVE_REVIEWER_PROTOCOL_V4);
    const run = graph(p).tasks[0]!.review_run!;
    expect(run.reviewer_protocol).toEqual(WAVE_REVIEWER_PROTOCOL_V4);
    for (const { authority } of issued.slice(1)) {
      expect(run.slot_authority!.find(({ agent }) => agent === authority.role)).toEqual({ agent: authority.role,
        slot_id: authority.slotId, attempted: 1, request_id: authority.requestId, context_digest: authority.contextDigest });
      const packet = value(handle.readContext(authority.contextDigest));
      expect(packet.schemaVersion).toBe(2);
      expect(Buffer.from(packet.fixedContext.find(({ label }) => label === "reviewer-payload-schema")!.bytes).toString()).toBe(WAVE_REVIEWER_PAYLOAD_SCHEMA_V4);
      expect(Buffer.from(packet.fixedContext.find(({ label }) => label === "reviewer-impact-rubric")!.bytes).toString()).toBe(REVIEWER_IMPACT_RUBRIC_V1);
      const sourceSection = packet.fixedContext.find(({ label }) => label === WAVE_FROZEN_SOURCE_SECTION)!;
      const source = value(parseWaveFrozenSource(JSON.parse(Buffer.from(sourceSection.bytes).toString("utf8"))));
      expect(source.taskId).toBe("T1");
      expect(source.workspaceHeadSha).toBe(run.workspace_head_sha);
      expect(source.files).toMatchObject([{ path: "src/x.ts", kind: "text", content: "export const x = 1;\n" }]);
      expect(value(reviewerProtocolResolver(handle, registration(handle))(authority))).toMatchObject({
        protocolVersion: 2, reviewerProtocol: WAVE_REVIEWER_PROTOCOL_V4 });
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
    expect(completed.accepted_review_authority?.reviewer_protocol).toEqual(WAVE_REVIEWER_PROTOCOL_V4);
    expect(completed.review_run).toBeUndefined();
    const before = readFileSync(p.statePath);
    expect(await resume(p, handle)).toEqual(final);
    expect(readFileSync(p.statePath)).toEqual(before);
  }, 60_000);

  it("FR-022: issues architecture-tech-lead last for a Task touching an owned family, carries the owner map to both owner-map roles, and completes only with all six reviewers", async () => {
    const p = project();
    await ownXFamily(p);
    const { handle, action } = await start(p);
    const issued = action.requests!;
    expect(issued.map(({ authority }) => authority.role)).toEqual(["spec-check-invoker", ...ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS]);
    const run = graph(p).tasks[0]!.review_run!;
    expect(run.expected_agents).toEqual(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS);
    expect(run.slot_authority!.map(({ agent }) => agent)).toEqual(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS);
    const architecture = issued.at(-1)!;
    // A valid Wave Reviewer Protocol v4 request, minted from the catalog: the
    // architecture reviewer's own profile and preloaded Skill.
    expect(architecture.authority).toMatchObject({ role: "architecture-tech-lead", program: "wave-gate", attempt: 1,
      modelProfile: "focused-review", requiredSkill: "deepen" });
    expect(architecture.task).toContain("LOOM_REQUIRED_SKILL: deepen");
    const ownerMapText = renderOwnerMapSection(join(p.root, "plan.md"), [OWNED_X]);
    for (const { authority } of issued.slice(1)) {
      const packet = value(handle.readContext(authority.contextDigest));
      expect(packet.schemaVersion, authority.role).toBe(2);
      expect(packet.fixedContext.some(({ label }) => label === "reviewer-payload-schema"), authority.role).toBe(true);
      const section = packet.fixedContext.find(({ label }) => label === OWNER_MAP_SECTION);
      const expected = authority.role === "code-reviewer" || authority.role === "architecture-tech-lead" ? ownerMapText : null;
      expect(section === undefined ? null : Buffer.from(section.bytes).toString("utf8"), authority.role).toBe(expected);
      expect(value(reviewerProtocolResolver(handle, registration(handle))(authority)), authority.role).toMatchObject({
        protocolVersion: 2, reviewerProtocol: WAVE_REVIEWER_PROTOCOL_V4 });
    }
    await capture(handle, issued[0]!.authority, specPass);
    for (const { authority } of issued.slice(1, -1)) {
      const step = await submit(p, handle, authority, payload(handle, authority));
      expect(step.kind, `${authority.role}: ${JSON.stringify(step)}`).not.toBe("done");
    }
    const final = await submit(p, handle, architecture.authority, payload(handle, architecture.authority));
    expect(final.kind, JSON.stringify(final)).toBe("done");
    expect(graph(p).tasks[0]!.review_run).toBeUndefined();
    const before = readFileSync(p.statePath);
    expect(await resume(p, handle)).toEqual(final);
    expect(readFileSync(p.statePath)).toEqual(before);
  }, 60_000);

  it("FR-022: a completed run's replay refuses an owner-mapped Task whose architecture-tech-lead protocol was never published", async () => {
    const p = project();
    const { handle, action } = await start(p);
    const issued = action.requests!;
    expect(issued.map(({ authority }) => authority.role)).toEqual(["spec-check-invoker", ...BASE_WAVE_REVIEW_AGENTS]);
    await capture(handle, issued[0]!.authority, specPass);
    let final: Action | undefined;
    for (const { authority } of issued.slice(1)) final = await submit(p, handle, authority, payload(handle, authority));
    expect(final?.kind, JSON.stringify(final)).toBe("done");
    // T1 now touches an owned family, so its derived roster is the six reviewers;
    // the completed run published only the base five.
    await new StateManager(p.statePath).update((locked) => ({ ...locked, owner_obligations: [OWNED_X] }));
    expect(await resume(p, handle)).toMatchObject({
      kind: "blocked",
      diagnostic: { message: expect.stringContaining("completed Wave Task T1 lacks the complete published reviewer protocol roster") },
    });
  }, 60_000);

  it("a completed run's replay refuses when a registered Task's roster can no longer be derived", async () => {
    const p = project();
    await ownXFamily(p);
    const { handle, action } = await start(p);
    const issued = action.requests!;
    await capture(handle, issued[0]!.authority, specPass);
    let final: Action | undefined;
    for (const { authority } of issued.slice(1)) final = await submit(p, handle, authority, payload(handle, authority));
    expect(final?.kind, JSON.stringify(final)).toBe("done");
    await new StateManager(p.statePath).update((locked) => ({
      ...locked,
      tasks: locked.tasks.map((task) => task.id === "T1" ? { ...task, id: "T2" } : task),
    }));
    expect(await resume(p, handle)).toMatchObject({
      kind: "blocked",
      diagnostic: { message: expect.stringContaining("completed Wave Gate roster cannot be derived: registered Wave Task T1 disappeared") },
    });
  }, 60_000);

  it("FR-022: an owner-mapped Task's Review Run bound to only the base five reviewers settles nothing: the roster is the Task's derived one", async () => {
    const p = project();
    await ownXFamily(p);
    const { handle, action } = await start(p);
    await new StateManager(p.statePath).update(toBaseFive);
    await capture(handle, action.requests![0]!.authority, specPass);
    for (const { authority } of action.requests!.slice(1, 1 + BASE_WAVE_REVIEW_AGENTS.length)) {
      await capture(handle, authority, payload(handle, authority));
    }
    const blocked = await resume(p, handle);
    expect(blocked).toMatchObject({ kind: "blocked", diagnostic: { message: expect.stringContaining("Task T1 active Review Run lacks engine-issued exact slot authority") } });
    expect(graph(p).tasks[0]!.review_run?.evidence).toEqual([]);
    expect(graph(p).tasks[0]!.review_status).not.toBe("passed");
  }, 30_000);

  it("FR-022: slot membership refuses a five-agent run against an owner-mapped Task's six-agent derived roster, and admits a plain Task's five", async () => {
    const membership = (handle: RunDirHandle, authority: AgentRequestAuthority, state: TaskGraph) => {
      const context = readWaveReviewContext([value(handle.readContext(authority.contextDigest))], authority.contextDigest);
      if (context.kind !== "loaded") throw new Error("expected issued Wave context");
      return waveReviewerSlotProblem(state, state.tasks[0]!, context.value, issuedWaveProtocol(handle, registration(handle), authority));
    };
    const owned = project();
    await ownXFamily(owned);
    const { handle, action } = await start(owned);
    const codeReviewer = action.requests!.find(({ authority }) => authority.role === "code-reviewer")!.authority;
    expect(membership(handle, codeReviewer, graph(owned))).toBeNull();
    expect(membership(handle, codeReviewer, toBaseFive(graph(owned))))
      .toBe("current reviewer protocol differs from protected workspace/request/context authority");

    const plain = project();
    const started = await start(plain, "run.plain");
    const plainReviewer = started.action.requests!.find(({ authority }) => authority.role === "code-reviewer")!.authority;
    expect(graph(plain).tasks[0]!.review_run!.expected_agents).toEqual(BASE_WAVE_REVIEW_AGENTS);
    expect(membership(started.handle, plainReviewer, graph(plain))).toBeNull();
  }, 30_000);

  it("FR-022: exhausted-run restart over an owner-mapped Task binds all six slots, and refuses a five-agent run", async () => {
    const p = project();
    await ownXFamily(p);
    const { handle } = await start(p);
    const exhausted = (state: TaskGraph): TaskGraph => ({ ...state, tasks: state.tasks.map((task) => {
      const run = task.review_run;
      if (run?.reviewer_protocol === undefined) throw new Error("fixture must have a genuine installed current run");
      const [first, ...rest] = run.slot_authority;
      return { ...task, review_run: { ...run, slot_authority: [{ ...first, attempted: 2 as const },
        ...rest.map((slot) => ({ ...slot, attempted: 2 as const }))] } };
    }) });
    const state = exhausted(graph(p));
    const keys = new Set(state.tasks[0]!.review_run!.slot_authority!.map(({ slot_id }) => captureKey(slot_id, 2)));
    const restarted = prepareExhaustedWaveGateRestart(state, handle.runId, registration(handle), "run.next", p.runsRoot, keys, NO_CARRY_OBSERVED);
    if (!restarted.ok) throw new Error(restarted.message);
    expect(restarted.value.registration.restart?.exhaustedSlots)
      .toEqual(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS.map((agent) => `T1/${agent}`));
    expect(prepareExhaustedWaveGateRestart(toBaseFive(state), handle.runId, registration(handle), "run.next", p.runsRoot, keys, NO_CARRY_OBSERVED))
      .toEqual({ ok: false, message: "task T1 Review Packet is not bound to the active epoch and exact reviewer roster" });
  }, 30_000);

  it("ADR-0084: a freshly started Wave Gate registers v4, issues every Task review packet under it and tells each reviewer the v4 envelope", async () => {
    const p = project(mixedPriors());
    const { handle, action } = await start(p);
    const issued = action.requests!;
    expect(registration(handle).reviewerProtocol).toEqual(WAVE_REVIEWER_PROTOCOL_V4);
    expect(graph(p).tasks[0]!.review_run!.reviewer_protocol).toEqual(WAVE_REVIEWER_PROTOCOL_V4);
    const [specCheck, ...reviewers] = issued;
    expect(specCheck!.task).not.toContain(WAVE_V4_PAYLOAD_LINE);
    expect(reviewers).toHaveLength(BASE_WAVE_REVIEW_AGENTS.length);
    for (const { authority, task } of reviewers) {
      const packet = value(handle.readContext(authority.contextDigest));
      if (packet.schemaVersion !== 2) throw new Error(`${authority.role} packet must be a schema-2 reviewer packet`);
      // The layout stays schema 2; the descriptor's version selects the v4 decoder.
      expect(packet.reviewerProtocol, authority.role).toEqual(WAVE_REVIEWER_PROTOCOL_V4);
      expect(Buffer.from(packet.fixedContext.find(({ label }) => label === "reviewer-payload-schema")!.bytes).toString(), authority.role)
        .toBe(WAVE_REVIEWER_PAYLOAD_SCHEMA_V4);
      expect(task, authority.role).toContain(WAVE_V4_PAYLOAD_LINE);
      expect(task, authority.role).not.toContain(reviewerPayloadKindLine(false));
      const descriptor = parseEmissionDescriptor(task);
      expect(descriptor, authority.role).toMatchObject({ kind: "issued", binding: { requestId: authority.requestId, version: "v4" } });
    }
  }, 30_000);

  it("ADR-0084: a v4 reviewer that copies packetId is refused naming the v4 envelope, and the identity-free payload is admitted bound to the issued packet", async () => {
    const priors = mixedPriors();
    const p = project(priors);
    const { handle, action } = await start(p);
    const [specCheck, first, ...siblings] = action.requests!;
    await capture(handle, specCheck!.authority, specPass);
    for (const { authority } of siblings) await submit(p, handle, authority, payload(handle, authority, [], "still_present"));
    const packet = value(handle.readContext(first!.authority.contextDigest));
    const context = readWaveReviewContext([packet], packet.digest);
    if (context.kind !== "loaded" || context.value.task === null) throw new Error("expected issued Task context");
    const identity = issuedWavePacketIdentity(packet);
    const body = { prior_findings: context.value.task.priorFindings.map(({ id }) =>
      ({ finding_id: id, verdict: "still_present", reason: "the issued packet still shows it" })), findings: [] };

    // The decoder itself: the copied identity is refused and the diagnostic names the whole v4 envelope.
    const issuedFirst = issuedWaveProtocol(handle, registration(handle), first!.authority);
    const copied = parseReviewerEvidence(issuedFirst, Buffer.from(waveReviewerPayloadV4WithIdentity(identity, body)));
    expect(copied.ok).toBe(false);
    if (copied.ok) throw new Error("unreachable");
    expect(copied.error.message).toContain(WAVE_V4_ENVELOPE_HINT);
    expect(parseReviewerEvidence(issuedFirst, Buffer.from(waveReviewerPayload({ version: 2, identity, body }))).ok).toBe(false);
    const admitted = parseReviewerEvidence(issuedFirst, Buffer.from(waveReviewerPayload({ version: 4, body })));
    if (!admitted.ok || admitted.value.kind !== "wave-review") throw new Error(`expected admitted Wave evidence: ${JSON.stringify(admitted)}`);
    expect(admitted.value.bound).toMatchObject(identity);

    // Through the façade: attempt 1 is refused and the retry carries the envelope diagnostic.
    const retried = await submit(p, handle, first!.authority, waveReviewerPayloadV4WithIdentity(identity, body));
    expect(retried.kind, JSON.stringify(retried)).toBe("spawn-batch");
    expect(retried.requests).toHaveLength(1);
    const retry = retried.requests![0]!;
    expect(retry.authority).toMatchObject({ slotId: first!.authority.slotId, attempt: 2 });
    expect(retry.task).toContain("Parser rejection reason: ");
    // The retry renders the parser's reason as a JSON string literal (byte-exact revalidation), so its quotes arrive escaped.
    expect(retry.task).toContain(JSON.stringify(WAVE_V4_ENVELOPE_HINT).slice(1, -1));
    expect(retry.task).toContain(WAVE_V4_PAYLOAD_LINE);
    expect(graph(p).tasks[0]!.review_run?.evidence).toHaveLength(siblings.length);

    // The identity-free v4 payload on the final attempt is admitted and completes the roster.
    expect(identityOf(handle, retry.authority)).toEqual(identity);
    const done = await submit(p, handle, retry.authority, waveReviewerPayload({ version: 4, body }));
    expect(done.kind, JSON.stringify(done)).not.toBe("blocked");
    const settled = graph(p).tasks[0]!;
    expect(settled.review_run).toBeUndefined();
    expect(settled.accepted_review_authority).toMatchObject({ packet_id: identity.packetId, generation: identity.generation,
      reviewer_protocol: WAVE_REVIEWER_PROTOCOL_V4 });
  }, 60_000);

  it("ADR-0084: restarting an exhausted v2-registered Wave Gate registers the replacement under v4", async () => {
    const p = project();
    const { handle } = await start(p);
    // The same run as it stood when Wave Gates registered v2: its registration and its Review Run carry the v2 descriptor.
    const current = registration(handle);
    if (current.schemaVersion !== 2) throw new Error("a started Wave Gate registers schema 2");
    const v2Registration = { ...current, reviewerProtocol: REVIEWER_PROTOCOL_V2 };
    const exhaustedV2 = (state: TaskGraph): TaskGraph => ({ ...state, tasks: state.tasks.map((task) => {
      const run = task.review_run;
      if (run?.reviewer_protocol === undefined) throw new Error("fixture must have a genuine installed current run");
      const [first, ...rest] = run.slot_authority;
      return { ...task, review_run: { ...run, reviewer_protocol: REVIEWER_PROTOCOL_V2,
        slot_authority: [{ ...first, attempted: 2 as const }, ...rest.map((slot) => ({ ...slot, attempted: 2 as const }))] } };
    }) });
    const state = exhaustedV2(graph(p));
    const keys = new Set(state.tasks[0]!.review_run!.slot_authority!.map(({ slot_id }) => captureKey(slot_id, 2)));
    const restarted = prepareExhaustedWaveGateRestart(state, handle.runId, v2Registration, "run.next", p.runsRoot, keys, NO_CARRY_OBSERVED);
    if (!restarted.ok) throw new Error(restarted.message);
    expect(restarted.value.registration).toMatchObject({ schemaVersion: 2, reviewerProtocol: WAVE_REVIEWER_PROTOCOL_V4,
      restart: { previousRunId: handle.runId, exhaustedSlots: BASE_WAVE_REVIEW_AGENTS.map((agent) => `T1/${agent}`) } });
  }, 30_000);

  it("ADR-0084: a v2-registered Wave Gate keeps v2 until it ends: it refuses the v4 payload and admits the v2 one", async () => {
    const p = project(mixedPriors());
    const { handle, action } = await registeredPrefix(p, REVIEWER_PROTOCOL_V2);
    expect(registration(handle).reviewerProtocol).toEqual(REVIEWER_PROTOCOL_V2);
    expect(graph(p).tasks[0]!.review_run!.reviewer_protocol).toEqual(REVIEWER_PROTOCOL_V2);
    const [specCheck, first, ...siblings] = action.requests!;
    for (const { authority, task } of [first!, ...siblings]) {
      const packet = value(handle.readContext(authority.contextDigest));
      if (packet.schemaVersion !== 2) throw new Error("expected a schema-2 reviewer packet");
      expect(packet.reviewerProtocol, authority.role).toEqual(REVIEWER_PROTOCOL_V2);
      expect(task, authority.role).not.toContain(WAVE_V4_PAYLOAD_LINE);
      expect(task, authority.role).toContain(reviewerPayloadKindLine(false));
    }
    await capture(handle, specCheck!.authority, specPass);
    for (const { authority } of siblings) await submit(p, handle, authority, payload(handle, authority, [], "still_present"));
    const identity = identityOf(handle, first!.authority);
    const priorIds = graph(p).tasks[0]!.review_run!.prior_finding_ids;
    const body = { prior_findings: priorIds.map((finding_id) => ({ finding_id, verdict: "still_present", reason: "still present" })), findings: [] };
    const retried = await submit(p, handle, first!.authority, waveReviewerPayload({ version: 4, body }));
    expect(retried.kind, JSON.stringify(retried)).toBe("spawn-batch");
    const retry = retried.requests![0]!;
    expect(retry.authority).toMatchObject({ slotId: first!.authority.slotId, attempt: 2 });
    expect(retry.task).toContain("Parser rejection reason: ");
    // The v2 run's attempt 2 is decoded by v2 exactly as before: the echoed identity is required.
    expect(await submit(p, handle, retry.authority, waveReviewerPayload({ version: 2, identity, body }))).not.toMatchObject({ kind: "blocked" });
    expect(graph(p).tasks[0]!.review_run).toBeUndefined();
    expect(graph(p).tasks[0]!.accepted_review_authority?.reviewer_protocol).toEqual(REVIEWER_PROTOCOL_V2);
  }, 60_000);

  it("ADR-0069: issues architecture-tech-lead last for a Contract Task writing a types file, and carries the contract surface to both surface roles", async () => {
    const p = project([], X_CONTRACT_FILES);
    await contractWave(p);
    const { handle, action } = await start(p);
    const issued = action.requests!;
    expect(issued.map(({ authority }) => authority.role)).toEqual(["spec-check-invoker", ...ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS]);
    const run = graph(p).tasks[0]!.review_run!;
    expect(run.expected_agents).toEqual(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS);
    expect(run.slot_authority!.map(({ agent }) => agent)).toEqual(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS);
    expect(issued.at(-1)!.authority).toMatchObject({ role: "architecture-tech-lead", modelProfile: "focused-review", requiredSkill: "deepen" });
    const surfaceText = renderContractSurfaceSection(join(p.root, "plan.md"), [{
      contract: { id: X_CONTRACT.id, title: X_CONTRACT.title, statement: X_CONTRACT.statement }, typesFile: X_SURFACE.types, bindings: [],
    }]);
    for (const { authority } of issued.slice(1)) {
      const section = value(handle.readContext(authority.contextDigest)).fixedContext
        .find(({ label }) => label === CONTRACT_SURFACE_SECTION);
      const expected = isContractSurfaceRole(authority.role) ? surfaceText : null;
      expect(section === undefined ? null : Buffer.from(section.bytes).toString("utf8"), authority.role).toBe(expected);
    }
    expect(await resume(p, handle)).toMatchObject({ kind: "spawn-batch" });
  }, 30_000);

  // A contract stamped after the Wave's completion suite ran changes what the
  // gate owes that contract: the suite's recorded acceptance expectation no
  // longer matches, so the five-agent run settles nothing (ADR-0098: every
  // execute graph carries a manifest, so no gate runs without the suite).
  it("ADR-0069: a contract stamped after the Wave's completion suite ran conflicts with its acceptance expectation and settles nothing", async () => {
    const p = project([], X_CONTRACT_FILES);
    const { handle, action } = await start(p);
    const issued = action.requests!;
    expect(graph(p).tasks[0]!.review_run!.expected_agents).toEqual(BASE_WAVE_REVIEW_AGENTS);
    await new StateManager(p.statePath).update(asContractTask);
    await capture(handle, issued[0]!.authority, specPass);
    const first = issued[1]!.authority;
    expect(await submit(p, handle, first, payload(handle, first))).toMatchObject({
      kind: "blocked",
      diagnostic: { kind: "wave-completion-suite-blocked", message: expect.stringContaining("acceptance-expectation-mismatch") },
    });
    const unsettled = graph(p).tasks[0]!;
    expect(unsettled.review_run?.expected_agents).toEqual(BASE_WAVE_REVIEW_AGENTS);
    expect(unsettled.review_run?.evidence.map(({ agent }) => agent)).toEqual(["code-reviewer"]);
    expect(unsettled.review_status).not.toBe("passed");
  }, 60_000);

  it("re-anchors the completed Wave's claim hashes to the spec text its spec-check reviewed", async () => {
    const p = project();
    // Claim-time hashes for text that has since been rewritten: the Wave is
    // reviewed against the current spec, so completion must record that text.
    const stale = "0".repeat(64);
    await new StateManager(p.statePath).update((locked) => ({ ...locked, tasks: locked.tasks.map((task) =>
      ({ ...task, spec_anchor_hashes: { "FR-001": stale, "AS-001": stale } })) }));
    const { handle, action } = await start(p);
    await capture(handle, action.requests![0]!.authority, specPass);
    for (const { authority } of action.requests!.slice(1)) await capture(handle, authority, payload(handle, authority));
    const done = await resume(p, handle);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    const reviewed = parseSpec(specText);
    if (!reviewed.ok) throw new Error("fixture spec must parse");
    expect(graph(p).tasks[0]!.spec_anchor_hashes).toEqual(recordedAnchorHashes(reviewed.value, ["FR-001", "AS-001"]));
    const before = readFileSync(p.statePath);
    expect(await resume(p, handle)).toEqual(done);
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
    // The issued v4 envelope without its required prior roster: whole-payload malformed.
    const malformed = JSON.stringify({ schemaVersion: 4, kind: "wave-review", findings: [criticalDraft] });
    const retried = await submit(p, handle, first, malformed);
    expect(retried.kind, JSON.stringify(retried)).toBe("spawn-batch");
    expect(retried.requests).toHaveLength(1);
    const retry = retried.requests![0]!;
    expect(retry.authority.attempt).toBe(2);
    // Under the Pi parent the retry keeps the emission route: after the
    // parser's rejection reason it closes with the fresh-budget tool-primary
    // instruction its own descriptor names — never the extraction wording or
    // the archived v1 lifecycle schema.
    const retryDescriptor = parseEmissionDescriptor(retry.task);
    if (retryDescriptor.kind !== "issued") throw new Error("a Pi-parented current Wave retry must carry an issued descriptor");
    expect(retryDescriptor).toMatchObject({ contextDigest: retry.authority.contextDigest,
      binding: { requestId: retry.authority.requestId, version: "v4" } });
    expect(retry.task).toContain("Parser rejection reason: ");
    expect(retry.task).toContain(reviewerRetryInstruction({ kind: "emission", binding: retryDescriptor.binding, contextDigest: retryDescriptor.contextDigest }));
    expect(retry.task).not.toContain(REVIEWER_EXTRACTION_RETRY_INSTRUCTION);
    expect(retry.task).not.toContain("review_lifecycle block");
    const task = graph(p).tasks[0]!;
    expect(task.findings).toEqual([]);
    expect(task.review_run?.evidence).toHaveLength(4);
    expect(task.review_run?.slot_authority?.find(({ agent }) => agent === first.role)).toEqual({ agent: first.role,
      slot_id: first.slotId, attempted: 2, request_id: retry.authority.requestId, context_digest: retry.authority.contextDigest });
    const firstPacket = value(handle.readContext(first.contextDigest));
    const secondPacket = value(handle.readContext(retry.authority.contextDigest));
    expect(secondPacket.fixedContext).toEqual(firstPacket.fixedContext);
    const firstSource = firstPacket.fixedContext.find(({ label }) => label === WAVE_FROZEN_SOURCE_SECTION)!;
    const retrySource = secondPacket.fixedContext.find(({ label }) => label === WAVE_FROZEN_SOURCE_SECTION)!;
    expect(retrySource.digest).toBe(firstSource.digest);
    expect(retrySource).toEqual(firstSource);
    expect(persistedWaveAttemptTwoCompatibilityProblem(first, retry.authority, firstPacket, secondPacket)).toBeNull();
    expect(await resume(p, handle)).toEqual(retried);
    const awaiting = await submit(p, handle, retry.authority, payload(handle, retry.authority, [advisory]));
    expect(awaiting.kind, JSON.stringify(awaiting)).toBe("await-user");
    expect(graph(p).tasks[0]!.findings).toMatchObject([{ ...advisory, protocolVersion: 2 }]);
    expect(value(handle.readTranscriptBytes(requests[2]!.authority))).toEqual(sibling);
    expect(await resume(p, handle)).toEqual(awaiting);
    // Approval needs a disposition on every advisory the request issued (ADR-0090).
    const advised = graph(p).tasks[0]!;
    await runCli(p, ["disposition"], JSON.stringify({ dispositions: [
      { finding: `${advised.id}:${advised.findings![0]!.id}`, decision: "dismissed", reason: "scripted fixture advice" },
    ] }));
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
        const published = await publishLegacyInitialBatch(handle, [retry.request], [retry.packet], `wave-gate-retry:${authority.slotId}`);
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
      // The sealed Subject Digest is current-only authority too (ADR-0091), so it goes with the descriptor.
      const { reviewer_protocol: _removed, subject_digest: _sealed, ...missing } = accepted;
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

  it.each(["missing", "ambiguous", "marker-only"] as const)("terminal-blocks %s final payload retries and carries accepted current evidence on exhausted restart without resolving partial priors", async (mode) => {
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
    // ADR-0089: only spec-check and the exhausted slot are reissued; the four
    // accepted slots carry their evidence by reference, unfolded, so the prior
    // roster the reissued reviewer assesses is the one its siblings assessed.
    expect(restarted.requests?.map(({ authority }) => authority.role)).toEqual(["spec-check-invoker", requests[1]!.authority.role]);
    const preserved = graph(p).tasks[0]!;
    expect(preserved.findings).toEqual(priors);
    expect(preserved.resolved_findings ?? []).toEqual([]);
    expect(preserved.review_run?.reviewer_protocol).toEqual(WAVE_REVIEWER_PROTOCOL_V4);
    expect(preserved.review_run?.prior_finding_ids).toEqual(priors.map(({ id }) => id));
    const carriedFindings: readonly DraftFinding[] = (preserved.review_run?.evidence ?? [])
      .flatMap(({ new_findings }): readonly DraftFinding[] => new_findings);
    expect(carriedFindings).toMatchObject([{ ...criticalDraft, protocolVersion: 2 }, { ...advisory, protocolVersion: 2 }]);
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

// ---------------------------------------------------------------------------
// ADR-0089 (loom#213 Cause 1b): a restart reissues only the exhausted slots.
// ---------------------------------------------------------------------------

describe("Wave Gate restart carries accepted review evidence", () => {
  const carriedCritical: ReviewerDraftV2 = { ...criticalDraft, file: "src/y.ts", claim: "carried critical on y" };

  /** Run A exhausted, then restarted through the façade. */
  async function exhaustedThenRestarted() {
    const run = await exhausted();
    const restarted = await runCli(run.p, ["restart", "--runs-root", run.p.runsRoot, "--run", run.previous.runId, "--new-run", "run.restarted"]);
    return { ...run, restarted, next: value(openRunDirectory(run.p.runsRoot, "run.restarted")) };
  }

  /**
   * The restart's crash window: the replacement is registered and its carry
   * plan committed to protected state, but no resume has installed its batch.
   * That is exactly what `orchestration restart` commits before it resumes.
   */
  async function restartedBeforeFirstResume() {
    const { p, previous } = await exhausted();
    const before = graph(p);
    const carried = value(observeRestartCarry(previous, before, registration(previous), p.root));
    const exhaustedKeys = new Set(before.tasks.flatMap(({ review_run: run }) => (run?.slot_authority ?? [])
      .filter((slot) => slot.attempted === 2 && !run!.evidence.some(({ agent }) => agent === slot.agent))
      .map(({ slot_id }) => captureKey(slot_id, 2))));
    const next = value(createRunDirectory(p.runsRoot, "run.restarted"));
    const prepared = value(prepareExhaustedWaveGateRestart(
      before, previous.runId, registration(previous), next.runId, next.identity.runsRoot, exhaustedKeys, carried));
    expect(prepared.registration.restart?.carry?.carried.map(({ kind, taskId }) => [kind, taskId]))
      .toEqual([["accepted-task", "T1"], ["accepted-slots", "T2"]]);
    value(await next.registerProgram(prepared.registration));
    await new StateManager(p.statePath).update(() => prepared.graph);
    return { p, next };
  }

  /** Run A: T1 accepts every slot; T2 accepts all but its third reviewer, whose attempt 2 exhausts. */
  async function exhausted() {
    const p = project([], ["src/x.ts"], true);
    const { handle, action } = await start(p);
    const [specCheck, ...reviewers] = action.requests!;
    const t1 = reviewers.slice(0, BASE_WAVE_REVIEW_AGENTS.length);
    const t2 = reviewers.slice(BASE_WAVE_REVIEW_AGENTS.length);
    expect(t2).toHaveLength(BASE_WAVE_REVIEW_AGENTS.length);
    await capture(handle, specCheck!.authority, specPass);
    for (const { authority } of t1) await submit(p, handle, authority, payload(handle, authority));
    expect(graph(p).tasks[0]!.accepted_review_authority?.run_id).toBe(handle.runId);
    const exhausted = t2[2]!.authority;
    for (const [index, { authority }] of t2.entries()) {
      if (authority.requestId === exhausted.requestId) continue;
      await submit(p, handle, authority, payload(handle, authority, index === 0 ? [carriedCritical] : []));
    }
    const packetA = graph(p).tasks[1]!.review_run!.packet_id;
    value(await handle.rejectCapture(exhausted, "capture failed before its journal append"));
    const retry = await resume(p, handle);
    expect(retry.requests).toHaveLength(1);
    value(await handle.rejectCapture(retry.requests![0]!.authority, "capture failed before its journal append"));
    expect(await resume(p, handle)).toMatchObject({ kind: "blocked", diagnostic: { message: expect.stringContaining("attempt 2 exhausted") } });
    return { p, previous: handle, exhausted, packetA };
  }

  /** Accept the replacement's spec-check and its one reissued slot. */
  async function settleReplacement(p: ReturnType<typeof project>, next: RunDirHandle, restarted: Action): Promise<Action> {
    const [specCheck, reissued] = restarted.requests!;
    await capture(next, specCheck!.authority, specPass);
    return submit(p, next, reissued!.authority, payload(next, reissued!.authority));
  }

  it("restart reissues only spec-check and the exhausted slot, carries every accepted slot by reference, and completes after one capture", async () => {
    const { p, previous, exhausted, packetA, restarted, next } = await exhaustedThenRestarted();
    expect(restarted.kind, JSON.stringify(restarted)).toBe("spawn-batch");
    expect(restarted.requests?.map(({ authority }) => [authority.role, authority.runId, authority.attempt])).toEqual([
      ["spec-check-invoker", "run.restarted", 1], [exhausted.role, "run.restarted", 1],
    ]);
    const accepted = BASE_WAVE_REVIEW_AGENTS.filter((agent) => agent !== exhausted.role);
    const previousDigest = registration(previous).authorityDigest;
    expect(registration(next).restart?.carry).toEqual({
      lineage: [{ runId: previous.runId, authorityDigest: previousDigest }],
      carried: [
        { kind: "accepted-task", taskId: "T1", roster: BASE_WAVE_REVIEW_AGENTS, acceptance: { runId: previous.runId, authorityDigest: previousDigest } },
        { kind: "accepted-slots", taskId: "T2", agents: accepted },
      ],
    });
    const rebound = graph(p);
    // T1 is not reissued: its acceptance stays the one run A recorded.
    expect(rebound.tasks[0]!.review_run).toBeUndefined();
    expect(rebound.tasks[0]!.accepted_review_authority?.run_id).toBe(previous.runId);
    // T2's accepted slots keep run A's slot/request/context identity plus provenance; the exhausted one is fresh.
    const run = rebound.tasks[1]!.review_run!;
    expect(run.wave_gate_run_id).toBe("run.restarted");
    expect(run.evidence.map(({ agent }) => agent)).toEqual(accepted);
    for (const slot of run.slot_authority ?? []) {
      if (slot.agent === exhausted.role) {
        expect(slot).toEqual({ agent: exhausted.role, slot_id: restarted.requests![1]!.authority.slotId, attempted: 1,
          request_id: restarted.requests![1]!.authority.requestId, context_digest: restarted.requests![1]!.authority.contextDigest });
      } else {
        expect(slot).toMatchObject({ carried_from: { run_id: previous.runId, authority_digest: previousDigest, packet_id: packetA } });
        expect(value(previous.readIssuedRequests()).some(({ slotId, requestId }) => slotId === slot.slot_id && requestId === slot.request_id)).toBe(true);
      }
    }
    // Resume replays the same two requests and writes nothing.
    const before = readFileSync(p.statePath);
    expect((await resume(p, next)).requests?.map(({ authority }) => authority.requestId))
      .toEqual(restarted.requests!.map(({ authority }) => authority.requestId));
    expect(readFileSync(p.statePath)).toEqual(before);

    // Abandoning the replacement now would fold the carried evidence under the Review Packet that issued it.
    const folded = supersedeAbandonedWaveGateReview(rebound, "run.restarted", ["T1", "T2"]);
    expect(folded.tasks[1]!.findings).toMatchObject([{ claim: carriedCritical.claim, review_packet_id: packetA }]);

    // One capture closes T2's roster; its carried critical goes to the Refutation Panel of the replacement run.
    const panel = await settleReplacement(p, next, restarted);
    expect(panel.kind, JSON.stringify(panel)).toBe("spawn-batch");
    const settled = graph(p).tasks[1]!;
    expect(settled.accepted_review_authority?.run_id).toBe("run.restarted");
    expect(settled.findings).toMatchObject([{ claim: carriedCritical.claim, review_packet_id: packetA }]);
    for (const [index, { authority }] of panel.requests!.entries()) {
      expect(authority).toMatchObject({ role: "review-verifier-agent", runId: "run.restarted" });
      const material = JSON.parse(Buffer.from(value(next.readContext(authority.contextDigest)).fixedContext
        .find(({ label }) => label === "wave-refutation-authority")!.bytes).toString()) as { lens: string; findings: readonly { id: string; claim: string }[] };
      expect(material.findings.map(({ claim }) => claim)).toEqual([carriedCritical.claim]);
      await capture(next, authority, JSON.stringify({ criterion: material.lens,
        verdicts: material.findings.map(({ id }) => ({ finding_id: id, verdict: index < 2 ? "refuted" : "upheld", reasoning: "asserted precondition does not hold" })) }));
    }
    const done = await resume(p, next);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    // A completed replay accepts the carried subjects as published along the lineage.
    expect(await resume(p, next)).toEqual(done);
  }, 120_000);

  it.each([
    ["a whole-roster acceptance", "x.ts", "Task T1 cannot keep the acceptance its restart carried from run run.current: drift in head, subject"],
    ["carried slots", "y.ts", "Task T2 carried review evidence no longer judges it: drift in head, subject"],
  ])("the first install refuses %s whose reviewed bytes changed after the restart, and writes no review state", async (_label, file, refusal) => {
    const { p, next } = await restartedBeforeFirstResume();
    writeFileSync(join(p.root, "src", file), `export const ${file.replace(".ts", "")} = 3;\n`);
    const before = readFileSync(p.statePath);
    expect(await resume(p, next)).toMatchObject({ kind: "blocked", diagnostic: { message: `internal Wave Gate failure: ${refusal}` } });
    expect(withoutCompletionSuite(readFileSync(p.statePath))).toEqual(withoutCompletionSuite(before));
  }, 120_000);

  it("a restart names each reviewed Task it does not carry, and why, on its output", async () => {
    const { p, previous } = await exhausted();
    writeFileSync(join(p.root, "src", "y.ts"), "export const y = 3;\n");
    const restarted = await cliResult(p, ["restart", "--runs-root", p.runsRoot, "--run", previous.runId, "--new-run", "run.restarted"]);
    expect(restarted.status, restarted.stderr).toBe(0);
    const reported = restarted.stderr.split("\n").flatMap((line) => {
      try { return [JSON.parse(line) as unknown]; } catch { return []; }
    });
    expect(reported).toContainEqual({ kind: "wave-gate-restart-not-carried", runId: "run.restarted",
      notCarried: [{ taskId: "T2", reason: { kind: "drift", fields: ["head", "subject"] } }] });
    // T2 is issued in full; T1 still carries.
    expect((JSON.parse(restarted.stdout) as Action).requests?.map(({ authority }) => authority.role))
      .toEqual(["spec-check-invoker", ...BASE_WAVE_REVIEW_AGENTS]);
    expect(registration(value(openRunDirectory(p.runsRoot, "run.restarted"))).restart?.carry?.carried.map(({ taskId }) => taskId))
      .toEqual(["T1"]);
  }, 120_000);

  it("a restart that carries nothing issues exactly the batch it always did; a carry plan enters the epoch", async () => {
    const p = project([], ["src/x.ts"], true);
    const { handle } = await start(p);
    const current = registration(handle);
    if (current.schemaVersion !== 2) throw new Error("a started Wave Gate registers schema 2");
    const batchFor = (program: RegisteredWaveGateProgram) => withFixturePiSession(p.root, async () =>
      waveRequests(handle, program, graph(p), 1, { kind: "state-layout", root: p.root }));
    const plain = await batchFor(current);
    const restartedWithoutCarry = await batchFor(withOrigin(current, { restart: { previousRunId: "run.previous", exhaustedSlots: ["T2/code-reviewer"] } }));
    expect(restartedWithoutCarry.batchEpoch).toBe(plain.batchEpoch);
    expect(restartedWithoutCarry.requests.map(({ authority }) => [authority.slotId, authority.requestId]))
      .toEqual(plain.requests.map(({ authority }) => [authority.slotId, authority.requestId]));
    const acceptance = { runId: "run.previous", authorityDigest: "c".repeat(64) };
    const carrying = await batchFor(withOrigin(current, { restart: { previousRunId: "run.previous", exhaustedSlots: ["T2/code-reviewer"],
      carry: { lineage: [acceptance], carried: [{ kind: "accepted-task", taskId: "T1", roster: BASE_WAVE_REVIEW_AGENTS, acceptance }] } } }));
    expect(carrying.batchEpoch).not.toBe(plain.batchEpoch);
    expect(carrying.subjects).toEqual([{ role: "spec-check-invoker", taskId: null },
      ...BASE_WAVE_REVIEW_AGENTS.map((role) => ({ role, taskId: "T2" }))]);
    expect(carrying.taskRuns.map(({ taskId }) => taskId)).toEqual(["T2"]);
  }, 60_000);

  it("completion refuses a carried acceptance forged outside the recorded restart lineage", async () => {
    const { p, restarted, next } = await exhaustedThenRestarted();
    await new StateManager(p.statePath).update((locked) => ({ ...locked, tasks: locked.tasks.map((task) => {
      const accepted = task.accepted_review_authority;
      return task.id === "T1" && accepted?.reviewer_protocol !== undefined
        ? { ...task, accepted_review_authority: { ...accepted, run_id: "run.forged" } } : task;
    }) }));
    const settled = await settleReplacement(p, next, restarted);
    const blocked = settled.kind === "blocked" ? settled : await resume(p, next);
    expect(blocked).toMatchObject({ kind: "blocked", diagnostic: {
      message: expect.stringContaining("Task T1 acceptance from run run.forged is neither this run's nor carried along its recorded lineage"),
    } });
  }, 120_000);
});

// ---------------------------------------------------------------------------
// ADR-0091 (loom#213 Cause 5): a fresh Wave Gate start carries the accepted
// reviews of unchanged Tasks from the run it succeeds.
// ---------------------------------------------------------------------------

describe("a fresh Wave Gate start carries unchanged Tasks' accepted reviews", () => {
  const SIX = ["T1", "T2", "T3", "T4", "T5", "T6"] as const;
  const fileOfTask = (id: string) => `src/${id.toLowerCase()}.ts`;
  const advisoryOn = (id: string): ReviewerDraftV2 => ({ ...advisory, file: fileOfTask(id), claim: ` advisory on ${id} ` });

  /** A six-Task Wave 1 over one file each, all implemented. */
  function sixTaskProject() {
    const p = project();
    for (const id of SIX) writeFileSync(join(p.root, fileOfTask(id)), `export const ${id.toLowerCase()} = 1;\n`);
    git(p.root, ["add", "src"]);
    git(p.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "six"]);
    const tasks = SIX.map((id) => implementedTask(id, [fileOfTask(id)], fileOfTask(id),
      id === "T1" ? { spec_anchors: ["FR-001", "AS-001"], spec_contributions: [] } : { spec_anchors: [], spec_contributions: ["FR-001"] }));
    const state: TaskGraph = { ...graphFixture(tasks), spec_file: join(p.root, "spec.md"), plan_file: join(p.root, "plan.md"), spec_trace_version: 2 };
    writeFileSync(p.statePath, JSON.stringify(value(parseTaskGraph(state))));
    return p;
  }

  /** The advisory round behind #213: every roster accepted, T1 and T6 each left one advisory, then abandoned. */
  async function abandonedAdvisoryRound() {
    const p = sixTaskProject();
    const { handle, action } = await start(p, "run.first");
    const [specCheck, ...reviewers] = action.requests!;
    expect(reviewers).toHaveLength(SIX.length * BASE_WAVE_REVIEW_AGENTS.length);
    await capture(handle, specCheck!.authority, specPass);
    for (const [index, { authority }] of reviewers.entries()) {
      const taskId = SIX[Math.floor(index / BASE_WAVE_REVIEW_AGENTS.length)]!;
      const first = index % BASE_WAVE_REVIEW_AGENTS.length === 0;
      await capture(handle, authority, payload(handle, authority, first && (taskId === "T1" || taskId === "T6") ? [advisoryOn(taskId)] : []));
    }
    const awaiting = await resume(p, handle);
    expect(awaiting.kind, JSON.stringify(awaiting)).toBe("await-user");
    expect(graph(p).tasks.map(({ accepted_review_authority }) => accepted_review_authority?.run_id)).toEqual(SIX.map(() => "run.first"));
    // The operator decides both advisories at the pause, after the acceptances (ADR-0090):
    // T1's is deferred over its unchanged bytes, T6's is to be fixed.
    const [t1, , , , , t6] = graph(p).tasks;
    await runCli(p, ["disposition"], JSON.stringify({ dispositions: [
      { finding: `T1:${t1!.findings![0]!.id}`, decision: "deferred", reason: "belongs to a later Wave", target: "Wave 2" },
      { finding: `T6:${t6!.findings![0]!.id}`, decision: "fixed", reason: "reopening T6 to fix it" },
    ] }));
    const abandoned = await cliResult(p, ["abandon", "--runs-root", p.runsRoot, "--run", "run.first", "--reason", "fix T6's advisory"]);
    expect(abandoned.status, abandoned.stderr).toBe(0);
    return p;
  }

  /** `reopen-task <id>`, then the Task re-implemented over `content`, as its brief would. */
  async function reopenAndReimplement(p: ReturnType<typeof project>, id: string, content: string) {
    const request = value(parseTaskReopeningArgs(["--wave", "1", "--task", id, "--reason", "fix the advisory"]));
    await new StateManager(p.statePath).update((locked) => {
      const reopened = reopenImplementedTasks(locked, request);
      if (!reopened.ok || reopened.value.kind !== "reopened") throw new Error(JSON.stringify(reopened));
      return reopened.value.graph;
    });
    writeFileSync(join(p.root, fileOfTask(id)), content);
    await new StateManager(p.statePath).update((locked) => ({ ...locked, tasks: locked.tasks.map((task) => {
      if (task.id !== id) return task;
      const reimplemented = implementedTask(id, [fileOfTask(id)], fileOfTask(id), { spec_anchors: [], spec_contributions: ["FR-001"] });
      return { ...reimplemented, review_generation: task.review_generation, findings: task.findings,
        critical_findings: task.critical_findings, advisory_findings: task.advisory_findings,
        ...(task.review_basis === undefined ? {} : { review_basis: task.review_basis }) };
    }) }));
  }
  const reopenAndReimplementT6 = (p: ReturnType<typeof project>) => reopenAndReimplement(p, "T6", "export const t6 = 2;\n");

  const startCli = (p: ReturnType<typeof project>, runId: string, extra: readonly string[] = []) =>
    cliResult(p, ["start", "wave-gate", "--runs-root", p.runsRoot, "--run", runId, ...extra], JSON.stringify({ wave: 1 }));
  const reportedLines = (stderr: string): readonly unknown[] => stderr.split("\n").flatMap((line) => {
    try { return [JSON.parse(line) as unknown]; } catch { return []; }
  });

  it("replays the #213 advisory round: the fresh start issues spec-check plus T6's roster only, and completes on the carried acceptances", async () => {
    const p = await abandonedAdvisoryRound();
    await reopenAndReimplementT6(p);
    const started = await startCli(p, "run.second");
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as Action;
    expect(action.kind, started.stdout).toBe("spawn-batch");
    expect(action.requests?.map(({ authority }) => authority.role)).toEqual(["spec-check-invoker", ...BASE_WAVE_REVIEW_AGENTS]);
    const next = value(openRunDirectory(p.runsRoot, "run.second"));
    for (const { authority } of action.requests!.slice(1)) {
      expect(identityOf(next, authority)).toBeDefined();
      const context = readWaveReviewContext([value(next.readContext(authority.contextDigest))], authority.contextDigest);
      expect(context.kind === "loaded" ? context.value.subject.taskId : null).toBe("T6");
    }
    // The start names the one Task it reviews in full, and why.
    expect(reportedLines(started.stderr)).toContainEqual({ kind: "wave-gate-start-not-carried", runId: "run.second",
      notCarried: [{ taskId: "T6", reason: { kind: "nothing-accepted" } }] });
    const first = registration(value(openRunDirectory(p.runsRoot, "run.first")));
    expect(registration(next).succession).toEqual({
      previousRunId: "run.first", previousAuthorityDigest: first.authorityDigest, kind: "abandoned",
      carry: {
        lineage: [{ runId: "run.first", authorityDigest: first.authorityDigest }],
        carried: SIX.slice(0, 5).map((taskId) => ({ kind: "accepted-task", taskId, roster: BASE_WAVE_REVIEW_AGENTS,
          acceptance: { runId: "run.first", authorityDigest: first.authorityDigest } })),
      },
    });
    expect(graph(p).retired_wave_review_runs).toEqual([{ schemaVersion: 1, kind: "retired-wave-review-run", runId: "run.first",
      wave: 1, authorityDigest: first.authorityDigest, retirement: "abandoned" }]);

    // Spec-check and T6's roster land; T1's carried advisory reaches this run's advisory decision.
    const [specCheck, ...t6] = action.requests!;
    await capture(next, specCheck!.authority, specPass);
    for (const { authority } of t6) await capture(next, authority, payload(next, authority));
    const awaiting = await resume(p, next);
    expect(awaiting.kind, JSON.stringify(awaiting)).toBe("await-user");
    const settled = graph(p);
    expect(settled.tasks[5]!.accepted_review_authority?.run_id).toBe("run.second");
    expect(settled.tasks[5]!.findings).toEqual([]);
    expect(settled.tasks[0]!.findings).toMatchObject([{ claim: advisoryOn("T1").claim }]);
    expect(settled.tasks[0]!.accepted_review_authority?.run_id).toBe("run.first");
    // The deferral recorded after T1's acceptance did not stop it carrying (ADR-0091), and it
    // still stands for T1's advisory, so approval needs no new disposition.
    const done = await runCli(p, ["decide", "--runs-root", p.runsRoot, "--run", "run.second", "--request", awaiting.request!.requestId],
      JSON.stringify({ kind: "approve" }));
    expect(done.kind, JSON.stringify(done)).toBe("done");
    expect(await resume(p, next)).toEqual(done);
  }, 180_000);

  it("ADR-0094: a doc-comment fix is reviewed by comment-analyzer alone, frozen into the registration, and completes and replays", async () => {
    const p = await abandonedAdvisoryRound();
    await reopenAndReimplement(p, "T5", "/** The T5 constant. */\nexport const t5 = 1;\n");
    expect(graph(p).tasks[4]!.review_basis?.run_id).toBe("run.first");
    const started = await startCli(p, "run.second");
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as Action;
    expect(action.requests?.map(({ authority }) => authority.role)).toEqual(["spec-check-invoker", "comment-analyzer"]);
    const next = value(openRunDirectory(p.runsRoot, "run.second"));
    const first = registration(value(openRunDirectory(p.runsRoot, "run.first")));
    const basis = graph(p).tasks[4]!.review_basis!;
    const review = { taskId: "T5", roster: ["comment-analyzer"], from: BASE_WAVE_REVIEW_AGENTS,
      change: ["comment"], basis: { runId: "run.first", authorityDigest: first.authorityDigest, packetId: basis.packet_id, headSha: basis.head_sha } };
    expect(registration(next).narrowedReviews).toEqual([review]);
    // The report and the registration are read from one plan.
    expect(reportedLines(started.stderr)).toContainEqual({ kind: "wave-gate-start-roster", runId: "run.second", rosters: [
      ...["T1", "T2", "T3", "T4"].map((taskId) => ({ taskId, kind: "carried" })),
      { taskId: "T5", kind: "narrowed", review },
      { taskId: "T6", kind: "carried" },
    ] });
    // Slot membership refuses the narrowed run once its recorded narrowing is missing or inconsistent with its roster.
    const membership = (state: TaskGraph) => {
      const context = readWaveReviewContext([value(next.readContext(comment!.authority.contextDigest))], comment!.authority.contextDigest);
      if (context.kind !== "loaded") throw new Error("expected issued Wave context");
      return waveReviewerSlotProblem(state, state.tasks[4]!, context.value, issuedWaveProtocol(next, registration(next), comment!.authority));
    };
    const withT5Run = (state: TaskGraph, change: (run: CurrentReviewRun) => CurrentReviewRun): TaskGraph =>
      ({ ...state, tasks: state.tasks.map((task, index) => (index === 4 ? { ...task, review_run: change(task.review_run as CurrentReviewRun) } : task)) });
    const [, comment] = action.requests!;
    const installed = graph(p);
    expect(membership(installed)).toBeNull();
    const MISMATCH = "current reviewer protocol differs from protected workspace/request/context authority";
    expect(membership(withT5Run(installed, ({ narrowing: _dropped, ...run }) => run as CurrentReviewRun))).toBe(MISMATCH);
    expect(membership(withT5Run(installed, (run) => ({ ...run, narrowing: { ...run.narrowing!, from: ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS } }))))
      .toBe(MISMATCH);

    const [specCheck] = action.requests!;
    await capture(next, specCheck!.authority, specPass);
    await capture(next, comment!.authority, payload(next, comment!.authority));
    const awaiting = await resume(p, next);
    expect(awaiting.kind, JSON.stringify(awaiting)).toBe("await-user");
    const t5 = graph(p).tasks[4]!;
    expect(t5.accepted_review_authority).toMatchObject({ run_id: "run.second",
      narrowing: { from: BASE_WAVE_REVIEW_AGENTS, change: ["comment"], basis: { run_id: "run.first" } } });
    const done = await runCli(p, ["decide", "--runs-root", p.runsRoot, "--run", "run.second", "--request", awaiting.request!.requestId],
      JSON.stringify({ kind: "approve" }));
    expect(done.kind, JSON.stringify(done)).toBe("done");
    // The completed-protocol replay checks the narrowed roster it published, not the derived five.
    expect(await resume(p, next)).toEqual(done);
  }, 180_000);

  it("ADR-0094: T6's open code-reviewer advisory forces code-reviewer onto its comment-only fix, which retires it", async () => {
    const p = await abandonedAdvisoryRound();
    await reopenAndReimplement(p, "T6", "// the T6 constant\nexport const t6 = 1;\n");
    const started = await startCli(p, "run.second");
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as Action;
    expect(action.requests?.map(({ authority }) => authority.role)).toEqual(["spec-check-invoker", "code-reviewer", "comment-analyzer"]);
    const next = value(openRunDirectory(p.runsRoot, "run.second"));
    const [specCheck, ...t6] = action.requests!;
    await capture(next, specCheck!.authority, specPass);
    for (const { authority } of t6) await capture(next, authority, payload(next, authority));
    const awaiting = await resume(p, next);
    expect(awaiting.kind, JSON.stringify(awaiting)).toBe("await-user");
    const settled = graph(p).tasks[5]!;
    expect(settled.findings).toEqual([]);
    expect(settled.resolved_findings?.at(-1)?.resolution).toMatchObject({ expected_agents: ["code-reviewer", "comment-analyzer"],
      narrowed_from: BASE_WAVE_REVIEW_AGENTS });
  }, 180_000);

  it("--fresh-review carries nothing: every reviewed Task is issued, and the registration is exactly a carry-free start's", async () => {
    const p = await abandonedAdvisoryRound();
    const started = await startCli(p, "run.fresh", ["--fresh-review"]);
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as Action;
    expect(action.requests).toHaveLength(1 + SIX.length * BASE_WAVE_REVIEW_AGENTS.length);
    expect(reportedLines(started.stderr).some((line) => (line as { kind?: string }).kind === "wave-gate-start-not-carried")).toBe(false);
    const fresh = value(openRunDirectory(p.runsRoot, "run.fresh"));
    expect(Object.keys(value(fresh.readProgramRegistration()) as object).sort())
      .toEqual(["authorityDigest", "input", "kind", "reviewerProtocol", "schemaVersion", "taskIds"]);
  }, 180_000);

  it("a start with no carry prepares the batch it always did; a succession enters the epoch and drops the carried subjects", async () => {
    const p = sixTaskProject();
    const { handle } = await start(p);
    const current = registration(handle);
    if (current.schemaVersion !== 2) throw new Error("a started Wave Gate registers schema 2");
    const batchFor = (program: RegisteredWaveGateProgram) => withFixturePiSession(p.root, async () =>
      waveRequests(handle, program, graph(p), 1, { kind: "state-layout", root: p.root }));
    const plain = await batchFor(current);
    const acceptance = { runId: "run.previous", authorityDigest: "c".repeat(64) };
    const carrying = await batchFor(withOrigin(current, { succession: { previousRunId: acceptance.runId, previousAuthorityDigest: acceptance.authorityDigest,
      kind: "abandoned", carry: { lineage: [acceptance], carried: [{ kind: "accepted-task", taskId: "T1", roster: BASE_WAVE_REVIEW_AGENTS, acceptance }] } } }));
    expect(carrying.batchEpoch).not.toBe(plain.batchEpoch);
    expect(carrying.taskRuns.map(({ taskId }) => taskId)).toEqual(SIX.slice(1));
  }, 120_000);

  it("a start whose predecessor's Run Directory is gone issues every reviewed Task and names predecessor-unreadable", async () => {
    const p = await abandonedAdvisoryRound();
    rmSync(join(p.runsRoot, "run.first"), { recursive: true, force: true });
    const started = await startCli(p, "run.orphaned-predecessor");
    expect(started.status, started.stderr).toBe(0);
    expect((JSON.parse(started.stdout) as Action).requests).toHaveLength(1 + SIX.length * BASE_WAVE_REVIEW_AGENTS.length);
    const report = reportedLines(started.stderr).find((line) => (line as { kind?: string }).kind === "wave-gate-start-not-carried") as
      { notCarried: readonly { taskId: string; reason: { kind: string } }[] } | undefined;
    expect(report?.notCarried.map(({ taskId, reason }) => [taskId, reason.kind])).toEqual(SIX.map((taskId) => [taskId, "predecessor-unreadable"]));
    expect(Object.hasOwn(value(value(openRunDirectory(p.runsRoot, "run.orphaned-predecessor")).readProgramRegistration()) as object,
      "succession")).toBe(false);
  }, 180_000);

  it("the first batch install refuses a carried acceptance whose bytes changed after the start, and writes no review state", async () => {
    const p = await abandonedAdvisoryRound();
    await reopenAndReimplementT6(p);
    // The start's preflight and registration as `start wave-gate` commits them, before its first resume.
    const before = graph(p);
    const taskIds = before.tasks.map(({ id }) => id);
    const first = registration(value(openRunDirectory(p.runsRoot, "run.first")));
    const predecessor = successionPredecessorOf(before, 1);
    if (predecessor === null) throw new Error("the abandoned run must be the predecessor");
    const plan = planSuccessorCarry({ graph: before, taskIds, protocol: WAVE_REVIEWER_PROTOCOL_V4, predecessor,
      previous: { ok: true, value: first }, workspaces: observeReviewedWorkspace(before.tasks, p.root) });
    const succession = plan.succession;
    if (succession === undefined) throw new Error("T1..T5 must carry");
    const next = value(createRunDirectory(p.runsRoot, "run.second"));
    const program: RegisteredWaveGateProgram = { schemaVersion: 2, reviewerProtocol: WAVE_REVIEWER_PROTOCOL_V4, kind: "wave-gate",
      input: { wave: 1 }, taskIds, authorityDigest: waveGateAuthorityDigest(1, taskIds, before), succession };
    value(await next.registerProgram(program));
    await registerWaveGate(new StateManager(p.statePath),
      { runId: next.runId, runsRoot: next.identity.runsRoot, authorityDigest: program.authorityDigest }, { taskIds, succession });
    writeFileSync(join(p.root, fileOfTask("T1")), "export const t1 = 'edited after the start';\n");
    const installed = readFileSync(p.statePath);
    expect(await resume(p, next)).toMatchObject({ kind: "blocked", diagnostic: { message:
      "internal Wave Gate failure: Task T1 cannot keep the acceptance its succession carried from run run.first: drift in head, subject" } });
    expect(withoutCompletionSuite(readFileSync(p.statePath))).toEqual(withoutCompletionSuite(installed));
  }, 180_000);
});

// ---------------------------------------------------------------------------
// US1 scenario 1 / FR-012: the parent supplies the Wave number and nothing
// else; the engine derives the whole review scope and the exact spawn batch.
// ---------------------------------------------------------------------------

describe("US1 scenario 1: a Wave Gate starts from the Wave number alone", () => {
  it("returns the exact spec-check and reviewer batch with every authority field engine-derived", async () => {
    const p = project(mixedPriors());
    const { handle, action } = await start(p);
    const requests = action.requests!;
    // The roster is the engine's: the spec-check slot, then the Task's derived roster (here the base five,
    // since the fixture Task touches no owned family), in roster order.
    expect(requests.map(({ authority }) => authority.role)).toEqual(["spec-check-invoker", ...BASE_WAVE_REVIEW_AGENTS]);
    // Request, slot and output identities are distinct, first attempts, and bound to this run.
    for (const identity of [
      requests.map(({ authority }) => authority.requestId),
      requests.map(({ authority }) => authority.slotId),
      requests.map(({ authority }) => authority.outputSlot.path),
    ]) expect(new Set(identity).size).toBe(requests.length);
    for (const { authority, task } of requests) {
      expect(authority).toMatchObject({ runId: handle.runId, attempt: 1 });
      // The model binding and context the parent never named are issued, durable and readable.
      expect(authority.modelProfile).toEqual(expect.any(String));
      expect(authority.harnessBinding).toBeDefined();
      expect(value(handle.readContext(authority.contextDigest)).digest).toBe(authority.contextDigest);
      // The spawn task is rendered by the engine rather than assembled from parent parts.
      expect(task.length).toBeGreaterThan(0);
    }
    // The returned batch is the durable one: the run holds exactly these requests.
    expect(value(handle.readIssuedRequests()).map(({ requestId }) => requestId).sort())
      .toEqual(requests.map(({ authority }) => authority.requestId).sort());
    // Resuming with no input re-issues the same request authorities, so nothing the parent holds is needed.
    const resumed = await resume(p, handle);
    expect(resumed.kind).toBe("spawn-batch");
    expect(resumed.requests?.map(({ authority }) => authority)).toEqual(requests.map(({ authority }) => authority));
  }, 60_000);

  it.each([
    ["a caller-supplied request roster", { requests: [{ role: "code-reviewer" }] }],
    ["caller-supplied Review Packets", { packets: [{ taskId: "T1" }] }],
    ["a caller-chosen model binding", { models: { "code-reviewer": "opus" } }],
  ])("refuses %s beside the Wave number and changes no state", async (_label, extra) => {
    const p = project();
    const before = readFileSync(p.statePath);
    const refused = await cliResult(p, ["start", "wave-gate", "--runs-root", p.runsRoot, "--run", "run.forged"],
      JSON.stringify({ wave: 1, ...extra }));
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("wave-gate input must contain exactly wave");
    expect(readFileSync(p.statePath)).toEqual(before);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Issued emission route controls on the real Wave program path (T6): FR-012
// issuance joins retained regardless of emission-tool availability, and the
// non-producer spec-check slot stays byte-identical on both routes.
// ---------------------------------------------------------------------------

/** Scope the Pi-parent observation for in-process renders without touching
 *  the CLI children this suite spawns (their fixture environment is fixed). */
async function withPiParent<T>(enabled: boolean, operation: () => T | Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT;
  try {
    if (enabled) process.env.PI_CODING_AGENT = "true";
    else delete process.env.PI_CODING_AGENT;
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT;
    else process.env.PI_CODING_AGENT = previous;
  }
}

function executePacketCommand(task: string) {
  const command = /^LOOM_CONTEXT_READ_COMMAND: (.+)$/m.exec(task)?.[1];
  expect(command, "delivery must supply an executable cross-harness packet reader").toBeDefined();
  const result = spawnSync("bash", ["-c", command ?? "exit 127"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { schemaVersion: number; requestId: string; sections: unknown[] };
}

describe("the issued emission route on the Wave program path (T6)", () => {
  it("retains every issuance join across the extraction and emission routes and changes only reviewer task text (FR-012)", async () => {
    const startRun = async (parent: FacadeParent) => {
      const p = project();
      const { action, handle } = await start(p, "run.route", parent);
      return { p, handle, requests: action.requests! };
    };
    // The route is decided by the parent harness alone: the same Wave started
    // from Claude Code (extraction-only) and from Pi (emission).
    const extraction = await startRun("claude-code");
    const emission = await startRun("pi");

    // AD-6: every slot carries its catalog profile and the identical frozen binding on both routes.
    expectParentIndependentIssuance(emission.requests, extraction.requests);

    // FR-012 on the emission route: the issuance joins survive — the packet
    // read command still resolves the exact issued v2 packet for every slot,
    // and the durable-only fallback render reproduces each issued task
    // byte-for-byte (the Wave start appends one task-scoped instruction line,
    // so the comparison drops that final decoration), while the same render
    // without a Pi parent yields the extraction-shaped task. The route delta
    // on the wire is EXACTLY the descriptor line plus the appended
    // tool-primary instruction.
    for (const { authority, task } of emission.requests) {
      // The render IS the issued task: markers, delivery, the request's own
      // instruction and the packet's Task binding, byte for byte.
      const emissionRender = await withPiParent(true, () =>
        renderExtractionOnlyTask({ handle: emission.handle, authority }).task);
      expect(task).toBe(emissionRender);
      const extractionRender = await withPiParent(false, () =>
        renderExtractionOnlyTask({ handle: emission.handle, authority }).task);
      if (authority.role === "spec-check-invoker") {
        expect(extractionRender).toBe(emissionRender);
        expect(task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
        continue;
      }
      // The delivery join survives on the emission route: the packet read
      // command still resolves the exact issued v2 packet for this slot.
      expect(executePacketCommand(task)).toMatchObject({ schemaVersion: 2, requestId: authority.requestId });
      expect(task).toContain("calling the exact tool loom_emit_reviewer_payload exactly once");
      const descriptor = parseEmissionDescriptor(task);
      expect(descriptor).toMatchObject({ kind: "issued", contextDigest: authority.contextDigest,
        binding: { requestId: authority.requestId, version: "v4" } });
      if (descriptor.kind !== "issued") throw new Error("a Pi-parented reviewer must mint an issued descriptor");
      expect(withoutEmissionRouteDelta(emissionRender, descriptor.binding, descriptor.contextDigest)).toBe(extractionRender);
    }

    // The extraction route keeps its exact baseline: no descriptor, verbatim
    // instruction, and the durable render a non-Pi parent reproduces. Its
    // durable state is route-agnostic: rendered under a Pi parent, the same
    // run's reviewer task differs from it by exactly the emission delta.
    for (const { authority, task } of extraction.requests) {
      expect(task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
      expect(task).not.toContain("calling the exact tool loom_emit_reviewer_payload");
      const extractionRender = await withPiParent(false, () =>
        renderExtractionOnlyTask({ handle: extraction.handle, authority }).task);
      expect(task).toBe(extractionRender);
      if (authority.role === "spec-check-invoker") continue;
      const piRender = await withPiParent(true, () =>
        renderExtractionOnlyTask({ handle: extraction.handle, authority }).task);
      const descriptor = parseEmissionDescriptor(piRender);
      if (descriptor.kind !== "issued") throw new Error("a Pi-parent render of a current Wave reviewer must mint an issued descriptor");
      expect(withoutEmissionRouteDelta(piRender, descriptor.binding, descriptor.contextDigest)).toBe(extractionRender);
    }
  }, 120_000);
});
