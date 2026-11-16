/**
 * Standalone Assessment Roster: what a successor reviewer may say about each
 * inherited Finding Origin, projected once from the prepared successor.
 *
 * A successor payload names every prior by its origin reference and cites
 * decisions by their exact references: canonical digests a reviewer cannot
 * compute from the raw lineage. The roster hands both over as data, in issued
 * order, beside the standing that decides which verdicts the engine admits.
 * The issued packet carries it, and `assessStandaloneSuccessor` judges every
 * assessment against the same rows, so what a reviewer is told and what the
 * engine accepts cannot drift apart.
 *
 * Pure module: no I/O, no clock, no randomness.
 */
import { match } from "ts-pattern";
import { canonicalRecord } from "./orchestration-contract/identity";
import { findingOf, standaloneDecisionReference, standaloneOriginReference } from "./standalone-finding-origin";
import {
  STANDALONE_ASSESSMENT_ROSTER_SECTION, type StandaloneLineageRow, type StandaloneResolutionAssessment,
} from "./standalone-lineage-contract";
import type { PreparedStandaloneSuccessor } from "./standalone-review-model";

/** One verdict a successor reviewer can give a prior. */
export type StandaloneAssessmentVerdict = StandaloneResolutionAssessment["verdict"];

/**
 * One decision a prior's assessment may cite by `reference`: a recorded
 * adjudication or resolution in its history, or a published disposition
 * revision that names it.
 */
export type StandaloneDecisionCitation =
  | Readonly<{ kind: "adjudication"; reference: string; survives: boolean }>
  | Readonly<{ kind: "resolution"; reference: string }>
  | Readonly<{ kind: "successor-resolution"; reference: string }>
  | Readonly<{ kind: "disposition"; reference: string; decision: "accepted" | "deferred" | "dismissed" }>;

/**
 * Whether a prior still stands. `active`: its latest decision is a surviving
 * adjudication, or it has none, and no selected disposition dismisses it.
 * `retired`: dismissed, refuted or resolved.
 */
export type StandalonePriorStanding = "active" | "retired";

/** How a scoped path compares with the predecessor's snapshot of it. */
export type StandaloneInputChange = "observed-changed" | "historical-unknown" | "unchanged";

/** A scoped path a `repaired` assessment may name as its change. */
export type StandaloneRepairablePath = Readonly<{ path: string; change: Exclude<StandaloneInputChange, "unchanged"> }>;

/** One inherited prior, as a successor reviewer must assess it. */
export type StandaloneAssessmentRosterRow = Readonly<{
  /** The exact `origin` its assessment carries. */
  origin: string;
  /** The original Finding, unchanged: assess it, never restate it. */
  finding: Readonly<{ agent: string; severity: "critical" | "advisory"; file: string | null; line: number | null; claim: string }>;
  standing: StandalonePriorStanding;
  /** Every reference a `retained` or `reopen` assessment may cite, oldest first. */
  decisions: readonly StandaloneDecisionCitation[];
  /** Every verdict the engine admits for this prior, in a fixed order. */
  verdicts: readonly StandaloneAssessmentVerdict[];
}>;

/** The whole roster: every prior in issued order, and the paths a repair may name. */
export type StandaloneAssessmentRoster = Readonly<{
  lineageDigest: string;
  snapshotDigest: string;
  repairablePaths: readonly StandaloneRepairablePath[];
  priors: readonly StandaloneAssessmentRosterRow[];
}>;

/** Whether `row` still stands under the prepared successor's selected policy. */
export function standalonePriorStanding(prepared: PreparedStandaloneSuccessor, row: StandaloneLineageRow): StandalonePriorStanding {
  const policy = prepared.disposition;
  if (policy.kind === "selected-record" && policy.disposition.record.entries.some(entry =>
    entry.origin === standaloneOriginReference(row.origin) && entry.decision === "dismissed")) return "retired";
  const latest = row.history.at(-1);
  return latest === undefined || (latest.kind === "adjudication" && latest.survives) ? "active" : "retired";
}

/** Every decision `row` may cite: its history, then each selected disposition revision that names it. */
function standaloneDecisionCitations(prepared: PreparedStandaloneSuccessor, row: StandaloneLineageRow): readonly StandaloneDecisionCitation[] {
  const historical = row.history.map((decision): StandaloneDecisionCitation => {
    const reference = standaloneDecisionReference(decision);
    return match(decision)
      .with({ kind: "adjudication" }, value => canonicalRecord({ kind: "adjudication" as const, reference, survives: value.survives }))
      .with({ kind: "resolution" }, () => canonicalRecord({ kind: "resolution" as const, reference }))
      .with({ kind: "successor-resolution" }, () => canonicalRecord({ kind: "successor-resolution" as const, reference }))
      .exhaustive();
  });
  const policy = prepared.disposition;
  if (policy.kind !== "selected-record") return Object.freeze(historical);
  const origin = standaloneOriginReference(row.origin);
  const disposed = [...policy.disposition.history, policy.disposition].flatMap((revision): StandaloneDecisionCitation[] => {
    const entry = revision.record.entries.find(candidate => candidate.origin === origin);
    return entry === undefined ? [] : [canonicalRecord({ kind: "disposition" as const, reference: revision.digest, decision: entry.decision })];
  });
  return Object.freeze([...historical, ...disposed]);
}

/** How `path` compares with the predecessor's snapshot. An unknown historical input stays unknown, never an observed change. */
export function standaloneInputChange(
  snapshots: Pick<PreparedStandaloneSuccessor, "snapshot" | "previousSnapshot">, path: string,
): StandaloneInputChange {
  const current = snapshots.snapshot.find(entry => entry.path === path);
  if (current === undefined) return "unchanged";
  const previous = snapshots.previousSnapshot.find(entry => entry.path === path);
  if (previous === undefined || previous.kind === "historical-unknown") return "historical-unknown";
  if (current.kind !== previous.kind) return "observed-changed";
  if (current.kind === "present" && previous.kind === "present") {
    // An unobserved mode cannot certify either equality or a mode-only repair.
    return current.digest !== previous.digest || (previous.mode !== null && current.mode !== previous.mode)
      ? "observed-changed" : "unchanged";
  }
  return "unchanged";
}

/** The verdicts the engine admits for a prior of this standing with these citations, in a fixed order. */
const verdictsFor = (standing: StandalonePriorStanding, decisions: readonly StandaloneDecisionCitation[]): readonly StandaloneAssessmentVerdict[] => Object.freeze([
  ...(standing === "active" ? ["still-present", "repaired"] as const : []),
  ...(decisions.length > 0 ? ["retained", "reopen"] as const : []),
  "not-assessable" as const,
]);

/** The roster row for one inherited prior. */
function standaloneAssessmentRosterRow(prepared: PreparedStandaloneSuccessor, row: StandaloneLineageRow): StandaloneAssessmentRosterRow {
  const finding = findingOf(row);
  const standing = standalonePriorStanding(prepared, row);
  const decisions = standaloneDecisionCitations(prepared, row);
  return canonicalRecord({
    origin: standaloneOriginReference(row.origin),
    finding: canonicalRecord({ agent: finding.agent, severity: finding.severity, file: finding.file, line: finding.line, claim: finding.claim }),
    standing, decisions, verdicts: verdictsFor(standing, decisions),
  });
}

/** The roster issued to every successor reviewer: each prior in issued order, and the scoped paths a repair may name. */
export function standaloneAssessmentRoster(prepared: PreparedStandaloneSuccessor): StandaloneAssessmentRoster {
  const repairablePaths = prepared.snapshot.flatMap((entry): StandaloneRepairablePath[] => {
    const change = standaloneInputChange(prepared, entry.path);
    return change === "unchanged" ? [] : [canonicalRecord({ path: entry.path, change })];
  });
  return canonicalRecord({
    lineageDigest: prepared.lineageDigest, snapshotDigest: prepared.snapshotDigest, repairablePaths: Object.freeze(repairablePaths),
    priors: Object.freeze(prepared.inventory.map(row => standaloneAssessmentRosterRow(prepared, row))),
  });
}

/** What an assessment points at besides its verdict: the decision it cites, the path it names as repaired, or nothing. */
type AssessmentCitation =
  | Readonly<{ kind: "decision"; reference: string }>
  | Readonly<{ kind: "path"; path: string }>
  | Readonly<{ kind: "none" }>;

const citationOf = (assessment: StandaloneResolutionAssessment): AssessmentCitation => match(assessment)
  .with({ verdict: "retained" }, value => ({ kind: "decision" as const, reference: value.decisionDigest }))
  .with({ verdict: "reopen" }, value => ({ kind: "decision" as const, reference: value.proposal.decisionDigest }))
  .with({ verdict: "repaired" }, value => ({ kind: "path" as const, path: value.change.path }))
  .with({ verdict: "still-present" }, { verdict: "not-assessable" }, () => ({ kind: "none" as const }))
  .exhaustive();

/**
 * Whether `assessment` is one the engine admits for the roster's prior at
 * `index`: the verdict is one its standing and decisions admit (`verdictsFor`,
 * the rule that built the row's `verdicts`), a citation names one of its
 * decisions, and a repair names one of the same roster's `repairablePaths`.
 * The origin and its order are checked by the caller.
 */
export function admitsStandaloneAssessment(
  roster: StandaloneAssessmentRoster,
  index: number,
  assessment: StandaloneResolutionAssessment,
): boolean {
  const prior = roster.priors[index];
  if (prior === undefined || !verdictsFor(prior.standing, prior.decisions).includes(assessment.verdict)) return false;
  return match(citationOf(assessment))
    .with({ kind: "decision" }, ({ reference }) => prior.decisions.some(decision => decision.reference === reference))
    .with({ kind: "path" }, ({ path }) => roster.repairablePaths.some(entry => entry.path === path))
    .with({ kind: "none" }, () => true)
    .exhaustive();
}

/** How many citable references a refusal lists before pointing at the roster row for the rest. */
const LISTED_REFERENCES = 8;
/** How many characters of a reviewer-supplied value a refusal echoes. */
const ECHOED_CHARACTERS = 128;
const echoed = (raw: string): string => {
  const characters = [...raw];
  return characters.length <= ECHOED_CHARACTERS ? raw : `${characters.slice(0, ECHOED_CHARACTERS).join("")}…`;
};

/**
 * The refusal for an assessment `admitsStandaloneAssessment` rejected: which
 * prior, what was said, and what its roster row allows, so a retry can correct
 * exactly that row. Bounded to 2048 UTF-8 bytes whatever the row or the
 * payload: it never names the Finding's claim, echoes at most
 * `ECHOED_CHARACTERS` of what the reviewer wrote, and lists at most
 * `LISTED_REFERENCES` references, leaving the rest to the issued roster row.
 */
export function describeInadmissibleAssessment(
  index: number,
  prior: StandaloneAssessmentRosterRow,
  assessment: StandaloneResolutionAssessment,
): string {
  const allowed = prior.verdicts.join(", ");
  const cited = match(citationOf(assessment))
    .with({ kind: "decision" }, ({ reference }) => ` citing ${echoed(reference)}`)
    .with({ kind: "path" }, ({ path }) => ` naming ${echoed(path)}`)
    .with({ kind: "none" }, () => "")
    .exhaustive();
  const listed = prior.decisions.slice(0, LISTED_REFERENCES).map(decision => decision.reference);
  const unlisted = prior.decisions.length - listed.length;
  const citable = listed.length === 0 ? "none"
    : listed.join(", ") + (unlisted === 0 ? "" : `, and ${unlisted} more in that row`);
  return "Assessment must respect the exact prior decision and explicitly reopen retired history: " +
    `priorAssessments[${index}] (origin ${prior.origin}, ${prior.standing}) says ${assessment.verdict}${cited}; ` +
    `its ${STANDALONE_ASSESSMENT_ROSTER_SECTION} row allows ${allowed}, citing only: ${citable}.` +
    (assessment.verdict === "repaired" ? " A repair must name one of the roster's repairablePaths." : "");
}
