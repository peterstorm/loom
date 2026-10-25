/**
 * INV-3 matrix: which owned Invariants a Wave or Task owes is decided only by
 * `core/owner-verification/obligations.ts`.
 *
 * Owner rows (T4): the Wave scope (`ownerVerificationOwed`, owner or
 * sibling: G5a's `changesFamily`) against the touch scope
 * (`obligationsTouchedBy`, any role) over owner-only, sibling-only,
 * matrix-only and unrelated file lists; and an absent against an empty
 * `owner_obligations` stamp through `ownerVerificationOwed` and
 * `ownerCheckAuthority`. Every selection reads the opaque `OwnerScope`
 * `ownerScopeOf` builds, never the raw stamp.
 *
 * Sibling rows (T9): `wave-review-authority.ts` issues the owner map, and
 * `implementation-brief.ts` renders the duty paragraphs, for exactly the
 * obligations `obligationsTouchedBy` selects, over the same file-list shapes,
 * and neither issues anything over an unstamped graph.
 *
 * Sibling rows (T10, PR #131): `owner-verification/suite-authority.ts`, the
 * one authorize-from-TaskGraph function the gate helper and readiness share,
 * authorizes the `loom:owner-verification` check with exactly the ids
 * `ownerVerificationOwed` selects (the gate scope);
 * `wave-completion-suite-readiness.ts` accepts, and the State File wire
 * (`state-file-wire.ts`) loads, exactly the receipt authorized under
 * `ownerCheckAuthority`, over the same file-list shapes; an unstamped graph
 * carries no owner check in any of them.
 *
 * Sibling rows (PR #131): `handlers/helpers/wave-completion-suite.ts` hands
 * the runner exactly the `ownerVerificationOwed` obligations and the authorized
 * check, and skips it when none are owed; `owner-verification-runner.ts`
 * needs an `affectedRunner` exactly when `verifyOwed` selects some
 * obligation; `owner-verification/plan-integrity.ts` blocks on exactly the
 * stamps `stampAgreement` does not find in agreement.
 *
 * Sibling row (PR #131): `task-graph-population.ts` refuses a manifest
 * without an `affectedRunner` exactly when `verifyOwed` selects some
 * obligation to owe mutation.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  RULE_DOCUMENTS,
  renderImplementationBrief,
  type RuleDocument,
} from "../../src/core/implementation-brief";
import { parseOrchestrationRunId } from "../../src/core/orchestration-contract";
import { OWNER_MAP_SECTION, renderOwnerMapSection } from "../../src/core/owner-verification/owner-map";
import { CURRENT_REVIEWER_PROTOCOL } from "../../src/core/reviewer-contract";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import { prepareWaveReviewBatch } from "../../src/core/wave-review-authority";
import { IMPLEMENTATION_BRIEF_TEMPLATE } from "../../src/orchestration/implementation-brief";
import { observeWaveSpecCheckDocuments } from "../../src/orchestration/wave-spec-check-documents";
import { parseTaskGraph } from "../../src/state-file-wire";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { observedWorkspace } from "../fixtures/reviewed-workspace";
import {
  obligationsAgree,
  obligationsDigest,
  obligationsFromPlan,
  obligationsTouchedBy,
  ownerCheckAuthority,
  ownerScopeOf,
  ownerVerificationOwed,
  stampAgreement,
  verifyOwed,
  type OwnerCheckAuthority,
} from "../../src/core/owner-verification/obligations";
import type { OwnerObligation } from "../../src/core/owner-verification/types";
import { verifiedMutationOf } from "../../src/core/owner-verification/outcome";
import { parsePlanModels } from "../../src/core/parse-plan-models";
import { planModelsIntegrityFailure } from "../../src/core/owner-verification/plan-integrity";
import { emptyAcceptanceExpectation } from "../../src/core/acceptance-contract";
import { evaluateWaveCompletionSuite } from "../../src/core/completion-suite";
import type { ArtifactDigest } from "../../src/core/orchestration-contract";
import {
  authorizeWaveCompletionSuite,
  freezeVerificationManifest,
  legacyDefaultVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import { deriveWaveCompletionSuiteReadiness } from "../../src/core/wave-completion-suite-readiness";
import { authorizeGraphCompletionSuite } from "../../src/core/owner-verification/suite-authority";
import type { ActiveWaveGateRegistration, Task, TaskGraph } from "../../src/types";
import { labelledValue } from "../fixtures/parse-result";
import { buildOwnerVerificationRepo, canonicalRoot, cleanupOwnerVerificationRepos } from "../fixtures/owner-verification-repo";
import { ensureWaveCompletionSuite } from "../../src/handlers/helpers/wave-completion-suite";
import { runOwnerVerification, type OwnerVerificationInput } from "../../src/orchestration/owner-verification-runner";
import { AFFECTED_RUNNER } from "../fixtures/stop-check-runners";
import { parseAuthoredTaskRoster, populateTaskGraph } from "../../src/core/task-graph-population";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";
import { ownerObligation } from "../fixtures/owner-obligation";

const ADMISSION: OwnerObligation = ownerObligation({
  invariant: "INV-1",
  title: "Admission is decided only by the owner",
  statement: "Every entry point admits through decide().",
  owner: "src/rules/owner.ts",
  siblings: [
    { path: "src/rules/sibling-a.ts", note: "admits members" },
    { path: "src/rules/sibling-b.ts", note: null },
  ],
  matrixTest: "tests/rules.matrix.test.ts",
  mutation: { kind: "verify" },
});

const FEES: OwnerObligation = ownerObligation({
  invariant: "INV-4",
  title: "Fees are computed only by the fee table",
  statement: null,
  owner: "src/fees/table.ts",
  siblings: [],
  matrixTest: "tests/fees.matrix.test.ts",
  mutation: { kind: "exempt", reason: "generated lookup table" },
});

const OBLIGATIONS = [ADMISSION, FEES] as const;

const task = (id: string, wave: number, fileList: readonly string[]): Task =>
  taskFixture({ id, description: id, agent: "code-implementer-agent", wave, depends_on: [], file_list: fileList });

const graph = (tasks: readonly Task[], stamp?: readonly OwnerObligation[]): TaskGraph => ({
  ...graphFixture(tasks),
  ...(stamp === undefined ? {} : { owner_obligations: stamp }),
});

/** The four file-list shapes against INV-1's family, with each scope's expected decision. */
const ROWS = [
  { name: "owner-only", files: ["src/rules/owner.ts"], wave: true, touched: true },
  { name: "sibling-only", files: ["src/rules/sibling-b.ts"], wave: true, touched: true },
  { name: "matrix-only", files: ["tests/rules.matrix.test.ts"], wave: false, touched: true },
  { name: "unrelated", files: ["src/other.ts", "tests/other.test.ts"], wave: false, touched: false },
] as const;

const WORKSPACE_DIGEST = "c".repeat(64) as ArtifactDigest;

/** A frozen verification manifest with no project checks; `document` adds the schema version and any runner. */
const frozenManifest = (document: Readonly<Record<string, unknown>>): FrozenVerificationManifest =>
  labelledValue("manifest", freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    kind: "loom-verification-manifest", checks: [], ...document,
  }))));

const ids = (obligations: readonly OwnerObligation[]): readonly string[] => obligations.map(({ invariant }) => invariant);

/** The Wave scope of Wave-1 Tasks over the stamp. */
const waveScope = (tasks: readonly Task[], stamp: readonly OwnerObligation[] = OBLIGATIONS): readonly OwnerObligation[] =>
  ownerVerificationOwed(ownerScopeOf(graph(tasks, stamp)), 1);

/** The touch scope of a file list over the stamp. */
const touchScope = (files: readonly string[], stamp: readonly OwnerObligation[] = OBLIGATIONS): readonly OwnerObligation[] =>
  obligationsTouchedBy(ownerScopeOf({ tasks: [], owner_obligations: stamp }), files);

describe("INV-3 owner rows — Wave scope against touch scope", () => {
  it.each(ROWS)("$name: the Wave scope is owner-or-sibling, the touch scope any role", ({ files, wave, touched }) => {
    expect(ids(waveScope([task("T1", 1, files)]))).toEqual(wave ? ["INV-1"] : []);
    expect(ids(touchScope(files))).toEqual(touched ? ["INV-1"] : []);
  });

  it.each(ROWS)("$name: ownerVerificationOwed over a stamped graph is the Wave scope of that Wave's Tasks", ({ files, wave }) => {
    const stamped = graph([task("T1", 2, files), task("T2", 1, ["src/fees/table.ts"])], OBLIGATIONS);
    expect(ids(ownerVerificationOwed(ownerScopeOf(stamped), 2))).toEqual(wave ? ["INV-1"] : []);
    expect(ownerCheckAuthority(ownerScopeOf(stamped), 2)).toEqual({ obligationsDigest: obligationsDigest(OBLIGATIONS), owed: wave ? ["INV-1"] : [] });
  });

  it("a Wave's Tasks are unioned, in plan order, each obligation once", () => {
    const tasks = [task("T1", 1, ["src/fees/table.ts"]), task("T2", 1, ["src/rules/sibling-a.ts", "src/rules/owner.ts"])];
    expect(ids(waveScope(tasks))).toEqual(["INV-1", "INV-4"]);
    expect(ids(touchScope(["tests/fees.matrix.test.ts", "src/rules/owner.ts"]))).toEqual(["INV-1", "INV-4"]);
  });

  it("a Task without a file_list changes and touches nothing", () => {
    const bare = taskFixture({ id: "T1", description: "T1", agent: "code-implementer-agent", wave: 1, depends_on: [] });
    expect(waveScope([bare])).toEqual([]);
    expect(touchScope(bare.file_list ?? [])).toEqual([]);
  });

  it("paths match through the one plan path rule (a leading ./ is the same path)", () => {
    expect(ids(touchScope(["./src/rules/owner.ts"]))).toEqual(["INV-1"]);
  });
});

describe("INV-3 sibling rows — review-packet owner map and brief duties follow obligationsTouchedBy", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  const PLAN_FILE = ".claude/plans/matrix.md";

  /** The owner map the sibling `wave-review-authority.ts` issues to the code-reviewer, or null for none. */
  function packetOwnerMap(files: readonly string[], stamp: readonly OwnerObligation[] | undefined): string | null {
    const root = canonicalTempDir("loom-inv3-matrix-");
    cleanup.push(root);
    mkdirSync(join(root, ".claude", "plans"), { recursive: true });
    writeFileSync(join(root, PLAN_FILE), "# Plan: matrix\n");
    const parsed = parseTaskGraph({
      spec_trace_version: 2, current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: PLAN_FILE, wave_gates: {},
      ...(stamp === undefined ? {} : { owner_obligations: stamp }),
      tasks: [taskFixture({
        id: "T1", description: "Reviewed", agent: "code-implementer-agent", wave: 1, status: "implemented",
        depends_on: [], spec_anchors: [], spec_contributions: [], file_list: [...files], files_modified: [...files],
      })],
    });
    if (!parsed.ok) throw new Error(String(parsed.error));
    const runId = parseOrchestrationRunId("run.inv3-matrix");
    if (!runId.ok) throw new Error(runId.error.message);
    const batch = prepareWaveReviewBatch(
      runId.value,
      { schemaVersion: 2, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL, kind: "wave-gate", input: { wave: 1 }, taskIds: ["T1"], authorityDigest: "a".repeat(64) },
      parsed.value,
      1,
      [observedWorkspace("T1", files, files.map((path) => ({ path, bytes: Buffer.from(`// ${path}\n`) })))],
      observeWaveSpecCheckDocuments({ specFile: null, planFile: PLAN_FILE, projectBoundary: { kind: "state-layout", root } }),
    );
    if (!batch.ok) throw new Error(batch.error.message);
    const index = batch.value.subjects.findIndex(({ role }) => role === "code-reviewer");
    const section = batch.value.packets[index]!.fixedContext.find(({ label }) => label === OWNER_MAP_SECTION);
    return section === undefined ? null : Buffer.from(section.bytes).toString("utf8");
  }

  const TEMPLATE = readFileSync(join(LOOM_PACKAGE_ROOT, IMPLEMENTATION_BRIEF_TEMPLATE), "utf8");
  const RULES: ReadonlyMap<RuleDocument, string> = new Map(RULE_DOCUMENTS.map((name) =>
    [name, readFileSync(join(LOOM_PACKAGE_ROOT, "rules", name), "utf8")] as const));
  const PLAN_INVARIANTS = parsePlanModels([
    "## Invariants", "",
    "### INV-1: Admission is decided only by the owner", "",
    "**Tier:** advisory",
    "**Owner module:** `src/rules/owner.ts`",
    "**Sibling entry points:**",
    "- `src/rules/sibling-a.ts` — admits members",
    "- `src/rules/sibling-b.ts`",
    "**Matrix test:** `tests/rules.matrix.test.ts`",
    "**Statement:** Every entry point admits through decide().", "",
    "### INV-4: Fees are computed only by the fee table", "",
    "**Tier:** advisory",
    "**Owner module:** src/fees/table.ts",
    "**Sibling entry points:** none",
    "**Matrix test:** tests/fees.matrix.test.ts",
    "**Mutation exemption:** generated lookup table", "",
  ].join("\n")).invariants;

  /** The Invariants whose duty paragraph the sibling `implementation-brief.ts` renders, in order. */
  function briefDuties(files: readonly string[], stamp: readonly OwnerObligation[] | undefined): readonly string[] {
    const value = task("T1", 1, files);
    const derivation = deriveTaskImplementationDispatch(value);
    if (derivation.kind !== "dispatch") throw new Error(derivation.kind);
    const rendered = renderImplementationBrief({
      template: TEMPLATE, task: value, dispatch: derivation.dispatch, verificationManifest: undefined,
      planFile: PLAN_FILE, spec: { kind: "unavailable", reason: { kind: "no-spec-file" } }, rules: RULES,
      roster: [], invariants: PLAN_INVARIANTS, contracts: [], repositoryRoot: "/repo", operatorNotes: [],
      ownerScope: ownerScopeOf(stamp === undefined ? { tasks: [] } : { tasks: [], owner_obligations: stamp }),
    });
    if (!rendered.ok) throw new Error(rendered.error.message);
    return [...rendered.value.prompt.matchAll(/\*\*Owner duties \((INV-\d+)\):\*\*/g)].map((match) => match[1]!);
  }

  it.each(ROWS)("$name: wave-review-authority issues the owner map of exactly the touch scope", ({ files }) => {
    const touched = touchScope(files);
    const [first, ...rest] = touched;
    expect(packetOwnerMap(files, OBLIGATIONS))
      .toBe(first === undefined ? null : renderOwnerMapSection(PLAN_FILE, [first, ...rest]));
  });

  it.each(ROWS)("$name: implementation-brief renders duties for exactly the touch scope", ({ files }) => {
    expect(briefDuties(files, OBLIGATIONS)).toEqual(ids(touchScope(files)));
  });

  it.each(ROWS)("$name: an absent stamp gives neither sibling anything to issue", ({ files }) => {
    expect(packetOwnerMap(files, undefined)).toBeNull();
    expect(briefDuties(files, undefined)).toEqual([]);
  });

  it("both siblings union every touched obligation, in stamp order", () => {
    const files = ["tests/fees.matrix.test.ts", "src/rules/owner.ts"];
    expect(packetOwnerMap(files, OBLIGATIONS)).toBe(renderOwnerMapSection(PLAN_FILE, [ADMISSION, FEES]));
    expect(briefDuties(files, OBLIGATIONS)).toEqual(["INV-1", "INV-4"]);
  });
});

describe("INV-3 sibling rows — suite authorization, readiness and the State File wire follow ownerCheckAuthority", () => {
  const MANIFEST = frozenManifest({ schemaVersion: 1 });
  const WORKSPACE = "b".repeat(64) as ArtifactDigest;
  const ACTIVE: ActiveWaveGateRegistration = {
    schemaVersion: 1, kind: "active-wave-gate", runId: "run.inv3-suite" as ActiveWaveGateRegistration["runId"],
    wave: 1, authorityDigest: "a".repeat(64) as ArtifactDigest, revision: 0, terminalOutcome: null,
  };

  const suiteGraph = (files: readonly string[], stamp: readonly OwnerObligation[] | undefined): TaskGraph => ({
    ...graph([task("T1", 1, files), task("T2", 2, ["src/fees/table.ts"])], stamp),
    verification_manifest: MANIFEST,
    active_wave_gate: ACTIVE,
  });

  /** The owner check the sibling `suite-authority.ts` authorizes for the graph's Wave, or null for none. */
  function gateOwnerCheck(value: TaskGraph) {
    const suite = labelledValue("gate suite", authorizeGraphCompletionSuite(value, WORKSPACE));
    return suite.checks.find((check) => check.kind === "engine-owner-verification") ?? null;
  }

  /** An accepted receipt minted under `owner`, whose observation verifies exactly `owner.owed`. */
  function receiptUnder(owner: OwnerCheckAuthority | null, manifest: FrozenVerificationManifest = MANIFEST) {
    const suite = labelledValue("suite", authorizeWaveCompletionSuite(manifest, ACTIVE, WORKSPACE, owner));
    const unchanged = labelledValue("unchanged run", verifiedMutationOf({
      killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: 0, ownerChangedInWave: false,
    }));
    const evaluation = evaluateWaveCompletionSuite(suite, {
      kind: "wave-completion-suite-result",
      runId: suite.runId, wave: suite.wave, revision: suite.revision, authorityDigest: suite.authorityDigest,
      manifestDigest: suite.manifestDigest, suiteDigest: suite.suiteDigest, workspaceDigest: suite.workspaceDigest,
      checks: suite.checks.map(({ checkId }) => ({
        checkId, scope: "wave",
        outcome: { kind: "observed", exitCode: 0, timedOut: false, signal: null, report: { kind: "not-required" } },
      })),
      ...(owner === null ? {} : {
        ownerVerification: {
          kind: "verified", obligationsDigest: owner.obligationsDigest, boundMs: 0,
          verdicts: owner.owed.map((invariant) => ({
            invariant, title: invariant, owner: "src/rules/owner.ts", matrixTest: "tests/rules.matrix.test.ts",
            coverage: { kind: "covered" }, mutation: unchanged,
          })),
        },
      }),
    }, emptyAcceptanceExpectation(1));
    if (evaluation.kind !== "accepted") throw new Error(`receipt fixture rejected: ${JSON.stringify(evaluation)}`);
    return evaluation.receipt;
  }

  const readiness = (value: TaskGraph, owner: OwnerCheckAuthority | null) =>
    deriveWaveCompletionSuiteReadiness(
      { ...value, active_wave_completion_suite: receiptUnder(owner) },
      1,
      { kind: "observed", workspaceDigest: WORKSPACE },
    ).kind;

  it.each(ROWS)("$name: suite-authority authorizes the owner check with exactly the owed Invariants", ({ files }) => {
    const stamped = suiteGraph(files, OBLIGATIONS);
    expect(gateOwnerCheck(stamped)).toMatchObject({
      checkId: "loom:owner-verification",
      obligationsDigest: obligationsDigest(OBLIGATIONS),
      owed: ids(ownerVerificationOwed(ownerScopeOf(stamped), 1)),
    });
  });

  it.each(ROWS)("$name: an unstamped graph's suite carries no owner check", ({ files }) => {
    expect(gateOwnerCheck(suiteGraph(files, undefined))).toBeNull();
  });

  it.each(ROWS)("$name: readiness accepts exactly the receipt authorized under ownerCheckAuthority", ({ files }) => {
    const stamped = suiteGraph(files, OBLIGATIONS);
    const owner = ownerCheckAuthority(ownerScopeOf(stamped), 1);
    expect(readiness(stamped, owner)).toBe("accepted");
    expect(readiness(stamped, null)).toBe("required");
    const otherOwed = owner!.owed.length === 0 ? [FEES.invariant] : [];
    expect(readiness(stamped, { ...owner!, owed: otherOwed })).toBe("required");
  });

  it.each(ROWS)("$name: readiness of an unstamped graph refuses a receipt carrying an owner check", ({ files }) => {
    const unstamped = suiteGraph(files, undefined);
    expect(readiness(unstamped, null)).toBe("accepted");
    expect(readiness(unstamped, { obligationsDigest: obligationsDigest([]), owed: [] })).toBe("required");
  });

  /**
   * Whether the sibling `state-file-wire.ts` loads the graph, written as JSON,
   * with a receipt minted under `owner`. The wire re-derives the authority from
   * the stamp on purpose instead of trusting the receipt's roster: a receipt
   * never certifies itself. The graph carries no frozen manifest, so the wire
   * holds the receipt to the legacy engine default.
   */
  const loads = (value: TaskGraph, owner: OwnerCheckAuthority | null): boolean => {
    const { verification_manifest: _frozen, ...legacy } = value;
    const written = { ...legacy, active_wave_completion_suite: receiptUnder(owner, legacyDefaultVerificationManifest()) };
    return parseTaskGraph(JSON.parse(JSON.stringify(written))).ok;
  };

  it.each(ROWS)("$name: the State File wire loads exactly the receipt authorized under ownerCheckAuthority", ({ files }) => {
    const stamped = suiteGraph(files, OBLIGATIONS);
    const owner = ownerCheckAuthority(ownerScopeOf(stamped), 1);
    expect(loads(stamped, owner)).toBe(true);
    expect(loads(stamped, null)).toBe(false);
    const otherOwed = owner!.owed.length === 0 ? [FEES.invariant] : [];
    expect(loads(stamped, { ...owner!, owed: otherOwed })).toBe(false);
  });

  it.each(ROWS)("$name: the State File wire refuses an unstamped graph's receipt carrying an owner check", ({ files }) => {
    const unstamped = suiteGraph(files, undefined);
    expect(loads(unstamped, null)).toBe(true);
    expect(loads(unstamped, { obligationsDigest: obligationsDigest([]), owed: [] })).toBe(false);
  });
});

describe("INV-3 sibling row — population's runner requirement follows verifyOwed", () => {
  const ROSTER = labelledValue("roster", parseAuthoredTaskRoster([Object.freeze({
    id: "T1", description: "implement T1", agent: "code-implementer-agent", wave: 1,
    depends_on: [], spec_anchors: [], spec_contributions: [], file_list: ["src/rules/owner.ts"],
    verification_policy: {
      regression: { kind: "required" as const },
      new_tests: { kind: "waived" as const, reason: "existing-tests-sufficient" as const },
    },
  })]));
  const INVARIANTS = parsePlanModels([
    "## Invariants", "",
    "### INV-1: Admission is decided only by the owner", "",
    "**Tier:** advisory",
    "**Owner module:** `src/rules/owner.ts`",
    "**Sibling entry points:**",
    "- `src/rules/sibling-a.ts` — admits members",
    "- `src/rules/sibling-b.ts`",
    "**Matrix test:** `tests/rules.matrix.test.ts`",
    "**Statement:** Every entry point admits through decide().", "",
    "### INV-4: Fees are computed only by the fee table", "",
    "**Tier:** advisory",
    "**Owner module:** src/fees/table.ts",
    "**Sibling entry points:** none",
    "**Matrix test:** tests/fees.matrix.test.ts",
    "**Mutation exemption:** generated lookup table", "",
  ].join("\n")).invariants;

  const populate = (invariants: typeof INVARIANTS, withRunner: boolean) => populateTaskGraph(
    { current_phase: "decompose", phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: "plan.md", tasks: [], wave_gates: {} },
    {
      planTitle: "INV-3 matrix", validatedPlanFile: "plan.md", tasks: ROSTER,
      verificationManifest: frozenManifest(withRunner ? { schemaVersion: 2, affectedRunner: AFFECTED_RUNNER } : { schemaVersion: 2 }),
      specIndex: { kind: "unavailable", reason: { kind: "no-spec-file" } }, observedSpecFile: null, force: false,
      proofBoundary: { kind: "absent", cause: "fixture: no Git repository root" }, contracts: [], invariants,
    },
  );

  it.each([
    { name: "verify and exempt", pick: [0, 1] },
    { name: "verify only", pick: [0] },
    { name: "exempt only", pick: [1] },
    { name: "no owned Invariant", pick: [] },
  ])("$name: without an affectedRunner, population refuses exactly when verifyOwed selects some obligation", ({ pick }) => {
    const invariants = pick.map((index) => INVARIANTS[index]!);
    const owed = ids(verifyOwed(labelledValue("obligations", obligationsFromPlan({ invariants }))));
    const refused = populate(invariants, false);
    if (owed.length === 0) {
      expect(refused.ok).toBe(true);
    } else {
      expect(refused).toMatchObject({ ok: false, error: { kind: "owner-verification-runner-missing" } });
      if (!refused.ok) expect(refused.error.message).toContain(`owned Invariant(s) ${owed.join(", ")} owe mutation verification`);
    }
    expect(populate(invariants, true).ok).toBe(true);
  });
});

describe("INV-3 sibling rows — the gate runs owner verification for ownerVerificationOwed, the runner mutates only verifyOwed", () => {
  afterEach(cleanupOwnerVerificationRepos);
  const GATE_TIMEOUT_MS = 60_000;

  it.each(["owner", "sibling", "matrix-test", "unrelated"] as const)(
    "%s: wave-completion-suite hands the runner exactly the owed obligations and the authorized check, and skips it when none are owed",
    async (waveChanges) => {
      const repo = buildOwnerVerificationRepo({ waveChanges, matrixTest: "discriminating" });
      const seen: OwnerVerificationInput[] = [];
      await ensureWaveCompletionSuite({
        handle: repo.handle, manager: repo.manager, graph: repo.manager.load(), registration: repo.registration,
        runOwnerVerification: async (input) => {
          seen.push(input);
          return { kind: "unavailable", failure: { kind: "unexpected-error", detail: "matrix row: the run is only observed" } };
        },
      });
      const loaded = repo.manager.load();
      const wave = loaded.active_wave_gate!.wave;
      const owed = ids(ownerVerificationOwed(ownerScopeOf(loaded), wave));
      expect(seen.map((input) => ids(input.owed))).toEqual(owed.length === 0 ? [] : [owed]);
      for (const input of seen) expect(input.authority).toMatchObject(ownerCheckAuthority(ownerScopeOf(loaded), wave)!);
    },
    GATE_TIMEOUT_MS,
  );

  const NO_RUNNER = frozenManifest({ schemaVersion: 2 });

  it.each([
    { name: "verify and exempt", owed: [ADMISSION, FEES] },
    { name: "verify only", owed: [ADMISSION] },
    { name: "exempt only", owed: [FEES] },
  ] as const)("$name: owner-verification-runner needs a runner exactly when verifyOwed selects some obligation", async ({ owed }) => {
    const root = canonicalTempDir("loom-inv3-runner-");
    try {
      const observation = await runOwnerVerification({
        root: canonicalRoot(root), graph: graph([], OBLIGATIONS), wave: 1,
        authority: { obligationsDigest: obligationsDigest(OBLIGATIONS), owed: owed.map(({ invariant }) => invariant) },
        owed: [owed[0], ...owed.slice(1)], manifest: NO_RUNNER,
        observeWorkspace: () => ({ ok: true, value: WORKSPACE_DIGEST }),
      });
      const mutating = ids(verifyOwed(owed));
      if (mutating.length > 0) {
        expect(observation).toMatchObject({ kind: "unavailable", failure: { kind: "runner-missing" } });
        if (observation.kind === "unavailable") expect(observation.failure.detail).toContain(`${mutating.join(", ")} owe mutation verification`);
      } else {
        expect(observation.kind).toBe("verified");
        if (observation.kind === "verified") expect(observation.verdicts.map(({ mutation }) => mutation.kind)).toEqual(owed.map(() => "exempt"));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("INV-3 owner rows — absent against empty owner_obligations", () => {
  const changing = [task("T1", 1, ["src/rules/owner.ts"])];

  it("absent: a pre-feature graph owes nothing and has no owner check authority", () => {
    expect(ownerVerificationOwed(ownerScopeOf(graph(changing)), 1)).toEqual([]);
    expect(ownerCheckAuthority(ownerScopeOf(graph(changing)), 1)).toBeNull();
    expect(touchScope(["src/rules/owner.ts"], [])).toEqual([]);
    expect(obligationsTouchedBy(ownerScopeOf(graph(changing)), ["src/rules/owner.ts"])).toEqual([]);
  });

  it("empty: a stamped graph with no owned Invariant owes nothing but still carries the check", () => {
    expect(ownerVerificationOwed(ownerScopeOf(graph(changing, [])), 1)).toEqual([]);
    expect(ownerCheckAuthority(ownerScopeOf(graph(changing, [])), 1)).toEqual({ obligationsDigest: obligationsDigest([]), owed: [] });
  });

  it("stamped, owing nothing this Wave: the authority is non-null with owed []", () => {
    expect(ownerCheckAuthority(ownerScopeOf(graph([task("T1", 1, ["src/other.ts"])], OBLIGATIONS)), 1))
      .toEqual({ obligationsDigest: obligationsDigest(OBLIGATIONS), owed: [] });
  });

  it("the absent and empty digests differ from a non-empty stamp's", () => {
    expect(obligationsDigest([])).not.toBe(obligationsDigest(OBLIGATIONS));
  });
});

describe("obligationsFromPlan — owned Invariants only, in plan order", () => {
  const PLAN = [
    "# Plan: obligations",
    "",
    "## Invariants",
    "",
    "### INV-1: Admission is decided only by the owner",
    "",
    "**Tier:** advisory",
    "**Owner module:** `src/rules/owner.ts`",
    "**Sibling entry points:**",
    "- `src/rules/sibling-a.ts` — admits members",
    "- `src/rules/sibling-b.ts`",
    "**Matrix test:** `tests/rules.matrix.test.ts`",
    "**Statement:** Every entry point admits through decide().",
    "",
    "### INV-2: No clock reads",
    "",
    "**Tier:** advisory",
    "**Owner module:** none",
    "**Unowned reason:** a prohibition",
    "",
    "### INV-3: Malformed",
    "",
    "**Tier:** advisory",
    "**Owner module:** src/x.ts",
    "",
    "### INV-4: Fees are computed only by the fee table",
    "",
    "**Tier:** advisory",
    "**Owner module:** src/fees/table.ts",
    "**Sibling entry points:** none",
    "**Matrix test:** tests/fees.matrix.test.ts",
    "**Mutation exemption:** generated lookup table",
    "",
  ].join("\n");

  it("derives one obligation per owned Invariant, carrying title, statement, family and mutation policy", () => {
    expect(obligationsFromPlan(parsePlanModels(PLAN))).toEqual({ ok: true, value: OBLIGATIONS });
  });

  it("a plan without owned Invariants derives the empty stamp", () => {
    expect(obligationsFromPlan(parsePlanModels("# Plan: none\n"))).toEqual({ ok: true, value: [] });
  });
});

describe("obligationsDigest and obligationsAgree — the stamp's identity", () => {
  it("the digest is canonical: key order of a stamp read back from the wire does not change it", () => {
    const reordered = {
      mutation: { reason: "generated lookup table", kind: "exempt" },
      matrixTest: FEES.matrixTest,
      siblings: [],
      owner: FEES.owner,
      statement: null,
      title: FEES.title,
      invariant: FEES.invariant,
    };
    const readBack = parseTaskGraph({ ...graphFixture([]), owner_obligations: [ADMISSION, reordered] });
    if (!readBack.ok) throw new Error(String(readBack.error));
    const stamp = readBack.value.owner_obligations ?? [];
    expect(obligationsDigest(stamp)).toBe(obligationsDigest(OBLIGATIONS));
    expect(obligationsAgree(stamp, OBLIGATIONS)).toBe(true);
  });

  it("any change to an owned Invariant is drift", () => {
    const drifted: readonly (readonly OwnerObligation[])[] = [
      [ADMISSION],
      [FEES, ADMISSION],
      [ADMISSION, ownerObligation({ ...FEES, mutation: { kind: "verify" } })],
      [ADMISSION, ownerObligation({ ...FEES, mutation: { kind: "exempt", reason: "another reason" } })],
      [ownerObligation({ ...ADMISSION, siblings: ADMISSION.siblings.slice(1) }), FEES],
      [ownerObligation({ ...ADMISSION, statement: null }), FEES],
    ];
    for (const stamp of drifted) {
      expect(obligationsAgree(stamp, OBLIGATIONS)).toBe(false);
      expect(obligationsDigest(stamp)).not.toBe(obligationsDigest(OBLIGATIONS));
    }
    expect(obligationsAgree([], [])).toBe(true);
  });
});

describe("stampAgreement — the gate's drift check reads the scope, never the raw stamp", () => {
  const PLAN_MODELS = parsePlanModels([
    "## Invariants", "",
    "### INV-1: Admission is decided only by the owner", "",
    "**Tier:** advisory",
    "**Owner module:** `src/rules/owner.ts`",
    "**Sibling entry points:**",
    "- `src/rules/sibling-a.ts` — admits members",
    "- `src/rules/sibling-b.ts`",
    "**Matrix test:** `tests/rules.matrix.test.ts`",
    "**Statement:** Every entry point admits through decide().", "",
    "### INV-4: Fees are computed only by the fee table", "",
    "**Tier:** advisory",
    "**Owner module:** src/fees/table.ts",
    "**Sibling entry points:** none",
    "**Matrix test:** tests/fees.matrix.test.ts",
    "**Mutation exemption:** generated lookup table", "",
  ].join("\n"));
  const scopeOf = (stamp?: readonly OwnerObligation[]) => ownerScopeOf(stamp === undefined ? { tasks: [] } : { tasks: [], owner_obligations: stamp });

  it("agrees with the stamp the plan derives, and drifts from any other, an empty one included", () => {
    expect(stampAgreement(scopeOf(OBLIGATIONS), PLAN_MODELS)).toEqual({ kind: "agrees" });
    expect(stampAgreement(scopeOf([ADMISSION]), PLAN_MODELS)).toEqual({ kind: "drifted" });
    expect(stampAgreement(scopeOf([FEES, ADMISSION]), PLAN_MODELS)).toEqual({ kind: "drifted" });
    expect(stampAgreement(scopeOf([]), PLAN_MODELS)).toEqual({ kind: "drifted" });
    expect(stampAgreement(scopeOf([]), parsePlanModels("# Plan: none\n"))).toEqual({ kind: "agrees" });
  });

  it("an absent stamp is unstamped, never agreement", () => {
    expect(stampAgreement(scopeOf(), PLAN_MODELS)).toEqual({ kind: "unstamped" });
    expect(stampAgreement(scopeOf(), parsePlanModels("# Plan: none\n"))).toEqual({ kind: "unstamped" });
  });

  it("a plan whose owned Invariant names a path in two roles derives no obligation: underivable", () => {
    const conflicted = parsePlanModels([
      "## Invariants", "",
      "### INV-1: Admission", "",
      "**Tier:** advisory",
      "**Owner module:** src/rules/owner.ts",
      "**Sibling entry points:**",
      "- `./src/rules/owner.ts` — the owner again",
      "**Matrix test:** tests/rules.matrix.test.ts", "",
    ].join("\n"));
    expect(stampAgreement(scopeOf(OBLIGATIONS), conflicted)).toEqual({
      kind: "underivable", error: { kind: "owner-is-sibling", invariant: "INV-1", path: "./src/rules/owner.ts" },
    });
  });

  it("sibling row: plan-integrity blocks on exactly the stamps stampAgreement does not find in agreement", () => {
    const failureOf = (scope: ReturnType<typeof scopeOf>, models = PLAN_MODELS) => planModelsIntegrityFailure("plan.md", models, scope)?.kind ?? null;
    expect(failureOf(scopeOf(OBLIGATIONS))).toBeNull();
    expect(failureOf(scopeOf([ADMISSION]))).toBe("plan-drift");
    expect(failureOf(scopeOf([]))).toBe("plan-drift");
    expect(failureOf(scopeOf())).toBe("plan-drift");
    expect(failureOf(scopeOf([]), parsePlanModels("# Plan: none\n"))).toBeNull();
  });

  it("the scope is opaque: it serializes to nothing a caller could filter", () => {
    expect(JSON.stringify(scopeOf(OBLIGATIONS))).toBe("{}");
    expect(Object.keys(scopeOf(OBLIGATIONS))).toEqual([]);
  });
});

describe("verifyOwed — the one home of the owes-mutation rule", () => {
  it("selects exactly the obligations whose policy is verify, in order", () => {
    expect(ids(verifyOwed(OBLIGATIONS))).toEqual(["INV-1"]);
    expect(verifyOwed([FEES])).toEqual([]);
    expect(verifyOwed([])).toEqual([]);
  });

  it("is a filter: it keeps every verify obligation of its input, drops every exempt one, and is idempotent", () => {
    const exempted = ownerObligation({ ...ADMISSION, invariant: "INV-7", mutation: { kind: "exempt", reason: "r" } });
    fc.assert(fc.property(fc.subarray([ADMISSION, FEES, exempted]), (stamp) => {
      const owed = verifyOwed(stamp);
      expect(owed.every((obligation) => stamp.includes(obligation) && obligation.mutation.kind === "verify")).toBe(true);
      expect(verifyOwed(owed)).toEqual(owed);
      expect(stamp.filter((obligation) => !owed.includes(obligation)).every(({ mutation }) => mutation.kind === "exempt")).toBe(true);
    }));
  });
});

describe("INV-3 properties", () => {
  const universe = [
    ADMISSION.owner,
    ...ADMISSION.siblings.map(({ path }) => path),
    ADMISSION.matrixTest,
    FEES.owner,
    FEES.matrixTest,
    "src/other.ts",
    "tests/other.test.ts",
  ];
  const fileList = fc.subarray(universe);

  it("the Wave scope is a subset of the touch scope for every file list", () => {
    fc.assert(fc.property(fc.array(fileList, { maxLength: 4 }), (lists) => {
      const changed = ids(waveScope(lists.map((files, i) => task(`T${i}`, 1, files))));
      const touched = ids(touchScope(lists.flat()));
      for (const id of changed) expect(touched).toContain(id);
    }));
  });

  it("an absent stamp owes nothing and has no authority, whatever the Wave changed", () => {
    fc.assert(fc.property(fc.array(fileList, { maxLength: 4 }), fc.integer({ min: 1, max: 3 }), (lists, wave) => {
      const unstamped = graph(lists.map((files, i) => task(`T${i}`, 1 + (i % 3), files)));
      expect(ownerVerificationOwed(ownerScopeOf(unstamped), wave)).toEqual([]);
      expect(ownerCheckAuthority(ownerScopeOf(unstamped), wave)).toBeNull();
      expect(obligationsTouchedBy(ownerScopeOf(unstamped), lists.flat())).toEqual([]);
    }));
  });

  it("a stamped graph always has authority, and owed is exactly the ids of ownerVerificationOwed", () => {
    fc.assert(fc.property(fc.array(fileList, { maxLength: 4 }), fc.integer({ min: 1, max: 3 }), (lists, wave) => {
      const stamped = graph(lists.map((files, i) => task(`T${i}`, 1 + (i % 3), files)), OBLIGATIONS);
      expect(ownerCheckAuthority(ownerScopeOf(stamped), wave)).toEqual({
        obligationsDigest: obligationsDigest(OBLIGATIONS),
        owed: ids(ownerVerificationOwed(ownerScopeOf(stamped), wave)),
      });
    }));
  });
});
