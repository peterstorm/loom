import { describe, expect, it } from "vitest";
import { EMISSION_TOOL_SPECS, frozenPayloadSchemaParameters } from "../../src/core/emission-tool";
import { JUDGE_VERDICT_SCHEMA_V1, JUDGE_VERDICT_SCHEMA_V1_DIGEST } from "../../src/core/panel-contract";
import { REFUTATION_VERDICT_SCHEMA_V1, REFUTATION_VERDICT_SCHEMA_V1_DIGEST } from "../../src/core/review-panel";
import { sha256Hex } from "../../src/core/review-packet";
import type { ArtifactDigest } from "../../src/core/orchestration-contract/identity";

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

  it("the exported verdict schema digests match sha256 of the frozen bytes beside their parsers", () => {
    // The digests are exported beside the parsers via the reviewer-protocol
    // codec pattern; pinning the derivation is what keeps a hand-edited digest
    // from describing bytes the provider never grammar-constrains against.
    expect(JUDGE_VERDICT_SCHEMA_V1_DIGEST).toBe(sha256Hex(JUDGE_VERDICT_SCHEMA_V1));
    expect(REFUTATION_VERDICT_SCHEMA_V1_DIGEST).toBe(sha256Hex(REFUTATION_VERDICT_SCHEMA_V1));
  });

  it("each spec's carried bytes digest-match the frozen bytes the parsers sit beside", () => {
    expect(sha256Hex(EMISSION_TOOL_SPECS["judge-verdict"].schemaVersions["v1"]!.schemaBytes)).toBe(JUDGE_VERDICT_SCHEMA_V1_DIGEST);
    expect(sha256Hex(EMISSION_TOOL_SPECS["refutation-verdict"].schemaVersions["v1"]!.schemaBytes)).toBe(REFUTATION_VERDICT_SCHEMA_V1_DIGEST);
  });

  it("the two verdict contracts are distinct — one schema cannot silently describe both payloads", () => {
    // The minimal two-contracts guard (the wire-contract suite extends it to
    // all three kinds with the tool-primary docs): a judge verdict and a
    // refutation verdict are different payloads, so their frozen bytes and
    // digests must differ — a collision would mean one schema drifted into
    // describing both.
    expect(JUDGE_VERDICT_SCHEMA_V1).not.toBe(REFUTATION_VERDICT_SCHEMA_V1);
    expect(JUDGE_VERDICT_SCHEMA_V1_DIGEST).not.toBe(REFUTATION_VERDICT_SCHEMA_V1_DIGEST);
  });

  it("the exported digests are branded ArtifactDigest values — type-level", () => {
    // Compile-time: the digests ride the reviewer-protocol codec pattern with
    // the branded ArtifactDigest; an accidental widening to a bare string is
    // caught here, at the one place the digests are exported beside their
    // parsers.
    const _judgeDigestIsArtifactDigest: ArtifactDigest = JUDGE_VERDICT_SCHEMA_V1_DIGEST;
    const _refutationDigestIsArtifactDigest: ArtifactDigest = REFUTATION_VERDICT_SCHEMA_V1_DIGEST;
    expect(typeof _judgeDigestIsArtifactDigest).toBe("string");
    expect(typeof _refutationDigestIsArtifactDigest).toBe("string");
  });
});
