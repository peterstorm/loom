/**
 * The emission-child harness: the launcher's view of a real headless
 * `pi --mode rpc` child, shared by every emission readiness suite
 * (`engine/tests/pi/emission-*.test.ts`) so none of them imports another.
 *
 * It owns the explicit pi binary resolution (PI_BIN env, then the
 * repo-resolved `node_modules/.bin/pi`, then PATH), the launcher expectation
 * mint over the shared registry cells (`emission-registry-cells`: the cell's
 * binding through the REAL `issueEmissionBinding` over `EMISSION_TOOL_SPECS`,
 * the schema digest derived from the frozen bytes, never trusted — the
 * harness declares no cell of its own), the COUNTING PROVIDER SUBSTITUTE (a
 * local HTTP server that counts and rejects completions, so a model request is
 * a counted event, never a real call), the strict JSONL RPC bus and request
 * framing, the probe-proven launcher steps (channel check, discovery, bounded
 * readiness wait, the fail-closed settle-aware route bind, prompt delivery
 * only on open) as the harness adapter of the PRODUCTION launcher step
 * sequence (`pi/emission-readiness-sequence.ts`) that `runLauncherBarrier`
 * drives inside the `withBarrierResources` lifecycle bracket, the real-RPC
 * adapter (`rpcReadinessClient`) through which a real child drives the
 * verifier the parent bridge ships, the shared gate-run assertions, and the
 * ambient-process-state scope the in-process suites restore.
 *
 * Neither the step ORDER nor the gate decisions live here: the sequence and
 * the gate (`pi/emission-readiness-gate.ts`) are production code, and the
 * shipped verifier is the step port's other adapter, so a stage the launcher
 * adds or reorders reaches these suites too. The harness owns only what the
 * shipped verifier's RPC client cannot express — the pinned-endpoint route,
 * the decision ADT the suites assert codes, the opened readiness and the
 * bound route on, and the readiness-wait controls (a bounded-window timeout,
 * a launcher cancellation, a child death mid-wait, a command-error
 * `startup-unavailable`). The shipped verifier itself runs against a real
 * child through `rpcReadinessClient` (emission-startup-production.test.ts).
 */

import { expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../../src/core/digest";
import {
  EMISSION_STARTUP_REMEDIATIONS,
  type EmissionReadinessGateDecision,
  type EmissionStartupDecision,
  type EmissionStartupExpectation,
  type EmissionStartupRefusalCode,
  type ExpectedEmissionRoute,
  type ReadinessObservation,
  type RouteObservation,
} from "../../../pi/emission-readiness-gate";
import {
  runEmissionStartupSequence,
  type ChannelObservation,
  type EmissionStartupSteps,
} from "../../../pi/emission-readiness-sequence";
import {
  boundDiagnosticMessage,
  canonicalRecord,
  describeUnknown,
  parseContextDigest,
  success,
  type ContextDigest,
} from "../../src/core/orchestration-contract/identity";
import { withEnvOverlay, type EnvironmentOverlay } from "./issue-route-env";
import type { PiSubagentLaunchReply } from "../../../pi/emission-launch-bridge";
import { canonicalTempDir } from "./canonical-temp-dir";
import { mintedBindingFor, type RegistryCell } from "./emission-registry-cells";

// ---------------------------------------------------------------------------
// Shared unknown-value helpers (the one confined projection of untrusted data)
// ---------------------------------------------------------------------------

/** The ONE confined cast over untrusted records (RPC payloads, parsed JSON):
 *  a null-prototype-safe object view, or null. Every consumer guards. */
export const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const stringifyUnknown = (value: unknown): string => (typeof value === "string" ? value : describeUnknown(value));

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
 * The launcher expectation mint: the shared registry-cell binding mint (the
 * REAL issuance mint over the frozen registry), claiming the cell's request
 * id, kind, version, exact tool name and the digest derived from its frozen
 * bytes — the mint certifies the claims against the registry, so the
 * expectation can never name a schema the registry does not freeze. The
 * harness owns the counting provider's registration, so its route pins the
 * serving endpoint too.
 */
export type HarnessExpectation = EmissionStartupExpectation & Readonly<{
  route: Extract<ExpectedEmissionRoute, { kind: "pinned-endpoint" }>;
}>;

export const makeExpectation = (cell: RegistryCell, requestId: string, routeBaseUrl: string): HarnessExpectation =>
  canonicalRecord({
    binding: mintedBindingFor(cell, requestId),
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
export const observeChannel = async (rpc: PiRpcChild): Promise<ChannelObservation> => {
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

/** The issued request the prompt names: only its binding is read. */
type IssuedPromptSource = Pick<EmissionStartupExpectation, "binding">;

export const issuedPromptText = (issued: IssuedPromptSource): string =>
  `Emit the issued ${issued.binding.kind.kind} payload via ${issued.binding.toolName}.`;

/** 5. Prompt delivery — only ever on the open arm. */
export const deliverIssuedPrompt = async (rpc: PiRpcChild, issued: IssuedPromptSource): Promise<void> => {
  await rpc.rpcRequest({ type: "set_auto_retry", enabled: false }, "set_auto_retry");
  await rpc.rpcRequest({ type: "prompt", message: issuedPromptText(issued) }, "prompt delivery");
};

export const awaitFirstRequestOrDeadline = async (server: CountingServer): Promise<void> => {
  const requestDeadline = Date.now() + FIRST_REQUEST_TIMEOUT_MS;
  while (server.hits.length === 0 && Date.now() < requestDeadline) await sleep(50);
};

// ---------------------------------------------------------------------------
// The one launcher barrier run every real-child suite drives
// ---------------------------------------------------------------------------

/** The per-run infrastructure a barrier run owns: its own counting
 *  substitute, its own temp dir, and the children it adopted for release. */
export type BarrierResources = Readonly<{
  server: CountingServer;
  tmp: string;
  /** Register a spawned child so the bracket releases it in every outcome. */
  adopt: (rpc: PiRpcChild) => PiRpcChild;
}>;

/**
 * The lifecycle bracket of one real-child run: start the counting substitute
 * and a canonical temp dir, run `body`, then — in every outcome — dispose
 * exactly the children this run adopted (AS-020's release discipline: never a
 * peer's), close this run's server and remove its temp dir. `server.close`
 * never rejects (its callback resolves regardless); the temp-dir removal is
 * best-effort so cleanup can never mask the run's own outcome.
 *
 * An infrastructure failure keeps its semantics — it propagates as an error,
 * never a minted gate decision — and carries the run's own counted
 * model-request snapshot, so the zero-request property stays provable on the
 * rejection path too.
 */
export const withBarrierResources = async <T>(
  tmpPrefix: string,
  body: (resources: BarrierResources) => Promise<T>,
): Promise<T> => {
  const server = await startCountingServer();
  const tmp = canonicalTempDir(tmpPrefix);
  const adopted: PiRpcChild[] = [];
  try {
    return await body(Object.freeze({
      server,
      tmp,
      adopt: (rpc: PiRpcChild): PiRpcChild => {
        adopted.push(rpc);
        return rpc;
      },
    }));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new Error(
      `${error.message} — the counting substitute recorded ${server.hits.length} model request(s) before this failure`,
      { cause: error },
    );
  } finally {
    for (const rpc of adopted) await rpc.dispose();
    await server.close();
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** What the launcher does while its bounded readiness wait is open. */
export type LauncherReadinessWait =
  /** Waits the bounded window out. */
  | Readonly<{ kind: "waits" }>
  /** Cancels the barrier mid-readiness-wait (the cancellation control). */
  | Readonly<{ kind: "cancels"; afterMs: number }>
  /** SIGKILLs the child this many ms AFTER the verified invocation, inside the
   *  bounded window (the infrastructure-failure boundary control). */
  | Readonly<{ kind: "kills-child"; afterMs: number }>;

/** How a launcher drives the readiness stage once discovery listed the command. */
export type ReadinessStageDriver = Readonly<{
  /** `2` re-invokes the command before the wait (the idempotence control). */
  invocations: 1 | 2;
  wait: LauncherReadinessWait;
  /** The observation a live child's unanswered bounded wait becomes. */
  unobserved: () => ReadinessObservation;
}>;

/** The barrier's record of one run: the protocol facts it observed, the
 *  decision it acted on, and whether it prompted. */
export type BarrierRun<P> = Readonly<{
  channelAlive: boolean;
  channelDiagnostic: string | null;
  commands: readonly Record<string, unknown>[];
  commandListed: boolean;
  invocationCount: number;
  readiness: ReadinessObservation;
  readinessObservedAt: number | null;
  decision: EmissionStartupDecision;
  decidedAt: number;
  prompted: boolean;
  /** What the run's `afterPrompt` returned; `null` when the barrier refused. */
  afterPrompt: P | null;
}>;

const CANCELLED_READINESS: ReadinessObservation = canonicalRecord({ kind: "cancelled" as const });

const invokeReadinessCommand = async (rpc: PiRpcChild, command: string, label: string): Promise<void> => {
  const invocation = await rpc.rpcRequest({ type: "prompt", message: `/${command}` }, label);
  if (invocation["success"] !== true) {
    throw new Error(`the ${label} was refused by the child: ${boundedEvent(invocation)}`);
  }
};

export const waitReadinessEntryCount = async (bus: RpcBus, count: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (customEntriesOf(bus, READINESS_ENTRY_TYPE).length < count) {
    if (Date.now() > deadline) {
      throw new Error(`expected ${count} readiness entries, observed ${customEntriesOf(bus, READINESS_ENTRY_TYPE).length} within ${timeoutMs}ms`);
    }
    await sleep(50);
  }
};

/** 3. Readiness — invoke the verified command (no model request) and wait,
 *  bounded, for the bound payload through entry_appended, under the
 *  launcher's wait behavior. */
const observeReadiness = async (
  rpc: PiRpcChild,
  command: string,
  driver: ReadinessStageDriver,
): Promise<Readonly<{ readiness: ReadinessObservation; observedAt: number | null }>> => {
  await invokeReadinessCommand(rpc, command, "readiness command invocation");
  if (driver.invocations === 2) await invokeReadinessCommand(rpc, command, "idempotent readiness re-invocation");
  const wait = driver.wait;
  // The child dies AFTER a verified invocation, while the bounded wait is
  // open: the launcher must surface infrastructure, never a minted refusal.
  if (wait.kind === "kills-child") setTimeout(() => rpc.release(), wait.afterMs);
  const readinessWait = settleWait(rpc.bus.waitFor(readinessPredicate, READY_TIMEOUT_MS, "readiness"));
  const outcome = wait.kind === "cancels"
    ? await Promise.race([readinessWait, sleep(wait.afterMs).then((): "cancelled" => "cancelled")])
    : await readinessWait;
  if (outcome === "cancelled") {
    rpc.release();
    return { readiness: CANCELLED_READINESS, observedAt: null };
  }
  const settled = settledReadiness(outcome, rpc, driver.unobserved);
  if (outcome.kind === "observed" && driver.invocations === 2) {
    await waitReadinessEntryCount(rpc.bus, 2, READY_TIMEOUT_MS);
  }
  return settled;
};

/** 5. Act on the closed verdict: prompt delivery ONLY on the open arm, then
 *  the run's own post-prompt observation; a refusal waits the grace window
 *  out so a cheating child's late request would still be counted. */
export const actOnGateVerdict = async <P>(
  rpc: PiRpcChild,
  issued: IssuedPromptSource,
  open: boolean,
  afterPrompt: () => Promise<P>,
): Promise<Readonly<{ prompted: boolean; afterPrompt: P | null }>> => {
  if (!open) {
    await sleep(REFUSE_GRACE_MS);
    return { prompted: false, afterPrompt: null };
  }
  await deliverIssuedPrompt(rpc, issued);
  return { prompted: true, afterPrompt: await afterPrompt() };
};

/** What the harness's discovery step keeps beside the listing verdict: the
 *  raw inventory, for the suites' discovery diagnostics. */
type HarnessDiscovery = Readonly<{ commandListed: boolean; commands: readonly Record<string, unknown>[] }>;

/** What the harness's readiness step keeps beside the observation: when it arrived. */
type HarnessReadinessStage = Readonly<{ readiness: ReadinessObservation; observedAt: number | null }>;

/**
 * The harness's adapter of the production launcher step port
 * (`pi/emission-readiness-sequence.ts`) — the second adapter beside the
 * verifier the parent bridge ships. Each step is the real RPC exchange with
 * the harness's controls (the bounded-window timeout, cancellation, a child
 * death mid-wait, a command-error `startup-unavailable`, the idempotent
 * re-invocation) and the settle-aware pinned-endpoint route bind. Its
 * transport failures are INFRASTRUCTURE — they throw, so the port's error arm
 * is `never` and a hostile-payload throw from the gate propagates the same way.
 */
const launcherSteps = (
  rpc: PiRpcChild,
  readinessCommand: string,
  driver: ReadinessStageDriver,
): EmissionStartupSteps<never, HarnessDiscovery, HarnessReadinessStage> => Object.freeze({
  observeChannel: async () => success(await observeChannel(rpc)),
  discoverReadinessCommand: async () => {
    const commands = await discoverCommands(rpc);
    return success(Object.freeze({ commandListed: listsExtensionCommand(commands, readinessCommand), commands }));
  },
  observeReadiness: async () => success(Object.freeze(await observeReadiness(rpc, readinessCommand, driver))),
  bindRoute: async (route) => success(await bindRouteWithSettle(rpc.rpcRequest, route)),
  gateThrew: (thrown): never => {
    throw thrown;
  },
});

/**
 * The launcher barrier: the production launcher step sequence over the
 * harness's real-RPC adapter (channel check → discovery → readiness only for
 * a listed command → the pure gate → the fail-closed route bind only on a
 * ready child), then `onDecided` → prompt only on open, then `afterPrompt`.
 * Every step is bounded. The release stays with the caller, so a run can hold
 * its child mid-flight across a peer's release.
 */
export const runLauncherBarrier = async <P>(
  rpc: PiRpcChild,
  expectation: EmissionStartupExpectation,
  driver: ReadinessStageDriver,
  hooks: Readonly<{ onDecided?: () => void; afterPrompt: () => Promise<P> }>,
): Promise<BarrierRun<P>> => {
  const sequenced = await runEmissionStartupSequence(expectation, launcherSteps(rpc, expectation.readinessCommand, driver));
  // The adapter's error arm is `never`: its failures threw above.
  if (!sequenced.ok) return sequenced.error;
  const { channel, discovery, readinessStage, facts, decision } = sequenced.value;
  hooks.onDecided?.();
  const decidedAt = Date.now();
  const acted = await actOnGateVerdict(rpc, expectation, decision.kind === "open", hooks.afterPrompt);
  return Object.freeze({
    channelAlive: channel.channelAlive,
    channelDiagnostic: channel.channelDiagnostic,
    commands: discovery === null ? [] : discovery.commands,
    commandListed: facts.commandListed,
    invocationCount: facts.commandListed ? driver.invocations : 0,
    readiness: facts.readiness,
    readinessObservedAt: readinessStage === null ? null : readinessStage.observedAt,
    decision,
    decidedAt,
    prompted: acted.prompted,
    afterPrompt: acted.afterPrompt,
  });
};

// ---------------------------------------------------------------------------
// The shipped verifier's readiness client over a REAL pi RPC child
// ---------------------------------------------------------------------------

/** The emission-rpc directive the parent bridge mints for one staged launch. */
export type PiEmissionRpcDirective = Extract<PiSubagentLaunchReply, { kind: "emission-rpc" }>["directive"];
/** The readiness verifier the parent bridge hands the installed launcher. */
export type PiReadinessVerifier = PiEmissionRpcDirective["verifyReadiness"];
/** The port that verifier drives. */
export type PiReadinessClient = Parameters<PiReadinessVerifier>[0];

/**
 * The real-RPC adapter of the shipped verifier's readiness port — the second
 * adapter beside the plain fake in `emission-launch-bridge.test.ts`, so the
 * verifier `pi/emission-launch-bridge.ts` ships is exercised against a real
 * child. Each method is the launcher's RPC exchange: `get_commands`; the
 * readiness command invoked once, then the bounded entry wait (an unanswered
 * wait on a live child is zero entries, which the verifier refuses as
 * malformed readiness; a dead child throws as infrastructure); the
 * settle-aware `set_model` bind, throwing its refusal so the verifier refuses
 * it as an RPC failure; and `get_state`'s data record.
 */
export const rpcReadinessClient = (rpc: PiRpcChild): PiReadinessClient => Object.freeze({
  getCommands: async () => (await discoverCommands(rpc)).flatMap((command) => {
    const name = command["name"];
    const source = command["source"];
    if (typeof name !== "string") return [];
    return [typeof source === "string" ? Object.freeze({ name, source }) : Object.freeze({ name })];
  }),
  invokeReadiness: async () => {
    await invokeReadinessCommand(rpc, READINESS_COMMAND_NAME, "readiness command invocation");
    const outcome = await settleWait(rpc.bus.waitFor(readinessPredicate, READY_TIMEOUT_MS, "readiness"));
    if (outcome.kind === "failed") {
      rpc.assertAliveAfterWait(outcome.error);
      return [];
    }
    return [outcome.event["entry"]];
  },
  setModel: async (provider: string, modelId: string) => {
    const bound = await bindRouteWithSettle(rpc.rpcRequest, { kind: "issued-model", provider, modelId });
    if (bound.kind !== "bound") throw new Error(bound.kind === "failed" ? bound.reason : "the route bind produced no binding");
  },
  getState: async () => {
    const state = await rpc.rpcRequest({ type: "get_state" }, "get_state route observation");
    const data = recordOf(state["data"]);
    if (state["success"] !== true || data === null) throw new Error(`get_state refused: ${boundedEvent(state)}`);
    return { model: recordOf(data["model"]) };
  },
});

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
 * touched value in `finally`, so no test leaks state into a later one. The
 * `env` overlay is the shared `withEnvOverlay` scope (`undefined` deletes a
 * key; every named key is snapshotted and restored, including keys the
 * operation itself reassigns). `clearArgv1` hides the runner's script path
 * from launchers that would otherwise re-exec it instead of resolving `pi` on
 * PATH.
 */
export const withProcessState = async <T>(
  state: Readonly<{ env: EnvironmentOverlay; clearArgv1?: boolean }>,
  operation: () => T | Promise<T>,
): Promise<T> => {
  const previousArgv1 = process.argv[1];
  if (state.clearArgv1 === true) delete process.argv[1];
  try {
    return await withEnvOverlay(state.env, operation);
  } finally {
    if (state.clearArgv1 === true) {
      if (previousArgv1 === undefined) delete process.argv[1];
      else process.argv[1] = previousArgv1;
    }
  }
};
