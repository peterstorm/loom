/**
 * The boundary rule, run against the tree it protects.
 *
 * `no-cross-boundary-imports.test.ts` exercises `checkBoundaryViolation` as a
 * pure function of `(filePath, resolvedImport, boundaries)` — correctly, and
 * entirely against synthetic inline fixtures. Nothing walked real source, so
 * the guarantee the rule exists to provide ("core/ never imports the shell")
 * was never actually checked, and a live violation sat at branch HEAD
 * undetected: `core/block-direct-edits.ts` imported `machine/ledger`, the
 * machine's filesystem shell, which `core/`'s allowlist denies by omission.
 *
 * This is the missing imperative shell for that pure rule: it supplies the real
 * tree as input. The rule is registered in the "full" programmatic tier, which
 * runs only at a Wave Gate over files a wave touched — so an unmodified file
 * that drifts is never re-checked by the gate. This test re-checks all of them,
 * every run.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  handler,
  DEFAULT_BOUNDARIES,
} from "../../../src/linter/programmatic/no-cross-boundary-imports";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const ENGINE_SRC = join(REPO_ROOT, "engine", "src");

/** Every non-test TypeScript module under a directory, repo-relative. */
function sourceFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") found.push(...sourceFiles(full));
      continue;
    }
    // The rule excludes nothing itself; test files are skipped here because the
    // boundaries describe production dependency arrows, not fixture imports.
    if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      found.push(relative(REPO_ROOT, full).split("\\").join("/"));
    }
  }
  return found;
}

describe("no-cross-boundary-imports — against the real engine/src tree", () => {
  const files = sourceFiles(ENGINE_SRC);

  it("finds source to check (the walk itself must not silently pass on zero files)", () => {
    // A walk that returns nothing would make the assertion below vacuously
    // true — the exact way an acceptance test rots into a no-op.
    expect(files.length).toBeGreaterThan(100);
  });

  it("reports zero boundary violations across every module", () => {
    const violations = files.flatMap((file) =>
      handler(readFileSync(join(REPO_ROOT, file), "utf-8"), file, DEFAULT_BOUNDARIES),
    );
    // Name every offender: a bare count tells whoever broke it nothing.
    expect(violations.map((v) => `${v.file}:${v.line} ${v.fixHint}`)).toEqual([]);
  });

  it("still fails when a real core module reaches into the machine's fs shell", () => {
    // Pins the detection itself, so the green assertion above cannot be green
    // because the walk or the rule quietly stopped working.
    const planted = `import { readActiveAgentRoles } from "../machine/ledger";\n`;
    const violations = handler(planted, "engine/src/core/block-direct-edits.ts", DEFAULT_BOUNDARIES);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.fixHint).toContain("engine/src/machine/ledger");
  });
});
