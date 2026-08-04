import { lstatSync, realpathSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
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
    if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse a symlink: ${raw}`);
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
