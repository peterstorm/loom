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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "./fixtures/canonical-temp-dir";
import {
  parseCompletedWaveGateRegistration,
  parseTaskGraph,
  StateManager,
} from "../src/state-manager";
import { recordReviewRunEvidence } from "../src/core/findings";
import type { AcceptedReviewAuthority } from "../src/types";
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
import fc from "fast-check";
import { CURRENT_REVIEWER_PROTOCOL, REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../src/core/reviewer-contract";

function currentReviewTask(generation = 1) {
  const slot = { agent: "code-reviewer", slot_id: "slot:code-reviewer", attempted: 1 as const, request_id: "request:code-reviewer:1", context_digest: "d".repeat(64) };
  return { ...validTask, review_status: "pending", review_generation: generation, findings: [], critical_findings: [], advisory_findings: [],
    review_run: { generation, packet_id: PACKET, head_sha: HEAD, expected_agents: [slot.agent], prior_finding_ids: [],
      reviewer_protocol: CURRENT_REVIEWER_PROTOCOL, workspace_scope: ["src/x.ts"], workspace_head_sha: "e".repeat(64), wave_gate_run_id: "run.current", wave_gate_authority_digest: "f".repeat(64),
      slot_authority: [slot], evidence: [{ protocolVersion: 2, ...slot, prior_assessments: [], new_findings: [{ protocolVersion: 2, ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0], file: "src/x.ts" }] }],
    } };
}

describe("current Review Run loader joins", () => {
  it("round-trips exact current descriptor, evidence, request/context and generation", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100000 }), (generation) => {
      const task = currentReviewTask(generation);
      const parsed = parseTaskGraph(JSON.parse(JSON.stringify(graph({ tasks: [task] }))));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed));
      expect(parsed.value.tasks[0]?.review_run).toEqual(task.review_run);
      expect(Object.isFrozen(parsed.value.tasks[0]?.review_run?.evidence[0]?.new_findings[0]?.basis?.evidence)).toBe(true);
    }), { seed: 31284, numRuns: 50 });
  });
  it.each(["descriptor-null", "descriptor-unknown", "no-descriptor", "no-workspace", "no-slots", "no-request", "no-context", "request-mismatch", "context-mismatch", "attempt-mismatch", "legacy-evidence", "legacy-draft", "missing-basis"])("refuses %s without normalization or downgrade", (mutation) => {
    const task = JSON.parse(JSON.stringify(currentReviewTask()));
    const run = task.review_run;
    if (mutation === "descriptor-null") run.reviewer_protocol = null;
    if (mutation === "descriptor-unknown") run.reviewer_protocol.version = 3;
    if (mutation === "no-descriptor") delete run.reviewer_protocol;
    if (mutation === "no-workspace") delete run.workspace_scope;
    if (mutation === "no-slots") delete run.slot_authority;
    if (mutation === "no-request") delete run.slot_authority[0].request_id;
    if (mutation === "no-context") delete run.slot_authority[0].context_digest;
    if (mutation === "request-mismatch") run.evidence[0].request_id = "request:other";
    if (mutation === "context-mismatch") run.evidence[0].context_digest = "a".repeat(64);
    if (mutation === "attempt-mismatch") run.evidence[0].attempted = 2;
    if (mutation === "legacy-evidence") delete run.evidence[0].protocolVersion;
    if (mutation === "legacy-draft") run.evidence[0].new_findings = [{ severity: "critical", claim: "legacy", file: null, line: null }];
    if (mutation === "missing-basis") delete run.evidence[0].new_findings[0].basis;
    expect(parseTaskGraph(graph({ tasks: [task] })).ok).toBe(false);
  });
  it.each(["valid", "null-descriptor", "missing-run", "unsupported"])("checks completed current accepted authority: %s", (mutation) => {
    const task = { ...validTask, review_generation: 1, review_status: "passed", accepted_review_authority: {
      generation: 1, packet_id: PACKET, head_sha: HEAD, scope: ["src/x.ts"], run_id: "run.current", authority_digest: "a".repeat(64), reviewer_protocol: CURRENT_REVIEWER_PROTOCOL,
    } };
    const raw = JSON.parse(JSON.stringify(task));
    if (mutation === "null-descriptor") raw.accepted_review_authority.reviewer_protocol = null;
    if (mutation === "missing-run") delete raw.accepted_review_authority.run_id;
    if (mutation === "unsupported") raw.accepted_review_authority.reviewer_protocol.version = 3;
    expect(parseTaskGraph(graph({ tasks: [raw] })).ok).toBe(mutation === "valid");
  });
});

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

describe("stored Finding location authority", () => {
  const finding = {
    id: "code-reviewer-1",
    agent: "code-reviewer",
    severity: "critical",
    file: null,
    line: null,
    claim: "load boundary must prove locations",
  };
  const legacyFinding = (({ file: _file, line: _line, ...rest }) => rest)(finding);
  const refutation = (storedFinding: unknown) => ({
    finding: storedFinding,
    refutations: [{ lens: "intent", reason: "not reproducible" }],
  });
  const resolution = (storedFinding: unknown) => ({
    finding: storedFinding,
    resolution: {
      kind: "resolved_by_remediation",
      generation: 1,
      packet_id: PACKET,
      head_sha: HEAD,
      expected_agents: ["code-reviewer"],
      assessments: [{
        finding_id: typeof storedFinding === "object" && storedFinding !== null && "id" in storedFinding
          ? String(storedFinding.id)
          : finding.id,
        verdict: "resolved_by_remediation",
        reason: "fixed",
        agent: "code-reviewer",
      }],
    },
  });

  it("normalizes omitted legacy locations in every Finding-bearing container", () => {
    const parsed = parseTaskGraph(graph({
      tasks: [{
        ...validTask,
        findings: [legacyFinding],
        critical_findings: [finding.claim],
        advisory_findings: [],
        refuted_findings: [refutation({ ...legacyFinding, id: "code-reviewer-2" })],
        resolved_findings: [resolution({ ...legacyFinding, id: "code-reviewer-3" })],
      }],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.tasks[0]?.findings?.[0]).toMatchObject({ file: null, line: null });
    expect(parsed.value.tasks[0]?.refuted_findings?.[0]?.finding).toMatchObject({ file: null, line: null });
    expect(parsed.value.tasks[0]?.resolved_findings?.[0]?.finding).toMatchObject({ file: null, line: null });
  });

  it.each([
    ["numeric file", { ...finding, file: 42 }],
    ["object line", { ...finding, line: {} }],
    ["unsafe line", { ...finding, line: Number.MAX_SAFE_INTEGER + 1 }],
    ["numeric-string line", { ...finding, line: "42" }],
  ])("rejects an explicitly noncanonical active Finding with %s", (_label, malformed) => {
    expect(errorOf(graph({
      tasks: [{
        ...validTask,
        findings: [malformed],
        critical_findings: [finding.claim],
        advisory_findings: [],
      }],
    }))).toContain("not a well-formed finding");
  });

  it.each([
    ["refuted", (malformed: unknown) => refutation(malformed)],
    ["resolved", (malformed: unknown) => resolution(malformed)],
  ])("rejects malformed explicit locations nested in %s findings", (container, envelope) => {
    const field = container === "refuted" ? "refuted_findings" : "resolved_findings";
    expect(errorOf(graph({
      tasks: [{ ...validTask, [field]: [envelope({ ...finding, file: 42 })] }],
    }))).toContain("not a well-formed");
  });

  const stagedReviewTask = (newFinding: unknown) => reviewedTask({
    review_run: {
      ...reviewedTask().review_run,
      evidence: [{
        agent: "code-reviewer",
        prior_assessments: [],
        new_findings: [newFinding],
      }],
    },
  });

  it.each([
    ["numeric file", { severity: "critical", file: 42, line: null, claim: "staged blocker" }],
    ["padded file", { severity: "critical", file: " src/x.ts ", line: null, claim: "staged blocker" }],
    ["numeric-string line", { severity: "critical", file: null, line: "7", claim: "staged blocker" }],
    ["zero line", { severity: "critical", file: null, line: 0, claim: "staged blocker" }],
  ])("rejects a Review Run draft with an explicitly noncanonical %s", (_label, malformed) => {
    expect(errorOf(graph({ tasks: [stagedReviewTask(malformed)] })))
      .toContain("review_run.evidence[0].new_findings must be well-formed draft findings");
  });

  it("loads canonical staged locations and preserves them through Review Run finalization", () => {
    const parsed = parseTaskGraph(graph({
      tasks: [stagedReviewTask({
        severity: "critical",
        file: "src/x.ts",
        line: 7,
        claim: "staged blocker",
      })],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const transition = recordReviewRunEvidence(parsed.value.tasks[0]!, PACKET, 1, {
      agent: "silent-failure-hunter",
      prior_assessments: [],
      new_findings: [],
    });
    expect(transition).toMatchObject({ ok: true, completed: true });
    if (!transition.ok) return;
    expect(transition.task.findings).toContainEqual(expect.objectContaining({
      agent: "code-reviewer",
      file: "src/x.ts",
      line: 7,
      claim: "staged blocker",
    }));
  });
});

// ---------------------------------------------------------------------------
// Requirement Content Hash authority
// ---------------------------------------------------------------------------

describe("parseTaskGraph spec_anchor_hashes load boundary", () => {
  it("round-trips a record of strings", () => {
    const parsed = parseTaskGraph(graph({
      tasks: [{ ...validTask, spec_anchor_hashes: { "FR-001": DIGEST("a") } }],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.tasks[0]?.spec_anchor_hashes).toEqual({ "FR-001": DIGEST("a") });
    expect(Object.isFrozen(parsed.value.tasks[0]?.spec_anchor_hashes)).toBe(true);
  });

  it.each([42, null, true, {}, []])("refuses non-string hash value %j", (value) => {
    expect(errorOf(graph({
      tasks: [{ ...validTask, spec_anchor_hashes: { "FR-001": value } }],
    }))).toContain('tasks[0].spec_anchor_hashes["FR-001"] must be a string');
  });

  it.each([null, [], "hash"])("refuses non-record spec_anchor_hashes %j", (value) => {
    expect(errorOf(graph({
      tasks: [{ ...validTask, spec_anchor_hashes: value }],
    }))).toContain("spec_anchor_hashes must be a record of strings");
  });
});

// ---------------------------------------------------------------------------
// Durable decompose-time Spec Index observation
// ---------------------------------------------------------------------------

describe("parseTaskGraph spec_index_observation load boundary", () => {
  it("preserves legacy graphs where the observation is absent", () => {
    const parsed = parseTaskGraph(graph());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.spec_index_observation).toBeUndefined();
  });

  it.each([
    {
      label: "indexed identity",
      specFile: "spec.md",
      observation: { kind: "indexed", path: "spec.md", contentDigest: DIGEST("a") },
    },
    {
      label: "no spec file",
      specFile: null,
      observation: { kind: "unavailable", reason: { kind: "no-spec-file" } },
    },
    {
      label: "unreadable spec",
      specFile: "spec.md",
      observation: { kind: "unavailable", reason: { kind: "unreadable", path: "spec.md", reason: "EACCES" } },
    },
    {
      label: "invalid encoding",
      specFile: "spec.md",
      observation: {
        kind: "unavailable",
        reason: { kind: "invalid-encoding", path: "spec.md", contentDigest: DIGEST("b"), reason: "invalid UTF-8" },
      },
    },
    {
      label: "unparsed spec",
      specFile: "spec.md",
      observation: {
        kind: "unavailable",
        reason: {
          kind: "unparsed",
          path: "spec.md",
          contentDigest: DIGEST("c"),
          errors: [{ kind: "entry-not-canonical", section: "Functional Requirements", line: 12 }],
        },
      },
    },
  ])("parses and deeply freezes $label", ({ specFile, observation }) => {
    const parsed = parseTaskGraph(graph({ spec_file: specFile, spec_index_observation: observation }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const stored = parsed.value.spec_index_observation;
    expect(stored).toEqual(observation);
    expect(Object.isFrozen(stored)).toBe(true);
    if (stored?.kind === "unavailable") {
      expect(Object.isFrozen(stored.reason)).toBe(true);
      if (stored.reason.kind === "unparsed") {
        expect(Object.isFrozen(stored.reason.errors)).toBe(true);
        expect(Object.isFrozen(stored.reason.errors[0])).toBe(true);
      }
    }
  });

  it.each([
    ["non-object", []],
    ["unknown tag", { kind: "maybe" }],
    ["indexed digest", { kind: "indexed", path: "spec.md", contentDigest: "bad" }],
    ["persisted ParsedSpec", { kind: "indexed", path: "spec.md", contentDigest: DIGEST("a"), index: {} }],
    ["unavailable surplus field", { kind: "unavailable", reason: { kind: "no-spec-file" }, extra: true }],
    ["unreadable missing reason", { kind: "unavailable", reason: { kind: "unreadable", path: "spec.md" } }],
    ["invalid encoding digest", {
      kind: "unavailable",
      reason: { kind: "invalid-encoding", path: "spec.md", contentDigest: "bad", reason: "invalid" },
    }],
    ["unparsed empty errors", {
      kind: "unavailable",
      reason: { kind: "unparsed", path: "spec.md", contentDigest: DIGEST("a"), errors: [] },
    }],
    ["unparsed malformed error", {
      kind: "unavailable",
      reason: {
        kind: "unparsed",
        path: "spec.md",
        contentDigest: DIGEST("a"),
        errors: [{ kind: "entry-not-canonical", section: "not-a-section", line: 0 }],
      },
    }],
  ])("fails closed for malformed stored shape: %s", (_label, observation) => {
    expect(errorOf(graph({ spec_file: "spec.md", spec_index_observation: observation })))
      .toContain("spec_index_observation");
  });

  it("refuses an observation that contradicts protected spec_file authority", () => {
    expect(errorOf(graph({
      spec_file: "spec.md",
      spec_index_observation: { kind: "indexed", path: "other.md", contentDigest: DIGEST("a") },
    }))).toContain("path must match protected spec_file");
  });
});

// ---------------------------------------------------------------------------
// Wave review epoch authority
// ---------------------------------------------------------------------------

const waveReviewEpoch = (overrides: Record<string, unknown> = {}) => ({
  runId: "run.wave-epoch",
  wave: 1,
  batchEpoch: DIGEST("a"),
  specCheckSlotAuthority: { slot_id: "wave-slot:spec-check", attempted: 1 },
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
    expect(Object.isFrozen(parsed.value.wave_review_epoch?.specCheckSlotAuthority)).toBe(true);
  });

  it("parses and deeply freezes byte-bound spec-check documents", () => {
    const documents = {
      spec: { path: "spec.md", contentDigest: DIGEST("c") },
      plan: { path: "plan.md", contentDigest: DIGEST("d") },
    };
    const parsed = parseTaskGraph(graph({
      current_wave: 1,
      spec_file: "spec.md",
      plan_file: "plan.md",
      wave_review_epoch: waveReviewEpoch({ specCheckDocuments: documents }),
    }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.wave_review_epoch?.specCheckDocuments).toEqual(documents);
    expect(isDeeplyFrozen(parsed.value.wave_review_epoch?.specCheckDocuments)).toBe(true);
  });

  it("rejects document paths that disagree with protected graph authority", () => {
    expect(errorOf(graph({
      spec_file: "different-spec.md",
      plan_file: "plan.md",
      wave_review_epoch: waveReviewEpoch({
        specCheckDocuments: {
          spec: { path: "spec.md", contentDigest: DIGEST("c") },
          plan: { path: "plan.md", contentDigest: DIGEST("d") },
        },
      }),
    }))).toContain("paths must match spec_file/plan_file");
  });

  it.each([
    [
      "identity-bearing settled",
      { kind: "settled", count: 2, criticalFindings: ["required one", "required two"] },
      { kind: "settled", count: 2, criticalFindings: ["required one", "required two"] },
    ],
    ["historical count-only", { kind: "settled", count: 3 }, { kind: "legacy-settled", count: 3 }],
    [
      "unprojected",
      { kind: "unprojected", reason: "the TaskGraph records no spec_file" },
      { kind: "unprojected", reason: "the TaskGraph records no spec_file" },
    ],
  ])("parses and freezes a %s Requirement Coverage floor", (_label, floor, expected) => {
    const parsed = parseTaskGraph(graph({
      current_wave: 1,
      wave_review_epoch: waveReviewEpoch({ settledSpecCheckFloor: floor }),
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.wave_review_epoch?.settledSpecCheckFloor).toEqual(expected);
    expect(isDeeplyFrozen(parsed.value.wave_review_epoch?.settledSpecCheckFloor)).toBe(true);
  });

  it("keeps an epoch installed before the floor was recorded readable", () => {
    // Absent is a historical fact, not corruption; `epochSettledFloor` is where
    // that absence acquires its stated meaning.
    const parsed = parseTaskGraph(graph({ current_wave: 1, wave_review_epoch: waveReviewEpoch() }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.wave_review_epoch?.settledSpecCheckFloor).toBeUndefined();
  });

  it("keeps historical epochs readable without spec-check slot authority", () => {
    const legacy = waveReviewEpoch();
    const { specCheckSlotAuthority: _absent, ...withoutSlotAuthority } = legacy;
    const parsed = parseTaskGraph(graph({ current_wave: 1, wave_review_epoch: withoutSlotAuthority }));
    expect(parsed).toMatchObject({ ok: true });
  });

  it.each([
    ["non-object", "forged"],
    ["bad run id", waveReviewEpoch({ runId: "../escape" })],
    ["zero Wave", waveReviewEpoch({ wave: 0 })],
    ["non-integer Wave", waveReviewEpoch({ wave: 1.5 })],
    ["bad batch digest", waveReviewEpoch({ batchEpoch: "not-a-digest" })],
    ["malformed document digest", waveReviewEpoch({ specCheckDocuments: {
      spec: { path: null, contentDigest: "bad" }, plan: { path: null, contentDigest: null },
    } })],
    ["malformed spec-check slot", waveReviewEpoch({ specCheckSlotAuthority: "forged" })],
    ["bad spec-check slot id", waveReviewEpoch({ specCheckSlotAuthority: { slot_id: "../escape", attempted: 1 } })],
    ["bad spec-check attempt", waveReviewEpoch({ specCheckSlotAuthority: { slot_id: "wave-slot:spec-check", attempted: 3 } })],
    ["surplus spec-check slot field", waveReviewEpoch({ specCheckSlotAuthority: { slot_id: "wave-slot:spec-check", attempted: 1, forged: true } })],
    ["unknown field", waveReviewEpoch({ forged: true })],
    // A corrupt floor must not degrade to "no floor": that would silently
    // unfloor a live epoch, which is the exact failure recording it prevents.
    ["forged settled floor", waveReviewEpoch({ settledSpecCheckFloor: "forged" })],
    ["unknown floor variant", waveReviewEpoch({ settledSpecCheckFloor: { kind: "waived" } })],
    ["manual override floor", waveReviewEpoch({
      settledSpecCheckFloor: { kind: "manual-override", reason: "operator" },
    })],
    ["settled floor with no count", waveReviewEpoch({ settledSpecCheckFloor: { kind: "settled" } })],
    ["negative settled floor", waveReviewEpoch({ settledSpecCheckFloor: { kind: "settled", count: -1 } })],
    ["non-integer settled floor", waveReviewEpoch({ settledSpecCheckFloor: { kind: "settled", count: 1.5 } })],
    ["unsafe settled floor", waveReviewEpoch({ settledSpecCheckFloor: { kind: "settled", count: 1e100 } })],
    ["settled identity/count mismatch", waveReviewEpoch({
      settledSpecCheckFloor: { kind: "settled", count: 2, criticalFindings: ["only one"] },
    })],
    ["misspelled settled identity field", waveReviewEpoch({
      settledSpecCheckFloor: { kind: "settled", count: 1, criticalFinding: ["misspelled"] },
    })],
    ["surplus historical settled field", waveReviewEpoch({
      settledSpecCheckFloor: { kind: "settled", count: 1, forged: true },
    })],
    ["surplus current settled field", waveReviewEpoch({
      settledSpecCheckFloor: { kind: "settled", count: 1, criticalFindings: ["required"], forged: true },
    })],
    ["blank settled identity", waveReviewEpoch({
      settledSpecCheckFloor: { kind: "settled", count: 1, criticalFindings: ["  "] },
    })],
    ["duplicate settled identity", waveReviewEpoch({
      settledSpecCheckFloor: { kind: "settled", count: 2, criticalFindings: ["same", "same"] },
    })],
    ["unprojected floor with no reason", waveReviewEpoch({ settledSpecCheckFloor: { kind: "unprojected" } })],
    ["unprojected floor with a blank reason", waveReviewEpoch({ settledSpecCheckFloor: { kind: "unprojected", reason: "  " } })],
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
// persisted spec-check evidence
// ---------------------------------------------------------------------------

describe("parseTaskGraph spec_check count and provenance authority", () => {
  const captured = (overrides: Record<string, unknown> = {}) => ({
    wave: 1,
    run_at: "now",
    verdict: "PASSED",
    critical_count: 0,
    high_count: 0,
    critical_findings: [],
    high_findings: [],
    medium_findings: [],
    ...overrides,
  });

  it.each([1e100, Number.MAX_SAFE_INTEGER + 1])("refuses unsafe captured count %s", (count) => {
    expect(errorOf(graph({ spec_check: captured({ critical_count: count }) }))).toContain("safe integer");
  });

  it("normalizes historical UNKNOWN into retryable evidence failure", () => {
    const parsed = parseTaskGraph(graph({ spec_check: captured({ verdict: "UNKNOWN" }) }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.spec_check).toMatchObject({
      verdict: "EVIDENCE_CAPTURE_FAILED",
      cause: "transcript",
      error: expect.stringContaining("UNKNOWN"),
    });
  });

  it("migrates UNKNOWN with critical findings without leaving a causeless Wave block", () => {
    const parsed = parseTaskGraph(graph({
      spec_check: captured({
        verdict: "UNKNOWN",
        critical_count: 1,
        critical_findings: ["historical blocker"],
      }),
      wave_gates: {
        "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: true },
      },
    }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.spec_check).toMatchObject({
      verdict: "EVIDENCE_CAPTURE_FAILED",
      cause: "transcript",
    });
    expect(parsed.value.wave_gates["1"]?.blocked).toBe(false);
  });

  it("preserves a legitimate review block while migrating UNKNOWN evidence", () => {
    const finding = {
      id: "code-reviewer-1", agent: "code-reviewer", severity: "critical",
      file: null, line: null, claim: "review blocker",
    };
    const parsed = parseTaskGraph(graph({
      tasks: [{
        ...validTask, review_status: "blocked", findings: [finding],
        critical_findings: [finding.claim], advisory_findings: [],
      }],
      spec_check: captured({
        verdict: "UNKNOWN", critical_count: 1, critical_findings: ["historical blocker"],
      }),
      wave_gates: {
        "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: true },
      },
    }));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.wave_gates["1"]?.blocked).toBe(true);
  });

  it("round-trips a non-empty manual override source", () => {
    const source = { kind: "manual-override", reason: "operator accepted false-positive" };
    const parsed = parseTaskGraph(graph({ spec_check: captured({ evidence_source: source }) }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.spec_check).toMatchObject({ evidence_source: source });
  });

  it.each([
    { kind: "manual-override", reason: "  " },
    { kind: "registered", reason: "invented" },
    { kind: "manual-override", reason: "valid", surplus: true },
  ])("refuses malformed evidence source %j", (evidence_source) => {
    expect(errorOf(graph({ spec_check: captured({ evidence_source }) }))).toContain("evidence_source");
  });

  it.each([
    ["PASSED", 1, ["critical"]],
    ["BLOCKED", 0, []],
  ])("refuses contradictory %s/count evidence", (verdict, critical_count, critical_findings) => {
    expect(errorOf(graph({ spec_check: captured({ verdict, critical_count, critical_findings }) })))
      .toContain("spec_check.verdict");
  });
});

// ---------------------------------------------------------------------------
// wave_gates keys are persisted canonical Wave identities
// ---------------------------------------------------------------------------

const waveGateRecord = {
  impl_complete: false,
  tests_passed: null,
  reviews_complete: false,
  blocked: false,
} as const;

describe("parseTaskGraph safe generation and Wave boundaries", () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;

  it.each([
    ["Task Wave", { tasks: [{ ...validTask, wave: unsafe }] }],
    ["current Wave", { current_wave: unsafe }],
    ["Wave review epoch", { wave_review_epoch: waveReviewEpoch({ wave: unsafe }) }],
    ["active Wave Gate", { current_wave: unsafe, active_wave_gate: activeWaveGate({ wave: unsafe }) }],
    ["completed Wave history", { wave_gate_history: [completedEntry({ wave: unsafe })] }],
  ])("rejects an unsafe %s", (_label, fields) => {
    expect(errorOf(graph(fields))).toMatch(/safe|wave_review_epoch/u);
  });

  it("preserves the exact safe Wave diagnostic through the shared integer-bound parser", () => {
    expect(errorOf(graph({ wave_review_epoch: waveReviewEpoch({ wave: 0 }) }))).toBe(
      "wave_review_epoch.wave must be an integer >= 1 within the safe-integer range",
    );
  });

  it("rejects unsafe Task and accepted-authority review generations", () => {
    expect(errorOf(graph({ tasks: [{ ...validTask, review_generation: unsafe }] }))).toContain("safe integer");
    expect(errorOf(graph({ tasks: [{
      ...validTask,
      accepted_review_authority: {
        generation: unsafe,
        packet_id: PACKET,
        head_sha: HEAD,
        scope: ["src/x.ts"],
      },
    }] }))).toContain("accepted_review_authority");
  });

  it("models Accepted Review Run authority as all-or-none and preserves both persisted variants", () => {
    const legacy: AcceptedReviewAuthority = {
      generation: 1,
      packet_id: PACKET,
      head_sha: HEAD,
      scope: ["src/x.ts"],
    };
    const runBound: AcceptedReviewAuthority = {
      ...legacy,
      run_id: "run.wave",
      authority_digest: DIGEST("a"),
    };
    // @ts-expect-error run_id cannot exist without authority_digest.
    const partialRun: AcceptedReviewAuthority = { ...legacy, run_id: "run.wave" };
    // @ts-expect-error authority_digest cannot exist without run_id.
    const partialDigest: AcceptedReviewAuthority = { ...legacy, authority_digest: DIGEST("a") };

    expect(parseTaskGraph(graph({ tasks: [{ ...validTask, accepted_review_authority: legacy }] })).ok).toBe(true);
    expect(parseTaskGraph(graph({ tasks: [{ ...validTask, accepted_review_authority: runBound }] })).ok).toBe(true);
    expect(errorOf(graph({ tasks: [{ ...validTask, accepted_review_authority: partialRun }] })))
      .toContain("run authority must be complete and valid when present");
    expect(errorOf(graph({ tasks: [{ ...validTask, accepted_review_authority: partialDigest }] })))
      .toContain("run authority must be complete and valid when present");
  });

  it.each([
    ["workspace_scope", {
      workspace_head_sha: DIGEST("b"),
      wave_gate_run_id: "run.wave",
      wave_gate_authority_digest: DIGEST("a"),
    }],
    ["workspace_head_sha", {
      workspace_scope: ["src/x.ts"],
      wave_gate_run_id: "run.wave",
      wave_gate_authority_digest: DIGEST("a"),
    }],
    ["wave_gate_run_id", {
      workspace_scope: ["src/x.ts"],
      workspace_head_sha: DIGEST("b"),
      wave_gate_authority_digest: DIGEST("a"),
    }],
    ["wave_gate_authority_digest", {
      workspace_scope: ["src/x.ts"],
      workspace_head_sha: DIGEST("b"),
      wave_gate_run_id: "run.wave",
    }],
  ] as const)(
    "rejects complete Review Run workspace authority minus %s",
    (_omitted, partial) => {
      expect(errorOf(graph({
        tasks: [reviewedTask({ review_run: { ...reviewedTask().review_run, ...partial } })],
      }))).toContain("workspace");
    },
  );
});

describe("parseTaskGraph wave_gates load boundary", () => {
  it("accepts canonical positive integer keys (String(wave))", () => {
    expect(parseTaskGraph(graph({ wave_gates: { "1": waveGateRecord } })).ok).toBe(true);
  });

  it("rejects non-canonical wave_gates keys — even when the gate value is valid", () => {
    for (const wave of ["01", "abc", "-1", "1.0", "0", "1e2", String(Number.MAX_SAFE_INTEGER + 1)]) {
      const err = errorOf(graph({ wave_gates: { [wave]: waveGateRecord } }));
      expect(err).toContain("wave_gates key must be a canonical positive safe-integer wave number");
    }
  });

  it.each([
    ["impl_complete", "yes"],
    ["tests_passed", "yes"],
    ["reviews_complete", "no"],
    ["blocked", 1],
  ])("rejects malformed persisted %s before gate booleans can be consumed", (field, value) => {
    const err = errorOf(graph({ wave_gates: { "1": { ...waveGateRecord, [field]: value } } }));
    expect(err).toContain(`wave_gates["1"]: ${field}`);
  });

  it("rejects blocked:true when neither Task findings nor Spec-check findings supply a cause", () => {
    const err = errorOf(graph({ wave_gates: { "1": { ...waveGateRecord, blocked: true } } }));
    expect(err).toContain("blocked: true has no cause");
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

describe("StateManager byte decoding", () => {
  it("rejects malformed UTF-8 before attempting JSON parsing", () => {
    const root = canonicalTempDir("loom-invalid-state-utf8-");
    const stateDirectory = join(root, ".claude", "state");
    const statePath = join(stateDirectory, "active_task_graph.json");
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(statePath, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
    try {
      expect(() => new StateManager(statePath).load()).toThrow(/invalid UTF-8/u);
      expect(() => new StateManager(statePath).load()).not.toThrow(/invalid JSON/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
