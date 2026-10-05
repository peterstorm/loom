/**
 * Panel verdict source selection and durable provenance (AD-8, FR-006/009/011/012).
 *
 * Pure module: no I/O, no clock, no randomness.
 */
import type { PayloadProducerKind, PayloadProducerKindName } from "./model-profiles";
import type { ParseResult } from "./panel-kernel";
import { reviewerEmissionToolContract } from "./reviewer-contract";
import { success as domainSuccess, failure as domainFailure } from "./orchestration-contract/identity";
import { safeRecord } from "./exact-data";
import {
  canonicalRecord,
  parseArtifactByteLength,
  parseArtifactDigest,
  parseRequestId,
  parseSlotId,
  type ArtifactDigest,
  type DomainResult,
  type RequestId,
  type SemanticAttempt,
  type SlotId,
} from "./orchestration-contract";

//
// Judge v1 and refutation v1 enter their panels through the SAME deterministic
// selection seam the reviewer capture path uses: the emission observation is
// folded and bound ONCE (the kernel's `selectVerdictSource`, reached through
// the injected port), the selection runs BEFORE the authoritative parse
// (AD-8), and the accepted source is returned by the same decision — never
// reconstructed by a caller from the input records. The panel parsers keep
// their criterion/lens bindings and complete candidate/finding coverage
// (FR-012): a selection can choose WHICH bytes are parsed, never what they
// must bind to — a source cannot override issuance.
//
// Purity boundary: this module is a declared pure module, so it never imports
// the emission transport modules (`emission-ingestion`/`emission-tool`/
// `harness-capture`). The kernel capabilities arrive as the injected port —
// the shell that owns the emission transport supplies the ONE production
// adapter. The structural types below mirror the kernel's frozen contract
// shapes; a kernel drift fails to compile at the adapter, never silently
// here. The core keeps every decision arm: which bytes won, the retained
// refusal, the durable provenance, the record protocol, and the AD-9 exact
// replay (re-certification is checked HERE against the minted digest the
// port returns — the port can return a refusal, never a verdict).

/** The closed schema-version vocabulary of the frozen emission registry
 *  (structural mirror of the kernel's `EmissionSchemaVersion`). */
type PanelVerdictSchemaVersion = "v1" | "v2" | "v3";

const VERDICT_SCHEMA_VERSIONS: readonly string[] = ["v1", "v2", "v3"];

/** The frozen emission tool-name vocabulary (structural mirror of the
 *  kernel's `EmissionToolName`). */
type PanelVerdictEmissionToolName =
  | "loom_emit_reviewer_payload"
  | "loom_emit_judge_verdict"
  | "loom_emit_refutation_verdict";

/** Structural mirror of the kernel's issued emission binding: the
 *  authenticated issuance (AD-6 — never output shape) the selection folds
 *  against. */
export type PanelVerdictEmissionBinding = Readonly<{
  requestId: RequestId;
  kind: PayloadProducerKind;
  version: PanelVerdictSchemaVersion;
  toolName: PanelVerdictEmissionToolName;
  schemaDigest: ArtifactDigest;
}>;

/** The verdict-kind-refined binding view: a binding minted for one producer
 *  kind cannot be passed where another is expected (the kernel's
 *  `IssuedEmissionBindingOf` path scoping, mirrored). */
export type PanelVerdictEmissionBindingOf<K extends PayloadProducerKindName> = PanelVerdictEmissionBinding &
  Readonly<{ kind: Readonly<{ kind: K }> }>;

// Route-aware panel-verdict wire-instruction rendering (AD-7; FR-020/AS-012).

/**
 * The closed wire-instruction route of ONE panel verdict spawn attempt — the
 * same route discriminant the request programs project (AD-7), mirrored over
 * this core's binding vocabulary so the render never re-derives route
 * semantics. The emission arm carries the registry-minted binding; the
 * extraction-only arm its admission reason. A refused route is not
 * representable — the shell throws it fail-closed before any render.
 */
export type PanelVerdictInstructionRoute =
  | Readonly<{ kind: "emission"; binding: PanelVerdictEmissionBinding }>
  | Readonly<{ kind: "extraction-only"; reason: string }>;

/**
 * Route-aware rendered panel-verdict wire instructions (AD-7, FR-020/AS-012):
 * an emission route renders the ONE frozen tool-primary wording over the
 * binding's exact issued tool; an extraction-only verdict attempt — today's
 * whole panel-verdict spawn surface, and any unqualified route — renders the
 * panel's own final-message contract (`finalMessageContract`) VERBATIM. A
 * pure projection; it never rewrites issued packet or verdict-schema bytes.
 */
export function renderPanelVerdictInstructions(
  route: PanelVerdictInstructionRoute,
  finalMessageContract: string,
): string {
  return route.kind === "emission"
    ? reviewerEmissionToolContract(route.binding.toolName)
    : finalMessageContract;
}

/** Structural mirror of the kernel's emission tool call: the contract fields
 *  only, never adapter provenance beyond them. The request id is the kernel's
 *  plain string here (the binding carries the branded identity); a parsed
 *  record stores its canonical minted id in the same field. */
export type PanelVerdictEmissionCall = Readonly<{
  requestId: string;
  toolCallId: string;
  kind: PayloadProducerKind;
  version: PanelVerdictSchemaVersion;
  arguments: unknown;
}>;

/** Structural mirror of the kernel's closed emission observation (AD-8):
 *  absent, one complete call, multiple distinct calls, or unusable with a
 *  reason — an incomplete or failed observation is representable as itself,
 *  never reclassified as absence. */
export type PanelVerdictEmissionObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "single-call"; call: PanelVerdictEmissionCall }>
  | Readonly<{ kind: "multiple-calls"; calls: readonly PanelVerdictEmissionCall[] }>
  | Readonly<{ kind: "unusable"; reason: string }>;

/** The emission edge's parse refusal, widened to the durable code string the
 *  provenance form carries (the kernel's closed code vocabulary has no
 *  runtime enumeration to mirror; the code is never re-ingested). */
export type PanelVerdictEmissionRefusal = Readonly<{ code: string; message: string }>;

/** Structural mirror of the kernel's closed observation-refusal vocabulary. */
export type PanelVerdictObservationRefusal = Readonly<{
  code: "unusable-observation" | "wrong-request" | "unexpected-kind" | "unexpected-version";
  message: string;
}>;

/** The kernel's verdict-source selection, mirrored: which bytes won, from
 *  what source, with the retained refusal when extraction ran over a refused
 *  call (FR-006) and the observed calls when the fold refused an ambiguity
 *  (FR-007). */
export type PanelVerdictSourceSelection =
  | Readonly<{ kind: "emission-tool-arguments"; rawJson: string; source: "emission-tool"; call: PanelVerdictEmissionCall }>
  | Readonly<{ kind: "final-message-extraction"; rawJson: string; source: "extraction" }>
  | Readonly<{ kind: "extraction-over-refused-call"; rawJson: string; source: "extraction"; emissionRefusal: PanelVerdictEmissionRefusal }>
  | Readonly<{ kind: "duplicate-emission-call"; calls: readonly PanelVerdictEmissionCall[] }>
  | Readonly<{ kind: "observation-refused"; refusal: PanelVerdictObservationRefusal }>;

/**
 * The injected kernel port — the purity boundary's ONE seam. The shell that
 * owns the emission transport supplies the fold (the kernel's ONE
 * verdict-source selection) and the AD-9 replay capability that re-certifies
 * a record's emission claims against the frozen registry and re-folds the
 * single accepted call. The replay returns the minted schema digest beside
 * the re-folded selection so THIS core performs the certification
 * cross-check; a capability failure is a typed refusal, never a verdict.
 */
export type PanelVerdictEmissionPort = Readonly<{
  fold: (submission: Readonly<{
    binding: PanelVerdictEmissionBindingOf<"judge-verdict" | "refutation-verdict">;
    observation: PanelVerdictEmissionObservation;
    rawJson: string;
  }>) => PanelVerdictSourceSelection;
  replayAcceptedCall: (
    claims: Readonly<{ requestId: RequestId; kind: "judge-verdict" | "refutation-verdict"; version: PanelVerdictSchemaVersion }>,
    call: PanelVerdictEmissionCall,
    rawJson: string,
  ) => DomainResult<Readonly<{ schemaDigest: ArtifactDigest; selection: PanelVerdictSourceSelection }>, string>;
}>;

/** One issued verdict-kind emission submission input, as the caller hands it
 *  to the panel seam: the issued binding (authenticated issuance, AD-6 —
 *  never output shape), the emission observation, and the kernel port that
 *  folds the observation. */
export type PanelVerdictEmissionSelectionOf<K extends "judge-verdict" | "refutation-verdict"> = Readonly<{
  binding: PanelVerdictEmissionBindingOf<K>;
  observation: PanelVerdictEmissionObservation;
  port: PanelVerdictEmissionPort;
}>;

export type PanelVerdictEmissionSelection = PanelVerdictEmissionSelectionOf<"judge-verdict" | "refutation-verdict">;

/**
 * The durable accepted-source record of one panel verdict (FR-009/FR-011) —
 * the same provenance vocabulary the reviewer capture seam's source records
 * use, so one ingestion-time shape serves every producer path. The emission
 * arm carries the accepted call's identity and the issued schema identity;
 * the extraction arm carries the retained single-call refusal that led to the
 * fallback (FR-006) when there was one — and nothing when there was not.
 */
export type PanelVerdictSource = Readonly<{
  source: "emission-tool" | "extraction";
  toolCallId?: string;
  producerKind?: string;
  emissionSchemaVersion?: PanelVerdictSchemaVersion;
  schemaDigest?: string;
  emissionRefusal?: Readonly<{ code: string; message: string }>;
}>;

/** The zero-emission-baseline accepted source: extraction with no refusal. */
const EXTRACTION_VERDICT_SOURCE: PanelVerdictSource = canonicalRecord({ source: "extraction" as const });

type RejectedVerdictSelection = Extract<PanelVerdictSourceSelection, { kind: "duplicate-emission-call" | "observation-refused" }>;
type AcceptedVerdictSelection = Extract<PanelVerdictSourceSelection, { kind: "emission-tool-arguments" | "final-message-extraction" | "extraction-over-refused-call" }>;

const isRejectedVerdictSelection = (selection: PanelVerdictSourceSelection): selection is RejectedVerdictSelection =>
  selection.kind === "duplicate-emission-call" || selection.kind === "observation-refused";

/** The provenance the selection decision itself returns for an accepted arm —
 *  derived ONCE here, so the persistent accepted events and the legacy source
 *  records cannot disagree about what was accepted or why. */
export function panelVerdictSourceProvenance(
  expected: PanelVerdictEmissionBinding,
  accepted: AcceptedVerdictSelection,
): PanelVerdictSource {
  switch (accepted.kind) {
    case "emission-tool-arguments":
      return canonicalRecord({
        source: "emission-tool" as const,
        toolCallId: accepted.call.toolCallId,
        producerKind: accepted.call.kind.kind,
        emissionSchemaVersion: expected.version,
        schemaDigest: expected.schemaDigest,
      });
    case "final-message-extraction":
      return EXTRACTION_VERDICT_SOURCE;
    case "extraction-over-refused-call":
      return canonicalRecord({
        source: "extraction" as const,
        emissionRefusal: canonicalRecord({ code: accepted.emissionRefusal.code, message: accepted.emissionRefusal.message }),
      });
  }
}

/**
 * The durable source arm of an accepted panel verdict event, PARSED not
 * assumed. `undefined` is the historical projection: genuinely pre-feature
 * accepted events were extraction (the plan's parser-compatible historical
 * rule). A PRESENT arm must be exact — malformed present-day source fields are
 * NOT historical absence and refuse here, so a corrupted arm can never be
 * replayed as a silently-downgraded extraction acceptance.
 */
export function projectPanelVerdictSourceArm(raw: unknown): DomainResult<PanelVerdictSource, string> {
  if (raw === undefined) return domainSuccess(EXTRACTION_VERDICT_SOURCE);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return domainFailure("panel verdict source must be an exact data record when present");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (record["source"] === "emission-tool") {
    if (keys !== "emissionSchemaVersion,producerKind,schemaDigest,source,toolCallId") {
      return domainFailure("an emission-tool panel verdict source must carry exactly its call identity and issued schema identity");
    }
    const toolCallId = record["toolCallId"];
    const producerKind = record["producerKind"];
    const emissionSchemaVersion = record["emissionSchemaVersion"];
    const schemaDigest = parseArtifactDigest(record["schemaDigest"]);
    if (typeof toolCallId !== "string" || toolCallId.length === 0 ||
        typeof producerKind !== "string" || producerKind.length === 0 ||
        typeof emissionSchemaVersion !== "string" || !VERDICT_SCHEMA_VERSIONS.includes(emissionSchemaVersion) ||
        !schemaDigest.ok) {
      return domainFailure("an emission-tool panel verdict source carries a malformed call or schema identity");
    }
    return domainSuccess(canonicalRecord({
      source: "emission-tool" as const,
      toolCallId,
      producerKind,
      emissionSchemaVersion: emissionSchemaVersion as PanelVerdictSchemaVersion,
      schemaDigest: schemaDigest.value,
    }));
  }
  if (record["source"] === "extraction") {
    if (keys === "source") return domainSuccess(EXTRACTION_VERDICT_SOURCE);
    if (keys === "emissionRefusal,source") {
      const refusal = record["emissionRefusal"];
      if (typeof refusal !== "object" || refusal === null || Array.isArray(refusal)) {
        return domainFailure("a retained emission refusal must be an exact data record");
      }
      const refusalRecord = refusal as Record<string, unknown>;
      if (Object.keys(refusalRecord).sort().join(",") !== "code,message" ||
          typeof refusalRecord["code"] !== "string" || refusalRecord["code"].length === 0 ||
          typeof refusalRecord["message"] !== "string" || refusalRecord["message"].length === 0) {
        return domainFailure("a retained emission refusal must carry exactly a non-empty code and message");
      }
      return domainSuccess(canonicalRecord({
        source: "extraction" as const,
        emissionRefusal: canonicalRecord({ code: refusalRecord["code"], message: refusalRecord["message"] }),
      }));
    }
    return domainFailure("an extraction panel verdict source carries only its optional retained emission refusal");
  }
  return domainFailure(`panel verdict source must be "emission-tool" or "extraction"`);
}

/** The typed rejection a refused selection arm produces — the SAME vocabulary
 *  the reviewer capture runtime uses for the identical arms, so a duplicate or
 *  misbound observation consumes one attempt and names what was observed. The
 *  `kind` is the PersistentPanelError kind; the rejection event derives its
 *  category from it (`rejectionEvent`), the legacy path reads the message. */
export function panelVerdictSelectionRejection(
  selection: RejectedVerdictSelection,
): Readonly<{ kind: "request-binding-mismatch" | "malformed-result"; message: string }> {
  if (selection.kind === "duplicate-emission-call") {
    return canonicalRecord({
      kind: "malformed-result" as const,
      message: `result carried ${selection.calls.length} distinct emission tool calls (${selection.calls.map(({ toolCallId }) => toolCallId).join(", ")}); exactly one successfully executed call is allowed`,
    });
  }
  return canonicalRecord({
    kind: selection.refusal.code === "unusable-observation" ? "malformed-result" as const : "request-binding-mismatch" as const,
    message: `${selection.refusal.code}: ${selection.refusal.message}`,
  });
}

/** The retained single-call refusal beside a parse that also refused: BOTH
 *  causes in one diagnostic (AD-9 — one rejection, not two). */
export function describePanelRefusalPair(
  emissionRefusal: Readonly<{ code: string; message: string }>,
  parseDetail: string,
): string {
  return `emission arguments were refused [${emissionRefusal.code}]: ${emissionRefusal.message}; authoritative verdict parse was refused: ${parseDetail}`;
}

/** The emission-provenance prefix of an emission-arm parse failure: the
 *  accepted call stays named even when its payload refused the joins. */
export function describePanelVerdictEmissionParseFailure(
  toolCallId: string,
  label: string,
  detail: string,
): string {
  return `emission tool call ${toolCallId} produced a ${label} that refuses its authoritative parse: ${detail}`;
}


interface VerdictSubmissionFoldInput<Verdict> {
  readonly label: "judge verdict" | "refutation verdict";
  readonly expectedRequestId: RequestId;
  readonly emission: PanelVerdictEmissionSelection | undefined;
  readonly rawJson: unknown;
  /** The seam's own authoritative parse — the criterion/lens binding and the
   *  complete candidate/finding coverage live HERE and nowhere else; the
   *  selection can choose which bytes reach it, never what they bind to. */
  readonly parse: (rawJson: unknown) => ParseResult<Verdict>;
  readonly classifyRaw: (raw: unknown) => "request-binding-mismatch" | "malformed-result";
  readonly foreignAuthorityMessage: string;
}

type VerdictSubmissionFold<Verdict> =
  | Readonly<{ kind: "accepted"; value: Verdict; source: PanelVerdictSource }>
  | Readonly<{ kind: "rejected"; errorKind: "request-binding-mismatch" | "malformed-result"; message: string }>;

/**
 * The ONE verdict-submission fold both panel verdict submissions share:
 * selection before the authoritative parse (AD-8), the accepted source
 * returned by the same decision, and the extraction arms parsed byte-verbatim
 * on the caller's raw input. Without an emission input the fold is today's
 * baseline exactly — the accepted source is extraction and every diagnostic is
 * byte-identical to the pre-selection seam.
 */
export function foldVerdictSubmission<Verdict>(input: VerdictSubmissionFoldInput<Verdict>): VerdictSubmissionFold<Verdict> {
  let selection: PanelVerdictSourceSelection | null = null;
  if (input.emission !== undefined) {
    // The port receives the caller's raw input ONLY to fill the extraction
    // arms' byte-verbatim echo (`final-message-extraction` /
    // `extraction-over-refused-call`); the fold itself never parses it, and
    // the parse target for those arms is resolved back to `input.rawJson`
    // below — never to this echo. A non-string caller input is carried as ""
    // so the echo stays a string without ever becoming the parse target: the
    // caller's own input keeps refusing with its baseline diagnostic.
    selection = input.emission.port.fold({
      binding: input.emission.binding,
      observation: input.emission.observation,
      rawJson: typeof input.rawJson === "string" ? input.rawJson : "",
    });
    if (isRejectedVerdictSelection(selection)) {
      const rejection = panelVerdictSelectionRejection(selection);
      return canonicalRecord({ kind: "rejected" as const, errorKind: rejection.kind, message: rejection.message });
    }
  }
  const accepted = selection;
  const parseTarget = accepted !== null && accepted.kind === "emission-tool-arguments" ? accepted.rawJson : input.rawJson;
  const parsed = input.parse(parseTarget);
  if (!parsed.ok) {
    const errorKind = input.classifyRaw(parseTarget);
    const base = errorKind === "request-binding-mismatch" ? input.foreignAuthorityMessage : parsed.errors.join("; ");
    let message = base;
    if (accepted !== null && accepted.kind === "emission-tool-arguments") {
      message = describePanelVerdictEmissionParseFailure(accepted.call.toolCallId, input.label, base);
    } else if (accepted !== null && accepted.kind === "extraction-over-refused-call") {
      message = describePanelRefusalPair(accepted.emissionRefusal, base);
    }
    return canonicalRecord({ kind: "rejected" as const, errorKind, message });
  }
  if (accepted === null) {
    return canonicalRecord({ kind: "accepted" as const, value: parsed.value, source: EXTRACTION_VERDICT_SOURCE });
  }
  if (input.emission === undefined) {
    // Unreachable — a non-null selection exists only under an emission input.
    // The guard carries the invariant instead of a non-null assertion.
    throw new Error("panel verdict invariant: a selection exists without an issued emission binding");
  }
  return canonicalRecord({ kind: "accepted" as const, value: parsed.value, source: panelVerdictSourceProvenance(input.emission.binding, accepted) });
}

/**
 * The durable per-attempt record of ONE panel attempt's accepted verdict
 * source (the legacy panel path's channel for FR-009/FR-011 provenance). The
 * emission arm carries the ACCEPTED CALL — the exact replay authority AD-9's
 * replay row names — so every later per-attempt scan (reconciliation,
 * deterministic tally/aggregate) re-runs the SAME selection seam over it and
 * reproduces the same selected bytes instead of re-parsing pre-selection
 * transcript bytes as if they had never been selected.
 */
export type PanelVerdictSourceRecord = Readonly<{
  schemaVersion: 1;
  kind: "panel-verdict-source";
  requestId: RequestId;
  slotId: SlotId;
  attempt: SemanticAttempt;
  source: PanelVerdictSource;
  /** The accepted call — present exactly when the source is emission-tool. */
  acceptedCall?: PanelVerdictEmissionCall;
  /** The digest identity of the bytes the seam authoritatively parsed: the
   *  selected rawJson for the emission arm, the attempt's own raw bytes for
   *  the extraction arms. */
  payloadDigest: ArtifactDigest;
  payloadByteLength: number;
}>;

/** The ONE constructor of a durable panel verdict source record. */
export function panelVerdictSourceRecord(args: {
  requestId: RequestId;
  slotId: SlotId;
  attempt: SemanticAttempt;
  source: PanelVerdictSource;
  acceptedCall?: PanelVerdictEmissionCall;
  payloadDigest: ArtifactDigest;
  payloadByteLength: number;
}): DomainResult<PanelVerdictSourceRecord, string> {
  if (args.source.source === "emission-tool") {
    if (args.acceptedCall === undefined) {
      return domainFailure("an emission-tool panel verdict source record requires the accepted call");
    }
  } else if (args.acceptedCall !== undefined) {
    return domainFailure("an extraction panel verdict source record must not carry an accepted call");
  }
  if (!Number.isSafeInteger(args.payloadByteLength) || args.payloadByteLength <= 0) {
    return domainFailure("a panel verdict source record payload byte length must be a positive safe integer");
  }
  return domainSuccess(canonicalRecord({
    schemaVersion: 1 as const,
    kind: "panel-verdict-source" as const,
    requestId: args.requestId,
    slotId: args.slotId,
    attempt: args.attempt,
    source: args.source,
    ...(args.acceptedCall === undefined ? {} : { acceptedCall: args.acceptedCall }),
    payloadDigest: args.payloadDigest,
    payloadByteLength: args.payloadByteLength,
  }));
}

/** Parse a durable record back: exact shape, branded identities, the accepted
 *  call's contract fields, and every cross-check that makes a tampered record
 *  refuse instead of replaying. Absent source is NOT the historical projection
 *  here — a record always carries its accepted source. */
/** Parse and certify the acceptedCall field of an emission-tool panel verdict
 * source record against the record's own identity and source arm. Every
 * diagnostic keeps the exact message the fixtures pin. */
function parsePanelVerdictAcceptedCall(args: Readonly<{
  acceptedCallRaw: unknown;
  requestId: RequestId;
  source: PanelVerdictSource;
}>): DomainResult<PanelVerdictEmissionCall, string> {
  const callRecord = safeRecord(args.acceptedCallRaw, ["requestId", "toolCallId", "kind", "version", "arguments"]);
  if (callRecord === null) return domainFailure("the accepted call must be an exact emission tool call record");
  const callRequestId = parseRequestId(callRecord["requestId"]);
  const toolCallId = callRecord["toolCallId"];
  const kind = callRecord["kind"];
  const kindName = typeof kind === "object" && kind !== null && !Array.isArray(kind)
    ? (kind as Record<string, unknown>)["kind"]
    : undefined;
  const version = callRecord["version"];
  if (!callRequestId.ok) return domainFailure(`the accepted call request id is invalid: ${callRequestId.error.message}`);
  if (typeof toolCallId !== "string" || toolCallId.length === 0) return domainFailure("the accepted call carries no tool-call identity");
  if (typeof kindName !== "string" || (kindName !== "judge-verdict" && kindName !== "refutation-verdict")) {
    // The verdict panels only ever accept verdict-kind calls: the submission
    // bindings are verdict-kind refinements and the kernel selection refuses
    // an unexpected kind, so a record claiming anything else is not a panel
    // verdict record and refuses at the parse boundary.
    return domainFailure(`the accepted call names producer kind ${JSON.stringify(kindName ?? null)}, which is not a panel verdict kind`);
  }
  if (version !== "v1" && version !== "v2" && version !== "v3") {
    return domainFailure(`the accepted call carries schema version ${JSON.stringify(version ?? null)}, which is not in the closed schema-version vocabulary`);
  }
  if (callRecord["arguments"] === undefined) return domainFailure("the accepted call carries no arguments");
  const acceptedCall: PanelVerdictEmissionCall = canonicalRecord({
    requestId: callRequestId.value,
    toolCallId,
    kind: canonicalRecord({ kind: kindName }),
    version,
    arguments: callRecord["arguments"],
  });
  if (acceptedCall.requestId !== args.requestId) return domainFailure("the accepted call was observed under a different request than the record's request");
  if (args.source.toolCallId !== toolCallId) return domainFailure("the accepted call's identity disagrees with the record's source arm");
  if (args.source.producerKind !== kindName) return domainFailure("the accepted call's producer kind disagrees with the record's source arm");
  if (args.source.emissionSchemaVersion !== version) return domainFailure("the accepted call's schema version disagrees with the record's source arm");
  return domainSuccess(acceptedCall);
}

export function parsePanelVerdictSourceRecord(raw: unknown): DomainResult<PanelVerdictSourceRecord, string> {
  const record = safeRecord(raw, ["schemaVersion", "kind", "requestId", "slotId", "attempt", "source", "acceptedCall", "payloadDigest", "payloadByteLength"]);
  if (record === null || record["schemaVersion"] !== 1 || record["kind"] !== "panel-verdict-source") {
    return domainFailure("panel verdict source record must be an exact schemaVersion 1 panel-verdict-source data record");
  }
  const requestId = parseRequestId(record["requestId"]);
  const slotId = parseSlotId(record["slotId"]);
  const attempt = record["attempt"] === 1 || record["attempt"] === 2 ? record["attempt"] : null;
  const payloadDigest = parseArtifactDigest(record["payloadDigest"]);
  const payloadByteLength = parseArtifactByteLength(record["payloadByteLength"]);
  if (record["source"] === undefined) return domainFailure("panel verdict source record must carry its accepted source");
  const source = projectPanelVerdictSourceArm(record["source"]);
  if (!requestId.ok) return domainFailure(`panel verdict source record request id is invalid: ${requestId.error.message}`);
  if (!slotId.ok) return domainFailure(`panel verdict source record slot id is invalid: ${slotId.error.message}`);
  if (attempt === null) return domainFailure("panel verdict source record attempt must be 1 or 2");
  if (!payloadDigest.ok) return domainFailure(`panel verdict source record payload digest is invalid: ${payloadDigest.error.message}`);
  if (!payloadByteLength.ok) return domainFailure(`panel verdict source record payload byte length is invalid: ${payloadByteLength.error.message}`);
  if (!source.ok) return domainFailure(`panel verdict source record source is invalid: ${source.error}`);

  const acceptedCallRaw = record["acceptedCall"];
  if (source.value.source === "emission-tool") {
    if (acceptedCallRaw === undefined) {
      return domainFailure("an emission-tool panel verdict source record requires the accepted call");
    }
    const call = parsePanelVerdictAcceptedCall({ acceptedCallRaw, requestId: requestId.value, source: source.value });
    if (!call.ok) return call;
    return domainSuccess(canonicalRecord({
      schemaVersion: 1 as const,
      kind: "panel-verdict-source" as const,
      requestId: requestId.value,
      slotId: slotId.value,
      attempt,
      source: source.value,
      acceptedCall: call.value,
      payloadDigest: payloadDigest.value,
      payloadByteLength: payloadByteLength.value,
    }));
  }
  if (acceptedCallRaw !== undefined) {
    return domainFailure("an extraction panel verdict source record must not carry an accepted call");
  }
  return domainSuccess(canonicalRecord({
    schemaVersion: 1 as const,
    kind: "panel-verdict-source" as const,
    requestId: requestId.value,
    slotId: slotId.value,
    attempt,
    source: source.value,
    payloadDigest: payloadDigest.value,
    payloadByteLength: payloadByteLength.value,
  }));
}

/**
 * The EXACT REPLAY of one durable record's accepted selection (AD-9's replay
 * row): the emission arm re-certifies its claims against the frozen registry
 * THROUGH THE INJECTED PORT, re-folds the single accepted call, and re-runs
 * the SAME selection — so a re-scan reproduces the accepted bytes and call
 * identity instead of re-parsing the pre-selection transcript bytes. The
 * certification cross-check stays HERE: the port returns the minted schema
 * digest beside the re-folded selection, and this core refuses a record whose
 * digest does not certify it. The caller verifies the returned selection's
 * bytes against the record's payload digest (it owns the bytes); extraction
 * arms replay verbatim with the retained refusal in place.
 */
export function replayPanelVerdictSourceSelection(
  record: PanelVerdictSourceRecord,
  rawJson: string,
  port: PanelVerdictEmissionPort,
): DomainResult<PanelVerdictSourceSelection, string> {
  if (record.source.source === "extraction") {
    // The durable refusal re-enters the selection vocabulary verbatim: the
    // provenance form widened the parse's code to a validated non-empty
    // string (the shared provenance vocabulary) and this arm carries it
    // unchanged — the code is never re-ingested by any parse.
    return record.source.emissionRefusal === undefined
      ? domainSuccess(canonicalRecord({ kind: "final-message-extraction" as const, rawJson, source: "extraction" as const }))
      : domainSuccess(canonicalRecord({
          kind: "extraction-over-refused-call" as const,
          rawJson,
          source: "extraction" as const,
          emissionRefusal: record.source.emissionRefusal,
        }));
  }
  const call = record.acceptedCall;
  if (call === undefined) {
    return domainFailure("an emission-tool panel verdict source record carries no accepted call to replay");
  }
  // The record's emission claims select a VERDICT registry cell: a
  // panel-verdict-source record for another producer kind is not replayable
  // through this seam. The parse already refused non-verdict accepted calls;
  // this check narrows the durable provenance string for the port's claims.
  if (record.source.producerKind !== "judge-verdict" && record.source.producerKind !== "refutation-verdict") {
    return domainFailure(`the record's producer kind ${record.source.producerKind} is not a panel verdict kind`);
  }
  const claimsVersion = record.source.emissionSchemaVersion;
  if (claimsVersion === undefined) {
    // Unreachable for a PARSED record (the exact-key-set validation requires
    // the version); the guard covers a constructor-built record instead of a
    // non-null assertion.
    return domainFailure("an emission-tool panel verdict source record carries no issued schema version");
  }
  const replayed = port.replayAcceptedCall(
    canonicalRecord({
      requestId: record.requestId,
      kind: record.source.producerKind,
      version: claimsVersion,
    }),
    call,
    rawJson,
  );
  if (!replayed.ok) {
    return domainFailure(`the record's emission claims select no frozen registry cell: ${replayed.error}`);
  }
  if (replayed.value.schemaDigest !== record.source.schemaDigest) {
    return domainFailure(`the record's schema digest does not certify the frozen registry digest ${replayed.value.schemaDigest}`);
  }
  const selection = replayed.value.selection;
  if (selection.kind !== "emission-tool-arguments") {
    return domainFailure(`replaying the record's accepted call did not reproduce the accepted emission selection (${selection.kind})`);
  }
  if (selection.call.toolCallId !== record.source.toolCallId) {
    return domainFailure(`the replayed call identity ${selection.call.toolCallId} does not match the recorded ${record.source.toolCallId}`);
  }
  return domainSuccess(selection);
}
