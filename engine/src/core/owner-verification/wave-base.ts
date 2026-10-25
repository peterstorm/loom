/**
 * Which commit an owner's mutation plan diffs against (AD-8, ADR-0036): the
 * `start_sha` of the Wave Tasks that list the owner. Pure: the shell resolves
 * the chosen commit with Git (`rev-parse` for one, `merge-base --octopus` for
 * several) and reads the owner's bytes there.
 *
 * - No Wave Task lists the owner: the owner is unchanged in the Wave, so no
 *   mutant is planned (only the baseline runs).
 * - One distinct `start_sha`: that commit.
 * - Several: their octopus merge-base, so a later Task's start cannot hide an
 *   earlier Task's change.
 * - A listing Task without a `start_sha`: the base is unknown, which is the
 *   blocking `missing-wave-base` failure, never "unchanged".
 */

import type { Task } from "../../types";
import { failure, success, type DomainResult } from "../orchestration-contract/identity";
import { pathsMatch } from "../plan-path-match";
import type { OwnerInfrastructureFailure } from "./types";

/** The Task fields the choice reads. */
export type WaveBaseTask = Pick<Task, "id" | "wave" | "file_list" | "start_sha">;

/** The commit an owner's Wave change is diffed against, as the shell must resolve it. */
export type WaveBase =
  | Readonly<{ kind: "owner-unchanged" }>
  | Readonly<{ kind: "commit"; sha: string }>
  | Readonly<{ kind: "merge-base"; shas: readonly [string, string, ...string[]] }>;

/** The Wave's Tasks that list the owner, in graph order. */
export const ownerTasks = <T extends WaveBaseTask>(tasks: readonly T[], wave: number, owner: string): readonly T[] =>
  tasks.filter((task) => task.wave === wave && (task.file_list ?? []).some((file) => pathsMatch(file, owner)));

/** The owner's Wave base: unchanged, one commit, or the merge-base of several; refused when a listing Task records no start. */
export function waveBaseOf(tasks: readonly WaveBaseTask[], wave: number, owner: string): DomainResult<WaveBase, OwnerInfrastructureFailure> {
  const listing = ownerTasks(tasks, wave, owner);
  if (listing.length === 0) return success({ kind: "owner-unchanged" });
  const missing = listing.filter((task) => task.start_sha === undefined || task.start_sha === "").map((task) => task.id);
  if (missing.length > 0) {
    return failure({ kind: "missing-wave-base", detail: `Task ${missing.join(", ")} changed ${owner} but records no start_sha, so the owner's Wave base is unknown` });
  }
  const [first, second, ...rest] = [...new Set(listing.map((task) => task.start_sha!))];
  return second === undefined ? success({ kind: "commit", sha: first! }) : success({ kind: "merge-base", shas: [first!, second, ...rest] });
}
