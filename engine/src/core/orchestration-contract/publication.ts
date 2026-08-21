/**
 * Sub-domain volume of the orchestration shared kernel. The module-level
 * contract lives in index.ts (facade); this file owns one region of the
 * kernel and exports its internals so sibling volumes can import them.
 * Pure module: no I/O, no clock, no randomness.
 */
import { createHash } from 'node:crypto';
import { canonicalRecord, failure, parseArtifactDigest, parseContextDigest, parseEffectId, parseOrchestrationRunId, parseRequestId, success, type ArtifactDigest, type ContextDigest, type DomainResult, type EffectId, type NonEmpty, type OrchestrationRunId, type RequestId, type SemanticAttempt, type SlotId } from './identity';
import { causedMessage, readDenseDataArray, readExactDataRecord, type DataBoundaryError } from './bytes';
import { parseFixedArtifactSlot, type FixedArtifactSlot } from './artifacts';
import { AtomicInitialPublicationClaimPortMembership, InitialBatchPublicationIntentMembership, InitialPublicationEffectPortMembership, InitialPublicationIssuanceMembership, parseStoredAgentRequestAuthority, sameHarnessBinding, type AgentRequestAuthority } from './roster';
import { fieldFailureError, type AcceptedAgentResultError, actionFailure, outputSlotCollision, type ExternalActionError } from './errors';

export const REGISTERED_PUBLICATION_PROOF: unique symbol = Symbol("RegisteredBatchPublicationAuthority");
export const ISSUED_REQUEST_PROOF: unique symbol = Symbol("IssuedRequest");

/**
 * The proof caches. These are the trust root of the whole contract: an object's
 * MEMBERSHIP here — not any field it carries — is what makes a publication
 * "registered" or a request "issued". They are therefore module-private.
 *
 * They used to be `export const`, which handed every importer the capability
 * they exist to withhold: `registeredPublicationCache.add(x)` or
 * `issuedRequestCache.set(x, x)` from any sibling volume minted an accepted
 * result out of a hand-built object, and direct sub-module imports that bypass
 * the index.ts facade are an established pattern in this repo, so nothing
 * stopped it. The two genuine cross-volume needs are served by the narrow
 * accessors below — reads and one scoped delete, never a write.
 */
const initialBatchPublicationIntentCache = new WeakMap<object, BatchPublishedReceipt>();
const initialPublicationIssuanceCache = new WeakMap<object, Readonly<{ receipt: BatchPublishedReceipt }>>();
const initialPublicationEffectPortCache = new WeakMap<object, InitialPublicationEffectExecutor>();
const atomicInitialPublicationClaimPortCache = new WeakMap<object, AtomicInitialPublicationClaim>();
const registeredPublicationCache = new WeakSet<object>();
const issuedRequestCache = new WeakMap<object, SpawnRequest>();

/** Read-only view of the initial-issuance capability held by `raw`, for
 *  `actions.ts`. Grants no way to create one. */
export function readInitialPublicationIssuance(
  raw: object,
): Readonly<{ receipt: BatchPublishedReceipt }> | undefined {
  return initialPublicationIssuanceCache.get(raw);
}

/** Consume (burn) the initial-issuance capability held by `raw`, for
 *  `actions.ts`. Delete only — a caller can spend a capability, never mint one. */
export function clearInitialPublicationIssuance(raw: object): void {
  initialPublicationIssuanceCache.delete(raw);
}

/** The canonical issued request `raw` IS, or undefined. The identity check
 *  `issued === request` stays with the caller (`completion.ts`); this exposes
 *  the lookup without exposing the `set`. */
export function issuedSpawnRequestFor(raw: object): SpawnRequest | undefined {
  return issuedRequestCache.get(raw);
}

export type ContextReference = Readonly<{
  digest: ContextDigest;
  slot: FixedArtifactSlot;
}>;

/**
 * A context reference whose slot is PROVEN to be content-addressed by its own
 * digest — the invariant the type's shape alone cannot state.
 *
 * The check used to live at the call sites instead (`awaitUserAction` in
 * `actions.ts`, `parsePublishedSpawnRequest` below), each re-deriving the same
 * `contexts/${digest}.json` string. Two copies agreeing is not enforcement: a
 * third caller that simply forgot would have accepted a reference whose slot
 * names a DIFFERENT digest's packet, and nothing in the type would have said
 * so. The smart constructor is the only place that can make it impossible.
 */
export function parseContextReference(raw: unknown): DomainResult<ContextReference, ExternalActionError> {
  const context = readExactDataRecord(raw, ["digest", "slot"], "context");
  if (!context.ok) return actionFailure(context.error.message, `context${context.error.field === null ? "" : `.${context.error.field}`}`);
  const digest = parseContextDigest(context.value.digest);
  const slot = parseFixedArtifactSlot(context.value.slot);
  if (!digest.ok) return actionFailure(digest.error.message, "context.digest");
  if (!slot.ok) return actionFailure(slot.error.message, "context.slot");
  if (slot.value.path !== `contexts/${digest.value}.json`) {
    return actionFailure("context slot must be content-addressed by its digest", "context.slot");
  }
  return success(canonicalRecord({ digest: digest.value, slot: slot.value }));
}

export type InitialSpawnRequestInput = Readonly<{
  authority: unknown;
  context: unknown;
}>;

export type PublishedSpawnRequestAuthority = Readonly<{
  authority: AgentRequestAuthority;
  context: ContextReference;
}>;

/** Serialized publication data is untrusted until matched to registered authority. */
export type BatchPublishedReceipt = Readonly<{
  schemaVersion: 1;
  kind: "batch-published";
  effectId: EffectId;
  runId: OrchestrationRunId;
  requestIds: NonEmpty<RequestId>;
  contextDigests: NonEmpty<ContextDigest>;
  issuedRequests: NonEmpty<PublishedSpawnRequestAuthority>;
  publicationDigest: ArtifactDigest;
}>;

export type BatchPublicationIdentity = Readonly<{
  schemaVersion: 1;
  kind: "batch-publication-identity";
  runId: OrchestrationRunId;
  effectId: EffectId;
  publicationDigest: ArtifactDigest;
}>;

/** Single-use proof minted only from a verified fresh or matching durable publication claim. */
export type InitialPublicationIssuanceAuthority = InitialPublicationIssuanceMembership & Readonly<{
  schemaVersion: 1;
  kind: "initial-publication-issuance-authority";
  identity: BatchPublicationIdentity;
}>;

/** Parser-produced restart proof from an independently loaded immutable registration. */
export type RegisteredBatchPublicationAuthority = Readonly<{
  schemaVersion: 1;
  kind: "registered-batch-publication-authority";
  identity: BatchPublicationIdentity;
  receipt: BatchPublishedReceipt;
  readonly [REGISTERED_PUBLICATION_PROOF]: true;
}>;

export type PublicationAuthorityResolutionError = Readonly<{
  kind: "publication-authority-unavailable";
  field?: string;
  message: string;
}>;

export type BatchPublicationRegistrationLookup = Readonly<{
  schemaVersion: 1;
  kind: "batch-publication-registration-lookup";
  runId: OrchestrationRunId;
  effectId: EffectId;
}>;

/**
 * The sole restart-registration trust seam. Its persistence adapter must load
 * the exact immutable registration bytes for this authoritative run/effect
 * lookup. Serialized requests and receipts are deliberately not loader inputs
 * and confer no registration authority.
 */
export type TrustedPublicationRegistrationLoader = (
  lookup: BatchPublicationRegistrationLookup,
) => DomainResult<readonly number[], PublicationAuthorityResolutionError>;

/** Parser-produced authority lookup used by restart rehydration. */
export type PublicationAuthorityResolver = (
  identity: BatchPublicationIdentity,
) => DomainResult<RegisteredBatchPublicationAuthority, PublicationAuthorityResolutionError>;

export const MAX_PUBLICATION_REGISTRATION_BYTES = 16_777_216;

/** Durable requests serialize only publication identity plus their canonical batch index. */
export type IssuedSpawnRequestProof = Readonly<{
  schemaVersion: 1;
  kind: "issued-spawn-request-proof";
  runId: OrchestrationRunId;
  effectId: EffectId;
  publicationDigest: ArtifactDigest;
  batchIndex: number;
}>;

export type SpawnRequest = Readonly<{
  authority: AgentRequestAuthority;
  context: ContextReference;
  issuance: IssuedSpawnRequestProof;
  readonly [ISSUED_REQUEST_PROOF]: true;
}>;

export function parseNonEmptyAuthorityList<T>(
  raw: unknown,
  parse: (value: unknown) => DomainResult<T, { message: string }>,
  field: string,
): DomainResult<NonEmpty<T>, ExternalActionError> {
  const entries = readDenseDataArray(raw, field);
  if (!entries.ok || entries.value.length === 0) {
    return actionFailure(entries.ok ? `${field} must be a non-empty array` : entries.error.message, field);
  }
  const parsed: T[] = [];
  for (let index = 0; index < entries.value.length; index++) {
    const entry = parse(entries.value[index]);
    if (!entry.ok) return actionFailure(entry.error.message, `${field}[${index}]`);
    parsed.push(entry.value);
  }
  return success(Object.freeze(parsed) as NonEmpty<T>);
}

export function samePublishedRequest(
  left: PublishedSpawnRequestAuthority,
  right: PublishedSpawnRequestAuthority,
): boolean {
  const actual = left.authority;
  const expected = right.authority;
  return actual.runId === expected.runId && actual.requestId === expected.requestId &&
    actual.slotId === expected.slotId && actual.program === expected.program &&
    actual.role === expected.role && actual.attempt === expected.attempt &&
    actual.modelProfile === expected.modelProfile &&
    sameHarnessBinding(actual.harnessBinding, expected.harnessBinding) &&
    actual.requiredSkill === expected.requiredSkill &&
    actual.contextDigest === expected.contextDigest &&
    actual.outputSlot.path === expected.outputSlot.path &&
    left.context.digest === right.context.digest && left.context.slot.path === right.context.slot.path;
}

export function parsePublishedSpawnRequest(
  raw: unknown,
  field: string,
): DomainResult<PublishedSpawnRequestAuthority, ExternalActionError> {
  const request = readExactDataRecord(raw, ["authority", "context"], field);
  if (!request.ok) {
    return actionFailure(
      request.error.message,
      `${field}${request.error.field === null ? "" : `.${request.error.field}`}`,
    );
  }
  const authority = parseStoredAgentRequestAuthority(request.value.authority);
  if (!authority.ok) {
    return actionFailure(
      authority.error.violations.map(({ message }) => message).join("; "),
      `${field}.authority`,
    );
  }
  const context = parseContextReference(request.value.context);
  if (!context.ok) return actionFailure(context.error.message, `${field}.${context.error.field}`);
  if (authority.value.contextDigest !== context.value.digest) {
    return actionFailure("request authority does not match context digest", `${field}.context.digest`);
  }
  return success(canonicalRecord({ authority: authority.value, context: context.value }));
}

export function parseBatchPublishedReceipt(
  raw: unknown,
): DomainResult<BatchPublishedReceipt, ExternalActionError> {
  const receipt = readExactDataRecord(
    raw,
    [
      "schemaVersion", "kind", "effectId", "runId", "requestIds", "contextDigests",
      "issuedRequests", "publicationDigest",
    ],
    "batch publication receipt",
  );
  if (!receipt.ok) return actionFailure(receipt.error.message, `receipt${receipt.error.field === null ? "" : `.${receipt.error.field}`}`);
  if (receipt.value.schemaVersion !== 1) return actionFailure("receipt.schemaVersion must be 1", "receipt.schemaVersion");
  if (receipt.value.kind !== "batch-published") return actionFailure("receipt.kind must be 'batch-published'", "receipt.kind");
  const effectId = parseEffectId(receipt.value.effectId);
  const runId = parseOrchestrationRunId(receipt.value.runId);
  const requestIds = parseNonEmptyAuthorityList(receipt.value.requestIds, parseRequestId, "receipt.requestIds");
  const contextDigests = parseNonEmptyAuthorityList(receipt.value.contextDigests, parseContextDigest, "receipt.contextDigests");
  const publicationDigest = parseArtifactDigest(receipt.value.publicationDigest);
  if (!effectId.ok) return actionFailure(effectId.error.message, "receipt.effectId");
  if (!runId.ok) return actionFailure(runId.error.message, "receipt.runId");
  if (!requestIds.ok) return requestIds;
  if (!contextDigests.ok) return contextDigests;
  if (!publicationDigest.ok) return actionFailure(publicationDigest.error.message, "receipt.publicationDigest");

  const rawIssuedRequests = readDenseDataArray(receipt.value.issuedRequests, "receipt.issuedRequests");
  if (!rawIssuedRequests.ok || rawIssuedRequests.value.length === 0) {
    return actionFailure(
      rawIssuedRequests.ok ? "receipt.issuedRequests must be a non-empty array" : rawIssuedRequests.error.message,
      "receipt.issuedRequests",
    );
  }
  const issuedRequests: PublishedSpawnRequestAuthority[] = [];
  const semanticSlots = new Map<SlotId, number>();
  const outputSlots = new Map<string, Readonly<{
    index: number;
    requestId: RequestId;
    slotId: SlotId;
    attempt: SemanticAttempt;
  }>>();
  for (let index = 0; index < rawIssuedRequests.value.length; index++) {
    const issued = parsePublishedSpawnRequest(rawIssuedRequests.value[index], `receipt.issuedRequests[${index}]`);
    if (!issued.ok) return issued;
    if (issued.value.authority.runId !== runId.value) {
      return actionFailure("issued request run does not match receipt run", `receipt.issuedRequests[${index}].authority.runId`);
    }
    const outputAuthority = canonicalRecord({
      index,
      requestId: issued.value.authority.requestId,
      slotId: issued.value.authority.slotId,
      attempt: issued.value.authority.attempt,
    });
    const firstSemanticIndex = semanticSlots.get(issued.value.authority.slotId);
    if (firstSemanticIndex !== undefined) {
      return actionFailure(
        `semantic slot '${issued.value.authority.slotId}' is authorized by requests ${firstSemanticIndex} and ${index}; retries require a later action`,
        `receipt.issuedRequests[${index}].authority.slotId`,
      );
    }
    semanticSlots.set(issued.value.authority.slotId, index);
    const first = outputSlots.get(issued.value.authority.outputSlot.path);
    if (first !== undefined) {
      return outputSlotCollision(issued.value.authority.outputSlot.path, first, outputAuthority);
    }
    outputSlots.set(issued.value.authority.outputSlot.path, outputAuthority);
    issuedRequests.push(issued.value);
  }

  if (
    requestIds.value.length !== contextDigests.value.length ||
    requestIds.value.length !== issuedRequests.length
  ) {
    return actionFailure(
      "receipt requestIds, contextDigests, and issuedRequests must have equal lengths",
      "receipt.issuedRequests",
    );
  }
  if (new Set(requestIds.value).size !== requestIds.value.length) {
    return actionFailure("receipt requestIds must be unique", "receipt.requestIds");
  }
  if (new Set(contextDigests.value).size !== contextDigests.value.length) {
    return actionFailure("receipt contextDigests must be unique", "receipt.contextDigests");
  }
  for (let index = 0; index < issuedRequests.length; index++) {
    const issued = issuedRequests[index]!;
    if (requestIds.value[index] !== issued.authority.requestId) {
      return actionFailure("receipt request order or identity does not match issued authority", `receipt.requestIds[${index}]`);
    }
    if (contextDigests.value[index] !== issued.context.digest) {
      return actionFailure("receipt context order or identity does not match issued authority", `receipt.contextDigests[${index}]`);
    }
  }

  const canonicalIssuedRequests = Object.freeze(issuedRequests) as NonEmpty<PublishedSpawnRequestAuthority>;
  const derivedPublicationDigest = digestCanonicalBatchPublicationContent({
    schemaVersion: 1,
    kind: "batch-published",
    effectId: effectId.value,
    runId: runId.value,
    requestIds: requestIds.value,
    contextDigests: contextDigests.value,
    issuedRequests: canonicalIssuedRequests,
  });
  if (publicationDigest.value !== derivedPublicationDigest) {
    return actionFailure(
      "receipt.publicationDigest does not match canonical registered receipt/request content",
      "receipt.publicationDigest",
    );
  }

  return success(canonicalRecord({
    schemaVersion: 1,
    kind: "batch-published",
    effectId: effectId.value,
    runId: runId.value,
    requestIds: requestIds.value,
    contextDigests: contextDigests.value,
    issuedRequests: canonicalIssuedRequests,
    publicationDigest: derivedPublicationDigest,
  }));
}

export function digestCanonicalBatchPublicationContent(
  content: Omit<BatchPublishedReceipt, "publicationDigest">,
): ArtifactDigest {
  const bytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: content.schemaVersion,
    kind: content.kind,
    effectId: content.effectId,
    runId: content.runId,
    requestIds: content.requestIds,
    contextDigests: content.contextDigests,
    issuedRequests: content.issuedRequests,
  }));
  return createHash("sha256").update(bytes).digest("hex") as ArtifactDigest;
}

function publicationIdentity(
  source: Pick<BatchPublicationIdentity, "runId" | "effectId" | "publicationDigest">,
): BatchPublicationIdentity {
  return canonicalRecord({
    schemaVersion: 1,
    kind: "batch-publication-identity",
    runId: source.runId,
    effectId: source.effectId,
    publicationDigest: source.publicationDigest,
  });
}

export function batchPublicationIdentity(receipt: BatchPublishedReceipt): BatchPublicationIdentity {
  return publicationIdentity(receipt);
}

export function samePublicationIdentity(
  left: BatchPublicationIdentity,
  right: BatchPublicationIdentity,
): boolean {
  return left.schemaVersion === right.schemaVersion && left.kind === right.kind &&
    left.runId === right.runId && left.effectId === right.effectId &&
    left.publicationDigest === right.publicationDigest;
}

export function initialPublicationClaimKey(
  identity: BatchPublicationIdentity,
): InitialPublicationClaimKey {
  return canonicalRecord({
    runId: identity.runId,
    effectId: identity.effectId,
  });
}

export function sameInitialPublicationClaimKey(
  left: InitialPublicationClaimKey,
  right: InitialPublicationClaimKey,
): boolean {
  return left.runId === right.runId && left.effectId === right.effectId;
}

export type InitialBatchPublicationIntent = InitialBatchPublicationIntentMembership & Readonly<{
  schemaVersion: 1;
  kind: "initial-batch-publication-intent";
  identity: BatchPublicationIdentity;
  requestIds: NonEmpty<RequestId>;
  contextDigests: NonEmpty<ContextDigest>;
  issuedRequests: NonEmpty<PublishedSpawnRequestAuthority>;
}>;

export type InitialPublicationEffectError = Readonly<{
  kind: "initial-publication-effect-failed";
  message: string;
}>;

export type InitialPublicationClaimError = Readonly<{
  kind: "initial-publication-claim-failed";
  message: string;
}>;

export type InitialPublicationClaimKey = Readonly<{
  runId: OrchestrationRunId;
  effectId: EffectId;
}>;

export type InitialPublicationClaimRequest = Readonly<{
  schemaVersion: 1;
  kind: "initial-publication-claim-request";
  key: InitialPublicationClaimKey;
  identity: BatchPublicationIdentity;
}>;

export type InitialPublicationClaimOutcome =
  | Readonly<{
      schemaVersion: 1;
      kind: "initial-publication-claimed";
      key: InitialPublicationClaimKey;
      identity: BatchPublicationIdentity;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "initial-publication-matching-replay";
      key: InitialPublicationClaimKey;
      identity: BatchPublicationIdentity;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "initial-publication-conflict";
      key: InitialPublicationClaimKey;
      requestedIdentity: BatchPublicationIdentity;
      claimedIdentity: BatchPublicationIdentity;
    }>;

export type AcceptedInitialPublicationClaim = Extract<
  InitialPublicationClaimOutcome,
  { kind: "initial-publication-claimed" | "initial-publication-matching-replay" }
>;

/**
 * Shell adapter contract invoked for fresh and matching claims. Only exact
 * independently returned receipt bytes mint authority here; the T7 adapter,
 * not this injected function type, owns idempotent write behavior.
 */
export type InitialPublicationEffectExecutor = (
  intent: InitialBatchPublicationIntent,
) => DomainResult<readonly number[], InitialPublicationEffectError>;

/**
 * Durable compare-and-set seam. Implementations key storage only by request.key
 * (runId, effectId), atomically storing the full canonical publication identity.
 */
export type AtomicInitialPublicationClaim = (
  request: InitialPublicationClaimRequest,
) => DomainResult<InitialPublicationClaimOutcome, InitialPublicationClaimError>;

export type InitialPublicationEffectPort = InitialPublicationEffectPortMembership & Readonly<{
  kind: "initial-publication-effect-port";
}>;

export type AtomicInitialPublicationClaimPort = AtomicInitialPublicationClaimPortMembership & Readonly<{
  kind: "atomic-initial-publication-claim-port";
}>;

export type InitialBatchPublicationReconciler = (
  intent: InitialBatchPublicationIntent,
) => DomainResult<InitialPublicationIssuanceAuthority, ExternalActionError>;

/**
 * Shell-only wiring point. The returned runtime capability is intentionally not
 * structurally interchangeable with the durable restart registration loader.
 */
export function createInitialPublicationEffectPort(
  executor: InitialPublicationEffectExecutor,
): InitialPublicationEffectPort {
  const port = canonicalRecord({ kind: "initial-publication-effect-port" as const }) as InitialPublicationEffectPort;
  if (typeof executor === "function") initialPublicationEffectPortCache.set(port, executor);
  return port;
}

/** Shell-only wiring point for the durable atomic fresh/replay/conflict claim seam. */
export function createAtomicInitialPublicationClaimPort(
  claim: AtomicInitialPublicationClaim,
): AtomicInitialPublicationClaimPort {
  const port = canonicalRecord({ kind: "atomic-initial-publication-claim-port" as const }) as AtomicInitialPublicationClaimPort;
  if (typeof claim === "function") atomicInitialPublicationClaimPortCache.set(port, claim);
  return port;
}

/**
 * Purely prepares the exact expected publication and its canonical identity.
 * This value carries no issuance authority: the full identity must first be
 * durably claimed, then independently returned publication bytes must match it.
 */
export function prepareInitialBatchPublicationIntent(
  rawRunId: unknown,
  rawEffectId: unknown,
  rawRequests: unknown,
): DomainResult<InitialBatchPublicationIntent, ExternalActionError> {
  const runId = parseOrchestrationRunId(rawRunId);
  const effectId = parseEffectId(rawEffectId);
  if (!runId.ok) return actionFailure(runId.error.message, "intent.runId");
  if (!effectId.ok) return actionFailure(effectId.error.message, "intent.effectId");
  const entries = readDenseDataArray(rawRequests, "initial publication intent requests");
  if (!entries.ok || entries.value.length === 0) {
    return actionFailure(entries.ok ? "initial publication intent requires a non-empty request array" : entries.error.message, "intent.requests");
  }
  const issuedRequests: PublishedSpawnRequestAuthority[] = [];
  for (let index = 0; index < entries.value.length; index++) {
    const published = parsePublishedSpawnRequest(entries.value[index], `intent.requests[${index}]`);
    if (!published.ok) return published;
    issuedRequests.push(published.value);
  }
  const canonicalIssued = Object.freeze(issuedRequests) as NonEmpty<PublishedSpawnRequestAuthority>;
  const requestIds = Object.freeze(canonicalIssued.map(({ authority }) => authority.requestId)) as NonEmpty<RequestId>;
  const contextDigests = Object.freeze(canonicalIssued.map(({ context }) => context.digest)) as NonEmpty<ContextDigest>;
  const content = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "batch-published" as const,
    effectId: effectId.value,
    runId: runId.value,
    requestIds,
    contextDigests,
    issuedRequests: canonicalIssued,
  });
  const expectedReceipt = parseBatchPublishedReceipt(canonicalRecord({
    ...content,
    publicationDigest: digestCanonicalBatchPublicationContent(content),
  }));
  if (!expectedReceipt.ok) return expectedReceipt;
  const intent = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "initial-batch-publication-intent" as const,
    identity: batchPublicationIdentity(expectedReceipt.value),
    requestIds: expectedReceipt.value.requestIds,
    contextDigests: expectedReceipt.value.contextDigests,
    issuedRequests: expectedReceipt.value.issuedRequests,
  }) as InitialBatchPublicationIntent;
  initialBatchPublicationIntentCache.set(intent, expectedReceipt.value);
  return success(intent);
}

export function boundaryField(prefix: string, error: DataBoundaryError): string {
  return error.field === null ? prefix : `${prefix}.${error.field}`;
}

/**
 * The ok/value/error envelope every external publication port returns.
 *
 * Three parsers — the initial publication effect, the initial publication
 * claim, and the registration loader — each re-implemented this same four-step
 * shape check (exact ok/value/error keys, a boolean tag, and exactly-two-keys
 * on whichever branch the tag selects). One of them getting a step wrong is a
 * fail-OPEN in a boundary whose entire job is to refuse malformed input, and
 * nothing tied the three copies together.
 *
 * This classifies the envelope only. What each branch's payload must contain,
 * which error kinds are legal, and which failure type to build stay with the
 * caller — they genuinely differ.
 *
 * The violation carries `field` and a `kind` so each caller reproduces its own
 * exact diagnostic: the registration loader deliberately reports its
 * success-shape violation WITHOUT a field, where the other two name the prefix.
 */
type ResultEnvelope =
  | Readonly<{ branch: "failed"; error: unknown }>
  | Readonly<{ branch: "succeeded"; value: unknown }>;

type EnvelopeViolation = Readonly<{
  kind: "unreadable" | "invalid-tag" | "failure-shape" | "success-shape";
  message: string;
  field: string;
}>;

function readResultEnvelope(
  raw: unknown,
  noun: string,
  prefix: string,
): DomainResult<ResultEnvelope, EnvelopeViolation> {
  const result = readExactDataRecord(raw, ["ok", "value", "error"], `${noun} result`);
  if (!result.ok) {
    return failure({ kind: "unreadable", message: result.error.message, field: boundaryField(prefix, result.error) });
  }
  if (typeof result.value.ok !== "boolean") {
    return failure({ kind: "invalid-tag", message: `${noun} returned an invalid result tag`, field: `${prefix}.ok` });
  }
  const keys = Object.keys(result.value);
  if (result.value.ok === false) {
    return keys.length === 2 && keys.includes("error")
      ? success(canonicalRecord({ branch: "failed" as const, error: result.value.error }))
      : failure({ kind: "failure-shape", message: `failed ${noun} must contain exactly ok and error`, field: prefix });
  }
  return keys.length === 2 && keys.includes("value")
    ? success(canonicalRecord({ branch: "succeeded" as const, value: result.value.value }))
    : failure({ kind: "success-shape", message: `successful ${noun} must contain exactly ok and value`, field: prefix });
}

export function parseInitialPublicationEffectResult(
  raw: unknown,
): DomainResult<readonly number[], ExternalActionError> {
  const envelope = readResultEnvelope(raw, "initial publication effect", "publicationEffect");
  if (!envelope.ok) return actionFailure(envelope.error.message, envelope.error.field);
  if (envelope.value.branch === "failed") {
    const error = readExactDataRecord(envelope.value.error, ["kind", "message"], "initial publication effect error");
    if (!error.ok) {
      return actionFailure(error.error.message, boundaryField("publicationEffect.error", error.error));
    }
    if (error.value.kind !== "initial-publication-effect-failed") {
      return actionFailure("initial publication effect error kind is invalid", "publicationEffect.error.kind");
    }
    if (typeof error.value.message !== "string" || error.value.message.trim().length === 0) {
      return actionFailure("initial publication effect error message must be non-empty", "publicationEffect.error.message");
    }
    return actionFailure(error.value.message, "publicationEffect.error.message");
  }
  const bytes = readDenseDataArray(
    envelope.value.value,
    "initial publication receipt bytes",
    MAX_PUBLICATION_REGISTRATION_BYTES,
  );
  if (!bytes.ok) return actionFailure(bytes.error.message, "publicationEffect.receiptBytes");
  for (let index = 0; index < bytes.value.length; index++) {
    const byte = bytes.value[index];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      return actionFailure(
        `initial publication receipt byte at index ${index} must be an integer from 0 through 255`,
        "publicationEffect.receiptBytes",
      );
    }
  }
  return success(bytes.value as readonly number[]);
}

export function parseInitialPublicationReceiptBytes(
  bytes: readonly number[],
): DomainResult<BatchPublishedReceipt, ExternalActionError> {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch (cause) {
    return actionFailure(causedMessage("initial publication receipt bytes are not valid UTF-8", cause), "publicationEffect.receiptBytes");
  }
  let rawReceipt: unknown;
  try {
    rawReceipt = JSON.parse(decoded) as unknown;
  } catch (cause) {
    return actionFailure(causedMessage("initial publication receipt bytes are not valid JSON", cause), "publicationEffect.receiptBytes");
  }
  return parseBatchPublishedReceipt(rawReceipt);
}

export function verifyInitialPublicationReceipt(
  expected: BatchPublishedReceipt,
  actual: BatchPublishedReceipt,
): DomainResult<BatchPublishedReceipt, ExternalActionError> {
  if (!samePublicationIdentity(batchPublicationIdentity(expected), batchPublicationIdentity(actual))) {
    return actionFailure("published receipt run/effect/publication identity does not match the expected intent", "publicationEffect.receipt.identity");
  }
  if (actual.issuedRequests.length !== expected.issuedRequests.length) {
    return actionFailure("published receipt request count does not match the expected intent", "publicationEffect.receipt.issuedRequests");
  }
  for (let index = 0; index < expected.issuedRequests.length; index++) {
    if (actual.requestIds[index] !== expected.requestIds[index]) {
      return actionFailure("published receipt request identity or order does not match the expected intent", `publicationEffect.receipt.requestIds[${index}]`);
    }
    if (actual.contextDigests[index] !== expected.contextDigests[index]) {
      return actionFailure("published receipt context identity or order does not match the expected intent", `publicationEffect.receipt.contextDigests[${index}]`);
    }
    if (!samePublishedRequest(actual.issuedRequests[index]!, expected.issuedRequests[index]!)) {
      return actionFailure(
        "published receipt does not match expected run/effect/request/context/order/output/model/Skill bindings",
        `publicationEffect.receipt.issuedRequests[${index}]`,
      );
    }
  }
  return success(actual);
}

export function parseInitialPublicationClaimKey(
  raw: unknown,
  field: string,
): DomainResult<InitialPublicationClaimKey, ExternalActionError> {
  const key = readExactDataRecord(raw, ["runId", "effectId"], field);
  if (!key.ok) return actionFailure(key.error.message, field);
  const runId = parseOrchestrationRunId(key.value.runId);
  const effectId = parseEffectId(key.value.effectId);
  if (!runId.ok) return actionFailure(runId.error.message, `${field}.runId`);
  if (!effectId.ok) return actionFailure(effectId.error.message, `${field}.effectId`);
  return success(canonicalRecord({
    runId: runId.value,
    effectId: effectId.value,
  }));
}

export function parseInitialPublicationClaimResult(
  raw: unknown,
): DomainResult<InitialPublicationClaimOutcome, ExternalActionError> {
  const envelope = readResultEnvelope(raw, "initial publication claim", "publicationClaim");
  if (!envelope.ok) return actionFailure(envelope.error.message, envelope.error.field);
  if (envelope.value.branch === "failed") {
    const error = readExactDataRecord(envelope.value.error, ["kind", "message"], "initial publication claim error");
    if (!error.ok) {
      return actionFailure(error.error.message, boundaryField("publicationClaim.error", error.error));
    }
    if (error.value.kind !== "initial-publication-claim-failed") {
      return actionFailure("initial publication claim error kind is invalid", "publicationClaim.error.kind");
    }
    if (typeof error.value.message !== "string" || error.value.message.trim().length === 0) {
      return actionFailure("initial publication claim error message must be non-empty", "publicationClaim.error.message");
    }
    return actionFailure(error.value.message, "publicationClaim.error.message");
  }
  const claimed = envelope.value.value;
  const outcomeShape = readExactDataRecord(
    claimed,
    ["schemaVersion", "kind", "key", "identity", "requestedIdentity", "claimedIdentity"],
    "initial publication claim outcome",
  );
  if (!outcomeShape.ok || outcomeShape.value.schemaVersion !== 1) {
    return actionFailure(
      outcomeShape.ok ? "initial publication claim outcome schemaVersion is invalid" : outcomeShape.error.message,
      "publicationClaim",
    );
  }
  const kind = outcomeShape.value.kind;
  if (kind === "initial-publication-claimed" || kind === "initial-publication-matching-replay") {
    const outcome = readExactDataRecord(
      claimed,
      ["schemaVersion", "kind", "key", "identity"],
      "initial publication claim outcome",
    );
    if (!outcome.ok) return actionFailure(outcome.error.message, "publicationClaim");
    const key = parseInitialPublicationClaimKey(outcome.value.key, "publicationClaim.key");
    const identity = parseBatchPublicationIdentity(outcome.value.identity);
    if (!key.ok) return key;
    if (!identity.ok) return actionFailure(identity.error.message, "publicationClaim.identity");
    return success(canonicalRecord({ schemaVersion: 1, kind, key: key.value, identity: identity.value }));
  }
  if (kind === "initial-publication-conflict") {
    const outcome = readExactDataRecord(
      claimed,
      ["schemaVersion", "kind", "key", "requestedIdentity", "claimedIdentity"],
      "initial publication claim conflict",
    );
    if (!outcome.ok) return actionFailure(outcome.error.message, "publicationClaim");
    const key = parseInitialPublicationClaimKey(outcome.value.key, "publicationClaim.key");
    const requestedIdentity = parseBatchPublicationIdentity(outcome.value.requestedIdentity);
    const claimedIdentity = parseBatchPublicationIdentity(outcome.value.claimedIdentity);
    if (!key.ok) return key;
    if (!requestedIdentity.ok) return actionFailure(requestedIdentity.error.message, "publicationClaim.requestedIdentity");
    if (!claimedIdentity.ok) return actionFailure(claimedIdentity.error.message, "publicationClaim.claimedIdentity");
    return success(canonicalRecord({
      schemaVersion: 1,
      kind,
      key: key.value,
      requestedIdentity: requestedIdentity.value,
      claimedIdentity: claimedIdentity.value,
    }));
  }
  return actionFailure("initial publication claim outcome tag is invalid", "publicationClaim");
}

/** Pure claim reducer. It returns a decision, never an issuance capability. */
export function reduceInitialPublicationClaim(
  expectedIdentity: BatchPublicationIdentity,
  outcome: InitialPublicationClaimOutcome,
): DomainResult<AcceptedInitialPublicationClaim, ExternalActionError> {
  const expectedKey = initialPublicationClaimKey(expectedIdentity);
  if (!sameInitialPublicationClaimKey(expectedKey, outcome.key)) {
    return actionFailure("atomic initial publication claim returned a foreign claim key", "publicationClaim.key");
  }
  if (outcome.kind === "initial-publication-conflict") {
    if (!samePublicationIdentity(expectedIdentity, outcome.requestedIdentity)) {
      return actionFailure("atomic initial publication claim returned a foreign requested identity", "publicationClaim.requestedIdentity");
    }
    const claimedKey = initialPublicationClaimKey(outcome.claimedIdentity);
    if (!sameInitialPublicationClaimKey(expectedKey, claimedKey)) {
      return actionFailure("atomic initial publication claim returned a foreign claimed identity", "publicationClaim.claimedIdentity");
    }
    if (samePublicationIdentity(expectedIdentity, outcome.claimedIdentity)) {
      return actionFailure("atomic initial publication claim returned an invalid matching conflict", "publicationClaim.claimedIdentity");
    }
    return actionFailure(
      "initial publication claim conflicts with a different digest for the same run/effect",
      "publicationClaim.claimedIdentity.publicationDigest",
    );
  }
  if (!samePublicationIdentity(expectedIdentity, outcome.identity)) {
    return actionFailure("atomic initial publication claim returned a foreign identity", "publicationClaim.identity");
  }
  return success(outcome);
}

export function mintInitialPublicationIssuanceAuthority(
  receipt: BatchPublishedReceipt,
): InitialPublicationIssuanceAuthority {
  const authority = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "initial-publication-issuance-authority" as const,
    identity: batchPublicationIdentity(receipt),
  }) as InitialPublicationIssuanceAuthority;
  initialPublicationIssuanceCache.set(authority, canonicalRecord({ receipt }));
  return authority;
}

/**
 * Thin shell reconciliation adapter. The prepared canonical identity is claimed
 * before invoking the injected effect. Fresh and matching claims invoke that
 * effect, and only its exact returned receipt mints authority.
 */
export function createInitialBatchPublicationReconciler(
  publicationEffectPort: InitialPublicationEffectPort,
  publicationClaimPort: AtomicInitialPublicationClaimPort,
): InitialBatchPublicationReconciler {
  return (intent) => {
    const expectedReceipt = typeof intent === "object" && intent !== null
      ? initialBatchPublicationIntentCache.get(intent)
      : undefined;
    if (expectedReceipt === undefined) {
      return actionFailure("initial publication reconciliation requires a fresh prepared intent", "intent");
    }
    const executor = typeof publicationEffectPort === "object" && publicationEffectPort !== null
      ? initialPublicationEffectPortCache.get(publicationEffectPort)
      : undefined;
    if (executor === undefined) {
      return actionFailure("a trusted initial publication effect port is required", "publicationEffect");
    }
    const claim = typeof publicationClaimPort === "object" && publicationClaimPort !== null
      ? atomicInitialPublicationClaimPortCache.get(publicationClaimPort)
      : undefined;
    if (claim === undefined) {
      return actionFailure("a trusted atomic initial publication claim port is required", "publicationClaim");
    }

    const identity = batchPublicationIdentity(expectedReceipt);
    const claimRequest = canonicalRecord({
      schemaVersion: 1 as const,
      kind: "initial-publication-claim-request" as const,
      key: initialPublicationClaimKey(identity),
      identity,
    });
    let rawClaimResult: unknown;
    try {
      rawClaimResult = claim(claimRequest);
    } catch (cause) {
      return actionFailure(causedMessage("atomic initial publication claim threw", cause), "publicationClaim");
    }
    const claimResult = parseInitialPublicationClaimResult(rawClaimResult);
    if (!claimResult.ok) return claimResult;
    const decision = reduceInitialPublicationClaim(identity, claimResult.value);
    if (!decision.ok) return decision;

    let rawEffectResult: unknown;
    try {
      rawEffectResult = executor(intent);
    } catch (cause) {
      return actionFailure(causedMessage("initial publication effect threw", cause), "publicationEffect");
    }
    const effectResult = parseInitialPublicationEffectResult(rawEffectResult);
    if (!effectResult.ok) return effectResult;
    const parsedReceipt = parseInitialPublicationReceiptBytes(effectResult.value);
    if (!parsedReceipt.ok) return parsedReceipt;
    const verifiedReceipt = verifyInitialPublicationReceipt(expectedReceipt, parsedReceipt.value);
    return verifiedReceipt.ok
      ? success(mintInitialPublicationIssuanceAuthority(verifiedReceipt.value))
      : verifiedReceipt;
  };
}

export function registeredBatchPublicationAuthority(
  receipt: BatchPublishedReceipt,
): RegisteredBatchPublicationAuthority {
  const authority = Object.create(null) as {
    schemaVersion: 1;
    kind: "registered-batch-publication-authority";
    identity: BatchPublicationIdentity;
    receipt: BatchPublishedReceipt;
    readonly [REGISTERED_PUBLICATION_PROOF]: true;
  };
  Object.defineProperties(authority, {
    schemaVersion: { value: 1, enumerable: true, writable: false, configurable: false },
    kind: { value: "registered-batch-publication-authority", enumerable: true, writable: false, configurable: false },
    identity: { value: batchPublicationIdentity(receipt), enumerable: true, writable: false, configurable: false },
    receipt: { value: receipt, enumerable: true, writable: false, configurable: false },
    [REGISTERED_PUBLICATION_PROOF]: { value: true, enumerable: false, writable: false, configurable: false },
  });
  const canonical = Object.freeze(authority);
  registeredPublicationCache.add(canonical);
  return canonical;
}

export function publicationResolutionFailure(
  message: string,
  field?: string,
): PublicationAuthorityResolutionError {
  return fieldFailureError("publication-authority-unavailable", message, field);
}

export function parseBatchPublicationIdentity(
  raw: unknown,
): DomainResult<BatchPublicationIdentity, PublicationAuthorityResolutionError> {
  const identity = readExactDataRecord(
    raw,
    ["schemaVersion", "kind", "runId", "effectId", "publicationDigest"],
    "batch publication identity",
  );
  if (!identity.ok || identity.value.schemaVersion !== 1 || identity.value.kind !== "batch-publication-identity") {
    return failure(publicationResolutionFailure(
      identity.ok ? "batch publication identity tag or schemaVersion is invalid" : identity.error.message,
    ));
  }
  const runId = parseOrchestrationRunId(identity.value.runId);
  const effectId = parseEffectId(identity.value.effectId);
  const publicationDigest = parseArtifactDigest(identity.value.publicationDigest);
  if (!runId.ok) return failure(publicationResolutionFailure(runId.error.message));
  if (!effectId.ok) return failure(publicationResolutionFailure(effectId.error.message));
  if (!publicationDigest.ok) return failure(publicationResolutionFailure(publicationDigest.error.message));
  return success(canonicalRecord({
    schemaVersion: 1,
    kind: "batch-publication-identity",
    runId: runId.value,
    effectId: effectId.value,
    publicationDigest: publicationDigest.value,
  }));
}

export function parseRegistrationLoaderResult(
  raw: unknown,
): DomainResult<readonly number[], PublicationAuthorityResolutionError> {
  const envelope = readResultEnvelope(raw, "publication registration loader", "publicationRegistrationLoader");
  if (!envelope.ok) {
    // The success-shape violation is reported WITHOUT a field, as it always
    // was here; every other violation names the field the classifier derived.
    return failure(envelope.error.kind === "success-shape"
      ? publicationResolutionFailure(envelope.error.message)
      : publicationResolutionFailure(envelope.error.message, envelope.error.field));
  }
  if (envelope.value.branch === "failed") {
    const loaderError = readExactDataRecord(
      envelope.value.error,
      ["kind", "field", "message"],
      "publication registration loader error",
    );
    if (!loaderError.ok) {
      return failure(publicationResolutionFailure(
        loaderError.error.message,
        boundaryField("publicationRegistrationLoader.error", loaderError.error),
      ));
    }
    if (loaderError.value.kind !== "publication-authority-unavailable") {
      return failure(publicationResolutionFailure(
        "publication registration loader error kind is invalid",
        "publicationRegistrationLoader.error.kind",
      ));
    }
    if (typeof loaderError.value.message !== "string" || loaderError.value.message.trim().length === 0) {
      return failure(publicationResolutionFailure(
        "publication registration loader error message must be non-empty",
        "publicationRegistrationLoader.error.message",
      ));
    }
    if (loaderError.value.field !== undefined &&
        (typeof loaderError.value.field !== "string" || loaderError.value.field.trim().length === 0)) {
      return failure(publicationResolutionFailure(
        "publication registration loader error field must be non-empty when present",
        "publicationRegistrationLoader.error.field",
      ));
    }
    return failure(publicationResolutionFailure(
      loaderError.value.message,
      typeof loaderError.value.field === "string"
        ? loaderError.value.field
        : "publicationRegistrationLoader.error.message",
    ));
  }
  const bytes = readDenseDataArray(
    envelope.value.value,
    "publication registration bytes",
    MAX_PUBLICATION_REGISTRATION_BYTES,
  );
  if (!bytes.ok) return failure(publicationResolutionFailure(bytes.error.message));
  for (let index = 0; index < bytes.value.length; index++) {
    const byte = bytes.value[index];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      return failure(publicationResolutionFailure(
        `publication registration byte at index ${index} must be an integer from 0 through 255`,
      ));
    }
  }
  return success(bytes.value as readonly number[]);
}

/**
 * Anti-corruption boundary from shell-owned registration bytes to opaque core
 * authority. The loader is invoked exactly once for each resolver call. The
 * loaded receipt is structurally parsed and its publication digest is
 * recomputed from canonical receipt/request content before authority exists.
 */
export function createPublicationAuthorityResolver(
  loader: TrustedPublicationRegistrationLoader,
): PublicationAuthorityResolver {
  return (rawIdentity) => {
    const identity = parseBatchPublicationIdentity(rawIdentity);
    if (!identity.ok) return identity;
    if (typeof loader !== "function") {
      return failure(publicationResolutionFailure("a trusted publication registration loader is required"));
    }
    const lookup = canonicalRecord({
      schemaVersion: 1 as const,
      kind: "batch-publication-registration-lookup" as const,
      runId: identity.value.runId,
      effectId: identity.value.effectId,
    });
    let rawLoaded: unknown;
    try {
      rawLoaded = loader(lookup);
    } catch (cause) {
      return failure(publicationResolutionFailure(
        causedMessage("publication registration loader threw", cause),
      ));
    }
    const loaded = parseRegistrationLoaderResult(rawLoaded);
    if (!loaded.ok) return loaded;

    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(loaded.value));
    } catch (cause) {
      return failure(publicationResolutionFailure(
        causedMessage("publication registration bytes are not valid UTF-8", cause),
      ));
    }
    let rawRegistration: unknown;
    try {
      rawRegistration = JSON.parse(decoded) as unknown;
    } catch (cause) {
      return failure(publicationResolutionFailure(
        causedMessage("publication registration bytes are not valid JSON", cause),
      ));
    }
    const receipt = parseBatchPublishedReceipt(rawRegistration);
    if (!receipt.ok) return failure(publicationResolutionFailure(receipt.error.message));
    const derivedIdentity = batchPublicationIdentity(receipt.value);
    if (!samePublicationIdentity(identity.value, derivedIdentity)) {
      return failure(publicationResolutionFailure(
        "loaded publication registration is stale, foreign, or divergent",
      ));
    }
    return success(registeredBatchPublicationAuthority(receipt.value));
  };
}

export function parseIssuedSpawnRequestProof(
  raw: unknown,
): DomainResult<IssuedSpawnRequestProof, AcceptedAgentResultError> {
  const proof = readExactDataRecord(
    raw,
    ["schemaVersion", "kind", "runId", "effectId", "publicationDigest", "batchIndex"],
    "issued spawn request proof",
  );
  if (!proof.ok || proof.value.schemaVersion !== 1 || proof.value.kind !== "issued-spawn-request-proof") {
    return failure(canonicalRecord({
      kind: "invalid-accepted-agent-result",
      message: proof.ok ? "issued spawn request proof tag or schemaVersion is invalid" : proof.error.message,
    }));
  }
  const runId = parseOrchestrationRunId(proof.value.runId);
  const effectId = parseEffectId(proof.value.effectId);
  const publicationDigest = parseArtifactDigest(proof.value.publicationDigest);
  const batchIndex = proof.value.batchIndex;
  if (!runId.ok) return failure(canonicalRecord({ kind: "invalid-accepted-agent-result", message: runId.error.message }));
  if (!effectId.ok) return failure(canonicalRecord({ kind: "invalid-accepted-agent-result", message: effectId.error.message }));
  if (!publicationDigest.ok) return failure(canonicalRecord({ kind: "invalid-accepted-agent-result", message: publicationDigest.error.message }));
  if (typeof batchIndex !== "number" || !Number.isSafeInteger(batchIndex) || batchIndex < 0) {
    return failure(canonicalRecord({
      kind: "invalid-accepted-agent-result",
      message: "issued spawn request proof batchIndex must be a non-negative safe integer",
    }));
  }
  return success(canonicalRecord({
    schemaVersion: 1,
    kind: "issued-spawn-request-proof",
    runId: runId.value,
    effectId: effectId.value,
    publicationDigest: publicationDigest.value,
    batchIndex,
  }));
}

export function issuancePublicationIdentity(issuance: IssuedSpawnRequestProof): BatchPublicationIdentity {
  return publicationIdentity(issuance);
}

export function authorityResolutionFailure(message: string, field?: string): AcceptedAgentResultError {
  return fieldFailureError("invalid-accepted-agent-result", message, field);
}

export function resolveRegisteredPublicationAuthority(
  resolver: PublicationAuthorityResolver,
  identity: BatchPublicationIdentity,
): DomainResult<RegisteredBatchPublicationAuthority, AcceptedAgentResultError> {
  if (typeof resolver !== "function") {
    return failure(authorityResolutionFailure("a publication authority resolver is required"));
  }
  let rawResolution: unknown;
  try {
    rawResolution = resolver(identity);
  } catch (cause) {
    return failure(authorityResolutionFailure(causedMessage("publication authority resolver threw", cause)));
  }
  // Classified by the SHARED envelope reader, like the other three publication
  // ports. This site used to re-implement the same four steps inline — a fourth,
  // untied copy of the check `readResultEnvelope` was introduced to consolidate,
  // sitting directly under the JSDoc that claims the consolidation happened.
  const envelope = readResultEnvelope(rawResolution, "publication authority resolver", "publicationAuthorityResolver");
  if (!envelope.ok) {
    // The success-shape violation is reported WITHOUT a field, as it always was
    // here; every other violation names the field the classifier derived.
    return failure(envelope.error.kind === "success-shape"
      ? authorityResolutionFailure(envelope.error.message)
      : authorityResolutionFailure(envelope.error.message, envelope.error.field));
  }
  if (envelope.value.branch === "failed") {
    const resolverError = readExactDataRecord(
      envelope.value.error,
      ["kind", "field", "message"],
      "publication authority resolution error",
    );
    if (!resolverError.ok) {
      return failure(authorityResolutionFailure(
        resolverError.error.message,
        boundaryField("publicationAuthorityResolver.error", resolverError.error),
      ));
    }
    if (resolverError.value.kind !== "publication-authority-unavailable") {
      return failure(authorityResolutionFailure(
        "publication authority resolution error kind is invalid",
        "publicationAuthorityResolver.error.kind",
      ));
    }
    if (typeof resolverError.value.message !== "string" || resolverError.value.message.trim().length === 0) {
      return failure(authorityResolutionFailure(
        "publication authority resolution error message must be non-empty",
        "publicationAuthorityResolver.error.message",
      ));
    }
    if (resolverError.value.field !== undefined &&
        (typeof resolverError.value.field !== "string" || resolverError.value.field.trim().length === 0)) {
      return failure(authorityResolutionFailure(
        "publication authority resolution error field must be non-empty when present",
        "publicationAuthorityResolver.error.field",
      ));
    }
    return failure(authorityResolutionFailure(
      resolverError.value.message,
      typeof resolverError.value.field === "string"
        ? resolverError.value.field
        : "publicationAuthorityResolver.error.message",
    ));
  }
  const registered = envelope.value.value;
  if (typeof registered !== "object" || registered === null || !registeredPublicationCache.has(registered)) {
    return failure(authorityResolutionFailure("publication authority resolver returned an untrusted or forged registration proof"));
  }
  const authority = registered as RegisteredBatchPublicationAuthority;
  if (!samePublicationIdentity(identity, authority.identity) ||
      !samePublicationIdentity(authority.identity, batchPublicationIdentity(authority.receipt))) {
    return failure(authorityResolutionFailure("resolved publication authority is stale or foreign"));
  }
  return success(authority);
}

export function issuedSpawnRequest(
  published: PublishedSpawnRequestAuthority,
  registered: RegisteredBatchPublicationAuthority,
  batchIndex: number,
): SpawnRequest {
  const issuance = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "issued-spawn-request-proof" as const,
    runId: registered.identity.runId,
    effectId: registered.identity.effectId,
    publicationDigest: registered.identity.publicationDigest,
    batchIndex,
  });
  const request = Object.create(null) as {
    authority: AgentRequestAuthority;
    context: ContextReference;
    issuance: IssuedSpawnRequestProof;
    readonly [ISSUED_REQUEST_PROOF]: true;
  };
  Object.defineProperties(request, {
    authority: { value: published.authority, enumerable: true, writable: false, configurable: false },
    context: { value: published.context, enumerable: true, writable: false, configurable: false },
    issuance: { value: issuance, enumerable: true, writable: false, configurable: false },
    [ISSUED_REQUEST_PROOF]: { value: true, enumerable: false, writable: false, configurable: false },
  });
  const canonical = Object.freeze(request);
  issuedRequestCache.set(canonical, canonical);
  return canonical;
}

export function parseIssuedSpawnRequestAgainstRegistration(
  registered: RegisteredBatchPublicationAuthority,
  raw: unknown,
): DomainResult<SpawnRequest, AcceptedAgentResultError> {
  const cached = typeof raw === "object" && raw !== null ? issuedRequestCache.get(raw) : undefined;
  const serializedEnvelope = cached === undefined
    ? raw
    : canonicalRecord({ authority: cached.authority, context: cached.context, issuance: cached.issuance });
  const request = readExactDataRecord(serializedEnvelope, ["authority", "context", "issuance"], "issued spawn request");
  if (!request.ok) return failure(authorityResolutionFailure(request.error.message));
  const published = parsePublishedSpawnRequest(
    canonicalRecord({ authority: request.value.authority, context: request.value.context }),
    "issued spawn request",
  );
  if (!published.ok) return failure(authorityResolutionFailure(published.error.message));
  const issuance = parseIssuedSpawnRequestProof(request.value.issuance);
  if (!issuance.ok) return issuance;
  const identity = issuancePublicationIdentity(issuance.value);
  if (!samePublicationIdentity(identity, registered.identity)) {
    return failure(authorityResolutionFailure("issued spawn request carries stale or foreign publication identity"));
  }
  const expected = registered.receipt.issuedRequests[issuance.value.batchIndex];
  if (expected === undefined || !samePublishedRequest(published.value, expected)) {
    return failure(authorityResolutionFailure(
      "issued spawn request does not match registered run/request/context/order/output/model/Skill authority",
    ));
  }
  return success(issuedSpawnRequest(expected, registered, issuance.value.batchIndex));
}

export function parseIssuedSpawnRequestIdentity(
  raw: unknown,
): DomainResult<BatchPublicationIdentity, AcceptedAgentResultError> {
  const cached = typeof raw === "object" && raw !== null ? issuedRequestCache.get(raw) : undefined;
  const serializedEnvelope = cached === undefined
    ? raw
    : canonicalRecord({ authority: cached.authority, context: cached.context, issuance: cached.issuance });
  const envelope = readExactDataRecord(serializedEnvelope, ["authority", "context", "issuance"], "issued spawn request");
  if (!envelope.ok) return failure(authorityResolutionFailure(envelope.error.message));
  const issuance = parseIssuedSpawnRequestProof(envelope.value.issuance);
  return issuance.ok ? success(issuancePublicationIdentity(issuance.value)) : issuance;
}

/** Rebuild a runtime proof only after one independent registered-authority lookup. */
export function parseIssuedSpawnRequest(
  resolver: PublicationAuthorityResolver,
  raw: unknown,
): DomainResult<SpawnRequest, AcceptedAgentResultError> {
  const identity = parseIssuedSpawnRequestIdentity(raw);
  if (!identity.ok) return identity;
  const registered = resolveRegisteredPublicationAuthority(resolver, identity.value);
  return registered.ok
    ? parseIssuedSpawnRequestAgainstRegistration(registered.value, raw)
    : registered;
}
