/**
 * The shared Git execution policy, pinned at its own interface — the two
 * policy-bound spawns `runGit` and `spawnGit` — and at every engine route that
 * reaches Git through them. A recording `git` shim on PATH captures each
 * child's argv and environment, so every assertion is about what a Git child
 * actually received: the allow-listed environment, and `core.fsmonitor`
 * disabled in BOTH forms — the `-c` argv prefix every Git honours and the
 * GIT_CONFIG_COUNT/KEY/VALUE environment form only Git 2.31+ honours. An
 * "old Git" shim that strips the environment form proves the argv form alone
 * keeps a repository-configured fsmonitor hook from running.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRepositorySnapshotWitness } from "../../src/core/remediation-machine";
import { openGitRepository, snapshotRepositoryWitness } from "../../src/orchestration/git-remediation";
import {
  captureRemediationCandidateWorkspace,
  type RemediationCandidateCaptureInput,
} from "../../src/orchestration/remediation-candidate";
import { runGit, spawnGit, type GitOutput } from "../../src/utils/git-execution-policy";
import { changedPaths, diffFilesAt, diffFilesSinceAt, isTrackedAt } from "../../src/utils/git";
import { gitOutput, worktreeVisibleLeafPaths } from "../../src/utils/git-leaves";
import { observeWorkspaceDigest } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { git, write } from "../fixtures/git-repository";

const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
const AMBIENT_ATTACK: Readonly<Record<string, string>> = Object.freeze({
  GIT_DIR: "/attacker/.git",
  GIT_WORK_TREE: "/attacker",
  GIT_INDEX_FILE: "/attacker/index",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_1: "diff.external",
  GIT_CONFIG_VALUE_1: "sh -c 'touch /tmp/owned'",
  GIT_EXTERNAL_DIFF: "sh",
  GIT_LITERAL_PATHSPECS: "1",
  LOOM_UNRELATED: "leak",
});
const POLICY_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_OPTIONAL_LOCKS: "0",
});
const FSMONITOR_PREFIX = Object.freeze(["-c", "core.fsmonitor=false"]);

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = canonicalTempDir(prefix);
  cleanup.push(dir);
  return dir;
}

function withAmbient<T>(variables: Readonly<Record<string, string>>, run: () => T): T {
  const previous = new Map(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type Invocation = Readonly<{ argv: readonly string[]; env: Readonly<Record<string, string>> }>;

/**
 * A `git` shim that appends each invocation's argv and environment to a log,
 * then either emulates a tiny Git (`emulate`: `fail` exits 1, `big` prints
 * 2 MiB, anything else prints `out`), runs the real Git, or runs the real Git
 * as an "old Git" that never sees the environment config form. With
 * `failOn`, an invocation carrying that argument fails before reaching Git.
 */
function recordingGit(mode: "emulate" | "real" | "old-git", failOn?: string): Readonly<{
  path: string;
  invocations: () => readonly Invocation[];
}> {
  const bin = tempDir("loom-git-shim-");
  const log = join(bin, "invocations.log");
  writeFileSync(log, "");
  const tail = mode === "emulate"
    ? [
      "for arg in \"$@\"; do",
      "  case \"$arg\" in",
      "    fail) echo 'scripted failure' >&2; exit 1 ;;",
      "    big) head -c 2097152 /dev/zero; exit 0 ;;",
      "  esac",
      "done",
      "printf 'out'",
    ]
    : [`exec '${REAL_GIT}' "$@"`];
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    // The old-Git stand-in drops the environment form before anything is
    // recorded, so the log shows exactly what that Git receives.
    ...(mode === "old-git" ? ["unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0"] : []),
    "{",
    "  echo '@@invocation'",
    "  for arg in \"$@\"; do printf 'ARG %s\\n' \"$arg\"; done",
    "  env | sed 's/^/ENV /'",
    `} >> '${log}'`,
    ...(failOn === undefined ? [] : [
      "for arg in \"$@\"; do",
      `  if [ "$arg" = '${failOn}' ]; then echo 'scripted route failure' >&2; exit 2; fi`,
      "done",
    ]),
    ...tail,
    "",
  ].join("\n"), { mode: 0o755 });
  return Object.freeze({
    path: `${bin}:${process.env.PATH ?? ""}`,
    invocations: () => readFileSync(log, "utf-8").split("@@invocation\n").filter((record) => record !== "").map((record) => {
      const lines = record.split("\n");
      const argv = lines.filter((line) => line.startsWith("ARG ")).map((line) => line.slice(4));
      const env = Object.fromEntries(lines.filter((line) => line.startsWith("ENV ")).map((line) => {
        const [key, ...value] = line.slice(4).split("=");
        return [key!, value.join("=")];
      }));
      return Object.freeze({ argv, env });
    }),
  });
}

/** Both policy halves, as one Git child received them. */
function expectHardened(invocation: Invocation, ambientPath: string): void {
  expect(invocation.argv.slice(0, 2)).toEqual(FSMONITOR_PREFIX);
  expect(invocation.env).toMatchObject(POLICY_ENVIRONMENT);
  expect(invocation.env.PATH).toBe(ambientPath);
  for (const key of ["GIT_EXTERNAL_DIFF", "GIT_LITERAL_PATHSPECS", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1", "LOOM_UNRELATED"]) {
    expect(invocation.env[key], key).toBeUndefined();
  }
  // The location variables are absent or the shadow directory's — never ambient.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
    expect(invocation.env[key], key).not.toBe(AMBIENT_ATTACK[key]);
  }
}

/** A repository whose own config names an fsmonitor hook that leaves a marker. */
function fsmonitorRepository(): Readonly<{ root: string; marker: string }> {
  const root = tempDir("loom-git-policy-");
  const marker = join(root, "FSMONITOR_EXECUTED");
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  write(root, ".gitignore", "FSMONITOR_EXECUTED\nfsmonitor.sh\n.loom/completion-reports/\n.claude/reviews/\n");
  write(root, "tracked.txt", "tracked\n");
  git(root, ["add", ".gitignore", "tracked.txt"]);
  git(root, ["-c", "user.email=loom@example.invalid", "-c", "user.name=Loom", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "base"]);
  const hook = join(root, "fsmonitor.sh");
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(hook, 0o755);
  git(root, ["config", "core.fsmonitor", hook]);
  return Object.freeze({ root, marker });
}

describe("runGit and spawnGit — the one policy-bound spawn", () => {
  it.each<[GitOutput, unknown]>([
    ["bytes", Buffer.from("out")],
    ["text", "out"],
    ["discard", undefined],
  ])("applies the argv prefix and the allow-listed environment on a %s run", (output, expected) => {
    const shim = recordingGit("emulate");
    const result = withAmbient({ ...AMBIENT_ATTACK, PATH: shim.path }, () => runGit(["status", "--porcelain"], { output }));

    expect(result).toEqual(expected);
    const [invocation, ...rest] = shim.invocations();
    expect(rest).toEqual([]);
    expect(invocation!.argv).toEqual([...FSMONITOR_PREFIX, "status", "--porcelain"]);
    expectHardened(invocation!, shim.path);
    expect(invocation!.env.GIT_DIR).toBeUndefined();
    expect(invocation!.env.GIT_INDEX_FILE).toBeUndefined();
  });

  it("applies both halves on a status-returning run and reports exit 1 without throwing", () => {
    const shim = recordingGit("emulate");
    const result = withAmbient({ ...AMBIENT_ATTACK, PATH: shim.path }, () =>
      spawnGit(["check-ignore", "--quiet", "fail"], { maxBuffer: 1024 }));

    expect(result.status).toBe(1);
    expect(result.error).toBeUndefined();
    expect(Buffer.isBuffer(result.stderr) && result.stderr.toString("utf-8")).toBe("scripted failure\n");
    const [invocation] = shim.invocations();
    expect(invocation!.argv).toEqual([...FSMONITOR_PREFIX, "check-ignore", "--quiet", "fail"]);
    expectHardened(invocation!, shim.path);
  });

  it("throws a non-zero exit with its status and stderr, as execFileSync does", () => {
    const shim = recordingGit("emulate");
    let thrown: unknown;
    try {
      withAmbient({ PATH: shim.path }, () => runGit(["fail"], { output: "text" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ status: 1 });
    expect(String((thrown as { stderr: unknown }).stderr)).toBe("scripted failure\n");
    expect((thrown as Error).message).toMatch(/^Command failed: git -c core\.fsmonitor=false fail/);
  });

  it("relocates the repository only through the closed location overlay", () => {
    const shim = recordingGit("emulate");
    const location = {
      GIT_DIR: "/shadow",
      GIT_WORK_TREE: "/work",
      GIT_INDEX_FILE: "/work/.git/index",
      GIT_OBJECT_DIRECTORY: "/work/.git/objects",
    };
    withAmbient({ GIT_DIR: "/attacker/.git", PATH: shim.path }, () => runGit(["diff"], { output: "text", location }));
    expect(shim.invocations()[0]!.env).toMatchObject({ ...location, ...POLICY_ENVIRONMENT });
  });

  it("gives a bytes capture the listing budget, a text capture Node's default, and honours an explicit budget", () => {
    const shim = recordingGit("emulate");
    withAmbient({ PATH: shim.path }, () => {
      expect(runGit(["big"], { output: "bytes" }).byteLength).toBe(2 * 1024 * 1024);
      expect(() => runGit(["big"], { output: "text" })).toThrow(expect.objectContaining({ code: "ENOBUFS" }));
      expect(() => runGit(["big"], { output: "bytes", maxBuffer: 1024 })).toThrow(expect.objectContaining({ code: "ENOBUFS" }));
      expect(spawnGit(["big"], { maxBuffer: 1024 }).error).toMatchObject({ code: "ENOBUFS" });
    });
  });

  it("makes Git read core.fsmonitor as false, even on a Git that ignores the environment config form", () => {
    const { root } = fsmonitorRepository();
    expect(runGit(["config", "--get", "core.fsmonitor"], { output: "text", cwd: root }).trim()).toBe("false");

    const oldGit = recordingGit("old-git");
    withAmbient({ PATH: oldGit.path }, () => {
      expect(runGit(["config", "--get", "core.fsmonitor"], { output: "text", cwd: root }).trim()).toBe("false");
      expect(spawnGit(["config", "--get", "core.fsmonitor"], { cwd: root, maxBuffer: 1024 }).stdout.toString("utf-8").trim())
        .toBe("false");
    });
  });

  it("never runs a repository-configured fsmonitor hook, on the argv form alone", () => {
    const { root, marker } = fsmonitorRepository();
    // Control: the fixture's hook really runs for an unhardened Git.
    expect(spawnSync(REAL_GIT, ["status", "--porcelain"], { cwd: root, env: { PATH: process.env.PATH, HOME: root } }).status)
      .toBe(0);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const oldGit = recordingGit("old-git");
    withAmbient({ PATH: oldGit.path }, () => {
      runGit(["status", "--porcelain"], { output: "discard", cwd: root });
      expect(spawnGit(["status", "--porcelain"], { cwd: root, maxBuffer: 1024 * 1024 }).status).toBe(0);
    });
    expect(oldGit.invocations().map(({ env }) => env.GIT_CONFIG_COUNT)).toEqual([undefined, undefined]);
    runGit(["status", "--porcelain"], { output: "discard", cwd: root });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("every engine Git route runs under the policy", () => {
  it("leaf listings, revision reads, shadow diffs and listings, tracking, the workspace digest and remediation audits", () => {
    const { root, marker } = fsmonitorRepository();
    write(root, "tracked.txt", "dirty\n");
    write(root, "untracked.txt", "new\n");
    const repository = openGitRepository(root);
    if (!repository.ok) throw new Error(repository.error.message);
    const rawWitness = snapshotRepositoryWitness(repository.value);
    if (!rawWitness.ok) throw new Error(rawWitness.error.message);
    const witness = parseRepositorySnapshotWitness(rawWitness.value);
    if (!witness.ok) throw new Error(witness.error.message);
    rmSync(marker, { force: true });

    const shim = recordingGit("real");
    withAmbient({ ...AMBIENT_ATTACK, PATH: shim.path }, () => {
      expect(gitOutput(root, ["rev-parse", "HEAD"]).toString("utf-8").trim()).toMatch(/^[0-9a-f]{40}$/);
      expect(worktreeVisibleLeafPaths(root, ".")).toEqual([".gitignore", "tracked.txt", "untracked.txt"]);
      expect(changedPaths(root, "worktree")).toEqual(["tracked.txt"]);
      expect(changedPaths(root, "untracked")).toEqual(["untracked.txt"]);
      expect(diffFilesAt(root, ["tracked.txt"])).toMatchObject({ ok: true, diff: expect.stringContaining("+dirty") });
      expect(isTrackedAt(root, "tracked.txt")).toEqual({ ok: true, tracked: true });
      expect(isTrackedAt(root, "untracked.txt")).toEqual({ ok: true, tracked: false });
      expect(observeWorkspaceDigest(root)).toMatchObject({ ok: true, value: { pathCount: 3 } });
      const captured = captureRemediationCandidateWorkspace({
        repositoryStartPath: root,
        // Capture reads only the plan kind; a minted plan needs a full source inventory.
        verification: { kind: "not-required" } as unknown as RemediationCandidateCaptureInput["verification"],
        pathSources: { reviewedPaths: ["tracked.txt"], supportPaths: [], siblingPaths: [], inputSourcePaths: [] },
        runDirectory: join(root, ".claude/reviews/run"),
      }, witness.value);
      expect(captured.ok, captured.ok ? "" : captured.error.message).toBe(true);
    });

    const invocations = shim.invocations();
    for (const invocation of invocations) expectHardened(invocation, shim.path);
    const subcommandOf = ({ argv }: Invocation) => argv.slice(2).find((arg, index, rest) =>
      !arg.startsWith("-") && rest[index - 1] !== "-C");
    expect(new Set(invocations.map(subcommandOf))).toEqual(new Set(["rev-parse", "ls-files", "diff", "check-ignore"]));
    // Content-hashing listings, diffs and the tracking probe run in the shadow
    // administration directory; leaf listings never do.
    const shadowRoutes = invocations.filter(({ argv }) => argv.includes("diff") || argv.includes("--error-unmatch"));
    expect(shadowRoutes.length).toBe(4);
    for (const invocation of invocations) {
      if (shadowRoutes.includes(invocation)) expect(invocation.env.GIT_DIR).toMatch(/loom-git-shadow-/);
      else expect(invocation.env.GIT_DIR).toBeUndefined();
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("gives the workspace digest roster the leaf enumerator's ignore rules, even with a global core.excludesFile", () => {
    const { root } = fsmonitorRepository();
    write(root, "globally-ignored.txt", "operator-local\n");
    const home = tempDir("loom-git-home-");
    writeFileSync(join(home, "global-ignore"), "globally-ignored.txt\n");
    writeFileSync(join(home, ".gitconfig"), `[core]\n\texcludesFile = ${join(home, "global-ignore")}\n`);

    withAmbient({ HOME: home }, () => {
      // Control: an ambient-config Git honours the operator's global ignore file.
      expect(spawnSync(REAL_GIT, ["check-ignore", "--quiet", "globally-ignored.txt"], { cwd: root }).status).toBe(0);
      const digest = observeWorkspaceDigest(root);
      if (!digest.ok) throw new Error(JSON.stringify(digest.error));
      expect(digest.value.observedPaths).toEqual(worktreeVisibleLeafPaths(root, "."));
      expect(digest.value.observedPaths).toContain("globally-ignored.txt");
    });
  });
});

describe("the shadow administration directory", () => {
  function shadowDirectories(tmp: string): readonly string[] {
    return readdirSync(tmp).filter((entry) => entry.startsWith("loom-git-shadow-"));
  }

  it("is removed after a successful run, an expected exit-1 answer, and a failed diff", () => {
    const { root } = fsmonitorRepository();
    write(root, "tracked.txt", "dirty\n");
    const tmp = tempDir("loom-git-tmp-");
    const shim = recordingGit("real");

    withAmbient({ TMPDIR: tmp, PATH: shim.path }, () => {
      expect(diffFilesAt(root, ["tracked.txt"]).ok).toBe(true);
      expect(isTrackedAt(root, "absent.txt")).toEqual({ ok: true, tracked: false });
      expect(diffFilesSinceAt(root, "no-such-revision", ["tracked.txt"]).ok).toBe(false);
    });

    const shadows = shim.invocations().map(({ env }) => env.GIT_DIR).filter((dir): dir is string => dir !== undefined);
    expect(new Set(shadows).size).toBe(3);
    for (const shadow of shadows) {
      expect(shadow.startsWith(join(tmp, "loom-git-shadow-"))).toBe(true);
      expect(existsSync(shadow)).toBe(false);
    }
    expect(shadowDirectories(tmp)).toEqual([]);
  });

  it("is removed when the shadow-run listing throws", () => {
    const { root } = fsmonitorRepository();
    const tmp = tempDir("loom-git-tmp-");
    mkdirSync(join(tmp, "unrelated"));
    const shim = recordingGit("real", "--name-only");

    withAmbient({ TMPDIR: tmp, PATH: shim.path }, () => {
      expect(() => changedPaths(root, "worktree")).toThrow(/scripted route failure/);
    });

    const [shadow] = shim.invocations().map(({ env }) => env.GIT_DIR).filter((dir): dir is string => dir !== undefined);
    expect(shadow?.startsWith(join(tmp, "loom-git-shadow-"))).toBe(true);
    expect(shadowDirectories(tmp)).toEqual([]);
    expect(readdirSync(tmp)).toEqual(["unrelated"]);
  });
});
