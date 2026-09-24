/**
 * Witness-integrity emptiness-guard pins for git-remediation (pta-1).
 *
 * `snapshotRepositoryWitness` turns transiently silent Git observations into
 * the repository witness, and `installVerifiedIndex` re-reads the real index
 * path under the compare-and-swap. A confirmed silence at either site must
 * refuse loudly — `sha256("")` must never become a witness value or an index
 * path — and these are the only two emptiness guards the scripted-spawn
 * harness in git-remediation-ordering.test.ts does not already pin.
 *
 * The mock intercepts EXACTLY one fixed-argv probe at a time and delegates
 * every other spawn to real Git, so the fixture repositories, temporary
 * indexes, and installation authority are all real engine outputs.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const interception = vi.hoisted(() => ({
  matches: [] as string[][],
  predicate: null as null | ((file: string, args: readonly string[]) => boolean),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (file: string, args: readonly string[], options?: unknown) => {
      if (interception.predicate?.(file, args) === true) {
        interception.matches.push([file, ...args]);
        return { error: null, status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      return actual.spawnSync(file, args as never, options as never);
    },
  };
});

import {
  createTemporaryIndex,
  installVerifiedIndex,
  openGitRepository,
  snapshotRepositoryWitness,
  stageAuditedPaths,
  type GitRepository,
} from "../../src/orchestration/git-remediation";
import type { CurrentVerifiedIndexInstallation } from "../../src/core/remediation-machine";
import { git, pathspecContract, write } from "../fixtures/git-repository";
import { verifiedRemediationInstallation } from "../fixtures/verified-remediation-installation";

const cleanup: string[] = [];

afterEach(() => {
  interception.predicate = null;
  interception.matches = [];
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixtureRepository(): GitRepository {
  const root = mkdtempSync(join(tmpdir(), "loom-witness-guards-"));
  cleanup.push(root);
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Fixture"]);
  write(root, "src/target.ts", "export const target = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const opened = openGitRepository(root);
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

describe("repository witness and install emptiness guards", () => {
  it("refuses a confirmed-empty HEAD^{tree} witness probe after the bounded retry, never digesting sha256(\"\")", () => {
    const repository = fixtureRepository();
    // runGit prepends --literal-pathspecs to every argv.
    interception.predicate = (_file, args) => args.includes("HEAD^{tree}");
    const witness = snapshotRepositoryWitness(repository);
    expect(witness.ok).toBe(false);
    if (witness.ok) throw new Error("expected refusal");
    expect(witness.error.operation).toBe("rev-parse");
    expect(witness.error.message).toBe("git rev-parse HEAD^{tree} returned no output");
    // Three transient-empty attempts ran before the guard refused: silence
    // after the retry budget is a malformed observation, never an empty value
    // to digest into the repository witness.
    expect(interception.matches).toHaveLength(3);
  });

  it("refuses installation when the real-index path probe answers empty, before any lock or write", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/target.ts", "export const target = 2;\n");
    const temporary = createTemporaryIndex(repository);
    if (!temporary.ok) throw new Error(temporary.error.message);
    cleanup.push(temporary.value.directory);
    const staged = stageAuditedPaths(repository, temporary.value, pathspecContract(["src/target.ts"]));
    if (!staged.ok) throw new Error(staged.error.message);
    const witness: CurrentVerifiedIndexInstallation = verifiedRemediationInstallation(repository, temporary.value);

    // runGit prepends --literal-pathspecs to every argv.
    interception.predicate = (_file, args) => args.includes("--git-path") && args.includes("index");
    const installed = installVerifiedIndex(repository, temporary.value, witness);

    expect(installed.ok).toBe(false);
    if (installed.ok) throw new Error("expected refusal");
    expect(installed.error.operation).toBe("install");
    expect(installed.error.message).toBe("Git returned an empty real-index path");
    // The guard fired before the index lock: no index.lock exists and the
    // tracked worktree is untouched.
    expect(existsSync(join(repository.root, ".git", "index.lock"))).toBe(false);
  });
});
