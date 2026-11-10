/**
 * Programmatic rule: no-io-in-pure-modules
 *
 * Detects I/O operations and non-determinism in modules declared as
 * "functional core" (pure). Enforces the FC/IS boundary at the file level.
 *
 * Detection strategy: check imports for I/O modules + scan for banned globals.
 */

import type { Violation } from "../types";
import { makeViolation } from "../types";
import { match } from "ts-pattern";
import { isTestFile, type ReasonedPath } from "./config";

// --- Configuration ---

/**
 * Which files the rule holds to purity: every NON-TEST file under a
 * `pureModules` entry (a directory root with a trailing `/`, or one file),
 * minus the `impureModules` shells — each named with the I/O it does.
 *
 * Pure by default inside the roots, so a new file in the functional core is
 * checked the moment it exists; a shell inside a root has to be declared, with
 * its reason, rather than being exempt by omission from an allowlist.
 */
export type PurityScope = Readonly<{
  pureModules: readonly string[];
  impureModules: readonly ReasonedPath[];
}>;

/**
 * The shipped default checks nothing: which directories form a project's
 * functional core is the project's decision, so its roots and shells live in
 * its own `config.json` (Loom's are in `.claude/linter/rules/config.json`).
 */
export const DEFAULT_PURITY_SCOPE: PurityScope = Object.freeze({ pureModules: Object.freeze([]), impureModules: Object.freeze([]) });

/** Where one file stands under a purity scope. */
export type PurityClassification =
  | Readonly<{ kind: "pure" }>
  | Readonly<{ kind: "shell"; path: string; reason: string }>
  | Readonly<{ kind: "test" }>
  | Readonly<{ kind: "unscoped" }>;

/** Import specifiers that indicate I/O capability or ambient non-determinism */
export const IO_IMPORTS: readonly string[] = [
  // Node.js / TypeScript
  "node:fs",
  "node:net",
  "node:http",
  "node:https",
  "node:child_process",
  "node:dgram",
  "node:dns",
  "node:tls",
  "node:crypto",
  "node:os",
  "node:process",
  "node:worker_threads",
  "node:readline",
  "node:util",
  "crypto",
  "process",
  "util",
  "fs",
  "net",
  "http",
  "https",
  "child_process",
  // Java
  "java.io",
  "java.nio.file",
  "java.net",
  "java.sql",
  "javax.sql",
  "jakarta.servlet",
  "javax.servlet",
  "java.lang.ProcessBuilder",
];

/** Global expressions that indicate side effects or non-determinism.
 *  NOTE: these are banned in PURE modules only (the rule fires solely for
 *  files the scope classifies pure) — shell modules keep using process.stderr etc. */
export const BANNED_GLOBALS: readonly { pattern: RegExp; description: string }[] = [
  { pattern: /\bprocess\.exit\b/, description: "process.exit (control flow side effect)" },
  { pattern: /\bprocess\.env\b/, description: "process.env (environment I/O)" },
  { pattern: /\bprocess\.(stdout|stderr)\.write\b/, description: "process.stdout/stderr.write (I/O — pure modules return data; shells own the streams)" },
  { pattern: /\bfetch\s*\(/, description: "fetch() (network I/O)" },
  { pattern: /\bconsole\.(log|error|warn|info|debug)\b/, description: "console output (I/O)" },
  { pattern: /\bMath\.random\s*\(/, description: "Math.random() (non-determinism)" },
  { pattern: /\bnew\s+Date\s*\(\s*\)/, description: "new Date() without argument (non-determinism)" },
  { pattern: /\bDate\.now\s*\(/, description: "Date.now() (non-determinism — inject the clock)" },
  { pattern: /\bperformance\.now\s*\(/, description: "performance.now() (non-determinism)" },
  { pattern: /\bset(Timeout|Interval)\s*\(/, description: "setTimeout/setInterval (scheduling side effect)" },
  { pattern: /\bcrypto\s*\.\s*(randomUUID|randomBytes|randomFill|randomFillSync|getRandomValues)\b/, description: "crypto entropy (non-determinism — inject the random source)" },
  { pattern: /\bprocess\s*\.\s*(cwd|chdir|hrtime|uptime|platform|arch|argv|pid|kill|nextTick)\b/, description: "process ambient state or effects (inject shell-observed data)" },
];

/** Import specifiers allowed even in pure modules (side-effect free) */
export const PURE_ALLOW_LIST: readonly string[] = [
  "node:path",
  "node:url",
  "path",
  "url",
  "ts-pattern",
  // The security-audit contract parses its run metadata with a schema, and zod
  // is this repo's derive-types-from-source-of-truth tool: a pure parse.
  "zod/v4",
];

/** Capability-level exceptions, never whole crypto/util modules. Hash instances
 * stay local to deterministic byte transforms; randomness and debug I/O do not.
 * Namespace/default/require/dynamic imports cannot prove a narrow capability. */
const PURE_CAPABILITY_IMPORTS: readonly RegExp[] = [
  /\bimport\s+\{\s*createHash(?:\s+as\s+[\w$]+)?\s*,?\s*\}\s+from\s*["'](?:node:)?crypto["']/g,
  /\bimport\s+\{\s*isDeepStrictEqual(?:\s+as\s+[\w$]+)?\s*,?\s*\}\s+from\s*["'](?:node:)?util["']/g,
];

// --- Matching ---

/**
 * Does a file path fall under one scope entry? Matching is prefix/exact —
 * never a bare substring: a directory entry (trailing /) matches paths that
 * START with it or contain it at a path boundary (`/<entry>`); a file entry
 * matches exactly or at a path boundary. The boundary form is what lets an
 * absolute path (the hook and `lintFile` resolve every path) match a
 * project-relative entry, and a Java entry like `domain/model/` cover every
 * package's model. Substring matching would let e.g. "my-engine/src/core/x.ts"
 * or "core/parse-machine.ts.bak" match unintended entries.
 */
export function matchesModulePath(filePath: string, entry: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (entry.endsWith("/")) {
    return normalized.startsWith(entry) || normalized.includes("/" + entry);
  }
  return normalized === entry || normalized.endsWith("/" + entry);
}

/**
 * Classify one file: a test (never held to purity — tests own their I/O), a
 * declared shell (with its reason), pure (under a root), or outside every root.
 * A shell entry wins over a root, so a shell inside the core is named once.
 */
export function classifyPurity(filePath: string, scope: PurityScope): PurityClassification {
  if (isTestFile(filePath)) return { kind: "test" };
  const shell = scope.impureModules.find(({ path }) => matchesModulePath(filePath, path));
  if (shell !== undefined) return { kind: "shell", path: shell.path, reason: shell.reason };
  return scope.pureModules.some((entry) => matchesModulePath(filePath, entry)) ? { kind: "pure" } : { kind: "unscoped" };
}

/** Is this file held to purity under the scope? */
export function isPureModule(filePath: string, scope: PurityScope): boolean {
  return classifyPurity(filePath, scope).kind === "pure";
}

/**
 * One lexical span of a source text: code the rule reads, or a quoted string
 * or a comment it does not. Template literals — their text and their `${…}`
 * alike — and regex literals are code, so a `//` inside one (a URL in a
 * template, an escaped slash in a regex) never hides the rest of the line.
 */
type SourceSegment = Readonly<{ kind: "code" | "string" | "comment"; start: number; end: number }>;

/** The open delimiter the scanner is inside of: template text, or a `${…}` / `{…}` of code. */
type Nesting = "template" | "interpolation" | "brace";

/** Words after which a `/` begins a regex literal rather than a division. */
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

/**
 * Split a source text into code, string and comment spans. The scan carries
 * template nesting across lines (a multi-line template's continuation is still
 * template text) and fails closed: a quote with no closing partner on its line,
 * or a `/` with no closing regex delimiter, is read as code — when in doubt the
 * text is checked, never skipped.
 */
export function sourceSegments(content: string): readonly SourceSegment[] {
  const segments: SourceSegment[] = [];
  const nesting: Nesting[] = [];
  let codeStart = 0;
  let index = 0;
  const skip = (kind: "string" | "comment", end: number): void => {
    if (index > codeStart) segments.push({ kind: "code", start: codeStart, end: index });
    segments.push({ kind, start: index, end });
    index = end;
    codeStart = end;
  };
  while (index < content.length) {
    const char = content[index];
    if (nesting.at(-1) === "template") {
      index = templateStep(content, index, nesting);
      continue;
    }
    const next = content[index + 1];
    if (char === "/" && next === "/") {
      skip("comment", lineEnd(content, index));
      continue;
    }
    if (char === "/" && next === "*") {
      skip("comment", blockCommentEnd(content, index));
      continue;
    }
    const stringClose = char === "\"" || char === "'" ? closingQuote(content, index) : -1;
    if (stringClose !== -1) {
      skip("string", stringClose + 1);
      continue;
    }
    const regexClose = char === "/" && regexMayStart(content, index) ? regexEnd(content, index) : -1;
    if (regexClose !== -1) {
      index = regexClose;
      continue;
    }
    if (char === "`") nesting.push("template");
    else if (char === "{") nesting.push("brace");
    else if (char === "}") nesting.pop(); // closes a brace, or an interpolation back into its template
    index += 1;
  }
  if (content.length > codeStart) segments.push({ kind: "code", start: codeStart, end: content.length });
  return segments;
}

/** One step through template text: an escape, the closing backtick, a `${` into code, or a text character. */
function templateStep(content: string, index: number, nesting: Nesting[]): number {
  const char = content[index];
  if (char === "\\") return index + 2;
  if (char === "`") {
    nesting.pop();
    return index + 1;
  }
  if (char === "$" && content[index + 1] === "{") {
    nesting.push("interpolation");
    return index + 2;
  }
  return index + 1;
}

/** The end of the line holding `index` (its newline is not part of the line). */
function lineEnd(content: string, index: number): number {
  const newline = content.indexOf("\n", index);
  return newline === -1 ? content.length : newline;
}

/** The end of the block comment opened at `open`; an unterminated one runs to the end of the text. */
function blockCommentEnd(content: string, open: number): number {
  const close = content.indexOf("*/", open + 2);
  return close === -1 ? content.length : close + 2;
}

/** The index of the quote closing the string opened at `open` on the same line, or -1. */
function closingQuote(content: string, open: number): number {
  const quote = content[open];
  for (let index = open + 1; index < content.length && content[index] !== "\n"; index += 1) {
    if (content[index] === "\\") index += 1;
    else if (content[index] === quote) return index;
  }
  return -1;
}

/**
 * Can a `/` at `index` open a regex literal? Only an operand — a name, a
 * number, a closing bracket or a closed literal — makes it a division; after
 * an operator, punctuation, a keyword or the start of the text it is a regex.
 * Erring toward regex is the closed side: a misread division keeps the text up
 * to the next `/` as code, it never turns code into a comment.
 */
function regexMayStart(content: string, index: number): boolean {
  let before = index - 1;
  while (before >= 0 && /\s/.test(content.charAt(before))) before -= 1;
  if (before < 0) return true;
  const previous = content.charAt(before);
  if (/[)\]"'`]/.test(previous)) return false;
  if (!/[\w$]/.test(previous)) return true;
  const word = /[\w$]+$/.exec(content.slice(0, before + 1));
  return word !== null && REGEX_PRECEDING_KEYWORDS.has(word[0]);
}

/** The index just past the regex literal opened at `open`, or -1 when it does not close on its line. */
function regexEnd(content: string, open: number): number {
  let inClass = false;
  for (let index = open + 1; index < content.length; index += 1) {
    const char = content[index];
    if (char === "\n") return -1;
    if (char === "\\") index += 1;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return index + 1;
  }
  return -1;
}

/** One segment as the rule reads it: code whole, a string emptied to its quotes, a comment reduced to its newlines. */
function readable(content: string, segment: SourceSegment): string {
  const text = content.slice(segment.start, segment.end);
  return match(segment.kind)
    .with("code", () => text)
    .with("string", () => text.charAt(0).repeat(2))
    .with("comment", () => text.replace(/[^\n]/g, ""))
    .exhaustive();
}

/** One entry per line of `content`: the line's code, strings emptied and comments removed. */
function codeLinesOf(content: string, segments: readonly SourceSegment[]): readonly string[] {
  return segments.map((segment) => readable(content, segment)).join("").split("\n");
}

/**
 * The code of a text with its quoted string literals emptied and its comments
 * removed, so a banned global NAMED in a message, a description or a comment
 * is not read as a call. Template and regex literals are kept whole — `${…}`
 * holds code, and a `//` inside either is not a comment — and a quote with no
 * closing partner on its line is left as code: when in doubt the text is
 * checked, never skipped.
 */
export function codeOfLine(line: string): string {
  return codeLinesOf(line, sourceSegments(line)).join("\n");
}

// --- Rule handler ---

/**
 * Programmatic rule handler for no-io-in-pure-modules.
 * Fires only for files the scope classifies pure.
 */
export function handler(
  content: string,
  filePath: string,
  scope: PurityScope = DEFAULT_PURITY_SCOPE
): Violation[] {
  if (!isPureModule(filePath, scope)) {
    return []; // A shell, a test, or outside every pure root — no restrictions
  }

  const violations: Violation[] = [];
  const lines = content.split("\n");
  const segments = sourceSegments(content);
  const code = codeLinesOf(content, segments);
  const inCode = (offset: number): boolean =>
    segments.some(({ kind, start, end }) => kind === "code" && offset >= start && offset < end);
  // An import counts only where its keyword is code — not one quoted in a string or named in a comment.
  const imports = [...content.matchAll(/\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']\)?/g)]
    .filter((importMatch) => inCode(importMatch.index));
  const capabilityImports = PURE_CAPABILITY_IMPORTS.flatMap((pattern) =>
    [...content.matchAll(pattern)].map((capability) => ({ start: capability.index, end: capability.index + capability[0].length })));
  let nextLineStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = nextLineStart;
    nextLineStart += line.length + 1;

    // Check for I/O imports
    for (const importMatch of imports.filter((match) => match.index >= lineStart && match.index < nextLineStart)) {
      const specifier = importMatch[1];
      const isIOImport = IO_IMPORTS.some((io) => specifier === io || specifier.startsWith(io + "/"));
      const offset = importMatch.index;
      const isAllowed = PURE_ALLOW_LIST.some((a) => specifier === a || specifier.startsWith(a + "/")) ||
        capabilityImports.some(({ start, end }) => offset >= start && offset + importMatch[0].length <= end);

      if (isIOImport && !isAllowed) {
        violations.push(
          makeViolation(
            "no-io-in-pure-modules",
            filePath,
            i + 1,
            line,
            `Pure module must not import I/O module "${specifier}". Move this logic to the imperative shell or inject via a port.`
          )
        );
      }
    }

    // Check for banned globals — in code, not in the strings and comments that name them
    for (const { pattern, description } of BANNED_GLOBALS) {
      if (pattern.test(code[i])) {
        violations.push(
          makeViolation(
            "no-io-in-pure-modules",
            filePath,
            i + 1,
            line,
            `Pure module must not use ${description}. Extract to imperative shell or inject as a dependency.`
          )
        );
        break; // One violation per line is enough
      }
    }
  }

  return violations;
}
