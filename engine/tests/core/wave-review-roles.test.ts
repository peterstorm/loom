/**
 * A re-reviewed Task's roster follows what changed (ADR-0093, loom#213 Cause
 * 5b): the start's roster plan, its threading through issuance and the
 * registration, retirement in a narrowed run, and the Review Basis that
 * survives a reopening.
 */
import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS,
  BASE_WAVE_REVIEW_AGENTS,
  issuedWaveReviewRoster,
  parseNarrowedWaveReviewRoster,
} from "../../src/core/agent-catalog-projections";
import { attributeFindings, claimsOfSeverity, recordReviewRunEvidence, reviewRunError } from "../../src/core/findings";
import type { CurrentAcceptedReviewAuthority, CurrentReviewRun, CurrentReviewRunEvidence, Finding } from "../../src/core/findings-shape";
import { invalidateTaskReview } from "../../src/core/review-output";
import { reviewBasisOf } from "../../src/core/review-narrowing";
import { REVIEWER_PAYLOAD_EXAMPLE_V2, reviewerDraftV2Schema, WAVE_REVIEWER_PROTOCOL_V4 } from "../../src/core/reviewer-contract";
import { reviewedWorkspaceObservation, type ReviewedWorkspaceObservation } from "../../src/core/reviewed-workspace";
import { returnToRevalidation } from "../../src/core/task-revalidation";
import { waveFrozenSource } from "../../src/core/wave-frozen-source";
import type { NarrowedTaskReview, RegisteredWaveGateProgram } from "../../src/core/wave-gate-program";
import { installWaveGateRegistration } from "../../src/core/wave-gate-registration";
import { issuedWaveReviewRosters, taskReviewScope, waveGateAuthorityDigest, waveRunRosterProblem } from "../../src/core/wave-review-authority";
import { issuedWaveTaskRoster, reviewNarrowingOf } from "../../src/core/wave-review-carry-plan";
import { parseNarrowedReviews } from "../../src/core/wave-review-carry-audit";
import { planReviewRoles, type BasisPacketView, type ReviewRolesInput } from "../../src/core/wave-review-roles";
import { parseRegisteredFacadeProgram } from "../../src/handlers/helpers/programs/registration";
import type { Task, TaskCommonMetadata, TaskGraph } from "../../src/types";
import { findingId } from "../fixtures/finding-id";
import { value } from "../fixtures/parse-result";
import { activeWaveGateFixture, graphFixture, satisfiedProof, taskFixture } from "../fixtures/task-lifecycle";

const V4 = WAVE_REVIEWER_PROTOCOL_V4;
const DIGEST_A = "a".repeat(64);
const PACKET = "1".repeat(64);
const SOURCE = "/** Adds one. */\nexport const t1 = 1;\n";
const TEST = "it('adds', () => {});\n";

/** An implemented Task over a source file and its test, accepted by `run.previous` and then reopened. */
const implemented = (extra: Partial<TaskCommonMetadata> = {}): Task => taskFixture({
  id: "T1", description: "T1 work", agent: "code-implementer-agent", wave: 1, depends_on: [], status: "implemented",
  proof: satisfiedProof(["src/t1.ts", "src/t1.test.ts"]), file_list: ["src/t1.ts", "src/t1.test.ts"],
  files_modified: ["src/t1.ts", "src/t1.test.ts"], spec_anchors: [], spec_contributions: [], test_result: { verdict: "trusted-pass" },
  review_generation: 1, review_status: "pending", findings: [], critical_findings: [], advisory_findings: [], ...extra,
});

const observe = (task: Task, files: Readonly<Record<string, string>>): ReviewedWorkspaceObservation => {
  const scope = taskReviewScope(task);
  return value(reviewedWorkspaceObservation(task.id, scope, scope.map((path) => ({ path, bytes: Buffer.from(files[path] ?? "") }))));
};

const BEFORE = { "src/t1.ts": SOURCE, "src/t1.test.ts": TEST };

/** The acceptance a basis run recorded of `task` over `files`. */
function basisAcceptance(task: Task, files = BEFORE, narrowing?: CurrentAcceptedReviewAuthority["narrowing"]): CurrentAcceptedReviewAuthority {
  const bytes = observe(task, files);
  return { generation: 0, packet_id: PACKET, head_sha: bytes.headSha, scope: bytes.scope, run_id: "run.previous",
    authority_digest: DIGEST_A, reviewer_protocol: V4, ...(narrowing === undefined ? {} : { narrowing }) };
}

/** What the shell would read from the basis run's packets of `task` over `files`. */
function basisView(task: Task, files = BEFORE, roles: readonly string[] = BASE_WAVE_REVIEW_AGENTS): BasisPacketView {
  return {
    runId: "run.previous", packetId: PACKET, roles,
    frozenSource: waveFrozenSource(observe(task, files)),
    task: { id: task.id, description: task.description, agent: task.agent, reviewGeneration: 0, planContext: null,
      specAnchors: [], specContributions: [], declaredFiles: task.file_list ?? [], modifiedFiles: task.files_modified ?? [],
      proof: null, testResult: null, priorFindings: [] },
    planFile: null, ownerMap: null, contractSurface: null,
  };
}

function plan(task: Task, now: Readonly<Record<string, string>>, overrides: Partial<ReviewRolesInput> = {}) {
  const reopened: Task = { ...task, review_basis: basisAcceptance(task) };
  return planReviewRoles({
    graph: graphFixture([reopened]), taskIds: ["T1"], carried: new Set(), freshReview: false,
    workspaces: [observe(reopened, now)], bases: new Map([["T1", { ok: true, value: basisView(reopened) }]]),
    ...overrides,
  });
}

const advisoryBy = (agent: string): Finding =>
  ({ id: findingId(`${agent}-1`), agent, severity: "advisory", file: "src/t1.ts", line: 1, claim: `${agent} advisory` });

describe("a fresh start issues a changed Task only the roles its change needs", () => {
  it("a doc-comment change issues comment-analyzer only, and the registration freezes the narrowing", () => {
    const result = plan(implemented(), { ...BEFORE, "src/t1.ts": SOURCE.replace("Adds one.", "Adds exactly one.") });
    expect(result.rosters).toEqual([{ taskId: "T1", kind: "narrowed", roster: ["comment-analyzer"], change: ["comment"] }]);
    expect(result.narrowedReviews).toEqual([{ taskId: "T1", roster: ["comment-analyzer"], from: BASE_WAVE_REVIEW_AGENTS,
      change: ["comment"], basis: { runId: "run.previous", authorityDigest: DIGEST_A, packetId: PACKET,
        headSha: observe(implemented(), BEFORE).headSha } }]);
  });

  it("a test-only change issues code-reviewer and pr-test-analyzer", () => {
    const result = plan(implemented(), { ...BEFORE, "src/t1.test.ts": `${TEST}it('again', () => {});\n` });
    expect(result.rosters).toEqual([{ taskId: "T1", kind: "narrowed", roster: ["code-reviewer", "pr-test-analyzer"], change: ["test"] }]);
  });

  it("an open code-reviewer advisory forces code-reviewer onto a comment-only review", () => {
    const task = implemented({ findings: [advisoryBy("code-reviewer")], advisory_findings: ["code-reviewer advisory"] });
    const result = plan(task, { ...BEFORE, "src/t1.ts": SOURCE.replace("Adds one.", "Adds exactly one.") });
    expect(result.rosters).toEqual([{ taskId: "T1", kind: "narrowed", roster: ["code-reviewer", "comment-analyzer"], change: ["comment"] }]);
  });

  it("a code change, an unchanged Task, --fresh-review and an unsettled review all issue the full roster", () => {
    expect(plan(implemented(), { ...BEFORE, "src/t1.ts": SOURCE.replace("= 1", "= 2") }).rosters)
      .toMatchObject([{ kind: "full", roster: BASE_WAVE_REVIEW_AGENTS, reason: { kind: "change", change: { kind: "changed", classes: ["code"] } } }]);
    expect(plan(implemented(), BEFORE).rosters).toMatchObject([{ kind: "full", reason: { kind: "change", change: { kind: "unchanged" } } }]);
    expect(plan(implemented(), { ...BEFORE, "src/t1.ts": `${SOURCE}// x\n` }, { freshReview: true }).rosters)
      .toMatchObject([{ kind: "full", reason: { kind: "fresh-review" } }]);
    expect(plan(implemented(), BEFORE).narrowedReviews).toBeUndefined();
  });

  it("a missing, unreadable or mismatched basis issues the full roster", () => {
    const comment = { ...BEFORE, "src/t1.ts": SOURCE.replace("Adds one.", "Adds exactly one.") };
    expect(plan(implemented(), comment, { bases: new Map() }).rosters).toMatchObject([{ kind: "full", reason: { kind: "no-basis" } }]);
    expect(plan(implemented(), comment, { bases: new Map([["T1", { ok: false, error: "gone" }]]) }).rosters)
      .toMatchObject([{ kind: "full", reason: { kind: "basis-unreadable", error: "gone" } }]);
    const forged = basisView(implemented(), { ...BEFORE, "src/t1.ts": "export const other = 1;\n" });
    expect(plan(implemented(), comment, { bases: new Map([["T1", { ok: true, value: forged }]]) }).rosters)
      .toMatchObject([{ kind: "full", reason: { kind: "basis-mismatch", detail: "the basis frozen source is not the accepted head" } }]);
    const otherPacket = { ...basisView(implemented()), packetId: "2".repeat(64) };
    expect(plan(implemented(), comment, { bases: new Map([["T1", { ok: true, value: otherPacket }]]) }).rosters)
      .toMatchObject([{ kind: "full", reason: { kind: "basis-mismatch" } }]);
  });

  it("a carried Task is never narrowed", () => {
    expect(plan(implemented(), { ...BEFORE, "src/t1.ts": `${SOURCE}// x\n` }, { carried: new Set(["T1"]) }))
      .toEqual({ narrowedReviews: undefined, rosters: [{ taskId: "T1", kind: "carried" }] });
  });

  it("a basis whose packets did not show the contract surface is a context change, unless it narrowed the base five", () => {
    const comment = { ...BEFORE, "src/t1.ts": SOURCE.replace("Adds one.", "Adds exactly one.") };
    const commentOnly = basisView(implemented(), BEFORE, ["comment-analyzer"]);
    expect(plan(implemented(), comment, { bases: new Map([["T1", { ok: true, value: commentOnly }]]) }).rosters)
      .toMatchObject([{ kind: "full", reason: { kind: "change", change: { kind: "context-changed" } } }]);
    const reopened: Task = { ...implemented(), review_basis: basisAcceptance(implemented(), BEFORE,
      { from: BASE_WAVE_REVIEW_AGENTS, change: ["comment"], basis: { run_id: "run.older", authority_digest: DIGEST_A, packet_id: PACKET, head_sha: DIGEST_A } }) };
    expect(planReviewRoles({ graph: graphFixture([reopened]), taskIds: ["T1"], carried: new Set(), freshReview: false,
      workspaces: [observe(reopened, comment)], bases: new Map([["T1", { ok: true, value: commentOnly }]]) }).rosters)
      .toMatchObject([{ kind: "narrowed", roster: ["comment-analyzer"] }]);
  });
});

describe("the issued roster is threaded through every roster comparison", () => {
  const narrowed: NarrowedTaskReview = { taskId: "T1", roster: ["comment-analyzer"], from: BASE_WAVE_REVIEW_AGENTS, change: ["comment"],
    basis: { runId: "run.previous", authorityDigest: DIGEST_A, packetId: PACKET, headSha: DIGEST_A } };

  it("only a proper ordered part of a derived roster is a narrowed roster", () => {
    expect(parseNarrowedWaveReviewRoster(BASE_WAVE_REVIEW_AGENTS, ["comment-analyzer"])).toEqual(["comment-analyzer"]);
    expect(parseNarrowedWaveReviewRoster(BASE_WAVE_REVIEW_AGENTS, ["comment-analyzer", "code-reviewer"])).toBeNull();
    expect(parseNarrowedWaveReviewRoster(BASE_WAVE_REVIEW_AGENTS, [...BASE_WAVE_REVIEW_AGENTS])).toBeNull();
    expect(parseNarrowedWaveReviewRoster(BASE_WAVE_REVIEW_AGENTS, ["architecture-tech-lead"])).toBeNull();
    expect(issuedWaveReviewRoster(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS, [])).toBe(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS);
  });

  it("a narrowing decided from another derived roster is void: the Task is reviewed in full", () => {
    expect(issuedWaveTaskRoster(BASE_WAVE_REVIEW_AGENTS, narrowed)).toEqual(["comment-analyzer"]);
    expect(issuedWaveTaskRoster(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS, narrowed)).toBe(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS);
  });

  it("issuedWaveReviewRosters issues the narrowed roles, and with no plan is the rosters themselves", () => {
    const rosters = [{ taskId: "T1", roster: BASE_WAVE_REVIEW_AGENTS }, { taskId: "T2", roster: BASE_WAVE_REVIEW_AGENTS }];
    expect(issuedWaveReviewRosters(rosters, {})).toBe(rosters);
    expect(issuedWaveReviewRosters(rosters, { narrowedReviews: [narrowed] }))
      .toEqual([{ taskId: "T1", roster: ["comment-analyzer"] }, { taskId: "T2", roster: BASE_WAVE_REVIEW_AGENTS }]);
  });

  it("waveRunRosterProblem compares a run with its issued roster", () => {
    const graph = graphFixture([implemented()]);
    const slot = (agent: string, index: number) => ({ agent, slot_id: `wave-slot:${index}`, attempted: 1 as const });
    const run = (agents: readonly [string, ...string[]]) =>
      ({ expected_agents: agents, slot_authority: agents.map(slot) as unknown as readonly [ReturnType<typeof slot>] });
    expect(waveRunRosterProblem(graph, 2, graph.tasks[0]!, run(["comment-analyzer"]), narrowed)).toBeNull();
    expect(waveRunRosterProblem(graph, 2, graph.tasks[0]!, run(["comment-analyzer"]), undefined))
      .toMatchObject({ kind: "expected-agents-differ", roster: BASE_WAVE_REVIEW_AGENTS });
    expect(waveRunRosterProblem(graph, 2, graph.tasks[0]!, run([...BASE_WAVE_REVIEW_AGENTS] as unknown as readonly [string]), narrowed))
      .toMatchObject({ kind: "expected-agents-differ", roster: ["comment-analyzer"] });
  });

  it("the registration parses its narrowed reviews exactly, and refuses one naming a foreign Task or a non-subsequence", () => {
    const base = { schemaVersion: 2, reviewerProtocol: V4, kind: "wave-gate", input: { wave: 1 }, taskIds: ["T1"], authorityDigest: DIGEST_A };
    const parsed = parseRegisteredFacadeProgram({ ...base, narrowedReviews: [narrowed] });
    expect(parsed).toEqual({ kind: "registered", program: { ...base, narrowedReviews: [narrowed] } });
    expect(parseRegisteredFacadeProgram({ ...base, narrowedReviews: [{ ...narrowed, taskId: "T9" }] })).toMatchObject({ kind: "invalid" });
    expect(parseNarrowedReviews([{ ...narrowed, roster: ["comment-analyzer", "code-reviewer"] }]).ok).toBe(false);
    expect(parseNarrowedReviews([{ ...narrowed, change: ["code"] }]).ok).toBe(false);
    expect(parseNarrowedReviews([{ ...narrowed, from: ["comment-analyzer"] }]).ok).toBe(false);
    expect(parseNarrowedReviews([narrowed, narrowed]).ok).toBe(false);
    expect(parseNarrowedReviews([]).ok).toBe(false);
  });

  it("the locked install refuses a narrowing whose basis the Task no longer holds", () => {
    const task: Task = { ...implemented(), review_basis: basisAcceptance(implemented()) };
    const graph: TaskGraph = { ...graphFixture([task]), current_phase: "execute", current_wave: 1 };
    const registration = activeWaveGateFixture({ runId: "run.next", wave: 1, authorityDigest: waveGateAuthorityDigest(1, ["T1"], graph) });
    const held: NarrowedTaskReview = { ...narrowed, basis: { ...narrowed.basis, headSha: task.review_basis!.head_sha } };
    expect(installWaveGateRegistration(graph, registration, ["T1"], undefined, [held]).kind).toBe("installed");
    expect(installWaveGateRegistration(graph, registration, ["T1"], undefined, [narrowed])).toMatchObject({ kind: "refused",
      message: "Wave Gate narrows Task T1's review against run run.previous's acceptance, which is no longer its Review Basis" });
  });

  it("a registration without narrowed reviews keeps its exact key set", () => {
    const program: RegisteredWaveGateProgram = { schemaVersion: 2, reviewerProtocol: V4, kind: "wave-gate", input: { wave: 1 },
      taskIds: ["T1"], authorityDigest: DIGEST_A };
    expect(Object.keys(program).sort()).toEqual(["authorityDigest", "input", "kind", "reviewerProtocol", "schemaVersion", "taskIds"]);
  });
});

describe("a narrowed run never retires a prior Finding its owner did not vote on", () => {
  const AGENTS = ["comment-analyzer"] as const;
  const narrowing = reviewNarrowingOf({ taskId: "T1", roster: [...AGENTS], from: BASE_WAVE_REVIEW_AGENTS, change: ["comment"],
    basis: { runId: "run.previous", authorityDigest: DIGEST_A, packetId: PACKET, headSha: DIGEST_A } });
  const draft = { protocolVersion: 2 as const, ...reviewerDraftV2Schema.parse({ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0], file: "src/t1.ts" }) };

  function narrowedRunTask(): Task {
    const findings = [...attributeFindings([draft], "silent-failure-hunter"), ...attributeFindings([{ ...draft, claim: "comment drift" }], "comment-analyzer")];
    const run: CurrentReviewRun = { reviewer_protocol: V4, generation: 1, packet_id: "a".repeat(64), head_sha: "b".repeat(40),
      expected_agents: AGENTS, prior_finding_ids: findings.map(({ id }) => id), evidence: [],
      slot_authority: [{ agent: "comment-analyzer", slot_id: "wave-slot:1", attempted: 1, request_id: "wave-request:1:1", context_digest: "c".repeat(64) }],
      workspace_scope: ["src/t1.ts"], workspace_head_sha: "e".repeat(64), wave_gate_run_id: "run.current", wave_gate_authority_digest: "f".repeat(64),
      narrowing,
    };
    return { ...implemented(), findings, critical_findings: claimsOfSeverity(findings, "critical"),
      advisory_findings: claimsOfSeverity(findings, "advisory"), review_run: run };
  }

  it("the State File refuses a narrowing whose roster is not a proper part of the roster it names", () => {
    const task = narrowedRunTask();
    expect(reviewRunError(task.review_run, 1, task.findings, "review_run")).toBeNull();
    expect(reviewRunError({ ...task.review_run!, narrowing: { ...narrowing, from: ["comment-analyzer"] } }, 1, task.findings, "review_run"))
      .toMatch(/narrowing must be/);
  });

  it("keeps the absent owner's Finding active, retires the voting owner's, and records the narrowing on the acceptance and resolution", () => {
    const task = narrowedRunTask();
    const run = task.review_run as CurrentReviewRun;
    const evidence: CurrentReviewRunEvidence = { protocolVersion: 2, ...run.slot_authority[0]!,
      prior_assessments: run.prior_finding_ids.map((finding_id) => ({ finding_id, verdict: "resolved_by_remediation", reason: "fixed" })),
      new_findings: [] };
    const settled = recordReviewRunEvidence(task, run.packet_id, 1, evidence);
    if (!settled.ok) throw new Error(settled.error);
    expect(settled.completed).toBe(true);
    expect(settled.task.findings?.map(({ agent }) => agent)).toEqual(["silent-failure-hunter"]);
    expect(settled.task.resolved_findings?.map(({ finding, resolution }) => [finding.agent, resolution.narrowed_from]))
      .toEqual([["comment-analyzer", BASE_WAVE_REVIEW_AGENTS]]);
    expect(settled.task.accepted_review_authority).toMatchObject({ run_id: "run.current", narrowing });
  });
});

describe("the Review Basis survives a reopening", () => {
  it("invalidation and revalidation keep the cleared current acceptance as review_basis; a legacy one is no basis", () => {
    const accepted = basisAcceptance(implemented());
    const task: Task = { ...implemented(), accepted_review_authority: accepted, review_status: "passed" };
    expect(invalidateTaskReview(task).review_basis).toEqual(accepted);
    expect(invalidateTaskReview(task).accepted_review_authority).toBeUndefined();
    expect(returnToRevalidation(task, undefined).review_basis).toEqual(accepted);
    expect(reviewBasisOf(invalidateTaskReview(invalidateTaskReview(task)))).toEqual(accepted);
    const { reviewer_protocol: _protocol, subject_digest: _subject, ...legacy } = accepted;
    const legacyTask: Task = { ...implemented(), accepted_review_authority: legacy };
    expect(Object.hasOwn(invalidateTaskReview(legacyTask), "review_basis")).toBe(false);
  });
});
