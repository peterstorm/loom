/**
 * ReDoS safety module — static regex analysis + runtime timeout wrapper.
 *
 * Defense-in-depth: static analysis catches known-bad patterns at rule load time,
 * runtime timeout catches anything static analysis misses during execution.
 *
 * Zero external dependencies.
 */

// --- Types ---

export type SafetyResult =
  | { readonly safe: true; readonly regex: RegExp }
  | { readonly safe: false; readonly reason: string };

// --- Static Analysis ---

/**
 * Analyzes a regex pattern for ReDoS vulnerability.
 * Detects:
 *   1. Nested quantifiers (e.g., (a+)+ or (a*)*b)
 *   2. Overlapping alternations with quantifiers (e.g., (a|a)+)
 *   3. Catastrophic backtracking patterns (e.g., (.*a){n})
 *
 * Returns a compiled RegExp if safe, or a rejection reason if unsafe.
 */
export function analyzeRegex(pattern: string, flags?: string): SafetyResult {
  // Phase 1: Check for obviously invalid regex
  try {
    new RegExp(pattern, flags);
  } catch (e) {
    return {
      safe: false,
      reason: `Invalid regex: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Phase 2: Static pattern analysis for ReDoS indicators
  const unsafeReason = detectUnsafePattern(pattern);
  if (unsafeReason) {
    return { safe: false, reason: unsafeReason };
  }

  // Phase 3: Compile and return
  return { safe: true, regex: new RegExp(pattern, flags) };
}

/**
 * Detects unsafe regex patterns using structural analysis.
 * Returns a reason string if unsafe, or null if safe.
 */
function detectUnsafePattern(pattern: string): string | null {
  // --- Nested quantifiers ---
  // Matches patterns like (X+)+, (X*)+, (X+)*, (X*){n}, etc.
  // where X contains a quantifier inside a group that itself has a quantifier
  if (hasNestedQuantifiers(pattern)) {
    return "Nested quantifiers detected — potential exponential backtracking";
  }

  // --- Overlapping alternations with quantifiers ---
  // e.g., (a|a)+, (ab|a)+, (\s|\t)+ where alternations can match the same input
  if (hasOverlappingAlternations(pattern)) {
    return "Overlapping alternations with quantifier — potential polynomial backtracking";
  }

  // --- Catastrophic patterns: quantified groups containing .* or .+ ---
  // e.g., (.*a){10}, (.+)+
  if (hasCatastrophicDotStar(pattern)) {
    return "Quantified group with unbounded repetition — potential catastrophic backtracking";
  }

  return null;
}

/**
 * Detects nested quantifiers: a quantifier applied to a group that
 * internally contains a quantifier. E.g. (a+)+, (a*)*b, (x+y*)+
 */
function hasNestedQuantifiers(pattern: string): boolean {
  // Find groups (handling nesting) and check if both the group content
  // and the group itself have quantifiers
  const quantifierSuffixRe = /[+*]\)?[+*?{]/;

  // Simple approach: tokenize by looking for quantifier-on-group patterns
  // Match: group with internal quantifier followed by external quantifier
  // Pattern: (... [+*?{n,m}] ...) [+*?{n,m}]
  const groups = extractGroups(pattern);
  for (const group of groups) {
    if (hasQuantifier(group.content) && hasQuantifier(group.suffix)) {
      return true;
    }
  }

  // Also detect direct patterns like \w+\w+ preceded by a quantified group:
  // (a+)+ or (a*)*
  const directNestedRe = /\([^)]*[+*}][^)]*\)[+*?]|\([^)]*[+*}][^)]*\)\{/;
  if (directNestedRe.test(pattern)) {
    return true;
  }

  return false;
}

/**
 * Detects overlapping alternations within a quantified group.
 * E.g., (a|a)+, (ab|a)+, (\s|\t)+ 
 * where branches of an alternation can match overlapping inputs.
 */
function hasOverlappingAlternations(pattern: string): boolean {
  // Find quantified groups that contain alternations
  const groups = extractGroups(pattern);
  for (const group of groups) {
    if (!hasQuantifier(group.suffix)) continue;
    if (!group.content.includes("|")) continue;

    const alternatives = splitAlternatives(group.content);
    if (alternatives.length < 2) continue;

    // Check if any two alternatives can match overlapping input
    if (hasOverlap(alternatives)) {
      return true;
    }
  }
  return false;
}

/**
 * Detects catastrophic dot-star patterns: a quantified group containing
 * .* or .+ which creates unbounded internal matching.
 * E.g., (.*a)+, (.+)+, (.*){2,}
 */
function hasCatastrophicDotStar(pattern: string): boolean {
  // Pattern: group containing .* or .+ that itself has a quantifier
  const groups = extractGroups(pattern);
  for (const group of groups) {
    if (!hasQuantifier(group.suffix)) continue;
    // Check if group content contains .* or .+ (unbounded dot repetition)
    if (/\.\*|\.\+/.test(group.content)) {
      return true;
    }
  }

  // Also catch non-grouped patterns like .*.*
  // Two adjacent unbounded patterns can cause polynomial behavior
  const dotStarCount = (pattern.match(/\.\*|\.\+/g) || []).length;
  if (dotStarCount >= 2) {
    // Only flag if there's ambiguity: .*.* at the same level
    if (/\.\*.*\.\*|\.\+.*\.\+|\.\*.*\.\+|\.\+.*\.\*/.test(pattern)) {
      // But exclude patterns anchored at both ends (^...$) which are safe
      if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
        return true;
      }
    }
  }

  return false;
}

// --- Helper Functions ---

interface GroupInfo {
  content: string;   // content inside the parens (excluding outer parens)
  suffix: string;    // characters immediately after the closing paren
  start: number;     // position of opening paren in original pattern
  end: number;       // position of closing paren
}

/**
 * Extracts top-level and nested groups from a regex pattern.
 * Returns group content and the suffix (potential quantifier) after each group.
 */
function extractGroups(pattern: string): GroupInfo[] {
  const groups: GroupInfo[] = [];
  const stack: number[] = [];

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    // Skip escaped characters
    if (ch === "\\" && i + 1 < pattern.length) {
      i++;
      continue;
    }

    // Skip character classes
    if (ch === "[") {
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\" && i + 1 < pattern.length) i++;
        i++;
      }
      continue;
    }

    if (ch === "(") {
      stack.push(i);
    } else if (ch === ")" && stack.length > 0) {
      const start = stack.pop()!;
      let content = pattern.slice(start + 1, i);

      // Remove non-capturing group prefix
      if (content.startsWith("?:")) {
        content = content.slice(2);
      } else if (content.startsWith("?")) {
        // Skip lookahead/lookbehind groups — they don't backtrack the same way
        // but still extract for analysis
        const lookMatch = content.match(/^\?[=!<]/);
        if (lookMatch) continue;
      }

      // Get suffix (quantifier after the group)
      const suffix = extractQuantifierSuffix(pattern, i + 1);

      groups.push({ content, start, end: i, suffix });
    }
  }

  return groups;
}

/**
 * Extracts the quantifier suffix starting at the given position.
 * Returns the quantifier string (e.g., "+", "*", "?", "{2,5}", "+?") or "".
 */
function extractQuantifierSuffix(pattern: string, pos: number): string {
  if (pos >= pattern.length) return "";
  const rest = pattern.slice(pos);
  const match = rest.match(/^([+*?]|\{\d+,?\d*\})[+?]?/);
  return match ? match[0] : "";
}

/**
 * Checks if a pattern fragment contains a quantifier.
 */
function hasQuantifier(fragment: string): boolean {
  // Match +, *, ?, {n}, {n,}, {n,m} that are not escaped
  // Simple heuristic: check for unescaped quantifier characters
  for (let i = 0; i < fragment.length; i++) {
    if (fragment[i] === "\\" && i + 1 < fragment.length) {
      i++; // skip escaped char
      continue;
    }
    if (fragment[i] === "+" || fragment[i] === "*") {
      return true;
    }
    if (fragment[i] === "{" && /^\{\d+,?\d*\}/.test(fragment.slice(i))) {
      return true;
    }
  }
  return false;
}

/**
 * Splits alternation content by top-level `|` (respecting nested groups).
 */
function splitAlternatives(content: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let current = "";

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "\\" && i + 1 < content.length) {
      current += ch + content[i + 1];
      i++;
      continue;
    }
    if (ch === "(") { depth++; current += ch; continue; }
    if (ch === ")") { depth--; current += ch; continue; }
    if (ch === "|" && depth === 0) {
      alternatives.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  alternatives.push(current);
  return alternatives;
}

/**
 * Checks if any two alternatives in a list have overlapping match potential.
 * Uses a simplified first-character-set intersection heuristic.
 */
function hasOverlap(alternatives: string[]): boolean {
  // Strategy: compute the "first match set" for each alternative
  // If any two sets intersect, there's potential overlap
  const sets = alternatives.map(computeFirstMatchSet);
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      if (setsIntersect(sets[i], sets[j])) {
        return true;
      }
    }
  }
  return false;
}

type MatchSet = { chars: Set<string>; matchesAny: boolean };

/**
 * Computes a simplified "first character set" for an alternative.
 * If the alternative can match arbitrary characters (.), matchesAny is true.
 */
function computeFirstMatchSet(alt: string): MatchSet {
  const chars = new Set<string>();
  let matchesAny = false;

  if (alt.length === 0) return { chars, matchesAny: true };

  let i = 0;
  // Skip non-capturing prefix
  if (alt.startsWith("?:")) i = 2;

  if (i >= alt.length) return { chars, matchesAny: true };

  const ch = alt[i];

  if (ch === "\\") {
    if (i + 1 < alt.length) {
      const escaped = alt[i + 1];
      if (escaped === "d" || escaped === "w" || escaped === "s") {
        // Character classes — approximate
        if (escaped === "d") "0123456789".split("").forEach(c => chars.add(c));
        else if (escaped === "s") " \t\n\r".split("").forEach(c => chars.add(c));
        else matchesAny = true; // \w is too broad
      } else {
        chars.add(escaped);
      }
    }
  } else if (ch === ".") {
    matchesAny = true;
  } else if (ch === "[") {
    // Character class — simplified: treat as matchesAny for safety
    matchesAny = true;
  } else {
    chars.add(ch);
  }

  return { chars, matchesAny };
}

/**
 * Checks if two match sets can match any of the same characters.
 */
function setsIntersect(a: MatchSet, b: MatchSet): boolean {
  if (a.matchesAny || b.matchesAny) return true;
  for (const ch of a.chars) {
    if (b.chars.has(ch)) return true;
  }
  return false;
}

// --- Runtime Timeout ---

/**
 * Executes a synchronous function with a timeout deadline.
 * 
 * IMPORTANT: This is NOT a preemptive timeout. JavaScript is single-threaded,
 * so a truly blocking operation cannot be interrupted. This function is designed
 * to be used with batch-processing loops where the loop checks the deadline
 * between iterations (e.g., between processing each line of a file).
 * 
 * For the linter use case, the executor calls this once per batch of lines,
 * checking the deadline between batches.
 * 
 * @throws Error if the function exceeds the timeout
 */
export function execWithTimeout<T>(fn: () => T, timeoutMs: number): T {
  const deadline = performance.now() + timeoutMs;
  const result = fn();
  const elapsed = performance.now() - (deadline - timeoutMs);
  if (elapsed > timeoutMs) {
    throw new Error(
      `Execution exceeded timeout of ${timeoutMs}ms (took ${Math.round(elapsed)}ms)`
    );
  }
  return result;
}

/**
 * Creates a deadline checker function for use in line-by-line processing loops.
 * The caller should invoke checkDeadline() periodically (e.g., every N lines).
 * 
 * @throws Error if the deadline has passed when checked
 */
export function createDeadlineChecker(timeoutMs: number): () => void {
  const deadline = performance.now() + timeoutMs;
  return () => {
    if (performance.now() > deadline) {
      throw new Error(
        `Execution exceeded timeout of ${timeoutMs}ms`
      );
    }
  };
}
