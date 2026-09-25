/**
 * The emission-startup acceptance suite (FR-008 / AS-020 / AD-4): an
 * emission-enabled Pi child MUST NOT send a model request before its ACTUAL
 * registered-and-active emission tool matches the issued request, producer
 * kind, version and schema digest. Startup observation is bounded and fails
 * explicitly on absent or contradictory readiness — without consuming
 * semantic evidence retry authority.
 *
 * The seam is the probe-proven one (`probes/emission-readiness/`, PROBE PASS
 * 4/4 twice on installed pi 0.83.0; the same primitives exist in the
 * repo-resolved runtime and are re-proven here on every run): a real headless
 * `pi --mode rpc` child spawned with NO prompt, `get_state` as the channel
 * check (distinguishing "child up, readiness missing" from "child never came
 * up"), `get_commands` discovery BEFORE any invocation (an unknown /command
 * would fall through to a real model request — the launcher must never invoke
 * an unverified command), the readiness command invoked via the RPC prompt
 * command (extension commands execute without a model request), the bound
 * readiness payload through `entry_appended`, a pure gate decision, a
 * fail-closed `set_model` route binding, prompt delivery only on match, and
 * the in-child awaited `before_agent_start` hold as the defense-in-depth
 * layer. The model transport is a COUNTING PROVIDER SUBSTITUTE (a local HTTP
 * server that counts and rejects completions), so a model request is a
 * counted event, never a real call.
 *
 * The launcher expectation is minted through the real `issueEmissionBinding`
 * over `EMISSION_TOOL_SPECS` — the schema digest is derived from the frozen
 * bytes, never trusted — and the readiness payload is parsed with the
 * production identity parsers (`parseRequestId` / `parseContextDigest` /
 * `parseArtifactDigest`). The gate decision is a closed ADT: THIRTEEN refusal
 * codes, exhaustive ts-pattern matching, the remediation named in every
 * message, and DELIBERATELY NO SEMANTIC ARM — a startup refusal is
 * evidence/infrastructure class, never a semantic payload decision and never
 * a consumed attempt (FR-008); the AS-020 release discipline is that only the
 * refusing child's own reservation is released.
 *
 * The pi binary is resolved explicitly — PI_BIN env, then the repo-resolved
 * `node_modules/.bin/pi`, then PATH — and the runtime identity is carried in
 * the suite title below.
 *
 * The 15 scenarios: matching opens on the judge-v1 and reviewer-v2 cells with
 * first-request-after-observation ordering; held (the `before_agent_start`
 * hold ordering); the zero-request negative controls (wrong digest, wrong
 * version, wrong kind, wrong request, stale revision, honestly-inactive tool
 * under a real `--tools` allowlist exclusion, malformed payload, silent child
 * under the bounded timeout, stale extension, absent extension); cancellation;
 * and the AS-020 concurrent-isolation control (a refused child released
 * without disturbing a concurrently starting matching child).
 */

import { describe, expect, it } from "vitest";
import { match } from "ts-pattern";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import {
  EMISSION_TOOL_SPECS,
  issueEmissionBinding,
  type EmissionSchemaVersion,
  type EmissionToolName,
  type IssuedEmissionBinding,
} from "../../src/core/emission-tool";
import { EMISSION_CONSTRAINED_SAMPLING_REQUEST } from "../../src/core/harness-capture";
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
} from "../../src/core/orchestration-contract/identity";
import type { PayloadProducerKindName } from "../../src/core/model-profiles";

// ---------------------------------------------------------------------------
// Shared unknown-value helpers (the one confined projection of untrusted data)
// ---------------------------------------------------------------------------

/** The ONE confined cast over untrusted records (RPC payloads, parsed JSON):
 *  a null-prototype-safe object view, or null. Every consumer guards. */
const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const stringifyUnknown = (value: unknown): string => (typeof value === "string" ? value : describeUnknown(value));

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Explicit pi binary resolution — PI_BIN env > repo-resolved bin > PATH
// ---------------------------------------------------------------------------

type PiBinarySource = "env" | "repo" | "path";

type PiBinaryResolution = Readonly<{
  bin: string;
  source: PiBinarySource;
  /** The resolved binary's own package version, when its layout carries one. */
  version: string | null;
}>;

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const piPackageVersionOf = (bin: string): string | null => {
  try {
    const real = realpathSync(bin);
    const manifest = recordOf(JSON.parse(readFileSync(join(dirname(dirname(real)), "package.json"), "utf8")));
    return manifest !== null && typeof manifest["version"] === "string" ? manifest["version"] : null;
  } catch {
    return null;
  }
};

const resolvePiBinary = (): PiBinaryResolution => {
  const envBinary = process.env["PI_BIN"];
  if (typeof envBinary === "string" && envBinary.length > 0) {
    return canonicalRecord({ bin: envBinary, source: "env" as const, version: piPackageVersionOf(envBinary) });
  }
  const repoBinary = join(repoRoot, "node_modules", ".bin", "pi");
  if (existsSync(repoBinary)) {
    return canonicalRecord({ bin: repoBinary, source: "repo" as const, version: piPackageVersionOf(repoBinary) });
  }
  return canonicalRecord({ bin: "pi", source: "path" as const, version: null });
};

const piBinary = resolvePiBinary();
const piIdentity = `pi ${piBinary.version ?? "version-unreported"} resolved from ${piBinary.source}`;

// ---------------------------------------------------------------------------
// The frozen registry cells the scenarios issue against
// ---------------------------------------------------------------------------

type RegistryCell = Readonly<{
  kind: PayloadProducerKindName;
  version: EmissionSchemaVersion;
  toolName: EmissionToolName;
  schemaBytes: string;
}>;

const cellOf = (kind: PayloadProducerKindName, version: EmissionSchemaVersion): RegistryCell => {
  const spec = EMISSION_TOOL_SPECS[kind];
  // Confined boundary cast: each spec's schemaVersions record type carries
  // only ITS versions, so a general in-vocabulary version cannot index the
  // union of per-spec records. The undefined guard below is the real check —
  // the cast never claims a cell exists, only that the key space is the
  // closed version vocabulary the registry itself bounds.
  const cell = (spec.schemaVersions as Readonly<Partial<Record<EmissionSchemaVersion, Readonly<{ schemaBytes: string }>>>>)[version];
  if (cell === undefined) throw new Error(`registry cell ${kind}/${version} is absent`);
  return canonicalRecord({ kind, version, toolName: spec.toolName, schemaBytes: cell.schemaBytes });
};

const REVIEWER_V2_CELL = cellOf("reviewer-payload", "v2");
const JUDGE_V1_CELL = cellOf("judge-verdict", "v1");

// ---------------------------------------------------------------------------
// The pure startup gate (FR-008 / AD-4): the closed decision the launcher acts
// on before any prompt delivery. Functional core — no I/O, no clock, no
// process knowledge; every input arrives as data.
// ---------------------------------------------------------------------------

/**
 * The closed refusal vocabulary of the launcher's startup barrier — THIRTEEN
 * codes, each naming the actual remediation. Deliberately NO semantic arm:
 * none of these codes mint, consume or advance a semantic attempt (FR-008) —
 * startup refusals are evidence/infrastructure observations, classified at
 * the boundary. The three bound-payload codes reuse the AD-8 observation
 * refusal vocabulary (`wrong-request`, `unexpected-kind`, `unexpected-version`)
 * so the startup gate and the ingestion selection speak one language about a
 * misbound child.
 */
export type EmissionStartupRefusalCode =
  | "child-unreachable"
  | "readiness-command-absent"
  | "readiness-timeout"
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

/** The remediation each refusal names — keyed by the closed code union, so a
 *  missing key is a compile error and the vocabulary cannot drift open. */
export const EMISSION_STARTUP_REMEDIATIONS: Readonly<Record<EmissionStartupRefusalCode, string>> = Object.freeze({
  "child-unreachable": "verify the pi runtime and extension wiring, then respawn the child",
  "readiness-command-absent": "/reload the loom extension so the child registers the readiness command",
  "readiness-timeout": "inspect the child extension startup, then respawn the child within the bounded readiness window",
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

/**
 * The bound readiness report — the AD-4 binding fields, PARSED not trusted:
 * request id, context digest, child identity, producer kind, schema version,
 * schema digest and exact tool name, plus the honest registered-and-active
 * fact and the child's full tool list for audit. The kind/version/tool name/
 * revision stay plain strings here (untrusted child claims); the GATE
 * compares them, so an out-of-vocabulary version is a refusal
 * (`unexpected-version`), never a parse failure — the malformed-payload
 * refusal is reserved for payloads that violate the contract's shape.
 */
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

export type ReadinessPayloadRejection = Readonly<{ kind: "malformed-readiness-payload"; reason: string }>;

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
    return failure(canonicalRecord({ message: `${field} must be an array of tool names, received ${describeUnknown(value)}` }));
  }
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      return failure(canonicalRecord({ message: `${field} must contain only non-empty tool names, received ${describeUnknown(entry)}` }));
    }
    names.push(entry);
  }
  return success(Object.freeze(names));
};

/** Collect one field's parse: the value when it parses, else a recorded
 *  violation and undefined. The violation carries the field's own name. */
const checkedField = <T, E extends FieldParseError>(
  field: string,
  parsed: DomainResult<T, E>,
  violations: string[],
): T | undefined => {
  if (parsed.ok) return parsed.value;
  violations.push(`${field}: ${parsed.error.message}`);
  return undefined;
};

/** The construction guard proving the collected invariant: violations.length
 *  === 0 implies every checked field parsed. A real runtime guard, never a
 *  type assertion — the same posture the kernel's own invariant guards use. */
const present = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("readiness parse invariant failed: a field value is absent without a recorded violation");
  return value;
};

/**
 * Parse, don't validate: the readiness payload becomes a validated report or
 * a malformed-readiness refusal naming EVERY violated field (bounded, in
 * contract order). The identity fields go through the production parsers, so
 * the launcher-side vocabulary is the engine's vocabulary — a probe-prefixed
 * digest (`sha256-…`) is malformed here exactly as it would be in production.
 */
export function parseReadinessReport(raw: unknown): DomainResult<ReadinessReport, ReadinessPayloadRejection> {
  const record = recordOf(raw);
  if (record === null) {
    return failure(canonicalRecord({
      kind: "malformed-readiness-payload" as const,
      reason: `the readiness payload is ${describeUnknown(raw)}, not an object`,
    }));
  }
  const violations: string[] = [];
  const requestId = checkedField("requestId", parseRequestId(record["requestId"]), violations);
  const contextDigest = checkedField("contextDigest", parseContextDigest(record["contextDigest"]), violations);
  const schemaDigest = checkedField("schemaDigest", parseArtifactDigest(record["schemaDigest"]), violations);
  const kind = checkedField("kind", nonEmptyString("kind", record["kind"]), violations);
  const version = checkedField("version", nonEmptyString("version", record["version"]), violations);
  const toolName = checkedField("toolName", nonEmptyString("toolName", record["toolName"]), violations);
  const revision = checkedField("revision", nonEmptyString("revision", record["revision"]), violations);
  const active = checkedField("active", booleanValue("active", record["active"]), violations);
  const childPid = checkedField("childPid", positiveInteger("childPid", record["childPid"]), violations);
  const registeredTools = checkedField("registeredTools", stringArray("registeredTools", record["registeredTools"]), violations);
  if (violations.length > 0) {
    return failure(canonicalRecord({
      kind: "malformed-readiness-payload" as const,
      reason: `the readiness payload violates its contract (${violations.join("; ")})`,
    }));
  }
  return success(canonicalRecord({
    requestId: present(requestId),
    contextDigest: present(contextDigest),
    kind: present(kind),
    version: present(version),
    toolName: present(toolName),
    schemaDigest: present(schemaDigest),
    revision: present(revision),
    active: present(active),
    childPid: present(childPid),
    registeredTools: present(registeredTools),
  }));
}

/** The launcher's issued expectation: the minted binding (registry-derived
 *  tool name and digest), the bound context digest, the parent-side loaded
 *  revision, the expected readiness command, and the constrained route the
 *  gate must bind fail-closed before any prompt. */
export type LauncherExpectation = Readonly<{
  binding: IssuedEmissionBinding;
  contextDigest: ContextDigest;
  revision: string;
  readinessCommand: string;
  route: Readonly<{ provider: string; modelId: string; api: string; baseUrl: string }>;
}>;

/** The route the gate must bind before prompting (AD-4's fail-closed step). */
export type VerifiedRoute = Readonly<{ provider: string; modelId: string; api: string; baseUrl: string }>;

export type ReadinessObservation =
  | Readonly<{ kind: "observed"; payload: unknown }>
  | Readonly<{ kind: "absent"; reason: string }>
  | Readonly<{ kind: "cancelled" }>;

export type RouteObservation =
  | Readonly<{ kind: "unbound" }>
  | Readonly<{ kind: "bound"; model: Readonly<{ provider: string; id: string; api: string; baseUrl: string }> }>
  | Readonly<{ kind: "failed"; reason: string }>;

export type ReadinessStageObservation = Readonly<{
  channelAlive: boolean;
  channelDiagnostic: string | null;
  commandListed: boolean;
  readiness: ReadinessObservation;
}>;

export type StartupGateObservation = ReadinessStageObservation & Readonly<{ route: RouteObservation }>;

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

/** Every refusal message carries its remediation — named, not implied. */
const refused = <C extends EmissionStartupRefusalCode>(code: C, detail: string): EmissionStartupRefusal<C> =>
  canonicalRecord({
    kind: "refused" as const,
    code,
    message: boundDiagnosticMessage(`${detail} Remediation: ${EMISSION_STARTUP_REMEDIATIONS[code]}`),
    remediation: EMISSION_STARTUP_REMEDIATIONS[code],
  });

/**
 * The readiness stage of the barrier: the pure ladder over the launcher's
 * protocol observations, in the order the launcher observes them —
 * cancellation first (a cancelled barrier is torn down; nothing else
 * matters), then the channel check (infrastructure), discovery, the bounded
 * readiness wait, the payload parse, and the request→kind→version→digest→
 * tool→active→revision binding ladder. The stage never mintes
 * `route-bind-refused`: the route is a separate, later stage (its type forbids
 * the code), because the constrained route can only be bound AFTER readiness
 * — the child registers its provider at readiness-command time.
 */
export function decideReadinessGate(
  expectation: LauncherExpectation,
  observation: ReadinessStageObservation,
): EmissionReadinessGateDecision {
  const readiness = observation.readiness;
  if (readiness.kind === "cancelled") {
    return refused("cancelled", "startup was cancelled before the readiness observation completed");
  }
  if (!observation.channelAlive) {
    return refused("child-unreachable", `the pi child never became addressable${observation.channelDiagnostic === null ? "" : `: ${observation.channelDiagnostic}`}`);
  }
  if (!observation.commandListed) {
    return refused("readiness-command-absent", `the expected readiness command /${expectation.readinessCommand} is not registered in the child (the launcher never invokes an unverified command)`);
  }
  if (readiness.kind === "absent") {
    return refused("readiness-timeout", `no readiness observation arrived within the bounded window (${readiness.reason})`);
  }
  const parsed = parseReadinessReport(readiness.payload);
  if (!parsed.ok) return refused("malformed-readiness", parsed.error.reason);
  const report = parsed.value;
  if (report.requestId !== expectation.binding.requestId || report.contextDigest !== expectation.contextDigest) {
    const mismatched: string[] = [];
    if (report.requestId !== expectation.binding.requestId) {
      mismatched.push(`request id ${report.requestId} ≠ issued ${expectation.binding.requestId}`);
    }
    if (report.contextDigest !== expectation.contextDigest) {
      mismatched.push(`context digest ${report.contextDigest} ≠ issued ${expectation.contextDigest}`);
    }
    return refused("wrong-request", `the child's readiness is bound to another request (${mismatched.join("; ")})`);
  }
  if (report.kind !== expectation.binding.kind.kind) {
    return refused("unexpected-kind", `the child activated producer kind ${report.kind}, not the issued ${expectation.binding.kind.kind}`);
  }
  if (report.version !== expectation.binding.version) {
    return refused("unexpected-version", `the child carries schema version ${report.version}, not the issued ${expectation.binding.version}`);
  }
  if (report.schemaDigest !== expectation.binding.schemaDigest) {
    return refused("schema-digest-mismatch", `the child's registered schema digest ${report.schemaDigest} does not certify the issued frozen schema (${expectation.binding.schemaDigest})`);
  }
  if (report.toolName !== expectation.binding.toolName) {
    return refused("tool-name-mismatch", `the child registered tool ${report.toolName}, not the issued ${expectation.binding.toolName}`);
  }
  if (!report.active) {
    return refused("tool-inactive", `the emission tool ${report.toolName} is registered but inactive in the child's actual active set`);
  }
  if (report.revision !== expectation.revision) {
    return refused("revision-mismatch", `the child reports revision ${report.revision}, not the issued ${expectation.revision}`);
  }
  return canonicalRecord({ kind: "ready" as const, readiness: report });
}

/**
 * The ONE startup decision the launcher acts on: the readiness stage, then —
 * only after the child proved its actual registered-and-active tool — the
 * fail-closed route binding. Prompt delivery happens only on the open arm,
 * and the open arm carries BOTH the parsed readiness report and the verified
 * route identity. Unbound or failed route identity is a refusal even when the
 * readiness matched: a prompt that slipped past an unverified route would
 * fall through to the child's default provider — the under-capability class
 * the gate exists to prevent.
 */
export function decideEmissionStartup(
  expectation: LauncherExpectation,
  observation: StartupGateObservation,
): EmissionStartupDecision {
  const stage = decideReadinessGate(expectation, observation);
  if (stage.kind === "refused") return stage;
  if (observation.route.kind === "unbound") {
    return refused("route-bind-refused", "the gate never bound the constrained route before any prompt delivery");
  }
  if (observation.route.kind === "failed") {
    return refused("route-bind-refused", `the constrained route binding failed: ${observation.route.reason}`);
  }
  const model = observation.route.model;
  if (
    model.provider !== expectation.route.provider ||
    model.id !== expectation.route.modelId ||
    model.api !== expectation.route.api ||
    model.baseUrl !== expectation.route.baseUrl
  ) {
    return refused(
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

/** The closed consumption of the decision — exhaustive by compiler, not by
 *  discipline: a third arm cannot be added without updating every consumer. */
export type StartupGateAction =
  | Readonly<{ kind: "deliver-prompt"; route: VerifiedRoute }>
  | Readonly<{ kind: "release-without-prompt" }>;

export const startupGateAction = (decision: EmissionStartupDecision): StartupGateAction =>
  match(decision)
    .with({ kind: "open" }, ({ route }) => canonicalRecord({ kind: "deliver-prompt" as const, route }))
    .with({ kind: "refused" }, () => canonicalRecord({ kind: "release-without-prompt" as const }))
    .exhaustive();

export const describeStartupDecision = (decision: EmissionStartupDecision): string =>
  match(decision)
    .with({ kind: "open" }, ({ readiness, route }) => `open on ${readiness.toolName} (${readiness.version}) via ${route.provider}/${route.modelId}`)
    .with({ kind: "refused" }, ({ code }) => `refused: ${code}`)
    .exhaustive();

// ---------------------------------------------------------------------------
// The imperative shell: counting provider substitute + real pi RPC child
// ---------------------------------------------------------------------------

const READINESS_COMMAND_NAME = "loom-emission-readiness";
const READINESS_ENTRY_TYPE = "loom-emission-readiness";
const HOLD_ENTRY_TYPE = "loom-emission-hold";
const CURRENT_REVISION = "loom-emission-rev-t4-current";
const STALE_REVISION = "loom-emission-rev-t4-stale-000";

const STATE_TIMEOUT_MS = 8_000;
const READY_TIMEOUT_MS = 2_500;
const HOLD_RESOLVE_TIMEOUT_MS = 6_000;
const FIRST_REQUEST_TIMEOUT_MS = 6_000;
const REFUSE_GRACE_MS = 800;
const CANCEL_AFTER_MS = 600;
const HOLD_MS = 700;
const HOLD_ORDERING_SLACK_MS = 250;
const HOLD_RELEASE_CAP_MS = 10_000;
const SLOW_READINESS_MS = 5_000;

const nextRequestId = (label: string): string => `req-emission-startup-t4-${label}-${++requestCounter}`;
let requestCounter = 0;

const contextDigestOf = (seed: string): ContextDigest => {
  const parsed = parseContextDigest(sha256Hex(seed));
  if (!parsed.ok) throw new Error(`fixture context digest refused: ${parsed.error.message}`);
  return parsed.value;
};

/**
 * The launcher expectation mint: the REAL issuance mint over the frozen
 * registry, with the claims the launcher holds (request id, kind, version,
 * exact tool name) and the digest derived from the frozen bytes — the mint
 * certifies the claims against the registry, so the expectation can never
 * name a schema the registry does not freeze.
 */
const makeExpectation = (cell: RegistryCell, requestId: string, routeBaseUrl: string): LauncherExpectation => {
  const minted = issueEmissionBinding({
    requestId,
    kind: cell.kind,
    version: cell.version,
    toolName: cell.toolName,
    schemaDigest: sha256Hex(cell.schemaBytes),
  });
  if (!minted.ok) {
    throw new Error(`the launcher expectation mint refused the issued claims: ${minted.error.code} — ${minted.error.message}`);
  }
  return canonicalRecord({
    binding: minted.value,
    contextDigest: contextDigestOf(`emission-startup-context:${requestId}`),
    revision: CURRENT_REVISION,
    readinessCommand: READINESS_COMMAND_NAME,
    route: canonicalRecord({
      provider: "loom-counting",
      modelId: "loom-counting-model",
      api: "openai-completions",
      baseUrl: routeBaseUrl,
    }),
  });
};

/** One counted model request on the counting provider substitute. */
type CountedRequest = Readonly<{ at: number; url: string; bytes: number }>;

type CountingServer = Readonly<{
  baseUrl: string;
  hits: CountedRequest[];
  close: () => Promise<void>;
}>;

/** The counting provider substitute (the committed probe's server, verbatim
 *  behavior): counts every completions POST and rejects it — the count is the
 *  evidence, the rejection bounds the run, and no real model is involved. */
const startCountingServer = (): Promise<CountingServer> => {
  const hits: CountedRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      if (request.method === "POST" && (request.url ?? "").startsWith("/v1/chat/completions")) {
        hits.push({ at: Date.now(), url: request.url ?? "", bytes: body.length });
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "counting substitute: rejected" } }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      resolve({
        hits,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        },
      });
    });
  });
};

/**
 * The child-side extension — adapted from the committed
 * `probes/emission-readiness/probe-extension.mjs` (PROBE PASS 4/4): the
 * counting provider and the ISSUED emission tool are registered inside the
 * readiness command (pi queues action methods at load time — never at factory
 * top level), the readiness payload is emitted via `appendEntry` →
 * `entry_appended` at gate time, the `held` variant proves the awaited
 * `before_agent_start` hold, and every scenario behavior is env-driven so the
 * SAME bytes serve all variants. The constrained-sampling request is the
 * shared production vocabulary, interpolated — the child registers with the
 * exact object production registers with.
 */
const CHILD_EXTENSION_SOURCE = `/**
 * Emission-startup suite child extension (probe-adapted). Env-driven; silent
 * on stdout — the RPC stream must carry only protocol JSON.
 */
import { createHash } from "node:crypto";

const env = process.env;
const VARIANT = env.EMISSION_STARTUP_VARIANT || "matching";
const READINESS_COMMAND = env.EMISSION_STARTUP_READINESS_COMMAND || "loom-emission-readiness";
const TOOL_NAME = env.EMISSION_STARTUP_TOOL_NAME || "";
const FROZEN_SCHEMA_TEXT = env.EMISSION_STARTUP_SCHEMA || "";
const STALE_SCHEMA_TEXT = env.EMISSION_STARTUP_STALE_SCHEMA || "";
const BINDING = JSON.parse(env.EMISSION_STARTUP_CHILD_BINDING || "{}");
const COUNT_BASE_URL = env.EMISSION_STARTUP_COUNT_BASE_URL || "";
const HOLD_MS = Number(env.EMISSION_STARTUP_HOLD_MS || "700");
const SLOW_READINESS_MS = Number(env.EMISSION_STARTUP_SLOW_READINESS_MS || "0");
const CONSTRAINED_SAMPLING = ${JSON.stringify(EMISSION_CONSTRAINED_SAMPLING_REQUEST)};
const READINESS_ENTRY_TYPE = "loom-emission-readiness";
const HOLD_ENTRY_TYPE = "loom-emission-hold";

const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function (pi) {
  if (VARIANT === "held") {
    pi.on("before_agent_start", async () => {
      pi.appendEntry(HOLD_ENTRY_TYPE, { phase: "entered" });
      await sleep(HOLD_MS);
      pi.appendEntry(HOLD_ENTRY_TYPE, { phase: "resolved" });
      return undefined;
    });
  }
  if (VARIANT === "stale-extension") {
    pi.registerCommand(READINESS_COMMAND + "-v0-stale", {
      description: "stale extension build: the expected readiness command is absent",
      handler: async () => undefined,
    });
    return;
  }
  pi.registerCommand(READINESS_COMMAND, {
    description: "Emission readiness: register the issued tool, verify active, report.",
    handler: async () => {
      if (SLOW_READINESS_MS > 0) {
        setTimeout(() => { void reportReadiness(pi); }, SLOW_READINESS_MS);
        return undefined;
      }
      return reportReadiness(pi);
    },
  });
}

async function reportReadiness(pi) {
  const registeredBytes = VARIANT === "wrong-digest" ? STALE_SCHEMA_TEXT : FROZEN_SCHEMA_TEXT;
  pi.registerProvider("loom-counting", {
    name: "Loom Counting Provider",
    baseUrl: COUNT_BASE_URL,
    apiKey: "$EMISSION_STARTUP_COUNT_KEY",
    api: "openai-completions",
    models: [
      {
        id: "loom-counting-model",
        name: "Loom Counting Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
  });
  pi.registerTool({
    name: TOOL_NAME,
    label: "Loom Emission Tool",
    description: "Emit the issued structured payload.",
    parameters: JSON.parse(registeredBytes),
    constrainedSampling: CONSTRAINED_SAMPLING,
    async execute(_toolCallId, params) {
      pi.appendEntry("loom-emission-args", { tool: TOOL_NAME, args: params });
      return { content: [{ type: "text", text: "payload acknowledged" }], details: {}, terminate: true };
    },
  });
  if (VARIANT === "silent") return undefined;
  const payload = VARIANT === "malformed"
    ? { emitted: "legacy-shape", note: "a stale extension emitted an incompatible readiness payload" }
    : {
        requestId: BINDING.requestId,
        contextDigest: BINDING.contextDigest,
        kind: BINDING.kind,
        version: BINDING.version,
        toolName: TOOL_NAME,
        schemaDigest: sha256Hex(registeredBytes),
        revision: BINDING.revision,
        active: pi.getActiveTools().includes(TOOL_NAME),
        childPid: process.pid,
        registeredTools: pi.getAllTools().map((tool) => tool.name),
      };
  pi.appendEntry(READINESS_ENTRY_TYPE, payload);
  return undefined;
}
`;

/** Strict JSONL RPC framing over the child's stdout (the probe's bus). */
type RpcEvent = Readonly<{ type: string } & Record<string, unknown>>;

type RpcBus = Readonly<{
  waitFor: (predicate: (event: RpcEvent) => boolean, timeoutMs: number, label: string) => Promise<RpcEvent>;
  failAll: (reason: string) => void;
}>;

const makeRpcBus = (stdout: NodeJS.ReadableStream): RpcBus => {
  const events: RpcEvent[] = [];
  const waiters: {
    predicate: (event: RpcEvent) => boolean;
    resolve: (event: RpcEvent) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout | null;
  }[] = [];
  let buffer = "";
  stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        events.push({ type: "__non_json__", line: line.slice(0, 160) });
        continue;
      }
      const record = recordOf(parsed);
      if (record === null) {
        events.push({ type: "__non_json__", line: line.slice(0, 160) });
        continue;
      }
      const event: RpcEvent = { ...record, type: typeof record["type"] === "string" ? record["type"] : "__untyped__" };
      events.push(event);
      for (let position = waiters.length - 1; position >= 0; position--) {
        const waiter = waiters[position];
        if (waiter !== undefined && waiter.predicate(event)) {
          waiters.splice(position, 1);
          if (waiter.timer !== null) clearTimeout(waiter.timer);
          waiter.resolve(event);
        }
      }
    }
  });
  return {
    failAll: (reason: string): void => {
      for (const waiter of waiters.splice(0)) {
        if (waiter.timer !== null) clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      }
    },
    waitFor: (predicate, timeoutMs, label) => {
      const existing = events.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<RpcEvent>((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null as NodeJS.Timeout | null };
        waiter.timer = setTimeout(() => {
          const position = waiters.indexOf(waiter);
          if (position !== -1) waiters.splice(position, 1);
          reject(new Error(`${label}: no matching RPC event within ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
};

const boundedEvent = (event: RpcEvent): string => boundDiagnosticMessage(JSON.stringify(event));
const boundedDiagnostic = (error: unknown): string =>
  boundDiagnosticMessage(error instanceof Error ? error.message : describeUnknown(error));

type ChildVariant = "matching" | "held" | "wrong-digest" | "malformed" | "silent" | "stale-extension" | "slow";

type ChildBinding = Readonly<{
  requestId: string;
  contextDigest: ContextDigest;
  kind: PayloadProducerKindName;
  version: string;
  revision: string;
}>;

type ScenarioSpec = Readonly<{
  label: string;
  issuedCell: RegistryCell;
  variant: ChildVariant;
  /** The child's OWN registration cell — the drift surface for wrong-kind. */
  childCell?: RegistryCell;
  childRequestId?: string;
  childContextDigest?: ContextDigest;
  childKind?: PayloadProducerKindName;
  childVersion?: string;
  childRevision?: string;
  /** The real spawn-time --tools allowlist (the honest-inactive control). */
  allowlist?: readonly string[];
  spawnChildExtension?: boolean;
  /** Cancel the barrier mid-readiness-wait (the cancellation control). */
  cancelAfterMs?: number;
  waitForRequest?: boolean;
  waitForHold?: boolean;
  /** Hold this run's own release open until the promise settles — the AS-020
   *  control keeps the matching child mid-flight across a peer's release. */
  holdRelease?: Promise<void>;
}>;

const childEnvFor = (
  server: CountingServer,
  spec: ScenarioSpec,
  childCell: RegistryCell,
  childBinding: ChildBinding,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["PI_CODING_AGENT"];
  env["EMISSION_STARTUP_VARIANT"] = spec.variant;
  env["EMISSION_STARTUP_READINESS_COMMAND"] = READINESS_COMMAND_NAME;
  env["EMISSION_STARTUP_TOOL_NAME"] = childCell.toolName;
  env["EMISSION_STARTUP_SCHEMA"] = childCell.schemaBytes;
  env["EMISSION_STARTUP_STALE_SCHEMA"] = spec.variant === "wrong-digest" ? staleSchemaBytes(childCell.schemaBytes) : "";
  env["EMISSION_STARTUP_CHILD_BINDING"] = JSON.stringify(childBinding);
  env["EMISSION_STARTUP_COUNT_BASE_URL"] = server.baseUrl;
  env["EMISSION_STARTUP_COUNT_KEY"] = "loom-counting-key";
  env["EMISSION_STARTUP_HOLD_MS"] = String(HOLD_MS);
  env["EMISSION_STARTUP_SLOW_READINESS_MS"] = spec.variant === "slow" ? String(SLOW_READINESS_MS) : "0";
  return env;
};

/** The stale schema a drifted child registers: the frozen bytes plus one
 *  marker property — still a valid tool schema, a DIFFERENT digest. */
const staleSchemaBytes = (schemaBytes: string): string => {
  const parsed = recordOf(JSON.parse(schemaBytes));
  if (parsed === null) throw new Error("the frozen schema bytes are not a JSON object");
  const properties = recordOf(parsed["properties"]);
  return JSON.stringify({ ...parsed, properties: { ...(properties ?? {}), staleDriftMarker: { type: "string" } } });
};

type StartupRun = Readonly<{
  label: string;
  decision: EmissionStartupDecision;
  channelAlive: boolean;
  channelDiagnostic: string | null;
  commandListed: boolean;
  commandsSeen: readonly string[];
  invocationCount: number;
  readinessPayload: unknown;
  readinessObservedAt: number | null;
  prompted: boolean;
  holdResolvedAt: number | null;
  firstRequestAt: number | null;
  requestCount: number;
  issuedRequestId: string;
  countingBaseUrl: string;
  childPid: number | null;
  childKilled: boolean;
  releasedAt: number | null;
  stderr: string;
}>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

type StartedGate = Readonly<{
  result: Promise<StartupRun>;
  childReady: Promise<ChildProcess | null>;
  /** Settles when the gate decision exists (or the run already settled) —
   *  the AS-020 control's mid-flight synchronization point. */
  gateDecided: Promise<void>;
}>;

type SettledWait = Readonly<{ kind: "observed"; event: RpcEvent }> | Readonly<{ kind: "failed"; error: unknown }>;

const settleWait = (wait: Promise<RpcEvent>): Promise<SettledWait> =>
  wait.then(
    (event): SettledWait => canonicalRecord({ kind: "observed" as const, event }),
    (error): SettledWait => canonicalRecord({ kind: "failed" as const, error }),
  );

const readinessPredicate = (event: RpcEvent): boolean => {
  const entry = recordOf(event["entry"]);
  return event.type === "entry_appended" && entry !== null && entry["customType"] === READINESS_ENTRY_TYPE;
};

const holdResolvedPredicate = (event: RpcEvent): boolean => {
  const entry = recordOf(event["entry"]);
  if (event.type !== "entry_appended" || entry === null || entry["customType"] !== HOLD_ENTRY_TYPE) return false;
  const data = recordOf(entry["data"]);
  return data !== null && data["phase"] === "resolved";
};

const entryDataOf = (event: RpcEvent): unknown => {
  const entry = recordOf(event["entry"]);
  return entry === null ? undefined : entry["data"];
};

/**
 * Run the launcher barrier protocol against a REAL headless pi child — the
 * probe-proven sequence, bounded at every step, cleaning up exactly this
 * child and this counting server in every outcome (AS-020's release
 * discipline: only the refusing run's own reservation is released).
 */
const startStartupGate = (spec: ScenarioSpec): StartedGate => {
  const childRef: { current: ChildProcess | null } = { current: null };
  const releasedRef: { current: boolean } = { current: false };
  const releasedAtRef: { current: number | null } = { current: null };
  const childReady = deferred<ChildProcess | null>();
  const decisionMade = deferred<void>();
  const releaseChild = (): void => {
    const child = childRef.current;
    if (child === null || releasedRef.current) return;
    releasedRef.current = true;
    releasedAtRef.current = Date.now();
    child.kill("SIGKILL");
  };
  const result = (async (): Promise<StartupRun> => {
    let exitSettled: Promise<void> | null = null;
    const server = await startCountingServer();
    const tmp = canonicalTempDir(`loom-emission-startup-${spec.label}-`);
    try {
      const issuedRequestId = nextRequestId(spec.label);
      const expectation = makeExpectation(spec.issuedCell, issuedRequestId, server.baseUrl);
      const childCell = spec.childCell ?? spec.issuedCell;
      const childContextDigest =
        spec.childContextDigest ?? contextDigestOf(`emission-startup-context:${spec.childRequestId ?? issuedRequestId}`);
      const childBinding: ChildBinding = canonicalRecord({
        requestId: spec.childRequestId ?? issuedRequestId,
        contextDigest: childContextDigest,
        kind: spec.childKind ?? childCell.kind,
        version: spec.childVersion ?? childCell.version,
        revision: spec.childRevision ?? CURRENT_REVISION,
      });
      const extPath = join(tmp, "loom-emission-child.mjs");
      await writeFile(extPath, CHILD_EXTENSION_SOURCE, "utf8");
      const args: string[] = ["--mode", "rpc", "--no-session", "-ne"];
      if (spec.spawnChildExtension !== false) args.push("-e", extPath);
      const allowlist = spec.allowlist ?? [childCell.toolName];
      if (allowlist.length > 0) args.push("--tools", allowlist.join(","));
      const child = spawn(piBinary.bin, args, {
        cwd: tmp,
        env: childEnvFor(server, spec, childCell, childBinding),
        stdio: ["pipe", "pipe", "pipe"],
      });
      childRef.current = child;
      childReady.resolve(child);
      exitSettled = new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
      });
      if (child.stdout === null) throw new Error("the pi child has no stdout pipe");
      const bus = makeRpcBus(child.stdout);
      let spawnError: Error | null = null;
      let childExited = false;
      child.on("error", (error: Error) => {
        spawnError = error;
        bus.failAll(`the pi child process failed: ${error.message}`);
      });
      child.on("exit", (code: number | null, signal: string | null) => {
        childExited = true;
        bus.failAll(`the pi child exited (code ${code === null ? "none" : code}, signal ${signal === null ? "none" : signal}) while the launcher was observing it`);
      });
      const stderrChunks: string[] = [];
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });

      let rpcCallCounter = 0;
      const rpcRequest = async (message: Record<string, unknown>, label: string): Promise<RpcEvent> => {
        const stdin = child.stdin;
        if (stdin === null || !stdin.writable) {
          throw new Error(`the pi child's stdin is not writable for ${label}${spawnError === null ? "" : ` (spawn error: ${spawnError.message})`}`);
        }
        const id = `t4-${spec.label}-${++rpcCallCounter}`;
        stdin.write(`${JSON.stringify({ ...message, id })}\n`);
        return bus.waitFor((event) => event.type === "response" && event["id"] === id, STATE_TIMEOUT_MS, label);
      };
      const assertChildAliveDuringWait = (error: unknown): void => {
        if (spawnError !== null || childExited) {
          throw new Error(`the launcher's child died during a bounded wait: ${boundedDiagnostic(error)}`);
        }
      };

      // 1. Channel check — "child up, readiness missing" must be
      //    distinguishable from "child never came up" (infrastructure).
      let channelAlive = false;
      let channelDiagnostic: string | null = "the RPC channel never answered get_state";
      try {
        const state = await rpcRequest({ type: "get_state" }, "get_state");
        if (state["success"] === true) {
          channelAlive = true;
          channelDiagnostic = null;
        } else {
          channelDiagnostic = `get_state answered success=false: ${boundedEvent(state)}`;
        }
      } catch (error) {
        channelDiagnostic = boundedDiagnostic(error);
      }

      // 2. Discovery — the readiness command must be REGISTERED before it is
      //    invoked; an unknown /command would trigger a real model request.
      let commandListed = false;
      const commandsSeen: string[] = [];
      if (channelAlive) {
        const commandsResponse = await rpcRequest({ type: "get_commands" }, "get_commands");
        const data = recordOf(commandsResponse["data"]);
        const rawCommands = data === null ? undefined : data["commands"];
        const commands: readonly unknown[] = Array.isArray(rawCommands) ? rawCommands : [];
        for (const raw of commands) {
          const record = recordOf(raw);
          if (record !== null && typeof record["name"] === "string" && typeof record["source"] === "string") {
            commandsSeen.push(`${record["name"]} (${record["source"]})`);
          }
        }
        commandListed = commands.some((raw) => {
          const record = recordOf(raw);
          return record !== null && record["name"] === expectation.readinessCommand && record["source"] === "extension";
        });
      }

      // 3. Readiness — invoke the verified command (no model request) and
      //    wait, bounded, for the bound payload through entry_appended.
      let invocationCount = 0;
      let readiness: ReadinessObservation = canonicalRecord({
        kind: "absent" as const,
        reason: "the launcher never reached the readiness stage",
      });
      let readinessObservedAt: number | null = null;
      if (commandListed) {
        invocationCount = 1;
        const invocation = await rpcRequest(
          { type: "prompt", message: `/${expectation.readinessCommand}` },
          "readiness command invocation",
        );
        if (invocation["success"] !== true) {
          throw new Error(`the readiness command invocation was refused by the child: ${boundedEvent(invocation)}`);
        }
        const readinessWait = settleWait(bus.waitFor(readinessPredicate, READY_TIMEOUT_MS, "readiness"));
        if (spec.cancelAfterMs !== undefined) {
          const outcome = await Promise.race([readinessWait, sleep(spec.cancelAfterMs).then((): "cancelled" => "cancelled")]);
          if (outcome === "cancelled") {
            readiness = canonicalRecord({ kind: "cancelled" as const });
            releaseChild();
          } else if (outcome.kind === "observed") {
            readinessObservedAt = Date.now();
            readiness = canonicalRecord({ kind: "observed" as const, payload: entryDataOf(outcome.event) });
          } else {
            assertChildAliveDuringWait(outcome.error);
            readiness = canonicalRecord({ kind: "absent" as const, reason: `no readiness entry arrived within ${READY_TIMEOUT_MS}ms` });
          }
        } else {
          const outcome = await readinessWait;
          if (outcome.kind === "observed") {
            readinessObservedAt = Date.now();
            readiness = canonicalRecord({ kind: "observed" as const, payload: entryDataOf(outcome.event) });
          } else {
            assertChildAliveDuringWait(outcome.error);
            readiness = canonicalRecord({ kind: "absent" as const, reason: `no readiness entry arrived within ${READY_TIMEOUT_MS}ms` });
          }
        }
      }

      // 4. The pure gate decision over the observed protocol facts, then —
      //    only on a ready child — the fail-closed route binding, then the
      //    full decision the launcher acts on.
      const stageObservation: ReadinessStageObservation = canonicalRecord({
        channelAlive,
        channelDiagnostic,
        commandListed,
        readiness,
      });
      const stageDecision = decideReadinessGate(expectation, stageObservation);
      let routeObservation: RouteObservation = canonicalRecord({ kind: "unbound" as const });
      if (stageDecision.kind === "ready") {
        const setModel = await rpcRequest(
          { type: "set_model", provider: expectation.route.provider, modelId: expectation.route.modelId },
          "set_model route binding",
        );
        if (setModel["success"] !== true) {
          routeObservation = canonicalRecord({ kind: "failed" as const, reason: `set_model refused: ${boundedEvent(setModel)}` });
        } else {
          const model = recordOf(setModel["data"]);
          if (model === null) {
            routeObservation = canonicalRecord({ kind: "failed" as const, reason: "set_model returned no model record" });
          } else {
            routeObservation = canonicalRecord({
              kind: "bound" as const,
              model: canonicalRecord({
                provider: stringifyUnknown(model["provider"]),
                id: stringifyUnknown(model["id"]),
                api: stringifyUnknown(model["api"]),
                baseUrl: stringifyUnknown(model["baseUrl"]),
              }),
            });
          }
        }
      }
      const observation: StartupGateObservation = { ...stageObservation, route: routeObservation };
      const finalDecision = decideEmissionStartup(expectation, observation);
      decisionMade.resolve();

      // 5. Act on the closed decision — prompt delivery ONLY on the open arm.
      const action = startupGateAction(finalDecision);
      let prompted = false;
      let holdResolvedAt: number | null = null;
      if (action.kind === "deliver-prompt") {
        await rpcRequest({ type: "set_auto_retry", enabled: false }, "set_auto_retry");
        await rpcRequest(
          {
            type: "prompt",
            message: `Emit the issued ${expectation.binding.kind.kind} payload via ${expectation.binding.toolName}.`,
          },
          "prompt delivery",
        );
        prompted = true;
        if (spec.waitForHold === true) {
          await bus.waitFor(holdResolvedPredicate, HOLD_RESOLVE_TIMEOUT_MS, "hold resolution");
          holdResolvedAt = Date.now();
        }
        const requestDeadline = Date.now() + FIRST_REQUEST_TIMEOUT_MS;
        while (server.hits.length === 0 && Date.now() < requestDeadline) await sleep(50);
      } else {
        await sleep(REFUSE_GRACE_MS);
      }

      // 6. The launcher's own release: the barrier is decided, so this child's
      //    reservation is released (the finally below is only the safety net).
      //    A held release keeps the child mid-flight across a peer's release
      //    (the AS-020 concurrent-isolation observation point), capped so a
      //    lost test can never wedge the run.
      if (spec.holdRelease !== undefined) {
        await Promise.race([spec.holdRelease, sleep(HOLD_RELEASE_CAP_MS)]);
      }
      releaseChild();

      const hits = server.hits;
      return canonicalRecord({
        label: spec.label,
        decision: finalDecision,
        channelAlive,
        channelDiagnostic,
        commandListed,
        commandsSeen: Object.freeze(commandsSeen),
        invocationCount,
        readinessPayload: readiness.kind === "observed" ? readiness.payload : null,
        readinessObservedAt,
        prompted,
        holdResolvedAt,
        firstRequestAt: hits.length > 0 ? hits[0]!.at : null,
        requestCount: hits.length,
        issuedRequestId,
        countingBaseUrl: server.baseUrl,
        childPid: typeof child.pid === "number" ? child.pid : null,
        childKilled: releasedRef.current,
        releasedAt: releasedAtRef.current,
        stderr: boundDiagnosticMessage(stderrChunks.join("").trim()),
      });
    } finally {
      releaseChild();
      if (exitSettled !== null) await Promise.race([exitSettled, sleep(1500)]);
      await server.close();
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  })().catch((error: unknown) => {
    childReady.resolve(null);
    throw error;
  });
  return {
    result,
    childReady: childReady.promise,
    gateDecided: Promise.race([decisionMade.promise, result.then(() => undefined, () => undefined)]),
  };
};

const runStartupGate = async (spec: ScenarioSpec): Promise<StartupRun> => (await startStartupGate(spec)).result;

// ---------------------------------------------------------------------------
// Assertion helpers (narrowing without casts)
// ---------------------------------------------------------------------------

type OpenDecision = Extract<EmissionStartupDecision, { kind: "open" }>;
type RefusedDecision = Extract<EmissionStartupDecision, { kind: "refused" }>;

const asOpen = (decision: EmissionStartupDecision): OpenDecision => {
  if (decision.kind !== "open") throw new Error(`expected an OPEN decision, received ${describeStartupDecision(decision)}`);
  return decision;
};

const asRefused = (decision: EmissionStartupDecision): RefusedDecision => {
  if (decision.kind !== "refused") throw new Error(`expected a REFUSED decision, received ${describeStartupDecision(decision)}`);
  return decision;
};

const expectOpenRun = (run: StartupRun): OpenDecision => {
  if (run.decision.kind !== "open") {
    const message = run.decision.kind === "refused" ? run.decision.message : "";
    throw new Error(`[${run.label}] expected the gate to OPEN, received ${describeStartupDecision(run.decision)} — ${message}; stderr: ${run.stderr}`);
  }
  return run.decision;
};

const expectRefusedRun = (run: StartupRun): RefusedDecision => {
  if (run.decision.kind !== "refused") {
    throw new Error(`[${run.label}] expected a REFUSED decision, received ${describeStartupDecision(run.decision)}; stderr: ${run.stderr}`);
  }
  return run.decision;
};

/** The shared negative-control assertion: the decision refused with exactly
 *  the expected code, the message names its remediation, the launcher never
 *  prompted, ZERO model requests reached the counting substitute, and the
 *  refusing child's own reservation was released. */
const expectZeroRequestRefusal = (run: StartupRun, code: EmissionStartupRefusalCode): RefusedDecision => {
  const refusedDecision = expectRefusedRun(run);
  expect(refusedDecision.code, run.label).toBe(code);
  expect(refusedDecision.message, run.label).toContain(EMISSION_STARTUP_REMEDIATIONS[code]);
  expect(run.prompted, run.label).toBe(false);
  expect(run.requestCount, run.label).toBe(0);
  expect(run.firstRequestAt, run.label).toBeNull();
  expect(run.childKilled, run.label).toBe(true);
  return refusedDecision;
};

const orderingPair = (run: StartupRun): { readonly firstRequestAt: number; readonly readinessObservedAt: number } => {
  if (run.firstRequestAt === null || run.readinessObservedAt === null) {
    throw new Error(`[${run.label}] missing ordering timestamps (first=${run.firstRequestAt}, readiness=${run.readinessObservedAt})`);
  }
  return { firstRequestAt: run.firstRequestAt, readinessObservedAt: run.readinessObservedAt };
};

const scenario = (label: string, overrides: Partial<Omit<ScenarioSpec, "label">> = {}): ScenarioSpec => ({
  label,
  issuedCell: REVIEWER_V2_CELL,
  variant: "matching",
  ...overrides,
});

// ---------------------------------------------------------------------------
// The pure gate contract (no process, no I/O — the launcher's decision law)
// ---------------------------------------------------------------------------

describe("the emission-startup gate decision — a closed ADT with no semantic arm (FR-008/AD-4)", () => {
  const expectation = makeExpectation(REVIEWER_V2_CELL, nextRequestId("gate-contract"), "http://127.0.0.1:9/v1");

  const honestReport = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
    requestId: expectation.binding.requestId,
    contextDigest: expectation.contextDigest,
    kind: expectation.binding.kind.kind,
    version: expectation.binding.version,
    toolName: expectation.binding.toolName,
    schemaDigest: expectation.binding.schemaDigest,
    revision: expectation.revision,
    active: true,
    childPid: 4242,
    registeredTools: [expectation.binding.toolName, "read"],
    ...overrides,
  });

  const observedReport = (overrides: Readonly<Record<string, unknown>> = {}): ReadinessObservation =>
    canonicalRecord({ kind: "observed" as const, payload: honestReport(overrides) });

  const readyStage = (): ReadinessStageObservation =>
    canonicalRecord({
      channelAlive: true,
      channelDiagnostic: null,
      commandListed: true,
      readiness: observedReport(),
    });

  const verifiedRouteOf = (route: LauncherExpectation["route"]): RouteObservation =>
    canonicalRecord({
      kind: "bound" as const,
      model: canonicalRecord({
        provider: route.provider,
        id: route.modelId,
        api: route.api,
        baseUrl: route.baseUrl,
      }),
    });

  const stageRows: readonly { readonly code: EmissionReadinessRefusalCode; readonly stage: ReadinessStageObservation }[] = [
    {
      code: "child-unreachable",
      stage: canonicalRecord({ channelAlive: false, channelDiagnostic: "connection refused", commandListed: true, readiness: observedReport() }),
    },
    {
      code: "readiness-command-absent",
      stage: canonicalRecord({ channelAlive: true, channelDiagnostic: null, commandListed: false, readiness: observedReport() }),
    },
    {
      code: "readiness-timeout",
      stage: canonicalRecord({
        channelAlive: true,
        channelDiagnostic: null,
        commandListed: true,
        readiness: canonicalRecord({ kind: "absent" as const, reason: "no readiness entry within 2500ms" }),
      }),
    },
    {
      code: "malformed-readiness",
      stage: canonicalRecord({
        channelAlive: true,
        channelDiagnostic: null,
        commandListed: true,
        readiness: canonicalRecord({ kind: "observed" as const, payload: { emitted: "legacy-shape" } }),
      }),
    },
    { code: "wrong-request", stage: { channelAlive: true, channelDiagnostic: null, commandListed: true, readiness: observedReport({ requestId: "req-emission-startup-t4-other-peer-1" }) } },
    { code: "unexpected-kind", stage: { channelAlive: true, channelDiagnostic: null, commandListed: true, readiness: observedReport({ kind: "judge-verdict" }) } },
    { code: "unexpected-version", stage: { channelAlive: true, channelDiagnostic: null, commandListed: true, readiness: observedReport({ version: "v9" }) } },
    { code: "schema-digest-mismatch", stage: { channelAlive: true, channelDiagnostic: null, commandListed: true, readiness: observedReport({ schemaDigest: sha256Hex("stale-bytes") }) } },
    { code: "tool-name-mismatch", stage: { channelAlive: true, channelDiagnostic: null, commandListed: true, readiness: observedReport({ toolName: "loom_emit_refutation_verdict" }) } },
    { code: "tool-inactive", stage: { channelAlive: true, channelDiagnostic: null, commandListed: true, readiness: observedReport({ active: false }) } },
    { code: "revision-mismatch", stage: { channelAlive: true, channelDiagnostic: null, commandListed: true, readiness: observedReport({ revision: STALE_REVISION }) } },
    {
      code: "cancelled",
      stage: canonicalRecord({
        channelAlive: true,
        channelDiagnostic: null,
        commandListed: true,
        readiness: canonicalRecord({ kind: "cancelled" as const }),
      }),
    },
  ];

  const routeRows: readonly { readonly route: RouteObservation }[] = [
    { route: canonicalRecord({ kind: "unbound" as const }) },
    { route: canonicalRecord({ kind: "failed" as const, reason: "set_model refused: unknown provider" }) },
    {
      route: canonicalRecord({
        kind: "bound" as const,
        model: canonicalRecord({ provider: "other-provider", id: "other-model", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1" }),
      }),
    },
  ];

  it("refuses every mismatching observation with its exact code, and every refusal message names the remediation", () => {
    for (const row of stageRows) {
      const decision = decideEmissionStartup(expectation, { ...row.stage, route: verifiedRouteOf(expectation.route) });
      const refusedDecision = asRefused(decision);
      expect(refusedDecision.code, JSON.stringify(row.stage)).toBe(row.code);
      expect(refusedDecision.message, row.code).toContain(EMISSION_STARTUP_REMEDIATIONS[row.code]);
      expect(refusedDecision.remediation, row.code).toBe(EMISSION_STARTUP_REMEDIATIONS[row.code]);
    }
    for (const row of routeRows) {
      const decision = decideEmissionStartup(expectation, { ...readyStage(), route: row.route });
      const refusedDecision = asRefused(decision);
      expect(refusedDecision.code, JSON.stringify(row.route)).toBe("route-bind-refused");
      expect(refusedDecision.message).toContain(EMISSION_STARTUP_REMEDIATIONS["route-bind-refused"]);
    }
  });

  it("the refusal vocabulary is closed at exactly thirteen codes with no semantic arm, and the decision is exhaustive to match", () => {
    const codes = Object.keys(EMISSION_STARTUP_REMEDIATIONS);
    expect(codes).toHaveLength(13);
    expect(new Set(codes).size).toBe(13);
    for (const code of codes) expect(EMISSION_STARTUP_REMEDIATIONS[code as EmissionStartupRefusalCode].length).toBeGreaterThan(0);

    // The open arm and the refused arm are the ONLY arms; the consumption is
    // exhaustive by compiler (ts-pattern .exhaustive()), and neither arm
    // carries a payload, source, or attempt field — startup never minted,
    // consumed, or advanced semantic evidence (FR-008).
    const open = asOpen(decideEmissionStartup(expectation, { ...readyStage(), route: verifiedRouteOf(expectation.route) }));
    expect(startupGateAction(open).kind).toBe("deliver-prompt");
    expect(describeStartupDecision(open)).toContain("open on loom_emit_reviewer_payload");
    expect(Object.keys(open).sort().join(",")).toBe("kind,readiness,route");

    const refusedDecision = asRefused(decideEmissionStartup(expectation, { ...readyStage(), route: { kind: "unbound" } }));
    expect(startupGateAction(refusedDecision)).toEqual({ kind: "release-without-prompt" });
    expect(describeStartupDecision(refusedDecision)).toBe("refused: route-bind-refused");
    expect(Object.keys(refusedDecision).sort().join(",")).toBe("code,kind,message,remediation");

    // The refusal vocabulary is disjoint from the AD-9 semantic selection
    // vocabulary — a startup refusal cannot be mistaken for a payload decision.
    const semanticSelectionArms = [
      "emission-tool-arguments",
      "final-message-extraction",
      "extraction-over-refused-call",
      "duplicate-emission-call",
      "refused-call-no-fallback",
      "observation-refused",
    ];
    for (const code of codes) expect(semanticSelectionArms).not.toContain(code);
  });

  it("parses the readiness payload through the production identity parsers", () => {
    const parsed = parseReadinessReport(honestReport());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.requestId).toBe(expectation.binding.requestId);
      expect(parsed.value.contextDigest).toBe(expectation.contextDigest);
      expect(parsed.value.schemaDigest).toBe(expectation.binding.schemaDigest);
      expect(parsed.value.kind).toBe(expectation.binding.kind.kind);
      expect(parsed.value.active).toBe(true);
      expect(parsed.value.childPid).toBe(4242);
      expect(parsed.value.registeredTools).toEqual([expectation.binding.toolName, "read"]);
    }
  });

  it("refuses a malformed readiness payload naming every violated field — parse, don't validate", () => {
    const parsed = parseReadinessReport({
      requestId: 42,
      contextDigest: "not-a-digest",
      schemaDigest: `sha256-${"0".repeat(64)}`,
      kind: "",
      version: "v2",
      toolName: "loom_emit_reviewer_payload",
      revision: "r",
      active: "yes",
      childPid: 0,
      registeredTools: ["ok", 7],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      for (const fragment of ["requestId", "contextDigest", "schemaDigest", "kind", "active", "childPid", "registeredTools"]) {
        expect(parsed.error.reason, fragment).toContain(fragment);
      }
    }
  });

  it("opens only on the full conjunction — matching readiness AND a verified route, with the mint digesting the frozen bytes", () => {
    const open = asOpen(decideEmissionStartup(expectation, { ...readyStage(), route: verifiedRouteOf(expectation.route) }));
    expect(open.readiness.requestId).toBe(expectation.binding.requestId);
    expect(open.readiness.toolName).toBe(REVIEWER_V2_CELL.toolName);
    expect(open.readiness.schemaDigest).toBe(sha256Hex(REVIEWER_V2_CELL.schemaBytes));
    expect(open.route).toEqual({ provider: "loom-counting", modelId: "loom-counting-model", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1" });
  });
});

// ---------------------------------------------------------------------------
// The 15 real-child scenarios — counting-provider substitute, zero-request
// negative controls, release isolation (FR-008 / AS-020)
// ---------------------------------------------------------------------------

describe(`emission-startup barrier against a real headless pi child on ${piIdentity} — counting-provider substitute`, () => {
  it("matching readiness on the judge-verdict v1 cell opens the gate, and the first model request lands after the readiness observation (FR-008)", async () => {
    const run = await runStartupGate(scenario("matching-judge-v1", { issuedCell: JUDGE_V1_CELL, waitForRequest: true }));
    const open = expectOpenRun(run);
    expect(run.channelAlive).toBe(true);
    expect(run.commandListed).toBe(true);
    expect(run.invocationCount).toBe(1);
    expect(run.prompted).toBe(true);
    expect(run.requestCount).toBe(1);
    const { firstRequestAt, readinessObservedAt } = orderingPair(run);
    expect(firstRequestAt).toBeGreaterThanOrEqual(readinessObservedAt);
    expect(open.readiness.requestId).toBe(run.issuedRequestId);
    expect(open.readiness.kind).toBe("judge-verdict");
    expect(open.readiness.version).toBe("v1");
    expect(open.readiness.toolName).toBe("loom_emit_judge_verdict");
    expect(open.readiness.schemaDigest).toBe(sha256Hex(JUDGE_V1_CELL.schemaBytes));
    expect(open.readiness.active).toBe(true);
    expect(open.readiness.childPid).toBe(run.childPid);
    expect(open.route).toEqual({
      provider: "loom-counting",
      modelId: "loom-counting-model",
      api: "openai-completions",
      baseUrl: run.countingBaseUrl,
    });
  });

  it("matching readiness on the reviewer-payload v2 cell opens the gate, and the first model request lands after the readiness observation (FR-008)", async () => {
    const run = await runStartupGate(scenario("matching-reviewer-v2", { waitForRequest: true }));
    const open = expectOpenRun(run);
    expect(run.channelAlive).toBe(true);
    expect(run.commandListed).toBe(true);
    expect(run.invocationCount).toBe(1);
    expect(run.prompted).toBe(true);
    expect(run.requestCount).toBe(1);
    const { firstRequestAt, readinessObservedAt } = orderingPair(run);
    expect(firstRequestAt).toBeGreaterThanOrEqual(readinessObservedAt);
    expect(open.readiness.requestId).toBe(run.issuedRequestId);
    expect(open.readiness.kind).toBe("reviewer-payload");
    expect(open.readiness.version).toBe("v2");
    expect(open.readiness.toolName).toBe("loom_emit_reviewer_payload");
    expect(open.readiness.schemaDigest).toBe(sha256Hex(REVIEWER_V2_CELL.schemaBytes));
    expect(open.readiness.active).toBe(true);
    expect(open.readiness.childPid).toBe(run.childPid);
    expect(open.route).toEqual({
      provider: "loom-counting",
      modelId: "loom-counting-model",
      api: "openai-completions",
      baseUrl: run.countingBaseUrl,
    });
  });

  it("the in-child before_agent_start hold delays the first model request until the hold resolves — defense-in-depth ordering (AD-4)", async () => {
    const run = await runStartupGate(scenario("held", { variant: "held", waitForRequest: true, waitForHold: true }));
    expectOpenRun(run);
    expect(run.prompted).toBe(true);
    expect(run.requestCount).toBe(1);
    if (run.holdResolvedAt === null) throw new Error(`[${run.label}] the hold-resolution marker was never observed`);
    const { firstRequestAt, readinessObservedAt } = orderingPair(run);
    expect(firstRequestAt).toBeGreaterThanOrEqual(readinessObservedAt);
    expect(firstRequestAt).toBeGreaterThanOrEqual(run.holdResolvedAt - HOLD_ORDERING_SLACK_MS);
  });

  it("a child whose registered schema digest contradicts the issued frozen schema is refused with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("wrong-digest", { variant: "wrong-digest" }));
    const refusedDecision = expectZeroRequestRefusal(run, "schema-digest-mismatch");
    expect(run.readinessPayload).not.toBeNull();
    expect(run.invocationCount).toBe(1);
    expect(refusedDecision.message).toContain("digest");
  });

  it("a child claiming a schema version outside the issued binding is refused with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("wrong-version", { childVersion: "v9" }));
    const refusedDecision = expectZeroRequestRefusal(run, "unexpected-version");
    expect(run.readinessPayload).not.toBeNull();
    expect(refusedDecision.message).toContain("v9");
  });

  it("a child activated for a different producer kind is refused with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("wrong-kind", { childCell: JUDGE_V1_CELL }));
    const refusedDecision = expectZeroRequestRefusal(run, "unexpected-kind");
    expect(run.readinessPayload).not.toBeNull();
    const raw = recordOf(run.readinessPayload);
    expect(raw?.["kind"]).toBe("judge-verdict");
    expect(refusedDecision.message).toContain("judge-verdict");
  });

  it("a child still bound to a stale request is refused with ZERO model requests, the message naming both request ids (AS-020)", async () => {
    const staleRequestId = nextRequestId("stale-peer");
    const run = await runStartupGate(scenario("wrong-request", {
      childRequestId: staleRequestId,
      childContextDigest: contextDigestOf(`emission-startup-context:${staleRequestId}`),
    }));
    const refusedDecision = expectZeroRequestRefusal(run, "wrong-request");
    expect(run.readinessPayload).not.toBeNull();
    expect(refusedDecision.message).toContain(staleRequestId);
    expect(refusedDecision.message).toContain(run.issuedRequestId);
  });

  it("a child loaded at a stale revision is refused with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("stale-revision", { childRevision: STALE_REVISION }));
    const refusedDecision = expectZeroRequestRefusal(run, "revision-mismatch");
    expect(run.readinessPayload).not.toBeNull();
    expect(refusedDecision.message).toContain(STALE_REVISION);
  });

  it("a registered-but-inactive tool under a real --tools allowlist exclusion is honestly refused with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("honestly-inactive", { allowlist: ["read"] }));
    const refusedDecision = expectZeroRequestRefusal(run, "tool-inactive");
    expect(run.readinessPayload).not.toBeNull();
    const raw = recordOf(run.readinessPayload);
    expect(raw?.["active"]).toBe(false);
    expect(refusedDecision.message).toContain("--tools");
  });

  it("a readiness payload violating the bound contract shape is refused with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("malformed-payload", { variant: "malformed" }));
    const refusedDecision = expectZeroRequestRefusal(run, "malformed-readiness");
    expect(run.readinessPayload).not.toBeNull();
    expect(refusedDecision.message).toContain("violates its contract");
  });

  it("a silent child is refused by the bounded readiness timeout with ZERO model requests (FR-008/AS-020)", async () => {
    const run = await runStartupGate(scenario("silent-child", { variant: "silent" }));
    const refusedDecision = expectZeroRequestRefusal(run, "readiness-timeout");
    expect(run.readinessPayload).toBeNull();
    expect(run.invocationCount).toBe(1);
    expect(refusedDecision.message).toContain("bounded window");
  });

  it("a stale extension that no longer registers the expected readiness command is refused by discovery with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("stale-extension", { variant: "stale-extension" }));
    const refusedDecision = expectZeroRequestRefusal(run, "readiness-command-absent");
    expect(run.invocationCount).toBe(0);
    expect(run.readinessPayload).toBeNull();
    expect(run.commandsSeen.join(" | ")).toContain("loom-emission-readiness-v0-stale (extension)");
    expect(run.commandsSeen.join(" | ")).not.toContain("loom-emission-readiness (extension)");
    expect(refusedDecision.message).toContain("/reload");
  });

  it("an absent extension is refused by discovery with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("absent-extension", { spawnChildExtension: false }));
    const refusedDecision = expectZeroRequestRefusal(run, "readiness-command-absent");
    expect(run.channelAlive).toBe(true);
    expect(run.invocationCount).toBe(0);
    expect(run.readinessPayload).toBeNull();
    expect(run.commandsSeen.join(" | ")).not.toContain("loom-emission-readiness (extension)");
    expect(refusedDecision.message).toContain("/reload");
  });

  it("cancelling the barrier mid-readiness releases the child and sends ZERO model requests (FR-008/AS-020)", async () => {
    const run = await runStartupGate(scenario("cancellation", { variant: "slow", cancelAfterMs: CANCEL_AFTER_MS }));
    const refusedDecision = expectZeroRequestRefusal(run, "cancelled");
    expect(run.readinessPayload).toBeNull();
    expect(run.invocationCount).toBe(1);
    expect(run.releasedAt).not.toBeNull();
    expect(refusedDecision.message).toContain("cancelled");
  });

  it("AS-020: a refused child is released without disturbing a concurrently starting matching child", async () => {
    const holdRelease = deferred<void>();
    const refusedGate = startStartupGate(scenario("as020-refused", { variant: "wrong-digest" }));
    const matchingGate = startStartupGate(scenario("as020-matching", { waitForRequest: true, holdRelease: holdRelease.promise }));
    try {
      // Synchronize: the matching child is past its gate decision (mid-flight)
      // before the refused peer's release is even awaited.
      await matchingGate.gateDecided;
      const refusedRun = await refusedGate.result;
      expectZeroRequestRefusal(refusedRun, "schema-digest-mismatch");
      const matchingChild = await matchingGate.childReady;
      if (matchingChild === null) throw new Error("the matching child was never spawned");
      // The refused release touched ONLY the refused reservation: the
      // matching child is still alive and was never signalled.
      expect(refusedRun.childPid).not.toBe(matchingChild.pid);
      expect(matchingChild.exitCode).toBeNull();
      expect(matchingChild.killed).toBe(false);
      holdRelease.resolve();
      const matchingRun = await matchingGate.result;
      const open = expectOpenRun(matchingRun);
      expect(open.readiness.requestId).toBe(matchingRun.issuedRequestId);
      expect(open.readiness.active).toBe(true);
      expect(matchingRun.prompted).toBe(true);
      expect(matchingRun.requestCount).toBe(1);
      const { firstRequestAt, readinessObservedAt } = orderingPair(matchingRun);
      expect(firstRequestAt).toBeGreaterThanOrEqual(readinessObservedAt);
    } finally {
      // The held release is ALWAYS unblocked — even on an assertion failure —
      // so both runs settle and release their own reservations.
      holdRelease.resolve();
      await Promise.allSettled([refusedGate.result, matchingGate.result]);
    }
  });
});
