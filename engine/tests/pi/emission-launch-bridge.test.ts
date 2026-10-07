/**
 * The parent emission launch bridge over the installed synchronous launch
 * port (AD-4 / FR-008 / FR-031): capability probing, staging of admitted
 * launches keyed by session/tool-call/slot, the one-shot resolve handshake,
 * and the readiness verifier the installed launcher runs before any Task
 * prompt — driven against a plain synchronous event bus and a plain fake
 * readiness client. Every child readiness and route state the verifier
 * observes is refused in the gate's vocabulary
 * (`pi/emission-readiness-gate.ts`); only RPC transport failures carry the
 * bridge's own wording.
 */

import { describe, expect, it, vi } from "vitest";
import loomPiExtension from "../../../pi/extension";
import {
  LOOM_SUBAGENT_LAUNCH_CHANNEL,
  registerPiEmissionLaunchBridge,
  type PiSubagentLaunchEventBus,
} from "../../../pi/emission-launch-bridge";
import {
  EMISSION_READINESS_COMMAND,
  EMISSION_READINESS_ENTRY_TYPE,
  LOOM_EMISSION_BINDING_ENV,
} from "../../../pi/emission-tool";
import { EMISSION_STARTUP_REMEDIATIONS } from "../../../pi/emission-readiness-gate";
import {
  JUDGE_V1_CELL,
  recordOf,
  REVIEWER_V2_CELL,
  sha256Hex,
  withProcessState,
} from "../fixtures/emission-child-harness";
import {
  advertiseInstalledLaunchPort,
  bridgeLaunchExpectation,
  launchResolveEnvelope,
  NoEventBusFakePi,
  SynchronousEventBus,
} from "../fixtures/emission-launch-port";

describe("the parent emission adapter over the installed synchronous launch port", () => {
  it("keeps ordinary extension initialization available when the event bus is absent and reports the launcher unavailable", async () => {
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

    await withProcessState({ env: { [LOOM_EMISSION_BINDING_ENV]: undefined } }, () => {
      const pi = new NoEventBusFakePi();
      expect(() => loomPiExtension(pi as never, () => Object.freeze([]))).not.toThrow();
      expect(pi.handlers.has("tool_call")).toBe(true);
      expect(pi.commands.has(EMISSION_READINESS_COMMAND)).toBe(true);
    });
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

  it("refuses every child readiness and route state in the gate's one vocabulary, never invoking an unlisted command", async () => {
    const bus = new SynchronousEventBus();
    advertiseInstalledLaunchPort(bus);
    const bridge = registerPiEmissionLaunchBridge(bus as PiSubagentLaunchEventBus);
    const launch = bridgeLaunchExpectation(JUDGE_V1_CELL, "tool-call-gate-vocabulary", { kind: "single", index: 0 });
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
    const readinessEntry = {
      customType: EMISSION_READINESS_ENTRY_TYPE,
      data: {
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
      },
    };
    const calls: string[] = [];
    const client = (overrides: Readonly<Record<string, unknown>> = {}) => ({
      getCommands: async () => {
        calls.push("getCommands");
        return [{ name: EMISSION_READINESS_COMMAND, source: "extension" }];
      },
      invokeReadiness: async () => {
        calls.push("invokeReadiness");
        return [readinessEntry];
      },
      setModel: async () => { calls.push("setModel"); },
      getState: async () => {
        calls.push("getState");
        return { model: { provider: launch.expectation.route.provider, id: launch.expectation.route.model } };
      },
      ...overrides,
    });
    const refusal = async (overrides: Readonly<Record<string, unknown>>): Promise<string> => {
      calls.length = 0;
      const verdict = await directive.verifyReadiness(client(overrides));
      if (verdict.ok) throw new Error(`expected a refusal for ${JSON.stringify(Object.keys(overrides))}`);
      return verdict.reason;
    };

    for (const commands of [[], [{ name: EMISSION_READINESS_COMMAND, source: "prompt" }]]) {
      const reason = await refusal({ getCommands: async () => { calls.push("getCommands"); return commands; } });
      expect(reason).toContain(`the expected readiness command /${EMISSION_READINESS_COMMAND} is not registered in the child`);
      expect(reason).toContain(EMISSION_STARTUP_REMEDIATIONS["readiness-command-absent"]);
      expect(calls).toEqual(["getCommands"]);
    }

    for (const [entries, detail] of [
      [[], "readiness invocation produced 0 entries; exactly one is required"],
      [[readinessEntry, readinessEntry], "readiness invocation produced 2 entries; exactly one is required"],
      [[{ ...readinessEntry, customType: "other" }], `did not produce one ${EMISSION_READINESS_ENTRY_TYPE} custom entry`],
    ] as const) {
      const reason = await refusal({ invokeReadiness: async () => { calls.push("invokeReadiness"); return entries; } });
      expect(reason).toContain(detail);
      expect(reason).toContain(EMISSION_STARTUP_REMEDIATIONS["malformed-readiness"]);
      expect(calls).toEqual(["getCommands", "invokeReadiness"]);
    }

    const wrongRoute = await refusal({
      getState: async () => { calls.push("getState"); return { model: { provider: "openai-codex", id: "gpt-6-sol" } }; },
    });
    expect(wrongRoute).toContain("the bound route (openai-codex/gpt-6-sol via an unreported api at an unreported base URL)");
    expect(wrongRoute).toContain(`not the expected constrained route (${launch.expectation.route.provider}/${launch.expectation.route.model})`);
    expect(wrongRoute).toContain(EMISSION_STARTUP_REMEDIATIONS["route-bind-refused"]);
    expect(calls).toEqual(["getCommands", "invokeReadiness", "setModel", "getState"]);

    const noModel = await refusal({ getState: async () => { calls.push("getState"); return { model: null }; } });
    expect(noModel).toContain("the constrained route binding failed: Emission readiness RPC get_state returned no exact provider/model record");
    expect(noModel).toContain(EMISSION_STARTUP_REMEDIATIONS["route-bind-refused"]);
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
