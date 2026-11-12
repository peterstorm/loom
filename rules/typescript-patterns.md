---
description: TypeScript/Next.js architectural patterns - discriminated unions, Result, parse-don't-validate, ports
globs: "**/*.{ts,tsx}"
---

# TypeScript/Next.js Architecture Patterns

The rules are in `architecture.md`; this file gives their TypeScript shape. Samples assume `match` from `ts-pattern`, `z` from `zod` and branded domain types (`MerchantId`, `Money`, …).

## Package Structure

Dependency arrows point inward: infra → domain, orchestrator → domain. Never outward.

```
src/
├── domain/              Pure functional core (no I/O, no framework imports)
│   ├── model/           Types, branded types, discriminated unions, Zod schemas
│   ├── port/            Port type aliases (owned by domain, implemented in infra)
│   ├── error/           Error unions
│   └── *.ts             Pure logic functions
├── orchestrator/        Shell orchestrators: sequence ports + pure domain logic
├── api/ | routes/       Outermost shell: Express handlers, tRPC routers
├── infra/{system}/      Adapters and SDK wrappers, grouped by external system (stripe/, postgres/)
└── config/              Environment, feature flags, wiring
```

Next.js App Router: `app/` is the outermost shell (route handlers, server components); `src/` or `lib/` holds the same `domain/`, `orchestrator/`, `infra/`, `config/`. Server actions live in `orchestrator/`.

**Import rules** (`eslint-plugin-boundaries` or Loom's `boundaries` lint):
- `domain/` imports nothing from `orchestrator/`, `infra/`, `api/`, or `config/`
- `orchestrator/` imports from `domain/` (ports + model + logic). Never from `infra/`.
- `infra/` imports from `domain/port/` (to implement) and vendor SDKs. Never from `orchestrator/`.
- `api/` / `app/` imports from `domain/` and `orchestrator/`. Never from `infra/`.

**Naming:** orchestrators after the operation (`calculateShipping`) or aggregate (`orderOrchestrator`); adapters after system + role (`stripePaymentAdapter`, `pgOrderRepository`); ports after the domain capability (`OrderRepository`, `PaymentGateway`).

## Compiler Gates

`strict: true` does not include the unused-code checks. Turn them on explicitly.

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,       // dead imports, dead consts
    "noUnusedParameters": true,   // dead params (prefix intentional ones with _)
    "noImplicitReturns": true,    // every branch returns, or none does
    "noFallthroughCasesInSwitch": true
  }
}
```

If a dependency ships raw `.ts` sources, these flags report its dead code too and `skipLibCheck` does not help; run them from a script that filters the output to your own paths.

These flags do not catch dead exports: `tsc` assumes an exported symbol has an external consumer. Aliases left by a rename, facades whose callers went direct and "for compat" re-exports collect there. Find them with `knip`.

## One Result Shape

One shape for every fallible function in the core, with a typed error (a union, never `string`):

```typescript
type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

const assertNever = (x: never): never => {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
};

// Zod's { success, data } is converted once, at the boundary.
type ParseError = { kind: 'invalid'; issues: readonly string[] };

const parseWith = <T>(schema: z.ZodType<T>, raw: unknown): Result<T, ParseError> => {
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : err({ kind: 'invalid', issues: parsed.error.issues.map((i) => i.message) });
};
```

**Wire data is parsed, never cast.** Bind `JSON.parse` / `.json()` output as `unknown` and parse it: `const raw: unknown = JSON.parse(text); return parseWith(orderSchema, raw);`. `as T` (or a `: T` annotation) on wire data is refused by the `no-wire-cast` lint rule.

Types: discriminated unions for states, `readonly` by default, derived from one source of truth (Zod schema, DB types), no `any`.

## Totality

**`switch` over a union is the un-checked form.** A `switch` with every arm listed and a declared return type fails to compile when a variant is added, but only where every arm returns. A switch that assigns, pushes or falls through, or whose scrutinee is `unknown`/`string`, compiles and silently stops covering the new variant. `match(x).exhaustive()` is a compile error either way. When you keep a `switch`, end it with `default: return assertNever(x)`. `default: throw new Error("unreachable")` proves nothing: it still compiles after the new variant lands. The `switch-totality` lint rule enforces this on every edit; only the `default` arm can carry the proof.

**`.exhaustive()` throws at runtime on an unexpected tag.** That is right for a value the type system owns and wrong for a wire document: a validator given `{status: "bogus"}` must report it, not crash. Parse first, then match. For a scrutinee the type system does not own, use `.otherwise(...)` and let the fallback name the unknown case.

**`Array.isArray(x)` narrows `unknown` to `any[]`.** Every element read afterwards is unchecked and nothing reports it. Narrow with a typed predicate or a schema (`z.array(rowSchema)`).

## Canonical Example: Charging a Card

A discriminated union, a pure decision and a thin shell, implementing `architecture.md` → "Effects are retry-safe".

```typescript
// domain/charge.ts — pure: no I/O, no clock, no randomness
type ChargeCommand = Readonly<{
  merchantId: MerchantId; // from the authenticated session, never from the body
  key: IdempotencyKey; // parsed: length-bounded, restricted charset
  amount: Money; // integer minor units + currency, no floats
  method: PaymentMethodToken; // a PSP token; the card number never reaches this service
}>;

type Outcome =
  | { kind: 'succeeded'; chargeId: ChargeId }
  | { kind: 'declined'; reason: DeclineReason };

// A stored attempt. No state has both "pending" and an outcome.
type Attempt =
  | { status: 'pending'; fingerprint: Fingerprint }
  | { status: 'settled'; fingerprint: Fingerprint; outcome: Outcome };

type Decision =
  | { kind: 'charge' } // first sight of this key
  | { kind: 'replay'; outcome: Outcome } // already settled: return the stored answer
  | { kind: 'reconcile' } // an earlier run stopped mid-flight
  | { kind: 'key-reused' }; // same key, different command

export const decide = (existing: Attempt | undefined, fingerprint: Fingerprint): Decision => {
  if (existing === undefined) return { kind: 'charge' };
  if (existing.fingerprint !== fingerprint) return { kind: 'key-reused' };
  return existing.status === 'settled'
    ? { kind: 'replay', outcome: existing.outcome }
    : { kind: 'reconcile' };
};
```

```typescript
// orchestrator/charge-card.ts — sequences I/O around the pure decision
type ChargePorts = Readonly<{
  // INSERT … ON CONFLICT (merchant_id, key) DO NOTHING, then read the row.
  // Resolves to undefined when this call created the pending row.
  claim: (merchantId: MerchantId, key: IdempotencyKey, fp: Fingerprint) => Promise<Attempt | undefined>;
  settle: (merchantId: MerchantId, key: IdempotencyKey, outcome: Outcome) => Promise<void>;
  // The PSP deduplicates on the key it is given.
  pspCharge: (pspKey: string, cmd: ChargeCommand) => Promise<Outcome | { kind: 'unknown' }>;
}>;

type ChargeError = { kind: 'key-reused' } | { kind: 'in-progress' };

export const chargeCard =
  (ports: ChargePorts) =>
  async (cmd: ChargeCommand): Promise<Result<Outcome, ChargeError>> => {
    const fp = fingerprintOf(cmd); // pure: hash of amount, currency, method
    const existing = await ports.claim(cmd.merchantId, cmd.key, fp); // claimed before any money moves
    const decision = decide(existing, fp);

    switch (decision.kind) {
      case 'key-reused':
        return err({ kind: 'key-reused' });
      case 'replay':
        return ok(decision.outcome);
      case 'charge':
      case 'reconcile': {
        // Same downstream key on the first run and on every retry: the PSP charges at most once.
        const result = await ports.pspCharge(`${cmd.merchantId}:${cmd.key}`, cmd);
        if (result.kind === 'unknown') return err({ kind: 'in-progress' }); // stays pending; a retry reconciles
        await ports.settle(cmd.merchantId, cmd.key, result);
        return ok(result);
      }
      default:
        return assertNever(decision);
    }
  };

// The ts-pattern form of the same proof:
export const describeOutcome = (outcome: Outcome): string =>
  match(outcome)
    .with({ kind: 'succeeded' }, ({ chargeId }) => `charged ${chargeId}`)
    .with({ kind: 'declined' }, ({ reason }) => `declined: ${reason}`)
    .exhaustive();
```

- **FP:** the whole policy is `decide`, pure and total, tested with no fakes. `Attempt` cannot be half pending, half settled. The shell only dispatches on the decision; `key-reused` and `in-progress` are values, not exceptions.
- **Idempotency:** a unique constraint claims the key before the effect, so two concurrent requests cannot both see "no attempt". `charge` and `reconcile` share a path because the PSP gets the same key: a crash before `settle` is healed by the next retry, not by a second charge. A timeout leaves the attempt pending; releasing the key is the classic double charge. If the PSP cannot deduplicate, `reconcile` queries it first.
- **Security:** the key is scoped to the session's `merchantId`, so one tenant cannot replay or block another's payment. The fingerprint stops a key being reused to change the amount or method. The key is parsed at the boundary, expires on a documented TTL longer than the client's retry window, and stays out of logs with the token. The PSP webhook verifies the signature, then deduplicates on the event id.

## Value Objects, Branded Types and Aggregates

```typescript
type OrderId = string & { readonly __brand: 'OrderId' };
type CustomerId = string & { readonly __brand: 'CustomerId' };

// Swap protection only: the cast checks nothing. Use it for values your own code minted.
const OrderId = (s: string): OrderId => s as OrderId;

// A value with an invariant is parsed by a smart constructor.
type Email = string & { readonly __brand: 'Email' };
type EmailError = { kind: 'invalid-email'; raw: string };

export const parseEmail = (raw: string): Result<Email, EmailError> =>
  /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? ok(raw as Email) : err({ kind: 'invalid-email', raw });

// Aggregate: readonly data. Commands are pure functions shaped like `decide`:
// (order, command data) => Result<Order, OrderError>, returning a new order via spread.
type Order = Readonly<{
  id: OrderId;
  customer: CustomerId;
  lines: readonly OrderLine[];
  status: 'draft' | 'submitted';
}>;
```

Brand same-typed parameters that could be swapped silently (IDs, keys, names).

## Ports & Adapters at I/O Boundaries

See `architecture.md` → "Ports at I/O Boundaries" for when a port is earned. A port is a `type` alias of an object with method signatures, not `class` + `interface`, so a fake is an object literal. A single-method port is a function type. Adapters live in `infra/` and parse what they read: rows are wire data.

```typescript
// Port: owned by the domain, typed in domain terms.
type OrderRepository = {
  find: (id: OrderId) => Promise<Order | undefined>;
  save: (order: Order) => Promise<void>;
};

type Clock = () => Date;

// Test fakes: object literals, no mocking framework.
export const fakeOrderRepository = (seed: readonly Order[] = []): OrderRepository => {
  const store = new Map(seed.map((o) => [o.id, o]));
  return {
    find: async (id) => store.get(id),
    save: async (order) => { store.set(order.id, order); },
  };
};

export const fixedClock = (at: Date): Clock => () => at;
```

## Framework Edges

Route handlers, server actions, Zustand store actions and React components are shell: they parse, call an orchestrator or a pure function, and format. Logic lives in pure functions (`(state, action) => newState`, custom hooks over pure helpers) and is tested with plain objects, not DB mocks or renders.

```typescript
export async function POST(req: Request): Promise<Response> {
  const raw: unknown = await req.json();
  const request = parseWith(createOrderRequestSchema, raw); // parse: the orchestrator accepts only the parsed type
  if (!request.ok) return Response.json(request.error, { status: 400 });

  const created = await createOrder(request.value); // orchestrator: all I/O behind ports
  return created.ok
    ? Response.json({ id: created.value.id }, { status: 201 })
    : Response.json(created.error, { status: 422 });
}
```
