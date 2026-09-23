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

// --- Boundary Configuration ---

export interface BoundaryRule {
  /**
   * The prefix, relative to repo root, selecting the files this rule governs.
   * Directory prefixes carry a trailing `/` (`engine/src/core/`); a bare
   * file-stem (`engine/src/state-manager`) matches only at a path boundary
   * (see underPrefix), so it can never swallow a sibling like
   * `engine/src/state-managerX/`.
   */
  readonly module: string;
  /** Allowed import prefixes — imports must match at least one (allowlist) */
  readonly allow: readonly string[];
  /** Denied import prefixes — checked first, overrides allow */
  readonly deny: readonly string[];
  /**
   * Per-FILE capability allowlist, keyed by repo-relative module path. When a
   * file is listed here, an import matching one of its allowed prefixes is
   * admitted even though the blanket `allow` would refuse it. This is the
   * mechanism that makes I/O capability per-module rather than per-directory:
   * `engine/src/core/` deliberately has NO blanket `node:` allowance, so every
   * filesystem/byte import in the functional core is an explicit, reviewed
   * exception named here — a future I/O import in an unlisted core module
   * fails the lint gate until it earns an entry.
   */
  readonly perFileAllow?: Readonly<Record<string, readonly string[]>>;
  /** Audited package entrypoints: exact specifier equality, never a prefix grant. */
  readonly perFileExactAllow?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Default boundary rules for the loom engine.
 * These encode the architectural constraint: dependency arrows point inward.
 */
export const DEFAULT_BOUNDARIES: readonly BoundaryRule[] = [
  {
    module: "engine/src/linter/",
    allow: ["./", "engine/src/linter/", "node:", "ts-pattern"],
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
    allow: [
      "./",
      "engine/src/core/",
      // NO blanket `node:` here — I/O capability in the functional core is
      // per-module, an explicit reviewed exception for every byte/fs import
      // (see perFileAllow below). The only core modules that may touch node
      // builtins are exactly the ones enumerated there.
      "engine/src/types",
      "engine/src/config",
      // Pure machine-core modules only: identity brands (parseSessionId in
      // block-direct-edits) and the gate-wired tool vocabulary source
      // (tool-vocabulary derives FILE_MODIFYING_TOOLS from GATE_WIRED_TOOLS).
      // The machine's fs shell (ledger/report-discovery) stays denied by
      // omission — this allowlist is fail-closed.
      "engine/src/machine/evidence",
      "engine/src/machine/types",
      // extract-evidence is the same pure family: it folds transcript spans
      // using core's own tool vocabulary and shell normalizer and touches no
      // filesystem. Listed individually rather than opening `machine/`, which
      // would also admit the ledger and report-discovery shells.
      "engine/src/machine/extract-evidence",
      // Narrow pure helpers: extract-task-id uses core/task-id for canonical
      // Task identity; the other two have no imports. These explicit entries
      // admit no shell/I/O dependency. The rest of utils stays denied rather
      // than granting access to its filesystem and locking helpers.
      "engine/src/utils/extract-task-id",
      "engine/src/utils/no-finding-sentinel",
      "engine/src/utils/strip-namespace",
      // find-file imports only `node:fs` and `node:path`. The core boundary's
      // formerly blanket `node:` allowance is now per-module, and this
      // narrow wrapper over the same calls is enumerated below — the
      // capability policed is protected-state WRITING: `engine/src/state-manager`
      // stays unlisted, and `validate-phase-order` takes its state read as an
      // injected dependency instead.
      // NOTE: unlike the per-file grant below, this is a LIVE import grant —
      // no deny matches and no per-file lookup is needed, so any governed
      // core file may import `engine/src/utils/find-file` through it today.
      // It is live-but-unused: no current core file has exercised it. It is
      // permission to read the filesystem walk, never to write protected
      // state. Should find-file move under core/, imports would resolve to
      // the new core path (already covered by this boundary's `./`), and this
      // line would go dead rather than gate-breaking.
      "engine/src/utils/find-file",
      "ts-pattern",
    ],
    // Every core module that touches a node builtin, and exactly the subpaths
    // it uses. `node:crypto` is digest-only (pure hashing); `node:path` is
    // pure path math; `node:fs` is the deliberately-sanctioned gate I/O;
    // `node:util` is isDeepStrictEqual. A future I/O import in a module that
    // is not listed here — or a listed module reaching a new subpath — fails
    // the lint gate until it is reviewed and named.
    //
    // The map grants; it does not certify. An entry for a module that has since
    // dropped the import is stale permission, not a lint failure — this list is
    // fail-closed on ADDING capability, so nothing catches a grant going unused.
    // `identity.ts` sat here for `node:crypto`/`node:path` after it had lost
    // every import statement; it is now off the list.
    perFileExactAllow: {
      "engine/src/core/reviewer-contract.ts": ["zod/v4"],
      "engine/src/core/standalone-lineage-contract.ts": ["zod/v4"],
      "engine/src/core/reviewer-protocol.ts": ["jsonc-parser"],
    },
    perFileAllow: {
      // Cross-branch pre-provisioning, INERT in this checkout: the feature-
      // branch `block-direct-edits` normalizes panel/spec-artifact targets
      // with pure path math (posix.normalize) before the prefix test, but the
      // module checked in at this HEAD makes no node:path import (the
      // normalization landed only on feat/defect-stale-flow and
      // feat/grammar-constrained-decoding). Same tolerance as the find-file
      // entry below: stale permission, not a lint failure.
      "engine/src/core/block-direct-edits.ts": ["node:path"],
      // Cross-branch pre-provisioning, INERT in this checkout: the feature-
      // branch `emission-ingestion` folds a digest over captured payload
      // bytes (digest-only hashing, mirroring review-packet/panel-program),
      // but that module does not exist on this branch — the only occurrence
      // of its name in this tree is this grant line. Same tolerance as the
      // find-file entry below: stale permission, not a lint failure.
      "engine/src/core/emission-ingestion.ts": ["node:crypto"],
      "engine/src/core/harness-capture.ts": ["node:crypto"],
      "engine/src/core/harness-resources.ts": ["node:crypto", "node:path"],
      "engine/src/core/legacy-archive.ts": ["node:crypto"],
      "engine/src/core/orchestration-contract/bytes.ts": ["node:crypto"],
      "engine/src/core/orchestration-contract/effects.ts": ["node:path"],
      "engine/src/core/orchestration-contract/publication.ts": ["node:crypto"],
      // The Spec Index: a total pure grammar whose only node use is a content
      // digest. It lives in core/ rather than parsers/ because the Requirement
      // Coverage Projection joins against it, and core may not import parsers.
      // The rule that move established: a DOMAIN grammar whose output is a
      // value object carrying invariants belongs in core/; a harness or tool
      // OUTPUT scraper (transcripts, bash output, changed-file lists) belongs
      // in parsers/.
      "engine/src/core/parse-spec.ts": ["node:crypto"],
      "engine/src/core/panel-kernel.ts": ["node:path"],
      "engine/src/core/phase-artifact-paths.ts": ["node:path"],
      "engine/src/core/panel-program.ts": ["node:crypto"],
      "engine/src/core/remediation-machine.ts": ["node:crypto"],
      "engine/src/core/repository-path.ts": ["node:path"],
      "engine/src/core/review-packet.ts": ["node:crypto"],
      "engine/src/core/review-panel.ts": ["node:path"],
      "engine/src/core/standalone-review.ts": ["node:crypto", "node:util"],
      // Exact runtime entry and transitive implementation bytes are gated by machine-purity.
      "engine/src/core/structured-test-report.ts": ["saxes"],
      "engine/src/core/wave-gate-machine.ts": ["node:crypto"],
      // Cross-branch pre-provisioning, deliberate. TODAY this per-file grant
      // is INERT with zero granted capability: `find-file` sits in utils/,
      // which NO boundary rule governs, so the per-file lookup only runs for
      // files the core boundary actually governs, and this entry never
      // matches. (The core `allow` line naming the module is a different
      // case — a live, unused IMPORT grant; see its comment above.) The entry
      // is kept, not pruned: it is the reviewed node:-capability grant for
      // the day a boundary comes to govern utils/, where dropping it now
      // would indeed fail that future gate until re-reviewed. A move of
      // find-file under core/ would NOT be rescued by this entry — the moved
      // file's `node:` imports would need a fresh capability entry at the new
      // path, re-reviewed at that move — and the stale utils-path entry would
      // simply go dead.
      "engine/src/utils/find-file.ts": ["node:fs", "node:path"],
    },
    deny: [
      "engine/src/linter/",
      "engine/src/handlers/",
      "engine/src/parsers/",
    ],
  },
  {
    module: "engine/src/parsers/",
    allow: [
      "./",
      "engine/src/parsers/",
      "node:",
      "engine/src/types",
      // The single source of truth for harness tool names. Both
      // parse-bash-test-output and parse-files-modified must classify spans
      // using the SAME vocabulary the gates are wired for; a parser-local copy
      // is exactly the drift GATE_WIRED_TOOLS exists to prevent. Nothing else
      // in core/ is reachable — this allowlist stays fail-closed.
      "engine/src/core/tool-vocabulary",
      "ts-pattern",
    ],
    deny: [
      "engine/src/linter/",
      "engine/src/handlers/",
      // `engine/src/core/` is NOT denied here, and the omission is deliberate.
      // Deny is evaluated before allow, so a blanket core deny would override
      // the one core module parsers must share (tool-vocabulary). The allow
      // list is fail-closed — every other core module is refused by not
      // appearing in it — so the protection is unchanged and the single
      // sanctioned exception becomes expressible.
      "engine/src/state-manager",
    ],
  },
  {
    // The orchestration shell drives the pure core through Fugue and owns the
    // filesystem/protected-state/Git effects. Arrows point inward: it may
    // import the core, but the core's own allowlist already refuses to import
    // it back, so the functional core can never acquire a runtime dependency.
    module: "engine/src/orchestration/",
    allow: [
      "./",
      "engine/src/orchestration/",
      "engine/src/core/",
      "engine/src/utils/",
      "engine/src/types",
      "engine/src/config",
      "engine/src/state-manager",
      // The same pure identity-brand module `core/` is allowed. What it
      // actually supplies here is `SessionId`/`parseSessionId` and the
      // run-directory suffix vocabulary (`ORCHESTRATION_RUNS_SUFFIX`) — see
      // `orchestration/session-run-bindings`, the sole consumer. `RequestId`
      // is NOT among them; it arrives from `core/orchestration-contract`,
      // allowed separately above. The machine's fs shell (`machine/ledger`,
      // `machine/report-discovery`) stays denied by omission — this allowlist
      // is fail-closed, so naming the pure module individually cannot open a
      // path into the shell.
      "engine/src/machine/evidence",
      "node:",
      "@fuguejs/framework",
      "zod",
      "ts-pattern",
    ],
    deny: [
      "engine/src/linter/",
      "engine/src/handlers/",
      "engine/src/parsers/",
    ],
  },
];

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
  if (boundary.perFileExactAllow?.[normalizedFile]?.includes(resolvedImport)) return null;
  const perFile = boundary.perFileAllow?.[normalizedFile];
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
 * are written in.
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

// --- Rule handler ---

/**
 * Programmatic rule handler for no-cross-boundary-imports.
 * Scans imports and checks each against boundary rules.
 */
export function handler(
  content: string,
  filePath: string,
  boundaries: readonly BoundaryRule[] = DEFAULT_BOUNDARIES
): Violation[] {
  const imports = extractImports(content);
  const violations: Violation[] = [];
  // Normalize ONCE at entry: `resolveImportPath` joins against this path, so a
  // relative file path yields relative resolved imports for free.
  const relativeFile = toRepositoryRelative(filePath, boundaries);

  for (const imp of imports) {
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
