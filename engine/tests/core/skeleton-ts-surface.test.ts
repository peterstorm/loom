/**
 * The third parse-only TypeScript compiler seam (AD-6): declaration surfaces of
 * frozen types files and implementation files, and the specifier style the
 * frozen acceptance tests import a types file with. Unit tests over strings.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readTsImplementationSurface,
  readTsTypesSurface,
  typesImportSpecifier,
} from "../../src/core/skeleton/ts-surface";
import type {
  DeclaredAlias,
  FrozenAdt,
  SurfaceProblem,
  TsExportedBinding,
  TsImplementationSurface,
  TsTypesSurface,
} from "../../src/core/skeleton/types";
import type { DomainResult } from "../../src/core/orchestration-contract";

const REPO_ROOT = resolve(__dirname, "../../..");
const TYPES = "src/order/order-contract.ts";
const IMPL = "src/order/pricing.ts";

const unwrap = <T>(result: DomainResult<T, SurfaceProblem>): T => {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.error)}`);
  return result.value;
};

const typesOf = (text: string, path = TYPES): TsTypesSurface => unwrap(readTsTypesSurface(path, text));
const implOf = (text: string, path = IMPL): TsImplementationSurface => unwrap(readTsImplementationSurface(path, text));
const aliasNamed = (surface: TsTypesSurface, name: string): DeclaredAlias | undefined =>
  surface.aliases.find((alias) => alias.name === name);
const exportNamed = (surface: TsImplementationSurface, name: string): TsExportedBinding | undefined =>
  surface.exports.find((binding) => binding.name === name);

// The CT-1 acceptance fixture's frozen types file, verbatim.
const ORDER_CONTRACT = `export type Order = Readonly<{ id: string; lines: readonly string[] }>;
export type Price = Readonly<{ cents: number }>;
export type OrderId = string & { readonly __brand: "OrderId" };
export type OrderState =
  | Readonly<{ status: "draft" }>
  | Readonly<{ status: "paid"; at: string }>;

export type ParseOrderFn = (raw: string) => Order;
export type PriceOrderFn = (order: Order, quantity: number) => Price;
export type ShipOrderFn = (order: Order) => void;
export type IdentityFn = <T>(value: T) => T;
export type Mapper<T> = (value: T) => T;
`;

describe("readTsTypesSurface: aliases", () => {
  it("reads every exported alias in source order, with function shape, arity and generic-ness", () => {
    const surface = typesOf(ORDER_CONTRACT);
    expect(surface.language).toBe("typescript");
    expect(surface.path).toBe(TYPES);
    expect(surface.aliases).toEqual([
      { name: "Order", shape: { kind: "not-a-function" } },
      { name: "Price", shape: { kind: "not-a-function" } },
      { name: "OrderId", shape: { kind: "not-a-function" } },
      { name: "OrderState", shape: { kind: "not-a-function" } },
      { name: "ParseOrderFn", shape: { kind: "function", generic: false, parameterCount: 1 } },
      { name: "PriceOrderFn", shape: { kind: "function", generic: false, parameterCount: 2 } },
      { name: "ShipOrderFn", shape: { kind: "function", generic: false, parameterCount: 1 } },
      { name: "IdentityFn", shape: { kind: "function", generic: true, parameterCount: 1 } },
      { name: "Mapper", shape: { kind: "function", generic: true, parameterCount: 1 } },
    ]);
  });

  it("reads a parenthesized function type as a function, and a zero-parameter one with arity 0", () => {
    const surface = typesOf("export type NowFn = (() => number);\nexport type Run = () => void;\n");
    expect(aliasNamed(surface, "NowFn")?.shape).toEqual({ kind: "function", generic: false, parameterCount: 0 });
    expect(aliasNamed(surface, "Run")?.shape).toEqual({ kind: "function", generic: false, parameterCount: 0 });
  });

  it("reads a union, an object, a Readonly-wrapped function, a constructor type and an interface as not-a-function", () => {
    const surface = typesOf([
      "export type Maybe = ((x: number) => void) | null;",
      "export type Port = { run: (x: number) => void };",
      "export type Frozen = Readonly<(x: number) => void>;",
      "export type Ctor = new (x: number) => object;",
      "export interface Callable { (x: number): void }",
      "",
    ].join("\n"));
    for (const name of ["Maybe", "Port", "Frozen", "Ctor", "Callable"]) {
      expect(aliasNamed(surface, name)?.shape, name).toEqual({ kind: "not-a-function" });
    }
  });

  it("lists only exported declarations, including names exported through a local export list", () => {
    const surface = typesOf([
      "type Hidden = (x: number) => void;",
      "type Local = (x: string, y: string) => string;",
      "interface Shape { area: number }",
      "export type { Local as Joined, Shape };",
      "",
    ].join("\n"));
    expect(surface.aliases).toEqual([
      { name: "Joined", shape: { kind: "function", generic: false, parameterCount: 2 } },
      { name: "Shape", shape: { kind: "not-a-function" } },
    ]);
  });

  it("refuses text the parser reports syntax errors in, naming the path", () => {
    const result = readTsTypesSurface(TYPES, "export type Broken = (x: number => ;\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unparseable");
    expect(result.error.path).toBe(TYPES);
    expect(result.error.detail).toMatch(/^1:\d+ /);
  });
});

describe("readTsTypesSurface: frozen ADTs", () => {
  it("reads the CT-1 fixture's brand and inline discriminated union", () => {
    expect(typesOf(ORDER_CONTRACT).adts).toEqual([
      { kind: "brand", name: "OrderId" },
      { kind: "discriminated-union", name: "OrderState", discriminant: "status", tags: ["draft", "paid"], variants: [] },
    ]);
  });

  it("names the variants of a union of local named types, type aliases and interfaces alike", () => {
    const surface = typesOf([
      "export type Draft = Readonly<{ kind: \"draft\" }>;",
      "export interface Paid { readonly kind: \"paid\"; at: string }",
      "type Cancelled = { kind: 'cancelled' } & { reason: string };",
      "export type OrderStatus = Draft | Paid | Cancelled;",
      "",
    ].join("\n"));
    expect(surface.adts).toEqual([
      { kind: "discriminated-union", name: "OrderStatus", discriminant: "kind", tags: ["draft", "paid", "cancelled"], variants: ["Draft", "Paid", "Cancelled"] },
    ]);
  });

  it("prefers the key whose tags are distinct when several keys are literal in every member", () => {
    const surface = typesOf([
      "export type Event =",
      "  | { version: \"v1\"; type: \"created\" }",
      "  | { version: \"v1\"; type: \"deleted\" };",
      "",
    ].join("\n"));
    expect(surface.adts).toEqual([
      { kind: "discriminated-union", name: "Event", discriminant: "type", tags: ["created", "deleted"], variants: [] },
    ]);
  });

  it("reads no ADT from a string-literal union, an undiscriminated object union, or a union with an unresolvable member", () => {
    const surface = typesOf([
      "import type { Remote } from \"./remote\";",
      "export type Colour = \"red\" | \"green\";",
      "export type Loose = { a: string } | { b: string };",
      "export type Mixed = { kind: \"a\" } | Remote;",
      "export type Single = { kind: \"only\" };",
      "",
    ].join("\n"));
    expect(surface.adts).toEqual([]);
  });

  it("reads a unique-symbol brand and an `__brand` brand, but not a plain intersection", () => {
    const surface = typesOf([
      "declare const IDENTIFIER: unique symbol;",
      "export type Identifier = string & Readonly<{ [IDENTIFIER]: true }>;",
      "export type Cents = number & { readonly __brand: \"Cents\" };",
      "export type Named = { name: string } & { age: number };",
      "",
    ].join("\n"));
    expect(surface.adts).toEqual([
      { kind: "brand", name: "Identifier" },
      { kind: "brand", name: "Cents" },
    ]);
  });

  it("reads the G2 skeleton types file itself: function aliases and a discriminated union", () => {
    const path = "engine/src/core/skeleton/types.ts";
    const surface = typesOf(readFileSync(resolve(REPO_ROOT, path), "utf-8"), path);
    expect(aliasNamed(surface, "ParseIdentifierFn")?.shape).toEqual({ kind: "function", generic: false, parameterCount: 1 });
    expect(aliasNamed(surface, "ResolveBindingsFn")?.shape).toEqual({ kind: "function", generic: false, parameterCount: 2 });
    expect(aliasNamed(surface, "BindingTaskView")?.shape).toEqual({ kind: "not-a-function" });
    const problems = surface.adts.find((adt): adt is Extract<FrozenAdt, { kind: "discriminated-union" }> =>
      adt.kind === "discriminated-union" && adt.name === "BindingProblem");
    expect(problems?.discriminant).toBe("kind");
    expect(problems?.tags).toContain("unsafe-path");
    expect(problems?.tags).toContain("name-collides-with-alias");
    expect(problems?.tags).toContain("alias-collides-with-class");
    expect(problems?.tags).toHaveLength(14);
  });

  it("reads the persisted leaf: the Identifier and ContractId brands and the outcome union", () => {
    const path = "engine/src/core/skeleton/persisted.ts";
    const surface = typesOf(readFileSync(resolve(REPO_ROOT, path), "utf-8"), path);
    expect(surface.adts).toContainEqual({ kind: "brand", name: "Identifier" });
    expect(surface.adts).toContainEqual({ kind: "brand", name: "ContractId" });
    const outcomes = surface.adts.find((adt): adt is Extract<FrozenAdt, { kind: "discriminated-union" }> =>
      adt.kind === "discriminated-union" && adt.name === "SkeletonOutcome");
    expect(outcomes?.tags).toHaveLength(5);
  });
});

describe("readTsImplementationSurface: exported bindings", () => {
  it("reads a skeleton's bound export: annotation, its import source and the marker literal", () => {
    const surface = implOf([
      "import type { PriceOrderFn } from \"./order-contract\";",
      "",
      "export const priceOrder: PriceOrderFn = () => {",
      "  throw new Error(\"unimplemented: priceOrder\");",
      "};",
      "",
    ].join("\n"));
    expect(surface).toEqual({
      language: "typescript",
      path: IMPL,
      exports: [{
        name: "priceOrder",
        declaration: "const",
        annotation: "PriceOrderFn",
        annotationSource: "./order-contract",
        initializerStrings: ["unimplemented: priceOrder"],
      }],
      localDeclarations: [],
      localUnions: [],
    });
  });

  it("reads let, var, function, class, enum, type and destructured exports with their declaration kind", () => {
    const surface = implOf([
      "export let counter = 0;",
      "export var legacy = 'old';",
      "export function helper(): string { return \"from body\"; }",
      "export class Engine { label = `no substitution`; }",
      "export enum Mode { On = \"on\" }",
      "export type Alias = string;",
      "export interface Shape { area: number }",
      "export const { left, right } = { left: \"l\", right: \"r\" };",
      "",
    ].join("\n"));
    expect(surface.exports.map(({ name, declaration }) => [name, declaration])).toEqual([
      ["counter", "let"],
      ["legacy", "var"],
      ["helper", "function"],
      ["Engine", "class"],
      ["Mode", "other"],
      ["Alias", "other"],
      ["Shape", "other"],
      ["left", "const"],
      ["right", "const"],
    ]);
    expect(exportNamed(surface, "legacy")?.initializerStrings).toEqual(["old"]);
    expect(exportNamed(surface, "helper")?.initializerStrings).toEqual(["from body"]);
    expect(exportNamed(surface, "Engine")?.initializerStrings).toEqual(["no substitution"]);
    expect(exportNamed(surface, "left")?.initializerStrings).toEqual(["l", "r"]);
  });

  it("reads an annotation only when it is a bare identifier, and its source only when it is imported", () => {
    const surface = implOf([
      "import type * as contract from \"./order-contract\";",
      "import { type PriceOrderFn as Pricing } from \"./order-contract.js\";",
      "import Default from \"./default\";",
      "type LocalFn = () => void;",
      "export const renamedImport: Pricing = () => { throw new Error(\"x\"); };",
      "export const defaultImport: Default = () => undefined;",
      "export const local: LocalFn = () => undefined;",
      "export const qualified: contract.PriceOrderFn = () => { throw new Error(\"y\"); };",
      "export const inline: (x: number) => void = () => undefined;",
      "export const generic: Array<string> = [];",
      "export const bare = () => undefined;",
      "",
    ].join("\n"));
    const pick = (name: string) => {
      const binding = exportNamed(surface, name);
      return [binding?.annotation, binding?.annotationSource];
    };
    expect(pick("renamedImport")).toEqual(["Pricing", "./order-contract.js"]);
    expect(pick("defaultImport")).toEqual(["Default", "./default"]);
    expect(pick("local")).toEqual(["LocalFn", null]);
    expect(pick("qualified")).toEqual([null, null]);
    expect(pick("inline")).toEqual([null, null]);
    expect(pick("generic")).toEqual([null, null]);
    expect(pick("bare")).toEqual([null, null]);
  });

  it("resolves a local export list to the local declaration, and marks imported or forwarded names as re-exports", () => {
    const surface = implOf([
      "import type { PriceOrderFn } from \"./order-contract\";",
      "import { shipOrder } from \"./shipping\";",
      "const priceOrder: PriceOrderFn = () => { throw new Error(\"unimplemented: priceOrder\"); };",
      "function parse(): void {}",
      "export { priceOrder, parse as parseOrder, shipOrder };",
      "export { cancelOrder as cancel } from \"./cancel\";",
      "export * as billing from \"./billing\";",
      "export * from \"./everything\";",
      "",
    ].join("\n"));
    expect(surface.exports).toEqual([
      { name: "priceOrder", declaration: "const", annotation: "PriceOrderFn", annotationSource: "./order-contract", initializerStrings: ["unimplemented: priceOrder"] },
      { name: "parseOrder", declaration: "function", annotation: null, annotationSource: null, initializerStrings: [] },
      { name: "shipOrder", declaration: "re-export", annotation: null, annotationSource: null, initializerStrings: [] },
      { name: "cancel", declaration: "re-export", annotation: null, annotationSource: null, initializerStrings: [] },
      { name: "billing", declaration: "re-export", annotation: null, annotationSource: null, initializerStrings: [] },
    ]);
  });

  it("reads a default export under the name `default`", () => {
    expect(implOf("export default function main(): string { return \"hello\"; }\n").exports).toEqual([
      { name: "default", declaration: "function", annotation: null, annotationSource: null, initializerStrings: ["hello"] },
    ]);
    expect(implOf("export default \"value\";\n").exports).toEqual([
      { name: "default", declaration: "other", annotation: null, annotationSource: null, initializerStrings: ["value"] },
    ]);
  });

  it("collects every string literal of the initializer, but never a template with substitutions", () => {
    const surface = implOf([
      "export const f = (name: string) => {",
      "  if (name === \"a\") throw new Error(`unimplemented: ${name}`);",
      "  return ['b', `c`];",
      "};",
      "",
    ].join("\n"));
    expect(exportNamed(surface, "f")?.initializerStrings).toEqual(["a", "b", "c"]);
  });

  it("refuses unparseable implementation text", () => {
    const result = readTsImplementationSurface(IMPL, "export const = ;\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: "unparseable", path: IMPL });
  });

  it("parses a .tsx implementation with JSX", () => {
    const surface = implOf("export const View = () => <div title=\"t\">hi</div>;\n", "src/view.tsx");
    expect(exportNamed(surface, "View")?.initializerStrings).toEqual(["t"]);
  });
});

describe("readTsImplementationSurface: local declarations and unions", () => {
  it("lists every local type, interface, class and enum in source order, nested ones included", () => {
    const surface = implOf([
      "export type OrderState = { status: \"draft\" };",
      "interface Draft { status: \"draft\" }",
      "class Paid {}",
      "const enum Mode { A }",
      "export function inner(): void { type Nested = number; }",
      "",
    ].join("\n"));
    expect(surface.localDeclarations).toEqual([
      { name: "OrderState", kind: "type" },
      { name: "Draft", kind: "interface" },
      { name: "Paid", kind: "class" },
      { name: "Mode", kind: "enum" },
      { name: "Nested", kind: "type" },
    ]);
  });

  it("reads the string-literal properties of each object-shaped union member, resolving local names but not imported ones", () => {
    const surface = implOf([
      "import type { Draft, Paid } from \"./order-contract\";",
      "type Shipped = Readonly<{ status: \"shipped\"; carrier: string }>;",
      "export type Relisted =",
      "  | Readonly<{ status: \"draft\" }>",
      "  | ({ status: 'paid'; via: \"card\" } & { at: string })",
      "  | Shipped;",
      "export type FromFrozen = Draft | Paid;",
      "type Plain = \"a\" | \"b\";",
      "",
    ].join("\n"));
    expect(surface.localUnions).toEqual([
      {
        name: "Relisted",
        objectMembers: [
          [{ key: "status", literal: "draft" }],
          [{ key: "status", literal: "paid" }, { key: "via", literal: "card" }],
          [{ key: "status", literal: "shipped" }],
        ],
      },
    ]);
  });
});

describe("typesImportSpecifier", () => {
  const ACCEPTANCE = "tests/order.acceptance.test.ts";

  it("reads the style of a relative import that names the types file", () => {
    expect(typesImportSpecifier(ACCEPTANCE, "import type { A } from \"../src/order/order-contract.js\";\n", TYPES)).toBe(".js");
    expect(typesImportSpecifier(ACCEPTANCE, "import type { A } from \"../src/order/order-contract\";\n", TYPES)).toBe("extensionless");
    expect(typesImportSpecifier(ACCEPTANCE, "import { type A } from \"../src/order/order-contract.ts\";\n", TYPES)).toBe(".ts");
  });

  it("is null when no import names the types file", () => {
    expect(typesImportSpecifier(ACCEPTANCE, "import { describe } from \"vitest\";\n", TYPES)).toBeNull();
    expect(typesImportSpecifier(ACCEPTANCE, "import { x } from \"./order-contract\";\n", TYPES)).toBeNull();
    expect(typesImportSpecifier(ACCEPTANCE, "// import { A } from \"../src/order/order-contract.js\";\nconst s = \"../src/order/order-contract\";\n", TYPES)).toBeNull();
    expect(typesImportSpecifier(ACCEPTANCE, "import { A } from \"src/order/order-contract\";\n", TYPES)).toBeNull();
  });

  it("copies the first import, in declaration order, that names the types file", () => {
    const text = [
      "import { describe } from \"vitest\";",
      "import { helper } from \"./helper.js\";",
      "import type { A } from \"../src/order/order-contract.ts\";",
      "import type { B } from \"../src/order/order-contract.js\";",
      "",
    ].join("\n");
    expect(typesImportSpecifier(ACCEPTANCE, text, TYPES)).toBe(".ts");
  });

  it("reads re-exports, require and dynamic import, and collapses `.` and `..` segments", () => {
    expect(typesImportSpecifier(ACCEPTANCE, "export type { A } from \"../src/order/./order-contract\";\n", TYPES)).toBe("extensionless");
    expect(typesImportSpecifier(ACCEPTANCE, "const c = require(\"../src/x/../order/order-contract.js\");\n", TYPES)).toBe(".js");
    expect(typesImportSpecifier(ACCEPTANCE, "const c = await import(\"../src/order/order-contract.ts\");\n", TYPES)).toBe(".ts");
  });

  it("maps the module extensions: .tsx and .mts types files", () => {
    expect(typesImportSpecifier(ACCEPTANCE, "import { A } from \"../src/ui/contract.js\";\n", "src/ui/contract.tsx")).toBe(".js");
    expect(typesImportSpecifier(ACCEPTANCE, "import { A } from \"../src/ui/contract.tsx\";\n", "src/ui/contract.tsx")).toBe(".ts");
    expect(typesImportSpecifier(ACCEPTANCE, "import { A } from \"../src/esm/contract.mjs\";\n", "src/esm/contract.mts")).toBe(".js");
    expect(typesImportSpecifier(ACCEPTANCE, "import { A } from \"../src/esm/contract.mts\";\n", "src/esm/contract.mts")).toBe(".ts");
  });

  it("reads a directory import of an index types file as extensionless", () => {
    expect(typesImportSpecifier(ACCEPTANCE, "import type { A } from \"../src/order\";\n", "src/order/index.ts")).toBe("extensionless");
    expect(typesImportSpecifier(ACCEPTANCE, "import type { A } from \"../src/order/index.js\";\n", "src/order/index.ts")).toBe(".js");
  });
});
