import { buildContextPacket, encodeByteSection, type ContextPacket } from "../../src/core/context-packets";
import { parseIssuedSpawnRequest, parseRequestId, sameAgentRequestAuthority, type AgentRequestAuthority, type PublicationAuthorityResolver, type SpawnRequest } from "../../src/core/orchestration-contract";
import { parseIssuedReviewerProtocol, type ReviewerProtocolAuthorityResolver } from "../../src/core/review-output";
import { serializeStandaloneReviewAuthority } from "../../src/core/standalone-review-records";
import { type FrozenStandaloneReviewAuthority } from "../../src/core/standalone-review-model";
import { parseRegistration, parsedAuthority } from "../../src/handlers/helpers/programs/registration";
import { value } from "./parse-result";

/** Explicit schema-1 fixture producer, not a production downgrade option. */
export function legacyStandaloneContext(request: Readonly<{
  runId: string; requestId: string; role: string; attempt: 1 | 2; requiredSkill: string | null;
}>, scope: readonly string[]): ContextPacket {
  return value(buildContextPacket({
    requestId: value(parseRequestId(request.requestId)), role: request.role, requiredSkill: request.requiredSkill ?? "none",
    outputContract: "Review the exact frozen scope. Return the Loom Machine Summary and findings contract for your reviewer role.",
    fixedContext: [value(encodeByteSection("standalone-review-authority", JSON.stringify({
      runId: request.runId, scope, role: request.role, attempt: request.attempt,
    })))], variableContext: [],
  }));
}

/** Separate immutable fixture registration bytes, parsed by the whole production reader. */
export function standaloneFixtureRegistration(authority: FrozenStandaloneReviewAuthority) {
  return value(parseRegistration(JSON.parse(JSON.stringify({
    schemaVersion: authority.schemaVersion,
    ...(authority.schemaVersion === 2 ? { reviewerProtocol: authority.reviewerProtocol } : {}),
    kind: "standalone-review", input: { kind: authority.reviewMetadata.requestedKinds[0], files: authority.scopeSource === "explicit" ? authority.scope : null, dryRun: false },
    authority: JSON.parse(serializeStandaloneReviewAuthority(authority)),
  }))));
}

export function fixtureReviewerProtocols(
  authority: FrozenStandaloneReviewAuthority,
  publications: PublicationAuthorityResolver,
  requests: readonly SpawnRequest[],
  packets: readonly ContextPacket[],
): ReviewerProtocolAuthorityResolver {
  const registration = standaloneFixtureRegistration(authority);
  const registered = value(parsedAuthority(registration));
  const durableRequests = JSON.parse(JSON.stringify(requests)) as readonly SpawnRequest[];
  const durablePackets = new Map(packets.map((packet) => [packet.digest, packet]));
  return (request: AgentRequestAuthority) => {
    const raw = durableRequests.find((candidate) => sameAgentRequestAuthority(candidate.authority, request));
    const issued = parseIssuedSpawnRequest(publications, raw);
    const packet = durablePackets.get(request.contextDigest);
    if (!issued.ok || packet === undefined) return { ok: false, error: {
      kind: "reviewer-protocol-failed", code: "authority-unavailable", path: "/fixture-publications", message: "missing fixture publication or packet",
    } };
    const protocol = registration.schemaVersion === 2
      ? { schemaVersion: 2 as const, reviewerProtocol: registration.reviewerProtocol, runId: registered.runId, program: registration.kind }
      : { schemaVersion: 1 as const, runId: registered.runId, program: registration.kind };
    return parseIssuedReviewerProtocol({ request: issued.value, packet, registration: protocol,
      subject: { kind: "standalone-review", runId: registered.runId, scope: registered.scope } });
  };
}

export function legacyFixtureReviewerProtocols(
  authority: FrozenStandaloneReviewAuthority,
  publications: PublicationAuthorityResolver,
  requests: readonly SpawnRequest[],
): ReviewerProtocolAuthorityResolver {
  if (authority.schemaVersion !== 1) throw new Error("legacy fixture adapter requires a parsed historical registration");
  return fixtureReviewerProtocols(authority, publications, requests,
    requests.map(({ authority: request }) => legacyStandaloneContext(request, authority.scope)));
}
