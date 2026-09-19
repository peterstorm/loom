import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  admitEmissionArguments,
  EMISSION_TOOL_SPECS,
  frozenPayloadSchemaParameters,
  notProvidedEmissionCapability,
  providedEmissionCapability,
  type EmissionArgumentAdmission,
  type EmissionParseFailureCode,
} from "../../src/core/emission-tool";
import { producerKindsOfAgent } from "../../src/core/model-profiles";
import { REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../src/core/reviewer-contract";
import { parseReviewerPayloadV2, parseStandaloneReviewerPayloadV3 } from "../../src/core/reviewer-protocol";
import { standaloneReviewerPayloadV3Schema } from "../../src/core/standalone-lineage-contract";
import { canonicalStructuralEquals, type ArtifactDigest } from "../../src/core/orchestration-contract/identity";

/** Non-empty prose matching the frozen verdict schemas' min(1) constraints. */
const proseArb = fc.stringMatching(/^[a-z0-9][a-z0-9 .,;:\-]{0,60}$/);

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

  it("returns frozen results — the US4 capability gate reads the projection as data, never as a caller convention", () => {
    // The doc-comment invariant: every projection — the dual-payload list and
    // the empty non-producer list included — is frozen, so a caller-side push
    // cannot widen it behind the per-kind emission-tool scoping.
    expect(Object.isFrozen(producerKindsOfAgent("code-reviewer"))).toBe(true);
    expect(Object.isFrozen(producerKindsOfAgent("arch-judge-agent"))).toBe(true);
    expect(Object.isFrozen(producerKindsOfAgent("review-verifier-agent"))).toBe(true);
    expect(Object.isFrozen(producerKindsOfAgent("arch-designer-agent"))).toBe(true);
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

  it("carries the same parsers the fallback uses — one parser, not a second contract", () => {
    // The admission gate and PR #52's fallback share ONE parser per version
    // (the security note's "the SAME parser the fallback uses"); pinning the
    // identity is what stops a second, divergent parse from being minted.
    expect(EMISSION_TOOL_SPECS["reviewer-payload"].schemaVersions["v2"]?.parsePayload).toBe(parseReviewerPayloadV2);
    expect(EMISSION_TOOL_SPECS["reviewer-payload"].schemaVersions["v3"]?.parsePayload).toBe(parseStandaloneReviewerPayloadV3);
  });

  it("is frozen at every level — a runtime push would widen the spec behind every proof that reads it", () => {
    expect(Object.isFrozen(EMISSION_TOOL_SPECS)).toBe(true);
    for (const spec of Object.values(EMISSION_TOOL_SPECS)) {
      expect(Object.isFrozen(spec)).toBe(true);
      expect(Object.isFrozen(spec.schemaVersions)).toBe(true);
      for (const schemaVersion of Object.values(spec.schemaVersions)) {
        expect(Object.isFrozen(schemaVersion)).toBe(true);
      }
    }
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

  it("admits valid standalone-successor (v3) arguments through the registry's v3 parser", () => {
    const payload = standaloneReviewerPayloadV3Schema.parse({
      schemaVersion: 3,
      kind: "standalone-successor-review",
      lineageDigest: "a".repeat(64),
      snapshotDigest: "b".repeat(64),
      priorAssessments: [],
      findings: [],
    });
    const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["reviewer-payload"], "v3", payload);
    expect(admitted.kind).toBe("valid");
    if (admitted.kind === "valid") {
      expect(canonicalStructuralEquals(admitted.payload, payload)).toBe(true);
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

  it("admits every schema-conforming judge argument the frozen grammar admits — containment", () => {
    fc.assert(
      fc.property(
        proseArb,
        fc.array(
          fc.record({
            candidate: proseArb,
            score: fc.integer({ min: 0, max: 10 }),
            fatal_flaw: fc.option(proseArb, { nil: null }),
            strongest_idea: proseArb,
          }),
          { minLength: 1, maxLength: 4 },
        ),
        (criterion, rankings) => {
          const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["judge-verdict"], "v1", { criterion, rankings });
          return admitted.kind === "valid";
        },
      ),
    );
  });

  it("refuses schema-invalid arguments as never-ingestable with the parse's own code", () => {
    const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["judge-verdict"], "v1", {
      criterion: "extensibility",
      rankings: [{ candidate: "candidate-x.md", score: 11, fatal_flaw: null, strongest_idea: "out of the score domain" }],
    });
    expect(admitted.kind).toBe("refused");
    if (admitted.kind === "refused") {
      expect(admitted.code).toBe("invalid-schema");
      expect(admitted.message).toContain("frozen schema");
    }
  });

  it("refuses prose-brace payloads the sanitization strips to nothing", () => {
    const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["refutation-verdict"], "v1", {
      criterion: "reproduction",
      verdicts: [{ finding_id: "T1:x-1", verdict: "upheld", reasoning: " { } " }],
    });
    expect(admitted.kind).toBe("refused");
  });

  it("refuses arguments that cannot be serialized deterministically", () => {
    const circular: Record<string, unknown> = { criterion: "x" };
    circular["self"] = circular;
    const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["judge-verdict"], "v1", circular);
    expect(admitted.kind).toBe("refused");
    if (admitted.kind === "refused") expect(admitted.code).toBe("invalid-json");
  });

  it("refuses an unsupported schema version", () => {
    const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["judge-verdict"], "v2", {});
    expect(admitted.kind).toBe("refused");
    if (admitted.kind === "refused") {
      expect(admitted.code).toBe("unsupported-schema-version");
      expect(admitted.message).toContain("v2");
    }
  });

  it("refuses reviewer-payload arguments that do not conform to the issued v2 schema", () => {
    const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["reviewer-payload"], "v2", { arbitrary: "not a payload" });
    expect(admitted.kind).toBe("refused");
    if (admitted.kind === "refused") {
      expect(admitted.code).toBe("invalid-payload");
      expect(admitted.message).toContain("v2 schema");
    }
  });

  it("refuses arguments whose serialized bytes exceed the reviewer payload byte budget", () => {
    const admitted = admitEmissionArguments(EMISSION_TOOL_SPECS["reviewer-payload"], "v2", {
      schemaVersion: 2,
      kind: "standalone-review",
      findings: [],
      pad: "x".repeat(1_048_576),
    });
    expect(admitted.kind).toBe("refused");
    if (admitted.kind === "refused") {
      expect(admitted.code).toBe("payload-too-large");
    }
  });
});

describe("frozenPayloadSchemaParameters", () => {
  it("is the ONE constructor for every kind and version: parse once, re-serialize is identity", () => {
    for (const spec of Object.values(EMISSION_TOOL_SPECS)) {
      for (const schemaVersion of Object.values(spec.schemaVersions)) {
        const parameters = frozenPayloadSchemaParameters(schemaVersion.schemaBytes);
        expect(JSON.stringify(parameters, null, 2)).toBe(schemaVersion.schemaBytes);
      }
    }
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

/** Type-level: the refusal code is a member of the closed vocabulary, never a
 *  free string — an unknown code is unrepresentable behind every consumer that
 *  switches on it (parse, don't validate). */
const _refusedCodeIsClosed: (
  admission: Extract<EmissionArgumentAdmission, { kind: "refused" }>,
) => EmissionParseFailureCode = (admission) => admission.code;
void _refusedCodeIsClosed;
