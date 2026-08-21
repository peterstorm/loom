/**
 * Sub-domain volume of the orchestration shared kernel: the error and
 * diagnostic vocabulary shared ACROSS volumes.
 *
 * These types were each declared beside the operation that raises them, which
 * made three volume pairs cyclic — `roster` needed one diagnostic from
 * `completion`, `publication` needed one error from `completion` and three
 * symbols from `actions`, while each of those volumes depended heavily on the
 * other direction. An error type is referenced by everything that can fail,
 * so it belongs BENEATH the operations rather than beside one of them.
 *
 * This volume sits directly above `identity` and imports nothing else, so it
 * can never reintroduce a cycle. A diagnostic used by exactly one volume stays
 * in that volume; only shared ones land here.
 *
 * Pure module: no I/O, no clock, no randomness.
 */
import {
  canonicalRecord,
  failure,
  type DomainResult,
  type RequestId,
  type SemanticAttempt,
  type SlotId,
} from './identity';
import { type DataBoundaryReason } from './bytes';

// --- Accepted agent results (raised by completion, referenced by publication) ---

export type AcceptedAgentResultError = Readonly<{
  kind: "invalid-accepted-agent-result";
  field?: string;
  message: string;
}>;

// --- Semantic payloads (raised by completion, referenced by roster) ---

export type SemanticPayloadFailureReason =
  | DataBoundaryReason
  | "non-finite-number"
  | "unsupported-value"
  | "cyclic-value"
  | "wrong-container-prototype"
  | "parser-threw"
  | "invalid-parser-result"
  | "parser-rejected";

export type SemanticPayloadDiagnostic = Readonly<{
  kind: "invalid-semantic-payload";
  phase: "parse" | "canonicalize";
  reason: SemanticPayloadFailureReason;
  field: string | null;
  index: number | null;
  message: string;
}>;

// --- External actions (raised by actions, referenced by publication) ---

export type ExternalActionError =
  | Readonly<{
      kind: "invalid-external-action";
      field: string;
      message: string;
    }>
  | Readonly<{
      kind: "spawn-output-slot-collision";
      field: "requests.authority.outputSlot.path";
      message: string;
      path: string;
      first: Readonly<{
        index: number;
        requestId: RequestId;
        slotId: SlotId;
        attempt: SemanticAttempt;
      }>;
      duplicate: Readonly<{
        index: number;
        requestId: RequestId;
        slotId: SlotId;
        attempt: SemanticAttempt;
      }>;
    }>;

export function actionFailure<T = never>(message: string, field: string): DomainResult<T, ExternalActionError> {
  return failure(canonicalRecord({ kind: "invalid-external-action", field, message }));
}

export function outputSlotCollision<T>(
  path: string,
  first: Readonly<{
    index: number;
    requestId: RequestId;
    slotId: SlotId;
    attempt: SemanticAttempt;
  }>,
  duplicate: Readonly<{
    index: number;
    requestId: RequestId;
    slotId: SlotId;
    attempt: SemanticAttempt;
  }>,
): DomainResult<T, ExternalActionError> {
  return failure(canonicalRecord({
    kind: "spawn-output-slot-collision",
    field: "requests.authority.outputSlot.path",
    message: `spawn output slot '${path}' is authorized by requests ${first.index} and ${duplicate.index}`,
    path,
    first: canonicalRecord(first),
    duplicate: canonicalRecord(duplicate),
  }));
}

/**
 * The canonical optional-field failure: `field` is present ONLY when a
 * specific field is named — the record's shape (and so its canonical digest)
 * differs with and without the field, and both forms must be constructed
 * together. This two-branch shape existed in three copies (publication ×2,
 * remediation-machine); a drifted copy would have silently changed stored
 * error digests.
 */
export function fieldFailureError<Kind extends string>(
  kind: Kind,
  message: string,
  field: string | undefined,
): Readonly<{ kind: Kind; field?: string; message: string }> {
  return field === undefined
    ? canonicalRecord({ kind, message })
    : canonicalRecord({ kind, field, message });
}
