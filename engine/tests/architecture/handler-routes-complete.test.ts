/**
 * The CLI builds a handler's module path from strings — `./handlers/${dir}/${name}.ts`
 * after a lookup in `KNOWN_HANDLERS` — so the routing table and the directories
 * can disagree without any compile error. Both directions fail late:
 *
 *   file exists, not routed   → "Unknown handler", exit 1 (a helper nobody can call)
 *   routed, no such file      → hook error at dynamic import, exit 2
 *
 * The hooks-sync test covers one direction only: every handler a SHIM invokes
 * is routed. A handler added to a directory but never routed has no shim
 * invoking it, so nothing notices until someone tries to call it.
 *
 * This asserts the two sets are equal per hook type, read from the filesystem
 * the dynamic import actually resolves against.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_HANDLERS } from "../../src/handler-routes";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HANDLERS = join(ENGINE, "src", "handlers");

/**
 * The handler names `cli.ts` can import for one hook type.
 *
 * Each directory holds two kinds of file: handler modules (default export,
 * invoked as `<hook-type> <name>`) and internal modules those handlers import
 * — `pre-tool-use-input`, `spawn-vetoes`, the helpers' operations tables. Only
 * the default export is a handler, so that is the filter, and it is the same
 * property the CLI depends on at the call site.
 */
function handlerFiles(hookType: string): readonly string[] {
  const directory = join(HANDLERS, hookType === "helper" ? "helpers" : hookType);
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => entry.slice(0, -3))
    .filter((name) => hasDefaultExport(join(directory, `${name}.ts`)))
    .sort();
}

const defaultExport = new Map<string, boolean>();
function hasDefaultExport(path: string): boolean {
  const cached = defaultExport.get(path);
  if (cached !== undefined) return cached;
  const content = readFileSync(path, "utf-8");
  const exported = /^export default\b/m.test(content) || /^export \{[^}]*\bdefault\b[^}]*\}/m.test(content);
  defaultExport.set(path, exported);
  return exported;
}

describe("every hook-type route set matches the handler files it routes to", () => {
  it("routes exactly the handler modules that exist, for each hook type", () => {
    for (const [hookType, routed] of Object.entries(KNOWN_HANDLERS)) {
      expect([...routed].sort(), `${hookType}: routed handlers vs src/handlers/${hookType}`)
        .toEqual(handlerFiles(hookType));
    }
  });

  it("covers every hook directory, so a new directory cannot go unrouted", () => {
    const directories = readdirSync(HANDLERS).sort().filter((entry) => !entry.includes("."));
    // `helpers` is reached through the `helper` CLI argument; the rest are named as-is.
    const routed = Object.keys(KNOWN_HANDLERS)
      .map((hookType) => hookType === "helper" ? "helpers" : hookType)
      .sort();
    expect(routed).toEqual(directories);
  });
});
