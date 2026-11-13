/**
 * Exclusion patterns for the linter's tests, written as an author writes them
 * and parsed by the production parser — so a test names `"apps/"` and gets the
 * value a loaded rule would hold.
 */
import { describeExcludePatternError, parseExcludePattern, type ExcludePattern } from "../../src/linter/exclude-pattern";

export const excludePatterns = (...entries: readonly string[]): readonly ExcludePattern[] =>
  entries.map((entry) => {
    const parsed = parseExcludePattern(entry);
    if (!parsed.ok) throw new Error(`test pattern ${describeExcludePatternError(parsed.error)}`);
    return parsed.value;
  });
