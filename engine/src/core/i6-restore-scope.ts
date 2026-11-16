/**
 * Which of a retrying Task's implementation files the I6 repair may restore.
 *
 * The repair returns the Task's implementation files to its start commit so
 * the retry can show red afresh (AD-7). A file another Task of the roster
 * also lists holds that Task's work as well: a later Wave's Task often
 * extends a file an earlier Wave wrote (a shared `package.json`, a report, a
 * harness module), and that work is usually uncommitted. Restoring such a file
 * to the start commit discards the other Task's work, so only files no other
 * Task lists are restorable. A shared file stays as it is, and the retry shows
 * red with a new failing test before its first write to it.
 *
 * Pure: the roster is the protected Task roster the brief renders from.
 */

/** A shared implementation file and the other Tasks that list it, in roster order. */
export type SharedImplementationFile = Readonly<{ path: string; coOwners: readonly string[] }>;

/** The repair's scope: the files it restores, and the shared files it leaves alone, each in file-list order. */
export type RestoreScope = Readonly<{
  restorable: readonly string[];
  shared: readonly SharedImplementationFile[];
}>;

type RosterTask = Readonly<{ id: string; file_list?: readonly string[] }>;

/** Split `implementationFiles` of Task `taskId` by whether any other Task of `roster` lists the same path. */
export function restoreScope(taskId: string, implementationFiles: readonly string[], roster: readonly RosterTask[]): RestoreScope {
  const others = roster.filter(({ id }) => id !== taskId);
  const coOwnersOf = (path: string): readonly string[] =>
    [...new Set(others.filter(({ file_list }) => (file_list ?? []).includes(path)).map(({ id }) => id))];
  const restorable: string[] = [];
  const shared: SharedImplementationFile[] = [];
  for (const path of implementationFiles) {
    const coOwners = coOwnersOf(path);
    if (coOwners.length === 0) restorable.push(path);
    else shared.push(Object.freeze({ path, coOwners: Object.freeze(coOwners) }));
  }
  return Object.freeze({ restorable: Object.freeze(restorable), shared: Object.freeze(shared) });
}
