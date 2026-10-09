import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decideProbedRoute,
  decideRouteReachability,
  decideSpawnGate,
  distinctRoutes,
  modelsUrl,
  parseRouteGateMode,
  planSpawnRoutes,
  reportUnverifiedRoutes,
  ROUTE_GATE_VARIABLE,
  type RouteGateMode,
  type RouteProbe,
  type SpawnRouteDecision,
  type SpawnRouting,
  type UnverifiedRoute,
} from "../../src/core/route-reachability";
import {
  DESKTOP_VLLM_ROUTE,
  RECORDED_LLM_PROFILE_IDS,
  piModelPattern,
  recordedProfileBindings,
  resolveAgentProfile,
  type PiBinding,
  type RecordedLlmProfileId,
} from "../../src/core/model-profiles";
import { parseModelRoutingConfig, resolveAgentLaunchBinding, type ModelRoutingConfig } from "../../src/core/model-routing";
import {
  LOCAL_PI_BINDING,
  LOCAL_PI_MODEL_ARGUMENT,
  LOCAL_PI_ROUTE,
  RETIRED_CLOUD_PI_BINDING,
  RETIRED_CLOUD_PROFILE,
  RETIRED_CLOUD_ROUTE,
} from "../fixtures/local-pi-binding";

const LOCAL: PiBinding = LOCAL_PI_BINDING;
const ENDPOINT = { provider: LOCAL.provider, baseUrl: "http://192.168.0.80:8000/v1/" };
const URL = "http://192.168.0.80:8000/v1/models";
const ROUTE = LOCAL_PI_ROUTE;
const RETIRED: SpawnRouteDecision = Object.freeze({
  kind: "retired", profile: RETIRED_CLOUD_PROFILE, recorded: RETIRED_CLOUD_PI_BINDING, current: LOCAL,
});

const answered = (status: number, servedModels: readonly string[] | null = null): RouteProbe =>
  ({ kind: "answered", status, servedModels });
const probed = (probe: RouteProbe) => ({ kind: "probed" as const, endpoint: ENDPOINT, probe });

/** The probe vocabulary the gate properties sample: one answer of each kind the local route can give. */
const PROBE = Object.freeze({
  listed: answered(200, [LOCAL.model]),
  notServed: answered(200, ["other"]),
  unreadableListing: answered(200),
  authRefused401: answered(401),
  authRefused403: answered(403),
  serverError: answered(500),
  refused: Object.freeze({ kind: "refused", reason: "down" } as const),
} satisfies Record<string, RouteProbe>);
const PROBES: readonly RouteProbe[] = Object.values(PROBE);
/** The answers of a live server: the route is reachable, its listing verified or not. */
const REACHABLE_PROBES: readonly RouteProbe[] = [PROBE.listed, PROBE.unreadableListing, PROBE.authRefused401, PROBE.authRefused403];

/** The gate's refusal text, or null when it admits. */
const refusal = (decisions: readonly SpawnRouteDecision[], mode: RouteGateMode = "admit-unverified"): string | null => {
  const verdict = decideSpawnGate(decisions, mode);
  return verdict.kind === "refused" ? verdict.message : null;
};

describe("decideRouteReachability", () => {
  it("is reachable and listed when the server lists the model", () => {
    expect(decideRouteReachability(LOCAL, probed(answered(200, ["other", LOCAL.model])))).toEqual({
      kind: "reachable", route: ROUTE, url: URL, served: { kind: "listed", models: ["other", LOCAL.model] },
    });
  });

  it("is unreachable when the server answers but does not serve the model, keeping what it serves", () => {
    const decision = decideRouteReachability(LOCAL, probed(answered(200, ["qwen3.8-27b"])));
    expect(decision).toEqual({
      kind: "unreachable", route: ROUTE, url: URL, cause: { kind: "model-not-served", model: LOCAL.model, served: ["qwen3.8-27b"] },
    });
    expect(refusal([decision])).toContain(`does not serve '${LOCAL.model}' (serves: qwen3.8-27b)`);
  });

  it.each([401, 403])("treats an authentication refusal (HTTP %i) as a live server whose list is unobservable", (status) => {
    expect(decideRouteReachability(LOCAL, probed(answered(status)))).toMatchObject({
      kind: "reachable", served: { kind: "unlisted", cause: "auth-refused", status },
    });
  });

  it("is reachable but unlisted when a 2xx body lists nothing readable", () => {
    expect(decideRouteReachability(LOCAL, probed(answered(200)))).toMatchObject({
      kind: "reachable", served: { kind: "unlisted", cause: "unreadable-listing", status: 200 },
    });
  });

  it("is unreachable when the connection is refused", () => {
    expect(decideRouteReachability(LOCAL, probed({ kind: "refused", reason: "fetch failed (connect ECONNREFUSED)" })))
      .toEqual({ kind: "unreachable", route: ROUTE, url: URL, cause: { kind: "refused", reason: "fetch failed (connect ECONNREFUSED)" } });
  });

  it("is unconfigured when Pi declares no endpoint for the provider", () => {
    expect(decideRouteReachability(LOCAL, { kind: "unconfigured" })).toEqual({ kind: "unconfigured", route: ROUTE, provider: LOCAL.provider });
  });

  it("owns the whole status table: auth refusal and 2xx are reachable, everything else unreachable (property)", () => {
    fc.assert(fc.property(
      fc.integer({ min: 100, max: 599 }),
      fc.option(fc.array(fc.constantFrom(LOCAL.model, "other", "third")), { nil: null }),
      (status, servedModels) => {
        const decision = decideProbedRoute(LOCAL, ENDPOINT, answered(status, servedModels));
        const ok = status >= 200 && status <= 299;
        const auth = status === 401 || status === 403;
        const served = ok && servedModels !== null;
        if (auth) expect(decision).toMatchObject({ kind: "reachable", served: { kind: "unlisted", cause: "auth-refused", status } });
        else if (!ok) expect(decision).toMatchObject({ kind: "unreachable", cause: { kind: "http-status", status } });
        else if (!served) expect(decision).toMatchObject({ kind: "reachable", served: { kind: "unlisted", cause: "unreadable-listing" } });
        else if (servedModels.includes(LOCAL.model)) expect(decision).toMatchObject({ kind: "reachable", served: { kind: "listed", models: servedModels } });
        else expect(decision).toMatchObject({ kind: "unreachable", cause: { kind: "model-not-served", served: servedModels } });
      },
    ), { numRuns: 300 });
  });

  it("refuses every non-auth, non-2xx status with the HTTP status as the reason (property)", () => {
    fc.assert(fc.property(
      fc.integer({ min: 100, max: 599 }).filter((status) => (status < 200 || status > 299) && status !== 401 && status !== 403),
      (status) => {
        expect(refusal([decideProbedRoute(LOCAL, ENDPOINT, answered(status, [LOCAL.model]))]))
          .toContain(`is unreachable at ${URL}: GET /models answered HTTP ${status}`);
      },
    ));
  });
});

const ROLE = "code-reviewer";
const request = (pi: PiBinding, modelProfile: RecordedLlmProfileId = RETIRED_CLOUD_PROFILE) =>
  ({ role: ROLE, modelProfile, harnessBinding: { pi, claude: { harness: "claude-code", model: "sonnet" } } } as const);
const NO_ROUTING: SpawnRouting = { parentRef: null, config: null };
const LOCAL_PARENT = { provider: LOCAL.provider, model: LOCAL.model };

const routingConfig = (rules: readonly unknown[], targets: Readonly<Record<string, unknown>> = {}): ModelRoutingConfig => {
  const parsed = parseModelRoutingConfig({ schemaVersion: 1, defaultClass: "cloud", modelClasses: { local: [`${LOCAL.provider}/*`] }, targets, rules });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

describe("planSpawnRoutes", () => {
  it("launches a current request on the catalog's local route when no routing applies", () => {
    expect(planSpawnRoutes([request(LOCAL), request(LOCAL)], NO_ROUTING))
      .toEqual({ ok: true, value: { launch: [{ ...DESKTOP_VLLM_ROUTE, thinking: "high" }], retired: [] } });
  });

  it("classifies a request recorded on a retired cloud route as retired, never as a launch route", () => {
    expect(planSpawnRoutes([request(RETIRED_CLOUD_PI_BINDING), request(RETIRED_CLOUD_PI_BINDING), request(LOCAL)], NO_ROUTING)).toEqual({
      ok: true,
      value: { launch: [{ ...DESKTOP_VLLM_ROUTE, thinking: "high" }], retired: [RETIRED] },
    });
  });

  it("is retired exactly for a recorded binding other than the profile's current one (property)", () => {
    const recorded = RECORDED_LLM_PROFILE_IDS.flatMap((profile) =>
      recordedProfileBindings(profile).pi.map((pi, index) => ({ profile, pi, current: index === 0 })));
    fc.assert(fc.property(fc.constantFrom(...recorded), ({ profile, pi, current }) => {
      const plan = planSpawnRoutes([request(pi, profile)], NO_ROUTING);
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.value.retired).toEqual(current
        ? []
        : [{ kind: "retired", profile, recorded: pi, current: recordedProfileBindings(profile).pi[0] }]);
      expect(plan.value.launch.length).toBe(current ? 1 : 0);
    }));
  });

  it("probes the binding the child launches with when a routing rule names another target (gate = renderer)", () => {
    const config = routingConfig(
      [{ id: "local-reviews-use-muse", when: { parentClass: "local" }, use: { kind: "named", target: "muse" } }],
      { muse: { model: "desktop-muse/qwen3.8-27b", thinkingLevel: "medium" } },
    );
    const routing: SpawnRouting = { parentRef: LOCAL_PARENT, config };
    const plan = planSpawnRoutes([request(LOCAL)], routing);
    expect(plan).toEqual({ ok: true, value: { launch: [{ provider: "desktop-muse", model: "qwen3.8-27b", thinking: "medium" }], retired: [] } });
    const rendered = resolveAgentLaunchBinding(ROLE, routing.parentRef, routing.config);
    expect(plan.ok && rendered.ok && plan.value.launch).toEqual(rendered.ok ? [rendered.value.effective] : null);
  });

  it("launches on the parent's own route when the rule inherits the parent", () => {
    const config = routingConfig([{ id: "local-inherits", when: { parentClass: "local" }, use: { kind: "parent" } }]);
    const parentRef = { provider: LOCAL.provider, model: "qwen3.8-27b" };
    expect(planSpawnRoutes([request(LOCAL)], { parentRef, config }))
      .toEqual({ ok: true, value: { launch: [{ ...parentRef, thinking: "high" }], retired: [] } });
  });

  it("matches the renderer's launch binding for every Agent role under any routing (property)", () => {
    const config = routingConfig([{ id: "local-inherits", when: { parentClass: "local" }, use: { kind: "parent" } }]);
    const parents = [null, { provider: LOCAL.provider, model: "qwen3.8-27b" }, { provider: RETIRED_CLOUD_PI_BINDING.provider, model: RETIRED_CLOUD_PI_BINDING.model }];
    const roles = ["code-reviewer", "code-implementer-agent", "review-verifier-agent", "silent-failure-hunter"] as const;
    fc.assert(fc.property(fc.constantFrom(...roles), fc.constantFrom(...parents), fc.boolean(), (role, parentRef, routed) => {
      const profile = resolveAgentProfile(role);
      if (!profile.ok) throw new Error(profile.error.message);
      const routing: SpawnRouting = { parentRef, config: routed ? config : null };
      const plan = planSpawnRoutes([{ ...request(LOCAL, profile.value.id), role }], routing);
      const rendered = resolveAgentLaunchBinding(role, routing.parentRef, routing.config);
      expect(plan.ok && rendered.ok).toBe(true);
      if (plan.ok && rendered.ok) expect(plan.value.launch).toEqual([rendered.value.effective]);
    }));
  });
});

describe("decideSpawnGate: refusals", () => {
  it("admits when every route is reachable, whatever the served-model evidence, under the default mode", () => {
    expect(refusal([
      decideProbedRoute(LOCAL, ENDPOINT, answered(200, [LOCAL.model])),
      decideProbedRoute(LOCAL, ENDPOINT, answered(401)),
    ])).toBeNull();
  });

  it("names every refused route, its URL and the reason, and tells the operator to resume", () => {
    const text = refusal([
      decideProbedRoute(LOCAL, ENDPOINT, { kind: "refused", reason: "timed out" }),
      decideRouteReachability({ provider: "llama.cpp", model: "m" }, { kind: "unconfigured" }),
    ]);
    expect(text).toContain(`route ${ROUTE} is unreachable at ${URL}: timed out`);
    expect(text).toContain("route llama.cpp/m is unconfigured: Pi's models.json declares no baseUrl for provider 'llama.cpp'");
    expect(text).toContain("bring the route up, then resume the run");
    expect(text).toContain("declare the provider's baseUrl in Pi's models.json or route the child elsewhere in model-routing.json, then resume the run");
    expect(text).not.toContain("start a fresh run");
    expect(text).toContain("Nothing was spawned.");
  });

  it("tells the operator a retired route can only be recovered by a fresh run — never to bring it up", () => {
    const text = refusal([RETIRED]);
    expect(text).toContain(`route ${RETIRED_CLOUD_ROUTE} (recorded under profile '${RETIRED_CLOUD_PROFILE}') is retired`);
    expect(text).toContain(`the request records ${piModelPattern(RETIRED_CLOUD_PI_BINDING)}, ` +
      `and profile '${RETIRED_CLOUD_PROFILE}' now issues ${LOCAL_PI_MODEL_ARGUMENT}`);
    expect(text).toContain("start a fresh run");
    expect(text).not.toContain("bring the route up");
    expect(text).not.toContain("unconfigured");
  });

  it("derives a retired route's refusal from the recorded and current bindings alone, naming no one retirement", () => {
    // Any retargeting the catalog may make next — not only the cloud-to-local
    // one of ADR-0023 — is described by the bindings the decision carries.
    const reversed: SpawnRouteDecision = { kind: "retired", profile: "refutation", recorded: LOCAL, current: RETIRED_CLOUD_PI_BINDING };
    const text = refusal([reversed]) ?? "";
    expect(text).toContain(`route ${ROUTE} (recorded under profile 'refutation') is retired: ` +
      `the request records ${LOCAL_PI_MODEL_ARGUMENT}, and profile 'refutation' now issues ${piModelPattern(RETIRED_CLOUD_PI_BINDING)}`);
    expect(text).not.toMatch(/ADR-0023|local route only|local-only/);
  });

  it("names only the configure remedy for an unconfigured route", () => {
    const text = refusal([decideRouteReachability(RETIRED_CLOUD_PI_BINDING, { kind: "unconfigured" })]);
    expect(text).toContain("declare the provider's baseUrl in Pi's models.json");
    expect(text).not.toContain("bring the route up");
  });

  it("gives each failure its own remedy when a batch has both", () => {
    const text = refusal([RETIRED, decideProbedRoute(LOCAL, ENDPOINT, { kind: "refused", reason: "down" })]);
    expect(text).toContain("bring the route up, then resume the run");
    expect(text).toContain("start a fresh run");
  });
});

describe("decideSpawnGate: unverified routes and the gate mode", () => {
  const MUSE_UNREADABLE = decideProbedRoute({ provider: "desktop-muse", model: "m" }, { provider: "desktop-muse", baseUrl: "http://muse/v1" }, answered(200));

  it("admits under the default mode, reporting exactly the reachable routes whose served model went unconfirmed", () => {
    expect(decideSpawnGate([
      decideProbedRoute(LOCAL, ENDPOINT, answered(200, [LOCAL.model])),
      decideProbedRoute(LOCAL, ENDPOINT, answered(403)),
      MUSE_UNREADABLE,
    ], "admit-unverified")).toEqual({
      kind: "admitted",
      unverified: [
        { route: ROUTE, url: URL, cause: "auth-refused", status: 403 },
        { route: "desktop-muse/m", url: "http://muse/v1/models", cause: "unreadable-listing", status: 200 },
      ],
    });
  });

  it("reports no unverified route for a batch whose every route listed its model", () => {
    expect(decideSpawnGate([decideProbedRoute(LOCAL, ENDPOINT, answered(200, [LOCAL.model]))], "strict"))
      .toEqual({ kind: "admitted", unverified: [] });
  });

  it.each([401, 403])("refuses an authentication refusal (HTTP %i) under strict, with its own remedy", (status) => {
    const text = refusal([decideProbedRoute(LOCAL, ENDPOINT, answered(status))], "strict");
    expect(text).toContain(`route ${ROUTE} is unverified at ${URL} (${ROUTE_GATE_VARIABLE}=strict): GET /models answered HTTP ${status}, so its served models cannot be listed without credentials`);
    expect(text).toContain(`make the route list its models at GET /models without credentials, or unset ${ROUTE_GATE_VARIABLE} to admit unverified routes, then resume the run`);
    expect(text).not.toContain("bring the route up");
    expect(text).toContain("Nothing was spawned.");
  });

  it("refuses an unreadable 2xx listing under strict", () => {
    expect(refusal([MUSE_UNREADABLE], "strict"))
      .toContain("route desktop-muse/m is unverified at http://muse/v1/models (LOOM_ROUTE_GATE=strict): GET /models answered HTTP 200 without an OpenAI-style model list");
  });

  it("reports the verify remedy beside the others, in remedy order", () => {
    const text = refusal([RETIRED, decideProbedRoute(LOCAL, ENDPOINT, answered(401)), decideProbedRoute(LOCAL, ENDPOINT, { kind: "refused", reason: "down" })], "strict") ?? "";
    const order = ["bring the route up", "make the route list its models", "start a fresh run"].map((remedy) => text.indexOf(remedy));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  const decisions = fc.array(fc.oneof(
    fc.constantFrom(...PROBES).map((probe): SpawnRouteDecision => decideProbedRoute(LOCAL, ENDPOINT, probe)),
    fc.constant<SpawnRouteDecision>(RETIRED),
    fc.constant<SpawnRouteDecision>(decideRouteReachability(LOCAL, { kind: "unconfigured" })),
  ), { maxLength: 6 });
  const isUnverified = (decision: SpawnRouteDecision): boolean => decision.kind === "reachable" && decision.served.kind === "unlisted";

  it("admits exactly the batches whose every route is reachable — and, under strict, also listed (property)", () => {
    fc.assert(fc.property(decisions, fc.constantFrom<RouteGateMode>("admit-unverified", "strict"), (batch, mode) => {
      const runnable = batch.every((decision) => decision.kind === "reachable" && (mode === "admit-unverified" || !isUnverified(decision)));
      expect(decideSpawnGate(batch, mode).kind).toBe(runnable ? "admitted" : "refused");
    }));
  });

  it("only an unverified route can make the two modes disagree (property)", () => {
    fc.assert(fc.property(decisions.filter((batch) => !batch.some(isUnverified)), (batch) => {
      expect(decideSpawnGate(batch, "strict")).toEqual(decideSpawnGate(batch, "admit-unverified"));
    }));
  });
});

describe("reportUnverifiedRoutes: the emitted action names what the gate admitted unverified", () => {
  const ACTION = Object.freeze({ kind: "spawn-batch", runId: "run.unverified", requests: [] });
  const AUTH: UnverifiedRoute = { route: ROUTE, url: URL, cause: "auth-refused", status: 401 };

  it("emits the action unchanged when every route was verified", () => {
    expect(reportUnverifiedRoutes(ACTION, [])).toBe(ACTION);
  });

  it("adds every unverified route, in gate order, without touching the action's own fields", () => {
    const muse: UnverifiedRoute = { route: "desktop-muse/m", url: "http://muse/v1/models", cause: "unreadable-listing", status: 200 };
    expect(reportUnverifiedRoutes(ACTION, [AUTH, muse])).toEqual({ ...ACTION, unverifiedRoutes: [AUTH, muse] });
  });

  it("reports exactly the routes the default gate admitted unverified, and none under strict (property)", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...REACHABLE_PROBES),{ minLength: 1, maxLength: 5 }), (probes) => {
      const batch = probes.map((probe) => decideProbedRoute(LOCAL, ENDPOINT, probe));
      const admitted = decideSpawnGate(batch, "admit-unverified");
      if (admitted.kind !== "admitted") throw new Error("a reachable batch is admitted by default");
      const emitted = reportUnverifiedRoutes(ACTION, admitted.unverified);
      const unlisted = batch.filter((decision) => decision.kind === "reachable" && decision.served.kind === "unlisted").length;
      expect("unverifiedRoutes" in emitted ? emitted.unverifiedRoutes.length : 0).toBe(unlisted);
      expect(decideSpawnGate(batch, "strict").kind).toBe(unlisted === 0 ? "admitted" : "refused");
    }));
  });
});

describe("parseRouteGateMode", () => {
  it("is the default mode when the variable is unset or empty", () => {
    expect(parseRouteGateMode(undefined)).toEqual({ ok: true, value: "admit-unverified" });
    expect(parseRouteGateMode("")).toEqual({ ok: true, value: "admit-unverified" });
  });

  it.each(["strict", "admit-unverified"] as const)("admits the mode named '%s'", (mode) => {
    expect(parseRouteGateMode(mode)).toEqual({ ok: true, value: mode });
  });

  it("refuses any value naming no mode, never reading it as the default (property)", () => {
    fc.assert(fc.property(
      fc.oneof(fc.string({ minLength: 1 }), fc.constantFrom("Strict", "STRICT", "strict ", "off", "true", "1")),
      (raw) => {
        fc.pre(raw !== "strict" && raw !== "admit-unverified");
        expect(parseRouteGateMode(raw)).toEqual({ ok: false, error: `${ROUTE_GATE_VARIABLE} must be unset, 'admit-unverified' or 'strict', not '${raw}'` });
      },
    ));
  });
});

describe("route helpers", () => {
  it("joins the models path onto a base URL with or without a trailing slash", () => {
    expect(modelsUrl({ provider: "p", baseUrl: "http://h/v1" })).toBe("http://h/v1/models");
    expect(modelsUrl({ provider: "p", baseUrl: "http://h/v1//" })).toBe("http://h/v1/models");
  });

  it("probes each route once, in first-seen order, whatever the thinking level", () => {
    const medium = { ...DESKTOP_VLLM_ROUTE, thinking: "medium" as const };
    expect(medium.thinking).not.toBe(LOCAL.thinking);
    expect(distinctRoutes([LOCAL, medium, { provider: "desktop-muse", model: "m" }, LOCAL]))
      .toEqual([LOCAL, { provider: "desktop-muse", model: "m" }]);
  });
});
