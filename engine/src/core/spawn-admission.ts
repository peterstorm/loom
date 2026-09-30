/**
 * Spawn Admission (see CONTEXT.md): the pure decision that accepts or blocks
 * one Pi subagent spawn batch before any state mutation.
 *
 * Functional core. Every gate that can be decided from values is decided
 * here — batch classification, size, interactive-transport routing, Agent
 * scope, spawn-model policy, and the Skill-prompt check. The reads the decision
 * needs (rendered-definition identity, source agent bytes, phase-order state,
 * template/file probes) enter through `SpawnAdmissionPorts`, so the sequence
 * is deterministic given its ports and testable with in-memory fakes. The Pi
 * extension is the shell: it gathers nothing up front, implements the ports
 * over the real filesystem/state, and applies the returned decision.
 *
 * The guard that decided is DATA on the block result — not ambient mutable
 * state — so a refusal always names its gate.
 *
 * The module also owns the issued emission capability contract (AD-6/AD-7,
 * FR-001/FR-008/FR-012/FR-020): the engine-issued descriptor line that binds
 * one spawn request to one frozen-registry emission tool, the parent-side
 * expected-capability decision over it (catalog × registry × independently
 * reserved Run Directory request, checked against task identity), and the
 * issuance-side route decision that turns an issued
 * producer contract plus the child surface's capability declaration into
 * emission, extraction-only, or a hard refusal. The request programs render
 * the projection through these pure pieces. The Pi launcher barrier is the
 * allocated consumer of the batch admission's per-item results; this module
 * only decides and carries those expectations.
 */

import type { HookResult } from "../types";
import { checkAgentSkillPrompt } from "./agent-skills";
import {
  agentRequiresInteractiveTransport,
  classifyPiSpawnItems,
  expectedSpawnModel,
  producerKindsOfAgent,
  type LoomAgentName,
  type PayloadProducerKindName,
  type PiSpawnItem,
} from "./model-profiles";
import { classifyTaskExecutionSpawn, type TaskExecutionSpawn } from "./validate-task-execution";
import {
  EMISSION_TOOL_SPECS,
  issueEmissionBinding,
  notProvidedEmissionCapability,
  providedEmissionCapability,
  type EmissionBindingRefusalCode,
  type EmissionSchemaVersion,
  type EmissionToolCapability,
  type EmissionToolSpec,
  type IssuedEmissionBinding,
} from "./emission-tool";
import {
  boundedThrownCause,
  canonicalRecord,
  parseArtifactDigest,
  parseContextDigest,
  parseRequestId,
  type ArtifactDigest,
  type ContextDigest,
  type DomainResult,
  type RequestId,
} from "./orchestration-contract/identity";
import { sha256Hex } from "./review-packet";

/** Pi's transport cap per native subagent call; larger engine batches are
 *  chunked by the parent. Single source — the extension imports it. */
export const MAX_PI_ORCHESTRATION_BATCH_SIZE = 8;

export type PiSpawnTransport = "headless" | "interactive-rpc";

export type SpawnGuardName =
  | "parse-pi-subagent-batch"
  | "external-agents"
  | "batch-size"
  | "interactive-transport"
  | "agent-scope"
  | "definition-identity"
  | "validate-agent-skill"
  | "validate-phase-order"
  | "validate-template-substitution"
  | "expected-emission-capability";

export type SpawnAdmissionPorts = Readonly<{
  /** Is a Loom task graph active for this session? */
  graphActive: boolean;
  /** Which parent-owned transport will execute this exact batch. */
  transport: PiSpawnTransport;
  /** Absolute Loom package root, used verbatim in remediation messages. */
  packageRoot: string;
  /** Prove the rendered Pi definition is the one this package generated. */
  validateDefinition: (
    agent: LoomAgentName,
  ) => Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }>;
  /** Read the source agent definition; a failure carries the full message. */
  readSourceAgent: (
    agent: LoomAgentName,
  ) => Readonly<{ ok: true; content: string }> | Readonly<{ ok: false; error: string }>;
  checkPhaseOrder: (agent: LoomAgentName, task: string) => HookResult;
  checkTemplateSubstitution: (task: string) => HookResult;
  /** Read the reserved request from this parent session's registered Run
   *  Directory. Never derive this answer from task text: the descriptor and
   *  markers are untrusted projections of this independently issued record. */
  readIssuedRequest: (
    requestId: RequestId,
    contextDigest: ContextDigest,
    agent: LoomAgentName,
  ) => DomainResult<IssuedSpawnEmissionAuthority, Readonly<{ message: string }>>;
}>;

type SpawnAdmissionBlock = Readonly<{ kind: "block"; guard: SpawnGuardName; reason: string }>;

export type AdmittedSpawnItem = Readonly<{
  item: PiSpawnItem;
  taskExecutionSpawn: TaskExecutionSpawn;
  emissionExpectation: SpawnEmissionExpectation;
}>;

export type SpawnAdmission =
  | Readonly<{ kind: "pass-through" }>
  | Readonly<{
      kind: "admit";
      /** The structural per-item admission result consumed by launchers:
       *  classification and expected capability cannot be reordered away from
       *  the item they govern. */
      itemAdmissions: readonly AdmittedSpawnItem[];
      needsTaskGraphLifecycle: boolean;
    }>
  | SpawnAdmissionBlock;

const block = (guard: SpawnGuardName, reason: string): SpawnAdmissionBlock =>
  Object.freeze({ kind: "block", guard, reason });

function transportAdmission(
  items: readonly PiSpawnItem[],
  transport: PiSpawnTransport,
): SpawnAdmission | null {
  const interactiveItems = items.filter((item) => agentRequiresInteractiveTransport(item.agent));
  if (transport === "headless" && interactiveItems.length > 0) {
    return block(
      "interactive-transport",
      `BLOCKED: ${interactiveItems.map(({ agent }) => agent).join(", ")} requires live user questions. ` +
        "Use Loom's loom_interactive_subagent Pi tool so the same child Agent can question the parent TUI over RPC.",
    );
  }
  return transport === "interactive-rpc" && (items.length !== 1 || interactiveItems.length !== items.length)
    ? block(
        "interactive-transport",
        "loom_interactive_subagent accepts exactly one interactive Loom phase Agent; use the normal subagent tool for every headless role.",
      )
    : null;
}

/** One item's gate outcome: a whole-batch block, or the item's expected
 *  emission capability. Every existing gate composes before the emission gate,
 *  so a descriptor never bypasses the skill, phase, template, or definition
 *  gates. */
type ItemGateOutcome =
  | Readonly<{ kind: "block"; block: SpawnAdmissionBlock }>
  | Readonly<{ kind: "item"; expectation: SpawnEmissionExpectation }>;

const itemBlocked = (guard: SpawnGuardName, reason: string): ItemGateOutcome =>
  canonicalRecord({ kind: "block" as const, block: block(guard, reason) });

function itemAdmission(item: PiSpawnItem, ports: SpawnAdmissionPorts): ItemGateOutcome {
  const expected = expectedSpawnModel(item.agent, "pi");
  if (!expected.ok) return itemBlocked("definition-identity", expected.error.message);

  const definition = ports.validateDefinition(item.agent);
  if (!definition.ok) {
    return itemBlocked(
      "definition-identity",
      `Pi agent '${item.agent}' must be rendered from active Loom package ${ports.packageRoot}: ${definition.error}. ` +
        `Run "${ports.packageRoot}/scripts/sync-pi-agents.sh" and /reload.`,
    );
  }
  const source = ports.readSourceAgent(item.agent);
  if (!source.ok) return itemBlocked("validate-agent-skill", source.error);
  const skillCheck = checkAgentSkillPrompt(source.content, item.task);
  if (!skillCheck.ok) return itemBlocked("validate-agent-skill", `Pi agent '${item.agent}' skill policy failed: ${skillCheck.error}`);
  const phaseResult = ports.checkPhaseOrder(item.agent, item.task);
  if (phaseResult.kind === "block") return itemBlocked("validate-phase-order", phaseResult.message);
  const templateResult = ports.checkTemplateSubstitution(item.task);
  if (templateResult.kind === "block") return itemBlocked("validate-template-substitution", templateResult.message);
  const emission = expectedSpawnEmissionCapability(item, ports.readIssuedRequest);
  return emission.ok
    ? canonicalRecord({ kind: "item" as const, expectation: emission.expectation })
    : itemBlocked("expected-emission-capability", emission.reason);
}

/** The external-batch arm of `admitPiSpawnBatch`. Interactive transport
 *  accepts exactly one interactive Loom phase Agent; Loom owns only its
 *  catalog outside orchestration, so during an active graph an unknown agent
 *  would bypass the phase/task/model gates and external agents block, while
 *  without an active graph they belong to another Pi workflow and pass
 *  through. */
function externalBatchAdmission(ports: SpawnAdmissionPorts): SpawnAdmission {
  if (ports.transport === "interactive-rpc") {
    return block(
      "interactive-transport",
      "loom_interactive_subagent accepts exactly one interactive Loom phase Agent; external Agents must use the normal subagent tool.",
    );
  }
  return ports.graphActive
    ? block("external-agents", "External Pi subagents cannot run while a Loom task graph is active")
    : Object.freeze({ kind: "pass-through" });
}

/**
 * Decide one spawn batch. The gate sequence and every reason string are the
 * exact ones the Pi extension enforced inline; a malformed sibling blocks the
 * whole batch, so one parallel item cannot bypass gates the top-level fields
 * never represented.
 */
export function admitPiSpawnBatch(rawInput: unknown, ports: SpawnAdmissionPorts): SpawnAdmission {
  const classified = classifyPiSpawnItems(rawInput);
  if (!classified.ok) return block("parse-pi-subagent-batch", classified.error.message);
  if (classified.value.kind === "external") return externalBatchAdmission(ports);

  const items = classified.value.items;
  if (items.length > MAX_PI_ORCHESTRATION_BATCH_SIZE) {
    return block(
      "batch-size",
      `Pi transport accepts at most ${MAX_PI_ORCHESTRATION_BATCH_SIZE} requests per subagent call; partition the engine-issued spawn-batch into ordered chunks without changing, dropping, or duplicating requests.`,
    );
  }

  const transport = transportAdmission(items, ports.transport);
  if (transport !== null) return transport;

  const requestedScope = (rawInput as { agentScope?: unknown }).agentScope ?? "user";
  if (requestedScope !== "user") {
    return block(
      "agent-scope",
      `Loom-owned Pi agents require agentScope='user' so the validated generated definition is exactly the definition Pi executes; got ${JSON.stringify(requestedScope)}.`,
    );
  }

  const itemAdmissions: AdmittedSpawnItem[] = [];
  for (const item of items) {
    const gate = itemAdmission(item, ports);
    if (gate.kind === "block") return gate.block;
    itemAdmissions.push(canonicalRecord({
      item,
      taskExecutionSpawn: classifyTaskExecutionSpawn({ agentType: item.agent, prompt: item.task, description: "" }),
      emissionExpectation: gate.expectation,
    }));
  }

  const admittedItems = Object.freeze(itemAdmissions);
  return Object.freeze({
    kind: "admit",
    itemAdmissions: admittedItems,
    needsTaskGraphLifecycle: admittedItems.some(({ taskExecutionSpawn }) => taskExecutionSpawn.kind !== "standalone"),
  });
}

// ---------------------------------------------------------------------------
// Issued emission capability (AD-6/AD-7, FR-001/FR-008/FR-012/FR-020)
// ---------------------------------------------------------------------------

/**
 * The single task-text marker of the engine-issued emission descriptor: one
 * line binding a spawn request to ONE frozen-registry emission tool — the
 * request programs' projection of authenticated request authority (AD-7), not
 * a standalone permission claim. Grammar:
 *
 *   LOOM_EMISSION_DESCRIPTOR: <toolName> <kind> <version> <requestId> <contextDigest> <schemaDigest>
 *
 * The field order is frozen and every value is whitespace-free, so the parse
 * below is total over arbitrary task text. `issueEmissionBinding` certifies
 * the tool name, producer kind, version, request ID and schema digest against
 * the frozen registry; `parseContextDigest` separately parses the context
 * field. Neither parse makes task text independent issuance authority.
 */
export const EMISSION_DESCRIPTOR_MARKER = "LOOM_EMISSION_DESCRIPTOR";

/** The exact field count of the descriptor grammar. */
const EMISSION_DESCRIPTOR_FIELDS = 6;

/**
 * The descriptor parse over one spawn task's text. `absent` is the ordinary
 * arm (no emission tool advertised — non-producer or explicitly extraction-only
 * requests, AS-010); `issued` carries the registry-certified binding plus the
 * canonical context digest; `malformed` refuses with a typed defect and its
 * human rendering. Absence is ordinary at this parse layer because task text
 * alone cannot establish a missing expected capability. The subsequent parent
 * admission decision joins this parse with independently issued authority and
 * blocks descriptor loss; the allocated AD-4 launcher barrier consumes the
 * admitted expectation later to prove child readiness.
 */
export type EmissionDescriptorRefusalCode =
  | "descriptor-cardinality"
  | "descriptor-fields"
  | "invalid-context-digest"
  | EmissionBindingRefusalCode;

export type EmissionDescriptorParse =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "malformed"; code: EmissionDescriptorRefusalCode; reason: string }>
  | Readonly<{ kind: "issued"; binding: IssuedEmissionBinding; contextDigest: ContextDigest }>;

/**
 * The ONE render of the descriptor line (the request programs' projection).
 * Deterministic in the binding and context digest, so a re-rendered retry or
 * recovered spawn task carries the byte-identical descriptor.
 */
export function renderEmissionDescriptor(binding: IssuedEmissionBinding, contextDigest: ContextDigest): string {
  return `${EMISSION_DESCRIPTOR_MARKER}: ${binding.toolName} ${binding.kind.kind} ${binding.version} ` +
    `${binding.requestId} ${contextDigest} ${binding.schemaDigest}\n`;
}

/**
 * Parse the descriptor out of one task text. Zero matching lines is `absent`;
 * more than one is malformed (a task must not claim two emission identities);
 * the single line's tool name, kind, version, request ID, and schema digest
 * are registry-minted by `issueEmissionBinding`, never trusted; its context
 * digest is independently parsed by `parseContextDigest` against the canonical
 * digest grammar.
 */
export function parseEmissionDescriptor(task: string): EmissionDescriptorParse {
  const prefix = `${EMISSION_DESCRIPTOR_MARKER}: `;
  const lines = task.split("\n").filter((line) => line.startsWith(prefix));
  if (lines.length === 0) return canonicalRecord({ kind: "absent" as const });
  if (lines.length > 1) {
    return canonicalRecord({
      kind: "malformed" as const,
      code: "descriptor-cardinality" as const,
      reason: `the task text carries ${lines.length} ${EMISSION_DESCRIPTOR_MARKER} lines; exactly one descriptor is representable`,
    });
  }
  const fields = lines[0]!.slice(prefix.length).split(" ");
  if (fields.length !== EMISSION_DESCRIPTOR_FIELDS || fields.some((field) => field.length === 0)) {
    return canonicalRecord({
      kind: "malformed" as const,
      code: "descriptor-fields" as const,
      reason: `the emission descriptor must carry exactly ${EMISSION_DESCRIPTOR_FIELDS} whitespace-free fields ` +
        `(toolName kind version requestId contextDigest schemaDigest); received ${fields.length}`,
    });
  }
  // `issueEmissionBinding` registry-mints the tool, kind, version, request, and
  // schema fields; the kind/version casts are only vocabulary hints that mint
  // re-checks. `contextDigest` stays outside that mint and is independently
  // parsed below with `parseContextDigest`.
  const [toolName, kind, version, requestId, contextDigest, schemaDigest] = fields;
  const minted = issueEmissionBinding({
    requestId: requestId!,
    kind: kind as PayloadProducerKindName,
    version: version as EmissionSchemaVersion,
    toolName,
    schemaDigest,
  });
  if (!minted.ok) {
    return canonicalRecord({
      kind: "malformed" as const,
      code: minted.error.code,
      reason: `the emission descriptor does not select a frozen registry cell: ${minted.error.code} — ${minted.error.message}`,
    });
  }
  const digest = parseContextDigest(contextDigest);
  if (!digest.ok) {
    return canonicalRecord({
      kind: "malformed" as const,
      code: "invalid-context-digest" as const,
      reason: `the emission descriptor carries no canonical context digest: ${digest.error.message}`,
    });
  }
  return canonicalRecord({ kind: "issued" as const, binding: minted.value, contextDigest: digest.value });
}

/**
 * One exact task marker line (`MARKER: value`, whitespace-free value), as the
 * expected-capability decision reads the request identity its task carries.
 * Repeated identical lines stay bound (harmless re-render). Absence and
 * contradiction are distinct arms; any value outside the marker grammar,
 * including a whitespace-bearing value, is classified as contradictory so a
 * descriptor can never bind to an identity the task does not carry.
 */
type TaskMarker =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "bound"; value: string }>
  | Readonly<{ kind: "contradictory" }>;

function taskMarker(task: string, marker: string): TaskMarker {
  const markerPrefix = `${marker}:`;
  const valuePrefix = `${markerPrefix} `;
  const lines = task.split("\n").filter((line) => line.startsWith(markerPrefix));
  const values = lines
    .map((line) => line.startsWith(valuePrefix) ? line.slice(valuePrefix.length) : "")
    .filter((value) => value.length > 0 && !/\s/.test(value));
  if (values.length < lines.length) return canonicalRecord({ kind: "contradictory" as const });
  const distinct = new Set(values);
  if (distinct.size === 0) return canonicalRecord({ kind: "absent" as const });
  return distinct.size === 1
    ? canonicalRecord({ kind: "bound" as const, value: values[0]! })
    : canonicalRecord({ kind: "contradictory" as const });
}

const markerReason = (state: TaskMarker): string =>
  state.kind === "bound" ? `names ${state.value}`
  : state.kind === "absent" ? "is absent"
  : "is contradictory";

/** Parsed task identity used only to locate independent issuance authority.
 * A descriptor never contributes either field. */
type TaskIssuedIdentity =
  | Readonly<{ kind: "unbound" }>
  | Readonly<{ kind: "malformed"; reason: string }>
  | Readonly<{ kind: "bound"; requestId: RequestId; contextDigest: ContextDigest }>;

function parseTaskIssuedIdentity(task: string): TaskIssuedIdentity {
  const requestMarker = taskMarker(task, "LOOM_REQUEST_ID");
  const digestMarker = taskMarker(task, "LOOM_CONTEXT_DIGEST");
  if (requestMarker.kind === "absent" && digestMarker.kind === "absent") {
    return canonicalRecord({ kind: "unbound" as const });
  }
  if (requestMarker.kind !== "bound" || digestMarker.kind !== "bound") {
    return canonicalRecord({
      kind: "malformed" as const,
      reason: `task issuance identity is incomplete or contradictory: LOOM_REQUEST_ID marker ${markerReason(requestMarker)}; ` +
        `LOOM_CONTEXT_DIGEST marker ${markerReason(digestMarker)}`,
    });
  }
  const requestId = parseRequestId(requestMarker.value);
  if (!requestId.ok) {
    return canonicalRecord({
      kind: "malformed" as const,
      reason: `task LOOM_REQUEST_ID marker is not canonical: ${requestId.error.message}`,
    });
  }
  const contextDigest = parseContextDigest(digestMarker.value);
  if (!contextDigest.ok) {
    return canonicalRecord({
      kind: "malformed" as const,
      reason: `task LOOM_CONTEXT_DIGEST marker is not canonical: ${contextDigest.error.message}`,
    });
  }
  return canonicalRecord({ kind: "bound" as const, requestId: requestId.value, contextDigest: contextDigest.value });
}

/**
 * The parent's expected emission capability for ONE spawn item — the pure
 * expected-capability decision (AD-4's parent half). Ordinary tasks carrying
 * neither issuance marker nor descriptor retain the no-tool baseline. Once a
 * task carries issuance identity, however, the independently read request
 * authority decides whether emission is required; the descriptor is only an
 * untrusted projection that must exactly match that decision:
 *
 * - an issued, catalog-eligible claim selecting a frozen registry cell MUST
 *   carry its exact descriptor or admission blocks;
 * - an issued non-producer or extraction-only claim MUST carry no descriptor;
 * - malformed/partial identity or unavailable authority blocks rather than
 *   silently degrading a request-bound task;
 * - matching prompt markers and descriptor can never mint capability without
 *   the independently issued record (FR-001).
 */
/** The exact route whose provider serializer accepted every frozen emission
 * schema during qualification. It is deliberately module-local policy data:
 * neither callers nor ambient parent state can choose an enabled child route. */
const QUALIFIED_EMISSION_ROUTE: Readonly<{ provider: string; model: string }> = Object.freeze({
  provider: "desktop-vllm",
  model: "glm-5.3-flash-spark-tp2-v14",
});

export type SpawnEmissionExpectation =
  | Readonly<{ kind: "no-emission-tool" }>
  | Readonly<{
      kind: "emission-enabled";
      binding: IssuedEmissionBinding;
      contextDigest: ContextDigest;
      route: Readonly<{ provider: string; model: string }>;
    }>;

export type SpawnEmissionAdmission =
  | Readonly<{ ok: true; expectation: SpawnEmissionExpectation }>
  | Readonly<{ ok: false; reason: string }>;

/** Derived from a reserved Run Directory request and its registered program,
 *  never from the prompt's descriptor or identity markers. */
export type IssuedSpawnEmissionRoute =
  | Readonly<{
      kind: "emission-enabled";
      binding: IssuedEmissionBinding;
      contextDigest: ContextDigest;
    }>
  | Readonly<{ kind: "extraction-only"; reason: string }>;

export type IssuedSpawnEmissionRouteDecision =
  | IssuedSpawnEmissionRoute
  | Readonly<{ kind: "refused"; reason: string }>;

export type IssuedSpawnEmissionAuthority = Readonly<{
  role: LoomAgentName;
  claim: IssuedProducerClaim;
  /** Independently qualified from the frozen request route. Required so a
   *  request-bound authority cannot represent an ambiguous absent-route state. */
  route: IssuedSpawnEmissionRoute;
}>;

const sameEmissionBinding = (left: IssuedEmissionBinding, right: IssuedEmissionBinding): boolean =>
  left.requestId === right.requestId &&
  left.kind.kind === right.kind.kind &&
  left.version === right.version &&
  left.toolName === right.toolName &&
  left.schemaDigest === right.schemaDigest;

export function expectedSpawnEmissionCapability(
  item: PiSpawnItem,
  readIssuedRequest: SpawnAdmissionPorts["readIssuedRequest"],
): SpawnEmissionAdmission {
  const descriptor = parseEmissionDescriptor(item.task);
  const identity = parseTaskIssuedIdentity(item.task);
  if (identity.kind === "unbound") {
    return descriptor.kind === "absent"
      ? canonicalRecord({ ok: true, expectation: canonicalRecord({ kind: "no-emission-tool" as const }) })
      : canonicalRecord({
          ok: false,
          reason: `Pi agent '${item.agent}' carries an emission descriptor without exact task issuance identity markers`,
        });
  }
  if (identity.kind === "malformed") {
    return canonicalRecord({ ok: false, reason: `Pi agent '${item.agent}' carries unusable task issuance identity: ${identity.reason}` });
  }

  let issued: DomainResult<IssuedSpawnEmissionAuthority, Readonly<{ message: string }>>;
  try {
    issued = readIssuedRequest(identity.requestId, identity.contextDigest, item.agent);
  } catch (thrown) {
    const cause = boundedThrownCause(thrown, "issued spawn request authority");
    return canonicalRecord({
      ok: false,
      reason: `issued emission request authority could not be read safely (${cause.name}: ${cause.message})`,
    });
  }
  if (!issued.ok) {
    return canonicalRecord({ ok: false, reason: `issued emission request authority unavailable: ${issued.error.message}` });
  }
  const { claim, route } = issued.value;
  if (issued.value.role !== item.agent || claim.requestId !== identity.requestId ||
      claim.contextDigest !== identity.contextDigest) {
    return canonicalRecord({
      ok: false,
      reason: `issued emission request authority differs from the exact task identity for ${item.agent}/${identity.requestId}`,
    });
  }

  const eligible = producerKindsOfAgent(item.agent).map(({ kind }) => kind);
  if (!eligible.includes(claim.producerKind)) {
    if (descriptor.kind === "absent") {
      return canonicalRecord({ ok: true, expectation: canonicalRecord({ kind: "no-emission-tool" as const }) });
    }
    return canonicalRecord({
      ok: false,
      reason: `Pi agent '${item.agent}' carries an emission descriptor, but it cannot produce ${claim.producerKind} payloads: ` +
        `the Agent Catalog authorizes ${eligible.length === 0 ? "no producer kind" : eligible.join(", ")} for it (AD-6); ` +
        `extraction-only authority cannot be upgraded by task text`,
    });
  }
  if (route.kind === "extraction-only") {
    return descriptor.kind === "absent"
      ? canonicalRecord({ ok: true, expectation: canonicalRecord({ kind: "no-emission-tool" as const }) })
      : canonicalRecord({
          ok: false,
          reason: `Pi agent '${item.agent}' carries an emission descriptor, but the independently issued route is extraction-only ` +
            `(${route.reason}); extraction-only authority cannot be upgraded by task text`,
        });
  }

  const expected = issueProducerClaimBinding(claim);
  if (!expected.ok) {
    return canonicalRecord({
      ok: false,
      reason: `Pi agent '${item.agent}' carries an emission-enabled route, but the issued ` +
        `${claim.producerKind}/${claim.version} claim selects no frozen registry cell (${expected.error.code}); ` +
        `extraction-only authority cannot be upgraded by task text`,
    });
  }

  const routeMatchesAuthority = route.contextDigest === identity.contextDigest &&
    sameEmissionBinding(route.binding, expected.value);
  if (!routeMatchesAuthority) {
    return canonicalRecord({
      ok: false,
      reason: `issued emission route ${route.binding.requestId} differs from the exact request/protocol authority ` +
        `${identity.requestId} for ${item.agent}`,
    });
  }

  if (descriptor.kind === "absent") {
    return canonicalRecord({
      ok: false,
      reason: `issued emission-enabled request ${identity.requestId} is missing its required ${EMISSION_DESCRIPTOR_MARKER} descriptor`,
    });
  }
  if (descriptor.kind === "malformed") {
    return canonicalRecord({
      ok: false,
      reason: `Pi agent '${item.agent}' carries an unusable issued emission descriptor: ${descriptor.reason}`,
    });
  }
  const descriptorMatchesAuthority = descriptor.contextDigest === identity.contextDigest &&
    sameEmissionBinding(descriptor.binding, expected.value);
  if (!descriptorMatchesAuthority) {
    return canonicalRecord({
      ok: false,
      reason: `issued emission request/protocol authority differs from the descriptor for ${item.agent}/${identity.requestId}`,
    });
  }
  return canonicalRecord({
    ok: true,
    expectation: canonicalRecord({
      kind: "emission-enabled" as const,
      binding: expected.value,
      contextDigest: identity.contextDigest,
      route: QUALIFIED_EMISSION_ROUTE,
    }),
  });
}

/** Fields shared by every issued producer contract. Request identity is
 *  canonical before the claim enters the core; raw strings belong only at the
 *  request parser boundary. */
type IssuedProducerAuthority = Readonly<{
  requestId: RequestId;
  contextDigest: ContextDigest;
  producerKind: PayloadProducerKindName;
}>;

/**
 * One issued request's producer contract — a closed version-indexed claim
 * extracted from ISSUED registration, never from current defaults or model
 * arguments (AD-7). Archived v1 has no schema digest; current v2/v3 always
 * carry one. The discriminant makes an absent current digest and a digest on
 * an archived claim unrepresentable before registry admission.
 */
export type IssuedProducerClaim =
  | Readonly<IssuedProducerAuthority & { version: "v1"; schemaDigest?: never }>
  | Readonly<IssuedProducerAuthority & { version: "v2" | "v3"; schemaDigest: ArtifactDigest }>;

type ArchivedIssuedProducerClaim = Extract<IssuedProducerClaim, Readonly<{ version: "v1" }>>;
type CurrentIssuedProducerClaim = Extract<IssuedProducerClaim, Readonly<{ version: "v2" | "v3" }>>;

/** The registered review program's authenticated frozen protocol, shared by
 *  the issuance renderer and Pi parent admission. Its own discriminant is the
 *  sole input used to construct the corresponding producer-claim arm. */
type IssuedReviewerProtocol =
  | Readonly<{ schemaVersion: 1; reviewerProtocol?: never }>
  | Readonly<{ schemaVersion: 2 | 3; reviewerProtocol: Readonly<{ schemaDigest: string }> }>;

export function issuedReviewerPayloadClaim(
  program: IssuedReviewerProtocol,
  request: Readonly<{ requestId: RequestId; contextDigest: ContextDigest }>,
): IssuedProducerClaim {
  const authority = canonicalRecord({
    requestId: request.requestId,
    contextDigest: request.contextDigest,
    producerKind: "reviewer-payload" as const,
  });
  if (program.schemaVersion === 1) {
    return canonicalRecord({ ...authority, version: "v1" as const }) satisfies ArchivedIssuedProducerClaim;
  }
  const schemaDigest = parseArtifactDigest(program.reviewerProtocol.schemaDigest);
  if (!schemaDigest.ok) {
    throw new Error(`authenticated issued reviewer protocol carries an invalid schema digest: ${schemaDigest.error.message}`);
  }
  return canonicalRecord({
    ...authority,
    version: program.schemaVersion === 2 ? "v2" as const : "v3" as const,
    schemaDigest: schemaDigest.value,
  }) satisfies CurrentIssuedProducerClaim;
}

/** Translate the closed claim into the looser registry-boundary request. The
 *  branch is exhaustive over the version discriminant, so the registry never
 *  receives an absent v2/v3 digest or a synthetic v1 digest from typed code. */
function issueProducerClaimBinding(claim: IssuedProducerClaim) {
  const authority = {
    requestId: claim.requestId,
    kind: claim.producerKind,
    version: claim.version,
  };
  return claim.version === "v1"
    ? issueEmissionBinding(authority)
    : issueEmissionBinding({ ...authority, schemaDigest: claim.schemaDigest });
}

/**
 * The issuance-side route decision (AD-7/US2/US4): an issued producer contract
 * plus the child surface's capability declaration decide, in this order —
 *
 * 1. the issued contract must select AND certify a frozen registry cell
 *   (unsupported or non-certifying contracts are extraction-only by issuance,
 *   regardless of the surface — "historical reviewer protocols without a
 *   supported emission schema are extraction-only");
 * 2. a provided surface whose declared digest equals the issued cell's is
 *   emission; a provided surface declaring any other digest is the US4 hard
 *   refusal (parent-side loaded-revision containment);
 * 3. a not-provided surface follows its own degradation class: `extraction`
 *   is the capability-aware extraction route (AS-010 admits it), `refuse` is
 *   the hard refusal.
 */
export type EmissionRouteDecision =
  | Readonly<{ kind: "emission"; binding: IssuedEmissionBinding; contextDigest: ContextDigest }>
  | Readonly<{ kind: "extraction-only"; reason: string }>
  | Readonly<{ kind: "refused"; reason: string }>;

export function decideRequestEmissionRoute(
  claim: IssuedProducerClaim,
  capability: EmissionToolCapability,
): EmissionRouteDecision {
  const minted = issueProducerClaimBinding(claim);
  if (!minted.ok) {
    return canonicalRecord({
      kind: "extraction-only" as const,
      reason: `the issued ${claim.producerKind}/${claim.version} payload contract selects no frozen emission-tool registry cell: ` +
        `${minted.error.code} — ${minted.error.message}`,
    });
  }
  if (capability.kind === "provided") {
    return capability.schemaDigest === minted.value.schemaDigest
      ? canonicalRecord({ kind: "emission" as const, binding: minted.value, contextDigest: claim.contextDigest })
      : canonicalRecord({
          kind: "refused" as const,
          reason: `the child emission surface declares schema digest ${capability.schemaDigest}, not the issued ` +
            `${claim.producerKind}/${claim.version} digest ${minted.value.schemaDigest} (stale loaded revision; reload the Loom runtime or reissue the request)`,
        });
  }
  return capability.degradation === "refuse"
    ? canonicalRecord({
        kind: "refused" as const,
        reason: `the child emission surface cannot provide the issued emission tool: ${capability.reason}`,
      })
    : canonicalRecord({ kind: "extraction-only" as const, reason: capability.reason });
}

/** Translate capability qualification into the exact route carried by issued
 * spawn authority. This is the sole bridge between request projection and
 * parent admission, so the adapter never reconstructs route semantics. */
export function decideIssuedSpawnEmissionRoute(
  claim: IssuedProducerClaim,
  capability: EmissionToolCapability,
): IssuedSpawnEmissionRouteDecision {
  const route = decideRequestEmissionRoute(claim, capability);
  return route.kind === "emission"
    ? canonicalRecord({
        kind: "emission-enabled" as const,
        binding: route.binding,
        contextDigest: route.contextDigest,
      })
    : route;
}

/**
 * The ONE projection of an issued spawn route back onto the request
 * programs' route decision — the inverse of `decideIssuedSpawnEmissionRoute`'s
 * enabled arm, owned here so no consumer re-derives the discriminant mapping.
 * The extraction-only and refused arms are the same closed values in both
 * vocabularies and pass through unchanged.
 */
export function issuedSpawnEmissionRouteDecision(
  route: IssuedSpawnEmissionRouteDecision,
): EmissionRouteDecision {
  return route.kind === "emission-enabled"
    ? canonicalRecord({
        kind: "emission" as const,
        binding: route.binding,
        contextDigest: route.contextDigest,
      })
    : route;
}

export type IssuedRequestPiRoute = Readonly<{
  harnessBinding: Readonly<{
    pi: Readonly<{ provider: string; model: string }>;
  }>;
}>;

function emissionCapabilityForIssuedRoute(
  claim: IssuedProducerClaim,
  request: IssuedRequestPiRoute,
  piParentExists: boolean,
): EmissionToolCapability {
  if (!piParentExists) {
    return notProvidedEmissionCapability(
      "the parent harness is not Pi: its payload agents have no Loom extension seam that can register the exact emission tool",
      "extraction",
    );
  }
  const { provider, model } = request.harnessBinding.pi;
  if (provider !== QUALIFIED_EMISSION_ROUTE.provider || model !== QUALIFIED_EMISSION_ROUTE.model) {
    return notProvidedEmissionCapability(
      `issued Pi route ${provider}/${model} is not the explicitly trusted qualified route ` +
        `${QUALIFIED_EMISSION_ROUTE.provider}/${QUALIFIED_EMISSION_ROUTE.model} for the frozen emission schemas`,
      "extraction",
    );
  }
  const spec: EmissionToolSpec = EMISSION_TOOL_SPECS[claim.producerKind];
  const cell = spec.schemaVersions[claim.version];
  return cell === undefined
    ? notProvidedEmissionCapability(
        `the loaded emission registry carries no ${claim.producerKind}/${claim.version} cell`,
        "extraction",
      )
    : providedEmissionCapability(sha256Hex(cell.schemaBytes) as ArtifactDigest);
}

/** Pure qualification from authenticated, frozen request route data plus the
 * shell-observed existence of a Pi parent. The parent's mutable provider/model
 * is intentionally not an input and therefore cannot upgrade cloud issuance. */
export function qualifyIssuedSpawnEmissionRoute(
  claim: IssuedProducerClaim,
  request: IssuedRequestPiRoute,
  piParentExists: boolean,
): IssuedSpawnEmissionRouteDecision {
  return decideIssuedSpawnEmissionRoute(
    claim,
    emissionCapabilityForIssuedRoute(claim, request, piParentExists),
  );
}

/**
 * The tool-primary wire instruction for an emission-enabled request (FR-020/
 * AS-012): it names the EXACT issued tool as the primary final action, forbids
 * re-emitting within the same spawn (the duplicate-call ambiguity rule is
 * protocol, not just engine policy), and describes final-message extraction as
 * the fallback. It deliberately does not carry the extraction-only admission
 * prose — extraction-only and archived contracts keep their own wording.
 */
export function emissionToolPrimaryInstruction(binding: IssuedEmissionBinding): string {
  return `Emit the required payload by calling the exact tool ${binding.toolName} exactly once, with its arguments carrying the complete issued payload, and make that tool call your primary final action. Never call ${binding.toolName} a second time in this spawn. Only if the tool is unavailable or refuses your arguments, fall back to the final message: exactly one JSON object conforming to the issued payload schema, and nothing else.`;
}

/**
 * The ONE task-text projection of an emission route: what descriptor line (if
 * any) the spawn task carries and what instruction text the request programs
 * append. Emission requests gain the descriptor and the tool-primary
 * instruction; extraction-only requests keep the caller's instruction
 * VERBATIM and stamp nothing (FR-020: the final-message contract is
 * preserved). A refused route is not representable here — the shell throws it
 * fail-closed at its own boundary; the projection never silently degrades.
 */
export type EmissionTaskTextProjection = Readonly<{
  descriptor: string;
  instruction: string;
  /** Retained separately from task bytes so extraction-only remains verbatim
   *  while its exact admission reason can reach an operator-owned surface. */
  decision: Exclude<EmissionRouteDecision, { kind: "refused" }>;
}>;

export function projectEmissionTaskText(
  route: Exclude<EmissionRouteDecision, { kind: "refused" }>,
  baseInstruction: string,
): EmissionTaskTextProjection {
  return route.kind === "emission"
    ? canonicalRecord({
        descriptor: renderEmissionDescriptor(route.binding, route.contextDigest),
        instruction: `${baseInstruction}\n${emissionToolPrimaryInstruction(route.binding)}`,
        decision: route,
      })
    : canonicalRecord({ descriptor: "", instruction: baseInstruction, decision: route });
}
