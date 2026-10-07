/**
 * The installed-launcher port as the emission suites fake it: a plain
 * synchronous event bus standing in for `pi.events`, a fake ExtensionAPI with
 * no event bus, the launcher's v2 capability advertisement, the admitted
 * launch expectation and resolve envelope the parent bridge
 * (`pi/emission-launch-bridge.ts`) exchanges with it, and the directive that
 * exact handshake mints (`issuedLaunchDirective`).
 */

import { resolve } from "node:path";
import { renderEmissionDescriptor } from "../../src/core/issued-emission-capability";
import {
  LOOM_SUBAGENT_LAUNCH_CHANNEL,
  registerPiEmissionLaunchBridge,
  type PiEmissionLaunchExpectation,
  type PiSubagentLaunchReply,
  type PiSubagentLaunchSlot,
} from "../../../pi/emission-launch-bridge";
import {
  contextDigestOf,
  recordOf,
  repoRoot,
  type PiEmissionRpcDirective,
} from "./emission-child-harness";
import { mintedBindingFor, type RegistryCell } from "./emission-registry-cells";

export type FakeExtensionHandler = (...args: readonly unknown[]) => unknown;

export class NoEventBusFakePi {
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

export class SynchronousEventBus {
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

export const advertiseInstalledLaunchPort = (events: SynchronousEventBus): (() => void) =>
  events.on(LOOM_SUBAGENT_LAUNCH_CHANNEL, (event) => {
    const probe = recordOf(event);
    if (probe !== null && probe["kind"] === "capability" && probe["version"] === 2 &&
        typeof probe["respond"] === "function") {
      probe["respond"]({ kind: "available", version: 2 });
    }
  });

export const bridgeLaunchExpectation = (
  cell: RegistryCell,
  toolCallId: string,
  slot: PiSubagentLaunchSlot,
  task?: string,
): PiEmissionLaunchExpectation => {
  const binding = mintedBindingFor(cell, `req-installed-launch-${toolCallId.replace(/[^a-z0-9-]/g, "-")}`);
  const contextDigest = contextDigestOf(`installed-launch:${toolCallId}:${slot.kind}:${slot.index}`);
  return Object.freeze({
    sessionId: "01a0e4b3-c4c1-7b63-916d-f5d41d2b5a00",
    toolCallId,
    slot,
    agent: "code-reviewer",
    task: task ?? `${renderEmissionDescriptor(binding, contextDigest)}Review the issued packet.`,
    cwd: resolve(repoRoot),
    expectation: Object.freeze({
      kind: "emission-enabled" as const,
      binding,
      contextDigest,
      route: Object.freeze({
        provider: "desktop-vllm",
        model: "glm-5.3-flash-spark-tp2-v14",
      }),
    }),
    revision: "sha256:installed-launch-runtime",
  });
};

export const launchResolveEnvelope = (
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

/**
 * The directive the parent bridge mints for `launch` through the real
 * handshake: a fresh bridge over a bus advertising the installed launch port,
 * the launch staged, and its exact resolve envelope answered. Throws unless
 * staging succeeded and the bridge answered with exactly one emission-rpc
 * directive — the verifier tests read only what differs per test.
 */
export const issuedLaunchDirective = (launch: PiEmissionLaunchExpectation): PiEmissionRpcDirective => {
  const bus = new SynchronousEventBus();
  advertiseInstalledLaunchPort(bus);
  const bridge = registerPiEmissionLaunchBridge(bus);
  const staged = bridge.stage([launch]);
  if (!staged.ok) throw new Error(`the bridge refused to stage ${launch.toolCallId}: ${staged.reason}`);
  const replies: PiSubagentLaunchReply[] = [];
  bus.emit(LOOM_SUBAGENT_LAUNCH_CHANNEL, launchResolveEnvelope(launch, {
    respond: (reply: PiSubagentLaunchReply) => { replies.push(reply); },
  }));
  const [reply] = replies;
  if (replies.length !== 1 || reply === undefined || reply.kind !== "emission-rpc") {
    throw new Error(`the exact launch ${launch.toolCallId} did not receive its directive: ${JSON.stringify(replies)}`);
  }
  return reply.directive;
};
