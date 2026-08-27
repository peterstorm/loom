/** Canonical Task identity value object shared by every parsing boundary. */

export const TASK_ID_PATTERN = /^T\d+$/;

declare const TASK_ID: unique symbol;
export type TaskId = string & { readonly [TASK_ID]: true };

/**
 * The error shape intentionally matches implementation-completion's historical
 * parser contract so moving TaskId to its own module is wire-compatible.
 */
export type CanonicalTaskIdParseError = Readonly<{
  kind: "invalid-implementation-completion";
  errors: readonly [string, ...string[]];
}>;

export type CanonicalTaskIdParseResult<T = TaskId> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: CanonicalTaskIdParseError }>;

/** Exact, total TaskId smart constructor. No normalization or aliases. */
export function parseTaskId(raw: unknown, path = "taskId"): CanonicalTaskIdParseResult {
  if (typeof raw === "string" && TASK_ID_PATTERN.test(raw)) {
    return Object.freeze({ ok: true, value: raw as TaskId });
  }
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      kind: "invalid-implementation-completion",
      errors: Object.freeze([`${path} must match T\\d+`] as const),
    }),
  });
}
