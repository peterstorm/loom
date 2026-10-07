/**
 * The two `findings.ts` guards whose rejecting branch nothing exercised.
 *
 * `startReviewRun`'s binding validation and `findingIdCollisionError`'s
 * `resolved_findings` arm are both fail-closed checks against values that reach
 * them from a task graph on disk, not from a caller with a fixed constant. Every
 * existing test supplied a well-formed binding and a three-argument collision
 * check, so deleting either branch left the suite green.
 */

import { describe, expect, it } from "vitest";
import { findingIdCollisionError, startReviewRun, type Finding } from "../../src/core/findings";
import type { HeadSha, PacketId } from "../../src/core/review-packet";
import type { CurrentDraftFinding, Task } from "../../src/types";
import fc from "fast-check";
import { REVIEWER_PAYLOAD_EXAMPLE_V2, reviewerDraftV2Schema } from "../../src/core/reviewer-contract";
import { attributeFindings, parseStoredFindings, parseStoredRefutations, parseStoredResolutions, currentFindingAuthorityError, salvageMalformedFindings, recoverViewOnlyClaims, claimsOfSeverity, applyFindingOutcomes } from "../../src/core/findings";
import { fixFull } from "../../src/handlers/helpers/validate-task-graph";
import { updateTaskFindings } from "../../src/handlers/helpers/store-review-findings";
import { findingId } from "../fixtures/finding-id";

function currentDraft(claim = "  preserved\n  claim "): CurrentDraftFinding {
  return { protocolVersion: 2, ...reviewerDraftV2Schema.parse({ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0], file: "src/x.ts", claim }) };
}

describe("current Finding stored authority", () => {
  it.each([
    ["missing discriminator", (raw: Record<string, unknown>) => { delete raw.protocolVersion; }],
    ["unsupported discriminator", (raw: Record<string, unknown>) => { raw.protocolVersion = 3; }],
    ["null discriminator", (raw: Record<string, unknown>) => { raw.protocolVersion = null; }],
    ["missing basis", (raw: Record<string, unknown>) => { delete raw.basis; }],
    ["unknown basis field", (raw: Record<string, unknown>) => { raw.basis = { ...(raw.basis as object), unknown: true }; }],
    ["unknown evidence field", (raw: Record<string, unknown>) => { const basis = raw.basis as Record<string, unknown>; basis.evidence = { ...(basis.evidence as object), unknown: true }; }],
    ["advisory reason without discriminator", (raw: Record<string, unknown>) => { delete raw.protocolVersion; delete raw.basis; raw.severity = "advisory"; raw.reason = "useful"; }],
  ] as const)("refuses %s in active, refuted and resolved records before repair", (_name, mutate) => {
    const raw: Record<string, unknown> = JSON.parse(JSON.stringify(attributeFindings([currentDraft()], "code-reviewer")[0]));
    mutate(raw);
    for (const field of ["findings", "refuted_findings", "resolved_findings"]) {
      const task = { ...readyTask(), [field]: field === "findings" ? [raw] : [{ finding: raw }] };
      expect(currentFindingAuthorityError(task)).not.toBeNull();
      expect(JSON.parse(fixFull({ tasks: [task] }).json).tasks[0]).toEqual(task);
    }
    expect(parseStoredFindings([raw])).toEqual([]);
    expect(salvageMalformedFindings([raw])).toEqual([]);
  });

  it("keeps unrelated historical unknown-field salvage unchanged", () => {
    const old = { severity: "critical", claim: "  old\n claim  ", file: null, line: null, arbitraryOldKey: 1 };
    expect(salvageMalformedFindings([old])).toEqual([{ severity: "critical", claim: "old claim", file: null, line: null }]);
  });

  it("conserves exact multiplicity, basis and identities through repair/refutation/resolution", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 0, max: 100 }), (count, confidence) => {
      const source = currentDraft();
      if (source.severity !== "critical") throw new Error("critical fixture expected");
      const draft = { ...source, basis: { ...source.basis, truthConfidence: confidence } };
      const findings = attributeFindings(Array.from({ length: count }, () => draft), "code-reviewer");
      const task: Task = { ...readyTask(), review_status: "blocked", findings, critical_findings: claimsOfSeverity(findings, "critical") };
      const fixed = JSON.parse(fixFull({ tasks: [task] }).json).tasks[0];
      expect(fixed.findings).toEqual(findings);
      expect(fixed.critical_findings).toEqual(task.critical_findings);
      const override = updateTaskFindings(task, [], [], false);
      expect(override.findings).toEqual([]);
      expect(parseStoredRefutations(override.refuted_findings).map(({ finding }) => finding)).toEqual(findings);
      expect(recoverViewOnlyClaims(findings, [], { critical: task.critical_findings, advisory: [] })).toEqual([]);
      const retired = applyFindingOutcomes(task, findings.map(({ id }) => ({ finding: { id, taskId: task.id }, survives: false as const, refutations: [{ lens: "intent", reason: "contract permits it" }] as const })));
      expect(parseStoredRefutations(JSON.parse(JSON.stringify(retired.refuted_findings))).map(({ finding }) => finding)).toEqual(findings);
      const resolved = findings.map((finding) => ({ finding, resolution: { kind: "resolved_by_remediation", generation: 2, packet_id: PACKET, head_sha: HEAD,
        expected_agents: ["code-reviewer"], assessments: [{ agent: "code-reviewer", finding_id: finding.id, verdict: "resolved_by_remediation", reason: "verified" }] } }));
      expect(parseStoredResolutions(JSON.parse(JSON.stringify(resolved))).map(({ finding }) => finding)).toEqual(findings);
      expect(Object.isFrozen(parseStoredFindings(findings)[0]?.basis?.consequence)).toBe(true);
    }), { seed: 99184, numRuns: 80 });
  });

  it("repairs duplicate current identities without losing generation, basis or exact claims", () => {
    const [finding] = attributeFindings([currentDraft()], "code-reviewer", 1, { generation: 1, packetId: PACKET });
    if (finding === undefined) throw new Error("finding fixture missing");
    const task = { ...readyTask(), findings: [finding, finding], critical_findings: [finding.claim, finding.claim] };
    const repaired = JSON.parse(fixFull({ tasks: [task] }).json).tasks[0];
    expect(repaired.findings).toEqual([finding, { ...finding, id: "code-reviewer-2" }]);
  });

  it("consumes current exact occurrences before normalized legacy multiset recovery", () => {
    const findings = attributeFindings([currentDraft(" a  b "), { severity: "critical", file: null, line: null, claim: "a b" }], "reviewer");
    expect(recoverViewOnlyClaims(findings, [], { critical: [" a  b ", "a b", "a   b"], advisory: [] }).map(({ claim }) => claim)).toEqual(["a b"]);
  });
});

// Branded as the smart constructors would mint them. The malformed cases below
// cast deliberately: they exercise startReviewRun's fail-closed checks against a
// value that reached the binding WITHOUT going through parsePacketId/parseHeadSha
// — the one gap a compile-time brand cannot close.
const PACKET = "a".repeat(64) as PacketId;
const HEAD = "b".repeat(40) as HeadSha;

const finding = (id: string, agent: string, claim: string): Finding => ({
  id: findingId(id),
  agent,
  severity: "critical",
  file: "src/x.ts",
  line: 1,
  claim,
});

/** A task that is ready to open a review run, so only the binding is under test. */
function readyTask(): Task {
  return {
    id: "T1",
    description: "fix review findings",
    agent: "code-implementer-agent",
    wave: 1,
    status: "implemented",
    legacy_missing_proof: true,
    depends_on: [],
    review_status: "pending",
    review_generation: 1,
    findings: [],
    critical_findings: [],
    advisory_findings: [],
    refuted_findings: [],
    resolved_findings: [],
  };
}

const runWith = (overrides: Partial<Parameters<typeof startReviewRun>[1]>) =>
  startReviewRun(readyTask(), {
    generation: 1,
    packetId: PACKET,
    headSha: HEAD,
    expectedAgents: ["code-reviewer", "silent-failure-hunter"],
    ...overrides,
  });

describe("startReviewRun refuses a malformed run binding", () => {
  it("accepts the well-formed binding these cases are varied from", () => {
    expect(runWith({}).ok).toBe(true);
  });

  describe("packet id", () => {
    it.each([
      ["too short", "a".repeat(63)],
      ["too long", "a".repeat(65)],
      ["not lowercase hex", "A".repeat(64)],
      ["non-hex characters", "z".repeat(64)],
      ["empty", ""],
    ])("refuses a packet id that is %s", (_label, packetId) => {
      const transition = runWith({ packetId: packetId as PacketId });
      expect(transition.ok).toBe(false);
      if (transition.ok) return;
      expect(transition.error).toContain("review packet id is invalid");
    });
  });

  describe("head SHA", () => {
    it.each([
      ["too short", "b".repeat(39)],
      ["between the accepted lengths", "b".repeat(50)],
      ["longer than a full 64-char SHA", "b".repeat(65)],
      ["not lowercase hex", "B".repeat(40)],
      ["empty", ""],
    ])("refuses a head SHA that is %s", (_label, headSha) => {
      const transition = runWith({ headSha: headSha as HeadSha });
      expect(transition.ok).toBe(false);
      if (transition.ok) return;
      expect(transition.error).toContain("review head SHA is invalid");
    });

    it("accepts the abbreviated 40-char and full 64-char forms", () => {
      expect(runWith({ headSha: "b".repeat(40) as HeadSha }).ok).toBe(true);
      expect(runWith({ headSha: "b".repeat(64) as HeadSha }).ok).toBe(true);
    });
  });

  describe("expected agents", () => {
    it.each([
      ["empty", []],
      ["repeating an agent", ["code-reviewer", "code-reviewer"]],
      ["containing an empty name", ["code-reviewer", ""]],
      ["containing a whitespace-only name", ["code-reviewer", "   "]],
    ])("refuses an expected-agents list that is %s", (_label, expectedAgents) => {
      const transition = runWith({ expectedAgents });
      expect(transition.ok).toBe(false);
      if (transition.ok) return;
      expect(transition.error).toContain("expected agents must be non-empty and unique");
    });
  });
});

describe("findingIdCollisionError sees the resolved_findings arm", () => {
  const live = finding("code-reviewer-1", "code-reviewer", "live claim");

  /** The stored envelope `parseStoredResolution` accepts, wrapping one finding. */
  const resolutionOf = (wrapped: Finding) => ({
    finding: wrapped,
    resolution: {
      kind: "resolved_by_remediation",
      generation: 2,
      packet_id: PACKET,
      head_sha: HEAD,
      expected_agents: ["code-reviewer"],
      assessments: [{
        agent: "code-reviewer",
        finding_id: wrapped.id,
        verdict: "resolved_by_remediation",
        reason: "fixed in remediation",
      }],
    },
  });

  it("reports an id that is live and already resolved", () => {
    const error = findingIdCollisionError([live], [], "T1", [resolutionOf(live)]);
    expect(error).not.toBeNull();
    expect(error).toContain("code-reviewer-1");
    expect(error).toContain("resolved_findings");
  });

  it("reports an id that is refuted and already resolved", () => {
    const refuted = { finding: live, refutations: [{ lens: "intent", reason: "deliberate" }] };
    const error = findingIdCollisionError([], [refuted], "T1", [resolutionOf(live)]);
    expect(error).not.toBeNull();
    expect(error).toContain("resolved_findings");
  });

  it("stays silent when the resolved id is distinct from every live and refuted id", () => {
    const other = finding("code-reviewer-2", "code-reviewer", "other claim");
    expect(findingIdCollisionError([live], [], "T1", [resolutionOf(other)])).toBeNull();
  });

  it("stays silent when the resolved argument is omitted, as the three-arg callers rely on", () => {
    expect(findingIdCollisionError([live], [], "T1")).toBeNull();
  });

  it("ignores a resolved entry whose envelope does not parse, rather than reporting a false collision", () => {
    // A malformed envelope yields no finding, so it cannot own an id — the
    // salvage path, not the collision path, is what recovers it.
    expect(findingIdCollisionError([live], [], "T1", [{ finding: live, resolution: { kind: "nonsense" } }])).toBeNull();
  });
});
