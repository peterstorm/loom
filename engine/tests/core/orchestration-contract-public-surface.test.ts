/**
 * The orchestration kernel's facade is a PUBLIC SURFACE: every symbol on it
 * must have a consumer outside the kernel.
 *
 * `tsc` cannot catch a dead export — it assumes an external consumer exists —
 * so a barrel that re-exports the union of its volumes makes an unused symbol
 * indistinguishable from a public one. That is how this facade reached 142
 * symbols of which 52 were imported by nothing outside `orchestration-contract`,
 * and it is the same blind spot that let dead aliases accumulate elsewhere.
 *
 * A volume exports a symbol so the volumes above it can use it. That is an
 * internal relationship and says nothing about whether a caller outside the
 * kernel needs it. This test is the difference between the two.
 *
 * Failing here is not "delete your code" — it is "decide". Either a caller
 * needs the symbol (add the caller) or the kernel does not publish it (drop the
 * re-export; the volume keeps exporting it to its siblings either way).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ENGINE = join(__dirname, "../..");
const KERNEL = join(ENGINE, "src/core/orchestration-contract");
/** Everything that could legitimately consume the kernel. */
const CONSUMER_ROOTS = [
  join(ENGINE, "src"),
  join(ENGINE, "tests"),
  join(ENGINE, "../pi"),
  join(ENGINE, "../hooks"),
  join(ENGINE, "../scripts"),
];

function typescriptFiles(root: string): readonly string[] {
  let entries: readonly string[];
  try { entries = readdirSync(root); } catch { return []; }
  return entries.flatMap((entry) => {
    if (entry === "node_modules" || entry === "coverage") return [];
    const path = join(root, entry);
    if (statSync(path).isDirectory()) return typescriptFiles(path);
    return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [path] : [];
  });
}

/** The names `index.ts` publishes, with the `type ` modifier stripped. */
function publishedSymbols(): readonly string[] {
  const source = readFileSync(join(KERNEL, "index.ts"), "utf-8");
  return [...source.matchAll(/^export \{([^}]*)\}/gm)]
    .flatMap((match) => match[1]!.split(","))
    .map((entry) => entry.trim().replace(/^type /, ""))
    .filter((entry) => entry.length > 0);
}

describe("orchestration-contract public surface", () => {
  it("publishes only symbols that something outside the kernel imports", () => {
    const consumers = CONSUMER_ROOTS
      .flatMap(typescriptFiles)
      .filter((path) => !path.startsWith(KERNEL))
      .map((path) => readFileSync(path, "utf-8"));

    const published = publishedSymbols();
    expect(published.length).toBeGreaterThan(0);

    const orphaned = published.filter((symbol) => {
      const reference = new RegExp(`\\b${symbol}\\b`);
      return !consumers.some((source) => reference.test(source));
    });

    expect(orphaned).toEqual([]);
  });
});
