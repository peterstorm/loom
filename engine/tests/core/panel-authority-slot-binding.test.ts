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

/**
 * The slot-to-entry refusals of the panel authority: a slot the roster does
 * not hold, or a slot whose ordinal lies past the paired entry list, is a
 * typed `request-binding-mismatch`, never an entry read as `undefined`.
 */

function parsed<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error(`expected success: ${JSON.stringify(result)}`);
  return result.value;
}

const hexDigest = (seed: string): string => createHash("sha256").update(seed).digest("hex");
const harnessBinding = {
  pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
  claude: { harness: "claude-code", model: "opus" },
} as const;

function attemptAuthority(
  runId: OrchestrationRunId,
  slotId: SlotId,
  requestId: string,
  attempt: 1 | 2,
  program: "architecture-panel" | "refutation-panel",
  role: "arch-designer-agent" | "arch-judge-agent" | "review-verifier-agent",
) {
  const modelProfile = role === "arch-designer-agent" ? "panel-design" : role === "arch-judge-agent" ? "panel-judge" : "refutation";
  return parsed(parseAgentRequestAuthority({
    runId,
    requestId: parsed(parseRequestId(requestId)),
    slotId,
    program,
    role,
    attempt,
    modelProfile,
    harnessBinding,
    requiredSkill: role === "arch-designer-agent" ? "architecture-tech-lead" : null,
    contextDigest: parsed(parseContextDigest(hexDigest(`${requestId}:context`))),
    outputSlot: `transcripts/${slotId.replace(/:/g, "-")}-attempt-${attempt}.json`,
  }));
}

function ordinalSlot(
  runId: OrchestrationRunId,
  stage: string,
  ordinal: number,
  role: "arch-designer-agent" | "arch-judge-agent",
) {
  const slotId = parsed(parseSlotId(`${stage}:${ordinal}`));
  return parsed(parseAgentRosterSlot(
    attemptAuthority(runId, slotId, `${runId}:${stage}:${ordinal}:1`, 1, "architecture-panel", role),
    attemptAuthority(runId, slotId, `${runId}:${stage}:${ordinal}:2`, 2, "architecture-panel", role),
  ));
}

function architectureAuthority(): ArchitecturePanelAuthority {
  const runId = parsed(parseOrchestrationRunId("run.architecture.slot-binding"));
  return parsed(parseArchitecturePanelAuthority({
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
  const runId = parsed(parseOrchestrationRunId("run.refutation.slot-binding"));
  const findings: readonly [BriefFinding, ...BriefFinding[]] = [
    { id: waveId("T1:code-reviewer-1"), taskId: "T1", agent: "code-reviewer", severity: "critical", file: "src/a.ts", line: 10, claim: "first claim" },
  ];
  const findingIds = findings.map(({ id }) => id) as unknown as NonEmpty<WaveFindingId>;
  const lenses = ["reproduction", "intent"] as const;
  const verifierSlots = lenses.map((lens) => {
    const binding = parsed(deriveRefutationVerifierBinding(runId, lens as ReviewLens, findingIds));
    return parsed(parseAgentRosterSlot(
      attemptAuthority(runId, binding.slotId, binding.requestIds[0], 1, "refutation-panel", "review-verifier-agent"),
      attemptAuthority(runId, binding.slotId, binding.requestIds[1], 2, "refutation-panel", "review-verifier-agent"),
    ));
  });
  return parsed(parseRefutationPanelAuthority({ runId, findings, lenses, verifierSlots }));
}

const unknownSlot = parsed(parseSlotId("stranger:9"));

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
