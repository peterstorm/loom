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
 * `parseArtifactDigest`). The gate decision is a closed ADT: FOURTEEN refusal
 * codes, both union arms and their runtime shapes pinned by assertions, the
 * remediation named in every message, and DELIBERATELY NO SEMANTIC ARM — a startup refusal is
 * evidence/infrastructure class, never a semantic payload decision and never
 * a consumed attempt (FR-008); the AS-020 release discipline is that only the
 * refusing child's own reservation is released.
 *
 * The pi binary is resolved explicitly — PI_BIN env, then the repo-resolved
 * `node_modules/.bin/pi`, then PATH — and the runtime identity is carried in
 * the suite title below.
 *
 * The wave-2 protocol suite contains 22 scenarios: matching opens on the
 * judge-v1 and reviewer-v2 cells; held ordering; the zero-request negative
 * controls (including an active, digest-matching tool under a DRIFTED name
 * and a readiness bound to a foreign context digest — both discriminating
 * only through the real protocol); the bounded-observation law (a readiness
 * entry arriving AFTER the bounded window cannot reopen the decided
 * barrier); the misbinding precedence END-TO-END (a child provisioned for a
 * stale peer's request AND a different producer kind refuses wrong-request,
 * never its capability mismatch); the fail-closed route bind observed live
 * (a bound route drifting from the expected constrained endpoint, and a
 * child with NO registered provider — both refused before any prompt after
 * matching readiness); the infrastructure-failure boundary (a child that
 * dies mid-readiness throws as infrastructure, never a minted refusal, with
 * ZERO counted model requests); cancellation; and concurrent isolation. The
 * T5 production suite at the end repeats the protocol against the real Loom
 * extension, including provisioning refusals and the hold's
 * wedge-to-readiness release arc.
 */

import { describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { captureLoomRuntimeIdentity } from "../../src/runtime-compatibility";
import { renderPiAgentDefinition } from "../../src/utils/render-pi-agent";
import {
  emissionToolPrimaryInstruction,
  projectEmissionTaskText,
  renderEmissionDescriptor,
} from "../../src/core/spawn-admission";
import {
  EMISSION_TOOL_SPECS,
  issueEmissionBinding,
  type EmissionSchemaVersion,
  type EmissionToolName,
} from "../../src/core/emission-tool";
import {
  decideEmissionStartup,
  decideReadinessGate,
  describeStartupDecision,
  EMISSION_HOLD_ENTRY_TYPE,
  EMISSION_READINESS_COMMAND,
  EMISSION_READINESS_ENTRY_TYPE,
  EMISSION_STARTUP_REMEDIATIONS,
  LOOM_EMISSION_BINDING_ENV,
  parseReadinessReport,
  parseReadinessStageObservation,
  startupGateAction,
  startupGateObservation,
  type EmissionReadinessRefusalCode,
  type EmissionStartupDecision,
  type EmissionStartupRefusalCode,
  type LauncherExpectation,
  type ReadinessObservation,
  type ReadinessReport,
  type ReadinessStageObservation,
  type RouteObservation,
} from "../../../pi/emission-tool";
import { EMISSION_CONSTRAINED_SAMPLING_REQUEST } from "../../src/core/harness-capture";
import {
  boundDiagnosticMessage,
  canonicalRecord,
  describeUnknown,
  parseContextDigest,
  parseRequestId,
  success,
  type ContextDigest,
} from "../../src/core/orchestration-contract/identity";
import type { PayloadProducerKindName } from "../../src/core/model-profiles";
import loomPiExtension, {
  LOOM_SUBAGENT_LAUNCH_CHANNEL,
  registerPiEmissionLaunchBridge,
  type PiEmissionLaunchExpectation,
  type PiIssuedReviewRouteQualifier,
  type PiSubagentLaunchEventBus,
  type PiSubagentLaunchSlot,
} from "../../../pi/extension";
import { buildReviewerContextPacket, encodeByteSection } from "../../src/core/context-packets";
import { prepareFreshStandaloneReview } from "../../src/core/standalone-review";
import { createRunDirectory, openRegisteredRunDirectory } from "../../src/orchestration/run-directory-handle";
import { RUN_DIR_ENV, RUNS_ROOT_ENV } from "../../src/orchestration/harness-capture-runtime";
import {
  parsedAuthority,
  publishReviewInitialBatch,
  renderReviewProgramSpawnTask,
  standaloneRequestId,
  type RegisteredStandaloneProgram,
} from "../../src/handlers/helpers/programs/helpers";
import { standaloneFixtureRegistration } from "../fixtures/standalone-reviewer-protocol";
import { fixtureSession, withFixturePiSession } from "../fixtures/pi-session";

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
// The imperative shell: counting provider substitute + real pi RPC child
// ---------------------------------------------------------------------------

const READINESS_COMMAND_NAME = "loom-emission-readiness";
const READINESS_ENTRY_TYPE = "loom-emission-readiness";
const HOLD_ENTRY_TYPE = "loom-emission-hold";
const CURRENT_REVISION = "loom-emission-rev-t4-current";
const STALE_REVISION = "loom-emission-rev-t4-stale-000";

const STATE_TIMEOUT_MS = 8_000;
// The installed launcher's bounded startup window is 45s: a cold real Pi
// child can spend over 20s loading Loom under the parallel project suite.
// Only the initial get_state channel check earns this budget; every later RPC
// operation keeps its shorter bound, so a hung readiness command still refuses.
const CHANNEL_STARTUP_TIMEOUT_MS = 45_000;
const PRODUCTION_STATE_TIMEOUT_MS = 20_000;
const READY_TIMEOUT_MS = 2_500;
/** Budget for the launcher's route-bind settle wait (10 attempts × 300ms).
 *  Deliberately far below the step timeouts: settling the model registry is a
 *  sub-second property of a healthy child; the bound exists so a genuinely
 *  absent model still fails closed on the bind refusal itself, never a hang. */
const BIND_SETTLE_BACKOFF_MS = 300;
const HOLD_RESOLVE_TIMEOUT_MS = 6_000;
const FIRST_REQUEST_TIMEOUT_MS = 6_000;
// The real production extension can finish the resumed RPC prompt before its
// provider request is scheduled, and under full-suite load the scheduled
// request itself can wait on the saturated worker pool — one real gate start
// observed this wait exceed 30s. Keep the larger budget local to that one
// hold-release observation; the test's own timeout override covers the wait.
const PRODUCTION_HOLD_FIRST_REQUEST_TIMEOUT_MS = 60_000;
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
type CountedRequest = Readonly<{ at: number; url: string; bytes: number; body: string }>;

type CountingServer = Readonly<{
  baseUrl: string;
  hits: CountedRequest[];
  firstRequest: Promise<CountedRequest>;
  close: () => Promise<void>;
}>;

/** The counting provider substitute (the committed probe's server, verbatim
 *  behavior): counts every completions POST and rejects it — the count is the
 *  evidence, the rejection bounds the run, and no real model is involved. */
const startCountingServer = (): Promise<CountingServer> => {
  const hits: CountedRequest[] = [];
  let resolveFirstRequest!: (request: CountedRequest) => void;
  const firstRequest = new Promise<CountedRequest>((resolve) => {
    resolveFirstRequest = resolve;
  });
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      if (request.method === "POST" && (request.url ?? "").startsWith("/v1/chat/completions")) {
        const countedRequest = canonicalRecord({
          at: Date.now(),
          url: request.url ?? "",
          bytes: body.length,
          body,
        });
        hits.push(countedRequest);
        if (hits.length === 1) resolveFirstRequest(countedRequest);
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
        firstRequest,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        },
      });
    });
  });
};

/** Await the counting server's actual first-request event. Timeout remains an
 * explicit refusal with the caller's current RPC/stderr observations. */
const awaitFirstCountedRequest = async (
  server: CountingServer,
  timeoutMs: number,
  diagnostic: () => string,
): Promise<CountedRequest> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      server.firstRequest,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          `no counted model request arrived within ${timeoutMs}ms; ${boundDiagnosticMessage(diagnostic())}`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
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
  if (VARIANT === "no-provider") {
    // The route-bind-absent control: an honestly matching readiness payload
    // about a child that never registered the constrained provider — the
    // gate's fail-closed bind must refuse before any prompt.
  } else {
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
  }
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
type RpcEvent = Readonly<{ type: string; receivedAt: number } & Record<string, unknown>>;

type RpcBus = Readonly<{
  waitFor: (predicate: (event: RpcEvent) => boolean, timeoutMs: number, label: string) => Promise<RpcEvent>;
  failAll: (reason: string) => void;
  /** Frozen copy of every event collected so far — the production scenarios
   *  count multiple identical readiness entries and hold markers, which a
   *  one-shot waitFor cannot express. Additive to the probe's bus. */
  snapshot: () => readonly RpcEvent[];
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
        events.push({ type: "__non_json__", line: line.slice(0, 160), receivedAt: Date.now() });
        continue;
      }
      const record = recordOf(parsed);
      if (record === null) {
        events.push({ type: "__non_json__", line: line.slice(0, 160), receivedAt: Date.now() });
        continue;
      }
      const event: RpcEvent = { ...record, type: typeof record["type"] === "string" ? record["type"] : "__untyped__", receivedAt: Date.now() };
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
    snapshot: (): readonly RpcEvent[] => Object.freeze([...events]),
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

/**
 * The launcher's fail-closed route bind, settle-aware (both barrier runners
 * share it). pi marks an extension-registered model available synchronously
 * at registerProvider, then the availability refresh it queues recomputes
 * configuredProviders from per-provider auth checks and can transiently drop
 * the extension provider — under parallel suite load the launcher's bind can
 * land inside that settle window even though the readiness entry (appended
 * after registration) was already observed. The bind therefore waits for the
 * model registry to settle, retrying ONLY the registry's own "Model not
 * found" refusal — a registry-settling signal about the ROUTE, never a gate
 * semantic; every other refusal fails closed on its first observation, and a
 * child that dies mid-bind throws as infrastructure. Bounded at 10 × 300ms:
 * a genuinely absent model still refuses on the bind itself, never a hang.
 */
const bindRouteWithSettle = async (
  rpcRequest: (message: Record<string, unknown>, label: string) => Promise<RpcEvent>,
  route: LauncherExpectation["route"],
): Promise<RouteObservation> => {
  let setModel: RpcEvent | null = null;
  for (let bindAttempt = 0; bindAttempt < 10; bindAttempt++) {
    if (bindAttempt > 0) await sleep(BIND_SETTLE_BACKOFF_MS);
    const bind = await rpcRequest(
      { type: "set_model", provider: route.provider, modelId: route.modelId },
      "set_model route binding",
    );
    setModel = bind;
    const bindError = typeof bind["error"] === "string" ? bind["error"] : "";
    if (bind["success"] === true || !bindError.includes("Model not found")) break;
  }
  if (setModel === null) {
    return canonicalRecord({ kind: "failed" as const, reason: "the route bind produced no observation" });
  }
  if (setModel["success"] !== true) {
    return canonicalRecord({ kind: "failed" as const, reason: `set_model refused: ${boundedEvent(setModel)}` });
  }
  const model = recordOf(setModel["data"]);
  return model === null
    ? canonicalRecord({ kind: "failed" as const, reason: "set_model returned no model record" })
    : canonicalRecord({
        kind: "bound" as const,
        model: canonicalRecord({
          provider: stringifyUnknown(model["provider"]),
          id: stringifyUnknown(model["id"]),
          api: stringifyUnknown(model["api"]),
          baseUrl: stringifyUnknown(model["baseUrl"]),
        }),
      });
};

type ChildVariant = "matching" | "held" | "wrong-digest" | "malformed" | "silent" | "stale-extension" | "slow" | "no-provider";

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
  /** The tool name the child registers the FROZEN schema under — the drift
   *  surface for tool-name-mismatch through the real protocol. */
  childToolName?: string;
  /** The base URL the CHILD registers the constrained provider under — the
   *  drift surface for the live fail-closed route bind (defaults to the
   *  launcher's own counting server). */
  childCountBaseUrl?: string;
  /** The real spawn-time --tools allowlist (the honest-inactive control). */
  allowlist?: readonly string[];
  spawnChildExtension?: boolean;
  /** Cancel the barrier mid-readiness-wait (the cancellation control). */
  cancelAfterMs?: number;
  /** How long the SLOW variant delays its readiness report — the
   *  bounded-observation control delays it PAST the READY_TIMEOUT_MS window
   *  so the late entry lands while the launcher's release is held. */
  readinessDelayMs?: number;
  /** SIGKILL the child this many ms AFTER the readiness command was invoked
   *  (and before the bounded readiness window closes) — the
   *  infrastructure-failure boundary control. */
  killChildAfterReadinessInvocationMs?: number;
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
  env["EMISSION_STARTUP_TOOL_NAME"] = spec.childToolName ?? childCell.toolName;
  env["EMISSION_STARTUP_SCHEMA"] = childCell.schemaBytes;
  env["EMISSION_STARTUP_STALE_SCHEMA"] = spec.variant === "wrong-digest" ? staleSchemaBytes(childCell.schemaBytes) : "";
  env["EMISSION_STARTUP_CHILD_BINDING"] = JSON.stringify(childBinding);
  env["EMISSION_STARTUP_COUNT_BASE_URL"] = spec.childCountBaseUrl ?? server.baseUrl;
  env["EMISSION_STARTUP_COUNT_KEY"] = "loom-counting-key";
  env["EMISSION_STARTUP_HOLD_MS"] = String(HOLD_MS);
  env["EMISSION_STARTUP_SLOW_READINESS_MS"] = spec.variant === "slow" ? String(spec.readinessDelayMs ?? SLOW_READINESS_MS) : "0";
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
  /** Readiness entries that arrived AFTER the gate decision — the bounded-
   *  observation control proves a late observation cannot reopen a decided
   *  barrier (zero of them may ever induce a prompt or a model request). */
  readinessEntriesAfterDecision: number;
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
  /** Live view of the run's own counting substitute — read by the rejection
   *  path below so an infrastructure failure still carries its COUNTED
   *  zero-request evidence. */
  const countingHitsRef: { current: readonly CountedRequest[] } = { current: [] };
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
    countingHitsRef.current = server.hits;
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
        return bus.waitFor((event) => event.type === "response" && event["id"] === id,
          label === "get_state" && rpcCallCounter === 1 ? CHANNEL_STARTUP_TIMEOUT_MS : STATE_TIMEOUT_MS, label);
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
        if (spec.killChildAfterReadinessInvocationMs !== undefined) {
          // The infrastructure-failure boundary control: the child dies AFTER
          // a verified invocation, while the launcher's bounded readiness
          // wait is open — the launcher must surface an infrastructure
          // failure, never a minted refusal decision.
          setTimeout(() => releaseChild(), spec.killChildAfterReadinessInvocationMs);
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
      const stageObservation = parseReadinessStageObservation({
        channelAlive,
        channelDiagnostic,
        commandListed,
        readiness,
      });
      const stageDecision = decideReadinessGate(expectation, stageObservation);
      let routeObservation: RouteObservation = canonicalRecord({ kind: "unbound" as const });
      if (stageDecision.kind === "ready") {
        routeObservation = await bindRouteWithSettle(rpcRequest, expectation.route);
      }
      const observation = startupGateObservation(stageObservation, routeObservation);
      const finalDecision = decideEmissionStartup(expectation, observation);
      decisionMade.resolve();
      const decisionAt = Date.now();

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
        readinessEntriesAfterDecision: bus.snapshot()
          .filter(readinessPredicate)
          .filter((event) => event.receivedAt > decisionAt).length,
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
    // Infrastructure failures keep their existing semantics — they propagate
    // as errors, never as minted gate decisions — and they carry the run's
    // own counted model-request snapshot so the zero-request property stays
    // provable on the rejection path too.
    const countedRequests = countingHitsRef.current.length;
    if (error instanceof Error) {
      throw new Error(
        `${error.message} — the counting substitute recorded ${countedRequests} model request(s) before this failure`,
        { cause: error },
      );
    }
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

  const stageOf = (
    facts: Parameters<typeof parseReadinessStageObservation>[0],
  ): ReadinessStageObservation => parseReadinessStageObservation(canonicalRecord(facts));

  const readyStage = (): ReadinessStageObservation => stageOf({
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
      stage: stageOf({ channelAlive: false, channelDiagnostic: "connection refused", commandListed: true, readiness: observedReport() }),
    },
    {
      code: "readiness-command-absent",
      stage: stageOf({ channelAlive: true, channelDiagnostic: null, commandListed: false, readiness: observedReport() }),
    },
    {
      code: "readiness-timeout",
      stage: stageOf({
        channelAlive: true,
        channelDiagnostic: null,
        commandListed: true,
        readiness: canonicalRecord({ kind: "absent" as const, reason: "no readiness entry within 2500ms" }),
      }),
    },
    {
      code: "startup-unavailable",
      stage: stageOf({
        channelAlive: true,
        channelDiagnostic: null,
        commandListed: true,
        readiness: canonicalRecord({ kind: "startup-unavailable" as const, reason: "LOOM_EMISSION_BINDING is missing" }),
      }),
    },
    {
      code: "malformed-readiness",
      stage: stageOf({
        channelAlive: true,
        channelDiagnostic: null,
        commandListed: true,
        readiness: canonicalRecord({ kind: "observed" as const, payload: { emitted: "legacy-shape" } }),
      }),
    },
    { code: "wrong-request", stage: stageOf({ channelAlive: true, channelDiagnostic: null, commandListed: true, readiness: observedReport({ requestId: "req-emission-startup-t4-other-peer-1" }) }) },
    { code: "unexpected-kind", stage: stageOf({ channelAlive: true, channelDiagnostic: null, commandListed: true, readiness: observedReport({ kind: "judge-verdict" }) }) },
    { code: "unexpected-version", stage: stageOf({ channelAlive: true, channelDiagnostic: null, commandListed: true, readiness: observedReport({ version: "v9" }) }) },
    { code: "schema-digest-mismatch", stage: stageOf({ channelAlive: true, channelDiagnostic: null, commandListed: true, readiness: observedReport({ schemaDigest: sha256Hex("stale-bytes") }) }) },
    { code: "tool-name-mismatch", stage: stageOf({ channelAlive: true, channelDiagnostic: null, commandListed: true, readiness: observedReport({ toolName: "loom_emit_refutation_verdict" }) }) },
    { code: "tool-inactive", stage: stageOf({ channelAlive: true, channelDiagnostic: null, commandListed: true, readiness: observedReport({ active: false }) }) },
    { code: "revision-mismatch", stage: stageOf({ channelAlive: true, channelDiagnostic: null, commandListed: true, readiness: observedReport({ revision: STALE_REVISION }) }) },
    {
      code: "cancelled",
      stage: stageOf({
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
      const decision = decideEmissionStartup(
        expectation,
        startupGateObservation(row.stage, verifiedRouteOf(expectation.route)),
      );
      const refusedDecision = asRefused(decision);
      expect(refusedDecision.code, JSON.stringify(row.stage)).toBe(row.code);
      expect(refusedDecision.message, row.code).toContain(EMISSION_STARTUP_REMEDIATIONS[row.code]);
      expect(refusedDecision.remediation, row.code).toBe(EMISSION_STARTUP_REMEDIATIONS[row.code]);
    }
    for (const row of routeRows) {
      const decision = decideEmissionStartup(expectation, startupGateObservation(readyStage(), row.route));
      const refusedDecision = asRefused(decision);
      expect(refusedDecision.code, JSON.stringify(row.route)).toBe("route-bind-refused");
      expect(refusedDecision.message).toContain(EMISSION_STARTUP_REMEDIATIONS["route-bind-refused"]);
    }
  });

  it("the binding check precedes every capability check — a misbound readiness refuses wrong-request first, and each later field speaks only after its predecessors match (FR-014)", () => {
    // The gate's field-comparison order IS the misbinding precedence: a
    // readiness report bound to another request must refuse wrong-request
    // even when EVERY later capability field also mismatches — a child
    // holding another request's readiness is never reclassified by its
    // kind/version/digest/tool/active/revision claims. The remaining rows
    // pin the whole chain: each refusal code appears exactly when its field
    // mismatches and every EARLIER field matched, so no later mismatch can
    // mask a misbinding and no earlier one can mask a capability lie.
    const misboundEverywhere = asRefused(decideEmissionStartup(
      expectation,
      startupGateObservation(
        stageOf({
          channelAlive: true,
          channelDiagnostic: null,
          commandListed: true,
          readiness: observedReport({
            requestId: "req-emission-startup-t4-misbound-peer-1",
            contextDigest: contextDigestOf("emission-startup-context:req-emission-startup-t4-misbound-peer-1"),
            kind: "judge-verdict",
            version: "v9",
            schemaDigest: sha256Hex("misbound-bytes"),
            toolName: "loom_emit_judge_verdict",
            active: false,
            revision: STALE_REVISION,
          }),
        }),
        verifiedRouteOf(expectation.route),
      ),
    ));
    expect(misboundEverywhere.code).toBe("wrong-request");
    expect(misboundEverywhere.message).toContain("req-emission-startup-t4-misbound-peer-1");
    expect(misboundEverywhere.message).toContain("≠ issued");

    const misboundDigestOnly = asRefused(decideEmissionStartup(
      expectation,
      startupGateObservation(
        stageOf({
          channelAlive: true,
          channelDiagnostic: null,
          commandListed: true,
          readiness: observedReport({
            contextDigest: contextDigestOf("emission-startup-context:some-other-request"),
            kind: "judge-verdict",
          }),
        }),
        verifiedRouteOf(expectation.route),
      ),
    ));
    expect(misboundDigestOnly.code).toBe("wrong-request");

    // The successor chain: each row matches every field BEFORE its index and
    // mismatches its own field plus every LATER one — the earliest mismatch
    // must win, every time.
    const chainRows: readonly {
      readonly code: EmissionReadinessRefusalCode;
      readonly overrides: Readonly<Record<string, unknown>>;
    }[] = [
      { code: "unexpected-kind", overrides: { kind: "judge-verdict", version: "v9", schemaDigest: sha256Hex("misbound-bytes"), toolName: "loom_emit_judge_verdict", active: false, revision: STALE_REVISION } },
      { code: "unexpected-version", overrides: { version: "v9", schemaDigest: sha256Hex("misbound-bytes"), toolName: "loom_emit_judge_verdict", active: false, revision: STALE_REVISION } },
      { code: "schema-digest-mismatch", overrides: { schemaDigest: sha256Hex("misbound-bytes"), toolName: "loom_emit_judge_verdict", active: false, revision: STALE_REVISION } },
      { code: "tool-name-mismatch", overrides: { toolName: "loom_emit_refutation_verdict", active: false, revision: STALE_REVISION } },
      { code: "tool-inactive", overrides: { active: false, revision: STALE_REVISION } },
      { code: "revision-mismatch", overrides: { revision: STALE_REVISION } },
    ];
    for (const row of chainRows) {
      const decision = asRefused(decideEmissionStartup(
        expectation,
        startupGateObservation(
          stageOf({
            channelAlive: true,
            channelDiagnostic: null,
            commandListed: true,
            readiness: observedReport(row.overrides),
          }),
          verifiedRouteOf(expectation.route),
        ),
      ));
      expect(decision.code, JSON.stringify(row.overrides)).toBe(row.code);
    }
  });

  it("the gate decision is idempotent — repeated evaluation of the same observation yields the identical decision, and every arm acts consistently", () => {
    for (const row of stageRows) {
      const observation = startupGateObservation(row.stage, verifiedRouteOf(expectation.route));
      const first = decideEmissionStartup(expectation, observation);
      const second = decideEmissionStartup(expectation, observation);
      expect(second, row.code).toEqual(first);
      expect(startupGateAction(first), row.code).toEqual(
        first.kind === "refused" ? { kind: "release-without-prompt" } : { kind: "deliver-prompt" },
      );
    }
    for (const row of routeRows) {
      const observation = startupGateObservation(readyStage(), row.route);
      const first = decideEmissionStartup(expectation, observation);
      const second = decideEmissionStartup(expectation, observation);
      expect(second, JSON.stringify(row.route)).toEqual(first);
      expect(startupGateAction(first)).toEqual({ kind: "release-without-prompt" });
    }
  });

  it("the refusal vocabulary is closed at exactly fourteen codes and both decision arms have exact non-semantic shapes", () => {
    const codes = Object.keys(EMISSION_STARTUP_REMEDIATIONS);
    expect(codes).toHaveLength(14);
    expect(new Set(codes).size).toBe(14);
    for (const code of codes) expect(EMISSION_STARTUP_REMEDIATIONS[code as EmissionStartupRefusalCode].length).toBeGreaterThan(0);

    // The open arm and the refused arm are the ONLY declared union arms; the
    // assertions below pin their runtime shapes. Neither arm carries a payload,
    // source, or attempt field — startup never minted, consumed, or advanced
    // semantic evidence (FR-008).
    const open = asOpen(decideEmissionStartup(
      expectation,
      startupGateObservation(readyStage(), verifiedRouteOf(expectation.route)),
    ));
    expect(startupGateAction(open).kind).toBe("deliver-prompt");
    expect(describeStartupDecision(open)).toContain("open on loom_emit_reviewer_payload");
    expect(Object.keys(open).sort().join(",")).toBe("kind,readiness,route");

    const refusedDecision = asRefused(decideEmissionStartup(
      expectation,
      startupGateObservation(readyStage(), { kind: "unbound" }),
    ));
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

  it("canonicalizes contradictory raw facts with cancelled > unreachable > command-absent precedence", () => {
    const contradictoryRows = [
      {
        facts: {
          channelAlive: false,
          channelDiagnostic: "connection refused",
          commandListed: false,
          readiness: canonicalRecord({ kind: "cancelled" as const }),
        },
        expected: { kind: "cancelled" },
      },
      {
        facts: {
          channelAlive: false,
          channelDiagnostic: "connection refused",
          commandListed: false,
          readiness: observedReport(),
        },
        expected: { kind: "unreachable", diagnostic: "connection refused" },
      },
      {
        facts: {
          channelAlive: true,
          channelDiagnostic: "stale diagnostic",
          commandListed: false,
          readiness: canonicalRecord({ kind: "startup-unavailable" as const, reason: "command failed" }),
        },
        expected: { kind: "command-absent" },
      },
    ] as const;

    for (const { facts, expected } of contradictoryRows) {
      const stage = parseReadinessStageObservation(facts);
      expect(stage).toEqual(expected);
      expect(Object.hasOwn(stage, "channelAlive")).toBe(false);
      expect(Object.hasOwn(stage, "commandListed")).toBe(false);
      expect(Object.hasOwn(stage, "readiness")).toBe(false);
    }
  });

  it("keeps route evidence only on the observed startup arm", () => {
    const route = verifiedRouteOf(expectation.route);
    const refusedStartup = startupGateObservation(stageOf({
      channelAlive: false,
      channelDiagnostic: "connection refused",
      commandListed: true,
      readiness: observedReport(),
    }), route);
    expect(refusedStartup).toEqual({ kind: "unreachable", diagnostic: "connection refused" });
    expect(Object.hasOwn(refusedStartup, "route")).toBe(false);

    const observedStartup = startupGateObservation(readyStage(), route);
    expect(observedStartup.kind).toBe("observed");
    expect(Object.hasOwn(observedStartup, "route")).toBe(true);
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
    const open = asOpen(decideEmissionStartup(
      expectation,
      startupGateObservation(readyStage(), verifiedRouteOf(expectation.route)),
    ));
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

describe(`emission-startup barrier against a real headless pi child on ${piIdentity} — counting-provider substitute`, { timeout: 60_000 }, () => {
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

  it("a child binding the ISSUED request id to a foreign context digest is refused as wrong-request with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("foreign-context-digest", {
      // Same request id, different context digest: the wrong-request bind is
      // BOTH identity fields, and the digest arm is discriminated only when
      // the request-id arm matches — the misbinding precedence through the
      // real protocol, not only at the pure gate.
      childContextDigest: contextDigestOf("emission-startup-context:foreign-digest-seed"),
    }));
    const refusedDecision = expectZeroRequestRefusal(run, "wrong-request");
    expect(run.readinessPayload).not.toBeNull();
    const raw = recordOf(run.readinessPayload);
    expect(raw?.["requestId"]).toBe(run.issuedRequestId);
    expect(raw?.["contextDigest"]).toBe(contextDigestOf("emission-startup-context:foreign-digest-seed"));
    expect(refusedDecision.message).toContain("context digest");
    expect(refusedDecision.message).toContain("≠ issued");
  });

  it("a child loaded at a stale revision is refused with ZERO model requests (AS-020)", async () => {
    const run = await runStartupGate(scenario("stale-revision", { childRevision: STALE_REVISION }));
    const refusedDecision = expectZeroRequestRefusal(run, "revision-mismatch");
    expect(run.readinessPayload).not.toBeNull();
    expect(refusedDecision.message).toContain(STALE_REVISION);
  });

  it("a child registering the FROZEN schema under a drifted tool name — active and digest-matching — is refused with ZERO model requests (AS-020)", async () => {
    const driftedToolName = "loom_emit_reviewer_payload_drifted";
    const run = await runStartupGate(scenario("drifted-tool-name", {
      childToolName: driftedToolName,
      // The drifted tool is genuinely registered AND active: the child is
      // fully functional under the wrong name, so the refusal is purely the
      // exact-tool-name bind, never an inactive-tool accident.
      allowlist: [driftedToolName],
    }));
    const refusedDecision = expectZeroRequestRefusal(run, "tool-name-mismatch");
    expect(run.readinessPayload).not.toBeNull();
    const raw = recordOf(run.readinessPayload);
    expect(raw?.["toolName"]).toBe(driftedToolName);
    expect(raw?.["active"]).toBe(true);
    expect(raw?.["schemaDigest"]).toBe(sha256Hex(REVIEWER_V2_CELL.schemaBytes));
    expect(refusedDecision.message).toContain(driftedToolName);
    expect(refusedDecision.message).toContain(REVIEWER_V2_CELL.toolName);
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

  it("a readiness observation arriving AFTER the bounded window cannot reopen the decided barrier — the launcher releases without prompting on late readiness (FR-008)", async () => {
    // The bounded-observation law through the REAL protocol: the child's
    // readiness entry lands PAST the bounded readiness window, while the
    // launcher's release is still held, so the late observation provably
    // ARRIVES — and provably does nothing. The decided readiness-timeout
    // refusal stands: no prompt, ZERO counted model requests, the child's
    // own reservation released. The counting substitute is the discriminator:
    // an unbounded or reopenable launcher would have prompted on the late
    // entry and produced a counted request.
    const holdRelease = deferred<void>();
    const LATE_DELAY_MS = 4_000;
    const gate = startStartupGate(scenario("late-readiness", {
      variant: "slow",
      readinessDelayMs: LATE_DELAY_MS,
      holdRelease: holdRelease.promise,
    }));
    try {
      await gate.gateDecided;
      // Hold the release past the child's late emission: the bounded window
      // plus the delay plus settling margin — safely inside the runner's
      // HOLD_RELEASE_CAP_MS cap so a lost late entry still settles the run.
      await sleep(LATE_DELAY_MS - READY_TIMEOUT_MS + 1_500);
      holdRelease.resolve();
      const run = await gate.result;
      const refusedDecision = expectZeroRequestRefusal(run, "readiness-timeout");
      // The late entry PROVABLY arrived after the decision — and induced
      // nothing: the in-window payload stayed absent, the refused message
      // names the bounded window, and the counting substitute recorded zero.
      expect(run.readinessEntriesAfterDecision, run.label).toBeGreaterThanOrEqual(1);
      expect(run.readinessPayload, run.label).toBeNull();
      expect(run.invocationCount, run.label).toBe(1);
      expect(refusedDecision.message, run.label).toContain("bounded window");
    } finally {
      holdRelease.resolve();
      await gate.result.catch(() => undefined);
    }
  });

  it("a child provisioned for a stale peer's request AND a different producer kind is refused wrong-request with ZERO model requests — no later capability mismatch reclassifies a misbound child (FR-014)", async () => {
    // The misbinding precedence through the REAL protocol (the pure gate pins
    // the whole chain): a child bound to another request and activated for
    // another kind/version/tool must refuse as wrong-request — its capability
    // mismatch must never mask the misbinding that is the actual failure.
    const staleRequestId = nextRequestId("misbound-peer");
    const run = await runStartupGate(scenario("misbound-everywhere", {
      childCell: JUDGE_V1_CELL,
      childRequestId: staleRequestId,
    }));
    const refusedDecision = expectZeroRequestRefusal(run, "wrong-request");
    expect(run.readinessPayload).not.toBeNull();
    const raw = recordOf(run.readinessPayload);
    expect(raw?.["requestId"]).toBe(staleRequestId);
    expect(raw?.["kind"]).toBe("judge-verdict");
    expect(raw?.["toolName"]).toBe("loom_emit_judge_verdict");
    expect(refusedDecision.message).toContain(staleRequestId);
    expect(refusedDecision.message).toContain(run.issuedRequestId);
    expect(refusedDecision.message).not.toContain("judge-verdict, not the issued");
  });

  it("a child whose bound route drifts from the expected constrained endpoint is refused by the fail-closed bind with ZERO model requests — matching readiness alone never opens the gate (AS-020/AD-4)", async () => {
    // Discriminating only through the REAL protocol: the child registers a
    // live provider and an active, digest-matching tool — every readiness
    // field matches — but under a DRIFTED base URL, so set_model binds a
    // route that is not the issued constrained endpoint. Prompting here
    // would deliver the emission payload to an endpoint the issued binding
    // never certified; the gate must refuse before ANY model request.
    const run = await runStartupGate(scenario("route-bind-drift", { childCountBaseUrl: "http://127.0.0.1:9/v1" }));
    const refusedDecision = expectZeroRequestRefusal(run, "route-bind-refused");
    expect(run.channelAlive, run.label).toBe(true);
    expect(run.commandListed, run.label).toBe(true);
    expect(run.invocationCount, run.label).toBe(1);
    expect(run.readinessPayload, run.label).not.toBeNull();
    expect(refusedDecision.message, run.label).toContain("not the expected constrained route");
    expect(refusedDecision.message, run.label).toContain("http://127.0.0.1:9/v1");
  });

  it("a child with matching readiness but NO registered provider is refused by the bounded route-bind settle with ZERO model requests (AS-020/AD-4)", async () => {
    // The bind itself fails closed: the child emits an honest, fully
    // matching readiness payload, but set_model never finds the constrained
    // model (the child registered no provider), so the settle-bounded bind
    // refuses and the launcher releases without prompting.
    const run = await runStartupGate(scenario("route-bind-absent-provider", { variant: "no-provider" }));
    const refusedDecision = expectZeroRequestRefusal(run, "route-bind-refused");
    expect(run.channelAlive, run.label).toBe(true);
    expect(run.commandListed, run.label).toBe(true);
    expect(run.invocationCount, run.label).toBe(1);
    expect(run.readinessPayload, run.label).not.toBeNull();
    expect(refusedDecision.message, run.label).toContain("set_model refused");
  });

  it("a child that dies mid-readiness is an INFRASTRUCTURE failure — never a minted gate refusal, no remediation vocabulary, ZERO counted model requests (AD-4)", async () => {
    // The refusal ADT is the launcher's decision vocabulary for OBSERVED
    // startup facts. A child that dies while the bounded readiness wait is
    // open is infrastructure: the existing semantics propagate the error —
    // no refusal code, no remediation, no minted decision, no consumed
    // attempt — while the run's own counting substitute still proves that
    // ZERO model requests were sent before the failure.
    const runPromise = runStartupGate(
      scenario("mid-readiness-death", { variant: "slow", killChildAfterReadinessInvocationMs: 300 }),
    );
    await expect(runPromise).rejects.toThrow(/child died during a bounded wait/);
    const failure: unknown = await runPromise.catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("unreachable: the rejection is an Error");
    // NOT a refusal decision: the infrastructure error carries no refusal
    // code, no remediation text and no decision arm — the closed ADT was
    // never minted, and semantic retry authority was never touched.
    expect("code" in failure, failure.message).toBe(false);
    expect("remediation" in failure, failure.message).toBe(false);
    expect("decision" in failure, failure.message).toBe(false);
    // The death is the test's own SIGKILL of a child that had already been
    // invoked, and the counted evidence on the rejection path is ZERO model
    // requests.
    expect(failure.message, failure.message).toContain("signal SIGKILL");
    expect(failure.message, failure.message).toContain("the counting substitute recorded 0 model request(s)");
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

// ---------------------------------------------------------------------------
// T5: the PRODUCTION loom child extension through the real barrier protocol.
// The readiness command, the exact tool registration, the in-child hold and
// the honest readiness payload all come from the loaded production sources
// (pi/extension.ts + pi/emission-tool.ts via -e) in a real headless pi child.
// Only the model transport (the counting substitute) and the constrained
// route's provider registration are infrastructure — the provider substitute
// registers NO emission tool and NO readiness command, so every readiness
// behavior observed here is production behavior (AS-005 negative controls
// through the production path). The stale-launcher drift surfaces live on the
// launcher side (expectation revision, issued request) or on the provisioning
// boundary (absent/garbage binding env), never on production knobs.
// ---------------------------------------------------------------------------

const PRODUCTION_EXTENSION_PATH = join(repoRoot, "pi", "extension.ts");

/** The per-run provider substitute: infrastructure for the gate's
 *  fail-closed route binding, registered at session start — proven to fire in
 *  RPC children (the T4 protocol's set_model binding runs after it). */
const productionProviderExtensionSource = (baseUrl: string): string => `/**
 * Emission-startup suite provider substitute (infrastructure, not under test).
 */
export default function (pi) {
  pi.on("session_start", async () => {
    pi.registerProvider("loom-counting", {
      name: "Loom Counting Provider",
      baseUrl: ${JSON.stringify(baseUrl)},
      apiKey: "$LOOM_EMISSION_STARTUP_PROVIDER_KEY",
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
    return undefined;
  });
}
`;

type ChildProvisioning =
  | Readonly<{ kind: "minted"; cell: RegistryCell; requestId?: string }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "garbage"; raw: string }>;

type ProductionScenarioSpec = Readonly<{
  label: string;
  issuedCell: RegistryCell;
  provisioning?: ChildProvisioning;
  /** The launcher-side expectation's revision — the stale-expectation drift
   *  surface; the production child always reports its true load identity. */
  expectationRevision?: string;
  /** The real spawn-time --tools allowlist (the honest-inactive control). */
  allowlist?: readonly string[];
  doubleInvocation?: boolean;
  deliverPromptOnOpen?: boolean;
  waitForRequest?: boolean;
}>;

type ProductionRun = Readonly<{
  label: string;
  decision: EmissionStartupDecision;
  channelAlive: boolean;
  channelDiagnostic: string | null;
  commandListed: boolean;
  invocationCount: number;
  readinessPayloads: readonly unknown[];
  readinessObservedAt: number | null;
  extensionErrors: readonly Readonly<{ event: string; error: string }>[];
  holdEntries: readonly unknown[];
  prompted: boolean;
  firstRequestAt: number | null;
  requestCount: number;
  requestBodies: readonly string[];
  issuedRequestId: string;
  childPid: number | null;
  countingBaseUrl: string;
  stderr: string;
}>;

/** The launcher-side provisioning the production child receives: the minted
 *  issued binding (registry-certified claims) plus the context digest — the
 *  same record shape a real barrier provisions with. */
const childProvisioningEnv = (
  expectation: LauncherExpectation,
  issuedRequestId: string,
  provisioning: ChildProvisioning,
): string | undefined => {
  if (provisioning.kind === "absent") return undefined;
  if (provisioning.kind === "garbage") return provisioning.raw;
  const requestId = provisioning.requestId ?? issuedRequestId;
  const contextDigest = requestId === issuedRequestId
    ? expectation.contextDigest
    : contextDigestOf(`emission-startup-context:${requestId}`);
  const minted = issueEmissionBinding({
    requestId,
    kind: provisioning.cell.kind,
    version: provisioning.cell.version,
    toolName: provisioning.cell.toolName,
    schemaDigest: sha256Hex(provisioning.cell.schemaBytes),
  });
  if (!minted.ok) {
    throw new Error(`production child provisioning mint refused: ${minted.error.code} — ${minted.error.message}`);
  }
  return JSON.stringify({
    requestId: minted.value.requestId,
    contextDigest,
    kind: minted.value.kind.kind,
    version: minted.value.version,
    toolName: minted.value.toolName,
    schemaDigest: minted.value.schemaDigest,
  });
};

const readinessEntriesOf = (bus: RpcBus): readonly RpcEvent[] => bus.snapshot().filter(readinessPredicate);

const waitReadinessEntryCount = async (bus: RpcBus, count: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (readinessEntriesOf(bus).length < count) {
    if (Date.now() > deadline) {
      throw new Error(`expected ${count} readiness entries, observed ${readinessEntriesOf(bus).length} within ${timeoutMs}ms`);
    }
    await sleep(50);
  }
};

/**
 * The production barrier run: the T4 protocol sequence against a child whose
 * extension IS the production loom extension. Every step is bounded, and the
 * child is released in every outcome.
 */
const runProductionGate = async (spec: ProductionScenarioSpec): Promise<ProductionRun> => {
  const childRef: { current: ChildProcess | null } = { current: null };
  const releasedRef: { current: boolean } = { current: false };
  const releasedAtRef: { current: number | null } = { current: null };
  const releaseChild = (): void => {
    const child = childRef.current;
    if (child === null || releasedRef.current) return;
    releasedRef.current = true;
    releasedAtRef.current = Date.now();
    child.kill("SIGKILL");
  };
  let exitSettled: Promise<void> | null = null;
  const server = await startCountingServer();
  const tmp = canonicalTempDir(`loom-emission-startup-t5-${spec.label}-`);
  try {
    const issuedRequestId = nextRequestId(`t5-${spec.label}`);
    const mintedExpectation = makeExpectation(spec.issuedCell, issuedRequestId, server.baseUrl);
    const expectation = canonicalRecord({
      ...mintedExpectation,
      // The launcher's expectation carries the PARENT's content-addressed
      // revision — never the T4 protocol fixture's placeholder string.
      revision: spec.expectationRevision ?? PARENT_RUNTIME_REVISION,
    });
    const provisioning = spec.provisioning ?? canonicalRecord({ kind: "minted" as const, cell: spec.issuedCell });
    const envBinding = childProvisioningEnv(expectation, issuedRequestId, provisioning);
    const provisioningCell = provisioning.kind === "minted" ? provisioning.cell : spec.issuedCell;
    const allowlist = spec.allowlist ?? [provisioningCell.toolName];
    const providerExtPath = join(tmp, "loom-counting-provider.mjs");
    await writeFile(providerExtPath, productionProviderExtensionSource(server.baseUrl), "utf8");
    const args: string[] = ["--mode", "rpc", "--no-session", "-ne", "-e", PRODUCTION_EXTENSION_PATH, "-e", providerExtPath];
    if (allowlist.length > 0) args.push("--tools", allowlist.join(","));
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv["PI_CODING_AGENT"];
    delete childEnv[LOOM_EMISSION_BINDING_ENV];
    if (envBinding !== undefined) childEnv[LOOM_EMISSION_BINDING_ENV] = envBinding;
    childEnv["LOOM_EMISSION_STARTUP_PROVIDER_KEY"] = "loom-counting-key";
    const child = spawn(piBinary.bin, args, { cwd: tmp, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    childRef.current = child;
    exitSettled = new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
    if (child.stdout === null) throw new Error("the production child has no stdout pipe");
    const bus = makeRpcBus(child.stdout);
    let spawnError: Error | null = null;
    let childExited = false;
    child.on("error", (error: Error) => {
      spawnError = error;
      bus.failAll(`the production child process failed: ${error.message}`);
    });
    child.on("exit", (code: number | null, signal: string | null) => {
      childExited = true;
      bus.failAll(`the production child exited (code ${code === null ? "none" : code}, signal ${signal === null ? "none" : signal}) while the launcher was observing it`);
    });
    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    let rpcCallCounter = 0;
    const rpcRequest = async (message: Record<string, unknown>, label: string): Promise<RpcEvent> => {
      const stdin = child.stdin;
      if (stdin === null || !stdin.writable) {
        throw new Error(`the production child's stdin is not writable for ${label}${spawnError === null ? "" : ` (spawn error: ${spawnError.message})`}`);
      }
      const id = `t5-${spec.label}-${++rpcCallCounter}`;
      stdin.write(`${JSON.stringify({ ...message, id })}\n`);
      return bus.waitFor((event) => event.type === "response" && event["id"] === id,
        label === "get_state" && rpcCallCounter === 1 ? CHANNEL_STARTUP_TIMEOUT_MS : PRODUCTION_STATE_TIMEOUT_MS, label);
    };
    const assertChildAliveDuringWait = (error: unknown): void => {
      if (spawnError !== null || childExited) {
        throw new Error(`the production child died during a bounded wait: ${boundedDiagnostic(error)}`);
      }
    };
    const extensionErrorsOf = (): readonly Readonly<{ event: string; error: string }>[] =>
      bus.snapshot()
        .filter((event) => event.type === "extension_error")
        .map((event) => canonicalRecord({ event: stringifyUnknown(event["event"]), error: stringifyUnknown(event["error"]) }));

    // 1. Channel check.
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

    // 2. Discovery — the production command must be REGISTERED before it is
    //    invoked; the launcher never invokes an unverified command.
    let commandListed = false;
    if (channelAlive) {
      const commandsResponse = await rpcRequest({ type: "get_commands" }, "get_commands");
      const data = recordOf(commandsResponse["data"]);
      const rawCommands = data === null ? undefined : data["commands"];
      const commands: readonly unknown[] = Array.isArray(rawCommands) ? rawCommands : [];
      commandListed = commands.some((raw) => {
        const record = recordOf(raw);
        return record !== null && record["name"] === EMISSION_READINESS_COMMAND && record["source"] === "extension";
      });
    }

    // 3. Readiness invocation(s) — the production command registers the exact
    //    tool and appends the bound payload; failures surface as
    //    extension_error events (pi's command-error channel), never as
    //    fabricated payloads.
    let invocationCount = 0;
    let readiness: ReadinessObservation = canonicalRecord({
      kind: "absent" as const,
      reason: "the launcher never reached the readiness stage",
    });
    let readinessObservedAt: number | null = null;
    if (commandListed) {
      invocationCount = 1;
      const first = await rpcRequest({ type: "prompt", message: `/${EMISSION_READINESS_COMMAND}` }, "readiness command invocation");
      if (first["success"] !== true) {
        throw new Error(`the readiness command invocation was refused by the production child: ${boundedEvent(first)}`);
      }
      if (spec.doubleInvocation === true) {
        invocationCount = 2;
        const second = await rpcRequest({ type: "prompt", message: `/${EMISSION_READINESS_COMMAND}` }, "idempotent readiness re-invocation");
        if (second["success"] !== true) {
          throw new Error(`the idempotent readiness re-invocation was refused by the production child: ${boundedEvent(second)}`);
        }
      }
      const outcome = await settleWait(bus.waitFor(readinessPredicate, READY_TIMEOUT_MS, "readiness"));
      if (outcome.kind === "observed") {
        readinessObservedAt = Date.now();
        readiness = canonicalRecord({ kind: "observed" as const, payload: entryDataOf(outcome.event) });
        if (spec.doubleInvocation === true) {
          await waitReadinessEntryCount(bus, 2, READY_TIMEOUT_MS);
        }
      } else {
        assertChildAliveDuringWait(outcome.error);
        const refusalErrors = extensionErrorsOf();
        readiness = refusalErrors.length > 0
          ? canonicalRecord({
              kind: "startup-unavailable" as const,
              reason: refusalErrors[refusalErrors.length - 1]!.error,
            })
          : canonicalRecord({
              kind: "absent" as const,
              reason: `no readiness entry arrived within ${READY_TIMEOUT_MS}ms`,
            });
      }
    }

    // 4. The pure gate decision over the observed protocol facts, then the
    //    fail-closed route binding on a ready child.
    const stageObservation = parseReadinessStageObservation({
      channelAlive,
      channelDiagnostic,
      commandListed,
      readiness,
    });
    const stageDecision = decideReadinessGate(expectation, stageObservation);
    let routeObservation: RouteObservation = canonicalRecord({ kind: "unbound" as const });
    if (stageDecision.kind === "ready") {
      routeObservation = await bindRouteWithSettle(rpcRequest, expectation.route);
    }
    const observation = startupGateObservation(stageObservation, routeObservation);
    const finalDecision = decideEmissionStartup(expectation, observation);

    // 5. Prompt delivery ONLY on the open arm.
    const action = startupGateAction(finalDecision);
    let prompted = false;
    if (action.kind === "deliver-prompt" && spec.deliverPromptOnOpen !== false) {
      await rpcRequest({ type: "set_auto_retry", enabled: false }, "set_auto_retry");
      await rpcRequest(
        { type: "prompt", message: `Emit the issued ${expectation.binding.kind.kind} payload via ${expectation.binding.toolName}.` },
        "prompt delivery",
      );
      prompted = true;
      if (spec.waitForRequest === true) {
        const requestDeadline = Date.now() + FIRST_REQUEST_TIMEOUT_MS;
        while (server.hits.length === 0 && Date.now() < requestDeadline) await sleep(50);
      }
    } else {
      await sleep(REFUSE_GRACE_MS);
    }
    releaseChild();
    await Promise.race([exitSettled, sleep(1500)]);
    const hits = server.hits;
    return canonicalRecord({
      label: spec.label,
      decision: finalDecision,
      channelAlive,
      channelDiagnostic,
      commandListed,
      invocationCount,
      readinessPayloads: Object.freeze(readinessEntriesOf(bus).map((event) => entryDataOf(event))),
      readinessObservedAt,
      extensionErrors: extensionErrorsOf(),
      holdEntries: Object.freeze(
        bus.snapshot()
          .filter((event) => {
            const entry = recordOf(event["entry"]);
            return event.type === "entry_appended" && entry !== null && entry["customType"] === EMISSION_HOLD_ENTRY_TYPE;
          })
          .map((event) => entryDataOf(event)),
      ),
      prompted,
      firstRequestAt: hits.length > 0 ? hits[0]!.at : null,
      requestCount: hits.length,
      requestBodies: Object.freeze(hits.map((hit) => hit.body)),
      issuedRequestId,
      childPid: typeof child.pid === "number" ? child.pid : null,
      countingBaseUrl: server.baseUrl,
      stderr: boundDiagnosticMessage(stderrChunks.join("").trim()),
    });
  } finally {
    releaseChild();
    if (exitSettled !== null) await Promise.race([exitSettled, sleep(1500)]);
    await server.close().catch(() => undefined);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** A stale-launcher prompt delivered before readiness must wedge. The
 *  release variant then performs the readiness exchange against that SAME
 *  child and proves the awaited prompt resumes; refusal variants stay wedged
 *  until their own child is killed. */
type ProductionHoldGateSpec = Readonly<{
  label: string;
  issuedCell: RegistryCell;
  provisioning?: ChildProvisioning;
  releaseThroughReadiness?: boolean;
}>;

type HoldPromptResponse =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "succeeded"; diagnostic: string }>
  | Readonly<{ kind: "refused"; diagnostic: string }>
  | Readonly<{ kind: "transport-failed"; diagnostic: string }>;

const holdPromptResponseOf = (outcome: SettledWait): HoldPromptResponse => {
  if (outcome.kind === "failed") {
    return canonicalRecord({ kind: "transport-failed" as const, diagnostic: boundedDiagnostic(outcome.error) });
  }
  return canonicalRecord({
    kind: outcome.event["success"] === true ? "succeeded" as const : "refused" as const,
    diagnostic: boundedEvent(outcome.event),
  });
};

const runProductionHoldGate = async (spec: ProductionHoldGateSpec): Promise<Readonly<{
  holdPhases: readonly string[];
  childAliveDuringProbe: boolean;
  agentStartCount: number;
  promptResponse: HoldPromptResponse;
  requestCount: number;
  stderr: string;
}>> => {
  const childRef: { current: ChildProcess | null } = { current: null };
  const releaseChild = (): void => {
    const child = childRef.current;
    if (child === null) return;
    child.kill("SIGKILL");
  };
  const HOLD_PROBE_WINDOW_MS = 2_500;
  let exitSettled: Promise<void> | null = null;
  const server = await startCountingServer();
  const tmp = canonicalTempDir(`loom-emission-startup-t5-${spec.label}-`);
  try {
    const issuedRequestId = nextRequestId(`t5-${spec.label}`);
    const expectation = makeExpectation(spec.issuedCell, issuedRequestId, server.baseUrl);
    const provisioning = spec.provisioning ?? canonicalRecord({ kind: "minted" as const, cell: spec.issuedCell });
    const envBinding = childProvisioningEnv(expectation, issuedRequestId, provisioning);
    const providerExtPath = join(tmp, "loom-counting-provider.mjs");
    await writeFile(providerExtPath, productionProviderExtensionSource(server.baseUrl), "utf8");
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv["PI_CODING_AGENT"];
    delete childEnv[LOOM_EMISSION_BINDING_ENV];
    if (envBinding === undefined) throw new Error("the hold control's provisioning env is absent");
    childEnv[LOOM_EMISSION_BINDING_ENV] = envBinding;
    childEnv["LOOM_EMISSION_STARTUP_PROVIDER_KEY"] = "loom-counting-key";
    const child = spawn(
      piBinary.bin,
      ["--mode", "rpc", "--no-session", "-ne", "-e", PRODUCTION_EXTENSION_PATH, "-e", providerExtPath, "--tools", spec.issuedCell.toolName],
      { cwd: tmp, env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
    );
    childRef.current = child;
    exitSettled = new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
    if (child.stdout === null) throw new Error("the production child has no stdout pipe");
    const bus = makeRpcBus(child.stdout);
    let spawnError: Error | null = null;
    let childExited = false;
    child.on("error", (error: Error) => {
      spawnError = error;
      bus.failAll(`the production child process failed: ${error.message}`);
    });
    child.on("exit", () => {
      childExited = true;
      bus.failAll("the production child exited while the launcher was observing it");
    });
    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));
    let rpcCallCounter = 0;
    const rpcRequest = (message: Record<string, unknown>): Promise<RpcEvent> => {
      const id = `t5-hold-${spec.label}-${++rpcCallCounter}`;
      const stdin = child.stdin;
      if (stdin === null || !stdin.writable) throw new Error("the production hold child's stdin is not writable");
      stdin.write(`${JSON.stringify({ ...message, id })}\n`);
      return bus.waitFor((event) => event.type === "response" && event["id"] === id,
        message.type === "get_state" && rpcCallCounter === 1 ? CHANNEL_STARTUP_TIMEOUT_MS : PRODUCTION_STATE_TIMEOUT_MS, "rpc");
    };
    await rpcRequest({ type: "get_state" });
    // The stale launcher binds the route and delivers the prompt WITHOUT a
    // readiness exchange. Keep the request live so the release variant can
    // prove this exact awaited prompt resumes after readiness.
    await rpcRequest({ type: "set_model", provider: expectation.route.provider, modelId: expectation.route.modelId });
    await rpcRequest({ type: "set_auto_retry", enabled: false });
    let promptResponse: HoldPromptResponse = canonicalRecord({ kind: "pending" as const });
    const promptOutcome = settleWait(rpcRequest({
      type: "prompt",
      message: `Emit the issued ${expectation.binding.kind.kind} payload via ${expectation.binding.toolName}.`,
    })).then((outcome) => {
      promptResponse = holdPromptResponseOf(outcome);
      return outcome;
    });
    await sleep(HOLD_PROBE_WINDOW_MS);
    if (spawnError !== null || childExited) {
      throw new Error("the production hold child died or failed to spawn inside the probe window");
    }
    const promptResponseBeforeReadiness: HoldPromptResponse = promptResponse;
    if (spec.releaseThroughReadiness === true) {
      const readinessResponse = await rpcRequest({ type: "prompt", message: `/${EMISSION_READINESS_COMMAND}` });
      if (readinessResponse["success"] !== true) {
        throw new Error(`the hold-release readiness command failed: ${boundedEvent(readinessResponse)}`);
      }
      // The early binding above intentionally models a stale launcher. The
      // provider registry can refresh while readiness registers the tool;
      // mirror the real launcher's post-readiness bind before requiring the
      // first model request from this already-wedged prompt. Otherwise a
      // refreshed default model can receive it instead of the counting route.
      const rebound = await bindRouteWithSettle((message) => rpcRequest(message), expectation.route);
      if (rebound.kind !== "bound" || rebound.model.provider !== expectation.route.provider ||
          rebound.model.id !== expectation.route.modelId) {
        throw new Error(`the hold-release route was not rebound after readiness: ${JSON.stringify(rebound)}`);
      }
      const resumed = await promptOutcome;
      const stderr = boundDiagnosticMessage(stderrChunks.join("").trim());
      if (resumed.kind === "failed") {
        throw new Error(`the wedged prompt did not resume: ${boundedDiagnostic(resumed.error)}; stderr: ${stderr}`);
      }
      if (resumed.event["success"] !== true) {
        throw new Error(`the resumed prompt response was refused: ${boundedEvent(resumed.event)}; stderr: ${stderr}`);
      }
      await awaitFirstCountedRequest(
        server,
        PRODUCTION_HOLD_FIRST_REQUEST_TIMEOUT_MS,
        () => `prompt response: ${JSON.stringify(promptResponse)}; stderr: ${stderrChunks.join("").trim()}`,
      );
    }
    await sleep(400);
    if (spawnError !== null || childExited) {
      throw new Error("the production hold child died or failed to spawn before the probe completed");
    }
    const holdEntries = bus.snapshot()
      .filter((event) => {
        const entry = recordOf(event["entry"]);
        return event.type === "entry_appended" && entry !== null && entry["customType"] === EMISSION_HOLD_ENTRY_TYPE;
      })
      .map((event) => recordOf(entryDataOf(event)))
      .filter((data): data is Record<string, unknown> => data !== null);
    const holdPhases = holdEntries
      .map((data) => data["phase"])
      .filter((phase): phase is string => typeof phase === "string");
    releaseChild();
    await Promise.race([exitSettled, sleep(1500)]);
    return canonicalRecord({
      holdPhases: Object.freeze(holdPhases),
      childAliveDuringProbe: true,
      agentStartCount: bus.snapshot().filter((event) => event.type === "agent_start").length,
      promptResponse: spec.releaseThroughReadiness === true ? promptResponse : promptResponseBeforeReadiness,
      requestCount: server.hits.length,
      stderr: boundDiagnosticMessage(stderrChunks.join("").trim()),
    });
  } finally {
    releaseChild();
    if (exitSettled !== null) await Promise.race([exitSettled, sleep(1500)]);
    await server.close().catch(() => undefined);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
};

const productionScenario = (label: string, overrides: Partial<Omit<ProductionScenarioSpec, "label">> = {}): ProductionScenarioSpec => ({
  label,
  issuedCell: REVIEWER_V2_CELL,
  ...overrides,
});

/** The parent-side content-addressed runtime identity: the revision the
 *  launcher (the expectation mint) holds. The production child computes the
 *  same identity from the same sources at its own load — the equality is the
 *  FR-031 handshake the readiness report is checked against. */
const PARENT_RUNTIME_REVISION = captureLoomRuntimeIdentity(repoRoot).revision;

const productionOrderingPair = (run: ProductionRun): { readonly firstRequestAt: number; readonly readinessObservedAt: number } => {
  if (run.firstRequestAt === null || run.readinessObservedAt === null) {
    throw new Error(`[${run.label}] missing ordering timestamps (first=${run.firstRequestAt}, readiness=${run.readinessObservedAt})`);
  }
  return { firstRequestAt: run.firstRequestAt, readinessObservedAt: run.readinessObservedAt };
};

const expectOpenProductionRun = (run: ProductionRun): OpenDecision => {
  try {
    return asOpen(run.decision);
  } catch (error) {
    throw new Error(`[${run.label}] ${(error as Error).message}; stderr: ${run.stderr}`);
  }
};

/** The production negative-control assertion: the decision refused with
 *  exactly the expected code, the message names its remediation, the launcher
 *  never prompted, ZERO model requests reached the counting substitute. */
const expectZeroRequestProductionRefusal = (
  run: ProductionRun,
  code: EmissionStartupRefusalCode,
): RefusedDecision => {
  let refusedDecision: RefusedDecision;
  try {
    refusedDecision = asRefused(run.decision);
  } catch (error) {
    throw new Error(`[${run.label}] ${(error as Error).message}; stderr: ${run.stderr}`);
  }
  expect(refusedDecision.code, run.label).toBe(code);
  expect(refusedDecision.message, run.label).toContain(EMISSION_STARTUP_REMEDIATIONS[code]);
  expect(run.prompted, run.label).toBe(false);
  expect(run.requestCount, run.label).toBe(0);
  expect(run.firstRequestAt, run.label).toBeNull();
  return refusedDecision;
};

const asProvisionedPayload = (run: ProductionRun, index = 0): ReadinessReport => {
  const payload = run.readinessPayloads[index];
  if (payload === undefined) throw new Error(`[${run.label}] no readiness payload at index ${index}`);
  const parsed = parseReadinessReport(payload);
  if (!parsed.ok) throw new Error(`[${run.label}] the production readiness payload violates its contract: ${parsed.error.reason}`);
  return parsed.value;
};

type FakeExtensionHandler = (...args: readonly unknown[]) => unknown;

class NoEventBusFakePi {
  readonly handlers = new Map<string, FakeExtensionHandler[]>();
  readonly commands = new Map<string, Readonly<{ handler: FakeExtensionHandler }>>();
  readonly tools = new Map<string, Readonly<{ name: string }>>();

  on(event: string, handler: FakeExtensionHandler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  registerCommand(name: string, command: Readonly<{ handler: FakeExtensionHandler }>): void {
    this.commands.set(name, command);
  }

  registerTool(tool: Readonly<{ name: string }>): void {
    this.tools.set(tool.name, tool);
  }

  appendEntry(): void {}

  getActiveTools(): readonly string[] {
    return Object.freeze([...this.tools.keys()]);
  }

  getAllTools(): readonly Readonly<{ name: string }>[] {
    return Object.freeze([...this.tools.values()]);
  }
}

class SynchronousEventBus {
  readonly handlers = new Map<string, ((event: unknown) => void)[]>();

  on(channel: string, handler: (event: unknown) => void): () => void {
    this.handlers.set(channel, [...(this.handlers.get(channel) ?? []), handler]);
    return () => {
      this.handlers.set(channel, (this.handlers.get(channel) ?? []).filter((candidate) => candidate !== handler));
    };
  }

  emit(channel: string, event: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(event);
  }
}

const advertiseInstalledLaunchPort = (events: SynchronousEventBus): (() => void) =>
  events.on(LOOM_SUBAGENT_LAUNCH_CHANNEL, (event) => {
    const probe = recordOf(event);
    if (probe !== null && probe["kind"] === "capability" && probe["version"] === 2 &&
        typeof probe["respond"] === "function") {
      probe["respond"]({ kind: "available", version: 2 });
    }
  });

const bridgeLaunchExpectation = (
  cell: RegistryCell,
  toolCallId: string,
  slot: PiSubagentLaunchSlot,
  task?: string,
): PiEmissionLaunchExpectation => {
  const binding = issueEmissionBinding({
    requestId: `req-installed-launch-${toolCallId.replace(/[^a-z0-9-]/g, "-")}`,
    kind: cell.kind,
    version: cell.version,
  });
  if (!binding.ok) throw new Error(binding.error.message);
  const contextDigest = contextDigestOf(`installed-launch:${toolCallId}:${slot.kind}:${slot.index}`);
  return Object.freeze({
    sessionId: "01a0e4b3-c4c1-7b63-916d-f5d41d2b5a00",
    toolCallId,
    slot,
    agent: "code-reviewer",
    task: task ?? `${renderEmissionDescriptor(binding.value, contextDigest)}Review the issued packet.`,
    cwd: resolve(repoRoot),
    expectation: Object.freeze({
      kind: "emission-enabled" as const,
      binding: binding.value,
      contextDigest,
      route: Object.freeze({
        provider: "desktop-vllm",
        model: "glm-5.3-flash-spark-tp2-v14",
      }),
    }),
    revision: "sha256:installed-launch-runtime",
  });
};

const launchResolveEnvelope = (
  launch: PiEmissionLaunchExpectation,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => {
  const replies: unknown[] = [];
  return {
    kind: "resolve",
    sessionId: launch.sessionId,
    toolCallId: launch.toolCallId,
    slot: launch.slot,
    agent: launch.agent,
    task: launch.task,
    cwd: launch.cwd,
    effectiveModel: {
      provider: launch.expectation.route.provider,
      id: launch.expectation.route.model,
    },
    respond: (reply: unknown) => { replies.push(reply); },
    get reply(): unknown { return replies.at(-1) ?? { kind: "not-admitted" }; },
    get replyCount(): number { return replies.length; },
    ...overrides,
  };
};

describe("the parent emission adapter over the installed synchronous launch port", () => {
  it("keeps ordinary extension initialization available when the event bus is absent and reports the launcher unavailable", () => {
    const bridge = registerPiEmissionLaunchBridge(undefined);
    expect(bridge.probe()).toEqual({ kind: "unavailable", reason: "this Pi runtime exposes no extension event bus" });
    expect(bridge.stage([
      bridgeLaunchExpectation(REVIEWER_V2_CELL, "tool-call-no-event-bus", { kind: "single", index: 0 }),
    ])).toEqual({
      ok: false,
      reason: "Emission launch unavailable: this Pi runtime exposes no extension event bus",
    });
    expect(() => {
      bridge.removeToolCall("01a0e4b3-c4c1-7b63-916d-f5d41d2b5a00", "tool-call-no-event-bus");
      bridge.removeSession("01a0e4b3-c4c1-7b63-916d-f5d41d2b5a00");
    }).not.toThrow();

    const previousBinding = process.env[LOOM_EMISSION_BINDING_ENV];
    delete process.env[LOOM_EMISSION_BINDING_ENV];
    try {
      const pi = new NoEventBusFakePi();
      expect(() => loomPiExtension(pi as never, () => Object.freeze([]))).not.toThrow();
      expect(pi.handlers.has("tool_call")).toBe(true);
      expect(pi.commands.has(EMISSION_READINESS_COMMAND)).toBe(true);
    } finally {
      if (previousBinding === undefined) delete process.env[LOOM_EMISSION_BINDING_ENV];
      else process.env[LOOM_EMISSION_BINDING_ENV] = previousBinding;
    }
  });

  it("fails its synchronous capability probe closed when the installed launcher is missing", () => {
    const bus = new SynchronousEventBus();
    const bridge = registerPiEmissionLaunchBridge(bus as PiSubagentLaunchEventBus);
    expect(bridge.probe()).toMatchObject({ kind: "unavailable", reason: expect.stringContaining("does not advertise") });
  });

  it.each([
    { label: "null", reply: null, diagnosis: "received null" },
    { label: "wrong kind", reply: { kind: "ready", version: 2 }, diagnosis: "incompatible kind" },
    { label: "wrong version", reply: { kind: "available", version: 1 }, diagnosis: "incompatible version" },
  ] as const)("diagnoses one malformed $label v2 callback reply as an incompatible launcher", ({ reply, diagnosis }) => {
    const bus = new SynchronousEventBus();
    bus.on(LOOM_SUBAGENT_LAUNCH_CHANNEL, (event) => {
      const probe = recordOf(event);
      if (probe?.["kind"] === "capability" && typeof probe["respond"] === "function") probe["respond"](reply);
    });
    const bridge = registerPiEmissionLaunchBridge(bus as PiSubagentLaunchEventBus);
    const probe = bridge.probe();
    expect(probe.kind).toBe("unavailable");
    if (probe.kind === "unavailable") {
      expect(probe.reason).toContain("incompatible v2 capability response");
      expect(probe.reason).toContain(diagnosis);
      expect(probe.reason).not.toContain("does not advertise");
      expect(Buffer.byteLength(probe.reason, "utf8")).toBeLessThan(1_000);
    }
  });

  it("retains the bounded cause when a present launcher capability probe throws", () => {
    const bus = new SynchronousEventBus();
    bus.on(LOOM_SUBAGENT_LAUNCH_CHANNEL, (event) => {
      if (recordOf(event)?.["kind"] === "capability") throw new Error(`launcher capability crashed ${"x".repeat(10_000)}`);
    });
    const bridge = registerPiEmissionLaunchBridge(bus as PiSubagentLaunchEventBus);
    const probe = bridge.probe();
    expect(probe.kind).toBe("unavailable");
    if (probe.kind === "unavailable") {
      expect(probe.reason).toContain("launcher capability crashed");
      expect(probe.reason).not.toContain("does not advertise");
      expect(Buffer.byteLength(probe.reason, "utf8")).toBeLessThan(1_000);
    }
  });

  it("binds single, parallel, and chain slots only on the exact call/slot/agent/cwd/route/task tuple", () => {
    const bus = new SynchronousEventBus();
    advertiseInstalledLaunchPort(bus);
    const bridge = registerPiEmissionLaunchBridge(bus as PiSubagentLaunchEventBus);
    expect(bridge.probe()).toEqual({ kind: "available" });
    advertiseInstalledLaunchPort(bus);
    expect(bridge.probe()).toMatchObject({ kind: "unavailable", reason: expect.stringContaining("multiple launcher capabilities") });
    // Remove duplicate advertisement for the exact launch checks below.
    const handlers = bus.handlers.get(LOOM_SUBAGENT_LAUNCH_CHANNEL)!;
    bus.handlers.set(LOOM_SUBAGENT_LAUNCH_CHANNEL, handlers.slice(0, -1));

    const launches = [
      bridgeLaunchExpectation(REVIEWER_V2_CELL, "tool-call-single", { kind: "single", index: 0 }),
      bridgeLaunchExpectation(REVIEWER_V2_CELL, "tool-call-batch", { kind: "parallel", index: 1 }),
      bridgeLaunchExpectation(REVIEWER_V2_CELL, "tool-call-batch", { kind: "chain", index: 2 }),
    ] as const;
    expect(bridge.stage(launches)).toEqual({ ok: true });

    for (const launch of launches) {
      const wrongEnvelopes = [
        launchResolveEnvelope(launch, { sessionId: "01a0e4b3-c4c1-7b63-916d-f5d41d2b5aff" }),
        launchResolveEnvelope(launch, { toolCallId: `${launch.toolCallId}-wrong` }),
        launchResolveEnvelope(launch, { slot: { kind: launch.slot.kind, index: launch.slot.index + 1 } }),
        launchResolveEnvelope(launch, { agent: "code-simplifier" }),
        launchResolveEnvelope(launch, { cwd: `${launch.cwd}/other` }),
        launchResolveEnvelope(launch, { task: `${launch.task}\nsubstituted` }),
        launchResolveEnvelope(launch, { effectiveModel: { provider: "openai-codex", id: "gpt-6-sol" } }),
      ];
      for (const [index, envelope] of wrongEnvelopes.entries()) {
        bus.emit(LOOM_SUBAGENT_LAUNCH_CHANNEL, envelope);
        expect(envelope["reply"], JSON.stringify(envelope)).toMatchObject({
          kind: index < 3 ? "not-admitted" : "refused",
        });
      }

      const exact = launchResolveEnvelope(launch);
      bus.emit(LOOM_SUBAGENT_LAUNCH_CHANNEL, exact);
      expect(exact["replyCount"]).toBe(1);
      expect(exact["reply"]).toMatchObject({
        kind: "emission-rpc",
        directive: {
          kind: "emission-rpc",
          expectedProvider: launch.expectation.route.provider,
          expectedModel: launch.expectation.route.model,
          expectedToolName: launch.expectation.binding.toolName,
        },
      });
      const reply = exact["reply"] as { kind: string; directive: { bindingEnv: string } };
      expect(JSON.parse(reply.directive.bindingEnv)).toEqual({
        requestId: launch.expectation.binding.requestId,
        contextDigest: launch.expectation.contextDigest,
        kind: launch.expectation.binding.kind.kind,
        version: launch.expectation.binding.version,
        toolName: launch.expectation.binding.toolName,
        schemaDigest: launch.expectation.binding.schemaDigest,
      });
    }
  });

  it("consumes only the exact matched launch slot, rejecting replay without disturbing a parallel sibling", () => {
    const bus = new SynchronousEventBus();
    advertiseInstalledLaunchPort(bus);
    const bridge = registerPiEmissionLaunchBridge(bus as PiSubagentLaunchEventBus);
    const first = bridgeLaunchExpectation(REVIEWER_V2_CELL, "tool-call-one-shot", { kind: "parallel", index: 0 });
    const sibling = bridgeLaunchExpectation(REVIEWER_V2_CELL, "tool-call-one-shot", { kind: "parallel", index: 1 });
    expect(bridge.stage([first, sibling])).toEqual({ ok: true });

    const wrongProbe = launchResolveEnvelope(first, { task: `${first.task}\nwrong probe` });
    bus.emit(LOOM_SUBAGENT_LAUNCH_CHANNEL, wrongProbe);
    expect(wrongProbe["reply"]).toMatchObject({ kind: "refused", reason: expect.stringContaining("issued task") });

    const exact = launchResolveEnvelope(first);
    bus.emit(LOOM_SUBAGENT_LAUNCH_CHANNEL, exact);
    expect(exact["reply"]).toMatchObject({ kind: "emission-rpc" });

    const replay = launchResolveEnvelope(first);
    bus.emit(LOOM_SUBAGENT_LAUNCH_CHANNEL, replay);
    expect(replay["reply"]).toEqual({ kind: "not-admitted" });

    const parallelSibling = launchResolveEnvelope(sibling);
    bus.emit(LOOM_SUBAGENT_LAUNCH_CHANNEL, parallelSibling);
    expect(parallelSibling["reply"]).toMatchObject({ kind: "emission-rpc" });
  });

  it.each([
    { label: "missing effectiveModel", overrides: { effectiveModel: undefined } },
    { label: "non-string effectiveModel fields", overrides: { effectiveModel: { provider: 42, id: null } } },
  ] as const)("answers a $label resolve exactly once with the bounded malformed refusal, never an emission-rpc directive", ({ overrides }) => {
    const bus = new SynchronousEventBus();
    advertiseInstalledLaunchPort(bus);
    const bridge = registerPiEmissionLaunchBridge(bus as PiSubagentLaunchEventBus);
    const launch = bridgeLaunchExpectation(REVIEWER_V2_CELL, "tool-call-malformed-resolve", { kind: "single", index: 0 });
    expect(bridge.stage([launch])).toEqual({ ok: true });

    const envelope = launchResolveEnvelope(launch, overrides);
    expect(() => bus.emit(LOOM_SUBAGENT_LAUNCH_CHANNEL, envelope)).not.toThrow();
    expect(envelope["replyCount"]).toBe(1);
    expect(envelope["reply"]).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("staged emission launch resolve is malformed:"),
    });
    const reply = envelope["reply"] as Record<string, unknown>;
    expect(Object.hasOwn(reply, "directive")).toBe(false);
    expect(Buffer.byteLength(String(reply["reason"]), "utf8")).toBeLessThan(500);
  });

  it("verifies command discovery, invokes readiness once, gates every binding field, then binds and observes the exact route", async () => {
    const bus = new SynchronousEventBus();
    advertiseInstalledLaunchPort(bus);
    const bridge = registerPiEmissionLaunchBridge(bus as PiSubagentLaunchEventBus);
    const launch = bridgeLaunchExpectation(JUDGE_V1_CELL, "tool-call-verifier", { kind: "single", index: 0 });
    expect(bridge.stage([launch])).toEqual({ ok: true });
    const envelope = launchResolveEnvelope(launch);
    bus.emit(LOOM_SUBAGENT_LAUNCH_CHANNEL, envelope);
    const reply = envelope["reply"] as {
      kind: string;
      directive?: {
        verifyReadiness: (client: unknown) => Promise<
          Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>
        >;
      };
    };
    if (reply.kind !== "emission-rpc" || reply.directive === undefined) {
      throw new Error("the exact launch did not receive its directive");
    }
    const directive = reply.directive;

    const calls: string[] = [];
    const readiness = {
      requestId: launch.expectation.binding.requestId,
      contextDigest: launch.expectation.contextDigest,
      kind: launch.expectation.binding.kind.kind,
      version: launch.expectation.binding.version,
      toolName: launch.expectation.binding.toolName,
      schemaDigest: launch.expectation.binding.schemaDigest,
      revision: launch.revision,
      active: true,
      childPid: 4242,
      registeredTools: [launch.expectation.binding.toolName],
    };
    const client = {
      getCommands: async () => {
        calls.push("getCommands");
        return [{ name: EMISSION_READINESS_COMMAND, source: "extension" }];
      },
      invokeReadiness: async () => {
        calls.push("invokeReadiness");
        return [{ customType: EMISSION_READINESS_ENTRY_TYPE, data: readiness }];
      },
      setModel: async (provider: string, model: string) => {
        calls.push(`setModel:${provider}/${model}`);
      },
      getState: async () => {
        calls.push("getState");
        return { model: { provider: launch.expectation.route.provider, id: launch.expectation.route.model } };
      },
    };
    expect(await directive.verifyReadiness(client)).toEqual({ ok: true });
    expect(calls).toEqual([
      "getCommands",
      "invokeReadiness",
      `setModel:${launch.expectation.route.provider}/${launch.expectation.route.model}`,
      "getState",
    ]);

    const mismatchCalls: string[] = [];
    const mismatch = await directive.verifyReadiness({
      ...client,
      getCommands: async () => {
        mismatchCalls.push("getCommands");
        return [{ name: EMISSION_READINESS_COMMAND, source: "extension" }];
      },
      invokeReadiness: async () => {
        mismatchCalls.push("invokeReadiness");
        return [{ customType: EMISSION_READINESS_ENTRY_TYPE, data: { ...readiness, schemaDigest: sha256Hex("wrong") } }];
      },
      setModel: async () => {
        mismatchCalls.push("setModel");
      },
      getState: async () => {
        mismatchCalls.push("getState");
        return { model: null };
      },
    });
    expect(mismatch).toMatchObject({ ok: false, reason: expect.stringContaining("schema digest") });
    expect(mismatchCalls).toEqual(["getCommands", "invokeReadiness"]);

    const failingClient = (operation: "getCommands" | "invokeReadiness" | "setModel" | "getState") => ({
      ...client,
      getCommands: async () => {
        if (operation === "getCommands") throw new Error(`rpc ${operation} ${"x".repeat(10_000)}`);
        return [{ name: EMISSION_READINESS_COMMAND, source: "extension" }];
      },
      invokeReadiness: async () => {
        if (operation === "invokeReadiness") throw new Error(`rpc ${operation} ${"x".repeat(10_000)}`);
        return [{ customType: EMISSION_READINESS_ENTRY_TYPE, data: readiness }];
      },
      setModel: async () => {
        if (operation === "setModel") throw new Error(`rpc ${operation} ${"x".repeat(10_000)}`);
      },
      getState: async () => {
        if (operation === "getState") throw new Error(`rpc ${operation} ${"x".repeat(10_000)}`);
        return { model: { provider: launch.expectation.route.provider, id: launch.expectation.route.model } };
      },
    });
    for (const operation of ["getCommands", "invokeReadiness", "setModel", "getState"] as const) {
      const refused = await directive.verifyReadiness(failingClient(operation));
      expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining("failed") });
      if (refused.ok) throw new Error(`${operation} unexpectedly passed`);
      expect(refused.reason).toContain("retry the same issued request");
      expect(Buffer.byteLength(refused.reason, "utf8"), operation).toBeLessThan(2_000);
    }

    for (const [label, malformed, reason] of [
      ["commands-not-array", { getCommands: async () => undefined as never }, "malformed command inventory"],
      ["commands-with-non-record", { getCommands: async () => [null] as never }, "malformed command inventory"],
      ["readiness-entries-not-array", { invokeReadiness: async () => null as never }, "malformed entry list"],
      ["state-not-record", { getState: async () => null as never }, "no exact provider/model record"],
      ["model-not-record", { getState: async () => ({ model: "wrong-shape" }) as never }, "no exact provider/model record"],
    ] as const) {
      const refused = await directive.verifyReadiness({ ...client, ...malformed });
      expect(refused, label).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
    }
    const throwingCommand = Object.defineProperty({}, "name", {
      get: () => { throw new Error(`malformed command getter ${"y".repeat(10_000)}`); },
    });
    const thrownResponse = await directive.verifyReadiness({
      ...client,
      getCommands: async () => [throwingCommand] as never,
    });
    expect(thrownResponse).toMatchObject({ ok: false, reason: expect.stringContaining("malformed command getter") });
    if (!thrownResponse.ok) expect(Buffer.byteLength(thrownResponse.reason, "utf8")).toBeLessThan(2_000);
  });

  it("returns bounded refusals when custom-entry extraction or readiness-payload gate evaluation throws", async () => {
    const bus = new SynchronousEventBus();
    advertiseInstalledLaunchPort(bus);
    const bridge = registerPiEmissionLaunchBridge(bus as PiSubagentLaunchEventBus);
    const launch = bridgeLaunchExpectation(JUDGE_V1_CELL, "tool-call-hostile-readiness", { kind: "single", index: 0 });
    expect(bridge.stage([launch])).toEqual({ ok: true });
    const envelope = launchResolveEnvelope(launch);
    bus.emit(LOOM_SUBAGENT_LAUNCH_CHANNEL, envelope);
    const reply = envelope["reply"] as {
      kind: string;
      directive?: {
        verifyReadiness: (client: unknown) => Promise<
          Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>
        >;
      };
    };
    if (reply.kind !== "emission-rpc" || reply.directive === undefined) {
      throw new Error("the exact launch did not receive its directive");
    }

    const throwingDataEntry = Object.defineProperty(
      { customType: EMISSION_READINESS_ENTRY_TYPE },
      "data",
      { get: () => { throw new Error(`custom entry data accessor failed ${"d".repeat(10_000)}`); } },
    );
    const throwingPayload = new Proxy<Record<string, unknown>>({}, {
      get: () => { throw new Error(`readiness payload accessor failed ${"p".repeat(10_000)}`); },
    });
    for (const [label, entry, diagnostic] of [
      ["entry data", throwingDataEntry, "custom entry data accessor failed"],
      ["readiness payload", { customType: EMISSION_READINESS_ENTRY_TYPE, data: throwingPayload }, "readiness payload accessor failed"],
    ] as const) {
      const setModel = vi.fn();
      const getState = vi.fn();
      const result = await reply.directive.verifyReadiness({
        getCommands: async () => [{ name: EMISSION_READINESS_COMMAND, source: "extension" }],
        invokeReadiness: async () => [entry],
        setModel,
        getState,
      });
      expect(result.ok, label).toBe(false);
      if (result.ok) throw new Error(`${label} unexpectedly passed`);
      expect(result.reason, label).toContain("Emission readiness RPC invoke_readiness response failed");
      expect(result.reason, label).toContain(diagnostic);
      expect(Buffer.byteLength(result.reason, "utf8"), label).toBeLessThan(2_000);
      expect(setModel, label).not.toHaveBeenCalled();
      expect(getState, label).not.toHaveBeenCalled();
    }
  });

  it("retains capabilities until exact tool-result/session cleanup, allowing a fresh retry after refusal", () => {
    const bus = new SynchronousEventBus();
    advertiseInstalledLaunchPort(bus);
    const bridge = registerPiEmissionLaunchBridge(bus as PiSubagentLaunchEventBus);
    const first = bridgeLaunchExpectation(REVIEWER_V2_CELL, "tool-call-cleanup-a", { kind: "single", index: 0 });
    const sibling = bridgeLaunchExpectation(REVIEWER_V2_CELL, "tool-call-cleanup-b", { kind: "single", index: 0 });
    expect(bridge.stage([first, sibling])).toEqual({ ok: true });
    expect(bridge.stage([first])).toMatchObject({ ok: false });

    bridge.removeToolCall(first.sessionId, first.toolCallId);
    expect(bridge.stage([first])).toEqual({ ok: true });
    bridge.removeSession(first.sessionId);
    for (const launch of [first, sibling]) {
      const envelope = launchResolveEnvelope(launch);
      bus.emit(LOOM_SUBAGENT_LAUNCH_CHANNEL, envelope);
      expect(envelope["reply"]).toEqual({ kind: "not-admitted" });
    }
  });
});

const fixtureValue = <T, E>(
  result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: E }>,
): T => {
  if (!result.ok) throw new Error(`fixture refused: ${JSON.stringify(result.error)}`);
  return result.value;
};

type PublishedParentSpawnFixture = Readonly<{
  root: string;
  piAgentDir: string;
  runsRoot: string;
  runDirectory: string;
  task: string;
  emissionDescriptor: string;
  toolPrimaryInstruction: string;
}>;

const publishedParentSpawnFixture = async (label: string): Promise<PublishedParentSpawnFixture> => {
  const root = canonicalTempDir(`loom-parent-emission-${label}-`);
  const piAgentDir = join(root, "pi-agent");
  const runsRoot = join(root, "runs");
  const sourcePath = "src/fixture.ts";
  await mkdir(runsRoot);
  await mkdir(join(root, "src"));
  await mkdir(join(piAgentDir, "agents"), { recursive: true });
  await writeFile(join(root, sourcePath), "export const fixture = true;\n", "utf8");
  await writeFile(
    join(piAgentDir, "agents", "code-reviewer.md"),
    renderPiAgentDefinition(
      readFileSync(join(repoRoot, "agents", "code-reviewer.md"), "utf8"),
      "code-reviewer",
      repoRoot,
    ),
    "utf8",
  );
  const created = createRunDirectory(runsRoot, `run.${label}`);
  if (!created.ok) throw new Error(created.error.message);
  const handle = created.value;
  const packets = ([1, 2] as const).map((attempt) => {
    const requestId = fixtureValue(parseRequestId(standaloneRequestId(handle.runId, "code-reviewer", attempt)));
    const section = fixtureValue(encodeByteSection(
      "standalone-review-authority",
      JSON.stringify({ runId: handle.runId, scope: [sourcePath], role: "code-reviewer", attempt }),
    ));
    return fixtureValue(buildReviewerContextPacket({
      requestId,
      role: "code-reviewer",
      requiredSkill: "none",
      fixedContext: Object.freeze([section]),
      variableContext: Object.freeze([]),
    }));
  });
  const packet = packets[0]!;
  const prepared = fixtureValue(prepareFreshStandaloneReview({
    runId: handle.runId,
    explicitScope: Object.freeze([sourcePath]),
    changedPaths: Object.freeze({
      unstaged: Object.freeze([sourcePath]),
      staged: Object.freeze([]),
      committed: Object.freeze([]),
      base_revision: null,
      head_revision: "a".repeat(40),
    }),
    reviewMetadata: Object.freeze({
      requested_kinds: Object.freeze(["types"]),
      docs_only: false,
      source_or_test_changed: false,
      types_changed: false,
      comments_changed: false,
      additions: 1,
      file_count: 1,
      new_structure: false,
      languages: Object.freeze(["TypeScript"]),
    }),
    scopeSafety: Object.freeze([{ path: sourcePath, status: "safe" as const }]),
    reviewerContexts: Object.freeze([{
      attempts: [packets[0]!.digest, packets[1]!.digest] as const,
    }]),
  }));
  const registration = standaloneFixtureRegistration(prepared.authority) as RegisteredStandaloneProgram;
  const parsed = parsedAuthority(registration);
  if (!parsed.ok) throw new Error(parsed.message);
  const authority = parsed.value.roster.orderedSlots[0]?.attempts[0];
  if (authority === undefined) throw new Error("fixture standalone authority carries no reviewer attempt");
  const registered = await handle.registerProgram(registration);
  if (!registered.ok) throw new Error(registered.error.message);
  const published = await publishReviewInitialBatch(
    handle,
    Object.freeze([Object.freeze({
      authority,
      context: Object.freeze({
        digest: packet.digest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.digest}.json` }),
      }),
    })]),
    Object.freeze([packet]),
    "standalone-reviewer-payload-v2",
    registration,
  );
  if (!published.ok) throw new Error(published.message);

  const binding = issueEmissionBinding({
    requestId: authority.requestId,
    kind: "reviewer-payload",
    version: "v2",
  });
  if (!binding.ok) throw new Error(`fixture emission binding refused: ${binding.error.message}`);
  const baseInstruction = "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.";
  const projected = projectEmissionTaskText(
    canonicalRecord({
      kind: "emission" as const,
      binding: binding.value,
      contextDigest: authority.contextDigest,
    }),
    baseInstruction,
  );
  const toolPrimaryInstruction = emissionToolPrimaryInstruction(binding.value);
  const task = projected.descriptor + renderReviewProgramSpawnTask(
    handle,
    authority,
    projected.instruction,
    registration,
    { standalone: true },
  );
  return Object.freeze({
    root,
    piAgentDir,
    runsRoot,
    runDirectory: handle.runDirectory,
    task,
    emissionDescriptor: projected.descriptor,
    toolPrimaryInstruction,
  });
};

const qualifiedPublishedReviewerRoute = (
  onQualification: () => void,
): PiIssuedReviewRouteQualifier => (classified, published) => {
  onQualification();
  const binding = issueEmissionBinding({
    requestId: classified.claim.requestId,
    kind: classified.claim.producerKind,
    version: classified.claim.version,
    ...(classified.claim.schemaDigest === undefined ? {} : { schemaDigest: classified.claim.schemaDigest }),
  });
  if (!binding.ok) return { ok: false, error: { message: binding.error.message } };
  return success(Object.freeze({
    role: published.role,
    claim: classified.claim,
    route: Object.freeze({
      kind: "emission-enabled" as const,
      binding: binding.value,
      contextDigest: classified.claim.contextDigest,
    }),
  }));
};

class ParentGuardFakePi extends NoEventBusFakePi {
  constructor(readonly events: SynchronousEventBus) {
    super();
  }
}

const shutdownParentExtension = async (
  pi: ParentGuardFakePi,
  fixture: PublishedParentSpawnFixture,
): Promise<void> => {
  const session = fixtureSession(fixture.root);
  for (const handler of pi.handlers.get("session_shutdown") ?? []) {
    await handler({}, {
      cwd: fixture.root,
      hasUI: false,
      sessionManager: { getSessionId: () => session.sessionId },
    });
  }
};

type InstalledLauncherResult = Readonly<{
  agent: string;
  task: string;
  exitCode: number;
  stderr: string;
  messages: readonly unknown[];
  stopReason?: string;
  launchOutcome?: unknown;
}>;

type InstalledLauncherModules = Readonly<{
  launcher: Readonly<{
    runSingleAgent: (...args: unknown[]) => Promise<InstalledLauncherResult>;
  }>;
  port: Readonly<{ advertiseSubagentLaunchPort: (events: unknown) => () => void }>;
  routingPolicy: Readonly<{
    parseModelRoutingPolicy: (raw: unknown) => Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; error: readonly string[] }>;
  }>;
}>;

/**
 * The installed launcher lives outside this repository (synced from dotfiles
 * into the ambient Pi agent dir), so it is resolved once from the ambient
 * environment, before any test swaps PI_CODING_AGENT_DIR for a fixture.
 */
const installedLauncher = (() => {
  const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
  const subagentRoot = join(agentDir, "extensions", "subagent");
  const paths = Object.freeze({
    launcher: join(subagentRoot, "index.ts"),
    port: join(subagentRoot, "loom-launch-port.ts"),
    routingPolicy: join(agentDir, "extensions", "model-routing", "policy.ts"),
  });
  const missing = Object.freeze(Object.values(paths).filter((path) => !existsSync(path)));
  return Object.freeze({ agentDir, paths, missing });
})();

/**
 * A CI runner can never hold the out-of-repo launcher, so there these
 * acceptance tests report as skipped. Everywhere else an absent launcher still
 * fails loudly: the prerequisite is tracked, never a claimed pass (FR-032/FR-008).
 */
const skipWithoutInstalledLauncher = process.env["CI"] === "true" && installedLauncher.missing.length > 0;

const loadInstalledLauncherModules = async (): Promise<InstalledLauncherModules> => {
  const [absent] = installedLauncher.missing;
  if (absent !== undefined) {
    throw new Error(
      `Installed Pi launcher prerequisite is absent at ${absent}. Install/sync the shared subagent and model-routing extensions under ${installedLauncher.agentDir}, then rerun this acceptance test.`,
    );
  }
  const { paths } = installedLauncher;
  return Object.freeze({
    launcher: await import(/* @vite-ignore */ paths.launcher),
    port: await import(/* @vite-ignore */ paths.port),
    routingPolicy: await import(/* @vite-ignore */ paths.routingPolicy),
  }) as InstalledLauncherModules;
};

const FAKE_INSTALLED_PI_SOURCE = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const mode = process.argv[process.argv.indexOf("--mode") + 1];
const log = process.env.FAKE_INSTALLED_LAUNCH_LOG;
if (mode !== "rpc") {
  if (log) appendFileSync(log, "ordinary-task\\n");
  console.log(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "ordinary path preserved" }], stopReason: "stop" },
  }));
  process.exit(0);
}
const binding = JSON.parse(process.env.LOOM_EMISSION_BINDING || "{}");
const variant = process.env.FAKE_INSTALLED_LAUNCH_VARIANT || "matching";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline = buffer.indexOf("\\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const response = (success = true, data = {}) => send({
      type: "response", id: request.id, command: request.type, success, data,
    });
    if (request.type === "get_commands") {
      response(true, { commands: variant === "missing-command"
        ? []
        : [{ name: "loom-emission-readiness", source: "extension" }] });
    } else if (request.type === "prompt" && request.message === "/loom-emission-readiness") {
      response();
      send({ type: "entry_appended", entry: {
        customType: "loom-emission-readiness",
        data: {
          requestId: binding.requestId,
          contextDigest: binding.contextDigest,
          kind: binding.kind,
          version: binding.version,
          toolName: binding.toolName,
          schemaDigest: variant === "wrong-schema" ? "0".repeat(64) : binding.schemaDigest,
          revision: process.env.FAKE_INSTALLED_LAUNCH_REVISION,
          active: variant !== "inactive",
          childPid: process.pid,
          registeredTools: [binding.toolName],
        },
      } });
    } else if (request.type === "set_model") {
      response(true, { provider: request.provider, id: request.modelId });
    } else if (request.type === "get_state") {
      response(true, { model: {
        provider: "desktop-vllm",
        id: "glm-5.3-flash-spark-tp2-v14",
      } });
    } else if (request.type === "prompt") {
      if (log) appendFileSync(log, "emission-task\\n");
      response();
      send({ type: "agent_settled" });
    } else {
      response(false, {});
    }
  }
});
`;

describe("production parent tool_call to installed launcher readiness barrier", { timeout: 30_000 }, () => {
  const parentContext = (fixture: PublishedParentSpawnFixture) => {
    const session = fixtureSession(fixture.root);
    return {
      cwd: fixture.root,
      hasUI: false,
      sessionManager: { getSessionId: () => session.sessionId },
    } as const;
  };

  const withPublishedRunEnvironment = async <T>(
    fixture: PublishedParentSpawnFixture,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previousRoot = process.env[RUNS_ROOT_ENV];
    const previousRun = process.env[RUN_DIR_ENV];
    process.env[RUNS_ROOT_ENV] = fixture.runsRoot;
    process.env[RUN_DIR_ENV] = fixture.runDirectory;
    try {
      return await operation();
    } finally {
      if (previousRoot === undefined) delete process.env[RUNS_ROOT_ENV];
      else process.env[RUNS_ROOT_ENV] = previousRoot;
      if (previousRun === undefined) delete process.env[RUN_DIR_ENV];
      else process.env[RUN_DIR_ENV] = previousRun;
    }
  };

  const invokeExistingParentSpawn = async (
    pi: ParentGuardFakePi,
    fixture: PublishedParentSpawnFixture,
    toolCallId: string,
  ): Promise<unknown> => {
    const handler = pi.handlers.get("tool_call")?.[0];
    if (handler === undefined) throw new Error("the production extension did not register its parent tool_call handler");
    return handler({
      toolName: "subagent",
      toolCallId,
      input: { agent: "code-reviewer", task: fixture.task, agentScope: "user" },
    }, parentContext(fixture));
  };

  const invokeIssuedParentSpawn = async (
    fixture: PublishedParentSpawnFixture,
    bus: SynchronousEventBus,
    toolCallId: string,
    qualified: { count: number },
  ): Promise<Readonly<{ pi: ParentGuardFakePi; result: unknown }>> => {
    const previousPiAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = fixture.piAgentDir;
    try {
      const pi = new ParentGuardFakePi(bus);
      loomPiExtension(pi as never, () => Object.freeze([]), qualifiedPublishedReviewerRoute(() => {
        qualified.count += 1;
      }));
      const result = await invokeExistingParentSpawn(pi, fixture, toolCallId);
      return Object.freeze({ pi, result });
    } finally {
      if (previousPiAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = previousPiAgentDir;
    }
  };

  const deliverParentToolResult = async (
    pi: ParentGuardFakePi,
    fixture: PublishedParentSpawnFixture,
    toolCallId: string,
    results: readonly unknown[],
  ): Promise<unknown> => {
    let response: unknown;
    for (const handler of pi.handlers.get("tool_result") ?? []) {
      const next = await handler({
        toolName: "subagent",
        toolCallId,
        input: { agent: "code-reviewer", task: fixture.task, agentScope: "user" },
        content: [],
        details: { mode: "single", results },
        isError: true,
      }, parentContext(fixture));
      if (next !== undefined) response = next;
    }
    return response;
  };

  const expectUncapturedIssuedRequest = (fixture: PublishedParentSpawnFixture): void => {
    const opened = openRegisteredRunDirectory(fixture.runsRoot, fixture.runDirectory);
    if (!opened.ok) throw new Error(opened.error.message);
    const issued = opened.value.readIssuedRequests();
    if (!issued.ok || issued.value[0] === undefined) throw new Error("fixture issued request is unavailable");
    expect(opened.value.readCapturedAttempts()).toEqual({ ok: true, value: new Set() });
    expect(opened.value.readCaptureRejection(issued.value[0])).toEqual({ ok: true, value: null });
  };

  const runInstalledChild = async (
    installed: InstalledLauncherModules,
    bus: SynchronousEventBus,
    fixture: PublishedParentSpawnFixture,
    toolCallId: string,
    variant: "matching" | "wrong-schema",
  ): Promise<Readonly<{ result: InstalledLauncherResult; log: string }>> => {
    const fakePi = join(fixture.root, "pi");
    const log = join(fixture.root, "launch.log");
    await writeFile(fakePi, FAKE_INSTALLED_PI_SOURCE, "utf8");
    await chmod(fakePi, 0o700);
    const parsedPolicy = installed.routingPolicy.parseModelRoutingPolicy({
      schemaVersion: 1,
      defaultClass: "cloud",
      modelClasses: {},
      targets: {},
      rules: [],
    });
    if (!parsedPolicy.ok) throw new Error(parsedPolicy.error.join("; "));
    const agent = {
      name: "code-reviewer",
      description: "published reviewer fixture",
      model: "desktop-vllm/glm-5.3-flash-spark-tp2-v14",
      declaredSkills: [],
      systemPrompt: "",
      source: "user",
      filePath: join(fixture.root, "code-reviewer.md"),
    } as const;
    const previousArgv1 = process.argv[1];
    const previousPath = process.env["PATH"];
    const previousLog = process.env["FAKE_INSTALLED_LAUNCH_LOG"];
    const previousRevision = process.env["FAKE_INSTALLED_LAUNCH_REVISION"];
    const previousVariant = process.env["FAKE_INSTALLED_LAUNCH_VARIANT"];
    delete process.argv[1];
    process.env["PATH"] = `${fixture.root}:${previousPath ?? ""}`;
    process.env["FAKE_INSTALLED_LAUNCH_LOG"] = log;
    process.env["FAKE_INSTALLED_LAUNCH_REVISION"] = captureLoomRuntimeIdentity(repoRoot).revision;
    process.env["FAKE_INSTALLED_LAUNCH_VARIANT"] = variant;
    try {
      const result = await installed.launcher.runSingleAgent(
        fixture.root,
        [agent],
        agent.name,
        fixture.task,
        undefined,
        undefined,
        undefined,
        undefined,
        (results: readonly unknown[]) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
        { policy: parsedPolicy.value, policyDigest: `parent-handler-${variant}` },
        {
          events: bus,
          sessionId: fixtureSession(fixture.root).sessionId,
          toolCallId,
          slot: { kind: "single", index: 0 },
          readinessTimeoutMs: 2_000,
        },
      );
      return Object.freeze({ result, log });
    } finally {
      if (previousArgv1 === undefined) delete process.argv[1];
      else process.argv[1] = previousArgv1;
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
      if (previousLog === undefined) delete process.env["FAKE_INSTALLED_LAUNCH_LOG"];
      else process.env["FAKE_INSTALLED_LAUNCH_LOG"] = previousLog;
      if (previousRevision === undefined) delete process.env["FAKE_INSTALLED_LAUNCH_REVISION"];
      else process.env["FAKE_INSTALLED_LAUNCH_REVISION"] = previousRevision;
      if (previousVariant === undefined) delete process.env["FAKE_INSTALLED_LAUNCH_VARIANT"];
      else process.env["FAKE_INSTALLED_LAUNCH_VARIANT"] = previousVariant;
    }
  };

  it("refuses a stale disposable generated Agent before authenticating or launching the issued request", async () => {
    const fixture = await publishedParentSpawnFixture("t5-parent-stale-agent");
    try {
      await withFixturePiSession(fixture.root, () => withPublishedRunEnvironment(fixture, async () => {
        const generatedAgentPath = join(fixture.piAgentDir, "agents", "code-reviewer.md");
        await writeFile(generatedAgentPath, `${await readFile(generatedAgentPath, "utf8")}\n<!-- stale definition -->\n`, "utf8");
        const qualified = { count: 0 };
        const parent = await invokeIssuedParentSpawn(
          fixture,
          new SynchronousEventBus(),
          "tool-call-parent-stale-agent",
          qualified,
        );
        expect(parent.result).toMatchObject({
          block: true,
          reason: expect.stringContaining("differs from active package"),
        });
        expect(qualified.count).toBe(0);
        expect(existsSync(join(fixture.root, "launch.log"))).toBe(false);
        await shutdownParentExtension(parent.pi, fixture);
      }));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("authenticates the issued request and exact disposable generated Agent before launcher-capability refusal", async () => {
    const fixture = await publishedParentSpawnFixture("t5-parent-missing-launcher");
    try {
      await withFixturePiSession(fixture.root, () => withPublishedRunEnvironment(fixture, async () => {
        const qualified = { count: 0 };
        const bus = new SynchronousEventBus();
        const ambientPiAgentDir = process.env["PI_CODING_AGENT_DIR"];
        const parent = await invokeIssuedParentSpawn(
          fixture,
          bus,
          "tool-call-parent-missing-launcher",
          qualified,
        );
        expect(process.env["PI_CODING_AGENT_DIR"]).toBe(ambientPiAgentDir);
        expect(parent.result).toMatchObject({
          block: true,
          reason: expect.stringContaining("installed subagent launcher does not advertise"),
        });
        // The qualifier runs only after readPiIssuedSpawnRequest authenticated
        // the exact reservation, program registration, and publication. The
        // real admitPiSpawnBatch handler then reaches the capability guard.
        expect(qualified.count).toBe(1);
        expect(existsSync(join(fixture.root, "launch.log"))).toBe(false);
        await shutdownParentExtension(parent.pi, fixture);
      }));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("surfaces an incompatible launcher capability reply through the production parent guard before any Task dispatch", async () => {
    const fixture = await publishedParentSpawnFixture("t5-parent-incompatible-launcher");
    try {
      await withFixturePiSession(fixture.root, () => withPublishedRunEnvironment(fixture, async () => {
        const bus = new SynchronousEventBus();
        bus.on(LOOM_SUBAGENT_LAUNCH_CHANNEL, (event) => {
          const probe = recordOf(event);
          if (probe?.["kind"] === "capability" && typeof probe["respond"] === "function") {
            probe["respond"]({ kind: "available", version: 1 });
          }
        });
        const qualified = { count: 0 };
        const parent = await invokeIssuedParentSpawn(fixture, bus, "tool-call-parent-incompatible-launcher", qualified);
        const blocked = recordOf(parent.result);
        expect(blocked?.["block"]).toBe(true);
        expect(typeof blocked?.["reason"]).toBe("string");
        if (typeof blocked?.["reason"] === "string") {
          expect(blocked["reason"]).toContain("incompatible v2 capability response");
          expect(blocked["reason"]).toContain("incompatible version");
          expect(blocked["reason"]).not.toContain("does not advertise");
        }
        expect(qualified.count).toBe(1);
        expect(existsSync(join(fixture.root, "launch.log"))).toBe(false);
        await shutdownParentExtension(parent.pi, fixture);
      }));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("surfaces a launcher probe crash through the production parent guard before any Task dispatch", async () => {
    const fixture = await publishedParentSpawnFixture("t5-parent-crashed-launcher");
    try {
      await withFixturePiSession(fixture.root, () => withPublishedRunEnvironment(fixture, async () => {
        const bus = new SynchronousEventBus();
        bus.on(LOOM_SUBAGENT_LAUNCH_CHANNEL, (event) => {
          if (recordOf(event)?.["kind"] === "capability") throw new Error("launcher capability handler crashed before dispatch");
        });
        const qualified = { count: 0 };
        const parent = await invokeIssuedParentSpawn(fixture, bus, "tool-call-parent-crashed-launcher", qualified);
        expect(parent.result).toMatchObject({
          block: true,
          reason: expect.stringContaining("launcher capability handler crashed before dispatch"),
        });
        expect(JSON.stringify(parent.result)).not.toContain("does not advertise");
        expect(qualified.count).toBe(1);
        expect(existsSync(join(fixture.root, "launch.log"))).toBe(false);
        await shutdownParentExtension(parent.pi, fixture);
      }));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.skipIf(skipWithoutInstalledLauncher)("keeps the same issued request retriable after an attested pre-prompt refusal and accepts a new native correlator", async () => {
    const installed = await loadInstalledLauncherModules();
    const fixture = await publishedParentSpawnFixture("t5-parent-same-request-retry");
    try {
      await withFixturePiSession(fixture.root, () => withPublishedRunEnvironment(fixture, async () => {
        const bus = new SynchronousEventBus();
        installed.port.advertiseSubagentLaunchPort(bus);
        const qualified = { count: 0 };
        expect(fixture.task.match(/^LOOM_EMISSION_DESCRIPTOR:.*$/gm)).toEqual([
          fixture.emissionDescriptor.trimEnd(),
        ]);
        expect(fixture.task.split(fixture.toolPrimaryInstruction)).toHaveLength(2);

        const firstToolCallId = "tool-call-parent-wrong-readiness";
        const parent = await invokeIssuedParentSpawn(fixture, bus, firstToolCallId, qualified);
        expect(parent.result).toBeUndefined();
        const refused = await runInstalledChild(installed, bus, fixture, firstToolCallId, "wrong-schema");
        expect(refused.result).toMatchObject({
          exitCode: 1,
          messages: [],
          launchOutcome: {
            kind: "emission-startup-refused",
            sessionId: fixtureSession(fixture.root).sessionId,
            toolCallId: firstToolCallId,
            slot: { kind: "single", index: 0 },
            phase: "before-task-prompt",
          },
        });
        expect(refused.result.stderr).toContain("registered schema digest");
        expect(existsSync(refused.log)).toBe(false);

        const response = await deliverParentToolResult(parent.pi, fixture, firstToolCallId, [refused.result]);
        expect(response).toMatchObject({
          isError: true,
          content: [{ text: expect.stringContaining("retry this same issued request") }],
        });
        expectUncapturedIssuedRequest(fixture);

        const retryToolCallId = "tool-call-parent-readiness-retry";
        expect(await invokeExistingParentSpawn(parent.pi, fixture, retryToolCallId)).toBeUndefined();
        expect(qualified.count).toBe(2);
        const retry = await runInstalledChild(installed, bus, fixture, retryToolCallId, "matching");
        expect(retry.result.exitCode).toBe(0);
        expect(retry.result.launchOutcome).toBeUndefined();
        expect(await readFile(retry.log, "utf8")).toBe("emission-task\n");
        await shutdownParentExtension(parent.pi, fixture);
      }));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.skipIf(skipWithoutInstalledLauncher)("terminally rejects an absent attempt-1 result and does not infer startup refusal from untrusted markers", async () => {
    const installed = await loadInstalledLauncherModules();

    const absentFixture = await publishedParentSpawnFixture("t5-parent-absent-result");
    try {
      await withFixturePiSession(absentFixture.root, () => withPublishedRunEnvironment(absentFixture, async () => {
        const bus = new SynchronousEventBus();
        installed.port.advertiseSubagentLaunchPort(bus);
        const parent = await invokeIssuedParentSpawn(absentFixture, bus, "tool-call-absent-result", { count: 0 });
        const response = await deliverParentToolResult(parent.pi, absentFixture, "tool-call-absent-result", []);
        expect(response).toMatchObject({
          isError: true,
          content: [{ text: expect.stringContaining("no typed pre-prompt outcome exists; terminal capture rejection") }],
        });

        const opened = openRegisteredRunDirectory(absentFixture.runsRoot, absentFixture.runDirectory);
        if (!opened.ok) throw new Error(opened.error.message);
        const issued = opened.value.readIssuedRequests();
        if (!issued.ok || issued.value[0] === undefined) throw new Error("fixture issued request is unavailable");
        expect(issued.value).toHaveLength(1);
        expect(issued.value[0].attempt).toBe(1);
        expect(opened.value.readCapturedAttempts()).toEqual({ ok: true, value: new Set() });
        expect(opened.value.readCaptureRejection(issued.value[0])).toEqual({
          ok: true,
          value: "capture-rejection: request-bound result 1 for code-reviewer was missing or mismatched; " +
            "no typed pre-prompt outcome exists; terminal capture rejection",
        });

        const sameRequestRetry = await invokeExistingParentSpawn(
          parent.pi,
          absentFixture,
          "tool-call-absent-result-same-request-retry",
        );
        expect(sameRequestRetry).toMatchObject({
          block: true,
          reason: expect.stringContaining("attempt 1"),
        });
        expect(sameRequestRetry).toMatchObject({
          block: true,
          reason: expect.stringContaining("terminally rejected"),
        });
        expect(sameRequestRetry).toMatchObject({
          block: true,
          reason: expect.stringContaining("new attempt-2 issuance is required"),
        });
        expect(opened.value.readIssuedRequests()).toEqual(issued);
        await shutdownParentExtension(parent.pi, absentFixture);
      }));
    } finally {
      await rm(absentFixture.root, { recursive: true, force: true });
    }

    for (const [label, rewrite] of [
      ["malformed", (outcome: unknown) => ({ ...(recordOf(outcome) ?? {}), requestId: 42 })],
      ["after-prompt", (outcome: unknown) => ({ ...(recordOf(outcome) ?? {}), phase: "task-prompt-sent" })],
    ] as const) {
      const fixture = await publishedParentSpawnFixture(`t5-parent-${label}-marker`);
      try {
        await withFixturePiSession(fixture.root, () => withPublishedRunEnvironment(fixture, async () => {
          const bus = new SynchronousEventBus();
          installed.port.advertiseSubagentLaunchPort(bus);
          const toolCallId = `tool-call-${label}-marker`;
          const parent = await invokeIssuedParentSpawn(fixture, bus, toolCallId, { count: 0 });
          const refused = await runInstalledChild(installed, bus, fixture, toolCallId, "wrong-schema");
          const raw = { ...refused.result, launchOutcome: rewrite(refused.result.launchOutcome) };
          const response = await deliverParentToolResult(parent.pi, fixture, toolCallId, [raw]);
          expect(response).toMatchObject({
            isError: true,
            content: [{ text: expect.stringContaining("untrusted emission launch outcome") }],
          });
          const opened = openRegisteredRunDirectory(fixture.runsRoot, fixture.runDirectory);
          if (!opened.ok) throw new Error(opened.error.message);
          const issued = opened.value.readIssuedRequests();
          if (!issued.ok || issued.value[0] === undefined) throw new Error("fixture issued request is unavailable");
          expect(opened.value.readCaptureRejection(issued.value[0])).toMatchObject({ ok: true, value: expect.any(String) });
          await shutdownParentExtension(parent.pi, fixture);
        }));
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });
});

describe("native installed subagent launcher integration", { timeout: 20_000 }, () => {
  it.skipIf(skipWithoutInstalledLauncher)("blocks a mismatched child before Task prompt and permits a fresh exact retry; ordinary JSON launch remains unchanged", async () => {
    const tmp = canonicalTempDir("loom-installed-launcher-t5-");
    const fakePi = join(tmp, "pi");
    const log = join(tmp, "launch.log");
    await writeFile(fakePi, FAKE_INSTALLED_PI_SOURCE, "utf8");
    await chmod(fakePi, 0o700);

    const bus = new SynchronousEventBus();
    const installed = await loadInstalledLauncherModules();
    installed.port.advertiseSubagentLaunchPort(bus);
    const bridge = registerPiEmissionLaunchBridge(bus as PiSubagentLaunchEventBus);
    expect(bridge.probe()).toEqual({ kind: "available" });

    const parsedPolicy = installed.routingPolicy.parseModelRoutingPolicy({
      schemaVersion: 1,
      defaultClass: "cloud",
      modelClasses: {},
      targets: {},
      rules: [],
    });
    if (!parsedPolicy.ok) throw new Error(parsedPolicy.error.join("; "));
    const agent = {
      name: "code-reviewer",
      description: "fixture reviewer",
      model: "desktop-vllm/glm-5.3-flash-spark-tp2-v14",
      declaredSkills: [],
      systemPrompt: "",
      source: "user",
      filePath: join(tmp, "code-reviewer.md"),
    } as const;
    const routingSnapshot = {
      policy: parsedPolicy.value,
      policyDigest: "installed-launch-test",
    } as const;
    const makeDetails = (results: readonly unknown[]) => ({
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results,
    });
    const previousArgv1 = process.argv[1];
    const previousPath = process.env["PATH"];
    const previousLog = process.env["FAKE_INSTALLED_LAUNCH_LOG"];
    const previousRevision = process.env["FAKE_INSTALLED_LAUNCH_REVISION"];
    const previousVariant = process.env["FAKE_INSTALLED_LAUNCH_VARIANT"];
    const previousAmbientBinding = process.env[LOOM_EMISSION_BINDING_ENV];
    delete process.argv[1];
    process.env["PATH"] = `${tmp}:${previousPath ?? ""}`;
    process.env["FAKE_INSTALLED_LAUNCH_LOG"] = log;

    const run = async (launch: PiEmissionLaunchExpectation) => installed.launcher.runSingleAgent(
      repoRoot,
      [agent],
      agent.name,
      launch.task,
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      routingSnapshot,
      {
        events: bus,
        sessionId: launch.sessionId,
        toolCallId: launch.toolCallId,
        slot: launch.slot,
        readinessTimeoutMs: 2_000,
      },
    );

    try {
      for (const [variant, diagnostic] of [
        ["missing-command", "Required extension command /loom-emission-readiness is unavailable"],
        ["inactive", "registered but inactive"],
        ["wrong-schema", "registered schema digest"],
        ["stale-revision", "reports revision sha256:stale-child"],
      ] as const) {
        const refused = bridgeLaunchExpectation(
          JUDGE_V1_CELL,
          `tool-call-native-${variant}`,
          { kind: "single", index: 0 },
        );
        expect(bridge.stage([refused])).toEqual({ ok: true });
        process.env["FAKE_INSTALLED_LAUNCH_VARIANT"] = variant === "stale-revision" ? "matching" : variant;
        process.env["FAKE_INSTALLED_LAUNCH_REVISION"] = variant === "stale-revision"
          ? "sha256:stale-child"
          : refused.revision;
        const refusedResult = await run(refused);
        expect(refusedResult.exitCode, variant).toBe(1);
        expect(refusedResult.stderr, variant).toContain(diagnostic);
        bridge.removeToolCall(refused.sessionId, refused.toolCallId);
      }
      // None of the missing/inactive/wrong-schema/revision children reached
      // Task prompt — the executable launcher's zero-model-request invariant.
      await expect(readFile(log, "utf8")).rejects.toThrow();

      const retry = bridgeLaunchExpectation(JUDGE_V1_CELL, "tool-call-native-retry", { kind: "single", index: 0 });
      expect(bridge.stage([retry])).toEqual({ ok: true });
      process.env["FAKE_INSTALLED_LAUNCH_VARIANT"] = "matching";
      process.env["FAKE_INSTALLED_LAUNCH_REVISION"] = retry.revision;
      const retryResult = await run(retry);
      expect(retryResult.exitCode).toBe(0);
      expect(await readFile(log, "utf8")).toBe("emission-task\n");

      bridge.removeToolCall(retry.sessionId, retry.toolCallId);
      const ordinaryResult = await installed.launcher.runSingleAgent(
        repoRoot,
        [agent],
        agent.name,
        "ordinary extraction-only task",
        undefined,
        undefined,
        undefined,
        undefined,
        makeDetails,
        routingSnapshot,
        {
          events: bus,
          sessionId: "01a0e4b3-c4c1-7b63-916d-f5d41d2b5a00",
          toolCallId: "tool-call-native-ordinary",
          slot: { kind: "single", index: 0 },
          readinessTimeoutMs: 2_000,
        },
      );
      expect(ordinaryResult.exitCode).toBe(0);
      expect(ordinaryResult.messages).toHaveLength(1);
      expect(await readFile(log, "utf8")).toBe("emission-task\nordinary-task\n");
      expect(process.env[LOOM_EMISSION_BINDING_ENV]).toBe(previousAmbientBinding);
    } finally {
      if (previousArgv1 === undefined) delete process.argv[1];
      else process.argv[1] = previousArgv1;
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
      if (previousLog === undefined) delete process.env["FAKE_INSTALLED_LAUNCH_LOG"];
      else process.env["FAKE_INSTALLED_LAUNCH_LOG"] = previousLog;
      if (previousRevision === undefined) delete process.env["FAKE_INSTALLED_LAUNCH_REVISION"];
      else process.env["FAKE_INSTALLED_LAUNCH_REVISION"] = previousRevision;
      if (previousVariant === undefined) delete process.env["FAKE_INSTALLED_LAUNCH_VARIANT"];
      else process.env["FAKE_INSTALLED_LAUNCH_VARIANT"] = previousVariant;
      if (previousAmbientBinding === undefined) delete process.env[LOOM_EMISSION_BINDING_ENV];
      else process.env[LOOM_EMISSION_BINDING_ENV] = previousAmbientBinding;
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

class EmissionHoldFakePi {
  readonly events = new SynchronousEventBus();
  readonly handlers = new Map<string, FakeExtensionHandler[]>();
  readonly commands = new Map<string, Readonly<{ handler: FakeExtensionHandler }>>();
  readonly tools = new Map<string, Readonly<{ name: string }>>();
  readonly entries: Readonly<{ customType: string; data: unknown }>[] = [];

  on(event: string, handler: FakeExtensionHandler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  registerCommand(name: string, command: Readonly<{ handler: FakeExtensionHandler }>): void {
    this.commands.set(name, command);
  }

  registerTool(tool: Readonly<{ name: string }>): void {
    this.tools.set(tool.name, tool);
  }

  appendEntry(customType: string, data: unknown): void {
    if (customType === EMISSION_HOLD_ENTRY_TYPE) {
      throw new Error(`hold journal unavailable ${"x".repeat(10_000)}`);
    }
    this.entries.push(Object.freeze({ customType, data }));
  }

  getActiveTools(): readonly string[] {
    return Object.freeze([...this.tools.keys()]);
  }

  getAllTools(): readonly Readonly<{ name: string }>[] {
    return Object.freeze([...this.tools.values()]);
  }
}

describe(`the PRODUCTION loom child extension through the real barrier protocol on ${piIdentity} (T5; FR-008/FR-001/AD-4)`, { timeout: 75_000 }, () => {
  it("carries the settled protocol names — the production constants and the barrier contract cannot drift apart", () => {
    expect(EMISSION_READINESS_COMMAND).toBe(READINESS_COMMAND_NAME);
    expect(EMISSION_READINESS_ENTRY_TYPE).toBe(READINESS_ENTRY_TYPE);
    expect(EMISSION_HOLD_ENTRY_TYPE).toBe(HOLD_ENTRY_TYPE);
  });

  it("retains bounded refused and transport-failed prompt responses as typed hold diagnostics", () => {
    expect(holdPromptResponseOf({
      kind: "observed",
      event: { type: "response", success: false, error: "provider rejected the resumed prompt", receivedAt: 0 },
    })).toEqual({
      kind: "refused",
      diagnostic: expect.stringContaining("provider rejected the resumed prompt"),
    });
    expect(holdPromptResponseOf({
      kind: "failed",
      error: new Error("RPC response channel closed"),
    })).toEqual({
      kind: "transport-failed",
      diagnostic: expect.stringContaining("RPC response channel closed"),
    });
  });

  it("bounds first-request observation and retains RPC/stderr diagnostics when no request arrives", async () => {
    const server = await startCountingServer();
    try {
      await expect(awaitFirstCountedRequest(
        server,
        25,
        () => "RPC response succeeded; stderr: provider dispatch remained pending",
      )).rejects.toThrow(
        "no counted model request arrived within 25ms; RPC response succeeded; stderr: provider dispatch remained pending",
      );
      expect(server.hits).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("logs a bounded append cause while the production hold remains fail-closed until readiness", async () => {
    const requestId = nextRequestId("t5-hold-diagnostic-cause");
    const expectation = makeExpectation(JUDGE_V1_CELL, requestId, "http://127.0.0.1:9/v1");
    const rawBinding = childProvisioningEnv(
      expectation,
      requestId,
      canonicalRecord({ kind: "minted" as const, cell: JUDGE_V1_CELL }),
    );
    if (rawBinding === undefined) throw new Error("the diagnostic fixture failed to mint provisioning");

    const previousBinding = process.env[LOOM_EMISSION_BINDING_ENV];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    process.env[LOOM_EMISSION_BINDING_ENV] = rawBinding;
    try {
      const productionExtension = await import("../../../pi/extension");
      const pi = new EmissionHoldFakePi();
      productionExtension.default(pi as never, () => Object.freeze([]));
      const holdHandler = pi.handlers.get("before_agent_start")?.[1];
      const readiness = pi.commands.get(EMISSION_READINESS_COMMAND);
      if (holdHandler === undefined || readiness === undefined) {
        throw new Error("the production extension did not register its emission hold and readiness command");
      }

      let holdSettled = false;
      const heldPrompt = Promise.resolve(holdHandler({}, {})).then(() => {
        holdSettled = true;
      });
      await sleep(20);
      expect(holdSettled).toBe(false);

      await readiness.handler("", {});
      await heldPrompt;
      expect(holdSettled).toBe(true);
      expect(pi.entries.some((entry) => entry.customType === EMISSION_READINESS_ENTRY_TYPE)).toBe(true);

      const diagnostic = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(diagnostic).toContain("emission hold entered diagnostic append failed (Error: hold journal unavailable");
      expect(diagnostic).toContain("emission hold resolved diagnostic append failed (Error: hold journal unavailable");
      expect(diagnostic).toContain("the hold remains fail-closed");
      expect(diagnostic).toContain("…");
      expect(diagnostic.length).toBeLessThan(1_000);
    } finally {
      stderr.mockRestore();
      if (previousBinding === undefined) delete process.env[LOOM_EMISSION_BINDING_ENV];
      else process.env[LOOM_EMISSION_BINDING_ENV] = previousBinding;
    }
  });

  it("session shutdown releases an armed emission hold: the wedged prompt settles, the shutdown-released marker is attempted, and re-invocation is inert (AD-4 cleanup arm)", async () => {
    const requestId = nextRequestId("t5-hold-shutdown-release");
    const expectation = makeExpectation(JUDGE_V1_CELL, requestId, "http://127.0.0.1:9/v1");
    const rawBinding = childProvisioningEnv(
      expectation,
      requestId,
      canonicalRecord({ kind: "minted" as const, cell: JUDGE_V1_CELL }),
    );
    if (rawBinding === undefined) throw new Error("the shutdown-release fixture failed to mint provisioning");

    const previousBinding = process.env[LOOM_EMISSION_BINDING_ENV];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    process.env[LOOM_EMISSION_BINDING_ENV] = rawBinding;
    try {
      const productionExtension = await import("../../../pi/extension");
      const pi = new EmissionHoldFakePi();
      productionExtension.default(pi as never, () => Object.freeze([]));
      const holdHandler = pi.handlers.get("before_agent_start")?.[1];
      // The emission fail-safe is the SECOND session_shutdown handler: the
      // interactive-subagent bridge registers one first, the emission
      // fail-safe second, and the general cleanup third (whose fake-ctx
      // behavior this unit fixture does not drive).
      const shutdownFailSafe = pi.handlers.get("session_shutdown")?.[1];
      if (holdHandler === undefined || shutdownFailSafe === undefined) {
        throw new Error("the production extension did not register its emission hold and shutdown fail-safe");
      }

      let holdSettled = false;
      const heldPrompt = Promise.resolve(holdHandler({}, {})).then(() => {
        holdSettled = true;
      });
      await sleep(20);
      expect(holdSettled).toBe(false);

      // Shutdown with the hold armed: the wedged coroutine resolves. The
      // fake journal refuses hold entries, so the shutdown-released marker
      // surfaces as the bounded stderr diagnostic — the entry emission is
      // attempted even when the journal is unavailable.
      await shutdownFailSafe({}, {});
      await heldPrompt;
      expect(holdSettled).toBe(true);

      // A second shutdown is inert: the hold is already released, so exactly
      // one shutdown-released diagnostic is emitted and nothing re-releases.
      await shutdownFailSafe({}, {});
      const diagnostic = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(diagnostic).toContain("emission hold shutdown-released diagnostic append failed (Error: hold journal unavailable");
      expect(diagnostic.match(/shutdown-released diagnostic append failed/g)).toHaveLength(1);
      expect(diagnostic).toContain("the hold remains fail-closed");
    } finally {
      stderr.mockRestore();
      if (previousBinding === undefined) delete process.env[LOOM_EMISSION_BINDING_ENV];
      else process.env[LOOM_EMISSION_BINDING_ENV] = previousBinding;
    }
  });

  it("matching readiness on the judge-verdict v1 cell opens the gate, exposes the exact registered tool to the constrained route, and the first model request lands after the readiness observation", async () => {
    const run = await runProductionGate(productionScenario("production-matching-judge-v1", { issuedCell: JUDGE_V1_CELL, waitForRequest: true }));
    const open = expectOpenProductionRun(run);
    expect(run.channelAlive).toBe(true);
    expect(run.commandListed).toBe(true);
    expect(run.invocationCount).toBe(1);
    expect(run.prompted).toBe(true);
    expect(run.requestCount).toBe(1);
    const readiness = asProvisionedPayload(run);
    expect(readiness.requestId).toBe(run.issuedRequestId);
    expect(readiness.kind).toBe("judge-verdict");
    expect(readiness.version).toBe("v1");
    expect(readiness.toolName).toBe("loom_emit_judge_verdict");
    expect(readiness.schemaDigest).toBe(sha256Hex(JUDGE_V1_CELL.schemaBytes));
    expect(readiness.active).toBe(true);
    expect(readiness.childPid).toBe(run.childPid);
    expect(readiness.revision).toBe(PARENT_RUNTIME_REVISION);
    expect(readiness.registeredTools).toContain("loom_emit_judge_verdict");
    expect(open.route).toEqual({
      provider: "loom-counting",
      modelId: "loom-counting-model",
      api: "openai-completions",
      baseUrl: run.countingBaseUrl,
    });
    // FR-001 on the production path: the provider request carries the exact
    // registered emission tool.
    expect(run.requestBodies[0]).toContain("loom_emit_judge_verdict");
    const { firstRequestAt, readinessObservedAt } = productionOrderingPair(run);
    expect(firstRequestAt).toBeGreaterThanOrEqual(readinessObservedAt);
  });

  it("matching readiness on the reviewer-payload v2 cell opens the gate, and the first model request lands after the readiness observation", async () => {
    const run = await runProductionGate(productionScenario("production-matching-reviewer-v2", { waitForRequest: true }));
    expectOpenProductionRun(run);
    expect(run.prompted).toBe(true);
    expect(run.requestCount).toBe(1);
    const readiness = asProvisionedPayload(run);
    expect(readiness.requestId).toBe(run.issuedRequestId);
    expect(readiness.kind).toBe("reviewer-payload");
    expect(readiness.version).toBe("v2");
    expect(readiness.toolName).toBe("loom_emit_reviewer_payload");
    expect(readiness.schemaDigest).toBe(sha256Hex(REVIEWER_V2_CELL.schemaBytes));
    expect(readiness.active).toBe(true);
    expect(run.requestBodies[0]).toContain("loom_emit_reviewer_payload");
    const { firstRequestAt, readinessObservedAt } = productionOrderingPair(run);
    expect(firstRequestAt).toBeGreaterThanOrEqual(readinessObservedAt);
  });

  it("re-invoking the production readiness command is idempotent — identical payloads, exactly ONE registered emission tool", async () => {
    const run = await runProductionGate(productionScenario("production-idempotent-reinvocation", { issuedCell: JUDGE_V1_CELL, doubleInvocation: true, waitForRequest: true }));
    const open = expectOpenProductionRun(run);
    expect(run.invocationCount).toBe(2);
    expect(run.readinessPayloads).toHaveLength(2);
    const [first, second] = [asProvisionedPayload(run, 0), asProvisionedPayload(run, 1)];
    expect(second).toEqual(first);
    // Exactly one emission tool: the idempotent invocation registered nothing
    // twice (the contradictory-refusal state machine guards the rest).
    const emissionTools = first.registeredTools.filter((name) => name.startsWith("loom_emit_"));
    expect(emissionTools).toEqual(["loom_emit_judge_verdict"]);
    expect(open.readiness.requestId).toBe(run.issuedRequestId);
    expect(run.requestCount).toBe(1);
  });

  it("an honestly-inactive tool under a real --tools allowlist exclusion is reported active:false by the production payload and refused with ZERO model requests", async () => {
    const run = await runProductionGate(productionScenario("production-honestly-inactive", { allowlist: ["read"] }));
    const refusedDecision = expectZeroRequestProductionRefusal(run, "tool-inactive");
    const readiness = asProvisionedPayload(run);
    expect(readiness.active).toBe(false);
    expect(readiness.toolName).toBe("loom_emit_reviewer_payload");
    expect(refusedDecision.message).toContain("--tools");
  });

  it("a production child provisioned for another request is refused as wrong-request with ZERO model requests, the message naming both request ids", async () => {
    const staleRequestId = nextRequestId("t5-production-stale-peer");
    const run = await runProductionGate(productionScenario("production-wrong-request", {
      provisioning: canonicalRecord({ kind: "minted" as const, cell: REVIEWER_V2_CELL, requestId: staleRequestId }),
    }));
    const refusedDecision = expectZeroRequestProductionRefusal(run, "wrong-request");
    const readiness = asProvisionedPayload(run);
    expect(readiness.requestId).toBe(staleRequestId);
    expect(refusedDecision.message).toContain(staleRequestId);
    expect(refusedDecision.message).toContain(run.issuedRequestId);
  });

  it("a production child provisioned for another producer kind is refused as unexpected-kind with ZERO model requests", async () => {
    const run = await runProductionGate(productionScenario("production-wrong-kind", {
      provisioning: canonicalRecord({ kind: "minted" as const, cell: JUDGE_V1_CELL }),
    }));
    const refusedDecision = expectZeroRequestProductionRefusal(run, "unexpected-kind");
    const readiness = asProvisionedPayload(run);
    expect(readiness.kind).toBe("judge-verdict");
    expect(readiness.toolName).toBe("loom_emit_judge_verdict");
    expect(refusedDecision.message).toContain("judge-verdict");
  });

  it("a launcher expecting a stale revision is refused by the production child's honest load identity with ZERO model requests", async () => {
    const run = await runProductionGate(productionScenario("production-stale-revision", { expectationRevision: STALE_REVISION }));
    const refusedDecision = expectZeroRequestProductionRefusal(run, "revision-mismatch");
    const readiness = asProvisionedPayload(run);
    expect(readiness.revision).not.toBe(STALE_REVISION);
    expect(refusedDecision.message).toContain(STALE_REVISION);
  });

  it("a child with NO provisioned binding refuses the readiness invocation explicitly, emits no readiness, and sends ZERO model requests", async () => {
    const run = await runProductionGate(productionScenario("production-absent-provisioning", {
      provisioning: canonicalRecord({ kind: "absent" as const }),
    }));
    const refusedDecision = expectZeroRequestProductionRefusal(run, "startup-unavailable");
    expect(run.commandListed).toBe(true);
    expect(run.invocationCount).toBe(1);
    expect(run.readinessPayloads).toHaveLength(0);
    // The explicit refusal surfaced on pi's command-error channel and is the
    // parent-facing startup-unavailable decision, never a generic timeout.
    const readinessError = run.extensionErrors.map((error) => error.error).join(" | ");
    expect(readinessError).toContain(LOOM_EMISSION_BINDING_ENV);
    expect(readinessError).toContain("Remediation: the launcher barrier provisions the issued emission binding before readiness.");
    expect(refusedDecision.message).toContain(LOOM_EMISSION_BINDING_ENV);
  });

  it("a child whose provisioned claims select no frozen registry cell refuses with the mint's code and ZERO model requests", async () => {
    const run = await runProductionGate(productionScenario("production-garbage-provisioning", {
      provisioning: canonicalRecord({
        kind: "garbage" as const,
        raw: JSON.stringify({ requestId: "req-t5-garbage-1", contextDigest: sha256Hex("ctx"), kind: "no-such-kind", version: "v1" }),
      }),
    }));
    const refusedDecision = expectZeroRequestProductionRefusal(run, "startup-unavailable");
    expect(run.readinessPayloads).toHaveLength(0);
    const readinessError = run.extensionErrors.map((error) => error.error).join(" | ");
    expect(readinessError).toContain("unknown-producer-kind");
    expect(readinessError).toContain("Remediation: respawn the child with the issued emission binding.");
    expect(refusedDecision.message).toContain("unknown-producer-kind");
  });

  it("a prompt delivered before the readiness exchange wedges on the production hold with ZERO model requests and zero agent starts (AD-4)", async () => {
    const run = await runProductionHoldGate({ label: "production-hold-gates", issuedCell: JUDGE_V1_CELL });
    expect(run.childAliveDuringProbe).toBe(true);
    expect(run.holdPhases).toEqual(["entered"]);
    expect(run.agentStartCount).toBe(0);
    expect(run.promptResponse).toEqual({ kind: "pending" });
    expect(run.requestCount).toBe(0);
  });

  it("a provisioning-refused child also wedges a delivered prompt with ZERO model requests", async () => {
    const run = await runProductionHoldGate({
      label: "production-refused-hold-gates",
      issuedCell: JUDGE_V1_CELL,
      provisioning: canonicalRecord({
        kind: "garbage" as const,
        raw: JSON.stringify({ requestId: "req-t5-hold-garbage", contextDigest: sha256Hex("ctx"), kind: "no-such-kind", version: "v1" }),
      }),
    });
    expect(run.childAliveDuringProbe).toBe(true);
    expect(run.holdPhases).toEqual(["entered"]);
    expect(run.agentStartCount).toBe(0);
    expect(run.promptResponse).toEqual({ kind: "pending" });
    expect(run.requestCount).toBe(0);
  });

  it("readiness releases the already-wedged prompt, appends the resolved marker, and permits its first model request", { timeout: 150_000 }, async () => {
    const run = await runProductionHoldGate({
      label: "production-hold-readiness-release",
      issuedCell: JUDGE_V1_CELL,
      releaseThroughReadiness: true,
    });
    expect(run.childAliveDuringProbe).toBe(true);
    expect(run.holdPhases).toEqual(["entered", "resolved"]);
    expect(run.agentStartCount).toBe(1);
    expect(run.promptResponse.kind).toBe("succeeded");
    if (run.promptResponse.kind === "succeeded") {
      expect(run.promptResponse.diagnostic).toContain('"success":true');
    }
    expect(run.requestCount, `prompt response: ${JSON.stringify(run.promptResponse)}; stderr: ${run.stderr}`).toBe(1);
  });
});
