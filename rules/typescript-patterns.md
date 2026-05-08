---
description: TypeScript/Next.js architectural patterns - discriminated unions, ts-pattern, FP
globs: "**/*.{ts,tsx}"
---

# TypeScript/Next.js Architecture Patterns

## Discriminated Unions with ts-pattern
```typescript
// Domain state modeling - exhaustive, type-safe
type OrderState =
  | { status: 'draft'; items: OrderItem[] }
  | { status: 'submitted'; items: OrderItem[]; submittedAt: Date }
  | { status: 'paid'; items: OrderItem[]; paidAt: Date; transactionId: string }
  | { status: 'failed'; error: string };

// Exhaustive pattern matching - compiler error if case missed
import { match, P } from 'ts-pattern';

const handleOrder = (order: OrderState): string =>
  match(order)
    .with({ status: 'draft' }, ({ items }) => `Draft with ${items.length} items`)
    .with({ status: 'submitted' }, ({ submittedAt }) => `Submitted at ${submittedAt}`)
    .with({ status: 'paid' }, ({ transactionId }) => `Paid: ${transactionId}`)
    .with({ status: 'failed' }, ({ error }) => `Failed: ${error}`)
    .exhaustive();

// Railway-oriented error handling
type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

const processOrder = (input: unknown): Result<Order> =>
  match(validateInput(input))
    .with({ ok: true }, ({ value }) => applyPricing(value))
    .with({ ok: false }, (err) => err)
    .exhaustive();

// Pattern matching with guards
const getDiscount = (customer: Customer): number =>
  match(customer)
    .with({ tier: 'gold', ordersCount: P.number.gte(10) }, () => 20)
    .with({ tier: 'gold' }, () => 15)
    .with({ tier: 'silver' }, () => 10)
    .otherwise(() => 0);
```

## Branded Types for Stringly-Typed Parameters
Prevent argument-swap bugs by branding primitive types that represent distinct domain concepts.

```typescript
// BAD: two strings, easy to swap silently
function backfill(projectName: string, apiKey: string): void

// GOOD: branded types catch swaps at compile time
type ProjectName = string & { readonly __brand: 'ProjectName' };
type ApiKey = string & { readonly __brand: 'ApiKey' };

const ProjectName = (s: string): ProjectName => s as ProjectName;
const ApiKey = (s: string): ApiKey => s as ApiKey;

function backfill(projectName: ProjectName, apiKey: ApiKey): void

// Compile error: Argument of type 'ApiKey' is not assignable to 'ProjectName'
backfill(apiKey, projectName);
```

Use branded types when:
- Multiple same-typed params could be confused (IDs, keys, names)
- Domain concepts deserve distinct types (UserId vs OrderId)
- Bugs from argument swaps would be silent at runtime

## Database Operations
- Extract query logic from business logic
- Pass query results as data to pure functions
- Return data structures describing what to persist
- Test business logic with plain objects, not DB mocks

## API Integrations
- Separate API calling from response processing
- Make response processing pure functions
- Use ports and adapters pattern
- Test response handling with fixture data

## State Management (Zustand)
- Keep store actions thin - orchestrate, don't contain logic
- Extract business logic into pure functions
- Test state transitions as pure: `(state, action) => newState`

## Next.js API Routes
```typescript
// Minimal logic in route handlers
// Extract request validation into pure functions
// Route handlers: parse -> call service -> format response

export async function POST(req: Request) {
    const body = await req.json();

    // Pure validation
    const validated = validateOrderRequest(body);
    if (!validated.success) return Response.json(validated.error, { status: 400 });

    // Call service (I/O boundary)
    const result = await orderService.create(validated.data);

    // Pure response formatting
    return Response.json(formatOrderResponse(result));
}
```

## React Components
- Separate presentation from logic
- Extract complex logic into custom hooks or utility functions
- Test logic independently from rendering
- Use component testing only for integration
