/** Shared pure validation vocabulary for task-graph and model-binding checks. */
export type ValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

export const ok = (): ValidationResult => Object.freeze({ ok: true });

export const fail = (errors: readonly string[]): ValidationResult => Object.freeze({
  ok: false,
  errors: Object.freeze([...errors]),
});
