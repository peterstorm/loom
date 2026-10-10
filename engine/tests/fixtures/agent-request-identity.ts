/**
 * The canonical `AgentRequestIdentity` fixture: what an issuer hands
 * `mintAgentRequestAuthority`/`mintAgentRosterSlot` before the catalog fills
 * the profile, bindings and Skill.
 *
 * `recorded-request-authority.test.ts` (three builders) and
 * `roster-minting.test.ts` each spelled the same identity shape, differing
 * only in id prefixes. One builder derives what the suites never vary — the
 * request id from the slot id and attempt, the output slot from the slot id
 * and attempt, a per-attempt context digest — so each suite names only its
 * run, its slot and the fields it does vary, and a change to the identity
 * shape is made once.
 */

import type { LoomAgentName } from "../../src/core/model-profiles";
import type { AgentRequestIdentity } from "../../src/core/orchestration-contract";

/** The slot an identity belongs to, plus any field a suite varies. */
export type RequestIdentitySlot = Readonly<{
  runId: string;
  /** `slot:<name>`; the default request id is `request:<name>-<attempt>`. */
  slotId: string;
}> & Partial<Pick<AgentRequestIdentity, "requestId" | "program" | "contextDigest">>;

export function agentRequestIdentity<Attempt extends 1 | 2>(
  role: LoomAgentName,
  attempt: Attempt,
  { runId, slotId, ...overrides }: RequestIdentitySlot,
): AgentRequestIdentity<Attempt> {
  return {
    runId,
    requestId: `${slotId.replace(/^slot:/, "request:")}-${attempt}`,
    slotId,
    program: "standalone-review",
    role,
    attempt,
    contextDigest: String(attempt).repeat(64),
    outputSlot: `transcripts/${slotId}/attempt-${attempt}.raw`,
    ...overrides,
  };
}
