/**
 * The closed set of documented wire shape ids a `wire-example` marker may
 * name. The scan (`doc-wire-examples.ts`) parses a marker's id into
 * `WireShapeId` once, and the registry (`doc-wire-shapes.ts`) is a record over
 * it, so an example bound to an unregistered shape is unrepresentable past
 * the scan and an id without a parser does not compile.
 *
 * Its own module because both of those import it, and the registry already
 * imports the scan.
 */

export const WIRE_SHAPE_IDS = [
  "architecture-panel-journal",
  "completed-wave-reopening",
  "decompose-task-graph",
  "defect-family-accounting",
  "implementation-brief-request",
  "judge-verdict",
  "linter-project-config",
  "linter-regex-rule",
  "refutation-verdict",
  "remediation-start",
  "security-audit-start",
  "security-critic-result",
  "security-hunter-result",
  "security-verification-result",
  "spec-trace-ownership",
  "standalone-disposition-start",
  "standalone-review-start",
  "verification-manifest",
  "wave-gate-decision",
  "wave-gate-start",
] as const;

export type WireShapeId = (typeof WIRE_SHAPE_IDS)[number];

export const parseWireShapeId = (raw: string): WireShapeId | null =>
  WIRE_SHAPE_IDS.find((id) => id === raw) ?? null;
