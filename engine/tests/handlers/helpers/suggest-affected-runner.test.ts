/**
 * `helper suggest-affected-runner` (loom#198, Cause 3): the read-only shell
 * over the preset detection, run in a real temp Git repository.
 */

import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSuggestAffectedRunnerHandler } from "../../../src/handlers/helpers/suggest-affected-runner";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository(packageJson: unknown): string {
  const root = canonicalTempDir("loom-suggest-runner-");
  temporary.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "package.json"), JSON.stringify(packageJson));
  return root;
}

async function suggest(root: string, args: readonly string[] = []) {
  const printed: string[] = [];
  const result = await createSuggestAffectedRunnerHandler((text) => { printed.push(text); }, () => root)("", [...args]);
  return { result, printed: printed.join("") };
}

describe("helper suggest-affected-runner", () => {
  it("suggests the runner the project's test script runs, as a manifest fragment", async () => {
    const { result, printed } = await suggest(repository({ scripts: { test: "vitest run" }, devDependencies: { vitest: "3" } }));
    expect(result).toEqual({ kind: "passthrough" });
    expect(printed).toContain("Suggested runner: vitest");
    expect(printed).toContain('"executable": "node_modules/.bin/vitest"');
  });

  it("prints the generic shape when no runner is detected", async () => {
    const { printed } = await suggest(repository({ name: "plain" }));
    expect(printed).toContain("No known test runner was detected");
  });

  it("prints a named preset as is, and refuses an unknown one", async () => {
    const root = repository({});
    expect((await suggest(root, ["--preset", "node-test"])).printed).toContain("--test-reporter=junit");
    expect((await suggest(root, ["--preset", "karma"])).result).toMatchObject({ kind: "error", message: expect.stringContaining("unknown preset karma") });
  });
});
