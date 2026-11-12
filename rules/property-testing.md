---
description: Property-based testing - when to use it, which properties to write, idempotence vs idempotency
globs: "**/*.{ts,tsx,js,jsx,java,kt,hs,scala,rs}"
---

# Property-Based Testing

Language-neutral. Library code is in the test skills: `skills/java-test-engineer` (jqwik) and `skills/ts-test-engineer` (fast-check).

## When to Use

| Property tests | Example tests |
|----------------|---------------|
| Pure functions | Side effects (DB, HTTP) |
| Validation and parsing | Specific business scenarios |
| Serializers | Integration flows |
| Mathematical properties | Small enumerable cases |

## Which Properties

- **Invariant**: always true of the output. "A discount never exceeds the subtotal", "end date is after start date".
- **Round trip**: two operations cancel. "parse(serialize(x)) = x".
- **Idempotence**: `f(f(x)) = f(x)`. "Normalising an already normalised string changes nothing". Not everything repeatable qualifies: applying a 10% discount twice is not applying it once.
- **Commutativity**: order does not matter. "Adding lines in any order gives the same total".

Do not restate the implementation. A property that recomputes the result the way the code does ("total equals the sum of line totals", written with the same fold) passes whenever the code runs. Assert a relation the code does not compute directly: a bound, a round trip, an invariant under reordering.

Generators produce only valid domain values, built through the same parsers as production input.

## Idempotence and Idempotency

Idempotence is the pure-function property above. Idempotency is about effects (`architecture.md` → "Effects are retry-safe") and needs a model-based property over the shell with a counting fake: for any sequence of retries, crashes after the downstream call, and timeouts on one key, the fake records at most one charge and every completed call returns the same outcome. Add two example tests beside it: N parallel calls with one key produce one effect, and the same key under two principals produces two independent attempts.
