/**
 * The Pi-side emission tool shell — the PURE half of the child's emission
 * registration/readiness surface (T5; FR-001/FR-008/FR-013/FR-014/FR-021/
 * SC-006). The imperative half is the readiness command + hold wiring in
 * `pi/emission-readiness.ts`; this module owns every decision that wiring acts on, so
 * the acceptance suite drives the same policy seam production registers with
 * — never a test twin.
 *
 * Dependency direction: pi → engine, never outward, and NO pi-package import
 * (the tool definition is a plain record; the confined TypeBox claim happens
 * ONCE, at the `registerTool` surface in the extension). No environment is
 * read at import time — the provisioning parser takes the raw env value as a
 * parameter, so unit tests can import this module without pinning `~/.pi`.
 *
 * The three decisions minted here:
 *
 * 1. PROVISIONING (FR-008): the launcher provisions an emission-enabled child
 *    with the issued binding before any prompt. The child parses those claims
 *    through the ONE mint (`issueEmissionBinding` over the frozen registry) —
 *    kind/version/tool-name/digest identity is certified against the frozen
 *    registry, never taken from the env text. Absence is a distinct arm:
 *    a non-emission child is simply not provisioned, never a refusal.
 *
 * 2. REGISTRATION (FR-001/SC-006): the exact tool for the issued
 *    kind/version — the tool name and digest are the registry's, the
 *    parameters are the frozen bytes parsed once (ONE schema, no second
 *    contract; no TypeBox mirror), and the constrained-sampling request is
 *    the shared `strict: "prefer"` vocabulary (FR-002/INV-1 — never
 *    strict-required). Registration is idempotent ONLY for the exact same
 *    request/kind/version/digest; a contradictory re-registration is a
 *    refusal the shell throws (AD-4).
 *
 * 3. EXECUTION (FR-013): the execute shell observes the validated arguments
 *    and admits them through the registry's admission gate — the SAME
 *    admission the engine's selection later re-runs. Success returns the
 *    minimal terminating acknowledgment (no payload echo); a refusal is
 *    THROWN at the harness boundary, because returning an error-labeled
 *    object does not set pi's error flag (AD-3).
 *
 * The readiness payload builder mints the launcher-facing report: exactly the
 * ten contract fields the readiness barrier parses, carrying the child's
 * HONEST observations (its own load revision, the actual active set, its
 * actual pid) beside the minted binding — the launcher gate compares, the
 * child never certifies itself beyond what it observed.
 */

import {
  canonicalizeEmissionWireArguments,
  EMISSION_TOOL_SPECS,
  frozenPayloadSchemaParameters,
  issueEmissionBinding,
  type EmissionBindingRefusalCode,
  type EmissionToolName,
  type EmissionToolSpec,
  type IssuedEmissionBinding,
} from "../engine/src/core/emission-tool";
import {
  acknowledgeEmissionExecution,
  EMISSION_CONSTRAINED_SAMPLING_REQUEST,
  type EmissionConstrainedSamplingRequest,
  type EmissionExecutionOutcome,
  type EmissionToolAcknowledgment,
} from "../engine/src/core/harness-capture";
import { isRecord } from "../engine/src/core/plain-record";
import {
  boundDiagnosticMessage,
  canonicalRecord,
  describeUnknown,
  failure,
  parseArtifactDigest,
  parseContextDigest,
  parseRequestId,
  success,
  type ArtifactDigest,
  type ContextDigest,
  type DomainResult,
  type RequestId,
} from "../engine/src/core/orchestration-contract/identity";
import type { PayloadProducerKindName } from "../engine/src/core/model-profiles";

// ---------------------------------------------------------------------------
// The launcher↔child readiness protocol contract (AD-4, probe-proven shape)
// ---------------------------------------------------------------------------

/** The readiness command the launcher discovers and invokes via the RPC
 *  prompt command — extension commands execute without a model request. The
 *  name is the settled barrier protocol's (`probes/emission-readiness`, the
 *  wave-2 acceptance suite): renaming it is a launcher-visible contract
 *  change, not a refactor. */
export const EMISSION_READINESS_COMMAND = "loom-emission-readiness";

/** The custom-entry type the bound readiness payload travels under. The
 *  launcher's gate waits for `entry_appended` events of this type; the
 *  payload shape is `emissionReadinessReport`'s, and the barrier parses it
 *  with the production identity parsers. */
export const EMISSION_READINESS_ENTRY_TYPE = "loom-emission-readiness";

/** The custom-entry type bracketing the in-child `before_agent_start` hold —
 *  the defense-in-depth layer's observable gating (AD-4). Entries make the
 *  hold's phase ordering observable on the RPC stream; they are never LLM
 *  context. */
export const EMISSION_HOLD_ENTRY_TYPE = "loom-emission-hold";

/** The closed phase vocabulary the hold's `EMISSION_HOLD_ENTRY_TYPE` entries
 *  carry onto the RPC stream — part of this module's readiness protocol
 *  contract, beside the command and entry-type names it already owns:
 *
 *  - `entered`: a prompt arrived before readiness and is wedged.
 *  - `resolved`: the readiness exchange released the hold.
 *  - `shutdown-released`: the session shut down while the hold was still
 *    armed — the cleanup arm's honest forensic marker that readiness never
 *    opened on that child. The release exists so the wedged
 *    `before_agent_start` handler cannot outlive its session; it can admit
 *    no model request, because the session is ending. */
export type EmissionHoldPhase = "entered" | "resolved" | "shutdown-released";

/** The environment variable the launcher provisions an emission-enabled child
 *  with: the issued emission binding as JSON (request id, context digest,
 *  kind, version, tool name, schema digest). Absence is a NON-emission child;
 *  presence is parsed and certified, never trusted. */
export const LOOM_EMISSION_BINDING_ENV = "LOOM_EMISSION_BINDING";

/** The reserved name prefix of the loom emission tool family. A registered
 *  emission tool is a frozen-registry name; a call to a PREFIX-matching name
 *  outside the registry is an observed-but-unbindable emission call (the
 *  transcript adapter refuses it as incomplete — never absorbed as absence). */
export const EMISSION_TOOL_NAME_PREFIX = "loom_emit_";

// ---------------------------------------------------------------------------
// The emission tool family, as the frozen registry projects it to pi
// ---------------------------------------------------------------------------

/** The closed family membership of a tool name, decided by the frozen
 *  registry — `unrelated` names are not emission calls at all;
 *  `registered` carries the registry's producer kind for the name;
 *  `unregistered-emission-name` is a prefix-reserved name the registry does
 *  not freeze (a stale or foreign child's tool): observable, unbindable,
 *  never silently unrelated. */
export type EmissionToolFamily =
  | Readonly<{ kind: "unrelated" }>
  | Readonly<{ kind: "registered"; producerKind: PayloadProducerKindName }>
  | Readonly<{ kind: "unregistered-emission-name" }>;

const projectKindsByToolName = (): ReadonlyMap<string, PayloadProducerKindName> => {
  const projection = new Map<string, PayloadProducerKindName>();
  for (const [kind, spec] of Object.entries(EMISSION_TOOL_SPECS)) {
    if (projection.has(spec.toolName)) {
      throw new Error(`emission tool registry invariant failed: duplicate tool name ${spec.toolName}`);
    }
    projection.set(spec.toolName, kind as PayloadProducerKindName);
  }
  return projection;
};

const kindByToolName = projectKindsByToolName();

export function emissionToolFamily(toolName: unknown): EmissionToolFamily {
  if (typeof toolName !== "string") return canonicalRecord({ kind: "unrelated" as const });
  const registeredKind = kindByToolName.get(toolName);
  if (registeredKind !== undefined) {
    return canonicalRecord({ kind: "registered" as const, producerKind: registeredKind });
  }
  return toolName.startsWith(EMISSION_TOOL_NAME_PREFIX)
    ? canonicalRecord({ kind: "unregistered-emission-name" as const })
    : canonicalRecord({ kind: "unrelated" as const });
}

// ---------------------------------------------------------------------------
// Child provisioning (FR-008): the issued binding, certified — never trusted
// ---------------------------------------------------------------------------

/**
 * The child's provisioning, parsed once at load. `not-provisioned` is the
 * ordinary non-emission child (no hold, no readiness semantics);
 * `provisioning-refused` is an UNUSABLE provisioning — the launcher bound
 * claims that do not select a frozen registry cell, or a context digest that
 * is not canonical; the readiness command refuses it explicitly and the
 * in-child hold wedges (fail-closed: no model request can run on an
 * uncertified binding). `provisioned` carries the minted binding — registry
 * certified — and the canonical context digest.
 */
export type EmissionProvisioningRefusalCode =
  | "invalid-json"
  | "non-object"
  | "invalid-context-digest"
  | "invalid-claim-type"
  | EmissionBindingRefusalCode;

export type EmissionChildProvisioning =
  | Readonly<{ kind: "not-provisioned" }>
  | Readonly<{ kind: "provisioned"; binding: IssuedEmissionBinding; contextDigest: ContextDigest }>
  | Readonly<{ kind: "provisioning-refused"; code: EmissionProvisioningRefusalCode; reason: string }>;

/**
 * The claims carried by `LOOM_EMISSION_BINDING`. The optional claims are
 * verified when present and registry-derived when absent — the mint's own
 * contract; the child adds no second certification policy. The context
 * digest is the issued request's context binding the launcher holds; the
 * child echoes it in readiness and the gate compares.
 */
type ProvisioningClaims = Readonly<{
  requestId: unknown;
  contextDigest: unknown;
  kind: unknown;
  version: unknown;
  toolName: unknown;
  schemaDigest: unknown;
}>;

/** The provisioning text's claims: `not-provisioned` (absent env only),
 *  `refused` (unparseable JSON or a non-object), or the six extracted claim
 *  fields for certification. Certification itself stays in
 *  `mintProvisioningClaims`; this step only decides whether claims exist. */
type ProvisioningClaimsParse =
  | Readonly<{ kind: "not-provisioned" }>
  | Readonly<{ kind: "refused"; code: "invalid-json" | "non-object"; reason: string }>
  | Readonly<{ kind: "claims"; claims: ProvisioningClaims }>;

/** Extract the provisioning claims from the raw env text: JSON parse →
 *  object shape → the six fields verbatim. Total over arbitrary text. */
function parseProvisioningClaims(raw: string | undefined): ProvisioningClaimsParse {
  if (raw === undefined) {
    return canonicalRecord({ kind: "not-provisioned" as const });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return canonicalRecord({
      kind: "refused" as const,
      code: "invalid-json" as const,
      reason: boundDiagnosticMessage(
        `the provisioned emission binding is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ),
    });
  }
  if (!isRecord(parsed)) {
    return canonicalRecord({
      kind: "refused" as const,
      code: "non-object" as const,
      reason: `the provisioned emission binding is ${describeUnknown(parsed)}, not an object`,
    });
  }
  return canonicalRecord({
    kind: "claims" as const,
    claims: canonicalRecord({
      requestId: parsed["requestId"],
      contextDigest: parsed["contextDigest"],
      kind: parsed["kind"],
      version: parsed["version"],
      toolName: parsed["toolName"],
      schemaDigest: parsed["schemaDigest"],
    }),
  });
}

const refuseProvisioning = (
  code: EmissionProvisioningRefusalCode,
  reason: string,
): Extract<EmissionChildProvisioning, { kind: "provisioning-refused" }> =>
  canonicalRecord({ kind: "provisioning-refused" as const, code, reason });

/** Certify the extracted claims through the ONE mint — context digest first,
 *  then claim types, then registry certification. Context parsing and the mint
 *  retain their own messages; claim-type diagnostics are composed here from
 *  the untrusted values because no inner parser exists for those fields. */
function mintProvisioningClaims(claims: ProvisioningClaims): EmissionChildProvisioning {
  const contextDigest = parseContextDigest(claims.contextDigest);
  if (!contextDigest.ok) {
    return refuseProvisioning("invalid-context-digest", contextDigest.error.message);
  }
  // The mint's documented caller posture: untrusted claims arrive as strings
  // and the mint refuses every claim that does not select one of its cells —
  // the confined casts claim membership only where the mint re-checks it.
  if (typeof claims.kind !== "string") {
    return refuseProvisioning(
      "invalid-claim-type",
      `the provisioned emission binding names producer kind ${describeUnknown(claims.kind)}, not a producer kind`,
    );
  }
  if (typeof claims.requestId !== "string" || typeof claims.version !== "string") {
    return refuseProvisioning(
      "invalid-claim-type",
      `the provisioned emission binding carries requestId ${describeUnknown(claims.requestId)} and version ${describeUnknown(claims.version)}; both must be strings`,
    );
  }
  if ((claims.toolName !== undefined && typeof claims.toolName !== "string") ||
      (claims.schemaDigest !== undefined && typeof claims.schemaDigest !== "string")) {
    return refuseProvisioning(
      "invalid-claim-type",
      `the provisioned emission binding carries toolName ${describeUnknown(claims.toolName)} and schemaDigest ${describeUnknown(claims.schemaDigest)}; present optional claims must be strings`,
    );
  }
  const minted = issueEmissionBinding({
    requestId: claims.requestId,
    kind: claims.kind as PayloadProducerKindName,
    version: claims.version,
    ...(claims.toolName === undefined ? {} : { toolName: claims.toolName }),
    ...(claims.schemaDigest === undefined ? {} : { schemaDigest: claims.schemaDigest }),
  });
  if (!minted.ok) {
    return refuseProvisioning(minted.error.code, minted.error.message);
  }
  return canonicalRecord({
    kind: "provisioned" as const,
    binding: minted.value,
    contextDigest: contextDigest.value,
  });
}

export function parseEmissionChildProvisioning(raw: string | undefined): EmissionChildProvisioning {
  const parsed = parseProvisioningClaims(raw);
  if (parsed.kind === "not-provisioned") return canonicalRecord({ kind: "not-provisioned" as const });
  if (parsed.kind === "refused") {
    return refuseProvisioning(parsed.code, parsed.reason);
  }
  return mintProvisioningClaims(parsed.claims);
}

// ---------------------------------------------------------------------------
// Registration (FR-001/SC-006): idempotent only for the exact same binding
// ---------------------------------------------------------------------------

/**
 * The child's process-local emission-tool registration aggregate. The child
 * is provisioned for ONE issued request; its registration is at most one
 * tool. `unregistered` is the fresh child; `registered` carries the binding
 * the registered tool answers to. The state is data — the transition is a
 * pure decision below, applied by the shell around `registerTool`.
 */
export type EmissionToolRegistration =
  | Readonly<{ kind: "unregistered" }>
  | Readonly<{ kind: "registered"; binding: IssuedEmissionBinding }>;

/**
 * The registration decision: `register` (the fresh child takes the attempted
 * binding), `idempotent` (the exact same request/kind/version/digest is
 * already registered — re-report readiness, register nothing), or
 * `contradictory` (a DIFFERENT binding was attempted on a registered child —
 * a launcher bug; the refusal names both bindings and the shell throws).
 */
export type EmissionToolRegistrationDecision =
  | Readonly<{ kind: "register" }>
  | Readonly<{ kind: "idempotent" }>
  | Readonly<{ kind: "contradictory"; registered: IssuedEmissionBinding; attempted: IssuedEmissionBinding }>;

/** Idempotence identity: the EXACT same request/kind/version/digest. The tool
 *  name is registry-derived from kind+version and the digest is derived from
 *  the frozen bytes, so equal kind+version implies equal name and digest for
 *  every minted binding — the four compared fields are the full identity. */
const sameEmissionBinding = (left: IssuedEmissionBinding, right: IssuedEmissionBinding): boolean =>
  left.requestId === right.requestId &&
  left.kind.kind === right.kind.kind &&
  left.version === right.version &&
  left.schemaDigest === right.schemaDigest;

export function decideEmissionToolRegistration(
  state: EmissionToolRegistration,
  attempted: IssuedEmissionBinding,
): EmissionToolRegistrationDecision {
  if (state.kind === "unregistered") return canonicalRecord({ kind: "register" as const });
  if (sameEmissionBinding(state.binding, attempted)) return canonicalRecord({ kind: "idempotent" as const });
  return canonicalRecord({ kind: "contradictory" as const, registered: state.binding, attempted });
}

/** The bounded diagnostic a contradictory re-registration refuses with — both
 *  bindings named (request id, kind, version, digest), so the launcher's
 *  infrastructure observation says exactly which child held which request. */
export function describeEmissionRegistrationContradiction(
  decision: Extract<EmissionToolRegistrationDecision, { kind: "contradictory" }>,
): string {
  const describe = (binding: IssuedEmissionBinding): string =>
    `${binding.requestId} (${binding.kind.kind}/${binding.version}, digest ${binding.schemaDigest})`;
  return "contradictory emission-tool re-registration: the child is registered for " +
    `${describe(decision.registered)} and was asked to register ${describe(decision.attempted)}`;
}

// ---------------------------------------------------------------------------
// The exact tool definition (FR-001/FR-002/FR-013/FR-021/SC-006)
// ---------------------------------------------------------------------------

/**
 * The exact registered tool definition for one issued binding — a plain
 * record shaped like pi's ToolDefinition; the confined TypeBox claim happens
 * once, at the `registerTool` surface in the extension.
 *
 * - `name` is the registry's exact tool name (FR-001).
 * - `parameters` are the frozen bytes parsed ONCE — byte-identity to the
 *   frozen payload schema is by construction (FR-021/SC-006; the one
 *   serialization chain, no mirror).
 * - `prepareArguments` is the wire-form canonicalization pi's agent loop runs
 *   BEFORE `validateToolArguments`: driven entirely by the frozen schema's
 *   declared types, it parses only values a declared non-string type can
 *   accept from their JSON encoding (routes without server-side constrained
 *   decoding serialize fields as JSON strings). Validation against the SAME
 *   frozen bytes still follows and refuses every genuinely non-conforming
 *   form; the registry's admission gate re-parses the canonical form
 *   unchanged. One schema, one contract — a transport parse, not a second
 *   schema.
 * - `constrainedSampling` is the ONE shared preferred-strict request — the
 *   same object every emission tool registers with (FR-002/INV-1; never
 *   strict-required, and no second provider payload serialization — the
 *   harness's capability resolver owns the wire).
 * - `execute` admits the untrusted arguments through the registry's admission
 *   gate and either returns the minimal terminating acknowledgment or THROWS
 *   the refusal at the harness boundary (FR-013/AD-3 — a returned
 *   error-labeled object does not set pi's error flag). The transcript adapter
 *   captures a frozen shallow snapshot of the parsed arguments object's
 *   enumerable properties, not its identity or original JSON bytes; selection
 *   independently applies the same pure admission gate to that snapshot.
 */
export type EmissionToolDefinition = Readonly<{
  name: EmissionToolName;
  label: string;
  description: string;
  parameters: unknown;
  prepareArguments: (args: unknown) => unknown;
  constrainedSampling: EmissionConstrainedSamplingRequest;
  execute: (toolCallId: string, params: unknown) => Promise<EmissionToolAcknowledgment>;
}>;

export function emissionToolDefinition(binding: IssuedEmissionBinding): EmissionToolDefinition {
  const spec: EmissionToolSpec = EMISSION_TOOL_SPECS[binding.kind.kind];
  // Constructor invariant: a MINTED binding's (kind, version) pair is
  // registry-carried by construction; the guard keeps the invariant honest
  // instead of a non-null assertion (unreachable for minted bindings).
  const schemaVersion = spec.schemaVersions[binding.version];
  if (schemaVersion === undefined) {
    throw new Error(
      `emission tool definition invariant failed: binding ${binding.requestId} names ${binding.kind.kind}/${binding.version}, which the frozen registry does not carry`,
    );
  }
  const parameters = frozenPayloadSchemaParameters(schemaVersion.schemaBytes);
  return canonicalRecord({
    name: spec.toolName,
    label: `Emission ${binding.kind.kind} ${binding.version}`,
    description: `Emit the frozen ${binding.kind.kind} ${binding.version} payload. Parameters ARE the frozen schema.`,
    parameters,
    prepareArguments: (args: unknown): unknown => canonicalizeEmissionWireArguments(parameters, args),
    constrainedSampling: EMISSION_CONSTRAINED_SAMPLING_REQUEST,
    execute: async (_toolCallId: string, params: unknown): Promise<EmissionToolAcknowledgment> => {
      const outcome: EmissionExecutionOutcome = acknowledgeEmissionExecution(binding, params);
      if (outcome.kind === "refused") {
        // The shell boundary's error signal (AD-3): the admission's own code
        // and message verbatim — the model's correction surface is the
        // parse's vocabulary, never a shell-invented string.
        throw new Error(`${outcome.code}: ${outcome.message}`);
      }
      return outcome.acknowledgment;
    },
  });
}

// ---------------------------------------------------------------------------
// The readiness report (FR-008): the bound payload the launcher's gate parses
// ---------------------------------------------------------------------------

/** The child's honest observations at readiness time: its own content-
 *  addressed load revision, whether the registered tool is in the ACTUAL
 *  active set, its pid, and its full registered tool list (audit). */
export type EmissionReadinessObservation = Readonly<{
  revision: string;
  active: boolean;
  childPid: number;
  registeredTools: readonly string[];
}>;

/**
 * The bound readiness report — exactly the ten contract fields the barrier
 * parses (request id, context digest, producer kind, schema version, exact
 * tool name, schema digest, revision, active, child pid, registered tools).
 * The binding fields are the MINTED binding's (canonical, registry
 * certified); the observation fields are the child's own honest facts. The
 * child never certifies more than it observed — the GATE decides.
 */
export type EmissionReadinessReport = Readonly<{
  requestId: string;
  contextDigest: string;
  kind: string;
  version: string;
  toolName: string;
  schemaDigest: string;
  revision: string;
  active: boolean;
  childPid: number;
  registeredTools: readonly string[];
}>;

export function emissionReadinessReport(
  provisioned: Extract<EmissionChildProvisioning, { kind: "provisioned" }>,
  observation: EmissionReadinessObservation,
): EmissionReadinessReport {
  return canonicalRecord({
    requestId: provisioned.binding.requestId,
    contextDigest: provisioned.contextDigest,
    kind: provisioned.binding.kind.kind,
    version: provisioned.binding.version,
    toolName: provisioned.binding.toolName,
    schemaDigest: provisioned.binding.schemaDigest,
    revision: observation.revision,
    active: observation.active,
    childPid: observation.childPid,
    registeredTools: Object.freeze([...observation.registeredTools]),
  });
}

// ---------------------------------------------------------------------------
// Parent launcher startup gate (FR-008/AS-020): one parser and one decision
// ---------------------------------------------------------------------------

export type EmissionStartupRefusalCode =
  | "child-unreachable"
  | "readiness-command-absent"
  | "readiness-timeout"
  | "startup-unavailable"
  | "malformed-readiness"
  | "wrong-request"
  | "unexpected-kind"
  | "unexpected-version"
  | "schema-digest-mismatch"
  | "tool-name-mismatch"
  | "tool-inactive"
  | "revision-mismatch"
  | "route-bind-refused"
  | "cancelled";

export const EMISSION_STARTUP_REMEDIATIONS: Readonly<Record<EmissionStartupRefusalCode, string>> = Object.freeze({
  "child-unreachable": "verify the pi runtime and extension wiring, then respawn the child",
  "readiness-command-absent": "/reload the loom extension so the child registers the readiness command",
  "readiness-timeout": "inspect the child extension startup, then respawn the child within the bounded readiness window",
  "startup-unavailable": "correct the child provisioning or extension startup refusal, then respawn the child",
  "malformed-readiness": "/reload the extension so its readiness payload matches the bound readiness contract",
  "wrong-request": "spawn a fresh child provisioned for this request; the observed child holds another request's readiness",
  "unexpected-kind": "verify the issued producer kind against the child's spawn configuration",
  "unexpected-version": "/reload so the child carries the issued frozen schema version",
  "schema-digest-mismatch": "/reload so the child registers the issued frozen schema bytes",
  "tool-name-mismatch": "verify the child extension registers the exact issued emission tool name",
  "tool-inactive": "include the emission tool in the child spawn's --tools allowlist",
  "revision-mismatch": "/reload so the child loads the issued loom revision",
  "route-bind-refused": "verify the provider/model configuration the gate must bind before prompting",
  "cancelled": "none — startup was cancelled and the child was released without prompting",
});

export type EmissionReadinessRefusalCode = Exclude<EmissionStartupRefusalCode, "route-bind-refused">;

/** Parsed child report. Binding claims remain untrusted strings until the gate
 * compares them with the registry-minted parent expectation. */
export type ReadinessReport = Readonly<{
  requestId: RequestId;
  contextDigest: ContextDigest;
  kind: string;
  version: string;
  toolName: string;
  schemaDigest: ArtifactDigest;
  revision: string;
  active: boolean;
  childPid: number;
  registeredTools: readonly string[];
}>;

export type ReadinessPayloadRejection = Readonly<{
  kind: "malformed-readiness-payload";
  reason: string;
}>;

type FieldParseError = Readonly<{ message: string }>;

const nonEmptyString = (field: string, value: unknown): DomainResult<string, FieldParseError> =>
  typeof value === "string" && value.length > 0
    ? success(value)
    : failure(canonicalRecord({ message: `${field} must be a non-empty string, received ${describeUnknown(value)}` }));

const booleanValue = (field: string, value: unknown): DomainResult<boolean, FieldParseError> =>
  typeof value === "boolean"
    ? success(value)
    : failure(canonicalRecord({ message: `${field} must be a boolean, received ${describeUnknown(value)}` }));

const positiveInteger = (field: string, value: unknown): DomainResult<number, FieldParseError> =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? success(value)
    : failure(canonicalRecord({ message: `${field} must be a positive integer, received ${describeUnknown(value)}` }));

const stringArray = (field: string, value: unknown): DomainResult<readonly string[], FieldParseError> => {
  if (!Array.isArray(value)) {
    return failure(canonicalRecord({
      message: `${field} must be an array of tool names, received ${describeUnknown(value)}`,
    }));
  }
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      return failure(canonicalRecord({
        message: `${field} must contain only non-empty tool names, received ${describeUnknown(entry)}`,
      }));
    }
    names.push(entry);
  }
  return success(Object.freeze(names));
};

const checkedField = <T, E extends FieldParseError>(
  field: string,
  parsed: DomainResult<T, E>,
  violations: string[],
): T | undefined => {
  if (parsed.ok) return parsed.value;
  violations.push(`${field}: ${parsed.error.message}`);
  return undefined;
};

const presentReadinessField = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("readiness parse invariant failed: a field value is absent without a recorded violation");
  }
  return value;
};

/** Parse, don't validate: arbitrary command-entry data becomes one immutable
 * readiness report or one bounded rejection naming every malformed field. */
export function parseReadinessReport(raw: unknown): DomainResult<ReadinessReport, ReadinessPayloadRejection> {
  if (!isRecord(raw)) {
    return failure(canonicalRecord({
      kind: "malformed-readiness-payload" as const,
      reason: `the readiness payload is ${describeUnknown(raw)}, not an object`,
    }));
  }
  const violations: string[] = [];
  const requestId = checkedField("requestId", parseRequestId(raw["requestId"]), violations);
  const contextDigest = checkedField("contextDigest", parseContextDigest(raw["contextDigest"]), violations);
  const schemaDigest = checkedField("schemaDigest", parseArtifactDigest(raw["schemaDigest"]), violations);
  const kind = checkedField("kind", nonEmptyString("kind", raw["kind"]), violations);
  const version = checkedField("version", nonEmptyString("version", raw["version"]), violations);
  const toolName = checkedField("toolName", nonEmptyString("toolName", raw["toolName"]), violations);
  const revision = checkedField("revision", nonEmptyString("revision", raw["revision"]), violations);
  const active = checkedField("active", booleanValue("active", raw["active"]), violations);
  const childPid = checkedField("childPid", positiveInteger("childPid", raw["childPid"]), violations);
  const registeredTools = checkedField(
    "registeredTools",
    stringArray("registeredTools", raw["registeredTools"]),
    violations,
  );
  if (violations.length > 0) {
    return failure(canonicalRecord({
      kind: "malformed-readiness-payload" as const,
      reason: `the readiness payload violates its contract (${violations.join("; ")})`,
    }));
  }
  return success(canonicalRecord({
    requestId: presentReadinessField(requestId),
    contextDigest: presentReadinessField(contextDigest),
    kind: presentReadinessField(kind),
    version: presentReadinessField(version),
    toolName: presentReadinessField(toolName),
    schemaDigest: presentReadinessField(schemaDigest),
    revision: presentReadinessField(revision),
    active: presentReadinessField(active),
    childPid: presentReadinessField(childPid),
    registeredTools: presentReadinessField(registeredTools),
  }));
}

export type EmissionReadinessExpectation = Readonly<{
  binding: IssuedEmissionBinding;
  contextDigest: ContextDigest;
  revision: string;
  readinessCommand: string;
}>;

export type LauncherExpectation = EmissionReadinessExpectation & Readonly<{
  route: Readonly<{ provider: string; modelId: string; api: string; baseUrl: string }>;
}>;

export type VerifiedRoute = Readonly<{
  provider: string;
  modelId: string;
  api: string;
  baseUrl: string;
}>;

export type ReadinessObservation =
  | Readonly<{ kind: "observed"; payload: unknown }>
  | Readonly<{ kind: "absent"; reason: string }>
  | Readonly<{ kind: "startup-unavailable"; reason: string }>
  | Readonly<{ kind: "cancelled" }>;

export type RouteObservation =
  | Readonly<{ kind: "unbound" }>
  | Readonly<{
      kind: "bound";
      model: Readonly<{ provider: string; id: string; api: string; baseUrl: string }>;
    }>
  | Readonly<{ kind: "failed"; reason: string }>;

export type ReadinessProbeFacts = Readonly<{
  channelAlive: boolean;
  channelDiagnostic: string | null;
  commandListed: boolean;
  readiness: ReadinessObservation;
}>;

/** One canonical readiness-stage state. Raw RPC facts can contradict while a
 * child is failing (for example cancellation after channel loss); this closed
 * union applies the protocol's precedence once so downstream policy cannot
 * accidentally choose a different interpretation. */
export type ReadinessStageObservation =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "unreachable"; diagnostic: string | null }>
  | Readonly<{ kind: "command-absent" }>
  | Readonly<{ kind: "startup-unavailable"; reason: string }>
  | Readonly<{ kind: "timeout"; reason: string }>
  | Readonly<{ kind: "observed"; payload: unknown }>;

/** Parse raw probe facts into the readiness vocabulary. Precedence is part of
 * construction: cancellation > unreachable > command absence > the command's
 * own outcome. No contradictory boolean combination crosses this seam. */
export function parseReadinessStageObservation(facts: ReadinessProbeFacts): ReadinessStageObservation {
  if (facts.readiness.kind === "cancelled") {
    return canonicalRecord({ kind: "cancelled" as const });
  }
  if (!facts.channelAlive) {
    return canonicalRecord({ kind: "unreachable" as const, diagnostic: facts.channelDiagnostic });
  }
  if (!facts.commandListed) {
    return canonicalRecord({ kind: "command-absent" as const });
  }
  if (facts.readiness.kind === "startup-unavailable") {
    return canonicalRecord({ kind: "startup-unavailable" as const, reason: facts.readiness.reason });
  }
  if (facts.readiness.kind === "absent") {
    return canonicalRecord({ kind: "timeout" as const, reason: facts.readiness.reason });
  }
  return canonicalRecord({ kind: "observed" as const, payload: facts.readiness.payload });
}

/** Route evidence exists only after readiness was observed. Refused readiness
 * states cannot accidentally carry a stale or sibling route observation. */
export type StartupGateObservation =
  | Exclude<ReadinessStageObservation, Readonly<{ kind: "observed" }>>
  | Readonly<{ kind: "observed"; payload: unknown; route: RouteObservation }>;

export function startupGateObservation(
  stage: ReadinessStageObservation,
  route: RouteObservation,
): StartupGateObservation {
  return stage.kind === "observed"
    ? canonicalRecord({ kind: "observed" as const, payload: stage.payload, route })
    : stage;
}

export type EmissionStartupRefusal<C extends EmissionStartupRefusalCode> = Readonly<{
  kind: "refused";
  code: C;
  message: string;
  remediation: string;
}>;

export type EmissionStartupDecision =
  | Readonly<{ kind: "open"; readiness: ReadinessReport; route: VerifiedRoute }>
  | EmissionStartupRefusal<EmissionStartupRefusalCode>;

export type EmissionReadinessGateDecision =
  | Readonly<{ kind: "ready"; readiness: ReadinessReport }>
  | EmissionStartupRefusal<EmissionReadinessRefusalCode>;

const refuseStartup = <C extends EmissionStartupRefusalCode>(
  code: C,
  detail: string,
): EmissionStartupRefusal<C> => canonicalRecord({
  kind: "refused" as const,
  code,
  message: boundDiagnosticMessage(`${detail} Remediation: ${EMISSION_STARTUP_REMEDIATIONS[code]}`),
  remediation: EMISSION_STARTUP_REMEDIATIONS[code],
});

/** The one readiness decision shared by the executable launcher directive and
 * acceptance tests. It compares every issued binding field before route bind. */
export function decideReadinessGate(
  expectation: EmissionReadinessExpectation,
  observation: ReadinessStageObservation,
): EmissionReadinessGateDecision {
  if (observation.kind === "cancelled") {
    return refuseStartup("cancelled", "startup was cancelled before the readiness observation completed");
  }
  if (observation.kind === "unreachable") {
    return refuseStartup(
      "child-unreachable",
      `the pi child never became addressable${observation.diagnostic === null ? "" : `: ${observation.diagnostic}`}`,
    );
  }
  if (observation.kind === "command-absent") {
    return refuseStartup(
      "readiness-command-absent",
      `the expected readiness command /${expectation.readinessCommand} is not registered in the child (the launcher never invokes an unverified command)`,
    );
  }
  if (observation.kind === "startup-unavailable") {
    return refuseStartup("startup-unavailable", `the child explicitly refused startup before readiness: ${observation.reason}`);
  }
  if (observation.kind === "timeout") {
    return refuseStartup("readiness-timeout", `no readiness observation arrived within the bounded window (${observation.reason})`);
  }
  const parsed = parseReadinessReport(observation.payload);
  if (!parsed.ok) return refuseStartup("malformed-readiness", parsed.error.reason);
  const report = parsed.value;
  if (report.requestId !== expectation.binding.requestId || report.contextDigest !== expectation.contextDigest) {
    const mismatched: string[] = [];
    if (report.requestId !== expectation.binding.requestId) {
      mismatched.push(`request id ${report.requestId} ≠ issued ${expectation.binding.requestId}`);
    }
    if (report.contextDigest !== expectation.contextDigest) {
      mismatched.push(`context digest ${report.contextDigest} ≠ issued ${expectation.contextDigest}`);
    }
    return refuseStartup("wrong-request", `the child's readiness is bound to another request (${mismatched.join("; ")})`);
  }
  if (report.kind !== expectation.binding.kind.kind) {
    return refuseStartup(
      "unexpected-kind",
      `the child activated producer kind ${report.kind}, not the issued ${expectation.binding.kind.kind}`,
    );
  }
  if (report.version !== expectation.binding.version) {
    return refuseStartup(
      "unexpected-version",
      `the child carries schema version ${report.version}, not the issued ${expectation.binding.version}`,
    );
  }
  if (report.schemaDigest !== expectation.binding.schemaDigest) {
    return refuseStartup(
      "schema-digest-mismatch",
      `the child's registered schema digest ${report.schemaDigest} does not certify the issued frozen schema (${expectation.binding.schemaDigest})`,
    );
  }
  if (report.toolName !== expectation.binding.toolName) {
    return refuseStartup(
      "tool-name-mismatch",
      `the child registered tool ${report.toolName}, not the issued ${expectation.binding.toolName}`,
    );
  }
  if (!report.active) {
    return refuseStartup(
      "tool-inactive",
      `the emission tool ${report.toolName} is registered but inactive in the child's actual active set`,
    );
  }
  if (report.revision !== expectation.revision) {
    return refuseStartup(
      "revision-mismatch",
      `the child reports revision ${report.revision}, not the issued ${expectation.revision}`,
    );
  }
  return canonicalRecord({ kind: "ready" as const, readiness: report });
}

/** Complete startup decision used by acceptance runners that also observe the
 * route API/base URL. The installed port independently enforces provider/model
 * sequencing around the same readiness decision. */
export function decideEmissionStartup(
  expectation: LauncherExpectation,
  observation: StartupGateObservation,
): EmissionStartupDecision {
  const stage = decideReadinessGate(expectation, observation);
  if (stage.kind === "refused") return stage;
  if (observation.kind !== "observed") {
    return refuseStartup("startup-unavailable", "the readiness decision opened without an observed readiness payload");
  }
  if (observation.route.kind === "unbound") {
    return refuseStartup("route-bind-refused", "the gate never bound the constrained route before any prompt delivery");
  }
  if (observation.route.kind === "failed") {
    return refuseStartup("route-bind-refused", `the constrained route binding failed: ${observation.route.reason}`);
  }
  const model = observation.route.model;
  if (model.provider !== expectation.route.provider ||
      model.id !== expectation.route.modelId ||
      model.api !== expectation.route.api ||
      model.baseUrl !== expectation.route.baseUrl) {
    return refuseStartup(
      "route-bind-refused",
      `the bound route (${model.provider}/${model.id} via ${model.api} at ${model.baseUrl}) is not the expected constrained route (${expectation.route.provider}/${expectation.route.modelId})`,
    );
  }
  return canonicalRecord({
    kind: "open" as const,
    readiness: stage.readiness,
    route: canonicalRecord({
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      baseUrl: model.baseUrl,
    }),
  });
}

export type StartupGateAction =
  | Readonly<{ kind: "deliver-prompt"; route: VerifiedRoute }>
  | Readonly<{ kind: "release-without-prompt" }>;

export const startupGateAction = (decision: EmissionStartupDecision): StartupGateAction =>
  decision.kind === "open"
    ? canonicalRecord({ kind: "deliver-prompt" as const, route: decision.route })
    : canonicalRecord({ kind: "release-without-prompt" as const });

export const describeStartupDecision = (decision: EmissionStartupDecision): string =>
  decision.kind === "open"
    ? `open on ${decision.readiness.toolName} (${decision.readiness.version}) via ${decision.route.provider}/${decision.route.modelId}`
    : `refused: ${decision.code}`;
