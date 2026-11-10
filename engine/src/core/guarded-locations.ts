/**
 * Core: the directories Loom guards, as one domain value.
 *
 * Pure. Which directories exist is configuration (the task-graph location,
 * `LOOM_SUBAGENT_DIR`, `LOOM_MACHINES_DIR`), so the shell resolves them —
 * `guardedLocations()` in config, read lazily at decision time — and passes
 * them in. How they compose is policy, and lives here once: config derives its
 * `guardedDirs()` / `protectedDirs()` from these functions, and the state-file
 * guard derives its matching scope from the same value, so the two cannot
 * disagree about what is guarded.
 */

/**
 * The guarded directories, by role. Only the roles are representable: the
 * protected set is not a separate list a caller could let drift from the
 * guarded one — it is always exactly the subagent and machine-definitions
 * directories, and both are always guarded.
 */
export type GuardedLocations = Readonly<{
  /**
   * The state directories (each task-graph candidate's directory and the
   * verification-manifest directory), deduplicated: any reference puts a
   * command in the state-file guard's scope, and a whitelisted helper may
   * write there.
   */
  stateDirs: readonly string[];
  /**
   * The subagent tracking directory: guarded AND protected — a write forges
   * trusted evidence (`.evidence.jsonl`), fakes attribution (`.active`) or
   * disarms the gate (`.machine`), so no helper may write it.
   */
  subagentDir: string;
  /**
   * The machine-definitions directory: guarded AND protected — a write
   * deletes or rewrites the gate's rules.
   */
  machinesDir: string;
}>;

/** Every guarded directory: the state directories, then the protected ones. */
export const guardedDirsOf = (locations: GuardedLocations): readonly string[] => [
  ...locations.stateDirs,
  ...protectedDirsOf(locations),
];

/** The directories whose writes are NEVER whitelisted, even for a helper. */
export const protectedDirsOf = (locations: GuardedLocations): readonly [string, ...string[]] => [
  locations.subagentDir,
  locations.machinesDir,
];
