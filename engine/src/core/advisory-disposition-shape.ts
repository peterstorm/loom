/**
 * The advisory disposition record's shape (ADR-0090): a leaf with type-only
 * imports, so the schema-root TaskGraph in `types.ts` can declare the field
 * without an import cycle. Its constructor, parser and rules live in
 * `advisory-disposition.ts`, which re-exports this shape.
 */

import type { FindingId } from "./findings-shape";
import type { TaskId } from "./task-id";

export const ADVISORY_DECISIONS = ["fixed", "deferred", "dismissed"] as const;
export type AdvisoryDecision = (typeof ADVISORY_DECISIONS)[number];

declare const ANCHOR_DIGEST: unique symbol;
/**
 * The sha256 of the reviewed bytes an advisory was decided over. Minted only
 * by `anchorDigest` and the anchor parser in `advisory-disposition.ts`. The
 * brand is type-only, so persisted JSON is byte-identical to the plain string.
 */
export type AnchorDigest = string & { readonly [ANCHOR_DIGEST]: true };

type DispositionHead = Readonly<{
  schemaVersion: 1;
  wave: number;
  taskId: TaskId;
  findingId: FindingId;
}>;

/**
 * One recorded decision on one advisory. The decision fixes the rest:
 *
 * - `fixed` never suppresses reissue, so it has no anchor, and no target;
 * - `deferred` suppresses while its anchor holds, and may name where the
 *   deferral lands (`Wave 5`, `T12`);
 * - `dismissed` suppresses while its anchor holds, and has no target.
 *
 * Every variant lists its fields in the one State File order.
 */
export type AdvisoryDisposition = DispositionHead & (
  | Readonly<{ decision: "fixed"; reason: string; target: null; anchor: null }>
  | Readonly<{ decision: "deferred"; reason: string; target: string | null; anchor: AnchorDigest }>
  | Readonly<{ decision: "dismissed"; reason: string; target: null; anchor: AnchorDigest }>
);
