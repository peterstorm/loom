/**
 * INV-3 matrix: which owned Invariants a Wave or Task owes is decided only by
 * `core/owner-verification/obligations.ts`.
 *
 * Owner rows (T4): the Wave scope (`waveChangedObligations`, owner or
 * sibling: G5a's `changesFamily`) against the touch scope
 * (`obligationsTouchedBy`, any role) over owner-only, sibling-only,
 * matrix-only and unrelated file lists; and an absent against an empty
 * `owner_obligations` stamp through `ownerVerificationOwed` and
 * `ownerCheckAuthority`.
 *
 * Sibling rows (T9): `wave-review-authority.ts` issues the owner map, and
 * `implementation-brief.ts` renders the duty paragraphs, for exactly the
 * obligations `obligationsTouchedBy` selects, over the same file-list shapes,
 * and neither issues anything over an unstamped graph.
 *
 * Sibling rows (T10): `wave-completion-suite.ts` authorizes the
 * `loom:owner-verification` check with exactly the ids `ownerVerificationOwed`
 * selects (the gate scope), and `wave-completion-suite-readiness.ts` accepts
 * exactly the receipt authorized under `ownerCheckAuthority`, over the same
 * file-list shapes; an unstamped graph carries no owner check in either.
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
import { parseTaskGraph } from "../../src/state-manager";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { observedWorkspace } from "../fixtures/reviewed-workspace";
import {
  obligationsAgree,
  obligationsDigest,
  obligationsFromPlan,
  obligationsTouchedBy,
  ownerCheckAuthority,
  ownerVerificationOwed,
  waveChangedObligations,
  type OwnerCheckAuthority,
} from "../../src/core/owner-verification/obligations";
import type { OwnerObligation } from "../../src/core/owner-verification/types";
import { verifiedMutationOf } from "../../src/core/owner-verification/outcome";
import { parsePlanModels } from "../../src/core/parse-plan-models";
import { emptyAcceptanceExpectation } from "../../src/core/acceptance-contract";
import { evaluateWaveCompletionSuite } from "../../src/core/completion-suite";
import type { ArtifactDigest } from "../../src/core/orchestration-contract";
import { authorizeWaveCompletionSuite, freezeVerificationManifest } from "../../src/core/verification-manifest";
import { deriveWaveCompletionSuiteReadiness } from "../../src/core/wave-completion-suite-readiness";
import { authorizeGraphCompletionSuite } from "../../src/handlers/helpers/wave-completion-suite";
import type { ActiveWaveGateRegistration, Task, TaskGraph } from "../../src/types";
import { labelledValue } from "../fixtures/parse-result";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";

const ADMISSION: OwnerObligation = {
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
};

const FEES: OwnerObligation = {
  invariant: "INV-4",
  title: "Fees are computed only by the fee table",
  statement: null,
  owner: "src/fees/table.ts",
  siblings: [],
  matrixTest: "tests/fees.matrix.test.ts",
  mutation: { kind: "exempt", reason: "generated lookup table" },
};

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

const ids = (obligations: readonly OwnerObligation[]): readonly string[] => obligations.map(({ invariant }) => invariant);

describe("INV-3 owner rows — Wave scope against touch scope", () => {
  it.each(ROWS)("$name: the Wave scope is owner-or-sibling, the touch scope any role", ({ files, wave, touched }) => {
    expect(ids(waveChangedObligations([task("T1", 1, files)], OBLIGATIONS))).toEqual(wave ? ["INV-1"] : []);
    expect(ids(obligationsTouchedBy(files, OBLIGATIONS))).toEqual(touched ? ["INV-1"] : []);
  });

  it.each(ROWS)("$name: ownerVerificationOwed over a stamped graph is the Wave scope of that Wave's Tasks", ({ files, wave }) => {
    const stamped = graph([task("T1", 2, files), task("T2", 1, ["src/fees/table.ts"])], OBLIGATIONS);
    expect(ids(ownerVerificationOwed(stamped, 2))).toEqual(wave ? ["INV-1"] : []);
    expect(ownerCheckAuthority(stamped, 2)).toEqual({ obligationsDigest: obligationsDigest(OBLIGATIONS), owed: wave ? ["INV-1"] : [] });
  });

  it("a Wave's Tasks are unioned, in plan order, each obligation once", () => {
    const tasks = [task("T1", 1, ["src/fees/table.ts"]), task("T2", 1, ["src/rules/sibling-a.ts", "src/rules/owner.ts"])];
    expect(ids(waveChangedObligations(tasks, OBLIGATIONS))).toEqual(["INV-1", "INV-4"]);
    expect(ids(obligationsTouchedBy(["tests/fees.matrix.test.ts", "src/rules/owner.ts"], OBLIGATIONS))).toEqual(["INV-1", "INV-4"]);
  });

  it("a Task without a file_list changes and touches nothing", () => {
    const bare = taskFixture({ id: "T1", description: "T1", agent: "code-implementer-agent", wave: 1, depends_on: [] });
    expect(waveChangedObligations([bare], OBLIGATIONS)).toEqual([]);
  });

  it("paths match through the one plan path rule (a leading ./ is the same path)", () => {
    expect(ids(obligationsTouchedBy(["./src/rules/owner.ts"], OBLIGATIONS))).toEqual(["INV-1"]);
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
      ...(stamp === undefined ? {} : { ownerObligations: stamp }),
    });
    if (!rendered.ok) throw new Error(rendered.error.message);
    return [...rendered.value.prompt.matchAll(/\*\*Owner duties \((INV-\d+)\):\*\*/g)].map((match) => match[1]!);
  }

  it.each(ROWS)("$name: wave-review-authority issues the owner map of exactly the touch scope", ({ files }) => {
    const touched = obligationsTouchedBy(files, OBLIGATIONS);
    const [first, ...rest] = touched;
    expect(packetOwnerMap(files, OBLIGATIONS))
      .toBe(first === undefined ? null : renderOwnerMapSection(PLAN_FILE, [first, ...rest]));
  });

  it.each(ROWS)("$name: implementation-brief renders duties for exactly the touch scope", ({ files }) => {
    expect(briefDuties(files, OBLIGATIONS)).toEqual(ids(obligationsTouchedBy(files, OBLIGATIONS)));
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

describe("INV-3 sibling rows — the completion suite's gate scope and readiness follow ownerCheckAuthority", () => {
  const MANIFEST = labelledValue("manifest", freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1, kind: "loom-verification-manifest", checks: [],
  }))));
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

  /** The owner check the sibling `wave-completion-suite.ts` authorizes for the graph's Wave, or null for none. */
  function gateOwnerCheck(value: TaskGraph) {
    const suite = labelledValue("gate suite", authorizeGraphCompletionSuite(value, MANIFEST, ACTIVE, WORKSPACE));
    return suite.checks.find((check) => check.kind === "engine-owner-verification") ?? null;
  }

  /** An accepted receipt minted under `owner`, whose observation verifies exactly `owner.owed`. */
  function receiptUnder(owner: OwnerCheckAuthority | null) {
    const suite = labelledValue("suite", authorizeWaveCompletionSuite(MANIFEST, ACTIVE, WORKSPACE, owner));
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

  it.each(ROWS)("$name: wave-completion-suite authorizes the owner check with exactly the owed Invariants", ({ files }) => {
    const stamped = suiteGraph(files, OBLIGATIONS);
    expect(gateOwnerCheck(stamped)).toMatchObject({
      checkId: "loom:owner-verification",
      obligationsDigest: obligationsDigest(OBLIGATIONS),
      owed: ids(ownerVerificationOwed(stamped, 1)),
    });
  });

  it.each(ROWS)("$name: an unstamped graph's suite carries no owner check", ({ files }) => {
    expect(gateOwnerCheck(suiteGraph(files, undefined))).toBeNull();
  });

  it.each(ROWS)("$name: readiness accepts exactly the receipt authorized under ownerCheckAuthority", ({ files }) => {
    const stamped = suiteGraph(files, OBLIGATIONS);
    const owner = ownerCheckAuthority(stamped, 1);
    expect(readiness(stamped, owner)).toBe("accepted");
    expect(readiness(stamped, null)).toBe("required");
    const otherOwed = owner!.owed.length === 0 ? ["INV-4"] : [];
    expect(readiness(stamped, { ...owner!, owed: otherOwed })).toBe("required");
  });

  it.each(ROWS)("$name: readiness of an unstamped graph refuses a receipt carrying an owner check", ({ files }) => {
    const unstamped = suiteGraph(files, undefined);
    expect(readiness(unstamped, null)).toBe("accepted");
    expect(readiness(unstamped, { obligationsDigest: obligationsDigest([]), owed: [] })).toBe("required");
  });
});

describe("INV-3 owner rows — absent against empty owner_obligations", () => {
  const changing = [task("T1", 1, ["src/rules/owner.ts"])];

  it("absent: a pre-feature graph owes nothing and has no owner check authority", () => {
    expect(ownerVerificationOwed(graph(changing), 1)).toEqual([]);
    expect(ownerCheckAuthority(graph(changing), 1)).toBeNull();
  });

  it("empty: a stamped graph with no owned Invariant owes nothing but still carries the check", () => {
    expect(ownerVerificationOwed(graph(changing, []), 1)).toEqual([]);
    expect(ownerCheckAuthority(graph(changing, []), 1)).toEqual({ obligationsDigest: obligationsDigest([]), owed: [] });
  });

  it("stamped, owing nothing this Wave: the authority is non-null with owed []", () => {
    expect(ownerCheckAuthority(graph([task("T1", 1, ["src/other.ts"])], OBLIGATIONS), 1))
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
    expect(obligationsFromPlan(parsePlanModels(PLAN))).toEqual(OBLIGATIONS);
  });

  it("a plan without owned Invariants derives the empty stamp", () => {
    expect(obligationsFromPlan(parsePlanModels("# Plan: none\n"))).toEqual([]);
  });
});

describe("obligationsDigest and obligationsAgree — the stamp's identity", () => {
  it("the digest is canonical: key order of a stamp read back from the wire does not change it", () => {
    const reordered: OwnerObligation = {
      mutation: { reason: "generated lookup table", kind: "exempt" },
      matrixTest: FEES.matrixTest,
      siblings: [],
      owner: FEES.owner,
      statement: null,
      title: FEES.title,
      invariant: FEES.invariant,
    };
    expect(obligationsDigest([ADMISSION, reordered])).toBe(obligationsDigest(OBLIGATIONS));
    expect(obligationsAgree([ADMISSION, reordered], OBLIGATIONS)).toBe(true);
  });

  it("any change to an owned Invariant is drift", () => {
    const drifted: readonly (readonly OwnerObligation[])[] = [
      [ADMISSION],
      [FEES, ADMISSION],
      [ADMISSION, { ...FEES, mutation: { kind: "verify" } }],
      [ADMISSION, { ...FEES, mutation: { kind: "exempt", reason: "another reason" } }],
      [{ ...ADMISSION, siblings: ADMISSION.siblings.slice(1) }, FEES],
      [{ ...ADMISSION, statement: null }, FEES],
    ];
    for (const stamp of drifted) {
      expect(obligationsAgree(stamp, OBLIGATIONS)).toBe(false);
      expect(obligationsDigest(stamp)).not.toBe(obligationsDigest(OBLIGATIONS));
    }
    expect(obligationsAgree([], [])).toBe(true);
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
      const changed = ids(waveChangedObligations(lists.map((files, i) => task(`T${i}`, 1, files)), OBLIGATIONS));
      const touched = ids(obligationsTouchedBy(lists.flat(), OBLIGATIONS));
      for (const id of changed) expect(touched).toContain(id);
    }));
  });

  it("an absent stamp owes nothing and has no authority, whatever the Wave changed", () => {
    fc.assert(fc.property(fc.array(fileList, { maxLength: 4 }), fc.integer({ min: 1, max: 3 }), (lists, wave) => {
      const unstamped = graph(lists.map((files, i) => task(`T${i}`, 1 + (i % 3), files)));
      expect(ownerVerificationOwed(unstamped, wave)).toEqual([]);
      expect(ownerCheckAuthority(unstamped, wave)).toBeNull();
    }));
  });

  it("a stamped graph always has authority, and owed is exactly the ids of ownerVerificationOwed", () => {
    fc.assert(fc.property(fc.array(fileList, { maxLength: 4 }), fc.integer({ min: 1, max: 3 }), (lists, wave) => {
      const stamped = graph(lists.map((files, i) => task(`T${i}`, 1 + (i % 3), files)), OBLIGATIONS);
      expect(ownerCheckAuthority(stamped, wave)).toEqual({
        obligationsDigest: obligationsDigest(OBLIGATIONS),
        owed: ids(ownerVerificationOwed(stamped, wave)),
      });
    }));
  });
});
