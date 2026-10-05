import { describe, expect, expectTypeOf, it } from "vitest";
import fc from "fast-check";
import { buildContextPacket, buildReviewerContextPacket, encodeByteSection, type ContextPacket } from "../../src/core/context-packets";
import { CURRENT_REVIEWER_PROTOCOL, REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../src/core/reviewer-contract";
import { sha256Hex } from "../../src/core/digest";
import { createPublicationAuthorityResolver, parseAgentRequestAuthority, parseIssuedSpawnRequest, parseOrchestrationRunId, parseRequestId, type SpawnRequest } from "../../src/core/orchestration-contract";
import { lowerModelProfile, resolveAgentPolicy, resolveModelProfile } from "../../src/core/model-profiles";
import { reconcileFindings, makeParsedFindings, type CurrentParsedFindings, resolveReviewFindings, parseIssuedReviewerProtocol, parseReviewerEvidence, resolveIssuedTaskReviewFindings, applyReviewResolution, type IssuedReviewerProtocol, type ReviewerProtocolRegistration, type ReviewerSubjectBinding } from "../../src/core/review-output";
import { makeDraftFinding, mergeFindings, attributeFindings, parseStoredFindings, reviewFindingCounts, recoverViewOnlyClaims } from "../../src/core/findings";
import { taskFixture } from "../fixtures/task-lifecycle";

const bytes = (raw: unknown) => new TextEncoder().encode(JSON.stringify(raw));
function value<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
const runId = value(parseOrchestrationRunId("run.protocol-authority"));
const prior = attributeFindings([{ severity: "critical", claim: "old", file: null, line: null }], "old-reviewer");
const basis = REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!;
const critical = { ...basis, severity: "critical" as const, file: null, line: null, claim: "  exact\n claim  " };
const advisory = { severity: "advisory" as const, file: null, line: null, claim: "None", reason: "  useful\n benefit " };

/** In-memory durable publication adapter; the production receipt parser alone mints SpawnRequest. */
function publish(packet: ContextPacket, kind: ReviewerSubjectBinding["kind"], attempt: 1 | 2, role = packet.role): SpawnRequest {
  const policy = value(resolveAgentPolicy(role));
  const profile = value(resolveModelProfile(policy.profile));
  const authority = value(parseAgentRequestAuthority({
    runId, requestId: packet.requestId, slotId: "slot:code-reviewer", program: kind === "wave-review" ? "wave-gate" : "standalone-review",
    role, attempt, modelProfile: policy.profile,
    harnessBinding: { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") },
    requiredSkill: policy.requiredSkill, contextDigest: packet.digest,
    outputSlot: `transcripts/code-reviewer/attempt-${attempt}.raw`,
  }));
  const context = { digest: packet.digest, slot: { kind: "fixed-artifact-slot", path: `contexts/${packet.digest}.json` } };
  const content = { schemaVersion: 1, kind: "batch-published", effectId: "effect:reviewer-publication", runId,
    requestIds: [authority.requestId], contextDigests: [authority.contextDigest], issuedRequests: [{ authority, context }] };
  const receipt = { ...content, publicationDigest: sha256Hex(JSON.stringify(content)) };
  const resolver = createPublicationAuthorityResolver(() => ({ ok: true, value: [...bytes(receipt)] }));
  return value(parseIssuedSpawnRequest(resolver, { authority, context, issuance: {
    schemaVersion: 1, kind: "issued-spawn-request-proof", runId, effectId: content.effectId, publicationDigest: receipt.publicationDigest, batchIndex: 0,
  } }));
}

function fixture(version: 1 | 2 = 2, kind: ReviewerSubjectBinding["kind"] = "standalone-review", attempt: 1 | 2 = 1, priorFindings = prior) {
  const subject: ReviewerSubjectBinding = kind === "standalone-review"
    ? { kind, runId, scope: ["src/a.ts", "src/b.ts"] }
    : { kind, runId, scope: ["src/a.ts", "src/b.ts"], taskId: "T1", packetId: "a".repeat(64), generation: 3, priorFindingIds: priorFindings.map(({ id }) => id) };
  const section = kind === "standalone-review"
    ? { runId, scope: subject.scope, role: "code-reviewer", attempt }
    : { runId, wave: 1, authorityDigest: "b".repeat(64), batchEpoch: "c".repeat(64), subject: { role: "code-reviewer", taskId: "T1" },
        taskRun: { taskId: "T1", generation: 3, packetId: "a".repeat(64), headSha: "c".repeat(64) },
        task: { id: "T1", description: "review", agent: "code-implementer-agent", reviewGeneration: 3, planContext: null,
          specAnchors: [], specContributions: [], declaredFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"], proof: null, testResult: null, priorFindings },
        specCheckScope: null, packetId: "a".repeat(64), specFile: null, planFile: null };
  const input = { requestId: value(parseRequestId(`request:code-reviewer:${attempt}`)), role: "code-reviewer", requiredSkill: "none",
    fixedContext: [value(encodeByteSection(kind === "standalone-review" ? "standalone-review-authority" : "wave-review-authority", JSON.stringify(section)))], variableContext: [] };
  const packet = value<ContextPacket>(version === 2 ? buildReviewerContextPacket(input) : buildContextPacket({ ...input, outputContract: "Machine Summary" }));
  const request = publish(packet, kind, attempt);
  const program = kind === "wave-review" ? "wave-gate" : "standalone-review";
  const registration: ReviewerProtocolRegistration = version === 2
    ? { schemaVersion: 2, runId, program, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL }
    : { schemaVersion: 1, runId, program };
  const authority = value(parseIssuedReviewerProtocol({ request, packet, registration, subject }));
  return { request, packet, registration, subject, authority };
}

function payload(subject: ReviewerSubjectBinding, findings: readonly unknown[] = []) {
  return subject.kind === "standalone-review" ? { schemaVersion: 2, kind: subject.kind, findings }
    : { schemaVersion: 2, kind: subject.kind, packetId: subject.packetId, generation: subject.generation,
        prior_findings: subject.priorFindingIds.map((finding_id) => ({ finding_id, verdict: "still_present", reason: "  remains\n present " })), findings };
}

for (const kind of ["standalone-review", "wave-review"] as const) describe(`${kind} issuance`, () => {
  for (const version of [1, 2] as const) it(`mints only joined protocol ${version} publication authority`, () => {
    const f = fixture(version, kind);
    expect(f.authority.protocolVersion).toBe(version);
    expect(f.authority.subject).toEqual(f.subject);
    expect(Object.isFrozen(f.authority)).toBe(true);
    expect(Object.isFrozen(f.authority.subject.scope)).toBe(true);
    expect(f.authority.packet === f.packet).toBe(false);
    expect(parseIssuedReviewerProtocol({ ...f, request: { ...f.request } }).ok).toBe(false);
    expect(parseIssuedReviewerProtocol({ ...f, subject: { ...f.subject, scope: ["src/a.ts"] } }).ok).toBe(false);
    expect(parseIssuedReviewerProtocol({ ...f, registration: { ...f.registration, runId: value(parseOrchestrationRunId("run.other")) } }).ok).toBe(false);
  });

  it("preserves historical synthetic shortfalls and normalized marker/block multisets under real issuance", () => {
    const f = fixture(1, kind);
    let output = "CRITICAL_COUNT: 3\nADVISORY_COUNT: 0\nCRITICAL: same   claim\nCRITICAL: same   claim";
    if (f.subject.kind === "wave-review") output += `\nREVIEW_PACKET_ID: ${f.subject.packetId}\nREVIEW_GENERATION: ${f.subject.generation}\n\u0060\u0060\u0060review_lifecycle\n${JSON.stringify({ prior_findings: f.subject.priorFindingIds.map((finding_id) => ({ finding_id, verdict: "still_present", reason: "old" })) })}\n\u0060\u0060\u0060`;
    const legacy = resolveReviewFindings(output, "code-reviewer");
    if (legacy.kind !== "findings") throw new Error("legacy fixture failed");
    const admitted = value(parseReviewerEvidence(f.authority, new TextEncoder().encode(output)));
    expect(admitted.findings).toEqual(legacy.findings);
    expect(admitted.findings.drafts.map(({ claim }) => claim)).toEqual(["Review output parsing failed - 1 of 3 critical findings not captured", "same claim", "same claim"]);
    expect(Object.hasOwn(admitted.findings, "protocolVersion")).toBe(false);
  });

  it("accepts exact empty current output and never sniffs legacy", () => {
    const f = fixture(2, kind);
    expect(value(parseReviewerEvidence(f.authority, bytes(payload(f.subject)))).findings).toMatchObject({ protocolVersion: 2, drafts: [], criticalCount: 0, advisoryCount: 0, blockStatus: { kind: "json" } });
    const failed = parseReviewerEvidence(f.authority, new TextEncoder().encode("CRITICAL_COUNT: 3\nADVISORY_COUNT: 0\nCRITICAL: lost"));
    expect(failed).toMatchObject({ ok: false, error: { code: "invalid-json" } });
    expect("findings" in failed).toBe(false);
  });

  it("preserves exact current strings, duplicates, basis and derived counts through attribution/storage", () => {
    const f = fixture(2, kind);
    fc.assert(fc.property(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 1, max: 12 }), (confidence, count) => {
      if (critical.basis === undefined) throw new Error("critical example lacks basis");
      const draft = { ...critical, basis: { ...critical.basis, truthConfidence: confidence } };
      const findings = [...Array.from({ length: count }, () => draft), advisory];
      const admitted = value(parseReviewerEvidence(f.authority, bytes(payload(f.subject, findings))));
      expect(admitted.findings.criticalCount).toBe(count);
      expect(admitted.findings.advisoryCount).toBe(1);
      expect(reviewFindingCounts(admitted.findings.drafts)).toEqual({ critical: count, advisory: 1 });
      expect(admitted.findings.drafts).toEqual(findings.map((entry) => ({ protocolVersion: 2, ...entry })));
      const attributed = attributeFindings(admitted.findings.drafts, "code-reviewer");
      expect(new Set(attributed.map(({ id }) => id)).size).toBe(count + 1);
      expect(parseStoredFindings(JSON.parse(JSON.stringify(attributed)))).toEqual(attributed);
      expect(recoverViewOnlyClaims(attributed, [], { critical: admitted.findings.critical, advisory: admitted.findings.advisory })).toEqual([]);
      expect(Object.isFrozen(attributed[0]?.basis?.evidence)).toBe(true);
    }), { seed: 41829, numRuns: 60 });
  });
});

describe("authority refusal", () => {
  it("makes legacy normalization and unbound merge unable to accept current evidence", () => {
    expectTypeOf<CurrentParsedFindings>().not.toMatchTypeOf<Parameters<typeof reconcileFindings>[0]>();
    expectTypeOf<CurrentParsedFindings>().not.toMatchTypeOf<Parameters<typeof makeParsedFindings>[0]>();
    expectTypeOf<CurrentParsedFindings>().not.toMatchTypeOf<Parameters<typeof mergeFindings>[1]>();
    expectTypeOf<CurrentParsedFindings["drafts"][number]>().not.toMatchTypeOf<Parameters<typeof makeDraftFinding>[0]>();
  });
  it("checks minted membership before getters or byte observation", () => {
    let reads = 0;
    const forged = Object.defineProperty({}, "protocolVersion", { get() { reads++; throw new Error("getter"); } }) as IssuedReviewerProtocol;
    const raw = new Proxy(new Uint8Array(), { get() { reads++; throw new Error("bytes"); } });
    expect(parseReviewerEvidence(forged, raw)).toMatchObject({ ok: false, error: { code: "authority-unavailable" } });
    expect(reads).toBe(0);
    const f = fixture();
    expect(parseReviewerEvidence({ ...f.authority }, bytes(payload(f.subject))).ok).toBe(false);
  });
  it("names the thrown error class, never its payload-bearing message, when evidence inspection throws", () => {
    const f = fixture(2);
    for (const [thrown, name] of [
      [new TypeError("SECRET payload text"), "TypeError"],
      [new RangeError("SECRET payload text"), "RangeError"],
      ["SECRET payload text", "NonErrorThrown"],
    ] as const) {
      // The decoder's first observation of the bytes throws: a programming
      // defect and a hostile value must both fail closed, distinguishably.
      const raw = new Proxy(new Uint8Array(), { get() { throw thrown; } });
      const result = parseReviewerEvidence(f.authority, raw);
      expect(result).toMatchObject({ ok: false, error: {
        code: "invalid-payload", path: "/", message: `reviewer evidence could not be inspected (${name})`,
      } });
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
    // The historical decoder shares the boundary.
    const legacy = parseReviewerEvidence(fixture(1).authority, new Proxy(new Uint8Array(), { get() { throw new TypeError("SECRET"); } }));
    expect(legacy).toMatchObject({ ok: false, error: { code: "invalid-payload", path: "/" } });
    if (!legacy.ok) expect(legacy.error.message).toMatch(/^reviewer evidence could not be inspected \(\w+\)$/);
    expect(JSON.stringify(legacy)).not.toContain("SECRET");
  });
  it("names the thrown error class when authority inspection throws", () => {
    const f = fixture();
    const input = Object.defineProperty({ ...f }, "packet", { get() { throw new TypeError("SECRET packet text"); } });
    const result = parseIssuedReviewerProtocol(input);
    expect(result).toMatchObject({ ok: false, error: {
      code: "authority-unavailable", path: "/", message: "reviewer authority could not be inspected (TypeError)",
    } });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("refuses a genuinely published request whose role differs from the packet", () => {
    const f = fixture();
    const request = publish(f.packet, "standalone-review", 1, "silent-failure-hunter");
    expect(parseIssuedReviewerProtocol({ ...f, request })).toMatchObject({ ok: false, error: { code: "authority-mismatch", path: "/request" } });
  });

  it("refuses a self-consistent published packet with the wrong required Skill", () => {
    const f = fixture();
    const packet = value(buildReviewerContextPacket({
      requestId: f.packet.requestId, role: f.packet.role, requiredSkill: "unexpected-skill",
      fixedContext: f.packet.fixedContext.filter(({ label }) => label === "standalone-review-authority"), variableContext: [],
    }));
    const request = publish(packet, "standalone-review", 1);
    expect(parseIssuedReviewerProtocol({ ...f, request, packet })).toMatchObject({ ok: false, error: { code: "authority-mismatch", path: "/request" } });
  });

  it("refuses registration accessors without evaluating them", () => {
    const f = fixture();
    let reads = 0;
    const registration = Object.defineProperty({ ...f.registration }, "schemaVersion", { enumerable: true, get() { reads++; return 2; } });
    expect(parseIssuedReviewerProtocol({ ...f, registration }).ok).toBe(false);
    expect(reads).toBe(0);
  });

  it("rejects current registration downgrade, removed descriptor and packet/request mismatch", () => {
    const f = fixture();
    expect(parseIssuedReviewerProtocol({ ...f, registration: { schemaVersion: 1, runId, program: "standalone-review" } }).ok).toBe(false);
    expect(parseIssuedReviewerProtocol({ ...f, registration: { schemaVersion: 2, runId, program: "standalone-review" } as ReviewerProtocolRegistration }).ok).toBe(false);
    const retry = fixture(2, "standalone-review", 2);
    expect(parseIssuedReviewerProtocol({ ...f, packet: retry.packet }).ok).toBe(false);
    expect(parseIssuedReviewerProtocol({ ...f, subject: { ...f.subject, scope: [...f.subject.scope].reverse() } }).ok).toBe(false);
  });
  it("retains ordinary historical failure diagnostics but bounds and escapes untrusted diagnostics", () => {
    const f = fixture(1);
    expect(parseReviewerEvidence(f.authority, new TextEncoder().encode("missing output"))).toMatchObject({ ok: false, error: { message: "CRITICAL_COUNT marker not found; ADVISORY_COUNT marker not found in agent output" } });
    const output = `CRITICAL_COUNT: 1\nADVISORY_COUNT: 0\n\u0060\u0060\u0060findings\n${JSON.stringify([{ severity: "critical", claim: "problem", file: "\u202e" + "🦄".repeat(3000), line: 1 }])}\n\u0060\u0060\u0060`;
    const failure = parseReviewerEvidence(f.authority, new TextEncoder().encode(output));
    if (failure.ok) throw new Error("scope refusal expected");
    expect(new TextEncoder().encode(failure.error.message).length).toBeLessThanOrEqual(2048);
    expect(failure.error.message).not.toContain("\u202e");
  });

  it("rejects current malformed bytes and whole-output shape without partial findings", () => {
    const f = fixture();
    const invalid = [new Uint8Array([255]), bytes({ schemaVersion: 2, kind: "wave-review", packetId: "a".repeat(64), generation: 0, prior_findings: [], findings: [] }), bytes({ ...payload(f.subject, [critical]), criticalCount: 1 }), bytes(payload(f.subject, [{ severity: "critical", file: null, line: null, claim: "missing basis" }])), bytes(payload(f.subject, [{ ...advisory, file: "src/outside.ts" }]))];
    for (const raw of invalid) {
      const result = parseReviewerEvidence(f.authority, raw);
      expect(result.ok).toBe(false);
      expect(Object.keys(result).sort()).toEqual(["error", "ok"]);
    }
  });
});

describe("Wave current binding and lifecycle", () => {
  it("joins ordered prior IDs independently and rejects reordered assessments", () => {
    const priors = attributeFindings([{ severity: "critical", claim: "one", file: null, line: null }, { severity: "critical", claim: "two", file: null, line: null }], "prior");
    const f = fixture(2, "wave-review", 1, priors);
    if (f.subject.kind !== "wave-review") throw new Error("Wave expected");
    expect(parseIssuedReviewerProtocol({ ...f, subject: { ...f.subject, priorFindingIds: [...f.subject.priorFindingIds].reverse() } }).ok).toBe(false);
    const raw = payload(f.subject);
    if (!("prior_findings" in raw)) throw new Error("Wave expected");
    expect(parseReviewerEvidence(f.authority, bytes({ ...raw, prior_findings: [...raw.prior_findings!].reverse() })).ok).toBe(false);
  });

  it.each(["count", "ID length", "NUL", "surrogate", "minimum payload bytes"])("refuses an unrepresentable current prior roster: %s", (bound) => {
    let priors = prior;
    if (bound === "count") priors = Array.from({ length: 4097 }, (_, index) => ({ ...prior[0]!, id: `prior-${index + 1}` }));
    if (bound === "ID length") priors = [{ ...prior[0]!, id: "x".repeat(2049) }];
    if (bound === "NUL") priors = [{ ...prior[0]!, id: "prior\0id" }];
    if (bound === "surrogate") priors = [{ ...prior[0]!, id: "prior\ud800" }];
    if (bound === "minimum payload bytes") priors = Array.from({ length: 600 }, (_, index) => ({ ...prior[0]!, id: `${"x".repeat(2000)}-${index}` }));
    expect(() => fixture(2, "wave-review", 1, priors)).toThrow("published subject must match full scope and ordered prior roster");
  });
  it.each(["packet", "generation", "missing", "foreign", "duplicate"])("refuses %s prior/binding mutation", (mutation) => {
    const f = fixture(2, "wave-review");
    const raw = payload(f.subject);
    if (!("prior_findings" in raw)) throw new Error("Wave expected");
    const changed = { ...raw,
      ...(mutation === "packet" ? { packetId: "d".repeat(64) } : {}),
      ...(mutation === "generation" ? { generation: 2 } : {}),
      ...(mutation === "missing" ? { prior_findings: [] } : {}),
      ...(mutation === "foreign" ? { prior_findings: [{ finding_id: "foreign", verdict: "still_present", reason: "reason" }] } : {}),
      ...(mutation === "duplicate" ? { prior_findings: [...raw.prior_findings!, ...raw.prior_findings!] } : {}),
    };
    expect(parseReviewerEvidence(f.authority, bytes(changed)).ok).toBe(false);
  });
  it("keeps identical new drafts beside a still-present prior with exact request/context authority", () => {
    const f = fixture(2, "wave-review");
    if (f.authority.subject.kind !== "wave-review") throw new Error("Wave expected");
    // Narrowing a nested discriminant requires reconstructing neither authority nor membership.
    const authority = f.authority as Extract<IssuedReviewerProtocol, { subject: { kind: "wave-review" } }>;
    const request = authority.request;
    const slot = { agent: request.role, slot_id: request.slotId, attempted: request.attempt, request_id: request.requestId, context_digest: request.contextDigest };
    const task = taskFixture({ id: "T1", description: "review", agent: "code-implementer-agent", wave: 1, depends_on: [], findings: prior, critical_findings: ["old"], advisory_findings: [], review_generation: 3,
      review_run: { reviewer_protocol: CURRENT_REVIEWER_PROTOCOL, generation: 3, packet_id: "a".repeat(64), head_sha: "c".repeat(64),
        expected_agents: [request.role], prior_finding_ids: prior.map(({ id }) => id), evidence: [], slot_authority: [slot],
        workspace_scope: authority.subject.scope, workspace_head_sha: "c".repeat(64), wave_gate_run_id: runId, wave_gate_authority_digest: "b".repeat(64) } });
    const resolution = resolveIssuedTaskReviewFindings(authority, bytes(payload(f.subject, [{ ...critical, claim: "old" }, { ...critical, claim: "old" }])));
    const next = applyReviewResolution(task, resolution);
    expect(next.findings?.map(({ id }) => id)).toEqual(["old-reviewer-1", "code-reviewer-1", "code-reviewer-2"]);
    expect(next.accepted_review_authority?.reviewer_protocol).toEqual(CURRENT_REVIEWER_PROTOCOL);
    expect(next.review_run).toBeUndefined();
    expect(task.findings).toEqual(prior);
  });
});
