import { describe, expect, it } from "vitest";
import {
  EMISSION_TOOL_SPECS, frozenPayloadSchemaParameters, issueEmissionBinding,
  type EmissionSchemaVersion, type EmissionToolSpec,
} from "../../src/core/emission-tool";
import { EMISSION_CONSTRAINED_SAMPLING_REQUEST } from "../../src/core/harness-capture";
import type { PayloadProducerKindName } from "../../src/core/model-profiles";
import { emissionToolDefinition } from "../../../pi/emission-tool";
import { JUDGE_VERDICT_SCHEMA_V1, JUDGE_VERDICT_SCHEMA_V1_DIGEST } from "../../src/core/panel-contract";
import { REFUTATION_VERDICT_SCHEMA_V1, REFUTATION_VERDICT_SCHEMA_V1_DIGEST } from "../../src/core/review-panel";
import { sha256Hex } from "../../src/core/digest";
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

/**
 * The REGISTERED tool surface (FR-021/SC-006, AS-013): the byte identity is
 * proven where the tool is actually REGISTERED, not only at the parameters
 * constructor above. `emissionToolDefinition` is the production definition
 * pi/emission-readiness.ts registers — the same definition the readiness barrier and
 * the Pi validation suite (`engine/tests/pi/emission-tool.test.ts`) drive —
 * so one minted binding per supported (kind, version) registry cell proves
 * 100% of the per-kind emission-tool parameter schemas byte-match the frozen
 * payload schema bytes AT the registered surface: the exact tool name, the
 * frozen parameters bytes, and the ONE shared constrained-sampling request
 * (never a second sampling vocabulary).
 */
describe("the registered Pi tool surface carries the frozen bytes for every supported kind/version", () => {
  // Every supported registry cell, as one minted-binding round-trip case.
  // The registry is the kind/version source of truth; Object.entries erases
  // the key types, so the boundary parse (`issueEmissionBinding`) re-proves
  // each claimed cell against the closed vocabulary instead of a test cast.
  const cells = (Object.keys(EMISSION_TOOL_SPECS) as PayloadProducerKindName[]).flatMap((kind) => {
    const spec: EmissionToolSpec = EMISSION_TOOL_SPECS[kind];
    return (Object.keys(spec.schemaVersions) as EmissionSchemaVersion[]).map((version) => ({
      kind, version, spec, schemaVersion: spec.schemaVersions[version]!,
    }));
  });

  it("enumerates every supported registry cell (a vacuous pass would prove nothing)", () => {
    expect(cells.map(({ kind, version }) => `${kind}/${version}`)).toEqual([
      "reviewer-payload/v2", "reviewer-payload/v3", "judge-verdict/v1", "refutation-verdict/v1",
    ]);
  });

  for (const cell of cells) {
    it(`${cell.kind}/${cell.version}: the registered tool definition byte-matches the frozen bytes at the registered surface`, () => {
      const minted = issueEmissionBinding({
        requestId: "request:registered-surface",
        kind: cell.kind,
        version: cell.version,
      });
      expect(minted.ok, minted.ok ? "" : `${minted.error.code} — ${minted.error.message}`).toBe(true);
      if (!minted.ok) return;
      const definition = emissionToolDefinition(minted.value);
      expect(definition.name).toBe(cell.spec.toolName);
      expect(JSON.stringify(definition.parameters, null, 2)).toBe(cell.schemaVersion.schemaBytes);
      expect(definition.constrainedSampling).toEqual(EMISSION_CONSTRAINED_SAMPLING_REQUEST);
      expect(typeof definition.prepareArguments).toBe("function");
    });
  }
});
