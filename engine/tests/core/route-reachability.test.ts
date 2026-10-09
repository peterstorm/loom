import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decideProbedRoute,
  decideRouteReachability,
  distinctRoutes,
  modelsUrl,
  planSpawnRoutes,
  reachabilityRefusal,
  unverifiedRoutes,
  type RouteProbe,
  type SpawnRouting,
} from "../../src/core/route-reachability";
import {
  DESKTOP_VLLM_ROUTE,
  RETIRED_LLM_PROFILE_IDS,
  LLM_PROFILE_IDS,
  recordedProfileBindings,
  resolveAgentProfile,
  type PiBinding,
  type RecordedLlmProfileId,
} from "../../src/core/model-profiles";
import { parseModelRoutingConfig, resolveAgentLaunchBinding, type ModelRoutingConfig } from "../../src/core/model-routing";

const LOCAL: PiBinding = { harness: "pi", ...DESKTOP_VLLM_ROUTE, thinking: "high" };
const ENDPOINT = { provider: "desktop-vllm", baseUrl: "http://192.168.0.80:8000/v1/" };
const URL = "http://192.168.0.80:8000/v1/models";
const ROUTE = `${DESKTOP_VLLM_ROUTE.provider}/${DESKTOP_VLLM_ROUTE.model}`;

const answered = (status: number, servedModels: readonly string[] | null = null): RouteProbe =>
  ({ kind: "answered", status, servedModels });
const probed = (probe: RouteProbe) => ({ kind: "probed" as const, endpoint: ENDPOINT, probe });

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
    expect(reachabilityRefusal([decision])).toContain("does not serve 'glm-5.3-flash-spark-tp2-v14' (serves: qwen3.8-27b)");
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
    expect(decideRouteReachability(LOCAL, { kind: "unconfigured" })).toEqual({ kind: "unconfigured", route: ROUTE, provider: "desktop-vllm" });
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
        expect(reachabilityRefusal([decideProbedRoute(LOCAL, ENDPOINT, answered(status, [LOCAL.model]))]))
          .toContain(`is unreachable at ${URL}: GET /models answered HTTP ${status}`);
      },
    ));
  });
});

const ROLE = "code-reviewer";
const request = (pi: PiBinding, modelProfile: RecordedLlmProfileId = "general-review") =>
  ({ role: ROLE, modelProfile, harnessBinding: { pi, claude: { harness: "claude-code", model: "sonnet" } } } as const);
const NO_ROUTING: SpawnRouting = { parentRef: null, config: null };
const RETIRED_SOL: PiBinding = { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" };

const routingConfig = (rules: readonly unknown[], targets: Readonly<Record<string, unknown>> = {}): ModelRoutingConfig => {
  const parsed = parseModelRoutingConfig({ schemaVersion: 1, defaultClass: "cloud", modelClasses: { local: ["desktop-vllm/*"] }, targets, rules });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

describe("planSpawnRoutes", () => {
  it("launches a current request on the catalog's local route when no routing applies", () => {
    expect(planSpawnRoutes([request(LOCAL), request(LOCAL)], NO_ROUTING))
      .toEqual({ ok: true, value: { launch: [{ ...DESKTOP_VLLM_ROUTE, thinking: "high" }], retired: [] } });
  });

  it("classifies a request recorded on a retired cloud route as retired, never as a launch route", () => {
    expect(planSpawnRoutes([request(RETIRED_SOL), request(RETIRED_SOL), request(LOCAL)], NO_ROUTING)).toEqual({
      ok: true,
      value: {
        launch: [{ ...DESKTOP_VLLM_ROUTE, thinking: "high" }],
        retired: [{ kind: "retired", route: "openai-codex/gpt-5.6-sol", profile: "general-review" }],
      },
    });
  });

  it("is retired exactly for a recorded binding other than the profile's current one (property)", () => {
    const recorded = [...LLM_PROFILE_IDS, ...RETIRED_LLM_PROFILE_IDS].flatMap((profile) =>
      recordedProfileBindings(profile).pi.map((pi, index) => ({ profile, pi, current: index === 0 })));
    fc.assert(fc.property(fc.constantFrom(...recorded), ({ profile, pi, current }) => {
      const plan = planSpawnRoutes([request(pi, profile)], NO_ROUTING);
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.value.retired.length).toBe(current ? 0 : 1);
      expect(plan.value.launch.length).toBe(current ? 1 : 0);
    }));
  });

  it("probes the binding the child launches with when a routing rule names another target (gate = renderer)", () => {
    const config = routingConfig(
      [{ id: "local-reviews-use-muse", when: { parentClass: "local" }, use: { kind: "named", target: "muse" } }],
      { muse: { model: "desktop-muse/qwen3.8-27b", thinkingLevel: "medium" } },
    );
    const routing: SpawnRouting = { parentRef: { provider: "desktop-vllm", model: "glm-5.3-flash-spark-tp2-v14" }, config };
    const plan = planSpawnRoutes([request(LOCAL)], routing);
    expect(plan).toEqual({ ok: true, value: { launch: [{ provider: "desktop-muse", model: "qwen3.8-27b", thinking: "medium" }], retired: [] } });
    const rendered = resolveAgentLaunchBinding(ROLE, routing.parentRef, routing.config);
    expect(plan.ok && rendered.ok && plan.value.launch).toEqual(rendered.ok ? [rendered.value.effective] : null);
  });

  it("launches on the parent's own route when the rule inherits the parent", () => {
    const config = routingConfig([{ id: "local-inherits", when: { parentClass: "local" }, use: { kind: "parent" } }]);
    const parentRef = { provider: "desktop-vllm", model: "qwen3.8-27b" };
    expect(planSpawnRoutes([request(LOCAL)], { parentRef, config }))
      .toEqual({ ok: true, value: { launch: [{ ...parentRef, thinking: "high" }], retired: [] } });
  });

  it("matches the renderer's launch binding for every Agent role under any routing (property)", () => {
    const config = routingConfig([{ id: "local-inherits", when: { parentClass: "local" }, use: { kind: "parent" } }]);
    const parents = [null, { provider: "desktop-vllm", model: "qwen3.8-27b" }, { provider: "openai-codex", model: "gpt-5.6-sol" }];
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

describe("reachabilityRefusal", () => {
  it("is null when every route is reachable, whatever the served-model evidence", () => {
    expect(reachabilityRefusal([
      decideProbedRoute(LOCAL, ENDPOINT, answered(200, [LOCAL.model])),
      decideProbedRoute(LOCAL, ENDPOINT, answered(401)),
    ])).toBeNull();
  });

  it("names every refused route, its URL and the reason, and tells the operator to resume", () => {
    const refusal = reachabilityRefusal([
      decideProbedRoute(LOCAL, ENDPOINT, { kind: "refused", reason: "timed out" }),
      decideRouteReachability({ provider: "llama.cpp", model: "m" }, { kind: "unconfigured" }),
    ]);
    expect(refusal).toContain(`route ${ROUTE} is unreachable at ${URL}: timed out`);
    expect(refusal).toContain("route llama.cpp/m is unconfigured: Pi's models.json declares no baseUrl for provider 'llama.cpp'");
    expect(refusal).toContain("bring the route up, then resume the run");
    expect(refusal).toContain("declare the provider's baseUrl in Pi's models.json or route the child elsewhere in model-routing.json, then resume the run");
    expect(refusal).not.toContain("start a fresh run");
    expect(refusal).toContain("Nothing was spawned.");
  });

  it("tells the operator a retired route can only be recovered by a fresh run — never to bring it up", () => {
    const refusal = reachabilityRefusal([{ kind: "retired", route: "openai-codex/gpt-5.6-sol", profile: "general-review" }]);
    expect(refusal).toContain("route openai-codex/gpt-5.6-sol (recorded under profile 'general-review') is retired");
    expect(refusal).toContain("ADR-0023");
    expect(refusal).toContain("start a fresh run");
    expect(refusal).not.toContain("bring the route up");
    expect(refusal).not.toContain("unconfigured");
  });

  it("names only the configure remedy for an unconfigured route", () => {
    const refusal = reachabilityRefusal([decideRouteReachability({ provider: "openai-codex", model: "gpt-5.6-sol" }, { kind: "unconfigured" })]);
    expect(refusal).toContain("declare the provider's baseUrl in Pi's models.json");
    expect(refusal).not.toContain("bring the route up");
  });

  it("gives each failure its own remedy when a batch has both", () => {
    const refusal = reachabilityRefusal([
      { kind: "retired", route: "openai-codex/gpt-5.5", profile: "focused-review" },
      decideProbedRoute(LOCAL, ENDPOINT, { kind: "refused", reason: "down" }),
    ]);
    expect(refusal).toContain("bring the route up, then resume the run");
    expect(refusal).toContain("start a fresh run");
  });
});

describe("unverifiedRoutes", () => {
  it("reports exactly the reachable routes whose served model went unconfirmed", () => {
    expect(unverifiedRoutes([
      decideProbedRoute(LOCAL, ENDPOINT, answered(200, [LOCAL.model])),
      decideProbedRoute(LOCAL, ENDPOINT, answered(403)),
      decideProbedRoute({ provider: "desktop-muse", model: "m" }, { provider: "desktop-muse", baseUrl: "http://muse/v1" }, answered(200)),
      decideProbedRoute(LOCAL, ENDPOINT, { kind: "refused", reason: "down" }),
      { kind: "retired", route: "openai-codex/gpt-5.6-sol", profile: "general-review" },
    ])).toEqual([
      { route: ROUTE, url: URL, cause: "auth-refused", status: 403 },
      { route: "desktop-muse/m", url: "http://muse/v1/models", cause: "unreadable-listing", status: 200 },
    ]);
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
