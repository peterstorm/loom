/**
 * Escaped-defect severity (AS-016) — PURE: the retained blinding key and
 * blinded assessments, and the paired quality comparison of one cell.
 *
 * - Blinded: an assessor sees blind ids only, never the arm.
 * - The same rubric for both arms: a sample with no accepted payload lets
 *   every known defect escape at its preregistered severity; an accepted
 *   payload's escapes are adjudicated conservatively — the maximum severity
 *   any assessor observed — identically for both arms.
 * - Disagreements are retained, never averaged away; an assessment naming a
 *   defect the case does not declare is refused.
 * - Fewer blinded assessors than preregistered, or an unscored held-out
 *   request, leaves the guardrail not measured — never a pass.
 */

import { z } from "zod";
import { err, ok, type Result } from "../kernel";
import { sampleTerminal, type ObservedPair } from "./pilot-observation";
import type { CellPreregistration, Preregistration, WorkloadCase } from "./pilot-preregistration";
import { bootstrapInterval, jsonInterval, mean, type Interval, type JsonInterval } from "./pilot-statistics";
import {
  guardrailOutcome,
  parserOf,
  PILOT_ARMS,
  SEVERITIES,
  SEVERITY_WEIGHT,
  text,
  type DeepReadonly,
  type GuardrailOutcome,
  type GuardrailVerdict,
  type PilotArm,
  type Severity,
} from "./pilot-vocabulary";

const blindingKeySchema = z.object({
  schemaVersion: z.literal(1),
  windowId: text,
  entries: z.array(z.object({ blindId: text, pairId: text, arm: z.enum(PILOT_ARMS) }).strict()),
}).strict().superRefine((key, ctx) => {
  const ids = key.entries.map((entry) => entry.blindId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "blind ids must be unique", path: ["entries"] });
});
export type BlindingKey = DeepReadonly<z.infer<typeof blindingKeySchema>>;

export const parseBlindingKey: (raw: unknown) => Result<BlindingKey, readonly string[]> = parserOf(blindingKeySchema);

/** An assessor id names its retained file (`assessments/<assessorId>.json`),
 *  so it is parsed as a path-safe token: no separator, no traversal. */
const assessorIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "must be a path-safe assessor id ([A-Za-z0-9._-], starting alphanumeric)");

const assessmentSchema = z.object({
  schemaVersion: z.literal(1),
  assessorId: assessorIdSchema,
  method: text,
  /** The assessor saw blind ids only — never the arm. */
  blinded: z.literal(true),
  entries: z.array(z.object({
    blindId: text,
    escapedDefects: z.array(z.object({ defectId: text, severity: z.enum(SEVERITIES) }).strict()),
  }).strict()),
}).strict().superRefine((assessment, ctx) => {
  const ids = assessment.entries.map((entry) => entry.blindId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "an assessor scores each blind id at most once", path: ["entries"] });
});
export type QualityAssessment = DeepReadonly<z.infer<typeof assessmentSchema>>;

export const parseQualityAssessment: (raw: unknown) => Result<QualityAssessment, readonly string[]> = parserOf(assessmentSchema);

export type EscapedDefect = Readonly<{ defectId: string; severity: Severity }>;

export type ObservedEscape = Readonly<{
  pairId: string;
  arm: PilotArm;
  defectId: string;
  /** Who observed it: an assessor id, or `terminal-failure` when no payload was accepted. */
  observedBy: readonly string[];
  severity: Severity;
}>;

export type AssessorDisagreement = Readonly<{
  pairId: string;
  arm: PilotArm;
  byAssessor: Readonly<Record<string, readonly EscapedDefect[]>>;
}>;

export type QualityComparison = Readonly<{
  heldOutPairs: number;
  assessors: readonly string[];
  meanEscapedSeverity: Readonly<Record<PilotArm, number | null>>;
  /** Paired effect: emission − extraction escaped-severity points per request. */
  pairedDifference: Readonly<{ mean: number | null; interval: JsonInterval }>;
  observedEscapes: readonly ObservedEscape[];
  disagreements: readonly AssessorDisagreement[];
}>;

export type QualityInputs = Readonly<{
  key: BlindingKey | null;
  assessments: readonly QualityAssessment[];
}>;

const severityScore = (defects: readonly EscapedDefect[]): number =>
  defects.reduce((sum, defect) => sum + SEVERITY_WEIGHT[defect.severity], 0);

const sameEscapes = (left: readonly EscapedDefect[], right: readonly EscapedDefect[]): boolean => {
  const canon = (defects: readonly EscapedDefect[]): string =>
    JSON.stringify([...defects].map((defect) => `${defect.defectId}:${defect.severity}`).sort());
  return canon(left) === canon(right);
};

export type QualityGuardrail = Readonly<{
  comparison: QualityComparison | null;
  guardrail: GuardrailOutcome<GuardrailVerdict, "escaped-defect-severity">;
}>;

/** The cell's escaped-defect severity comparison over its held-out pairs, or
 *  the inconsistencies (unknown defects, duplicate assessors) that refuse it. */
export function compareQuality(
  cell: CellPreregistration,
  pairs: readonly ObservedPair[],
  prereg: Preregistration,
  quality: QualityInputs,
): Result<QualityGuardrail, readonly string[]> {
  const casesById = new Map(cell.workload.cases.map((entry) => [entry.caseId, entry] as const));
  const heldOut = pairs.filter((pair) => casesById.get(pair.scheduled.caseId)?.heldOutKnownDefectCase === true);
  if (heldOut.length === 0) {
    return ok({ comparison: null, guardrail: guardrailOutcome("escaped-defect-severity", "not-measured", "no held-out known-defect pair was observed") });
  }
  const assessors = [...new Set(quality.assessments.map((assessment) => assessment.assessorId))].sort();
  if (quality.assessments.length !== assessors.length) return err(["each assessor may submit exactly one assessment"]);
  const required = prereg.guardrails.requiredIndependentAssessors;
  const blindByPairArm = new Map((quality.key?.entries ?? []).map((entry) => [`${entry.pairId}|${entry.arm}`, entry.blindId] as const));
  const problems: string[] = [];
  const missing: string[] = [];
  const escapesFor = (pair: ObservedPair, arm: PilotArm): Readonly<{ score: number; escapes: readonly ObservedEscape[]; disagreement: AssessorDisagreement | null }> => {
    const entry = casesById.get(pair.scheduled.caseId) as WorkloadCase;
    const sample = arm === "emission-enabled" ? pair.emission : pair.extraction;
    if (sampleTerminal(sample).kind === "terminal-failure") {
      // No accepted payload: every known defect escaped, at its preregistered severity.
      return {
        score: severityScore(entry.knownDefects),
        escapes: entry.knownDefects.map((defect) => Object.freeze({
          pairId: pair.scheduled.pairId, arm, defectId: defect.defectId, observedBy: Object.freeze(["terminal-failure"]), severity: defect.severity,
        })),
        disagreement: null,
      };
    }
    const blindId = blindByPairArm.get(`${pair.scheduled.pairId}|${arm}`);
    if (blindId === undefined) {
      missing.push(`${pair.scheduled.pairId}/${arm}: no blinding-key entry`);
      return { score: Number.NaN, escapes: [], disagreement: null };
    }
    const known = new Set(entry.knownDefects.map((defect) => defect.defectId));
    const byAssessor: Record<string, readonly EscapedDefect[]> = {};
    for (const assessment of quality.assessments) {
      const scored = assessment.entries.find((candidate) => candidate.blindId === blindId);
      if (scored === undefined) {
        missing.push(`${pair.scheduled.pairId}/${arm}: assessor ${assessment.assessorId} did not score blind id ${blindId}`);
        continue;
      }
      for (const defect of scored.escapedDefects) {
        if (!known.has(defect.defectId)) problems.push(`assessor ${assessment.assessorId} names unknown defect ${defect.defectId} for ${blindId}`);
      }
      byAssessor[assessment.assessorId] = scored.escapedDefects;
    }
    const scoredSets = Object.values(byAssessor);
    const disagree = scoredSets.some((defects) => !sameEscapes(defects, scoredSets[0] ?? []));
    // Conservative adjudication, identical for both arms: the maximum severity any assessor observed.
    const escapes = new Map<string, ObservedEscape>();
    for (const [assessorId, defects] of Object.entries(byAssessor)) {
      for (const defect of defects) {
        const seen = escapes.get(defect.defectId);
        const severity = seen !== undefined && SEVERITY_WEIGHT[seen.severity] >= SEVERITY_WEIGHT[defect.severity] ? seen.severity : defect.severity;
        escapes.set(defect.defectId, Object.freeze({
          pairId: pair.scheduled.pairId, arm, defectId: defect.defectId,
          observedBy: Object.freeze([...(seen?.observedBy ?? []), assessorId]), severity,
        }));
      }
    }
    const adjudicated = [...escapes.values()];
    return {
      score: severityScore(adjudicated),
      escapes: adjudicated,
      disagreement: disagree ? Object.freeze({ pairId: pair.scheduled.pairId, arm, byAssessor: Object.freeze(byAssessor) }) : null,
    };
  };
  const scored = heldOut.map((pair) => ({ pair, emission: escapesFor(pair, "emission-enabled"), extraction: escapesFor(pair, "extraction-only") }));
  if (problems.length > 0) return err(problems);
  const observedEscapes = scored.flatMap((item) => [...item.emission.escapes, ...item.extraction.escapes]);
  const disagreements = scored.flatMap((item) => [item.emission.disagreement, item.extraction.disagreement])
    .filter((value): value is AssessorDisagreement => value !== null);
  const notEnoughAssessors = assessors.length < required;
  if (notEnoughAssessors || missing.length > 0) {
    return ok({
      comparison: Object.freeze({
        heldOutPairs: heldOut.length,
        assessors,
        meanEscapedSeverity: Object.freeze({ "emission-enabled": null, "extraction-only": null }),
        pairedDifference: Object.freeze({ mean: null, interval: Object.freeze({ lower: null, upper: null, level: prereg.guardrails.confidenceLevel }) }),
        observedEscapes,
        disagreements,
      }),
      guardrail: guardrailOutcome("escaped-defect-severity", "not-measured", [
        ...(notEnoughAssessors ? [`${assessors.length} blinded independent assessor(s) < preregistered ${required}`] : []),
        ...(missing.length > 0 ? [`${missing.length} held-out request(s) unscored (first: ${missing[0]})`] : []),
      ].join("; ")),
    });
  }
  const differences = scored.map((item) => item.emission.score - item.extraction.score);
  const meanDifference = mean(differences);
  const interval = bootstrapInterval(differences, mean, prereg.guardrails.bootstrapResamples, prereg.guardrails.bootstrapSeed + 3, prereg.guardrails.confidenceLevel);
  const margin = prereg.guardrails.qualityNonInferiorityMargin;
  const describe = `mean paired escaped-severity difference ${meanDifference.toFixed(3)} (interval ${interval.lower.toFixed(3)}–${interval.upper.toFixed(3)}), margin ${margin}`;
  return ok({
    comparison: Object.freeze({
      heldOutPairs: heldOut.length,
      assessors,
      meanEscapedSeverity: Object.freeze({
        "emission-enabled": mean(scored.map((item) => item.emission.score)),
        "extraction-only": mean(scored.map((item) => item.extraction.score)),
      }),
      pairedDifference: Object.freeze({ mean: meanDifference, interval: jsonInterval(interval) }),
      observedEscapes,
      disagreements,
    }),
    guardrail: qualityVerdict(meanDifference, interval, margin, describe),
  });
}

function qualityVerdict(meanDifference: number, interval: Interval, margin: number, describe: string): GuardrailOutcome<GuardrailVerdict, "escaped-defect-severity"> {
  if (interval.lower > 0 || meanDifference > margin) {
    return guardrailOutcome("escaped-defect-severity", "violated", `${describe}: worse than the PR #52-only extraction baseline`);
  }
  if (meanDifference <= 0 && interval.upper <= margin) return guardrailOutcome("escaped-defect-severity", "pass", describe);
  return guardrailOutcome("escaped-defect-severity", "inconclusive", `${describe}: non-inferiority not established — inconclusive is not a pass`);
}
