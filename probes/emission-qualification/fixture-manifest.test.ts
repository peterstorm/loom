import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EMISSION_TOOL_SPECS } from "../../engine/src/core/emission-tool";
import { buildManifest, MANIFEST_PATH, renderManifest } from "./fixture-manifest.mts";

/**
 * The committed probe manifest is a generated artifact: it must be exactly
 * what `gen-fixtures.mts` writes from the current frozen registry and zod
 * schemas, so neither can drift without this test failing. Regenerate with
 * `bun probes/emission-qualification/gen-fixtures.mts`.
 */
describe("fixtures/manifest.json", () => {
  it("is byte-identical to its generator's output", () => {
    expect(readFileSync(MANIFEST_PATH, "utf8")).toBe(renderManifest());
  });

  it("carries every registry cell's frozen schema bytes, and each fixture passes its own pinned detectors", () => {
    const manifest = buildManifest();
    expect(manifest.map((entry) => `${entry.kind}/${entry.version}`)).toEqual([
      "reviewer-payload/v2", "reviewer-payload/v3", "judge-verdict/v1", "refutation-verdict/v1",
    ]);
    for (const entry of manifest) {
      const versions = Object.entries(EMISSION_TOOL_SPECS[entry.kind as keyof typeof EMISSION_TOOL_SPECS].schemaVersions);
      const frozen = versions.find(([version]) => version === entry.version)?.[1];
      expect(entry.schemaBytes, entry.registeredToolName).toBe(frozen?.schemaBytes);
      const conforms = new Function(`return (${entry.conformsDetect})`)() as (args: unknown) => boolean;
      const violation = new Function(`return (${entry.violationDetect})`)() as (args: unknown) => boolean;
      const fixture: unknown = JSON.parse(entry.fixtureJson);
      expect(conforms(fixture), entry.registeredToolName).toBe(true);
      expect(violation(fixture), entry.registeredToolName).toBe(false);
    }
  });
});
