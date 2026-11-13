# Vitest Patterns

## Configuration

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'jsdom',           // only component tests need it; pure and orchestrator tests run in 'node'
    setupFiles: ['./vitest.setup.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'lcov'] },
  },
});
```

```typescript
// vitest.setup.ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());
```

The MSW server lifecycle also goes in the setup file; see `react-component-testing.md`.

## Port Fakes Before Mocks

An orchestrator takes its ports as arguments, so the test passes object literals. No mocking API is involved, and the assertion reads the state the fake holds.

```typescript
const fakeOrders = (seed: Order[] = []): OrderRepository => {
  const store = new Map(seed.map((o) => [o.id, o]));
  return {
    find: async (id) => store.get(id) ?? null,
    save: async (order) => { store.set(order.id, order); },
  };
};

it('submits a draft order', async () => {
  const orders = fakeOrders([draftOrder]);
  const submit = submitOrder({ orders, now: () => new Date('2024-01-15T10:00:00Z') });

  const result = await submit(draftOrder.id);

  expect(result.ok).toBe(true);
  expect((await orders.find(draftOrder.id))?.status).toBe('submitted');
});
```

Time and randomness are ports too (`now`, `newId`): pass a fixed function instead of mocking the clock.

## Test Data Factories

```typescript
export const aUser = (overrides: Partial<User> = {}): User => ({
  id: 'user-1',
  email: 'user@example.com',
  name: 'Test User',
  role: 'user',
  ...overrides,
});
```

Fixed defaults keep failures reproducible. Use fast-check, not random factory data, when you want variety.

## Parameterized Tests

```typescript
it.each([
  ['test@example.com', true],
  ['invalid', false],
  ['@nodomain.com', false],
])('validateEmail(%s) = %s', (email, expected) => {
  expect(validateEmail(email)).toBe(expected);
});
```

## Timers

For code that owns a timer (debounce, polling) and cannot take a clock:

```typescript
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('debounces calls', () => {
  const fn = vi.fn();
  const debounced = debounce(fn, 100);

  debounced();
  debounced();
  expect(fn).not.toHaveBeenCalled();

  vi.advanceTimersByTime(100);
  expect(fn).toHaveBeenCalledOnce();
});
```

## Module Mocks: Last Resort

`vi.mock` replaces a module for the whole file and couples the test to an import path. Use it only for a framework module you cannot pass in (`next/navigation`, `next/cache`); the samples are in `nextjs-testing.md`. If you are about to mock one of your own modules, pass it as a port instead.

## Snapshots

Prefer targeted assertions. When a snapshot is the right tool (a generated config, a formatted report), use `toMatchInlineSnapshot` so the expected value is reviewed in the diff.
