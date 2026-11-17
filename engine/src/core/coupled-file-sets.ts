/**
 * Coupled file sets (ADR-0082, loom#199 Cause 3): files that change together,
 * so one Task owns all of them or none.
 *
 * A package manifest and its lockfile are one change: bumping a dependency
 * edits `package.json` and regenerates the lockfile beside it. When two Tasks
 * own the two halves, every state between their attempts is legitimately
 * broken (the lockfile and installed packages on one version, the manifest on
 * another), and no Task can make the pair consistent alone.
 *
 * The rule: a Task that lists any member of a set lists every member of that
 * set that any Task of the graph lists. Population validation and every plan
 * edit apply it to the Tasks they create or change.
 *
 * Pure.
 */

import { nonEmpty, type NonEmpty } from "./orchestration-contract";

/** The lockfiles a package manager writes beside its `package.json`. */
export const PACKAGE_LOCKFILES = Object.freeze([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
] as const);

const MANIFEST = "package.json";

/** `path`'s directory prefix (with its trailing slash) and base name. */
function split(path: string): Readonly<{ dir: string; base: string }> {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { dir: "", base: path } : { dir: path.slice(0, slash + 1), base: path.slice(slash + 1) };
}

/**
 * The key of the coupled set `path` belongs to, or null when it belongs to
 * none: a manifest and its lockfiles share their directory as the key.
 */
export function coupledSetKey(path: string): string | null {
  const { dir, base } = split(path);
  return base === MANIFEST || (PACKAGE_LOCKFILES as readonly string[]).includes(base) ? `package:${dir}` : null;
}

/** One Task's missing members of a set it partly owns. */
export type CoupledSetGap = Readonly<{
  taskId: string;
  /** The members the Task lists, in its file-list order. */
  listed: NonEmpty<string>;
  /** The members another Task lists and this one does not, in graph order. */
  missing: NonEmpty<string>;
}>;

type CoupledTask = Readonly<{ id: string; file_list?: readonly string[] }>;

/**
 * Every set `task` lists part of while another Task of `tasks` lists the
 * rest, one gap per set, in the order the Task first lists a member.
 */
export function coupledSetGaps(tasks: readonly CoupledTask[], task: CoupledTask): readonly CoupledSetGap[] {
  const own = task.file_list ?? [];
  const keys = [...new Set(own.flatMap((path) => {
    const key = coupledSetKey(path);
    return key === null ? [] : [key];
  }))];
  return Object.freeze(keys.flatMap((key) => {
    const listed = nonEmpty(own.filter((path) => coupledSetKey(path) === key));
    const members = [...new Set(tasks.flatMap(({ file_list }) => (file_list ?? []).filter((path) => coupledSetKey(path) === key)))];
    const missing = nonEmpty(members.filter((path) => !own.includes(path)));
    return listed === null || missing === null ? [] : [Object.freeze({ taskId: task.id, listed, missing })];
  }));
}

/** The operator-facing sentence for one gap. */
export const describeCoupledSetGap = ({ taskId, listed, missing }: CoupledSetGap): string =>
  `${taskId} lists ${listed.join(", ")} but not ${missing.join(", ")}, which change${missing.length === 1 ? "s" : ""} ` +
  "with it (a package manifest and its lockfile are one coupled file set); one Task takes the whole set";
