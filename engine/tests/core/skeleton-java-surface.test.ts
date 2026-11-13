/**
 * The restricted Java reader (AD-7): frozen-holder shape refusals, bindable
 * alias shapes (single abstract method arity and generic-ness), sealed
 * hierarchies with explicit and implicit permits, records, fields with their
 * type tokens and initializer strings, text blocks — and the blanking law:
 * comments and string contents never change a declaration read.
 */

import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as javaSurface from "../../src/core/skeleton/java-surface";
import { readJavaImplementationSurface, readJavaTypesSurface } from "../../src/core/skeleton/java-surface";
import { DEFAULT_MAX_FUNCTION_LINES_OPTIONS, handler as maxFunctionLines } from "../../src/linter/programmatic/max-function-lines";
import type { JavaImplementationSurface, JavaTypesSurface, SurfaceProblem } from "../../src/core/skeleton/types";
import type { DomainResult } from "../../src/core/orchestration-contract";
import { unwrap } from "../fixtures/skeleton-builders";

const TYPES_PATH = "src/main/java/com/acme/order/OrderContract.java";
const IMPL_PATH = "src/main/java/com/acme/order/pricing/Pricing.java";

const refusal = <T>(result: DomainResult<T, SurfaceProblem>): SurfaceProblem => {
  if (result.ok) throw new Error(`expected a refusal, read ${JSON.stringify(result.value)}`);
  return result.error;
};

const types = (text: string): JavaTypesSurface => unwrap(readJavaTypesSurface(TYPES_PATH, text));
const impl = (text: string, path: string = IMPL_PATH): JavaImplementationSurface => unwrap(readJavaImplementationSurface(path, text));

const holder = (body: string): string => `package com.acme.order;\n\npublic interface OrderContract {\n${body}\n}\n`;
const aliasesOf = (body: string) => types(holder(body)).aliases;

const fn = (parameterCount: number, generic = false) => ({ kind: "function", generic, parameterCount }) as const;
const notFn = { kind: "not-a-function" } as const;

// ---------------------------------------------------------------------------
// Frozen types surface
// ---------------------------------------------------------------------------

describe("readJavaTypesSurface", () => {
  it("reads the package, the holder, every nested alias with its shape, and the frozen records", () => {
    const text = `package com.acme.order;

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
    expect(readJavaTypesSurface(TYPES_PATH, text)).toEqual({
      ok: true,
      value: {
        language: "java",
        path: TYPES_PATH,
        package: "com.acme.order",
        holder: "OrderContract",
        aliases: [
          { name: "PriceOrderFn", shape: fn(2) },
          { name: "ParseOrderFn", shape: fn(1) },
          { name: "Ledger", shape: notFn },
          { name: "MapFn", shape: fn(1, true) },
          { name: "Order", shape: notFn },
          { name: "Price", shape: notFn },
        ],
        adts: [
          { kind: "record", name: "Order" },
          { kind: "record", name: "Price" },
        ],
      },
    });
  });

  it("reads a public final class holder with a private constructor, constants and static methods", () => {
    const surface = types(`package com.acme.order;

public final class OrderContract {
    private OrderContract() {}

    public static final String VERSION = "1";

    public static int answer() { return 42; }

    @FunctionalInterface
    public interface PriceOrderFn {
        long apply(int quantity);
    }
}
`);
    expect(surface).toEqual({
      language: "java",
      path: TYPES_PATH,
      package: "com.acme.order",
      holder: "OrderContract",
      aliases: [{ name: "PriceOrderFn", shape: fn(1) }],
      adts: [],
    });
  });

  it("reads a holder in the default package with a null package", () => {
    expect(types(`public interface OrderContract { interface F { void run(); } }`)).toMatchObject({ package: null, holder: "OrderContract" });
  });

  it.each([
    ["no top-level type", "package com.acme.order;\n", "no top-level type"],
    ["two top-level types", "package com.acme.order;\npublic interface OrderContract {}\ninterface Extra {}\n", "OrderContract, Extra"],
    ["a non-final class", "package com.acme.order;\npublic class OrderContract {}\n", "OrderContract"],
    ["an abstract class", "package com.acme.order;\npublic abstract class OrderContract {}\n", "OrderContract"],
    ["a package-private interface", "package com.acme.order;\ninterface OrderContract {}\n", "OrderContract"],
    ["a package-private final class", "package com.acme.order;\nfinal class OrderContract {}\n", "OrderContract"],
    ["a public record", "package com.acme.order;\npublic record OrderContract(int id) {}\n", "OrderContract"],
    ["a public enum", "package com.acme.order;\npublic enum OrderContract { A }\n", "OrderContract"],
    ["a public annotation type", "package com.acme.order;\npublic @interface OrderContract {}\n", "OrderContract"],
  ])("refuses %s as unsupported-holder-shape, naming what it found", (_shape, text, named) => {
    const problem = refusal(readJavaTypesSurface(TYPES_PATH, text));
    expect(problem.kind).toBe("unsupported-holder-shape");
    expect(problem.path).toBe(TYPES_PATH);
    expect(problem.detail).toContain(named);
  });

  it.each([
    ["an unterminated block comment", "public interface OrderContract { /* never closed }"],
    ["an unterminated string literal", 'public interface OrderContract { String S = "open;\n}'],
    ["an unterminated text block", 'public interface OrderContract { String S = """\n  open;\n}'],
    ["a text block without a line terminator after its opening delimiter", 'public interface OrderContract { String S = """open"""; }'],
    ["an unbalanced brace", "public interface OrderContract { interface F { void run(); }"],
    ["a mismatched bracket", "public interface OrderContract { interface F { void run(]; } }"],
    ["an invalid string escape", 'public interface OrderContract { String S = "\\q"; }'],
    ["an invalid unicode escape", "public interface OrderContract { String S = \"\\u00G1\"; }"],
    ["a stray token at the top level", "public interface OrderContract {} 42"],
  ])("refuses %s as unparseable", (_case, text) => {
    const problem = refusal(readJavaTypesSurface(TYPES_PATH, text));
    expect(problem).toMatchObject({ kind: "unparseable", path: TYPES_PATH });
    expect(problem.detail.length).toBeGreaterThan(0);
  });

  describe("single abstract method shapes", () => {
    it("counts the single abstract method's parameters, through generics, arrays, varargs, annotations and final", () => {
      expect(aliasesOf(`
        interface Zero { void run(); }
        interface Three { long apply(java.util.Map<String, java.util.List<Integer>> table, @Deprecated final int[] counts, String... rest); }
        interface Dims { int[] apply(int legacy[]); }
      `)).toEqual([
        { name: "Zero", shape: fn(0) },
        { name: "Three", shape: fn(3) },
        { name: "Dims", shape: fn(1) },
      ]);
    });

    it("does not count default, static and private methods, nor public Object methods redeclared abstract", () => {
      expect(aliasesOf(`
        interface Fn {
            long apply(int q);
            default long twice(int q) { return 2 * apply(q); }
            static Fn constant(long v) { return q -> v; }
            private long helper() { return 0; }
            boolean equals(Object other);
            int hashCode();
            String toString();
        }
      `)).toEqual([{ name: "Fn", shape: fn(1) }]);
    });

    it("marks a generic interface or a generic single abstract method as generic", () => {
      expect(aliasesOf(`
        interface Mapper<T> { T apply(T value); }
        interface Identity { <T> T apply(T value); }
      `)).toEqual([
        { name: "Mapper", shape: fn(1, true) },
        { name: "Identity", shape: fn(1, true) },
      ]);
    });

    it("reads no function from an interface with zero or several abstract methods, a class, an enum, or a sealed interface", () => {
      expect(aliasesOf(`
        interface Marker {}
        interface Two { void a(); void b(int x); }
        final class Helper { void run() {} }
        enum Currency { EUR, USD }
        sealed interface Choice permits Yes { void pick(); }
        record Yes() implements Choice { public void pick() {} }
        @interface Tag { String value() default "x"; }
      `)).toEqual([
        { name: "Marker", shape: notFn },
        { name: "Two", shape: notFn },
        { name: "Helper", shape: notFn },
        { name: "Currency", shape: notFn },
        { name: "Choice", shape: notFn },
        { name: "Yes", shape: notFn },
        { name: "Tag", shape: notFn },
      ]);
    });

    it("inherits abstract methods from interfaces the file declares, and refuses to guess an undeclared parent", () => {
      expect(aliasesOf(`
        interface Base<T> { long apply(T value); }
        interface IntFn extends Base<Integer> {}
        interface Narrowed extends Base<String> { long apply(String value); }
        interface Defaulted extends Base<String> { default long apply(String value) { return 0; } }
        interface External extends java.util.function.Function<String, String> {}
        interface Loop extends Loop2 {}
        interface Loop2 extends Loop {}
      `)).toEqual([
        { name: "Base", shape: fn(1, true) },
        { name: "IntFn", shape: fn(1) },
        { name: "Narrowed", shape: fn(1) },
        { name: "Defaulted", shape: notFn },
        { name: "External", shape: notFn },
        { name: "Loop", shape: notFn },
        { name: "Loop2", shape: notFn },
      ]);
    });

    it("keys abstract methods by name and erased parameter types: same-arity overloads are two methods (AS-009)", () => {
      expect(aliasesOf(`
        interface Overloaded { void apply(String s); void apply(Integer i); }
        interface ArrayOverload { void apply(int[] xs); void apply(int x); }
        interface VarargsOverload { void apply(String... xs); void apply(String x); }
        interface Parent { void apply(String s); }
        interface InheritedOverload extends Parent { void apply(Integer i); }
        interface GenericParent<T> { void apply(T value); }
        interface SubstitutedOverload extends GenericParent<String> { void apply(Integer i); }
      `)).toEqual([
        { name: "Overloaded", shape: notFn },
        { name: "ArrayOverload", shape: notFn },
        { name: "VarargsOverload", shape: notFn },
        { name: "Parent", shape: fn(1) },
        { name: "InheritedOverload", shape: notFn },
        { name: "GenericParent", shape: fn(1, true) },
        { name: "SubstitutedOverload", shape: notFn },
      ]);
    });

    it("a default method removes only the abstract method with the same erased parameter types", () => {
      expect(aliasesOf(`
        interface Parent { void apply(String s); }
        interface OtherDefault extends Parent { default void apply(Integer i) {} }
        interface SameDefault extends Parent { default void apply(String s) {} }
        interface Pair { void apply(String s); void apply(Integer i); }
        interface OneDefaulted extends Pair { default void apply(Integer i) {} }
        interface GenericParent<T> { void apply(T value); }
        interface SubstitutedDefault extends GenericParent<String> { default void apply(String s) {} }
        interface RawDefault extends GenericParent { default void apply(Object o) {} }
      `)).toEqual([
        { name: "Parent", shape: fn(1) },
        { name: "OtherDefault", shape: fn(1) },
        { name: "SameDefault", shape: notFn },
        { name: "Pair", shape: notFn },
        { name: "OneDefaulted", shape: fn(1) },
        { name: "GenericParent", shape: fn(1, true) },
        { name: "SubstitutedDefault", shape: notFn },
        { name: "RawDefault", shape: notFn },
      ]);
    });

    it("counts override-equivalent redeclarations once: qualified names, type arguments, varargs, diamonds and chained substitution", () => {
      expect(aliasesOf(`
        interface Parent { void apply(java.util.List<String> xs); }
        interface Qualified extends Parent { void apply(List xs); }
        interface VarargsParent { void apply(String... xs); }
        interface ArrayRedeclared extends VarargsParent { void apply(String[] xs); }
        interface Left { void apply(String s); }
        interface Right { void apply(String s); }
        interface Diamond extends Left, Right {}
        interface Generic<T> { void apply(T value); }
        interface Middle<U> extends Generic<U> {}
        interface Chained extends Middle<String> { void apply(String s); }
        interface Bounded<T extends Number> { void apply(T value); }
        interface RawBounded extends Bounded { void apply(Number n); }
      `)).toEqual([
        { name: "Parent", shape: fn(1) },
        { name: "Qualified", shape: fn(1) },
        { name: "VarargsParent", shape: fn(1) },
        { name: "ArrayRedeclared", shape: fn(1) },
        { name: "Left", shape: fn(1) },
        { name: "Right", shape: fn(1) },
        { name: "Diamond", shape: fn(1) },
        { name: "Generic", shape: fn(1, true) },
        { name: "Middle", shape: fn(1, true) },
        { name: "Chained", shape: fn(1) },
        { name: "Bounded", shape: fn(1, true) },
        { name: "RawBounded", shape: fn(1) },
      ]);
    });
  });

  describe("frozen ADTs", () => {
    it("reads a sealed interface with explicit permits, simple names from qualified ones", () => {
      expect(types(holder(`
        sealed interface OrderState permits OrderContract.Draft, Paid {}
        record Draft(String id) implements OrderState {}
        record Paid(String id, long cents) implements OrderState {}
      `)).adts).toEqual([
        { kind: "sealed-interface", name: "OrderState", variants: ["Draft", "Paid"] },
        { kind: "record", name: "Draft" },
        { kind: "record", name: "Paid" },
      ]);
    });

    it("reads implicit permits: every type the file declares with the sealed interface as a direct supertype", () => {
      expect(types(holder(`
        sealed interface Shape {
            record Circle(double r) implements Shape {}
            record Square(double side) implements Shape, Comparable<Square> {
                public int compareTo(Square other) { return 0; }
            }
        }
        final class Triangle implements OrderContract.Shape {}
        non-sealed interface Polygon extends Shape {}
      `)).adts).toEqual([
        { kind: "sealed-interface", name: "Shape", variants: ["Circle", "Square", "Triangle", "Polygon"] },
        { kind: "record", name: "Circle" },
        { kind: "record", name: "Square" },
      ]);
    });

    it("reads records with generic headers, compact constructors and static members", () => {
      expect(types(holder(`
        record Pair<A, B>(A left, B right) {
            Pair {
                java.util.Objects.requireNonNull(left);
            }
            static <A> Pair<A, A> twin(A value) { return new Pair<>(value, value); }
            static final String TAG = "pair";
        }
      `))).toMatchObject({ aliases: [{ name: "Pair", shape: notFn }], adts: [{ kind: "record", name: "Pair" }] });
    });
  });

  describe("literals and comments are blanked", () => {
    it("ignores braces, keywords and quotes inside comments, strings, chars and text blocks", () => {
      expect(aliasesOf(`
        // interface Fake { void x(); }
        /* } } class Broken { */
        String NOTE = "interface Ghost { void a(); } }";
        char BRACE = '}';
        char QUOTE = '\\'';
        String BLOCK = """
            interface Phantom { void p(); }
            } \\""" still inside
            """;
        /** @see Fn */
        interface Fn { void run(); /* String toString(); */ }
      `)).toEqual([{ name: "Fn", shape: fn(0) }]);
    });

    it("translates unicode escapes before lexing, everywhere in the file", () => {
      expect(types(`\\u0070ublic interface OrderContract { interface F { void run(int \\u0061); } }`)).toMatchObject({
        holder: "OrderContract",
        aliases: [{ name: "F", shape: fn(1) }],
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Implementation surface
// ---------------------------------------------------------------------------

const SKELETON = `// Skeleton written by Loom from src/main/java/com/acme/order/OrderContract.java (CT-2). Make these signatures work; keep each name and its type.
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

describe("readJavaImplementationSurface", () => {
  it("reads a canonical skeleton: package, imports, one public static final field per binding with its marker", () => {
    expect(readJavaImplementationSurface(IMPL_PATH, SKELETON)).toEqual({
      ok: true,
      value: {
        language: "java",
        path: IMPL_PATH,
        package: "com.acme.order.pricing",
        imports: ["com.acme.order.OrderContract.ParseOrderFn", "com.acme.order.OrderContract.PriceOrderFn"],
        fields: [
          { name: "priceOrder", modifiers: ["public", "static", "final"], typeToken: "PriceOrderFn", initializerStrings: ["unimplemented: priceOrder"] },
          { name: "parseOrder", modifiers: ["public", "static", "final"], typeToken: "ParseOrderFn", initializerStrings: ["unimplemented: parseOrder"] },
        ],
        localTypes: [{ name: "Pricing", kind: "class", sealed: false, permits: [] }],
      },
    });
  });

  it("reads qualified and generic type tokens, several declarators per declaration, and array dimensions", () => {
    const surface = impl(`package p;
import com.acme.order.OrderContract;
import static com.acme.order.OrderContract.*;
public final class Pricing {
    @Deprecated
    static final OrderContract.PriceOrderFn priceOrder = q -> Math.max(q, "floor".length());
    private static final java.util.Map<String, Integer> TABLE = new java.util.HashMap<String, Integer>(), EMPTY;
    int a = b < c, d = f(1, 2);
    long legacy[] = { 1, 2 };
    private final transient volatile String note;
    private Pricing() { note = "set"; }
}
`);
    expect(surface.imports).toEqual(["com.acme.order.OrderContract", "com.acme.order.OrderContract.*"]);
    expect(surface.fields).toEqual([
      { name: "priceOrder", modifiers: ["static", "final"], typeToken: "OrderContract.PriceOrderFn", initializerStrings: ["floor"] },
      { name: "TABLE", modifiers: ["private", "static", "final"], typeToken: "java.util.Map<String, Integer>", initializerStrings: [] },
      { name: "EMPTY", modifiers: ["private", "static", "final"], typeToken: "java.util.Map<String, Integer>", initializerStrings: [] },
      { name: "a", modifiers: [], typeToken: "int", initializerStrings: [] },
      { name: "d", modifiers: [], typeToken: "int", initializerStrings: [] },
      { name: "legacy", modifiers: [], typeToken: "long[]", initializerStrings: [] },
      { name: "note", modifiers: ["private", "final", "transient", "volatile"], typeToken: "String", initializerStrings: [] },
    ]);
  });

  it("reads fields only of the top-level type named after the file", () => {
    const surface = impl(`package p;
final class Helper { static final PriceOrderFn priceOrder = null; }
public final class Pricing {
    static final PriceOrderFn parseOrder = null;
    static final class Inner { static final PriceOrderFn nested = null; }
}
`);
    expect(surface.fields.map((field) => field.name)).toEqual(["parseOrder"]);
    expect(surface.localTypes.map((type) => type.name)).toEqual(["Helper", "Pricing", "Inner"]);
  });

  it("reads no field when no top-level type is named after the file", () => {
    expect(impl(`final class Helper { static final PriceOrderFn priceOrder = null; }`).fields).toEqual([]);
  });

  it("adds the implicit public static final modifiers of an interface's fields", () => {
    expect(impl(`public interface Pricing { PriceOrderFn priceOrder = q -> 0; public static PriceOrderFn other = null; }`).fields).toEqual([
      { name: "priceOrder", modifiers: ["public", "static", "final"], typeToken: "PriceOrderFn", initializerStrings: [] },
      { name: "other", modifiers: ["public", "static", "final"], typeToken: "PriceOrderFn", initializerStrings: [] },
    ]);
  });

  it("reads every declared type at any depth, member and local, with sealed and permits", () => {
    const surface = impl(`package p;
public final class Pricing {
    sealed interface Outcome permits Ok, Pricing.Bad {}
    record Ok() implements Outcome {}
    record Bad(String why) implements Outcome {}
    sealed interface Shape {}
    final class Circle implements Shape {}
    non-sealed interface Polygon extends Shape {}
    enum Mode { FAST { void go() {} }, SLOW; void go() {} }
    static Object label(int q) {
        record Line(int q) {}
        Class<?> c = String.class;
        Runnable r = () -> { class Inside {} };
        return new Line(q);
    }
    static final Runnable HOOK = new Runnable() { public void run() { interface Deep {} } };
    @interface Tag {}
}
`);
    expect(surface.localTypes).toEqual([
      { name: "Pricing", kind: "class", sealed: false, permits: [] },
      { name: "Outcome", kind: "interface", sealed: true, permits: ["Ok", "Bad"] },
      { name: "Ok", kind: "record", sealed: false, permits: [] },
      { name: "Bad", kind: "record", sealed: false, permits: [] },
      { name: "Shape", kind: "interface", sealed: true, permits: ["Circle", "Polygon"] },
      { name: "Circle", kind: "class", sealed: false, permits: [] },
      { name: "Polygon", kind: "interface", sealed: false, permits: [] },
      { name: "Mode", kind: "enum", sealed: false, permits: [] },
      { name: "Line", kind: "record", sealed: false, permits: [] },
      { name: "Inside", kind: "class", sealed: false, permits: [] },
      { name: "Deep", kind: "interface", sealed: false, permits: [] },
      { name: "Tag", kind: "interface", sealed: false, permits: [] },
    ]);
  });

  it("keeps sealed and permits on member types of anonymous class bodies and enum constant bodies", () => {
    const surface = impl(`package p;
public final class Pricing {
    static final Object HOOK = new Object() {
        sealed interface Outcome permits Ok, Bad {}
        record Ok() implements Outcome {}
        record Bad(String why) implements Outcome {}
    };
    enum Mode {
        FAST {
            sealed interface Shape {}
            final class Circle implements Shape {}
            non-sealed interface Polygon extends Shape {}
        };
    }
    static int pick(int q) {
        switch (q) { default -> { return q; } }
    }
}
`);
    expect(surface.localTypes).toEqual([
      { name: "Pricing", kind: "class", sealed: false, permits: [] },
      { name: "Outcome", kind: "interface", sealed: true, permits: ["Ok", "Bad"] },
      { name: "Ok", kind: "record", sealed: false, permits: [] },
      { name: "Bad", kind: "record", sealed: false, permits: [] },
      { name: "Mode", kind: "enum", sealed: false, permits: [] },
      { name: "Shape", kind: "interface", sealed: true, permits: ["Circle", "Polygon"] },
      { name: "Circle", kind: "class", sealed: false, permits: [] },
      { name: "Polygon", kind: "interface", sealed: false, permits: [] },
    ]);
  });

  it("keeps string and text block values in initializers, with escapes decoded and incidental whitespace stripped", () => {
    const surface = impl(`public final class Pricing {
    static final String BLOCK = """
        unimplemented: \\
        priceOrder
          indented\\s
        """;
    static final String ESCAPED = "tab\\tquote\\"slash\\\\octal\\101";
    static final PriceOrderFn priceOrder = (p0) -> { throw new UnsupportedOperationException("unimplemented: \\u0070riceOrder"); };
    static final char C = 'x';
}
`);
    expect(surface.fields.map((field) => [field.name, field.initializerStrings])).toEqual([
      ["BLOCK", ["unimplemented: priceOrder\n  indented \n"]],
      ["ESCAPED", ["tab\tquote\"slash\\octalA"]],
      ["priceOrder", ["unimplemented: priceOrder"]],
      ["C", []],
    ]);
  });

  it("reads an enum's constants, constant bodies and the members after them", () => {
    expect(impl(`public enum Pricing {
    LOW("low") { @Override String tag() { return "l"; } },
    HIGH("high"),;
    static final PriceOrderFn priceOrder = null;
    private final String label;
    Pricing(String label) { this.label = label; }
    String tag() { return label; }
}
`).fields.map((field) => field.name)).toEqual(["priceOrder", "label"]);
  });

  it("refuses an unparseable implementation file", () => {
    expect(refusal(readJavaImplementationSurface(IMPL_PATH, "public final class Pricing { void run() { }"))).toMatchObject({
      kind: "unparseable",
      path: IMPL_PATH,
    });
  });

  it("reads a file of several top-level types, which only a frozen types file refuses", () => {
    expect(impl(`class A {} public final class Pricing {} interface B {}`).localTypes.map((type) => type.name)).toEqual(["A", "Pricing", "B"]);
  });
});

// ---------------------------------------------------------------------------
// The blanking law: comments and string contents never change a declaration read
// ---------------------------------------------------------------------------

/** Fixtures as whitespace-separated chunks: comments go between chunks;
 *  `$Sn` is a string literal, `$Tn` a text block. */
const TYPES_FIXTURE = `
package com.acme.order ;
import java.util.List ;
public interface OrderContract {
  String VERSION = $S0 ;
  @FunctionalInterface interface PriceOrderFn { Price apply ( Order order , int quantity ) ; default String describe ( ) { return $S1 + $T0 ; } }
  interface ParseOrderFn { Order parse ( String raw ) ; boolean equals ( Object other ) ; }
  interface MapFn < T > { T apply ( T value ) ; }
  sealed interface OrderState permits Draft , Paid { }
  record Draft ( String id ) implements OrderState { }
  record Paid ( String id , long cents ) implements OrderState { static final String TAG = $S2 ; }
  sealed interface Shape { record Circle ( double r ) implements Shape { } record Square ( double s ) implements Shape { } }
  record Order ( String id , List < String > lines ) { }
  record Price ( long cents ) { }
  enum Currency { EUR , USD ; }
}
`;

const IMPL_FIXTURE = `
package com.acme.order.pricing ;
import com.acme.order.OrderContract.PriceOrderFn ;
import static com.acme.order.OrderContract.* ;
public final class Pricing {
  private Pricing ( ) { }
  public static final PriceOrderFn priceOrder = ( p0 , p1 ) -> { throw new UnsupportedOperationException ( $S0 ) ; } ;
  static final String NOTE = $T0 , OTHER = $S1 ;
  private static final java.util.Map < String , Integer > TABLE = new java.util.HashMap < String , Integer > ( ) ;
  static String label ( int q ) { record Line ( int q ) { } return $S2 + q ; }
  sealed interface Outcome permits Ok , Bad { }
  record Ok ( ) implements Outcome { }
  record Bad ( String why ) implements Outcome { }
}
final class Helper { static final PriceOrderFn priceOrder = null ; }
`;

const chunksOf = (fixture: string): readonly string[] => fixture.trim().split(/\s+/);

/** A Java string literal whose value is exactly `value`. */
const stringLiteral = (value: string): string =>
  `"${[...value].map((ch) => {
    if (ch === "\\") return "\\\\";
    if (ch === '"') return '\\"';
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 ? `\\${code.toString(8).padStart(3, "0")}` : ch;
  }).join("")}"`;

/** A text block whose value is exactly `value` (a single unindented line). */
const textBlock = (value: string): string => `"""\n${value}"""`;

type Literals = Readonly<{ strings: readonly string[]; blocks: readonly string[] }>;

const render = (chunks: readonly string[], literals: Literals, comments: readonly (string | null)[] = []): string =>
  chunks
    .map((chunk, index) => {
      const literal = /^\$([ST])(\d)$/.exec(chunk);
      const text = literal === null
        ? chunk
        : literal[1] === "S"
          ? stringLiteral(literals.strings[Number(literal[2])] ?? "")
          : textBlock(literals.blocks[Number(literal[2])] ?? "");
      return `${comments[index] ?? ""} ${text}`;
    })
    .join(" ")
    .concat(`${comments[chunks.length] ?? ""}\n`);

const BASE_LITERALS: Literals = { strings: ["a", "b", "c"], blocks: ["d"] };

/** Comment bodies may hold anything Java allows there, except what would end
 *  the comment early: a line terminator (line comments), `*\/` (block
 *  comments), or a unicode escape (translated before lexing, everywhere). */
const commentText = fc.oneof(
  fc.string(),
  fc.constantFrom("{", "}", "class Fake {", "interface X { void a(); }", '"', "'", '"""', "record R()", "permits A, B", "@FunctionalInterface"),
);
const comment = fc.oneof(
  commentText.filter((text) => !/[\r\n]/.test(text) && !text.includes("\\u")).map((text) => `//${text}\n`),
  commentText.filter((text) => !text.includes("*/") && !text.includes("\\u")).map((text) => `/*${text}*/`),
);
const comments = (chunks: readonly string[]) =>
  fc.array(fc.option(comment, { nil: null }), { minLength: chunks.length + 1, maxLength: chunks.length + 1 });

const stringValue = fc.oneof(
  fc.string({ unit: "binary" }),
  fc.constantFrom("{", "}", "class X {", "*/", "//", '"""', "\\u0022", "unimplemented: priceOrder", "'", "\\"),
);
const blockValue = fc.stringMatching(/^[A-Za-z0-9{}();:,.<>=+*/@'-]*$/);
const literals = fc.record({
  strings: fc.array(stringValue, { minLength: 3, maxLength: 3 }),
  blocks: fc.array(blockValue, { minLength: 1, maxLength: 1 }),
});

const withoutInitializerStrings = (surface: JavaImplementationSurface) => ({
  ...surface,
  fields: surface.fields.map(({ initializerStrings: _strings, ...field }) => field),
});

describe("the blanking law", () => {
  const typesChunks = chunksOf(TYPES_FIXTURE);
  const implChunks = chunksOf(IMPL_FIXTURE);

  it("the fixtures read as expected", () => {
    const typesBaseline = types(render(typesChunks, BASE_LITERALS));
    const implBaseline = impl(render(implChunks, BASE_LITERALS));
    expect(typesBaseline.aliases.filter((alias) => alias.shape.kind === "function").map((alias) => alias.name)).toEqual(["PriceOrderFn", "ParseOrderFn", "MapFn"]);
    expect(typesBaseline.adts).toEqual([
      { kind: "sealed-interface", name: "OrderState", variants: ["Draft", "Paid"] },
      { kind: "record", name: "Draft" },
      { kind: "record", name: "Paid" },
      { kind: "sealed-interface", name: "Shape", variants: ["Circle", "Square"] },
      { kind: "record", name: "Circle" },
      { kind: "record", name: "Square" },
      { kind: "record", name: "Order" },
      { kind: "record", name: "Price" },
    ]);
    expect(implBaseline.fields.map((field) => [field.name, field.initializerStrings])).toEqual([
      ["priceOrder", ["a"]],
      ["NOTE", ["d"]],
      ["OTHER", ["b"]],
      ["TABLE", []],
    ]);
  });

  it("comments anywhere between tokens never change the types or implementation surface", () => {
    const typesBaseline = types(render(typesChunks, BASE_LITERALS));
    const implBaseline = impl(render(implChunks, BASE_LITERALS));
    fc.assert(
      fc.property(comments(typesChunks), comments(implChunks), (typesComments, implComments) => {
        expect(types(render(typesChunks, BASE_LITERALS, typesComments))).toEqual(typesBaseline);
        expect(impl(render(implChunks, BASE_LITERALS, implComments))).toEqual(implBaseline);
      }),
      { numRuns: 200 },
    );
  });

  it("string and text block contents never change a declaration read, and initializer strings are exactly their values", () => {
    const typesBaseline = types(render(typesChunks, BASE_LITERALS));
    const implBaseline = impl(render(implChunks, BASE_LITERALS));
    fc.assert(
      fc.property(literals, (values) => {
        expect(types(render(typesChunks, values))).toEqual(typesBaseline);
        const read = impl(render(implChunks, values));
        expect(withoutInitializerStrings(read)).toEqual(withoutInitializerStrings(implBaseline));
        expect(read.fields.map((field) => field.initializerStrings)).toEqual([[values.strings[0]], [values.blocks[0]], [values.strings[1]], []]);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Module shape: two entry points, every function within the full-tier bound
// ---------------------------------------------------------------------------

describe("the java-surface module", () => {
  const SOURCE_PATH = new URL("../../src/core/skeleton/java-surface.ts", import.meta.url);

  it("exports exactly the two readers", () => {
    expect(Object.keys(javaSurface).sort()).toEqual(["readJavaImplementationSurface", "readJavaTypesSurface"]);
  });

  it("keeps every function within the full-tier max-function-lines bound", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    expect(maxFunctionLines(source, "engine/src/core/skeleton/java-surface.ts", DEFAULT_MAX_FUNCTION_LINES_OPTIONS).map((violation) => violation.fixHint)).toEqual([]);
  });
});
