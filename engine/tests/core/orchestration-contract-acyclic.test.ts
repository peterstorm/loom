/**
 * The orchestration shared kernel's volume graph must stay acyclic.
 *
 * The kernel is split into sub-domain volumes behind one facade (`index.ts`).
 * That split only buys anything if the volumes form a layering: a cycle means
 * neither volume can be read, tested, or reasoned about without the other, and
 * the "volumes" are really one module in several files.
 *
 * Three cycles had formed — `roster ↔ completion`, `publication ↔ completion`,
 * and `publication ↔ actions` — and every back-edge carried nothing but an
 * error or diagnostic TYPE. An error type is referenced by everything that can
 * fail, so declaring it beside the operation that raises it points an edge
 * backwards. They now live in `errors.ts`, which sits directly above
 * `identity`/`bytes` and imports nothing else.
 *
 * This asserts the PROPERTY (acyclic) rather than a hand-maintained ordering,
 * so adding a volume requires no change here — only not reintroducing a cycle.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SOURCE_DIR = join(__dirname, "../../src");
const CORE_DIR = join(SOURCE_DIR, "core");
const KERNEL_DIR = join(CORE_DIR, "orchestration-contract");

/** Sibling-volume imports (`./name`) declared by one volume file. */
function siblingImports(source: string): readonly string[] {
  return [...source.matchAll(/(?:^|[\s})*;,=])(?:from|import)\s*\(?["']\.\/([A-Za-z0-9-]+)["']\)?/g)]
    .map((match) => match[1]!);
}

function volumeGraph(): ReadonlyMap<string, readonly string[]> {
  const graph = new Map<string, readonly string[]>();
  for (const entry of readdirSync(KERNEL_DIR)) {
    if (!entry.endsWith(".ts") || entry === "index.ts") continue;
    const volume = entry.slice(0, -".ts".length);
    graph.set(volume, siblingImports(readFileSync(join(KERNEL_DIR, entry), "utf-8")));
  }
  return graph;
}

/** Every cycle reachable from `start`, as the path that closes it. */
function cyclesFrom(
  start: string,
  graph: ReadonlyMap<string, readonly string[]>,
): readonly string[][] {
  const found: string[][] = [];
  const walk = (node: string, path: readonly string[]): void => {
    for (const next of graph.get(node) ?? []) {
      const seen = path.indexOf(next);
      if (seen >= 0) {
        found.push([...path.slice(seen), next]);
        continue;
      }
      walk(next, [...path, next]);
    }
  };
  walk(start, [start]);
  return found;
}

describe("orchestration-contract volume graph", () => {
  it("has no cycles between sub-domain volumes", () => {
    const graph = volumeGraph();
    expect(graph.size).toBeGreaterThan(1);

    const cycles = [...graph.keys()]
      .flatMap((volume) => cyclesFrom(volume, graph))
      .map((cycle) => cycle.join(" -> "));

    expect([...new Set(cycles)]).toEqual([]);
  });

  it("keeps historical compatibility imports one-way", () => {
    const names = ["legacy-archive", "standalone-review", "review-panel"] as const;
    const graph = new Map(names.map((name) => [
      name,
      siblingImports(readFileSync(join(CORE_DIR, `${name}.ts`), "utf-8"))
        .filter((dependency) => names.includes(dependency as typeof names[number])),
    ]));
    const cycles = [...graph.keys()]
      .flatMap((volume) => cyclesFrom(volume, graph))
      .map((cycle) => cycle.join(" -> "));

    expect([...new Set(cycles)]).toEqual([]);
    expect(graph.get("standalone-review")).not.toContain("legacy-archive");
  });

  it("keeps the shared error vocabulary beneath every volume that raises it", () => {
    const graph = volumeGraph();
    // errors.ts is the leaf that broke the three original cycles. If it ever
    // imports a volume other than identity/bytes, it can close a cycle again.
    expect([...(graph.get("errors") ?? [])].sort()).toEqual(["bytes", "identity"]);
  });

  it("keeps top-level source domains acyclic across runtime and type-only imports", () => {
    const sourceFiles = (directory: string): readonly string[] => readdirSync(directory).flatMap((entry) => {
      const path = join(directory, entry);
      return statSync(path).isDirectory()
        ? sourceFiles(path)
        : path.endsWith(".ts")
          ? [path]
          : [];
    });
    const files = sourceFiles(SOURCE_DIR);
    const modulePath = (path: string): string => relative(SOURCE_DIR, path).replace(/\.ts$/, "");
    const modules = new Set(files.map(modulePath));
    const graph = new Map(files.map((path): readonly [string, readonly string[]] => {
      const source = readFileSync(path, "utf-8");
      const specifiers = [...source.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*(?:\(\s*)?["']([^"']+)["']/g)]
        .map((match) => match[1] ?? match[2])
        .filter((specifier): specifier is string => specifier !== undefined && specifier.startsWith("."));
      const dependencies = specifiers.flatMap((specifier) => {
        const target = resolve(dirname(path), specifier);
        const candidates = [`${target}.ts`, join(target, "index.ts")];
        const found = candidates.find((candidate) => existsSync(candidate));
        if (found === undefined) return [];
        const key = modulePath(found);
        return modules.has(key) ? [key] : [];
      });
      return [modulePath(path), Object.freeze([...new Set(dependencies)])];
    }));
    const reachesSelf = (start: string, current: string, seen: ReadonlySet<string>): boolean =>
      (graph.get(current) ?? []).some((next) =>
        next === start || (!seen.has(next) && reachesSelf(start, next, new Set([...seen, next]))));
    const cyclicModules = [...graph.keys()].filter((module) => reachesSelf(module, module, new Set([module]))).sort();

    // The Guarded Skill Machine's three-volume legacy cycle predates the
    // orchestration kernel and is explicitly outside ADR-0007. No shared-kernel
    // or schema-root module may join it or form another cycle.
    expect(cyclicModules).toEqual([
      "machine/evidence",
      "machine/test-report",
      "machine/types",
    ]);
    expect(readFileSync(join(CORE_DIR, "model-profiles.ts"), "utf-8")).toContain('from "./phases"');
    expect(readFileSync(join(CORE_DIR, "model-profiles.ts"), "utf-8")).not.toContain('from "../types"');
  });
});
