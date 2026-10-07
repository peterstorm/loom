/**
 * Catalog-lowered request authority for the program-path and spawn-task
 * suites: one parsed `AgentRequestAuthority` per (role, program) request,
 * carrying the catalog's real (profile, harness binding, required Skill) for
 * the role. The ONE place a suite crosses to build such an authority, so a
 * catalog binding or required-Skill change reaches every suite through one
 * edit, never through suite-local copies that drift and keep passing.
 */
import { parseAgentRequestAuthority, type AgentRequestAuthority } from "../../src/core/orchestration-contract";
import type { ContextDigest } from "../../src/core/orchestration-contract/identity";
import { lowerModelProfile, resolveAgentPolicy, resolveModelProfile } from "../../src/core/model-profiles";
import { CONTEXT_DIGEST } from "./issued-emission";
import { labelledValue, value } from "./parse-result";

/** Parse raw authority fields; a refused parse is a fixture bug, thrown loudly. */
export const mustAuthority = (raw: unknown): AgentRequestAuthority =>
  labelledValue("agent request authority", parseAgentRequestAuthority(raw));

/** One catalog request: the role and program it is issued for, its request
 *  identity, and the run and slot it is published under. The slot names the
 *  output slot `transcripts/<slotId>/attempt-1.raw`. */
export type CatalogRequest = Readonly<{
  role: AgentRequestAuthority["role"];
  program: AgentRequestAuthority["program"];
  requestId: string;
  contextDigest?: ContextDigest;
  runId?: string;
  slotId?: string;
}>;

/** The attempt-1 authority for `request`, with the catalog's real profile,
 *  harness binding lowering and required Skill for its role. */
export const catalogAuthority = (request: CatalogRequest): AgentRequestAuthority => {
  const policy = value(resolveAgentPolicy(request.role));
  const profile = value(resolveModelProfile(policy.profile));
  const slotId = request.slotId ?? `slot:${request.requestId}`;
  return mustAuthority({
    runId: request.runId ?? "run.wiring", requestId: request.requestId, slotId,
    program: request.program, role: request.role, attempt: 1, modelProfile: policy.profile,
    harnessBinding: { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") },
    requiredSkill: policy.requiredSkill, contextDigest: request.contextDigest ?? CONTEXT_DIGEST,
    outputSlot: `transcripts/${slotId}/attempt-1.raw`,
  });
};

/** One eligible code-reviewer request authority per review program. */
export const reviewerAuthority = (
  program: "standalone-review" | "wave-gate",
  requestId: string,
  contextDigest: ContextDigest = CONTEXT_DIGEST,
  runId?: string,
): AgentRequestAuthority => catalogAuthority({ role: "code-reviewer", program, requestId, contextDigest, runId });
