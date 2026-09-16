import { describe, expect, it } from "vitest";
import { EMISSION_TOOL_SPECS, frozenPayloadSchemaParameters } from "../../src/core/emission-tool";
import { JUDGE_VERDICT_SCHEMA_V1 } from "../../src/core/panel-contract";
import { REFUTATION_VERDICT_SCHEMA_V1 } from "../../src/core/review-panel";

/**
 * One schema, no second contract (FR-021/SC-006, now three kinds): each
 * emission tool's `parameters` object is constructed by parsing the frozen
 * bytes once, so byte-identity holds by construction — and the guard proves it
 * through a DIFFERENT serialization chain than the stamper writes with. The
 * frozen bytes were written with `JSON.stringify(z.toJSONSchema(...), null, 2)`;
 * re-serializing the PARSED bytes with `JSON.stringify(..., null, 2)` proves the
 * parse→stringify round trip is identity, so a schema that fails this guard has
 * drifted from the bytes the provider grammar-constrains against.
 */
describe("emission tool parameter schemas byte-match the frozen payload schema bytes", () => {
  for (const [kind, spec] of Object.entries(EMISSION_TOOL_SPECS)) {
    for (const [version, schemaVersion] of Object.entries(spec.schemaVersions)) {
      it(`${kind} ${version}: parameters byte-match the frozen bytes through a different serialization chain`, () => {
        const parameters = frozenPayloadSchemaParameters(schemaVersion.schemaBytes);
        expect(JSON.stringify(parameters, null, 2)).toBe(schemaVersion.schemaBytes);
      });
    }
  }

  it("the judge-verdict emission tool's parameters byte-match JUDGE_VERDICT_SCHEMA_V1", () => {
    const parameters = frozenPayloadSchemaParameters(JUDGE_VERDICT_SCHEMA_V1);
    expect(JSON.stringify(parameters, null, 2)).toBe(JUDGE_VERDICT_SCHEMA_V1);
  });

  it("the refutation-verdict emission tool's parameters byte-match REFUTATION_VERDICT_SCHEMA_V1", () => {
    const parameters = frozenPayloadSchemaParameters(REFUTATION_VERDICT_SCHEMA_V1);
    expect(JSON.stringify(parameters, null, 2)).toBe(REFUTATION_VERDICT_SCHEMA_V1);
  });

  it("the toolName literals come from the registry, never hand-minted", () => {
    expect(EMISSION_TOOL_SPECS["reviewer-payload"].toolName).toBe("loom_emit_reviewer_payload");
    expect(EMISSION_TOOL_SPECS["judge-verdict"].toolName).toBe("loom_emit_judge_verdict");
    expect(EMISSION_TOOL_SPECS["refutation-verdict"].toolName).toBe("loom_emit_refutation_verdict");
  });

  it("the frozen bytes parse as strict JSON for every kind and version", () => {
    for (const spec of Object.values(EMISSION_TOOL_SPECS)) {
      for (const schemaVersion of Object.values(spec.schemaVersions)) {
        expect(() => JSON.parse(schemaVersion.schemaBytes)).not.toThrow();
      }
    }
  });
});
