import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseModelRoutingConfig } from "../../src/core/model-routing";
import type { RouteReachability, UnverifiedRoute } from "../../src/core/route-reachability";
import {
  announcedParentHarness,
  gateEmission,
  type EmissionGateStep,
  type AnnouncedParent,
  type EmissionVerdict,
  type GatedAction,
  type PiRouteGateFacts,
  type RouteGateStep,
} from "../../src/core/spawn-emission-gate";
import { parseSpawnBatch } from "../../src/core/spawn-request-authority";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";
import { LOCAL_PI_BINDING as LOCAL, LOCAL_PI_ROUTE, RETIRED_CLOUD_PI_BINDING, RETIRED_CLOUD_ROUTE } from "../fixtures/local-pi-binding";

/**
 * The emission gate's one pure entry point: which actions it gates (and so
 * which ask for route-gate facts), the order in which it refuses unreadable
 * inputs (a request before any fact is read, the facts before any probe), the
 * routes it asks the shell to observe, and the verdict — with its stderr
 * events as data.
 */

const RUN_ID = "run.emission-gate";
const URL = "http://vllm.test/v1/models";

const GATE: PiRouteGateFacts = {
  agentDir: "/agent",
  mode: { ok: true, value: "admit-unverified" },
  routing: { ok: true, value: { parentRef: null, config: null } },
};
const PI: AnnouncedParent["harness"] = "pi";
const facts = (overrides: Partial<PiRouteGateFacts> = {}): PiRouteGateFacts => ({ ...GATE, ...overrides });

/** A spawn batch as the façade hands it to the gate: parsed once, as a Pi parent labels it. */
const batch = (...authorities: unknown[]): GatedAction => ({ kind: "spawn-batch", batch: parseSpawnBatch("Pi", authorities) });
const stored = (overrides: Record<string, unknown> = {}) => agentRequestAuthority(RUN_ID, overrides);
const unparseable = () => ({ ...stored(), modelProfile: "no-such-profile" });
const retired = () => stored({
  requestId: "request:reviewer:retired",
  harnessBinding: { pi: RETIRED_CLOUD_PI_BINDING, claude: { harness: "claude-code", model: "sonnet" } },
});

const reachable = (served: Extract<RouteReachability, { kind: "reachable" }>["served"]): RouteReachability =>
  ({ kind: "reachable", route: LOCAL_PI_ROUTE, url: URL, served });
const LISTED = reachable({ kind: "listed", models: [LOCAL.model] });
const AUTH_REFUSED = reachable({ kind: "unlisted", cause: "auth-refused", status: 401 });
const DOWN: RouteReachability = { kind: "unreachable", route: LOCAL_PI_ROUTE, url: URL, cause: { kind: "refused", reason: "ECONNREFUSED" } };

const verdictOf = (step: EmissionGateStep | RouteGateStep): EmissionVerdict => {
  if (step.kind !== "decided") throw new Error(`expected a decided step, got ${step.kind}`);
  return step.verdict;
};
const readingFacts = (step: EmissionGateStep): Extract<EmissionGateStep, { kind: "read-route-gate" }> => {
  if (step.kind !== "read-route-gate") throw new Error(`expected a read-route-gate step, got ${JSON.stringify(step)}`);
  return step;
};
/** A Pi parent's `action`, gated on `gateFacts`. */
const gated = (action: GatedAction, gateFacts: PiRouteGateFacts = facts()): RouteGateStep =>
  readingFacts(gateEmission(action, PI)).gate(gateFacts);
const observing = (step: RouteGateStep): Extract<RouteGateStep, { kind: "observe" }> => {
  if (step.kind !== "observe") throw new Error(`expected an observe step, got ${JSON.stringify(step)}`);
  return step;
};
const UNGATED: EmissionVerdict = { kind: "emit", unverified: [], events: [] };

describe("gateEmission: what it gates", () => {
  const actions = fc.constantFrom<GatedAction>(batch(stored()), batch(unparseable()), { kind: "other" });

  it("emits every action of a Claude Code parent ungated, whatever its requests", () => {
    fc.assert(fc.property(actions, (action) => {
      expect(verdictOf(gateEmission(action, "claude-code"))).toEqual(UNGATED);
    }));
  });

  it("emits every non-spawn action of a Pi parent ungated, without asking for its route-gate facts", () => {
    expect(verdictOf(gateEmission({ kind: "other" }, PI))).toEqual(UNGATED);
  });

  it("gates a Pi parent's spawn batch on the route it launches on", () => {
    expect(observing(gated(batch(stored()))).launch)
      .toEqual([{ provider: LOCAL.provider, model: LOCAL.model, thinking: LOCAL.thinking }]);
  });
});

describe("gateEmission: unreadable inputs refuse before any route is observed", () => {
  it("refuses an unparseable request first, naming it, before asking for any route-gate fact", () => {
    const step = gateEmission(batch(stored(), unparseable()), PI);
    expect(verdictOf(step)).toMatchObject({ kind: "refuse", message: expect.stringMatching(/^Pi orchestration spawn request 1: /) });
  });

  it("refuses an unparseable gate mode before a malformed routing config", () => {
    const step = gated(batch(stored()), facts({ mode: { ok: false, error: "bad mode" }, routing: { ok: false, error: "bad routing" } }));
    expect(verdictOf(step)).toEqual({ kind: "refuse", message: "cannot check Pi route reachability: bad mode" });
  });

  it("refuses a malformed routing config", () => {
    expect(verdictOf(gated(batch(stored()), facts({ routing: { ok: false, error: "bad routing" } }))))
      .toEqual({ kind: "refuse", message: "cannot check Pi route reachability: bad routing" });
  });

  it("refuses when models.json could not be read for the observation", () => {
    expect(observing(gated(batch(stored()))).decide({ ok: false, error: "invalid models.json" }))
      .toEqual({ kind: "refuse", message: "cannot check Pi route reachability: invalid models.json" });
  });
});

describe("gateEmission: the routes it observes and the verdict over them", () => {
  it("never asks to observe a retired route, and refuses it with the restart remedy", () => {
    const step = observing(gated(batch(retired())));
    expect(step.launch).toEqual([]);
    expect(step.decide({ ok: true, decisions: [] })).toMatchObject({
      kind: "refuse", message: expect.stringContaining(`route ${RETIRED_CLOUD_ROUTE} (recorded under profile`),
    });
  });

  it("asks to observe the routed launch target, not the recorded binding", () => {
    const config = parseModelRoutingConfig({
      schemaVersion: 1,
      defaultClass: "cloud",
      modelClasses: { local: [`${LOCAL.provider}/*`] },
      targets: { muse: { model: "desktop-muse/qwen3.8-27b", thinkingLevel: "medium" } },
      rules: [{ id: "local-uses-muse", when: { parentClass: "local" }, use: { kind: "named", target: "muse" } }],
    });
    if (!config.ok) throw new Error(config.error.message);
    const step = observing(gated(batch(stored()), facts({
      routing: { ok: true, value: { parentRef: { provider: LOCAL.provider, model: LOCAL.model }, config: config.value } },
    })));
    expect(step.launch).toEqual([{ provider: "desktop-muse", model: "qwen3.8-27b", thinking: "medium" }]);
    expect(step.agentDir).toBe(GATE.agentDir);
  });

  it("observes each distinct launch route once", () => {
    const step = observing(gated(batch(stored(), stored({ requestId: "request:reviewer:2" }))));
    expect(step.launch).toHaveLength(1);
  });

  it("refuses a batch whose route is down", () => {
    expect(observing(gated(batch(stored()))).decide({ ok: true, decisions: [DOWN] }))
      .toMatchObject({ kind: "refuse", message: expect.stringContaining(`route ${LOCAL_PI_ROUTE} is unreachable at ${URL}`) });
  });

  it("emits a batch whose route lists its model, with no events", () => {
    expect(observing(gated(batch(stored()))).decide({ ok: true, decisions: [LISTED] })).toEqual(UNGATED);
  });

  it("admits an unverified route by default, carrying it and its stderr event as data", () => {
    const unverified: UnverifiedRoute = { route: LOCAL_PI_ROUTE, url: URL, cause: "auth-refused", status: 401 };
    expect(observing(gated(batch(stored()))).decide({ ok: true, decisions: [AUTH_REFUSED] })).toEqual({
      kind: "emit", unverified: [unverified], events: [{ event: "loom-route-unverified", ...unverified }],
    });
  });

  it("refuses an unverified route under strict", () => {
    expect(observing(gated(batch(stored()), facts({ mode: { ok: true, value: "strict" } }))).decide({ ok: true, decisions: [AUTH_REFUSED] }))
      .toMatchObject({ kind: "refuse", message: expect.stringContaining("(LOOM_ROUTE_GATE=strict)") });
  });
});

describe("announcedParentHarness", () => {
  it("reads a Pi parent only from PI_CODING_AGENT=true, Pi taking precedence over Claude Code", () => {
    expect(announcedParentHarness({ PI_CODING_AGENT: "true", PI_SESSION_ID: "p", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "c" }))
      .toEqual({ harness: "pi", sessionId: "p" });
    expect(announcedParentHarness({ PI_CODING_AGENT: "true" })).toEqual({ harness: "pi", sessionId: null });
    expect(announcedParentHarness({ PI_CODING_AGENT: "1", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "c" }))
      .toEqual({ harness: "claude-code", sessionId: "c" });
    expect(announcedParentHarness({ PI_CODING_AGENT_DIR: "/agent" })).toBeNull();
    expect(announcedParentHarness({})).toBeNull();
  });
});
