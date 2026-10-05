/**
 * Pure standalone-review scope policy: which changed paths are reviewable, how
 * a frozen scope classifies into the metadata `selectStandaloneReviewers`
 * consumes, and how Git numstat output counts additions. The program volume
 * runs the Git probes; every rule here is table-testable with plain data.
 */
import { posix } from "node:path";
import { isExcludedRemediationPath, parseCanonicalRepositoryRelativePath } from "./remediation-machine";
import type { StandaloneReviewKind, StandaloneReviewMetadata } from "./standalone-review-scope";

export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".java", ".rs", ".py", ".go", ".c", ".cpp"]);
export const TYPE_EXTENSIONS = new Set([".ts", ".tsx", ".d.ts", ".java", ".rs"]);

/**
 * Changed-path discovery omits paths this repository cannot canonicalize and
 * excludes orchestration evidence from the derived review scope. Callers that
 * require explicit complete coverage must supply and parse that scope instead
 * of treating this filter as rejection authority.
 */
export function reviewablePath(path: string): boolean {
  const parsed = parseCanonicalRepositoryRelativePath(path, "standalone review scope path");
  return parsed.ok && !isExcludedRemediationPath(parsed.value);
}

/** Sum the additions column of `git diff --numstat` output; binary rows ("-") count zero. */
export function parseNumstatAdditions(output: string): number {
  return output.split("\n").reduce((sum, line) => {
    const additions = Number.parseInt(line.split("\t", 1)[0] ?? "", 10);
    return sum + (Number.isFinite(additions) ? additions : 0);
  }, 0);
}

/**
 * Pure scope classification — the policy `selectStandaloneReviewers` consumes,
 * separated from the git subprocess that measures `additions` so the rules are
 * table-testable with plain data. Both regexes anchor their directory-name
 * alternatives to a full path segment: `docs?`/`README` must be followed by a
 * separator, an extension dot, or end-of-path, so `docker-compose.yml` and
 * `src/docker/build.ts` are NOT documentation.
 */
export function classifyScope(
  kind: StandaloneReviewKind,
  scope: readonly string[],
  created: ReadonlySet<string>,
  additions: number,
): StandaloneReviewMetadata {
  const extensions = scope.map((path) => posix.extname(path).toLowerCase());
  const languages = [...new Set(extensions.filter(Boolean).map((extension) => extension.slice(1)))].sort();
  const sourceOrTestChanged = scope.some((path, index) =>
    SOURCE_EXTENSIONS.has(extensions[index]!) || /(^|\/)(test|tests|__tests__)(\/|$)/.test(path));
  // Canonically, docsOnly implies commentsChanged and excludes sourceOrTestChanged.
  const docsOnly = !sourceOrTestChanged
    && scope.every((path) => /(^|\/)(docs?|README)(\/|\.|$)|\.(md|mdx|txt)$/.test(path));
  return Object.freeze({
    requestedKinds: Object.freeze([kind]) as readonly [StandaloneReviewKind],
    ...(docsOnly
      ? { docsOnly: true as const, sourceOrTestChanged: false as const, commentsChanged: true as const }
      : { docsOnly: false as const, sourceOrTestChanged, commentsChanged: scope.some((path) => /\.(md|mdx)$/.test(path)) }),
    typesChanged: scope.some((_, index) => TYPE_EXTENSIONS.has(extensions[index]!)),
    additions,
    fileCount: scope.length,
    // "New structure" means a genuinely NEW deep path (a fresh service,
    // package, or migration directory) — not an ordinary edit to an existing
    // deeply nested file.
    newStructure: scope.some((path) => created.has(path) && path.split("/").length >= 4),
    languages: Object.freeze(languages),
  });
}
