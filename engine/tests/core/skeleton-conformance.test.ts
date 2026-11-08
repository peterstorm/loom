/**
 * The completion conformance judge (AD-11), unit level: the signature rules
 * per bound export, the frozen-ADT rules per in-scope file, the diagnostic,
 * and the laws — additions never add a violation, and each frozen ADT binds
 * only files of its types file's language.
 *
 * The frozen CT-2 acceptance matrix covers the seeded fixture world; these
 * cases pin the edges it does not: how an annotation or a Java type token is
 * proven frozen (specifier styles, wildcard, static and holder imports, the
 * holder's own package, shadowing locals), shared aliases, missing contracts,
 * unreadable files, and the remedy's wording.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { judgeConformance, renderConformanceViolations } from "../../src/core/skeleton/conformance";
import { readJavaImplementationSurface, readJavaTypesSurface } from "../../src/core/skeleton/java-surface";
import { skeletonLanguageOf } from "../../src/core/skeleton/language";
import { readTsImplementationSurface, readTsTypesSurface } from "../../src/core/skeleton/ts-surface";
import type {
  ConformanceViolation,
  ContractConformance,
  ContractSurface,
  ExportBinding,
  ViolationReason,
} from "../../src/core/skeleton/types";
import type { NonEmpty } from "../../src/core/orchestration-contract";
import {
  SOURCES_JAVA_CONTRACT_ID,
  JAVA_GEOMETRY,
  JAVA_PRICING,
  SOURCES_JAVA_TYPES_PATH,
  SOURCES_JAVA_TYPES_TEXT,
  SOURCES_TS_CONTRACT_ID,
  TS_LEDGER,
  TS_PRICING,
  TS_REPLAY,
  SOURCES_TS_TYPES_PATH,
  SOURCES_TS_TYPES_TEXT,
} from "../fixtures/skeleton-sources";
import { binding, unwrap } from "../fixtures/skeleton-builders";

// ---------------------------------------------------------------------------
// Building inputs
// ---------------------------------------------------------------------------

const TS_SURFACE: ContractSurface = { contract: SOURCES_TS_CONTRACT_ID, surface: unwrap(readTsTypesSurface(SOURCES_TS_TYPES_PATH, SOURCES_TS_TYPES_TEXT)) };
const JAVA_SURFACE: ContractSurface = {
  contract: SOURCES_JAVA_CONTRACT_ID,
  surface: unwrap(readJavaTypesSurface(SOURCES_JAVA_TYPES_PATH, SOURCES_JAVA_TYPES_TEXT)),
};

const TS_PATH = "src/order/pricing.ts";
const TS_UNBOUND = "src/order/ledger.ts";
const JAVA_PATH = "src/main/java/com/acme/order/pricing/Pricing.java";
const JAVA_UNBOUND = "src/main/java/com/acme/order/pricing/Geometry.java";

const TS_BINDING = binding(TS_PATH, SOURCES_TS_CONTRACT_ID, ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]);
const JAVA_BINDING = binding(JAVA_PATH, SOURCES_JAVA_CONTRACT_ID, ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]);

const file = (path: string, text: string | null) => {
  const target = skeletonLanguageOf(path);
  if (target.kind !== "supported") throw new Error(`${path} is no target`);
  return { target, text };
};

type Judge = Readonly<{
  files: Readonly<Record<string, string | null>>;
  bindings?: readonly ExportBinding[];
  surfaces?: readonly ContractSurface[];
}>;

const judge = ({ files, bindings = [TS_BINDING, JAVA_BINDING], surfaces = [TS_SURFACE, JAVA_SURFACE] }: Judge): ContractConformance =>
  judgeConformance({ surfaces, bindings, files: Object.entries(files).map(([path, text]) => file(path, text)) });

type Row = Readonly<{ file: string; subject: string; reason: ViolationReason }>;

const rows = (conformance: ContractConformance): readonly Row[] => {
  if (conformance.kind !== "judged") throw new Error("the judge always judges");
  return [...conformance.violations].flatMap(([path, violations]) => violations.map(({ subject, reason }) => ({ file: path, subject, reason })));
};

const violationsAt = (conformance: ContractConformance, path: string): NonEmpty<ConformanceViolation> => {
  if (conformance.kind !== "judged") throw new Error("the judge always judges");
  const violations = conformance.violations.get(path);
  if (violations === undefined) throw new Error(`no violation at ${path}`);
  return violations;
};

const CLEAN: ContractConformance = { kind: "judged", violations: new Map() };

const TS_IMPORTS = `import type { Order, OrderId, ParseOrderFn, Price, PriceOrderFn } from "./order-contract";\n`;
const TS_PARSE = `export const parseOrder: ParseOrderFn = (raw) => ({ id: raw as OrderId, unitCents: 0 });\n`;
const TS_PRICE = `export const priceOrder: PriceOrderFn = (order, quantity) => ({ cents: order.unitCents * quantity });\n`;

const javaPricing = (head: string, body: string, pkg = "com.acme.order.pricing"): string =>
  `package ${pkg};\n\n${head}\npublic final class Pricing {\n    private Pricing() {}\n${body}}\n`;

const JAVA_PRICE = `    public static final PriceOrderFn priceOrder = (o, q) -> new Price(o.unitCents() * q);\n`;
const JAVA_PARSE = `    public static final ParseOrderFn parseOrder = raw -> new Order(raw, 0L);\n`;

// ---------------------------------------------------------------------------
// Signatures — TypeScript
// ---------------------------------------------------------------------------

describe("signature conformance — TypeScript", () => {
  it("AS-020: an export annotated with its frozen alias, no marker, conforms", () => {
    expect(judge({ files: { [TS_PATH]: TS_PRICING.conforming } })).toEqual(CLEAN);
  });

  it.each([
    { style: "extensionless", specifier: "./order-contract" },
    { style: ".js", specifier: "./order-contract.js" },
    { style: ".ts", specifier: "./order-contract.ts" },
    { style: "a parent-relative path", specifier: "../order/order-contract" },
  ])("AS-020: a frozen alias imported with the $style specifier proves the annotation", ({ specifier }) => {
    const text = `import type { Order, OrderId, ParseOrderFn, Price, PriceOrderFn } from "${specifier}";\n${TS_PRICE}${TS_PARSE}`;
    expect(judge({ files: { [TS_PATH]: text } })).toEqual(CLEAN);
  });

  it("AS-020: a bound export exported through a local export list keeps its annotation", () => {
    const text = `${TS_IMPORTS}const priceOrder: PriceOrderFn = (o, q) => ({ cents: o.unitCents * q });\n${TS_PARSE}export { priceOrder };\n`;
    expect(judge({ files: { [TS_PATH]: text } })).toEqual(CLEAN);
  });

  it("AS-021: a missing export is `deleted`, and the diagnostic names file, export and reason", () => {
    const conformance = judge({ files: { [TS_PATH]: TS_PRICING.deleted } });
    expect(rows(conformance)).toEqual([{ file: TS_PATH, subject: "parseOrder", reason: "deleted" }]);
    const diagnostic = renderConformanceViolations(TS_PATH, violationsAt(conformance, TS_PATH));
    expect(diagnostic).toContain(TS_PATH);
    expect(diagnostic).toContain("parseOrder");
    expect(diagnostic).toContain("deleted");
  });

  it("AS-022: the frozen annotation moved to another name is `renamed`", () => {
    expect(rows(judge({ files: { [TS_PATH]: TS_PRICING.renamed } }))).toEqual([
      { file: TS_PATH, subject: "priceOrder", reason: "renamed" },
    ]);
  });

  it("AS-022: an alias annotation moved onto another name, but not imported from the frozen file, is `deleted`, not `renamed`", () => {
    const text = `import type { ParseOrderFn, OrderId } from "./order-contract";\ntype PriceOrderFn = () => number;\nexport const computePrice: PriceOrderFn = () => 1;\n${TS_PARSE}`;
    expect(rows(judge({ files: { [TS_PATH]: text } }))).toEqual([{ file: TS_PATH, subject: "priceOrder", reason: "deleted" }]);
  });

  it("AS-022: another bound export sharing the alias never makes a deleted export `renamed`", () => {
    const shared = binding(TS_PATH, SOURCES_TS_CONTRACT_ID, ["priceOrder", "PriceOrderFn"], ["priceBulk", "PriceOrderFn"]);
    const text = `${TS_IMPORTS}export const priceBulk: PriceOrderFn = (o, q) => ({ cents: o.unitCents * q });\n`;
    expect(rows(judge({ files: { [TS_PATH]: text }, bindings: [shared] }))).toEqual([
      { file: TS_PATH, subject: "priceOrder", reason: "deleted" },
    ]);
  });

  it.each([
    { how: "annotation removed", text: TS_PRICING.retypedUnannotated },
    { how: "inline function type", text: TS_PRICING.retypedInlineType },
    { how: "local alias of the frozen name", text: TS_PRICING.retypedLocalAlias },
    { how: "function declaration", text: TS_PRICING.retypedFunctionDeclaration },
    { how: "`let` instead of `const`", text: `${TS_IMPORTS}export let priceOrder: PriceOrderFn = (o, q) => ({ cents: o.unitCents * q });\n${TS_PARSE}` },
    { how: "another frozen alias", text: `${TS_IMPORTS}export const priceOrder: ParseOrderFn = (raw) => ({ id: raw as OrderId, unitCents: 0 });\n${TS_PARSE}` },
    {
      how: "alias imported from another module",
      text: `import type { PriceOrderFn } from "./elsewhere";\nimport type { ParseOrderFn, OrderId } from "./order-contract";\nexport const priceOrder: PriceOrderFn = () => ({ cents: 0 });\n${TS_PARSE}`,
    },
    { how: "a class", text: `${TS_IMPORTS}export class priceOrder {}\n${TS_PARSE}` },
  ])("AS-023: $how is `retyped`", ({ text }) => {
    expect(rows(judge({ files: { [TS_PATH]: text } }))).toEqual([{ file: TS_PATH, subject: "priceOrder", reason: "retyped" }]);
  });

  it("AS-024: the exact marker left in the body is `still unimplemented`", () => {
    expect(rows(judge({ files: { [TS_PATH]: TS_PRICING.stillUnimplemented } }))).toEqual([
      { file: TS_PATH, subject: "priceOrder", reason: "still-unimplemented" },
    ]);
  });

  it("AS-024: a retyped export that still holds its marker reports both violations", () => {
    const text = `${TS_IMPORTS}export function priceOrder(): Price {\n  throw new Error("unimplemented: priceOrder");\n}\n${TS_PARSE}`;
    expect(rows(judge({ files: { [TS_PATH]: text } }))).toEqual([
      { file: TS_PATH, subject: "priceOrder", reason: "retyped" },
      { file: TS_PATH, subject: "priceOrder", reason: "still-unimplemented" },
    ]);
  });

  it.each([
    { what: "another export's marker", literal: "unimplemented: parseOrder" },
    { what: "a longer message", literal: "unimplemented: priceOrder for bulk orders" },
    { what: "a different case", literal: "Unimplemented: priceOrder" },
    { what: "no space", literal: "unimplemented:priceOrder" },
  ])("AS-025: $what in the body never trips the unimplemented check", ({ literal }) => {
    const text = `${TS_IMPORTS}export const priceOrder: PriceOrderFn = () => {\n  throw new Error("${literal}");\n};\n${TS_PARSE}`;
    expect(judge({ files: { [TS_PATH]: text } })).toEqual(CLEAN);
  });

  it("AS-025: the marker in a comment is no string literal and never trips the check", () => {
    const text = `${TS_IMPORTS}// was: throw new Error("unimplemented: priceOrder")\n${TS_PRICE}${TS_PARSE}`;
    expect(judge({ files: { [TS_PATH]: text } })).toEqual(CLEAN);
  });

  it("AS-026: helpers and extra exports, one annotated with a frozen alias, pass", () => {
    expect(judge({ files: { [TS_PATH]: TS_PRICING.withExtras } })).toEqual(CLEAN);
  });

  it("AS-027: a missing bound file reports every bound export as `deleted`, in binding order", () => {
    expect(rows(judge({ files: { [TS_PATH]: null } }))).toEqual([
      { file: TS_PATH, subject: "priceOrder", reason: "deleted" },
      { file: TS_PATH, subject: "parseOrder", reason: "deleted" },
    ]);
  });

  it("AS-027: a bound file that no longer parses proves none of its bound exports: each is `deleted`", () => {
    expect(rows(judge({ files: { [TS_PATH]: `${TS_PRICING.conforming}\nexport const = ;\n` } }))).toEqual([
      { file: TS_PATH, subject: "priceOrder", reason: "deleted" },
      { file: TS_PATH, subject: "parseOrder", reason: "deleted" },
    ]);
  });

  it("FR-013: a binding whose contract has no surface proves no annotation: present exports are `retyped`", () => {
    expect(rows(judge({ files: { [TS_PATH]: TS_PRICING.conforming }, surfaces: [JAVA_SURFACE] }))).toEqual([
      { file: TS_PATH, subject: "priceOrder", reason: "retyped" },
      { file: TS_PATH, subject: "parseOrder", reason: "retyped" },
    ]);
  });

  it("FR-013: a binding whose contract surface is of the other language proves no annotation", () => {
    const crossed = binding(TS_PATH, SOURCES_JAVA_CONTRACT_ID, ["priceOrder", "PriceOrderFn"]);
    expect(rows(judge({ files: { [TS_PATH]: TS_PRICING.conforming }, bindings: [crossed] }))).toEqual([
      { file: TS_PATH, subject: "priceOrder", reason: "retyped" },
    ]);
  });

  it("FR-013: a binding of a path outside the judged files is not judged", () => {
    expect(judge({ files: { [TS_UNBOUND]: TS_LEDGER.conforming } })).toEqual(CLEAN);
  });
});

// ---------------------------------------------------------------------------
// Signatures — Java
// ---------------------------------------------------------------------------

describe("signature conformance — Java", () => {
  const SIMPLE_IMPORTS = `import com.acme.order.OrderContract.Order;\nimport com.acme.order.OrderContract.ParseOrderFn;\nimport com.acme.order.OrderContract.Price;\nimport com.acme.order.OrderContract.PriceOrderFn;\n`;

  it.each([
    { how: "simple-name imports", text: JAVA_PRICING.conforming },
    { how: "the holder imported, members qualified", text: JAVA_PRICING.conformingQualified },
    {
      how: "a wildcard import of the holder's members",
      text: javaPricing("import com.acme.order.OrderContract.*;\n", JAVA_PRICE + JAVA_PARSE),
    },
    {
      how: "static imports of the members",
      text: javaPricing(
        "import static com.acme.order.OrderContract.PriceOrderFn;\nimport static com.acme.order.OrderContract.ParseOrderFn;\nimport com.acme.order.OrderContract.*;\n",
        JAVA_PRICE + JAVA_PARSE,
      ),
    },
    {
      how: "fully qualified types",
      text: javaPricing(
        "import com.acme.order.OrderContract.*;\n",
        "    public static final com.acme.order.OrderContract.PriceOrderFn priceOrder = (o, q) -> new Price(0L);\n    public static final com.acme.order.OrderContract.ParseOrderFn parseOrder = raw -> new Order(raw, 0L);\n",
      ),
    },
    {
      how: "the holder's own package, qualified without an import",
      text: javaPricing(
        "",
        "    static final OrderContract.PriceOrderFn priceOrder = (o, q) -> new OrderContract.Price(0L);\n    static final OrderContract.ParseOrderFn parseOrder = raw -> new OrderContract.Order(raw, 0L);\n",
        "com.acme.order",
      ),
    },
  ])("AS-020: a bound member typed through $how conforms", ({ text }) => {
    const path = text.startsWith("package com.acme.order;") ? "src/main/java/com/acme/order/Pricing.java" : JAVA_PATH;
    const bound = binding(path, SOURCES_JAVA_CONTRACT_ID, ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]);
    expect(judge({ files: { [path]: text }, bindings: [bound] })).toEqual(CLEAN);
  });

  it("AS-029: a deleted member is `deleted`", () => {
    expect(rows(judge({ files: { [JAVA_PATH]: JAVA_PRICING.deleted } }))).toEqual([
      { file: JAVA_PATH, subject: "parseOrder", reason: "deleted" },
    ]);
  });

  it("AS-029: a member with the frozen type under another name is `renamed`", () => {
    expect(rows(judge({ files: { [JAVA_PATH]: JAVA_PRICING.renamed } }))).toEqual([
      { file: JAVA_PATH, subject: "priceOrder", reason: "renamed" },
    ]);
  });

  it.each([
    { how: "a JDK function type", text: JAVA_PRICING.retypedOtherType },
    { how: "a local interface of the alias's name", text: JAVA_PRICING.retypedLocalAlias },
    { how: "a missing `static`", text: javaPricing(SIMPLE_IMPORTS, JAVA_PRICE.replace("static ", "") + JAVA_PARSE) },
    { how: "a missing `final`", text: javaPricing(SIMPLE_IMPORTS, JAVA_PRICE.replace("final ", "") + JAVA_PARSE) },
    {
      how: "the holder's simple name with no import outside its package",
      text: javaPricing(
        "import com.acme.order.OrderContract.Order;\nimport com.acme.order.OrderContract.Price;\nimport com.acme.order.OrderContract.ParseOrderFn;\n",
        "    public static final OrderContract.PriceOrderFn priceOrder = (o, q) -> new Price(0L);\n" + JAVA_PARSE,
      ),
    },
    {
      how: "an unimported simple name",
      text: javaPricing(
        "import com.acme.order.OrderContract.Order;\nimport com.acme.order.OrderContract.Price;\nimport com.acme.order.OrderContract.ParseOrderFn;\n",
        JAVA_PRICE + JAVA_PARSE,
      ),
    },
    {
      how: "an alias of the same name from another holder",
      text: javaPricing(
        "import com.acme.order.OrderContract.Order;\nimport com.acme.order.OrderContract.Price;\nimport com.acme.order.OrderContract.ParseOrderFn;\nimport com.acme.other.Contract.PriceOrderFn;\n",
        JAVA_PRICE + JAVA_PARSE,
      ),
    },
    {
      how: "a local type named as the holder shadowing the qualified name",
      text: javaPricing(
        "import com.acme.order.OrderContract;\nimport com.acme.order.OrderContract.Order;\nimport com.acme.order.OrderContract.ParseOrderFn;\n",
        "    interface OrderContract { interface PriceOrderFn { Object apply(Object o, int q); } }\n    public static final OrderContract.PriceOrderFn priceOrder = (o, q) -> null;\n" + JAVA_PARSE,
      ),
    },
  ])("AS-029: $how is `retyped`", ({ text }) => {
    expect(rows(judge({ files: { [JAVA_PATH]: text } }))).toEqual([{ file: JAVA_PATH, subject: "priceOrder", reason: "retyped" }]);
  });

  it("AS-029: the marker left in the lambda is `still unimplemented`", () => {
    expect(rows(judge({ files: { [JAVA_PATH]: JAVA_PRICING.stillUnimplemented } }))).toEqual([
      { file: JAVA_PATH, subject: "priceOrder", reason: "still-unimplemented" },
    ]);
  });

  it("AS-025: other throws, one resembling the marker, never trip the check in Java", () => {
    expect(judge({ files: { [JAVA_PATH]: JAVA_PRICING.otherThrows } })).toEqual(CLEAN);
  });

  it("AS-026: helpers and extra members pass in Java", () => {
    expect(judge({ files: { [JAVA_PATH]: JAVA_PRICING.withExtras } })).toEqual(CLEAN);
  });

  it("AS-027: a missing Java bound file reports every bound member as `deleted`", () => {
    expect(rows(judge({ files: { [JAVA_PATH]: null } }))).toEqual([
      { file: JAVA_PATH, subject: "priceOrder", reason: "deleted" },
      { file: JAVA_PATH, subject: "parseOrder", reason: "deleted" },
    ]);
  });

  it("AS-029: a Java violation has the TypeScript violation's shape", () => {
    const shape = (conformance: ContractConformance, path: string) =>
      violationsAt(conformance, path).map(({ subject, reason, remedy }) => ({ subject, reason, remedy }));
    expect(shape(judge({ files: { [JAVA_PATH]: JAVA_PRICING.renamed } }), JAVA_PATH)).toEqual(
      shape(judge({ files: { [TS_PATH]: TS_PRICING.renamed } }), TS_PATH),
    );
  });
});

// ---------------------------------------------------------------------------
// Frozen ADTs
// ---------------------------------------------------------------------------

describe("frozen ADT conformance", () => {
  it.each([
    { what: "type alias", text: TS_LEDGER.shadowsUnionAsType },
    { what: "interface", text: TS_LEDGER.shadowsUnionAsInterface },
    { what: "class", text: TS_LEDGER.shadowsUnionAsClass },
    { what: "enum", text: "export enum OrderEvent { Placed }\n" },
    { what: "nested class", text: "export const make = () => {\n  class OrderEvent {}\n  return new OrderEvent();\n};\n" },
  ])("AS-030: a local $what named `OrderEvent` shadows the frozen union", ({ text }) => {
    const conformance = judge({ files: { [TS_UNBOUND]: text } });
    expect(rows(conformance)).toEqual([{ file: TS_UNBOUND, subject: "OrderEvent", reason: "shadows-frozen-adt" }]);
    expect(renderConformanceViolations(TS_UNBOUND, violationsAt(conformance, TS_UNBOUND))).toContain("shadows frozen ADT");
  });

  it("AS-030: a local declaration named as a frozen ADT is reported once, however often it is declared", () => {
    const text = "export interface OrderEvent { readonly a: string }\nexport interface OrderEvent { readonly b: string }\n";
    expect(rows(judge({ files: { [TS_UNBOUND]: text } }))).toEqual([{ file: TS_UNBOUND, subject: "OrderEvent", reason: "shadows-frozen-adt" }]);
  });

  it("AS-030: a bound file is judged for ADTs too", () => {
    const text = `${TS_PRICING.conforming}\ntype OrderPlaced = Readonly<{ kind: "placed" }>;\n`;
    expect(rows(judge({ files: { [TS_PATH]: text } }))).toEqual([{ file: TS_PATH, subject: "OrderPlaced", reason: "shadows-frozen-adt" }]);
  });

  it("AS-030: plain object types of the types file are no ADT and may be named locally", () => {
    expect(judge({ files: { [TS_UNBOUND]: "export type Order = Readonly<{ id: string }>;\nexport type Price = number;\n" } })).toEqual(CLEAN);
  });

  it("AS-031: a differently named union re-listing every frozen tag re-lists the frozen union, naming both", () => {
    const conformance = judge({ files: { [TS_UNBOUND]: TS_LEDGER.relistsAllTags } });
    expect(rows(conformance)).toEqual([{ file: TS_UNBOUND, subject: "OrderEvent", reason: "re-lists-frozen-variants" }]);
    const [violation] = violationsAt(conformance, TS_UNBOUND);
    expect(violation.remedy).toContain("LedgerEntry");
    expect(violation.remedy).toContain("Extract<OrderEvent");
  });

  it("AS-031: members that are same-file references carrying the frozen tags re-list too", () => {
    const text = `type A = Readonly<{ kind: "placed" }>;\ninterface B { kind: "shipped" }\nexport type Local = A | B;\n`;
    expect(rows(judge({ files: { [TS_UNBOUND]: text } }))).toEqual([{ file: TS_UNBOUND, subject: "OrderEvent", reason: "re-lists-frozen-variants" }]);
  });

  it("AS-031: a local union both named as and re-listing the frozen union reports both rules", () => {
    const text = `export type OrderEvent =\n  | Readonly<{ kind: "placed" }>\n  | Readonly<{ kind: "paid" }>;\n`;
    expect(rows(judge({ files: { [TS_UNBOUND]: text } }))).toEqual([
      { file: TS_UNBOUND, subject: "OrderEvent", reason: "shadows-frozen-adt" },
      { file: TS_UNBOUND, subject: "OrderEvent", reason: "re-lists-frozen-variants" },
    ]);
  });

  it("AS-032: a local type named as the frozen brand shadows it", () => {
    expect(rows(judge({ files: { [TS_UNBOUND]: TS_LEDGER.shadowsBrand } }))).toEqual([
      { file: TS_UNBOUND, subject: "OrderId", reason: "shadows-frozen-adt" },
    ]);
  });

  it("AS-033: a local sealed interface explicitly permitting two frozen variants re-lists the frozen hierarchy", () => {
    const conformance = judge({ files: { [JAVA_UNBOUND]: JAVA_GEOMETRY.relistsExplicitPermits } });
    expect(rows(conformance)).toEqual([
      { file: JAVA_UNBOUND, subject: "Circle", reason: "shadows-frozen-adt" },
      { file: JAVA_UNBOUND, subject: "Square", reason: "shadows-frozen-adt" },
      { file: JAVA_UNBOUND, subject: "Shape", reason: "re-lists-frozen-variants" },
    ]);
  });

  it("AS-033: a sealed class permitting imported frozen variants by name re-lists them", () => {
    const text = `package com.acme.order.pricing;\n\nimport com.acme.order.OrderContract.Circle;\n\npublic final class Geometry {\n    sealed abstract static class Figure permits Hexagon, Pentagon {}\n    static final class Hexagon extends Figure {}\n    static final class Pentagon extends Figure {}\n    sealed interface Local permits Circle, Triangle {}\n}\n`;
    expect(rows(judge({ files: { [JAVA_UNBOUND]: text } }))).toEqual([{ file: JAVA_UNBOUND, subject: "Shape", reason: "re-lists-frozen-variants" }]);
  });

  it.each([
    { what: "an interface named as the sealed interface", text: JAVA_GEOMETRY.shadowsSealedInterface, subject: "Shape" },
    { what: "a record named as a record", text: JAVA_GEOMETRY.shadowsRecord, subject: "Order" },
    { what: "a class named as a record", text: JAVA_GEOMETRY.shadowsRecordAsClass, subject: "Price" },
    { what: "an enum named as a variant", text: `package com.acme.order.pricing;\n\npublic final class Geometry {\n    enum Square { ONE }\n}\n`, subject: "Square" },
  ])("AS-034: $what shadows a frozen ADT", ({ text, subject }) => {
    expect(rows(judge({ files: { [JAVA_UNBOUND]: text } }))).toEqual([{ file: JAVA_UNBOUND, subject, reason: "shadows-frozen-adt" }]);
  });

  it("AS-034: a top-level file named as a frozen record shadows it", () => {
    const path = "src/main/java/com/acme/order/pricing/Order.java";
    expect(rows(judge({ files: { [path]: "package com.acme.order.pricing;\n\npublic final class Order {}\n" } }))).toEqual([
      { file: path, subject: "Order", reason: "shadows-frozen-adt" },
    ]);
  });

  it("AS-035: importing, matching on and constructing the frozen ADTs passes in both languages", () => {
    expect(judge({ files: { "src/order/replay.ts": TS_REPLAY.conforming, [JAVA_UNBOUND]: JAVA_GEOMETRY.conforming } })).toEqual(CLEAN);
  });

  it("AS-035: a union of imported frozen variants and `Extract<…>` derivations is using the frozen types directly", () => {
    const text = `import type { OrderEvent, OrderPaid, OrderShipped } from "./order-contract";\nexport type Settled = OrderPaid | OrderShipped;\nexport type Later = Extract<OrderEvent, { kind: "paid" }> | Extract<OrderEvent, { kind: "shipped" }>;\n`;
    expect(judge({ files: { [TS_UNBOUND]: text } })).toEqual(CLEAN);
  });

  it("AS-036: a strict subset of the frozen tags re-lists, and the remedy derives it with `Extract<OrderEvent, …>` naming the local union and its tags", () => {
    const conformance = judge({ files: { [TS_UNBOUND]: TS_LEDGER.relistsTagSubset } });
    expect(rows(conformance)).toEqual([{ file: TS_UNBOUND, subject: "OrderEvent", reason: "re-lists-frozen-variants" }]);
    const [violation] = violationsAt(conformance, TS_UNBOUND);
    expect(violation.remedy).toContain("SettledEntry");
    expect(violation.remedy).toContain(`Extract<OrderEvent, { kind: "paid" } | { kind: "shipped" }>`);
    expect(renderConformanceViolations(TS_UNBOUND, [violation])).toContain(violation.remedy ?? "<none>");
  });

  it("AS-036: re-listing the inline variants of a frozen union names that union's key in the remedy", () => {
    const conformance = judge({ files: { [TS_UNBOUND]: TS_LEDGER.relistsInlineVariants } });
    const [violation] = violationsAt(conformance, TS_UNBOUND);
    expect(violation).toMatchObject({ subject: "PaymentState", reason: "re-lists-frozen-variants" });
    expect(violation.remedy).toContain(`Extract<PaymentState, { status: "pending" } | { status: "settled" }>`);
  });

  it("AS-036: a Java hierarchy re-listing every frozen variant names the frozen and the local hierarchy in its remedy", () => {
    const conformance = judge({ files: { [JAVA_UNBOUND]: JAVA_GEOMETRY.relistsImplicitPermits } });
    const relisting = violationsAt(conformance, JAVA_UNBOUND).find(({ reason }) => reason === "re-lists-frozen-variants");
    expect(relisting?.subject).toBe("Shape");
    expect(relisting?.remedy).toContain("Shape");
    expect(relisting?.remedy).toContain("Figure");
  });

  it("AS-036: one shared variant name trips only the same-name rule, in both languages", () => {
    expect(rows(judge({ files: { [TS_UNBOUND]: TS_LEDGER.shadowsVariant, [JAVA_UNBOUND]: JAVA_GEOMETRY.singleSharedVariant } }))).toEqual([
      { file: TS_UNBOUND, subject: "OrderPaid", reason: "shadows-frozen-adt" },
      { file: JAVA_UNBOUND, subject: "Circle", reason: "shadows-frozen-adt" },
    ]);
  });

  it("AS-036: a union with one frozen tag repeated across members shares one tag and never re-lists", () => {
    const text = `export type Paid =\n  | Readonly<{ kind: "paid"; cents: number }>\n  | Readonly<{ kind: "paid"; refunded: true }>;\n`;
    expect(judge({ files: { [TS_UNBOUND]: text } })).toEqual(CLEAN);
  });

  it("FR-016: the near-miss view-models never re-list", () => {
    expect(judge({ files: { [TS_UNBOUND]: TS_LEDGER.conforming, [JAVA_UNBOUND]: JAVA_GEOMETRY.conforming } })).toEqual(CLEAN);
  });

  it("FR-017: a TypeScript file declaring `Shape` next to a Java contract freezing `Shape` stays clean", () => {
    const text = "export type Shape = Readonly<{ width: number }>;\nexport interface Circle { readonly r: number }\nexport type Fig = Readonly<{ kind: \"Circle\" }> | Readonly<{ kind: \"Square\" }>;\n";
    expect(judge({ files: { [TS_UNBOUND]: text } })).toEqual(CLEAN);
  });

  it("FR-017: a Java file declaring `OrderEvent` next to a TypeScript contract freezing `OrderEvent` stays clean", () => {
    const text = `package com.acme.order.pricing;\n\npublic final class Geometry {\n    record OrderEvent(String id) {}\n    record OrderId(String raw) {}\n    sealed interface Ev permits OrderPlaced, OrderPaid {}\n    record OrderPlaced() implements Ev {}\n    record OrderPaid() implements Ev {}\n}\n`;
    expect(judge({ files: { [JAVA_UNBOUND]: text } })).toEqual(CLEAN);
  });

  it("FR-015: a missing unbound file shadows nothing", () => {
    expect(judge({ files: { [TS_UNBOUND]: null, [JAVA_UNBOUND]: null } })).toEqual(CLEAN);
  });
});

// ---------------------------------------------------------------------------
// Listing every violation, and the diagnostic
// ---------------------------------------------------------------------------

describe("every violation, one diagnostic per file", () => {
  it("AS-028: every violation of every file is listed, files in input order, signature rules first", () => {
    const conformance = judge({
      files: {
        [TS_PATH]: TS_PRICING.severalViolations,
        [TS_UNBOUND]: TS_LEDGER.severalViolations,
        [JAVA_PATH]: JAVA_PRICING.severalViolations,
      },
    });
    expect(rows(conformance)).toEqual([
      { file: TS_PATH, subject: "priceOrder", reason: "still-unimplemented" },
      { file: TS_PATH, subject: "parseOrder", reason: "deleted" },
      { file: TS_UNBOUND, subject: "OrderId", reason: "shadows-frozen-adt" },
      { file: TS_UNBOUND, subject: "OrderEvent", reason: "re-lists-frozen-variants" },
      { file: JAVA_PATH, subject: "priceOrder", reason: "still-unimplemented" },
      { file: JAVA_PATH, subject: "parseOrder", reason: "retyped" },
    ]);
  });

  it("AS-028: the diagnostic lists the file, then one line per violation with its subject, reason words and remedy", () => {
    const violations: NonEmpty<ConformanceViolation> = [
      { subject: "priceOrder", reason: "still-unimplemented", remedy: null },
      { subject: "OrderEvent", reason: "re-lists-frozen-variants", remedy: "use the frozen types" },
    ];
    expect(renderConformanceViolations("src/a.ts", violations)).toBe(
      [
        "src/a.ts:",
        "  - priceOrder: still unimplemented",
        "  - OrderEvent: re-lists frozen variants — use the frozen types",
      ].join("\n"),
    );
  });

  it.each<[ViolationReason, string]>([
    ["deleted", "deleted"],
    ["renamed", "renamed"],
    ["retyped", "retyped"],
    ["still-unimplemented", "still unimplemented"],
    ["shadows-frozen-adt", "shadows frozen ADT"],
    ["re-lists-frozen-variants", "re-lists frozen variants"],
  ])("AS-028: the reason %s reads as `%s`", (reason, words) => {
    expect(renderConformanceViolations("f.ts", [{ subject: "x", reason, remedy: null }])).toContain(`x: ${words}`);
  });
});

// ---------------------------------------------------------------------------
// Laws
// ---------------------------------------------------------------------------

describe("laws", () => {
  const stems = fc
    .uniqueArray(fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,6}$/), { minLength: 1, maxLength: 4 })
    .map((names) => names.map((name) => `more${name.charAt(0).toUpperCase()}${name.slice(1)}`));

  const tsAdditions = (names: readonly string[]): string =>
    names
      .map((name) => `\nconst ${name}Local = (n: number): number => n;\nexport const ${name}: PriceOrderFn = (o, q) => ({ cents: ${name}Local(q) });\nexport type ${name}Union = Readonly<{ kind: "${name}" }> | Readonly<{ kind: "paid" }>;\nexport class ${name}Box {}\n`)
      .join("");

  const javaAdditions = (text: string, names: readonly string[]): string => {
    const members = names
      .map((name) => `\n    static final PriceOrderFn ${name} = priceOrder;\n    private static int ${name}Helper(int v) { return v; }\n    sealed interface ${name}Fig permits ${name}A {}\n    record ${name}A() implements ${name}Fig {}\n`)
      .join("");
    const close = text.lastIndexOf("}");
    return `${text.slice(0, close)}${members}${text.slice(close)}`;
  };

  it("FR-022: extra exports, helpers and own types never add a violation to a conforming file", () => {
    fc.assert(
      fc.property(stems, (names) => {
        expect(
          judge({
            files: {
              [TS_PATH]: TS_PRICING.conforming + tsAdditions(names),
              [JAVA_PATH]: javaAdditions(JAVA_PRICING.conforming, names),
            },
          }),
        ).toEqual(CLEAN);
      }),
      { numRuns: 40 },
    );
  });

  it("FR-022: additions never change a TypeScript file's violations, whatever its seeded defect", () => {
    fc.assert(
      fc.property(stems, fc.constantFrom(...Object.values(TS_PRICING)), (names, text) => {
        const before = rows(judge({ files: { [TS_PATH]: text } }));
        const after = rows(judge({ files: { [TS_PATH]: text + tsAdditions(names) } }));
        expect(after).toEqual(before);
      }),
      { numRuns: 40 },
    );
  });

  it("FR-022: additions never change a Java file's violations, whatever its seeded defect", () => {
    fc.assert(
      fc.property(stems, fc.constantFrom(JAVA_PRICING.conforming, JAVA_PRICING.deleted, JAVA_PRICING.retypedOtherType, JAVA_PRICING.stillUnimplemented), (names, text) => {
        const before = rows(judge({ files: { [JAVA_PATH]: text } }));
        const after = rows(judge({ files: { [JAVA_PATH]: javaAdditions(text, names) } }));
        expect(after).toEqual(before);
      }),
      { numRuns: 40 },
    );
  });

  it("FR-022: a file's violations do not depend on the other files judged beside it", () => {
    const files = { [TS_PATH]: TS_PRICING.severalViolations, [JAVA_UNBOUND]: JAVA_GEOMETRY.relistsImplicitPermits };
    const together = rows(judge({ files }));
    const apart = Object.entries(files).flatMap(([path, text]) => rows(judge({ files: { [path]: text } })));
    expect(together).toEqual(apart);
  });
});

describe("an unreadable bound file names why it proves nothing", () => {
  const remediesAt = (conformance: ContractConformance, path: string) =>
    violationsAt(conformance, path).map(({ subject, reason, remedy }) => ({ subject, reason, remedy }));

  it("AS-027: a TypeScript file that no longer parses keeps every bound export `deleted`, its remedy carrying the parse problem", () => {
    const text = `${TS_PRICING.conforming}\nexport const = ;\n`;
    const problem = readTsImplementationSurface(TS_PATH, text);
    if (problem.ok) throw new Error("fixture must not parse");
    const remedy = `${TS_PATH} no longer parses (${problem.error.detail}), so none of its bound exports is proven; make it parse`;
    expect(remediesAt(judge({ files: { [TS_PATH]: text } }), TS_PATH)).toEqual([
      { subject: "priceOrder", reason: "deleted", remedy },
      { subject: "parseOrder", reason: "deleted", remedy },
    ]);
  });

  it("AS-027: a Java file that no longer parses keeps every bound member `deleted`, its remedy carrying the parse problem", () => {
    const text = `${JAVA_PRICING.conforming}\n}}} class {\n`;
    const problem = readJavaImplementationSurface(JAVA_PATH, text);
    if (problem.ok) throw new Error("fixture must not parse");
    const remedy = `${JAVA_PATH} no longer parses (${problem.error.detail}), so none of its bound exports is proven; make it parse`;
    expect(remediesAt(judge({ files: { [JAVA_PATH]: text } }), JAVA_PATH)).toEqual([
      { subject: "priceOrder", reason: "deleted", remedy },
      { subject: "parseOrder", reason: "deleted", remedy },
    ]);
  });

  it("AS-027: a missing bound file names no parse problem", () => {
    expect(remediesAt(judge({ files: { [TS_PATH]: null } }), TS_PATH).map(({ remedy }) => remedy)).toEqual([null, null]);
  });
});

describe("bindings are matched to files by plan path", () => {
  it("FR-013: a binding spelled `./path` judges the file at `path`, as one spelled `path` does", () => {
    const respelled = binding(`./${TS_PATH}`, SOURCES_TS_CONTRACT_ID, ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]);
    const files = { [TS_PATH]: TS_PRICING.renamed };
    expect(judge({ files, bindings: [respelled] })).toEqual(judge({ files, bindings: [TS_BINDING] }));
    expect(rows(judge({ files, bindings: [respelled] }))).not.toEqual([]);
  });
});
