/**
 * The shipped regex rules in `lint-rules/`, each run through the production
 * loader and executor over a fixture table: lines the rule exists to refuse,
 * lines that look alike and must pass, the extensions it reads, and the test
 * files it exempts. A regex rule drifts in both directions — a pattern widened
 * into false positives gets disabled, one narrowed into false negatives passes
 * silently — so both directions are pinned.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeRules } from "../../src/linter/executor";
import { loadRules } from "../../src/linter/loader";
import type { Rule } from "../../src/linter/types";
import { REPO_ROOT } from "./loom-project-config";

const SHIPPED_RULES = loadRules(join(REPO_ROOT, "lint-rules"), null, "full", { includeProgrammatic: false });

const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
const JAVASCRIPT_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"] as const;

/** Every test-file spelling of the given extensions: `.test.` and `.spec.` before each. */
const testSuffixes = (extensions: readonly string[]): readonly string[] =>
  ["test", "spec"].flatMap((kind) => extensions.map((extension) => `.${kind}${extension}`));

function shippedRule(name: string): Rule {
  const rule = SHIPPED_RULES.find((candidate) => candidate.name === name);
  if (rule === undefined) throw new Error(`no shipped rule named ${name}`);
  return rule;
}

/** The lines of `content` the rule flags in `filePath`, 1-based. */
const flaggedLines = (rule: Rule, filePath: string, content: string): readonly number[] =>
  executeRules([rule], filePath, content, () => undefined).map(({ line }) => line);

/** Refused spellings assembled from pieces, so this file's own source never carries one. */
const AS_ANY = `as${" "}any`;
const EMPTY_BLOCK = `{${"}"}`;

type FixtureRow = Readonly<{
  rule: string;
  extensions: readonly string[];
  refused: readonly string[];
  allowed: readonly string[];
}>;

const FIXTURES: readonly FixtureRow[] = [
  {
    rule: "no-non-null-assertion",
    extensions: TYPESCRIPT_EXTENSIONS,
    refused: [
      "const name = users[0]!.name;",
      "use(value!);",
      "const entry = map.get(key)!;",
      "const first = rows![0];",
      "const total = call()!.length;",
      "const pair = { left: left!, right };",
      "let ready!: boolean;",
      "const items = [a!, b];",
    ],
    allowed: [
      "if (a !== b) return;",
      "if (a!==b) return;",
      "if (x != null) go();",
      "if (!flag) stop();",
      "const negated = !(a && b);",
      "throw new Error(\"Done!\");",
      "const greeting = `Hello! ${name}`;",
      "const bang = '!';",
    ],
  },
  {
    rule: "no-unsafe-as-any",
    extensions: TYPESCRIPT_EXTENSIONS,
    refused: [
      `const loose = value ${AS_ANY};`,
      `(input ${AS_ANY}).field = 1;`,
      `const list = raw ${AS_ANY}[];`,
      `return parse(text) as ${AS_ANY.slice(2)};`,
    ],
    allowed: [
      "const strict = value as unknown as Order;",
      "const typed = value as AnyOrder;",
      "const tag = value as anything;",
      "const fact = order.has(anyItem);",
      "const known = value as Order;",
    ],
  },
  {
    rule: "no-catch-ignore",
    extensions: [...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS],
    refused: [
      `try { run(); } catch ${EMPTY_BLOCK}`,
      `try { run(); } catch (error) ${EMPTY_BLOCK}`,
      `} catch (error) { ${EMPTY_BLOCK.slice(1)}`,
      `} catch (_error: unknown) ${EMPTY_BLOCK}`,
    ],
    allowed: [
      "} catch (error) { report(error); }",
      "} catch (error) { if (!isMissing(error)) throw error; }",
      "} catch (error) {",
      "const caught = catchAll;",
    ],
  },
  {
    rule: "no-console-log",
    extensions: TYPESCRIPT_EXTENSIONS,
    refused: ["console.log(value);", "  console.log(\"debug\", value);"],
    allowed: ["console.error(value);", "const hint = \"console.log(\";", "logger.log(value);"],
  },
];

describe("shipped regex rules: what each refuses and what it spares", () => {
  describe.each(FIXTURES)("$rule", ({ rule: name, extensions, refused, allowed }) => {
    const rule = shippedRule(name);

    it("reads exactly the extensions its language uses", () => {
      expect([...rule.extensions].sort()).toEqual([...extensions].sort());
    });

    it.each(extensions)("refuses every refused line in a production %s file", (extension) => {
      const content = refused.join("\n");
      expect(flaggedLines(rule, `/work/shop/src/domain/order${extension}`, content))
        .toEqual(refused.map((_line, index) => index + 1));
    });

    it.each(allowed)("spares %s", (line) => {
      expect(flaggedLines(rule, "/work/shop/src/domain/order.ts", line)).toEqual([]);
    });
  });
});

describe("shipped regex rules: one test-file exemption list", () => {
  it.each([
    ["no-non-null-assertion", TYPESCRIPT_EXTENSIONS],
    ["no-console-log", TYPESCRIPT_EXTENSIONS],
    ["no-todo-fixme", [...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS]],
  ] as const)("%s exempts every test spelling of every extension it reads", (name, extensions) => {
    const rule = shippedRule(name);
    expect([...rule.extensions].sort()).toEqual([...extensions].sort());
    const exempt = rule.kind === "regex" ? rule.excludePatterns ?? [] : [];
    expect(exempt.filter((pattern) => /\.(test|spec)\./.test(pattern)).sort()).toEqual([...testSuffixes(extensions)].sort());
  });

  it("an exempt test file is never flagged, and the same line in production is", () => {
    const rule = shippedRule("no-non-null-assertion");
    for (const suffix of testSuffixes(TYPESCRIPT_EXTENSIONS)) {
      expect(flaggedLines(rule, `/work/shop/src/order${suffix}`, "use(value!);"), suffix).toEqual([]);
    }
    expect(flaggedLines(rule, "/work/shop/src/order.mts", "use(value!);")).toEqual([1]);
  });

  it("no-console-log keeps its one stdout-contract script exempt by name, and only that one", () => {
    const rule = shippedRule("no-console-log");
    expect(flaggedLines(rule, "/work/shop/scripts/lint-project.ts", "console.log(report);")).toEqual([]);
    expect(flaggedLines(rule, "/work/shop/scripts/other-tool.ts", "console.log(report);")).toEqual([1]);
  });
});
