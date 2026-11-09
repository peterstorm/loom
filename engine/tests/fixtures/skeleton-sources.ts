/**
 * Source-text fixtures for the CT-2 conformance judge: one frozen TypeScript
 * contract and one frozen Java contract, their bound and unbound production
 * files in a conforming form, one seeded violation per variant, and the
 * near-miss view-models that must never trip a check.
 *
 * Every text is a plain string — the judge reads it through the real
 * surface readers, so a fixture states exactly what an implementer wrote.
 * Each violating variant differs from its conforming form only in the seeded
 * defect, so the expected violations are exactly the ones named beside it.
 */

// ---------------------------------------------------------------------------
// The frozen TypeScript contract (CT-1)
// ---------------------------------------------------------------------------

export const SOURCES_TS_CONTRACT_ID = "CT-1";
export const SOURCES_TS_TYPES_PATH = "src/order/order-contract.ts";

/**
 * Frozen ADTs: the brand `OrderId`; the discriminated union `OrderEvent`
 * (key `kind`, tags `placed | paid | shipped`, named variants `OrderPlaced`,
 * `OrderPaid`, `OrderShipped`); the inline-variant union `PaymentState` (key
 * `status`, tags `pending | settled`). `Order` and `Price` are plain object
 * types, no ADT. The three `…Fn` aliases are the bindable function types.
 */
export const SOURCES_TS_TYPES_TEXT = `export type OrderId = string & { readonly __brand: "OrderId" };

export type Order = Readonly<{ id: OrderId; unitCents: number }>;
export type Price = Readonly<{ cents: number }>;

export type OrderPlaced = Readonly<{ kind: "placed"; orderId: OrderId }>;
export type OrderPaid = Readonly<{ kind: "paid"; orderId: OrderId; cents: number }>;
export type OrderShipped = Readonly<{ kind: "shipped"; orderId: OrderId; carrier: string }>;
export type OrderEvent = OrderPlaced | OrderPaid | OrderShipped;

export type PaymentState =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "settled"; at: string }>;

export type PriceOrderFn = (order: Order, quantity: number) => Price;
export type ParseOrderFn = (raw: string) => Order;
export type ReplayEventsFn = (events: readonly OrderEvent[]) => readonly OrderEvent[];
`;

// ---------------------------------------------------------------------------
// TypeScript production files
// ---------------------------------------------------------------------------

/** Bound: `priceOrder: PriceOrderFn`, `parseOrder: ParseOrderFn`. */
export const TS_PRICING_PATH = "src/order/pricing.ts";
/** Bound: `replayEvents: ReplayEventsFn`. */
export const TS_REPLAY_PATH = "src/order/replay.ts";
/** Unbound, in scope: only the ADT checks apply. */
export const TS_LEDGER_PATH = "src/order/ledger.ts";

const TS_PRICING_IMPORTS = `import type { Order, OrderId, ParseOrderFn, Price, PriceOrderFn } from "./order-contract";
`;

const TS_PRICE_ORDER = `
export const priceOrder: PriceOrderFn = (order, quantity) => {
  if (quantity <= 0) throw new RangeError("quantity must be positive");
  return { cents: order.unitCents * quantity };
};
`;

const TS_PARSE_ORDER = `
export const parseOrder: ParseOrderFn = (raw) => {
  const [id = "", unitCents = "0"] = raw.split(":");
  return { id: id as OrderId, unitCents: Number(unitCents) };
};
`;

const TS_PRICE_ORDER_UNIMPLEMENTED = `
export const priceOrder: PriceOrderFn = () => {
  throw new Error("unimplemented: priceOrder");
};
`;

export const TS_PRICING = {
  /** Every bound export keeps its name and frozen-alias annotation; no marker. */
  conforming: TS_PRICING_IMPORTS + TS_PRICE_ORDER + TS_PARSE_ORDER,

  /** `parseOrder` removed; nothing else carries `ParseOrderFn`. → parseOrder deleted. */
  deleted: TS_PRICING_IMPORTS + TS_PRICE_ORDER,

  /** `priceOrder` now exported as `computePrice`, same annotation. → priceOrder renamed. */
  renamed: `${TS_PRICING_IMPORTS}
export const computePrice: PriceOrderFn = (order, quantity) => ({ cents: order.unitCents * quantity });
${TS_PARSE_ORDER}`,

  /** `priceOrder`'s annotation removed. → priceOrder retyped. */
  retypedUnannotated: `${TS_PRICING_IMPORTS}
export const priceOrder = (order: Order, quantity: number): Price => ({ cents: order.unitCents * quantity });
${TS_PARSE_ORDER}`,

  /** `priceOrder` annotated with an equivalent inline function type that still compiles. → priceOrder retyped. */
  retypedInlineType: `${TS_PRICING_IMPORTS}
export const priceOrder: (order: Order, quantity: number) => Price = (order, quantity) => ({
  cents: order.unitCents * quantity,
});
${TS_PARSE_ORDER}`,

  /** `priceOrder` annotated with a local alias of the same name, not the frozen one. → priceOrder retyped. */
  retypedLocalAlias: `import type { Order, OrderId, ParseOrderFn, Price } from "./order-contract";

type PriceOrderFn = (order: Order, quantity: number) => Price;

export const priceOrder: PriceOrderFn = (order, quantity) => ({ cents: order.unitCents * quantity });
${TS_PARSE_ORDER}`,

  /** `priceOrder` exported as a function declaration instead of `export const priceOrder: PriceOrderFn`. → priceOrder retyped. */
  retypedFunctionDeclaration: `${TS_PRICING_IMPORTS}
export function priceOrder(order: Order, quantity: number): Price {
  return { cents: order.unitCents * quantity };
}
${TS_PARSE_ORDER}`,

  /** `priceOrder`'s body still holds its exact marker. → priceOrder still unimplemented. */
  stillUnimplemented: TS_PRICING_IMPORTS + TS_PRICE_ORDER_UNIMPLEMENTED + TS_PARSE_ORDER,

  /** Legitimate throws, one of them only resembling the marker. → no violation. */
  otherThrows: `${TS_PRICING_IMPORTS}
export const priceOrder: PriceOrderFn = (order, quantity) => {
  if (quantity <= 0) throw new RangeError("quantity must be positive");
  if (quantity > 10_000) throw new Error("unimplemented: priceOrder for bulk orders");
  return { cents: order.unitCents * quantity };
};

export const parseOrder: ParseOrderFn = (raw) => {
  const [id, unitCents] = raw.split(":");
  if (id === undefined || unitCents === undefined) throw new SyntaxError(\`not an order: \${raw}\`);
  return { id: id as OrderId, unitCents: Number(unitCents) };
};
`,

  /**
   * Internal helpers and extra exports beside the bound ones, including an
   * extra export annotated with a frozen alias under a new name. → no violation.
   */
  withExtras: `${TS_PRICING_IMPORTS}
type Quote = Readonly<{ price: Price; label: string }>;

const TAX_RATE = 0.25;

const withTax = (price: Price): Price => ({ cents: Math.round(price.cents * (1 + TAX_RATE)) });
${TS_PRICE_ORDER}
export const priceOrderWithTax: PriceOrderFn = (order, quantity) => withTax(priceOrder(order, quantity));
${TS_PARSE_ORDER}
export function quote(order: Order, quantity: number): Quote {
  return { price: priceOrder(order, quantity), label: formatPrice(priceOrder(order, quantity)) };
}

export const formatPrice = (price: Price): string => \`\${(price.cents / 100).toFixed(2)}\`;

export class PriceCache {
  private readonly entries = new Map<string, Price>();
  lookup(order: Order): Price | undefined {
    return this.entries.get(order.id);
  }
}
`,

  /** Two seeded defects in one file. → priceOrder still unimplemented, parseOrder deleted. */
  severalViolations: TS_PRICING_IMPORTS + TS_PRICE_ORDER_UNIMPLEMENTED,
} as const;

export const TS_REPLAY = {
  /**
   * Imports the frozen ADTs, pattern-matches on them, constructs their
   * variants, and derives subsets from the frozen union (a union of frozen
   * variant types, and `Extract<…>`). → no violation.
   */
  conforming: `import type { OrderEvent, OrderPaid, OrderShipped, ReplayEventsFn } from "./order-contract";

type Settled = OrderPaid | OrderShipped;
type Shipment = Extract<OrderEvent, { kind: "shipped" }>;

const isSettled = (event: OrderEvent): event is Settled => event.kind === "paid" || event.kind === "shipped";

const reship = (event: Settled): Shipment => ({ kind: "shipped", orderId: event.orderId, carrier: "replay" });

export const describeEvent = (event: OrderEvent): string => {
  switch (event.kind) {
    case "placed":
      return \`placed \${event.orderId}\`;
    case "paid":
      return \`paid \${event.cents}\`;
    case "shipped":
      return \`shipped via \${event.carrier}\`;
  }
};

export const replayEvents: ReplayEventsFn = (events) => [...events, ...events.filter(isSettled).map(reship)];
`,

  /** The untouched engine skeleton. → replayEvents still unimplemented. */
  skeleton: `// Skeleton written by Loom from src/order/order-contract.ts (CT-1). Make these signatures work; keep each name and its type.
import type { ReplayEventsFn } from "./order-contract";

export const replayEvents: ReplayEventsFn = () => {
  throw new Error("unimplemented: replayEvents");
};
`,
} as const;

const TS_LEDGER_IMPORTS = `import type { OrderEvent } from "./order-contract";
`;

export const TS_LEDGER = {
  /**
   * Near-miss view-models, none of which re-declares a frozen ADT:
   * a string-literal union of the frozen tags (out of scope); a union keyed
   * by a different property; a union on the frozen key with no frozen tag;
   * a union sharing exactly one frozen tag; a single object shape carrying a
   * frozen tag; a local type named after a Java ADT (other language).
   * → no violation.
   */
  conforming: `${TS_LEDGER_IMPORTS}
export type EventKind = "placed" | "paid" | "shipped";

export type Badge =
  | Readonly<{ tone: "placed"; text: string }>
  | Readonly<{ tone: "paid"; text: string }>
  | Readonly<{ tone: "shipped"; text: string }>;

export type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; events: readonly OrderEvent[] }>;

export type RefundView =
  | Readonly<{ kind: "paid"; cents: number }>
  | Readonly<{ kind: "refunded"; cents: number }>;

export type PaidRow = Readonly<{ kind: "paid"; label: string }>;

export type Shape = Readonly<{ width: number; height: number }>;

export const ledgerSize = (events: readonly OrderEvent[]): number => events.length;
`,

  /** A local type alias named as the frozen union. → OrderEvent shadows frozen ADT. */
  shadowsUnionAsType: `export type OrderEvent = Readonly<{ id: string; at: string }>;
`,

  /** A local interface named as the frozen union. → OrderEvent shadows frozen ADT. */
  shadowsUnionAsInterface: `export interface OrderEvent {
  readonly id: string;
}
`,

  /** A local class named as the frozen union. → OrderEvent shadows frozen ADT. */
  shadowsUnionAsClass: `export class OrderEvent {
  constructor(readonly id: string) {}
}
`,

  /** A local type named as the frozen brand. → OrderId shadows frozen ADT. */
  shadowsBrand: `export type OrderId = string & { readonly __brand: "OrderId" };
`,

  /** A local type named as one frozen variant: the single shared name trips only the same-name rule. → OrderPaid shadows frozen ADT. */
  shadowsVariant: `export type OrderPaid = Readonly<{ kind: "paid"; cents: number }>;
`,

  /** A differently named local union re-listing every frozen tag. → OrderEvent re-lists frozen variants. */
  relistsAllTags: `export type LedgerEntry =
  | Readonly<{ kind: "placed"; orderId: string }>
  | Readonly<{ kind: "paid"; orderId: string; cents: number }>
  | Readonly<{ kind: "shipped"; orderId: string; carrier: string }>;
`,

  /** A local union re-listing a strict subset (two) of the frozen tags. → OrderEvent re-lists frozen variants. */
  relistsTagSubset: `export type SettledEntry =
  | Readonly<{ kind: "paid"; cents: number }>
  | Readonly<{ kind: "shipped"; carrier: string }>;
`,

  /** A local union re-listing the inline variants of `PaymentState`. → PaymentState re-lists frozen variants. */
  relistsInlineVariants: `export type PaymentView =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "settled"; at: string }>;
`,

  /** Two ADT defects in one file. → OrderId shadows frozen ADT, OrderEvent re-lists frozen variants. */
  severalViolations: `export type OrderId = string & { readonly __brand: "OrderId" };

export type SettledEntry =
  | Readonly<{ kind: "paid"; cents: number }>
  | Readonly<{ kind: "shipped"; carrier: string }>;
`,
} as const;

// ---------------------------------------------------------------------------
// The frozen Java contract (CT-2)
// ---------------------------------------------------------------------------

export const SOURCES_JAVA_CONTRACT_ID = "CT-2";
export const SOURCES_JAVA_TYPES_PATH = "src/main/java/com/acme/order/OrderContract.java";

/**
 * One top-level holder, `OrderContract`. Frozen ADTs: the records `Order`
 * and `Price`; the sealed interface `Shape` permitting `Circle`, `Square`,
 * `Triangle`, each itself a record. `PriceOrderFn` and `ParseOrderFn` are
 * the bindable functional interfaces.
 */
export const SOURCES_JAVA_TYPES_TEXT = `package com.acme.order;

/** Frozen CT-2 surface. */
public interface OrderContract {
    @FunctionalInterface
    interface PriceOrderFn {
        Price apply(Order order, int quantity);
    }

    @FunctionalInterface
    interface ParseOrderFn {
        Order parse(String raw);
    }

    record Order(String id, long unitCents) {}

    record Price(long cents) {}

    sealed interface Shape permits Circle, Square, Triangle {}

    record Circle(double radius) implements Shape {}

    record Square(double side) implements Shape {}

    record Triangle(double base, double height) implements Shape {}
}
`;

// ---------------------------------------------------------------------------
// Java production files
// ---------------------------------------------------------------------------

/** Bound: `priceOrder: PriceOrderFn`, `parseOrder: ParseOrderFn`. */
export const JAVA_PRICING_PATH = "src/main/java/com/acme/order/pricing/Pricing.java";
/** Unbound, in scope: only the ADT checks apply. */
export const JAVA_GEOMETRY_PATH = "src/main/java/com/acme/order/pricing/Geometry.java";

const JAVA_PRICING_HEAD = `package com.acme.order.pricing;

import com.acme.order.OrderContract.Order;
import com.acme.order.OrderContract.ParseOrderFn;
import com.acme.order.OrderContract.Price;
import com.acme.order.OrderContract.PriceOrderFn;

public final class Pricing {
    private Pricing() {}
`;

const JAVA_PRICE_ORDER = `
    public static final PriceOrderFn priceOrder = (order, quantity) -> {
        if (quantity <= 0) {
            throw new IllegalArgumentException("quantity must be positive");
        }
        return new Price(order.unitCents() * quantity);
    };
`;

const JAVA_PARSE_ORDER = `
    public static final ParseOrderFn parseOrder = raw -> {
        String[] parts = raw.split(":");
        return new Order(parts[0], Long.parseLong(parts[1]));
    };
`;

const JAVA_PRICE_ORDER_UNIMPLEMENTED = `
    public static final PriceOrderFn priceOrder = (p0, p1) -> {
        throw new UnsupportedOperationException("unimplemented: priceOrder");
    };
`;

const JAVA_CLASS_END = `}
`;

export const JAVA_PRICING = {
  /** Every bound member keeps its name and frozen-alias type; no marker. */
  conforming: JAVA_PRICING_HEAD + JAVA_PRICE_ORDER + JAVA_PARSE_ORDER + JAVA_CLASS_END,

  /** The aliases reached through the imported holder (`OrderContract.PriceOrderFn`). → no violation. */
  conformingQualified: `package com.acme.order.pricing;

import com.acme.order.OrderContract;

public final class Pricing {
    private Pricing() {}

    public static final OrderContract.PriceOrderFn priceOrder =
        (order, quantity) -> new OrderContract.Price(order.unitCents() * quantity);

    public static final OrderContract.ParseOrderFn parseOrder = raw -> new OrderContract.Order(raw, 0L);
}
`,

  /** `parseOrder` removed. → parseOrder deleted. */
  deleted: JAVA_PRICING_HEAD + JAVA_PRICE_ORDER + JAVA_CLASS_END,

  /** `priceOrder` now declared as `computePrice`, same type. → priceOrder renamed. */
  renamed: `${JAVA_PRICING_HEAD}
    public static final PriceOrderFn computePrice = (order, quantity) -> new Price(order.unitCents() * quantity);
${JAVA_PARSE_ORDER}${JAVA_CLASS_END}`,

  /** `priceOrder` typed by a JDK function type that still compiles. → priceOrder retyped. */
  retypedOtherType: `package com.acme.order.pricing;

import com.acme.order.OrderContract.Order;
import com.acme.order.OrderContract.ParseOrderFn;
import com.acme.order.OrderContract.Price;
import java.util.function.BiFunction;

public final class Pricing {
    private Pricing() {}

    public static final BiFunction<Order, Integer, Price> priceOrder =
        (order, quantity) -> new Price(order.unitCents() * quantity);
${JAVA_PARSE_ORDER}${JAVA_CLASS_END}`,

  /** `priceOrder` typed by a local interface of the same name, not the frozen one. → priceOrder retyped. */
  retypedLocalAlias: `package com.acme.order.pricing;

import com.acme.order.OrderContract.Order;
import com.acme.order.OrderContract.ParseOrderFn;
import com.acme.order.OrderContract.Price;

public final class Pricing {
    private Pricing() {}

    @FunctionalInterface
    interface PriceOrderFn {
        Price apply(Order order, int quantity);
    }

    public static final PriceOrderFn priceOrder = (order, quantity) -> new Price(order.unitCents() * quantity);
${JAVA_PARSE_ORDER}${JAVA_CLASS_END}`,

  /** `priceOrder`'s lambda still holds its exact marker. → priceOrder still unimplemented. */
  stillUnimplemented: JAVA_PRICING_HEAD + JAVA_PRICE_ORDER_UNIMPLEMENTED + JAVA_PARSE_ORDER + JAVA_CLASS_END,

  /** Legitimate throws, one of them only resembling the marker. → no violation. */
  otherThrows: `${JAVA_PRICING_HEAD}
    public static final PriceOrderFn priceOrder = (order, quantity) -> {
        if (quantity <= 0) {
            throw new IllegalArgumentException("quantity must be positive");
        }
        if (quantity > 10_000) {
            throw new UnsupportedOperationException("unimplemented: priceOrder for bulk orders");
        }
        return new Price(order.unitCents() * quantity);
    };

    public static final ParseOrderFn parseOrder = raw -> {
        String[] parts = raw.split(":");
        if (parts.length != 2) {
            throw new IllegalArgumentException("not an order: " + raw);
        }
        return new Order(parts[0], Long.parseLong(parts[1]));
    };
${JAVA_CLASS_END}`,

  /** Internal helpers and extra members beside the bound ones. → no violation. */
  withExtras: `${JAVA_PRICING_HEAD}
    private static final double TAX_RATE = 0.25;

    private record Quote(Price price, String label) {}
${JAVA_PRICE_ORDER}
    public static final PriceOrderFn priceOrderWithTax = (order, quantity) -> withTax(priceOrder.apply(order, quantity));
${JAVA_PARSE_ORDER}
    public static String formatPrice(Price price) {
        return String.format("%.2f", price.cents() / 100.0);
    }

    static Quote quote(Order order, int quantity) {
        Price price = priceOrder.apply(order, quantity);
        return new Quote(price, formatPrice(price));
    }

    private static Price withTax(Price price) {
        return new Price(Math.round(price.cents() * (1 + TAX_RATE)));
    }
${JAVA_CLASS_END}`,

  /** Two seeded defects in one file. → priceOrder still unimplemented, parseOrder retyped. */
  severalViolations: `package com.acme.order.pricing;

import com.acme.order.OrderContract.Order;
import com.acme.order.OrderContract.PriceOrderFn;
import java.util.function.Function;

public final class Pricing {
    private Pricing() {}
${JAVA_PRICE_ORDER_UNIMPLEMENTED}
    public static final Function<String, Order> parseOrder = raw -> new Order(raw, 0L);
${JAVA_CLASS_END}`,
} as const;

const JAVA_GEOMETRY_HEAD = `package com.acme.order.pricing;

public final class Geometry {
    private Geometry() {}
`;

export const JAVA_GEOMETRY = {
  /**
   * Imports the frozen ADTs, pattern-matches on them, constructs their
   * variants, and declares a local sealed view-model hierarchy whose variant
   * names are its own; a local record named after a TypeScript ADT (other
   * language). → no violation.
   */
  conforming: `package com.acme.order.pricing;

import com.acme.order.OrderContract.Circle;
import com.acme.order.OrderContract.Shape;
import com.acme.order.OrderContract.Square;
import com.acme.order.OrderContract.Triangle;

public final class Geometry {
    private Geometry() {}

    public static double area(Shape shape) {
        return switch (shape) {
            case Circle c -> Math.PI * c.radius() * c.radius();
            case Square s -> s.side() * s.side();
            case Triangle t -> t.base() * t.height() / 2;
        };
    }

    public static Shape unitCircle() {
        return new Circle(1.0);
    }

    sealed interface Label permits Plain, Bold {}

    record Plain(String text) implements Label {}

    record Bold(String text) implements Label {}

    record OrderEvent(String id) {}
}
`,

  /** A local interface named as the frozen sealed interface. → Shape shadows frozen ADT. */
  shadowsSealedInterface: `${JAVA_GEOMETRY_HEAD}
    interface Shape {
        double area();
    }
${JAVA_CLASS_END}`,

  /** A local record named as a frozen record. → Order shadows frozen ADT. */
  shadowsRecord: `${JAVA_GEOMETRY_HEAD}
    record Order(String id) {}
${JAVA_CLASS_END}`,

  /** A local class named as a frozen record. → Price shadows frozen ADT. */
  shadowsRecordAsClass: `${JAVA_GEOMETRY_HEAD}
    static final class Price {
        final long cents = 0L;
    }
${JAVA_CLASS_END}`,

  /** A local record named as one frozen variant: the single shared name trips only the same-name rule. → Circle shadows frozen ADT. */
  shadowsVariant: `${JAVA_GEOMETRY_HEAD}
    record Circle(double radius) {}
${JAVA_CLASS_END}`,

  /**
   * A local sealed interface whose explicit `permits` re-lists two frozen
   * variants, declared locally. → Shape re-lists frozen variants; Circle and
   * Square each shadow frozen ADT.
   */
  relistsExplicitPermits: `${JAVA_GEOMETRY_HEAD}
    sealed interface Figure permits Circle, Square {}

    record Circle(double radius) implements Figure {}

    record Square(double side) implements Figure {}
${JAVA_CLASS_END}`,

  /**
   * A local sealed interface whose implicit (nested) permitted subtypes
   * re-list every frozen variant. → Shape re-lists frozen variants; Circle,
   * Square and Triangle each shadow frozen ADT.
   */
  relistsImplicitPermits: `${JAVA_GEOMETRY_HEAD}
    sealed interface Figure {
        record Circle(double radius) implements Figure {}

        record Square(double side) implements Figure {}

        record Triangle(double base, double height) implements Figure {}
    }
${JAVA_CLASS_END}`,

  /** A local sealed hierarchy sharing exactly one frozen variant name. → Circle shadows frozen ADT only. */
  singleSharedVariant: `${JAVA_GEOMETRY_HEAD}
    sealed interface Figure permits Circle, Hexagon {}

    record Circle(double radius) implements Figure {}

    record Hexagon(double side) implements Figure {}
${JAVA_CLASS_END}`,

  /** One ADT defect. → Order shadows frozen ADT. */
  severalViolations: `${JAVA_GEOMETRY_HEAD}
    record Order(String id) {}
${JAVA_CLASS_END}`,
} as const;
