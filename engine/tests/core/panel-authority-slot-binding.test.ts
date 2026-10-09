import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  boundCandidateEntry,
  boundJudgeCriterion,
  boundRefutationLens,
  deriveRefutationVerifierBinding,
  parseArchitecturePanelAuthority,
  parseRefutationPanelAuthority,
  type ArchitecturePanelAuthority,
  type RefutationPanelAuthority,
} from "../../src/core/panel-authority";
import {
  parseAgentRequestAuthority,
  parseAgentRosterSlot,
  parseContextDigest,
  parseOrchestrationRunId,
  parseRequestId,
  parseSlotId,
  type NonEmpty,
  type OrchestrationRunId,
  type SlotId,
} from "../../src/core/orchestration-contract";
import { parseWaveFindingId, type BriefFinding, type ReviewLens, type WaveFindingId } from "../../src/core/review-panel";
import { lowerModelProfile, resolveModelProfile, type LlmProfileId } from "../../src/core/model-profiles";
import { value } from "../fixtures/parse-result";

/**
 * The slot-to-entry refusals of the panel authority: a slot the roster does
 * not hold, or a slot whose ordinal lies past the paired entry list, is a
 * typed `request-binding-mismatch`, never an entry read as `undefined`.
 */


const hexDigest = (seed: string): string => createHash("sha256").update(seed).digest("hex");
/** The binding the catalog issues `profileId` under today, so each minted
 *  attempt below passes the issue-mode check without re-spelling a target. */
const harnessBinding = (profileId: LlmProfileId) => {
  const profile = value(resolveModelProfile(profileId));
  return { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") };
};

function attemptAuthority(
  runId: OrchestrationRunId,
  slotId: SlotId,
  requestId: string,
  attempt: 1 | 2,
  program: "architecture-panel" | "refutation-panel",
  role: "arch-designer-agent" | "arch-judge-agent" | "review-verifier-agent",
) {
  const modelProfile: LlmProfileId = role === "arch-designer-agent" ? "panel-design" : role === "arch-judge-agent" ? "panel-judge" : "refutation";
  return value(parseAgentRequestAuthority({
    runId,
    requestId: value(parseRequestId(requestId)),
    slotId,
    program,
    role,
    attempt,
    modelProfile,
    harnessBinding: harnessBinding(modelProfile),
    requiredSkill: role === "arch-designer-agent" ? "architecture-tech-lead" : null,
    contextDigest: value(parseContextDigest(hexDigest(`${requestId}:context`))),
    outputSlot: `transcripts/${slotId.replace(/:/g, "-")}-attempt-${attempt}.json`,
  }));
}

function ordinalSlot(
  runId: OrchestrationRunId,
  stage: string,
  ordinal: number,
  role: "arch-designer-agent" | "arch-judge-agent",
) {
  const slotId = value(parseSlotId(`${stage}:${ordinal}`));
  return value(parseAgentRosterSlot(
    attemptAuthority(runId, slotId, `${runId}:${stage}:${ordinal}:1`, 1, "architecture-panel", role),
    attemptAuthority(runId, slotId, `${runId}:${stage}:${ordinal}:2`, 2, "architecture-panel", role),
  ));
}

function architectureAuthority(): ArchitecturePanelAuthority {
  const runId = value(parseOrchestrationRunId("run.architecture.slot-binding"));
  return value(parseArchitecturePanelAuthority({
    runId,
    candidateLenses: ["simplicity-first", "type-driven-fp"],
    judgeCriteria: ["simplicity", "pure functional core"],
    candidateSlots: [ordinalSlot(runId, "candidate", 1, "arch-designer-agent"), ordinalSlot(runId, "candidate", 2, "arch-designer-agent")],
    judgeSlots: [ordinalSlot(runId, "judge", 1, "arch-judge-agent"), ordinalSlot(runId, "judge", 2, "arch-judge-agent")],
  }));
}

const waveId = (raw: string): WaveFindingId => {
  const id = parseWaveFindingId(raw);
  if (id === null) throw new Error(`invalid wave finding id ${raw}`);
  return id;
};

function refutationAuthority(): RefutationPanelAuthority {
  const runId = value(parseOrchestrationRunId("run.refutation.slot-binding"));
  const findings: readonly [BriefFinding, ...BriefFinding[]] = [
    { id: waveId("T1:code-reviewer-1"), taskId: "T1", agent: "code-reviewer", severity: "critical", file: "src/a.ts", line: 10, claim: "first claim" },
  ];
  const findingIds = findings.map(({ id }) => id) as unknown as NonEmpty<WaveFindingId>;
  const lenses = ["reproduction", "intent"] as const;
  const verifierSlots = lenses.map((lens) => {
    const binding = value(deriveRefutationVerifierBinding(runId, lens as ReviewLens, findingIds));
    return value(parseAgentRosterSlot(
      attemptAuthority(runId, binding.slotId, binding.requestIds[0], 1, "refutation-panel", "review-verifier-agent"),
      attemptAuthority(runId, binding.slotId, binding.requestIds[1], 2, "refutation-panel", "review-verifier-agent"),
    ));
  });
  return value(parseRefutationPanelAuthority({ runId, findings, lenses, verifierSlots }));
}

const unknownSlot = value(parseSlotId("stranger:9"));

const expectBindingRefusal = (
  result: { readonly ok: true } | { readonly ok: false; readonly error: Readonly<{ kind: string; message: string }> },
  message: string,
) => {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.kind).toBe("request-binding-mismatch");
  expect(result.error.message).toContain(message);
};

describe("panel authority slot binding refuses an unbound slot", () => {
  const architecture = architectureAuthority();
  const refutation = refutationAuthority();
  const lastCandidate = architecture.candidateRoster.orderedSlots[1]!.slotId;
  const lastJudge = architecture.judgeRoster.orderedSlots[1]!.slotId;
  const lastVerifier = refutation.verifierRoster.orderedSlots[1]!.slotId;

  it("binds every rostered slot to its positional entry", () => {
    expect(boundCandidateEntry(architecture, lastCandidate)).toEqual({
      ok: true,
      value: { lens: architecture.candidateLenses[1], candidate: architecture.candidateIds[1] },
    });
    expect(boundJudgeCriterion(architecture, lastJudge)).toEqual({ ok: true, value: architecture.judgeCriteria[1] });
    expect(boundRefutationLens(refutation, lastVerifier)).toEqual({ ok: true, value: refutation.lenses[1] });
  });

  it.each([
    ["boundCandidateEntry", () => boundCandidateEntry(architecture, unknownSlot), "is bound to no candidate lens"],
    ["boundJudgeCriterion", () => boundJudgeCriterion(architecture, unknownSlot), "is bound to no judge criterion"],
    ["boundRefutationLens", () => boundRefutationLens(refutation, unknownSlot), "is bound to no refutation lens"],
  ] as const)("%s refuses a slot the roster does not hold", (_name, bind, message) => {
    expectBindingRefusal(bind(), message);
  });

  it.each([
    ["boundCandidateEntry (lenses)", () => boundCandidateEntry(
      { ...architecture, candidateLenses: [architecture.candidateLenses[0]] }, lastCandidate), "is bound to no candidate lens"],
    ["boundCandidateEntry (candidate ids)", () => boundCandidateEntry(
      { ...architecture, candidateIds: [architecture.candidateIds[0]!] }, lastCandidate), "is bound to no candidate lens"],
    ["boundJudgeCriterion", () => boundJudgeCriterion(
      { ...architecture, judgeCriteria: [architecture.judgeCriteria[0]] }, lastJudge), "is bound to no judge criterion"],
    ["boundRefutationLens", () => boundRefutationLens(
      { ...refutation, lenses: [refutation.lenses[0]] }, lastVerifier), "is bound to no refutation lens"],
  ] as const)("%s refuses a rostered slot whose ordinal lies past the paired entries", (_name, bind, message) => {
    expectBindingRefusal(bind(), message);
  });
});
