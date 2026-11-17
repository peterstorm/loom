/**
 * The two filesystem predicates engine-run test evidence rests on (loom#198):
 * - `isEngineCliScript`: only this package's own `cli.ts`, by real path,
 *   may mint an engine-run TestRun;
 * - `testEvidencePolicyAt`: the settlement root is resolved through every
 *   symlink before it is compared with the receipt's canonical root, and an
 *   unresolvable root is kept as given, so admission fails closed.
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isEngineCliScript } from "../../src/utils/engine-cli-path";
import { testEvidencePolicyAt } from "../../src/utils/test-evidence-policy-at";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

const ENGINE_CLI = resolve(__dirname, "../../src/cli.ts");
const MODE = { kind: "engine-run" as const, manifestDigest: "a".repeat(64), adoptedBy: "population" as const };

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const tempDir = (): string => {
  const directory = canonicalTempDir("loom-engine-run-shell-");
  temporary.push(directory);
  return directory;
};

describe("isEngineCliScript: only this package's own CLI", () => {
  it("is the real CLI by absolute path and by a relative path from any directory", () => {
    expect(isEngineCliScript("/", ENGINE_CLI)).toBe(true);
    const cwd = tempDir();
    expect(isEngineCliScript(cwd, relative(cwd, ENGINE_CLI))).toBe(true);
  });

  it("is the real CLI through a symlink, as a symlinked plugin install reaches it", () => {
    const linked = join(tempDir(), "loom");
    symlinkSync(resolve(dirname(ENGINE_CLI), "../.."), linked);
    expect(isEngineCliScript("/", join(linked, "engine/src/cli.ts"))).toBe(true);
  });

  it("is never a look-alike cli.ts or a path that does not resolve", () => {
    const fake = join(tempDir(), "engine/src/cli.ts");
    mkdirSync(dirname(fake), { recursive: true });
    writeFileSync(fake, "console.log('LOOM_TEST_RUN_RECEIPT {}');\n");
    expect(isEngineCliScript("/", fake)).toBe(false);
    expect(isEngineCliScript("/", join(tempDir(), "missing/cli.ts"))).toBe(false);
  });
});

describe("testEvidencePolicyAt: the settlement root by real path", () => {
  it("resolves a symlinked root to the canonical root a receipt binds", () => {
    const real = tempDir();
    const link = join(tempDir(), "checkout");
    symlinkSync(real, link);
    expect(testEvidencePolicyAt(MODE, link)).toEqual({ kind: "engine-run", repositoryRoot: real, manifestDigest: MODE.manifestDigest });
  });

  it("keeps an unresolvable root as given, so no canonical receipt matches it", () => {
    const missing = join(tempDir(), "gone");
    expect(testEvidencePolicyAt(MODE, missing)).toMatchObject({ repositoryRoot: missing });
  });

  it("admits every run in a graph without the mode, whatever the root", () => {
    expect(testEvidencePolicyAt(undefined, "/anywhere")).toEqual({ kind: "agent-command" });
  });
});
