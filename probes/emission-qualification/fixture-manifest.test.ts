import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EMISSION_TOOL_SPECS, frozenPayloadSchemaParameters } from "../../engine/src/core/emission-tool";
import { buildManifest, MANIFEST_PATH, renderManifest } from "./fixture-manifest.mts";
import { detector } from "./probe-analysis.mjs";
import registerQualificationTools, { type QualProbePi } from "./qual-extension.ts";

type RegisteredTool = Parameters<QualProbePi["registerTool"]>[0];

/** Run the child extension's session_start against a recording fake of its Pi port. */
async function registeredTools(): Promise<readonly RegisteredTool[]> {
  const tools: RegisteredTool[] = [];
  const handlers: (() => Promise<void>)[] = [];
  registerQualificationTools({
    on: (_event, handler) => { handlers.push(handler); },
    registerProvider: () => undefined,
    registerTool: (tool) => { tools.push(tool); },
    appendEntry: () => undefined,
  });
  for (const handler of handlers) await handler();
  return tools;
}

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
      const conforms = detector(entry.conformsDetect);
      const violation = detector(entry.violationDetect);
      const fixture: unknown = JSON.parse(entry.fixtureJson);
      expect(conforms(fixture), entry.registeredToolName).toBe(true);
      expect(violation(fixture), entry.registeredToolName).toBe(false);
    }
  });

  // The driver looks each row's tool up on the wire by `registeredToolName`;
  // a name the child did not register would hide as a no-verdict outcome.
  it("names exactly the tools the child extension registers, with the row's frozen schema as parameters", async () => {
    const tools = await registeredTools();
    const manifest = buildManifest();
    expect(tools.map((tool) => tool.name)).toEqual(manifest.map((entry) => entry.registeredToolName));
    for (const [index, entry] of manifest.entries()) {
      expect(tools[index]?.parameters, entry.registeredToolName).toEqual(frozenPayloadSchemaParameters(entry.schemaBytes));
    }
    // Only the reviewer cells, which share one production name, carry a suffix.
    expect(manifest.map((entry) => entry.registeredToolName)).toEqual([
      "loom_emit_reviewer_payload_v2",
      "loom_emit_reviewer_payload_v3",
      EMISSION_TOOL_SPECS["judge-verdict"].toolName,
      EMISSION_TOOL_SPECS["refutation-verdict"].toolName,
    ]);
  });
});
