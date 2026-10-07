/**
 * Eligible reviewer request authority for the program-path emission suites:
 * one parsed `AgentRequestAuthority` per review program, carrying the
 * catalog's real (profile, harness binding) pair for the code-reviewer role.
 */
import { parseAgentRequestAuthority, type AgentRequestAuthority } from "../../src/core/orchestration-contract";
import type { ContextDigest } from "../../src/core/orchestration-contract/identity";
import { lowerModelProfile, resolveAgentPolicy, resolveModelProfile } from "../../src/core/model-profiles";
import { CONTEXT_DIGEST, fixtureValue } from "./issued-emission";

/** Parse raw authority fields; a refused parse is a fixture bug, thrown loudly. */
export const mustAuthority = (raw: unknown): AgentRequestAuthority => {
  const parsed = parseAgentRequestAuthority(raw);
  if (!parsed.ok) throw new Error(`fixture authority refused: ${parsed.error.violations.map(({ message }) => message).join("; ")}`);
  return parsed.value;
};

/** One eligible reviewer request authority per review program, with the
 *  catalog's real (profile, harness binding) pair for its role. */
export const reviewerAuthority = (
  program: "standalone-review" | "wave-gate",
  requestId: string,
  contextDigest: ContextDigest = CONTEXT_DIGEST,
): AgentRequestAuthority => {
  const policy = fixtureValue(resolveAgentPolicy("code-reviewer"));
  const profile = fixtureValue(resolveModelProfile(policy.profile));
  return mustAuthority({
    runId: "run.wiring", requestId, slotId: `slot:${requestId}`,
    program, role: "code-reviewer", attempt: 1, modelProfile: policy.profile,
    harnessBinding: { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") },
    requiredSkill: policy.requiredSkill, contextDigest,
    outputSlot: `transcripts/slot:${requestId}/attempt-1.raw`,
  });
};
