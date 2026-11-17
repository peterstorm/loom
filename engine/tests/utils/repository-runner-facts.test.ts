/**
 * `observeRunnerFacts` (loom#198, Cause 3): what a repository shows about its
 * test runner, read for the runner suggestion. Total: a missing `package.json`
 * is a repository with no packages; one that exists but cannot be read or
 * parsed is named, so the hint never offers the generic shape for the wrong
 * reason.
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeRunnerFacts } from "../../src/utils/repository-runner-facts";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

function repository(files: Readonly<Record<string, string>> = {}): string {
  const root = canonicalTempDir("loom-runner-facts-");
  temporary.push(root);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return root;
}

describe("observeRunnerFacts", () => {
  it("reads a repository with no package.json as one with no packages and no problem", () => {
    expect(observeRunnerFacts(repository())).toEqual({ packages: new Set(), testScript: null, packageJsonProblem: null, bunLockfile: false });
  });

  it("collects dependency and devDependency names and the test script", () => {
    const facts = observeRunnerFacts(repository({
      "package.json": JSON.stringify({ dependencies: { react: "19" }, devDependencies: { mocha: "10" }, scripts: { test: "mocha" } }),
    }));
    expect(facts).toEqual({ packages: new Set(["react", "mocha"]), testScript: "mocha", packageJsonProblem: null, bunLockfile: false });
  });

  it("ignores a test script that is not a string and dependency blocks that are not objects", () => {
    const facts = observeRunnerFacts(repository({
      "package.json": JSON.stringify({ dependencies: ["vitest"], devDependencies: null, scripts: { test: 1 } }),
    }));
    expect(facts).toEqual({ packages: new Set(), testScript: null, packageJsonProblem: null, bunLockfile: false });
  });

  it.each([
    ["invalid JSON", "{ not json", /^package\.json is not valid JSON: /],
    ["a JSON array", "[]", /^package\.json is not a JSON object$/],
    ["a JSON string", '"mocha"', /^package\.json is not a JSON object$/],
  ])("names a package.json holding %s", (_label, text, problem) => {
    const facts = observeRunnerFacts(repository({ "package.json": text }));
    expect(facts.packageJsonProblem).toMatch(problem);
    expect(facts.packages.size).toBe(0);
    expect(facts.testScript).toBeNull();
  });

  it.runIf(process.getuid?.() !== 0)("names a package.json it is refused, rather than reading it as absent", () => {
    const root = repository({ "package.json": "{}" });
    chmodSync(join(root, "package.json"), 0o000);
    expect(observeRunnerFacts(root).packageJsonProblem).toMatch(/^package\.json could not be read: /);
  });

  it("reads a directory where package.json should be as absent", () => {
    const root = repository();
    mkdirSync(join(root, "package.json"));
    expect(observeRunnerFacts(root).packageJsonProblem).toBeNull();
  });

  it.each(["bun.lock", "bun.lockb"])("sees a Bun lockfile named %s", (lockfile) => {
    expect(observeRunnerFacts(repository({ [lockfile]: "" })).bunLockfile).toBe(true);
  });
});
