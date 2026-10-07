import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  acknowledgeEmissionExecution,
  admitIssuedEmissionArguments,
  canonicalizeEmissionWireArguments,
  EMISSION_CONSTRAINED_SAMPLING_REQUEST,
  EMISSION_TOOL_SPECS,
  emissionToolFamily,
  frozenPayloadSchemaParameters,
  issuedEmissionParameters,
  issueEmissionBinding,
  type EmissionArgumentAdmission,
  type EmissionParseFailureCode,
  type EmissionSchemaVersion,
  type EmissionToolSpec,
  type IssuedEmissionBinding,
} from "../../src/core/emission-tool";
import { producerKindsOfAgent, type PayloadProducerKindName } from "../../src/core/model-profiles";
import { REVIEWER_PAYLOAD_EXAMPLE_V2, REVIEWER_PAYLOAD_SCHEMA_V2 } from "../../src/core/reviewer-contract";
import { judgeVerdictV1Schema } from "../../src/core/panel-contract";
import { parseReviewerPayloadV2, parseStandaloneReviewerPayloadV3 } from "../../src/core/reviewer-protocol";
import {
  validJudgeArguments,
  validRefutationArguments,
  validReviewerArgumentsV3,
  whitespaceOnlyArguments,
} from "../fixtures/emission-arguments";
import { canonicalStructuralEquals } from "../../src/core/orchestration-contract/identity";

/** A binding for one registry cell, through the ONE mint. */
function mintedBinding<K extends PayloadProducerKindName>(kind: K, version: EmissionSchemaVersion) {
  const minted = issueEmissionBinding({ requestId: "request:emission-tool", kind, version });
  if (!minted.ok) throw new Error(`fixture binding refused: ${minted.error.code} — ${minted.error.message}`);
  return minted.value;
}

const REVIEWER_V2 = mintedBinding("reviewer-payload", "v2");
const REVIEWER_V3 = mintedBinding("reviewer-payload", "v3");
const JUDGE_V1 = mintedBinding("judge-verdict", "v1");
const REFUTATION_V1 = mintedBinding("refutation-verdict", "v1");

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

describe("admitIssuedEmissionArguments — the ONE admission under an issued binding", () => {
  it("admits valid reviewer-payload arguments through the same full parser the fallback uses", () => {
    const admitted = admitIssuedEmissionArguments(REVIEWER_V2, REVIEWER_PAYLOAD_EXAMPLE_V2);
    expect(admitted.kind).toBe("valid");
    if (admitted.kind === "valid") {
      expect(canonicalStructuralEquals(admitted.payload, REVIEWER_PAYLOAD_EXAMPLE_V2)).toBe(true);
    }
  });

  it("admits valid standalone-successor (v3) arguments through the registry's v3 parser", () => {
    const payload = validReviewerArgumentsV3();
    const admitted = admitIssuedEmissionArguments(REVIEWER_V3, payload);
    expect(admitted.kind).toBe("valid");
    if (admitted.kind === "valid") {
      expect(canonicalStructuralEquals(admitted.payload, payload)).toBe(true);
    }
  });

  it("admits valid judge-verdict arguments — shape, score domain, prose sanitization", () => {
    const admitted = admitIssuedEmissionArguments(JUDGE_V1, validJudgeArguments("extensibility"));
    expect(admitted.kind).toBe("valid");
  });

  it("admits valid refutation-verdict arguments", () => {
    const admitted = admitIssuedEmissionArguments(REFUTATION_V1, validRefutationArguments("reproduction"));
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
          const admitted = admitIssuedEmissionArguments(JUDGE_V1, { criterion, rankings });
          return admitted.kind === "valid";
        },
      ),
    );
  });

  it("refuses schema-invalid arguments as never-ingestable with the parse's own code", () => {
    const admitted = admitIssuedEmissionArguments(JUDGE_V1, {
      criterion: "extensibility",
      rankings: [{ candidate: "candidate-x.md", score: 11, fatal_flaw: null, strongest_idea: "out of the score domain" }],
    });
    expect(admitted.kind).toBe("refused");
    if (admitted.kind === "refused") {
      expect(admitted.code).toBe("invalid-schema");
      expect(admitted.message).toContain("frozen schema");
    }
  });

  it("names every fixable violation in ONE bounded refusal message — five named, overflow marked, deterministic", () => {
    // The verdict parser's one-message-names-all contract: a call with more
    // than five violations carries five named issues plus an explicit overflow
    // marker, so one re-emit within the bounded budget corrects them together
    // instead of spending a retry per issue. Built against the frozen schema's
    // own issue list, so the pin survives schema-message edits.
    const args = {
      criterion: "extensibility",
      rankings: Array.from({ length: 6 }, (_, index) => ({
        candidate: `candidate-${index}.md`,
        score: 11,
        fatal_flaw: null,
        strongest_idea: "out of the score domain",
      })),
    };
    const parsed = judgeVerdictV1Schema.safeParse(args);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issues = parsed.error.issues;
    expect(issues.length).toBeGreaterThan(5);

    const first = admitIssuedEmissionArguments(JUDGE_V1, args);
    const second = admitIssuedEmissionArguments(JUDGE_V1, args);
    expect(first.kind).toBe("refused");
    if (first.kind !== "refused") return;
    // Deterministic: structurally equal arguments refuse with the identical
    // message twice — the diagnostic the model re-emits against is stable.
    expect(second.kind).toBe("refused");
    if (second.kind !== "refused") return;
    expect(first.message).toBe(second.message);

    const overflow = `; (+${issues.length - 5} more)`;
    expect(first.message).toContain(overflow);
    const body = first.message.slice("emission arguments do not conform to the frozen schema: ".length);
    const named = body.slice(0, body.indexOf(overflow));
    expect(named).toBe(issues.slice(0, 5).map((issue) => issue.message).join("; "));
    for (const issue of issues.slice(0, 5)) expect(first.message).toContain(issue.message);
  });

  it("refuses prose-brace payloads the sanitization strips to nothing", () => {
    const admitted = admitIssuedEmissionArguments(REFUTATION_V1, {
      criterion: "reproduction",
      verdicts: [{ finding_id: "T1:x-1", verdict: "upheld", reasoning: " { } " }],
    });
    expect(admitted.kind).toBe("refused");
  });

  it("refuses arguments that cannot be serialized deterministically", () => {
    const circular: Record<string, unknown> = { criterion: "x" };
    circular["self"] = circular;
    const admitted = admitIssuedEmissionArguments(JUDGE_V1, circular);
    expect(admitted.kind).toBe("refused");
    if (admitted.kind === "refused") expect(admitted.code).toBe("invalid-json");
  });

  it("refuses an unsupported schema version at the mint, where it is reachable — no binding, no admission", () => {
    // The (kind, version) degradation is an issuance refusal: the mint is the
    // only producer of a binding, so admission never sees an unsupported cell.
    const minted = issueEmissionBinding({ requestId: "request:emission-tool", kind: "judge-verdict", version: "v2" });
    expect(minted.ok).toBe(false);
    if (!minted.ok) {
      expect(minted.error.code).toBe("unsupported-schema-version");
      expect(minted.error.message).toContain("v2");
    }
  });

  it("treats a binding forged past the mint as a broken invariant, never as refusable model input", () => {
    // Forging needs an explicit cast past the nominal brand; the one
    // binding→cell lookup then throws rather than inventing a refusal code.
    const forged = { ...JUDGE_V1, version: "v2" } as unknown as IssuedEmissionBinding;
    expect(() => admitIssuedEmissionArguments(forged, validJudgeArguments("extensibility"))).toThrow(/invariant failed/);
    expect(() => issuedEmissionParameters(forged)).toThrow(/invariant failed/);
  });

  it("registers exactly the binding cell's frozen parameters — the one lookup both shells read", () => {
    for (const binding of [REVIEWER_V2, REVIEWER_V3, JUDGE_V1, REFUTATION_V1]) {
      const spec: EmissionToolSpec = EMISSION_TOOL_SPECS[binding.kind.kind];
      const cell = spec.schemaVersions[binding.version];
      expect(issuedEmissionParameters(binding)).toEqual(frozenPayloadSchemaParameters(cell!.schemaBytes));
    }
  });

  it("refuses reviewer-payload arguments that do not conform to the issued v2 schema", () => {
    const admitted = admitIssuedEmissionArguments(REVIEWER_V2, { arbitrary: "not a payload" });
    expect(admitted.kind).toBe("refused");
    if (admitted.kind === "refused") {
      expect(admitted.code).toBe("invalid-payload");
      expect(admitted.message).toContain("v2 schema");
    }
  });

  it("refuses arguments whose serialized bytes exceed the reviewer payload byte budget", () => {
    const admitted = admitIssuedEmissionArguments(REVIEWER_V2, {
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

describe("whitespace-only schema-vs-parser disagreement (AD-5, engine half)", () => {
  /** Whitespace-only prose the frozen bytes' shape rules admit: JSON Schema
   *  expresses minLength only — the zod refinements (trim, NUL, surrogate,
   *  byte-budget) are unrepresentable in the emitted bytes and ride the
   *  emission edge's parse instead (AD-5's stated limit on the frozen
   *  schema's guarantees). The REAL pi validation half — these arguments
   *  passing `validateToolArguments` against the exact frozen bytes — is
   *  pinned by engine/tests/pi/emission-tool-runtime.test.ts. */
  const whitespacePerKind: readonly (readonly [PayloadProducerKindName, EmissionSchemaVersion])[] = [
    ["reviewer-payload", "v2"],
    ["judge-verdict", "v1"],
    ["refutation-verdict", "v1"],
  ];

  it("refuses whitespace-only advisory prose the frozen JSON Schema's shape rules admit", () => {
    for (const [kindName, version] of whitespacePerKind) {
      const admitted = admitIssuedEmissionArguments(mintedBinding(kindName, version), whitespaceOnlyArguments(kindName));
      expect(admitted.kind, `${kindName}/${version}`).toBe("refused");
    }
  });

  it("refuses with the parse's own vocabulary — reviewer through the fallback's parser, verdicts through the frozen schema", () => {
    const reviewer = admitIssuedEmissionArguments(REVIEWER_V2, whitespaceOnlyArguments("reviewer-payload"));
    expect(reviewer.kind).toBe("refused");
    if (reviewer.kind === "refused") expect(reviewer.code).toBe("invalid-payload");

    const judge = admitIssuedEmissionArguments(JUDGE_V1, whitespaceOnlyArguments("judge-verdict"));
    expect(judge.kind).toBe("refused");
    if (judge.kind === "refused") expect(judge.code).toBe("invalid-schema");

    const refutation = admitIssuedEmissionArguments(REFUTATION_V1, whitespaceOnlyArguments("refutation-verdict"));
    expect(refutation.kind).toBe("refused");
    if (refutation.kind === "refused") expect(refutation.code).toBe("invalid-schema");
  });

  it("never admits whitespace-only prose over arbitrary other-valid shapes (the gate is the parse, not a shape check)", () => {
    fc.assert(
      fc.property(fc.constantFrom(" ", "  \t ", "\n\r"), (whitespace) => {
        const judge = admitIssuedEmissionArguments(JUDGE_V1, {
          criterion: "extensibility",
          rankings: [{ candidate: "candidate-type-driven-fp.md", score: 8, fatal_flaw: null, strongest_idea: whitespace }],
        });
        return judge.kind === "refused";
      }),
    );
  });
});

describe("acknowledgeEmissionExecution — the FR-013 execute-shell decision", () => {
  const JUDGE_BINDING = mintedBinding("judge-verdict", "v1");
  const validJudgeArgs = validJudgeArguments("extensibility");

  it("acknowledges valid arguments with the minimal terminating result — never echoing the payload", () => {
    const outcome = acknowledgeEmissionExecution(JUDGE_BINDING, validJudgeArgs);
    expect(outcome.kind).toBe("acknowledged");
    if (outcome.kind === "acknowledged") {
      expect(outcome.acknowledgment.terminate).toBe(true);
      expect(outcome.acknowledgment.details).toEqual({});
      expect(outcome.acknowledgment.content).toEqual([{ type: "text", text: "payload acknowledged" }]);
      // Bounded and payload-blind: the acknowledgment carries no fragment of
      // the admitted payload (AD-3: no large payload echo).
      expect(JSON.stringify(outcome.acknowledgment)).not.toContain("frozen registry");
      expect(JSON.stringify(outcome.acknowledgment).length).toBeLessThan(200);
    }
  });

  it("carries the refusal the shell must THROW — the admission's own code and message, never a shell-invented string", () => {
    const args = { criterion: "extensibility", rankings: [{ candidate: "candidate-x.md", score: 11, fatal_flaw: null, strongest_idea: "out of domain" }] };
    const outcome = acknowledgeEmissionExecution(JUDGE_BINDING, args);
    const direct = admitIssuedEmissionArguments(JUDGE_BINDING, args);
    expect(outcome.kind).toBe("refused");
    expect(direct.kind).toBe("refused");
    if (outcome.kind === "refused" && direct.kind === "refused") {
      expect(outcome.code).toBe(direct.code);
      expect(outcome.message).toBe(direct.message);
    }
  });

  it("refuses whitespace-only prose the harness validator admits — the shell is engine-authoritative", () => {
    const outcome = acknowledgeEmissionExecution(JUDGE_BINDING, whitespaceOnlyArguments("judge-verdict"));
    expect(outcome).toMatchObject({ kind: "refused", code: "invalid-schema" });
  });

  it("is frozen at every arm — a caller-side push cannot widen the outcome behind the shell", () => {
    const acknowledged = acknowledgeEmissionExecution(JUDGE_BINDING, validJudgeArgs);
    expect(Object.isFrozen(acknowledged)).toBe(true);
    if (acknowledged.kind === "acknowledged") {
      expect(Object.isFrozen(acknowledged.acknowledgment)).toBe(true);
      expect(Object.isFrozen(acknowledged.acknowledgment.content)).toBe(true);
      expect(Object.isFrozen(acknowledged.acknowledgment.content[0])).toBe(true);
    }
    const refused = acknowledgeEmissionExecution(JUDGE_BINDING, { criterion: "x", rankings: [] });
    expect(Object.isFrozen(refused)).toBe(true);
  });
});

describe("EMISSION_CONSTRAINED_SAMPLING_REQUEST — the FR-002/INV-1 request vocabulary", () => {
  it("requests JSON-schema constrained sampling with strict PREFERRED — never required", () => {
    expect(EMISSION_CONSTRAINED_SAMPLING_REQUEST).toEqual({ type: "json_schema", strict: "prefer" });
    expect(Object.isFrozen(EMISSION_CONSTRAINED_SAMPLING_REQUEST)).toBe(true);
  });

  it("is ONE request vocabulary for every emission tool — the registry's specs carry no separate request", () => {
    // The module constant is the only request; every registry spec and
    // version cell carries exactly its declared fields, so a per-tool
    // sampling request (or any other field) added to a cell fails here.
    for (const [kindName, spec] of Object.entries(EMISSION_TOOL_SPECS)) {
      expect(Object.keys(spec).sort(), kindName).toEqual(["schemaVersions", "toolName"]);
      for (const [version, schemaVersion] of Object.entries(spec.schemaVersions)) {
        expect(Object.keys(schemaVersion).sort(), `${kindName}/${version}`).toEqual(["parsePayload", "schemaBytes"]);
      }
    }
  });
});

/** Type-level: the refusal code is a member of the closed vocabulary, never a
 *  free string — an unknown code is unrepresentable behind every consumer that
 *  switches on it (parse, don't validate). */
const _refusedCodeIsClosed: (
  admission: Extract<EmissionArgumentAdmission, { kind: "refused" }>,
) => EmissionParseFailureCode = (admission) => admission.code;
void _refusedCodeIsClosed;

describe("canonicalizeEmissionWireArguments — the emission edge's wire-form canonicalization", () => {
  const v2Schema = frozenPayloadSchemaParameters(REVIEWER_PAYLOAD_SCHEMA_V2);
  /** The EXACT wire shape the wave-gate reviewer children produced on the
   *  unconstrained local route: every declared non-string field serialized as
   *  a JSON-encoded string, payload content otherwise conforming. */
  const stringifiedFinding = REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!;
  const recordedWireForm = {
    schemaVersion: "2",
    kind: "standalone-review" as const,
    findings: JSON.stringify([stringifiedFinding]),
  };
  /** The wave-review variant the actual children emitted, same string-typed
   *  class — exercising the oneOf's second branch and its $ref'd fields. */
  const recordedWaveWireForm = {
    schemaVersion: "2",
    kind: "wave-review" as const,
    packetId: "3f".repeat(32),
    generation: "0",
    prior_findings: "[]",
    findings: JSON.stringify([stringifiedFinding]),
  };

  it("canonicalizes the recorded string-typed wire form into a payload the registry's parser admits", () => {
    const canonical = canonicalizeEmissionWireArguments(v2Schema, recordedWireForm);
    expect(canonical).toEqual({
      schemaVersion: 2,
      kind: "standalone-review",
      findings: [stringifiedFinding],
    });
    const admitted = admitIssuedEmissionArguments(REVIEWER_V2, canonical);
    expect(admitted.kind).toBe("valid");
  });

  it("canonicalizes the wave-review variant — oneOf branch and $ref'd prior_findings/findings walk", () => {
    const canonical = canonicalizeEmissionWireArguments(v2Schema, recordedWaveWireForm);
    expect(canonical).toEqual({
      schemaVersion: 2,
      kind: "wave-review",
      packetId: "3f".repeat(32),
      generation: 0,
      prior_findings: [],
      findings: [stringifiedFinding],
    });
    expect(admitIssuedEmissionArguments(REVIEWER_V2, canonical).kind).toBe("valid");
  });

  it("is idempotent and preserves unchanged subtrees — canonical arguments canonicalize to THEMSELVES", () => {
    // The identity the pi agent loop short-circuits on: an already-canonical
    // payload returns the SAME reference, so the loop validates it directly.
    expect(canonicalizeEmissionWireArguments(v2Schema, REVIEWER_PAYLOAD_EXAMPLE_V2)).toBe(REVIEWER_PAYLOAD_EXAMPLE_V2);
    const once = canonicalizeEmissionWireArguments(v2Schema, recordedWireForm);
    const twice = canonicalizeEmissionWireArguments(v2Schema, once);
    expect(canonicalStructuralEquals(once, twice)).toBe(true);
    const waveOnce = canonicalizeEmissionWireArguments(v2Schema, recordedWaveWireForm) as {
      findings: readonly unknown[];
    };
    const waveTwice = canonicalizeEmissionWireArguments(v2Schema, waveOnce) as {
      findings: readonly unknown[];
    };
    expect(waveTwice.findings).toBe(waveOnce.findings);
  });

  it("leaves wire forms no declared type can accept UNCHANGED — the canonicalization never invents or defaults", () => {
    const unparseable = {
      schemaVersion: "two",
      kind: "standalone-review" as const,
      findings: "not json",
    };
    const result = canonicalizeEmissionWireArguments(v2Schema, unparseable);
    expect(result).toBe(unparseable);
    // The unchanged form still refuses through the registry's parser — the
    // gate is untouched by the transport parse.
    const admitted = admitIssuedEmissionArguments(REVIEWER_V2, result);
    expect(admitted.kind).toBe("refused");
    if (admitted.kind === "refused") expect(admitted.code).toBe("invalid-payload");
  });

  it("parses declared type unions and never converts toward the string member", () => {
    const unionSchema = {
      type: "object",
      properties: {
        line: { type: ["integer", "null"] },
        flag: { type: ["boolean", "null"] },
        label: { type: "string" },
      },
      additionalProperties: false,
    };
    expect(canonicalizeEmissionWireArguments(unionSchema, { line: "3", flag: "true", label: "keep" })).toEqual({
      line: 3,
      flag: true,
      label: "keep",
    });
    expect(canonicalizeEmissionWireArguments(unionSchema, { line: "null", flag: "null" })).toEqual({
      line: null,
      flag: null,
    });
    // A string stays a string at a string-typed position; an unparseable
    // string stays verbatim at every position.
    expect(canonicalizeEmissionWireArguments(unionSchema, { label: "3" })).toEqual({ label: "3" });
    expect(canonicalizeEmissionWireArguments(unionSchema, { line: "3.5", flag: "yes" })).toEqual({
      line: "3.5",
      flag: "yes",
    });
  });

  it("either parses a declared-integer position to a finite integer or leaves the string verbatim — never throws (property)", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (raw, other) => {
        const schema = { type: "object", properties: { generation: { type: "integer" } } };
        const result = canonicalizeEmissionWireArguments(schema, { generation: raw, other }) as {
          generation: unknown;
        };
        const generation = result.generation;
        if (typeof generation === "string") {
          expect(generation).toBe(raw);
        } else {
          expect(Number.isFinite(generation)).toBe(true);
          expect(Number.isInteger(generation)).toBe(true);
        }
      }),
    );
  });

  it("never mutates its inputs — the canonical form is a fresh structure sharing unchanged subtrees", () => {
    const frozen = Object.freeze({
      schemaVersion: "2",
      kind: "standalone-review",
      findings: Object.freeze([Object.freeze({ ...stringifiedFinding })]),
    });
    const canonical = canonicalizeEmissionWireArguments(v2Schema, frozen) as {
      schemaVersion: unknown;
      findings: readonly unknown[];
    };
    expect(canonical.schemaVersion).toBe(2);
    expect(Array.isArray(canonical.findings)).toBe(true);
    expect(admitIssuedEmissionArguments(REVIEWER_V2, canonical).kind).toBe("valid");
  });

  it("passes through verbatim for non-object schemas, primitive arguments, and unknown shapes", () => {
    const args = { a: 1 };
    expect(canonicalizeEmissionWireArguments(undefined, args)).toBe(args);
    expect(canonicalizeEmissionWireArguments("not a schema", args)).toBe(args);
    expect(canonicalizeEmissionWireArguments(42, args)).toBe(args);
    expect(canonicalizeEmissionWireArguments(v2Schema, 5)).toBe(5);
    expect(canonicalizeEmissionWireArguments(v2Schema, "raw")).toBe("raw");
    expect(canonicalizeEmissionWireArguments(v2Schema, null)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// The ONE admission — the execute shell and the engine's selection admit
// untrusted arguments through the same function, so they cannot disagree
// ---------------------------------------------------------------------------

describe("the execute shell and the engine selection share ONE admission", () => {
  it("decides the recorded string-typed wire form and its canonical form identically in the shell and the selection", () => {
    const binding = mintedBinding("reviewer-payload", "v2");
    // The recorded transport class the unconstrained route produces: a
    // string-typed schemaVersion and the findings array serialized as one
    // JSON string — exactly what the transcript observes. Pi's
    // prepareArguments canonicalizes it before pi validates; the shell's
    // admission canonicalizes again (idempotently), exactly as the engine's
    // selection does over the observed call, so whichever surface sees the
    // wire form, the decision is the same.
    const wire = {
      schemaVersion: "2",
      kind: "standalone-review",
      findings: JSON.stringify([{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim: "real claim" }]),
    };
    const canonical = canonicalizeEmissionWireArguments(
      frozenPayloadSchemaParameters(EMISSION_TOOL_SPECS["reviewer-payload"].schemaVersions["v2"]!.schemaBytes),
      wire,
    );
    const acknowledged = {
      kind: "acknowledged",
      acknowledgment: { content: [{ type: "text", text: "payload acknowledged" }], details: {}, terminate: true },
    };
    expect(acknowledgeEmissionExecution(binding, wire)).toEqual(acknowledged);
    expect(acknowledgeEmissionExecution(binding, canonical)).toEqual(acknowledged);
    expect(admitIssuedEmissionArguments(binding, wire)).toEqual(admitIssuedEmissionArguments(binding, canonical));

    // Canonicalization never rescues a genuinely non-conforming form: a
    // string that no declared non-string type accepts is refused by the same
    // frozen-bytes parse in both shells.
    const nonConforming = { ...wire, findings: "not json" };
    expect(acknowledgeEmissionExecution(binding, nonConforming).kind).toBe("refused");
    expect(admitIssuedEmissionArguments(binding, nonConforming).kind).toBe("refused");
  });
});

/** Type-level INV-1: the request vocabulary's strict member is the "prefer"
 *  literal — a required request is unrepresentable behind the type, and the
 *  behavioral resolver crossing lives in the real-Pi suite. */
const _strictIsPreferLiteral: "prefer" = EMISSION_CONSTRAINED_SAMPLING_REQUEST.strict;
void _strictIsPreferLiteral;

describe("emissionToolFamily — the registry-projected family of a tool name (FR-014)", () => {
  it("maps every frozen registry tool name to its producer kind", () => {
    expect(emissionToolFamily("loom_emit_reviewer_payload")).toEqual({ kind: "registered", producerKind: "reviewer-payload" });
    expect(emissionToolFamily("loom_emit_judge_verdict")).toEqual({ kind: "registered", producerKind: "judge-verdict" });
    expect(emissionToolFamily("loom_emit_refutation_verdict")).toEqual({ kind: "registered", producerKind: "refutation-verdict" });
  });

  it("prefix-reserved names outside the registry are observed-but-unbindable, never unrelated", () => {
    expect(emissionToolFamily("loom_emit_gibberish")).toEqual({ kind: "unregistered-emission-name" });
  });

  it("everything else is unrelated — including non-string names", () => {
    expect(emissionToolFamily("bash")).toEqual({ kind: "unrelated" });
    expect(emissionToolFamily("loom")).toEqual({ kind: "unrelated" });
    expect(emissionToolFamily(undefined)).toEqual({ kind: "unrelated" });
    expect(emissionToolFamily(42)).toEqual({ kind: "unrelated" });
  });
});
