/**
 * The matrix test's tsconfig `paths` (ADR-0035), resolved in the pure core
 * over an injected read and an injected JSONC parser: the nearest config,
 * `extends` chains (relative and beneath `node_modules`), `baseUrl` against
 * the declaring config, and every refusal that leaves the aliases unknown.
 */

import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { failure, success } from "../../src/core/orchestration-contract/identity";
import {
  directoryOf,
  extendedConfig,
  nearestTsconfig,
  pathAliasesOf,
  within,
  type ParseJsonc,
} from "../../src/core/owner-verification/tsconfig-paths";

/** The runner's adapter shape, over the same package. */
const jsonc: ParseJsonc = (text) => {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.length === 0 ? success(value) : failure(errors.map((error) => printParseErrorCode(error.error)).join(", "));
};

const readerOf = (files: Readonly<Record<string, string>>) => (path: string): string | null => files[path] ?? null;

const aliasesOver = (matrixTest: string, files: Readonly<Record<string, string>>) =>
  pathAliasesOf(matrixTest, readerOf(files), jsonc);

describe("pathAliasesOf", () => {
  it("makes the nearest tsconfig's paths repository-relative through baseUrl, reading JSONC and following a relative extends", () => {
    const aliases = aliasesOver("packages/app/tests/x.matrix.test.ts", {
      "packages/app/tsconfig.json": '// app\n{ "extends": "../../tsconfig.base.json", "compilerOptions": { "baseUrl": "src", } }\n',
      "tsconfig.base.json": '{ /* base */ "compilerOptions": { "paths": { "@lib/*": ["lib/*", "vendor/*"], "exact": ["one.ts"] } } }',
    });
    expect(aliases).toEqual({
      ok: true,
      value: [
        { pattern: "@lib/*", targets: ["packages/app/src/lib/*", "packages/app/src/vendor/*"] },
        { pattern: "exact", targets: ["packages/app/src/one.ts"] },
      ],
    });
  });

  it("resolves paths against the declaring tsconfig's directory when no baseUrl is set", () => {
    expect(aliasesOver("tests/rules.matrix.test.ts", { "tsconfig.json": '{ "compilerOptions": { "paths": { "@rules/*": ["./src/rules/*"] } } }' }))
      .toEqual({ ok: true, value: [{ pattern: "@rules/*", targets: ["src/rules/*"] }] });
  });

  it("follows a package extends beneath node_modules, the extending config overriding what it inherits", () => {
    const aliases = aliasesOver("tests/x.test.ts", {
      "tsconfig.json": '{ "extends": "@org/tsconfig", "compilerOptions": { "paths": { "@own/*": ["own/*"] } } }',
      "node_modules/@org/tsconfig/tsconfig.json": '{ "compilerOptions": { "baseUrl": "../../../lib", "paths": { "@base/*": ["base/*"] } } }',
    });
    expect(aliases).toEqual({ ok: true, value: [{ pattern: "@own/*", targets: ["lib/own/*"] }] });
  });

  it("drops a target that escapes the repository and keeps the rest", () => {
    expect(aliasesOver("t.test.ts", { "tsconfig.json": '{ "compilerOptions": { "paths": { "x": ["../outside.ts", "inside.ts"] } } }' }))
      .toEqual({ ok: true, value: [{ pattern: "x", targets: ["inside.ts"] }] });
  });

  it("is empty without a tsconfig, or with one that declares no paths", () => {
    expect(aliasesOver("tests/x.test.ts", {})).toEqual({ ok: true, value: [] });
    expect(aliasesOver("tests/x.test.ts", { "tsconfig.json": '{ "compilerOptions": { "strict": true } }' })).toEqual({ ok: true, value: [] });
    expect(aliasesOver("tests/x.test.ts", { "tsconfig.json": "{}" })).toEqual({ ok: true, value: [] });
  });

  it.each([
    ["does not parse", { "tsconfig.json": '{ "compilerOptions": ' }, /tsconfig tsconfig.json does not parse/],
    ["is not an object", { "tsconfig.json": "[]" }, /is not an object/],
    ["extends itself", { "tsconfig.json": '{ "extends": "./tsconfig.json" }' }, /extends itself/],
    ["extends a config that cannot be found", { "tsconfig.json": '{ "extends": "./missing.json" }' }, /extends .\/missing.json, which cannot be found/],
    ["has a malformed extends", { "tsconfig.json": '{ "extends": 7 }' }, /extends that is not a string or a string array/],
    ["has a compilerOptions that is not an object", { "tsconfig.json": '{ "compilerOptions": 1 }' }, /compilerOptions is not an object/],
    ["has a baseUrl that is not a string", { "tsconfig.json": '{ "compilerOptions": { "baseUrl": 1 } }' }, /baseUrl is not a string/],
    ["has a baseUrl that escapes the repository", { "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".." } }' }, /escapes the repository/],
    ["has paths that are not an object", { "tsconfig.json": '{ "compilerOptions": { "paths": [] } }' }, /paths is not an object/],
    ["has a paths entry that is not a string array", { "tsconfig.json": '{ "compilerOptions": { "paths": { "x": "y" } } }' }, /paths.x is not a string array/],
  ] as const)("refuses a tsconfig that %s, since its aliases would be unknown", (_case, files, message) => {
    const aliases = aliasesOver("tests/x.test.ts", files);
    expect(aliases.ok).toBe(false);
    if (aliases.ok) return;
    expect(aliases.error).toMatch(message);
  });
});

describe("the repository-relative path helpers", () => {
  it.each([
    ["", "a/b", "a/b"],
    ["a", "./b/../c", "a/c"],
    ["a/b", "../..", ""],
    ["a", "../../x", null],
    ["", "..", null],
    ["a", "/b", "a/b"],
  ] as const)("within(%j, %j) is %j", (directory, relative, expected) => {
    expect(within(directory, relative)).toBe(expected);
  });

  it("directoryOf names the containing directory, empty at the root", () => {
    expect(directoryOf("a/b/c.ts")).toBe("a/b");
    expect(directoryOf("c.ts")).toBe("");
  });

  it("nearestTsconfig walks up from the matrix test to the repository root", () => {
    expect(nearestTsconfig("a/b/t.test.ts", readerOf({ "a/tsconfig.json": "{}", "tsconfig.json": "{}" }))).toBe("a/tsconfig.json");
    expect(nearestTsconfig("a/b/t.test.ts", readerOf({ "tsconfig.json": "{}" }))).toBe("tsconfig.json");
    expect(nearestTsconfig("a/b/t.test.ts", readerOf({}))).toBeNull();
  });

  it("extendedConfig tries the specifier, its .json and its tsconfig.json, relative or beneath the nearest node_modules", () => {
    expect(extendedConfig("a/tsconfig.json", "./base", readerOf({ "a/base.json": "{}" }))).toBe("a/base.json");
    expect(extendedConfig("a/tsconfig.json", "pkg", readerOf({ "node_modules/pkg/tsconfig.json": "{}" }))).toBe("node_modules/pkg/tsconfig.json");
    expect(extendedConfig("a/tsconfig.json", "pkg", readerOf({ "a/node_modules/pkg.json": "{}", "node_modules/pkg.json": "{}" }))).toBe("a/node_modules/pkg.json");
    expect(extendedConfig("a/tsconfig.json", "../../x", readerOf({}))).toBeNull();
  });
});
