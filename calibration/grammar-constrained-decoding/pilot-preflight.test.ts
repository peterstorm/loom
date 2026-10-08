import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EMISSION_TOOL_SPECS } from "../../engine/src/core/emission-tool";
import { decidePreflight, parsePreflightFacts, preflightRouteProbe, stagedRegistryFacts, type PreflightDecision, type PreflightFacts, type RouteProbe } from "./pilot-preflight";
import { prereg as retainedPrereg } from "./pilot-test-fixtures";
import { CELL_KEYS, contentDigest, PILOT_CELLS } from "./pilot-vocabulary";

describe("staged registry facts", () => {
  it("are every required cell's frozen tool name and schema digest, which the retained preregistration pins", () => {
    const registry = stagedRegistryFacts();
    expect(Object.keys(registry)).toEqual([...CELL_KEYS]);
    for (const cell of retainedPrereg.cells) {
      const { kind, version } = PILOT_CELLS[cell.cell];
      const versions: Readonly<Record<string, Readonly<{ schemaBytes: string }>>> = EMISSION_TOOL_SPECS[kind].schemaVersions;
      expect(registry[cell.cell]).toEqual({ toolName: EMISSION_TOOL_SPECS[kind].toolName, schemaDigest: contentDigest(versions[version]?.schemaBytes ?? "") });
      expect(registry[cell.cell]).toEqual({ toolName: cell.toolName, schemaDigest: cell.schemaDigest });
    }
  });
});

describe("preflight (content-addressed frozen runtime + live route)", () => {
  const prereg = retainedPrereg;
  const facts = (overrides: Partial<PreflightFacts> = {}): PreflightFacts => ({
    registry: Object.fromEntries(prereg.cells.map((cell) => [cell.cell, { toolName: cell.toolName, schemaDigest: cell.schemaDigest }])) as PreflightFacts["registry"],
    workloadFixturesDigest: prereg.workloadFixturesDigest,
    piVersion: prereg.route.piVersion,
    stagedRuntimeRevision: "sha256:staged",
    loadedRuntimeRevision: null,
    route: { kind: "reachable", servedModels: [prereg.route.model] },
    ...overrides,
  });

  it("is ready only when every identity matches and the served model is reachable", () => {
    const decision = decidePreflight(prereg, facts());
    expect(decision.kind).toBe("ready");
    expect(decision.runtime.loadedRuntime).toEqual({ kind: "unobserved" });
    expect(decidePreflight(prereg, facts({ loadedRuntimeRevision: "sha256:staged" })).runtime.loadedRuntime)
      .toEqual({ kind: "matches-staged", revision: "sha256:staged" });
  });

  it("blocks on every requalification trigger and on an unreachable route", () => {
    const blocksOf = (decision: PreflightDecision) => (decision.kind === "blocked" ? decision.blocks.map((block) => block.kind) : []);
    const registry = { ...facts().registry, "judge-verdict/v1": { toolName: "loom_emit_judge_verdict", schemaDigest: "f".repeat(64) } };
    expect(blocksOf(decidePreflight(prereg, facts({ registry })))).toEqual(["schema-digest-mismatch"]);
    expect(blocksOf(decidePreflight(prereg, facts({ piVersion: "0.84.0" })))).toEqual(["pi-version-mismatch"]);
    expect(blocksOf(decidePreflight(prereg, facts({ workloadFixturesDigest: "0".repeat(64) })))).toEqual(["workload-fixtures-changed"]);
    expect(blocksOf(decidePreflight(prereg, facts({ route: { kind: "unreachable", reason: "ECONNREFUSED" } })))).toEqual(["route-unreachable"]);
    expect(blocksOf(decidePreflight(prereg, facts({ route: { kind: "reachable", servedModels: ["other"] } })))).toEqual(["served-model-absent"]);
    expect(blocksOf(decidePreflight(prereg, facts({ loadedRuntimeRevision: "sha256:stale" })))).toEqual(["loaded-runtime-mismatch"]);
  });

  it("round-trips retained facts through the parser so re-decisions re-derive the verdict", () => {
    const retained = JSON.parse(JSON.stringify(facts({ route: { kind: "unreachable", reason: "down" } })));
    const parsed = parsePreflightFacts(retained);
    expect(parsed.ok && decidePreflight(prereg, parsed.value).kind).toBe("blocked");
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
  const route = retainedPrereg.route;
  const url = `${route.baseUrl}/models`;
  const answered = (status: number, servedModels: readonly string[] | null = null) => ({ kind: "answered" as const, status, servedModels });
  const ready = (probe: RouteProbe): PreflightFacts => ({
    registry: stagedRegistryFacts(),
    workloadFixturesDigest: retainedPrereg.workloadFixturesDigest,
    piVersion: retainedPrereg.route.piVersion,
    stagedRuntimeRevision: "sha256:staged",
    loadedRuntimeRevision: null,
    route: probe,
  });

  it("maps a 2xx listing to reachable with the served models, leaving the served-model check to the preflight", () => {
    expect(preflightRouteProbe(route, answered(200, [route.model, "other"]))).toEqual({ kind: "reachable", servedModels: [route.model, "other"] });
    const absent = preflightRouteProbe(route, answered(200, ["other"]));
    expect(absent).toEqual({ kind: "reachable", servedModels: ["other"] });
    const decision = decidePreflight(retainedPrereg, ready(absent));
    expect(decision.kind === "blocked" && decision.blocks).toEqual([{ kind: "served-model-absent", model: route.model, served: ["other"] }]);
  });

  it("maps an authentication refusal (401/403) to reachable with an unobservable served list, which blocks nothing", () => {
    for (const status of [401, 403]) {
      const probe = preflightRouteProbe(route, answered(status));
      expect(probe).toEqual({ kind: "reachable", servedModels: null });
      expect(decidePreflight(retainedPrereg, ready(probe)).kind).toBe("ready");
    }
  });

  it("maps everything else to unreachable, naming the URL and the reason", () => {
    expect(preflightRouteProbe(route, { kind: "refused", reason: "ECONNREFUSED" })).toEqual({ kind: "unreachable", reason: `GET ${url}: ECONNREFUSED` });
    expect(preflightRouteProbe(route, answered(500))).toEqual({ kind: "unreachable", reason: `GET ${url}: GET /models answered HTTP 500` });
    expect(preflightRouteProbe(route, answered(200))).toEqual({ kind: "unreachable", reason: `GET ${url} answered without a readable model list` });
  });

  it("is reachable exactly for a 2xx listing or an auth refusal (property)", () => {
    fc.assert(fc.property(
      fc.integer({ min: 100, max: 599 }),
      fc.option(fc.array(fc.constantFrom(route.model, "other", "third")), { nil: null }),
      (status, servedModels) => {
        const probe = preflightRouteProbe(route, answered(status, servedModels));
        const listed = status >= 200 && status <= 299 && servedModels !== null;
        const auth = status === 401 || status === 403;
        expect(probe.kind).toBe(listed || auth ? "reachable" : "unreachable");
        if (probe.kind === "reachable") expect(probe.servedModels).toEqual(listed ? servedModels : null);
      },
    ), { numRuns: 200 });
  });

  it("round-trips an unobservable served list through the retained-facts parser; retained arrays parse unchanged", () => {
    const retained = JSON.parse(JSON.stringify(ready({ kind: "reachable", servedModels: null })));
    const parsed = parsePreflightFacts(retained);
    expect(parsed.ok && parsed.value.route).toEqual({ kind: "reachable", servedModels: null });
    expect(parsed.ok && decidePreflight(retainedPrereg, parsed.value).kind).toBe("ready");
    const listed = parsePreflightFacts({ ...retained, route: { kind: "reachable", servedModels: [route.model] } });
    expect(listed.ok && listed.value.route).toEqual({ kind: "reachable", servedModels: [route.model] });
    expect(parsePreflightFacts({ ...retained, route: { kind: "reachable" } }).ok).toBe(false);
  });
});
