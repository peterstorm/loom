import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EMISSION_TOOL_SPECS } from "../../engine/src/core/emission-tool";
import { decideProbedRoute } from "../../engine/src/core/route-reachability";
import { decidePreflight, LEGACY_UNVERIFIED_REASON, parsePreflightFacts, preflightRouteProbe, stagedRegistryFacts, type PreflightDecision, type PreflightFacts, type RouteProbe } from "./pilot-preflight";
import { PILOT_1 } from "./pilot-test-fixtures";
import { CELL_KEYS, contentDigest, PILOT_CELLS } from "./pilot-vocabulary";

describe("staged registry facts", () => {
  it("are every required cell's frozen tool name and schema digest, which the retained preregistration pins", () => {
    const registry = stagedRegistryFacts();
    expect(Object.keys(registry)).toEqual([...CELL_KEYS]);
    for (const cell of PILOT_1.cells) {
      const { kind, version } = PILOT_CELLS[cell.cell];
      const versions: Readonly<Record<string, Readonly<{ schemaBytes: string }>>> = EMISSION_TOOL_SPECS[kind].schemaVersions;
      expect(registry[cell.cell]).toEqual({ toolName: EMISSION_TOOL_SPECS[kind].toolName, schemaDigest: contentDigest(versions[version]?.schemaBytes ?? "") });
      expect(registry[cell.cell]).toEqual({ toolName: cell.toolName, schemaDigest: cell.schemaDigest });
    }
  });
});

describe("preflight (content-addressed frozen runtime + live route)", () => {
  const facts = (overrides: Partial<PreflightFacts> = {}): PreflightFacts => ({
    registry: Object.fromEntries(PILOT_1.cells.map((cell) => [cell.cell, { toolName: cell.toolName, schemaDigest: cell.schemaDigest }])) as PreflightFacts["registry"],
    workloadFixturesDigest: PILOT_1.workloadFixturesDigest,
    piVersion: PILOT_1.route.piVersion,
    stagedRuntimeRevision: "sha256:staged",
    loadedRuntimeRevision: null,
    route: { kind: "reachable", servedModels: [PILOT_1.route.model] },
    ...overrides,
  });

  it("is ready only when every identity matches and the served model is reachable", () => {
    const decision = decidePreflight(PILOT_1, facts());
    expect(decision.kind).toBe("ready");
    expect(decision.runtime.loadedRuntime).toEqual({ kind: "unobserved" });
    expect(decidePreflight(PILOT_1, facts({ loadedRuntimeRevision: "sha256:staged" })).runtime.loadedRuntime)
      .toEqual({ kind: "matches-staged", revision: "sha256:staged" });
  });

  it("blocks on every requalification trigger and on an unreachable route", () => {
    const blocksOf = (decision: PreflightDecision) => (decision.kind === "blocked" ? decision.blocks.map((block) => block.kind) : []);
    const registry = { ...facts().registry, "judge-verdict/v1": { toolName: "loom_emit_judge_verdict", schemaDigest: "f".repeat(64) } };
    expect(blocksOf(decidePreflight(PILOT_1, facts({ registry })))).toEqual(["schema-digest-mismatch"]);
    expect(blocksOf(decidePreflight(PILOT_1, facts({ piVersion: "0.84.0" })))).toEqual(["pi-version-mismatch"]);
    expect(blocksOf(decidePreflight(PILOT_1, facts({ workloadFixturesDigest: "0".repeat(64) })))).toEqual(["workload-fixtures-changed"]);
    expect(blocksOf(decidePreflight(PILOT_1, facts({ route: { kind: "unreachable", reason: "ECONNREFUSED" } })))).toEqual(["route-unreachable"]);
    expect(blocksOf(decidePreflight(PILOT_1, facts({ route: { kind: "reachable", servedModels: ["other"] } })))).toEqual(["served-model-absent"]);
    expect(blocksOf(decidePreflight(PILOT_1, facts({ loadedRuntimeRevision: "sha256:stale" })))).toEqual(["loaded-runtime-mismatch"]);
  });

  it("round-trips retained facts through the parser so re-decisions re-derive the verdict", () => {
    const retained = JSON.parse(JSON.stringify(facts({ route: { kind: "unreachable", reason: "down" } })));
    const parsed = parsePreflightFacts(retained);
    expect(parsed.ok && decidePreflight(PILOT_1, parsed.value).kind).toBe("blocked");
    expect(parsePreflightFacts({ ...retained, route: { kind: "maybe" } }).ok).toBe(false);
  });

  it("parses retained digests as strictly as the preregistration (lowercase SHA-256 hex)", () => {
    const retained = JSON.parse(JSON.stringify(facts()));
    const judge = retained.registry["judge-verdict/v1"];
    for (const digest of [judge.schemaDigest.toUpperCase(), `sha256-${judge.schemaDigest}`, judge.schemaDigest.slice(1)]) {
      expect(parsePreflightFacts({ ...retained, registry: { ...retained.registry, "judge-verdict/v1": { ...judge, schemaDigest: digest } } }).ok).toBe(false);
    }
    expect(parsePreflightFacts({ ...retained, workloadFixturesDigest: "not-a-digest" }).ok).toBe(false);
    expect(parsePreflightFacts(retained).ok).toBe(true);
  });

  it("parses the retained registry as exactly one entry per required cell (null = no cell)", () => {
    const retained = JSON.parse(JSON.stringify(facts()));
    const { "judge-verdict/v1": _judge, ...missingOne } = retained.registry;
    expect(parsePreflightFacts({ ...retained, registry: missingOne }).ok).toBe(false);
    expect(parsePreflightFacts({ ...retained, registry: { ...retained.registry, "judge-verdict/v2": null } }).ok).toBe(false);
    expect(parsePreflightFacts({ ...retained, registry: { ...retained.registry, "judge-verdict/v1": null } }).ok).toBe(true);
  });
});

describe("route probe (the engine's probe, mapped into the preflight's route fact)", () => {
  const route = PILOT_1.route;
  const url = `${route.baseUrl}/models`;
  const answered = (status: number, servedModels: readonly string[] | null = null) => ({ kind: "answered" as const, status, servedModels });
  const ready = (probe: RouteProbe): PreflightFacts => ({
    registry: stagedRegistryFacts(),
    workloadFixturesDigest: PILOT_1.workloadFixturesDigest,
    piVersion: PILOT_1.route.piVersion,
    stagedRuntimeRevision: "sha256:staged",
    loadedRuntimeRevision: null,
    route: probe,
  });

  it("maps a 2xx listing to reachable with the served models, leaving the served-model check to the preflight", () => {
    expect(preflightRouteProbe(route, answered(200, [route.model, "other"]))).toEqual({ kind: "reachable", servedModels: [route.model, "other"] });
    const absent = preflightRouteProbe(route, answered(200, ["other"]));
    expect(absent).toEqual({ kind: "reachable", servedModels: ["other"] });
    const decision = decidePreflight(PILOT_1, ready(absent));
    expect(decision.kind === "blocked" && decision.blocks).toEqual([{ kind: "served-model-absent", model: route.model, served: ["other"] }]);
  });

  it("records an authentication refusal (401/403) as an explicit served-model-unverified fact, which blocks nothing", () => {
    for (const status of [401, 403]) {
      const probe = preflightRouteProbe(route, answered(status));
      expect(probe).toEqual({
        kind: "served-model-unverified",
        reason: `GET ${url} answered HTTP ${status}: the model list needs credentials Loom never sends`,
      });
      expect(decidePreflight(PILOT_1, ready(probe)).kind).toBe("ready");
    }
  });

  it("maps everything else to unreachable, naming the URL and the engine's reason", () => {
    expect(preflightRouteProbe(route, { kind: "refused", reason: "ECONNREFUSED" })).toEqual({ kind: "unreachable", reason: `GET ${url}: ECONNREFUSED` });
    expect(preflightRouteProbe(route, answered(500))).toEqual({ kind: "unreachable", reason: `GET ${url}: GET /models answered HTTP 500` });
    expect(preflightRouteProbe(route, answered(200))).toEqual({ kind: "unreachable", reason: `GET ${url} answered without a readable model list` });
  });

  it("is a total mapping of the engine's one route decision (property)", () => {
    fc.assert(fc.property(
      fc.integer({ min: 100, max: 599 }),
      fc.option(fc.array(fc.constantFrom(route.model, "other", "third")), { nil: null }),
      (status, servedModels) => {
        const probe = answered(status, servedModels);
        const fact = preflightRouteProbe(route, probe);
        const engine = decideProbedRoute(route, { provider: route.provider, baseUrl: route.baseUrl }, probe);
        // A served list (with or without the model) is `reachable`, its list recorded for decidePreflight.
        const listed = engine.kind === "reachable" ? engine.served.kind === "listed" : engine.cause.kind === "model-not-served";
        const unverified = engine.kind === "reachable" && engine.served.kind === "unlisted" && engine.served.cause === "auth-refused";
        expect(fact.kind).toBe(listed ? "reachable" : unverified ? "served-model-unverified" : "unreachable");
        if (fact.kind === "reachable") expect(fact.servedModels).toEqual(servedModels);
      },
    ), { numRuns: 300 });
  });

  it("round-trips the explicit unverified fact through the retained-facts parser; retained arrays parse unchanged", () => {
    const fact = preflightRouteProbe(route, answered(401));
    const retained = JSON.parse(JSON.stringify(ready(fact)));
    const parsed = parsePreflightFacts(retained);
    expect(parsed.ok && parsed.value.route).toEqual(fact);
    expect(parsed.ok && decidePreflight(PILOT_1, parsed.value).kind).toBe("ready");
    const listed = parsePreflightFacts({ ...retained, route: { kind: "reachable", servedModels: [route.model] } });
    expect(listed.ok && listed.value.route).toEqual({ kind: "reachable", servedModels: [route.model] });
    expect(parsePreflightFacts({ ...retained, route: { kind: "reachable" } }).ok).toBe(false);
    expect(parsePreflightFacts({ ...retained, route: { kind: "served-model-unverified" } }).ok).toBe(false);
  });

  it("reads a window retained before the explicit fact (servedModels null, as gcd-ad11-pilot-2 recorded) as served-model-unverified", () => {
    const retained = JSON.parse(JSON.stringify({ ...ready(preflightRouteProbe(route, answered(401))), route: { kind: "reachable", servedModels: null } }));
    const parsed = parsePreflightFacts(retained);
    expect(parsed.ok && parsed.value.route).toEqual({ kind: "served-model-unverified", reason: LEGACY_UNVERIFIED_REASON });
    expect(parsed.ok && decidePreflight(PILOT_1, parsed.value).kind).toBe("ready");
  });
});
