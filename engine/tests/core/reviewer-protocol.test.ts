import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { z } from "zod/v4";
import { parseReviewerPayloadV2, renderReviewerWireContract } from "../../src/core/reviewer-protocol";
import {
  CURRENT_REVIEWER_PROTOCOL, REVIEWER_PAYLOAD_EXAMPLE_V2, REVIEWER_PAYLOAD_LIMITS,
  REVIEWER_PAYLOAD_SCHEMA_V2, REVIEWER_IMPACT_RUBRIC_V1, reviewerPayloadV2Schema,
  type FindingBasis, type ReviewerDraftV2, type ReviewerPayloadV2,
} from "../../src/core/reviewer-contract";
import { sha256Hex } from "../../src/core/review-packet";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (value: unknown) => parseReviewerPayloadV2(bytes(JSON.stringify(value)));
const standalone = (findings: readonly unknown[] = []) => ({ schemaVersion: 2, kind: "standalone-review", findings });
const advisory = { severity: "advisory", file: null, line: null, claim: "  none\n remains  ", reason: "A concise benefit." } as const;
const example = REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0];
if (example?.severity !== "critical") throw new Error("contract example must exercise the critical floor");
const critical = example;
const basis = critical.basis;
const wave = (findings: readonly unknown[] = []) => ({ schemaVersion: 2, kind: "wave-review", packetId: "a".repeat(64), generation: 0, prior_findings: [], findings });
function refused(raw: Uint8Array, code = "invalid-payload", path?: string): void {
  const result = parseReviewerPayloadV2(raw);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected whole-response refusal");
  expect(result.error.kind).toBe("reviewer-protocol-failed");
  expect(result.error.code).toBe(code);
  if (path !== undefined) expect(result.error.path).toBe(path);
  expect(bytes(result.error.message).length).toBeLessThanOrEqual(2_048);
  expect(result).not.toHaveProperty("value");
  expect(result.error).not.toHaveProperty("findings");
}
const refuseValue = (value: unknown, path?: string): void => refused(bytes(JSON.stringify(value)), "invalid-payload", path);
function deepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(deepFrozen);
}

const text = fc.array(fc.constantFrom("a", "é", "🧵", "\n", "\t", " ", "\\", '"', "|", "<", "\u202e"), { maxLength: 35 }).map((chars) => `x${chars.join("")}`);
const evidence = fc.oneof(
  fc.record({ kind: fc.constant("reproduction" as const), execution: fc.constantFrom("not-executed" as const, "reviewer-reported" as const), setup: text, input: text, observed: text, expected: text, reference: text }),
  fc.record({ kind: fc.constant("execution-trace" as const), preconditions: fc.tuple(text).map((entries): readonly [string] => entries), steps: fc.tuple(text).map((entries): readonly [string] => entries), observed: text, expected: text, reference: text }),
);
const validBasis: fc.Arbitrary<FindingBasis> = fc.record({
  evidence, violatedContract: fc.record({ reference: text, statement: text }),
  consequence: fc.record({ affected: text, preconditions: text, impact: text, evidenceLimits: text }),
  truthConfidence: fc.integer({ min: 0, max: 100 }), severityRationale: text,
});
const draft: fc.Arbitrary<ReviewerDraftV2> = fc.oneof(
  fc.record({ severity: fc.constant("critical" as const), file: fc.constant(null), line: fc.constant(null), claim: text, basis: validBasis }),
  fc.record({ severity: fc.constant("advisory" as const), file: fc.constant("src/a.ts"), line: fc.option(fc.integer({ min: 1, max: 100 }), { nil: null }), claim: text, reason: text }),
);

describe("current reviewer codec", () => {
  it("round-trips both kinds, exact strings, order, duplicate entries and immutable evidence", () => {
    fc.assert(fc.property(fc.array(draft, { maxLength: 8 }), fc.boolean(), (findings, isWave) => {
      const value = isWave ? wave([...findings, ...findings]) : standalone([...findings, ...findings]);
      const serialized = bytes(JSON.stringify(value));
      const original = serialized.slice();
      const result = parseReviewerPayloadV2(serialized);
      expect(result).toEqual({ ok: true, value });
      expect(serialized).toEqual(original);
      if (result.ok) {
        deepFrozen(result.value);
        expect(decode(result.value)).toEqual(result);
      }
    }), { seed: 4001, numRuns: 100 });
  });

  it("admits empty reports, concise advisories, complete optional basis and both evidence arms", () => {
    for (const value of [standalone(), wave(), standalone([advisory]), standalone([{ ...advisory, basis }]), REVIEWER_PAYLOAD_EXAMPLE_V2,
      standalone([{ ...critical, basis: { ...basis, evidence: { kind: "reproduction", execution: "not-executed", setup: "s", input: "i", observed: "predicted", expected: "e", reference: "r" } } }])]) {
      expect(decode(value)).toEqual({ ok: true, value });
    }
  });

  it("does not interpret confidence as severity or test semantic plausibility", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100 }), (truthConfidence) => {
      const value = standalone([{ ...critical, basis: { ...basis, truthConfidence, severityRationale: "x" } }]);
      expect(decode(value)).toEqual({ ok: true, value });
    }), { seed: 4002 });
  });

  it.each(["", " ", "{}{}", "before {\"x\":1,}", "{/*x*/}", '{"x":1,}', "[1,]", '{"x":01}', '{"x":+1}', '{"x":.1}', '{"x":1.}', '{"x":NaN}', '{"x":Infinity}', '{"x":"\n"}', '{"x":"\\x20"}'])
    ("requires strict native grammar, never JSONC repair: %j", (raw) => refused(bytes(raw), "invalid-json"));
  it.each(["```json\n{}\n```", "before {}", "{} after", "// comment\n{}", "\u00a0{}"])
    ("extracts a prose-wrapped candidate and still gates the issued schema: %j", (raw) => refused(bytes(raw), "invalid-payload"));

  it("extracts exactly one strict JSON object wrapped in prose or a code fence", () => {
    const payload = JSON.stringify(standalone([advisory]));
    for (const wrapped of [
      `Summary text.\n\n${payload}`,
      "```json\n" + payload + "\n```",
      `Summary.\n\n\`\`\`json\n${payload}\n\`\`\`\n`,
    ]) {
      expect(parseReviewerPayloadV2(bytes(wrapped))).toEqual({ ok: true, value: standalone([advisory]) });
    }
  });
  it("admits prose-wrapped payloads without mutating the original bytes", () => {
    const payload = JSON.stringify(standalone([advisory]));
    const wrapped = `Summary text.\n\n${payload}`;
    const original = bytes(wrapped).slice();
    expect(parseReviewerPayloadV2(bytes(wrapped))).toEqual({ ok: true, value: standalone([advisory]) });
    expect(bytes(wrapped)).toEqual(original);
  });
  it("fails closed on ambiguous output: two or more balanced, parseable objects", () => {
    const payload = JSON.stringify(standalone([advisory]));
    refused(bytes(payload + payload), "invalid-json");
    refused(bytes(`Summary.\n\n${payload}\n\nAlso.\n\n${payload}`), "invalid-json");
  });
  it("fails closed when prose braces steal the object start rather than guessing", () => {
    const payload = JSON.stringify(standalone([advisory]));
    refused(bytes("Your message begins with '{' as the very first character.\n\n" + payload), "invalid-json");
  });
  it("admits prose-wrapped payloads for arbitrary brace-free quote-free prose", () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom("a", "é", "🧵", "\n", "\t", " ", "\\", "|", "<", "\u202e"), { maxLength: 35 }),
      fc.array(draft, { maxLength: 4 }),
      (prose, findings) => {
        const payload = JSON.stringify(standalone(findings));
        const wrapped = prose.join("") + "\n" + payload;
        const original = bytes(wrapped).slice();
        const result = parseReviewerPayloadV2(bytes(wrapped));
        expect(result).toEqual({ ok: true, value: standalone(findings) });
        expect(bytes(wrapped)).toEqual(original);
      },
    ), { seed: 4010, numRuns: 100 });
  });

  it.each([null, [], 2, "x", {}, { schemaVersion: 2, kind: "standalone-review" }, { schemaVersion: 1, kind: "standalone-review", findings: [] }, { ...standalone(), kind: "unknown" }, { ...standalone(), criticalCount: 0 }, { ...standalone(), packetId: "a".repeat(64) }, { ...standalone(), protocolVersion: 2 }, { ...wave(), extra: 1 }])
    ("refuses wrong root, version, missing fields or authored extras: %j", (value) => refuseValue(value));

  it.each(["severity", "file", "line", "claim", "basis"])("requires critical %s", (key) => {
    refuseValue(standalone([Object.fromEntries(Object.entries(critical).filter(([field]) => field !== key))]));
  });
  it.each(["evidence", "violatedContract", "consequence", "truthConfidence", "severityRationale"])("requires complete basis.%s", (key) => {
    refuseValue(standalone([{ ...critical, basis: Object.fromEntries(Object.entries(basis).filter(([field]) => field !== key)) }]));
  });
  it("rejects unknown fields at every actual nested schema and null optional basis", () => {
    const nested = [
      { ...critical, extra: 1 }, { ...critical, reason: "not a critical key" },
      { ...critical, basis: { ...basis, extra: 1 } },
      { ...critical, basis: { ...basis, evidence: { ...basis.evidence, extra: 1 } } },
      { ...critical, basis: { ...basis, violatedContract: { ...basis.violatedContract, extra: 1 } } },
      { ...critical, basis: { ...basis, consequence: { ...basis.consequence, extra: 1 } } },
      { ...advisory, basis: null }, { ...advisory, basis: {} }, { ...advisory, reason: undefined },
      { ...critical, protocolVersion: 2 },
    ];
    nested.forEach((entry) => refuseValue(standalone([entry])));
    refuseValue({ ...wave(), prior_findings: [{ finding_id: "id", verdict: "still_present", reason: "r", extra: 1 }] });
  });

  it.each(["", " ", "\n\t", "a\0b", "\ud800", "\udfff", "x\ud800y", "\udfff\ud800"])("rejects invalid strings exactly: %j", (claim) => refuseValue(standalone([{ ...advisory, claim }]), "/findings/0/claim"));
  it.each(["/abs", "../a", "a/../b", "a//b", "./a", "a/", " a", "a ", "C:/a", "a\\b", "a\nb"])("refuses noncanonical file %j", (file) => refuseValue(standalone([{ ...advisory, file }])));
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses unsafe or nonpositive line %s", (line) => refuseValue(standalone([{ ...advisory, file: "src/a.ts", line }])));
  it("enforces null-location correlation and safe positive lines", () => {
    refuseValue(standalone([{ ...advisory, line: 1 }]), "/findings/0/line");
    expect(decode(standalone([{ ...advisory, file: "src/a.ts", line: Number.MAX_SAFE_INTEGER }])).ok).toBe(true);
  });
  it.each([-1, 100.1, 1e300])("refuses confidence outside its interval: %s", (truthConfidence) => refuseValue(standalone([{ ...critical, basis: { ...basis, truthConfidence } }])));
  it("refuses numeric overflow without arbitrary precision allocation", () => {
    refused(bytes(JSON.stringify(standalone([critical])).replace('"truthConfidence":80', '"truthConfidence":1e999')));
    refused(bytes(JSON.stringify(wave()).replace('"generation":0', '"generation":1e999')));
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("refuses unsafe generation: %s", (generation) => refuseValue({ ...wave(), generation }));
  it.each(["a", "A".repeat(64), "g".repeat(64)])("refuses noncanonical packet digest %s", (packetId) => refuseValue({ ...wave(), packetId }));

  it("enforces UTF-8 byte bounds, not code-unit counts", () => {
    const cases: readonly [number, (text: string) => unknown][] = [
      [4096, (claim) => standalone([{ ...advisory, claim }])],
      [4096, (reason) => standalone([{ ...advisory, reason }])],
      [4096, (severityRationale) => standalone([{ ...critical, basis: { ...basis, severityRationale } }])],
      [2048, (file) => standalone([{ ...advisory, file }])],
      [2048, (reference) => standalone([{ ...critical, basis: { ...basis, violatedContract: { ...basis.violatedContract, reference } } }])],
      [8192, (impact) => standalone([{ ...critical, basis: { ...basis, consequence: { ...basis.consequence, impact } } }])],
    ];
    for (const [limit, make] of cases) {
      for (const unit of ["a", "é", "🧵"]) {
        const exact = unit.repeat(limit / bytes(unit).length);
        expect(decode(make(exact)).ok).toBe(true);
        refuseValue(make(exact + "a"));
      }
    }
  });
  it("checks trace/list bounds at both edges", () => {
    for (const field of ["preconditions", "steps"]) {
      for (const count of [0, 1, 32, 33]) {
        const value = standalone([{ ...critical, basis: { ...basis, evidence: { ...basis.evidence, [field]: Array(count).fill("x") } } }]);
        expect(decode(value).ok).toBe(count === 1 || count === 32);
      }
    }
    expect(decode(standalone(Array(128).fill(advisory))).ok).toBe(true);
    refuseValue(standalone(Array(129).fill(advisory)));
    const prior = { finding_id: "id", verdict: "still_present", reason: "r" };
    expect(decode({ ...wave(), prior_findings: Array(4096).fill(prior) }).ok).toBe(true);
    refuseValue({ ...wave(), prior_findings: Array(4097).fill(prior) });
    expect(decode({ ...wave(), prior_findings: [{ ...prior, reason: "x".repeat(8192) }] }).ok).toBe(true);
    refuseValue({ ...wave(), prior_findings: [{ ...prior, reason: "x".repeat(8193) }] });
    // Roster order/uniqueness and frozen scope are the later issued ingress join, not this codec.
  });
  it("bounds bytes before decoding, and rejects BOM/fatal UTF-8", () => {
    const raw = JSON.stringify(standalone());
    expect(parseReviewerPayloadV2(bytes(raw.padEnd(REVIEWER_PAYLOAD_LIMITS.bytes))).ok).toBe(true);
    refused(bytes(raw.padEnd(REVIEWER_PAYLOAD_LIMITS.bytes + 1)), "payload-too-large");
    refused(new Uint8Array(REVIEWER_PAYLOAD_LIMITS.bytes + 1).fill(0xff), "payload-too-large");
    for (const bad of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf0, 0x9f]]) refused(Uint8Array.from(bad), "invalid-utf8");
    refused(bytes(`\ufeff${raw}`), "invalid-utf8");
  });
  it("checks nesting before grammar/visitor while respecting quoted escaped delimiters", () => {
    refused(bytes("[".repeat(33)), "depth-exceeded");
    refused(bytes("[".repeat(32) + "0" + "]".repeat(32)), "invalid-payload");
    refused(bytes("[".repeat(33) + "0" + "]".repeat(33)), "depth-exceeded");
    expect(decode(standalone([{ ...advisory, claim: '\\"' + "[{}]".repeat(500) }])).ok).toBe(true);
  });

  it.each([
    ['{"findings":[],"find\\u0069ngs":[]}', "/findings"],
    ['{"a":[{"b":{"x":1,"\\u0078":2}}]}', "/a/0/b/x"],
    ['{"a":[[{"x":1,"x":2}]]}', "/a/0/0/x"],
    ['{"a/b~c":{"\\u002f":1,"/":2}}', "/a~1b~0c/~1"],
    ['{"__proto__":1,"__proto__":2}', "/__proto__"],
    ['{"constructor":1,"constructor":2}', "/constructor"],
    ['{"toString":1,"toString":2}', "/toString"],
  ])("rejects decoded duplicates with exact per-object pointer: %s", (raw, path) => refused(bytes(raw), "duplicate-key", path));
  it("rejects differently escaped decoded keys at arbitrary nested array/object paths", () => {
    fc.assert(fc.property(text, fc.integer({ min: 0, max: 8 }), (key, depth) => {
      const plain = JSON.stringify(key);
      const escaped = '"' + key.split("").map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("") + '"';
      const raw = '{"outer":[ '.repeat(depth) + `{${plain}:1,${escaped}:2}` + ']}'.repeat(depth);
      const path = "/outer/0".repeat(depth) + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1");
      refused(bytes(raw), "duplicate-key", path);
    }), { seed: 4004, numRuns: 100 });
  });
  it("rejects prototype-shaped unknown keys rather than stripping them", () => {
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const raw = JSON.stringify(standalone([advisory]));
      refused(bytes(raw.replace('"schemaVersion":', `"${key}":{},"schemaVersion":`)));
      refused(bytes(raw.replace('"severity":', `"${key}":{},"severity":`)));
    }
  });
  it("does not confuse sibling/ancestor properties or prototype names with duplicates", () => {
    for (const raw of ['{"a":{"a":1},"b":{"a":2}}', '{"a":[{"x":1},{"x":2}]}', '{"__proto__":1,"constructor":2,"toString":3}']) refused(bytes(raw), "invalid-payload");
    expect({}).not.toHaveProperty("polluted");
  });
  it("finds duplicates at every schema object level before schema admission", () => {
    const payload = JSON.stringify(standalone([critical]));
    for (const key of ["schemaVersion", "severity", "evidence", "kind", "statement", "impact"]) {
      const match = new RegExp(`"${key}":`).exec(payload);
      if (match === null) throw new Error(`missing fixture key ${key}`);
      const altered = payload.slice(0, match.index) + `"${key}":null,` + payload.slice(match.index);
      refused(bytes(altered), "duplicate-key");
    }
  });
  it("reports first duplicate and UTF-8 byte offset without echoing input in the diagnostic", () => {
    const raw = '{"é":1,"é":2,"x":1,"x":2}';
    const result = parseReviewerPayloadV2(bytes(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.path).toBe("/é");
      expect(result.error.byteOffset).toBe(bytes('{"é":1,').length);
      expect(result.error.message).not.toContain(raw);
    }
  });
  it("never throws for arbitrary bounded byte input", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 2048 }), (raw) => {
      const result = parseReviewerPayloadV2(raw);
      expect(typeof result.ok).toBe("boolean");
      if (!result.ok) expect(bytes(result.error.message).length).toBeLessThanOrEqual(2048);
    }), { seed: 4003, numRuns: 200 });
  });
});

describe("authoritative generated wire contract", () => {
  it("reference reuse expands to the exact old executable schema and preserves admission", () => {
    const options = { target: "draft-2020-12", io: "output", unrepresentable: "throw", cycles: "throw" } as const;
    const inline = z.toJSONSchema(reviewerPayloadV2Schema, { ...options, reused: "inline" });
    const referenced = JSON.parse(REVIEWER_PAYLOAD_SCHEMA_V2);
    const expand = (raw: unknown): unknown => {
      if (Array.isArray(raw)) return raw.map(expand);
      if (typeof raw !== "object" || raw === null) return raw;
      const object = raw as Record<string, unknown>;
      const { $ref, $defs: _definitions, ...rest } = object;
      if (typeof $ref === "string") return expand({ ...referenced.$defs[$ref.replace("#/$defs/", "")], ...rest });
      return Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, expand(value)]));
    };
    expect(expand(referenced)).toEqual(inline);
    expect(bytes(JSON.stringify(inline, null, 2)).length).toBe(57099);
    expect(bytes(REVIEWER_PAYLOAD_SCHEMA_V2).length).toBe(10257);
    fc.assert(fc.property(fc.array(draft, { maxLength: 4 }), (findings) => {
      for (const value of [standalone(findings), wave(findings), { ...standalone(findings), extra: true },
        standalone([{ ...critical, basis: undefined }]), standalone([{ ...advisory, claim: " " }])]) {
        const executable = reviewerPayloadV2Schema.safeParse(value);
        const admitted = decode(value);
        expect(admitted.ok).toBe(executable.success);
        if (executable.success && admitted.ok) expect(admitted.value).toEqual(executable.data);
      }
    }), { seed: 4102, numRuns: 30 });
  });
  it("pins exact schema/rubric revisions and derives descriptor digests", () => {
    expect(sha256Hex(REVIEWER_PAYLOAD_SCHEMA_V2)).toBe("3ac3395301c1d38f41cd93accb19b942e832d7ebced990976335208259f40c37");
    expect(sha256Hex(REVIEWER_IMPACT_RUBRIC_V1)).toBe("4f36c09cc1e7c27e2d8ff36c86ad22c7723c1a4715bd9c198bbed40e2c2f3a6b");
    expect(new TextEncoder().encode(REVIEWER_PAYLOAD_SCHEMA_V2).byteLength).toBeLessThanOrEqual(12 * 1024);
    expect(CURRENT_REVIEWER_PROTOCOL.schemaDigest).toBe(sha256Hex(REVIEWER_PAYLOAD_SCHEMA_V2));
    expect(CURRENT_REVIEWER_PROTOCOL.rubricDigest).toBe(sha256Hex(REVIEWER_IMPACT_RUBRIC_V1));
    expect(REVIEWER_IMPACT_RUBRIC_V1.endsWith("\n")).toBe(true);
    expect(REVIEWER_IMPACT_RUBRIC_V1.endsWith("\n\n")).toBe(false);
  });
  it("renders the exact issued full schema, example and rubric, not a second contract", () => {
    const rendered = renderReviewerWireContract();
    const json = [...rendered.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    expect(json).toEqual([REVIEWER_PAYLOAD_SCHEMA_V2, JSON.stringify(REVIEWER_PAYLOAD_EXAMPLE_V2, null, 2)]);
    expect(parseReviewerPayloadV2(bytes(json[1]))).toEqual({ ok: true, value: REVIEWER_PAYLOAD_EXAMPLE_V2 });
    expect(rendered.endsWith(REVIEWER_IMPACT_RUBRIC_V1)).toBe(true);
    deepFrozen(REVIEWER_PAYLOAD_EXAMPLE_V2);
  });
  it("generates strict objects and explains byte/cross-field/issuance constraints", () => {
    const schema = JSON.parse(REVIEWER_PAYLOAD_SCHEMA_V2);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    function inspect(value: unknown): void {
      if (value === null || typeof value !== "object") return;
      if ("type" in value && value.type === "object") expect(value).toHaveProperty("additionalProperties", false);
      Object.values(value).forEach(inspect);
    }
    inspect(schema);
    for (const phrase of ["UTF-8 bytes", "null file requires a null line", "issued frozen scope", "packet order", '"maxItems": 32', '"maxItems": 128', '"maxItems": 4096']) expect(REVIEWER_PAYLOAD_SCHEMA_V2).toContain(phrase);
  });
});

// Compile-time contract: required basis/reason and readonly nested evidence, never optional bags.
function staticContract(payload: ReviewerPayloadV2): void {
  // @ts-expect-error immutable array
  payload.findings.push(advisory);
  const finding = payload.findings[0];
  if (finding?.severity === "critical") {
    const required: FindingBasis = finding.basis;
    // @ts-expect-error immutable nested basis
    required.truthConfidence = 2;
  }
  // @ts-expect-error critical cannot lack basis
  const invalid: ReviewerDraftV2 = { severity: "critical", file: null, line: null, claim: "x" };
  void invalid;
}
void staticContract;
