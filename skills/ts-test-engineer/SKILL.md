---
name: ts-test-engineer
version: 1.0.0
description: "TypeScript/Next.js tests: Vitest, React Testing Library, fast-check property tests, MSW, Playwright. Use to write, fix or extend TypeScript tests. Not for Java tests (java-test-engineer), production code or CI setup."
---

# TypeScript Test Engineer

How to write, review and fix tests in TypeScript/Next.js applications.

## Context Loading

If not already in context this session, read `${CLAUDE_PLUGIN_ROOT}/rules/architecture.md` and the one language rule matching the files in scope.

Tests follow those rules: the functional core is exercised with plain data, and I/O is substituted at ports with object-literal fakes.

## Step 1: Determine What to Test

| What you have | Test type | Tool |
|---------------|-----------|------|
| Pure function, validator, parser | Property test | fast-check |
| Discriminated union handler | Property test + example test | fast-check + Vitest |
| Shell orchestrator | Unit test with object-literal port fakes | Vitest |
| React component | Component test | RTL + Vitest |
| Custom hook | Hook test | `renderHook` + Vitest |
| API route handler | Integration test | Vitest (direct import) |
| Server Component (async) | E2E test | Playwright (Vitest does not support async Server Components) |
| Critical user flow | E2E test | Playwright |
| API interaction | Mock with MSW | MSW v2 (`http`/`HttpResponse`) |

## Step 2: Apply Core Principles

1. **Test pyramid**: about 70% unit, 20% integration, 10% E2E.
2. **Testability over mocking**: pure functions for logic, dependencies passed as ports, props or context, data fetching separate from rendering. `vi.mock` is the last resort, for a module you cannot reach any other way.
3. **Behavior, not implementation**: test what the user sees and does, or what the fake recorded. Tests should survive a refactor.
4. **Properties before examples** for pure functions with invariants, parsers, codecs and state transitions.

## Step 3: Write the Test

| Need | Reference |
|------|-----------|
| Vitest config, port fakes, factories, timers | `references/vitest-patterns.md` |
| RTL, components and hooks, providers, MSW | `references/react-component-testing.md` |
| Next.js App Router: components, route handlers, Server Actions, proxy | `references/nextjs-testing.md` |
| Playwright E2E, auth state, page objects, a11y | `references/e2e-playwright.md` |

## Property-Based Testing (fast-check)

When to reach for a property and which kinds exist is in `${CLAUDE_PLUGIN_ROOT}/rules/property-testing.md`. A property states a fact about the result that does not repeat the implementation.

```typescript
import fc from 'fast-check';

// Invariant
it('a discounted total is never negative and never above the price', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 100 }), (price, percent) => {
      const total = applyDiscount(price, percent);
      expect(total).toBeGreaterThanOrEqual(0);
      expect(total).toBeLessThanOrEqual(price);
    }),
  );
});

// Round trip through the project's own codec
it('decodeCursor inverts encodeCursor', () => {
  fc.assert(
    fc.property(cursorArbitrary, (cursor) => {
      expect(decodeCursor(encodeCursor(cursor))).toEqual({ ok: true, value: cursor });
    }),
  );
});

// Idempotence: f(f(x)) = f(x). True of normalisers; not of a percentage discount.
it('normalizing twice equals normalizing once', () => {
  fc.assert(fc.property(fc.string(), (s) => expect(normalize(normalize(s))).toBe(normalize(s))));
});
```

Arbitraries build valid domain values; a discriminated union gets one arbitrary per variant:

```typescript
const cursorArbitrary = fc.record({
  id: fc.uuid(),
  createdAt: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
});

const resultArbitrary = fc.oneof(
  fc.record({ status: fc.constant('success' as const), data: fc.string() }),
  fc.record({ status: fc.constant('error' as const), error: fc.string() }),
  fc.record({ status: fc.constant('loading' as const) }),
);

it('describes every result', () => {
  fc.assert(fc.property(resultArbitrary, (result) => expect(describeResult(result)).not.toBe('')));
});
```

### Idempotency of an effect (model-based)

Idempotency is a different claim from idempotence: a command that arrives many times changes the world once and gets one answer. Test it through the orchestrator with a counting fake at the port, over generated sequences of retries and failures.

```typescript
it('charges at most once across retries, crashes and timeouts', async () => {
  const steps = fc.array(fc.constantFrom('ok', 'crash-after-psp', 'timeout'), { minLength: 1, maxLength: 20 });

  await fc.assert(
    fc.asyncProperty(steps, async (run) => {
      const psp = countingFakePsp();   // counts charges per key and replays the first outcome
      const charge = chargeCard({ ...inMemoryAttempts(), pspCharge: psp.charge });
      const outcomes = new Set<string>();

      for (const step of run) {
        psp.onNextCall(step);          // 'crash-after-psp': charge, then throw; 'timeout': outcome unknown
        const result = await charge(command).catch(() => undefined);  // the crash; the next step is the retry
        if (result?.ok) outcomes.add(JSON.stringify(result.value));
      }

      expect(psp.chargeCount(command.key)).toBeLessThanOrEqual(1);
      expect(outcomes.size).toBeLessThanOrEqual(1);   // every completed call returned the same outcome
    }),
  );
});
```

Add two example tests beside it: N parallel calls with one key produce one charge, and the same key under two merchants produces two independent attempts.

## Anti-Patterns

```typescript
// BAD: testing internal state
expect(component.state.isOpen).toBe(true);
// GOOD: test what user sees
expect(screen.getByRole('dialog')).toBeVisible();

// BAD: mocking everything
vi.mock('./utils'); vi.mock('./helpers'); vi.mock('./formatters');
// GOOD: use real implementations for pure functions
import { formatDate, calculateTotal } from './utils';

// BAD: meaningless snapshot
expect(component).toMatchSnapshot();
// GOOD: targeted assertions
expect(screen.getByRole('heading')).toHaveTextContent('Welcome');

// BAD: arbitrary timeout
await new Promise(r => setTimeout(r, 1000));
// GOOD: wait for specific condition
await waitFor(() => expect(screen.getByText('Loaded')).toBeInTheDocument());
```

## Checklist

- [ ] Test name describes behavior, not implementation
- [ ] A test for a claimed Acceptance Scenario starts its name with the identifier: `it('AS-004: rejects a stale cursor', …)`. `/spec-check` links scenarios to tests only by this prefix
- [ ] Accessible queries (`getByRole`, `getByLabelText`) from `screen`, in components and in Playwright
- [ ] `userEvent.setup()` for interactions, not `fireEvent`
- [ ] Independent of other tests; no arbitrary waits
- [ ] Happy path and the key error cases
- [ ] HTTP is faked with MSW v2 (`http`, `HttpResponse`), not a stubbed `fetch`
- [ ] Pure functions with invariants have property tests; a retried effect has the model-based property
- [ ] Async Server Components are covered by Playwright, their synchronous children by Vitest
