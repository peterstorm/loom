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

/** Judge a result under the expectation it recorded: the stance of every test
 *  that exercises authority and process rules independent of the live graph. */
export function evaluateAsRecorded(authority: AuthorizedWaveCompletionSuite, result: unknown): CompletionSuiteEvaluation {
  return evaluateWaveCompletionSuite(authority, result, recordedExpectation(result));
}
