/**
 * Shared fixtures for the Red-Then-Green Status core and helper tests: one
 * `file_list` vocabulary, the Task and Proof builders settlement-shaped
 * Tasks are made from, and the ledger facts a live epoch is built from.
 * Each test file keeps only the fixtures unique to it.
 */

import {
  derivePendingTaskProof,
  evaluateTaskProof,
  type FailedTaskProof,
  type RedThenGreenEra,
} from "../../src/core/proof-obligations";
import type { RedThenGreenGap, TestFileResult } from "../../src/core/red-then-green-types";
import { parseReportSummary } from "../../src/core/structured-test-report";
import { defaultVerificationManifest, type FrozenVerificationManifest } from "../../src/core/verification-manifest";
import type { NewTestWaiverReason } from "../../src/core/verification-policy";
import type { Evidence } from "../../src/machine/types";
import type { Task } from "../../src/types";
import { taskFixture } from "./task-lifecycle";

// --- File vocabulary ---

export const IMPL = "engine/src/core/ledger.ts";
export const TEST_A = "engine/tests/core/ledger.test.ts";
export const FIXTURE = "engine/tests/fixtures/ledger-fixtures.ts";
export const TEST_B = "engine/tests/core/replay.test.ts";
/** Test and implementation files interleaved, so `file_list` order is observable. */
export const FILES: readonly string[] = [IMPL, TEST_A, FIXTURE, TEST_B];
export const IMPL_ONLY: readonly string[] = [IMPL, FIXTURE];

export const OWED_ERA: RedThenGreenEra = "owed-if-new-tests";
export const I6_MANIFEST: FrozenVerificationManifest = defaultVerificationManifest();

// --- Tasks and Proofs ---

export const base = (id: string, wave: number, files: readonly string[]) => ({
  id,
  description: id,
  agent: "code-implementer-agent",
  wave,
  depends_on: [],
  file_list: [...files],
  spec_anchors: [],
  spec_contributions: [],
});

/** A Task requiring new tests whose frozen Proof was derived under `era`. */
export const requiredTask = (id: string, era: RedThenGreenEra, files: readonly string[] = FILES, wave = 1): Task =>
  taskFixture({
    ...base(id, wave, files),
    new_tests_required: true,
    proof: derivePendingTaskProof({ newTestsRequired: true, declaredArtifacts: files, redThenGreen: era }),
  });

/** A Task whose new tests are waived with `reason`, its Proof derived in the I6 era. */
export const waivedTask = (id: string, reason: NewTestWaiverReason): Task => {
  const verificationPolicy = Object.freeze({
    regression: Object.freeze({ kind: "required" as const }),
    newTests: Object.freeze({ kind: "waived" as const, reason }),
  });
  return taskFixture({
    ...base(id, 1, FILES),
    verification_policy: { regression: verificationPolicy.regression, new_tests: verificationPolicy.newTests },
    proof: derivePendingTaskProof({ verificationPolicy, declaredArtifacts: FILES, redThenGreen: OWED_ERA }),
  });
};

/** A failed I6 evaluation, as settlement stores it, minting `gap` (or `ledger-unavailable`). */
export const failedProof = (gap: RedThenGreenGap | "no-ledger"): FailedTaskProof => {
  const evaluated = evaluateTaskProof(
    { newTestsRequired: true, declaredArtifacts: FILES, redThenGreen: OWED_ERA },
    {
      taskCompleted: true,
      testResult: { verdict: "trusted-pass" },
      filesModified: FILES,
      newTestsWritten: true,
      ...(gap === "no-ledger" ? {} : { redThenGreen: { kind: "unproven" as const, gap } }),
    },
  );
  if (evaluated.state !== "failed") throw new Error("failed proof fixture must fail");
  return evaluated;
};

// --- Ledger facts ---

export const passing = (file: string): TestFileResult => ({ file, executed: 2, failed: 0, skipped: 0, collectionError: false });
export const failing = (file: string): TestFileResult => ({ file, executed: 2, failed: 1, skipped: 0, collectionError: false });

export function report(results: readonly TestFileResult[]) {
  const total = results.reduce((sum, { executed }) => sum + executed, 0);
  const failed = results.reduce((sum, file) => sum + file.failed, 0);
  const parsed = parseReportSummary(total, failed, "junit-xml", { kind: "recorded", results });
  if (parsed === null) throw new Error("fixture report must reconcile");
  return parsed;
}

export const RED_COMMAND = "bun test --reporter=junit --reporter-outfile=/tmp/red.xml";
export const GREEN_COMMAND = "bun test --reporter=junit --reporter-outfile=/tmp/green.xml";

/** Only an untrusted (exit-less) red before the write: red is unmet by qualifying runs alone. */
export const UNTRUSTED_RED_EVENTS: readonly Evidence[] = [
  { kind: "TestRun", command: RED_COMMAND, exit: null, report: report([failing(TEST_A)]) },
  { kind: "FileWrite", path: IMPL, via: "tool" },
];
