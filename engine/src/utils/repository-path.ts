import { lstatSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  parseRepositoryPath,
  parseRepositoryPathSet,
  type RepositoryPath,
} from "../core/repository-path";

export interface InspectedRepositoryPath extends RepositoryPath {
  readonly exists: boolean;
}

export interface RepositoryPathInspectionOptions {
  readonly mustExist?: boolean;
  readonly mustBeFile?: boolean;
  /** Permit a symlink only at the final component. Parent symlinks remain an
   * escape and are always rejected. Callers must use lstat/readlink, not follow
   * the permitted leaf. */
  readonly allowLeafSymlink?: boolean;
}

function resultError(errors: readonly string[]): Error {
  return new Error(errors.join("; "));
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Canonicalize a repository path and reject every existing symlink component.
 * Walking components (rather than checking only the leaf) prevents both reads
 * and writes from escaping through an in-repository symlinked directory.
 */
export function inspectRepositoryPath(
  root: string,
  raw: string,
  label = "repository path",
  options: RepositoryPathInspectionOptions = {},
): InspectedRepositoryPath {
  const canonicalRoot = resolve(root);
  const parsed = parseRepositoryPath(canonicalRoot, raw, label);
  if (!parsed.ok) throw resultError(parsed.errors);

  const rootStat = lstatIfPresent(canonicalRoot);
  if (rootStat === null) throw new Error(`repository root does not exist: ${canonicalRoot}`);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`repository root must be a real directory: ${canonicalRoot}`);
  }
  if (realpathSync(canonicalRoot) !== canonicalRoot) {
    throw new Error(`repository root must be canonical: ${canonicalRoot}`);
  }

  let current = canonicalRoot;
  const segments = parsed.value.relative.split("/");
  let pathExists = true;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = lstatIfPresent(current);
    if (stat === null) {
      pathExists = false;
      break;
    }
    if (stat.isSymbolicLink() && !(options.allowLeafSymlink && index === segments.length - 1)) {
      throw new Error(`${label} must not traverse a symlink: ${raw}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label} has a non-directory parent component: ${raw}`);
    }
  }

  if (options.mustExist && !pathExists) throw new Error(`${label} does not exist: ${raw}`);
  if (pathExists && options.mustBeFile && !lstatSync(parsed.value.absolute).isFile()) {
    throw new Error(`${label} must be a regular file: ${raw}`);
  }

  return Object.freeze({ ...parsed.value, exists: pathExists });
}

/** Transcript write evidence split at the repository boundary. */
export type PartitionedWriteEvidence = Readonly<{
  repository: readonly string[];
  external: readonly string[];
}>;

const isOutside = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot);
};

/** Real location of a possibly-absent path: the deepest existing ancestor
 *  resolved through every symlink, joined with the not-yet-existing suffix. */
function realLocation(path: string): string {
  let existing = path;
  const suffix: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...suffix.reverse());
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(existing);
      if (parent === existing) return path;
      suffix.push(existing.slice(parent.length).replace(/^\//, ""));
      existing = parent;
    }
  }
}

/**
 * An Agent may write outside the repository (its scratchpad, /tmp). Such a
 * write cannot change repository bytes, so it is neither byte-scope evidence
 * nor an observation failure. "Outside" is proven twice — lexically and by
 * real location — so an alias that resolves into the repository (a symlinked
 * prefix) stays repository evidence. Relative paths always stay repository
 * evidence for the strict parser, so a `../` escape still fails closed.
 */
export function partitionWriteEvidence(root: string, raw: readonly string[]): PartitionedWriteEvidence {
  const canonicalRoot = resolve(root);
  // Resolved only when a lexically external candidate needs the second proof,
  // so repository-only evidence never touches the filesystem here.
  let realRoot: string | undefined;
  const repository: string[] = [];
  const external: string[] = [];
  for (const path of raw) {
    const outside = isAbsolute(path) && isOutside(canonicalRoot, resolve(path)) &&
      isOutside(realRoot ??= realpathSync(canonicalRoot), realLocation(resolve(path)));
    (outside ? external : repository).push(path);
  }
  return Object.freeze({ repository: Object.freeze(repository), external: Object.freeze(external) });
}

/** Lexical canonicalization for transcript evidence before it enters state. */
export function canonicalRepositoryPaths(
  root: string,
  raw: readonly string[],
  label = "repository paths",
): readonly string[] {
  const parsed = parseRepositoryPathSet(resolve(root), raw, label);
  if (!parsed.ok) throw resultError(parsed.errors);
  return Object.freeze(parsed.value.map(({ relative }) => relative));
}
