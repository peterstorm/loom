import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkTypeScriptProject } from "../scripts/typecheck";
import { ENGINE } from "./fixtures/repository-roots";

const temporaryDirectories: string[] = [];
afterEach(() => temporaryDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function project(files: Readonly<Record<string, string>>, config: unknown = {
  compilerOptions: { strict: true, target: "esnext", module: "esnext", moduleResolution: "bundler", types: [] },
  include: ["src", "tests", "pi", "scripts"],
}): string {
  const directory = mkdtempSync(join(tmpdir(), "loom-compiler-"));
  temporaryDirectories.push(directory);
  const contents = { "tsconfig.json": JSON.stringify(config), ...files };
  for (const [path, content] of Object.entries(contents)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return join(directory, "tsconfig.json");
}

describe("real TypeScript compiler boundary", () => {
  it("checks a valid project without emitting", () => {
    const config = project({ "src/index.ts": "export const value: number = 1;" });
    expect(checkTypeScriptProject(config)).toMatchObject({ ok: true, value: { excludedDiagnostics: "" } });
    expect(readdirSync(join(dirname(config), "src"))).toEqual(["index.ts"]);
  });

  it.each(["src", "tests", "pi", "scripts"])("rejects owned unused declarations in %s", (root) => {
    const result = checkTypeScriptProject(project({ [`${root}/index.ts`]: "export {}; const unused = 1;" }));
    expect(result).toMatchObject({ ok: false, error: { kind: "diagnostics", diagnostics: expect.stringContaining("TS6133") } });
  });

  it.each([
    ["ordinary type error", { "src/index.ts": "export const value: number = 'wrong';" }, "TS2322"],
    ["missing input", {}, "TS18003"],
    ["malformed config", { "tsconfig.json": "{" }, "TS1005"],
    ["unknown option", { "tsconfig.json": '{"compilerOptions":{"nonexistent":true},"files":["index.ts"]}', "index.ts": "export {};" }, "TS5023"],
    ["missing explicit file", { "tsconfig.json": '{"files":["missing.ts"]}' }, "TS6053"],
    ["empty files", { "tsconfig.json": '{"files":[]}' }, "TS18002"],
  ])("fails closed on %s", (_label, files, diagnostic) => {
    const result = checkTypeScriptProject(project(files));
    expect(result).toMatchObject({ ok: false, error: { diagnostics: expect.stringContaining(diagnostic) } });
  });

  it("fails on a missing config rather than discovering a parent project", () => {
    const config = project({ "src/index.ts": "export {};" });
    expect(checkTypeScriptProject(join(dirname(config), "absent.json")))
      .toMatchObject({ ok: false, error: { diagnostics: expect.stringContaining("TS5083") } });
  });

  function dependency(source: string, owned = false): string {
    return project({
      "src/index.ts": "export { value } from 'upstream';",
      "node_modules/upstream/package.json": '{"name":"upstream","types":"index.ts"}',
      "node_modules/upstream/index.ts": source,
    }, {
      compilerOptions: { strict: true, moduleResolution: "bundler", module: "esnext", types: [] },
      files: owned ? ["src/index.ts", "node_modules/upstream/index.ts"] : ["src/index.ts"],
    });
  }

  it("observably excludes upstream raw-source unused, but no ordinary upstream errors", () => {
    const unused = "const unused = 1; export const value = 1;";
    expect(checkTypeScriptProject(dependency(unused)))
      .toMatchObject({ ok: true, value: { excludedDiagnostics: expect.stringContaining("TS6133") } });
    expect(checkTypeScriptProject(dependency(`${unused} const broken: number = 'wrong'; export { broken };`)))
      .toMatchObject({ ok: false, error: { diagnostics: expect.stringContaining("TS2322"), excludedDiagnostics: expect.stringContaining("TS6133") } });
  });

  it("does not exclude a dependency file explicitly owned as a compiler root", () => {
    expect(checkTypeScriptProject(dependency("const unused = 1; export const value = 1;", true)))
      .toMatchObject({ ok: false, error: { diagnostics: expect.stringContaining("TS6133") } });
  });

  it("missing installed compiler cannot resolve via Bun's package cache or the network", () => {
    const directory = dirname(project({ "src/index.ts": "export {};" }));
    mkdirSync(join(directory, "scripts"));
    mkdirSync(join(directory, "src/core"), { recursive: true });
    cpSync(join(ENGINE, "scripts/typecheck.ts"), join(directory, "scripts/typecheck.ts"));
    cpSync(join(ENGINE, "src/core/compiler-diagnostic-policy.ts"), join(directory, "src/core/compiler-diagnostic-policy.ts"));
    const result = spawnSync("bun", [join(directory, "scripts/typecheck.ts")], { cwd: directory, encoding: "utf8", timeout: 15_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("typescript/lib/typescript.js");
  });
});
