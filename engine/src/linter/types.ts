/**
 * Linter domain types — canonical type definitions for the linter bounded context.
 *
 * All types are immutable (readonly). Discriminated unions use `kind` tag.
 * Zero external dependencies.
 */

// --- Tier & Kind ---

/** Execution tier: immediate (PostEdit <50ms) or full (wave-gate, all rules) */
export type Tier = "immediate" | "full";

/** Rule classification: regex (declarative JSON) or programmatic (TS handler) */
export type RuleKind = "regex" | "programmatic";

/** Origin of a rule: shipped default or project-local override */
export type RuleSource = "default" | "project";

// --- Rule Types (discriminated union on `kind`) ---

export interface RegexRule {
  readonly kind: "regex";
  readonly name: string;
  readonly description: string;
  readonly extensions: readonly string[];  // e.g. [".ts", ".tsx"]
  readonly pattern: string;                // regex source
  readonly flags?: string;                 // regex flags (default: none)
  readonly fixHint: string;
  readonly enabled: boolean;
  readonly source: RuleSource;
}

export interface ProgrammaticRule {
  readonly kind: "programmatic";
  readonly name: string;
  readonly description: string;
  readonly extensions: readonly string[];
  readonly handler: (content: string, filePath: string) => Violation[];
  readonly fixHint: string;
  readonly enabled: boolean;
  readonly source: RuleSource;
}

export type Rule = RegexRule | ProgrammaticRule;

// --- Violation ---

export interface Violation {
  readonly rule: string;    // rule name
  readonly file: string;    // absolute path
  readonly line: number;    // 1-indexed
  readonly text: string;    // matched line content (trimmed)
  readonly fixHint: string;
}

// --- LintResult (discriminated union on `kind`) ---

export type LintResult =
  | { readonly kind: "pass" }
  | { readonly kind: "violations"; readonly violations: readonly Violation[] }
  | { readonly kind: "error"; readonly message: string };

// --- LintOutput (serializable JSON output) ---

export interface LintOutput {
  readonly status: "pass" | "fail" | "error";
  readonly file: string;
  readonly violations?: readonly Violation[];
  readonly error?: string;
}

// --- Type Guards ---

export function isRegexRule(rule: Rule): rule is RegexRule {
  return rule.kind === "regex";
}

export function isProgrammaticRule(rule: Rule): rule is ProgrammaticRule {
  return rule.kind === "programmatic";
}

export function isPass(result: LintResult): result is { kind: "pass" } {
  return result.kind === "pass";
}

export function isViolations(
  result: LintResult
): result is { kind: "violations"; violations: readonly Violation[] } {
  return result.kind === "violations";
}

export function isError(
  result: LintResult
): result is { kind: "error"; message: string } {
  return result.kind === "error";
}

// --- Constructors (parse-don't-validate) ---

export function makeViolation(
  rule: string,
  file: string,
  line: number,
  text: string,
  fixHint: string
): Violation {
  if (!rule || rule.trim().length === 0) {
    throw new Error("Violation rule name must be non-empty");
  }
  if (!file || file.trim().length === 0) {
    throw new Error("Violation file path must be non-empty");
  }
  if (line < 1 || !Number.isInteger(line)) {
    throw new Error("Violation line must be a positive integer");
  }
  return { rule, file, line, text: text.trim(), fixHint };
}

export function passResult(): LintResult {
  return { kind: "pass" };
}

export function violationsResult(violations: readonly Violation[]): LintResult {
  if (violations.length === 0) {
    return { kind: "pass" };
  }
  return { kind: "violations", violations };
}

export function lintErrorResult(message: string): LintResult {
  return { kind: "error", message: message || "Unknown linter error" };
}
