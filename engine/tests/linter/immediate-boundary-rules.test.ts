/**
 * The import-boundary rules run on every edit, not only at the Wave Gate: in
 * the G1 live pilot a contract Task wrote a forbidden `core/` import that only
 * full-tier lint at Wave Gate start caught, after the Task had settled.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRules, lintFile } from "../../src/linter/index";
import type { Rule } from "../../src/linter/types";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

const DEFAULT_RULES_DIR = resolve(__dirname, "../../../lint-rules");
const programmaticNames = (rules: readonly Rule[]): readonly string[] =>
  rules.filter((rule) => rule.kind === "programmatic").map(({ name }) => name).sort();

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("immediate tier programmatic rules", () => {
  it("are exactly the rules whose own tier is immediate: the two import-boundary rules", () => {
    expect(programmaticNames(loadRules(DEFAULT_RULES_DIR, null, "immediate"))).toEqual([
      "no-cross-boundary-imports",
      "no-io-in-pure-modules",
    ]);
  });

  it("all still run in the full tier", () => {
    expect(programmaticNames(loadRules(DEFAULT_RULES_DIR, null, "full"))).toEqual(expect.arrayContaining([
      "max-function-lines",
      "no-cross-boundary-imports",
      "no-io-in-pure-modules",
    ]));
  });

  it("refuse the pilot's forbidden core/ import when the file is edited", () => {
    const root = canonicalTempDir("immediate-boundary-");
    cleanup.push(root);
    const file = join(root, "engine", "src", "core", "contract-status-types.ts");
    mkdirSync(join(root, "engine", "src", "core"), { recursive: true });
    writeFileSync(file, 'import type { ParsedTaskGraph } from "../state-file-wire";\nexport type View = ParsedTaskGraph;\n');
    const result = lintFile(file, "immediate", DEFAULT_RULES_DIR, null, 5_000);
    expect(result).toMatchObject({ kind: "violations", violations: [expect.objectContaining({ rule: "no-cross-boundary-imports" })] });
  });

  it("pass the allowed import the pilot's fix used", () => {
    const root = canonicalTempDir("immediate-boundary-");
    cleanup.push(root);
    const file = join(root, "engine", "src", "core", "contract-status-types.ts");
    mkdirSync(join(root, "engine", "src", "core"), { recursive: true });
    writeFileSync(file, 'import type { TaskGraph } from "../types";\nexport type View = TaskGraph;\n');
    expect(lintFile(file, "immediate", DEFAULT_RULES_DIR, null, 5_000)).toEqual({ kind: "pass" });
  });
});
