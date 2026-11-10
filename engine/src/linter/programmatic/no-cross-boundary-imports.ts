/**
 * Programmatic rule: no-cross-boundary-imports
 *
 * Enforces bounded context import boundaries. Detects when a module imports
 * from a sibling bounded context it should not depend on.
 *
 * Supports both TypeScript (import/require with quotes) and Java (import pkg.Class;).
 * Uses regex-based import detection (no AST needed).
 */

import { dirname, join, sep } from "node:path";
import type { Violation } from "../types";
import { makeViolation } from "../types";
import { isAbsolutePath, projectRelative } from "./baseline";

// --- Boundary Configuration ---

/**
 * One file's capability beyond its boundary's allowlist, and why it was
 * granted. A grant is an exception, so it carries its justification as data:
 * the boundaries live in a project's `config.json`, which cannot hold comments.
 */
export type CapabilityGrant = Readonly<{
  allow: readonly string[];
  reason: string;
}>;

export interface BoundaryRule {
  /**
   * The prefix, relative to repo root, selecting the files this rule governs.
   * Directory prefixes carry a trailing `/` (`engine/src/core/`); a bare
   * file-stem (`engine/src/state-manager`) matches only at a path boundary
   * (see underPrefix), so it can never swallow a sibling like
   * `engine/src/state-managerX/`.
   */
  readonly module: string;
  /** What this module is and which way its dependencies point. */
  readonly description?: string;
  /** Allowed import prefixes — imports must match at least one (allowlist) */
  readonly allow: readonly string[];
  /** Denied import prefixes — checked first, overrides allow */
  readonly deny: readonly string[];
  /**
   * Per-FILE capability allowlist, keyed by repo-relative module path. When a
   * file is listed here, an import matching one of its granted prefixes is
   * admitted even though the blanket `allow` would refuse it. This is the
   * mechanism that makes I/O capability per-module rather than per-directory:
   * a boundary with NO blanket `node:` allowance refuses every node builtin in
   * a file it does not name here, so each one is an explicit, reviewed
   * exception.
   */
  readonly perFileAllow?: Readonly<Record<string, CapabilityGrant>>;
  /** Audited package entrypoints: exact specifier equality, never a prefix grant. */
  readonly perFileExactAllow?: Readonly<Record<string, CapabilityGrant>>;
}

/**
 * The shipped default governs nothing: which way a project's dependency
 * arrows point is the project's architecture, so its boundaries live in its own
 * `config.json` (Loom's are in `.claude/linter/rules/config.json`).
 */
export const DEFAULT_BOUNDARIES: readonly BoundaryRule[] = Object.freeze([]);

/**
 * How strictly the boundary rule reads a file no boundary names.
 * `requireGovernance` lists the path prefixes inside which every file must be
 * governed: there an ungoverned file is a violation ("ungoverned module"),
 * where elsewhere it may import anything. `projectRoot` is the root the
 * boundary prefixes are written against, used to relativize absolute paths.
 */
export type BoundaryOptions = Readonly<{
  requireGovernance: readonly string[];
  projectRoot: string | null;
}>;

export const DEFAULT_BOUNDARY_OPTIONS: BoundaryOptions = Object.freeze({ requireGovernance: Object.freeze([]), projectRoot: null });

// --- Import extraction ---

/**
 * Reject captures that cannot be module specifiers.
 *
 * The regex is line-based, so prose describing an import still matches — a
 * diagnostic like `` `must not import from "${denied}"` `` captured
 * `${denied}` and reported the message string as a cross-boundary import.
 * This line-regex extractor deliberately rejects whitespace and template
 * interpolation as conservative tells; that is not a claim about every string
 * JavaScript grammar permits as a module specifier.
 */
function isPlausibleSpecifier(specifier: string | undefined): specifier is string {
  return specifier !== undefined &&
    specifier.length > 0 &&
    !specifier.includes("${") &&
    !/\s/.test(specifier);
}

/**
 * Extracts import specifiers from TypeScript/JavaScript/Java source.
 * Handles:
 *   - TS/JS: import ... from "specifier", import "specifier", require("specifier")
 *   - Java: import com.example.package.Class;
 */
export function extractImports(
  content: string
): readonly { line: number; specifier: string; text: string }[] {
  const lines = content.split("\n");
  const imports: { line: number; specifier: string; text: string }[] = [];

  // TS/JS: import/require with quoted specifier
  // The keyword must start a token. Without the leading guard, the bare word
  // `from` INSIDE a string literal matches — a union like
  // `"renamed-from" | "renamed-to"` yielded the phantom specifier `" | "` and
  // reported it as a cross-boundary import. A real `from`/`import`/`require`
  // is always at the start of a line or preceded by one of the characters in
  // the guard class `[\s})*;,=]` — whitespace, `}`, `)`, `*`, `;`, `,`, `=`
  // (as in `} from`, `* as ns from`, `= require(`).
  const tsImportRe = /(?:^|[\s})*;,=])(?:from|import|require)\s*\(?["']([^"']+)["']\)?/;
  // Java: import com.example.Foo; or import static com.example.Foo.bar; or import java.util.*;
  const javaImportRe = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/;

  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("//")) continue;

    const tsMatch = tsImportRe.exec(line);
    if (tsMatch && isPlausibleSpecifier(tsMatch[1])) {
      imports.push({ line: i + 1, specifier: tsMatch[1], text: line });
      continue;
    }

    const javaMatch = javaImportRe.exec(line);
    if (javaMatch) {
      imports.push({ line: i + 1, specifier: javaMatch[1], text: line });
    }
  }

  return imports;
}

/**
 * Resolves a relative import specifier to a repo-relative path.
 * Uses purely relative path math — no process.cwd() dependency.
 *
 * For relative specifiers (./foo, ../bar): joins against file's directory.
 * For bare/absolute specifiers: returns as-is.
 */
export function resolveImportPath(filePath: string, specifier: string): string {
  if (!specifier.startsWith(".")) {
    return specifier; // bare/absolute specifier — return as-is
  }
  const fileDir = dirname(filePath);
  // Pure path join without resolve() — stays relative to repo root
  const joined = join(fileDir, specifier);
  // Normalize separators to forward slashes
  return joined.split(sep).join("/");
}

/**
 * Does `path` fall under `prefix`? Directory prefixes (trailing `/`) and
 * namespace prefixes (`node:`, `ts-pattern` — no embedded path separator)
 * match by plain containment. A path-like prefix WITHOUT a trailing slash
 * (`engine/src/state-manager`) matches only at a path boundary — exactly, a
 * directory below (`prefix/…`), or a file extension (`prefix.…`) — so it
 * cannot mid-segment-match a sibling like `engine/src/state-managerX/`.
 */
export function underPrefix(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  if (prefix.includes("/") && !prefix.endsWith("/") && path.length > prefix.length) {
    const next = path[prefix.length];
    return next === "/" || next === ".";
  }
  return true;
}

/**
 * Checks if a resolved import path violates any boundary rules for the given file.
 *
 * Enforcement model:
 *   1. Find the boundary rule matching this file's path
 *   2. Check DENY list first — explicit denials always block
 *   3. Check the additive per-file capability allowlist (perFileAllow) — a
 *      named file may additionally import its listed prefixes
 *   4. Check the directory ALLOW list — import may match any allow entry
 *   5. If none admits the import — violation (fail-closed allowlist)
 */
export function checkBoundaryViolation(
  filePath: string,
  resolvedImport: string,
  boundaries: readonly BoundaryRule[]
): string | null {
  const normalizedFile = filePath.split(sep).join("/");
  const boundary = boundaries.find((b) => underPrefix(normalizedFile, b.module));
  if (!boundary) {
    return null; // No boundary rule applies — allow
  }

  for (const denied of boundary.deny) {
    if (underPrefix(resolvedImport, denied)) {
      return `Module "${boundary.module}" must not import from "${denied}" — violates bounded context boundary`;
    }
  }

  // Additive per-file capability allowlist, checked before the directory allow.
  // This is how `node:` hardware is granted to named core modules without
  // removing their ordinary directory-level imports.
  if (boundary.perFileExactAllow?.[normalizedFile]?.allow.includes(resolvedImport)) return null;
  const perFile = boundary.perFileAllow?.[normalizedFile]?.allow;
  if (perFile !== undefined) {
    if (perFile.some((allowed) => underPrefix(resolvedImport, allowed))) {
      return null;
    }
  } else if (resolvedImport.startsWith("node:")) {
    // Fail closed: a node: import in an unlisted file of a boundary that does
    // not blanket-allow node: is refused with the explicit capability message.
    const blanketNode = boundary.allow.some((allowed) => underPrefix(resolvedImport, allowed));
    if (!blanketNode) {
      return `Module "${boundary.module}" grants node: builtins per-module only; ${resolvedImport} is not on the capability list for ${normalizedFile}`;
    }
  }

  const isAllowed = boundary.allow.some((allowed) => underPrefix(resolvedImport, allowed));
  if (!isAllowed) {
    return `Module "${boundary.module}" may only import from [${boundary.allow.join(", ")}] — "${resolvedImport}" is not allowed`;
  }

  return null; // Explicitly allowed and not denied
}

// --- Path normalization ---

/**
 * Reduce an absolute path to the repository-relative form the boundary rules
 * are written in, when the project root is not known.
 *
 * Boundary `module` prefixes are repo-relative (`engine/src/core/`), but
 * `lintFile` resolves every path to absolute before handing it to a rule. An
 * absolute path matches no prefix, so `checkBoundaryViolation` found no
 * applicable rule and returned "allow" for every file — the rule failed OPEN
 * and enforced nothing in production.
 *
 * The repository root is not threaded into rule handlers, so it is recovered
 * from the boundary prefixes themselves: a full boundary prefix occurring at a
 * segment boundary marks where the repo-relative portion begins. The RIGHTMOST
 * such occurrence wins — a checkout nested inside a directory of the same
 * shape (`/srv/engine/src/core/checkout/engine/src/core/x.ts`) must resolve
 * against its own root, and taking the leftmost match would climb out of it.
 *
 * A path already relative is returned unchanged, so the direct-call form used
 * by tests and tooling keeps working.
 */
export function toRepositoryRelative(
  filePath: string,
  boundaries: readonly BoundaryRule[] = DEFAULT_BOUNDARIES
): string {
  const normalized = filePath.split(sep).join("/");
  if (!normalized.startsWith("/")) return normalized;

  let bestIndex = -1;
  for (const boundary of boundaries) {
    const index = normalized.lastIndexOf(`/${boundary.module}`);
    if (index > bestIndex) bestIndex = index;
  }
  return bestIndex === -1 ? normalized : normalized.slice(bestIndex + 1);
}

/**
 * The project-relative path of the file being linted: exact against the
 * project root when it is known and contains the file (the one relativization
 * the baselined rules share, `projectRelative`), otherwise — an absolute path
 * outside the root, or no root at all — recovered from the boundary prefixes
 * (`toRepositoryRelative`).
 */
function relativeToProjectOrBoundaries(filePath: string, boundaries: readonly BoundaryRule[], projectRoot: string | null): string {
  const fromRoot = projectRelative(filePath, projectRoot);
  return isAbsolutePath(fromRoot) ? toRepositoryRelative(filePath, boundaries) : fromRoot;
}

/**
 * The governance root a file lies under while no boundary names it, or null.
 * Such a file is an ungoverned module: its dependencies point wherever they
 * please, so a project that requires governance refuses it outright.
 */
export function ungovernedRoot(
  relativeFile: string,
  boundaries: readonly BoundaryRule[],
  requireGovernance: readonly string[],
): string | null {
  if (boundaries.some((b) => underPrefix(relativeFile, b.module))) return null;
  return requireGovernance.find((root) => underPrefix(relativeFile, root)) ?? null;
}

// --- Rule handler ---

/**
 * Programmatic rule handler for no-cross-boundary-imports.
 * Scans imports and checks each against boundary rules; under
 * `requireGovernance`, a file no boundary names is itself a violation.
 */
export function handler(
  content: string,
  filePath: string,
  boundaries: readonly BoundaryRule[] = DEFAULT_BOUNDARIES,
  options: BoundaryOptions = DEFAULT_BOUNDARY_OPTIONS,
): Violation[] {
  // Normalize ONCE at entry: `resolveImportPath` joins against this path, so a
  // relative file path yields relative resolved imports for free.
  const relativeFile = relativeToProjectOrBoundaries(filePath, boundaries, options.projectRoot);
  const ungoverned = ungovernedRoot(relativeFile, boundaries, options.requireGovernance);
  if (ungoverned !== null) {
    return [makeViolation(
      "no-cross-boundary-imports",
      filePath,
      1,
      content.split("\n")[0] ?? "",
      `Ungoverned module: "${relativeFile}" lies under "${ungoverned}", where every file must belong to a boundary rule — add the boundary its directory (or file) needs to config.json, stating which way its imports point.`,
    )];
  }
  const violations: Violation[] = [];

  for (const imp of extractImports(content)) {
    const resolved = resolveImportPath(relativeFile, imp.specifier);
    const violation = checkBoundaryViolation(relativeFile, resolved, boundaries);

    if (violation) {
      violations.push(
        makeViolation(
          "no-cross-boundary-imports",
          filePath,
          imp.line,
          imp.text,
          `Remove this import. ${violation}`
        )
      );
    }
  }

  return violations;
}
