/**
 * The launcher's emission startup step sequence (AD-4 / FR-008): the ONE
 * ordering every launcher crosses before a Task prompt reaches an
 * emission-enabled child, written once over a narrow step port.
 *
 *   channel check → discovery (only on an answering channel) → the readiness
 *   invocation and bounded wait (only for a LISTED command — an unknown
 *   /command would reach the model) → the pure readiness gate → the route
 *   bind (only on a `ready` readiness) → the pure route decision.
 *
 * The decisions are the gate's (`pi/emission-readiness-gate.ts`); this module
 * owns only which step runs when, and which steps never run. The step port has
 * two adapters: the readiness verifier the parent launch bridge ships
 * (`pi/emission-launch-bridge.ts`, over the installed launcher's RPC client)
 * and the real-child launcher harness the barrier acceptance suites drive
 * (`engine/tests/fixtures/emission-child-harness.ts`, with its bounded-window
 * timeout, cancellation and mid-wait child-death controls). A stage added or
 * reordered here therefore reaches both.
 *
 * Each step answers `DomainResult<_, E>`: a failure is the adapter's own
 * transport refusal and ends the sequence (`E = never` for an adapter whose
 * transport failures are thrown infrastructure). No I/O happens here; every
 * effect is a step the adapter supplies.
 */

import { failure, success, type DomainResult } from "../engine/src/core/orchestration-contract/identity";
import {
  decideReadinessGate,
  decideStartupRoute,
  parseReadinessStageObservation,
  type EmissionReadinessGateDecision,
  type EmissionStartupDecision,
  type EmissionStartupExpectation,
  type ExpectedEmissionRoute,
  type ReadinessObservation,
  type ReadinessProbeFacts,
  type RouteObservation,
} from "./emission-readiness-gate";

/** Whether the child's RPC channel answered the launcher's channel check. */
export type ChannelObservation = Readonly<{ channelAlive: boolean; channelDiagnostic: string | null }>;

/** What discovery proved: whether the readiness command is listed as an
 *  extension command. An adapter may carry more evidence beside it. */
export type CommandDiscovery = Readonly<{ commandListed: boolean }>;

/** What the one readiness invocation produced. An adapter may carry more
 *  evidence beside it (for example the observation's arrival time). */
export type ReadinessStage = Readonly<{ readiness: ReadinessObservation }>;

/** The step port. Each step runs at most once, in sequence order. */
export type EmissionStartupSteps<
  E,
  D extends CommandDiscovery = CommandDiscovery,
  R extends ReadinessStage = ReadinessStage,
> = Readonly<{
  observeChannel: () => Promise<DomainResult<ChannelObservation, E>>;
  /** Runs only on an answering channel. */
  discoverReadinessCommand: () => Promise<DomainResult<D, E>>;
  /** Runs only when discovery listed the readiness command. */
  observeReadiness: () => Promise<DomainResult<R, E>>;
  /** Runs only on a `ready` readiness decision, binding the expected route
   *  and observing the route the child then reports. */
  bindRoute: (route: ExpectedEmissionRoute) => Promise<DomainResult<RouteObservation, E>>;
  /** The readiness gate reads an untrusted child payload; a hostile payload
   *  whose accessors throw is the adapter's refusal (or rethrow), never a
   *  rejected sequence. */
  gateThrew: (thrown: unknown) => E;
}>;

/** One sequenced startup: what each step observed (`null` for a step the
 *  sequence never ran), the probe facts the gate read, and the decision. */
export type EmissionStartupRun<D extends CommandDiscovery, R extends ReadinessStage> = Readonly<{
  channel: ChannelObservation;
  /** `null` when the channel never answered, so discovery never ran. */
  discovery: D | null;
  /** `null` when the command was not listed, so readiness was never invoked. */
  readinessStage: R | null;
  facts: ReadinessProbeFacts;
  /** The prompt may be delivered only on `open`. */
  decision: EmissionStartupDecision;
}>;

/** The readiness observation for a command the launcher never invoked. The
 *  gate decides that case from `channelAlive`/`commandListed` alone. */
const NOT_INVOKED: ReadinessObservation = Object.freeze({
  kind: "absent" as const,
  reason: "the readiness command was not verified as listed, so it was never invoked",
});

const decideReadiness = <E>(
  expectation: EmissionStartupExpectation,
  facts: ReadinessProbeFacts,
  gateThrew: (thrown: unknown) => E,
): DomainResult<EmissionReadinessGateDecision, E> => {
  try {
    return success(decideReadinessGate(expectation, parseReadinessStageObservation(facts)));
  } catch (thrown) {
    return failure(gateThrew(thrown));
  }
};

/** Run the launcher's startup steps in the protocol's one order. */
export async function runEmissionStartupSequence<
  E,
  D extends CommandDiscovery = CommandDiscovery,
  R extends ReadinessStage = ReadinessStage,
>(
  expectation: EmissionStartupExpectation,
  steps: EmissionStartupSteps<E, D, R>,
): Promise<DomainResult<EmissionStartupRun<D, R>, E>> {
  const channel = await steps.observeChannel();
  if (!channel.ok) return channel;
  const discovery = channel.value.channelAlive ? await steps.discoverReadinessCommand() : null;
  if (discovery !== null && !discovery.ok) return discovery;
  const commandListed = discovery !== null && discovery.value.commandListed;
  const readinessStage = commandListed ? await steps.observeReadiness() : null;
  if (readinessStage !== null && !readinessStage.ok) return readinessStage;
  const facts: ReadinessProbeFacts = Object.freeze({
    channelAlive: channel.value.channelAlive,
    channelDiagnostic: channel.value.channelDiagnostic,
    commandListed,
    readiness: readinessStage === null ? NOT_INVOKED : readinessStage.value.readiness,
  });
  const decided = (decision: EmissionStartupDecision): DomainResult<EmissionStartupRun<D, R>, E> => success(Object.freeze({
    channel: channel.value,
    discovery: discovery === null ? null : discovery.value,
    readinessStage: readinessStage === null ? null : readinessStage.value,
    facts,
    decision,
  }));
  const readiness = decideReadiness(expectation, facts, steps.gateThrew);
  if (!readiness.ok) return readiness;
  // A refused readiness is final: no route is ever bound for it.
  if (readiness.value.kind === "refused") return decided(readiness.value);
  const route = await steps.bindRoute(expectation.route);
  if (!route.ok) return route;
  return decided(decideStartupRoute(expectation.route, readiness.value, route.value));
}
