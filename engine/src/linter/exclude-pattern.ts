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
 * An entry that would not mean what its author wrote is refused by the parse
 * and never reaches the matcher. An empty entry and a slash-only directory name
 * nothing (as a suffix, the empty entry would match every file); a glob would
 * be compared byte for byte, since no glob support exists; and an empty, `.`
 * or `..` segment is one no linted path holds, so the entry could never match.
 * An exclusion that silently did nothing leaves the author believing a layer is
 * skipped, and one that silently excluded the whole tree makes a rule look
 * enforced while it reads nothing.
 *
 * The parse is the only way to obtain an `ExcludePattern`: the type is
 * branded, so a hand-built `{ kind: "suffix", suffix: "" }` does not compile.
 */
declare const parsedExcludePattern: unique symbol;

/** Proof that `parseExcludePattern` admitted the value. */
type Parsed = Readonly<{ [parsedExcludePattern]: true }>;

export type ExcludePattern =
  /** Every path ending with `suffix`, forward-slashed. */
  | (Readonly<{ kind: "suffix"; suffix: string }> & Parsed)
  /** Every path inside the project holding `segments`: forward-slashed and
   *  slash-delimited at both ends (`/src/infra/`), so it can only be satisfied
   *  at a segment boundary — never by `/src/infrastructure/`. */
  | (Readonly<{ kind: "directory"; segments: string }> & Parsed);

/** Why an entry is not an exclusion pattern. */
export type ExcludePatternError =
  | Readonly<{ kind: "empty" }>
  /** Slashes only: a directory with no name. */
  | Readonly<{ kind: "unnamed-directory"; raw: string }>
  /** No glob support exists, so a `*` would be compared as a literal byte. */
  | Readonly<{ kind: "glob"; raw: string }>
  /** An empty, `.` or `..` segment: no linted path holds one. */
  | Readonly<{ kind: "impossible-segment"; raw: string }>;

export type ExcludePatternParse =
  | Readonly<{ ok: true; value: ExcludePattern }>
  | Readonly<{ ok: false; error: ExcludePatternError }>;

/** The first refused entry of a list, by its position. */
export type ExcludePatternListError = Readonly<{ index: number; error: ExcludePatternError }>;

export type ExcludePatternListParse =
  | Readonly<{ ok: true; value: readonly ExcludePattern[] }>
  | Readonly<{ ok: false; error: ExcludePatternListError }>;

/** The brand's minting steps. Only `parseExcludePattern` calls them, after every check passed. */
const suffixPattern = (suffix: string): ExcludePattern => ({ kind: "suffix", suffix }) as ExcludePattern;
const directoryPattern = (segments: string): ExcludePattern => ({ kind: "directory", segments }) as ExcludePattern;

const IMPOSSIBLE_SEGMENTS: ReadonlySet<string> = new Set(["", ".", ".."]);
const holdsImpossibleSegment = (names: readonly string[]): boolean =>
  names.some((name) => IMPOSSIBLE_SEGMENTS.has(name));

/**
 * Parse one entry. Separators are normalized here, as a path's are when it is
 * matched, so `src\infra\` names the same directory as `src/infra/`; a
 * directory is anchored by one leading slash, so `src/infra/` and `/src/infra/`
 * are one pattern. A suffix's first segment is the tail of a name (`.test.ts`,
 * or empty in `/lint.ts`, anchoring it at a boundary), so only the segments
 * after it must be whole names.
 */
export function parseExcludePattern(raw: string): ExcludePatternParse {
  if (raw.length === 0) return { ok: false, error: { kind: "empty" } };
  if (raw.includes("*")) return { ok: false, error: { kind: "glob", raw } };
  const pattern = forwardSlashed(raw);
  if (!pattern.endsWith("/")) {
    return holdsImpossibleSegment(pattern.split("/").slice(1))
      ? { ok: false, error: { kind: "impossible-segment", raw } }
      : { ok: true, value: suffixPattern(pattern) };
  }
  if (/^\/+$/.test(pattern)) return { ok: false, error: { kind: "unnamed-directory", raw } };
  const body = pattern.slice(pattern.startsWith("/") ? 1 : 0, -1);
  return holdsImpossibleSegment(body.split("/"))
    ? { ok: false, error: { kind: "impossible-segment", raw } }
    : { ok: true, value: directoryPattern(`/${body}/`) };
}

/** Parse a whole list, refusing it at its first refused entry. */
export function parseExcludePatternList(entries: readonly string[]): ExcludePatternListParse {
  const patterns: ExcludePattern[] = [];
  for (const [index, entry] of entries.entries()) {
    const parsed = parseExcludePattern(entry);
    if (!parsed.ok) return { ok: false, error: { index, error: parsed.error } };
    patterns.push(parsed.value);
  }
  return { ok: true, value: patterns };
}

/** The author-facing sentence for a refused entry. */
export function describeExcludePatternError(error: ExcludePatternError): string {
  switch (error.kind) {
    case "empty":
      return "is empty — name a directory with a trailing '/' (every file beneath it) or a file suffix";
    case "unnamed-directory":
      return `'${error.raw}' names no directory — name one with a trailing '/', e.g. 'src/infra/'`;
    case "glob":
      return `'${error.raw}' is a glob — name a directory with a trailing '/' (every file beneath it) or a file suffix`;
    case "impossible-segment":
      return `'${error.raw}' holds an empty, '.' or '..' segment, which no linted path has — write it as the path reads beneath the project root, e.g. 'src/infra/'`;
    default: {
      const unreachable: never = error;
      return unreachable;
    }
  }
}

/** The sentence for a refused list entry, under the list's own key: `excludePatterns[1] is empty — …`. */
export const describeExcludePatternListError = (key: string, { index, error }: ExcludePatternListError): string =>
  `${key}[${index}] ${describeExcludePatternError(error)}`;

const forwardSlashed = (path: string): string => path.replace(/\\/g, "/");

/**
 * A lint target as a pattern sees it. A pattern is written in the project's
 * frame, so a directory pattern can only be answered for a path known to be in
 * that frame.
 */
type FramedPath = Readonly<{
  /** `in-project`: `path` is the path from the project root. `unframed`: no
   *  project owns the rules, or the file is outside the root, and `path` is
   *  the absolute path as given. */
  kind: "in-project" | "unframed";
  path: string;
}>;

/** `lintFile` hands rules absolute paths; a path already relative is taken as
 *  project-relative (`projectRelative`), with or without a project root. */
function framed(filePath: string, projectRoot: string | null): FramedPath {
  const path = projectRelative(filePath, projectRoot);
  return { kind: isAbsolutePath(path) ? "unframed" : "in-project", path };
}

function matches(pattern: ExcludePattern, target: FramedPath): boolean {
  switch (pattern.kind) {
    case "suffix":
      // A suffix matches wherever the checkout lives.
      return target.path.endsWith(pattern.suffix);
    case "directory":
      return target.kind === "in-project" && `/${target.path}`.includes(pattern.segments);
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
 * at `/home/u/apps/shop`. So an absolute path that cannot be placed in the
 * project — `projectRoot` is null because no project owns the rules, or the
 * file is outside the root — is excluded by no directory pattern, and the rule
 * reads the file. An exclusion that cannot be placed fails toward reporting,
 * never toward skipping, as an unmatched baseline key does. (A path that is
 * already relative is read as project-relative, with or without a root.)
 */
export function matchesAnyExcludePattern(
  filePath: string,
  patterns: readonly ExcludePattern[],
  projectRoot: string | null,
): boolean {
  const target = framed(filePath, projectRoot);
  return patterns.some((pattern) => matches(pattern, target));
}
