import { describe, expect, it } from "vitest";
import {
  admitEmissionArguments,
  EMISSION_TOOL_SPECS,
  frozenPayloadSchemaParameters,
  notProvidedEmissionCapability,
  providedEmissionCapability,
} from "../../src/core/emission-tool";
import { producerKindsOfAgent } from "../../src/core/model-profiles";
import { REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../src/core/reviewer-contract";
import { canonicalStructuralEquals, type ArtifactDigest } from "../../src/core/orchestration-contract/identity";

describe("producerKindsOfAgent", () => {
  it("projects the three cataloged producer kinds from the catalog", () => {
    expect(producerKindsOfAgent("code-reviewer")).toEqual([{ kind: "reviewer-payload" }]);
    expect(producerKindsOfAgent("arch-judge-agent")).toEqual([{ kind: "judge-verdict" }]);
  });

  it("expresses the review-verifier agent's genuinely dual payload kinds", () => {
    expect(producerKindsOfAgent("review-verifier-agent")).toEqual([
      { kind: "reviewer-payload" },
      { kind: "refutation-verdict" },
    ]);
  });

  it("produces no kinds for non-producer agents — arch-panel designers included", () => {
    expect(producerKindsOfAgent("arch-designer-agent")).toEqual([]);
    expect(producerKindsOfAgent("arch-interviewer-agent")).toEqual([]);
    expect(producerKindsOfAgent("code-implementer-agent")).toEqual([]);
    expect(producerKindsOfAgent("decompose-agent")).toEqual([]);
  });

  it("scopes the judge-verdict kind by the unique panel-judge profile, not the arch-panel kind", () => {
    for (const agent of [
      "code-reviewer",
      "silent-failure-hunter",
      "pr-test-analyzer",
      "type-design-analyzer",
      "comment-analyzer",
      "architecture-tech-lead",
    ] as const) {
      expect(producerKindsOfAgent(agent)).toContainEqual({ kind: "reviewer-payload" });
    }
    expect(producerKindsOfAgent("arch-designer-agent")).not.toContainEqual({ kind: "judge-verdict" });
  });
});

describe("EMISSION_TOOL_SPECS", () => {
  it("maps each of the three producer kinds to its emission tool spec", () => {
    expect(EMISSION_TOOL_SPECS["reviewer-payload"].toolName).toBe("loom_emit_reviewer_payload");
    expect(EMISSION_TOOL_SPECS["judge-verdict"].toolName).toBe("loom_emit_judge_verdict");
    expect(EMISSION_TOOL_SPECS["refutation-verdict"].toolName).toBe("loom_emit_refutation_verdict");
  });

  it("carries the frozen schema versions per kind", () => {
    expect(Object.keys(EMISSION_TOOL_SPECS["reviewer-payload"].schemaVersions).sort()).toEqual(["v2", "v3"]);
    expect(Object.keys(EMISSION_TOOL_SPECS["judge-verdict"].schemaVersions)).toEqual(["v1"]);
    expect(Object.keys(EMISSION_TOOL_SPECS["refutation-verdict"].schemaVersions)).toEqual(["v1"]);
  });
});

describe("admitEmissionArguments", () => {
  it("admits valid reviewer-payload arguments through the same full parser the fallback uses", () => {
    const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["reviewer-payload"], "v2", REVIEWER_PAYLOAD_EXAMPLE_V2);
    expect(admitted.kind).toBe("valid");
    if (admitted.kind === "valid") {
      expect(canonicalStructuralEquals(admitted.payload, REVIEWER_PAYLOAD_EXAMPLE_V2)).toBe(true);
    }
  });

  it("admits valid judge-verdict arguments — shape, score domain, prose sanitization", () => {
    const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["judge-verdict"], "v1", {
      criterion: "extensibility",
      rankings: [
        { candidate: "candidate-type-driven-fp.md", score: 8, fatal_flaw: null, strongest_idea: "the frozen registry" },
      ],
    });
    expect(admitted.kind).toBe("valid");
  });

  it("admits valid refutation-verdict arguments", () => {
    const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["refutation-verdict"], "v1", {
      criterion: "reproduction",
      verdicts: [{ finding_id: "T1:code-reviewer-1", verdict: "refuted", reasoning: "the failure cannot be triggered" }],
    });
    expect(admitted.kind).toBe("valid");
  });

  it("refuses schema-invalid arguments as never-ingestable with the parse's own code", () => {
    const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["judge-verdict"], "v1", {
      criterion: "extensibility",
      rankings: [{ candidate: "candidate-x.md", score: 11, fatal_flaw: null, strongest_idea: "out of the score domain" }],
    });
    expect(admitted.kind).toBe("invalid-schema");
    if (admitted.kind === "invalid-schema") {
      expect(admitted.code).toBe("invalid-schema");
      expect(admitted.message).toContain("frozen schema");
    }
  });

  it("refuses prose-brace payloads the sanitization strips to nothing", () => {
    const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["refutation-verdict"], "v1", {
      criterion: "reproduction",
      verdicts: [{ finding_id: "T1:x-1", verdict: "upheld", reasoning: " { } " }],
    });
    expect(admitted.kind).toBe("invalid-schema");
  });

  it("refuses arguments that cannot be serialized deterministically", () => {
    const circular: Record<string, unknown> = { criterion: "x" };
    circular["self"] = circular;
    const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["judge-verdict"], "v1", circular);
    expect(admitted.kind).toBe("invalid-schema");
    if (admitted.kind === "invalid-schema") expect(admitted.code).toBe("invalid-json");
  });

  it("refuses an unsupported schema version", () => {
    const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["judge-verdict"], "v2", {});
    expect(admitted.kind).toBe("invalid-schema");
    if (admitted.kind === "invalid-schema") {
      expect(admitted.code).toBe("unsupported-schema-version");
      expect(admitted.message).toContain("v2");
    }
  });
});

describe("frozenPayloadSchemaParameters", () => {
  it("is the ONE constructor: parsing the frozen bytes once and re-serializing is identity", () => {
    const schemaBytes = EMISSION_TOOL_SPECS["judge-verdict"].schemaVersions["v1"]!.schemaBytes;
    const parameters = frozenPayloadSchemaParameters(schemaBytes);
    expect(JSON.stringify(parameters, null, 2)).toBe(schemaBytes);
  });
});

describe("EmissionToolCapability", () => {
  it("mints the provided capability with its branded schema digest", () => {
    const digest = "a".repeat(64) as ArtifactDigest;
    const capability = providedEmissionCapability(digest);
    expect(canonicalStructuralEquals(capability, { kind: "provided", schemaDigest: digest })).toBe(true);
  });

  it("mints the not-provided capability with its degradation class as data", () => {
    const refused = notProvidedEmissionCapability(
      "the loaded runtime revision does not contain the emission-tool module",
      "refuse",
    );
    expect(canonicalStructuralEquals(refused, {
      kind: "not-provided",
      reason: "the loaded runtime revision does not contain the emission-tool module",
      degradation: "refuse",
    })).toBe(true);

    const extraction = notProvidedEmissionCapability("no Loom extension seam", "extraction");
    expect(canonicalStructuralEquals(extraction, {
      kind: "not-provided",
      reason: "no Loom extension seam",
      degradation: "extraction",
    })).toBe(true);
  });
});
