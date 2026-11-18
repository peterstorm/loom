/**
 * The advisory disposition record's shape (ADR-0090): a dependency-free leaf,
 * so the schema-root TaskGraph in `types.ts` can declare the field without an
 * import cycle. Its constructor, parser and rules live in
 * `advisory-disposition.ts`, which re-exports this shape.
 */

export const ADVISORY_DECISIONS = ["fixed", "deferred", "dismissed"] as const;
export type AdvisoryDecision = (typeof ADVISORY_DECISIONS)[number];

export type AdvisoryDisposition = Readonly<{
  schemaVersion: 1;
  wave: number;
  taskId: string;
  findingId: string;
  decision: AdvisoryDecision;
  reason: string;
  /** Where a deferral is meant to land (`Wave 5`, `T12`); null for any other decision. */
  target: string | null;
  /** The sha256 of the reviewed bytes the decision was made over; null for `fixed`, which never suppresses. */
  anchor: string | null;
}>;
