/**
 * The Pi harness is the half of this codebase that nothing else checks.
 *
 * `pi/` is outside `tsconfig.json`'s `include`, and its peer dependencies are
 * type-only in the extension entry point. Historically no test loaded it, so
 * `bun run typecheck` and `vitest run` were both green while
 * `pi/extension.ts` imported `isReviewAgent` from a module that had stopped
 * exporting it. That is an ESM LINK-time failure, not a lazy `undefined`: the
 * extension module never evaluates, so every loom hook under Pi — phase order,
 * wave gates, template substitution, direct-edit blocking, review capture —
 * silently does not run. The engine tests cannot see it because the engine is
 * fine; only the seam is broken.
 *
 * This closes the seam without needing the Pi runtime. Every `../engine/...`
 * import in `pi/` is read out of the source and resolved against what the
 * target module actually exports: value imports against the real module
 * namespace, type-only imports against the target's exported type
 * declarations. Moving or renaming a shared symbol now fails a test instead of
 * disarming Pi.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PI_DIR = join(PACKAGE_ROOT, "pi");

/** One `import ... from "<engine module>"` statement, decomposed. */
interface EngineImport {
  readonly file: string;
  readonly specifier: string;
  /** Named bindings whose VALUE must exist at runtime. */
  readonly values: readonly string[];
  /** Named bindings that are types — checked against the source, not the namespace. */
  readonly types: readonly string[];
  /** True for `import * as ns from "..."` — only module loadability is asserted. */
  readonly namespaceOnly: boolean;
}

/**
 * Read the engine imports out of a Pi source file.
 *
 * A regex rather than a parser, deliberately: the alternative is adding a TS
 * parser dependency to assert one structural fact, and the shapes in `pi/` are
 * ordinary import statements. The anti-vacuity assertions below are what keep a
 * regex that silently stops matching from turning this into a no-op test.
 */
function engineImports(file: string): readonly EngineImport[] {
  const source = readFileSync(join(PI_DIR, file), "utf-8");
  const found: EngineImport[] = [];

  const named = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["'](\.\.\/engine\/[^"']+)["']/g;
  for (const match of source.matchAll(named)) {
    const statementIsTypeOnly = match[1] !== undefined;
    const values: string[] = [];
    const types: string[] = [];
    for (const raw of match[2]!.split(",")) {
      const specifier = raw.trim();
      if (specifier === "") continue;
      // `{ type Foo }` marks one binding type-only inside a value import.
      const inlineType = specifier.startsWith("type ");
      // `a as b` — `a` is the name the target must export.
      const name = (inlineType ? specifier.slice(5) : specifier).trim().split(/\s+as\s+/)[0]!.trim();
      (statementIsTypeOnly || inlineType ? types : values).push(name);
    }
    found.push({ file, specifier: match[3]!, values, types, namespaceOnly: false });
  }

  const namespace = /import\s+\*\s+as\s+\w+\s+from\s*["'](\.\.\/engine\/[^"']+)["']/g;
  for (const match of source.matchAll(namespace)) {
    found.push({ file, specifier: match[1]!, values: [], types: [], namespaceOnly: true });
  }

  return found;
}

/**
 * Every `.ts` in `pi/`, discovered rather than listed.
 *
 * A hardcoded roster is the same bug class this file exists to catch: when the
 * `tool_result` handler was split out into `subagent-result.ts`, most of the
 * engine imports moved with it, and a fixed list would have kept passing while
 * checking the file they LEFT. Discovery cannot go stale; the anti-vacuity
 * assertions below keep an empty directory from turning this into a no-op.
 */
const PI_FILES = readdirSync(PI_DIR)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
  .sort();
const IMPORTS = PI_FILES.flatMap(engineImports);

describe("pi package manifest", () => {
  it("loads only the extension entry point; it renders harness-specific resources", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"));

    expect(manifest.pi).toEqual({ extensions: ["./pi/extension.ts"] });
    const extension = readFileSync(join(PI_DIR, "extension.ts"), "utf-8");
    expect(extension).toContain('pi.on("resources_discover"');
    expect(extension).toContain("materializePiResources(PACKAGE_ROOT");
  });

  it("binds Loom spawns to the same user agent file Pi executes", () => {
    // The decision itself is the pure Spawn Admission core; the extension is
    // the shell that must (a) run it and (b) implement its definition port
    // over the exact user-scope agent file Pi executes.
    const extension = readFileSync(join(PI_DIR, "extension.ts"), "utf-8");
    expect(extension).toContain("admitPiSpawnBatch(");
    expect(extension).toContain("validatePiAgentDefinitionFile(");
    expect(extension).toContain('join(PI_AGENT_DIR, "agents", `${agent}.md`)');
    const admission = readFileSync(
      join(PI_DIR, "..", "engine", "src", "core", "spawn-admission.ts"),
      "utf-8",
    );
    expect(admission).toContain('requestedScope !== "user"');
  });
});

/** Resolve a `../engine/...` specifier to a file on disk. */
function modulePath(specifier: string): string {
  const base = resolve(PI_DIR, specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      // A directory without an index would pass `existsSync`; require a file.
      if (candidate === base && !base.endsWith(".ts")) continue;
      return candidate;
    }
  }
  throw new Error(`no engine module on disk for ${specifier}`);
}

/**
 * Is `name` a type this module offers — declared here, or re-exported from a
 * module that declares it?
 *
 * Barrels are the normal shape in `engine/src`: `machine/index.ts` says
 * `export { type ClassifiedTestCommand } from "./extract-evidence"`, and a
 * checker that only looked for `export type X` in the named file called that a
 * missing declaration. Following the re-export is what makes the assertion mean
 * "pi can import this" rather than "this file happens to spell it out".
 *
 * `seen` terminates re-export cycles; an unresolvable hop answers false, so the
 * failure is still reported against the import that could not be satisfied.
 */
function declaresType(modulePathOnDisk: string, name: string, seen = new Set<string>()): boolean {
  if (seen.has(modulePathOnDisk)) return false;
  seen.add(modulePathOnDisk);
  const source = readFileSync(modulePathOnDisk, "utf-8");
  if (new RegExp(`export\\s+(type|interface)\\s+${name}\\b`).test(source)) return true;

  const reExport = /export\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(reExport)) {
    const statementIsTypeOnly = match[1] !== undefined;
    const names = match[2]!.split(",").map((raw) => {
      const trimmed = raw.trim();
      const inlineType = trimmed.startsWith("type ");
      const local = (inlineType ? trimmed.slice(5) : trimmed).trim().split(/\s+as\s+/);
      return { exported: (local[1] ?? local[0] ?? "").trim(), source: (local[0] ?? "").trim(), inlineType };
    });
    const hit = names.find((entry) => entry.exported === name && (statementIsTypeOnly || entry.inlineType));
    if (hit === undefined) continue;
    const resolved = relativeModulePath(modulePathOnDisk, match[3]!);
    if (resolved !== null && declaresType(resolved, hit.source, seen)) return true;
  }
  return false;
}

/** Resolve one relative specifier against the module that wrote it. */
function relativeModulePath(fromModule: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromModule), specifier);
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

describe("pi/ imports resolve against the engine that has to satisfy them", () => {
  it("found engine imports to check at all", () => {
    // Anti-vacuity. If the regexes stop matching — a formatter rewrites the
    // import block, someone switches to `require` — every assertion below
    // trivially passes over an empty list and the seam is unguarded again.
    expect(IMPORTS.length).toBeGreaterThan(15);
    expect(IMPORTS.some((entry) => entry.values.length > 0)).toBe(true);
    expect(IMPORTS.some((entry) => entry.types.length > 0)).toBe(true);
    expect(IMPORTS.some((entry) => entry.namespaceOnly)).toBe(true);
  });

  it("names the module every engine specifier points at", () => {
    for (const entry of IMPORTS) {
      expect(() => modulePath(entry.specifier), `${entry.file} → ${entry.specifier}`).not.toThrow();
    }
  });

  it.each(IMPORTS.filter((entry) => entry.values.length > 0).map((entry) => [entry.specifier, entry] as const))(
    "every value imported from %s is exported by it",
    async (_specifier, entry) => {
      const namespace = await import(modulePath(entry.specifier));
      for (const name of entry.values) {
        expect(
          Object.hasOwn(namespace, name),
          `${entry.file} imports { ${name} } from "${entry.specifier}", which does not export it`,
        ).toBe(true);
      }
    },
  );

  it("every type imported from an engine module is declared there", () => {
    for (const entry of IMPORTS) {
      if (entry.types.length === 0) continue;
      const target = modulePath(entry.specifier);
      for (const name of entry.types) {
        const declared = declaresType(target, name);
        expect(
          declared,
          `${entry.file} imports type { ${name} } from "${entry.specifier}", which does not declare it`,
        ).toBe(true);
      }
    }
  });

  it("loads every engine module pi/ depends on", async () => {
    // The named checks above prove the SYMBOLS line up; this proves the modules
    // themselves still evaluate, which is the other half of a link-time failure.
    for (const entry of IMPORTS) {
      await expect(import(modulePath(entry.specifier))).resolves.toBeDefined();
    }
  });

  it("keeps isReviewAgent's home honest — the regression this file exists for", () => {
    // Named explicitly rather than left to the generic sweep: the symbol moved
    // to `config` ON PURPOSE, so `core/review-output` could keep claiming it is
    // free of config, and the fix for the broken import must not be to move it
    // back.
    const source = readFileSync(join(PI_DIR, "extension.ts"), "utf-8");
    expect(source).toMatch(/import\s*\{[^}]*\bisReviewAgent\b[^}]*\}\s*from\s*["']\.\.\/engine\/src\/config["']/);
  });
});
