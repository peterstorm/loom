/**
 * Test-only smart constructor for the branded TestReportSummary.
 *
 * TestReportSummary is branded (types.ts): parseReportSummary is its sole
 * producer, so tests can no longer inline `{ total, failed, source }` where a
 * TestReportSummary is expected. This helper mints one through the real
 * parser and asserts sanity, so a typo (failed > total) fails loudly in the
 * fixture rather than silently demoting to null.
 */

import { parseReportSummary } from "../../src/machine/test-report";
import type { TestReportSummary } from "../../src/machine/types";

export function reportSummary(
  total: number,
  failed: number,
  source: TestReportSummary["source"] = "vitest-json",
): TestReportSummary {
  const parsed = parseReportSummary(total, failed, source);
  if (parsed === null) {
    throw new Error(`reportSummary test fixture: impossible counts total=${total} failed=${failed}`);
  }
  return parsed;
}
