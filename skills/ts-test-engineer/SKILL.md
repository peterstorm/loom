---
name: ts-test-engineer
version: 1.0.0
description: "This skill should be used when the user asks to 'write unit tests', 'add integration tests', 'create tests for React components', 'fix failing test', 'improve test coverage', 'add Playwright tests', 'test this component', 'add fast-check tests', or needs guidance on Vitest, React Testing Library, Playwright, property testing with fast-check, MSW mocking, or test patterns for TypeScript/Next.js. NOT for writing production code, CI/CD setup, or deployment."
---

# TypeScript Test Engineer Skill

Expert guidance for writing, reviewing, and fixing tests in TypeScript/Next.js applications.

---

## Workflow

### Step 1: Determine What to Test

| What you have | Test type | Tool |
|---------------|-----------|------|
| Pure function, validator, parser | Property test | fast-check |
| Discriminated union handler | Property test + example test | fast-check + Vitest |
| React component | Component test | RTL + Vitest |
| Custom hook | Hook test | `renderHook` + Vitest |
| API route handler | Integration test | Vitest (direct import) |
| Server Component (async) | E2E test | Playwright (Vitest doesn't support async Server Components yet) |
| Critical user flow | E2E test | Playwright |
| API interaction | Mock with MSW | MSW v2 (`http`/`HttpResponse`) |

### Step 2: Apply Core Principles

1. **Test pyramid**: 70% unit, 20% integration, 10% E2E
2. **Testability over mocking**: Pure functions for logic, DI via props/context, separate data fetching from rendering
3. **Test behavior, not implementation**: Test what user sees/does, not internal state. Tests should survive refactoring.
4. **Property tests > example tests** for pure functions with invariants, parsers, serializers, state transitions

### Step 3: Write the Test

Load the relevant reference for detailed patterns:

| Need | Reference |
|------|-----------|
| Vitest config, mocking, factories, async | `references/vitest-patterns.md` |
| RTL setup, component/hook testing, MSW | `references/react-component-testing.md` |
| Next.js App Router, Server Components, API routes | `references/nextjs-testing.md` |
| Playwright E2E, auth, page objects, a11y | `references/e2e-playwright.md` |

For property testing with fast-check, see below (not in references — it's unique domain knowledge).

---

## Property-Based Testing (fast-check)

Property tests find edge cases automatically. Use for pure functions and type transformations.

### When to Use

| Use Property Tests | Use Example Tests |
|-------------------|-------------------|
| Pure functions | Component rendering |
| Validation logic | User interactions |
| Parsers/serializers | API integration |
| State transitions | Specific business scenarios |
| Type narrowing | Visual regression |

### Common Patterns

#### 1. Invariants — "This should always be true"
```typescript
import fc from 'fast-check';

it('should never return negative', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 0, max: 100 }),
      (price, discount) => {
        expect(calculateTotal(price, discount)).toBeGreaterThanOrEqual(0);
      }
    )
  );
});
```

#### 2. Round-Trip / Symmetry
```typescript
it('serialize then deserialize = identity', () => {
  fc.assert(
    fc.property(userArbitrary, (user) => {
      expect(JSON.parse(JSON.stringify(user))).toEqual(user);
    })
  );
});
```

#### 3. Idempotence
```typescript
it('normalizing twice equals normalizing once', () => {
  fc.assert(
    fc.property(fc.string(), (input) => {
      expect(normalize(normalize(input))).toBe(normalize(input));
    })
  );
});
```

#### 4. Commutativity
```typescript
it('merge order should not matter', () => {
  fc.assert(
    fc.property(configArbitrary, configArbitrary, (a, b) => {
      expect(mergeConfig(a, b)).toEqual(mergeConfig(b, a));
    })
  );
});
```

### Custom Arbitraries
```typescript
const userArbitrary = fc.record({
  id: fc.uuid(),
  email: fc.emailAddress(),
  name: fc.string({ minLength: 1, maxLength: 100 }),
  role: fc.constantFrom('admin', 'user', 'guest'),
});
```

### Testing Discriminated Unions
```typescript
const resultArbitrary = fc.oneof(
  fc.record({ status: fc.constant('success' as const), data: fc.string() }),
  fc.record({ status: fc.constant('error' as const), error: fc.string() }),
  fc.record({ status: fc.constant('loading' as const) })
);

it('should handle any valid result without throwing', () => {
  fc.assert(
    fc.property(resultArbitrary, (result) => {
      expect(() => handleResult(result)).not.toThrow();
    })
  );
});
```

---

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

---

## Checklist

- [ ] Test name describes behavior, not implementation
- [ ] Uses accessible queries (`getByRole`, `getByLabelText`)
- [ ] Avoids implementation details
- [ ] Independent of other tests
- [ ] Fast (unit < 100ms)
- [ ] Covers happy path + key error cases
- [ ] No arbitrary waits/timeouts
- [ ] Uses MSW for API mocking (not fetch mocks)
- [ ] Property tests for pure functions with invariants

---

## References

| Topic | File | ~Tokens |
|-------|------|---------|
| Vitest config, mocking, factories, async | `references/vitest-patterns.md` | ~2,500 |
| RTL, component/hook testing, MSW | `references/react-component-testing.md` | ~2,500 |
| Next.js App Router, Server Components | `references/nextjs-testing.md` | ~3,000 |
| Playwright E2E, auth, page objects | `references/e2e-playwright.md` | ~3,500 |

---

## Constraints

- Prefer property tests over example tests for pure functions
- Use `userEvent.setup()` (not `fireEvent`) for user interactions
- Use MSW v2 API (`http`, `HttpResponse`) for API mocking
- Use `screen` queries over `container` destructuring
- Prefer Vitest browser mode for component testing when available; fall back to jsdom
- Async Server Components cannot be unit tested with Vitest — use Playwright E2E
