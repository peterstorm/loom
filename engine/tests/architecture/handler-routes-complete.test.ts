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
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KNOWN_HANDLERS } from "../../src/handler-routes";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HANDLERS = join(ENGINE, "src", "handlers");

/**
 * The handler names `cli.ts` can import for one hook type.
 *
 * Each directory holds two kinds of file: handler modules (a default-exported
 * function, invoked as `<hook-type> <name>`) and internal modules those
 * handlers import — `pre-tool-use-input`, `spawn-vetoes`, the helpers'
 * operations tables. The filter is the property the CLI depends on, tested the
 * way the CLI tests it: the module is imported and its `default` must be a
 * function. Any export form (`export default`, `export { x as default }`,
 * a re-export) counts exactly when the CLI's import would find a handler.
 */
async function handlerFiles(hookType: string): Promise<readonly string[]> {
  const directory = join(HANDLERS, hookType === "helper" ? "helpers" : hookType);
  const names = readdirSync(directory).filter((entry) => entry.endsWith(".ts")).map((entry) => entry.slice(0, -3));
  const handlers: string[] = [];
  for (const name of names) {
    const module = await import(pathToFileURL(join(directory, `${name}.ts`)).href) as { default?: unknown };
    if (typeof module.default === "function") handlers.push(name);
  }
  return handlers.sort();
}

describe("every hook-type route set matches the handler files it routes to", () => {
  it("routes exactly the handler modules that exist, for each hook type", async () => {
    for (const [hookType, routed] of Object.entries(KNOWN_HANDLERS)) {
      expect([...routed].sort(), `${hookType}: routed handlers vs src/handlers/${hookType}`)
        .toEqual(await handlerFiles(hookType));
    }
  }, 120_000);

  it("covers every hook directory, so a new directory cannot go unrouted", () => {
    const directories = readdirSync(HANDLERS).sort().filter((entry) => !entry.includes("."));
    // `helpers` is reached through the `helper` CLI argument; the rest are named as-is.
    const routed = Object.keys(KNOWN_HANDLERS)
      .map((hookType) => hookType === "helper" ? "helpers" : hookType)
      .sort();
    expect(routed).toEqual(directories);
  });
});
