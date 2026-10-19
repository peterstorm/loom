import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  boundRefutationLens,
  deriveRefutationVerifierBinding,
  parseRefutationPanelAuthority,
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
import { lowerModelProfile, resolveModelProfile } from "../../src/core/model-profiles";
import { value } from "../fixtures/parse-result";

/**
 * The slot-to-lens refusals of the refutation panel authority: a slot the
 * roster does not hold, or a slot whose ordinal lies past the paired lens list,
 * is a typed `request-binding-mismatch`, never a lens read as `undefined`.
 */

const hexDigest = (seed: string): string => createHash("sha256").update(seed).digest("hex");
/** The binding the catalog issues the refutation profile under today, so each
 *  minted attempt below passes the issue-mode check without re-spelling a target. */
const harnessBinding = () => {
  const profile = value(resolveModelProfile("refutation"));
  return { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") };
};

function attemptAuthority(runId: OrchestrationRunId, slotId: SlotId, requestId: string, attempt: 1 | 2) {
  return value(parseAgentRequestAuthority({
    runId,
    requestId: value(parseRequestId(requestId)),
    slotId,
    program: "refutation-panel",
    role: "review-verifier-agent",
    attempt,
    modelProfile: "refutation",
    harnessBinding: harnessBinding(),
    requiredSkill: null,
    contextDigest: value(parseContextDigest(hexDigest(`${requestId}:context`))),
    outputSlot: `transcripts/${slotId.replace(/:/g, "-")}-attempt-${attempt}.json`,
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
      attemptAuthority(runId, binding.slotId, binding.requestIds[0], 1),
      attemptAuthority(runId, binding.slotId, binding.requestIds[1], 2),
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

describe("refutation panel authority slot binding refuses an unbound slot", () => {
  const refutation = refutationAuthority();
  const lastVerifier = refutation.verifierRoster.orderedSlots[1]!.slotId;

  it("binds every rostered slot to its positional lens", () => {
    expect(boundRefutationLens(refutation, lastVerifier)).toEqual({ ok: true, value: refutation.lenses[1] });
  });

  it("refuses a slot the roster does not hold", () => {
    expectBindingRefusal(boundRefutationLens(refutation, unknownSlot), "is bound to no refutation lens");
  });

  it("refuses a rostered slot whose ordinal lies past the paired lenses", () => {
    expectBindingRefusal(boundRefutationLens({ ...refutation, lenses: [refutation.lenses[0]] }, lastVerifier), "is bound to no refutation lens");
  });
});
