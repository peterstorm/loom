/**
 * The ledger-fact arbitrary the property suites share: reads and writes of two
 * paths, and agent-command test runs with any exit (or none) and one of
 * `reports` (or no report).
 */

import fc from "fast-check";
import type { Evidence, TestReportSummary } from "../../src/machine/types";

export const evidenceArbitrary = (reports: readonly TestReportSummary[]): fc.Arbitrary<Evidence> => fc.oneof(
  fc.record({ kind: fc.constant("FileRead" as const), path: fc.constantFrom("/a.ts", "/b.ts") }),
  fc.record({ kind: fc.constant("FileWrite" as const), path: fc.constantFrom("/a.ts", "/b.ts"), via: fc.constantFrom("tool" as const, "shell" as const) }),
  fc.record({
    kind: fc.constant("TestRun" as const),
    origin: fc.constant({ kind: "agent-command" as const }),
    command: fc.constantFrom("npm test", "bun test"),
    exit: fc.constantFrom<number | null>(0, 1, null),
    report: fc.constantFrom<TestReportSummary | null>(null, ...reports),
  }),
);
