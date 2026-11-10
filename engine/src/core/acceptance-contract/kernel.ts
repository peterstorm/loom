/** Module-private result helpers shared by the Acceptance Contract modules. */

import type { DomainResult, NonEmpty } from "../orchestration-contract";

export { mapNonEmpty, nonEmpty } from "../orchestration-contract";

export const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
export const ok = <T>(value: T): DomainResult<T, never> => freeze({ ok: true as const, value });
export const err = <E>(error: E): DomainResult<never, E> => freeze({ ok: false as const, error });

/** Every value when every result is ok, else every error — both non-empty, in input order. */
export function allOk<T, E>(results: NonEmpty<DomainResult<T, E>>): DomainResult<NonEmpty<T>, NonEmpty<E>> {
  const [head, ...tail] = results;
  const start: DomainResult<NonEmpty<T>, NonEmpty<E>> = head.ok ? ok(freeze([head.value])) : err(freeze([head.error]));
  return tail.reduce<DomainResult<NonEmpty<T>, NonEmpty<E>>>((acc, result) => {
    if (acc.ok) return result.ok ? ok(freeze([...acc.value, result.value])) : err(freeze([result.error]));
    return result.ok ? acc : err(freeze([...acc.error, result.error]));
  }, start);
}
