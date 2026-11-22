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
import fc from "fast-check";
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

type Graph = ReadonlyMap<string, readonly string[]>;

function volumeGraph(): Graph {
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
  graph: Graph,
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

type CycleScan = Readonly<{
  members: readonly string[];
  edgeVisits: number;
}>;

function scanCyclicMembers(graph: Graph): CycleScan {
  let edgeVisits = 0;
  const reachesSelf = (start: string): boolean => {
    const visited = new Set([start]);
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      for (const next of graph.get(current) ?? []) {
        edgeVisits += 1;
        if (next === start) return true;
        if (visited.has(next)) continue;
        visited.add(next);
        pending.push(next);
      }
    }
    return false;
  };

  return Object.freeze({
    members: Object.freeze([...graph.keys()].filter(reachesSelf).sort()),
    edgeVisits,
  });
}

function bruteForceCyclicMembers(graph: Graph): readonly string[] {
  const reachesSelf = (start: string, current: string, path: ReadonlySet<string>): boolean =>
    (graph.get(current) ?? []).some((next) =>
      next === start || (!path.has(next) && reachesSelf(start, next, new Set([...path, next]))));

  return [...graph.keys()]
    .filter((node) => reachesSelf(node, node, new Set([node])))
    .sort();
}

function graphFromBits(size: number, edges: readonly boolean[]): Graph {
  const nodes = Array.from({ length: size }, (_, index) => `n${index}`);
  return new Map(nodes.map((node, from): readonly [string, readonly string[]] => [
    node,
    Object.freeze(nodes.filter((_, to) => edges[from * size + to] === true)),
  ]));
}

function layeredDiamond(levels: number): Graph {
  const graph = new Map<string, readonly string[]>();
  let entry = "root";
  for (let level = 0; level < levels; level += 1) {
    const left = `left-${level}`;
    const right = `right-${level}`;
    const merge = `merge-${level}`;
    graph.set(entry, Object.freeze([left, right]));
    graph.set(left, Object.freeze([merge]));
    graph.set(right, Object.freeze([merge]));
    entry = merge;
  }
  graph.set(entry, Object.freeze([]));
  return graph;
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

  it("reports self-cycles and multiple cycles without including dependent DAG nodes", () => {
    const graph: Graph = new Map([
      ["self", ["self"]],
      ["cycle-a", ["cycle-b"]],
      ["cycle-b", ["cycle-a", "downstream"]],
      ["cycle-c", ["cycle-d"]],
      ["cycle-d", ["cycle-c"]],
      ["downstream", ["leaf"]],
      ["leaf", []],
      ["dependent", ["cycle-a"]],
    ]);

    expect(scanCyclicMembers(graph).members).toEqual([
      "cycle-a",
      "cycle-b",
      "cycle-c",
      "cycle-d",
      "self",
    ]);
  });

  it("agrees with brute-force simple-path enumeration on bounded finite graphs", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 5 }).chain((size) =>
        fc.array(fc.boolean(), { minLength: size * size, maxLength: size * size })
          .map((edges) => graphFromBits(size, edges))),
      (graph) => {
        expect(scanCyclicMembers(graph).members).toEqual(bruteForceCyclicMembers(graph));
      },
    ), { numRuns: 200 });
  });

  it("scans a layered diamond within the per-root graph bound", () => {
    const graph = layeredDiamond(20);
    const edgeCount = [...graph.values()].reduce((count, edges) => count + edges.length, 0);
    const scan = scanCyclicMembers(graph);

    expect(scan.members).toEqual([]);
    expect(scan.edgeVisits).toBeLessThanOrEqual(graph.size * edgeCount);
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
    const cyclicModules = scanCyclicMembers(graph).members;

    // Shared structured-report facts now live in the pure core, so the former
    // three-volume Guarded Skill Machine cycle is reduced to its historical
    // evidence/types pair. No shared-kernel or schema-root module may join it.
    expect(cyclicModules).toEqual([
      "machine/evidence",
      "machine/types",
    ]);
    expect(readFileSync(join(CORE_DIR, "model-profiles.ts"), "utf-8")).toContain('from "./phases"');
    expect(readFileSync(join(CORE_DIR, "model-profiles.ts"), "utf-8")).not.toContain('from "../types"');
  });
});
