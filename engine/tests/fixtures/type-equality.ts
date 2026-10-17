/**
 * Compile-time type identity for tests that pin a restated type to its
 * owner: `Equal<A, B>` is `true` only when A and B are the same type
 * (readonly-ness and optionality included), so `const pin: Equal<A, B> = true`
 * fails typecheck the moment the two drift apart.
 */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
