/**
 * The ONE pure derivation of a reviewer request's issued emission route
 * (AD-6/AD-7, FR-001/FR-012), consumed by both shells that need it: the
 * request programs' render path (`reviewerEmissionProjection`, which renders
 * the descriptor and tool-primary instruction) and the capture runtime
 * (`resolveReviewerCaptureEmissionAuthority`, which selects against the same
 * binding). Each shell keeps only its read of the durable registration; the
 * eligibility predicate, the claim mint and the qualified-route decision live
 * here once, so the two sides cannot disagree about which requests are
 * emission-enabled or which binding they carry.
 *
 * Pure: no I/O, no ambient reads — the Pi-parent observation is an explicit
 * input, never `process.env`.
 */

import { STANDALONE_REVIEWER_ROLES } from "./standalone-review-scope";
import { CURRENT_REVIEWER_PROTOCOL } from "./reviewer-contract";
import { parseStandaloneReviewerProtocolV3 } from "./standalone-lineage-contract";
import {
  canonicalRecord,
  canonicalStructuralEquals,
  type AgentRequestAuthority,
  type ContextDigest,
  type DomainResult,
} from "./orchestration-contract";
import type { IssuedEmissionBindingOf } from "./emission-tool";
import {
  issuedReviewerPayloadClaim,
  qualifyIssuedSpawnEmissionRoute,
} from "./issued-emission-capability";

/** The registered review program's protocol projection the claim mint reads:
 *  archived schema 1 (no emission schema) or a current schema-2/3 protocol
 *  carrying its issued reviewer-payload schema digest. */
export type IssuedReviewerProtocol = Parameters<typeof issuedReviewerPayloadClaim>[0];

/**
 * The emission-eligibility predicate: only a reviewer role on a
 * standalone-review or wave-gate request carries the issued reviewer-payload
 * contract. Every other request — spec-check slots, panel verdicts,
 * implementation spawns — is extraction-only by construction and advertises
 * no emission tool (FR-001).
 */
export function reviewerEmissionEligible(request: Pick<AgentRequestAuthority, "role" | "program">): boolean {
  return (STANDALONE_REVIEWER_ROLES as readonly string[]).includes(request.role) &&
    (request.program === "standalone-review" || request.program === "wave-gate");
}

/**
 * Project a raw durable program registration onto the protocol the claim mint
 * reads, ACCEPTING ONLY the frozen descriptors: a schema-2 registration must
 * carry the exact current reviewer protocol and a schema-3 successor the
 * exact frozen v3 protocol — a drifted descriptor is a refusal (unavailable
 * evidence), never an extraction downgrade of a corrupt issuance. `null` is
 * the ordinary no-reviewer-program arm.
 */
export function projectRegisteredReviewerProtocol(raw: unknown): DomainResult<IssuedReviewerProtocol | null, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: true, value: null };
  const record = raw as Readonly<Record<string, unknown>>;
  const kind = Object.getOwnPropertyDescriptor(record, "kind")?.value;
  if (kind !== "standalone-review" && kind !== "wave-gate") return { ok: true, value: null };
  const schemaVersion = Object.getOwnPropertyDescriptor(record, "schemaVersion")?.value;
  if (schemaVersion === 1) return { ok: true, value: canonicalRecord({ schemaVersion: 1 as const }) };
  const descriptor = Object.getOwnPropertyDescriptor(record, "reviewerProtocol")?.value;
  if (schemaVersion === 2) {
    return canonicalStructuralEquals(descriptor, CURRENT_REVIEWER_PROTOCOL)
      ? { ok: true, value: canonicalRecord({ schemaVersion: 2 as const, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL }) }
      : { ok: false, error: "program registration does not carry the exact frozen reviewer protocol descriptor" };
  }
  if (schemaVersion === 3 && kind === "standalone-review") {
    const parsed = parseStandaloneReviewerProtocolV3(descriptor);
    return parsed.ok
      ? { ok: true, value: canonicalRecord({ schemaVersion: 3 as const, reviewerProtocol: parsed.value }) }
      : { ok: false, error: parsed.error.message };
  }
  return {
    ok: false,
    error: `program registration carries no supported reviewer protocol projection (schema version ${String(schemaVersion)})`,
  };
}

/** The reviewer request's route: the emission arm carries the
 *  reviewer-payload refinement of the minted binding. */
export type ReviewerEmissionRoute =
  | Readonly<{ kind: "emission"; binding: IssuedEmissionBindingOf<"reviewer-payload">; contextDigest: ContextDigest }>
  | Readonly<{ kind: "extraction-only"; reason: string }>
  | Readonly<{ kind: "refused"; reason: string }>;

/**
 * The issued route of one eligible reviewer request: the claim minted from
 * the registered protocol and the issued request authority (never from
 * prompt markers, harness claims or model arguments — FR-001), qualified
 * against the request's frozen Pi route and the observed Pi parent, then
 * decided. A non-Pi parent and a non-qualified route are extraction-only by
 * construction; no capture-side or render-side input can upgrade them.
 */
export function issuedReviewerEmissionRoute(
  protocol: IssuedReviewerProtocol,
  request: AgentRequestAuthority,
  piParentExists: boolean,
): ReviewerEmissionRoute {
  const route = qualifyIssuedSpawnEmissionRoute(issuedReviewerPayloadClaim(protocol, request), request, piParentExists);
  // The claim's producer kind is `reviewer-payload` by construction (the
  // claim mint takes only the reviewer protocol projection), so the minted
  // binding's path refinement is a fact of this composition — the one place
  // the refinement is stated.
  return route.kind === "emission"
    ? canonicalRecord({ ...route, binding: route.binding as IssuedEmissionBindingOf<"reviewer-payload"> })
    : route;
}
