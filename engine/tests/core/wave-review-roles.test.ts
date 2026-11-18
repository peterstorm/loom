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
  narrowedWaveReviewRoster,
  parseNarrowedWaveReviewRoster,
  type NarrowedWaveReviewRoster,
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
import {
  issuedWaveReviewRosters,
  taskReviewScope,
  waveGateAuthorityDigest,
  waveRunRosterProblem,
  widenedNarrowings,
} from "../../src/core/wave-review-authority";
import { waveAcceptanceProblem } from "../../src/core/wave-review-carry";
import {
  issuedTaskReview,
  registeredIssuance,
  reviewNarrowingOf,
  runIssuance,
  WHOLE_ISSUANCE,
} from "../../src/core/wave-review-carry-plan";
import { parseNarrowedReviews } from "../../src/core/wave-review-carry-audit";
import {
  basisReadOf,
  narrowedReviewsOf,
  planReviewRoles,
  type BasisPacketView,
  type ReviewRolesInput,
} from "../../src/core/wave-review-roles";
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

/** A narrowed roster of the base five, minted as the parser mints it. */
const narrowedOf = (roles: readonly string[]): NarrowedWaveReviewRoster => {
  const roster = parseNarrowedWaveReviewRoster(BASE_WAVE_REVIEW_AGENTS, roles);
  if (roster === null) throw new Error(`fixture roster ${roles.join()} must narrow the base five`);
  return roster;
};

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
const COMMENT_EDIT = { ...BEFORE, "src/t1.ts": SOURCE.replace("Adds one.", "Adds exactly one.") };

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

/** The roles and change classes of a plan's narrowed choices. */
const narrowedChoices = (choices: ReturnType<typeof plan>) =>
  choices.flatMap((choice) => (choice.kind === "narrowed" ? [[choice.review.roster, choice.review.change]] : []));

const advisoryBy = (agent: string): Finding =>
  ({ id: findingId(`${agent}-1`), agent, severity: "advisory", file: "src/t1.ts", line: 1, claim: `${agent} advisory` });

describe("a fresh start issues a changed Task only the roles its change needs", () => {
  it("a doc-comment change issues comment-analyzer only, and the registration freezes that same choice", () => {
    const result = plan(implemented(), COMMENT_EDIT);
    const review = { taskId: "T1", roster: ["comment-analyzer"], from: BASE_WAVE_REVIEW_AGENTS, change: ["comment"],
      basis: { runId: "run.previous", authorityDigest: DIGEST_A, packetId: PACKET, headSha: observe(implemented(), BEFORE).headSha } };
    expect(result).toEqual([{ taskId: "T1", kind: "narrowed", review }]);
    expect(narrowedReviewsOf(result)).toEqual([review]);
  });

  it("a test-only change issues code-reviewer and pr-test-analyzer", () => {
    expect(narrowedChoices(plan(implemented(), { ...BEFORE, "src/t1.test.ts": `${TEST}it('again', () => {});\n` })))
      .toEqual([[["code-reviewer", "pr-test-analyzer"], ["test"]]]);
  });

  it("an open code-reviewer advisory forces code-reviewer onto a comment-only review", () => {
    const task = implemented({ findings: [advisoryBy("code-reviewer")], advisory_findings: ["code-reviewer advisory"] });
    expect(narrowedChoices(plan(task, COMMENT_EDIT))).toEqual([[["code-reviewer", "comment-analyzer"], ["comment"]]]);
  });

  it("a code change, an unchanged Task, --fresh-review and an unsettled review all issue the full roster", () => {
    expect(plan(implemented(), { ...BEFORE, "src/t1.ts": SOURCE.replace("= 1", "= 2") }))
      .toMatchObject([{ kind: "full", roster: BASE_WAVE_REVIEW_AGENTS, reason: { kind: "change", change: { kind: "changed", classes: ["code"] } } }]);
    expect(plan(implemented(), BEFORE)).toMatchObject([{ kind: "full", reason: { kind: "change", change: { kind: "unchanged" } } }]);
    expect(plan(implemented(), COMMENT_EDIT, { freshReview: true })).toMatchObject([{ kind: "full", reason: { kind: "fresh-review" } }]);
    expect(narrowedReviewsOf(plan(implemented(), BEFORE))).toBeUndefined();
  });

  it("a missing, unreadable or mismatched basis issues the full roster", () => {
    expect(plan(implemented(), COMMENT_EDIT, { bases: new Map() })).toMatchObject([{ kind: "full", reason: { kind: "no-basis" } }]);
    expect(plan(implemented(), COMMENT_EDIT, { bases: new Map([["T1", { ok: false, error: "gone" }]]) }))
      .toMatchObject([{ kind: "full", reason: { kind: "basis-unreadable", error: "gone" } }]);
    const forged = basisView(implemented(), { ...BEFORE, "src/t1.ts": "export const other = 1;\n" });
    expect(plan(implemented(), COMMENT_EDIT, { bases: new Map([["T1", { ok: true, value: forged }]]) }))
      .toMatchObject([{ kind: "full", reason: { kind: "basis-mismatch", detail: "the basis frozen source is not the accepted head" } }]);
    const otherPacket = { ...basisView(implemented()), packetId: "2".repeat(64) };
    expect(plan(implemented(), COMMENT_EDIT, { bases: new Map([["T1", { ok: true, value: otherPacket }]]) }))
      .toMatchObject([{ kind: "full", reason: { kind: "basis-mismatch" } }]);
  });

  it("a carried Task is never narrowed", () => {
    expect(plan(implemented(), COMMENT_EDIT, { carried: new Set(["T1"]) })).toEqual([{ taskId: "T1", kind: "carried" }]);
  });

  it("one basis-read rule decides which Tasks the shell reads and the plan consults", () => {
    const reopened: Task = { ...implemented(), review_basis: basisAcceptance(implemented()) };
    const options = { carried: new Set<string>(), freshReview: false };
    expect(basisReadOf(reopened, options)).toEqual({ kind: "consult", basis: reopened.review_basis });
    expect(basisReadOf(reopened, { ...options, carried: new Set(["T1"]) })).toEqual({ kind: "carried" });
    expect(basisReadOf(reopened, { ...options, freshReview: true })).toEqual({ kind: "full", reason: { kind: "fresh-review" } });
    expect(basisReadOf(implemented(), options)).toEqual({ kind: "full", reason: { kind: "no-basis" } });
  });

  it("a basis whose packets did not show the contract surface is a context change, unless it narrowed the base five", () => {
    const commentOnly = basisView(implemented(), BEFORE, ["comment-analyzer"]);
    expect(plan(implemented(), COMMENT_EDIT, { bases: new Map([["T1", { ok: true, value: commentOnly }]]) }))
      .toMatchObject([{ kind: "full", reason: { kind: "change", change: { kind: "context-changed" } } }]);
    const reopened: Task = { ...implemented(), review_basis: basisAcceptance(implemented(), BEFORE,
      { from: BASE_WAVE_REVIEW_AGENTS, change: ["comment"], basis: { run_id: "run.older", authority_digest: DIGEST_A, packet_id: PACKET, head_sha: DIGEST_A } }) };
    expect(narrowedChoices(planReviewRoles({ graph: graphFixture([reopened]), taskIds: ["T1"], carried: new Set(), freshReview: false,
      workspaces: [observe(reopened, COMMENT_EDIT)], bases: new Map([["T1", { ok: true, value: commentOnly }]]) })))
      .toEqual([[["comment-analyzer"], ["comment"]]]);
  });
});

describe("the issued review is threaded through every roster comparison", () => {
  const narrowed: NarrowedTaskReview = { taskId: "T1", roster: narrowedOf(["comment-analyzer"]), from: BASE_WAVE_REVIEW_AGENTS,
    change: ["comment"], basis: { runId: "run.previous", authorityDigest: DIGEST_A, packetId: PACKET, headSha: DIGEST_A } };

  it("only a proper ordered part of a derived roster is a narrowed roster", () => {
    expect(parseNarrowedWaveReviewRoster(BASE_WAVE_REVIEW_AGENTS, ["comment-analyzer"])).toEqual(["comment-analyzer"]);
    expect(parseNarrowedWaveReviewRoster(BASE_WAVE_REVIEW_AGENTS, ["comment-analyzer", "code-reviewer"])).toBeNull();
    expect(parseNarrowedWaveReviewRoster(BASE_WAVE_REVIEW_AGENTS, [...BASE_WAVE_REVIEW_AGENTS])).toBeNull();
    expect(parseNarrowedWaveReviewRoster(BASE_WAVE_REVIEW_AGENTS, ["architecture-tech-lead"])).toBeNull();
    expect(narrowedWaveReviewRoster(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS, [])).toBeNull();
  });

  it("the issued review is tagged: whole, narrowed, or widened when a narrowing no longer fits the derived roster", () => {
    const issuance = registeredIssuance({ narrowedReviews: [narrowed] }, "T1");
    expect(issuedTaskReview(BASE_WAVE_REVIEW_AGENTS, WHOLE_ISSUANCE)).toEqual({ kind: "whole", roster: BASE_WAVE_REVIEW_AGENTS });
    expect(issuedTaskReview(BASE_WAVE_REVIEW_AGENTS, issuance))
      .toEqual({ kind: "narrowed", roster: ["comment-analyzer"], narrowing: reviewNarrowingOf(narrowed) });
    expect(issuedTaskReview(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS, issuance))
      .toEqual({ kind: "widened", roster: ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS, narrowing: reviewNarrowingOf(narrowed) });
  });

  it("a widened narrowing is reported, never silent", () => {
    const graph = graphFixture([implemented()]);
    expect(widenedNarrowings(graph, 2, { narrowedReviews: [narrowed] })).toEqual([]);
    const fromSix: NarrowedTaskReview = { ...narrowed, from: ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS };
    expect(widenedNarrowings(graph, 2, { narrowedReviews: [fromSix] }))
      .toEqual([{ taskId: "T1", from: ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS, derived: BASE_WAVE_REVIEW_AGENTS }]);
  });

  it("issuedWaveReviewRosters issues the narrowed roles, and with no plan is the rosters themselves", () => {
    const rosters = [{ taskId: "T1", roster: BASE_WAVE_REVIEW_AGENTS }, { taskId: "T2", roster: BASE_WAVE_REVIEW_AGENTS }];
    expect(issuedWaveReviewRosters(rosters, {})).toBe(rosters);
    expect(issuedWaveReviewRosters(rosters, { narrowedReviews: [narrowed] }))
      .toEqual([{ taskId: "T1", roster: ["comment-analyzer"] }, { taskId: "T2", roster: BASE_WAVE_REVIEW_AGENTS }]);
  });

  it("waveRunRosterProblem compares a run with its issued roster, and a run's missing or inconsistent narrowing is refused", () => {
    const graph = graphFixture([implemented()]);
    const slot = (agent: string, index: number) => ({ agent, slot_id: `wave-slot:${index}`, attempted: 1 as const });
    const run = (agents: readonly [string, ...string[]]) =>
      ({ expected_agents: agents, slot_authority: agents.map(slot) as unknown as readonly [ReturnType<typeof slot>] });
    const issuance = registeredIssuance({ narrowedReviews: [narrowed] }, "T1");
    expect(waveRunRosterProblem(graph, 2, graph.tasks[0]!, run(["comment-analyzer"]), issuance)).toBeNull();
    expect(waveRunRosterProblem(graph, 2, graph.tasks[0]!, run(["comment-analyzer"]), WHOLE_ISSUANCE))
      .toMatchObject({ kind: "expected-agents-differ", roster: BASE_WAVE_REVIEW_AGENTS });
    expect(waveRunRosterProblem(graph, 2, graph.tasks[0]!, run([...BASE_WAVE_REVIEW_AGENTS] as unknown as readonly [string]), issuance))
      .toMatchObject({ kind: "expected-agents-differ", roster: ["comment-analyzer"] });
    // A run that names a narrowing decided from another roster, or a roster
    // that is no part of its `from`, is held to the whole roster.
    const foreign = { kind: "narrowed" as const, roster: ["comment-analyzer"], narrowing: { ...reviewNarrowingOf(narrowed), from: ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS } };
    expect(waveRunRosterProblem(graph, 2, graph.tasks[0]!, run(["comment-analyzer"]), foreign)).toMatchObject({ kind: "expected-agents-differ" });
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

  it("the locked install reads the narrowing from the registration and refuses one whose basis or derived roster no longer holds", () => {
    const task: Task = { ...implemented(), review_basis: basisAcceptance(implemented()) };
    const graph: TaskGraph = { ...graphFixture([task]), current_phase: "execute", current_wave: 1 };
    const registration = activeWaveGateFixture({ runId: "run.next", wave: 1, authorityDigest: waveGateAuthorityDigest(1, ["T1"], graph) });
    const held: NarrowedTaskReview = { ...narrowed, basis: { ...narrowed.basis, headSha: task.review_basis!.head_sha } };
    expect(installWaveGateRegistration(graph, registration, { taskIds: ["T1"], narrowedReviews: [held] }).kind).toBe("installed");
    expect(installWaveGateRegistration(graph, registration, { taskIds: ["T1"], narrowedReviews: [narrowed] })).toMatchObject({ kind: "refused",
      message: "Wave Gate narrows Task T1's review against run run.previous's acceptance, which is no longer its Review Basis" });
    expect(installWaveGateRegistration(graph, registration, { taskIds: ["T1"], narrowedReviews: [{ ...held, from: ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS }] }))
      .toMatchObject({ kind: "refused", message: "Wave Gate narrows Task T1's review from a roster its review no longer derives" });
  });

  it("a registration without narrowed reviews keeps its exact key set", () => {
    const program: RegisteredWaveGateProgram = { schemaVersion: 2, reviewerProtocol: V4, kind: "wave-gate", input: { wave: 1 },
      taskIds: ["T1"], authorityDigest: DIGEST_A };
    expect(Object.keys(program).sort()).toEqual(["authorityDigest", "input", "kind", "reviewerProtocol", "schemaVersion", "taskIds"]);
  });
});

describe("completion admits a narrowed acceptance only as its registration issued it", () => {
  const narrowed: NarrowedTaskReview = { taskId: "T1", roster: narrowedOf(["comment-analyzer"]), from: BASE_WAVE_REVIEW_AGENTS,
    change: ["comment"], basis: { runId: "run.previous", authorityDigest: DIGEST_A, packetId: PACKET, headSha: DIGEST_A } };
  const registration = (extra: Partial<RegisteredWaveGateProgram> = {}): RegisteredWaveGateProgram => ({
    schemaVersion: 2, reviewerProtocol: V4, kind: "wave-gate", input: { wave: 1 }, taskIds: ["T1"], authorityDigest: DIGEST_A,
    ...extra,
  } as RegisteredWaveGateProgram);
  const accepted = (narrowing?: CurrentAcceptedReviewAuthority["narrowing"]): Task => ({ ...implemented(),
    accepted_review_authority: { ...basisAcceptance(implemented()), generation: 1, run_id: "run.current",
      ...(narrowing === undefined ? {} : { narrowing }) } });

  it("refuses a narrowed acceptance when the registration narrowed nothing", () => {
    expect(waveAcceptanceProblem(accepted(reviewNarrowingOf(narrowed)), registration(), "run.current", []))
      .toBe("Task T1 acceptance records a narrowing its registration did not issue");
  });

  it("refuses a narrowed acceptance measured against another basis than the registration's", () => {
    const other = reviewNarrowingOf({ ...narrowed, basis: { ...narrowed.basis, runId: "run.other" } });
    expect(waveAcceptanceProblem(accepted(other), registration({ narrowedReviews: [narrowed] }), "run.current", []))
      .toBe("Task T1 acceptance records a narrowing its registration did not issue");
  });

  it("admits the narrowing the registration issued, and a whole-roster acceptance either way", () => {
    expect(waveAcceptanceProblem(accepted(reviewNarrowingOf(narrowed)), registration({ narrowedReviews: [narrowed] }), "run.current", []))
      .toBeNull();
    expect(waveAcceptanceProblem(accepted(), registration({ narrowedReviews: [narrowed] }), "run.current", [])).toBeNull();
  });
});

describe("a narrowed run never retires a prior Finding its owner did not vote on", () => {
  const AGENTS = ["comment-analyzer"] as const;
  const narrowing = reviewNarrowingOf({ taskId: "T1", roster: narrowedOf([...AGENTS]), from: BASE_WAVE_REVIEW_AGENTS, change: ["comment"],
    basis: { runId: "run.previous", authorityDigest: DIGEST_A, packetId: PACKET, headSha: DIGEST_A } });
  const draft = { protocolVersion: 2 as const, ...reviewerDraftV2Schema.parse({ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0], file: "src/t1.ts" }) };

  function narrowedRunTask(extra: Partial<TaskCommonMetadata> = {}): Task {
    const findings = [...attributeFindings([draft], "silent-failure-hunter"), ...attributeFindings([{ ...draft, claim: "comment drift" }], "comment-analyzer")];
    const run: CurrentReviewRun = { reviewer_protocol: V4, generation: 1, packet_id: "a".repeat(64), head_sha: "b".repeat(40),
      expected_agents: AGENTS, prior_finding_ids: findings.map(({ id }) => id), evidence: [],
      slot_authority: [{ agent: "comment-analyzer", slot_id: "wave-slot:1", attempted: 1, request_id: "wave-request:1:1", context_digest: "c".repeat(64) }],
      workspace_scope: ["src/t1.ts"], workspace_head_sha: "e".repeat(64), wave_gate_run_id: "run.current", wave_gate_authority_digest: "f".repeat(64),
      narrowing,
    };
    return { ...implemented(extra), findings, critical_findings: claimsOfSeverity(findings, "critical"),
      advisory_findings: claimsOfSeverity(findings, "advisory"), review_run: run };
  }

  const settle = (task: Task) => {
    const run = task.review_run as CurrentReviewRun;
    const evidence: CurrentReviewRunEvidence = { protocolVersion: 2, ...run.slot_authority[0]!,
      prior_assessments: run.prior_finding_ids.map((finding_id) => ({ finding_id, verdict: "resolved_by_remediation", reason: "fixed" })),
      new_findings: [] };
    const settled = recordReviewRunEvidence(task, run.packet_id, 1, evidence);
    if (!settled.ok) throw new Error(settled.error);
    return settled;
  };

  it("the State File refuses a narrowing whose roster is not a proper part of the roster it names", () => {
    const task = narrowedRunTask();
    expect(reviewRunError(task.review_run, 1, task.findings, "review_run")).toBeNull();
    expect(reviewRunError({ ...task.review_run!, narrowing: { ...narrowing, from: ["comment-analyzer"] } }, 1, task.findings, "review_run"))
      .toMatch(/narrowing must be/);
  });

  it("a run's own issuance is its recorded narrowing over its roster, and whole without one", () => {
    const run = narrowedRunTask().review_run!;
    expect(runIssuance(run)).toEqual({ kind: "narrowed", roster: AGENTS, narrowing });
    const { narrowing: _dropped, ...unnarrowed } = run as CurrentReviewRun;
    expect(runIssuance(unnarrowed as CurrentReviewRun)).toEqual(WHOLE_ISSUANCE);
  });

  it("keeps the absent owner's Finding active, retires the voting owner's, and records the narrowing on the acceptance and resolution", () => {
    const settled = settle(narrowedRunTask());
    expect(settled.completed).toBe(true);
    expect(settled.task.findings?.map(({ agent }) => agent)).toEqual(["silent-failure-hunter"]);
    expect(settled.task.resolved_findings?.map(({ finding, resolution }) => [finding.agent, resolution.narrowed_from]))
      .toEqual([["comment-analyzer", BASE_WAVE_REVIEW_AGENTS]]);
    expect(settled.task.accepted_review_authority).toMatchObject({ run_id: "run.current", narrowing });
  });

  it("a new acceptance supersedes the kept Review Basis, so the two never stand side by side", () => {
    const settled = settle(narrowedRunTask({ review_basis: basisAcceptance(implemented()) }));
    expect(Object.hasOwn(settled.task, "review_basis")).toBe(false);
    expect(reviewBasisOf(settled.task)).toEqual(settled.task.accepted_review_authority);
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
