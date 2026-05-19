/**
 * Programmatic rule: no-cross-boundary-imports
 *
 * Enforces bounded context import boundaries. Detects when a module imports
 * from a sibling bounded context it should not depend on.
 *
 * Uses regex-based import detection (no AST needed — import statements are
 * syntactically unambiguous at the textual level).
 */

import { relative, resolve, dirname, sep } from "node:path";
import type { Violation } from "../types";
import { makeViolation } from "../types";

// --- Boundary Configuration ---

export interface BoundaryRule {
  /** Module prefix (relative to repo root, with trailing /) */
  readonly module: string;
  /** Allowed import prefixes (relative imports "./" always allowed) */
  readonly allow: readonly string[];
  /** Denied import prefixes — checked before allow */
  readonly deny: readonly string[];
}

/**
 * Default boundary rules for the loom engine.
 * These encode the architectural constraint: dependency arrows point inward.
 */
export const DEFAULT_BOUNDARIES: readonly BoundaryRule[] = [
  {
    module: "engine/src/linter/",
    allow: ["./", "node:", "ts-pattern"],
    deny: [
      "engine/src/core/",
      "engine/src/handlers/",
      "engine/src/parsers/",
      "engine/src/state-manager",
      "engine/src/cli",
    ],
  },
  {
    module: "engine/src/core/",
    allow: ["./", "node:", "engine/src/types", "engine/src/config", "ts-pattern"],
    deny: [
      "engine/src/linter/",
      "engine/src/handlers/",
      "engine/src/parsers/",
    ],
  },
  {
    module: "engine/src/parsers/",
    allow: ["./", "node:", "engine/src/types", "ts-pattern"],
    deny: [
      "engine/src/linter/",
      "engine/src/handlers/",
      "engine/src/core/",
      "engine/src/state-manager",
    ],
  },
];

// --- Import extraction ---

/**
 * Extracts import specifiers from TypeScript/JavaScript source.
 * Returns array of { line, specifier } for each import/require.
 */
export function extractImports(
  content: string
): readonly { line: number; specifier: string; text: string }[] {
  const lines = content.split("\n");
  const imports: { line: number; specifier: string; text: string }[] = [];

  // Match: import ... from "specifier"
  // Match: import "specifier"
  // Match: require("specifier")
  // Match: import("specifier") — dynamic import
  const importFromRe = /(?:from|import|require)\s*\(?["']([^"']+)["']\)?/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip comments
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }

    const match = importFromRe.exec(line);
    if (match) {
      imports.push({ line: i + 1, specifier: match[1], text: line });
    }
  }

  return imports;
}

/**
 * Resolves a relative import specifier to a repo-relative path.
 * E.g., given filePath "engine/src/linter/loader.ts" and specifier "../types",
 * returns "engine/src/types".
 */
export function resolveImportPath(filePath: string, specifier: string): string {
  if (!specifier.startsWith(".")) {
    return specifier; // absolute/bare specifier — return as-is
  }
  const fileDir = dirname(filePath);
  const resolved = resolve(fileDir, specifier);
  // Convert back to relative-to-cwd (repo root)
  return relative(process.cwd(), resolved).split(sep).join("/");
}

/**
 * Checks if a resolved import path violates any boundary rules for the given file.
 */
export function checkBoundaryViolation(
  filePath: string,
  resolvedImport: string,
  boundaries: readonly BoundaryRule[]
): string | null {
  // Normalize file path to forward slashes
  const normalizedFile = filePath.split(sep).join("/");

  // Find applicable boundary rule for this file
  const boundary = boundaries.find((b) => normalizedFile.startsWith(b.module));
  if (!boundary) {
    return null; // No boundary rule applies — allow
  }

  // Check deny list first (takes priority)
  for (const denied of boundary.deny) {
    if (resolvedImport.startsWith(denied)) {
      return `Module "${boundary.module}" must not import from "${denied}" — violates bounded context boundary`;
    }
  }

  return null; // Not denied — allow
}

// --- Rule handler ---

/**
 * Programmatic rule handler for no-cross-boundary-imports.
 * Scans imports and checks each against boundary rules.
 */
export function handler(content: string, filePath: string): Violation[] {
  const imports = extractImports(content);
  const violations: Violation[] = [];

  for (const imp of imports) {
    const resolved = resolveImportPath(filePath, imp.specifier);
    const violation = checkBoundaryViolation(filePath, resolved, DEFAULT_BOUNDARIES);

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
