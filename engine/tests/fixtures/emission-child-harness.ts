/**
 * The emission-child harness: the launcher's view of a real headless
 * `pi --mode rpc` child, shared by every emission readiness suite
 * (`engine/tests/pi/emission-*.test.ts`) so none of them imports another.
 *
 * It owns the explicit pi binary resolution (PI_BIN env, then the
 * repo-resolved `node_modules/.bin/pi`, then PATH), the frozen registry cells
 * the scenarios issue against, the launcher expectation mint (the REAL
 * `issueEmissionBinding` over `EMISSION_TOOL_SPECS`, the schema digest derived
 * from the frozen bytes, never trusted), the COUNTING PROVIDER SUBSTITUTE (a
 * local HTTP server that counts and rejects completions, so a model request is
 * a counted event, never a real call), the strict JSONL RPC bus and request
 * framing, the probe-proven launcher steps (channel check, discovery, bounded
 * readiness wait, the pure gate, the fail-closed settle-aware route bind,
 * prompt delivery only on open), the shared gate-run assertions, and the
 * ambient-process-state scope the in-process suites restore.
 *
 * The gate decisions themselves are the production ones
 * (`pi/emission-readiness-gate.ts`); this harness only gathers the facts and
 * sequences the two decision stages exactly as a launcher must.
 */

import { expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EMISSION_TOOL_SPECS,
  issueEmissionBinding,
  type EmissionSchemaVersion,
  type EmissionToolName,
} from "../../src/core/emission-tool";
import {
  decideReadinessGate,
  decideStartupRoute,
  EMISSION_STARTUP_REMEDIATIONS,
  parseReadinessStageObservation,
  type EmissionReadinessGateDecision,
  type EmissionStartupDecision,
  type EmissionStartupExpectation,
  type EmissionStartupRefusalCode,
  type ExpectedEmissionRoute,
  type ReadinessObservation,
  type ReadinessProbeFacts,
  type RouteObservation,
} from "../../../pi/emission-readiness-gate";
import {
  boundDiagnosticMessage,
  canonicalRecord,
  describeUnknown,
  parseContextDigest,
  type ContextDigest,
} from "../../src/core/orchestration-contract/identity";
import type { PayloadProducerKindName } from "../../src/core/agent-catalog-projections";

// ---------------------------------------------------------------------------
// Shared unknown-value helpers (the one confined projection of untrusted data)
// ---------------------------------------------------------------------------

/** The ONE confined cast over untrusted records (RPC payloads, parsed JSON):
 *  a null-prototype-safe object view, or null. Every consumer guards. */
export const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const stringifyUnknown = (value: unknown): string => (typeof value === "string" ? value : describeUnknown(value));

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

export const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

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
export const piIdentity = `pi ${piBinary.version ?? "version-unreported"} resolved from ${piBinary.source}`;

// ---------------------------------------------------------------------------
// The frozen registry cells the scenarios issue against
// ---------------------------------------------------------------------------

export type RegistryCell = Readonly<{
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

export const REVIEWER_V2_CELL = cellOf("reviewer-payload", "v2");
export const JUDGE_V1_CELL = cellOf("judge-verdict", "v1");

// ---------------------------------------------------------------------------
// The imperative shell: counting provider substitute + real pi RPC child
// ---------------------------------------------------------------------------

export const READINESS_COMMAND_NAME = "loom-emission-readiness";
export const READINESS_ENTRY_TYPE = "loom-emission-readiness";
export const HOLD_ENTRY_TYPE = "loom-emission-hold";
export const CURRENT_REVISION = "loom-emission-rev-t4-current";
export const STALE_REVISION = "loom-emission-rev-t4-stale-000";

export const STATE_TIMEOUT_MS = 8_000;
// The installed launcher's bounded startup window is 45s: a cold real Pi
// child can spend over 20s loading Loom under the parallel project suite.
// Only the initial get_state channel check earns this budget; every later RPC
// operation keeps its shorter bound, so a hung readiness command still refuses.
const CHANNEL_STARTUP_TIMEOUT_MS = 45_000;
export const PRODUCTION_STATE_TIMEOUT_MS = 20_000;
export const READY_TIMEOUT_MS = 2_500;
/** Budget for the launcher's route-bind settle wait (10 attempts × 300ms).
 *  Deliberately far below the step timeouts: settling the model registry is a
 *  sub-second property of a healthy child; the bound exists so a genuinely
 *  absent model still fails closed on the bind refusal itself, never a hang. */
const BIND_SETTLE_BACKOFF_MS = 300;
export const HOLD_RESOLVE_TIMEOUT_MS = 6_000;
const FIRST_REQUEST_TIMEOUT_MS = 6_000;
// The real production extension can finish the resumed RPC prompt before its
// provider request is scheduled, and under full-suite load the scheduled
// request itself can wait on the saturated worker pool — one real gate start
// observed this wait exceed 30s. Keep the larger budget local to that one
// hold-release observation; the test's own timeout override covers the wait.
export const PRODUCTION_HOLD_FIRST_REQUEST_TIMEOUT_MS = 60_000;
export const REFUSE_GRACE_MS = 800;
export const CANCEL_AFTER_MS = 600;
export const HOLD_MS = 700;
export const HOLD_ORDERING_SLACK_MS = 250;
export const HOLD_RELEASE_CAP_MS = 10_000;
export const SLOW_READINESS_MS = 5_000;

/** Each real pi child gets its own HOME and agent dir. pi persists every
 *  set_model as the default in <agentDir>/settings.json and resolves models
 *  against that dir's auth and the Loom extension's routing config, so a
 *  shared dir lets one child's (or the developer's own) model state choose the
 *  model a later child's released prompt runs on — and every run rewrote the
 *  developer's real pi default to the counting provider. */
export const isolatedPiEnv = async (tmp: string): Promise<NodeJS.ProcessEnv> => {
  const home = join(tmp, "home");
  const agentDir = join(tmp, "pi-agent");
  await mkdir(home, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER: "", PI_MODEL: "" };
};

export const nextRequestId = (label: string): string => `req-emission-startup-t4-${label}-${++requestCounter}`;
let requestCounter = 0;

export const contextDigestOf = (seed: string): ContextDigest => {
  const parsed = parseContextDigest(sha256Hex(seed));
  if (!parsed.ok) throw new Error(`fixture context digest refused: ${parsed.error.message}`);
  return parsed.value;
};

/**
 * The launcher expectation mint: the REAL issuance mint over the frozen
 * registry, with the claims the launcher holds (request id, kind, version,
 * exact tool name) and the digest derived from the frozen bytes — the mint
 * certifies the claims against the registry, so the expectation can never
 * name a schema the registry does not freeze. The harness owns the counting
 * provider's registration, so its route pins the serving endpoint too.
 */
export type HarnessExpectation = EmissionStartupExpectation & Readonly<{
  route: Extract<ExpectedEmissionRoute, { kind: "pinned-endpoint" }>;
}>;

export const makeExpectation = (cell: RegistryCell, requestId: string, routeBaseUrl: string): HarnessExpectation => {
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
      kind: "pinned-endpoint" as const,
      provider: "loom-counting",
      modelId: "loom-counting-model",
      api: "openai-completions",
      baseUrl: routeBaseUrl,
    }),
  });
};

/** One counted model request on the counting provider substitute. */
export type CountedRequest = Readonly<{ at: number; url: string; bytes: number; body: string }>;

export type CountingServer = Readonly<{
  baseUrl: string;
  hits: CountedRequest[];
  firstRequest: Promise<CountedRequest>;
  close: () => Promise<void>;
}>;

/** The counting provider substitute (the committed probe's server, verbatim
 *  behavior): counts every completions POST and rejects it — the count is the
 *  evidence, the rejection bounds the run, and no real model is involved. */
export const startCountingServer = (): Promise<CountingServer> => {
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
export const awaitFirstCountedRequest = async (
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

/** Strict JSONL RPC framing over the child's stdout (the probe's bus). */
export type RpcEvent = Readonly<{ type: string; receivedAt: number } & Record<string, unknown>>;

export type RpcBus = Readonly<{
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

export const boundedEvent = (event: RpcEvent): string => boundDiagnosticMessage(JSON.stringify(event));
export const boundedDiagnostic = (error: unknown): string =>
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
export const bindRouteWithSettle = async (
  rpcRequest: (message: Record<string, unknown>, label: string) => Promise<RpcEvent>,
  route: ExpectedEmissionRoute,
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

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

export type SettledWait = Readonly<{ kind: "observed"; event: RpcEvent }> | Readonly<{ kind: "failed"; error: unknown }>;

export const settleWait = (wait: Promise<RpcEvent>): Promise<SettledWait> =>
  wait.then(
    (event): SettledWait => canonicalRecord({ kind: "observed" as const, event }),
    (error): SettledWait => canonicalRecord({ kind: "failed" as const, error }),
  );

/** The custom-entry type an `entry_appended` event carries, or undefined. */
const customEntryTypeOf = (event: RpcEvent): unknown => {
  if (event.type !== "entry_appended") return undefined;
  const entry = recordOf(event["entry"]);
  return entry === null ? undefined : entry["customType"];
};

/** Every collected `entry_appended` event of one custom entry type. */
export const customEntriesOf = (bus: RpcBus, customType: string): readonly RpcEvent[] =>
  bus.snapshot().filter((event) => customEntryTypeOf(event) === customType);

export const readinessPredicate = (event: RpcEvent): boolean => customEntryTypeOf(event) === READINESS_ENTRY_TYPE;

export const entryDataOf = (event: RpcEvent): unknown => {
  const entry = recordOf(event["entry"]);
  return entry === null ? undefined : entry["data"];
};

export const holdResolvedPredicate = (event: RpcEvent): boolean => {
  if (customEntryTypeOf(event) !== HOLD_ENTRY_TYPE) return false;
  const data = recordOf(entryDataOf(event));
  return data !== null && data["phase"] === "resolved";
};

// ---------------------------------------------------------------------------
// The launcher-side barrier shell every real-child runner drives
// ---------------------------------------------------------------------------

type PiRpcChildOptions = Readonly<{
  /** How diagnostics name the child, e.g. "pi child" or "production child". */
  role: string;
  /** The request-id prefix, unique per run. */
  idPrefix: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The response budget of every request after the first get_state. */
  responseTimeoutMs: number;
}>;

export type PiRpcChild = Readonly<{
  child: ChildProcess;
  bus: RpcBus;
  /** Frame one request and wait, bounded, for its correlated response. */
  rpcRequest: (message: Record<string, unknown>, label: string) => Promise<RpcEvent>;
  /** True once the child failed to spawn or exited. */
  gone: () => boolean;
  /** After a failed bounded wait: throw as INFRASTRUCTURE when the child is
   *  gone (never a minted refusal); a live child returns. */
  assertAliveAfterWait: (error: unknown) => void;
  stderr: () => string;
  /** SIGKILL the child once — this run's own reservation; later calls are inert. */
  release: () => void;
  releasedAt: () => number | null;
  /** Release, then wait (capped at 1.5s) for the child's exit. */
  dispose: () => Promise<void>;
}>;

/**
 * Spawn ONE real headless `pi --mode rpc` child and wire the launcher's view
 * of it: the strict JSONL bus over stdout, stderr capture, and the request
 * framing. The first `get_state` (the channel check) gets
 * CHANNEL_STARTUP_TIMEOUT_MS — a cold pi start under parallel suite load —
 * and every later request the runner's own budget. A spawn error or exit
 * fails every pending wait with its reason, so no bounded wait outlives its
 * child. The three runners keep only their scenario-specific protocol steps.
 */
export const openPiRpcChild = (options: PiRpcChildOptions): PiRpcChild => {
  const child = spawn(piBinary.bin, [...options.args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });
  if (child.stdout === null) {
    child.kill("SIGKILL");
    throw new Error(`the ${options.role} has no stdout pipe`);
  }
  const bus = makeRpcBus(child.stdout);
  let spawnError: Error | null = null;
  let childExited = false;
  let releasedAt: number | null = null;
  child.on("error", (error: Error) => {
    spawnError = error;
    bus.failAll(`the ${options.role} process failed: ${error.message}`);
  });
  child.on("exit", (code: number | null, signal: string | null) => {
    childExited = true;
    bus.failAll(`the ${options.role} exited (code ${code === null ? "none" : code}, signal ${signal === null ? "none" : signal}) while the launcher was observing it`);
  });
  const stderrChunks: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString());
  });
  let rpcCallCounter = 0;
  const rpcRequest = async (message: Record<string, unknown>, label: string): Promise<RpcEvent> => {
    const stdin = child.stdin;
    if (stdin === null || !stdin.writable) {
      const cause: Error | null = spawnError;
      throw new Error(`the ${options.role}'s stdin is not writable for ${label}${cause === null ? "" : ` (spawn error: ${cause.message})`}`);
    }
    const id = `${options.idPrefix}-${++rpcCallCounter}`;
    stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    return bus.waitFor((event) => event.type === "response" && event["id"] === id,
      message["type"] === "get_state" && rpcCallCounter === 1 ? CHANNEL_STARTUP_TIMEOUT_MS : options.responseTimeoutMs, label);
  };
  const gone = (): boolean => spawnError !== null || childExited;
  const release = (): void => {
    if (releasedAt !== null) return;
    releasedAt = Date.now();
    child.kill("SIGKILL");
  };
  return Object.freeze({
    child,
    bus,
    rpcRequest,
    gone,
    assertAliveAfterWait: (error: unknown): void => {
      if (gone()) throw new Error(`the ${options.role} died during a bounded wait: ${boundedDiagnostic(error)}`);
    },
    stderr: (): string => boundDiagnosticMessage(stderrChunks.join("").trim()),
    release,
    releasedAt: (): number | null => releasedAt,
    dispose: async (): Promise<void> => {
      release();
      await Promise.race([exited, sleep(1500)]);
    },
  });
};

/** 1. Channel check — "child up, readiness missing" must be distinguishable
 *  from "child never came up" (infrastructure). */
export const observeChannel = async (
  rpc: PiRpcChild,
): Promise<Readonly<{ channelAlive: boolean; channelDiagnostic: string | null }>> => {
  try {
    const state = await rpc.rpcRequest({ type: "get_state" }, "get_state");
    return state["success"] === true
      ? { channelAlive: true, channelDiagnostic: null }
      : { channelAlive: false, channelDiagnostic: `get_state answered success=false: ${boundedEvent(state)}` };
  } catch (error) {
    return { channelAlive: false, channelDiagnostic: boundedDiagnostic(error) };
  }
};

/** 2. Discovery — the command inventory get_commands reports. The readiness
 *  command must be REGISTERED before it is invoked: an unknown /command would
 *  fall through to a real model request. */
export const discoverCommands = async (rpc: PiRpcChild): Promise<readonly Record<string, unknown>[]> => {
  const response = await rpc.rpcRequest({ type: "get_commands" }, "get_commands");
  const data = recordOf(response["data"]);
  const raw = data === null ? undefined : data["commands"];
  return Array.isArray(raw)
    ? raw.map(recordOf).filter((record): record is Record<string, unknown> => record !== null)
    : [];
};

export const listsExtensionCommand = (commands: readonly Record<string, unknown>[], name: string): boolean =>
  commands.some((command) => command["name"] === name && command["source"] === "extension");

/** 3. One settled bounded readiness wait as the observation the gate reads:
 *  an observed entry carries its payload and arrival time; a failed wait on a
 *  dead child throws as infrastructure, and on a live child is `unobserved`. */
export const settledReadiness = (
  outcome: SettledWait,
  rpc: PiRpcChild,
  unobserved: () => ReadinessObservation,
): Readonly<{ readiness: ReadinessObservation; observedAt: number | null }> => {
  if (outcome.kind === "observed") {
    return {
      readiness: canonicalRecord({ kind: "observed" as const, payload: entryDataOf(outcome.event) }),
      observedAt: Date.now(),
    };
  }
  rpc.assertAliveAfterWait(outcome.error);
  return { readiness: unobserved(), observedAt: null };
};

export const readinessAbsentWithinWindow = (): ReadinessObservation =>
  canonicalRecord({ kind: "absent" as const, reason: `no readiness entry arrived within ${READY_TIMEOUT_MS}ms` });

/** 4. The pure readiness decision over the observed protocol facts, then —
 *  only on a ready child — the fail-closed route binding and the route
 *  decision: the decision the launcher acts on. A refused readiness is final;
 *  no route is ever bound for it. */
export const decideStartupThroughRouteBind = async (
  rpc: PiRpcChild,
  expectation: EmissionStartupExpectation,
  facts: ReadinessProbeFacts,
): Promise<EmissionStartupDecision> => {
  const readiness = decideReadinessGate(expectation, parseReadinessStageObservation(facts));
  if (readiness.kind === "refused") return readiness;
  return decideStartupRoute(expectation.route, readiness, await bindRouteWithSettle(rpc.rpcRequest, expectation.route));
};

export const issuedPromptText = (expectation: EmissionStartupExpectation): string =>
  `Emit the issued ${expectation.binding.kind.kind} payload via ${expectation.binding.toolName}.`;

/** 5. Prompt delivery — only ever on the open arm. */
export const deliverIssuedPrompt = async (rpc: PiRpcChild, expectation: EmissionStartupExpectation): Promise<void> => {
  await rpc.rpcRequest({ type: "set_auto_retry", enabled: false }, "set_auto_retry");
  await rpc.rpcRequest({ type: "prompt", message: issuedPromptText(expectation) }, "prompt delivery");
};

export const awaitFirstRequestOrDeadline = async (server: CountingServer): Promise<void> => {
  const requestDeadline = Date.now() + FIRST_REQUEST_TIMEOUT_MS;
  while (server.hits.length === 0 && Date.now() < requestDeadline) await sleep(50);
};

// ---------------------------------------------------------------------------
// Assertion helpers (narrowing without casts)
// ---------------------------------------------------------------------------

export type OpenDecision = Extract<EmissionStartupDecision, { kind: "open" }>;
export type RefusedDecision = Extract<EmissionStartupDecision, { kind: "refused" }>;

/** A one-line rendering of either decision stage, for assertion diagnostics. */
const describeStartupDecision = (decision: EmissionStartupDecision | EmissionReadinessGateDecision): string => {
  switch (decision.kind) {
    case "open":
      return `open on ${decision.readiness.toolName} (${decision.readiness.version}) via ${decision.route.provider}/${decision.route.modelId}`;
    case "ready":
      return `ready on ${decision.readiness.toolName} (${decision.readiness.version})`;
    case "refused":
      return `refused: ${decision.code}`;
  }
};

export const asOpen = (decision: EmissionStartupDecision): OpenDecision => {
  if (decision.kind !== "open") throw new Error(`expected an OPEN decision, received ${describeStartupDecision(decision)}`);
  return decision;
};

export const asReady = (decision: EmissionReadinessGateDecision): Extract<EmissionReadinessGateDecision, { kind: "ready" }> => {
  if (decision.kind !== "ready") throw new Error(`expected a READY readiness decision, received ${describeStartupDecision(decision)}`);
  return decision;
};

export const asRefused = (decision: EmissionStartupDecision | EmissionReadinessGateDecision): RefusedDecision => {
  if (decision.kind !== "refused") throw new Error(`expected a REFUSED decision, received ${describeStartupDecision(decision)}`);
  return decision;
};

/** The observation every barrier run carries — the protocol-fixture runs and
 *  the production-extension runs alike — so ONE set of assertion helpers
 *  serves both suites. */
export type GateRun = Readonly<{
  label: string;
  decision: EmissionStartupDecision;
  prompted: boolean;
  requestCount: number;
  firstRequestAt: number | null;
  readinessObservedAt: number | null;
  childKilled: boolean;
  stderr: string;
}>;

export const expectOpenRun = (run: GateRun): OpenDecision => {
  if (run.decision.kind !== "open") {
    throw new Error(`[${run.label}] expected the gate to OPEN, received ${describeStartupDecision(run.decision)} — ${run.decision.message}; stderr: ${run.stderr}`);
  }
  return run.decision;
};

const expectRefusedRun = (run: GateRun): RefusedDecision => {
  if (run.decision.kind !== "refused") {
    throw new Error(`[${run.label}] expected a REFUSED decision, received ${describeStartupDecision(run.decision)}; stderr: ${run.stderr}`);
  }
  return run.decision;
};

/** The shared negative-control assertion: the decision refused with exactly
 *  the expected code, the message names its remediation, the launcher never
 *  prompted, ZERO model requests reached the counting substitute, and the
 *  refusing child's own reservation was released. */
export const expectZeroRequestRefusal = (run: GateRun, code: EmissionStartupRefusalCode): RefusedDecision => {
  const refusedDecision = expectRefusedRun(run);
  expect(refusedDecision.code, run.label).toBe(code);
  expect(refusedDecision.message, run.label).toContain(EMISSION_STARTUP_REMEDIATIONS[code]);
  expect(run.prompted, run.label).toBe(false);
  expect(run.requestCount, run.label).toBe(0);
  expect(run.firstRequestAt, run.label).toBeNull();
  expect(run.childKilled, run.label).toBe(true);
  return refusedDecision;
};

export const orderingPair = (run: GateRun): { readonly firstRequestAt: number; readonly readinessObservedAt: number } => {
  if (run.firstRequestAt === null || run.readinessObservedAt === null) {
    throw new Error(`[${run.label}] missing ordering timestamps (first=${run.firstRequestAt}, readiness=${run.readinessObservedAt})`);
  }
  return { firstRequestAt: run.firstRequestAt, readinessObservedAt: run.readinessObservedAt };
};

/**
 * Run `operation` against overridden ambient process state and restore every
 * touched value in `finally`, so no test leaks state into a later one. Each
 * `env` key holds its value for the operation (`undefined` deletes it); every
 * named key is snapshotted and restored, including keys the operation itself
 * reassigns. `clearArgv1` hides the runner's script path from launchers that
 * would otherwise re-exec it instead of resolving `pi` on PATH.
 */
export const withProcessState = async <T>(
  state: Readonly<{ env: Readonly<Record<string, string | undefined>>; clearArgv1?: boolean }>,
  operation: () => T | Promise<T>,
): Promise<T> => {
  const assignEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  const previousEnv = Object.keys(state.env).map((key) => [key, process.env[key]] as const);
  const previousArgv1 = process.argv[1];
  for (const [key, value] of Object.entries(state.env)) assignEnv(key, value);
  if (state.clearArgv1 === true) delete process.argv[1];
  try {
    return await operation();
  } finally {
    for (const [key, value] of previousEnv) assignEnv(key, value);
    if (state.clearArgv1 === true) {
      if (previousArgv1 === undefined) delete process.argv[1];
      else process.argv[1] = previousArgv1;
    }
  }
};
