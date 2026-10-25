/**
 * The overlay's path set: which paths the reviewed workspace differs from
 * HEAD in, read from `git status --porcelain=v2 -z --untracked-files=all`.
 * Pure: the shell (`orchestration/owner-mutation-workspace.ts`) runs Git and
 * copies each path this names into the isolated worktree, so the matrix test
 * runs against the Wave's bytes.
 *
 * Record shapes (porcelain v2, NUL-separated):
 * - `1 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <path>`: an ordinary change;
 * - `2 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` followed by a
 *   separate `<origPath>` record: a rename or copy, both sides overlaid;
 * - `u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`: unmerged;
 * - `? <path>`: untracked; a trailing `/` names an untracked directory;
 * - `# ...` headers and empty records are skipped.
 */

import { failure, success, type DomainResult } from "../orchestration-contract/identity";

/** How many space-separated fields precede the path in each tracked record kind. */
const PATH_FIELD: Readonly<Record<string, number>> = Object.freeze({ "1": 8, "2": 9, u: 10 });

/** The path one record names, or null when the record is not one porcelain v2 prints. Paths may contain spaces. */
function recordPath(record: string): string | null {
  if (record.startsWith("? ")) return record.slice(2);
  const fields = record.split(" ");
  const preceding = PATH_FIELD[fields[0] ?? ""];
  if (preceding === undefined || fields.length <= preceding) return null;
  return fields.slice(preceding).join(" ");
}

/** Every repository-relative path the status output names, in output order; a rename or copy names both sides. */
export function statusPaths(output: string): DomainResult<readonly string[], string> {
  const records = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record === "" || record.startsWith("# ")) continue;
    const path = recordPath(record);
    if (path === null) return failure(`git status printed an unrecognized record: ${JSON.stringify(record)}`);
    paths.push(path);
    if (!record.startsWith("2 ")) continue;
    index += 1;
    const original = records[index];
    if (original === undefined || original === "") return failure("git status printed a rename without its original path");
    paths.push(original);
  }
  return success(Object.freeze(paths));
}
