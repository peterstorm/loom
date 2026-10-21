/**
 * I6 in proof: the `red-then-green` obligation, its failure and evidence
 * variants, their parsers, the receipt failure kind settlement mints, and the
 * I6-era derivation (INV-6) through every derivation site T7 wires:
 * population, the State File obligation-match check, and revalidation.
 *
 * The era rows are the INV-6 matrix rows: (a)–(d) the four post-feature
 * freeze cases, (e) a pre-feature frozen manifest and (f) a pre-feature graph
 * carrying no `verification_manifest`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  TASK_BYTE_SCOPE_CHECK_ID_TEXT,
  createImplementationAttemptAuthority,
  createTaskCompletionSuiteAuthority,
  settleImplementationAttempt,
} from "../../src/core/implementation-completion";
import {
  deriveProofObligations,
  derivePendingTaskProof,
  evaluateProofObligations,
  parseObservedProofEvidence,
  parseProofEvidence,
  parseProofFailure,
  parseProofObligation,
  parseTaskProof,
  redThenGreenEra,
  redThenGreenScope,
  taskRedThenGreenEra,
  TRUSTED_LEDGER_ONLY_POLICY,
  type ObservedProofEvidence,
  type ProofObligation,
  type RedThenGreenEra,
  type RedThenGreenScope,
} from "../../src/core/proof-obligations";
import type { RedThenGreenGap, RedThenGreenObservation } from "../../src/core/red-then-green-types";
import {
  parseAuthoredTaskRoster,
  populateTaskGraph,
  type AuthoredTask,
} from "../../src/core/task-graph-population";
import { returnToRevalidation } from "../../src/core/task-revalidation";
import {
  defaultVerificationManifest,
  freezeVerificationManifest,
  legacyDefaultVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import { parseVerificationPolicy, type VerificationPolicy } from "../../src/core/verification-policy";
import { parseTaskGraph, taskUnionError } from "../../src/state-file-wire";
import type { Task, TaskGraph } from "../../src/types";

// --- Fixtures ---

const TEST_FILE = "tests/ledger.test.ts";
const IMPL_FILE = "src/ledger.ts";

function policy(newTests: "required" | "claimant" | "existing-tests-sufficient"): VerificationPolicy {
  const parsed = parseVerificationPolicy({
    regression: { kind: "required" },
    new_tests: newTests === "required"
      ? { kind: "required" }
      : { kind: "waived", reason: newTests === "claimant" ? "covered-by-acceptance-contract" : newTests },
  }, "policy");
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
}

const kinds = (obligations: readonly ProofObligation[]): readonly string[] => obligations.map(({ kind }) => kind);

const SHOWN: RedThenGreenObservation = Object.freeze({
  kind: "shown",
  red: Object.freeze({ index: 1, command: "npm test -- tests/ledger.test.ts" }),
  implementationWrite: IMPL_FILE,
  green: Object.freeze({ index: 3, command: "npm test" }),
});

const ALL_GAPS: readonly RedThenGreenGap[] = [
  { kind: "no-test-files" },
  { kind: "implementation-write-missing" },
  { kind: "red-missing", untrustedOnly: false },
  { kind: "red-missing", untrustedOnly: true },
  { kind: "red-after-first-implementation-write" },
  { kind: "green-missing", untrustedOnly: false },
  { kind: "green-missing", untrustedOnly: true },
  { kind: "ledger-unavailable" },
];

const observed = (redThenGreen?: RedThenGreenObservation): ObservedProofEvidence => ({
  taskCompleted: true,
  testResult: { verdict: "trusted-pass" },
  filesModified: [TEST_FILE, IMPL_FILE],
  newTestsWritten: true,
  newTestEvidence: "new tests",
  ...(redThenGreen === undefined ? {} : { redThenGreen }),
});

const i6Obligations = () => deriveProofObligations({
  verificationPolicy: policy("required"),
  declaredArtifacts: [TEST_FILE, IMPL_FILE],
  redThenGreen: "owed-if-new-tests",
});

// --- Era rows ---

function fromSource(document: Readonly<Record<string, unknown>>): FrozenVerificationManifest {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    kind: "loom-verification-manifest", checks: [], ...document,
  })));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return frozen.value;
}

type EraRow = Readonly<{ row: string; manifest: () => FrozenVerificationManifest | undefined; era: RedThenGreenEra }>;

const ERA_ROWS: readonly EraRow[] = [
  {
    row: "(a) an operator schema-2 manifest with testFileSuffixes",
    manifest: () => fromSource({ schemaVersion: 2, testFileSuffixes: [".test.ts"] }),
    era: "owed-if-new-tests",
  },
  { row: "(b) an operator schema-2 manifest without testFileSuffixes", manifest: () => fromSource({ schemaVersion: 2 }), era: "owed-if-new-tests" },
  { row: "(c) an operator schema-1 manifest", manifest: () => fromSource({ schemaVersion: 1 }), era: "owed-if-new-tests" },
  { row: "(d) no manifest file (defaultVerificationManifest())", manifest: () => defaultVerificationManifest(), era: "owed-if-new-tests" },
  { row: "(e) a pre-feature frozen manifest", manifest: () => legacyDefaultVerificationManifest(), era: "not-owed" },
  { row: "(f) a pre-feature graph with no verification_manifest", manifest: () => undefined, era: "not-owed" },
];

function authoredTask(id: string, newTests: "required" | "claimant" | "existing-tests-sufficient"): AuthoredTask {
  return {
    id,
    description: `implement ${id}`,
    agent: "code-implementer-agent",
    wave: 1,
    depends_on: [],
    spec_anchors: [],
    spec_contributions: [],
    verification_policy: {
      regression: { kind: "required" },
      new_tests: newTests === "required"
        ? { kind: "required" }
        : { kind: "waived", reason: newTests === "claimant" ? "covered-by-acceptance-contract" : newTests },
    },
    file_list: [`src/${id}.ts`, `tests/${id}.test.ts`],
  };
}

const TASKS = [authoredTask("T1", "required"), authoredTask("T2", "claimant"), authoredTask("T3", "existing-tests-sufficient")];

/** Population under `manifest`; row (f) is row (e)'s graph with its frozen manifest removed. */
function populated(manifest: FrozenVerificationManifest | undefined): TaskGraph {
  const roster = parseAuthoredTaskRoster(TASKS);
  if (!roster.ok) throw new Error(`roster refused: ${roster.error}`);
  const result = populateTaskGraph(
    {
      current_phase: "decompose",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: "plan.md",
      tasks: [],
      wave_gates: {},
    },
    {
      planTitle: "Era plan",
      validatedPlanFile: "plan.md",
      tasks: roster.value,
      verificationManifest: manifest ?? legacyDefaultVerificationManifest(),
      specIndex: { kind: "unavailable", reason: { kind: "no-spec-file" } },
      observedSpecFile: null,
      force: false,
      proofBoundary: { kind: "absent", cause: "fixture: no Git repository root" },
      contracts: [],
    },
  );
  if (!result.ok) throw new Error(`population refused: ${result.error.message}`);
  if (manifest !== undefined) return result.value.state;
  const { verification_manifest: _dropped, ...unfrozen } = result.value.state;
  return unfrozen;
}

const wire = (graph: TaskGraph): Record<string, unknown> => JSON.parse(JSON.stringify(graph));

const taskOf = (graph: TaskGraph, id: string): Task => {
  const task = graph.tasks.find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`no ${id}`);
  return task;
};

const expectedObligationKinds = (era: RedThenGreenEra): Readonly<Record<string, readonly string[]>> => ({
  T1: [
    "task-completed", "regression-test-pass", "new-tests",
    ...(era === "owed-if-new-tests" ? ["red-then-green"] : []),
    "declared-artifact-changed", "declared-artifact-changed",
  ],
  T2: ["task-completed", "regression-test-pass", "declared-artifact-changed", "declared-artifact-changed"],
  T3: ["task-completed", "regression-test-pass", "declared-artifact-changed", "declared-artifact-changed"],
});

// --- Tests ---

describe("redThenGreenEra (INV-6 owner)", () => {
  it.each(ERA_ROWS)("FR-005: $row reads as $era", ({ manifest, era }) => {
    expect(redThenGreenEra(manifest())).toBe(era);
  });
});

describe("taskRedThenGreenEra (contract writers do not owe I6)", () => {
  const ERAS: readonly RedThenGreenEra[] = ["owed-if-new-tests", "not-owed"];
  const scopeOf = (era: RedThenGreenEra, writers: readonly string[]): RedThenGreenScope =>
    ({ era, contractWriters: new Set(writers) });

  it.each<[string, RedThenGreenEra, readonly string[], string, RedThenGreenEra]>([
    ["a writer in an I6-era graph", "owed-if-new-tests", ["T1"], "T1", "not-owed"],
    ["a non-writer in an I6-era graph", "owed-if-new-tests", ["T1"], "T2", "owed-if-new-tests"],
    ["any Task in an I6-era graph with no contracts", "owed-if-new-tests", [], "T1", "owed-if-new-tests"],
    ["a writer in a pre-I6 graph", "not-owed", ["T1"], "T1", "not-owed"],
    ["a non-writer in a pre-I6 graph", "not-owed", ["T1"], "T2", "not-owed"],
  ])("%s reads as the expected era", (_row, era, writers, taskId, expected) => {
    expect(taskRedThenGreenEra(scopeOf(era, writers), taskId)).toBe(expected);
  });

  it("redThenGreenScope takes the era from the manifest and the writers from the contracts", () => {
    const scope = redThenGreenScope(defaultVerificationManifest(), [{ contractTask: "T1" }, { contractTask: "T4" }]);
    expect(scope.era).toBe("owed-if-new-tests");
    expect([...scope.contractWriters].sort()).toEqual(["T1", "T4"]);
    expect(redThenGreenScope(undefined, [{ contractTask: "T1" }]).era).toBe("not-owed");
  });

  const taskIds = fc.integer({ min: 1, max: 12 }).map((n) => `T${n}`);
  const scopes = fc.record({
    era: fc.constantFrom(...ERAS),
    writers: fc.uniqueArray(taskIds, { maxLength: 6 }),
  });

  it("is not-owed exactly when the Task writes a contract or the graph's era is not-owed", () => {
    fc.assert(fc.property(scopes, taskIds, ({ era, writers }, taskId) => {
      const result = taskRedThenGreenEra(scopeOf(era, writers), taskId);
      expect(result === "not-owed").toBe(writers.includes(taskId) || era === "not-owed");
    }));
  });

  it("never derives red-then-green for a contract writer, whatever its policy", () => {
    const policies = fc.constantFrom("required" as const, "claimant" as const, "existing-tests-sufficient" as const);
    fc.assert(fc.property(scopes, policies, ({ era, writers }, newTests) => {
      for (const writer of writers) {
        expect(kinds(deriveProofObligations({
          verificationPolicy: policy(newTests),
          declaredArtifacts: [IMPL_FILE],
          redThenGreen: taskRedThenGreenEra(scopeOf(era, writers), writer),
        }))).not.toContain("red-then-green");
      }
    }));
  });
});

describe("deriveProofObligations with the I6 era", () => {
  it("FR-005: red-then-green is owed exactly when the era owes it and the policy requires new tests", () => {
    for (const era of ["owed-if-new-tests", "not-owed"] as const) {
      for (const newTests of ["required", "claimant", "existing-tests-sufficient"] as const) {
        const derived = kinds(deriveProofObligations({
          verificationPolicy: policy(newTests),
          declaredArtifacts: [IMPL_FILE],
          redThenGreen: era,
        }));
        expect(derived.includes("red-then-green")).toBe(era === "owed-if-new-tests" && newTests === "required");
      }
    }
  });

  it("FR-010: a claimant (covered-by-acceptance-contract) never owes red-then-green", () => {
    expect(kinds(deriveProofObligations({
      verificationPolicy: policy("claimant"),
      declaredArtifacts: [IMPL_FILE],
      redThenGreen: "owed-if-new-tests",
    }))).not.toContain("red-then-green");
  });

  it("FR-005: red-then-green follows new-tests and precedes the declared artifacts", () => {
    expect(kinds(i6Obligations())).toEqual([
      "task-completed", "regression-test-pass", "new-tests", "red-then-green",
      "declared-artifact-changed", "declared-artifact-changed",
    ]);
  });

  it("FR-005: an input without an era (every pre-feature caller) derives exactly what it derived before", () => {
    const before = deriveProofObligations({ verificationPolicy: policy("required"), declaredArtifacts: [IMPL_FILE] });
    expect(kinds(before)).not.toContain("red-then-green");
    expect(deriveProofObligations({ newTestsRequired: true, declaredArtifacts: [IMPL_FILE], redThenGreen: "owed-if-new-tests" }))
      .toContainEqual({ kind: "red-then-green" });
    expect(kinds(deriveProofObligations({ newTestsRequired: true, declaredArtifacts: [IMPL_FILE] })))
      .not.toContain("red-then-green");
  });
});

describe("evaluating the red-then-green obligation", () => {
  it("AS-005: a shown observation satisfies it with the three facts as evidence", () => {
    const proof = evaluateProofObligations(i6Obligations(), observed(SHOWN));
    expect(proof.state).toBe("satisfied");
    if (proof.state !== "satisfied") return;
    expect(proof.evidence).toContainEqual({
      kind: "red-then-green", red: SHOWN.red, implementationWrite: IMPL_FILE, green: SHOWN.green,
    });
  });

  it.each(ALL_GAPS.filter(({ kind }) => kind !== "ledger-unavailable"))("FR-009: an unproven $kind gap fails it naming that gap", (gap) => {
    const proof = evaluateProofObligations(i6Obligations(), observed({ kind: "unproven", gap }));
    expect(proof.state).toBe("failed");
    if (proof.state !== "failed") return;
    expect(proof.failures).toEqual([{ kind: "red-then-green-unproven", gap }]);
  });

  it("FR-009: a missing observation fails it as ledger-unavailable", () => {
    const proof = evaluateProofObligations(i6Obligations(), observed());
    expect(proof.state === "failed" ? proof.failures : []).toEqual([
      { kind: "red-then-green-unproven", gap: { kind: "ledger-unavailable" } },
    ]);
  });

  it("FR-005: an observation reaching a Task that does not owe I6 changes nothing", () => {
    const obligations = deriveProofObligations({ verificationPolicy: policy("required"), declaredArtifacts: [IMPL_FILE] });
    const proof = evaluateProofObligations(obligations, {
      ...observed({ kind: "unproven", gap: { kind: "red-missing", untrustedOnly: false } }),
      filesModified: [IMPL_FILE],
    });
    expect(proof.state).toBe("satisfied");
  });
});

describe("parsing the red-then-green variants", () => {
  it("parses the obligation and refuses surplus fields", () => {
    expect(parseProofObligation({ kind: "red-then-green" })).toEqual({ ok: true, value: { kind: "red-then-green" } });
    expect(parseProofObligation({ kind: "red-then-green", artifact: "x" }).ok).toBe(false);
  });

  it.each(ALL_GAPS)("round-trips the $kind failure", (gap) => {
    const failure = { kind: "red-then-green-unproven", gap };
    expect(parseProofFailure(JSON.parse(JSON.stringify(failure)))).toEqual({ ok: true, value: failure });
  });

  it("refuses malformed gaps", () => {
    for (const gap of [
      undefined,
      { kind: "red-missing" },
      { kind: "red-missing", untrustedOnly: "yes" },
      { kind: "no-test-files", untrustedOnly: false },
      { kind: "green-late" },
    ]) {
      expect(parseProofFailure({ kind: "red-then-green-unproven", gap }).ok, JSON.stringify(gap)).toBe(false);
    }
  });

  it("round-trips the evidence and refuses malformed run references", () => {
    const evidence = { kind: "red-then-green", red: SHOWN.red, implementationWrite: IMPL_FILE, green: SHOWN.green };
    expect(parseProofEvidence(JSON.parse(JSON.stringify(evidence)))).toEqual({ ok: true, value: evidence });
    for (const broken of [
      { ...evidence, red: { index: -1, command: "x" } },
      { ...evidence, green: { index: 1.5, command: "x" } },
      { ...evidence, green: { index: 3 } },
      { ...evidence, implementationWrite: "" },
      { ...evidence, red: { index: 1, command: "x", extra: true } },
      { ...evidence, red: { index: 3, command: "x" }, green: { index: 3, command: "y" } },
    ]) {
      expect(parseProofEvidence(broken).ok, JSON.stringify(broken)).toBe(false);
    }
  });

  it("round-trips satisfied and failed proofs, and refuses a result whose payload belongs to another obligation", () => {
    const satisfied = evaluateProofObligations(i6Obligations(), observed(SHOWN));
    const failed = evaluateProofObligations(i6Obligations(), observed({ kind: "unproven", gap: { kind: "red-missing", untrustedOnly: true } }));
    for (const proof of [satisfied, failed]) {
      expect(parseTaskProof(JSON.parse(JSON.stringify(proof)))).toEqual({ ok: true, value: proof });
    }
    const crossed = JSON.parse(JSON.stringify(failed));
    const index = crossed.results.findIndex((result: { obligation: { kind: string } }) => result.obligation.kind === "red-then-green");
    crossed.results[index].failure = { kind: "new-tests-not-observed" };
    crossed.failures = [{ kind: "new-tests-not-observed" }];
    expect(parseTaskProof(crossed).ok).toBe(false);
  });

  it("admits redThenGreen in observed proof evidence and refuses a malformed one", () => {
    const raw = JSON.parse(JSON.stringify(observed(SHOWN)));
    expect(parseObservedProofEvidence(raw)).toEqual({ ok: true, value: observed(SHOWN) });
    expect(parseObservedProofEvidence({ ...raw, redThenGreen: { kind: "unproven", gap: { kind: "unknown" } } }).ok).toBe(false);
    expect(parseObservedProofEvidence({ ...raw, redThenGreen: { kind: "shown" } }).ok).toBe(false);
    const { redThenGreen: _omitted, ...absent } = raw;
    expect(parseObservedProofEvidence(absent)).toMatchObject({ ok: true, value: { taskCompleted: true } });
  });
});

describe("settlement mints proof:red-then-green-unproven:<gap>", () => {
  function settle(redThenGreen: RedThenGreenObservation | undefined) {
    const authority = createImplementationAttemptAuthority({
      taskId: "T1",
      wave: 1,
      semanticAttempt: 1,
      reservationId: "i6-attempt",
      headSha: "a".repeat(40),
      reservedAt: "2026-10-16T00:00:00.000Z",
      taskScopeBaseline: [],
      dirtySetBaseline: [],
    });
    if (!authority.ok) throw new Error(authority.error.errors.join("; "));
    const suite = createTaskCompletionSuiteAuthority(authority.value);
    if (!suite.ok) throw new Error(suite.error.errors.join("; "));
    return settleImplementationAttempt({
      id: "T1",
      status: "pending",
      proof: derivePendingTaskProof({
        verificationPolicy: policy("required"),
        declaredArtifacts: [],
        redThenGreen: "owed-if-new-tests",
      }),
      active_implementation_attempt: authority.value,
      implementation_attempt_history: [],
    }, authority.value, authority.value, {
      schemaVersion: 1,
      kind: "implementation-observed",
      observedAt: "2026-10-16T00:01:00.000Z",
      evidence: JSON.parse(JSON.stringify({ ...observed(redThenGreen), filesModified: [] })),
      proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
    }, {
      schemaVersion: 1,
      kind: "task-completion-suite-result",
      implementationAuthorityDigest: suite.value.implementationAuthorityDigest,
      suiteDigest: suite.value.suiteDigest,
      checks: [{ checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT, scope: "task", outcome: { kind: "accepted", changedPaths: [] } }],
    });
  }

  it.each(ALL_GAPS.filter(({ kind }) => kind !== "ledger-unavailable"))("FR-009: the $kind gap mints its own receipt failure kind and retries", (gap) => {
    const result = settle({ kind: "unproven", gap });
    expect(result).toMatchObject({
      ok: true,
      value: { kind: "retry-required", receipt: { failureKinds: [`proof:red-then-green-unproven:${gap.kind}`] } },
    });
  });

  it("FR-009: no observation mints the ledger-unavailable kind", () => {
    expect(settle(undefined)).toMatchObject({
      ok: true,
      value: { kind: "retry-required", receipt: { failureKinds: ["proof:red-then-green-unproven:ledger-unavailable"] } },
    });
  });

  it("AS-005: a shown observation implements the Task", () => {
    expect(settle(SHOWN)).toMatchObject({ ok: true, value: { kind: "implemented", receipt: { failureKinds: [] } } });
  });
});

describe("INV-6: every derivation site agrees with redThenGreenEra", () => {
  it.each(ERA_ROWS)("FR-005 / FR-010: population derives the $era obligations for $row", ({ manifest, era }) => {
    const graph = populated(manifest());
    for (const [id, expected] of Object.entries(expectedObligationKinds(era))) {
      expect(kinds(taskOf(graph, id).proof?.obligations ?? []), id).toEqual(expected);
    }
  });

  it.each(ERA_ROWS)("FR-005: the State File obligation-match check accepts the populated graph for $row", ({ manifest }) => {
    const parsed = parseTaskGraph(wire(populated(manifest())));
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
  });

  it.each(ERA_ROWS)("FR-005: the State File check refuses obligations of the other era for $row", ({ manifest, era }) => {
    const raw = wire(populated(manifest()));
    const tasks = raw.tasks as Array<Record<string, unknown>>;
    const t1 = tasks.find((task) => task.id === "T1")!;
    const proof = t1.proof as { obligations: Array<{ kind: string }>; results: Array<{ obligation: { kind: string } }> };
    if (era === "owed-if-new-tests") {
      proof.obligations = proof.obligations.filter(({ kind }) => kind !== "red-then-green");
      proof.results = proof.results.filter(({ obligation }) => obligation.kind !== "red-then-green");
    } else {
      proof.obligations.splice(3, 0, { kind: "red-then-green" });
      proof.results.splice(3, 0, { state: "pending", obligation: { kind: "red-then-green" } } as never);
    }
    const parsed = parseTaskGraph(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("proof obligations do not exactly match");
  });

  describe("taskUnionError holds the exact era it is given", () => {
    const ERAS: readonly RedThenGreenEra[] = ["owed-if-new-tests", "not-owed"];
    const otherEra = (era: RedThenGreenEra): RedThenGreenEra => era === "owed-if-new-tests" ? "not-owed" : "owed-if-new-tests";
    /** No contracts: every Task takes the graph's era. */
    const scope = (era: RedThenGreenEra): RedThenGreenScope => ({ era, contractWriters: new Set() });
    const wiredT1 = (era: RedThenGreenEra): Record<string, unknown> => {
      const row = ERA_ROWS.find((candidate) => candidate.era === era)!;
      const task = (wire(populated(row.manifest())).tasks as Array<Record<string, unknown>>).find((t) => t.id === "T1");
      if (task === undefined) throw new Error("no T1");
      return task;
    };

    it.each(ERAS)("FR-005: accepts a Task carrying exactly the %s obligations under that era", (era) => {
      expect(taskUnionError(wiredT1(era), 0, scope(era))).toBeNull();
    });

    it.each(ERAS)("FR-005: refuses the %s obligations under the other era", (era) => {
      expect(taskUnionError(wiredT1(era), 0, scope(otherEra(era)))).toContain("proof obligations do not exactly match");
    });

    it("refuses T1's I6-era obligations once T1 writes a contract, and accepts the writer era's", () => {
      const writerScope: RedThenGreenScope = { era: "owed-if-new-tests", contractWriters: new Set(["T1"]) };
      expect(taskUnionError(wiredT1("owed-if-new-tests"), 0, writerScope)).toContain("proof obligations do not exactly match");
      expect(taskUnionError(wiredT1("not-owed"), 0, writerScope)).toBeNull();
    });

    it.each(ERAS)("FR-005: refuses obligations that match neither era, under %s", (era) => {
      const task = wiredT1("owed-if-new-tests");
      const proof = task.proof as { obligations: Array<{ kind: string }>; results: Array<{ obligation: { kind: string } }> };
      // Without `new-tests` the set is neither era's derivation for a Task requiring new tests.
      proof.obligations = proof.obligations.filter(({ kind }) => kind !== "new-tests");
      proof.results = proof.results.filter(({ obligation }) => obligation.kind !== "new-tests");
      expect(taskUnionError(task, 0, scope(era))).toContain("proof obligations do not exactly match");
    });
  });

  it.each(ERA_ROWS)("FR-005: the State File migration derives a proof-less pending Task's obligations under $row's era", ({ manifest, era }) => {
    const raw = wire(populated(manifest()));
    const tasks = raw.tasks as Array<Record<string, unknown>>;
    delete tasks.find((task) => task.id === "T1")!.proof;
    const parsed = parseTaskGraph(raw);
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    if (!parsed.ok) return;
    const migrated = (parsed.value as unknown as TaskGraph).tasks.find((task) => task.id === "T1");
    expect(kinds(migrated?.proof?.obligations ?? [])).toEqual(expectedObligationKinds(era).T1);
  });

  it.each(ERA_ROWS)("FR-005: revalidation re-derives a proof-less Task's obligations under $row's era", ({ manifest, era }) => {
    const frozen = manifest();
    const graph = populated(frozen);
    for (const [id, expected] of Object.entries(expectedObligationKinds(era))) {
      const { proof: _cleared, status: _status, revalidation_required: _marker, ...metadata } = taskOf(graph, id);
      const legacy: Task = { ...metadata, status: "completed", legacy_missing_proof: true };
      const revalidated = returnToRevalidation(legacy, frozen);
      expect(kinds(revalidated.proof?.obligations ?? []), id).toEqual(expected);
      // A Task that still holds its Proof keeps it exactly.
      expect(returnToRevalidation(taskOf(graph, id), frozen).proof).toEqual(taskOf(graph, id).proof);
    }
  });
});
