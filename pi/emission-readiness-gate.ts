/**
 * The launcher-side emission readiness gate (AD-4 / FR-008 / AS-020): the pure
 * decision law the parent launch bridge (`pi/emission-launch-bridge.ts`) and
 * the barrier acceptance suites cross before any Task prompt reaches an
 * emission-enabled child.
 *
 * The one contract this module shares with the child surface
 * (`pi/emission-tool.ts`) is the bound readiness report: the child builds it
 * from its honest observations, and this gate parses it with the production
 * identity parsers and compares it against the parent's registry-minted
 * expectation. Nothing else crosses: child-side registration and provisioning
 * changes cannot disturb gate precedence, and gate changes cannot reach the
 * child.
 *
 * The decision runs in two stages because route binding is I/O that may only
 * happen after readiness opened:
 *
 * 1. `decideReadinessGate` — raw probe facts are first canonicalised by
 *    `parseReadinessStageObservation` (cancelled > unreachable > command
 *    absent > the command's own outcome), then every issued binding field is
 *    compared in misbinding-precedence order.
 * 2. `decideStartupRoute` — only a `ready` readiness decision can be bound to
 *    a route observation, so refused readiness can never be paired with a
 *    stale or sibling route.
 *
 * Every refusal carries one code from a closed fourteen-code vocabulary and
 * the remediation that code maps to. The vocabulary has no semantic arm: a
 * startup refusal is evidence/infrastructure class and never a consumed
 * semantic attempt. No I/O, no environment, no Pi import.
 */

import type { IssuedEmissionBinding } from "../engine/src/core/emission-tool";
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

// ---------------------------------------------------------------------------
// The closed refusal vocabulary and its remediation table
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

/** Every code the readiness stage can refuse with; only route binding refuses `route-bind-refused`. */
export type EmissionReadinessRefusalCode = Exclude<EmissionStartupRefusalCode, "route-bind-refused">;

export type EmissionStartupRefusal<C extends EmissionStartupRefusalCode> = Readonly<{
  kind: "refused";
  code: C;
  message: string;
  remediation: string;
}>;

const refuseStartup = <C extends EmissionStartupRefusalCode>(
  code: C,
  detail: string,
): EmissionStartupRefusal<C> => canonicalRecord({
  kind: "refused" as const,
  code,
  message: boundDiagnosticMessage(`${detail} Remediation: ${EMISSION_STARTUP_REMEDIATIONS[code]}`),
  remediation: EMISSION_STARTUP_REMEDIATIONS[code],
});

// ---------------------------------------------------------------------------
// The shared readiness report contract, parsed
// ---------------------------------------------------------------------------

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

type ParsedFieldValues<F> = {
  readonly [K in keyof F]: F[K] extends DomainResult<infer T, FieldParseError> ? T : never;
};

/** Collect-all field parse: every malformed field is named, in declaration
 * order, or every value is returned under its own key, so no caller ever holds
 * a half-parsed field. The one assertion is sound by construction: a success
 * means each key of `fields` was copied from an `ok` result. */
const parseAllFields = <F extends Readonly<Record<string, DomainResult<unknown, FieldParseError>>>>(
  fields: F,
): DomainResult<ParsedFieldValues<F>, readonly string[]> => {
  const violations: string[] = [];
  const values: Record<string, unknown> = {};
  for (const [field, parsed] of Object.entries(fields)) {
    if (parsed.ok) values[field] = parsed.value;
    else violations.push(`${field}: ${parsed.error.message}`);
  }
  return violations.length > 0
    ? failure(Object.freeze(violations))
    : success(values as ParsedFieldValues<F>);
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
  const parsed = parseAllFields({
    requestId: parseRequestId(raw["requestId"]),
    contextDigest: parseContextDigest(raw["contextDigest"]),
    schemaDigest: parseArtifactDigest(raw["schemaDigest"]),
    kind: nonEmptyString("kind", raw["kind"]),
    version: nonEmptyString("version", raw["version"]),
    toolName: nonEmptyString("toolName", raw["toolName"]),
    revision: nonEmptyString("revision", raw["revision"]),
    active: booleanValue("active", raw["active"]),
    childPid: positiveInteger("childPid", raw["childPid"]),
    registeredTools: stringArray("registeredTools", raw["registeredTools"]),
  });
  if (!parsed.ok) {
    return failure(canonicalRecord({
      kind: "malformed-readiness-payload" as const,
      reason: `the readiness payload violates its contract (${parsed.error.join("; ")})`,
    }));
  }
  const fields = parsed.value;
  return success(canonicalRecord({
    requestId: fields.requestId,
    contextDigest: fields.contextDigest,
    kind: fields.kind,
    version: fields.version,
    toolName: fields.toolName,
    schemaDigest: fields.schemaDigest,
    revision: fields.revision,
    active: fields.active,
    childPid: fields.childPid,
    registeredTools: fields.registeredTools,
  }));
}

// ---------------------------------------------------------------------------
// Stage 1: readiness
// ---------------------------------------------------------------------------

/** What the parent issued and expects the child to prove before route binding. */
export type EmissionReadinessExpectation = Readonly<{
  binding: IssuedEmissionBinding;
  contextDigest: ContextDigest;
  revision: string;
  readinessCommand: string;
}>;

/** The outcome of the one readiness-command invocation. `malformed` is a
 * readiness answer that is not exactly one bound readiness entry. */
export type ReadinessObservation =
  | Readonly<{ kind: "observed"; payload: unknown }>
  | Readonly<{ kind: "malformed"; reason: string }>
  | Readonly<{ kind: "absent"; reason: string }>
  | Readonly<{ kind: "startup-unavailable"; reason: string }>
  | Readonly<{ kind: "cancelled" }>;

/** The raw facts a launcher observes, in protocol order: whether the child
 * channel answered, whether discovery listed the readiness command, and what
 * the invocation produced. */
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
  | Readonly<{ kind: "malformed"; reason: string }>
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
  switch (facts.readiness.kind) {
    case "startup-unavailable":
      return canonicalRecord({ kind: "startup-unavailable" as const, reason: facts.readiness.reason });
    case "absent":
      return canonicalRecord({ kind: "timeout" as const, reason: facts.readiness.reason });
    case "malformed":
      return canonicalRecord({ kind: "malformed" as const, reason: facts.readiness.reason });
    case "observed":
      return canonicalRecord({ kind: "observed" as const, payload: facts.readiness.payload });
  }
}

export type EmissionReadinessGateDecision =
  | Readonly<{ kind: "ready"; readiness: ReadinessReport }>
  | EmissionStartupRefusal<EmissionReadinessRefusalCode>;

export type ReadyEmissionReadiness = Extract<EmissionReadinessGateDecision, { kind: "ready" }>;

/** The readiness decision every launcher crosses: one canonical stage, then
 * every issued binding field in misbinding-precedence order (FR-014). */
export function decideReadinessGate(
  expectation: EmissionReadinessExpectation,
  observation: ReadinessStageObservation,
): EmissionReadinessGateDecision {
  switch (observation.kind) {
    case "cancelled":
      return refuseStartup("cancelled", "startup was cancelled before the readiness observation completed");
    case "unreachable":
      return refuseStartup(
        "child-unreachable",
        `the pi child never became addressable${observation.diagnostic === null ? "" : `: ${observation.diagnostic}`}`,
      );
    case "command-absent":
      return refuseStartup(
        "readiness-command-absent",
        `the expected readiness command /${expectation.readinessCommand} is not registered in the child (the launcher never invokes an unverified command)`,
      );
    case "startup-unavailable":
      return refuseStartup("startup-unavailable", `the child explicitly refused startup before readiness: ${observation.reason}`);
    case "timeout":
      return refuseStartup("readiness-timeout", `no readiness observation arrived within the bounded window (${observation.reason})`);
    case "malformed":
      return refuseStartup("malformed-readiness", observation.reason);
    case "observed":
      return decideObservedReadiness(expectation, observation.payload);
  }
}

function decideObservedReadiness(
  expectation: EmissionReadinessExpectation,
  payload: unknown,
): EmissionReadinessGateDecision {
  const parsed = parseReadinessReport(payload);
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

// ---------------------------------------------------------------------------
// Stage 2: route binding, only after readiness opened
// ---------------------------------------------------------------------------

/**
 * The route the gate binds after readiness. `issued-model` is the parent's
 * issued provider/model authority — the parent launch bridge knows nothing
 * more. `pinned-endpoint` additionally pins the serving api and base URL, for
 * a launcher that owns the provider registration itself (the barrier
 * acceptance suites bind their counting substitute this way).
 */
export type ExpectedEmissionRoute =
  | Readonly<{ kind: "issued-model"; provider: string; modelId: string }>
  | Readonly<{ kind: "pinned-endpoint"; provider: string; modelId: string; api: string; baseUrl: string }>;

export type EmissionStartupExpectation = EmissionReadinessExpectation & Readonly<{ route: ExpectedEmissionRoute }>;

/** The child's route after the bind attempt. A `bound` model's api and base
 * URL are `null` when the child did not report them. */
export type RouteObservation =
  | Readonly<{ kind: "unbound" }>
  | Readonly<{
      kind: "bound";
      model: Readonly<{ provider: string; id: string; api: string | null; baseUrl: string | null }>;
    }>
  | Readonly<{ kind: "failed"; reason: string }>;

export type EmissionStartupDecision =
  | Readonly<{ kind: "open"; readiness: ReadinessReport; route: ExpectedEmissionRoute }>
  | EmissionStartupRefusal<EmissionStartupRefusalCode>;

const routeMatches = (
  expected: ExpectedEmissionRoute,
  model: Extract<RouteObservation, { kind: "bound" }>["model"],
): boolean =>
  model.provider === expected.provider && model.id === expected.modelId &&
  (expected.kind === "issued-model" || (model.api === expected.api && model.baseUrl === expected.baseUrl));

const describeExpectedRoute = (expected: ExpectedEmissionRoute): string =>
  expected.kind === "issued-model"
    ? `${expected.provider}/${expected.modelId}`
    : `${expected.provider}/${expected.modelId} via ${expected.api} at ${expected.baseUrl}`;

/** Bind the opened readiness to the observed route. The prompt may be
 * delivered only on `open`; every other arm releases the child unprompted. */
export function decideStartupRoute(
  expected: ExpectedEmissionRoute,
  ready: ReadyEmissionReadiness,
  route: RouteObservation,
): EmissionStartupDecision {
  if (route.kind === "unbound") {
    return refuseStartup("route-bind-refused", "the gate never bound the constrained route before any prompt delivery");
  }
  if (route.kind === "failed") {
    return refuseStartup("route-bind-refused", `the constrained route binding failed: ${route.reason}`);
  }
  const model = route.model;
  if (!routeMatches(expected, model)) {
    return refuseStartup(
      "route-bind-refused",
      `the bound route (${model.provider}/${model.id} via ${model.api ?? "an unreported api"} at ${model.baseUrl ?? "an unreported base URL"}) ` +
        `is not the expected constrained route (${describeExpectedRoute(expected)})`,
    );
  }
  return canonicalRecord({ kind: "open" as const, readiness: ready.readiness, route: expected });
}
