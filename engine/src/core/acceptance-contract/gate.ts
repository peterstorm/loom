/**
 * The Wave Gate's view of a contract: which testcase belongs to which
 * acceptance file, what each gate owes each contract (nothing before its
 * Wave, RED in it, GREEN-by-Requirement after), the acceptance facts a report
 * yields, and the RED/GREEN judgment over them.
 */

import type { ArtifactDigest, NonEmpty } from "../orchestration-contract";
import { normalizePlanPath } from "../plan-path-match";
import type { JunitTestcasesResult, ReportTestcaseOutcome } from "../structured-test-report";
import { freeze, nonEmpty } from "./kernel";
import type { AcceptanceContract, AcceptanceTestcase, ContractAcceptanceFile, ContractTaskView } from "./model";
import { contractWave, dueWaves } from "./tasks";

/**
 * The declared acceptance file a JUnit testcase belongs to, or null. Vitest
 * reports the test file relative to its root, so the declared repository path
 * may be longer; Surefire reports the class name, which maps to the declared
 * `.java`/`.kt` path. Matching is by whole path segments, never by suffix text.
 * An exact path wins; otherwise a segment-suffix match attributes the testcase
 * only when exactly one declared file matches — an ambiguous testcase is left
 * unattributed, which fails closed rather than crediting the wrong contract.
 */
export function testcaseAcceptanceFile(files: readonly string[], classname: string): string | null {
  const reported = normalizePlanPath(classname);
  const exact = files.find((file) => normalizePlanPath(file) === reported);
  if (exact !== undefined) return exact;
  const jvmClass = !reported.includes("/") && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(reported)
    ? reported.split("$")[0]!.replace(/\./g, "/")
    : null;
  const matches = files.filter((file) => {
    const declared = normalizePlanPath(file);
    if (declared.endsWith(`/${reported}`)) return true;
    if (jvmClass === null) return false;
    const withoutExtension = declared.replace(/\.[^./]+$/, "");
    return withoutExtension === jvmClass || withoutExtension.endsWith(`/${jvmClass}`);
  });
  return matches.length === 1 ? matches[0]! : null;
}

const ANCHOR_MENTION = /\b((?:FR|AS)-\d+):/g;

/** The declared anchors a testcase name decides (`AS-003: …`), in name order. */
function testcaseAnchors(name: string, fileAnchors: readonly string[]): readonly string[] {
  return [...new Set([...name.matchAll(ANCHOR_MENTION)].map((match) => match[1]!))]
    .filter((anchor) => fileAnchors.includes(anchor));
}

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
export const recordsRoster = (expected: ContractGateExpectation): boolean =>
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
  return acceptanceExpectation([], [], wave);
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

/** The anchors a testcase decides among those its own acceptance file declares. */
const decidedAnchors = (expected: ContractGateExpectation, testcase: TestcaseRef): readonly string[] =>
  testcaseAnchors(testcase.name, expected.files.find(({ path }) => path === testcase.file)?.anchors ?? []);

/** The real (collected) testcases of one contract's files that name an
 *  anchor, deduplicated, in report order. */
export function observedRoster(expected: ContractGateExpectation, observed: readonly ObservedAcceptanceTestcase[]): readonly AcceptanceTestcase[] {
  const roster: AcceptanceTestcase[] = [];
  for (const testcase of observed) {
    if (testcase.collectionError || roster.some((entry) => sameTestcase(entry, testcase))) continue;
    const anchors = nonEmpty(decidedAnchors(expected, testcase));
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
    const anchors = decidedAnchors(expected, testcase);
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

/**
 * The acceptance a gate judged: the expectation derived from the protected
 * graph and the facts observed from each check's report, bound to its digest.
 * Absent means the gate owed no contract anything — the shape every result
 * written before contracts existed already has — and is the only encoding of
 * that: only `acceptanceObservation` mints one, and it returns none for an
 * expectation that owes nothing.
 */
declare const owingObservation: unique symbol;
export type AcceptanceObservation = Readonly<{
  expectation: AcceptanceExpectation;
  facts: readonly AcceptanceReportFacts[];
}> & Readonly<{ [owingObservation]: true }>;

/** The observation a gate records, or undefined when its expectation owes no
 *  contract anything. Facts are one per check; the producer reads one report
 *  per check and the parser refuses a check named twice. */
export function acceptanceObservation(
  expectation: AcceptanceExpectation,
  facts: readonly AcceptanceReportFacts[],
): AcceptanceObservation | undefined {
  return owesAcceptance(expectation)
    ? freeze({ expectation, facts: Object.freeze([...facts]) }) as AcceptanceObservation
    : undefined;
}

/** The checks whose non-zero exit an observation excuses, and the failures it records. */
export type RecordedAcceptanceVerdict = Readonly<{
  excused: ReadonlySet<string>;
  failures: readonly AcceptanceFailure[];
}>;

/** What a recorded acceptance observation decides — the one judgment the
 *  completion-suite evaluator and receipt parser share. An absent observation,
 *  a gate owing no contract anything, excuses nothing and records nothing. */
export function recordedAcceptanceVerdict(acceptance: AcceptanceObservation | undefined): RecordedAcceptanceVerdict {
  if (acceptance === undefined) return freeze({ excused: new Set<string>(), failures: Object.freeze([]) });
  const judgment = judgeAcceptance(acceptance.expectation, acceptance.facts);
  return freeze({ excused: new Set(judgment.excusedCheckIds), failures: judgment.failures });
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
