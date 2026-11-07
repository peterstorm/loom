/**
 * CT-1 acceptance: export bindings, frozen surfaces, stage-two resolution and
 * canonical skeleton bytes, through the pure core's entry points.
 *
 * Binding testcases (FR-001, FR-002, AS-001..AS-005) drive only the plan
 * grammar and validation. Resolution and generation testcases read the
 * frozen types surface from source text, parse each path through
 * `skeletonLanguageOf`, resolve, then generate — the exact pipeline the spawn
 * runs — and build their bindings as data, so they never depend on the plan
 * grammar. The supported/unsupported table and the determinism and
 * idempotency laws live here too.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PlanContract } from "../../src/core/acceptance-contract";
import { parseExportBindings, parseIdentifier, validateExportBindings } from "../../src/core/skeleton/bindings";
import { generateSkeleton } from "../../src/core/skeleton/generate";
import { readJavaTypesSurface } from "../../src/core/skeleton/java-surface";
import { skeletonLanguageOf } from "../../src/core/skeleton/language";
import { resolveBindings } from "../../src/core/skeleton/resolve";
import { readTsTypesSurface, typesImportSpecifier } from "../../src/core/skeleton/ts-surface";
import type {
  BindingProblem,
  BindingTaskView,
  ExportBinding,
  FrozenSurface,
  GeneratedSkeleton,
  Identifier,
  JavaSkeletonTarget,
  JavaSkeletonInput,
  JavaTypesSurface,
  ResolvedBinding,
  SpecifierStyle,
  TsSkeletonInput,
  TsSkeletonTarget,
  TsTypesSurface,
} from "../../src/core/skeleton/types";
import type { DomainResult } from "../../src/core/orchestration-contract";

// ---------------------------------------------------------------------------
// Fixtures: one TypeScript contract (CT-1) and one Java contract (CT-2)
// ---------------------------------------------------------------------------

const TS_TYPES = "src/order/order-contract.ts";
const TS_ACCEPTANCE = "tests/order.acceptance.test.ts";
const JAVA_TYPES = "src/main/java/com/acme/order/OrderContract.java";
const JAVA_ACCEPTANCE = "src/test/java/com/acme/order/OrderAcceptanceTest.java";

const TS_TYPES_TEXT = `export type Order = Readonly<{ id: string; lines: readonly string[] }>;
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

const JAVA_TYPES_TEXT = `package com.acme.order;

import java.util.List;

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

    interface Ledger {
        void post(Order order);
        void reverse(Order order);
    }

    interface MapFn<T> {
        T apply(T value);
    }

    record Order(String id, List<String> lines) {}

    record Price(long cents) {}
}
`;

const HEADER_TAIL = "Make these signatures work; keep each name and its type.";

const unwrap = <T, E>(result: DomainResult<T, E>, what: string): T => {
  if (!result.ok) throw new Error(`${what} refused: ${JSON.stringify(result.error)}`);
  return result.value;
};

/** Identifiers are minted only by `parseIdentifier`, never cast. */
const identifier = (raw: string): Identifier => unwrap(parseIdentifier(raw), `parseIdentifier(${raw})`);

/** A binding built as data, its names and aliases parsed through `parseIdentifier`. */
const binding = (path: string, contract: string, ...exports: readonly [string, string][]): ExportBinding => {
  const [first, ...rest] = exports.map(([name, alias]) => ({ name: identifier(name), alias: identifier(alias) }));
  if (first === undefined) throw new Error("fixture binding needs at least one export");
  return { path, contract, exports: [first, ...rest] };
};

const tsSurface = (): TsTypesSurface => unwrap(readTsTypesSurface(TS_TYPES, TS_TYPES_TEXT), "readTsTypesSurface");
const javaSurface = (): JavaTypesSurface => unwrap(readJavaTypesSurface(JAVA_TYPES, JAVA_TYPES_TEXT), "readJavaTypesSurface");

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

const resolvedFor = (surface: FrozenSurface, bound: ExportBinding): ResolvedBinding => {
  const resolved = unwrap(resolveBindings(surface, [bound]), "resolveBindings");
  const forPath = resolved.find(({ path }) => path === bound.path);
  if (forPath === undefined) throw new Error(`resolution dropped ${bound.path}`);
  return forPath;
};

/** The spawn pipeline for one bound TypeScript path: types text → surface →
 *  resolution → target → canonical bytes. Every input is rebuilt from text on
 *  every call. */
function generateTs(bound: ExportBinding, specifierStyle: SpecifierStyle | null = null): GeneratedSkeleton {
  const surface = tsSurface();
  const { contract, exports } = resolvedFor(surface, bound);
  return generateSkeleton({ language: "typescript", target: tsTarget(bound.path), surface, contract, exports, specifierStyle });
}

/** The same pipeline for one bound Java path. */
function generateJava(bound: ExportBinding): GeneratedSkeleton {
  const surface = javaSurface();
  const { contract, exports } = resolvedFor(surface, bound);
  return generateSkeleton({ language: "java", target: javaTarget(bound.path), surface, contract, exports });
}

const sha256 = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");

// ---------------------------------------------------------------------------
// Plan fixtures for binding validation
// ---------------------------------------------------------------------------

const declaredContract = (id: string, typesPath: string, acceptancePath: string): PlanContract => ({
  id,
  title: `${id} contract`,
  declaration: {
    kind: "declared",
    types: { kind: "file", path: typesPath },
    acceptance: [{ path: acceptancePath, anchors: ["AS-001"] }],
    supportedDomain: null,
    entryPoint: null,
    statement: `${id} statement`,
  },
});

const CONTRACTS: readonly PlanContract[] = [
  declaredContract("CT-1", TS_TYPES, TS_ACCEPTANCE),
  declaredContract("CT-2", JAVA_TYPES, JAVA_ACCEPTANCE),
];

const BOUND_PATHS = [
  "src/order/pricing.ts",
  "src/order/shipping.ts",
  "src/main/java/com/acme/order/pricing/Pricing.java",
] as const;

const TASKS: readonly BindingTaskView[] = [
  { id: "T1", file_list: [TS_TYPES, TS_ACCEPTANCE], depends_on: [], regressionWaiver: null },
  { id: "T2", file_list: [JAVA_TYPES, JAVA_ACCEPTANCE], depends_on: [], regressionWaiver: null },
  { id: "T3", file_list: [...BOUND_PATHS, "../outside.ts", "/etc/pricing.ts"], depends_on: ["T1", "T2"], regressionWaiver: null },
];

/** A File Structure section: two groups, each a fenced block followed by an
 *  `**Export bindings:**` list. */
const fileStructure = (...bindingLines: readonly string[]): string => `## File Structure

### Pricing (T3, Wave 2)

\`\`\`
src/order/pricing.ts   — NEW pricing
src/order/shipping.ts  — NEW shipping
\`\`\`

**Export bindings:**
${bindingLines.join("\n")}
`;

const validate = (...bindingLines: readonly string[]): readonly BindingProblem[] =>
  validateExportBindings(parseExportBindings(fileStructure(...bindingLines)), CONTRACTS, TASKS);

// ---------------------------------------------------------------------------
// Bindings: grammar and validation
// ---------------------------------------------------------------------------

describe("export bindings", () => {
  it("FR-001: one or more `name: Alias` exports per file are recorded against that file, in plan order", () => {
    const section = `## File Structure

### Pricing (T3, Wave 2)

\`\`\`
src/order/pricing.ts   — NEW pricing
\`\`\`

**Export bindings:**
- \`src/order/pricing.ts\` — CT-1: priceOrder: PriceOrderFn, parseOrder: ParseOrderFn

### Java pricing (T3, Wave 2)

\`\`\`
src/main/java/com/acme/order/pricing/Pricing.java — NEW
\`\`\`

**Export bindings:**
- \`src/main/java/com/acme/order/pricing/Pricing.java\` — CT-2: priceOrder: PriceOrderFn
`;
    expect(parseExportBindings(section)).toEqual({
      bindings: [
        binding("src/order/pricing.ts", "CT-1", ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]),
        binding("src/main/java/com/acme/order/pricing/Pricing.java", "CT-2", ["priceOrder", "PriceOrderFn"]),
      ],
      problems: [],
    });
  });

  it("AS-001: validation accepts `parseOrder: ParseOrderFn` and `priceOrder: PriceOrderFn` and records both exports against the file", () => {
    const declaration = parseExportBindings(fileStructure(
      "- `src/order/pricing.ts` — CT-1: parseOrder: ParseOrderFn, priceOrder: PriceOrderFn",
    ));
    expect(declaration.bindings).toEqual([
      binding("src/order/pricing.ts", "CT-1", ["parseOrder", "ParseOrderFn"], ["priceOrder", "PriceOrderFn"]),
    ]);
    expect(validateExportBindings(declaration, CONTRACTS, TASKS)).toEqual([]);
  });

  it("AS-002: a binding on a path outside the repository is refused, naming the file and the reason", () => {
    expect(validate("- `../outside.ts` — CT-1: priceOrder: PriceOrderFn"))
      .toContainEqual({ kind: "unsafe-path", path: "../outside.ts" });
    expect(validate("- `/etc/pricing.ts` — CT-1: priceOrder: PriceOrderFn"))
      .toContainEqual({ kind: "unsafe-path", path: "/etc/pricing.ts" });
  });

  it("AS-003: a binding on a frozen path (the types file or an acceptance test) is refused, naming the path", () => {
    expect(validate(`- \`${TS_TYPES}\` — CT-1: priceOrder: PriceOrderFn`))
      .toContainEqual({ kind: "frozen-path", path: TS_TYPES, contract: "CT-1" });
    expect(validate(`- \`${TS_ACCEPTANCE}\` — CT-1: priceOrder: PriceOrderFn`))
      .toContainEqual({ kind: "frozen-path", path: TS_ACCEPTANCE, contract: "CT-1" });
    expect(validate(`- \`${JAVA_TYPES}\` — CT-1: priceOrder: PriceOrderFn`))
      .toContainEqual({ kind: "frozen-path", path: JAVA_TYPES, contract: "CT-2" });
  });

  it("AS-004: one file bound by two contracts' types files is refused, naming the file and both contracts", () => {
    const problems = validate(
      "- `src/order/pricing.ts` — CT-1: priceOrder: PriceOrderFn",
      "- `src/order/pricing.ts` — CT-2: parseOrder: ParseOrderFn",
    );
    const multi = problems.filter((problem) => problem.kind === "multi-contract");
    expect(multi).toEqual([{ kind: "multi-contract", path: "src/order/pricing.ts", contracts: ["CT-1", "CT-2"] }]);
  });

  it("AS-005: a binding missing its name, missing its alias, or repeating an export name is refused, naming the file and the entry", () => {
    expect(validate("- `src/order/pricing.ts` — CT-1: : PriceOrderFn")).toContainEqual({
      kind: "malformed-entry",
      path: "src/order/pricing.ts",
      line: expect.stringContaining(": PriceOrderFn"),
      reason: "missing-name",
    });
    expect(validate("- `src/order/pricing.ts` — CT-1: priceOrder:")).toContainEqual({
      kind: "malformed-entry",
      path: "src/order/pricing.ts",
      line: expect.stringContaining("priceOrder:"),
      reason: "missing-alias",
    });
    expect(validate("- `src/order/pricing.ts` — CT-1: priceOrder")).toContainEqual({
      kind: "malformed-entry",
      path: "src/order/pricing.ts",
      line: expect.stringContaining("priceOrder"),
      reason: "missing-alias",
    });
    expect(validate("- `src/order/pricing.ts` — CT-1: priceOrder: PriceOrderFn, priceOrder: ParseOrderFn"))
      .toContainEqual({ kind: "duplicate-name", path: "src/order/pricing.ts", name: "priceOrder" });
  });

  it("FR-002: unsafe, frozen, malformed, duplicate and multi-contract bindings are each refused with the file and the reason", () => {
    const refusals: readonly [readonly string[], BindingProblem][] = [
      [["- `../outside.ts` — CT-1: priceOrder: PriceOrderFn"], { kind: "unsafe-path", path: "../outside.ts" }],
      [[`- \`${JAVA_ACCEPTANCE}\` — CT-2: priceOrder: PriceOrderFn`], { kind: "frozen-path", path: JAVA_ACCEPTANCE, contract: "CT-2" }],
      [["- `src/order/pricing.ts` — CT-1: price-order: PriceOrderFn"],
        { kind: "malformed-entry", path: "src/order/pricing.ts", line: "- `src/order/pricing.ts` — CT-1: price-order: PriceOrderFn", reason: "invalid-identifier" }],
      [["- `src/order/pricing.ts` — CT-1: class: PriceOrderFn"],
        { kind: "malformed-entry", path: "src/order/pricing.ts", line: "- `src/order/pricing.ts` — CT-1: class: PriceOrderFn", reason: "reserved-word" }],
      [["- `src/order/pricing.ts` — priceOrder: PriceOrderFn"],
        { kind: "malformed-entry", path: "src/order/pricing.ts", line: "- `src/order/pricing.ts` — priceOrder: PriceOrderFn", reason: "missing-contract" }],
      [["- `src/order/shipping.ts` — CT-1: shipOrder: ShipOrderFn, shipOrder: ShipOrderFn"],
        { kind: "duplicate-name", path: "src/order/shipping.ts", name: "shipOrder" }],
      [["- `src/order/shipping.ts` — CT-1: shipOrder: ShipOrderFn", "- `src/order/shipping.ts` — CT-1: parseOrder: ParseOrderFn"],
        { kind: "duplicate-path", path: "src/order/shipping.ts", contract: "CT-1" }],
      [["- `src/order/shipping.ts` — CT-2: shipOrder: ShipOrderFn", "- `src/order/shipping.ts` — CT-1: parseOrder: ParseOrderFn"],
        { kind: "multi-contract", path: "src/order/shipping.ts", contracts: ["CT-2", "CT-1"] }],
    ];
    for (const [lines, refusal] of refusals) {
      expect(validate(...lines), lines.join(" / ")).toContainEqual(refusal);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage-two resolution
// ---------------------------------------------------------------------------

describe("stage-two resolution", () => {
  it("FR-003: every missing, non-function and generic TypeScript alias is refused, naming the alias, the binding file and the types file", () => {
    const result = resolveBindings(tsSurface(), [
      binding("src/order/pricing.ts", "CT-1", ["priceOrder", "PriceOrderFn"], ["refund", "RefundFn"]),
      binding("src/order/shipping.ts", "CT-1", ["order", "Order"], ["identity", "IdentityFn"], ["map", "Mapper"]),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([...result.error].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { kind: "generic-alias", alias: "IdentityFn", path: "src/order/shipping.ts", typesFile: TS_TYPES },
      { kind: "generic-alias", alias: "Mapper", path: "src/order/shipping.ts", typesFile: TS_TYPES },
      { kind: "missing-alias", alias: "RefundFn", path: "src/order/pricing.ts", typesFile: TS_TYPES },
      { kind: "not-a-function", alias: "Order", path: "src/order/shipping.ts", typesFile: TS_TYPES },
    ]);
  });

  it("FR-003: every missing, non-single-abstract-method and generic Java alias is refused, naming the alias, the binding file and the types file", () => {
    const path = "src/main/java/com/acme/order/pricing/Pricing.java";
    const result = resolveBindings(javaSurface(), [
      binding(path, "CT-2", ["priceOrder", "PriceOrderFn"], ["refund", "RefundFn"], ["ledger", "Ledger"], ["order", "Order"], ["map", "MapFn"]),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([...result.error].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { kind: "generic-alias", alias: "MapFn", path, typesFile: JAVA_TYPES },
      { kind: "missing-alias", alias: "RefundFn", path, typesFile: JAVA_TYPES },
      { kind: "not-a-function", alias: "Ledger", path, typesFile: JAVA_TYPES },
      { kind: "not-a-function", alias: "Order", path, typesFile: JAVA_TYPES },
    ]);
  });

  it("FR-003: bindings whose aliases are all declared function types resolve, with each single abstract method's arity", () => {
    expect(resolveBindings(javaSurface(), [
      binding("src/main/java/com/acme/order/pricing/Pricing.java", "CT-2", ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]),
    ])).toEqual({
      ok: true,
      value: [{
        path: "src/main/java/com/acme/order/pricing/Pricing.java",
        contract: "CT-2",
        exports: [
          { name: "priceOrder", alias: "PriceOrderFn", parameterCount: 2 },
          { name: "parseOrder", alias: "ParseOrderFn", parameterCount: 1 },
        ],
      }],
    });
  });

  it("FR-003: a Java types file that is not exactly one top-level public interface or public final class holder is refused", () => {
    const shapes: readonly [string, string][] = [
      ["two top-level types", `package com.acme.order;\npublic interface OrderContract {\n    interface PriceOrderFn { long apply(int q); }\n}\ninterface Extra {}\n`],
      ["a non-final class holder", `package com.acme.order;\npublic class OrderContract {\n    public interface PriceOrderFn { long apply(int q); }\n}\n`],
      ["a package-private holder", `package com.acme.order;\ninterface OrderContract {\n    interface PriceOrderFn { long apply(int q); }\n}\n`],
      ["no top-level type", `package com.acme.order;\n`],
    ];
    for (const [shape, text] of shapes) {
      const result = readJavaTypesSurface(JAVA_TYPES, text);
      expect(result.ok, shape).toBe(false);
      if (!result.ok) expect(result.error.kind, shape).toBe("unsupported-holder-shape");
    }
  });

  it("FR-003: a public interface holder and a public final class holder are both read with their package and holder name", () => {
    const finalClass = `package com.acme.order;\n\npublic final class OrderContract {\n    private OrderContract() {}\n\n    @FunctionalInterface\n    public interface PriceOrderFn {\n        long apply(int quantity);\n    }\n}\n`;
    for (const text of [JAVA_TYPES_TEXT, finalClass]) {
      const surface = unwrap(readJavaTypesSurface(JAVA_TYPES, text), "readJavaTypesSurface");
      expect(surface).toMatchObject({ language: "java", path: JAVA_TYPES, package: "com.acme.order", holder: "OrderContract" });
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical skeleton bytes
// ---------------------------------------------------------------------------

/** Bindings are built inside each testcase, never at module load: the stubbed
 *  `parseIdentifier` throws, and a module-load throw would hide every testcase. */
const tsPricing = (): ExportBinding =>
  binding("src/order/pricing.ts", "CT-1", ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]);

const TS_PRICING_BYTES = `// Skeleton written by Loom from ${TS_TYPES} (CT-1). ${HEADER_TAIL}
import type { ParseOrderFn, PriceOrderFn } from "./order-contract";

export const priceOrder: PriceOrderFn = () => {
  throw new Error("unimplemented: priceOrder");
};

export const parseOrder: ParseOrderFn = () => {
  throw new Error("unimplemented: parseOrder");
};
`;

const JAVA_PRICING_PATH = "src/main/java/com/acme/order/pricing/Pricing.java";

const javaPricing = (): ExportBinding =>
  binding(JAVA_PRICING_PATH, "CT-2", ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]);

const JAVA_PRICING_BYTES = `// Skeleton written by Loom from ${JAVA_TYPES} (CT-2). ${HEADER_TAIL}
package com.acme.order.pricing;

import com.acme.order.OrderContract.ParseOrderFn;
import com.acme.order.OrderContract.PriceOrderFn;

public final class Pricing {
    private Pricing() {}

    public static final PriceOrderFn priceOrder = (p0, p1) -> {
        throw new UnsupportedOperationException("unimplemented: priceOrder");
    };

    public static final ParseOrderFn parseOrder = (p0) -> {
        throw new UnsupportedOperationException("unimplemented: parseOrder");
    };
}
`;

describe("canonical skeleton bytes", () => {
  it("FR-006: a TypeScript skeleton type-imports the bound aliases and exports each name annotated with its alias, throwing `unimplemented: <name>`", () => {
    expect(generateTs(tsPricing())).toEqual({
      path: "src/order/pricing.ts",
      language: "typescript",
      bytes: TS_PRICING_BYTES,
      sha256: sha256(TS_PRICING_BYTES),
    });
  });

  it("FR-006: the import specifier copies the acceptance tests' style, relative to the skeleton's directory", () => {
    const acceptanceJs = `import type { PriceOrderFn } from "../src/order/order-contract.js";\n`;
    const acceptanceBare = `import type { PriceOrderFn } from "../src/order/order-contract";\n`;
    const acceptanceTs = `import { type PriceOrderFn } from "../src/order/order-contract.ts";\n`;
    expect(typesImportSpecifier(TS_ACCEPTANCE, acceptanceJs, TS_TYPES)).toBe(".js");
    expect(typesImportSpecifier(TS_ACCEPTANCE, acceptanceBare, TS_TYPES)).toBe("extensionless");
    expect(typesImportSpecifier(TS_ACCEPTANCE, acceptanceTs, TS_TYPES)).toBe(".ts");
    expect(typesImportSpecifier(TS_ACCEPTANCE, `import { describe } from "vitest";\n`, TS_TYPES)).toBeNull();

    const style = typesImportSpecifier(TS_ACCEPTANCE, acceptanceJs, TS_TYPES);
    expect(generateTs(binding("src/api/checkout.tsx", "CT-1", ["priceOrder", "PriceOrderFn"]), style).bytes).toBe(
      `// Skeleton written by Loom from ${TS_TYPES} (CT-1). ${HEADER_TAIL}
import type { PriceOrderFn } from "../order/order-contract.js";

export const priceOrder: PriceOrderFn = () => {
  throw new Error("unimplemented: priceOrder");
};
`,
    );
  });

  it("FR-007: a Java skeleton is a public final class named after the file with one public static final lambda per binding, throwing UnsupportedOperationException(\"unimplemented: <name>\")", () => {
    expect(generateJava(javaPricing())).toEqual({
      path: JAVA_PRICING_PATH,
      language: "java",
      bytes: JAVA_PRICING_BYTES,
      sha256: sha256(JAVA_PRICING_BYTES),
    });
  });

  it("FR-007: a Java target is generated only from a Java surface, and the skeleton's path is the target's own", () => {
    // Compile-time law: the input correlates target, surface and language, so
    // a cross-language pairing or a second path cannot be written at all.
    const javaFromTsSurface = (exports: ResolvedBinding["exports"]): JavaSkeletonInput => ({
      language: "java",
      target: javaTarget(JAVA_PRICING_PATH),
      // @ts-expect-error a TypeScript surface never types a Java skeleton
      surface: tsSurface(),
      contract: "CT-2",
      exports,
    });
    const tsFromJavaTarget = (exports: ResolvedBinding["exports"]): TsSkeletonInput => ({
      language: "typescript",
      // @ts-expect-error a Java target never takes a TypeScript skeleton
      target: javaTarget(JAVA_PRICING_PATH),
      surface: tsSurface(),
      contract: "CT-1",
      exports,
      specifierStyle: null,
    });
    const secondPath = (exports: ResolvedBinding["exports"]): JavaSkeletonInput => ({
      language: "java",
      target: javaTarget(JAVA_PRICING_PATH),
      surface: javaSurface(),
      contract: "CT-2",
      exports,
      // @ts-expect-error the skeleton's path is the target's; no second path exists
      path: "src/main/java/com/acme/order/Elsewhere.java",
    });
    expect([javaFromTsSurface, tsFromJavaTarget, secondPath].every((build) => typeof build === "function")).toBe(true);

    const bound = binding("src/main/java/com/acme/order/shipping/Shipping.java", "CT-2", ["parseOrder", "ParseOrderFn"]);
    expect(generateJava(bound)).toMatchObject({ path: bound.path, language: "java" });
  });

  it("FR-008: a skeleton holds exactly the bound exports and the unique, sorted imports they need — no other alias, type or helper", () => {
    const { bytes } = generateTs(binding("src/order/quotes.ts", "CT-1", ["quote", "PriceOrderFn"], ["priceOrder", "PriceOrderFn"]));
    expect(bytes).toBe(`// Skeleton written by Loom from ${TS_TYPES} (CT-1). ${HEADER_TAIL}
import type { PriceOrderFn } from "./order-contract";

export const quote: PriceOrderFn = () => {
  throw new Error("unimplemented: quote");
};

export const priceOrder: PriceOrderFn = () => {
  throw new Error("unimplemented: priceOrder");
};
`);
    for (const unbound of ["ParseOrderFn", "ShipOrderFn", "OrderState", "OrderId", "Order,", "Price "]) {
      expect(bytes).not.toContain(unbound);
    }

    const java = generateJava(binding(JAVA_PRICING_PATH, "CT-2", ["priceOrder", "PriceOrderFn"])).bytes;
    expect(java).not.toContain("ParseOrderFn");
    expect(java).not.toContain("Ledger");
    expect(java.match(/public static final /g)).toHaveLength(1);
  });

  it("AS-011: FR-009: 100 TypeScript generations over the same frozen types and bindings are byte-identical", () => {
    const outputs = Array.from({ length: 100 }, () => generateTs(tsPricing()).bytes);
    expect(new Set(outputs)).toEqual(new Set([TS_PRICING_BYTES]));
  });

  it("AS-017: FR-009: 100 Java generations over the same frozen types and bindings are byte-identical", () => {
    const outputs = Array.from({ length: 100 }, () => generateJava(javaPricing()).bytes);
    expect(new Set(outputs)).toEqual(new Set([JAVA_PRICING_BYTES]));
  });

  it("FR-010: regenerating from an untouched TypeScript skeleton's inputs reproduces its bytes and digest exactly", () => {
    const written = generateTs(tsPricing());
    const rerun = generateTs(tsPricing());
    expect(rerun.bytes).toBe(written.bytes);
    expect(rerun.sha256).toBe(sha256(written.bytes));
  });

  it("AS-017: FR-010: a re-run over an untouched Java skeleton changes 0 bytes", () => {
    const written = generateJava(javaPricing());
    const rerun = generateJava(javaPricing());
    expect(rerun).toEqual(written);
    expect(rerun.bytes).toBe(JAVA_PRICING_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Supported domain: read through skeletonLanguageOf, then generateSkeleton
// ---------------------------------------------------------------------------

describe("supported skeleton targets", () => {
  const typescriptTargets = ["src/order/pricing.ts", "src/ui/price-tag.tsx", "src/order/pricing.mts", "src/order/pricing.cts"] as const;

  for (const path of typescriptTargets) {
    it(`FR-006: ${path} is a TypeScript target and generates a skeleton`, () => {
      expect(skeletonLanguageOf(path)).toEqual({ kind: "supported", language: "typescript", path });
      const { bytes } = generateTs(binding(path, "CT-1", ["priceOrder", "PriceOrderFn"]));
      expect(bytes).toContain("export const priceOrder: PriceOrderFn = () => {\n");
      expect(bytes).toContain(`throw new Error("unimplemented: priceOrder");`);
    });
  }

  const javaTargets: readonly [string, string, string][] = [
    ["src/main/java/com/acme/order/pricing/Pricing.java", "com.acme.order.pricing", "Pricing"],
    ["billing/src/main/java/com/acme/billing/Invoices.java", "com.acme.billing", "Invoices"],
  ];

  for (const [path, javaPackage, className] of javaTargets) {
    it(`FR-007: ${path} is a Java target in package ${javaPackage} and generates class ${className}`, () => {
      expect(skeletonLanguageOf(path)).toEqual({ kind: "supported", language: "java", path, package: javaPackage, className });
      const { bytes } = generateJava(binding(path, "CT-2", ["priceOrder", "PriceOrderFn"]));
      expect(bytes).toContain(`package ${javaPackage};\n`);
      expect(bytes).toContain(`public final class ${className} {\n`);
      expect(bytes).toContain("    public static final PriceOrderFn priceOrder = (p0, p1) -> {\n");
    });
  }

  const unsupported: readonly [string, string, string][] = [
    ["FR-006", "src/order/pricing.rs", "other-extension"],
    ["FR-006", "src/order/pricing.js", "other-extension"],
    ["FR-006", "src/order/globals.d.ts", "other-extension"],
    ["FR-006", "docs/pricing.md", "other-extension"],
    ["FR-007", "src/main/kotlin/com/acme/Pricing.kt", "jvm-non-java"],
    ["FR-007", "src/main/scala/com/acme/Pricing.scala", "jvm-non-java"],
    ["FR-007", "src/test/java/com/acme/PricingTest.java", "java-outside-main-root"],
    ["FR-007", "lib/Pricing.java", "java-outside-main-root"],
    ["FR-007", "src/main/java/com/my-co/Pricing.java", "java-invalid-name"],
  ];

  for (const [anchor, path, reason] of unsupported) {
    it(`${anchor}: ${path} is no skeleton target (${reason})`, () => {
      expect(skeletonLanguageOf(path)).toEqual({ kind: "unsupported", path, reason });
    });
  }
});
