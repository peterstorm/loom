/**
 * The Subject Digest of a Wave review and its seal on an acceptance (ADR-0091).
 *
 * A Review Run records the Subject Digest of what its packets presented
 * (`waveTaskSubjectDigest` mints it through `subjectDigestOf`). Its acceptance
 * seals that digest together with the Finding IDs the acceptance left behind,
 * so a later Successor Carry can prove that nothing the review judged, and
 * nothing it concluded, has changed since. The Finding term is the union of
 * the Task's active and refuted Finding IDs: a Refutation Panel only moves a
 * Finding from one set to the other, so its verdicts leave the seal intact,
 * while any added, resolved or removed Finding breaks it.
 *
 * The two digests are distinct brands, each minted only here and read back
 * from the State File only through its parser, so a raw digest can never
 * stand in for a sealed one.
 *
 * A leaf: the finalisation write (`findings.ts`), the State File boundary and
 * the carry rule (`wave-review-carry.ts`) all go through it, so they cannot
 * disagree.
 *
 * Pure: no I/O, no clock, no randomness.
 */
import { sha256Hex } from "./digest";
import type { Finding, RefutedFinding, SealedSubjectDigest, SubjectDigest } from "./findings-shape";

const SHA256 = /^[0-9a-f]{64}$/;

/** The Subject Digest of one canonically constructed subject record. */
export const subjectDigestOf = (subject: unknown): SubjectDigest => sha256Hex(JSON.stringify(subject)) as SubjectDigest;

/** A stored Subject Digest, or null when `raw` is no SHA-256 digest. */
export const parseSubjectDigest = (raw: unknown): SubjectDigest | null =>
  typeof raw === "string" && SHA256.test(raw) ? raw as SubjectDigest : null;

/** A stored sealed Subject Digest, or null when `raw` is no SHA-256 digest. */
export const parseSealedSubjectDigest = (raw: unknown): SealedSubjectDigest | null =>
  typeof raw === "string" && SHA256.test(raw) ? raw as SealedSubjectDigest : null;

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
export function acceptedSubjectDigest(subjectDigest: SubjectDigest, task: SealedFindings): SealedSubjectDigest {
  return sha256Hex(JSON.stringify({ subject: subjectDigest, findings: findingTerm(task) })) as SealedSubjectDigest;
}
