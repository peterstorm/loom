import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTemporaryIndex,
  installVerifiedIndex,
  observeDirtyPaths,
  openGitRepository,
  readStagedPaths,
  readRepositoryBytes,
  runRemediationGit,
  snapshotRepositoryWitness,
  stageAuditedPaths,
  type GitRepository,
  type TemporaryIndex,
} from "../../src/orchestration/git-remediation";
import type { CurrentVerifiedIndexInstallation, FixedGitPathspecContract } from "../../src/core/remediation-machine";
import type { GitSpawnOutcome } from "../../src/utils/git-spawn-outcome";
import { git, pathspecContract, write } from "../fixtures/git-repository";
import { verifiedRemediationInstallation } from "../fixtures/verified-remediation-installation";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixtureRepository(): GitRepository {
  const root = mkdtempSync(join(tmpdir(), "loom-git-faults-"));
  cleanup.push(root);
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Fixture"]);
  write(root, "src/target.ts", "export const target = 1;\n");
  write(root, "src/bystander.ts", "export const bystander = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const opened = openGitRepository(root);
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

/** A full worktree snapshot, so "unchanged" can be asserted on bytes. */
function worktreeBytes(root: string): ReadonlyMap<string, string> {
  const collected = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else collected.set(relative, readFileSync(join(root, directory, entry.name), "utf-8"));
    }
  };
  walk(".", "");
  return collected;
}

function stageTarget(repository: GitRepository, paths: readonly string[]): Readonly<{
  temporary: TemporaryIndex;
  witness: CurrentVerifiedIndexInstallation;
}> {
  const temporary = createTemporaryIndex(repository);
  if (!temporary.ok) throw new Error(temporary.error.message);
  cleanup.push(temporary.value.directory);
  const staged = stageAuditedPaths(repository, temporary.value, pathspecContract(paths));
  if (!staged.ok) throw new Error(staged.error.message);
  const witness = verifiedRemediationInstallation(repository, temporary.value);
  return { temporary: temporary.value, witness };
}

describe("repository byte reads distinguish absence from failure", () => {
  it("returns exact existing bytes and null only for an absent path", () => {
    const repository = fixtureRepository();
    expect(readRepositoryBytes(repository.root, "src/target.ts"))
      .toEqual(Buffer.from("export const target = 1;\n"));
    expect(readRepositoryBytes(repository.root, "src/absent.ts")).toBeNull();
  });

  it("surfaces directory, non-directory ancestor, and symlink-loop errors", () => {
    const repository = fixtureRepository();
    symlinkSync("loop", join(repository.root, "loop"));
    for (const [path, code] of [["src", "EISDIR"], ["src/target.ts/child", "ENOTDIR"], ["loop", "ELOOP"]] as const) {
      expect(() => readRepositoryBytes(repository.root, path)).toThrow(expect.objectContaining({ code }));
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "surfaces permission errors for an unprivileged reader", () => {
      const repository = fixtureRepository();
      const target = join(repository.root, "src/target.ts");
      chmodSync(target, 0o000);
      try {
        expect(() => readRepositoryBytes(repository.root, "src/target.ts"))
          .toThrow(expect.objectContaining({ code: "EACCES" }));
      } finally {
        chmodSync(target, 0o644);
      }
    },
  );
});

// --- Drift between verification and installation ----------------------------

describe("compare-and-swap under concurrent change", () => {
  it.each([
    ["an unrelated file is edited", (root: string) => write(root, "src/bystander.ts", "export const bystander = 2;\n")],
    ["a new untracked file appears", (root: string) => write(root, "src/appeared.ts", "export const appeared = 1;\n")],
    ["something else is staged", (root: string) => {
      write(root, "src/bystander.ts", "export const bystander = 3;\n");
      git(root, ["add", "src/bystander.ts"]);
    }],
    ["a new commit lands", (root: string) => {
      write(root, "src/committed.ts", "export const committed = 1;\n");
      git(root, ["add", "src/committed.ts"]);
      git(root, ["commit", "--quiet", "-m", "concurrent"]);
    }],
  ])("refuses to install when %s", (_label, disturb) => {
    const repository = fixtureRepository();
    write(repository.root, "src/target.ts", "export const target = 2;\n");
    const { temporary, witness } = stageTarget(repository, ["src/target.ts"]);

    disturb(repository.root);
    const before = worktreeBytes(repository.root);

    const installed = installVerifiedIndex(repository, temporary, witness);

    expect(installed.ok).toBe(false);
    if (installed.ok) return;
    expect(installed.error.message).toContain("nothing was installed");
    expect(worktreeBytes(repository.root)).toEqual(before);
  });

  it("names which witness field drifted, so the cause is diagnosable", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/target.ts", "export const target = 2;\n");
    const { temporary, witness } = stageTarget(repository, ["src/target.ts"]);

    write(repository.root, "src/bystander.ts", "export const bystander = 2;\n");

    const installed = installVerifiedIndex(repository, temporary, witness);

    expect(installed.ok).toBe(false);
    if (installed.ok) return;
    expect(installed.error.message).toContain("worktreeDigest");
  });
});

// --- Every failure leaves the repository alone ------------------------------

describe("failure leaves index and worktree unchanged", () => {
  it("changes nothing when the temporary index was already discarded", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/target.ts", "export const target = 2;\n");
    const { temporary, witness } = stageTarget(repository, ["src/target.ts"]);
    rmSync(temporary.directory, { recursive: true, force: true });
    const before = worktreeBytes(repository.root);
    const indexBefore = snapshotRepositoryWitness(repository);

    const installed = installVerifiedIndex(repository, temporary, witness);

    expect(installed.ok).toBe(false);
    if (installed.ok) return;
    expect(installed.error.message).toContain("temporary index is missing");
    expect(worktreeBytes(repository.root)).toEqual(before);
    const indexAfter = snapshotRepositoryWitness(repository);
    expect(indexBefore.ok && indexAfter.ok).toBe(true);
    if (!indexBefore.ok || !indexAfter.ok) return;
    expect(indexAfter.value.indexDigest).toBe(indexBefore.value.indexDigest);
  });

  it("never reports a phantom staged set from a discarded index", () => {
    const repository = fixtureRepository();
    const created = createTemporaryIndex(repository);
    if (!created.ok) throw new Error(created.error.message);
    const temporary = created.value;
    rmSync(temporary.directory, { recursive: true, force: true });

    const staged = readStagedPaths(repository, temporary);

    // Git reads a missing index as EMPTY, which would present every tracked
    // file as deleted — a plausible staged set describing a change nobody
    // made. It must fail instead.
    expect(staged.ok).toBe(false);
  });

  it("leaves the worktree untouched by a successful installation", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/target.ts", "export const target = 2;\n");
    const before = worktreeBytes(repository.root);
    const { temporary, witness } = stageTarget(repository, ["src/target.ts"]);

    const installed = installVerifiedIndex(repository, temporary, witness);

    expect(installed.ok).toBe(true);
    // Installation writes the INDEX only; the work tree is not its business.
    expect(worktreeBytes(repository.root)).toEqual(before);
  });

  it("refuses an unrelated dirty path added after installation authority was minted", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/target.ts", "export const target = 2;\n");
    const { temporary, witness } = stageTarget(repository, ["src/target.ts"]);
    write(repository.root, "src/bystander.ts", "export const bystander = 2;\n");

    const installed = installVerifiedIndex(repository, temporary, witness);

    expect(installed.ok).toBe(false);
    const staged = spawnSync("git", ["diff", "--cached", "--name-only"], {
      cwd: repository.root,
      encoding: "utf-8",
      env: { PATH: process.env["PATH"] ?? "", HOME: repository.root, LC_ALL: "C" },
    });
    expect(staged.stdout.trim()).toBe("");
  });
});

// --- Command construction ---------------------------------------------------

describe("command construction", () => {
  it("ignores an ambient GIT_INDEX_FILE that would redirect the operation", () => {
    const repository = fixtureRepository();
    write(repository.root, "src/target.ts", "export const target = 2;\n");
    const hijack = join(mkdtempSync(join(tmpdir(), "loom-hijack-")), "index");
    cleanup.push(dirname(hijack));

    const previous = process.env["GIT_INDEX_FILE"];
    process.env["GIT_INDEX_FILE"] = hijack;
    try {
      const { temporary, witness } = stageTarget(repository, ["src/target.ts"]);
      const installed = installVerifiedIndex(repository, temporary, witness);
      expect(installed.ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["GIT_INDEX_FILE"];
      else process.env["GIT_INDEX_FILE"] = previous;
    }

    // The hijack index was never written to.
    expect(() => readFileSync(hijack)).toThrow();
  });

  it("fails instead of classifying an inaccessible dirty path as missing", () => {
    const repository = fixtureRepository();
    rmSync(join(repository.root, "src"), { recursive: true, force: true });
    symlinkSync("src", join(repository.root, "src"));

    const observed = observeDirtyPaths(repository);

    expect(observed.ok).toBe(false);
    if (observed.ok) return;
    expect(observed.error.operation).toBe("status-path");
    expect(observed.error.message).toMatch(/ELOOP|symbolic link/i);
  });

  it("ignores an ambient GIT_DIR that would point at another repository", () => {
    const repository = fixtureRepository();
    const decoy = mkdtempSync(join(tmpdir(), "loom-decoy-"));
    cleanup.push(decoy);
    git(decoy, ["init", "--quiet", "--initial-branch=main"]);

    const previous = process.env["GIT_DIR"];
    process.env["GIT_DIR"] = join(decoy, ".git");
    try {
      const observed = observeDirtyPaths(repository);
      expect(observed.ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = previous;
    }
  });

  it("treats a path that looks like an option as a path", () => {
    const repository = fixtureRepository();
    // A leading dash is the classic argument-injection shape; via the NUL
    // manifest it is just a filename Git cannot find, not a flag it parses.
    write(repository.root, "src/--force.ts", "export const dashed = 1;\n");

    const temporary = createTemporaryIndex(repository);
    if (!temporary.ok) throw new Error(temporary.error.message);
    cleanup.push(temporary.value.directory);
    const staged = stageAuditedPaths(repository, temporary.value, pathspecContract(["src/--force.ts"]));

    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value).toEqual(["src/--force.ts"]);
  });

  it("treats a path with a leading colon as a path, not a pathspec magic prefix", () => {
    const repository = fixtureRepository();
    write(repository.root, ":literal.ts", "export const colon = 1;\n");
    write(repository.root, "src/other.ts", "export const other = 1;\n");

    const temporary = createTemporaryIndex(repository);
    if (!temporary.ok) throw new Error(temporary.error.message);
    cleanup.push(temporary.value.directory);
    const staged = stageAuditedPaths(repository, temporary.value, pathspecContract([":literal.ts"]));

    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value).toEqual([":literal.ts"]);
  });

  it("refuses a pathspec contract whose global template was changed", () => {
    const repository = fixtureRepository();
    const temporary = createTemporaryIndex(repository);
    if (!temporary.ok) throw new Error(temporary.error.message);
    cleanup.push(temporary.value.directory);
    const tampered = {
      ...pathspecContract(["src/target.ts"]),
      globalArgs: ["--glob-pathspecs"],
    } as unknown as FixedGitPathspecContract;

    const staged = stageAuditedPaths(repository, temporary.value, tampered);

    expect(staged.ok).toBe(false);
    if (staged.ok) return;
    expect(staged.error.message).toContain("unexpected global arguments");
  });
});

describe("runRemediationGit outcome arms", () => {
  const invocation = { operation: "rev-parse", args: ["rev-parse", "--show-toplevel"] };
  const silent = Object.freeze({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  const refusal = (outcome: GitSpawnOutcome): string => {
    const result = runRemediationGit("/repo", invocation, () => outcome);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toMatchObject({ kind: "git-boundary-failed", operation: "rev-parse" });
    return result.error.message;
  };

  it("hands the spawn port the logical argv, the repository cwd and the bounds", () => {
    const calls: unknown[] = [];
    runRemediationGit("/repo", invocation, (args, run) => {
      calls.push({ args, run });
      return { kind: "exited", status: 0, ...silent };
    });
    expect(calls).toEqual([{
      args: ["--literal-pathspecs", "rev-parse", "--show-toplevel"],
      run: { cwd: "/repo", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    }]);
  });

  it("reports a git binary that cannot start", () => {
    expect(refusal({ kind: "spawn-failed", code: "ENOENT", message: "spawn git ENOENT" }))
      .toBe("git could not start: spawn git ENOENT");
  });

  it("reports a git process terminated by a signal", () => {
    expect(refusal({ kind: "signalled", signal: "SIGKILL", ...silent })).toBe("git terminated on signal SIGKILL");
  });

  it("reports a timed-out and an over-budget child with their bounds", () => {
    expect(refusal({ kind: "timed-out", timeoutMs: 30_000, signal: "SIGTERM", ...silent })).toBe("git timed out after 30000 ms");
    expect(refusal({ kind: "over-budget", maxBuffer: 1024, stdout: Buffer.alloc(2048), stderr: Buffer.from("warning: big\n") }))
      .toBe("git exceeded its 1024-byte output budget: warning: big");
  });

  it("reports a non-zero exit with its stderr verbatim", () => {
    expect(refusal({ kind: "exited", status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("fatal: not a git repository") }))
      .toBe("git exited 1: fatal: not a git repository");
  });

  it("names a fatal exit whose stderr arrived empty as a lost capture, never as Git's answer", () => {
    expect(refusal({ kind: "exited", status: 128, ...silent })).toBe(
      "git exited 128: stderr empty, stdout 0 bytes — Git writes a diagnostic for every fatal exit, so the child's stderr was lost before it reached the engine",
    );
  });

  it("passes a zero exit's stdout through as the success value", () => {
    const result = runRemediationGit("/repo", invocation, () => ({ kind: "exited", status: 0, stdout: Buffer.from(".git\n"), stderr: Buffer.alloc(0) }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.toString("utf-8")).toBe(".git\n");
  });
});
