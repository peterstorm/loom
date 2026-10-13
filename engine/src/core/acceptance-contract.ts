/**
 * Acceptance Contracts: the plan's `## Contracts`, made executable.
 *
 * A contract's **contract Task** writes a declarations-only types file, the
 * dedicated acceptance test files, and compiling stubs. Its Wave Gate must
 * observe every acceptance testcase FAIL (RED) — collected, so a file that
 * never loads is not a behavioral RED. That gate then stamps the **Acceptance
 * Freeze**: the frozen paths' bytes and the roster of testcases observed red.
 *
 * Each testcase names the Requirements it decides (`AS-003: …`), and each
 * Requirement has exactly one completion Wave, so a testcase is **due** once
 * the Wave completing all its anchors gates: from then on every Wave Gate needs
 * it present and passing (GREEN). Before that it is **pending**, and its
 * failure is excused — nothing else is. A gate whose report fails outside the
 * acceptance files, or fails a due testcase, is never excused.
 *
 * Tasks run between the contract Wave and the last Wave completing one of its
 * anchors see pending testcases fail in any full-suite run, so their
 * task-level regression obligation is waived by the engine
 * (`acceptance-red-window`) and the Wave Gate's engine-run suite, which knows
 * which failures are pending, is their regression authority.
 *
 * Pure: the shell supplies the JUnit projection, report digests and frozen
 * path digests; this module decides and returns data.
 */

import {
  canonicalStructuralEquals,
  parseArtifactDigest,
  type ArtifactDigest,
  type DomainResult,
  type NonEmpty,
} from "./orchestration-contract";
import { exactRecordErrors, isPlainRecord, parseExactRecord } from "./plain-record";
import { isRepoRelativePlanPath, normalizePlanPath, pathsMatch } from "./plan-path-match";
import type { JunitTestcasesResult, ReportTestcaseOutcome } from "./structured-test-report";

// ---------------------------------------------------------------------------
// Plan shapes — what a `## Contracts` block declares. Owned here, re-exported
// by types.ts beside the other plan shapes; this module imports nothing from
// types.ts, so the schema root can name `AcceptanceContract` without a cycle.
// ---------------------------------------------------------------------------

/** One `- path — FR-n, AS-n` line of a contract's `**Acceptance tests:**` list:
 *  a dedicated acceptance test file and the Requirements it decides. */
export type ContractAcceptanceFile = Readonly<{ path: string; anchors: NonEmpty<string> }>;

/** The shared surface a contract freezes: one declarations-only file, or none
 *  with the reason the feature slice needs no shared surface. */
export type ContractTypes =
  | Readonly<{ kind: "file"; path: string }>
  | Readonly<{ kind: "none"; reason: string }>;

/** Why a contract declaration is malformed. Each names exactly one way the plan
 *  text failed the grammar, so validation can say which. */
export type ContractProblem =
  | Readonly<{ kind: "missing-types" }>
  | Readonly<{ kind: "none-without-reason" }>
  | Readonly<{ kind: "reason-with-types-file" }>
  | Readonly<{ kind: "missing-acceptance" }>
  | Readonly<{ kind: "malformed-acceptance"; line: string }>
  | Readonly<{ kind: "invalid-anchor"; path: string; anchor: string }>
  | Readonly<{ kind: "duplicate-acceptance"; path: string }>
  | Readonly<{ kind: "supported-domain-not-acceptance"; path: string }>
  | Readonly<{ kind: "unsafe-path"; path: string }>
  | Readonly<{ kind: "missing-statement" }>;

/**
 * What a contract declares: the frozen types surface, the acceptance files and
 * the Requirements each decides, the file holding the supported/unsupported
 * table (when there is one), and the observable behavior consumers rely on. A
 * declaration that is not complete and consistent is `malformed`, carrying at
 * least one problem — never a half-filled declared value.
 */
export type ContractDeclaration =
  | Readonly<{
      kind: "declared";
      types: ContractTypes;
      acceptance: NonEmpty<ContractAcceptanceFile>;
      supportedDomain: string | null;
      statement: string;
    }>
  | Readonly<{ kind: "malformed"; problems: NonEmpty<ContractProblem> }>;

export interface PlanContract {
  /** e.g. "CT-1" */
  readonly id: string;
  readonly title: string;
  readonly declaration: ContractDeclaration;
}

// ---------------------------------------------------------------------------
// Persisted shapes
// ---------------------------------------------------------------------------

/** A testcase the freeze names: its acceptance file, its JUnit name, and the
 *  covered Requirements its name decides. */
export type AcceptanceTestcase = Readonly<{ file: string; name: string; anchors: NonEmpty<string> }>;

/** One frozen path and the digest of the bytes observed red. */
export type FrozenPathDigest = Readonly<{ path: string; sha256: ArtifactDigest }>;

/**
 * The Acceptance Freeze. `awaiting-red` until the contract Wave's gate observes
 * RED; `frozen` with the observed bytes and roster from then on; `revised`
 * after an operator Contract Revision re-stamped the bytes, until the next
 * gate re-records the roster green.
 */
export type AcceptanceFreeze =
  | Readonly<{ state: "awaiting-red" }>
  | Readonly<{ state: "frozen"; wave: number; paths: NonEmpty<FrozenPathDigest>; roster: NonEmpty<AcceptanceTestcase> }>
  | Readonly<{ state: "revised"; paths: NonEmpty<FrozenPathDigest> }>;

/** One operator Contract Revision: why, the bytes before and after, and the
 *  claimant Tasks it returned to revalidation. */
export type ContractRevision = Readonly<{
  revision: number;
  reason: string;
  previous: NonEmpty<FrozenPathDigest>;
  paths: NonEmpty<FrozenPathDigest>;
  revalidatedTaskIds: readonly string[];
}>;

export type AcceptanceContract = Readonly<{
  schemaVersion: 1;
  id: string;
  title: string;
  statement: string;
  /** The one Task that writes every frozen path. */
  contractTask: string;
  types: ContractTypes;
  acceptance: NonEmpty<ContractAcceptanceFile>;
  supportedDomain: string | null;
  freeze: AcceptanceFreeze;
  revisions: readonly ContractRevision[];
}>;

/** The Task fields contract derivation reads. */
export type ContractTaskView = Readonly<{
  id: string;
  wave: number;
  file_list?: readonly string[];
  spec_anchors?: readonly string[];
}>;

/** The engine-only regression waiver stamped on red-window Tasks. */
export const ACCEPTANCE_RED_WINDOW = "acceptance-red-window" as const;

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const ok = <T>(value: T): DomainResult<T, never> => freeze({ ok: true as const, value });
const err = <E>(error: E): DomainResult<never, E> => freeze({ ok: false as const, error });

function nonEmpty<T>(values: readonly T[]): NonEmpty<T> | null {
  const [head, ...tail] = values;
  return head === undefined ? null : Object.freeze([head, ...tail]);
}

/** The Requirement ids a contract may cover — only a functional Requirement or
 *  an Acceptance Scenario can be decided by a test, never an Out-of-Scope
 *  entry. The one grammar the plan parser and the persisted parser both read. */
export const COVERABLE_ANCHOR = /^(?:FR|AS)-\d+$/;

/** The id grammar of a plan contract. */
export const CONTRACT_ID = /^CT-\d+$/;

// ---------------------------------------------------------------------------
// Derived facts
// ---------------------------------------------------------------------------

/** Every path the freeze covers: the types file (if any), then each acceptance file. */
export function frozenPaths(contract: Pick<AcceptanceContract, "types" | "acceptance">): NonEmpty<string> {
  const acceptance = contract.acceptance.map(({ path }) => path);
  return contract.types.kind === "file"
    ? Object.freeze([contract.types.path, ...acceptance])
    : Object.freeze([acceptance[0]!, ...acceptance.slice(1)]);
}

/** The Requirements the contract's acceptance files decide, in declaration order. */
export function coveredAnchors(contract: Pick<AcceptanceContract, "acceptance">): readonly string[] {
  return Object.freeze([...new Set(contract.acceptance.flatMap(({ anchors }) => anchors))]);
}

/** Why a contract's frozen paths do not have exactly one writer. */
export type ContractWriterProblem =
  | Readonly<{ kind: "unwritten"; path: string }>
  | Readonly<{ kind: "shared"; path: string; taskIds: NonEmpty<string> }>
  | Readonly<{ kind: "split"; taskIds: NonEmpty<string> }>;

/**
 * The contract Task: the one Task whose file_list holds every frozen path,
 * with no other Task listing any of them. The one owner of that rule — plan
 * validation renders its problems, population refuses on them.
 */
export function contractWriter(
  paths: NonEmpty<string>,
  tasks: readonly Pick<ContractTaskView, "id" | "file_list">[],
): DomainResult<string, NonEmpty<ContractWriterProblem>> {
  const writers = paths.map((path) => ({
    path,
    ids: tasks.filter((task) => (task.file_list ?? []).some((file) => pathsMatch(file, path))).map(({ id }) => id),
  }));
  const problems: ContractWriterProblem[] = writers.flatMap(({ path, ids }): ContractWriterProblem[] => {
    const shared = nonEmpty(ids);
    if (shared === null) return [freeze({ kind: "unwritten", path })];
    return shared.length > 1 ? [freeze({ kind: "shared", path, taskIds: shared })] : [];
  });
  if (problems.length === 0) {
    const writerIds = nonEmpty([...new Set(writers.map(({ ids }) => ids[0]!))])!;
    if (writerIds.length === 1) return ok(writerIds[0]);
    problems.push(freeze({ kind: "split", taskIds: writerIds }));
  }
  return err(nonEmpty(problems)!);
}

/** The Tasks that claim an anchor's completion, other than the contract Task. */
function anchorClaimants(
  contract: Pick<AcceptanceContract, "contractTask">,
  anchor: string,
  tasks: readonly ContractTaskView[],
): readonly ContractTaskView[] {
  return tasks.filter((task) => task.id !== contract.contractTask && (task.spec_anchors ?? []).includes(anchor));
}

/** The Wave of a contract's contract Task; undefined when the Task is not in the roster. */
export function contractWave(
  contract: Pick<AcceptanceContract, "contractTask">,
  tasks: readonly ContractTaskView[],
): number | undefined {
  return tasks.find(({ id }) => id === contract.contractTask)?.wave;
}

/** The Tasks that claim any Requirement the contract covers, other than its contract Task. */
export function contractClaimants<T extends ContractTaskView>(
  contract: Pick<AcceptanceContract, "contractTask" | "acceptance">,
  tasks: readonly T[],
): readonly T[] {
  const covered = coveredAnchors(contract);
  return tasks.filter((task) =>
    task.id !== contract.contractTask && (task.spec_anchors ?? []).some((anchor) => covered.includes(anchor)));
}

/** Each covered anchor's completion Wave; an anchor nobody claims is absent. */
function dueWaves(contract: AcceptanceContract, tasks: readonly ContractTaskView[]): Readonly<Record<string, number>> {
  return freeze(Object.fromEntries(coveredAnchors(contract).flatMap((anchor) => {
    const waves = anchorClaimants(contract, anchor, tasks).map(({ wave }) => wave);
    return waves.length === 0 ? [] : [[anchor, Math.max(...waves)] as const];
  })));
}

/**
 * Build each plan contract's persisted form. Plan-binding validation has
 * already refused every case this rejects; it stays total so population can
 * never persist a contract without its one contract Task.
 */
export function acceptanceContractsFromPlan(
  contracts: readonly PlanContract[],
  tasks: readonly ContractTaskView[],
): DomainResult<readonly AcceptanceContract[], readonly string[]> {
  const errors: string[] = [];
  const built = contracts.flatMap((planContract): AcceptanceContract[] => {
    const declaration = planContract.declaration;
    if (declaration.kind === "malformed") {
      errors.push(`${planContract.id}: the declaration is malformed`);
      return [];
    }
    const writer = contractWriter(frozenPaths(declaration), tasks);
    if (!writer.ok) {
      errors.push(`${planContract.id}: the frozen paths do not have exactly one writer; exactly one contract Task must write them all`);
      return [];
    }
    return [freeze({
      schemaVersion: 1,
      id: planContract.id,
      title: planContract.title,
      statement: declaration.statement,
      contractTask: writer.value,
      types: declaration.types,
      acceptance: declaration.acceptance,
      supportedDomain: declaration.supportedDomain,
      freeze: freeze({ state: "awaiting-red" }),
      revisions: Object.freeze([]),
    })];
  });
  return errors.length > 0 ? err(Object.freeze(errors)) : ok(Object.freeze(built));
}

/**
 * Contracts are observed only through a Wave Gate test report, so a plan that
 * declares one needs a project check that writes a report; without one, RED
 * and GREEN would go unobserved and the contracts would be prose.
 */
export function acceptanceObservationProblem(
  contracts: readonly PlanContract[],
  projectChecks: readonly Readonly<{ reportPolicy: Readonly<{ kind: string }> }>[],
): string | null {
  if (contracts.length === 0 || projectChecks.some(({ reportPolicy }) => reportPolicy.kind === "required-file")) return null;
  return `The plan declares Contracts (${contracts.map(({ id }) => id).join(", ")}), whose RED and GREEN only a Wave Gate ` +
    "test report can observe. Install .loom/verification-manifest.json with a project check that writes a JUnit report " +
    "(\"report\": { \"kind\": \"required-file\", ... }) before populating the task graph.";
}

/**
 * The Tasks whose full-suite run would see some contract's pending testcases
 * fail: every Task from the contract Wave through the last Wave completing one
 * of its anchors.
 */
export function redWindowTaskIds(
  contracts: readonly AcceptanceContract[],
  tasks: readonly ContractTaskView[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const contract of contracts) {
    const start = contractWave(contract, tasks);
    if (start === undefined) continue;
    const end = Math.max(start, ...Object.values(dueWaves(contract, tasks)));
    for (const task of tasks) if (task.wave >= start && task.wave <= end) ids.add(task.id);
  }
  return ids;
}

/**
 * The declared acceptance file a JUnit testcase belongs to, or null. Vitest
 * reports the test file relative to its root, so the declared repository path
 * may be longer; Surefire reports the class name, which maps to the declared
 * `.java`/`.kt` path. Matching is by whole path segments, never by suffix text.
 */
export function testcaseAcceptanceFile(files: readonly string[], classname: string): string | null {
  const reported = normalizePlanPath(classname);
  const jvmClass = !reported.includes("/") && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(reported)
    ? reported.split("$")[0]!.replace(/\./g, "/")
    : null;
  return files.find((file) => {
    const declared = normalizePlanPath(file);
    if (declared === reported || declared.endsWith(`/${reported}`)) return true;
    if (jvmClass === null) return false;
    const withoutExtension = declared.replace(/\.[^./]+$/, "");
    return withoutExtension === jvmClass || withoutExtension.endsWith(`/${jvmClass}`);
  }) ?? null;
}

const ANCHOR_MENTION = /\b((?:FR|AS)-\d+):/g;

/** The declared anchors a testcase name decides (`AS-003: …`), in name order. */
function testcaseAnchors(name: string, fileAnchors: readonly string[]): readonly string[] {
  return [...new Set([...name.matchAll(ANCHOR_MENTION)].map((match) => match[1]!))]
    .filter((anchor) => fileAnchors.includes(anchor));
}

// ---------------------------------------------------------------------------
// Wave Gate expectation, observation and judgment
// ---------------------------------------------------------------------------

type GateExpectationBase = Readonly<{
  contract: string;
  files: NonEmpty<ContractAcceptanceFile>;
  /** Each covered anchor's completion Wave. */
  dueWave: Readonly<Record<string, number>>;
}>;

/**
 * What one Wave Gate owes one contract. RED always records the roster, so it
 * carries none. GREEN carries the frozen roster, or null when this gate
 * records it (the gate that froze it, or the first gate after a Contract
 * Revision).
 */
export type ContractGateExpectation =
  | Readonly<GateExpectationBase & { phase: "red" }>
  | Readonly<GateExpectationBase & { phase: "green"; roster: NonEmpty<AcceptanceTestcase> | null }>;

/** Whether this gate records the contract's roster rather than judging against a frozen one. */
const recordsRoster = (expected: ContractGateExpectation): boolean =>
  expected.phase === "red" || expected.roster === null;

export type AcceptanceExpectation = Readonly<{
  wave: number;
  contracts: readonly ContractGateExpectation[];
  /** Contracts this gate owes something but cannot judge: fail closed. */
  unobservable: readonly Readonly<{ contract: string; reason: string }>[];
}>;

/** What one Wave Gate owes every contract: nothing before a contract's Wave,
 *  RED in it, and GREEN-by-anchor after it. */
export function acceptanceExpectation(
  contracts: readonly AcceptanceContract[],
  tasks: readonly ContractTaskView[],
  wave: number,
): AcceptanceExpectation {
  const owed: ContractGateExpectation[] = [];
  const unobservable: Readonly<{ contract: string; reason: string }>[] = [];
  for (const contract of contracts) {
    const writtenIn = contractWave(contract, tasks);
    if (writtenIn === undefined) {
      unobservable.push(freeze({ contract: contract.id, reason: `contract Task ${contract.contractTask} is not in the TaskGraph` }));
      continue;
    }
    if (wave < writtenIn) continue;
    const base = { contract: contract.id, files: contract.acceptance, dueWave: dueWaves(contract, tasks) };
    if (wave === writtenIn) {
      owed.push(freeze({ ...base, phase: "red" }));
      continue;
    }
    switch (contract.freeze.state) {
      case "awaiting-red":
        unobservable.push(freeze({
          contract: contract.id,
          reason: `Wave ${writtenIn} gated without observing ${contract.id}'s acceptance RED, so nothing is frozen to turn green`,
        }));
        break;
      case "frozen":
        // The gate that recorded the roster keeps recording it, so its own
        // receipt still evaluates against the same expectation once stamped.
        owed.push(freeze({ ...base, phase: "green", roster: contract.freeze.wave === wave ? null : contract.freeze.roster }));
        break;
      case "revised":
        owed.push(freeze({ ...base, phase: "green", roster: null }));
        break;
    }
  }
  return freeze({ wave, contracts: Object.freeze(owed), unobservable: Object.freeze(unobservable) });
}

/** The expectation a protected TaskGraph derives for one Wave's gate: the one
 *  derivation every shell site compares a receipt against. */
export function graphAcceptanceExpectation(
  graph: Readonly<{ acceptance_contracts?: readonly AcceptanceContract[]; tasks: readonly ContractTaskView[] }>,
  wave: number,
): AcceptanceExpectation {
  return acceptanceExpectation(graph.acceptance_contracts ?? [], graph.tasks, wave);
}

/** The expectation of a gate that owes no contract anything. */
export function emptyAcceptanceExpectation(wave: number): AcceptanceExpectation {
  return freeze({ wave, contracts: Object.freeze([]), unobservable: Object.freeze([]) });
}

/** Whether a gate owes any contract anything at all. */
export function owesAcceptance(expectation: AcceptanceExpectation): boolean {
  return expectation.contracts.length > 0 || expectation.unobservable.length > 0;
}

/** One testcase attributed to an expected acceptance file. A testcase whose
 *  name is its classname is Vitest's synthetic case for a file that never
 *  loaded: a collection error, never a behavioral outcome. */
export type ObservedAcceptanceTestcase = Readonly<{
  file: string;
  name: string;
  outcome: ReportTestcaseOutcome;
  failureType: string | null;
  collectionError: boolean;
}>;

/** The acceptance-relevant projection of one check's report, bound to its
 *  digest: the testcases of expected acceptance files, and how many failing
 *  testcases fall outside them. */
export type AcceptanceReportFacts =
  | Readonly<{
      kind: "projected";
      checkId: string;
      reportDigest: ArtifactDigest;
      testcases: readonly ObservedAcceptanceTestcase[];
      otherFailures: number;
    }>
  | Readonly<{ kind: "unprojectable"; checkId: string; reportDigest: ArtifactDigest; reason: string }>;

/** Facts for a report the shell could not read back as the bytes the check produced. */
export function unprojectableFacts(checkId: string, reportDigest: ArtifactDigest, reason: string): AcceptanceReportFacts {
  return freeze({ kind: "unprojectable", checkId, reportDigest, reason });
}

export function observeAcceptanceFacts(
  expectation: AcceptanceExpectation,
  checkId: string,
  reportDigest: ArtifactDigest,
  projection: JunitTestcasesResult,
): AcceptanceReportFacts {
  if (!projection.ok) return unprojectableFacts(checkId, reportDigest, projection.error.message);
  const files = expectation.contracts.flatMap(({ files: declared }) => declared.map(({ path }) => path));
  const testcases: ObservedAcceptanceTestcase[] = [];
  let otherFailures = 0;
  for (const testcase of projection.value) {
    const file = testcaseAcceptanceFile(files, testcase.classname);
    if (file === null) {
      if (testcase.outcome === "failed") otherFailures += 1;
      continue;
    }
    testcases.push(freeze({
      file,
      name: testcase.name,
      outcome: testcase.outcome,
      failureType: testcase.failureType,
      collectionError: testcase.name === testcase.classname,
    }));
  }
  return freeze({ kind: "projected", checkId, reportDigest, testcases: Object.freeze(testcases), otherFailures });
}

type TestcaseRef = Readonly<{ file: string; name: string }>;

export type AcceptanceFailure =
  | Readonly<{ kind: "acceptance-unobservable"; contract: string; reason: string }>
  | Readonly<{ kind: "acceptance-not-observed"; contract: string; reasons: readonly string[] }>
  | Readonly<{ kind: "acceptance-file-not-collected"; contract: string; file: string }>
  | Readonly<{ kind: "acceptance-testcase-unanchored"; contract: string; file: string; name: string }>
  | Readonly<{ kind: "acceptance-anchor-untested"; contract: string; file: string; anchor: string }>
  | Readonly<{ kind: "acceptance-not-red"; contract: string; testcases: NonEmpty<TestcaseRef> }>
  | Readonly<{ kind: "acceptance-not-green"; contract: string; testcases: NonEmpty<TestcaseRef> }>
  | Readonly<{ kind: "acceptance-testcase-missing"; contract: string; testcases: NonEmpty<TestcaseRef> }>;

export type AcceptanceJudgment = Readonly<{
  failures: readonly AcceptanceFailure[];
  /** Checks whose report's failures are all RED or pending acceptance testcases. */
  excusedCheckIds: readonly string[];
}>;

const sameTestcase = (left: TestcaseRef, right: TestcaseRef): boolean =>
  left.file === right.file && left.name === right.name;

/** The real (collected) testcases of one contract's files that name an
 *  anchor, deduplicated, in report order. */
function observedRoster(expected: ContractGateExpectation, observed: readonly ObservedAcceptanceTestcase[]): readonly AcceptanceTestcase[] {
  const roster: AcceptanceTestcase[] = [];
  for (const testcase of observed) {
    if (testcase.collectionError || roster.some((entry) => sameTestcase(entry, testcase))) continue;
    const fileAnchors = expected.files.find(({ path }) => path === testcase.file)?.anchors ?? [];
    const anchors = nonEmpty(testcaseAnchors(testcase.name, fileAnchors));
    if (anchors !== null) roster.push(freeze({ file: testcase.file, name: testcase.name, anchors }));
  }
  return roster;
}

const isDue = (expected: ContractGateExpectation, anchors: readonly string[], wave: number): boolean =>
  anchors.every((anchor) => (expected.dueWave[anchor] ?? Number.POSITIVE_INFINITY) <= wave);

function contractFailures(
  expected: ContractGateExpectation,
  wave: number,
  facts: readonly AcceptanceReportFacts[],
): readonly AcceptanceFailure[] {
  const contract = expected.contract;
  const paths = expected.files.map(({ path }) => path);
  const observed = facts.flatMap((fact) =>
    fact.kind === "projected" ? fact.testcases.filter(({ file }) => paths.includes(file)) : []);
  if (observed.length === 0) {
    return [freeze({
      kind: "acceptance-not-observed",
      contract,
      reasons: Object.freeze(facts.flatMap((fact) => fact.kind === "unprojectable" ? [`${fact.checkId}: ${fact.reason}`] : [])),
    })];
  }
  const failures: AcceptanceFailure[] = [];
  // Collection and anchoring are proven when a roster is recorded; once
  // frozen, the roster is the authority and a vanished testcase is reported
  // against it below.
  for (const file of recordsRoster(expected) ? expected.files : []) {
    const real = observed.filter((testcase) => testcase.file === file.path && !testcase.collectionError);
    if (real.length === 0) failures.push(freeze({ kind: "acceptance-file-not-collected", contract, file: file.path }));
    for (const testcase of real) {
      if (testcaseAnchors(testcase.name, file.anchors).length === 0) {
        failures.push(freeze({ kind: "acceptance-testcase-unanchored", contract, file: file.path, name: testcase.name }));
      }
    }
    for (const anchor of file.anchors) {
      if (real.length > 0 && !real.some((testcase) => testcaseAnchors(testcase.name, [anchor]).length > 0)) {
        failures.push(freeze({ kind: "acceptance-anchor-untested", contract, file: file.path, anchor }));
      }
    }
  }
  const refs = (testcases: readonly TestcaseRef[]): NonEmpty<TestcaseRef> | null =>
    nonEmpty(testcases.map(({ file, name }) => freeze({ file, name })));
  if (expected.phase === "red") {
    const notRed = refs(observed.filter((testcase) => !testcase.collectionError && testcase.outcome !== "failed"));
    if (notRed !== null) failures.push(freeze({ kind: "acceptance-not-red", contract, testcases: notRed }));
    return failures;
  }
  const roster = expected.roster ?? observedRoster(expected, observed);
  const passed = (entry: TestcaseRef): boolean =>
    observed.some((testcase) => sameTestcase(testcase, entry) && !testcase.collectionError && testcase.outcome === "passed");
  const notGreen = refs(roster.filter((entry) => isDue(expected, entry.anchors, wave) && !passed(entry)));
  if (notGreen !== null) failures.push(freeze({ kind: "acceptance-not-green", contract, testcases: notGreen }));
  const missing = refs(roster.filter((entry) =>
    !isDue(expected, entry.anchors, wave) && !observed.some((testcase) => sameTestcase(testcase, entry))));
  if (missing !== null) failures.push(freeze({ kind: "acceptance-testcase-missing", contract, testcases: missing }));
  return failures;
}

/**
 * A check's non-zero exit is excused only when its report shows failures and
 * every one is a collected RED or pending acceptance testcase. The judgment is
 * report-derived: an exit cause that never appears as a failing testcase (a
 * coverage threshold, a chained step, a crash after the report was written)
 * is invisible here, which is why a contract's test runner must be its own
 * project check or the last step of one (`references/executable-models.md`).
 */
function excused(expectation: AcceptanceExpectation, fact: AcceptanceReportFacts): boolean {
  if (fact.kind !== "projected" || fact.otherFailures > 0) return false;
  const failing = fact.testcases.filter(({ outcome }) => outcome === "failed");
  return failing.length > 0 && failing.every((testcase) => {
    if (testcase.collectionError) return false;
    const expected = expectation.contracts.find(({ files }) => files.some(({ path }) => path === testcase.file));
    if (expected === undefined) return false;
    if (expected.phase === "red") return true;
    const fileAnchors = expected.files.find(({ path }) => path === testcase.file)?.anchors ?? [];
    const anchors = testcaseAnchors(testcase.name, fileAnchors);
    return anchors.length > 0 && !isDue(expected, anchors, expectation.wave);
  });
}

export function judgeAcceptance(
  expectation: AcceptanceExpectation,
  facts: readonly AcceptanceReportFacts[],
): AcceptanceJudgment {
  const failures: AcceptanceFailure[] = [
    ...expectation.unobservable.map(({ contract, reason }) => freeze({ kind: "acceptance-unobservable" as const, contract, reason })),
    ...expectation.contracts.flatMap((expected) => contractFailures(expected, expectation.wave, facts)),
  ];
  return freeze({
    failures: Object.freeze(failures),
    excusedCheckIds: Object.freeze(facts.filter((fact) => excused(expectation, fact)).map(({ checkId }) => checkId)),
  });
}

/** One-line operator rendering of an acceptance failure. */
export function renderAcceptanceFailure(failure: AcceptanceFailure): string {
  const names = (testcases: readonly TestcaseRef[]): string =>
    testcases.map(({ file, name }) => `'${name}' (${file})`).join(", ");
  switch (failure.kind) {
    case "acceptance-unobservable":
      return `${failure.contract}: ${failure.reason}`;
    case "acceptance-not-observed":
      return `${failure.contract}: no report ran an acceptance testcase${failure.reasons.length === 0 ? "" : ` (${failure.reasons.join("; ")})`}`;
    case "acceptance-file-not-collected":
      return `${failure.contract}: ${failure.file} yielded no collected testcase — a file that never loads is not a behavioral RED`;
    case "acceptance-testcase-unanchored":
      return `${failure.contract}: testcase '${failure.name}' in ${failure.file} names none of the file's Requirements ('AS-003: …')`;
    case "acceptance-anchor-untested":
      return `${failure.contract}: ${failure.anchor} is declared for ${failure.file} but no testcase there names it`;
    case "acceptance-not-red":
      return `${failure.contract}: acceptance testcases pass before any claimant implemented them: ${names(failure.testcases)}`;
    case "acceptance-not-green":
      return `${failure.contract}: due acceptance testcases are not passing: ${names(failure.testcases)}`;
    case "acceptance-testcase-missing":
      return `${failure.contract}: frozen acceptance testcases no longer run: ${names(failure.testcases)}`;
  }
}

// ---------------------------------------------------------------------------
// The Acceptance Freeze
// ---------------------------------------------------------------------------

/**
 * Stamp what an ACCEPTED gate observed: the contract Wave freezes its bytes
 * and red roster; the first gate after a Contract Revision re-records the
 * roster green. Re-stamping an identical freeze is a no-op; a different one
 * is refused — only a Contract Revision changes a frozen contract.
 */
export function stampAcceptanceFreezes(
  contracts: readonly AcceptanceContract[],
  expectation: AcceptanceExpectation,
  facts: readonly AcceptanceReportFacts[],
  observations: FrozenPathObservations,
): DomainResult<readonly AcceptanceContract[], string> {
  const errors: string[] = [];
  const stamped = contracts.map((contract): AcceptanceContract => {
    const expected = expectation.contracts.find(({ contract: id }) => id === contract.id);
    if (expected === undefined || !recordsRoster(expected)) return contract;
    const observed = facts.flatMap((fact) => fact.kind === "projected" ? fact.testcases : []);
    const roster = nonEmpty(observedRoster(expected, observed));
    if (roster === null) {
      errors.push(`${contract.id}: no anchored acceptance testcase was observed to freeze`);
      return contract;
    }
    if (expected.phase === "green") {
      return contract.freeze.state === "revised"
        ? freeze({ ...contract, freeze: freeze({ state: "frozen", wave: expectation.wave, paths: contract.freeze.paths, roster }) })
        : contract;
    }
    const paths = frozenPathDigests(contract, observations);
    if (!paths.ok) {
      errors.push(`${contract.id}: frozen paths could not be read to stamp the freeze: ${renderFrozenPathProblems(paths.error)}`);
      return contract;
    }
    const next: AcceptanceFreeze = freeze({ state: "frozen", wave: expectation.wave, paths: paths.value, roster });
    if (contract.freeze.state === "awaiting-red") return freeze({ ...contract, freeze: next });
    if (canonicalStructuralEquals(contract.freeze, next)) return contract;
    errors.push(`${contract.id} is already frozen with different bytes or roster; only a Contract Revision changes a frozen contract`);
    return contract;
  });
  return errors.length > 0 ? err(errors.join("; ")) : ok(Object.freeze(stamped));
}

/** What the shell saw at one frozen path: its digest, or why it could not be
 *  read without following a link. */
export type FrozenPathObservation =
  | Readonly<{ kind: "digest"; sha256: ArtifactDigest }>
  | Readonly<{ kind: "unreadable"; reason: string }>;

/** The shell's observations, by frozen path. A path with no entry was never
 *  observed — the contracts changed after the shell chose what to read. */
export type FrozenPathObservations = ReadonlyMap<string, FrozenPathObservation>;

/** A frozen path the core could not digest. */
export type FrozenPathProblem =
  | Readonly<{ kind: "unreadable"; path: string; reason: string }>
  | Readonly<{ kind: "not-observed"; path: string }>;

export function renderFrozenPathProblems(problems: readonly FrozenPathProblem[]): string {
  return problems.map((problem) => problem.kind === "unreadable"
    ? `'${problem.path}' (${problem.reason})`
    : `'${problem.path}' (not observed)`).join(", ");
}

/** Each frozen path with its observed digest, in freeze order, or every path
 *  that could not be digested and why. */
export function frozenPathDigests(
  contract: Pick<AcceptanceContract, "types" | "acceptance">,
  observations: FrozenPathObservations,
): DomainResult<NonEmpty<FrozenPathDigest>, NonEmpty<FrozenPathProblem>> {
  const paths = frozenPaths(contract);
  const digests: FrozenPathDigest[] = [];
  const problems: FrozenPathProblem[] = [];
  for (const path of paths) {
    const observation = observations.get(path);
    if (observation === undefined) problems.push(freeze({ kind: "not-observed", path }));
    else if (observation.kind === "unreadable") problems.push(freeze({ kind: "unreadable", path, reason: observation.reason }));
    else digests.push(freeze({ path, sha256: observation.sha256 }));
  }
  const failed = nonEmpty(problems);
  return failed === null ? ok(nonEmpty(digests)!) : err(failed);
}

/** One operator message naming every drifted frozen path. */
export function renderFrozenPathDrift(drift: readonly FrozenPathDrift[]): string {
  const what = ({ actual }: FrozenPathDrift): string => actual === null
    ? "was not observed"
    : actual.kind === "unreadable" ? `is missing or unreadable (${actual.reason})` : "changed";
  return "frozen acceptance drifted: " + drift.map((entry) => `${entry.contract} '${entry.path}' ${what(entry)}`).join("; ") +
    " — restore the frozen bytes, or record an operator Contract Revision (helper revise-contract)";
}

export type FrozenPathDrift = Readonly<{
  contract: string;
  path: string;
  expected: ArtifactDigest;
  /** What the shell saw instead; null when it never observed the path. */
  actual: FrozenPathObservation | null;
}>;

/** Every frozen path whose current bytes differ from the freeze, or could not be read. */
export function frozenPathDrift(
  contracts: readonly AcceptanceContract[],
  observations: FrozenPathObservations,
): readonly FrozenPathDrift[] {
  return Object.freeze(contracts.flatMap((contract) => {
    if (contract.freeze.state === "awaiting-red") return [];
    return contract.freeze.paths.flatMap(({ path, sha256 }) => {
      const actual = observations.get(path) ?? null;
      return actual?.kind === "digest" && actual.sha256 === sha256
        ? []
        : [freeze({ contract: contract.id, path, expected: sha256, actual })];
    });
  }));
}

/** Every frozen path of every contract, for the shell to digest: the gate
 *  stamps an awaiting-red contract's bytes and drift-checks the rest. */
export function frozenPathsToObserve(contracts: readonly AcceptanceContract[]): readonly string[] {
  return Object.freeze([...new Set(contracts.flatMap((contract) => frozenPaths(contract)))]);
}

// ---------------------------------------------------------------------------
// Wire parsers
// ---------------------------------------------------------------------------

type Parsed<T> = DomainResult<T, string>;

function exactRecord(raw: unknown, keys: readonly string[], path: string): Parsed<Record<string, unknown>> {
  const record = parseExactRecord(raw, keys, path);
  return record.ok ? ok(record.value) : err(exactRecordErrors(record, path, "a plain object").join("; "));
}

const text = (raw: unknown, path: string): Parsed<string> =>
  typeof raw === "string" && raw.trim() !== "" ? ok(raw) : err(`${path} must be a non-empty string`);

const parseWave = (raw: unknown, path: string): Parsed<number> =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 ? ok(raw) : err(`${path} must be a positive integer`);

function list<T>(raw: unknown, path: string, item: (value: unknown, path: string) => Parsed<T>): Parsed<readonly T[]> {
  if (!Array.isArray(raw)) return err(`${path} must be an array`);
  const values: T[] = [];
  for (const [index, value] of raw.entries()) {
    const parsed = item(value, `${path}[${index}]`);
    if (!parsed.ok) return parsed;
    values.push(parsed.value);
  }
  return ok(Object.freeze(values));
}

function nonEmptyList<T>(raw: unknown, path: string, item: (value: unknown, path: string) => Parsed<T>): Parsed<NonEmpty<T>> {
  if (Array.isArray(raw) && raw.length === 0) return err(`${path} must be non-empty`);
  const values = list(raw, path, item);
  return values.ok ? ok(nonEmpty(values.value)!) : values;
}

function parseTypes(raw: unknown, path: string): Parsed<ContractTypes> {
  if (isPlainRecord(raw) && raw.kind === "file") {
    const record = exactRecord(raw, ["kind", "path"], path);
    if (!record.ok) return record;
    const file = text(record.value.path, `${path}.path`);
    return file.ok ? ok(freeze({ kind: "file", path: file.value })) : file;
  }
  if (isPlainRecord(raw) && raw.kind === "none") {
    const record = exactRecord(raw, ["kind", "reason"], path);
    if (!record.ok) return record;
    const reason = text(record.value.reason, `${path}.reason`);
    return reason.ok ? ok(freeze({ kind: "none", reason: reason.value })) : reason;
  }
  return err(`${path}.kind must be file or none`);
}

function parseAcceptanceFile(raw: unknown, path: string): Parsed<ContractAcceptanceFile> {
  const record = exactRecord(raw, ["path", "anchors"], path);
  if (!record.ok) return record;
  const file = text(record.value.path, `${path}.path`);
  if (!file.ok) return file;
  const anchors = nonEmptyList(record.value.anchors, `${path}.anchors`, (value, anchorPath) =>
    typeof value === "string" && COVERABLE_ANCHOR.test(value) ? ok(value) : err(`${anchorPath} must be an FR-n or AS-n id`));
  if (!anchors.ok) return anchors;
  return ok(freeze({ path: file.value, anchors: anchors.value }));
}

function parsePathDigests(raw: unknown, path: string, expected: readonly string[]): Parsed<NonEmpty<FrozenPathDigest>> {
  const entries = nonEmptyList(raw, path, (value, entryPath) => {
    const record = exactRecord(value, ["path", "sha256"], entryPath);
    if (!record.ok) return record;
    const file = text(record.value.path, `${entryPath}.path`);
    const sha256 = parseArtifactDigest(record.value.sha256);
    if (!file.ok) return file;
    return sha256.ok ? ok(freeze({ path: file.value, sha256: sha256.value })) : err(`${entryPath}.sha256 must be a sha256 digest`);
  });
  if (!entries.ok) return entries;
  return canonicalStructuralEquals(entries.value.map(({ path: file }) => file), expected)
    ? entries
    : err(`${path} must digest exactly the contract's frozen paths, in order`);
}

function parseRoster(raw: unknown, path: string, files: readonly ContractAcceptanceFile[]): Parsed<NonEmpty<AcceptanceTestcase>> {
  return nonEmptyList(raw, path, (value, entryPath) => {
    const record = exactRecord(value, ["file", "name", "anchors"], entryPath);
    if (!record.ok) return record;
    const file = files.find(({ path: declared }) => declared === record.value.file);
    const name = text(record.value.name, `${entryPath}.name`);
    if (file === undefined) return err(`${entryPath}.file must be one of the contract's acceptance files`);
    if (!name.ok) return name;
    const anchors = nonEmptyList(record.value.anchors, `${entryPath}.anchors`, (anchor, anchorPath) =>
      typeof anchor === "string" && file.anchors.includes(anchor) ? ok(anchor) : err(`${anchorPath} must be one of the file's anchors`));
    return anchors.ok ? ok(freeze({ file: file.path, name: name.value, anchors: anchors.value })) : anchors;
  });
}

function parseFreeze(raw: unknown, path: string, contract: Pick<AcceptanceContract, "types" | "acceptance">): Parsed<AcceptanceFreeze> {
  const expected = frozenPaths(contract);
  if (isPlainRecord(raw) && raw.state === "awaiting-red") {
    const record = exactRecord(raw, ["state"], path);
    return record.ok ? ok(freeze({ state: "awaiting-red" })) : record;
  }
  if (isPlainRecord(raw) && raw.state === "frozen") {
    const record = exactRecord(raw, ["state", "wave", "paths", "roster"], path);
    if (!record.ok) return record;
    const frozenWave = parseWave(record.value.wave, `${path}.wave`);
    const paths = parsePathDigests(record.value.paths, `${path}.paths`, expected);
    const roster = parseRoster(record.value.roster, `${path}.roster`, contract.acceptance);
    if (!frozenWave.ok) return frozenWave;
    if (!paths.ok) return paths;
    if (!roster.ok) return roster;
    return ok(freeze({ state: "frozen", wave: frozenWave.value, paths: paths.value, roster: roster.value }));
  }
  if (isPlainRecord(raw) && raw.state === "revised") {
    const record = exactRecord(raw, ["state", "paths"], path);
    if (!record.ok) return record;
    const paths = parsePathDigests(record.value.paths, `${path}.paths`, expected);
    return paths.ok ? ok(freeze({ state: "revised", paths: paths.value })) : paths;
  }
  return err(`${path}.state must be awaiting-red, frozen or revised`);
}

function parseRevision(raw: unknown, path: string, index: number, expected: readonly string[]): Parsed<ContractRevision> {
  const record = exactRecord(raw, ["revision", "reason", "previous", "paths", "revalidatedTaskIds"], path);
  if (!record.ok) return record;
  if (record.value.revision !== index + 1) return err(`${path}.revision must be ${index + 1}`);
  const reason = text(record.value.reason, `${path}.reason`);
  const previous = parsePathDigests(record.value.previous, `${path}.previous`, expected);
  const paths = parsePathDigests(record.value.paths, `${path}.paths`, expected);
  const taskIds = list(record.value.revalidatedTaskIds, `${path}.revalidatedTaskIds`, text);
  if (!reason.ok) return reason;
  if (!previous.ok) return previous;
  if (!paths.ok) return paths;
  if (!taskIds.ok) return taskIds;
  return ok(freeze({
    revision: index + 1,
    reason: reason.value,
    previous: previous.value,
    paths: paths.value,
    revalidatedTaskIds: taskIds.value,
  }));
}

function parseContract(raw: unknown, path: string): Parsed<AcceptanceContract> {
  const record = exactRecord(raw, [
    "schemaVersion", "id", "title", "statement", "contractTask", "types", "acceptance", "supportedDomain", "freeze", "revisions",
  ], path);
  if (!record.ok) return record;
  const fields = record.value;
  if (fields.schemaVersion !== 1) return err(`${path}.schemaVersion must be 1`);
  if (typeof fields.id !== "string" || !CONTRACT_ID.test(fields.id)) return err(`${path}.id must be CT-n`);
  const title = text(fields.title, `${path}.title`);
  const statement = text(fields.statement, `${path}.statement`);
  const contractTask = text(fields.contractTask, `${path}.contractTask`);
  const types = parseTypes(fields.types, `${path}.types`);
  const acceptance = nonEmptyList(fields.acceptance, `${path}.acceptance`, parseAcceptanceFile);
  if (!title.ok) return title;
  if (!statement.ok) return statement;
  if (!contractTask.ok) return contractTask;
  if (!types.ok) return types;
  if (!acceptance.ok) return acceptance;
  const files = acceptance.value;
  const paths = frozenPaths({ types: types.value, acceptance: files });
  if (new Set(paths.map(normalizePlanPath)).size !== paths.length) return err(`${path} freezes one path twice`);
  const unsafe = paths.find((frozen) => !isRepoRelativePlanPath(frozen));
  if (unsafe !== undefined) return err(`${path} freezes '${unsafe}', which is not a repository-relative path`);
  if (fields.supportedDomain !== null && !files.some(({ path: file }) => file === fields.supportedDomain)) {
    return err(`${path}.supportedDomain must be null or one of the acceptance files`);
  }
  const frozen = parseFreeze(fields.freeze, `${path}.freeze`, { types: types.value, acceptance: files });
  if (!frozen.ok) return frozen;
  if (!Array.isArray(fields.revisions)) return err(`${path}.revisions must be an array`);
  const revisions: ContractRevision[] = [];
  for (const [index, value] of fields.revisions.entries()) {
    const revision = parseRevision(value, `${path}.revisions[${index}]`, index, paths);
    if (!revision.ok) return revision;
    revisions.push(revision.value);
  }
  // The freeze and its revision history must tell one story: a revision is
  // recorded only after the freeze, and the bytes frozen now are the bytes
  // the last revision stamped.
  const last = revisions.at(-1);
  if (last === undefined && frozen.value.state === "revised") return err(`${path}.freeze is revised but records no revision`);
  if (last !== undefined && frozen.value.state === "awaiting-red") return err(`${path}.revisions precede the freeze`);
  if (last !== undefined && frozen.value.state !== "awaiting-red" && !canonicalStructuralEquals(frozen.value.paths, last.paths)) {
    return err(`${path}.freeze.paths must equal the last revision's paths`);
  }
  return ok(freeze({
    schemaVersion: 1,
    id: fields.id,
    title: title.value,
    statement: statement.value,
    contractTask: contractTask.value,
    types: types.value,
    acceptance: files,
    supportedDomain: fields.supportedDomain as string | null,
    freeze: frozen.value,
    revisions: Object.freeze(revisions),
  }));
}

/** Parse the persisted `acceptance_contracts`: exact records, unique ids, and
 *  no path frozen by two contracts. */
export function parseAcceptanceContracts(raw: unknown): Parsed<readonly AcceptanceContract[]> {
  const contracts = list(raw, "acceptance_contracts", parseContract);
  if (!contracts.ok) return contracts;
  const ids = contracts.value.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) return err("acceptance_contracts must have unique ids");
  const paths = contracts.value.flatMap((contract) => frozenPaths(contract));
  if (new Set(paths.map(normalizePlanPath)).size !== paths.length) {
    return err("acceptance_contracts must not freeze one path in two contracts");
  }
  return contracts;
}

const OUTCOMES: readonly ReportTestcaseOutcome[] = ["passed", "failed", "skipped"];

function parseObservedTestcase(raw: unknown, path: string): Parsed<ObservedAcceptanceTestcase> {
  const record = exactRecord(raw, ["file", "name", "outcome", "failureType", "collectionError"], path);
  if (!record.ok) return record;
  const { file, name, outcome, failureType, collectionError } = record.value;
  if (typeof file !== "string" || file === "" || typeof name !== "string" || name === "" ||
      !OUTCOMES.includes(outcome as ReportTestcaseOutcome) ||
      (failureType !== null && typeof failureType !== "string") || typeof collectionError !== "boolean") {
    return err(`${path} has an invalid file, name, outcome, failureType or collectionError`);
  }
  return ok(freeze({
    file,
    name,
    outcome: outcome as ReportTestcaseOutcome,
    failureType: failureType as string | null,
    collectionError,
  }));
}

function parseGateExpectation(raw: unknown, path: string): Parsed<ContractGateExpectation> {
  if (!isPlainRecord(raw) || (raw.phase !== "red" && raw.phase !== "green")) return err(`${path}.phase must be red or green`);
  const green = raw.phase === "green";
  const record = exactRecord(raw, green
    ? ["contract", "files", "phase", "dueWave", "roster"]
    : ["contract", "files", "phase", "dueWave"], path);
  if (!record.ok) return record;
  const { contract, dueWave } = record.value;
  if (typeof contract !== "string" || !CONTRACT_ID.test(contract)) return err(`${path}.contract must be CT-n`);
  const files = nonEmptyList(record.value.files, `${path}.files`, parseAcceptanceFile);
  if (!files.ok) return files;
  if (!isPlainRecord(dueWave) || Object.entries(dueWave).some(([anchor, due]) =>
    !COVERABLE_ANCHOR.test(anchor) || !parseWave(due, anchor).ok)) {
    return err(`${path}.dueWave must map FR-n/AS-n ids to positive Waves`);
  }
  const base = { contract, files: files.value, dueWave: freeze({ ...(dueWave as Record<string, number>) }) };
  if (!green) return ok(freeze({ ...base, phase: "red" }));
  const roster = record.value.roster;
  const parsedRoster = roster === null ? ok(null) : parseRoster(roster, `${path}.roster`, files.value);
  if (!parsedRoster.ok) return parsedRoster;
  return ok(freeze({ ...base, phase: "green", roster: parsedRoster.value }));
}

/** Parse the expectation a persisted completion result was judged under. */
export function parseAcceptanceExpectation(raw: unknown, path = "acceptance.expectation"): Parsed<AcceptanceExpectation> {
  const record = exactRecord(raw, ["wave", "contracts", "unobservable"], path);
  if (!record.ok) return record;
  const gateWave = parseWave(record.value.wave, `${path}.wave`);
  if (!gateWave.ok) return gateWave;
  const contracts = list(record.value.contracts, `${path}.contracts`, parseGateExpectation);
  if (!contracts.ok) return contracts;
  const unobservable = list(record.value.unobservable, `${path}.unobservable`, (value, entryPath) => {
    const entry = exactRecord(value, ["contract", "reason"], entryPath);
    if (!entry.ok) return entry;
    const contract = text(entry.value.contract, `${entryPath}.contract`);
    const reason = text(entry.value.reason, `${entryPath}.reason`);
    if (!contract.ok) return contract;
    return reason.ok ? ok(freeze({ contract: contract.value, reason: reason.value })) : reason;
  });
  if (!unobservable.ok) return unobservable;
  return ok(freeze({ wave: gateWave.value, contracts: contracts.value, unobservable: unobservable.value }));
}

/** Parse one persisted `AcceptanceReportFacts` exactly. */
export function parseAcceptanceReportFacts(raw: unknown, path = "acceptance"): Parsed<AcceptanceReportFacts> {
  const unprojectable = isPlainRecord(raw) && raw.kind === "unprojectable";
  const record = exactRecord(raw, unprojectable
    ? ["kind", "checkId", "reportDigest", "reason"]
    : ["kind", "checkId", "reportDigest", "testcases", "otherFailures"], path);
  if (!record.ok) return record;
  const checkId = text(record.value.checkId, `${path}.checkId`);
  const reportDigest = parseArtifactDigest(record.value.reportDigest);
  if (!checkId.ok) return checkId;
  if (!reportDigest.ok) return err(`${path}.reportDigest must be a sha256 digest`);
  if (unprojectable) {
    const reason = text(record.value.reason, `${path}.reason`);
    return reason.ok
      ? ok(freeze({ kind: "unprojectable", checkId: checkId.value, reportDigest: reportDigest.value, reason: reason.value }))
      : reason;
  }
  if (record.value.kind !== "projected") return err(`${path}.kind must be projected or unprojectable`);
  const testcases = list(record.value.testcases, `${path}.testcases`, parseObservedTestcase);
  if (!testcases.ok) return testcases;
  const otherFailures = record.value.otherFailures;
  if (typeof otherFailures !== "number" || !Number.isSafeInteger(otherFailures) || otherFailures < 0) {
    return err(`${path}.otherFailures must be a non-negative integer`);
  }
  return ok(freeze({
    kind: "projected",
    checkId: checkId.value,
    reportDigest: reportDigest.value,
    testcases: testcases.value,
    otherFailures,
  }));
}
