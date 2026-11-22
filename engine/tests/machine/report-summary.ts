/**
 * Test-only helpers for structured test reports.
 *
 * `reportSummary` is the smart constructor for the branded TestReportSummary.
 * TestReportSummary is branded (types.ts): parseReportSummary is its sole
 * producer, so tests can no longer inline `{ total, failed, source }` where a
 * TestReportSummary is expected. This helper mints one through the real
 * parser, with per-file results unrecorded (the shape a pre-feature ledger line
 * reads back as), and asserts sanity, so a typo (failed > total) fails loudly
 * in the fixture rather than silently demoting to null.
 *
 * `countedReport` and `summarizedReport` read report text the way the engine
 * does, so the suites that check the two projections share one adapter:
 * the executed-count rule over the UTF-8 bytes (completion checks), and the
 * TestRun summary over the decoded text (report capture).
 */

import {
  parseReportSummary,
  readTestReport,
  readTestReportText,
  reportCounts,
  testRunSummary,
  type StructuredReportFormat,
  type StructuredReportParseResult,
} from "../../src/core/structured-test-report";
import type { TestReportSummary } from "../../src/machine/types";

export function reportSummary(
  total: number,
  failed: number,
  source: TestReportSummary["source"] = "vitest-json",
): TestReportSummary {
  const parsed = parseReportSummary(total, failed, source, undefined);
  if (parsed === null) {
    throw new Error(`reportSummary test fixture: impossible counts total=${total} failed=${failed}`);
  }
  return parsed;
}

/** Report text as the UTF-8 bytes a runner wrote. */
export const reportBytes = (content: string): Uint8Array => new TextEncoder().encode(content);

/** The executed-count rule's counts of report text, read as its bytes. */
export const countedReport = (content: string): StructuredReportParseResult => reportCounts(readTestReport(reportBytes(content)));

/** The TestRun summary of report text that must be `format`. */
export const summarizedReport = (content: string, format: StructuredReportFormat): TestReportSummary | null =>
  testRunSummary(readTestReportText(content), format);
