/**
 * Stage-two resolution (FR-003, FR-004): export bindings resolved against a
 * frozen, language-tagged surface read from source text. Every refusal names
 * the alias, the binding file and the types file; every problem across every
 * binding is listed; a resolved export carries the arity the frozen surface
 * declares and nothing the plan says.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DomainResult } from "../../src/core/orchestration-contract";
import { parseIdentifier } from "../../src/core/skeleton/bindings";
import { readJavaTypesSurface } from "../../src/core/skeleton/java-surface";
import { resolveBindings } from "../../src/core/skeleton/resolve";
import { readTsTypesSurface } from "../../src/core/skeleton/ts-surface";
import type {
  ExportBinding,
  Identifier,
  JavaTypesSurface,
  ResolutionProblem,
  TsTypesSurface,
} from "../../src/core/skeleton/types";

const TS_TYPES = "src/order/order-contract.ts";
const JAVA_TYPES = "src/main/java/com/acme/order/OrderContract.java";

const TS_TYPES_TEXT = `export type Order = Readonly<{ id: string }>;
export type Price = Readonly<{ cents: number }>;
export interface Ledger { post(order: Order): void }
export interface Callable { (order: Order): Price }
export type ParseOrderFn = (raw: string) => Order;
export type PriceOrderFn = (order: Order, quantity: number) => Price;
export type NowFn = () => number;
export type ShipOrderFn = (order: Order) => void;
export type IdentityFn = <T>(value: T) => T;
export type Mapper<T> = (value: T) => T;
`;

const JAVA_TYPES_TEXT = `package com.acme.order;

public interface OrderContract {
    @FunctionalInterface
    interface PriceOrderFn {
        Price apply(Order order, int quantity);
    }

    interface ParseOrderFn {
        Order parse(String raw);
    }

    interface NowFn {
        long now();
    }

    interface Ledger {
        void post(Order order);
        void reverse(Order order);
    }

    interface MapFn<T> {
        T apply(T value);
    }

    record Order(String id) {}

    record Price(long cents) {}
}
`;

const unwrap = <T, E>(result: DomainResult<T, E>): T => {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.error)}`);
  return result.value;
};

const identifier = (raw: string): Identifier => unwrap(parseIdentifier(raw));

const binding = (path: string, contract: string, ...exports: readonly (readonly [string, string])[]): ExportBinding => {
  const [first, ...rest] = exports.map(([name, alias]) => ({ name: identifier(name), alias: identifier(alias) }));
  if (first === undefined) throw new Error("fixture binding needs at least one export");
  return { path, contract, exports: [first, ...rest] };
};

const tsSurface = (): TsTypesSurface => unwrap(readTsTypesSurface(TS_TYPES, TS_TYPES_TEXT));
const javaSurface = (): JavaTypesSurface => unwrap(readJavaTypesSurface(JAVA_TYPES, JAVA_TYPES_TEXT));

const problemsOf = (result: ReturnType<typeof resolveBindings>): readonly ResolutionProblem[] => {
  if (result.ok) throw new Error(`resolved unexpectedly: ${JSON.stringify(result.value)}`);
  return result.error;
};

describe("resolveBindings — TypeScript surface", () => {
  it("FR-003: an alias the types file does not declare is refused as missing-alias, naming alias, binding file and types file", () => {
    expect(problemsOf(resolveBindings(tsSurface(), [binding("src/order/pricing.ts", "CT-1", ["refund", "RefundFn"])]))).toEqual([
      { kind: "missing-alias", alias: "RefundFn", path: "src/order/pricing.ts", typesFile: TS_TYPES },
    ]);
  });

  it("FR-003: an object alias, an interface and a callable interface are each not-a-function", () => {
    const path = "src/order/pricing.ts";
    expect(problemsOf(resolveBindings(tsSurface(), [
      binding(path, "CT-1", ["order", "Order"], ["ledger", "Ledger"], ["call", "Callable"]),
    ]))).toEqual([
      { kind: "not-a-function", alias: "Order", path, typesFile: TS_TYPES },
      { kind: "not-a-function", alias: "Ledger", path, typesFile: TS_TYPES },
      { kind: "not-a-function", alias: "Callable", path, typesFile: TS_TYPES },
    ]);
  });

  it("FR-003: a function type with its own or its alias's type parameters is a generic-alias", () => {
    const path = "src/order/pricing.ts";
    expect(problemsOf(resolveBindings(tsSurface(), [binding(path, "CT-1", ["identity", "IdentityFn"], ["map", "Mapper"])]))).toEqual([
      { kind: "generic-alias", alias: "IdentityFn", path, typesFile: TS_TYPES },
      { kind: "generic-alias", alias: "Mapper", path, typesFile: TS_TYPES },
    ]);
  });

  it("FR-003: every problem of every binding is listed, in plan order, and one resolvable binding does not hide them", () => {
    const result = resolveBindings(tsSurface(), [
      binding("src/order/a.ts", "CT-1", ["priceOrder", "PriceOrderFn"]),
      binding("src/order/b.ts", "CT-1", ["refund", "RefundFn"], ["parseOrder", "ParseOrderFn"], ["order", "Order"]),
      binding("src/order/c.ts", "CT-1", ["identity", "IdentityFn"]),
    ]);
    expect(problemsOf(result).map(({ kind }) => kind)).toEqual(["missing-alias", "not-a-function", "generic-alias"]);
  });

  it("FR-003: two exports of one file bound to the same refused alias report it once", () => {
    const path = "src/order/pricing.ts";
    expect(problemsOf(resolveBindings(tsSurface(), [binding(path, "CT-1", ["a", "RefundFn"], ["b", "RefundFn"])]))).toEqual([
      { kind: "missing-alias", alias: "RefundFn", path, typesFile: TS_TYPES },
    ]);
  });

  it("FR-004: resolved exports carry the arity the frozen types file declares, in plan order", () => {
    expect(resolveBindings(tsSurface(), [
      binding("src/order/pricing.ts", "CT-1", ["priceOrder", "PriceOrderFn"], ["now", "NowFn"]),
      binding("src/order/shipping.ts", "CT-1", ["shipOrder", "ShipOrderFn"]),
    ])).toEqual({
      ok: true,
      value: [
        {
          path: "src/order/pricing.ts",
          contract: "CT-1",
          exports: [
            { name: "priceOrder", alias: "PriceOrderFn", parameterCount: 2 },
            { name: "now", alias: "NowFn", parameterCount: 0 },
          ],
        },
        { path: "src/order/shipping.ts", contract: "CT-1", exports: [{ name: "shipOrder", alias: "ShipOrderFn", parameterCount: 1 }] },
      ],
    });
  });

  it("FR-004: the signature is the frozen file's — re-freezing an alias with another arity changes only the resolved arity", () => {
    const refrozen = unwrap(readTsTypesSurface(TS_TYPES, "export type PriceOrderFn = (a: number, b: number, c: number) => number;\n"));
    const bound = binding("src/order/pricing.ts", "CT-1", ["priceOrder", "PriceOrderFn"]);
    expect(unwrap(resolveBindings(refrozen, [bound]))[0]?.exports).toEqual([{ name: "priceOrder", alias: "PriceOrderFn", parameterCount: 3 }]);
  });

  it("no bindings resolve to no resolved bindings", () => {
    expect(resolveBindings(tsSurface(), [])).toEqual({ ok: true, value: [] });
  });
});

describe("resolveBindings — Java surface", () => {
  const path = "src/main/java/com/acme/order/pricing/Pricing.java";

  it("FR-003: missing, multi-method, record and generic Java aliases are each refused, naming alias, binding file and types file", () => {
    expect(problemsOf(resolveBindings(javaSurface(), [
      binding(path, "CT-2", ["refund", "RefundFn"], ["ledger", "Ledger"], ["order", "Order"], ["map", "MapFn"]),
    ]))).toEqual([
      { kind: "missing-alias", alias: "RefundFn", path, typesFile: JAVA_TYPES },
      { kind: "not-a-function", alias: "Ledger", path, typesFile: JAVA_TYPES },
      { kind: "not-a-function", alias: "Order", path, typesFile: JAVA_TYPES },
      { kind: "generic-alias", alias: "MapFn", path, typesFile: JAVA_TYPES },
    ]);
  });

  it("FR-003: single-abstract-method interfaces resolve with their method's arity, @FunctionalInterface or not", () => {
    expect(unwrap(resolveBindings(javaSurface(), [
      binding(path, "CT-2", ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"], ["now", "NowFn"]),
    ]))).toEqual([{
      path,
      contract: "CT-2",
      exports: [
        { name: "priceOrder", alias: "PriceOrderFn", parameterCount: 2 },
        { name: "parseOrder", alias: "ParseOrderFn", parameterCount: 1 },
        { name: "now", alias: "NowFn", parameterCount: 0 },
      ],
    }]);
  });
});

describe("resolveBindings — laws", () => {
  const RESOLVABLE = ["ParseOrderFn", "PriceOrderFn", "NowFn", "ShipOrderFn"] as const;
  const REFUSED = ["Order", "Ledger", "IdentityFn", "Mapper", "RefundFn", "Missing"] as const;

  const exportsArb = (aliases: readonly string[]) =>
    fc.uniqueArray(fc.tuple(fc.stringMatching(/^[a-z][A-Za-z0-9]{0,8}$/), fc.constantFrom(...aliases)), {
      minLength: 1,
      maxLength: 6,
      selector: ([name]) => name,
    }).filter((exports) => exports.every(([name]) => parseIdentifier(name).ok));

  it("FR-003: bindings over declared function aliases resolve to exactly their names and aliases, in plan order", () => {
    fc.assert(fc.property(exportsArb(RESOLVABLE), (exports) => {
      const bound = binding("src/order/pricing.ts", "CT-1", ...exports);
      const [resolved] = unwrap(resolveBindings(tsSurface(), [bound]));
      expect(resolved?.exports.map(({ name, alias }) => [name, alias])).toEqual(exports);
    }));
  });

  it("FR-003: a binding refused anywhere never resolves, and every refused alias is named", () => {
    fc.assert(fc.property(exportsArb([...RESOLVABLE, ...REFUSED]).filter((exports) => exports.some(([, alias]) => (REFUSED as readonly string[]).includes(alias))), (exports) => {
      const problems = problemsOf(resolveBindings(tsSurface(), [binding("src/order/pricing.ts", "CT-1", ...exports)]));
      const refused = new Set(exports.map(([, alias]) => alias).filter((alias) => (REFUSED as readonly string[]).includes(alias)));
      expect(new Set(problems.map((problem) => ("alias" in problem ? problem.alias : null)))).toEqual(refused);
    }));
  });
});
