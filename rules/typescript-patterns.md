---
description: TypeScript/Next.js architectural patterns - discriminated unions, ts-pattern, FP
globs: "**/*.{ts,tsx}"
---

# TypeScript/Next.js Architecture Patterns

## Package Structure

Organize modules to mirror the Functional Core / Imperative Shell / Infrastructure layering. Dependency arrows point inward: infra → domain, orchestrator → domain. Never outward.

### General TypeScript Backend

```
src/
├── domain/              Pure functional core (no I/O, no framework imports)
│   ├── model/           Types, branded types, discriminated unions
│   ├── port/            Port type aliases (seams — owned by domain, implemented in infra)
│   └── error/           Result/Error types
│   └── *.ts             Pure logic functions
│
├── orchestrator/        Shell orchestrators (sequence ports + pure domain logic)
│                        Named after the operation, not "service".
│                        Imports from domain/ only. Never from infra/.
│
├── api/ | routes/       Outermost shell (framework entry points: Express handlers, tRPC routers)
│                        Also orchestrators — call orchestrator/ or ports directly.
│
├── infra/               Adapters (port implementations) + SDK wrappers
│   └── {system}/        Grouped by external system (stripe/, postgres/, redis/)
│
└── config/              Environment, feature flags, DI wiring
```

### Next.js App Router

```
app/                     Route handlers (outermost shell — framework entry points)
├── api/                 API routes
└── (pages)/             Server components as orchestrators

src/ | lib/
├── domain/              Pure functional core
│   ├── model/           Types, Zod schemas (source of truth)
│   ├── port/            Port type aliases
│   └── *.ts             Pure logic
├── orchestrator/        Shell orchestrators (server actions often live here)
├── infra/               Adapters
└── config/              Environment, providers
```

**Import rules (enforced by convention or eslint-plugin-boundaries):**
- `domain/` imports nothing from `orchestrator/`, `infra/`, `api/`, or `config/`
- `orchestrator/` imports from `domain/` (ports + model + logic). Never from `infra/`.
- `infra/` imports from `domain/port/` (to implement) and vendor SDKs. Never from `orchestrator/`.
- `api/` / `app/` imports from `domain/` and `orchestrator/`. Never from `infra/`.

**Naming:**
- Orchestrators: named after the operation (`calculateShipping`) or aggregate (`orderOrchestrator`) — never `XxxService`
- Adapters: named after the system + role (`stripePaymentAdapter`, `pgOrderAdapter`)
- Ports: named after the domain capability (`OrderRepository`, `PaymentGateway`)

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
- Use ports and adapters pattern (see below)
- Test response handling with fixture data

## Ports & Adapters at I/O Boundaries
See `architecture.md` → "Ports at I/O Boundaries" for when this applies.

Prefer a `type` alias of an object with method signatures over `class` + `interface` — fakes become object literals.

```typescript
// Port: owned by the domain, types are domain types
type OrderRepository = {
  find: (id: OrderId) => Promise<Order | null>;
  save: (order: Order) => Promise<void>;
};

// Single-method ports are just function types
type Clock = () => Date;

type Cache<V> = {
  get: (key: string) => Promise<V | null>;
  set: (key: string, value: V, ttlSeconds?: number) => Promise<void>;
};

// Adapter: real implementation (lives in the shell)
const pgOrderRepository = (pool: Pool): OrderRepository => ({
  find: async (id) => {
    const row = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    return row.rows[0] ? parseOrder(row.rows[0]) : null;
  },
  save: async (order) => {
    await pool.query('INSERT INTO orders ...', [/* ... */]);
  },
});

// Test fake: plain object literal, no mocking framework
const fakeOrderRepository = (seed: Order[] = []): OrderRepository => {
  const store = new Map(seed.map((o) => [o.id, o]));
  return {
    find: async (id) => store.get(id) ?? null,
    save: async (order) => { store.set(order.id, order); },
  };
};

// Single-method ports collapse to a function type
type IdGenerator = () => OrderId;

const seededIds = (start = 1): IdGenerator => {
  let n = start;
  return () => `order-${n++}` as OrderId;
};
```

When a port has one method, use a function type — don't wrap it in an object just to look like an "interface". Multi-method ports use object types.

## State Management (Zustand)
- Keep store actions thin - orchestrate, don't contain logic
- Extract business logic into pure functions
- Test state transitions as pure: `(state, action) => newState`

## Next.js API Routes
```typescript
// Minimal logic in route handlers
// Extract request validation into pure functions
// Route handlers: parse -> call orchestrator -> format response

export async function POST(req: Request) {
    const body = await req.json();

    // Pure validation
    const validated = validateOrderRequest(body);
    if (!validated.success) return Response.json(validated.error, { status: 400 });

    // Orchestrate (I/O boundary)
    const result = await createOrder(validated.data);

    // Pure response formatting
    return Response.json(formatOrderResponse(result));
}
```

## React Components
- Separate presentation from logic
- Extract complex logic into custom hooks or utility functions
- Test logic independently from rendering
- Use component testing only for integration
