/**
 * The I6 judge: did one attempt epoch show a behavioral red on the Task's test
 * files, then the first write to a Task implementation file, then a green run
 * of every Task test file, in that order (FR-006..FR-012)?
 *
 * Pure, total and deterministic over the ordered ledger facts (AD-5). It never
 * classifies `file_list` itself: the settlement shell hands it a ready
 * `TestFileClassification` (INV-2), and every reported file identity maps to
 * a declared test file only through `attributeReportedFile` (INV-5).
 */

import { normalizePlanPath } from "./plan-path-match";
import { attributeReportedFile } from "./report-file-attribution";
import type {
  JudgeRedThenGreenFn,
  RedThenGreenGap,
  RedThenGreenObservation,
  RunRef,
  TestFileClassification,
  TestFileResult,
} from "./red-then-green-types";
import type { Evidence } from "../machine/types";

type TestRunFact = Extract<Evidence, { kind: "TestRun" }>;

/**
 * A trusted ledger run: an exit code and a parsed report with recorded
 * per-file results. `results` carries only the results attributed to a Task
 * test file, keyed by that declared file.
 */
type QualifyingRun = Readonly<{
  ref: RunRef;
  exit: number;
  results: ReadonlyMap<string, readonly TestFileResult[]>;
}>;

/** One epoch's facts, read once into the three things the steps consult. */
type EpochReading = Readonly<{
  qualifyingRuns: readonly QualifyingRun[];
  firstImplementationWrite: Readonly<{ index: number; path: string }> | null;
  holdsUntrustedRun: boolean;
}>;

const ABSOLUTE = /^(?:\/|[A-Za-z]:\/)/;

/** A written path as repository-relative, or null when it is absolute outside the root. */
function repositoryPath(written: string, repositoryRoot: string): string | null {
  const path = normalizePlanPath(written);
  if (!ABSOLUTE.test(path)) return path;
  const prefix = `${normalizePlanPath(repositoryRoot).replace(/\/+$/, "")}/`;
  return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : null;
}

function attributedResults(
  run: TestRunFact,
  testFiles: readonly string[],
  repositoryRoot: string,
): ReadonlyMap<string, readonly TestFileResult[]> | null {
  const files = run.report?.files;
  if (files?.kind !== "recorded") return null;
  const byFile = new Map<string, TestFileResult[]>();
  for (const result of files.results) {
    const declared = attributeReportedFile(testFiles, result.file, repositoryRoot);
    if (declared !== null) byFile.set(declared, [...(byFile.get(declared) ?? []), result]);
  }
  return byFile;
}

function readEpoch(
  events: readonly Evidence[],
  classification: TestFileClassification,
  repositoryRoot: string,
): EpochReading {
  const implementationFiles = new Map(
    classification.implementationFiles.map((file) => [normalizePlanPath(file), file] as const),
  );
  const qualifyingRuns: QualifyingRun[] = [];
  let firstImplementationWrite: EpochReading["firstImplementationWrite"] = null;
  let holdsUntrustedRun = false;
  // Local accumulation over one ordered pass; nothing escapes but the frozen reading.
  for (const [index, event] of events.entries()) {
    if (event.kind === "FileWrite" && firstImplementationWrite === null) {
      const relative = repositoryPath(event.path, repositoryRoot);
      const declared = relative === null ? undefined : implementationFiles.get(relative);
      if (declared !== undefined) firstImplementationWrite = Object.freeze({ index, path: declared });
    }
    if (event.kind !== "TestRun") continue;
    const results = attributedResults(event, classification.testFiles, repositoryRoot);
    if (results === null || event.exit === null) {
      holdsUntrustedRun = true;
      continue;
    }
    qualifyingRuns.push({ ref: Object.freeze({ index, command: event.command }), exit: event.exit, results });
  }
  return Object.freeze({ qualifyingRuns: Object.freeze(qualifyingRuns), firstImplementationWrite, holdsUntrustedRun });
}

/** A behavioral red: some Task test file has a failing testcase that is not a collection error (FR-007). */
const isRed = (run: QualifyingRun): boolean =>
  [...run.results.values()].some((results) => results.some(({ failed, collectionError }) => failed > 0 && !collectionError));

/** A full green: exit 0, and every Task test file executed, passed and collected (FR-006). */
const isGreen = (run: QualifyingRun, testFiles: readonly string[]): boolean =>
  run.exit === 0 && testFiles.every((file) => {
    const results = run.results.get(file) ?? [];
    return results.reduce((sum, { executed }) => sum + executed, 0) >= 1 &&
      results.every(({ failed, collectionError }) => failed === 0 && !collectionError);
  });

const unproven = (gap: RedThenGreenGap): RedThenGreenObservation =>
  Object.freeze({ kind: "unproven", gap: Object.freeze(gap) });

/**
 * Judge I6 over one epoch's ordered events. Gaps follow the frozen precedence:
 * no-test-files > implementation-write-missing > red-missing |
 * red-after-first-implementation-write > green-missing. A red or green step
 * unmet by qualifying runs is `untrustedOnly` when the epoch holds a
 * non-qualifying TestRun or the Task's test result is Pi-structured.
 */
export const judgeRedThenGreen: JudgeRedThenGreenFn = (events, classification, repositoryRoot, untrustedEvidence) => {
  if (classification.testFiles.length === 0) return unproven({ kind: "no-test-files" });
  const epoch = readEpoch(events, classification, repositoryRoot);
  const write = epoch.firstImplementationWrite;
  if (write === null) return unproven({ kind: "implementation-write-missing" });
  const untrustedOnly = untrustedEvidence || epoch.holdsUntrustedRun;
  const red = epoch.qualifyingRuns.find(isRed);
  if (red === undefined) return unproven({ kind: "red-missing", untrustedOnly });
  if (red.ref.index > write.index) return unproven({ kind: "red-after-first-implementation-write" });
  const green = epoch.qualifyingRuns.find((run) => run.ref.index > write.index && isGreen(run, classification.testFiles));
  if (green === undefined) return unproven({ kind: "green-missing", untrustedOnly });
  return Object.freeze({ kind: "shown", red: red.ref, implementationWrite: write.path, green: green.ref });
};
