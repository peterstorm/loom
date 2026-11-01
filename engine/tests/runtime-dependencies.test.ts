/**
 * Every package `src/` loads at runtime must be a runtime dependency.
 *
 * A package listed only under `devDependencies` resolves in every checkout
 * that ran a full install, so typecheck and the whole suite stay green, while
 * an install that omits dev dependencies cannot even load the CLI. `ts-pattern`
 * sat in `devDependencies` while `cli.ts` and the stop checks imported it, and
 * `typescript` had the same gap until ADR-0042. This reads every runtime edge
 * out of `src/` with the owner-coverage edge parser (`moduleEdges`, which
 * erases type-only edges and ignores comments) and fails on a package the
 * manifest does not ship.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { moduleEdges } from "../src/core/owner-verification/import-graph";

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ENGINE_ROOT, "src");

function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

/** The installable package a bare specifier names: `@scope/name` or `name`, without a subpath. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || isBuiltin(specifier)) return null;
  const [first = "", second = ""] = specifier.split("/");
  return first.startsWith("@") ? `${first}/${second}` : first;
}

function runtimePackages(path: string, text: string): readonly string[] {
  return moduleEdges(path, text)
    .filter(({ typeOnly }) => !typeOnly)
    .map(({ specifier }) => packageOf(specifier))
    .filter((name): name is string => name !== null);
}

describe("runtime dependencies", () => {
  it("names the package of a bare specifier and skips relative and builtin ones", () => {
    expect(packageOf("ts-pattern")).toBe("ts-pattern");
    expect(packageOf("zod/v4")).toBe("zod");
    expect(packageOf("@scope/pkg/sub")).toBe("@scope/pkg");
    expect(packageOf("node:fs")).toBeNull();
    expect(packageOf("fs")).toBeNull();
    expect(packageOf("./local")).toBeNull();
  });

  it("reads runtime imports, re-exports and dynamic imports, and erases type-only edges and comments", () => {
    const source = [
      '/** `import … from "commented-out"` */',
      'import { match } from "ts-pattern";',
      'import type { Foo } from "type-only";',
      'export type { Bar } from "also-type-only";',
      'export { baz } from "saxes";',
      'const ts = await import("typescript");',
    ].join("\n");
    expect(runtimePackages("x.ts", source)).toEqual(["ts-pattern", "saxes", "typescript"]);
  });

  it("ships every package src/ imports at runtime as a dependency", () => {
    const manifest = JSON.parse(readFileSync(join(ENGINE_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const shipped = new Set(Object.keys(manifest.dependencies ?? {}));
    const missing = sourceFiles(SRC).flatMap((file) =>
      runtimePackages(file, readFileSync(file, "utf8"))
        .filter((name) => !shipped.has(name))
        .map((name) => `${file.slice(ENGINE_ROOT.length + 1)}: ${name}`));
    expect(missing).toEqual([]);
  });
});
