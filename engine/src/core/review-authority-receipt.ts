/**
 * The review-authority receipt wire contract and the reviewed-source
 * attestation it carries — one pure owner for both sides of the Pi bridge.
 *
 * Pi's extension certifies a completed Standalone Review under an exact
 * witnessed-capture replay; the certification names the reviewed source the
 * replay proved (`StandaloneReviewedSource`). The producer
 * (handlers/helpers/programs/standalone-evidence.ts) builds that attestation
 * through `parseStandaloneReviewedSource`, and the bridge read path
 * (handlers/helpers/programs/review-authority-bridge.ts) parses every receipt
 * through `parseLoomReviewAuthorityReceipt`, which uses the same codec — so the
 * producer's type and the consumer's parser cannot drift: there is one
 * definition of each invariant (head revision grammar, file digest and length,
 * the absent shape). Pure: no I/O.
 */
import {
  parseArtifactDigest, parseOrchestrationRunId, parseRequestId,
  type ArtifactDigest, type DomainResult, type NonEmpty, type OrchestrationRunId, type RequestId,
} from "./orchestration-contract";
import { isExactGitSha } from "./git-sha";
import { isRecord } from "./plain-record";

/** One reviewed scope entry: an exact file digest and length, or an absent path. */
export type StandaloneReviewedSourceFile =
  | Readonly<{ path: string; kind: "file"; digest: string; byteLength: number }>
  | Readonly<{ path: string; kind: "absent"; digest: null; byteLength: 0 }>;

/** The frozen source a Standalone Review's reviewers attested: its head revision and every scope entry in order. */
export type StandaloneReviewedSource = Readonly<{
  schemaVersion: 1;
  headRevision: string;
  files: readonly StandaloneReviewedSourceFile[];
}>;

const exactKeys = (record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
const nonEmptyString = (raw: unknown): raw is string => typeof raw === "string" && raw.length > 0;
const absolutePath = (raw: unknown): raw is string => typeof raw === "string" && raw.startsWith("/");
const SHA256_HEX = /^[0-9a-f]{64}$/;

function parseStandaloneReviewedSourceFile(raw: unknown): StandaloneReviewedSourceFile | null {
  if (!isRecord(raw) || !exactKeys(raw, ["path", "kind", "digest", "byteLength"]) || !nonEmptyString(raw["path"])) return null;
  const path = raw["path"], digest = raw["digest"], byteLength = raw["byteLength"];
  if (raw["kind"] === "absent") {
    return digest === null && byteLength === 0 ? Object.freeze({ path, kind: "absent", digest: null, byteLength: 0 }) : null;
  }
  return raw["kind"] === "file" && typeof digest === "string" && SHA256_HEX.test(digest) &&
    typeof byteLength === "number" && Number.isSafeInteger(byteLength) && byteLength >= 0
    ? Object.freeze({ path, kind: "file", digest, byteLength }) : null;
}

/** The reviewed-source codec: the exact attestation record, or null. Frozen on success. */
export function parseStandaloneReviewedSource(raw: unknown): StandaloneReviewedSource | null {
  if (!isRecord(raw) || !exactKeys(raw, ["schemaVersion", "headRevision", "files"]) || raw["schemaVersion"] !== 1) return null;
  const headRevision = raw["headRevision"], rawFiles = raw["files"];
  if (!isExactGitSha(headRevision) || !Array.isArray(rawFiles)) return null;
  const files: StandaloneReviewedSourceFile[] = [];
  for (const rawFile of rawFiles) {
    const file = parseStandaloneReviewedSourceFile(rawFile);
    if (file === null) return null;
    files.push(file);
  }
  return Object.freeze({ schemaVersion: 1, headRevision, files: Object.freeze(files) });
}

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
  const reviewedSource = parseStandaloneReviewedSource(raw["reviewedSource"]);
  if (reviewedSource === null) return refused("reviewedSource");
  const requestIds: NonEmpty<RequestId> = Object.freeze([first, ...rest] as const);
  return { ok: true, value: Object.freeze({ schemaVersion: 1, kind: "loom-review-authority-receipt", sessionId,
    runId: runId.value, runsRoot, runDirectory, requestIds, resultDigest: resultDigest.value, reviewedSource }) };
}
