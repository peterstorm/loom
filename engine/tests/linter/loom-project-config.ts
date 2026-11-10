/**
 * Loom's OWN linter configuration, read from the repository's
 * `.claude/linter/rules/config.json` through the production loader.
 *
 * The shipped rule defaults are generic (a project with no config gets no
 * boundaries and no purity scope), so every test that asserts something about
 * Loom's architecture — which modules are pure, which way the engine's imports
 * point, which files may import the TypeScript compiler API — reads it from
 * here: the same bytes the hook and `scripts/lint-project.ts` enforce.
 */

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectConfig } from "../../src/linter/loader";
import { boundaryOptions, purityScope } from "../../src/linter/programmatic";
import type { BoundaryOptions, BoundaryRule } from "../../src/linter/programmatic/no-cross-boundary-imports";
import type { PurityScope } from "../../src/linter/programmatic/no-io-in-pure-modules";
import type { ProgrammaticConfig } from "../../src/linter/programmatic/config";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const LOOM_RULES_DIR = join(REPO_ROOT, ".claude/linter/rules");

export const LOOM_CONFIG: ProgrammaticConfig = loadProjectConfig(LOOM_RULES_DIR);
export const LOOM_BOUNDARIES: readonly BoundaryRule[] = LOOM_CONFIG.boundaries ?? [];
export const LOOM_PURITY_SCOPE: PurityScope = purityScope(LOOM_CONFIG);

/** Loom's boundary options with paths written repo-relative (no project root to strip). */
export const LOOM_BOUNDARY_OPTIONS: BoundaryOptions = boundaryOptions(LOOM_CONFIG, null);

/**
 * ADR-0042 (G5b INV-1, amended by G2 AD-6): the only modules through which the
 * TypeScript compiler API enters engine code. The one list is the boundary
 * grants in config.json — every file granted the exact `typescript`
 * specifier. machine-purity's closure audit and the INV-1 regex rule's
 * `excludePatterns` mirror both derive from or are checked against this.
 */
export const TYPESCRIPT_COMPILER_API_SEAMS: readonly string[] = Object.freeze(
  LOOM_BOUNDARIES.flatMap((boundary) => Object.entries(boundary.perFileExactAllow ?? {}))
    .filter(([, grant]) => grant.allow.includes("typescript"))
    .map(([file]) => file)
    .sort(),
);

/** Every specifier a file is granted beyond its boundary's allowlist — exact and prefix grants, node builtins included. */
export function grantedPackages(file: string): readonly string[] {
  return LOOM_BOUNDARIES.flatMap((boundary) => [
    ...(boundary.perFileExactAllow?.[file]?.allow ?? []),
    ...(boundary.perFileAllow?.[file]?.allow ?? []),
  ]);
}
