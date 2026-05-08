# React Component Testing Reference

Component and hook testing with React Testing Library, MSW for API mocking.

## Setup

```typescript
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
```

## Component Testing

```typescript
describe('LoginForm', () => {
  it('should submit with valid credentials', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<LoginForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      email: 'test@example.com',
      password: 'password123',
    });
  });

  it('should show validation errors', async () => {
    const user = userEvent.setup();
    render(<LoginForm onSubmit={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(screen.getByText(/email is required/i)).toBeInTheDocument();
  });
});
```

## Loading/Error States

```typescript
it('should show loading state', () => {
  render(<UserProfile userId="1" isLoading />);
  expect(screen.getByRole('progressbar')).toBeInTheDocument();
});

it('should show error state', () => {
  render(<UserProfile userId="1" error="Failed to load" />);
  expect(screen.getByRole('alert')).toHaveTextContent('Failed to load');
});
```

## Hook Testing

```typescript
import { renderHook, act } from '@testing-library/react';

describe('useCounter', () => {
  it('should increment', () => {
    const { result } = renderHook(() => useCounter(0));

    act(() => {
      result.current.increment();
    });

    expect(result.current.count).toBe(1);
  });
});
```

## Testing with Providers

```typescript
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) {
  const queryClient = createTestQueryClient();

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  }

  return render(ui, { wrapper: Wrapper, ...options });
}
```

---

## API Mocking with MSW v2

### Handler Setup

```typescript
// src/mocks/handlers.ts
import { http, HttpResponse } from 'msw';

export const handlers = [
  http.get('/api/users/:id', ({ params }) => {
    return HttpResponse.json({ id: params.id, name: 'Test User' });
  }),

  http.post('/api/orders', async ({ request }) => {
    const body = await request.json();
    return HttpResponse.json({ id: '123', ...body }, { status: 201 });
  }),
];

// src/mocks/server.ts
import { setupServer } from 'msw/node';
import { handlers } from './handlers';
export const server = setupServer(...handlers);
```

### Vitest Integration

```typescript
// vitest.setup.ts
import { beforeAll, afterAll, afterEach } from 'vitest';
import { server } from './mocks/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());
```

### Override Handlers Per Test

```typescript
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

it('should handle API error', async () => {
  server.use(
    http.get('/api/users/:id', () => {
      return HttpResponse.json({ error: 'Server error' }, { status: 500 });
    })
  );

  render(<UserProfile userId="1" />);

  await waitFor(() => {
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
```

## Query Priority

Prefer accessible queries in this order:
1. `getByRole` — best, matches ARIA roles
2. `getByLabelText` — form fields
3. `getByPlaceholderText` — fallback for unlabeled inputs
4. `getByText` — non-interactive elements
5. `getByTestId` — last resort
