/**
 * Canonical skeleton bytes (AD-8, FR-006..FR-010, AS-011, AS-017): the exact
 * TypeScript and Java bytes, the specifier rule, and the laws — determinism,
 * idempotency, exactly the bound exports — checked both on the bytes and by
 * reading the generated file back through the same surface readers the
 * conformance judge uses.
 */
import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DomainResult, NonEmpty } from "../../src/core/orchestration-contract";
import { parseIdentifier } from "../../src/core/skeleton/bindings";
import { generateSkeleton } from "../../src/core/skeleton/generate";
import { readJavaImplementationSurface, readJavaTypesSurface } from "../../src/core/skeleton/java-surface";
import { skeletonLanguageOf } from "../../src/core/skeleton/language";
import { readTsImplementationSurface, readTsTypesSurface } from "../../src/core/skeleton/ts-surface";
import type {
  GeneratedSkeleton,
  JavaSkeletonTarget,
  JavaTypesSurface,
  ResolvedExport,
  SpecifierStyle,
  TsSkeletonTarget,
  TsTypesSurface,
} from "../../src/core/skeleton/types";

const TS_TYPES = "src/order/order-contract.ts";
const JAVA_TYPES = "src/main/java/com/acme/order/OrderContract.java";
const HEADER_TAIL = "Make these signatures work; keep each name and its type.";

const TS_TYPES_TEXT = `export type Order = Readonly<{ id: string }>;
export type ParseOrderFn = (raw: string) => Order;
export type PriceOrderFn = (order: Order, quantity: number) => number;
export type NowFn = () => number;
`;

const JAVA_TYPES_TEXT = `package com.acme.order;

public interface OrderContract {
    interface PriceOrderFn { long apply(Order order, int quantity); }
    interface ParseOrderFn { Order parse(String raw); }
    interface NowFn { long now(); }
    record Order(String id) {}
}
`;

const unwrap = <T, E>(result: DomainResult<T, E>): T => {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.error)}`);
  return result.value;
};

const ARITY: Readonly<Record<string, number>> = { ParseOrderFn: 1, PriceOrderFn: 2, NowFn: 0 };

const exportsOf = (...pairs: readonly (readonly [string, string])[]): NonEmpty<ResolvedExport> => {
  const [first, ...rest] = pairs.map(([name, alias]): ResolvedExport => ({
    name: unwrap(parseIdentifier(name)),
    alias: unwrap(parseIdentifier(alias)),
    parameterCount: ARITY[alias] ?? 0,
  }));
  if (first === undefined) throw new Error("fixture needs at least one export");
  return [first, ...rest];
};

const tsSurface = (path = TS_TYPES, text = TS_TYPES_TEXT): TsTypesSurface => unwrap(readTsTypesSurface(path, text));
const javaSurface = (path = JAVA_TYPES, text = JAVA_TYPES_TEXT): JavaTypesSurface => unwrap(readJavaTypesSurface(path, text));

const tsTarget = (path: string): TsSkeletonTarget => {
  const target = skeletonLanguageOf(path);
  if (target.kind !== "supported" || target.language !== "typescript") throw new Error(`${path} is no TypeScript target`);
  return target;
};

const javaTarget = (path: string): JavaSkeletonTarget => {
  const target = skeletonLanguageOf(path);
  if (target.kind !== "supported" || target.language !== "java") throw new Error(`${path} is no Java target`);
  return target;
};

const generateTs = (
  path: string,
  exports: NonEmpty<ResolvedExport>,
  specifierStyle: SpecifierStyle | null = null,
  surface: TsTypesSurface = tsSurface(),
): GeneratedSkeleton => generateSkeleton({ language: "typescript", target: tsTarget(path), surface, contract: "CT-1", exports, specifierStyle });

const generateJava = (path: string, exports: NonEmpty<ResolvedExport>, surface: JavaTypesSurface = javaSurface()): GeneratedSkeleton =>
  generateSkeleton({ language: "java", target: javaTarget(path), surface, contract: "CT-2", exports });

const sha256 = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");

const tsMember = (name: string, alias: string): string =>
  `export const ${name}: ${alias} = () => {\n  throw new Error("unimplemented: ${name}");\n};\n`;

describe("generateSkeleton — TypeScript bytes", () => {
  it("FR-006: header, one sorted unique type import, then one throwing export per binding in plan order", () => {
    const skeleton = generateTs("src/order/pricing.ts", exportsOf(["priceOrder", "PriceOrderFn"], ["now", "NowFn"], ["parseOrder", "ParseOrderFn"], ["quote", "PriceOrderFn"]));
    const bytes = [
      `// Skeleton written by Loom from ${TS_TYPES} (CT-1). ${HEADER_TAIL}\n`,
      `import type { NowFn, ParseOrderFn, PriceOrderFn } from "./order-contract";\n`,
      "\n",
      tsMember("priceOrder", "PriceOrderFn"),
      "\n",
      tsMember("now", "NowFn"),
      "\n",
      tsMember("parseOrder", "ParseOrderFn"),
      "\n",
      tsMember("quote", "PriceOrderFn"),
    ].join("");
    expect(skeleton).toEqual({ path: "src/order/pricing.ts", language: "typescript", bytes, sha256: sha256(bytes) });
  });

  const specifiers: readonly [string, SpecifierStyle | null, string, string][] = [
    ["same directory, no acceptance import", null, "src/order/pricing.ts", "./order-contract"],
    ["same directory, extensionless", "extensionless", "src/order/pricing.ts", "./order-contract"],
    ["same directory, .js", ".js", "src/order/pricing.ts", "./order-contract.js"],
    ["same directory, .ts", ".ts", "src/order/pricing.ts", "./order-contract.ts"],
    ["deeper directory", null, "src/order/deep/er/pricing.ts", "../../order-contract"],
    ["sibling directory, .js", ".js", "src/api/checkout.tsx", "../order/order-contract.js"],
    ["repository root", null, "pricing.ts", "./src/order/order-contract"],
    ["another top-level tree", ".ts", "web/app/pricing.mts", "../../src/order/order-contract.ts"],
  ];

  for (const [label, style, path, specifier] of specifiers) {
    it(`FR-006: the specifier is relative to the skeleton's directory (${label})`, () => {
      expect(generateTs(path, exportsOf(["now", "NowFn"]), style).bytes).toContain(`import type { NowFn } from "${specifier}";\n`);
    });
  }

  it("FR-006: a .js-style specifier names a module types file by its runtime extension", () => {
    expect(generateTs("src/order/pricing.ts", exportsOf(["now", "NowFn"]), ".js", tsSurface("src/order/order-contract.mts")).bytes)
      .toContain(`from "./order-contract.mjs";\n`);
    expect(generateTs("src/order/pricing.ts", exportsOf(["now", "NowFn"]), ".js", tsSurface("src/order/order-contract.cts")).bytes)
      .toContain(`from "./order-contract.cjs";\n`);
    expect(generateTs("src/order/pricing.ts", exportsOf(["now", "NowFn"]), "extensionless", tsSurface("src/order/order-contract.mts")).bytes)
      .toContain(`from "./order-contract";\n`);
  });

  it("FR-006: the generated file reads back as exactly the bound exports, each annotated with its alias imported from the types file and carrying its marker", () => {
    const { path, bytes } = generateTs("src/api/checkout.ts", exportsOf(["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]), ".js");
    const surface = unwrap(readTsImplementationSurface(path, bytes));
    expect(surface.exports).toEqual([
      { name: "priceOrder", declaration: "const", annotation: "PriceOrderFn", annotationSource: "../order/order-contract.js", initializerStrings: ["unimplemented: priceOrder"] },
      { name: "parseOrder", declaration: "const", annotation: "ParseOrderFn", annotationSource: "../order/order-contract.js", initializerStrings: ["unimplemented: parseOrder"] },
    ]);
    expect(surface.localDeclarations).toEqual([]);
    expect(surface.localUnions).toEqual([]);
  });
});

describe("generateSkeleton — Java bytes", () => {
  const PRICING = "src/main/java/com/acme/order/pricing/Pricing.java";

  it("FR-007: package, sorted unique nested-type imports, a final class with a private constructor and one typed lambda per binding", () => {
    const skeleton = generateJava(PRICING, exportsOf(["priceOrder", "PriceOrderFn"], ["now", "NowFn"], ["quote", "PriceOrderFn"]));
    const bytes = `// Skeleton written by Loom from ${JAVA_TYPES} (CT-2). ${HEADER_TAIL}
package com.acme.order.pricing;

import com.acme.order.OrderContract.NowFn;
import com.acme.order.OrderContract.PriceOrderFn;

public final class Pricing {
    private Pricing() {}

    public static final PriceOrderFn priceOrder = (p0, p1) -> {
        throw new UnsupportedOperationException("unimplemented: priceOrder");
    };

    public static final NowFn now = () -> {
        throw new UnsupportedOperationException("unimplemented: now");
    };

    public static final PriceOrderFn quote = (p0, p1) -> {
        throw new UnsupportedOperationException("unimplemented: quote");
    };
}
`;
    expect(skeleton).toEqual({ path: PRICING, language: "java", bytes, sha256: sha256(bytes) });
  });

  it("FR-007: a target in the default package carries no package line", () => {
    const { bytes } = generateJava("src/main/java/Pricing.java", exportsOf(["parseOrder", "ParseOrderFn"]));
    expect(bytes).toBe(`// Skeleton written by Loom from ${JAVA_TYPES} (CT-2). ${HEADER_TAIL}

import com.acme.order.OrderContract.ParseOrderFn;

public final class Pricing {
    private Pricing() {}

    public static final ParseOrderFn parseOrder = (p0) -> {
        throw new UnsupportedOperationException("unimplemented: parseOrder");
    };
}
`);
  });

  it("FR-007: a types holder in the default package cannot be imported, so each member is typed by the holder-qualified alias", () => {
    const surface = javaSurface("src/main/java/OrderContract.java", JAVA_TYPES_TEXT.replace("package com.acme.order;\n\n", ""));
    const { bytes } = generateJava("src/main/java/Pricing.java", exportsOf(["now", "NowFn"]), surface);
    expect(bytes).toBe(`// Skeleton written by Loom from src/main/java/OrderContract.java (CT-2). ${HEADER_TAIL}

public final class Pricing {
    private Pricing() {}

    public static final OrderContract.NowFn now = () -> {
        throw new UnsupportedOperationException("unimplemented: now");
    };
}
`);
  });

  it("FR-007: the generated file reads back as one public static final field per binding, typed by its alias, with its marker", () => {
    const { path, bytes } = generateJava(PRICING, exportsOf(["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]));
    const surface = unwrap(readJavaImplementationSurface(path, bytes));
    expect(surface.package).toBe("com.acme.order.pricing");
    expect(surface.imports).toEqual(["com.acme.order.OrderContract.ParseOrderFn", "com.acme.order.OrderContract.PriceOrderFn"]);
    expect(surface.fields.map(({ name, modifiers, typeToken, initializerStrings }) => ({ name, modifiers: [...modifiers].sort(), typeToken, initializerStrings }))).toEqual([
      { name: "priceOrder", modifiers: ["final", "public", "static"], typeToken: "PriceOrderFn", initializerStrings: ["unimplemented: priceOrder"] },
      { name: "parseOrder", modifiers: ["final", "public", "static"], typeToken: "ParseOrderFn", initializerStrings: ["unimplemented: parseOrder"] },
    ]);
    expect(surface.localTypes.map(({ name, kind }) => ({ name, kind }))).toEqual([{ name: "Pricing", kind: "class" }]);
  });
});

// ---------------------------------------------------------------------------
// Laws
// ---------------------------------------------------------------------------

const ALIASES = Object.keys(ARITY);

/** One to six distinct, valid export names, each bound to a declared alias. */
const exportsArb = fc.uniqueArray(
  fc.tuple(fc.stringMatching(/^[a-z][A-Za-z0-9]{0,8}$/), fc.constantFrom(...ALIASES)),
  { minLength: 1, maxLength: 6, selector: ([name]) => name },
).filter((pairs) => pairs.every(([name]) => parseIdentifier(name).ok));

const tsPathArb = fc.tuple(
  fc.array(fc.constantFrom("src", "order", "api", "web", "deep"), { maxLength: 4 }),
  fc.constantFrom("pricing.ts", "checkout.tsx", "quote.mts", "legacy.cts"),
).map(([dirs, file]) => [...dirs, file].join("/"));

const javaPathArb = fc.tuple(
  fc.constantFrom("", "billing/"),
  fc.array(fc.constantFrom("com", "acme", "order", "pricing"), { maxLength: 4 }),
  fc.constantFrom("Pricing", "Invoices", "Quotes"),
).map(([module, packages, className]) => `${module}src/main/java/${[...packages, `${className}.java`].join("/")}`);

const styleArb = fc.constantFrom<SpecifierStyle | null>(null, "extensionless", ".js", ".ts");

describe("generateSkeleton — laws", () => {
  it("AS-011: 100 TypeScript generations over the same frozen types and bindings are byte-identical", () => {
    const exports = exportsOf(["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]);
    const outputs = Array.from({ length: 100 }, () => generateTs("src/order/pricing.ts", exports, ".js", tsSurface()));
    expect(new Set(outputs.map(({ bytes }) => bytes)).size).toBe(1);
    expect(new Set(outputs.map(({ sha256: digest }) => digest)).size).toBe(1);
  });

  it("AS-017: 100 Java generations over the same frozen types and bindings are byte-identical; a re-run over an untouched skeleton changes 0 bytes", () => {
    const exports = exportsOf(["priceOrder", "PriceOrderFn"], ["now", "NowFn"]);
    const outputs = Array.from({ length: 100 }, () => generateJava("src/main/java/com/acme/order/pricing/Pricing.java", exports, javaSurface()));
    expect(new Set(outputs.map(({ bytes }) => bytes)).size).toBe(1);
    const [written] = outputs;
    expect(generateJava("src/main/java/com/acme/order/pricing/Pricing.java", exports, javaSurface())).toEqual(written);
  });

  it("FR-009: TypeScript bytes are a pure function of target, surface, contract, exports and style", () => {
    fc.assert(fc.property(tsPathArb, exportsArb, styleArb, (path, pairs, style) => {
      const first = generateTs(path, exportsOf(...pairs), style, tsSurface());
      const second = generateTs(path, exportsOf(...pairs), style, tsSurface());
      expect(second).toEqual(first);
      expect(first.sha256).toBe(sha256(first.bytes));
    }));
  });

  it("FR-010: regenerating from an untouched skeleton's inputs reproduces its bytes, for both languages", () => {
    fc.assert(fc.property(tsPathArb, javaPathArb, exportsArb, styleArb, (tsPath, javaPath, pairs, style) => {
      const ts = generateTs(tsPath, exportsOf(...pairs), style);
      expect(generateTs(tsPath, exportsOf(...pairs), style).bytes).toBe(ts.bytes);
      const java = generateJava(javaPath, exportsOf(...pairs));
      expect(generateJava(javaPath, exportsOf(...pairs)).bytes).toBe(java.bytes);
    }));
  });

  it("FR-008: a TypeScript skeleton reads back as exactly the bound names, typed by exactly the bound aliases, importing nothing else", () => {
    fc.assert(fc.property(tsPathArb, exportsArb, styleArb, (path, pairs, style) => {
      const { bytes } = generateTs(path, exportsOf(...pairs), style);
      const surface = unwrap(readTsImplementationSurface(path, bytes));
      expect(surface.exports.map(({ name, annotation }) => [name, annotation])).toEqual(pairs);
      expect(surface.localDeclarations).toEqual([]);
      const importLines = bytes.split("\n").filter((line) => line.startsWith("import"));
      expect(importLines).toHaveLength(1);
      const imported = /\{ (.*) \}/.exec(importLines[0] ?? "")?.[1]?.split(", ");
      expect(imported).toEqual([...new Set(pairs.map(([, alias]) => alias))].sort());
    }));
  });

  it("FR-008: a Java skeleton reads back as exactly the bound fields, typed by exactly the bound aliases, importing nothing else", () => {
    fc.assert(fc.property(javaPathArb, exportsArb, (path, pairs) => {
      const { bytes } = generateJava(path, exportsOf(...pairs));
      const surface = unwrap(readJavaImplementationSurface(path, bytes));
      expect(surface.fields.map(({ name, typeToken }) => [name, typeToken])).toEqual(pairs);
      expect(surface.imports).toEqual([...new Set(pairs.map(([, alias]) => `com.acme.order.OrderContract.${alias}`))].sort());
      expect(surface.localTypes).toHaveLength(1);
    }));
  });

  it("FR-009: canonical bytes use LF only, end in exactly one newline and carry no timestamp", () => {
    fc.assert(fc.property(tsPathArb, javaPathArb, exportsArb, (tsPath, javaPath, pairs) => {
      for (const { bytes } of [generateTs(tsPath, exportsOf(...pairs)), generateJava(javaPath, exportsOf(...pairs))]) {
        expect(bytes).not.toContain("\r");
        expect(bytes.endsWith("\n")).toBe(true);
        expect(bytes.endsWith("\n\n")).toBe(false);
        expect(bytes).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      }
    }));
  });
});
