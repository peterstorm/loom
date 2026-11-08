import { describe, expect, it } from "vitest";
import { buildReviewerContextPacket, encodeByteSection, type ContextPacket } from "../../src/core/context-packets";
import { sha256Hex } from "../../src/core/digest";
import { lowerModelProfile, resolveAgentPolicy, resolveModelProfile } from "../../src/core/model-profiles";
import {
  createPublicationAuthorityResolver,
  parseAgentRequestAuthority,
  parseIssuedSpawnRequest,
  parseOrchestrationRunId,
  parseRequestId,
  type SpawnRequest,
} from "../../src/core/orchestration-contract";
import { CURRENT_REVIEWER_PROTOCOL, REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../src/core/reviewer-contract";
import { parseIssuedReviewerProtocol, type IssuedReviewerProtocol, type IssuedStandaloneReviewerProtocol } from "../../src/core/review-output";
import { admitStandaloneTranscript } from "../../src/core/standalone-transcript-admission";
import { value } from "../fixtures/parse-result";

/**
 * The admission a reviewer's retry is built from.
 *
 * Both rejections this engine's own six-slice review run took were refused here
 * (standalone `submit` → `admitStandaloneReviewerResult` → this function), and
 * both retry preambles carried a bare sentence — `Reviewer payload does not
 * conform to the issued v2 schema.` and `finding location is outside the frozen
 * scope` — with no JSON pointer, no offending file and no size. Attempt 2 had
 * nothing to correct against. These cases pin the facts the parse already held.
 */

const runId = value(parseOrchestrationRunId("run.standalone-admission"));
const ROLE = "code-reviewer";
const SCOPE = ["src/a.ts"] as const;

const encode = (raw: unknown) => new TextEncoder().encode(JSON.stringify(raw));

const isStandaloneProtocol = (protocol: IssuedReviewerProtocol): protocol is IssuedStandaloneReviewerProtocol =>
  protocol.subject.kind === "standalone-review";

/** Publication-issued request + exact packet, the only way to mint protocol authority. */
function issuedProtocol(scope: readonly string[] = SCOPE): IssuedStandaloneReviewerProtocol {
  const requestId = value(parseRequestId(`request:${ROLE}:1`));
  const packet: ContextPacket = value(buildReviewerContextPacket({
    requestId, role: ROLE, requiredSkill: "none",
    fixedContext: [value(encodeByteSection("standalone-review-authority", JSON.stringify({
      runId, scope, role: ROLE, attempt: 1,
    })))],
    variableContext: [],
  }));
  const policy = value(resolveAgentPolicy(ROLE));
  const profile = value(resolveModelProfile(policy.profile));
  const authority = value(parseAgentRequestAuthority({
    runId, requestId: packet.requestId, slotId: `slot:${ROLE}`, program: "standalone-review",
    role: ROLE, attempt: 1, modelProfile: policy.profile,
    harnessBinding: { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") },
    requiredSkill: policy.requiredSkill, contextDigest: packet.digest,
    outputSlot: `transcripts/${ROLE}/attempt-1.raw`,
  }));
  const context = { digest: packet.digest, slot: { kind: "fixed-artifact-slot" as const, path: `contexts/${packet.digest}.json` } };
  const content = { schemaVersion: 1, kind: "batch-published", effectId: "effect:reviewer-publication", runId,
    requestIds: [authority.requestId], contextDigests: [authority.contextDigest], issuedRequests: [{ authority, context }] };
  const receipt = { ...content, publicationDigest: sha256Hex(JSON.stringify(content)) };
  const published: SpawnRequest = value(parseIssuedSpawnRequest(
    createPublicationAuthorityResolver(() => ({ ok: true, value: [...encode(receipt)] })),
    { authority, context, issuance: {
      schemaVersion: 1, kind: "issued-spawn-request-proof", runId, effectId: content.effectId,
      publicationDigest: receipt.publicationDigest, batchIndex: 0,
    } },
  ));
  const protocol = parseIssuedReviewerProtocol({
    request: published, packet,
    registration: { schemaVersion: 2, runId, program: "standalone-review", reviewerProtocol: CURRENT_REVIEWER_PROTOCOL },
    subject: { kind: "standalone-review", runId, scope: [...scope] },
  });
  if (!protocol.ok || !isStandaloneProtocol(protocol.value)) {
    throw new Error(`standalone protocol fixture must be issued: ${protocol.ok ? "wrong subject" : protocol.error.message}`);
  }
  return protocol.value;
}

const critical = { ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, severity: "critical" as const, file: "src/a.ts", line: 4 };
const payload = (findings: readonly unknown[]) => encode({ schemaVersion: 2, kind: "standalone-review", findings });

describe("admitStandaloneTranscript — a refusal an agent can act on", () => {
  it("names the JSON pointer and the schema defect, plus the payload size", () => {
    const basis = critical.basis;
    if (basis === undefined) throw new Error("the issued v2 example's critical finding must carry a basis");
    const bytes = payload([{ ...critical, basis: { ...basis, evidence: { ...basis.evidence, preconditions: "run the suite" } } }]);
    const admission = admitStandaloneTranscript(issuedProtocol(), bytes);
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    const [problem] = admission.problems;
    // WHERE and WHY and HOW BIG — the three facts attempt 2 needs.
    expect(problem).toMatch(
      /^Reviewer payload does not conform to the issued v2 schema: .+ at \/findings\/0\/basis\/evidence\/preconditions \(payload \d+ bytes; /,
    );
    expect(problem).toContain("tuple");
    expect(problem).toContain(`${bytes.byteLength} bytes`);
  });

  it("names the offending finding, its file and its pointer when the location is outside the frozen scope", () => {
    const bytes = payload([critical, { ...critical, file: "src/outside.ts" }]);
    const admission = admitStandaloneTranscript(issuedProtocol(), bytes);
    expect(admission).toEqual({ ok: false, problems: [
      `findings[1].file is outside the frozen review scope: src/outside.ts at /findings/1/file (payload ${bytes.byteLength} bytes; validate the emitted JSON with JSON.parse before finalizing)`,
    ] });
  });

  it("admits a payload that conforms, so the refusal cases above are the refusal path and not the only path", () => {
    const admitted = admitStandaloneTranscript(issuedProtocol(), payload([critical]));
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.findings.criticalCount).toBe(1);
  });
});
