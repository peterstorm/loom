/**
 * The emission-tool kernel: the frozen registry mapping each cataloged
 * producer payload kind to its emission tool spec — the one place kind→schema
 * knowledge lives — plus the admission gate at the emission edge, the
 * capability ADT, and the ONE constructor of an emission tool's `parameters`
 * object.
 *
 * Pure module: no I/O, no clock, no randomness, no pi-package import — the
 * dependency direction stays pi → engine. Every trust boundary is explicit and
 * fail-closed: `admitEmissionArguments` re-validates untrusted model input
 * with the same parsers the fallback uses before anything is ingestable (the
 * parse IS the gate), and the frozen bytes are the ONE serialization chain
 * (AD-5) — no TypeBox mirror, no drift.
 */

import { z } from "zod/v4";
import { sha256Hex } from "./review-packet";
import { REVIEWER_PAYLOAD_SCHEMA_V2, type ReviewerProtocolFailure } from "./reviewer-contract";
import { parseReviewerPayloadV2, parseStandaloneReviewerPayloadV3 } from "./reviewer-protocol";
import { STANDALONE_REVIEWER_SCHEMA_V3 } from "./standalone-lineage-contract";
import { JUDGE_VERDICT_SCHEMA_V1, judgeVerdictV1Schema } from "./panel-contract";
import { REFUTATION_VERDICT_SCHEMA_V1, refutationVerdictV1Schema } from "./review-panel";
import {
  canonicalRecord,
  describeUnknown,
  failure,
  parseArtifactDigest,
  parseRequestId,
  success,
  type ArtifactDigest,
  type DomainResult,
  type RequestId,
} from "./orchestration-contract/identity";
import type { PayloadProducerKind, PayloadProducerKindName } from "./model-profiles";

/** FR-009 vocabulary: the recorded source of every ingested payload. */
export type PayloadSource = "emission-tool" | "extraction";

/** The toolName literal union — no branded newtype: the toolName is carried
 *  verbatim in protocol wording and agent prompts, never minted by prompt text. */
export type EmissionToolName =
  | "loom_emit_reviewer_payload"
  | "loom_emit_judge_verdict"
  | "loom_emit_refutation_verdict";

/**
 * The schema-version vocabulary of the frozen per-kind registry — the
 * transport-level union, deliberately flat. Which (kind, version) pairs a tool
 * carries is the registry's knowledge (`spec.schemaVersions`), and a spawn
 * bound to a version its tool does not carry is the degradation path the
 * admission gate refuses (`unsupported-schema-version`), not a type error — a
 * compound union of the valid pairs would type away the degradation the
 * capability ADT exists to express.
 */
export type EmissionSchemaVersion = "v2" | "v3" | "v1";

/** The closed vocabulary as data, for boundary parses of untrusted claimed
 *  version strings (the mint refuses a non-member before any registry lookup). */
export const EMISSION_SCHEMA_VERSIONS: readonly EmissionSchemaVersion[] = Object.freeze(["v2", "v3", "v1"]);

/**
 * The emission edge's closed refusal-code vocabulary — parse, don't validate:
 * a code is a member of THIS union, never a free string, so an unknown code is
 * unrepresentable behind every consumer that switches on it (the tool result
 * mapping, the Phase-2 execute shell). It is the reviewer protocol's own
 * failure codes (the registry's reviewer parsers mint exactly these) plus the
 * two failures the admission gate itself mints around the parse — the
 * unsupported-version and deterministic-serialization refusals.
 */
export type EmissionParseFailureCode =
  | ReviewerProtocolFailure["code"]
  | "invalid-schema"
  | "unsupported-schema-version";

/**
 * The failure the emission edge refuses. `code` is the parse's own code
 * vocabulary, never-ingestable per FR-006; `message` is the deterministic
 * diagnostic the tool result carries and the model re-emits within the
 * bounded budget.
 */
export type EmissionParseFailure = Readonly<{ code: EmissionParseFailureCode; message: string }>;

/** One per-version parser: the parse IS the gate at the emission edge. */
export type EmissionPayloadParser = (
  raw: Uint8Array,
) => DomainResult<unknown, EmissionParseFailure>;

export type EmissionToolSpec = Readonly<{
  toolName: EmissionToolName;
  /** Keyed by the closed `EmissionSchemaVersion` vocabulary — a spec cell
   *  claiming an out-of-vocabulary version is unrepresentable; an untrusted
   *  claimed version string is parsed against the vocabulary at the mint
   *  before any lookup, so the identical `unsupported-schema-version` refusal
   *  path is kept as a typed lookup miss. */
  schemaVersions: Readonly<Partial<Record<EmissionSchemaVersion, Readonly<{
    schemaBytes: string;
    parsePayload: EmissionPayloadParser;
  }>>>>;
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The pure schema-conformance parser for one verdict kind's arguments. The
 * frozen zod schema is the ONE contract (AD-5); this parse is its gate: shape,
 * score domain, and prose sanitization are expressed in the schema, so
 * arguments conform by construction at the syntax level. The authoritative
 * engine-side gate for verdicts is the submission seam's parse with the panel
 * authority's bindings (AD-8/FR-012) — the trust boundary is re-validated at
 * the engine edge regardless, so the difference is defense-in-depth placement,
 * not a security property the design depends on.
 */
const verdictArgsParser = (schema: z.ZodType): EmissionPayloadParser => (raw: Uint8Array) => {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(raw));
  } catch {
    return failure(canonicalRecord({
      code: "invalid-json",
      message: "emission arguments are not valid JSON",
    }));
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return success(parsed.data);
  // The refusal is the model's correction surface within the bounded budget:
  // one message names every fixable violation in the call (bounded, in parse
  // order) instead of spending a retry per issue.
  const issues = parsed.error.issues;
  const named = issues.slice(0, 5).map((issue) => issue.message).join("; ");
  const overflow = issues.length > 5 ? `; (+${issues.length - 5} more)` : "";
  return failure(canonicalRecord({
    code: "invalid-schema",
    message: `emission arguments do not conform to the frozen schema: ${named || "schema non-conformance"}${overflow}`,
  }));
};

/**
 * The frozen registry: each of the three cataloged producer payload kinds
 * mapped to its emission tool spec — reviewer-payload (v2 current + v3
 * standalone-successor, the same parsers the fallback uses), judge-verdict
 * (v1, the current external snake_case contract of serializeJudgeVerdict),
 * and refutation-verdict (v1, the current external contract of
 * serializeRefutationVerdict). A new producer kind is one entry here plus
 * compiler-guided wiring: the `satisfies` check is exhaustive over the kind
 * union, so a kind without a spec fails to compile at the one place kind→schema
 * knowledge lives.
 */
export const EMISSION_TOOL_SPECS = Object.freeze({
  "reviewer-payload": Object.freeze({
    toolName: "loom_emit_reviewer_payload",
    schemaVersions: Object.freeze({
      v2: Object.freeze({
        schemaBytes: REVIEWER_PAYLOAD_SCHEMA_V2,
        parsePayload: parseReviewerPayloadV2,
      }),
      v3: Object.freeze({
        schemaBytes: STANDALONE_REVIEWER_SCHEMA_V3,
        parsePayload: parseStandaloneReviewerPayloadV3,
      }),
    }),
  }),
  "judge-verdict": Object.freeze({
    toolName: "loom_emit_judge_verdict",
    schemaVersions: Object.freeze({
      v1: Object.freeze({
        schemaBytes: JUDGE_VERDICT_SCHEMA_V1,
        parsePayload: verdictArgsParser(judgeVerdictV1Schema),
      }),
    }),
  }),
  "refutation-verdict": Object.freeze({
    toolName: "loom_emit_refutation_verdict",
    schemaVersions: Object.freeze({
      v1: Object.freeze({
        schemaBytes: REFUTATION_VERDICT_SCHEMA_V1,
        parsePayload: verdictArgsParser(refutationVerdictV1Schema),
      }),
    }),
  }),
} satisfies Record<PayloadProducerKindName, EmissionToolSpec>);

/**
 * The ONE constructor of an emission tool's `parameters` object (AD-5): the
 * frozen zod-derived bytes, parsed once. Byte-identity by construction — one
 * schema, one serialization chain, no TypeBox mirror, no drift, zero new
 * dependency.
 *
 * The confined TSchema cast: pi's `registerTool` types its `parameters`
 * parameter as a TypeBox `TSchema`, so the pi registration surface (Phase 2)
 * claims the parsed JSON as one — a cast, not a proof, since this pure leaf
 * returns `unknown`. The cast's price is paid ONCE per kind at that single
 * surface and nowhere else; this leaf never narrows, and the byte-match guard
 * re-proves the parse→stringify round trip against the frozen bytes per kind
 * and version, so the claimed type can never describe a schema the provider
 * grammar-constrains against.
 *
 * The parse throws on non-JSON bytes — a constructor invariant guarding the
 * tool's `parameters` validity, permitted to throw per the functional core's
 * error strategy. Unreachable for every registry consumer: the spec-carried
 * bytes are stamper-written constants that always parse.
 */
export function frozenPayloadSchemaParameters(schemaBytes: string): unknown {
  return JSON.parse(schemaBytes);
}

/**
 * The admission ADT: admitted or refused — exactly one arm per argument, so
 * the tool result mapping switches on the discriminant. The refused arm is
 * named for the VERDICT (refused = never-ingestable, FR-006), not for one of
 * its reasons: the `code` field carries the precise refusal (unsupported
 * version, non-serializable arguments, or schema non-conformance), and naming
 * the arm after one reason would read as schema non-conformance when the
 * version or the serialization failed.
 */
export type EmissionArgumentAdmission =
  | Readonly<{ kind: "valid"; payload: unknown }>
  | Readonly<{ kind: "refused"; code: EmissionParseFailureCode; message: string }>;

/**
 * The parse IS the gate at the emission edge. The arguments are serialized
 * deterministically and parsed through the registry's parsePayload — for
 * reviewer-payload the SAME full schema-level parser the fallback uses; for
 * the verdict kinds the pure schema-conformance parse of the frozen verdict
 * schema. A refused admission is never-ingestable (FR-006); the tool result
 * is an error the model sees and re-emits within the bounded budget.
 */
export function admitEmissionArguments(
  spec: EmissionToolSpec,
  version: EmissionSchemaVersion,
  rawArgs: unknown,
): EmissionArgumentAdmission {
  const schemaVersion = spec.schemaVersions[version];
  if (schemaVersion === undefined) {
    return Object.freeze({
      kind: "refused" as const,
      code: "unsupported-schema-version",
      message: `emission tool ${spec.toolName} carries no schema version ${version}`,
    });
  }
  let bytes: Uint8Array;
  try {
    bytes = encoder.encode(JSON.stringify(rawArgs, null, 2));
  } catch (error) {
    return Object.freeze({
      kind: "refused" as const,
      code: "invalid-json",
      message: `emission arguments could not be serialized deterministically: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const parsed = schemaVersion.parsePayload(bytes);
  return parsed.ok
    ? Object.freeze({ kind: "valid" as const, payload: parsed.value })
    : Object.freeze({
        kind: "refused" as const,
        code: parsed.error.code,
        message: parsed.error.message,
      });
}

// ---------------------------------------------------------------------------
// Issued binding (AD-8): authenticated issuance selects exactly one cell of
// the frozen registry — kind, version, exact tool name and schema digest
// ---------------------------------------------------------------------------

/**
 * The closed refusal vocabulary of the issued-binding mint. A refusal means
 * the issuance claims do not select a registry cell: the (kind, version) pair
 * is unsupported, the claimed tool name or schema digest does not certify the
 * frozen schema, or the request identity is not canonical. Never a default.
 */
export type EmissionBindingRefusalCode =
  | "invalid-request-identity"
  | "unknown-producer-kind"
  | "unsupported-schema-version"
  | "tool-name-mismatch"
  | "schema-digest-mismatch";

export type EmissionBindingRefusal = Readonly<{ code: EmissionBindingRefusalCode; message: string }>;

/**
 * The parsed issued binding: ONE cell of the frozen registry selected by
 * authenticated issuance, carried as a valid-pair record rather than
 * independent string fields that allow unsupported combinations — a minted
 * binding's (kind, version) pair is registry-carried by construction, its
 * tool name is the registry's exact tool name, and its schema digest is
 * derived from the frozen bytes, never trusted from the claims. The request
 * identity is the issued request attempt the binding holds the emission
 * observations to (FR-014).
 */
export type IssuedEmissionBinding = Readonly<{
  requestId: RequestId;
  kind: PayloadProducerKind;
  version: EmissionSchemaVersion;
  toolName: EmissionToolName;
  schemaDigest: ArtifactDigest;
}>;

/**
 * The path-refined binding view. `selectCanonicalPayload` takes the
 * reviewer-payload refinement and `selectVerdictSource` the verdict-kind
 * refinement, so a binding minted for one ingestion path cannot be passed to
 * the other without a cast — the path scoping is a type fact, never a runtime
 * check the caller could forget.
 */
export type IssuedEmissionBindingOf<K extends PayloadProducerKindName> = IssuedEmissionBinding &
  Readonly<{ kind: Readonly<{ kind: K }> }>;

/**
 * The issuance claims the mint parses against the frozen registry. The
 * optional claims are verified when present (a stale protocol packet must
 * refuse here, not register a tool its packet does not certify) and derived
 * from the registry when absent — derivation is from the ONE frozen source,
 * never a current default (AD-7).
 */
export type IssuedEmissionRequest = Readonly<{
  requestId: string;
  kind: PayloadProducerKindName;
  version: string;
  toolName?: string;
  schemaDigest?: string;
}>;

/**
 * The ONLY mint of an issued emission binding: parse the claims against the
 * frozen registry, refuse every claim that does not select one of its cells,
 * and return the valid-pair binding. `sha256Hex` is the digest derivation the
 * reviewer protocol's recorded `schemaDigest` uses, so a binding minted here
 * and a protocol stamped from the same bytes carry the same digest.
 */
export function issueEmissionBinding<K extends PayloadProducerKindName>(
  issued: IssuedEmissionRequest & Readonly<{ kind: K }>,
): DomainResult<IssuedEmissionBindingOf<K>, EmissionBindingRefusal> {
  const requestId = parseRequestId(issued.requestId);
  if (!requestId.ok) {
    return failure(canonicalRecord({
      code: "invalid-request-identity" as const,
      message: `issued emission binding carries no canonical request id: ${requestId.error.message}`,
    }));
  }
  // The closed vocabulary is parsed at the boundary — an untrusted claimed
  // version string that names no vocabulary member refuses exactly where the
  // definedness check refused before, and the typed lookup below can never
  // select an out-of-vocabulary key.
  if (!(EMISSION_SCHEMA_VERSIONS as readonly string[]).includes(issued.version)) {
    return failure(canonicalRecord({
      code: "unsupported-schema-version" as const,
      message: `issued emission binding carries schema version ${describeUnknown(issued.version)}, which is not in the closed schema-version vocabulary (${EMISSION_SCHEMA_VERSIONS.join(", ")})`,
    }));
  }
  const claimedVersion = issued.version as EmissionSchemaVersion;
  const spec: EmissionToolSpec | undefined = EMISSION_TOOL_SPECS[issued.kind];
  if (spec === undefined) {
    // A caller that parsed claims as plain strings and narrowed by cast can
    // name an out-of-vocabulary kind; the mint refuses it in vocabulary
    // instead of crashing on the undefined spec cell.
    return failure(canonicalRecord({
      code: "unknown-producer-kind" as const,
      message: `issued emission binding names producer kind ${describeUnknown(issued.kind)}, which selects no registry cell (supported: ${Object.keys(EMISSION_TOOL_SPECS).join(", ")})`,
    }));
  }
  const schemaVersion = spec.schemaVersions[claimedVersion];
  if (schemaVersion === undefined) {
    return failure(canonicalRecord({
      code: "unsupported-schema-version" as const,
      message: `emission tool ${spec.toolName} carries no schema version ${claimedVersion} for producer kind ${issued.kind} (supported: ${Object.keys(spec.schemaVersions).join(", ")})`,
    }));
  }
  if (issued.toolName !== undefined && issued.toolName !== spec.toolName) {
    return failure(canonicalRecord({
      code: "tool-name-mismatch" as const,
      message: `issued tool name ${describeUnknown(issued.toolName)} does not name the registry tool ${spec.toolName} for producer kind ${issued.kind}`,
    }));
  }
  const schemaDigest = sha256Hex(schemaVersion.schemaBytes) as ArtifactDigest;
  if (issued.schemaDigest !== undefined) {
    const claimed = parseArtifactDigest(issued.schemaDigest);
    if (!claimed.ok || claimed.value !== schemaDigest) {
      return failure(canonicalRecord({
        code: "schema-digest-mismatch" as const,
        message: `issued schema digest ${describeUnknown(issued.schemaDigest)} does not certify the frozen ${issued.kind}/${claimedVersion} schema (registry digest ${schemaDigest})`,
      }));
    }
  }
  // The vocabulary parse above proves claimedVersion is a registry-carried
  // version, the definedness check proves the kind selects a cell, and the K
  // constraint (K extends PayloadProducerKindName) proves the kind member —
  // this is the one justified construction cast at the ONE minting point, so
  // every minted binding is a valid-pair record by construction and no
  // consumer ever re-narrows.
  return success(canonicalRecord({
    requestId: requestId.value,
    kind: Object.freeze({ kind: issued.kind }),
    version: claimedVersion,
    toolName: spec.toolName,
    schemaDigest,
  }) as IssuedEmissionBindingOf<K>);
}

/**
 * The capability ADT (US4/US2): per harness × producer kind, whether the
 * constrained path can be provided. Design intent for the later-wave wiring
 * (spawn/request programs, T6/T7 — no production caller in this revision):
 * the Pi-side declaration is to return degradation "refuse" when the child's
 * loaded revision does not carry this emission tool (the revision check is
 * parent-side loaded-revision containment — NOT the FR-008 child-readiness
 * proof, which the launcher gate owns); that is the US4 hard fail whose
 * remediation is /reload. The Claude Code declaration is to return
 * not-provided with degradation "extraction" (no Loom extension seam) — the
 * US2 capability-aware-degradation class, which the guard admits (AD-7).
 */
export type EmissionToolCapability =
  | Readonly<{ kind: "provided"; schemaDigest: ArtifactDigest }>
  | Readonly<{ kind: "not-provided"; reason: string; degradation: "refuse" | "extraction" }>;

/** The ONLY mint of the provided capability; the schema digest is branded. */
export function providedEmissionCapability(schemaDigest: ArtifactDigest): EmissionToolCapability {
  return canonicalRecord({ kind: "provided" as const, schemaDigest });
}

/** The ONLY mint of the not-provided capability; the degradation class is data. */
export function notProvidedEmissionCapability(
  reason: string,
  degradation: "refuse" | "extraction",
): EmissionToolCapability {
  return canonicalRecord({ kind: "not-provided" as const, reason, degradation });
}
