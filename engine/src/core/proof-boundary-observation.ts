/**
 * Proof Boundary Observation: the compact persisted record of whether TaskGraph
 * Population captured every Task's declared-artifact proof boundary from Git
 * (INV-DF1: the boundary predates production) or degraded to an honest absence.
 *
 * Absent is a distinct fact from captured, not a missing value: an absent
 * boundary means each Task's first dispatch stamps its own boundary, which can
 * postdate work. Recording it in the graph lets later readers distinguish an
 * honestly degraded graph from a captured one instead of relying on a stderr
 * line. Legacy graphs (populated before the field existed) carry no
 * observation at all, which is "unknown", never either arm.
 *
 * Pure: no I/O. Population mints it; the State File boundary parses it.
 */
import { isExactGitSha } from "./git-sha";
import { hasExactKeys, isRecord } from "./plain-record";

export type ProofBoundaryObservation =
  | Readonly<{ kind: "captured"; revision: string }>
  | Readonly<{ kind: "absent"; cause: string }>;

export type ProofBoundaryObservationParse =
  | Readonly<{ ok: true; value: ProofBoundaryObservation }>
  | Readonly<{ ok: false; error: string }>;

const refused = (error: string): ProofBoundaryObservationParse => Object.freeze({ ok: false, error });

/** Parse the persisted observation: exact keys, an exact Git revision, a non-empty cause. */
export function parseProofBoundaryObservation(raw: unknown): ProofBoundaryObservationParse {
  if (!isRecord(raw)) return refused("proof_boundary_observation must be an object");
  if (raw.kind === "captured") {
    if (!hasExactKeys(raw, ["kind", "revision"]) || !isExactGitSha(raw.revision)) {
      return refused("proof_boundary_observation captured shape must be exactly {kind, revision:<40/64-hex git SHA>}");
    }
    return Object.freeze({ ok: true, value: Object.freeze({ kind: "captured" as const, revision: raw.revision }) });
  }
  if (raw.kind === "absent") {
    if (!hasExactKeys(raw, ["kind", "cause"]) || typeof raw.cause !== "string" || raw.cause.trim() === "") {
      return refused("proof_boundary_observation absent shape must be exactly {kind, cause:<non-empty string>}");
    }
    return Object.freeze({ ok: true, value: Object.freeze({ kind: "absent" as const, cause: raw.cause }) });
  }
  return refused("proof_boundary_observation kind must be 'captured' or 'absent'");
}

/** The one operator-facing rendering of a degraded boundary; captured renders nothing. */
export function renderProofBoundaryNotice(observation: ProofBoundaryObservation): string | null {
  return observation.kind === "absent"
    ? `Task proof boundaries NOT captured: ${observation.cause}; each Task's first dispatch stamps its own boundary.`
    : null;
}
