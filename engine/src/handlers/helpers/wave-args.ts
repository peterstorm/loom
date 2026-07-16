/**
 * Single source of truth for --wave CLI parsing across the wave-scoped
 * helpers (complete-wave-gate, lint-wave-gate, mark-tests-passed). Each
 * helper previously carried its own copy with a "mirrors …" comment doing
 * the job of this import.
 */

/** Parses --wave N from CLI args (null when absent). A non-integer or
 *  sub-1 value throws — an unvalidated Number() would evaluate wave "NaN":
 *  filtering on it matches zero tasks (vacuous success) and stamping it
 *  writes wave_gates["NaN"] (vacuous gate pass). */
export function parseWaveArg(args: string[]): number | null {
  const idx = args.indexOf("--wave");
  if (idx < 0 || !args[idx + 1]) return null;
  const n = Number(args[idx + 1]);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --wave value: "${args[idx + 1]}" (must be a positive integer)`);
  }
  return n;
}
