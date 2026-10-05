/**
 * The Pi review-authority bridge contract.
 *
 * Pi's extension certifies a completed Standalone Review under an exact
 * witnessed-capture replay, and test harnesses read that certification back.
 * The handoff is a process-global published under ONE Symbol.for key; before
 * this module the key string was duplicated in three files and every consumer
 * structurally guessed the bridge's shape. Now the key, the receipt type, and
 * the fail-closed lookup live here — the producer publishes through
 * `publishLoomReviewAuthorityBridge`, the consumers read through
 * `readLoomReviewAuthorityBridge`, and neither side re-declares anything.
 *
 * The lookup is FAIL-CLOSED: an absent or malformed bridge is a thrown
 * contract violation, never an `undefined` the caller could misread as "the
 * review is simply not done yet". The receipt crosses a process-global, so the
 * read path PARSES every receipt `verify` resolves to into branded identities
 * before any consumer sees it; a malformed receipt rejects the verification.
 */

import {
  parseArtifactDigest, parseOrchestrationRunId, parseRequestId,
  type ArtifactDigest, type DomainResult, type NonEmpty, type OrchestrationRunId, type RequestId,
} from "../../../core/orchestration-contract";
import { isRecord } from "../../../core/plain-record";
import type { StandaloneReviewedSource, StandaloneReviewedSourceFile } from "./standalone-evidence";

/** The one key the bridge is published under. `unique symbol`, so a consumer
 *  indexing globalThis with a re-declared string cannot compile. */
export const LOOM_REVIEW_AUTHORITY_BRIDGE: unique symbol = Symbol.for("@peterstorm/loom/review-authority/v1");

/** The certification as the producer writes it: plain wire fields. */
export type LoomReviewAuthorityReceipt = Readonly<{
  schemaVersion: 1;
  kind: "loom-review-authority-receipt";
  sessionId: string;
  runId: string;
  runsRoot: string;
  runDirectory: string;
  requestIds: readonly string[];
  resultDigest: string;
  reviewedSource: StandaloneReviewedSource;
}>;

/** The certification a consumer receives: the exact witnessed Standalone
 *  Review run (for the session it was asked about), its non-empty captured
 *  request authority, the published result digest, and the reviewed-source
 *  attestation the replay proved — every identity parsed and branded. */
export type VerifiedLoomReviewAuthorityReceipt = Readonly<{
  schemaVersion: 1;
  kind: "loom-review-authority-receipt";
  sessionId: string;
  runId: OrchestrationRunId;
  /** Absolute. */
  runsRoot: string;
  /** Absolute. */
  runDirectory: string;
  requestIds: NonEmpty<RequestId>;
  resultDigest: ArtifactDigest;
  reviewedSource: StandaloneReviewedSource;
}>;

type VerifyInput = Readonly<{ cwd: string; sessionId: string }>;

/** What the producer publishes: exactly one verifier resolving to its wire receipt. */
export type LoomReviewAuthorityPublication = Readonly<{
  verify: (input: VerifyInput) => Promise<LoomReviewAuthorityReceipt>;
}>;

/** The bridge a consumer reads: its verifier resolves only to a parsed receipt. */
export type LoomReviewAuthorityBridge = Readonly<{
  verify: (input: VerifyInput) => Promise<VerifiedLoomReviewAuthorityReceipt>;
}>;

const exactKeys = (record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key));
const nonEmptyString = (raw: unknown): raw is string => typeof raw === "string" && raw.length > 0;
const absolutePath = (raw: unknown): raw is string => typeof raw === "string" && raw.startsWith("/");
const SHA256_HEX = /^[0-9a-f]{64}$/;

function parseReviewedSourceFile(raw: unknown): StandaloneReviewedSourceFile | null {
  if (!isRecord(raw) || !exactKeys(raw, ["path", "kind", "digest", "byteLength"]) || !nonEmptyString(raw["path"])) return null;
  const path = raw["path"], digest = raw["digest"], byteLength = raw["byteLength"];
  if (raw["kind"] === "absent") {
    return digest === null && byteLength === 0 ? Object.freeze({ path, kind: "absent", digest: null, byteLength: 0 }) : null;
  }
  return raw["kind"] === "file" && typeof digest === "string" && SHA256_HEX.test(digest) &&
    typeof byteLength === "number" && Number.isSafeInteger(byteLength) && byteLength >= 0
    ? Object.freeze({ path, kind: "file", digest, byteLength }) : null;
}

function parseReviewedSource(raw: unknown): StandaloneReviewedSource | null {
  if (!isRecord(raw) || !exactKeys(raw, ["schemaVersion", "headRevision", "files"]) || raw["schemaVersion"] !== 1) return null;
  const headRevision = raw["headRevision"], rawFiles = raw["files"];
  if (typeof headRevision !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headRevision) || !Array.isArray(rawFiles)) return null;
  const files: StandaloneReviewedSourceFile[] = [];
  for (const rawFile of rawFiles) {
    const file = parseReviewedSourceFile(rawFile);
    if (file === null) return null;
    files.push(file);
  }
  return Object.freeze({ schemaVersion: 1, headRevision, files: Object.freeze(files) });
}

/** Parse one receipt crossing the bridge; every identity field is branded or refused. */
export function parseLoomReviewAuthorityReceipt(raw: unknown): DomainResult<VerifiedLoomReviewAuthorityReceipt, string> {
  const refused = (field: string): DomainResult<never, string> => ({ ok: false, error: `receipt ${field} is malformed` });
  if (!isRecord(raw) || !exactKeys(raw, ["schemaVersion", "kind", "sessionId", "runId", "runsRoot", "runDirectory",
    "requestIds", "resultDigest", "reviewedSource"])) return refused("shape");
  if (raw["schemaVersion"] !== 1 || raw["kind"] !== "loom-review-authority-receipt") return refused("schema");
  const sessionId = raw["sessionId"], runsRoot = raw["runsRoot"], runDirectory = raw["runDirectory"], rawRequests = raw["requestIds"];
  if (!nonEmptyString(sessionId)) return refused("sessionId");
  const runId = parseOrchestrationRunId(raw["runId"]);
  if (!runId.ok) return refused("runId");
  if (!absolutePath(runsRoot)) return refused("runsRoot");
  if (!absolutePath(runDirectory)) return refused("runDirectory");
  if (!Array.isArray(rawRequests)) return refused("requestIds");
  const requests: RequestId[] = [];
  for (const rawRequest of rawRequests) {
    const request = parseRequestId(rawRequest);
    if (!request.ok) return refused("requestIds");
    requests.push(request.value);
  }
  const [first, ...rest] = requests;
  if (first === undefined) return refused("requestIds");
  const resultDigest = parseArtifactDigest(raw["resultDigest"]);
  if (!resultDigest.ok) return refused("resultDigest");
  const reviewedSource = parseReviewedSource(raw["reviewedSource"]);
  if (reviewedSource === null) return refused("reviewedSource");
  const requestIds: NonEmpty<RequestId> = Object.freeze([first, ...rest] as const);
  return { ok: true, value: Object.freeze({ schemaVersion: 1, kind: "loom-review-authority-receipt", sessionId,
    runId: runId.value, runsRoot, runDirectory, requestIds, resultDigest: resultDigest.value, reviewedSource }) };
}

/** Read the published bridge, or throw — never hand back a shape the caller
 *  must guess or an absent value it might read as a verdict. The returned
 *  verifier resolves only to a parsed receipt certifying the session asked
 *  about; anything else rejects. */
export function readLoomReviewAuthorityBridge(host: unknown): LoomReviewAuthorityBridge {
  const raw = (host as Record<PropertyKey, unknown>)[LOOM_REVIEW_AUTHORITY_BRIDGE];
  if (typeof raw !== "object" || raw === null) {
    throw new Error("loom review-authority bridge is not published under the contract key");
  }
  const verify: unknown = (raw as Record<string, unknown>)["verify"];
  if (typeof verify !== "function") {
    throw new Error("loom review-authority bridge is malformed: verify is not a function");
  }
  return Object.freeze({
    verify: async (input: VerifyInput): Promise<VerifiedLoomReviewAuthorityReceipt> => {
      const receipt = parseLoomReviewAuthorityReceipt(await Reflect.apply(verify, undefined, [input]));
      if (!receipt.ok) throw new Error(`loom review-authority bridge is malformed: ${receipt.error}`);
      if (receipt.value.sessionId !== input.sessionId) {
        throw new Error("loom review-authority receipt certifies a different session");
      }
      return receipt.value;
    },
  });
}

/** Publish the bridge — the producer's ONLY way onto the contract key. */
export function publishLoomReviewAuthorityBridge(host: unknown, bridge: LoomReviewAuthorityPublication): void {
  (host as Record<PropertyKey, unknown>)[LOOM_REVIEW_AUTHORITY_BRIDGE] = Object.freeze({ verify: bridge.verify });
}
