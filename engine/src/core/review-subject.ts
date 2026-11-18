/**
 * The sealed Subject Digest of an accepted review (ADR-0090).
 *
 * A Review Run records the Subject Digest of what its packets presented
 * (`waveTaskSubjectDigest`). Its acceptance seals that digest together with
 * the Finding IDs the acceptance left behind, so a later Successor Carry can
 * prove that nothing the review judged, and nothing it concluded, has changed
 * since. The Finding term is the union of the Task's active and refuted
 * Finding IDs: a Refutation Panel only moves a Finding from one set to the
 * other, so its verdicts leave the seal intact, while any added, resolved or
 * removed Finding breaks it.
 *
 * A leaf: the finalisation write (`findings.ts`) and the carry rule
 * (`wave-review-carry.ts`) both seal through it, so the two cannot disagree.
 *
 * Pure: no I/O, no clock, no randomness.
 */
import { sha256Hex } from "./digest";
import type { Finding, RefutedFinding } from "./findings-shape";

/** What the seal reads of a Task: its active and refuted Findings. */
export type SealedFindings = Readonly<{
  findings?: readonly Finding[];
  refuted_findings?: readonly RefutedFinding[];
}>;

/** The distinct active and refuted Finding IDs, sorted. */
function findingTerm(task: SealedFindings): readonly string[] {
  const ids = [
    ...(task.findings ?? []).map(({ id }) => id),
    ...(task.refuted_findings ?? []).map(({ finding }) => finding.id),
  ];
  return [...new Set<string>(ids)].sort();
}

/** The acceptance's sealed Subject Digest: `subjectDigest` bound to the Findings `task` holds. */
export function acceptedSubjectDigest(subjectDigest: string, task: SealedFindings): string {
  return sha256Hex(JSON.stringify({ subject: subjectDigest, findings: findingTerm(task) }));
}
