/**
 * The deterministic rubric assessor — PURE: one of the blinded assessors
 * (AS-016), scoring the arm-free packet by the same rule for both arms.
 *
 * Every accepted payload is read through its cell's frozen per-kind parser —
 * the reviewer v2 and standalone-successor v3 payload parsers, and the judge
 * and refutation verdict schemas the emission edge enforces — so the rubric
 * reads typed fields only. It fails closed: a payload its cell's parser
 * refuses, an escaped defect id the case does not declare, or a blinded entry
 * whose case or input cannot be resolved is an error naming it — never zero
 * escapes, so a schema drift or a lookup drift can never understate (or
 * symmetrically mask) an arm's escapes.
 */

import { match } from "ts-pattern";
import type { z } from "zod";
import { matchCalibrationFindings, type CalibrationPrediction } from "../../engine/src/core/model-calibration";
import { judgeVerdictV1Schema } from "../../engine/src/core/panel-contract";
import { refutationVerdictV1Schema } from "../../engine/src/core/review-panel";
import type { ReviewerDraftV2 } from "../../engine/src/core/reviewer-contract";
import { parseReviewerPayloadV2, parseStandaloneReviewerPayloadV3 } from "../../engine/src/core/reviewer-protocol";
import { err, ok, type Result } from "../kernel";
import type { Preregistration, WorkloadCase } from "./pilot-preregistration";
import type { EscapedDefect, QualityAssessment } from "./pilot-quality";
import { issuesOf } from "./pilot-vocabulary";
import type { BlindedEntry } from "./pilot-window";
import { caseInputKey, type CaseInput } from "./pilot-workload";

const encoder = new TextEncoder();

/** A payload one of the verdict schemas refused, as one diagnostic. */
const schemaRefusal = (error: z.ZodError): string => issuesOf(error).join("; ");

/** Reviewer drafts as calibration predictions. */
const predictionsOf = (drafts: readonly ReviewerDraftV2[]): readonly CalibrationPrediction[] =>
  drafts.map((draft) => ({ claim: draft.claim, file: draft.file, line: draft.line }));

/** A reviewer escape is a vulnerable snapshot's expected critical the drafts do
 *  not match, by the corpus match rules (`matchCalibrationFindings`). */
function reviewerEscapes(input: Extract<CaseInput, { cell: "reviewer-payload/v2" | "reviewer-payload/v3" }>, drafts: readonly ReviewerDraftV2[]): readonly string[] {
  if (input.corpusCase.state !== "vulnerable") return [];
  return matchCalibrationFindings(input.corpusCase.expectedCriticals, predictionsOf(drafts)).missedExpectations.map((expectation) => expectation.id);
}

/**
 * The defect ids ONE accepted payload lets escape, by the same rule for both
 * arms (the assessor never sees the arm): a reviewer escape is an unmatched
 * expected critical; a judge escape is a planted fatal flaw that is not named
 * or that scores at least as high as every sound candidate; a refutation
 * escape is a real defect verdicted `refuted` (`uncertain` counts toward
 * neither side, as in the tally). A payload its cell's frozen parser refuses
 * is an error, never read as escaping or not.
 */
function escapedDefectIds(input: CaseInput, payload: unknown): Result<readonly string[], string> {
  const refused = (detail: string): Result<never, string> => err(`the accepted payload does not parse as a ${input.cell} payload: ${detail}`);
  return match(input)
    .with({ cell: "reviewer-payload/v2" }, (reviewer): Result<readonly string[], string> => {
      const parsed = parseReviewerPayloadV2(encoder.encode(JSON.stringify(payload)));
      return parsed.ok ? ok(reviewerEscapes(reviewer, parsed.value.findings)) : refused(`${parsed.error.code}: ${parsed.error.message}`);
    })
    .with({ cell: "reviewer-payload/v3" }, (reviewer): Result<readonly string[], string> => {
      const parsed = parseStandaloneReviewerPayloadV3(encoder.encode(JSON.stringify(payload)));
      return parsed.ok
        ? ok(reviewerEscapes(reviewer, parsed.value.findings.map((finding) => finding.draft)))
        : refused(`${parsed.error.code}: ${parsed.error.message}`);
    })
    .with({ cell: "judge-verdict/v1" }, ({ fixture }): Result<readonly string[], string> => {
      const parsed = judgeVerdictV1Schema.safeParse(payload);
      if (!parsed.success) return refused(schemaRefusal(parsed.error));
      const { rankings } = parsed.data;
      const flawed = rankings.find((ranking) => ranking.candidate === fixture.plantedFlaw.candidate);
      if (flawed === undefined || flawed.fatal_flaw === null) return ok([fixture.plantedFlaw.defectId]);
      const others = rankings.filter((ranking) => ranking.candidate !== fixture.plantedFlaw.candidate);
      return ok(others.every((other) => flawed.score >= other.score) ? [fixture.plantedFlaw.defectId] : []);
    })
    .with({ cell: "refutation-verdict/v1" }, ({ fixture }): Result<readonly string[], string> => {
      const parsed = refutationVerdictV1Schema.safeParse(payload);
      if (!parsed.success) return refused(schemaRefusal(parsed.error));
      if (fixture.groundTruth.kind !== "real-defect") return ok([]);
      const entry = parsed.data.verdicts.find((verdict) => verdict.finding_id === fixture.finding.findingId);
      return ok(entry === undefined || entry.verdict === "refuted" ? [fixture.groundTruth.defectId] : []);
    })
    .exhaustive();
}

/**
 * Escaped known defects in ONE accepted payload, each resolved to its
 * preregistered severity. Fails closed: a payload its cell's parser refuses,
 * or an escaped defect id the case does not declare, is an error naming it.
 */
export function rubricEscapes(workloadCase: WorkloadCase, input: CaseInput, payload: unknown): Result<readonly EscapedDefect[], string> {
  const escaped = escapedDefectIds(input, payload);
  if (!escaped.ok) return err(`case ${workloadCase.caseId}: ${escaped.error}`);
  const known = new Map(workloadCase.knownDefects.map((defect) => [defect.defectId, defect] as const));
  const escapes: EscapedDefect[] = [];
  const unknown: string[] = [];
  for (const defectId of escaped.value) {
    const defect = known.get(defectId);
    if (defect === undefined) unknown.push(JSON.stringify(defectId));
    else escapes.push(Object.freeze({ defectId, severity: defect.severity }));
  }
  return unknown.length > 0
    ? err(`case ${workloadCase.caseId} declares no known defect ${unknown.join(", ")}`)
    : ok(Object.freeze(escapes));
}

type AssessedEntry = QualityAssessment["entries"][number];

/** One blinded entry scored by the rubric, or why it cannot be scored. */
function assessEntry(
  prereg: Preregistration, entry: BlindedEntry, inputs: ReadonlyMap<string, CaseInput>,
): Result<AssessedEntry, string> {
  const where = `blinded entry ${entry.blindId} (${entry.cell} case ${entry.caseId})`;
  const workloadCase = prereg.cells.find((cell) => cell.cell === entry.cell)?.workload.cases.find((item) => item.caseId === entry.caseId);
  if (workloadCase === undefined) return err(`${where}: the case is not preregistered`);
  const input = inputs.get(caseInputKey(entry.cell, entry.caseId));
  if (input === undefined) return err(`${where}: no resolved input`);
  const escapes = rubricEscapes(workloadCase, input, entry.payload);
  return escapes.ok
    ? ok({ blindId: entry.blindId, escapedDefects: escapes.value })
    : err(`${where}: ${escapes.error}`);
}

/**
 * The deterministic rubric assessor over the blinded packet. Fails closed:
 * an entry whose case, input, payload or escaped defect cannot be resolved
 * makes the whole assessment an error listing every such entry — it is never
 * scored as zero escapes, so a drift cannot understate a window's escapes.
 */
export function rubricAssessment(
  prereg: Preregistration, entries: readonly BlindedEntry[], inputs: ReadonlyMap<string, CaseInput>,
): Result<QualityAssessment, readonly string[]> {
  const scored: AssessedEntry[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    const assessed = assessEntry(prereg, entry, inputs);
    if (assessed.ok) scored.push(assessed.value);
    else problems.push(assessed.error);
  }
  if (problems.length > 0) return err(Object.freeze(problems));
  return ok({
    schemaVersion: 1,
    assessorId: "rubric-v1",
    method: "deterministic rubric: corpus match rules (reviewer), planted-flaw ranking (judge), real-defect refutation (refutation); sees blind id, source and canonical payload only",
    blinded: true,
    entries: Object.freeze(scored),
  });
}
