import {
  evaluateWaveCompletionSuite,
  type AuthorizedWaveCompletionSuite,
  type CompletionSuiteEvaluation,
} from "../../src/core/completion-suite";
import {
  emptyAcceptanceExpectation,
  parseAcceptanceExpectation,
  type AcceptanceExpectation,
} from "../../src/core/acceptance-contract";
import { isPlainRecord } from "../../src/core/plain-record";

/** The expectation a raw result recorded, or the empty one it implies when it
 *  records no acceptance (every result with no contract in play). A recorded
 *  expectation that does not parse is a broken fixture, never "owes nothing". */
export function recordedExpectation(result: unknown): AcceptanceExpectation {
  if (!isPlainRecord(result) || !Object.hasOwn(result, "acceptance")) {
    return emptyAcceptanceExpectation(isPlainRecord(result) && typeof result.wave === "number" ? result.wave : 1);
  }
  const acceptance = result.acceptance;
  const recorded = parseAcceptanceExpectation(isPlainRecord(acceptance) ? acceptance.expectation : undefined);
  if (!recorded.ok) throw new Error(`fixture result records an unparseable acceptance expectation: ${recorded.error}`);
  return recorded.value;
}

/** A raw result in which every authorized check ran green (exit 0, no
 *  timeout, no signal) and produced exactly the report its policy requires. */
export function greenCompletionSuiteResult(
  authority: AuthorizedWaveCompletionSuite,
  report: Readonly<{ digest: string; byteLength: number }>,
): Record<string, unknown> {
  return {
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
          : { kind: "produced", path: check.reportPolicy.path, digest: report.digest, byteLength: report.byteLength },
      },
    })),
  };
}

/** Judge a result under the expectation it recorded: the stance of every test
 *  that exercises authority and process rules independent of the live graph. */
export function evaluateAsRecorded(authority: AuthorizedWaveCompletionSuite, result: unknown): CompletionSuiteEvaluation {
  return evaluateWaveCompletionSuite(authority, result, recordedExpectation(result));
}
