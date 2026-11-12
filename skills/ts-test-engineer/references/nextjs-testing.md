# Next.js Testing Reference

Testing patterns for Next.js App Router applications. Samples target Next.js 15 and later, where `params` is a Promise.

The framework files (`page.tsx`, `route.ts`, Server Actions, `proxy.ts`) are the outermost shell. Keep them thin, put the behavior in a function that takes its ports, and test that function with object-literal fakes (see `vitest-patterns.md`). Rendering helpers with providers are in `react-component-testing.md`.

## Server Components

Vitest does not support `async` Server Components. Unit test synchronous components and cover the async page with Playwright.

```typescript
// app/users/[id]/page.tsx — async: covered by E2E
export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await fetchUser(id);
  return <UserProfile user={user} />;
}

// __tests__/UserProfile.test.tsx — the synchronous child, unit tested
it('renders the user profile', () => {
  render(<UserProfile user={{ id: '1', name: 'Test User', email: 'test@example.com' }} />);
  expect(screen.getByText('Test User')).toBeInTheDocument();
});
```

## Client Components

```typescript
// components/Counter.tsx
'use client';

import { useState } from 'react';

export function Counter({ initial = 0 }: { initial?: number }) {
  const [count, setCount] = useState(initial);
  return (
    <div>
      <output aria-label="count">{count}</output>
      <button onClick={() => setCount((c) => c + 1)}>Increment</button>
    </div>
  );
}

// __tests__/Counter.test.tsx
it('increments on click', async () => {
  const user = userEvent.setup();
  render(<Counter initial={5} />);

  await user.click(screen.getByRole('button', { name: /increment/i }));

  expect(screen.getByRole('status', { name: 'count' })).toHaveTextContent('6');
});
```

## Route Handlers

A `route.ts` file may export only the HTTP methods and route config, so the handlers are built in a separate module from their ports and the route file wires in the real adapters.

```typescript
// src/api/users.ts
export const usersHandlers = ({ users }: { users: UserRepository }) => ({
  GET: async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const user = await users.find(id);
    return user
      ? Response.json(user)
      : Response.json({ error: 'Not found' }, { status: 404 });
  },
});

// app/api/users/[id]/route.ts
export const { GET } = usersHandlers({ users: pgUserRepository(pool) });

// __tests__/api/users.test.ts
const { GET } = usersHandlers({ users: fakeUsers([aUser({ id: '1', name: 'Test User' })]) });
const get = (id: string) =>
  GET(new Request(`http://localhost/api/users/${id}`), { params: Promise.resolve({ id }) });

it('returns the user', async () => {
  const response = await get('1');

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ name: 'Test User' });
});

it('returns 404 for an unknown user', async () => {
  expect((await get('unknown')).status).toBe(404);
});
```

A handler that reads `request.nextUrl` or `request.cookies` is typed `NextRequest`; construct `new NextRequest(url, init)` in its test.

## Server Actions

A `'use server'` file may export only async functions. The action parses the form and delegates; the delegate takes its ports, including cache revalidation.

```typescript
// src/orchestrator/rename-user.ts
export const renameUser =
  ({ users, revalidate }: { users: UserRepository; revalidate: (path: string) => void }) =>
  async (id: UserId, name: string): Promise<void> => {
    const user = await users.find(id);
    if (!user) return;
    await users.save({ ...user, name });
    revalidate('/users');
  };

// actions/user.ts
'use server';
export async function renameUserAction(formData: FormData) {
  const input = parseRenameForm(formData);   // parse, don't cast
  if (!input.ok) return input;
  await renameUser({ users: pgUserRepository(pool), revalidate: revalidatePath })(input.value.id, input.value.name);
}

// __tests__/rename-user.test.ts
it('renames the user and revalidates the list', async () => {
  const users = fakeUsers([aUser({ id: '1' })]);
  const revalidated: string[] = [];

  await renameUser({ users, revalidate: (path) => revalidated.push(path) })('1' as UserId, 'Updated Name');

  expect((await users.find('1' as UserId))?.name).toBe('Updated Name');
  expect(revalidated).toEqual(['/users']);
});
```

## Proxy (Middleware)

Next.js 16 renamed `middleware.ts` to `proxy.ts` and the exported function to `proxy`. On 15 and earlier the file and the function are named `middleware`; the test is the same.

```typescript
// proxy.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const token = request.cookies.get('token');
  if (!token && request.nextUrl.pathname.startsWith('/dashboard')) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return NextResponse.next();
}

// __tests__/proxy.test.ts
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

it('redirects unauthenticated users away from the dashboard', () => {
  const response = proxy(new NextRequest('http://localhost/dashboard'));

  expect(response.status).toBe(307);
  expect(response.headers.get('location')).toContain('/login');
});

it('lets authenticated users through', () => {
  const request = new NextRequest('http://localhost/dashboard', { headers: { cookie: 'token=valid-token' } });

  expect(proxy(request).headers.get('location')).toBeNull();
});
```

## Components That Use `next/navigation`

`next/navigation` cannot be passed in, so this is the case for `vi.mock`. The mock factory is hoisted above the imports; create the spy with `vi.hoisted` so the factory and the test share it.

```typescript
const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/current-path',
  useSearchParams: () => new URLSearchParams('query=test'),
}));

it('navigates on submit', async () => {
  const user = userEvent.setup();
  render(<SearchForm />);

  await user.type(screen.getByRole('searchbox'), 'query');
  await user.click(screen.getByRole('button', { name: /search/i }));

  expect(push).toHaveBeenCalledWith('/search?q=query');
});
```

## Error Boundaries

Import the `error.tsx` component under a name that does not shadow the global `Error`.

```typescript
// app/users/error.tsx
'use client';

export default function UsersError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert">
      <p>Error: {error.message}</p>
      <button onClick={reset}>Try again</button>
    </div>
  );
}

// __tests__/users/error.test.tsx
import UsersError from '@/app/users/error';

it('displays the error and allows a retry', async () => {
  const reset = vi.fn();
  const user = userEvent.setup();

  render(<UsersError error={new Error('Failed to load')} reset={reset} />);

  expect(screen.getByRole('alert')).toHaveTextContent('Failed to load');

  await user.click(screen.getByRole('button', { name: /try again/i }));
  expect(reset).toHaveBeenCalled();
});
```
