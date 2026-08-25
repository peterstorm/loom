import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  TASK_BYTE_SCOPE_CHECK_ID_TEXT,
  canonicalArtifactBaselineDigest,
  createImplementationAttemptAuthority,
  createTaskCompletionSuiteAuthority,
  evaluateTaskCompletionSuite,
  parseArtifactBaselineDigest,
  parseCanonicalArtifactBaseline,
  parseGitSha,
  parseImplementationAttemptAuthority,
  parseImplementationAttemptHistory,
  parseImplementationAttemptSettlementReceipt,
  parseImplementationAuthorityDigest,
  parseImplementationObservation,
  parseIsoInstant,
  parseReservationId,
  parseSemanticAttempt,
  parseTaskCompletionSuiteAuthority,
  parseTaskCompletionSuiteResult,
  parseTaskId,
  parseWave,
  settleImplementationAttempt,
  type ImplementationAttemptAuthority,
  type ImplementationAttemptSettlementReceipt,
  type TaskCompletionSuiteAuthority,
} from "../../src/core/implementation-completion";
import {
  CLAUDE_CONTENT_BLOCK_TYPES,
  parseCompleteClaudeJsonl,
} from "../../src/core/claude-transcript-integrity";
import {
  PI_STRUCTURED_EVIDENCE_POLICY,
  TRUSTED_LEDGER_ONLY_POLICY,
  derivePendingTaskProof,
  evaluateProofObligations,
} from "../../src/core/proof-obligations";

const baseline = (entries: readonly [string, string | null][]) => entries.map(([artifact, digest]) => ({
  artifact,
  snapshot: digest === null ? { kind: "missing" } : { kind: "sha256", digest },
}));

const taskBaseline = baseline([
  ["engine/src/a.ts", "a".repeat(64)],
  ["engine/tests/a.test.ts", null],
]);
const dirtyBaseline = baseline([
  ["README.md", "b".repeat(64)],
  ["engine/src/a.ts", "a".repeat(64)],
]);

function valueOf<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error("fixture parse failed");
  return result.value;
}

function authority(
  semanticAttempt: 1 | 2 = 1,
  reservationId = `reservation-${semanticAttempt}`,
): ImplementationAttemptAuthority {
  return valueOf(createImplementationAttemptAuthority({
    taskId: "T1",
    wave: 2,
    semanticAttempt,
    reservationId,
    headSha: "c".repeat(40),
    reservedAt: `2026-08-23T00:00:0${semanticAttempt}.000Z`,
    taskScopeBaseline: taskBaseline,
    dirtySetBaseline: dirtyBaseline,
  }));
}

function suiteAuthority(attempt: ImplementationAttemptAuthority): TaskCompletionSuiteAuthority {
  return valueOf(createTaskCompletionSuiteAuthority(attempt));
}

function suiteResult(
  attempt: ImplementationAttemptAuthority,
  checks?: readonly unknown[],
): Record<string, unknown> {
  const suite = suiteAuthority(attempt);
  return {
    schemaVersion: 1,
    kind: "task-completion-suite-result",
    implementationAuthorityDigest: suite.implementationAuthorityDigest,
    suiteDigest: suite.suiteDigest,
    checks: checks ?? [{
      checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT,
      scope: "task",
      outcome: { kind: "accepted", changedPaths: ["engine/src/a.ts", "engine/tests/a.test.ts"] },
    }],
  };
}

const authoredProof = () => derivePendingTaskProof({
  newTestsRequired: true,
  declaredArtifacts: ["engine/src/a.ts", "engine/tests/a.test.ts"],
});

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "implementation-observed",
    observedAt: "2026-08-23T00:01:00.000Z",
    evidence: {
      taskCompleted: true,
      testResult: { verdict: "trusted-pass" },
      filesModified: ["engine/src/a.ts", "engine/tests/a.test.ts"],
      newTestsWritten: true,
      newTestEvidence: "vitest: pass",
    },
    proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
    ...overrides,
  };
}

function task(
  attempt: ImplementationAttemptAuthority,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "T1",
    status: "pending" as const,
    proof: authoredProof(),
    active_implementation_attempt: attempt,
    implementation_attempt_history: [],
    ...overrides,
  };
}

function settledValue(result: ReturnType<typeof settleImplementationAttempt>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function acceptedTransition(attempt = authority()) {
  return settledValue(settleImplementationAttempt(
    task(attempt),
    attempt,
    attempt,
    observation(),
    suiteResult(attempt),
  ));
}

function deepFrozen(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return true;
  return Object.isFrozen(raw) && Object.values(raw).every(deepFrozen);
}

const parsers = [
  parseTaskId,
  parseWave,
  parseSemanticAttempt,
  parseReservationId,
  parseGitSha,
  parseIsoInstant,
  parseArtifactBaselineDigest,
  parseImplementationAuthorityDigest,
  parseCanonicalArtifactBaseline,
  canonicalArtifactBaselineDigest,
  parseImplementationAttemptAuthority,
  parseTaskCompletionSuiteAuthority,
  parseTaskCompletionSuiteResult,
  parseImplementationObservation,
  parseImplementationAttemptSettlementReceipt,
  parseImplementationAttemptHistory,
] as const;

describe("implementation completion exact parsers", () => {
  it("parses real modern Claude record variants and preserves forward-compatible surplus fields", () => {
    const valid = readFileSync(new URL("../fixtures/claude-modern-transcript.jsonl", import.meta.url), "utf8");
    const complete = parseCompleteClaudeJsonl(valid);
    expect(complete.kind).toBe("complete");
    if (complete.kind !== "complete") return;
    expect(complete.transcript).toBe(valid);
    expect(complete.records).toHaveLength(7);
    expect(complete.records[0]).toMatchObject({
      type: "system",
      forward_compatible: { protocol: 2 },
    });
    expect(complete.records[2]).toMatchObject({ type: "assistant" });
    const message = complete.records[2]?.message as { content?: readonly unknown[] } | undefined;
    expect(message?.content?.[0]).toMatchObject({ future_block_field: 1 });
    const nestedResult = complete.records[4]?.message as { content?: readonly { content?: readonly unknown[] }[] } | undefined;
    expect(nestedResult?.content?.[0]?.content?.[0]).toMatchObject({
      type: "tool_reference",
      tool_name: "Bash",
      future_reference_field: true,
    });
    expect(nestedResult?.content?.[0]?.content?.[1]).toMatchObject({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: expect.stringMatching(/^iVBOR/),
      },
      future_image_field: "retained",
    });
  });

  it.each([
    ["empty transcript", "", "at least one supported record", null],
    ["blank transcript", "\n\n", "at least one supported record", null],
    ["empty object", "{}", "type", 1],
    ["null", "null", "plain object", 1],
    ["scalar", "42", "plain object", 1],
    ["array", "[]", "plain object", 1],
    ["missing message role", '{"type":"user","message":{"content":"hello"}}', "role", 1],
    ["non-string message role", '{"type":"user","message":{"role":1,"content":"hello"}}', "role", 1],
    ["unsupported message content", '{"type":"user","message":{"role":"user","content":null}}', "string or an array", 1],
    ["non-object block", '{"type":"user","message":{"role":"user","content":["hello"]}}', "plain object", 1],
    ["missing block type", '{"type":"assistant","message":{"role":"assistant","content":[{}]}}', "type", 1],
    ["malformed text block", '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":7}]}}', "text", 1],
    ["malformed tool-use block", '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool-1","name":"Bash","input":[]}]}}', "input", 1],
    ["malformed tool-result block", '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":null}]}}', "content", 1],
    ["malformed tool-reference block", '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":[{"type":"tool_reference","tool_name":"   "}]}]}}', "tool_name", 1],
    ["image without source", '{"type":"user","message":{"role":"user","content":[{"type":"image"}]}}', "source must be a plain object", 1],
    ["image with URL source", '{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"url","media_type":"image/png","data":"https://example.test/x.png"}}]}}', "type must equal base64", 1],
    ["image with unsupported media type", '{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/svg+xml","data":"PHN2Zz4="}}]}}', "media_type", 1],
    ["image with empty data", '{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":""}}]}}', "data must be a non-empty string", 1],
    ["image with surplus source field", '{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA==","url":"https://example.test"}}]}}', "exactly type, media_type, and data", 1],
    ["unknown block discriminant", '{"type":"assistant","message":{"role":"assistant","content":[{"type":"future_block","text":"no"}]}}', "must be one of", 1],
    ["misspelled block discriminant", '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_uses","id":"tool-1","name":"Bash","input":{}}]}}', "must be one of", 1],
    ["malformed fallback block", '{"type":"assistant","message":{"role":"assistant","content":[{"type":"fallback","from":{"model":""},"to":{"model":"claude"}}]}}', "model", 1],
  ] as const)("rejects the %s record through the bounded schema", (_name, line, expectedReason, expectedLine) => {
    const parsed = parseCompleteClaudeJsonl(`${line}\n`);
    expect(parsed).toMatchObject({ kind: "malformed", line: expectedLine, reason: expect.stringContaining(expectedReason) });
    expect(parsed).not.toHaveProperty("transcript");
  });

  it("accepts every explicit supported arm with surplus fields", () => {
    const blocks = [
      { type: "text", text: "done", future: true },
      { type: "thinking", thinking: "work", signature: "sig", future: true },
      { type: "tool_use", id: "tool-1", name: "Bash", input: {}, future: true },
      { type: "server_tool_use", id: "server-1", name: "search", input: {}, future: true },
      { type: "tool_result", tool_use_id: "tool-1", content: "pass", is_error: false, future: true },
      { type: "tool_reference", tool_name: "Bash", future: true },
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "UklGRg==" }, future: true },
      { type: "fallback", from: { model: "claude-fable", future: true }, to: { model: "claude-opus" }, future: true },
    ];
    expect(blocks.map(({ type }) => type)).toEqual(CLAUDE_CONTENT_BLOCK_TYPES);
    for (const block of blocks) {
      expect(parseCompleteClaudeJsonl(JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [block], future_message_field: true },
        future_record_field: true,
      }) + "\n").kind).toBe("complete");
    }
  });

  it("property: every unsupported nonblank block discriminant fails closed", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 40 })
        .filter((type) => type.trim() !== "" && !(CLAUDE_CONTENT_BLOCK_TYPES as readonly string[]).includes(type)),
      (type) => {
        const parsed = parseCompleteClaudeJsonl(JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type, text: "plausible" }] },
        }));
        expect(parsed.kind).toBe("malformed");
        expect(parsed).not.toHaveProperty("transcript");
      },
    ), { numRuns: 500 });
  });

  it("rejects a syntactically malformed tail without exposing partial transcript authority", () => {
    const valid = '{"type":"user"}\n\n{"type":"assistant"}\n';
    const malformed = parseCompleteClaudeJsonl(`${valid}{"type":"assistant"`);
    expect(malformed).toMatchObject({
      kind: "malformed",
      line: 4,
      reason: expect.stringContaining("malformed or truncated"),
    });
    expect(malformed).not.toHaveProperty("transcript");
  });

  it("is total over unknown Claude transcript inputs and arbitrary strings", () => {
    fc.assert(fc.property(fc.anything({ maxDepth: 5 }), (raw) => {
      expect(() => parseCompleteClaudeJsonl(raw)).not.toThrow();
      expect(["complete", "malformed"]).toContain(parseCompleteClaudeJsonl(raw).kind);
    }), { numRuns: 500 });
    fc.assert(fc.property(fc.string(), (raw) => {
      expect(() => parseCompleteClaudeJsonl(raw)).not.toThrow();
    }), { numRuns: 500 });
  });

  it("are total over arbitrary unknown input", () => {
    fc.assert(fc.property(fc.anything({ maxDepth: 5 }), (raw) => {
      parsers.forEach((parser) => {
        expect(() => parser(raw)).not.toThrow();
        expect(typeof parser(raw).ok).toBe("boolean");
      });
    }), { numRuns: 500 });
  });

  it("uses exact branded primitive grammars", () => {
    expect(parseTaskId("T42").ok).toBe(true);
    expect(parseTaskId("task-42").ok).toBe(false);
    expect(parseWave(1).ok).toBe(true);
    expect(parseWave(0).ok).toBe(false);
    expect(parseSemanticAttempt(1).ok).toBe(true);
    expect(parseSemanticAttempt(3).ok).toBe(false);
    expect(parseReservationId("reservation:1").ok).toBe(true);
    expect(parseReservationId("../reservation").ok).toBe(false);
    expect(parseGitSha("a".repeat(40)).ok).toBe(true);
    expect(parseGitSha("A".repeat(40)).ok).toBe(false);
    expect(parseIsoInstant("2026-08-23T00:00:00.000Z").ok).toBe(true);
    expect(parseIsoInstant("2026-08-23T00:00:00Z").ok).toBe(false);
  });

  it("rejects surplus keys at every authority, suite, observation, outcome, and receipt arm", () => {
    const attempt = authority();
    const suite = suiteAuthority(attempt);
    const transition = acceptedTransition(attempt);
    if (transition.kind !== "implemented") throw new Error("fixture must implement");
    const cases = [
      parseImplementationAttemptAuthority({ ...attempt, surplus: true }),
      parseTaskCompletionSuiteAuthority({ ...suite, surplus: true }),
      parseTaskCompletionSuiteAuthority({
        ...suite,
        checks: [{ ...suite.checks[0], surplus: true }],
      }),
      parseTaskCompletionSuiteResult({ ...suiteResult(attempt), surplus: true }),
      parseTaskCompletionSuiteResult({
        ...suiteResult(attempt),
        checks: [{
          checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT,
          scope: "task",
          outcome: { kind: "accepted", changedPaths: [], surplus: true },
        }],
      }),
      parseImplementationObservation({ ...observation(), surplus: true }),
      parseImplementationObservation({
        schemaVersion: 1,
        kind: "implementation-observation-unavailable",
        observedAt: "2026-08-23T00:01:00.000Z",
        failure: { kind: "observation-unavailable", message: "read failed", surplus: true },
      }),
      parseImplementationAttemptSettlementReceipt({ ...transition.receipt, surplus: true }),
      parseCanonicalArtifactBaseline([{
        ...taskBaseline[0],
        surplus: true,
      }]),
      parseCanonicalArtifactBaseline([{
        artifact: "engine/src/a.ts",
        snapshot: { kind: "missing", surplus: true },
      }]),
    ];
    cases.forEach((parsed) => expect(parsed.ok).toBe(false));
  });

  it("round-trips canonical authority, suite, result, observation, receipt, and history immutably", () => {
    const attempt = authority();
    const suite = suiteAuthority(attempt);
    const result = valueOf(parseTaskCompletionSuiteResult(suiteResult(attempt)));
    const observed = valueOf(parseImplementationObservation(observation()));
    const transition = acceptedTransition(attempt);
    if (transition.kind !== "implemented") throw new Error("fixture must implement");
    const valuesAndParsers = [
      [attempt, parseImplementationAttemptAuthority],
      [suite, parseTaskCompletionSuiteAuthority],
      [result, parseTaskCompletionSuiteResult],
      [observed, parseImplementationObservation],
      [transition.receipt, parseImplementationAttemptSettlementReceipt],
      [[transition.receipt], parseImplementationAttemptHistory],
    ] as const;
    valuesAndParsers.forEach(([value, parser]) => {
      const parsed = parser(JSON.parse(JSON.stringify(value)));
      expect(parsed).toEqual({ ok: true, value });
      expect(parsed.ok && deepFrozen(parsed.value)).toBe(true);
    });
  });
});

describe("canonical baseline and self-digest policy", () => {
  it("treats baseline arrays as unordered path-keyed sets", () => {
    fc.assert(fc.property(fc.boolean(), (reverse) => {
      const input = reverse ? [...taskBaseline].reverse() : taskBaseline;
      expect(valueOf(canonicalArtifactBaselineDigest(input)))
        .toBe(valueOf(canonicalArtifactBaselineDigest(taskBaseline)));
      expect(valueOf(parseCanonicalArtifactBaseline(input)).map((entry) => entry.artifact))
        .toEqual(["engine/src/a.ts", "engine/tests/a.test.ts"]);
    }));
  });

  it("changes baseline digest with path, missing/present state, or bytes and rejects duplicates", () => {
    const original = valueOf(canonicalArtifactBaselineDigest(taskBaseline));
    const mutations = [
      baseline([["engine/src/renamed.ts", "a".repeat(64)], ["engine/tests/a.test.ts", null]]),
      baseline([["engine/src/a.ts", null], ["engine/tests/a.test.ts", null]]),
      baseline([["engine/src/a.ts", "d".repeat(64)], ["engine/tests/a.test.ts", null]]),
    ];
    mutations.forEach((mutation) => expect(valueOf(canonicalArtifactBaselineDigest(mutation))).not.toBe(original));
    expect(parseCanonicalArtifactBaseline([taskBaseline[0], taskBaseline[0]]).ok).toBe(false);
  });

  it("rejects authority and receipt self-digest tampering", () => {
    const attempt = authority();
    for (const mutation of [
      { ...attempt, reservationId: "tampered" },
      { ...attempt, semanticAttempt: 2 },
      { ...attempt, taskScopeBaselineDigest: "d".repeat(64) },
      { ...attempt, authorityDigest: "e".repeat(64) },
    ]) expect(parseImplementationAttemptAuthority(mutation).ok).toBe(false);

    const transition = acceptedTransition(attempt);
    if (transition.kind !== "implemented") throw new Error("fixture must implement");
    expect(parseImplementationAttemptSettlementReceipt({
      ...transition.receipt,
      observedAt: "2026-08-23T00:02:00.000Z",
    }).ok).toBe(false);
  });
});

describe("pure Task suite evaluation", () => {
  it("accepts only the exact engine-owned byte-scope result", () => {
    const attempt = authority();
    const parsed = parseTaskCompletionSuiteResult(suiteResult(attempt));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const [only] = parsed.value.checks;
      expect(only).toMatchObject({ checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT, scope: "task" });
    }
    const evaluated = evaluateTaskCompletionSuite(suiteAuthority(attempt), suiteResult(attempt));
    expect(evaluated.kind).toBe("accepted");
  });

  it.each([
    ["missing", []],
    ["duplicate", [
      { checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT, scope: "task", outcome: { kind: "accepted", changedPaths: [] } },
      { checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT, scope: "task", outcome: { kind: "accepted", changedPaths: [] } },
    ]],
    ["surplus", [
      { checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT, scope: "task", outcome: { kind: "accepted", changedPaths: [] } },
      { checkId: "project:test", scope: "task", outcome: { kind: "accepted", changedPaths: [] } },
    ]],
    ["wrong-scope", [
      { checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT, scope: "wave", outcome: { kind: "accepted", changedPaths: [] } },
    ]],
  ])("rejects %s roster evidence", (_label, checks) => {
    const attempt = authority();
    expect(parseTaskCompletionSuiteResult(suiteResult(attempt, checks)).ok).toBe(false);
    const evaluated = evaluateTaskCompletionSuite(suiteAuthority(attempt), suiteResult(attempt, checks));
    expect(evaluated.kind).toBe("rejected");
    if (evaluated.kind === "rejected") expect(evaluated.authorityFailures.length).toBeGreaterThan(0);
  });

  it("keeps out-of-scope writes semantic and read uncertainty infrastructure", () => {
    const attempt = authority();
    const semantic = evaluateTaskCompletionSuite(suiteAuthority(attempt), suiteResult(attempt, [{
      checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT,
      scope: "task",
      outcome: { kind: "out-of-scope-writes", paths: ["foreign.ts"] },
    }]));
    const infrastructure = evaluateTaskCompletionSuite(suiteAuthority(attempt), suiteResult(attempt, [{
      checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT,
      scope: "task",
      outcome: { kind: "observation-unavailable", reason: "baseline could not be read" },
    }]));
    expect(semantic.kind === "rejected" && semantic.semanticFailures).toHaveLength(1);
    expect(semantic.kind === "rejected" && semantic.infrastructureFailures).toHaveLength(0);
    expect(infrastructure.kind === "rejected" && infrastructure.infrastructureFailures).toHaveLength(1);
    expect(infrastructure.kind === "rejected" && infrastructure.semanticFailures).toHaveLength(0);
  });
});

describe("Implementation Completion Oracle", () => {
  it("implements only with exact accepted suite and satisfied Proof", () => {
    const attempt = authority();
    const transition = acceptedTransition(attempt);
    expect(transition.kind).toBe("implemented");
    if (transition.kind !== "implemented") return;
    expect(transition.proof.state).toBe("satisfied");
    expect(transition.suite.checks).toHaveLength(1);
    expect(transition.suite.checks[0]?.checkId).toBe(TASK_BYTE_SCOPE_CHECK_ID_TEXT);
    expect(transition.receipt.transition).toBe("implemented");
    expect(transition.receipt.consumesSemanticAttempt).toBe(false);
  });

  it("preserves Pi structured provenance under the supplied ProofEvaluationPolicy", () => {
    const attempt = authority();
    const piObservation = observation({
      evidence: {
        taskCompleted: true,
        testResult: {
          verdict: "untrusted",
          passed: true,
          label: "pi-structured: tool-result",
          provenance: "pi-structured",
        },
        filesModified: ["engine/src/a.ts", "engine/tests/a.test.ts"],
        newTestsWritten: true,
      },
      proofEvaluationPolicy: PI_STRUCTURED_EVIDENCE_POLICY,
    });
    const transition = settledValue(settleImplementationAttempt(
      task(attempt), attempt, attempt, piObservation, suiteResult(attempt),
    ));
    expect(transition.kind).toBe("implemented");
    if (transition.kind === "implemented") {
      expect(transition.proof.evidence).toContainEqual(expect.objectContaining({
        kind: "regression-test-pass",
        provenance: "pi-structured",
        verdict: "untrusted-pass",
      }));
      expect(transition.proof.evidence).not.toContainEqual(expect.objectContaining({
        kind: "regression-test-pass",
        provenance: "evidence-ledger",
      }));
    }
  });

  it("classifies attempt-1 semantic failure as retry-required", () => {
    const attempt = authority(1);
    const failing = observation({
      evidence: {
        taskCompleted: true,
        testResult: { verdict: "trusted-fail" },
        filesModified: [],
        newTestsWritten: false,
      },
    });
    const transition = settledValue(settleImplementationAttempt(
      task(attempt), attempt, attempt, failing, suiteResult(attempt),
    ));
    expect(transition.kind).toBe("retry-required");
    if (transition.kind === "retry-required") {
      expect(transition.attempt).toBe(2);
      expect(transition.receipt.consumesSemanticAttempt).toBe(true);
    }
  });

  it("classifies attempt-2 semantic failure as escalation-required and never retries", () => {
    fc.assert(fc.property(fc.constantFrom("trusted-fail", "missing-artifacts"), (failureMode) => {
      const attempt = authority(2, `reservation-attempt-2-${failureMode}`);
      const failedObservation = failureMode === "trusted-fail"
        ? observation({ evidence: {
            taskCompleted: true,
            testResult: { verdict: "trusted-fail" },
            filesModified: ["engine/src/a.ts", "engine/tests/a.test.ts"],
            newTestsWritten: true,
          } })
        : observation({ evidence: {
            taskCompleted: true,
            testResult: { verdict: "trusted-pass" },
            filesModified: [],
            newTestsWritten: true,
          } });
      const transition = settledValue(settleImplementationAttempt(
        task(attempt), attempt, attempt, failedObservation, suiteResult(attempt),
      ));
      expect(transition.kind).toBe("escalation-required");
      if (transition.kind === "escalation-required") {
        expect(transition.receipt.consumesSemanticAttempt).toBe(true);
      }
    }));
  });

  it("does not consume a semantic attempt for observation or suite infrastructure uncertainty", () => {
    const attempt = authority();
    const unavailableObservation = {
      schemaVersion: 1,
      kind: "implementation-observation-unavailable",
      observedAt: "2026-08-23T00:01:00.000Z",
      failure: { kind: "observation-unavailable", message: "harness evidence missing" },
    };
    const unavailableSuite = suiteResult(attempt, [{
      checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT,
      scope: "task",
      outcome: { kind: "observation-unavailable", reason: "baseline missing" },
    }]);
    for (const [observed, suite] of [
      [unavailableObservation, suiteResult(attempt)],
      [observation(), unavailableSuite],
    ]) {
      const transition = settledValue(settleImplementationAttempt(task(attempt), attempt, attempt, observed, suite));
      expect(transition.kind).toBe("infrastructure-blocked");
      if (transition.kind === "infrastructure-blocked") {
        expect(transition.receipt.consumesSemanticAttempt).toBe(false);
      }
    }
  });

  it("classifies stale, duplicate, and already-completed settlement idempotently", () => {
    const current = authority(1, "reservation-current");
    const stale = authority(1, "reservation-stale");
    expect(settledValue(settleImplementationAttempt(
      task(current), current, stale, observation(), suiteResult(stale),
    ))).toEqual({ kind: "ignored", reason: "stale" });

    const implemented = acceptedTransition(current);
    if (implemented.kind !== "implemented") throw new Error("fixture must implement");
    expect(settledValue(settleImplementationAttempt(
      task(current, { implementation_attempt_history: [implemented.receipt] }),
      current,
      current,
      observation(),
      suiteResult(current),
    ))).toEqual({ kind: "ignored", reason: "duplicate" });

    const parsedObservation = valueOf(parseImplementationObservation(observation()));
    const satisfied = evaluateProofObligations(
      authoredProof().obligations,
      parsedObservation.kind === "implementation-observed"
        ? parsedObservation.evidence
        : { taskCompleted: false, filesModified: [] },
    );
    if (satisfied.state !== "satisfied") throw new Error("fixture must satisfy proof");
    expect(settledValue(settleImplementationAttempt(
      task(current, {
        status: "completed",
        proof: satisfied,
        active_implementation_attempt: undefined,
      }),
      current,
      current,
      observation(),
      suiteResult(current),
    ))).toEqual({ kind: "ignored", reason: "already-completed" });
  });

  it.each([
    ["missing", []],
    ["duplicate", [
      { checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT, scope: "task", outcome: { kind: "accepted", changedPaths: [] } },
      { checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT, scope: "task", outcome: { kind: "accepted", changedPaths: [] } },
    ]],
    ["surplus", [
      { checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT, scope: "task", outcome: { kind: "accepted", changedPaths: [] } },
      { checkId: "project:surplus", scope: "task", outcome: { kind: "accepted", changedPaths: [] } },
    ]],
    ["wrong-scope", [
      { checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT, scope: "wave", outcome: { kind: "accepted", changedPaths: [] } },
    ]],
  ])("cannot implement with %s suite evidence", (_label, checks) => {
    const attempt = authority();
    const settled = settleImplementationAttempt(task(attempt), attempt, attempt, observation(), suiteResult(attempt, checks));
    expect(settled.ok).toBe(false);
    if (!settled.ok) expect(settled.error.kind).toBe("task-suite-authority-failure");
  });

  it("cannot implement an out-of-scope write even when Proof itself is satisfied", () => {
    const attempt = authority();
    const transition = settledValue(settleImplementationAttempt(
      task(attempt),
      attempt,
      attempt,
      observation(),
      suiteResult(attempt, [{
        checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT,
        scope: "task",
        outcome: { kind: "out-of-scope-writes", paths: ["foreign.ts"] },
      }]),
    ));
    expect(transition.kind).toBe("retry-required");
    if (transition.kind === "retry-required") expect(transition.proof.state).toBe("satisfied");
  });

  it("settlement is deterministic and does not mutate any input", () => {
    const attempt = authority();
    const inputTask = task(attempt);
    const inputObservation = observation();
    const inputSuite = suiteResult(attempt);
    const before = JSON.stringify([inputTask, attempt, inputObservation, inputSuite]);
    const first = settleImplementationAttempt(inputTask, attempt, attempt, inputObservation, inputSuite);
    const second = settleImplementationAttempt(inputTask, attempt, attempt, inputObservation, inputSuite);
    expect(second).toEqual(first);
    expect(JSON.stringify([inputTask, attempt, inputObservation, inputSuite])).toBe(before);
  });
});

describe("settlement receipt history", () => {
  it("preserves ordered roundtrip history while rejecting duplicate receipt and reservation identities", () => {
    const first = acceptedTransition(authority(1, "receipt-reservation-1"));
    const secondAttempt = authority(2, "receipt-reservation-2");
    const second = settledValue(settleImplementationAttempt(
      task(secondAttempt),
      secondAttempt,
      secondAttempt,
      observation({ evidence: {
        taskCompleted: false,
        testResult: { verdict: "trusted-fail" },
        filesModified: [],
        newTestsWritten: false,
      } }),
      suiteResult(secondAttempt),
    ));
    if (first.kind !== "implemented" || second.kind !== "escalation-required") {
      throw new Error("fixtures must settle");
    }
    const history: readonly ImplementationAttemptSettlementReceipt[] = [first.receipt, second.receipt];
    expect(valueOf(parseImplementationAttemptHistory(history))).toEqual(history);
    expect(parseImplementationAttemptHistory([first.receipt, first.receipt]).ok).toBe(false);
    expect(parseImplementationAttemptHistory([
      first.receipt,
      { ...second.receipt, reservationId: first.receipt.reservationId },
    ]).ok).toBe(false);
  });
});
