/**
 * Shared Git fixture primitives for the remediation orchestration tests.
 *
 * `remediation-index.test.ts` and `remediation-faults.test.ts` each declared
 * their own `git`/`write`/`pathspecContract` — `pathspecContract` byte-for-byte
 * identical, the other two differing only in whether the git result is returned.
 * These decide what the tests believe about determinism (fixed identity, `LC_ALL=C`)
 * and about the literal-NUL pathspec contract; two copies is two chances for one
 * suite to test a subtly different Git than its sibling.
 *
 * Each suite keeps its OWN `fixtureRepository`: they seed genuinely different
 * trees, and that difference is part of what each is testing.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FixedGitPathspecContract } from "../../src/core/remediation-machine";

/** Real Git, fixed identity and config so the fixture is deterministic. */
export function gitResult(root: string, args: readonly string[]): SpawnSyncReturns<string> {
  const result = spawnSync("git", [...args], {
    cwd: root,
    encoding: "utf-8",
    env: { PATH: process.env["PATH"] ?? "", HOME: root, LC_ALL: "C" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

export function git(root: string, args: readonly string[]): void {
  gitResult(root, args);
}

export function write(root: string, path: string, contents: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/**
 * A pathspec contract over `paths`, with placeholder digests.
 *
 * The digests are deliberately not real: these suites exercise the STAGING
 * mechanics — literal pathspecs read from a NUL-delimited manifest on stdin —
 * and the digest proofs are `remediation-machine`'s own tests to make.
 */
export function pathspecContract(paths: readonly string[]): FixedGitPathspecContract {
  const bytes = [...Buffer.from(paths.map((path) => `${path}\0`).join(""), "utf-8")];
  return {
    schemaVersion: 1,
    kind: "fixed-git-pathspec-contract",
    globalArgs: ["--literal-pathspecs"],
    pathspecArgs: ["--pathspec-from-file=-", "--pathspec-file-nul"],
    manifest: {
      schemaVersion: 1,
      kind: "literal-nul-path-manifest",
      paths: { paths, digest: "0".repeat(64) },
      bytes,
      byteLength: bytes.length,
      contentDigest: "0".repeat(64),
      digest: "0".repeat(64),
    },
    digest: "0".repeat(64),
  } as unknown as FixedGitPathspecContract;
}
