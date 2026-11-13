import { isAbsolutePath, projectRelative } from "./programmatic/baseline";

/**
 * A rule's exclusion list — a regex rule's `excludePatterns` and
 * `maxFunctionLines`' `excludeFromMaxLines`: which files a single rule does not
 * read. (The purity and boundary rules scope by module entries, a different
 * grammar with its own matcher.)
 *
 * An entry is written as a string and PARSED ONCE, where the rule or the config
 * is loaded, into one of two forms told apart by a trailing slash:
 *
 *   `".test.ts"`        a FILE-SUFFIX   — every path ending with those bytes
 *   `"src/infra/"`      a DIRECTORY     — every path with that segment sequence
 *
 * The directory form exists because a rule scoped to a layer (`"apps/"`,
 * `"packages/framework/src/types/"`) has no way to express "everything beneath
 * here" as a suffix: a file path never ends with a directory name followed by a
 * slash.
 *
 * An entry that could only match nothing, or everything, is refused by the
 * parse and never reaches the matcher: an exclusion that silently did nothing
 * leaves the author believing a layer is skipped, and one that silently
 * excluded the whole tree makes a rule look enforced while it reads nothing.
 */
export type ExcludePattern =
  /** Every path ending with `suffix`, forward-slashed. */
  | Readonly<{ kind: "suffix"; suffix: string }>
  /** Every path inside the project holding `segments`: forward-slashed and
   *  slash-delimited at both ends (`/src/infra/`), so it can only be satisfied
   *  at a segment boundary — never by `/src/infrastructure/`. */
  | Readonly<{ kind: "directory"; segments: string }>;

/** Why an entry is not an exclusion pattern. */
export type ExcludePatternError =
  | Readonly<{ kind: "empty" }>
  /** Slashes only: a directory with no name. */
  | Readonly<{ kind: "unnamed-directory"; raw: string }>
  /** No glob support exists, so a `*` would be compared as a literal byte. */
  | Readonly<{ kind: "glob"; raw: string }>;

export type ExcludePatternParse =
  | Readonly<{ ok: true; value: ExcludePattern }>
  | Readonly<{ ok: false; error: ExcludePatternError }>;

/**
 * Parse one entry. Separators are normalized here, as a path's are when it is
 * matched, so `src\infra\` names the same directory as `src/infra/`; a
 * directory is anchored by a leading slash, so `src/infra/` and `/src/infra/`
 * are one pattern.
 */
export function parseExcludePattern(raw: string): ExcludePatternParse {
  if (raw.length === 0) return { ok: false, error: { kind: "empty" } };
  if (raw.includes("*")) return { ok: false, error: { kind: "glob", raw } };
  const pattern = forwardSlashed(raw);
  if (!pattern.endsWith("/")) return { ok: true, value: { kind: "suffix", suffix: pattern } };
  if (/^\/+$/.test(pattern)) return { ok: false, error: { kind: "unnamed-directory", raw } };
  return { ok: true, value: { kind: "directory", segments: pattern.startsWith("/") ? pattern : `/${pattern}` } };
}

/** The author-facing sentence for a refused entry. */
export function describeExcludePatternError(error: ExcludePatternError): string {
  switch (error.kind) {
    case "empty":
      return "is empty — it would exclude nothing";
    case "unnamed-directory":
      return `'${error.raw}' names no directory — it would exclude nothing`;
    case "glob":
      return `'${error.raw}' is a glob — name a directory with a trailing '/' (every file beneath it) or a file suffix`;
    default: {
      const unreachable: never = error;
      return unreachable;
    }
  }
}

const forwardSlashed = (path: string): string => path.replace(/\\/g, "/");

/**
 * A lint target as a pattern sees it. A pattern is written in the project's
 * frame, so a directory pattern can only be answered for a path known to be in
 * that frame.
 */
type FramedPath =
  /** Inside the project: its path from the project root. */
  | Readonly<{ kind: "in-project"; relative: string }>
  /** No project owns the rules, or the file is outside the project root. */
  | Readonly<{ kind: "unframed"; path: string }>;

/** `lintFile` hands rules absolute paths; a path already relative is taken as
 *  project-relative (`projectRelative`). */
function framed(filePath: string, projectRoot: string | null): FramedPath {
  const path = projectRelative(filePath, projectRoot);
  return isAbsolutePath(path) ? { kind: "unframed", path } : { kind: "in-project", relative: path };
}

function matches(pattern: ExcludePattern, target: FramedPath): boolean {
  switch (pattern.kind) {
    case "suffix":
      // A suffix never depended on where the checkout lives.
      return (target.kind === "in-project" ? target.relative : target.path).endsWith(pattern.suffix);
    case "directory":
      return target.kind === "in-project" && `/${target.relative}`.includes(pattern.segments);
    default: {
      const unreachable: never = pattern;
      return unreachable;
    }
  }
}

/**
 * Does any pattern exclude this file? False for an empty list.
 *
 * A directory pattern is matched against the file's path INSIDE the project,
 * at any depth (`apps/` excludes `packages/host/src/apps/x.ts`), and against
 * nothing else. Matched against an absolute path it would also match the
 * directories ABOVE the project: `apps/` would exclude every file of a checkout
 * at `/home/u/apps/shop`. So where the frame is unknown — `projectRoot` is null
 * because no project owns the rules, or the file is outside the root — a
 * directory pattern excludes nothing and the rule reads the file. An exclusion
 * that cannot be placed fails toward reporting, never toward skipping, as an
 * unmatched baseline key does.
 */
export function matchesAnyExcludePattern(
  filePath: string,
  patterns: readonly ExcludePattern[],
  projectRoot: string | null,
): boolean {
  const target = framed(filePath, projectRoot);
  return patterns.some((pattern) => matches(pattern, target));
}
