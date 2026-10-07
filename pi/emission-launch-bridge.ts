/**
 * Installed subagent launcher port (AD-4 / FR-008 / FR-031).
 *
 * The synchronous request/reply bridge between this extension and the shared
 * normal subagent launcher: capability probing, staging of admitted
 * emission-enabled launches, the launcher's resolve handshake, and the
 * readiness verifier the launcher runs before any Task prompt. The verifier is
 * RPC I/O plus response parsing only: every child readiness and route state it
 * observes is decided by the pure gate in `pi/emission-readiness-gate.ts`, so
 * the bridge carries no refusal vocabulary of its own beyond RPC transport
 * failures. Also owns the launch-slot vocabulary the result side uses to
 * authenticate a launcher's pre-prompt startup refusal.
 */

import type { SpawnEmissionExpectation } from "../engine/src/core/issued-emission-capability";
import { isRecord } from "../engine/src/core/plain-record";
import {
  boundedThrownCause,
  describeUnknown,
  failure,
  success,
  type DomainResult,
} from "../engine/src/core/orchestration-contract/identity";
import type { ContextDigest } from "../engine/src/core/orchestration-contract";
import type { IssuedEmissionBinding, IssuedEmissionBindingOf } from "../engine/src/core/emission-tool";
import { EMISSION_READINESS_COMMAND, EMISSION_READINESS_ENTRY_TYPE } from "./emission-tool";
import {
  decideReadinessGate,
  decideStartupRoute,
  parseReadinessStageObservation,
  type EmissionReadinessGateDecision,
  type EmissionStartupExpectation,
  type ReadinessObservation,
  type ReadinessProbeFacts,
  type RouteObservation,
} from "./emission-readiness-gate";

export const LOOM_SUBAGENT_LAUNCH_CHANNEL = "loom:subagent-launch:v2";

export type PiSubagentLaunchSlot =
  | Readonly<{ kind: "single"; index: 0 }>
  | Readonly<{ kind: "parallel"; index: number }>
  | Readonly<{ kind: "chain"; index: number }>;

type PiSubagentReadinessClient = Readonly<{
  getCommands: () => Promise<readonly Readonly<{ name: string; source?: string }>[]>;
  invokeReadiness: () => Promise<readonly unknown[]>;
  setModel: (provider: string, modelId: string) => Promise<void>;
  getState: () => Promise<Readonly<{
    model: null | Readonly<{ provider?: string; id?: string; [key: string]: unknown }>;
  }>>;
}>;

type PiEmissionRpcDirective = Readonly<{
  kind: "emission-rpc";
  bindingEnv: string;
  expectedProvider: string;
  expectedModel: string;
  expectedToolName: string;
  verifyReadiness: (
    client: PiSubagentReadinessClient,
  ) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>>;
}>;

export type PiSubagentLaunchReply =
  | Readonly<{ kind: "not-admitted" }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "emission-rpc"; directive: PiEmissionRpcDirective }>;

type PiSubagentLaunchResolveRequest = Readonly<{
  kind: "resolve";
  sessionId: string;
  toolCallId: string;
  slot: PiSubagentLaunchSlot;
  agent: string;
  task: string;
  cwd: string;
  effectiveModel: Readonly<{ provider: string; id: string }>;
  respond: (reply: Exclude<PiSubagentLaunchReply, { kind: "not-admitted" }>) => void;
}>;

type PiSubagentLaunchCapabilityReply = Readonly<{ kind: "available"; version: 2 }>;

type PiSubagentLaunchCapabilityProbe = Readonly<{
  kind: "capability";
  version: 2;
  respond: (reply: unknown) => void;
}>;

export type PiSubagentLaunchEventBus = Readonly<{
  emit: (channel: string, event: unknown) => void;
  on: (channel: string, handler: (event: unknown) => void) => () => void;
}>;

export type PiEmissionLaunchExpectation = Readonly<{
  sessionId: string;
  toolCallId: string;
  slot: PiSubagentLaunchSlot;
  agent: string;
  task: string;
  cwd: string;
  expectation: Extract<SpawnEmissionExpectation, { kind: "emission-enabled" }>;
  revision: string;
}>;

type PiEmissionLaunchStage =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string }>;

type PiEmissionLaunchAvailability =
  | Readonly<{ kind: "available" }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export type PiEmissionLaunchBridge = Readonly<{
  probe: () => PiEmissionLaunchAvailability;
  stage: (expectations: readonly PiEmissionLaunchExpectation[]) => PiEmissionLaunchStage;
  removeToolCall: (sessionId: string, toolCallId: string) => void;
  removeSession: (sessionId: string) => void;
}>;

const launchSlotKey = (sessionId: string, toolCallId: string, slot: PiSubagentLaunchSlot): string =>
  `${sessionId}\u0000${toolCallId}\u0000${slot.kind}\u0000${slot.index}`;

export const sameLaunchSlot = (left: PiSubagentLaunchSlot, right: PiSubagentLaunchSlot): boolean =>
  left.kind === right.kind && left.index === right.index;

export const exactFields = (record: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean => {
  const keys = Object.keys(record);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(record, field));
};

const parsePiSubagentLaunchCapabilityReply = (
  raw: unknown,
): DomainResult<PiSubagentLaunchCapabilityReply, Readonly<{ reason: string }>> => {
  const expected = 'exactly { kind: "available", version: 2 }';
  if (!isRecord(raw)) {
    return failure(Object.freeze({
      reason: `expected ${expected}; received ${describeUnknown(raw)}`,
    }));
  }
  if (!exactFields(raw, ["kind", "version"])) {
    return failure(Object.freeze({
      reason: `expected ${expected}; received an object with incompatible fields`,
    }));
  }
  if (raw.kind !== "available") {
    return failure(Object.freeze({
      reason: `expected ${expected}; received an object with an incompatible kind`,
    }));
  }
  if (raw.version !== 2) {
    return failure(Object.freeze({
      reason: `expected ${expected}; received an object with an incompatible version`,
    }));
  }
  return success(Object.freeze({ kind: "available" as const, version: 2 as const }));
};

export const parsePiSubagentLaunchSlot = (raw: unknown): PiSubagentLaunchSlot | null => {
  if (!isRecord(raw) || !exactFields(raw, ["kind", "index"]) ||
      (raw.kind !== "single" && raw.kind !== "parallel" && raw.kind !== "chain") ||
      typeof raw.index !== "number" || !Number.isSafeInteger(raw.index) || raw.index < 0 ||
      (raw.kind === "single" && raw.index !== 0)) return null;
  if (raw.kind === "single") return Object.freeze({ kind: "single" as const, index: 0 as const });
  return raw.kind === "parallel"
    ? Object.freeze({ kind: "parallel" as const, index: raw.index })
    : Object.freeze({ kind: "chain" as const, index: raw.index });
};

/** Correlation-tier fields every resolve event must carry before the bridge
 *  replies at all: without these the event cannot be correlated or answered,
 *  so it is dropped silently (exactly as today). */
type PiSubagentLaunchResolveCorrelation = Readonly<{
  sessionId: string;
  toolCallId: string;
  slot: PiSubagentLaunchSlot;
  respond: (reply: Exclude<PiSubagentLaunchReply, { kind: "not-admitted" }>) => void;
}>;

type PiSubagentLaunchResolveParse =
  | Readonly<{ kind: "silent" }>
  | Readonly<{ kind: "malformed"; correlation: PiSubagentLaunchResolveCorrelation; reason: string }>
  | Readonly<{ kind: "resolved"; request: PiSubagentLaunchResolveRequest }>;

/** A type-guard, not a truthiness cast: the narrowing carries the reply
 *  signature so the parsed correlation is a validated type, not a `Function`. */
const isPiSubagentLaunchResponder = (
  value: unknown,
): value is PiSubagentLaunchResolveCorrelation["respond"] => typeof value === "function";

const malformedResolve = (
  correlation: PiSubagentLaunchResolveCorrelation,
  reason: string,
): PiSubagentLaunchResolveParse => Object.freeze({ kind: "malformed" as const, correlation, reason });

/** Parse, never cast: a correlated resolve with a malformed agent/task/cwd or
 *  effectiveModel is still ANSWERABLE, so it gets one bounded field-specific
 *  refusal instead of a silent drop or an untyped comparison downstream. The
 *  effectiveModel is admitted only with EXACTLY the string fields provider and
 *  id, so `launchRequestMismatch` reads a guaranteed shape — no optional
 *  chain, no partial trust. */
const parsePiSubagentLaunchResolveRequest = (raw: unknown): PiSubagentLaunchResolveParse => {
  if (!isRecord(raw) || raw.kind !== "resolve" ||
      typeof raw.sessionId !== "string" || typeof raw.toolCallId !== "string" ||
      !isPiSubagentLaunchResponder(raw.respond)) return Object.freeze({ kind: "silent" as const });
  const slot = parsePiSubagentLaunchSlot(raw.slot);
  if (slot === null) return Object.freeze({ kind: "silent" as const });
  const correlation: PiSubagentLaunchResolveCorrelation = Object.freeze({
    sessionId: raw.sessionId,
    toolCallId: raw.toolCallId,
    slot,
    respond: raw.respond,
  });
  if (typeof raw.agent !== "string") return malformedResolve(correlation, "expected a string agent");
  if (typeof raw.task !== "string") return malformedResolve(correlation, "expected a string task");
  if (typeof raw.cwd !== "string") return malformedResolve(correlation, "expected a string cwd");
  const effectiveModel = raw.effectiveModel;
  if (!isRecord(effectiveModel) || !exactFields(effectiveModel, ["provider", "id"])) {
    return malformedResolve(
      correlation,
      "expected effectiveModel to be a record with exactly the string fields provider and id",
    );
  }
  if (typeof effectiveModel.provider !== "string") {
    return malformedResolve(correlation, "expected a string effectiveModel provider");
  }
  if (typeof effectiveModel.id !== "string") {
    return malformedResolve(correlation, "expected a string effectiveModel id");
  }
  return Object.freeze({
    kind: "resolved" as const,
    request: Object.freeze({
      kind: "resolve" as const,
      sessionId: correlation.sessionId,
      toolCallId: correlation.toolCallId,
      slot: correlation.slot,
      agent: raw.agent,
      task: raw.task,
      cwd: raw.cwd,
      effectiveModel: Object.freeze({ provider: effectiveModel.provider, id: effectiveModel.id }),
      respond: correlation.respond,
    }),
  });
};

const launchRequestMismatch = (
  request: PiSubagentLaunchResolveRequest,
  launch: PiEmissionLaunchExpectation,
): "session" | "agent" | "task" | "cwd" | "effective route" | null => {
  if (request.sessionId !== launch.sessionId) return "session";
  if (request.agent !== launch.agent) return "agent";
  if (request.task !== launch.task) return "task";
  if (request.cwd !== launch.cwd) return "cwd";
  if (request.effectiveModel.provider !== launch.expectation.route.provider ||
      request.effectiveModel.id !== launch.expectation.route.model) return "effective route";
  return null;
};

const emissionBindingEnvironment = (
  expectation: Extract<SpawnEmissionExpectation, { kind: "emission-enabled" }>,
): string => JSON.stringify({
  requestId: expectation.binding.requestId,
  contextDigest: expectation.contextDigest,
  kind: expectation.binding.kind.kind,
  version: expectation.binding.version,
  toolName: expectation.binding.toolName,
  schemaDigest: expectation.binding.schemaDigest,
});

type PiReadinessVerification = Awaited<ReturnType<PiEmissionRpcDirective["verifyReadiness"]>>;
type PiReadinessRefusal = Extract<PiReadinessVerification, { ok: false }>;

const readinessRefusal = (reason: string): PiReadinessRefusal => Object.freeze({ ok: false as const, reason });

const readinessRpcRefusal = (operation: string, thrown: unknown): PiReadinessRefusal => {
  const cause = boundedThrownCause(thrown, operation);
  return readinessRefusal(
    `Emission readiness RPC ${operation} failed (${cause.name}: ${cause.message}). ` +
      "Inspect the child RPC channel, then retry the same issued request after restoring the launcher.",
  );
};

/** One readiness RPC step: await the call, then parse its response. A throw
 * from the call is refused as `<operation>`, a throw while parsing the
 * response as `<operation> response`; a parse failure is an RPC protocol
 * violation refused with its reason. Child readiness states are never refused
 * here — they parse into the gate's observations and the gate decides. */
const readinessExchange = async <T, R>(
  operation: string,
  call: () => Promise<T>,
  parseResponse: (response: T) => DomainResult<R, string>,
): Promise<DomainResult<R, PiReadinessRefusal>> => {
  let response: T;
  try {
    response = await call();
  } catch (thrown) {
    return failure(readinessRpcRefusal(operation, thrown));
  }
  try {
    const parsed = parseResponse(response);
    return parsed.ok ? success(parsed.value) : failure(readinessRefusal(parsed.error));
  } catch (thrown) {
    return failure(readinessRpcRefusal(`${operation} response`, thrown));
  }
};

/** Whether discovery listed the readiness command as an extension command. A
 *  malformed inventory breaks the RPC protocol; it is not an absent command. */
const parseReadinessCommandListing = (commands: unknown): DomainResult<boolean, string> => {
  if (!Array.isArray(commands) || !commands.every((command) =>
    isRecord(command) && typeof command.name === "string" &&
    (command.source === undefined || typeof command.source === "string"))) {
    return failure("Emission readiness RPC get_commands returned a malformed command inventory");
  }
  return success(commands.some((command) =>
    command.name === EMISSION_READINESS_COMMAND && command.source === "extension"));
};

/** The one invocation's entries as the gate's readiness observation: exactly
 *  one bound readiness custom entry is observed; any other answer is malformed
 *  readiness. A non-list breaks the RPC protocol. */
const parseReadinessEntries = (entries: unknown): DomainResult<ReadinessObservation, string> => {
  if (!Array.isArray(entries)) return failure("Emission readiness RPC invocation returned a malformed entry list");
  if (entries.length !== 1) {
    return success(Object.freeze({
      kind: "malformed" as const,
      reason: `readiness invocation produced ${entries.length} entries; exactly one is required`,
    }));
  }
  const entry = entries[0];
  if (!isRecord(entry) || entry.customType !== EMISSION_READINESS_ENTRY_TYPE || !Object.hasOwn(entry, "data")) {
    return success(Object.freeze({
      kind: "malformed" as const,
      reason: `readiness invocation did not produce one ${EMISSION_READINESS_ENTRY_TYPE} custom entry`,
    }));
  }
  return success(Object.freeze({ kind: "observed" as const, payload: entry.data }));
};

/** The child's route after `set_model`, as the gate's route observation. */
const parseRouteState = (state: unknown): RouteObservation => {
  if (!isRecord(state) || !isRecord(state.model) ||
      typeof state.model.provider !== "string" || typeof state.model.id !== "string") {
    return Object.freeze({
      kind: "failed" as const,
      reason: "Emission readiness RPC get_state returned no exact provider/model record",
    });
  }
  return Object.freeze({
    kind: "bound" as const,
    model: Object.freeze({
      provider: state.model.provider,
      id: state.model.id,
      api: typeof state.model.api === "string" ? state.model.api : null,
      baseUrl: typeof state.model.baseUrl === "string" ? state.model.baseUrl : null,
    }),
  });
};

const startupExpectationOf = (launch: PiEmissionLaunchExpectation): EmissionStartupExpectation => Object.freeze({
  binding: launch.expectation.binding,
  contextDigest: launch.expectation.contextDigest,
  revision: launch.revision,
  readinessCommand: EMISSION_READINESS_COMMAND,
  route: Object.freeze({
    kind: "issued-model" as const,
    provider: launch.expectation.route.provider,
    modelId: launch.expectation.route.model,
  }),
});

/** The readiness never runs on an unlisted command: absence is decided
 *  without an invocation (an unknown /command would reach the model). */
const NOT_INVOKED: ReadinessObservation = Object.freeze({
  kind: "absent" as const,
  reason: "the readiness command was not listed, so it was never invoked",
});

/** Readiness probe facts as the verifier observed them. `get_commands`
 *  answered by the time any fact exists, so the channel is alive. */
const observedReadinessFacts = (commandListed: boolean, readiness: ReadinessObservation): ReadinessProbeFacts =>
  Object.freeze({ channelAlive: true, channelDiagnostic: null, commandListed, readiness });

/**
 * The verifier the installed launcher runs before the Task prompt: I/O in the
 * protocol's order (discover → invoke readiness once → bind route → observe
 * route), each response parsed into the gate's observations, and every child
 * state refused by the gate's one vocabulary (`pi/emission-readiness-gate.ts`).
 */
const readinessVerifier = (
  launch: PiEmissionLaunchExpectation,
): PiEmissionRpcDirective["verifyReadiness"] => async (client) => {
  const expectation = startupExpectationOf(launch);
  const listed = await readinessExchange("get_commands", () => client.getCommands(), parseReadinessCommandListing);
  if (!listed.ok) return listed.error;
  // Exactly one invocation in this verifier, and none for an unlisted command.
  // The installed launcher also enforces this count and refuses prompt
  // delivery if a verifier cheats. The gate decides inside the guarded
  // response parse: a hostile payload's throw is a bounded RPC refusal.
  const readiness = !listed.value
    ? success<EmissionReadinessGateDecision, PiReadinessRefusal>(
        decideReadinessGate(expectation, parseReadinessStageObservation(observedReadinessFacts(false, NOT_INVOKED))),
      )
    : await readinessExchange("invoke_readiness", () => client.invokeReadiness(), (entries) => {
        const observation = parseReadinessEntries(entries);
        return observation.ok
          ? success(decideReadinessGate(
              expectation,
              parseReadinessStageObservation(observedReadinessFacts(true, observation.value)),
            ))
          : observation;
      });
  if (!readiness.ok) return readiness.error;
  if (readiness.value.kind === "refused") return readinessRefusal(readiness.value.message);
  const ready = readiness.value;
  // Route selection is deliberately after readiness. Both this verifier and
  // the installed launcher observe the exact provider/model before Task prompt.
  const bound = await readinessExchange(
    "set_model",
    () => client.setModel(launch.expectation.route.provider, launch.expectation.route.model),
    () => success(undefined),
  );
  if (!bound.ok) return bound.error;
  const route = await readinessExchange("get_state", () => client.getState(), (state) => success(parseRouteState(state)));
  if (!route.ok) return route.error;
  const decision = decideStartupRoute(expectation.route, ready, route.value);
  return decision.kind === "open" ? Object.freeze({ ok: true as const }) : readinessRefusal(decision.message);
};

/** Register the synchronous request/reply adapter consumed by the installed
 * normal subagent launcher. The bridge owns no model process; it retains only
 * admitted, request-bound launch capabilities until result/shutdown cleanup. */
export function registerPiEmissionLaunchBridge(
  events: PiSubagentLaunchEventBus | undefined,
): PiEmissionLaunchBridge {
  if (events === undefined) {
    return Object.freeze({
      probe: (): PiEmissionLaunchAvailability => Object.freeze({
        kind: "unavailable" as const,
        reason: "this Pi runtime exposes no extension event bus",
      }),
      stage: (): PiEmissionLaunchStage => Object.freeze({
        ok: false as const,
        reason: "Emission launch unavailable: this Pi runtime exposes no extension event bus",
      }),
      removeToolCall: (): void => undefined,
      removeSession: (): void => undefined,
    });
  }

  const pending = new Map<string, PiEmissionLaunchExpectation>();
  events.on(LOOM_SUBAGENT_LAUNCH_CHANNEL, (raw) => {
    const parsed = parsePiSubagentLaunchResolveRequest(raw);
    if (parsed.kind === "silent") return;
    if (parsed.kind === "malformed") {
      // Correlation holds but the launch shape does not: answer EXACTLY ONCE
      // with a bounded, field-specific refusal — never throw, never compare
      // against a cast, never mint a directive from untrusted shape.
      parsed.correlation.respond(Object.freeze({
        kind: "refused" as const,
        reason: `staged emission launch resolve is malformed: ${parsed.reason}`,
      }));
      return;
    }
    const request = parsed.request;
    const key = launchSlotKey(request.sessionId, request.toolCallId, request.slot);
    const launch = pending.get(key);
    if (launch === undefined) return;

    const mismatch = launchRequestMismatch(request, launch);
    if (mismatch !== null) {
      request.respond(Object.freeze({
        kind: "refused" as const,
        reason: `staged emission launch ${request.toolCallId}/${request.slot.kind}[${request.slot.index}] does not match its issued ${mismatch}`,
      }));
      return;
    }

    pending.delete(key);
    request.respond(Object.freeze({
      kind: "emission-rpc" as const,
      directive: Object.freeze({
        kind: "emission-rpc" as const,
        bindingEnv: emissionBindingEnvironment(launch.expectation),
        expectedProvider: launch.expectation.route.provider,
        expectedModel: launch.expectation.route.model,
        expectedToolName: launch.expectation.binding.toolName,
        verifyReadiness: readinessVerifier(launch),
      }),
    }));
  });

  return Object.freeze({
    probe: (): PiEmissionLaunchAvailability => {
      let replies = 0;
      let malformedReplyReason: string | null = null;
      const probe: PiSubagentLaunchCapabilityProbe = Object.freeze({
        kind: "capability",
        version: 2,
        respond: (reply) => {
          replies += 1;
          const parsed = parsePiSubagentLaunchCapabilityReply(reply);
          if (!parsed.ok && malformedReplyReason === null) malformedReplyReason = parsed.error.reason;
        },
      });
      try {
        events.emit(LOOM_SUBAGENT_LAUNCH_CHANNEL, probe);
      } catch (thrown) {
        const cause = boundedThrownCause(thrown, "emission launcher capability probe");
        return Object.freeze({
          kind: "unavailable" as const,
          reason: `the installed subagent launcher capability probe failed (${cause.name}: ${cause.message})`,
        });
      }
      if (replies !== 1) {
        return Object.freeze({
          kind: "unavailable" as const,
          reason: replies > 1
            ? `multiple launcher capabilities answered ${LOOM_SUBAGENT_LAUNCH_CHANNEL}; reload a single installed launcher`
            : `the installed subagent launcher does not advertise ${LOOM_SUBAGENT_LAUNCH_CHANNEL}`,
        });
      }
      if (malformedReplyReason !== null) {
        return Object.freeze({
          kind: "unavailable" as const,
          reason: `the installed subagent launcher returned an incompatible v2 capability response: ${malformedReplyReason}`,
        });
      }
      return Object.freeze({ kind: "available" as const });
    },
    stage: (expectations): PiEmissionLaunchStage => {
      const staged = new Set<string>();
      for (const expectation of expectations) {
        const key = launchSlotKey(expectation.sessionId, expectation.toolCallId, expectation.slot);
        if (staged.has(key) || pending.has(key)) {
          return Object.freeze({
            ok: false as const,
            reason: `emission launch capability already exists for ${expectation.toolCallId}/${expectation.slot.kind}[${expectation.slot.index}]`,
          });
        }
        staged.add(key);
      }
      for (const expectation of expectations) {
        pending.set(
          launchSlotKey(expectation.sessionId, expectation.toolCallId, expectation.slot),
          Object.freeze(expectation),
        );
      }
      return Object.freeze({ ok: true as const });
    },
    removeToolCall: (sessionId, toolCallId): void => {
      for (const [key, launch] of pending) {
        if (launch.sessionId === sessionId && launch.toolCallId === toolCallId) pending.delete(key);
      }
    },
    removeSession: (sessionId): void => {
      for (const [key, launch] of pending) {
        if (launch.sessionId === sessionId) pending.delete(key);
      }
    },
  });
}

export function piSubagentLaunchSlot(raw: unknown, index: number): PiSubagentLaunchSlot {
  if (isRecord(raw) && Array.isArray(raw.chain)) return Object.freeze({ kind: "chain" as const, index });
  if (isRecord(raw) && Array.isArray(raw.tasks)) return Object.freeze({ kind: "parallel" as const, index });
  if (index !== 0) throw new Error(`single Pi subagent launch cannot address slot ${index}`);
  return Object.freeze({ kind: "single" as const, index: 0 });
}

export type PiReservedEmissionLaunch = Readonly<{
  slot: PiSubagentLaunchSlot;
  binding: IssuedEmissionBindingOf<"reviewer-payload">;
  contextDigest: ContextDigest;
}>;

const isReviewerEmissionBinding = (
  binding: IssuedEmissionBinding,
): binding is IssuedEmissionBindingOf<"reviewer-payload"> =>
  binding.kind.kind === "reviewer-payload";

export const reservedReviewerEmissionLaunch = (
  expectation: SpawnEmissionExpectation,
  rawInput: unknown,
  index: number,
): PiReservedEmissionLaunch | null => {
  if (expectation.kind !== "emission-enabled" || !isReviewerEmissionBinding(expectation.binding)) return null;
  return Object.freeze({
    slot: piSubagentLaunchSlot(rawInput, index),
    binding: expectation.binding,
    contextDigest: expectation.contextDigest,
  });
};
