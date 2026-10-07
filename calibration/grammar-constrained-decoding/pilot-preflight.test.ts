import { describe, expect, it } from "vitest";
import { EMISSION_TOOL_SPECS } from "../../engine/src/core/emission-tool";
import { decidePreflight, parsePreflightFacts, stagedRegistryFacts, type PreflightDecision, type PreflightFacts } from "./pilot-preflight";
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
