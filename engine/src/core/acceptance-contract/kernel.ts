/** Module-private result helpers shared by the Acceptance Contract modules. */

import type { DomainResult, NonEmpty } from "../orchestration-contract";

export const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
export const ok = <T>(value: T): DomainResult<T, never> => freeze({ ok: true as const, value });
export const err = <E>(error: E): DomainResult<never, E> => freeze({ ok: false as const, error });

export function nonEmpty<T>(values: readonly T[]): NonEmpty<T> | null {
  const [head, ...tail] = values;
  return head === undefined ? null : Object.freeze([head, ...tail]);
}
