/**
 * The legacy panel decisions are pure in behavior, but they stay out of
 * DEFAULT_PURE_MODULES: the purity closure would have to absorb the emission
 * transport they import (ADR-0018). The shipped no-io-in-pure-modules rule
 * therefore runs over this one file's own text, so direct I/O, an ambient
 * clock or randomness added here fails verification even though the
 * transitive imports are not audited.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handler as noIoHandler } from "../../src/linter/programmatic/no-io-in-pure-modules";

const MODULE = "engine/src/core/legacy-panel-decisions.ts";
const SOURCE = readFileSync(resolve(__dirname, "../../..", MODULE), "utf8");
const checkedAsPure = (content: string) => noIoHandler(content, MODULE, [MODULE]);

describe("legacy-panel-decisions file-local purity", () => {
  it("passes the shipped no-io-in-pure-modules rule", () => {
    expect(checkedAsPure(SOURCE)).toEqual([]);
  });

  it.each([
    'import { readFileSync } from "node:fs";',
    "const now = Date.now();",
    "const jitter = Math.random();",
  ])("rejects an impurity added to the file: %s", (probe) => {
    expect(checkedAsPure(`${SOURCE}\n${probe}\n`).length).toBeGreaterThan(0);
  });
});
