/**
 * The value-is-a-flag rule every engine CLI grammar shares: a `--`-prefixed
 * token is a flag, never a value. The helper shell's flag reader
 * (handlers/helpers/cli-args.ts) and both Context Packet reader grammars
 * (core/context-packet-projection.ts) apply this one spelling, so
 * `--run --json` can never read as `run = "--json"` in one grammar and not in
 * another.
 *
 * Pure leaf: no I/O, no clock, no randomness.
 */
export const isFlagToken = (token: string): boolean => token.startsWith("--");

/** A flag value that names a positive safe integer (a Wave, say), or null. */
export function positiveIntegerToken(token: string): number | null {
  if (!/^[1-9][0-9]*$/.test(token)) return null;
  const value = Number(token);
  return Number.isSafeInteger(value) ? value : null;
}
