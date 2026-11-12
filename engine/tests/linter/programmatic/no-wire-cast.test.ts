/**
 * no-wire-cast pins BOTH directions: every shape that names a type for
 * `JSON.parse` / `.json()` output without parsing it, and every shape that is
 * already honest — a rule that fires on a parser's own `: unknown` binding gets
 * disabled, which is worse than not having the rule.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_WIRE_CAST_OPTIONS,
  FIX_HINT,
  RULE_NAME,
  detectedWireCastKeys,
  handler as noWireCast,
} from "../../../src/linter/programmatic/no-wire-cast";
import { baselineKey, unusedBaselineEntries, type Baseline } from "../../../src/linter/programmatic/baseline";

const FILE = "src/orders/load-order.ts";
const NO_BASELINE: Baseline = [];
/** The widest type, spelled apart from the fixtures so they hold no real assertion to it. */
const ANY = "any";

const lint = (source: string, filePath: string = FILE, baseline: Baseline = NO_BASELINE, projectRoot: string | null = null) =>
  noWireCast(source, filePath, { ...DEFAULT_WIRE_CAST_OPTIONS, baseline, projectRoot });

/** What each violation says and where, without the shared fix hint. */
const reported = (source: string): readonly (readonly [number, string])[] =>
  lint(source).map(({ line, fixHint }) => [line, fixHint.slice(0, fixHint.indexOf(`. ${FIX_HINT}`))] as const);

describe("no-wire-cast: refused shapes", () => {
  it.each([
    ["an assertion on JSON.parse", "const order = JSON.parse(text) as Order;", "JSON.parse output is asserted `as Order` without being parsed"],
    ["an assertion to `any`", `const order = JSON.parse(text) as ${ANY};`, `JSON.parse output is asserted \`as ${ANY}\` without being parsed`],
    ["an assertion to an object type", "const head = JSON.parse(text) as { kind?: unknown };", "JSON.parse output is asserted `as { kind?: unknown }` without being parsed"],
    ["an assertion to an array of unknown", "const rows = JSON.parse(text) as unknown[];", "JSON.parse output is asserted `as unknown[]` without being parsed"],
    ["an assertion to a union", "const line = JSON.parse(text) as Order | Refund;", "JSON.parse output is asserted `as Order | Refund` without being parsed"],
    ["a chain that leaves unknown again", "const order = JSON.parse(text) as unknown as Order;", "JSON.parse output is asserted `as Order` without being parsed"],
    ["an assertion on an awaited .json() in parentheses", "const order = (await response.json()) as Order;", ".json() output is asserted `as Order` without being parsed"],
    ["an assertion on an awaited .json()", "const order = await response.json() as Order;", ".json() output is asserted `as Order` without being parsed"],
    ["an assertion on .json() itself", "const pending = response.json() as Promise<Order>;", ".json() output is asserted `as Promise<Order>` without being parsed"],
    ["an assertion on an optional .json() call", "const order = (await reply?.json()) as Order;", ".json() output is asserted `as Order` without being parsed"],
    ["an assertion inside doubled parentheses", "const order = ((JSON.parse(text))) as Order;", "JSON.parse output is asserted `as Order` without being parsed"],
    ["an assertion in return position", "return JSON.parse(text) as Order;", "JSON.parse output is asserted `as Order` without being parsed"],
    ["an assertion before a member read", "const id = (JSON.parse(text) as Order).id;", "JSON.parse output is asserted `as Order` without being parsed"],
    ["an assertion passed as an argument", "save(JSON.parse(text) as Order);", "JSON.parse output is asserted `as Order` without being parsed"],
    ["an assertion in a ternary arm", "const order = ready ? JSON.parse(text) as Order : fallback;", "JSON.parse output is asserted `as Order` without being parsed"],
    ["an assertion before a fallback", "const order = JSON.parse(text) as Order ?? fallback;", "JSON.parse output is asserted `as Order` without being parsed"],
    ["an assertion on a deep clone", "const copy = JSON.parse(JSON.stringify(order)) as Order;", "JSON.parse output is asserted `as Order` without being parsed"],
    ["an annotated const", "const order: Order = JSON.parse(text);", "JSON.parse output is bound to `order: Order` without being parsed"],
    ["an annotated let", "let order: Order | null = JSON.parse(text);", "JSON.parse output is bound to `order: Order | null` without being parsed"],
    ["an annotated var", `var order: ${ANY} = JSON.parse(text);`, `JSON.parse output is bound to \`order: ${ANY}\` without being parsed`],
    ["an annotated const of a generic type", "const byId: Map<string, Order> = JSON.parse(text);", "JSON.parse output is bound to `byId: Map<string, Order>` without being parsed"],
    ["an annotated const of a function type", "const run: (id: string) => Order = JSON.parse(text);", "JSON.parse output is bound to `run: (id: string) => Order` without being parsed"],
    ["an annotated const from an awaited .json()", "const order: Order = await response.json();", ".json() output is bound to `order: Order` without being parsed"],
    ["an annotated const from a parenthesised await", "const order: Order = (await response.json());", ".json() output is bound to `order: Order` without being parsed"],
    ["an annotated const from a fetch chain", "const order: Order = await (await fetch(url)).json();", ".json() output is bound to `order: Order` without being parsed"],
    ["an annotated promise of a type", "const pending: Promise<Order> = response.json();", ".json() output is bound to `pending: Promise<Order>` without being parsed"],
    ["an annotated destructuring", "const { id, total }: Order = JSON.parse(text);", "JSON.parse output is bound to `{ id, total }: Order` without being parsed"],
    ["a definite-assignment declaration", "let order!: Order;\norder = JSON.parse(text);", "JSON.parse output is assigned to `order`, declared `Order`, without being parsed"],
  ])("refuses %s", (_shape, source, message) => {
    expect(reported(source)).toEqual([[source.split("\n").length, message]]);
  });

  it.each([
    ["in a try block", "let order: Order;\ntry {\n  order = JSON.parse(text);\n} catch {\n  return null;\n}", 3],
    ["without semicolons", "let order: Order\ntry {\n  order = JSON.parse(text)\n} catch {\n  return null\n}", 3],
    ["after an else", "let order: Order;\nif (cached) order = cached;\nelse order = JSON.parse(text);", 3],
    ["through a logical assignment", "let order: Order | undefined;\norder ??= JSON.parse(text);", 2],
    ["from an awaited .json()", "let order: Order;\norder = await response.json();", 2],
    ["in a nested function that closes over the declaration", "let order: Order;\nconst load = () => {\n  order = JSON.parse(text);\n};", 3],
  ])("refuses an assignment to a name declared with a type, %s", (_where, source, line) => {
    expect(reported(source)).toEqual([[line, expect.stringContaining("output is assigned to `order`, declared `Order")]]);
  });

  it("judges an assignment by the NEAREST declaration its block can see", () => {
    const shadowed = [
      "let raw: Order;",
      "function load(text: string): unknown {",
      "  let raw: unknown;",
      "  raw = JSON.parse(text);",
      "  return raw;",
      "}",
    ].join("\n");
    expect(lint(shadowed)).toEqual([]);

    const sibling = [
      "function first(text: string): unknown {",
      "  let raw: unknown;",
      "  raw = JSON.parse(text);",
      "  return raw;",
      "}",
      "let raw: Order;",
      "raw = JSON.parse(text);",
    ].join("\n");
    expect(reported(sibling)).toEqual([[7, "JSON.parse output is assigned to `raw`, declared `Order`, without being parsed"]]);

    // The inner `unknown` declaration's block has closed: the outer one governs again.
    const closed = [
      "let raw: Order;",
      "{",
      "  let raw: unknown;",
      "  raw = JSON.parse(text);",
      "}",
      "raw = JSON.parse(text);",
    ].join("\n");
    expect(reported(closed)).toEqual([[6, "JSON.parse output is assigned to `raw`, declared `Order`, without being parsed"]]);
  });

  it.each([
    ["the type on later lines", "const order = JSON.parse(text) as {\n  id: string;\n  total: number;\n};", 1, "asserted `as { id: string; total: number; }`"],
    ["the argument over several lines", "const order = JSON.parse(\n  readFileSync(path, \"utf-8\"),\n) as Order;", 1, "asserted `as Order`"],
    ["`as` on the next line", "const order = JSON.parse(text)\n  as Order;", 1, "asserted `as Order`"],
    ["a chain broken across lines", "const order = JSON.parse(text) as unknown\n  as Order;", 1, "asserted `as Order`"],
    ["a union with leading bars", "const line = JSON.parse(text) as\n  | Order\n  | Refund;", 1, "asserted `as | Order | Refund`"],
    ["an awaited chain", "const order = (await fetch(url)\n  .then((reply) => reply)\n  .json()) as Order;", 3, "asserted `as Order`"],
    ["the initializer on the next line", "const order: Order =\n  JSON.parse(text);", 2, "bound to `order: Order`"],
    ["the annotation over several lines", "const order: {\n  id: string;\n} = JSON.parse(text);", 3, "bound to `order: { id: string; }`"],
    ["the awaited call on the next line", "const order: Order = await response\n  .json();", 2, "bound to `order: Order`"],
  ])("catches a multi-line form: %s", (_shape, source, line, message) => {
    expect(reported(source)).toEqual([[line, expect.stringContaining(message)]]);
  });

  it("reports each site once, on its own line, with the line as written and the fix", () => {
    const source = [
      "export function load(text: string): Order {",
      "  const head = JSON.parse(text) as Head; // trusted",
      "  const order: Order = JSON.parse(text);",
      "  return order;",
      "}",
    ].join("\n");
    expect(lint(source)).toEqual([
      {
        rule: RULE_NAME,
        file: FILE,
        line: 2,
        text: "const head = JSON.parse(text) as Head; // trusted",
        fixHint: `JSON.parse output is asserted \`as Head\` without being parsed. ${FIX_HINT}`,
      },
      {
        rule: RULE_NAME,
        file: FILE,
        line: 3,
        text: "const order: Order = JSON.parse(text);",
        fixHint: `JSON.parse output is bound to \`order: Order\` without being parsed. ${FIX_HINT}`,
      },
    ]);
    expect(FIX_HINT).toContain("unknown");
    expect(FIX_HINT).toContain("parser or decoder");
  });

  it("quotes a long type on one line and bounded", () => {
    const type = `{ ${Array.from({ length: 30 }, (_, index) => `field${index}: string`).join("; ")} }`;
    const [violation] = lint(`const wide = JSON.parse(text) as ${type};`);
    expect(violation?.fixHint).toContain(`\`as ${type.slice(0, 80)}…\``);
  });
});

describe("no-wire-cast: allowed shapes", () => {
  it.each([
    ["an `as unknown` assertion", "const raw = JSON.parse(text) as unknown;"],
    ["a doubled `as unknown`", "const raw = JSON.parse(text) as unknown as unknown;"],
    ["an `as unknown` before a fallback", "const raw = JSON.parse(text) as unknown ?? null;"],
    ["an `as unknown` in return position, without a semicolon", "return JSON.parse(text) as unknown\n"],
    ["an `: unknown` const", "const raw: unknown = JSON.parse(text);"],
    ["an `: unknown` const from .json()", "const raw: unknown = await response.json();"],
    ["a promise of unknown", "const pending = response.json() as Promise<unknown>;"],
    ["an annotated promise of unknown", "const pending: Promise<unknown> = response.json();"],
    ["an assignment to an unknown-declared name", "let raw: unknown;\ntry {\n  raw = JSON.parse(text);\n} catch {\n  return null;\n}"],
    ["the same without semicolons", "let raw: unknown\ntry {\n  raw = JSON.parse(text)\n} catch {\n  return null\n}"],
    ["the call in argument position", "const order = parseOrder(JSON.parse(text));"],
    ["the call in argument position of an annotated binding", "const order: Order = parseOrder(JSON.parse(text));"],
    ["an awaited .json() in argument position", "const order: Order = decodeOrder(await response.json());"],
    ["an assertion on the PARSER's result", "const order = parseOrder(JSON.parse(text)) as Order;"],
    ["the call in a generic call's argument position", "const order: Order = decode<Order>(JSON.parse(text));"],
    ["the call as one of several arguments", "const order: Order = decode(schema, JSON.parse(text), options);"],
    ["the call inside an object literal passed to a parser", "const order: Order = decode({ value: JSON.parse(text) });"],
    ["a comparison against the parsed value", "const same: boolean = stored === JSON.parse(text);"],
    ["a generic naming the call's text", "type Parsed = ReturnType<typeof JSON.parse>;\nconst cache: Map<string, Order> = new Map();"],
    ["a .json() call that takes arguments", "const sent: Reply = reply.json(body);\nconst made = Response.json(body) as Reply;"],
    ["a method that only ends in json", "const text: string = report.toJson();"],
    ["JSON.parse passed as a function", "const rows = lines.map(JSON.parse);"],
    ["a name that only ends in JSON", "const order: Order = myJSON.parse(text);"],
    ["a file that names neither call", "export const total = (order: Order): number => order.total;"],
  ])("accepts %s", (_shape, source) => {
    expect(lint(source)).toEqual([]);
  });

  it.each([
    ["a double-quoted string", `const note = "JSON.parse(text) as Order";`],
    ["a single-quoted string", `const note = 'const order: Order = JSON.parse(text);';`],
    ["a template literal", "const note = `write JSON.parse(text) as Order here`;"],
    ["a multi-line template literal", "const note = `\n  const order: Order = JSON.parse(text);\n`;"],
    ["a line comment", "// const order = JSON.parse(text) as Order;"],
    ["a block comment", "/* const order: Order = (await response.json()) as Order; */"],
    ["a doc comment", "/**\n * Never write `JSON.parse(text) as Order`.\n */\nexport const x = 1;"],
    ["a regex literal", "const shape = /JSON\\.parse\\(text\\) as Order/;"],
  ])("reads no site inside %s", (_where, source) => {
    expect(lint(source)).toEqual([]);
  });

  it("still reads the code of a template's interpolation, and only that", () => {
    expect(reported("const note = `id ${(JSON.parse(text) as Order).id}`;"))
      .toEqual([[1, "JSON.parse output is asserted `as Order` without being parsed"]]);
    expect(lint("const note = `${id}: JSON.parse(text) as Order`;")).toEqual([]);
  });

  it("is not thrown off by brackets and quotes inside strings, comments and regex literals around a site", () => {
    const source = [
      `const open = "(((";`,
      `const shape = /[)(]\\(/; // ) ) )`,
      `const order = (JSON.parse(text)) as Order; /* ( */`,
      `const raw: unknown = JSON.parse(")");`,
    ].join("\n");
    expect(reported(source)).toEqual([[3, "JSON.parse output is asserted `as Order` without being parsed"]]);
  });

  it("does not read the line above a semicolon-free statement as part of it", () => {
    const source = ["const ready: Order = cached()", "response.json()", "const raw: unknown = JSON.parse(text)"].join("\n");
    expect(lint(source)).toEqual([]);
  });

  it("leaves to the type checker what only it can see", () => {
    // The limits ADR-0072 states: none of these is a site.
    expect(lint("const order = JSON.parse(text);")).toEqual([]);
    expect(lint("function schema(): JsonSchema {\n  return JSON.parse(schemaBytes);\n}")).toEqual([]);
    expect(lint("const id: string = JSON.parse(text).id;")).toEqual([]);
    expect(lint("const rows: Row[] = JSON.parse(text) ?? [];")).toEqual([]);
    expect(lint("let order: Order;\norder = (await response.json())\n  .order;")).toEqual([]);
    expect(lint("class Cache {\n  private order: Order = JSON.parse(text);\n}")).toEqual([]);
    expect(lint("function load(order: Order = JSON.parse(text)): Order {\n  return order;\n}")).toEqual([]);
  });

  it.each(["src/orders/load-order.test.ts", "src/orders/load-order.spec.ts", "src/orders/load-order.test.tsx"])(
    "ignores the test file %s",
    (path) => {
      expect(lint("const order = JSON.parse(text) as Order;", path)).toEqual([]);
      expect(detectedWireCastKeys("const order = JSON.parse(text) as Order;", path)).toEqual([]);
    },
  );
});

describe("no-wire-cast baseline", () => {
  const TWO_SITES = "const head = JSON.parse(text) as Head;\nconst order: Order = await response.json();";

  it("keys a site by the type it was given, and the name it was bound to", () => {
    expect(detectedWireCastKeys(TWO_SITES, FILE)).toEqual([baselineKey(FILE, "as Head"), baselineKey(FILE, "order: Order")]);
    expect(detectedWireCastKeys("let order: Order;\norder = JSON.parse(text);", FILE)).toEqual([baselineKey(FILE, "order: Order")]);
  });

  it("spends one entry per site, so a second site of the same shape still fails", () => {
    const twice = "const head = JSON.parse(a) as Head;\nconst tail = JSON.parse(b) as Head;";
    expect(lint(twice, FILE, [baselineKey(FILE, "as Head")]).map(({ line }) => line)).toEqual([2]);
    expect(lint(twice, FILE, [baselineKey(FILE, "as Head"), baselineKey(FILE, "as Head")])).toEqual([]);
  });

  it("keys an absolute path relative to the project root, and excuses nothing through a key it cannot make relative", () => {
    const baseline = [baselineKey(FILE, "as Head"), baselineKey(FILE, "order: Order")];
    expect(lint(TWO_SITES, `/work/shop/${FILE}`, baseline, "/work/shop")).toEqual([]);
    expect(lint(TWO_SITES, `/work/shop/${FILE}`, baseline)).toHaveLength(2);
    expect(lint(TWO_SITES, `/elsewhere/${FILE}`, baseline, "/work/shop")).toHaveLength(2);
    expect(detectedWireCastKeys(TWO_SITES, `/work/shop/${FILE}`, { baseline: [], projectRoot: "/work/shop" })).toEqual(baseline);
  });

  it("reports a baselined site's entry unused once the value is parsed", () => {
    const baseline = [baselineKey(FILE, "as Head")];
    const parsed = "const head = parseHead(JSON.parse(text));";
    expect(unusedBaselineEntries({ detected: detectedWireCastKeys("const head = JSON.parse(text) as Head;", FILE), baseline })).toEqual([]);
    expect(lint(parsed, FILE, baseline)).toEqual([]);
    expect(unusedBaselineEntries({ detected: detectedWireCastKeys(parsed, FILE), baseline })).toEqual(baseline);
  });
});

/** A wire call as it is written, each reading `text` or `response`. */
const wireCall = fc.constantFrom(
  "JSON.parse(text)",
  "JSON.parse(readFileSync(path, encoding))",
  "JSON.parse(JSON.stringify(value))",
  "await response.json()",
  "(await response.json())",
  "await (await fetch(url)).json()",
);

/** A type that is not `unknown`. */
const namedType = fc.constantFrom(
  "Order",
  ANY,
  "Record<string, unknown>",
  "{ id: string; total?: number }",
  "readonly Order[]",
  "Order | Refund",
  "Map<string, Order[]>",
  "(id: string) => Order",
);

type Form = (name: string, wire: string, type: string) => string;

/** One-line statements the rule refuses, binding `name`. */
const REFUSED_FORMS: readonly Form[] = [
  (name, wire, type) => `const ${name} = ${wire} as ${type};`,
  (name, wire, type) => `const ${name} = ${wire} as unknown as ${type};`,
  (name, wire, type) => `const ${name}: ${type} = ${wire};`,
  (name, wire, type) => `let ${name}: ${type}; ${name} = ${wire};`,
  (name, wire, type) => `save(${name}, ${wire} as ${type});`,
];

/** One-line statements the rule accepts, binding `name`. */
const ALLOWED_FORMS: readonly Form[] = [
  (name, wire) => `const ${name}: unknown = ${wire};`,
  (name, wire) => `const ${name} = ${wire} as unknown;`,
  (name, wire) => `let ${name}: unknown; ${name} = ${wire};`,
  (name, wire, type) => `const ${name}: ${type} = parse(${wire});`,
  (name, wire, type) => `const ${name} = decode(schema, ${wire}) as ${type};`,
  (name, wire) => `const ${name} = ${wire};`,
];

const statementOf = (forms: readonly Form[]) =>
  fc.tuple(fc.constantFrom(...forms), wireCall, namedType).map(([form, wire, type]) => ({ form, wire, type }));

/** Text that is not code, holding `snippet` (one line, no quote or backtick). */
const nonCode = fc.constantFrom<(snippet: string) => string>(
  (snippet) => `const note = "${snippet}";`,
  (snippet) => `const note = '${snippet}';`,
  (snippet) => `const note = \`${snippet}\`;`,
  (snippet) => `const note = \`\n  ${snippet}\n\`;`,
  (snippet) => `// ${snippet}`,
  (snippet) => `/* ${snippet} */`,
  (snippet) => `/**\n * ${snippet}\n */`,
  (snippet) => `call(); // ${snippet}`,
);

/** A block of code around a program: each keeps every statement inside it code. */
const wrapper = fc.constantFrom<(program: string) => string>(
  (program) => `export function load(text: string): void {\n${program}\n}`,
  (program) => `export const load = async (response: Response): Promise<void> => {\n${program}\n};`,
  (program) => `class Loader {\n  async load(text: string): Promise<void> {\n${program}\n  }\n}`,
  (program) => `if (ready) {\n${program}\n}`,
  (program) => `try {\n${program}\n} catch (error) {\n  report(error);\n}`,
  (program) => `namespace wire {\n${program}\n}`,
  (program) => `for (const text of texts) {\n${program}\n}`,
  (program) => `const before = "(";\n${program}\nconst after = \`)\`; // (`,
);

const wrapped = (program: string, wrappers: readonly ((program: string) => string)[]): string =>
  wrappers.reduce((inner, wrap) => wrap(inner), program);

describe("no-wire-cast properties", () => {
  it("flags every refused form, whatever the wire call and the type", () => {
    fc.assert(fc.property(statementOf(REFUSED_FORMS), ({ form, wire, type }) => {
      expect(lint(form("value", wire, type))).toHaveLength(1);
    }));
  });

  it("never fires on a refused form embedded in a string, a template or a comment", () => {
    fc.assert(fc.property(statementOf(REFUSED_FORMS), nonCode, fc.array(wrapper, { maxLength: 2 }), ({ form, wire, type }, embed, wrappers) => {
      expect(lint(wrapped(embed(form("value", wire, type)), wrappers))).toEqual([]);
    }));
  });

  it("never fires on a program of allowed forms, however it is wrapped", () => {
    fc.assert(fc.property(
      fc.array(statementOf(ALLOWED_FORMS), { minLength: 1, maxLength: 6 }),
      fc.array(wrapper, { maxLength: 4 }),
      (statements, wrappers) => {
        const program = statements.map(({ form, wire, type }, index) => form(`value${index}`, wire, type)).join("\n");
        expect(lint(wrapped(program, wrappers))).toEqual([]);
      },
    ));
  });

  it("flags exactly the refused statements of a mixed program, however it is wrapped", () => {
    fc.assert(fc.property(
      fc.array(fc.oneof(
        statementOf(REFUSED_FORMS).map((statement) => ({ ...statement, refused: true })),
        statementOf(ALLOWED_FORMS).map((statement) => ({ ...statement, refused: false })),
      ), { maxLength: 8 }),
      fc.array(wrapper, { maxLength: 4 }),
      (statements, wrappers) => {
        const program = statements.map(({ form, wire, type }, index) => form(`value${index}`, wire, type)).join("\n");
        const source = wrapped(program, wrappers);
        const before = source.indexOf(program) === -1 ? 0 : source.slice(0, source.indexOf(program)).split("\n").length - 1;
        const expected = statements.flatMap(({ refused }, index) => (refused ? [before + index + 1] : []));
        expect(lint(source).map(({ line }) => line)).toEqual(expected);
        expect(detectedWireCastKeys(source, FILE)).toHaveLength(expected.length);
      },
    ));
  });

  it("hides at most one violation per baseline entry", () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom(baselineKey(FILE, "as Head"), baselineKey(FILE, "as Tail")), { maxLength: 5 }),
      (baseline: Baseline) => {
        const source = "const a = JSON.parse(x) as Head;\nconst b = JSON.parse(y) as Head;";
        const spent = Math.min(2, baseline.filter((key) => key === baselineKey(FILE, "as Head")).length);
        expect(lint(source, FILE, baseline)).toHaveLength(2 - spent);
        expect(unusedBaselineEntries({ detected: detectedWireCastKeys(source, FILE), baseline })).toHaveLength(baseline.length - spent);
      },
    ));
  });

  it("never throws, whatever the text", () => {
    const fragment = fc.constantFrom(
      "JSON.parse(", ".json()", "?.json()", " as ", "unknown", "const x: ", "let x", " = ", "await ", "(", ")", "{", "}", "[", "]",
      "<", ">", "=>", "\n", ";", ",", "\"", "'", "`", "${", "//", "/*", "*/", "/", "\\", "x", "|", "?", ":", "!", ".",
    );
    fc.assert(fc.property(fc.array(fragment, { maxLength: 80 }).map((parts) => parts.join("")), (source) => {
      expect(() => lint(source)).not.toThrow();
      expect(detectedWireCastKeys(source, FILE)).toHaveLength(lint(source).length);
    }), { numRuns: 2000 });
    fc.assert(fc.property(fc.string({ maxLength: 240 }), (source) => {
      expect(() => lint(`JSON.parse(${source}`)).not.toThrow();
    }));
  });
});

/**
 * The cost of the rule, pinned as RATIOS between runs on the same machine, never as a wall-clock deadline:
 * machine speed and load cancel out of a ratio, and an absolute bound (a 2,100-line file under the hook's
 * 50 ms) failed once on a loaded CI runner with no regression in the rule. ADR-0072 states what these
 * pin and what they do not. The early exit for a file that never mentions JSON is pinned by watching
 * the lexer (`no-wire-cast.early-exit.test.ts`), not by timing.
 */
describe("no-wire-cast cost", () => {
  /** Each generated function: seven lines, three wire calls, two of them sites (the `as Head` and the typed assignment). */
  const LINES_PER_FUNCTION = 7;
  const SITES_PER_FUNCTION = 2;
  /** 2,100 lines with 600 sites: a large source file of the shape ADR-0072 measured. */
  const FUNCTIONS = 300;
  /** How many times larger the second file of the growth check is. */
  const GROWTH = 8;
  /** Runs per measurement: each job's cost is the fastest of them, the rule's cost and not the machine's. */
  const RUNS = 5;
  const fileOf = (functions: number): string => Array.from({ length: functions }, (_, index) => [
    `export function load${index}(text: string, response: Response): Order {`,
    `  const raw: unknown = JSON.parse(text); // not "JSON.parse(text) as Order"`,
    `  const head = JSON.parse(text) as Head${index};`,
    `  let order: Order;`,
    `  order = JSON.parse(readFileSync(\`\${text}/order-${index}.json\`, "utf-8"));`,
    `  return parseOrder(raw, head, order, /[(]\\d+[)]/.test(text));`,
    `}`,
  ].join("\n")).join("\n");
  const LARGE = fileOf(FUNCTIONS);

  /** The milliseconds one run of `job` takes. */
  const timed = (job: () => void): number => {
    const started = performance.now();
    job();
    return performance.now() - started;
  };

  /**
   * The fastest of `RUNS` runs of each job, the jobs taken in alternation so that drift and warm-up fall
   * on all of them alike. One untimed run of each comes first: the first call pays for compiling the rule.
   */
  const fastestOf = (jobs: readonly (() => void)[]): readonly number[] => {
    for (const job of jobs) job();
    const runs = Array.from({ length: RUNS }, () => jobs.map(timed));
    return jobs.map((_, index) => Math.min(...runs.map((run) => run[index])));
  };

  /** A run of the rule over a generated file of `functions` functions that checks it found every site. */
  const findsEverySite = (source: string, functions: number) => (): void => {
    expect(lint(source)).toHaveLength(functions * SITES_PER_FUNCTION);
  };

  it(`reads a ${(FUNCTIONS * LINES_PER_FUNCTION).toLocaleString("en-US")}-line file with ${FUNCTIONS * SITES_PER_FUNCTION} sites, each on its own line`, () => {
    expect(LARGE.split("\n")).toHaveLength(FUNCTIONS * LINES_PER_FUNCTION);
    findsEverySite(LARGE, FUNCTIONS)();
    expect(lint(LARGE).at(-1)?.line).toBe(FUNCTIONS * LINES_PER_FUNCTION - 2);
  });

  it(`grows linearly with the file: ${GROWTH} times the text costs under ${GROWTH * 3} times the time`, () => {
    // A linear scan pays about 8×, a scan gone quadratic 64×: the bound sits three times above the one
    // and well under half of the other, so neither noise nor a quadratic regression is close to it.
    const grown = fileOf(FUNCTIONS * GROWTH);
    const [once, grownCost] = fastestOf([findsEverySite(LARGE, FUNCTIONS), findsEverySite(grown, FUNCTIONS * GROWTH)]);
    expect(grownCost).toBeLessThan(once * GROWTH * 3);
  });
});
