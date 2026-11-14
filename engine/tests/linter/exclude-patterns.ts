/**
 * Exclusion patterns for the linter's tests, written as an author writes them
 * and parsed by the production parser — so a test names `"apps/"` and gets the
 * value a loaded rule would hold.
 */
import {
  describeExcludePatternListError,
  parseExcludePatternList,
  type ExcludePattern,
} from "../../src/linter/exclude-pattern";

export const excludePatterns = (...entries: readonly string[]): readonly ExcludePattern[] => {
  const parsed = parseExcludePatternList(entries);
  if (!parsed.ok) throw new Error(`test ${describeExcludePatternListError("patterns", parsed.error)}`);
  return parsed.value;
};
