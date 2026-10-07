/**
 * The Pi-side emission tool surface of an emission-enabled CHILD — the PURE
 * half of its registration/readiness surface (T5; FR-001/FR-008/FR-013/
 * FR-014/FR-021/SC-006). The imperative half is the readiness command + hold
 * wiring in `pi/emission-readiness.ts`; this module owns every decision that
 * wiring acts on, so the acceptance suite drives the same policy seam
 * production registers with — never a test twin. The PARENT launcher's gate
 * over the readiness report this child mints lives in
 * `pi/emission-readiness-gate.ts`; the protocol the two share (command, entry
 * type, report shape) is owned by `pi/emission-readiness-protocol.ts`.
 *
 * Dependency direction: pi → engine, never outward, and NO pi-package import
 * (the tool definition is a plain record; the confined TypeBox claim happens
 * ONCE, at the `registerTool` surface in the extension). No environment is
 * read at import time — the provisioning parser takes the raw env value as a
 * parameter, so unit tests can import this module without pinning `~/.pi`.
 *
 * The four decisions minted here:
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
 * 3. HOLD (AD-4 defense in depth): the in-child `before_agent_start` hold is
 *    armed for every provisioned child and released only by a readiness
 *    report whose tool is in the ACTUAL active set, or by session shutdown.
 *    The transition is a pure decision over the hold state; the shell owns
 *    only the pending promise the release resolves.
 *
 * 4. EXECUTION (FR-013): the execute shell observes the validated arguments
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
  acknowledgeEmissionExecution,
  canonicalizeEmissionWireArguments,
  EMISSION_CONSTRAINED_SAMPLING_REQUEST,
  issuedEmissionParameters,
  issueEmissionBinding,
  type EmissionBindingRefusalCode,
  type EmissionConstrainedSamplingRequest,
  type EmissionExecutionOutcome,
  type EmissionToolAcknowledgment,
  type EmissionToolName,
  type IssuedEmissionBinding,
} from "../engine/src/core/emission-tool";
import { isRecord } from "../engine/src/core/plain-record";
import {
  boundDiagnosticMessage,
  canonicalRecord,
  describeUnknown,
  parseContextDigest,
  type ContextDigest,
} from "../engine/src/core/orchestration-contract/identity";
import type { EmissionReadinessReport } from "./emission-readiness-protocol";

// ---------------------------------------------------------------------------
// The child's own observable hold vocabulary (AD-4). The launcher↔child
// readiness protocol itself — command, entry type, report shape — is owned by
// `pi/emission-readiness-protocol.ts`, which both sides import.
// ---------------------------------------------------------------------------

/** The custom-entry type bracketing the in-child `before_agent_start` hold —
 *  the defense-in-depth layer's observable gating (AD-4). Entries make the
 *  hold's phase ordering observable on the RPC stream; they are never LLM
 *  context. */
export const EMISSION_HOLD_ENTRY_TYPE = "loom-emission-hold";

/** The closed phase vocabulary the hold's `EMISSION_HOLD_ENTRY_TYPE` entries
 *  carry onto the RPC stream — forensic observability of the child's hold,
 *  which the launcher gate never parses:
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
  // and the mint itself parses them into the registry vocabulary, refusing
  // every claim that does not select one of its cells — nothing is cast here.
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
    kind: claims.kind,
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
// The in-child readiness hold (AD-4): fail-closed transitions as data
// ---------------------------------------------------------------------------

/**
 * The child's `before_agent_start` hold. `unprovisioned` is the ordinary
 * non-emission child (no hold at all); every provisioned child — including a
 * provisioning-refused one — starts `armed`, so no model request can run on
 * an uncertified binding; `released` admits prompts. The pending promise an
 * armed hold wedges on is the shell's; this is the state it answers to.
 */
export type EmissionHoldState =
  | Readonly<{ kind: "unprovisioned" }>
  | Readonly<{ kind: "armed" }>
  | Readonly<{ kind: "released" }>;

/** What can move the hold: a readiness report (with whether the registered
 *  tool is in the child's ACTUAL active set), or session shutdown. */
export type EmissionHoldEvent =
  | Readonly<{ kind: "readiness-reported"; active: boolean }>
  | Readonly<{ kind: "session-shutdown" }>;

/** The next hold, whether the shell must resolve the wedged promise, and the
 *  hold-phase entry to append once it did (`null`: none). */
export type EmissionHoldTransition = Readonly<{
  next: EmissionHoldState;
  release: boolean;
  diagnostic: Extract<EmissionHoldPhase, "shutdown-released"> | null;
}>;

export const initialEmissionHold = (provisioning: EmissionChildProvisioning): EmissionHoldState =>
  canonicalRecord({ kind: provisioning.kind === "not-provisioned" ? "unprovisioned" as const : "armed" as const });

const holdUnchanged = (state: EmissionHoldState): EmissionHoldTransition =>
  canonicalRecord({ next: state, release: false, diagnostic: null });

/**
 * The fail-closed hold law. Only an ARMED hold moves, and only to `released`:
 * a readiness report releases it when — and only when — the registered tool
 * is in the actual active set (an honestly-inactive tool is reported, the
 * launcher gate refuses, and its prompts stay wedged); session shutdown
 * releases it so the wedged handler cannot outlive its session, with the
 * `shutdown-released` forensic marker. Releasing at shutdown admits no model
 * request, because the session is ending. Every other combination is inert.
 */
export function decideEmissionHoldTransition(
  state: EmissionHoldState,
  event: EmissionHoldEvent,
): EmissionHoldTransition {
  if (state.kind !== "armed") return holdUnchanged(state);
  if (event.kind === "readiness-reported") {
    return event.active
      ? canonicalRecord({ next: canonicalRecord({ kind: "released" as const }), release: true, diagnostic: null })
      : holdUnchanged(state);
  }
  return canonicalRecord({
    next: canonicalRecord({ kind: "released" as const }),
    release: true,
    diagnostic: "shutdown-released" as const,
  });
}

/** Whether a prompt arriving now must wedge on the hold (`entered` …
 *  `resolved`) rather than proceed. */
export const emissionHoldWedgesPrompt = (state: EmissionHoldState): boolean => state.kind === "armed";

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
  // A MINTED binding's (kind, version) pair is registry-carried by
  // construction, and its tool name is the registry cell's own; the kernel's
  // one binding→cell lookup guards that invariant.
  const parameters = issuedEmissionParameters(binding);
  return canonicalRecord({
    name: binding.toolName,
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
 * Mint the bound readiness report (`EmissionReadinessReport`, the protocol's
 * one wire shape). The binding fields are the MINTED binding's (canonical,
 * registry certified); the observation fields are the child's own honest
 * facts. The child never certifies more than it observed — the GATE decides.
 */
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
