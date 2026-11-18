/**
 * In-memory durable publication adapter for one reviewer request: the
 * production receipt parser alone mints the SpawnRequest, so a test cannot
 * hand-build issuance the engine would not accept.
 */
import type { ContextPacket } from "../../src/core/context-packets";
import { sha256Hex } from "../../src/core/digest";
import {
  createPublicationAuthorityResolver, parseAgentRequestAuthority, parseIssuedSpawnRequest,
  type OrchestrationRunId, type SpawnRequest,
} from "../../src/core/orchestration-contract";
import { lowerModelProfile, resolveAgentPolicy, resolveModelProfile } from "../../src/core/model-profiles";
import { value } from "./parse-result";

const bytes = (raw: unknown) => new TextEncoder().encode(JSON.stringify(raw));

export function publishReviewerRequest(packet: ContextPacket, issued: Readonly<{
  runId: OrchestrationRunId; program: "wave-gate" | "standalone-review"; attempt: 1 | 2; role?: string;
}>): SpawnRequest {
  const { runId, program, attempt } = issued;
  const role = issued.role ?? packet.role;
  const policy = value(resolveAgentPolicy(role));
  const profile = value(resolveModelProfile(policy.profile));
  const authority = value(parseAgentRequestAuthority({
    runId, requestId: packet.requestId, slotId: "slot:code-reviewer", program,
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
