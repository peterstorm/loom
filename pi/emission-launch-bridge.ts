/**
 * Installed subagent launcher port (AD-4 / FR-008 / FR-031).
 *
 * The synchronous request/reply bridge between this extension and the shared
 * normal subagent launcher: capability probing, staging of admitted
 * emission-enabled launches, the launcher's resolve handshake, and the
 * readiness verifier the launcher runs before any Task prompt. Also owns the
 * launch-slot vocabulary the result side uses to authenticate a launcher's
 * pre-prompt startup refusal.
 */

import type { SpawnEmissionExpectation } from "../engine/src/core/spawn-admission";
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
import {
  decideReadinessGate,
  EMISSION_READINESS_COMMAND,
  EMISSION_READINESS_ENTRY_TYPE,
  parseReadinessStageObservation,
  type EmissionReadinessExpectation,
} from "./emission-tool";

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

const readinessPayloadFromEntries = (
  entries: readonly unknown[],
): DomainResult<unknown, Readonly<{ message: string }>> => {
  if (entries.length !== 1) {
    return failure({ message: `readiness invocation produced ${entries.length} entries; exactly one is required` });
  }
  const entry = entries[0];
  if (!isRecord(entry) || entry.customType !== EMISSION_READINESS_ENTRY_TYPE || !Object.hasOwn(entry, "data")) {
    return failure({
      message: `readiness invocation did not produce one ${EMISSION_READINESS_ENTRY_TYPE} custom entry`,
    });
  }
  return success(entry.data);
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

const readinessRpcRefusal = (operation: string, thrown: unknown): PiReadinessVerification => {
  const cause = boundedThrownCause(thrown, operation);
  return Object.freeze({
    ok: false as const,
    reason: `Emission readiness RPC ${operation} failed (${cause.name}: ${cause.message}). ` +
      "Inspect the child RPC channel, then retry the same issued request after restoring the launcher.",
  });
};

const readinessVerifier = (
  launch: PiEmissionLaunchExpectation,
): PiEmissionRpcDirective["verifyReadiness"] => async (client) => {
  let commands: Awaited<ReturnType<PiSubagentReadinessClient["getCommands"]>>;
  try {
    commands = await client.getCommands();
  } catch (thrown) {
    return readinessRpcRefusal("get_commands", thrown);
  }
  let commandListed: boolean;
  try {
    if (!Array.isArray(commands) || !commands.every((command) =>
      isRecord(command) && typeof command.name === "string" &&
      (command.source === undefined || typeof command.source === "string"))) {
      return Object.freeze({ ok: false as const, reason: "Emission readiness RPC get_commands returned a malformed command inventory" });
    }
    commandListed = commands.some((command) =>
      command.name === EMISSION_READINESS_COMMAND && command.source === "extension");
  } catch (thrown) {
    return readinessRpcRefusal("get_commands response", thrown);
  }
  if (!commandListed) {
    return Object.freeze({
      ok: false as const,
      reason: `Required extension command /${EMISSION_READINESS_COMMAND} is unavailable`,
    });
  }

  // Exactly one invocation in this verifier. The installed launcher also
  // enforces this count and refuses prompt delivery if a verifier cheats.
  let readinessEntries: readonly unknown[];
  try {
    readinessEntries = await client.invokeReadiness();
  } catch (thrown) {
    return readinessRpcRefusal("invoke_readiness", thrown);
  }
  try {
    if (!Array.isArray(readinessEntries)) {
      return Object.freeze({ ok: false as const, reason: "Emission readiness RPC invocation returned a malformed entry list" });
    }
    const payload = readinessPayloadFromEntries(readinessEntries);
    if (!payload.ok) return Object.freeze({ ok: false as const, reason: payload.error.message });
    const expectation: EmissionReadinessExpectation = Object.freeze({
      binding: launch.expectation.binding,
      contextDigest: launch.expectation.contextDigest,
      revision: launch.revision,
      readinessCommand: EMISSION_READINESS_COMMAND,
    });
    const decision = decideReadinessGate(expectation, parseReadinessStageObservation({
      channelAlive: true,
      channelDiagnostic: null,
      commandListed: true,
      readiness: Object.freeze({ kind: "observed" as const, payload: payload.value }),
    }));
    if (decision.kind === "refused") {
      return Object.freeze({ ok: false as const, reason: decision.message });
    }
  } catch (thrown) {
    return readinessRpcRefusal("invoke_readiness response", thrown);
  }

  // Route selection is deliberately after readiness. Both this verifier and
  // the installed launcher observe the exact provider/model before Task prompt.
  try {
    await client.setModel(launch.expectation.route.provider, launch.expectation.route.model);
  } catch (thrown) {
    return readinessRpcRefusal("set_model", thrown);
  }
  let state: Awaited<ReturnType<PiSubagentReadinessClient["getState"]>>;
  try {
    state = await client.getState();
  } catch (thrown) {
    return readinessRpcRefusal("get_state", thrown);
  }
  try {
    if (!isRecord(state) || !isRecord(state.model) ||
        typeof state.model.provider !== "string" || typeof state.model.id !== "string") {
      return Object.freeze({ ok: false as const, reason: "Emission readiness RPC get_state returned no exact provider/model record" });
    }
    if (state.model.provider !== launch.expectation.route.provider ||
        state.model.id !== launch.expectation.route.model) {
      return Object.freeze({
        ok: false as const,
        reason: `the child route ${state.model.provider}/${state.model.id} does not match ` +
          `${launch.expectation.route.provider}/${launch.expectation.route.model}`,
      });
    }
  } catch (thrown) {
    return readinessRpcRefusal("get_state response", thrown);
  }
  return Object.freeze({ ok: true as const });
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
