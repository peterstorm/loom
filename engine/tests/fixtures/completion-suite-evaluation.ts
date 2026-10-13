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
 *  carries no acceptance observation (every result with no contract in play). */
export function recordedExpectation(result: unknown): AcceptanceExpectation {
  const wave = isPlainRecord(result) && typeof result.wave === "number" ? result.wave : 1;
  const acceptance = isPlainRecord(result) && isPlainRecord(result.acceptance) ? result.acceptance : null;
  const recorded = acceptance === null ? null : parseAcceptanceExpectation(acceptance.expectation);
  return recorded?.ok ? recorded.value : emptyAcceptanceExpectation(wave);
}

/** Judge a result under the expectation it recorded: the stance of every test
 *  that exercises authority and process rules independent of the live graph. */
export function evaluateAsRecorded(authority: AuthorizedWaveCompletionSuite, result: unknown): CompletionSuiteEvaluation {
  return evaluateWaveCompletionSuite(authority, result, recordedExpectation(result));
}
