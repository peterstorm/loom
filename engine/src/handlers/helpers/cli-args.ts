/**
 * The one CLI flag reader the helper shell uses.
 *
 * Five copies of "read the value after a named flag" had accumulated —
 * `panel-run`'s `argumentValue`, `orchestration`'s `flag`, and an `arg` each in
 * `model-calibration`, `model-profiles`, and `review-packet` — and they did not
 * agree. `model-profiles`'s copy accepted an EMPTY value the others rejected;
 * only `orchestration`'s rejected a value that is itself a flag. Divergence in
 * argument parsing is silent: the wrong copy simply reads a different command
 * line than the operator typed.
 *
 * The shared form takes the union of the guards, so a missing value, an empty
 * value, and a `--`-prefixed value are all "absent". `--run --json` never reads
 * as `run = "--json"`.
 */
export function argumentValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  return value === undefined || value === "" || value.startsWith("--") ? null : value;
}

/** Is this bare switch present? Pass the full flag, `--json`, not `json`. */
export function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}
