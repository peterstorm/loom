/**
 * Pure implementation-test evidence precedence and Guarded Skill Machine cap.
 *
 * Harness handlers supply transcript text and already-attributed ledger facts;
 * this module alone decides which provenance wins. It performs no I/O.
 */

import type { TaskTestResult } from "../types";
import { judgeTestRun, type TrustedTestVerdict } from "../machine/evidence";
import type { Evidence, Requirement } from "../machine/types";
import { extractTestEvidence } from "./test-evidence";
import { admitsTestRun, type TestEvidencePolicy } from "./test-evidence-policy";
import {
  NO_FOREIGN_OWNERS,
  attributeRegressionFailures,
  describeForeignFailures,
  type ForeignTestOwners,
} from "./regression-attribution";

/** Who else in the settling Task's Wave owns which files, and the root reports are read against. */
export type RegressionScope = Readonly<{ owners: ForeignTestOwners; repositoryRoot: string }>;

/** No other in-flight Task: every failure counts against the Task, as before loom#199. */
export const WHOLE_RUN_SCOPE: RegressionScope = Object.freeze({ owners: NO_FOREIGN_OWNERS, repositoryRoot: "" });

/** A trusted run's verdict, after attributing its failures (and the clause naming any it excused). */
type AttributedVerdict = Readonly<{ verdict: TrustedTestVerdict; excused: string | null }>;

/**
 * A trusted failing run whose every failure is in a file another in-flight
 * Task of the Wave owns is this Task's pass: that owner judges its own file,
 * and the Wave Gate judges the whole suite (loom#199). Any other verdict stands.
 */
function attributeTrustedVerdict(
  run: TestRunEvidence,
  verdict: TrustedTestVerdict,
  scope: RegressionScope,
): AttributedVerdict {
  if (verdict.verdict !== "trusted-fail") return { verdict, excused: null };
  const attribution = attributeRegressionFailures(run, scope.owners, scope.repositoryRoot);
  return attribution.kind === "foreign-only"
    ? { verdict: { verdict: "trusted-pass" }, excused: describeForeignFailures(attribution.foreign) }
    : { verdict, excused: null };
}

export type ResolvedTestEvidence = Readonly<{
  /** Verdict plus trust provenance, exactly as persisted on the Task. */
  result: TaskTestResult;
  /** Human-readable provenance stored beside the verdict. */
  evidence: string;
}>;

type TestRunEvidence = Extract<Evidence, { kind: "TestRun" }>;

function fallbackEvidenceLabel(
  demotionLabel: string | null,
  sawExitZero: boolean,
  machineBound: boolean,
  ledgerEmpty: boolean,
  sawUnadmittedRun: boolean,
): string {
  if (demotionLabel !== null) return demotionLabel;
  if (sawUnadmittedRun) return "not admitted (this graph admits only `helper run-tests` runs; transcript-regex)";
  if (sawExitZero) return "low-trust (exit 0, no report artifact; transcript-regex)";
  if (machineBound && ledgerEmpty) {
    return "degraded (machine bound, no ledger evidence; transcript-regex)";
  }
  return "transcript-regex (fallback)";
}

function untrustedTranscriptEvidence(label: string, bashOutput: string): ResolvedTestEvidence {
  const transcript = extractTestEvidence(bashOutput);
  return {
    result: { verdict: "untrusted", passed: transcript.passed, label, provenance: "unverified" },
    evidence: transcript.passed ? `${label}: ${transcript.evidence}` : "",
  };
}

/**
 * Ledger ground truth wins over transcript regex. The last trusted run decides,
 * except that a later exit-zero run makes an older trusted failure stale and a
 * FileWrite after a trusted pass invalidates that pass. Neither case promotes
 * transcript text to trusted evidence. A run `policy` does not admit (an
 * agent's own command in an engine-run graph) is judged untrusted. A trusted
 * failure whose every failing file another in-flight Task of the Wave owns
 * counts as a pass (`scope`, loom#199), and is then judged like any pass.
 */
export function resolveTestEvidence(
  ledgerEvents: readonly Evidence[],
  policy: TestEvidencePolicy,
  bashOutput: string,
  machineBound: boolean,
  snapshotFailed: boolean = false,
  scope: RegressionScope = WHOLE_RUN_SCOPE,
): ResolvedTestEvidence {
  if (snapshotFailed) {
    return untrustedTranscriptEvidence(
      "snapshot-read-failed (ledger snapshot unreadable; transcript-regex)",
      bashOutput,
    );
  }
  const judged = ledgerEvents.flatMap((event, index) => {
    if (event.kind !== "TestRun") return [];
    const admitted = admitsTestRun(policy, event);
    const verdict = admitted ? judgeTestRun(event.exit, event.report) : { verdict: "untrusted" as const };
    return [{ run: event as TestRunEvidence, index, admitted, verdict }];
  });
  const lastTrusted = judged.reduce<
    { index: number; run: TestRunEvidence; verdict: TrustedTestVerdict; excused: string | null } | null
  >((acc, { run, index, verdict }) =>
    verdict.verdict === "untrusted" ? acc : { index, run, ...attributeTrustedVerdict(run, verdict, scope) }, null);

  let demotionLabel: string | null = null;
  if (lastTrusted !== null) {
    const laterFileWrite = ledgerEvents
      .slice(lastTrusted.index + 1)
      .some((event) => event.kind === "FileWrite");
    const laterExitZero = judged.some(
      (judgment) => judgment.index > lastTrusted.index && judgment.admitted && judgment.run.exit === 0,
    );
    const keepTrusted = lastTrusted.verdict.verdict === "trusted-pass"
      ? !laterFileWrite
      : !laterExitZero;
    if (keepTrusted) {
      const report = lastTrusted.run.report
        ? `, report: ${lastTrusted.run.report.total} tests / ${lastTrusted.run.report.failed} failed`
        : "";
      const excused = lastTrusted.excused === null ? "" : `; ${lastTrusted.excused}`;
      return {
        result: lastTrusted.verdict,
        evidence: `ledger: exit ${lastTrusted.run.exit}${report}${excused} (${lastTrusted.run.command})`,
      };
    }
    if (lastTrusted.verdict.verdict === "trusted-pass") {
      demotionLabel = "low-trust (files modified after last trusted pass; transcript-regex)";
    }
  }

  return untrustedTranscriptEvidence(
    fallbackEvidenceLabel(
      demotionLabel,
      judged.some((judgment) => judgment.admitted && judgment.run.exit === 0),
      machineBound,
      ledgerEvents.length === 0,
      judged.some((judgment) => !judgment.admitted),
    ),
    bashOutput,
  );
}

/**
 * A Guarded Skill Machine with unmet terminal requirements caps only a trusted
 * pass. Trusted failures remain ground truth; already-untrusted evidence is at
 * the floor and remains unchanged.
 */
export function capVerdictForMachineCompletion(
  resolved: ResolvedTestEvidence,
  missing: readonly Requirement[],
): ResolvedTestEvidence {
  if (missing.length === 0 || resolved.result.verdict !== "trusted-pass") return resolved;
  const requirements = missing.map((requirement) =>
    `${requirement.event} ≥ ${requirement.min}`).join(", ");
  const label = `machine-incomplete: ${requirements}`;
  return {
    result: { verdict: "untrusted", passed: true, label, provenance: "unverified" },
    evidence: `${label} — ${resolved.evidence}`,
  };
}
