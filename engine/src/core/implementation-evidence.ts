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
): string {
  if (demotionLabel !== null) return demotionLabel;
  if (sawExitZero) return "low-trust (exit 0, no report artifact; transcript-regex)";
  if (machineBound && ledgerEmpty) {
    return "degraded (machine bound, no ledger evidence; transcript-regex)";
  }
  return "transcript-regex (fallback)";
}

function untrustedTranscriptEvidence(label: string, bashOutput: string): ResolvedTestEvidence {
  const transcript = extractTestEvidence(bashOutput);
  return transcript.passed
    ? {
        result: { verdict: "untrusted", passed: true, label, provenance: "unverified" },
        evidence: `${label}: ${transcript.evidence}`,
      }
    : {
        result: { verdict: "untrusted", passed: false, label, provenance: "unverified" },
        evidence: "",
      };
}

/**
 * Ledger ground truth wins over transcript regex. The last trusted run decides,
 * except that a later exit-zero run makes an older trusted failure stale and a
 * FileWrite after a trusted pass invalidates that pass. Neither case promotes
 * transcript text to trusted evidence.
 */
export function resolveTestEvidence(
  ledgerEvents: readonly Evidence[],
  bashOutput: string,
  machineBound: boolean,
  snapshotFailed: boolean = false,
): ResolvedTestEvidence {
  if (snapshotFailed) {
    return untrustedTranscriptEvidence(
      "snapshot-read-failed (ledger snapshot unreadable; transcript-regex)",
      bashOutput,
    );
  }
  const judged = ledgerEvents.flatMap((event, index) =>
    event.kind === "TestRun"
      ? [{ run: event as TestRunEvidence, index, verdict: judgeTestRun(event.exit, event.report) }]
      : [],
  );
  const lastTrusted = judged.reduce<
    { index: number; run: TestRunEvidence; verdict: TrustedTestVerdict } | null
  >((acc, { run, index, verdict }) =>
    verdict.verdict === "untrusted" ? acc : { index, run, verdict }, null);

  let demotionLabel: string | null = null;
  if (lastTrusted !== null) {
    const laterFileWrite = ledgerEvents
      .slice(lastTrusted.index + 1)
      .some((event) => event.kind === "FileWrite");
    const laterExitZero = judged.some(
      (judgment) => judgment.index > lastTrusted.index && judgment.run.exit === 0,
    );
    const keepTrusted = lastTrusted.verdict.verdict === "trusted-pass"
      ? !laterFileWrite
      : !laterExitZero;
    if (keepTrusted) {
      const report = lastTrusted.run.report
        ? `, report: ${lastTrusted.run.report.total} tests / ${lastTrusted.run.report.failed} failed`
        : "";
      return {
        result: lastTrusted.verdict,
        evidence: `ledger: exit ${lastTrusted.run.exit}${report} (${lastTrusted.run.command})`,
      };
    }
    if (lastTrusted.verdict.verdict === "trusted-pass") {
      demotionLabel = "low-trust (files modified after last trusted pass; transcript-regex)";
    }
  }

  return untrustedTranscriptEvidence(
    fallbackEvidenceLabel(
      demotionLabel,
      judged.some((judgment) => judgment.run.exit === 0),
      machineBound,
      ledgerEvents.length === 0,
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
