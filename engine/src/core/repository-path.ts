import { isAbsolute, relative, resolve, sep } from "node:path";
import { fail, ok, type ParseResult } from "./panel-kernel";

export interface RepositoryPath {
  readonly relative: string;
  readonly absolute: string;
}

function escapesRoot(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

/**
 * Parse any host-native path spelling into one canonical repository-relative
 * POSIX path. Absolute paths are accepted only when they point inside `root`;
 * aliases (`./`, repeated separators, and `..` that stays inside the root) are
 * collapsed before identity comparisons or persistence.
 *
 * This is lexical containment only. Filesystem consumers that read or write
 * must additionally reject symlink components at their I/O boundary.
 */
export function parseRepositoryPath(
  root: string,
  raw: unknown,
  label = "repository path",
): ParseResult<RepositoryPath> {
  if (typeof raw !== "string" || raw.length === 0) return fail([`${label} must be non-empty`]);
  if (raw.trim() !== raw) return fail([`${label} must not have surrounding whitespace: ${JSON.stringify(raw)}`]);
  if (/[\r\n\0]/.test(raw)) return fail([`${label} must be a single line without NUL: ${JSON.stringify(raw)}`]);
  if (!isAbsolute(root)) return fail([`repository root must be absolute: ${root}`]);

  // A foreign-platform absolute spelling must never be interpreted as a
  // relative filename on this host. Native Windows paths use '\\' normally;
  // POSIX paths containing it are aliases the packet schema cannot represent.
  if (sep === "/" && (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(raw) || raw.includes("\\"))) {
    return fail([`${label} uses a non-native or non-canonical path spelling: ${raw}`]);
  }

  const canonicalRoot = resolve(root);
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(canonicalRoot, raw);
  const fromRoot = relative(canonicalRoot, absolute);
  if (fromRoot === "" || escapesRoot(fromRoot)) {
    return fail([`${label} must identify a file inside the repository: ${raw}`]);
  }

  return ok(Object.freeze({
    relative: fromRoot.split(sep).join("/"),
    absolute,
  }));
}

/** Parse, canonicalize, deduplicate, and sort a repository path set. */
export function parseRepositoryPathSet(
  root: string,
  raw: readonly unknown[],
  label = "repository paths",
): ParseResult<readonly RepositoryPath[]> {
  const byRelative = new Map<string, RepositoryPath>();
  const errors: string[] = [];
  raw.forEach((entry, index) => {
    const parsed = parseRepositoryPath(root, entry, `${label}[${index}]`);
    if (parsed.ok) byRelative.set(parsed.value.relative, parsed.value);
    else errors.push(...parsed.errors);
  });
  return errors.length > 0
    ? fail(errors)
    : ok(Object.freeze([...byRelative.values()].sort((left, right) =>
        left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0,
      )));
}
