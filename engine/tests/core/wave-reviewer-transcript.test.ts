import { describe, expect, it } from "vitest";
import { buildContextPacket, buildReviewerContextPacket, encodeByteSection, type ContextPacket } from "../../src/core/context-packets";
import { CURRENT_REVIEWER_PROTOCOL, REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../src/core/reviewer-contract";
import { sha256Hex } from "../../src/core/digest";
import {
  createPublicationAuthorityResolver,
  parseAgentRequestAuthority,
  parseIssuedSpawnRequest,
  parseOrchestrationRunId,
  parseRequestId,
  type SpawnRequest,
} from "../../src/core/orchestration-contract";
import { lowerModelProfile, resolveAgentPolicy, resolveModelProfile } from "../../src/core/model-profiles";
import {
  parseIssuedReviewerProtocol,
  type IssuedWaveReviewerProtocol,
  type ReviewerProtocolRegistration,
  type ReviewerSubjectBinding,
} from "../../src/core/review-output";
import { attributeFindings } from "../../src/core/findings";
import { resolveWaveReviewerTranscript, reviewerRejectionReason } from "../../src/core/wave-reviewer-transcript";
import type { Finding, ReviewRun, Task } from "../../src/types";
import { taskFixture } from "../fixtures/task-lifecycle";

// ---------------------------------------------------------------------------
// Issued Wave reviewer authority, minted through the production publication
// and protocol joins (the same construction `reviewer-protocol-authority.test.ts`
// uses; no forged membership).
// ---------------------------------------------------------------------------

function value<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

const runId = value(parseOrchestrationRunId("run.wave-reviewer-transcript"));
const PACKET = "a".repeat(64);
const HEAD = "c".repeat(64);
const AUTHORITY_DIGEST = "b".repeat(64);
const GENERATION = 3;
const ROLE = "code-reviewer";
const SCOPE = ["src/a.ts", "src/b.ts"] as const;
const prior: readonly Finding[] = attributeFindings([{ severity: "critical", claim: "old", file: null, line: null }], "old-reviewer");
const PRIOR_ID = prior[0]!.id;

const encode = (text: string) => new TextEncoder().encode(text);
const json = (raw: unknown) => encode(JSON.stringify(raw));

function publish(packet: ContextPacket, attempt: 1 | 2): SpawnRequest {
  const policy = value(resolveAgentPolicy(packet.role));
  const profile = value(resolveModelProfile(policy.profile));
  const authority = value(parseAgentRequestAuthority({
    runId, requestId: packet.requestId, slotId: `slot:${ROLE}`, program: "wave-gate",
    role: packet.role, attempt, modelProfile: policy.profile,
    harnessBinding: { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") },
    requiredSkill: policy.requiredSkill, contextDigest: packet.digest,
    outputSlot: `transcripts/${ROLE}/attempt-${attempt}.raw`,
  }));
  const context = { digest: packet.digest, slot: { kind: "fixed-artifact-slot", path: `contexts/${packet.digest}.json` } };
  const content = { schemaVersion: 1, kind: "batch-published", effectId: "effect:reviewer-publication", runId,
    requestIds: [authority.requestId], contextDigests: [authority.contextDigest], issuedRequests: [{ authority, context }] };
  const receipt = { ...content, publicationDigest: sha256Hex(JSON.stringify(content)) };
  const resolver = createPublicationAuthorityResolver(() => ({ ok: true, value: [...json(receipt)] }));
  return value(parseIssuedSpawnRequest(resolver, { authority, context, issuance: {
    schemaVersion: 1, kind: "issued-spawn-request-proof", runId, effectId: content.effectId,
    publicationDigest: receipt.publicationDigest, batchIndex: 0,
  } }));
}

function issuedWaveProtocol(version: 1 | 2, attempt: 1 | 2 = 1): IssuedWaveReviewerProtocol {
  const subject: ReviewerSubjectBinding = {
    kind: "wave-review", runId, scope: [...SCOPE], taskId: "T1", packetId: PACKET, generation: GENERATION, priorFindingIds: [PRIOR_ID],
  };
  const section = { runId, wave: 1, authorityDigest: AUTHORITY_DIGEST, batchEpoch: HEAD, subject: { role: ROLE, taskId: "T1" },
    taskRun: { taskId: "T1", generation: GENERATION, packetId: PACKET, headSha: HEAD },
    task: { id: "T1", description: "review", agent: "code-implementer-agent", reviewGeneration: GENERATION, planContext: null,
      specAnchors: [], specContributions: [], declaredFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"], proof: null, testResult: null, priorFindings: prior },
    specCheckScope: null, packetId: PACKET, specFile: null, planFile: null };
  const input = { requestId: value(parseRequestId(`request:${ROLE}:${attempt}`)), role: ROLE, requiredSkill: "none",
    fixedContext: [value(encodeByteSection("wave-review-authority", JSON.stringify(section)))], variableContext: [] };
  const packet = value<ContextPacket>(version === 2 ? buildReviewerContextPacket(input) : buildContextPacket({ ...input, outputContract: "Machine Summary" }));
  const request = publish(packet, attempt);
  const registration: ReviewerProtocolRegistration = version === 2
    ? { schemaVersion: 2, runId, program: "wave-gate", reviewerProtocol: CURRENT_REVIEWER_PROTOCOL }
    : { schemaVersion: 1, runId, program: "wave-gate" };
  const issued = value(parseIssuedReviewerProtocol({ request, packet, registration, subject }));
  if (issued.subject.kind !== "wave-review") throw new Error("Wave authority expected");
  return issued as IssuedWaveReviewerProtocol;
}

const v1 = issuedWaveProtocol(1);
const v2 = issuedWaveProtocol(2);

// ---------------------------------------------------------------------------
// Task fixtures bound to that authority.
// ---------------------------------------------------------------------------

const currentSlot = (protocol: IssuedWaveReviewerProtocol, overrides: Partial<{ request_id: string; slot_id: string }> = {}) => ({
  agent: protocol.request.role, slot_id: protocol.request.slotId, attempted: protocol.request.attempt,
  request_id: protocol.request.requestId, context_digest: protocol.request.contextDigest, ...overrides,
});

type CurrentSlot = ReturnType<typeof currentSlot>;

function currentRun(expected: readonly [string, ...string[]], slots: readonly [CurrentSlot, ...CurrentSlot[]], generation = GENERATION): ReviewRun {
  return {
    reviewer_protocol: CURRENT_REVIEWER_PROTOCOL, generation, packet_id: PACKET, head_sha: HEAD,
    expected_agents: expected, prior_finding_ids: [PRIOR_ID], evidence: [],
    slot_authority: slots,
    workspace_scope: [...SCOPE], workspace_head_sha: HEAD, wave_gate_run_id: runId, wave_gate_authority_digest: AUTHORITY_DIGEST,
  };
}

function legacyRun(expected: readonly [string, ...string[]] = [ROLE]): ReviewRun {
  return {
    generation: GENERATION, packet_id: PACKET, head_sha: HEAD,
    expected_agents: expected, prior_finding_ids: [PRIOR_ID], evidence: [],
  };
}

function reviewTask(run: ReviewRun | undefined, overrides: Partial<{ id: string; review_generation: number }> = {}): Task {
  return taskFixture({
    id: overrides.id ?? "T1", description: "review", agent: "code-implementer-agent", wave: 1, depends_on: [],
    findings: prior, critical_findings: ["old"], advisory_findings: [],
    ...("review_generation" in overrides ? { review_generation: overrides.review_generation } : { review_generation: GENERATION }),
    ...(run === undefined ? {} : { review_run: run }),
  });
}

const critical = { ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, severity: "critical" as const, file: "src/a.ts", line: 4, claim: "new defect" };

function currentPayload(findings: readonly unknown[] = [], verdict = "still_present") {
  return json({ schemaVersion: 2, kind: "wave-review", packetId: PACKET, generation: GENERATION,
    prior_findings: [{ finding_id: PRIOR_ID, verdict, reason: "still there" }], findings });
}

function legacyTranscript(lines: readonly string[], verdict = "still_present"): Uint8Array {
  return encode([
    ...lines,
    `REVIEW_PACKET_ID: ${PACKET}`,
    `REVIEW_GENERATION: ${GENERATION}`,
    "```review_lifecycle",
    JSON.stringify({ prior_findings: [{ finding_id: PRIOR_ID, verdict, reason: "checked" }] }),
    "```",
  ].join("\n"));
}

const STALE = "issued reviewer protocol differs from the current Task Review Packet";

describe("resolveWaveReviewerTranscript — staleness", () => {
  const task = reviewTask(currentRun([ROLE], [currentSlot(v2)]));
  const bytes = currentPayload();

  it.each([
    ["the Task id differs", reviewTask(currentRun([ROLE], [currentSlot(v2)]), { id: "T2" }), ROLE],
    ["the agent is not the issued role", task, "silent-failure-hunter"],
    ["the Task has no Review Run", reviewTask(undefined), ROLE],
    ["the Review Run is for another packet", reviewTask({ ...currentRun([ROLE], [currentSlot(v2)]), packet_id: "d".repeat(64) }), ROLE],
    ["the Task generation moved on", reviewTask(currentRun([ROLE], [currentSlot(v2)]), { review_generation: GENERATION + 1 }), ROLE],
  ] as const)("ignores the transcript as stale when %s", (_label, staleTask, agent) => {
    expect(resolveWaveReviewerTranscript(staleTask, agent, bytes, v2)).toEqual({ kind: "ignored-stale", agent, message: STALE });
    expect(reviewerRejectionReason(staleTask, agent, bytes, v2)).toBe(STALE);
  });

  it("treats an absent review_generation as generation 0", () => {
    const untracked = taskFixture({ id: "T1", description: "review", agent: "code-implementer-agent", wave: 1, depends_on: [],
      review_run: currentRun([ROLE], [currentSlot(v2)]) });
    expect(resolveWaveReviewerTranscript(untracked, ROLE, bytes, v2)).toEqual({ kind: "ignored-stale", agent: ROLE, message: STALE });
  });
});

describe("resolveWaveReviewerTranscript — current protocol (v2)", () => {
  const task = reviewTask(currentRun([ROLE], [currentSlot(v2)]));

  it("binds admitted findings to the issued slot", () => {
    const resolution = resolveWaveReviewerTranscript(task, ROLE, currentPayload([critical]), v2);
    expect(resolution).toEqual({
      kind: "bound-findings",
      agent: ROLE,
      findings: expect.objectContaining({ protocolVersion: 2, criticalCount: 1, advisoryCount: 0, critical: ["new defect"], advisory: [] }),
      bound: { packetId: PACKET, generation: GENERATION, priorAssessments: [{ finding_id: PRIOR_ID, verdict: "still_present", reason: "still there" }] },
      issuedSlot: { slot_id: v2.request.slotId, attempted: 1, request_id: v2.request.requestId, context_digest: v2.request.contextDigest },
    });
  });

  it("fails evidence for malformed current bytes and never falls back to the historical parser", () => {
    const legacyLooking = encode("CRITICAL_COUNT: 0\nADVISORY_COUNT: 0");
    const resolution = resolveWaveReviewerTranscript(task, ROLE, legacyLooking, v2);
    const message = "Reviewer payload must be exactly one strict JSON object. Parse error: InvalidSymbol at position 0 " +
      "(line 1, column 1) (byte 0) (payload 35 bytes; validate the emitted JSON with JSON.parse before finalizing)";
    expect(resolution).toEqual({ kind: "evidence-failed", agent: ROLE, message });
    expect(reviewerRejectionReason(task, ROLE, legacyLooking, v2)).toBe(message);
  });

  it("fails evidence for a finding located outside the frozen scope", () => {
    const bytes = currentPayload([{ ...critical, file: "src/outside.ts" }]);
    expect(resolveWaveReviewerTranscript(task, ROLE, bytes, v2)).toEqual({
      kind: "evidence-failed", agent: ROLE,
      message: `finding location is outside the frozen scope (payload ${bytes.byteLength} bytes; validate the emitted JSON with JSON.parse before finalizing)`,
    });
  });
});

describe("resolveWaveReviewerTranscript — historical protocol (v1)", () => {
  it("resolves admitted historical output against the Task's own Review Run", () => {
    const resolution = resolveWaveReviewerTranscript(reviewTask(legacyRun()), ROLE,
      legacyTranscript(["CRITICAL_COUNT: 1", "ADVISORY_COUNT: 0", "CRITICAL: legacy defect"]), v1);
    expect(resolution).toEqual({
      kind: "bound-findings",
      agent: ROLE,
      findings: expect.objectContaining({ critical: ["legacy defect"], advisory: [], criticalCount: 1, advisoryCount: 0 }),
      bound: { packetId: PACKET, generation: GENERATION, priorAssessments: [{ finding_id: PRIOR_ID, verdict: "still_present", reason: "checked" }] },
    });
    if (resolution.kind === "bound-findings") expect(Object.hasOwn(resolution, "issuedSlot")).toBe(false);
  });

  it("keeps the historical diagnostic when historical admission failed", () => {
    expect(resolveWaveReviewerTranscript(reviewTask(legacyRun()), ROLE, encode("CRITICAL_COUNT: 0\nADVISORY_COUNT: 0"), v1)).toEqual({
      kind: "evidence-failed", agent: ROLE, message: "review output omitted REVIEW_PACKET_ID or REVIEW_GENERATION",
    });
  });

  it("re-applies the issued scope to the historical resolution", () => {
    const transcript = legacyTranscript([
      "CRITICAL_COUNT: 1", "ADVISORY_COUNT: 0", "CRITICAL: outside",
      "```findings", JSON.stringify([{ severity: "critical", claim: "outside", file: "src/outside.ts", line: 1 }]), "```",
    ]);
    expect(resolveWaveReviewerTranscript(reviewTask(legacyRun()), ROLE, transcript, v1)).toEqual({
      kind: "evidence-failed", agent: ROLE, message: "review finding location(s) outside Review Packet scope: src/outside.ts",
    });
  });

  it("refuses historical output against a Task whose run requires the current protocol", () => {
    expect(resolveWaveReviewerTranscript(reviewTask(currentRun([ROLE], [currentSlot(v2)])), ROLE,
      legacyTranscript(["CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0"]), v1)).toEqual({
      kind: "evidence-failed", agent: ROLE, message: "current review requires issued reviewer protocol authority",
    });
  });

  it("never lets unminted authority reach the historical parser", () => {
    const forged: IssuedWaveReviewerProtocol = { ...v1 };
    const transcript = legacyTranscript(["CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0"]);
    expect(resolveWaveReviewerTranscript(reviewTask(legacyRun()), ROLE, transcript, forged)).toEqual({
      kind: "evidence-failed", agent: "unissued-reviewer", message: "reviewer evidence requires minted authority",
    });
    expect(reviewerRejectionReason(reviewTask(legacyRun()), ROLE, transcript, forged)).toBe("reviewer evidence requires minted authority");
  });
});

describe("reviewerRejectionReason", () => {
  it("accepts evidence that is staged while other reviewers are outstanding", () => {
    const task = reviewTask(currentRun([ROLE, "silent-failure-hunter"], [
      currentSlot(v2),
      { ...currentSlot(v2), agent: "silent-failure-hunter", slot_id: "slot:silent-failure-hunter", request_id: "request:silent-failure-hunter:1" },
    ]));
    expect(reviewerRejectionReason(task, ROLE, currentPayload([critical]), v2)).toBeNull();
  });

  it("accepts the final valid slot that closes the roster", () => {
    expect(reviewerRejectionReason(reviewTask(currentRun([ROLE], [currentSlot(v2)])), ROLE, currentPayload(), v2)).toBeNull();
  });

  it("accepts historical evidence bound to the Task's legacy run", () => {
    expect(reviewerRejectionReason(reviewTask(legacyRun()), ROLE,
      legacyTranscript(["CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0"]), v1)).toBeNull();
  });

  it("reports the transition error when the issued request does not match the slot authority", () => {
    const task = reviewTask(currentRun([ROLE], [currentSlot(v2, { request_id: "request:code-reviewer:2" })]));
    expect(reviewerRejectionReason(task, ROLE, currentPayload(), v2)).toBe("current evidence does not match issued request/context");
  });

  it("reports the transition error when a reviewer resolves a prior Finding it re-emits", () => {
    const transcript = legacyTranscript(["CRITICAL_COUNT: 1", "ADVISORY_COUNT: 0", "CRITICAL: old"], "resolved_by_remediation");
    expect(reviewerRejectionReason(reviewTask(legacyRun()), ROLE, transcript, v1))
      .toBe(`${ROLE} cannot mark prior finding ${PRIOR_ID} resolved_by_remediation and re-emit the identical finding`);
  });

  it("reports the evidence failure message for an unparseable attempt", () => {
    expect(reviewerRejectionReason(reviewTask(legacyRun()), ROLE, legacyTranscript([]), v1))
      .toBe("CRITICAL_COUNT marker not found; ADVISORY_COUNT marker not found in agent output");
  });

  it("falls back to a generic reason when the attempt changed nothing and recorded no error", () => {
    // Task generation matches the issuance but its run's generation does not:
    // the staged transition is refused as stale and leaves the Task untouched.
    const task = reviewTask(currentRun([ROLE], [currentSlot(v2)], GENERATION - 1));
    expect(reviewerRejectionReason(task, ROLE, currentPayload(), v2)).toBe("attempt did not produce accepted packet evidence");
  });
});
