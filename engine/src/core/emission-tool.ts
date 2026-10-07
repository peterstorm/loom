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
import { sha256Hex } from "./digest";
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
 *  version strings (the mint refuses a non-member before any registry lookup).
 *  Module-local: its only consumer is `issueEmissionBinding`'s boundary parse
 *  in this module; the registry's typed cells carry the vocabulary to every
 *  other reader. */
const EMISSION_SCHEMA_VERSIONS: readonly EmissionSchemaVersion[] = Object.freeze(["v2", "v3", "v1"]);

/**
 * The emission edge's closed refusal-code vocabulary — parse, don't validate:
 * a code is a member of THIS union, never a free string, so an unknown code is
 * unrepresentable behind every consumer that switches on it (the tool result
 * mapping, the Phase-2 execute shell). It is the reviewer protocol's own
 * failure codes (the registry's reviewer parsers mint exactly these) plus two
 * added vocabulary members minted elsewhere: `unsupported-schema-version`
 * (the admission gateway below and the issued-binding mint) and `invalid-schema`
 * (the verdict-args parser). The gateway's deterministic-serialization refusal
 * reuses the protocol's own `invalid-json` code rather than adding a member.
 */
export type EmissionParseFailureCode =
  | ReviewerProtocolFailure["code"]
  | "invalid-schema"
  | "unsupported-schema-version";

/**
 * The failure the emission edge refuses. `code` is the parse's own code
 * vocabulary, never-ingestable per FR-006; `message` is the deterministic
 * diagnostic the tool result carries. There is no same-spawn correction
 * (ADR-0019): the model is instructed to finish with the final-message
 * fallback after a refusal, and a second distinct call in the same spawn is a
 * `duplicate-emission-call` rejection that consumes the attempt.
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
  // The refusal is what the model sees before it finishes with the
  // final-message fallback (it must not re-emit in the same spawn, ADR-0019):
  // one message names every fixable violation in the call (bounded, in parse
  // order) so the fallback payload can avoid all of them at once.
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

/** The reserved name prefix of the loom emission tool family. A registered
 *  emission tool is a frozen-registry name; a call to a PREFIX-matching name
 *  outside the registry is an observed-but-unbindable emission call (both
 *  harness transcript adapters refuse it as incomplete — never absorbed as
 *  absence). */
export const EMISSION_TOOL_NAME_PREFIX = "loom_emit_";

/** The closed family membership of a tool name, decided by the frozen
 *  registry — `unrelated` names are not emission calls at all;
 *  `registered` carries the registry's producer kind for the name;
 *  `unregistered-emission-name` is a prefix-reserved name the registry does
 *  not freeze (a stale or foreign child's tool): observable, unbindable,
 *  never silently unrelated. The ONE classification the Pi and Claude
 *  transcript adapters share. */
export type EmissionToolFamily =
  | Readonly<{ kind: "unrelated" }>
  | Readonly<{ kind: "registered"; producerKind: PayloadProducerKindName }>
  | Readonly<{ kind: "unregistered-emission-name" }>;

const producerKindsByToolName = (): ReadonlyMap<string, PayloadProducerKindName> => {
  const projection = new Map<string, PayloadProducerKindName>();
  for (const [kind, spec] of Object.entries(EMISSION_TOOL_SPECS)) {
    if (projection.has(spec.toolName)) {
      throw new Error(`emission tool registry invariant failed: duplicate tool name ${spec.toolName}`);
    }
    projection.set(spec.toolName, kind as PayloadProducerKindName);
  }
  return projection;
};

const producerKindByToolName = producerKindsByToolName();

export function emissionToolFamily(toolName: unknown): EmissionToolFamily {
  if (typeof toolName !== "string") return canonicalRecord({ kind: "unrelated" as const });
  const registeredKind = producerKindByToolName.get(toolName);
  if (registeredKind !== undefined) {
    return canonicalRecord({ kind: "registered" as const, producerKind: registeredKind });
  }
  return toolName.startsWith(EMISSION_TOOL_NAME_PREFIX)
    ? canonicalRecord({ kind: "unregistered-emission-name" as const })
    : canonicalRecord({ kind: "unrelated" as const });
}

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

// ---------------------------------------------------------------------------
// Wire-form canonicalization (the emission edge's transport parse)
// ---------------------------------------------------------------------------

const MAX_CANONICALIZE_DEPTH = 32;

type JsonSchemaNode = Readonly<Record<string, unknown>>;

const isPlainJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Resolve a local `#/$defs/...` JSON-pointer $ref against the root schema.
 *  Total: a foreign pointer, a missing segment, or a non-object target yields
 *  null (the node then walks as itself); self/cyclic refs are bounded by the
 *  walk's depth guard, never by throwing. */
const resolveLocalRef = (root: JsonSchemaNode, node: JsonSchemaNode): JsonSchemaNode | null => {
  const ref = node["$ref"];
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const key = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isPlainJsonRecord(current) || !(key in current)) return null;
    current = current[key];
  }
  return isPlainJsonRecord(current) ? current : null;
};

/** The schema positions a node effectively describes: itself (local $ref
 *  resolved) plus every composite member (allOf/anyOf/oneOf), flattened
 *  depth-guarded. One frozen schema, one walk — the positions are read-only
 *  projections, never a second contract. */
const schemaPositions = (
  node: JsonSchemaNode,
  root: JsonSchemaNode,
  depth: number,
): readonly JsonSchemaNode[] => {
  if (depth > MAX_CANONICALIZE_DEPTH) return [];
  const resolved = resolveLocalRef(root, node) ?? node;
  const positions: JsonSchemaNode[] = [resolved];
  for (const composite of ["allOf", "anyOf", "oneOf"] as const) {
    const members = resolved[composite];
    if (Array.isArray(members)) {
      for (const member of members) {
        if (isPlainJsonRecord(member)) positions.push(...schemaPositions(member, root, depth + 1));
      }
    }
  }
  return positions;
};

type DeclaredTypeParse = { ok: true; value: unknown } | { ok: false };

const NOT_PARSED: DeclaredTypeParse = Object.freeze({ ok: false });

/** `JSON.parse` as a total function: the parsed value, or not parsed. */
const parseJsonValue = (raw: string): DeclaredTypeParse => {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return NOT_PARSED;
  }
};

/** Parse one JSON-encoded string as ONE declared JSON Schema type. Accepts
 *  only the JSON encoding of a value the declared type names: numbers follow
 *  the JSON number grammar (so `0x10`, `+5`, `.5` and `5.` stay strings;
 *  `1e2` is JSON and parses), booleans and null are the exact literals.
 *  Anything else fails so the unchanged string reaches validation and is
 *  refused with its own vocabulary. Pure and total — never throws. */
const parseStringAsDeclaredType = (type: string, raw: string): DeclaredTypeParse => {
  switch (type) {
    case "boolean":
      return raw === "true" || raw === "false" ? { ok: true, value: raw === "true" } : NOT_PARSED;
    case "null":
      return raw === "null" ? { ok: true, value: null } : NOT_PARSED;
    default: {
      const parsed = parseJsonValue(raw);
      if (!parsed.ok) return NOT_PARSED;
      const { value } = parsed;
      const accepted =
        type === "number" ? typeof value === "number" && Number.isFinite(value)
        : type === "integer" ? typeof value === "number" && Number.isInteger(value)
        : type === "array" ? Array.isArray(value)
        : type === "object" ? isPlainJsonRecord(value)
        : false;
      return accepted ? parsed : NOT_PARSED;
    }
  }
};

/** The declared `type` names of one schema position. */
const declaredTypes = (position: JsonSchemaNode): readonly string[] => {
  const declared = position["type"];
  if (typeof declared === "string") return [declared];
  return Array.isArray(declared) ? declared.filter((member): member is string => typeof member === "string") : [];
};

/** The string branch: when any effective position declares `string`, the
 *  value is already a legitimate string and stays verbatim (a literal
 *  `"null"` at an `anyOf [string, null]` field is never coerced to null).
 *  Otherwise the value is parsed against the declared non-string types; an
 *  unparseable value stays verbatim for validation to refuse. */
const canonicalizeStringAt = (
  node: JsonSchemaNode,
  value: string,
  root: JsonSchemaNode,
  depth: number,
): unknown => {
  const types = schemaPositions(node, root, depth).flatMap(declaredTypes);
  if (types.includes("string")) return value;
  for (const type of types) {
    const parsed = parseStringAsDeclaredType(type, value);
    if (parsed.ok) return parsed.value;
  }
  return value;
};

/** The array branch: walk the declared items schema; unchanged elements keep
 *  the original array reference. */
const canonicalizeArrayAt = (
  node: JsonSchemaNode,
  value: readonly unknown[],
  root: JsonSchemaNode,
  depth: number,
): unknown => {
  const items = schemaPositions(node, root, depth)
    .map((position) => position["items"])
    .find(isPlainJsonRecord);
  if (items === undefined) return value;
  let changed = false;
  const next = value.map((element) => {
    const canonical = canonicalizeAt(items, element, root, depth + 1);
    if (canonical !== element) changed = true;
    return canonical;
  });
  return changed ? next : value;
};

/** The declared properties across a node's effective positions. */
const declaredProperties = (
  node: JsonSchemaNode,
  root: JsonSchemaNode,
  depth: number,
): ReadonlyMap<string, JsonSchemaNode> => {
  const properties = new Map<string, JsonSchemaNode>();
  for (const position of schemaPositions(node, root, depth)) {
    const declared = position["properties"];
    if (!isPlainJsonRecord(declared)) continue;
    for (const [key, propertySchema] of Object.entries(declared)) {
      if (isPlainJsonRecord(propertySchema) && !properties.has(key)) properties.set(key, propertySchema);
    }
  }
  return properties;
};

/** The object branch: the declared properties of every effective position
 *  (first declaration wins, matching ajv's resolution); unchanged objects
 *  keep the original reference. */
const canonicalizeObjectAt = (
  node: JsonSchemaNode,
  value: Record<string, unknown>,
  root: JsonSchemaNode,
  depth: number,
): unknown => {
  const properties = declaredProperties(node, root, depth);
  if (properties.size === 0) return value;
  let changed = false;
  const next: Record<string, unknown> = { ...value };
  for (const [key, propertySchema] of properties) {
    if (!(key in next)) continue;
    const canonical = canonicalizeAt(propertySchema, next[key], root, depth + 1);
    if (canonical !== next[key]) {
      next[key] = canonical;
      changed = true;
    }
  }
  return changed ? next : value;
};

/** One canonicalization step at one schema node, dispatched over the value's
 *  JSON runtime type. */
const canonicalizeAt = (node: JsonSchemaNode, value: unknown, root: JsonSchemaNode, depth: number): unknown => {
  if (depth > MAX_CANONICALIZE_DEPTH) return value;
  if (typeof value === "string") return canonicalizeStringAt(node, value, root, depth);
  if (Array.isArray(value)) return canonicalizeArrayAt(node, value, root, depth);
  if (isPlainJsonRecord(value)) return canonicalizeObjectAt(node, value, root, depth);
  return value;
};

/**
 * The emission edge's wire-form canonicalization (parse, don't validate):
 * routes without server-side constrained decoding routinely serialize schema
 * fields as JSON-encoded STRINGS (`schemaVersion: "2"`, `findings: "[...]"`)
 * even when the model's payload is otherwise conforming. This walk is driven
 * ENTIRELY by the frozen schema's own declared types — it only parses a value
 * that a declared non-string type can accept from its JSON encoding, and it
 * never invents, defaults, or drops a field.
 *
 * Contract preservation (FR-021/SC-006): the registered `parameters` remain
 * the frozen bytes; this step runs in pi's `prepareArguments` hook BEFORE the
 * harness validates against those same bytes, so every genuinely
 * non-conforming form is still refused with the frozen schema's own
 * vocabulary; `admitIssuedEmissionArguments` runs it again before the
 * registry's parse gate (a no-op on an already-canonical form), so the engine
 * selection and the execute shell admit through one function. One schema, one
 * contract — the canonicalization adds a deterministic transport parse, not a
 * second schema.
 *
 * Pure, total, and idempotent: unknown schema shapes and unmatched arguments
 * pass through verbatim; unchanged subtrees return the original reference;
 * cyclic $defs are bounded by the walk's depth guard. The input is never
 * mutated — the canonical form is a fresh structure sharing unchanged
 * subtrees.
 */
export function canonicalizeEmissionWireArguments(schema: unknown, args: unknown): unknown {
  if (!isPlainJsonRecord(schema)) return args;
  return canonicalizeAt(schema, args, schema, 0);
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
 * is an error the model sees. The model then finishes with the final-message
 * fallback; re-emitting in the same spawn is a `duplicate-emission-call`
 * rejection that consumes the attempt (ADR-0019).
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
 * The nominal brand only `issueEmissionBinding` can apply. A class-private
 * name is excluded from object-spread types and cannot be written by an object
 * literal, so neither a hand-built record nor `{ ...minted, schemaDigest }`
 * type-checks as a binding: forging one needs an explicit cast. Type-only — no
 * class exists at runtime, and a minted binding stays a frozen null-prototype
 * record that serializes and compares exactly as before.
 */
declare class IssuedEmissionBindingMint {
  #minted: true;
}

/**
 * The parsed issued binding: ONE cell of the frozen registry selected by
 * authenticated issuance, carried as a valid-pair record rather than
 * independent string fields that allow unsupported combinations — a minted
 * binding's (kind, version) pair is registry-carried by construction, its
 * tool name is the registry's exact tool name, and its schema digest is
 * derived from the frozen bytes, never trusted from the claims. The request
 * identity is the issued request attempt the binding holds the emission
 * observations to (FR-014). Nominal: the mint is the only producer, so every
 * consumer holds a registry-certified cell by type, not by re-verification.
 */
export type IssuedEmissionBinding = Readonly<{
  requestId: RequestId;
  kind: PayloadProducerKind;
  version: EmissionSchemaVersion;
  toolName: EmissionToolName;
  schemaDigest: ArtifactDigest;
}> & IssuedEmissionBindingMint;

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
  // version, the definedness check proves the kind selects a cell, the K
  // constraint (K extends PayloadProducerKindName) proves the kind member, and
  // the tool name and digest are the cell's own — this is the one justified
  // construction cast at the ONE minting point (it also applies the nominal
  // brand), so every minted binding is a certified valid-pair record by
  // construction and no consumer ever re-narrows or re-verifies.
  return success(canonicalRecord({
    requestId: requestId.value,
    kind: Object.freeze({ kind: issued.kind }),
    version: claimedVersion,
    toolName: spec.toolName,
    schemaDigest,
  }) as IssuedEmissionBindingOf<K>);
}

/**
 * The ONE admission of untrusted emission arguments under an issued binding,
 * shared by both shells that admit them — the Pi execute shell
 * (`acknowledgeEmissionExecution`) and the engine's selection over the
 * observed transcript (`emission-ingestion`) — so "the same admission" is one
 * function rather than two call sequences kept equal by convention.
 *
 * The schema-driven wire-form canonicalization runs first (the transport
 * parse of `canonicalizeEmissionWireArguments` over the cell's frozen
 * parameters; idempotent, so arguments Pi's `prepareArguments` already
 * canonicalized pass through unchanged), then the registry cell's parse gate.
 * The binding is nominal, so its cell is registry-certified by type; the
 * lookup miss below is unreachable for a minted binding and refuses through
 * the admission's own `unsupported-schema-version` vocabulary.
 */
export function admitIssuedEmissionArguments(
  binding: IssuedEmissionBinding,
  rawArgs: unknown,
): EmissionArgumentAdmission {
  const spec: EmissionToolSpec = EMISSION_TOOL_SPECS[binding.kind.kind];
  const schemaVersion = spec.schemaVersions[binding.version];
  if (schemaVersion === undefined) return admitEmissionArguments(spec, binding.version, rawArgs);
  const canonical = canonicalizeEmissionWireArguments(frozenPayloadSchemaParameters(schemaVersion.schemaBytes), rawArgs);
  return admitEmissionArguments(spec, binding.version, canonical);
}

/**
 * The capability ADT (US4/US2): per harness × producer kind, whether the
 * constrained path can be provided. The producer is
 * `qualifyIssuedSpawnEmissionRoute` in `spawn-admission.ts`: it declares
 * not-provided with degradation "extraction" for a non-Pi parent (Claude Code
 * has no Loom extension seam), for a Pi route that is not the qualified
 * emission route, and for a missing registry cell; otherwise it declares
 * provided with the issued cell's schema digest. The consumer is
 * `decideRequestEmissionRoute`: a provided digest that differs from the
 * issued cell's is the US4 hard refusal (parent-side loaded-revision
 * containment, remediated by /reload — NOT the FR-008 child-readiness proof,
 * which the launcher gate owns), and a not-provided "refuse" degradation is
 * the same hard refusal; "extraction" is the US2 capability-aware degradation
 * the guard admits (AD-7). ADR-0017 records the route decision.
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
