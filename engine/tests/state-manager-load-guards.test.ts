/**
 * Load-boundary guards in `state-manager.ts` whose REJECTING branch nothing hit.
 *
 * Every one of these parses a value that arrives from `active_task_graph.json`
 * on disk — a file an operator can edit and a crashed writer can leave
 * inconsistent — so "the fixtures were always self-consistent" is precisely the
 * gap: deleting any of these cross-field checks left the suite green while the
 * loader started accepting a graph it is supposed to refuse.
 */

import { describe, expect, it } from "vitest";
import {
  parseCompletedWaveGateRegistration,
  parseTaskGraph,
} from "../src/state-manager";
import {
  authorizeWaveCompletionSuite,
  defaultVerificationManifest,
  freezeVerificationManifest,
  type FrozenVerificationManifest,
} from "../src/core/verification-manifest";
import {
  evaluateWaveCompletionSuite,
  type AcceptedWaveCompletionReceipt,
} from "../src/core/completion-suite";
import { canonicalJson, sha256Hex } from "../src/core/review-packet";

const PACKET = "a".repeat(64);
const HEAD = "b".repeat(40);
const DIGEST = (fill: string) => fill.repeat(64);

const validTask = {
  id: "T1",
  description: "impl",
  agent: "code-implementer-agent",
  wave: 1,
  status: "pending",
  depends_on: [],
} as const;

const graph = (overrides: Record<string, unknown> = {}) => ({
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  tasks: [validTask],
  wave_gates: {},
  ...overrides,
});

const errorOf = (raw: Record<string, unknown>): string => {
  const parsed = parseTaskGraph(raw);
  expect(parsed.ok, `expected the loader to refuse this graph`).toBe(false);
  if (parsed.ok) throw new Error("unreachable");
  return parsed.error;
};

// ---------------------------------------------------------------------------
// Task protected verification paths
// ---------------------------------------------------------------------------

describe("parseTaskGraph protected Task paths", () => {
  it.each([
    ".loom/verification-manifest.json",
    ".loom/completion-reports/result.json",
    ".loom/completion-reports/nested/result.json",
  ])("refuses stored protected path %s with an actionable Task/path diagnostic", (path) => {
    expect(errorOf(graph({ tasks: [{ ...validTask, file_list: [path] }] }))).toBe(
      `tasks[0] ("T1"): file_list path '${path}' is protected verification infrastructure; ` +
      `remove it from this Task`,
    );
  });

  it.each([
    ["manifest alias", ".loom/./verification-manifest.json"],
    ["report traversal", ".loom/completion-reports/../result.json"],
  ])("refuses stored protected-path %s through the canonical path parser", (_label, path) => {
    expect(errorOf(graph({ tasks: [{ ...validTask, file_list: [path] }] }))).toBe(
      `tasks[0] ("T1"): file_list[0] must be canonical and must not contain traversal segments`,
    );
  });

  it.each([
    ".loom/verification-manifest.json.bak",
    ".loom/verification-manifests.json",
    ".loom/completion-reports",
    ".loom/completion-report/result.json",
    ".loom/completion-reports.json",
    ".loom/unrelated/state.json",
  ])("allows stored near-miss or unrelated .loom path %s", (path) => {
    expect(parseTaskGraph(graph({ tasks: [{ ...validTask, file_list: [path] }] })).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wave_gate_history
// ---------------------------------------------------------------------------

const completedEntry = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "completed-wave-gate",
  runId: "completed-wave-run",
  wave: 1,
  authorityDigest: DIGEST("f"),
  revision: 3,
  completionReceipt: {
    kind: "protected-wave-state-committed",
    effectId: "completed-wave-effect",
    runId: "completed-wave-run",
    committedRevision: 3,
    stateDigest: DIGEST("e"),
  },
  ...overrides,
});

describe("parseCompletedWaveGateRegistration cross-field checks", () => {
  it("accepts the self-consistent entry these cases are varied from", () => {
    expect(parseTaskGraph(graph({ wave_gate_history: [completedEntry()] })).ok).toBe(true);
  });

  it("refuses a completion receipt minted under a different run", () => {
    const entry = completedEntry();
    const foreign = { ...entry, completionReceipt: { ...entry.completionReceipt, runId: "some-other-run" } };
    expect(errorOf(graph({ wave_gate_history: [foreign] }))).toContain("belongs to a different run");
  });

  it("refuses a completion receipt whose committedRevision is not the terminal revision", () => {
    const entry = completedEntry();
    const drifted = { ...entry, completionReceipt: { ...entry.completionReceipt, committedRevision: 2 } };
    expect(errorOf(graph({ wave_gate_history: [drifted] })))
      .toContain("completion receipt revision must equal terminal revision");
  });
});

describe("parseWaveGateHistory duplicate and collision checks", () => {
  it("refuses a history that repeats one run identity", () => {
    const duplicate = [completedEntry({ wave: 1 }), completedEntry({ wave: 2 })];
    expect(errorOf(graph({ wave_gate_history: duplicate }))).toContain("duplicate run identities");
  });

  it("refuses a history that completes the same Wave twice", () => {
    const secondRun = completedEntry({
      runId: "second-wave-run",
      completionReceipt: { ...completedEntry().completionReceipt, runId: "second-wave-run" },
    });
    expect(errorOf(graph({ wave_gate_history: [completedEntry(), secondRun] })))
      .toContain("duplicate completed Waves");
  });

  it("accepts two genuinely distinct completed Waves", () => {
    const secondRun = completedEntry({
      runId: "second-wave-run",
      wave: 2,
      completionReceipt: { ...completedEntry().completionReceipt, runId: "second-wave-run" },
    });
    expect(parseTaskGraph(graph({ wave_gate_history: [completedEntry(), secondRun] })).ok).toBe(true);
  });

  it("refuses a history array that is not an array", () => {
    expect(errorOf(graph({ wave_gate_history: {} }))).toContain("must be an array");
  });
});

// ---------------------------------------------------------------------------
// task review_run / review_status consistency
// ---------------------------------------------------------------------------

const reviewedTask = (overrides: Record<string, unknown> = {}) => ({
  ...validTask,
  review_status: "pending",
  review_generation: 1,
  findings: [],
  critical_findings: [],
  advisory_findings: [],
  review_run: {
    generation: 1,
    packet_id: PACKET,
    head_sha: HEAD,
    expected_agents: ["code-reviewer", "silent-failure-hunter"],
    prior_finding_ids: [],
    evidence: [],
  },
  ...overrides,
});

describe("taskStatusError review_run consistency", () => {
  it("accepts the consistent task these cases are varied from", () => {
    expect(parseTaskGraph(graph({ tasks: [reviewedTask()] })).ok).toBe(true);
  });

  it("refuses a review_run on a task with no review_generation", () => {
    const task = reviewedTask();
    const { review_generation: _dropped, ...withoutGeneration } = task;
    expect(errorOf(graph({ tasks: [{ ...withoutGeneration, review_run: { ...task.review_run, generation: 0 } }] })))
      .toContain("review_run requires review_generation");
  });

  // Only statuses that ARE in REVIEW_STATUSES reach the review_run rule; an
  // unknown status is refused earlier by the enum check.
  it.each(["passed", "blocked"])(
    "refuses an in-progress review_run alongside review_status %s",
    (review_status) => {
      expect(errorOf(graph({ tasks: [reviewedTask({ review_status })] })))
        .toContain("requires pending or evidence_capture_failed status");
    },
  );

  it("allows an in-progress review_run alongside evidence_capture_failed", () => {
    expect(parseTaskGraph(graph({
      tasks: [reviewedTask({
        review_status: "evidence_capture_failed",
        review_evidence_failures: ["code-reviewer"],
      })],
    })).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// task review_run.slot_authority
// ---------------------------------------------------------------------------

const withSlots = (slot_authority: unknown) => graph({
  tasks: [reviewedTask({
    review_run: { ...reviewedTask().review_run, slot_authority },
  })],
});

const slots = () => [
  { agent: "code-reviewer", slot_id: "slot-1", attempted: 1 },
  { agent: "silent-failure-hunter", slot_id: "slot-2", attempted: 1 },
];

describe("taskFindingsError slot_authority validation", () => {
  it("accepts the well-formed slot authority these cases are varied from", () => {
    expect(parseTaskGraph(withSlots(slots())).ok).toBe(true);
  });

  it("refuses an empty slot_authority", () => {
    expect(errorOf(withSlots([]))).toContain("must be a non-empty array when present");
  });

  it("refuses a slot_authority that is not an array", () => {
    expect(errorOf(withSlots({}))).toContain("must be a non-empty array when present");
  });

  it("refuses a slot_authority that does not cover every expected agent", () => {
    expect(errorOf(withSlots(slots().slice(0, 1))))
      .toContain("must cover every expected agent exactly once in order");
  });

  it("refuses slots whose agents are out of expected_agents order", () => {
    expect(errorOf(withSlots([...slots()].reverse())))
      .toContain("agent must match expected_agents in order");
  });

  it("refuses a slot carrying an unexpected field", () => {
    const [first, second] = slots();
    expect(errorOf(withSlots([{ ...first, extra: true }, second])))
      .toContain("must contain exactly agent/slot_id/attempted");
  });

  it("refuses a slot missing a required field", () => {
    const [first, second] = slots();
    const { attempted: _dropped, ...withoutAttempted } = first!;
    expect(errorOf(withSlots([withoutAttempted, second])))
      .toContain("must contain exactly agent/slot_id/attempted");
  });

  it("refuses two slots that reuse one slot id", () => {
    const [first, second] = slots();
    expect(errorOf(withSlots([first, { ...second!, slot_id: first!.slot_id }])))
      .toContain("duplicates an earlier Review Run slot");
  });

  it.each([0, 3, "1", null])("refuses an attempted value of %s", (attempted) => {
    const [first, second] = slots();
    expect(errorOf(withSlots([{ ...first!, attempted }, second]))).toContain("attempted must be 1 or 2");
  });

  it("accepts a second attempt on a slot", () => {
    const [first, second] = slots();
    expect(parseTaskGraph(withSlots([{ ...first!, attempted: 2 }, second])).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wave review epoch authority
// ---------------------------------------------------------------------------

const waveReviewEpoch = (overrides: Record<string, unknown> = {}) => ({
  runId: "run.wave-epoch",
  wave: 1,
  batchEpoch: DIGEST("a"),
  ...overrides,
});

const activeWaveGate = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "active-wave-gate",
  runId: "run.wave-epoch",
  wave: 1,
  authorityDigest: DIGEST("b"),
  revision: 0,
  terminalOutcome: null,
  ...overrides,
});

function valueOf<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error("fixture parse failed");
  return result.value;
}

function operatorManifest(reportRequired = false): FrozenVerificationManifest {
  return valueOf(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    kind: "loom-verification-manifest",
    checks: [{
      id: "project:test",
      scope: "wave",
      executable: "bun",
      args: ["test"],
      cwd: ".",
      timeoutMs: 60_000,
      report: reportRequired
        ? { kind: "required-file", path: ".loom/completion-reports/completion.json" }
        : { kind: "not-required" },
    }],
  }))));
}

function acceptedReceipt(
  manifest: FrozenVerificationManifest = defaultVerificationManifest(),
): AcceptedWaveCompletionReceipt {
  const active = activeWaveGate();
  const authority = valueOf(authorizeWaveCompletionSuite(manifest, active, DIGEST("c")));
  const rawResult = {
    kind: "wave-completion-suite-result",
    runId: authority.runId,
    wave: authority.wave,
    revision: authority.revision,
    authorityDigest: authority.authorityDigest,
    manifestDigest: authority.manifestDigest,
    suiteDigest: authority.suiteDigest,
    workspaceDigest: authority.workspaceDigest,
    checks: authority.checks.map((check) => ({
      checkId: check.checkId,
      scope: "wave",
      outcome: {
        kind: "observed",
        exitCode: 0,
        timedOut: false,
        signal: null,
        report: check.reportPolicy.kind === "not-required"
          ? { kind: "not-required" }
          : {
              kind: "produced",
              path: check.reportPolicy.path,
              digest: DIGEST("d"),
              byteLength: 10,
            },
      },
    })),
  };
  const evaluated = evaluateWaveCompletionSuite(authority, rawResult);
  if (evaluated.kind !== "accepted") throw new Error("fixture evaluation failed");
  return evaluated.receipt;
}

function recomputeReceipt(raw: Record<string, unknown>): Record<string, unknown> {
  const { resultDigest: _discarded, ...uncanonicalBody } = raw;
  const body = Array.isArray(uncanonicalBody.checks)
    ? {
        ...uncanonicalBody,
        checks: [...uncanonicalBody.checks].sort((left, right) => {
          const leftId = String((left as { checkId?: unknown }).checkId);
          const rightId = String((right as { checkId?: unknown }).checkId);
          return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
        }),
      }
    : uncanonicalBody;
  return { ...body, resultDigest: sha256Hex(canonicalJson(body as never)) };
}

function completedV2Entry(overrides: Record<string, unknown> = {}) {
  const suite = acceptedReceipt();
  return {
    schemaVersion: 2,
    kind: "completed-wave-gate",
    runId: suite.runId,
    wave: suite.wave,
    authorityDigest: suite.authorityDigest,
    revision: suite.revision + 1,
    completionReceipt: {
      kind: "protected-wave-state-committed",
      effectId: "completed-wave-v2-effect",
      runId: suite.runId,
      committedRevision: suite.revision + 1,
      stateDigest: DIGEST("e"),
    },
    completionSuite: suite,
    ...overrides,
  };
}

function isDeeplyFrozen(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return true;
  return Object.isFrozen(raw) && Object.values(raw).every(isDeeplyFrozen);
}

describe("parseTaskGraph wave_review_epoch authority", () => {
  it("parses and freezes a well-formed epoch instead of retaining raw input", () => {
    const rawEpoch = waveReviewEpoch();
    const parsed = parseTaskGraph(graph({ current_wave: 1, wave_review_epoch: rawEpoch }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.wave_review_epoch).toEqual(rawEpoch);
    expect(parsed.value.wave_review_epoch).not.toBe(rawEpoch);
    expect(Object.isFrozen(parsed.value.wave_review_epoch)).toBe(true);
  });

  it.each([
    ["non-object", "forged"],
    ["bad run id", waveReviewEpoch({ runId: "../escape" })],
    ["zero Wave", waveReviewEpoch({ wave: 0 })],
    ["non-integer Wave", waveReviewEpoch({ wave: 1.5 })],
    ["bad batch digest", waveReviewEpoch({ batchEpoch: "not-a-digest" })],
    ["unknown field", waveReviewEpoch({ forged: true })],
  ])("refuses %s", (_label, epoch) => {
    expect(errorOf(graph({ wave_review_epoch: epoch }))).toContain("wave_review_epoch");
  });

  it("requires exact agreement with active Wave Gate run and Wave authority", () => {
    const mismatchedRun = graph({
      current_wave: 1,
      active_wave_gate: activeWaveGate(),
      wave_review_epoch: waveReviewEpoch({ runId: "run.someone-else" }),
    });
    expect(errorOf(mismatchedRun)).toContain("must match active_wave_gate run/Wave authority");

    const mismatchedWave = graph({
      current_wave: 1,
      active_wave_gate: activeWaveGate(),
      wave_review_epoch: waveReviewEpoch({ wave: 2 }),
    });
    expect(errorOf(mismatchedWave)).toContain("must match active_wave_gate run/Wave authority");
  });
});

// ---------------------------------------------------------------------------
// protected verification manifest + accepted completion suite
// ---------------------------------------------------------------------------

describe("parseCompletedWaveGateRegistration schema v1/v2 history", () => {
  it("round-trips historical v1 unchanged and modern v2 with its exact accepted suite", () => {
    const v1 = completedEntry();
    const v2 = completedV2Entry();
    expect(parseCompletedWaveGateRegistration(JSON.parse(JSON.stringify(v1)))).toEqual({
      ok: true,
      value: v1,
    });
    expect(parseCompletedWaveGateRegistration(JSON.parse(JSON.stringify(v2)))).toEqual({
      ok: true,
      value: v2,
    });
    expect(parseTaskGraph(graph({ wave_gate_history: [v2] })).ok).toBe(true);
  });

  it("rejects schema ambiguity, missing fields, and surplus fields", () => {
    const v1 = completedEntry();
    const v2 = completedV2Entry();
    const { completionSuite: _suite, ...v2WithoutSuite } = v2;
    for (const malformed of [
      { ...v1, completionSuite: acceptedReceipt() },
      v2WithoutSuite,
      { ...v2, surplus: true },
      { ...v2, schemaVersion: 3 },
    ]) {
      expect(parseCompletedWaveGateRegistration(malformed).ok).toBe(false);
    }
  });

  it("rejects malformed suite run/Wave/authority/revision and completionReceipt relations", () => {
    const v2 = completedV2Entry();
    const suite = v2.completionSuite;
    const malformed = [
      { ...v2, completionSuite: recomputeReceipt({ ...suite, runId: "run.other" }) },
      { ...v2, completionSuite: recomputeReceipt({ ...suite, wave: 2 }) },
      { ...v2, completionSuite: recomputeReceipt({ ...suite, authorityDigest: DIGEST("9") }) },
      { ...v2, completionSuite: recomputeReceipt({ ...suite, revision: suite.revision + 1 }) },
      { ...v2, completionReceipt: { ...v2.completionReceipt, runId: "run.other" } },
      { ...v2, completionReceipt: { ...v2.completionReceipt, committedRevision: v2.revision + 1 } },
    ];
    for (const entry of malformed) {
      expect(parseCompletedWaveGateRegistration(entry).ok).toBe(false);
    }
  });
});

describe("parseTaskGraph protected completion authority", () => {
  it("keeps pre-Slice-2 graphs readable when both protected fields are absent", () => {
    const parsed = parseTaskGraph(graph({ current_wave: 1, active_wave_gate: activeWaveGate() }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.verification_manifest).toBeUndefined();
      expect(parsed.value.active_wave_completion_suite).toBeUndefined();
    }
  });

  it("round-trips valid manifest and receipt into canonical deeply frozen values", () => {
    const manifest = operatorManifest(true);
    const receipt = acceptedReceipt(manifest);
    const parsed = parseTaskGraph(graph({
      current_wave: 1,
      active_wave_gate: activeWaveGate(),
      verification_manifest: JSON.parse(JSON.stringify(manifest)),
      active_wave_completion_suite: JSON.parse(JSON.stringify(receipt)),
    }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.verification_manifest).toEqual(manifest);
    expect(parsed.value.active_wave_completion_suite).toEqual(receipt);
    expect(isDeeplyFrozen(parsed.value.verification_manifest)).toBe(true);
    expect(isDeeplyFrozen(parsed.value.active_wave_completion_suite)).toBe(true);
    expect(parseTaskGraph(JSON.parse(JSON.stringify(parsed.value))).ok).toBe(true);
  });

  it("uses default manifest authority when the legacy-compatible field is absent", () => {
    const receipt = acceptedReceipt();
    expect(parseTaskGraph(graph({
      current_wave: 1,
      active_wave_gate: activeWaveGate(),
      active_wave_completion_suite: receipt,
    })).ok).toBe(true);
  });

  it("rejects malformed, surplus, and digest-tampered protected fields", () => {
    const manifest = operatorManifest();
    const receipt = acceptedReceipt(manifest);
    const cases = [
      { verification_manifest: { ...manifest, surplus: true } },
      { verification_manifest: { ...manifest, manifestDigest: DIGEST("f") } },
      { verification_manifest: { kind: "frozen-verification-manifest" } },
      { verification_manifest: manifest, active_wave_completion_suite: { ...receipt, surplus: true } },
      { verification_manifest: manifest, active_wave_completion_suite: { ...receipt, resultDigest: DIGEST("e") } },
      { verification_manifest: manifest, active_wave_completion_suite: { ...receipt, checks: [] } },
    ];
    for (const fields of cases) {
      expect(parseTaskGraph(graph({
        current_wave: 1,
        active_wave_gate: activeWaveGate(),
        ...fields,
      })).ok).toBe(false);
    }
  });

  it("requires an exact nonterminal active Wave Gate binding", () => {
    const receipt = acceptedReceipt();
    expect(errorOf(graph({ active_wave_completion_suite: receipt })))
      .toContain("requires a nonterminal active_wave_gate");
    const terminalGate = activeWaveGate({
      terminalOutcome: {
        kind: "done",
        outcome: {
          runId: "run.wave-epoch",
          slot: "outcome.json",
          digest: DIGEST("a"),
          byteLength: 1,
        },
      },
    });
    expect(errorOf(graph({ current_wave: 1, active_wave_gate: terminalGate, active_wave_completion_suite: receipt })))
      .toContain("requires a nonterminal active_wave_gate");

    for (const [field, value] of [
      ["runId", "run.other"],
      ["wave", 2],
      ["revision", 1],
      ["authorityDigest", DIGEST("9")],
    ] as const) {
      const tampered = recomputeReceipt({ ...receipt, [field]: value });
      expect(errorOf(graph({
        current_wave: 1,
        active_wave_gate: activeWaveGate(),
        active_wave_completion_suite: tampered,
      }))).toContain(field);
    }
  });

  it("rejects manifest, suite-digest, exact-roster, and report-policy contradictions", () => {
    const manifest = operatorManifest(true);
    const receipt = acceptedReceipt(manifest);
    const extraCheck = {
      checkId: "project:surplus",
      scope: "wave",
      outcome: {
        kind: "observed",
        exitCode: 0,
        timedOut: false,
        signal: null,
        report: { kind: "not-required" },
      },
    };
    const projectIndex = receipt.checks.findIndex((check) => check.checkId === "project:test");
    const wrongReportChecks = receipt.checks.map((check, index) => index === projectIndex
      ? { ...check, outcome: { ...check.outcome, report: { kind: "not-required" } } }
      : check);
    const contradictions = [
      recomputeReceipt({ ...receipt, manifestDigest: defaultVerificationManifest().manifestDigest }),
      recomputeReceipt({ ...receipt, suiteDigest: DIGEST("7") }),
      recomputeReceipt({ ...receipt, checks: [...receipt.checks, extraCheck] }),
      recomputeReceipt({ ...receipt, checks: wrongReportChecks }),
    ];
    for (const active_wave_completion_suite of contradictions) {
      expect(parseTaskGraph(graph({
        current_wave: 1,
        active_wave_gate: activeWaveGate(),
        verification_manifest: manifest,
        active_wave_completion_suite,
      })).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// wave_gates record-key domain (round-40: type-design-analyzer advisory)
// ---------------------------------------------------------------------------

const waveGateRecord = {
  impl_complete: false,
  tests_passed: null,
  reviews_complete: false,
  blocked: false,
} as const;

describe("parseTaskGraph wave_gates record-key validation", () => {
  it("accepts canonical positive integer keys (String(wave))", () => {
    expect(parseTaskGraph(graph({ wave_gates: { "1": waveGateRecord } })).ok).toBe(true);
  });

  it("rejects non-canonical wave_gates keys — even when the gate value is valid", () => {
    for (const wave of ["01", "abc", "-1", "1.0", "0", "1e2"]) {
      const err = errorOf(graph({ wave_gates: { [wave]: waveGateRecord } }));
      expect(err).toContain("wave_gates key must be a canonical positive integer wave number");
    }
  });
});

describe("untrusted test_result label validation", () => {
  const withTestResult = (label: unknown) => graph({
    tasks: [{ ...validTask, test_result: { verdict: "untrusted", passed: true, label } }],
  });

  it("accepts an untrusted verdict that names its weak source", () => {
    expect(parseTaskGraph(withTestResult("helper-reported (store-test-evidence stdin)")).ok).toBe(true);
  });

  it("refuses an empty untrusted label — the weak source would be unnamed", () => {
    for (const empty of ["", "   "]) {
      const err = errorOf(withTestResult(empty));
      expect(err).toContain("non-empty label naming the weak source");
    }
  });

  it("refuses a non-string untrusted label", () => {
    expect(errorOf(withTestResult(42))).toContain("non-empty label naming the weak source");
  });
});

describe("phase container immutability", () => {
  it("hands out frozen phase_artifacts and skipped_phases so in-place mutation cannot bypass the locked transform", () => {
    const parsed = parseTaskGraph(graph({ phase_artifacts: { architecture: "plans/x.md" }, skipped_phases: ["clarify"] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.isFrozen(parsed.value.phase_artifacts)).toBe(true);
    expect(Object.isFrozen(parsed.value.skipped_phases)).toBe(true);
  });
});
