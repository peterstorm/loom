/**
 * Skeleton test inputs built as data through the production parsers: every
 * `Identifier` is minted by `parseIdentifier`, never cast, every
 * `ExportBinding` carries at least one export by construction, and a frozen
 * test-file classification is frozen by `freezeVerificationManifest`.
 */

import type { DomainResult } from "../../src/core/orchestration-contract";
import { parseIdentifier } from "../../src/core/skeleton/bindings";
import type { ExportBinding, Identifier } from "../../src/core/skeleton/types";
import { freezeVerificationManifest, type FrozenVerificationManifest } from "../../src/core/verification-manifest";

/** The value of an accepted result; a refusal fails the test, naming `what`. */
export const unwrap = <T, E>(result: DomainResult<T, E>, what = "fixture input"): T => {
  if (!result.ok) throw new Error(`${what} refused: ${JSON.stringify(result.error)}`);
  return result.value;
};

/** An `Identifier` minted by `parseIdentifier`. */
export const identifier = (raw: string): Identifier => unwrap(parseIdentifier(raw), `parseIdentifier(${raw})`);

/** One export binding of `path` to `contract`, each `[name, alias]` pair parsed. */
export const binding = (path: string, contract: string, ...exports: readonly (readonly [string, string])[]): ExportBinding => {
  const [first, ...rest] = exports.map(([name, alias]) => ({ name: identifier(name), alias: identifier(alias) }));
  if (first === undefined) throw new Error("fixture binding needs at least one export");
  return { path, contract, exports: [first, ...rest] };
};

/** A `.loom/verification-manifest.json` declaring `testFileSuffixes`, frozen as population freezes it. */
export function frozenManifestWith(testFileSuffixes: readonly string[]): FrozenVerificationManifest {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    kind: "loom-verification-manifest", checks: [], schemaVersion: 2, testFileSuffixes,
  })));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return frozen.value;
}
