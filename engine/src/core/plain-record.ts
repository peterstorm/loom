/**
 * The one shared plain-record guard for at-rest wire parsing.
 *
 * A value is a plain record when it is a non-null, non-array object — the exact
 * predicate every wire-grammar parser used to hand-roll at its entry point.
 * `null` and arrays never count; prototype is deliberately NOT checked here,
 * because parsed disk JSON always carries `Object.prototype` and the few
 * parsers that need prototype strictness keep their own check. Per-site error
 * labels stay with the caller: this guard answers the shape question only.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
