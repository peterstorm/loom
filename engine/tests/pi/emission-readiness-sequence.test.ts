/**
 * The launcher's emission startup step sequence (`pi/emission-readiness-sequence.ts`)
 * at its own interface, over a plain recording fake of the step port: the ONE
 * step order both adapters cross (the verifier the parent bridge ships and the
 * real-child launcher harness), which steps never run, how an adapter's step
 * failure ends the sequence, and how a hostile payload's gate throw becomes the
 * adapter's refusal. The decisions themselves are the gate's
 * (emission-readiness-gate.test.ts); here they are only the oracle.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  decideReadinessGate,
  decideStartupRoute,
  parseReadinessStageObservation,
  type EmissionStartupDecision,
  type ReadinessObservation,
  type RouteObservation,
} from "../../../pi/emission-readiness-gate";
import {
  runEmissionStartupSequence,
  type EmissionStartupSteps,
} from "../../../pi/emission-readiness-sequence";
import { failure, success } from "../../src/core/orchestration-contract/identity";
import { asOpen, asRefused, makeExpectation, nextRequestId } from "../fixtures/emission-child-harness";
import { REVIEWER_V2_CELL } from "../fixtures/emission-registry-cells";
import { refusal, value } from "../fixtures/parse-result";

const BASE_URL = "http://127.0.0.1:9/v1";
const expectation = makeExpectation(REVIEWER_V2_CELL, nextRequestId("sequence"), BASE_URL);

const honestPayload = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  requestId: expectation.binding.requestId,
  contextDigest: expectation.contextDigest,
  kind: expectation.binding.kind.kind,
  version: expectation.binding.version,
  toolName: expectation.binding.toolName,
  schemaDigest: expectation.binding.schemaDigest,
  revision: expectation.revision,
  active: true,
  childPid: 4242,
  registeredTools: [expectation.binding.toolName],
  ...overrides,
});

const boundRoute = (baseUrl: string): RouteObservation => Object.freeze({
  kind: "bound" as const,
  model: Object.freeze({
    provider: expectation.route.provider,
    id: expectation.route.modelId,
    api: expectation.route.api,
    baseUrl,
  }),
});

type StepName = "observeChannel" | "discoverReadinessCommand" | "observeReadiness" | "bindRoute";

/** One fake child: what each step answers, and which step (if any) fails. */
type FakeChild = Readonly<{
  channelAlive: boolean;
  commandListed: boolean;
  readiness: ReadinessObservation;
  route: RouteObservation;
  failing: StepName | null;
}>;

type StepFailure = Readonly<{ step: StepName }>;

const HONEST_CHILD: FakeChild = Object.freeze({
  channelAlive: true,
  commandListed: true,
  readiness: Object.freeze({ kind: "observed" as const, payload: honestPayload() }),
  route: boundRoute(BASE_URL),
  failing: null,
});

/** The recording fake adapter: every step appends its name to `calls`, and
 *  carries adapter evidence beside the facts the sequence reads. */
const recordingSteps = (
  child: FakeChild,
  calls: string[],
): EmissionStartupSteps<StepFailure, Readonly<{ commandListed: boolean; inventory: string }>, Readonly<{ readiness: ReadinessObservation; arrivedAt: number }>> => {
  const answer = <T>(step: StepName, answered: T) => {
    calls.push(step);
    return Promise.resolve(child.failing === step ? failure<T, StepFailure>({ step }) : success<T, StepFailure>(answered));
  };
  return {
    observeChannel: () => answer("observeChannel", {
      channelAlive: child.channelAlive,
      channelDiagnostic: child.channelAlive ? null : "get_state never answered",
    }),
    discoverReadinessCommand: () => answer("discoverReadinessCommand", {
      commandListed: child.commandListed,
      inventory: child.commandListed ? "listed" : "unlisted",
    }),
    observeReadiness: () => answer("observeReadiness", { readiness: child.readiness, arrivedAt: 17 }),
    bindRoute: (route) => {
      expect(route).toEqual(expectation.route);
      return answer("bindRoute", child.route);
    },
    // The gate reads the readiness payload, so its throw is the readiness step's refusal.
    gateThrew: () => ({ step: "observeReadiness" }),
  };
};

const sequence = async (child: FakeChild) => {
  const calls: string[] = [];
  const run = await runEmissionStartupSequence(expectation, recordingSteps(child, calls));
  return { calls, run };
};

/** The independent oracle: the steps a launcher may run for `child`, in
 *  order, and the decision the gate's two stages reach over its facts. */
const expectedOf = (child: FakeChild): Readonly<{ calls: readonly StepName[]; decision: EmissionStartupDecision | null }> => {
  const calls: StepName[] = ["observeChannel"];
  if (child.failing === "observeChannel") return { calls, decision: null };
  if (child.channelAlive) {
    calls.push("discoverReadinessCommand");
    if (child.failing === "discoverReadinessCommand") return { calls, decision: null };
  }
  const listed = child.channelAlive && child.commandListed;
  if (listed) {
    calls.push("observeReadiness");
    if (child.failing === "observeReadiness") return { calls, decision: null };
  }
  const readiness = decideReadinessGate(expectation, parseReadinessStageObservation({
    channelAlive: child.channelAlive,
    channelDiagnostic: child.channelAlive ? null : "get_state never answered",
    commandListed: listed,
    readiness: listed ? child.readiness : { kind: "absent", reason: "not invoked" },
  }));
  if (readiness.kind === "refused") return { calls, decision: readiness };
  calls.push("bindRoute");
  if (child.failing === "bindRoute") return { calls, decision: null };
  return { calls, decision: decideStartupRoute(expectation.route, readiness, child.route) };
};

describe("the launcher's emission startup step sequence — one order, two adapters (AD-4/FR-008)", () => {
  it("runs channel → discovery → readiness → route bind in order, and carries each adapter's evidence beside the facts", async () => {
    const { calls, run } = await sequence(HONEST_CHILD);
    expect(calls).toEqual(["observeChannel", "discoverReadinessCommand", "observeReadiness", "bindRoute"]);
    const opened = value(run);
    const open = asOpen(opened.decision);
    expect(open.readiness.requestId).toBe(expectation.binding.requestId);
    expect(open.route).toEqual(expectation.route);
    expect(opened.facts).toEqual({
      channelAlive: true,
      channelDiagnostic: null,
      commandListed: true,
      readiness: HONEST_CHILD.readiness,
    });
    expect(opened.discovery).toEqual({ commandListed: true, inventory: "listed" });
    expect(opened.readinessStage).toEqual({ readiness: HONEST_CHILD.readiness, arrivedAt: 17 });
    expect(Object.isFrozen(opened)).toBe(true);
  });

  it("never discovers on an unanswering channel — the child is unreachable", async () => {
    const { calls, run } = await sequence({ ...HONEST_CHILD, channelAlive: false });
    expect(calls).toEqual(["observeChannel"]);
    const refused = value(run);
    const unreachable = asRefused(refused.decision);
    expect(unreachable.code).toBe("child-unreachable");
    expect(unreachable.message).toContain("get_state never answered");
    expect(refused.discovery).toBeNull();
    expect(refused.readinessStage).toBeNull();
  });

  it("never invokes an unlisted readiness command — an unknown /command would reach the model", async () => {
    const { calls, run } = await sequence({ ...HONEST_CHILD, commandListed: false });
    expect(calls).toEqual(["observeChannel", "discoverReadinessCommand"]);
    const refused = value(run);
    expect(asRefused(refused.decision).code).toBe("readiness-command-absent");
    expect(refused.facts.commandListed).toBe(false);
    expect(refused.facts.readiness.kind).toBe("absent");
    expect(refused.readinessStage).toBeNull();
  });

  it("never binds a route for a refused readiness — a refused readiness is final", async () => {
    const { calls, run } = await sequence({
      ...HONEST_CHILD,
      readiness: { kind: "observed", payload: honestPayload({ schemaDigest: "0".repeat(64) }) },
    });
    expect(calls).toEqual(["observeChannel", "discoverReadinessCommand", "observeReadiness"]);
    expect(asRefused(value(run).decision).code).toBe("schema-digest-mismatch");
  });

  it("refuses a drifted bound route only after binding it", async () => {
    const { calls, run } = await sequence({ ...HONEST_CHILD, route: boundRoute("http://127.0.0.1:10/v1") });
    expect(calls).toEqual(["observeChannel", "discoverReadinessCommand", "observeReadiness", "bindRoute"]);
    expect(asRefused(value(run).decision).code).toBe("route-bind-refused");
  });

  it.each(["observeChannel", "discoverReadinessCommand", "observeReadiness", "bindRoute"] as const)(
    "ends the sequence on the adapter's own %s failure, running no later step",
    async (step) => {
      const { calls, run } = await sequence({ ...HONEST_CHILD, failing: step });
      expect(refusal(run)).toEqual({ step });
      expect(calls.at(-1)).toBe(step);
      expect(calls).toEqual(expectedOf({ ...HONEST_CHILD, failing: step }).calls);
    },
  );

  it("turns a hostile payload's gate throw into the adapter's refusal, never a rejected sequence, and binds no route", async () => {
    const hostile = new Proxy<Record<string, unknown>>({}, {
      get: () => {
        throw new Error("hostile");
      },
    });
    const { calls, run } = await sequence({ ...HONEST_CHILD, readiness: { kind: "observed", payload: hostile } });
    expect(refusal(run)).toEqual({ step: "observeReadiness" });
    expect(calls).toEqual(["observeChannel", "discoverReadinessCommand", "observeReadiness"]);
  });

  it("property: for every fake child, the steps run are exactly the protocol-order prefix the facts permit, and the decision is the gate's two stages over those facts", async () => {
    const readinessArb = fc.constantFrom<ReadinessObservation>(
      { kind: "observed", payload: honestPayload() },
      { kind: "observed", payload: honestPayload({ requestId: "req-foreign-peer" }) },
      { kind: "observed", payload: honestPayload({ active: false }) },
      { kind: "malformed", reason: "two entries" },
      { kind: "absent", reason: "bounded window elapsed" },
      { kind: "startup-unavailable", reason: "provisioning refused" },
      { kind: "cancelled" },
    );
    const routeArb = fc.constantFrom<RouteObservation>(
      boundRoute(BASE_URL),
      boundRoute("http://127.0.0.1:10/v1"),
      { kind: "failed", reason: "set_model refused" },
      { kind: "unbound" },
    );
    const failingArb = fc.constantFrom<StepName | null>(null, null, "observeChannel", "discoverReadinessCommand", "observeReadiness", "bindRoute");
    await fc.assert(fc.asyncProperty(
      fc.record({ channelAlive: fc.boolean(), commandListed: fc.boolean(), readiness: readinessArb, route: routeArb, failing: failingArb }),
      async (child) => {
        const { calls, run } = await sequence(child);
        const expected = expectedOf(child);
        // The oracle binds the route only after a ready readiness, so exact
        // call equality also pins that an open decision was route-bound.
        expect(calls).toEqual(expected.calls);
        if (expected.decision === null) {
          expect(refusal(run)).toEqual({ step: child.failing });
        } else {
          expect(value(run).decision).toEqual(expected.decision);
        }
      },
    ));
  });
});
