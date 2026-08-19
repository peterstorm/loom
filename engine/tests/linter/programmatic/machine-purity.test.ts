/**
 * Self-lint: the guarded-skill-machine pure core is machine-checked pure.
 *
 * Two layers:
 * 1. The shipped no-io-in-pure-modules rule (with its shipped defaults —
 *    the machine core is part of DEFAULT_PURE_MODULES) passes over every
 *    pure machine module.
 * 2. A transitive import walk: every relative import of a pure machine
 *    module must resolve to another declared-pure module, so the reducer
 *    (advance.ts) can never re-acquire node:fs through a dependency — the
 *    FC/IS boundary of the machine is enforced here, not by prose.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import {
  handler as noIoHandler,
  isPureModule,
  DEFAULT_PURE_MODULES,
} from "../../../src/linter/programmatic/no-io-in-pure-modules";

const REPO_ROOT = resolve(__dirname, "../../../..");

/** The machine's functional core. ledger.ts / report-discovery.ts /
 *  session-registry.ts are the imperative shell — deliberately absent. */
const MACHINE_PURE_MODULES = [
  "engine/src/machine/types.ts",
  "engine/src/machine/advance.ts",
  "engine/src/machine/parse-machine.ts",
  "engine/src/machine/extract-evidence.ts",
  "engine/src/machine/mermaid.ts",
  "engine/src/machine/test-report.ts",
  "engine/src/machine/evidence.ts",
] as const;

/** Pure modules outside machine/ that the core may depend on. */
const PURE_DEPENDENCIES = [
  "engine/src/core/frozen.ts",
  "engine/src/core/tool-vocabulary.ts",
  "engine/src/core/shell-ansi-c.ts",
  "engine/src/core/shell-normalize.ts",
  "engine/src/core/shell-quoting.ts",
] as const;

/** Side-effect-free package imports the core may use. */
const PURE_PACKAGE_ALLOW = new Set(["ts-pattern"]);

const PURE_CLOSURE = new Set<string>([...MACHINE_PURE_MODULES, ...PURE_DEPENDENCIES]);

function importSpecifiers(content: string): string[] {
  return [...content.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

describe("machine pure core — self-lint via no-io-in-pure-modules", () => {
  it("every pure machine module is covered by the shipped DEFAULT_PURE_MODULES", () => {
    for (const mod of MACHINE_PURE_MODULES) {
      expect(DEFAULT_PURE_MODULES, `${mod} must be in DEFAULT_PURE_MODULES`).toContain(mod);
      expect(isPureModule(mod)).toBe(true);
    }
  });

  it("the shell modules are NOT declared pure (they own the I/O)", () => {
    for (const shell of [
      "engine/src/machine/ledger.ts",
      "engine/src/machine/report-discovery.ts",
      "engine/src/machine/session-registry.ts",
    ]) {
      expect(isPureModule(shell), `${shell} must not be pure-listed`).toBe(false);
    }
  });

  it.each([...MACHINE_PURE_MODULES, ...PURE_DEPENDENCIES])(
    "%s passes the no-io-in-pure-modules rule",
    (mod) => {
      const content = readFileSync(resolve(REPO_ROOT, mod), "utf-8");
      // Run with the pure list forced to include this file, so PURE_DEPENDENCIES
      // are held to the same standard even before they join the defaults.
      const violations = noIoHandler(content, mod, [mod]);
      expect(violations, violations.map((v) => `${v.file}:${v.line} ${v.fixHint}`).join("\n")).toEqual([]);
    },
  );

  it("the pure core's transitive imports never leave the pure closure", () => {
    for (const mod of PURE_CLOSURE) {
      const abs = resolve(REPO_ROOT, mod);
      const content = readFileSync(abs, "utf-8");
      for (const spec of importSpecifiers(content)) {
        if (spec.startsWith(".")) {
          const resolved = relative(REPO_ROOT, resolve(dirname(abs), spec)) + ".ts";
          expect(
            PURE_CLOSURE.has(resolved),
            `${mod} imports ${spec} → ${resolved}, which is not a declared pure module — ` +
              `the reducer's transitive closure would re-acquire I/O`,
          ).toBe(true);
        } else {
          expect(
            PURE_PACKAGE_ALLOW.has(spec),
            `${mod} imports package "${spec}" which is not on the pure allow-list`,
          ).toBe(true);
        }
      }
    }
  });

  it("advance.ts (the reducer) and its closure carry no node:* import at all", () => {
    const visited = new Set<string>();
    const queue = ["engine/src/machine/advance.ts"];
    while (queue.length > 0) {
      const mod = queue.pop()!;
      if (visited.has(mod)) continue;
      visited.add(mod);
      const abs = resolve(REPO_ROOT, mod);
      const content = readFileSync(abs, "utf-8");
      for (const spec of importSpecifiers(content)) {
        expect(spec.startsWith("node:"), `${mod} imports ${spec}`).toBe(false);
        if (spec.startsWith(".")) {
          queue.push(relative(REPO_ROOT, resolve(dirname(abs), spec)) + ".ts");
        }
      }
    }
    // Sanity: the walk actually traversed the closure.
    expect(visited).toContain("engine/src/machine/test-report.ts");
    expect(visited).toContain("engine/src/machine/types.ts");
  });
});
