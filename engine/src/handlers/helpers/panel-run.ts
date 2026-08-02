/**
 * Panel run shell — the filesystem boundary every panel helper shares.
 *
 * Companion to `core/panel-kernel.ts`: the kernel owns the pure envelope rules,
 * this owns the untrusted-path rules. Both panels write their artifacts into a
 * unique run directory under a runs-root inside the cwd, and both must reject
 * a symlinked hop, an escaping path, and an empty or non-regular artifact
 * before any agent output is believed.
 *
 * Not pure: lstat/realpath/read/write. Kept out of `core/` for that reason.
 */

import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { HookResult } from "../../types";
import type { ParseResult } from "../../core/panel-kernel";
import { fail, ok } from "../../core/panel-kernel";

/**
 * The file and directory names one panel uses inside its run directory.
 * The only thing that differs between panels at this layer — the containment
 * and symlink rules below are identical, and deliberately not parameterized.
 */
export interface RunLayout {
  /** Human-readable context the panel was built from. */
  readonly contextMd: string;
  /** Its validated, canonical JSON form — the only version agents consume. */
  readonly contextJson: string;
  /** Directory holding the items the panel judges. */
  readonly itemDir: string;
  /** Directory holding one verdict file per criterion. */
  readonly verdictDir: string;
}

/** `/loom --panel`: an interview digest and one candidate per lens. */
export const ARCHITECTURE_LAYOUT: RunLayout = Object.freeze({
  contextMd: "interview.md",
  contextJson: "interview.json",
  itemDir: "candidates",
  verdictDir: "verdicts",
});

/** The wave gate's refutation panel: a findings brief and the finding set. */
export const REVIEW_LAYOUT: RunLayout = Object.freeze({
  contextMd: "brief.md",
  contextJson: "brief.json",
  itemDir: "findings",
  verdictDir: "verdicts",
});

export function argumentValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1]! : null;
}

export function contractError(context: string, errors: readonly string[]) {
  return {
    kind: "error" as const,
    message: [`${context} contract failed:`, ...errors.map((error) => `- ${error}`)].join("\n"),
  };
}

export type RunBoundary = Readonly<{ runDir: string; manifestPath: string }>;

/** The runs-root must sit inside the cwd, reached without traversing a symlink.
 *  Every hop is checked, not just the leaf: a symlinked ancestor is enough to
 *  point the whole run somewhere the containment checks never see. */
function runsRootErrors(cwd: string, fromCwd: string): string[] {
  const errors: string[] = [];
  if (isAbsolute(fromCwd) || fromCwd === ".." || fromCwd.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    errors.push("panel-runs root must be inside the current working directory");
    return errors;
  }
  let cursor = cwd;
  for (const segment of fromCwd.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) errors.push(`path component must not be a symbolic link: ${cursor}`);
    } catch (error) {
      errors.push(`cannot inspect path component ${cursor}: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }
  return errors;
}

/** One run-scoped path's shape check: exists, right kind, not a symlink. */
function entryErrors(label: string, path: string, kind: "directory" | "file"): string[] {
  const errors: string[] = [];
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) errors.push(`${label} must not be a symbolic link: ${path}`);
    if (kind === "directory" && !stat.isDirectory()) errors.push(`${label} must be a directory: ${path}`);
    if (kind === "file" && (!stat.isFile() || stat.size === 0)) errors.push(`${label} must be a non-empty regular file: ${path}`);
  } catch (error) {
    errors.push(`cannot inspect ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

/**
 * Bind a run DIRECTORY to an explicit panel-runs root, for the operations that
 * run before a manifest exists (the review panel writes its brief and manifest
 * from the engine). Same containment and symlink rules as parseRunBoundary,
 * minus the manifest itself.
 */
export function parseRunDirectory(runsRoot: string, runDir: string): ParseResult<string> {
  const cwd = realpathSync(process.cwd());
  const absoluteRoot = resolve(runsRoot);
  const absoluteRunDir = resolve(runDir);

  const errors = runsRootErrors(cwd, relative(cwd, absoluteRoot));
  if (dirname(absoluteRunDir) !== absoluteRoot) {
    errors.push("run directory must be directly inside --runs-root");
  }
  errors.push(...entryErrors("run directory", absoluteRunDir, "directory"));

  return errors.length > 0 ? fail(errors) : ok(runDir);
}

/** Bind the run to an explicit panel-runs root and reject every symlinked hop. */
export function parseRunBoundary(runsRoot: string, manifestPath: string): ParseResult<RunBoundary> {
  const cwd = realpathSync(process.cwd());
  const absoluteRoot = resolve(runsRoot);
  const absoluteManifest = resolve(manifestPath);
  const absoluteRunDir = dirname(absoluteManifest);

  const errors = runsRootErrors(cwd, relative(cwd, absoluteRoot));
  if (dirname(absoluteRunDir) !== absoluteRoot) {
    errors.push("manifest must be directly inside one run directory under --runs-root");
  }
  if (absoluteManifest !== join(absoluteRunDir, "manifest.json")) {
    errors.push("manifest filename must be exactly manifest.json");
  }
  errors.push(...entryErrors("run directory", absoluteRunDir, "directory"));
  errors.push(...entryErrors("manifest", absoluteManifest, "file"));

  if (errors.length > 0) return fail(errors);
  return ok({ runDir: dirname(manifestPath), manifestPath });
}

/** One artifact's existence/shape/containment check. Returns null when the file
 *  is a non-empty regular file resolving directly inside `expectedParent`. */
export function artifactError(path: string, expectedParent: string): string | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return `artifact must not be a symbolic link: ${path}`;
    if (!stat.isFile() || stat.size === 0) {
      return `artifact must be a non-empty regular file: ${path}`;
    }
    if (dirname(realpathSync(path)) !== expectedParent) {
      return `artifact resolves outside its run-scoped directory: ${path}`;
    }
    return null;
  } catch (error) {
    return `cannot verify artifact ${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Canonical per-criterion verdict path. Positional by index, but the content
 *  is re-validated against `criteria[index]` when read, so a verdict written to
 *  the wrong slot is a hard error rather than a silent mis-adjudication. */
export function verdictPath(runDir: string, layout: RunLayout, index: number): string {
  return join(runDir, layout.verdictDir, `verdict-${index + 1}.json`);
}

/** Resolve a run directory once, so every containment check compares against
 *  the same real path. Errors are returned, never thrown — a panel helper's
 *  failure must reach the operator as a contract diagnostic. */
export function realRunDir(runDir: string): ParseResult<string> {
  try {
    return ok(realpathSync(runDir));
  } catch (error) {
    return fail([`cannot resolve run directory ${runDir}: ${error instanceof Error ? error.message : String(error)}`]);
  }
}

export function writeCanonicalOutput(output: string): HookResult {
  try {
    writeFileSync(process.stdout.fd, output);
    return { kind: "allow" as const };
  } catch (error) {
    return contractError("canonical output", [
      `stdout write failed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}
