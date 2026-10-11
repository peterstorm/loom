/**
 * The type-diagnostics shell against a REAL TypeScript compiler: a temp
 * project whose node_modules/typescript links to the engine's pinned one.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  locateTypeCheckProject,
  typeDiagnosticsAdvisory,
  type TypeDiagnosticsOptions,
} from "../../src/handlers/type-diagnostics-runner";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENGINE_TYPESCRIPT = join(ENGINE, "node_modules", "typescript");

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function scratch(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporary.push(directory);
  return directory;
}

function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** A TypeScript project with a real compiler and its own cache directory. */
function project(files: Readonly<Record<string, string>>, typescript: "real" | "none" = "real") {
  const root = scratch("loom-type-diagnostics-");
  write(root, {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, target: "esnext", module: "esnext", moduleResolution: "bundler", types: [], noEmit: true },
      include: ["src"],
    }),
    ...files,
  });
  if (typescript === "real") {
    mkdirSync(join(root, "node_modules"));
    symlinkSync(ENGINE_TYPESCRIPT, join(root, "node_modules", "typescript"), "dir");
  }
  const options: TypeDiagnosticsOptions = { cacheDir: scratch("loom-type-cache-"), deadlineMs: 60_000, env: {} };
  return { root, file: (path: string) => join(root, path), options };
}

describe("locateTypeCheckProject", () => {
  it("finds the nearest tsconfig above the file and the project's own compiler", () => {
    const p = project({ "src/deep/a.ts": "export const a = 1;\n" });
    const located = locateTypeCheckProject(p.file("src/deep/a.ts"));
    expect(located).toEqual({
      ok: true,
      value: { tsconfig: p.file("tsconfig.json"), projectDir: p.root, tscPath: join(p.root, "node_modules", "typescript", "lib", "tsc.js") },
    });
  });

  it("is unavailable without a project TypeScript", () => {
    const p = project({ "src/a.ts": "export const a = 1;\n" }, "none");
    const located = locateTypeCheckProject(p.file("src/a.ts"));
    expect(located.ok).toBe(false);
  });

  it("is unavailable without a tsconfig.json above the file", () => {
    const root = scratch("loom-type-noconfig-");
    write(root, { "a.ts": "export const a = 1;\n" });
    expect(locateTypeCheckProject(join(root, "a.ts"))).toMatchObject({ ok: false, error: expect.stringContaining("tsconfig.json") });
  });
});

describe("typeDiagnosticsAdvisory against a real tsc", () => {
  it("says nothing for a file that typechecks", async () => {
    const p = project({ "src/a.ts": "export const a: number = 1;\n" });
    expect(await typeDiagnosticsAdvisory(p.file("src/a.ts"), p.options)).toEqual({ forModel: null, forOperator: null });
  }, 60_000);

  it("reports the touched file's type error with its remedy, and a caller this edit broke", async () => {
    const p = project({
      "src/price.ts": "export const price = (amount: number, rate: number): number => amount * rate;\n",
      "src/checkout.ts": "import { price } from './price';\nexport const total = price(10, 2);\n",
    });
    // Baseline run: clean.
    expect((await typeDiagnosticsAdvisory(p.file("src/price.ts"), p.options)).forModel).toBeNull();

    // The edit: a wrong return value in price.ts, and a signature change that breaks checkout.ts.
    write(p.root, { "src/price.ts": "export const price = (amount: number): number => 'free';\n" });
    const advisory = await typeDiagnosticsAdvisory(p.file("src/price.ts"), p.options);
    expect(advisory.forModel).toContain("src/price.ts");
    expect(advisory.forModel).toContain("TS2322");
    expect(advisory.forModel).toContain("Never silence it with `as`");
    expect(advisory.forModel).toContain("src/checkout.ts");
    expect(advisory.forModel).toContain("TS2554");
  }, 120_000);

  it("escalates the repeat reminder across real consecutive runs", async () => {
    const p = project({ "src/a.ts": "export const a: number = 'x';\n" });
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await typeDiagnosticsAdvisory(p.file("src/a.ts"), p.options));
    expect(runs[1]!.forModel).not.toContain("consecutive edits");
    expect(runs[2]!.forModel).toContain("survived 3 consecutive edits");
  }, 120_000);

  it("ignores non-TypeScript files and declaration files", async () => {
    const p = project({ "src/a.js": "x", "src/a.d.ts": "export declare const a: number;\n" });
    expect(await typeDiagnosticsAdvisory(p.file("src/a.js"), p.options)).toEqual({ forModel: null, forOperator: null });
    expect(await typeDiagnosticsAdvisory(p.file("src/a.d.ts"), p.options)).toEqual({ forModel: null, forOperator: null });
    expect(readdirSync(p.options.cacheDir!)).toEqual([]);
  });

  it("is switched off by LOOM_TYPE_DIAGNOSTICS=off", async () => {
    const p = project({ "src/a.ts": "export const a: number = 'x';\n" });
    const advisory = await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, env: { LOOM_TYPE_DIAGNOSTICS: "off" } });
    expect(advisory).toEqual({ forModel: null, forOperator: null });
  });

  it("stays silent where no project TypeScript exists", async () => {
    const p = project({ "src/a.ts": "export const a: number = 'x';\n" }, "none");
    expect(await typeDiagnosticsAdvisory(p.file("src/a.ts"), p.options)).toEqual({ forModel: null, forOperator: null });
  });

  it("tells only the operator when tsc misses the deadline, and leaves the build running to warm the cache", async () => {
    const p = project({ "src/a.ts": "export const a: number = 'x';\n" });
    const advisory = await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, deadlineMs: 1 });
    expect(advisory.forModel).toBeNull();
    expect(advisory.forOperator).toMatch(/did not finish within/);
    // While that build is alive, a second check reports busy (silent) instead of racing it.
    const second = await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, deadlineMs: 1 });
    expect(second.forModel).toBeNull();
  }, 60_000);

  it("reports a compiler that crashes to the operator", async () => {
    const p = project({ "src/a.ts": "export const a = 1;\n" }, "none");
    write(p.root, { "node_modules/typescript/lib/tsc.js": "process.stderr.write('boom'); process.exit(7);\n" });
    const advisory = await typeDiagnosticsAdvisory(p.file("src/a.ts"), p.options);
    expect(advisory.forModel).toBeNull();
    expect(advisory.forOperator).toMatch(/could not run: tsc exited with 7: boom/);
  }, 60_000);
});
