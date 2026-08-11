import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTemporaryIndex,
  digestTemporaryIndex,
  discardTemporaryIndex,
  installVerifiedIndex,
  observeDirtyPaths,
  openGitRepository,
  readRepositoryBytes,
  readStagedPaths,
  snapshotRepositoryWitness,
  stageAuditedPaths,
  type GitRepository,
} from "../../src/orchestration/git-remediation";
import type { FixedGitPathspecContract } from "../../src/core/remediation-machine";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Real Git, fixed identity and config so the fixture is deterministic. */
function gitResult(root: string, args: readonly string[]) {
  const result = spawnSync("git", [...args], {
    cwd: root,
    encoding: "utf-8",
    env: { PATH: process.env["PATH"] ?? "", HOME: root, LC_ALL: "C" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

function git(root: string, args: readonly string[]): void {
  gitResult(root, args);
}

function write(root: string, path: string, contents: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/** A repository with one commit and a few tracked files. */
function fixtureRepository(): GitRepository {
  const root = mkdtempSync(join(tmpdir(), "loom-git-remediation-"));
  cleanup.push(root);
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "commit.gpgsign", "false"]);

  write(root, "src/kept.ts", "export const kept = 1;\n");
  write(root, "src/edited.ts", "export const edited = 1;\n");
  write(root, "src/removed.ts", "export const removed = 1;\n");
  write(root, "src/renamed.ts", "export const renamed = 1;\n");
  write(root, "unrelated.ts", "export const unrelated = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "base"]);

  const opened = openGitRepository(root);
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

/**
 * The pathspec contract the core would produce. Built here from its real
 * shape so the adapter is exercised through the same structure it receives in
 * production — including the canonical NUL bytes.
 */
function pathspecContract(paths: readonly string[]): FixedGitPathspecContract {
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

function stageInto(repository: GitRepository, paths: readonly string[]) {
  const temporary = createTemporaryIndex(repository);
  if (!temporary.ok) throw new Error(temporary.error.message);
  cleanup.push(temporary.value.directory);
  const staged = stageAuditedPaths(repository, temporary.value, pathspecContract(paths));
  return { temporary: temporary.value, staged };
}

// --- Repository identity ----------------------------------------------------

describe("opening a repository", () => {
  it("resolves the root once, so later paths mean one thing", () => {
    const repository = fixtureRepository();
    const nested = join(repository.root, "src");

    const fromNested = openGitRepository(nested);

    expect(fromNested.ok).toBe(true);
    if (!fromNested.ok) return;
    expect(fromNested.value.root).toBe(repository.root);
  });

  it("reports a typed failure outside a repository rather than throwing", () => {
    const outside = mkdtempSync(join(tmpdir(), "loom-not-a-repo-"));
    cleanup.push(outside);

    const opened = openGitRepository(outside);

    expect(opened.ok).toBe(false);
  });
});

// --- Observation ------------------------------------------------------------

describe("observing dirty paths", () => {
  it("reports added, modified, and deleted paths with their node kind", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/edited.ts", "export const edited = 2;\n");
    write(repository.root, "src/added.ts", "export const added = 1;\n");
    unlinkSync(join(repository.root, "src/removed.ts"));

    const observed = observeDirtyPaths(repository);

    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    const byPath = new Map(observed.value.map((entry) => [entry.path, entry]));
    expect(byPath.get("src/edited.ts")).toMatchObject({ change: "modified", nodeKind: "file" });
    expect(byPath.get("src/added.ts")).toMatchObject({ change: "added", nodeKind: "file" });
    expect(byPath.get("src/removed.ts")).toMatchObject({ change: "deleted", nodeKind: "missing" });
  });

  it("keeps a path containing a space or a quote intact", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/with space.ts", "export const spaced = 1;\n");
    write(repository.root, 'src/with"quote.ts', "export const quoted = 1;\n");

    const observed = observeDirtyPaths(repository);

    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    const paths = observed.value.map((entry) => entry.path);
    expect(paths).toContain("src/with space.ts");
    expect(paths).toContain('src/with"quote.ts');
  });

  it("reports both halves of a rename", () => {
    const repository = fixtureRepository();
    git(repository.root, ["mv", "src/renamed.ts", "src/renamed-to.ts"]);

    const observed = observeDirtyPaths(repository);

    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    const byPath = new Map(observed.value.map((entry) => [entry.path, entry]));
    expect(byPath.get("src/renamed-to.ts")?.change).toBe("renamed-to");
    expect(byPath.get("src/renamed.ts")?.change).toBe("renamed-from");
  });
});

// --- Staging ----------------------------------------------------------------

describe("staging into a temporary index", () => {
  it("stages exactly the audited set and nothing else", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/edited.ts", "export const edited = 2;\n");
    write(repository.root, "unrelated.ts", "export const unrelated = 2;\n");

    const { staged } = stageInto(repository, ["src/edited.ts"]);

    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value).toEqual(["src/edited.ts"]);
  });

  it("stages an addition", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/added.ts", "export const added = 1;\n");

    const { staged } = stageInto(repository, ["src/added.ts"]);

    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value).toEqual(["src/added.ts"]);
  });

  it("stages a deletion as a deletion rather than skipping it", () => {
    const repository = fixtureRepository();
    unlinkSync(join(repository.root, "src/removed.ts"));

    const { staged } = stageInto(repository, ["src/removed.ts"]);

    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value).toEqual(["src/removed.ts"]);
  });

  it("stages both halves of a rename when both are audited", () => {
    const repository = fixtureRepository();
    git(repository.root, ["mv", "src/renamed.ts", "src/renamed-to.ts"]);
    git(repository.root, ["reset", "--quiet"]);

    const { staged } = stageInto(repository, ["src/renamed.ts", "src/renamed-to.ts"]);

    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value).toEqual(["src/renamed-to.ts", "src/renamed.ts"]);
  });

  it("stages nothing for an absent, unchanged path", () => {
    const repository = fixtureRepository();

    const { staged } = stageInto(repository, ["src/kept.ts"]);

    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value).toEqual([]);
  });

  it("refuses an empty path set instead of staging everything", () => {
    const repository = fixtureRepository();

    const { staged } = stageInto(repository, []);

    expect(staged.ok).toBe(false);
    if (staged.ok) return;
    expect(staged.error.message).toContain("empty path set");
  });

  it("refuses to stage Loom's own run evidence", () => {
    const repository = fixtureRepository();
    write(repository.root, ".claude/state/active_task_graph.json", "{}\n");

    const { staged } = stageInto(repository, [".claude/state/active_task_graph.json"]);

    expect(staged.ok).toBe(false);
    if (staged.ok) return;
    expect(staged.error.message).toContain("excluded Loom evidence");
  });

  it("treats a glob character in a path as a literal name, not a pattern", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/star*.ts", "export const star = 1;\n");
    write(repository.root, "src/other.ts", "export const other = 1;\n");

    const { staged } = stageInto(repository, ["src/star*.ts"]);

    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    // A pattern would have swept up src/other.ts as well.
    expect(staged.value).toEqual(["src/star*.ts"]);
  });

  it("leaves the real index untouched while staging", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/edited.ts", "export const edited = 2;\n");
    const before = snapshotRepositoryWitness(repository);

    stageInto(repository, ["src/edited.ts"]);

    const after = snapshotRepositoryWitness(repository);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.value.indexDigest).toBe(before.value.indexDigest);
  });
});

// --- Installation -----------------------------------------------------------

describe("installing a verified index", () => {
  it("installs the staged set and leaves unrelated worktree bytes unchanged", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/edited.ts", "export const edited = 2;\n");
    write(repository.root, "unrelated.ts", "export const unrelated = 2;\n");
    const unrelatedBefore = readRepositoryBytes(repository.root, "unrelated.ts");

    const { temporary, staged } = stageInto(repository, ["src/edited.ts"]);
    expect(staged.ok).toBe(true);
    const witness = snapshotRepositoryWitness(repository);
    if (!witness.ok) throw new Error(witness.error.message);

    const installed = installVerifiedIndex(repository, temporary, witness.value);

    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    expect(installed.value.installedPaths).toEqual(["src/edited.ts"]);
    expect(readRepositoryBytes(repository.root, "unrelated.ts")).toEqual(unrelatedBefore);
  });

  it("refuses to install when the repository moved since verification", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/edited.ts", "export const edited = 2;\n");
    const { temporary, staged } = stageInto(repository, ["src/edited.ts"]);
    expect(staged.ok).toBe(true);
    const witness = snapshotRepositoryWitness(repository);
    if (!witness.ok) throw new Error(witness.error.message);

    // Someone edits an unrelated file between verification and installation.
    write(repository.root, "unrelated.ts", "export const unrelated = 99;\n");

    const installed = installVerifiedIndex(repository, temporary, witness.value);

    expect(installed.ok).toBe(false);
    if (installed.ok) return;
    expect(installed.error.message).toContain("changed since verification");
    expect(installed.error.message).toContain("nothing was installed");
  });

  it("rechecks the witness under the real index lock and preserves a concurrent writer's staged work", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/edited.ts", "export const edited = 2;\n");
    write(repository.root, "unrelated.ts", "export const unrelated = 2;\n");
    const { temporary, staged } = stageInto(repository, ["src/edited.ts"]);
    expect(staged.ok).toBe(true);
    const witness = snapshotRepositoryWitness(repository);
    if (!witness.ok) throw new Error(witness.error.message);

    // This is a real Git index writer, not a mocked witness. It lands after
    // verification and before installation. installVerifiedIndex must acquire
    // .git/index.lock first, observe the moved index there, and refuse rather
    // than overwrite the unrelated staged entry.
    git(repository.root, ["add", "--", "unrelated.ts"]);

    const installed = installVerifiedIndex(repository, temporary, witness.value);

    expect(installed.ok).toBe(false);
    if (installed.ok) return;
    expect(installed.error.message).toContain("indexDigest");
    expect(gitResult(repository.root, ["diff", "--cached", "--name-only"]).stdout.trim()).toBe("unrelated.ts");
  });

  it("leaves the real index unchanged when installation is refused", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/edited.ts", "export const edited = 2;\n");
    const { temporary, staged } = stageInto(repository, ["src/edited.ts"]);
    expect(staged.ok).toBe(true);
    const witness = snapshotRepositoryWitness(repository);
    if (!witness.ok) throw new Error(witness.error.message);
    write(repository.root, "unrelated.ts", "export const unrelated = 99;\n");
    const indexBefore = snapshotRepositoryWitness(repository);

    installVerifiedIndex(repository, temporary, witness.value);

    const indexAfter = snapshotRepositoryWitness(repository);
    expect(indexBefore.ok && indexAfter.ok).toBe(true);
    if (!indexBefore.ok || !indexAfter.ok) return;
    expect(indexAfter.value.indexDigest).toBe(indexBefore.value.indexDigest);
  });

  it("removes the temporary index whether it installs or refuses", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/edited.ts", "export const edited = 2;\n");
    const { temporary, staged } = stageInto(repository, ["src/edited.ts"]);
    expect(staged.ok).toBe(true);
    const witness = snapshotRepositoryWitness(repository);
    if (!witness.ok) throw new Error(witness.error.message);

    installVerifiedIndex(repository, temporary, witness.value);

    expect(() => statSync(temporary.path)).toThrow();
  });
});

// --- Digests ----------------------------------------------------------------

describe("index digests", () => {
  it("changes when the staged set changes and is stable when it does not", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/edited.ts", "export const edited = 2;\n");

    const first = stageInto(repository, ["src/edited.ts"]);
    const firstDigest = digestTemporaryIndex(repository, first.temporary);
    const repeated = digestTemporaryIndex(repository, first.temporary);

    const second = stageInto(repository, ["src/kept.ts"]);
    const secondDigest = digestTemporaryIndex(repository, second.temporary);

    expect(firstDigest.ok && repeated.ok && secondDigest.ok).toBe(true);
    if (!firstDigest.ok || !repeated.ok || !secondDigest.ok) return;
    expect(repeated.value).toBe(firstDigest.value);
    expect(secondDigest.value).not.toBe(firstDigest.value);
  });

  it("reports the staged paths of a discarded index as a failure, not as empty", () => {
    const repository = fixtureRepository();
    const { temporary } = stageInto(repository, ["src/kept.ts"]);
    discardTemporaryIndex(temporary);

    const staged = readStagedPaths(repository, temporary);

    // A discarded index must not read back as "nothing staged" — that is
    // indistinguishable from a legitimately empty set.
    expect(staged.ok).toBe(false);
  });
});
