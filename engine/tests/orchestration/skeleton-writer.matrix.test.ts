/**
 * INV-3 matrix: every engine-written skeleton byte goes through the one
 * no-clobber writer, `orchestration/skeleton-writer.ts`.
 *
 * Owner rows drive `createSkeleton` and `refreshSkeleton` over a temp
 * repository through each rule: a canonical repository-relative path, a frozen
 * path, a symlinked ancestor, an existing leaf of every kind, the refresh
 * digest guard (read after the replacement is prepared, so a target written
 * in place or replaced by rename meanwhile is refused), the written bytes and
 * modes, I/O failures, no prepared file left behind, and a prepared name that
 * cannot be removed (still `written` once published, named either way).
 * Every refusal is a value and leaves every byte as it was.
 *
 * Sibling rows drive `materializeTaskSkeletons` (registration, AD-1) over the
 * skeleton fixture repository with a pre-existing file, a frozen path, a
 * symlinked parent and a modified skeleton: the bytes are unchanged and the
 * refusal, where there is one, is a value naming the writer's reason.
 *
 * Sibling rows (T13) drive `materializeContractStubs` (the contract Task's
 * stop, AD-9) and `refreshRevisedSkeletons` (the Contract Revision, AD-10)
 * through the same four cases: a pre-existing or modified file stays
 * byte-identical, and a frozen path or a symlinked parent is a problem value
 * naming the writer's refusal, with nothing written.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/core/digest";
import { refreshRevisedSkeletons } from "../../src/orchestration/skeleton-revision";
import { materializeContractStubs } from "../../src/orchestration/contract-stub-materialization";
import { materializeTaskSkeletons } from "../../src/orchestration/skeleton-materialization";
import {
  createSkeleton,
  linkFailureResult,
  mkdirFailureTolerated,
  refreshSkeleton,
  renderSkeletonWriteResult,
  withPreparedNameLeft,
  type SkeletonWriteResult,
} from "../../src/orchestration/skeleton-writer";
import { StateManager } from "../../src/state-manager";
import type { TaskGraph } from "../../src/types";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import {
  canonicalSkeletonOf,
  cleanupSkeletonRepos,
  JAVA_CONTRACT,
  JAVA_EXISTING_TEXT,
  JAVA_TYPES_TEXT,
  PATHS,
  seededRecord,
  skeletonRepo,
  TS_CONTRACT,
  TS_LEGACY_TEXT,
  type SkeletonRepo,
} from "../fixtures/skeleton-repo";

/** Fault injection: while `failure` is set, every prepared-name cleanup throws it. */
const cleanup = vi.hoisted(() => ({ failure: null as Error | null }));
vi.mock("../../src/orchestration/no-follow-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/orchestration/no-follow-fs")>();
  return {
    ...actual,
    removeDirectoryFileNoFollow: (...args: Parameters<typeof actual.removeDirectoryFileNoFollow>): void => {
      if (cleanup.failure !== null) throw cleanup.failure;
      actual.removeDirectoryFileNoFollow(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  cleanup.failure = null;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
  cleanupSkeletonRepos();
});

const tempRepo = (): string => {
  const root = canonicalTempDir("loom-skeleton-writer-matrix-");
  roots.push(root);
  return root;
};

const put = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

const read = (root: string, path: string): string | null =>
  existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;

const names = (root: string, directory: string): readonly string[] => readdirSync(join(root, directory)).sort();

/** How many descriptors this test process holds open right now. */
const openDescriptors = (): number => readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length;

const NONE: ReadonlySet<string> = new Set();
const ENGINE = "export const a = 1;\n";
const OTHER = "export const b = 2;\n";
const NEXT = "export const c = 3;\n";

/** One writer entry point: create, or refresh from the engine bytes `ENGINE`. */
type Writer = Readonly<{
  name: string;
  write: (root: string, path: string, frozen: ReadonlySet<string>) => SkeletonWriteResult;
}>;

const create: Writer = { name: "createSkeleton", write: (root, path, frozen) => createSkeleton(root, path, NEXT, frozen) };
const refresh: Writer = { name: "refreshSkeleton", write: (root, path, frozen) => refreshSkeleton(root, path, sha256Hex(ENGINE), NEXT, frozen) };

describe("INV-3 owner: the rules every writer entry point shares", () => {
  for (const writer of [create, refresh]) {
    describe(writer.name, () => {
      it("refuses a frozen path as a value and leaves its bytes", () => {
        const root = tempRepo();
        put(root, "src/contract.ts", ENGINE);
        const result = writer.write(root, "src/contract.ts", new Set(["./src/contract.ts"]));
        expect(result).toEqual({ kind: "refused", reason: "frozen-path" });
        expect(read(root, "src/contract.ts")).toBe(ENGINE);
      });

      it("refuses a path under a symlinked parent as a value and writes nothing through it", () => {
        const root = tempRepo();
        put(root, "outside/a.ts", ENGINE);
        mkdirSync(join(root, "src"));
        symlinkSync(join(root, "outside"), join(root, "src/linked"));
        expect(writer.write(root, "src/linked/a.ts", NONE)).toEqual({ kind: "refused", reason: "symlinked-ancestor" });
        expect(names(root, "outside")).toEqual(["a.ts"]);
        expect(read(root, "outside/a.ts")).toBe(ENGINE);
      });

      for (const path of ["", "/abs/a.ts", "../a.ts", "src/../a.ts", "./a.ts", "src//a.ts", "src/./a.ts", "src\\a.ts", "C:/a.ts", "src/"]) {
        it(`refuses the non-repo-relative path ${JSON.stringify(path)} as a value`, () => {
          const root = tempRepo();
          expect(writer.write(root, path, NONE)).toEqual({ kind: "refused", reason: "not-repo-relative" });
          expect(names(root, ".")).toEqual([]);
        });
      }

      it("never touches a modified file", () => {
        const root = tempRepo();
        put(root, "src/a.ts", OTHER);
        const result = writer.write(root, "src/a.ts", NONE);
        expect(result).toEqual(writer === create ? { kind: "exists" } : { kind: "refused", reason: "modified" });
        expect(read(root, "src/a.ts")).toBe(OTHER);
        expect(names(root, "src")).toEqual(["a.ts"]);
      });

      it("never writes through a symlink leaf", () => {
        const root = tempRepo();
        put(root, "elsewhere/target.ts", ENGINE);
        mkdirSync(join(root, "src"));
        symlinkSync(join(root, "elsewhere/target.ts"), join(root, "src/a.ts"));
        const result = writer.write(root, "src/a.ts", NONE);
        expect(result).toEqual(writer === create ? { kind: "exists" } : { kind: "refused", reason: "not-a-regular-file" });
        expect(read(root, "elsewhere/target.ts")).toBe(ENGINE);
      });

      it("reports a non-directory ancestor as an I/O failure value carrying the error's own message", () => {
        const root = tempRepo();
        put(root, "src", OTHER);
        const result = writer.write(root, "src/a.ts", NONE);
        expect(result).toEqual({ kind: "io-failed", message: `${join(root, "src")} is not a directory` });
        expect(read(root, "src")).toBe(OTHER);
      });

      it("closes every directory it opens, on success and on failure, at any depth", () => {
        const root = tempRepo();
        put(root, "deep/a/b/c/x.ts", ENGINE);
        mkdirSync(join(root, "locked"));
        chmodSync(join(root, "locked"), 0o555);
        const drive = (): void => {
          writer.write(root, "deep/a/b/c/x.ts", NONE);
          writer.write(root, "deep/a/b/c/y.ts", NONE);
          writer.write(root, "top.ts", NONE);
          writer.write(root, "locked/missing/z.ts", NONE);
        };
        drive();
        const before = openDescriptors();
        for (let round = 0; round < 25; round += 1) drive();
        expect(openDescriptors()).toBeLessThanOrEqual(before + 2);
      });
    });
  }
});

describe("INV-3 owner: createSkeleton", () => {
  it("writes complete bytes with mode 0644 and leaves no prepared file", () => {
    const root = tempRepo();
    put(root, "src/keep.ts", OTHER);
    expect(createSkeleton(root, "src/a.ts", NEXT, NONE)).toEqual({ kind: "written", sha256: sha256Hex(NEXT), leftover: null });
    expect(read(root, "src/a.ts")).toBe(NEXT);
    expect(statSync(join(root, "src/a.ts")).mode & 0o777).toBe(0o644);
    expect(names(root, "src")).toEqual(["a.ts", "keep.ts"]);
  });

  it("creates each missing parent directory, readable and traversable", () => {
    const root = tempRepo();
    expect(createSkeleton(root, "src/main/java/a/b/C.java", NEXT, NONE).kind).toBe("written");
    expect(read(root, "src/main/java/a/b/C.java")).toBe(NEXT);
    for (const directory of ["src", "src/main/java/a", "src/main/java/a/b"]) {
      expect(statSync(join(root, directory)).mode & 0o777, directory).toBe(0o755 & ~process.umask());
    }
    expect(names(root, "src/main/java/a/b")).toEqual(["C.java"]);
  });

  it("writes at the repository root", () => {
    const root = tempRepo();
    expect(createSkeleton(root, "a.ts", NEXT, NONE).kind).toBe("written");
    expect(names(root, ".")).toEqual(["a.ts"]);
  });

  it("reports an existing directory as `exists`", () => {
    const root = tempRepo();
    mkdirSync(join(root, "src/a.ts"), { recursive: true });
    expect(createSkeleton(root, "src/a.ts", NEXT, NONE)).toEqual({ kind: "exists" });
  });

  it("refuses a symlinked top-level directory", () => {
    const root = tempRepo();
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(root, "src"));
    expect(createSkeleton(root, "src/deeper/a.ts", NEXT, NONE)).toEqual({ kind: "refused", reason: "symlinked-ancestor" });
    expect(names(root, "outside")).toEqual([]);
  });

  it("reports an unwritable directory as an I/O failure and cleans up", () => {
    const root = tempRepo();
    mkdirSync(join(root, "src"));
    chmodSync(join(root, "src"), 0o555);
    try {
      const result = createSkeleton(root, "src/a.ts", NEXT, NONE);
      expect(result.kind).toBe("io-failed");
      if (result.kind === "io-failed") expect(result.message).toContain("EACCES");
      expect(names(root, "src")).toEqual([]);
    } finally {
      chmodSync(join(root, "src"), 0o755);
    }
  });

  it("reports a parent directory it cannot create (EACCES) as that I/O failure, never as a later open failing", () => {
    const root = tempRepo();
    mkdirSync(join(root, "locked"));
    chmodSync(join(root, "locked"), 0o555);
    try {
      const result = createSkeleton(root, "locked/missing/a.ts", NEXT, NONE);
      expect(result.kind).toBe("io-failed");
      if (result.kind === "io-failed") {
        expect(result.message).toMatch(/^EACCES: permission denied, mkdir /);
        expect(result.message).not.toContain("ENOENT");
      }
      expect(names(root, "locked")).toEqual([]);
    } finally {
      chmodSync(join(root, "locked"), 0o755);
    }
  });

  it("reports a missing repository root as an I/O failure", () => {
    expect(createSkeleton(join(tempRepo(), "gone"), "a.ts", NEXT, NONE).kind).toBe("io-failed");
  });
});

const errno = (code: string, message: string): NodeJS.ErrnoException => Object.assign(new Error(message), { code });

describe("INV-3 owner: a failed publish link", () => {
  it("is `exists` when a file appeared at the target (EEXIST), never an overwrite", () => {
    expect(linkFailureResult(errno("EEXIST", "EEXIST: file already exists, link"))).toEqual({ kind: "exists" });
  });

  it("is an I/O failure with the error's own message for any other errno", () => {
    expect(linkFailureResult(errno("EACCES", "EACCES: permission denied, link"))).toEqual({
      kind: "io-failed",
      message: "EACCES: permission denied, link",
    });
    expect(linkFailureResult(new Error("no code at all"))).toEqual({ kind: "io-failed", message: "no code at all" });
  });

  it("is an I/O failure naming a thrown non-Error value as text", () => {
    expect(linkFailureResult("EEXIST")).toEqual({ kind: "io-failed", message: "EEXIST" });
    expect(linkFailureResult(null)).toEqual({ kind: "io-failed", message: "null" });
  });
});

describe("INV-3 owner: a file that appears at the target after the walk", () => {
  it("makes createSkeleton report `exists`, keep the other writer's bytes and leave no prepared file", () => {
    const root = tempRepo();
    mkdirSync(join(root, "src"));
    // The prepared name is drawn after the no-follow walk found the target
    // absent and before the publishing link: a concurrent writer lands here.
    const race = vi.spyOn(Math, "random").mockImplementationOnce(() => {
      writeFileSync(join(root, "src/a.ts"), OTHER);
      return 0.5;
    });
    try {
      expect(createSkeleton(root, "src/a.ts", NEXT, NONE)).toEqual({ kind: "exists" });
      expect(race).toHaveBeenCalled();
    } finally {
      race.mockRestore();
    }
    expect(read(root, "src/a.ts")).toBe(OTHER);
    expect(names(root, "src")).toEqual(["a.ts"]);
  });
});

describe("INV-3 owner: a failed parent mkdir", () => {
  it("is tolerated only when the directory appeared meanwhile (EEXIST)", () => {
    expect(mkdirFailureTolerated(errno("EEXIST", "EEXIST: file already exists, mkdir"))).toBe(true);
  });

  it("is fatal for any other errno, an errno-less error, or a non-Error value", () => {
    for (const code of ["EACCES", "ENOSPC", "ENOTDIR", "ENOENT"]) {
      expect(mkdirFailureTolerated(errno(code, `${code}: mkdir`)), code).toBe(false);
    }
    expect(mkdirFailureTolerated(new Error("no code"))).toBe(false);
    expect(mkdirFailureTolerated("EEXIST")).toBe(false);
    expect(mkdirFailureTolerated(null)).toBe(false);
  });
});

describe("INV-3 owner: renderSkeletonWriteResult", () => {
  it("renders every result kind as one exact line", () => {
    expect(renderSkeletonWriteResult("src/a.ts", { kind: "written", sha256: sha256Hex(NEXT), leftover: null })).toBe("src/a.ts: written");
    expect(renderSkeletonWriteResult("src/a.ts", { kind: "exists" })).toBe(
      "src/a.ts: a file appeared there during registration; it was left untouched",
    );
    expect(renderSkeletonWriteResult("src/a.ts", { kind: "refused", reason: "frozen-path" })).toBe("src/a.ts: refused (frozen-path)");
    expect(renderSkeletonWriteResult("src/a.ts", { kind: "io-failed", message: "boom" })).toBe("src/a.ts: write failed (boom)");
  });
});

describe("INV-3 owner: refreshSkeleton", () => {
  it("replaces the engine's untouched bytes, with mode 0644 and no temp file left", () => {
    const root = tempRepo();
    put(root, "src/a.ts", ENGINE);
    expect(refreshSkeleton(root, "src/a.ts", sha256Hex(ENGINE), NEXT, NONE)).toEqual({ kind: "written", sha256: sha256Hex(NEXT), leftover: null });
    expect(read(root, "src/a.ts")).toBe(NEXT);
    expect(statSync(join(root, "src/a.ts")).mode & 0o777).toBe(0o644);
    expect(names(root, "src")).toEqual(["a.ts"]);
  });

  it("refuses an absent file and creates nothing", () => {
    const root = tempRepo();
    expect(refreshSkeleton(root, "src/a.ts", sha256Hex(ENGINE), NEXT, NONE)).toEqual({ kind: "refused", reason: "absent" });
    expect(existsSync(join(root, "src"))).toBe(false);
  });

  it("refuses an existing directory as no regular file", () => {
    const root = tempRepo();
    mkdirSync(join(root, "src/a.ts"), { recursive: true });
    expect(refreshSkeleton(root, "src/a.ts", sha256Hex(ENGINE), NEXT, NONE)).toEqual({ kind: "refused", reason: "not-a-regular-file" });
  });

  it("reports an unwritable directory as an I/O failure, keeping the bytes", () => {
    const root = tempRepo();
    put(root, "src/a.ts", ENGINE);
    chmodSync(join(root, "src"), 0o555);
    try {
      expect(refreshSkeleton(root, "src/a.ts", sha256Hex(ENGINE), NEXT, NONE).kind).toBe("io-failed");
      expect(read(root, "src/a.ts")).toBe(ENGINE);
      expect(names(root, "src")).toEqual(["a.ts"]);
    } finally {
      chmodSync(join(root, "src"), 0o755);
    }
  });
});

/**
 * Run `during` at the writer's first draw of randomness: the prepared name,
 * drawn once the walk and the directory opens are done and before the
 * replacement is written, the target's digest is read and the bytes are
 * published.
 */
const duringPreparation = (during: () => void): void => {
  vi.spyOn(Math, "random").mockImplementationOnce(() => {
    during();
    return 0.5;
  });
};

describe("INV-3 owner: a target that changes while refreshSkeleton prepares its replacement", () => {
  it("is refused as `modified` when it is written in place, keeping the other writer's bytes and leaving no prepared file", () => {
    const root = tempRepo();
    put(root, "src/a.ts", ENGINE);
    duringPreparation(() => writeFileSync(join(root, "src/a.ts"), OTHER));
    expect(refreshSkeleton(root, "src/a.ts", sha256Hex(ENGINE), NEXT, NONE)).toEqual({ kind: "refused", reason: "modified" });
    expect(read(root, "src/a.ts")).toBe(OTHER);
    expect(names(root, "src")).toEqual(["a.ts"]);
  });

  it("is refused as `modified` when its name is replaced by a rename, keeping the replacement", () => {
    const root = tempRepo();
    put(root, "src/a.ts", ENGINE);
    put(root, "elsewhere/b.ts", OTHER);
    duringPreparation(() => renameSync(join(root, "elsewhere/b.ts"), join(root, "src/a.ts")));
    expect(refreshSkeleton(root, "src/a.ts", sha256Hex(ENGINE), NEXT, NONE)).toEqual({ kind: "refused", reason: "modified" });
    expect(read(root, "src/a.ts")).toBe(OTHER);
    expect(names(root, "src")).toEqual(["a.ts"]);
  });

  it("still replaces it when the change leaves the engine's bytes", () => {
    const root = tempRepo();
    put(root, "src/a.ts", ENGINE);
    duringPreparation(() => writeFileSync(join(root, "src/a.ts"), ENGINE));
    expect(refreshSkeleton(root, "src/a.ts", sha256Hex(ENGINE), NEXT, NONE)).toEqual({ kind: "written", sha256: sha256Hex(NEXT), leftover: null });
    expect(read(root, "src/a.ts")).toBe(NEXT);
    expect(names(root, "src")).toEqual(["a.ts"]);
  });
});

describe("INV-3 owner: a prepared name that cannot be removed", () => {
  const failure = errno("EBUSY", "EBUSY: resource busy or locked, unlink");

  it("leaves a published skeleton `written`, naming the prepared name left behind", () => {
    const root = tempRepo();
    mkdirSync(join(root, "src"));
    cleanup.failure = failure;
    const result = createSkeleton(root, "src/a.ts", NEXT, NONE);
    cleanup.failure = null;
    const left = names(root, "src").filter((name) => name !== "a.ts");
    expect(left).toHaveLength(1);
    expect(result).toEqual({
      kind: "written",
      sha256: sha256Hex(NEXT),
      leftover: { name: left[0], message: "EBUSY: resource busy or locked, unlink" },
    });
    expect(read(root, "src/a.ts")).toBe(NEXT);
  });

  it("is an I/O failure naming both when nothing was published", () => {
    const root = tempRepo();
    mkdirSync(join(root, "src"));
    cleanup.failure = failure;
    duringPreparation(() => writeFileSync(join(root, "src/a.ts"), OTHER));
    const result = createSkeleton(root, "src/a.ts", NEXT, NONE);
    cleanup.failure = null;
    expect(result.kind).toBe("io-failed");
    if (result.kind === "io-failed") {
      expect(result.message).toMatch(/^a file appeared at the target meanwhile, and the prepared name \.a\.ts\.loom-skeleton-\S+ was left behind \(EBUSY: resource busy or locked, unlink\)$/);
    }
    expect(read(root, "src/a.ts")).toBe(OTHER);
  });

  it("withPreparedNameLeft keeps a write written and names both for every other result", () => {
    const written: SkeletonWriteResult = { kind: "written", sha256: sha256Hex(NEXT), leftover: null };
    expect(withPreparedNameLeft(written, ".p", failure)).toEqual({ ...written, leftover: { name: ".p", message: failure.message } });
    expect(withPreparedNameLeft({ kind: "exists" }, ".p", "gone")).toEqual({
      kind: "io-failed",
      message: "a file appeared at the target meanwhile, and the prepared name .p was left behind (gone)",
    });
    expect(withPreparedNameLeft({ kind: "refused", reason: "modified" }, ".p", failure)).toEqual({
      kind: "io-failed",
      message: `refused (modified), and the prepared name .p was left behind (${failure.message})`,
    });
    expect(withPreparedNameLeft({ kind: "io-failed", message: "ENOSPC" }, ".p", failure)).toEqual({
      kind: "io-failed",
      message: `ENOSPC, and the prepared name .p was left behind (${failure.message})`,
    });
  });

  it("renders a written result with its leftover", () => {
    expect(renderSkeletonWriteResult("src/a.ts", {
      kind: "written",
      sha256: sha256Hex(NEXT),
      leftover: { name: ".p", message: "EBUSY" },
    })).toBe("src/a.ts: written; its prepared name .p was left behind (EBUSY)");
  });
});

// ---------------------------------------------------------------------------
// Sibling: spawn materialization
// ---------------------------------------------------------------------------

const loaded = (repo: SkeletonRepo): TaskGraph => {
  const manager = StateManager.fromPath(repo.statePath);
  if (manager === null) throw new Error("fixture State File missing");
  return manager.load();
};

describe("INV-3 sibling: materializeTaskSkeletons writes only through the writer", () => {
  it("leaves a pre-existing bound file byte-identical", () => {
    const repo = skeletonRepo();
    const result = materializeTaskSkeletons(repo.root, loaded(repo), ["T4", "T5"]);
    expect(result.ok).toBe(true);
    expect(repo.read(PATHS.tsLegacy)).toBe(TS_LEGACY_TEXT);
    expect(repo.read(PATHS.javaExisting)).toBe(JAVA_EXISTING_TEXT);
    if (result.ok) expect(result.value.records.map(({ path }) => path)).not.toContain(PATHS.tsLegacy);
  });

  it("refuses, as a value, to write a bound path an Acceptance Freeze covers", () => {
    const repo = skeletonRepo();
    const graph = loaded(repo);
    const frozenPricing: TaskGraph = {
      ...graph,
      acceptance_contracts: (graph.acceptance_contracts ?? []).map((contract) => contract.id === "CT-2"
        ? { ...contract, acceptance: [...contract.acceptance, { path: PATHS.javaPricing, anchors: ["AS-102"] }] }
        : contract),
    };
    const result = materializeTaskSkeletons(repo.root, frozenPricing, ["T5"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.join("\n")).toContain(`${PATHS.javaPricing}: refused (frozen-path)`);
    expect(repo.read(PATHS.javaPricing)).toBeNull();
  });

  it("refuses, as a value, to write under a symlinked parent", () => {
    const repo = skeletonRepo();
    const directory = dirname(PATHS.javaPricing);
    const outside = join(repo.root, "outside");
    rmSync(join(repo.root, PATHS.javaExisting));
    renameSync(join(repo.root, directory), outside);
    symlinkSync(outside, join(repo.root, directory));
    const result = materializeTaskSkeletons(repo.root, loaded(repo), ["T5"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.join("\n")).toContain(`${PATHS.javaPricing}: refused (symlinked-ancestor)`);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("never rewrites a modified skeleton", () => {
    const repo = skeletonRepo();
    const first = materializeTaskSkeletons(repo.root, loaded(repo), ["T4"]);
    expect(first.ok).toBe(true);
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));
    repo.write(PATHS.tsPricing, OTHER);
    const again = materializeTaskSkeletons(repo.root, loaded(repo), ["T4"]);
    expect(again.ok).toBe(true);
    expect(repo.read(PATHS.tsPricing)).toBe(OTHER);
    if (again.ok) {
      expect(again.value.records.map(({ path }) => path)).not.toContain(PATHS.tsPricing);
      expect(again.value.outcomes.get("T4")?.find(({ path }) => path === PATHS.tsPricing)?.outcome).toEqual({ kind: "exists-not-skeletonized" });
    }
  });
});

// ---------------------------------------------------------------------------
// Sibling: contract stubs at the contract Task's stop (AD-9)
// ---------------------------------------------------------------------------

const managerOf = (repo: SkeletonRepo): StateManager => {
  const manager = StateManager.fromPath(repo.statePath);
  if (manager === null) throw new Error("fixture State File missing");
  return manager;
};

/** The contract Wave with every contract Task's sources written. */
const contractWave = (): SkeletonRepo => {
  const repo = skeletonRepo({ stage: "contract-wave" });
  repo.writeContractSources();
  return repo;
};

describe("INV-3 sibling: materializeContractStubs writes only through the writer", () => {
  it("leaves a pre-existing file at a stub path byte-identical and records nothing for it", async () => {
    const repo = contractWave();
    repo.write(PATHS.tsQuotes, OTHER);
    const result = await materializeContractStubs(repo.root, managerOf(repo), "T1");
    expect(result.ok && result.value.problems).toEqual([]);
    expect(repo.read(PATHS.tsQuotes)).toBe(OTHER);
    expect(result.ok && result.value.written.map(({ path }) => path)).toEqual([PATHS.tsPricing, PATHS.tsLegacy]);
  });

  it("refuses, as a value, to write a stub an Acceptance Freeze covers", async () => {
    const repo = contractWave();
    // The State File refuses a frozen path two Tasks write, so this graph lives only in memory.
    const graph = loaded(repo);
    let current: TaskGraph = {
      ...graph,
      acceptance_contracts: (graph.acceptance_contracts ?? []).map((contract) => contract.id === "CT-2"
        ? { ...contract, acceptance: [...contract.acceptance, { path: PATHS.javaPricing, anchors: ["AS-102"] }] }
        : contract),
    };
    const store = {
      load: () => current,
      updateAndReturn: async <T,>(fn: (state: TaskGraph) => Readonly<{ state: TaskGraph; value: T }>): Promise<T> => {
        const produced = fn(current);
        current = produced.state;
        return produced.value;
      },
    };
    const result = await materializeContractStubs(repo.root, store, "T2");
    expect(result.ok && result.value.problems).toContainEqual({ kind: "write-failed", path: PATHS.javaPricing, detail: "refused (frozen-path)" });
    expect(repo.read(PATHS.javaPricing)).toBeNull();
    expect(repo.read(PATHS.javaExisting)).toBe(canonicalSkeletonOf(PATHS.javaExisting));
  });

  it("refuses, as a value, to write under a symlinked parent", async () => {
    const repo = contractWave();
    const outside = join(repo.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(repo.root, dirname(PATHS.javaPricing)));
    const result = await materializeContractStubs(repo.root, managerOf(repo), "T2");
    expect(result.ok && result.value.problems).toEqual([
      { kind: "write-failed", path: PATHS.javaPricing, detail: "refused (symlinked-ancestor)" },
      { kind: "write-failed", path: PATHS.javaExisting, detail: "refused (symlinked-ancestor)" },
    ]);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("never rewrites a modified stub, even when its canonical bytes changed", async () => {
    const repo = contractWave();
    await materializeContractStubs(repo.root, managerOf(repo), "T1");
    repo.write(PATHS.tsPricing, OTHER);
    repo.write(TS_CONTRACT.acceptance, (repo.read(TS_CONTRACT.acceptance) ?? "").replace(
      '"../src/order/order-contract"',
      '"../src/order/order-contract.js"',
    ));
    const result = await materializeContractStubs(repo.root, managerOf(repo), "T1");
    expect(repo.read(PATHS.tsPricing)).toBe(OTHER);
    expect(result.ok && result.value.written.map(({ path }) => path)).not.toContain(PATHS.tsPricing);
  });
});

// ---------------------------------------------------------------------------
// Sibling: the Contract Revision refresh (AD-10)
// ---------------------------------------------------------------------------

const JAVA_TYPES_WITH_CURRENCY = JAVA_TYPES_TEXT.replace(
  "Price apply(Order order, int quantity);",
  "Price apply(Order order, int quantity, String currency);",
);

/** Wave 2 with an engine-written `Pricing.java` recorded and on disk, and CT-2's types revised. */
const revisedJavaRepo = (): SkeletonRepo => {
  const repo = skeletonRepo({ skeletons: [seededRecord(PATHS.javaPricing, canonicalSkeletonOf(PATHS.javaPricing))] });
  repo.write(PATHS.javaPricing, canonicalSkeletonOf(PATHS.javaPricing));
  repo.write(JAVA_CONTRACT.types, JAVA_TYPES_WITH_CURRENCY);
  return repo;
};

describe("INV-3 sibling: refreshRevisedSkeletons writes only through the writer", () => {
  it("leaves a modified skeleton byte-identical, settling it stale", () => {
    const repo = revisedJavaRepo();
    repo.write(PATHS.javaPricing, OTHER);
    const result = refreshRevisedSkeletons(repo.root, loaded(repo), "CT-2");
    expect(result.ok && [...result.value.settlements]).toEqual([[PATHS.javaPricing, { kind: "stale" }]]);
    expect(repo.read(PATHS.javaPricing)).toBe(OTHER);
  });

  it("refuses, as a value, to refresh a skeleton an Acceptance Freeze covers", () => {
    const repo = revisedJavaRepo();
    const graph = loaded(repo);
    const frozenPricing: TaskGraph = {
      ...graph,
      acceptance_contracts: (graph.acceptance_contracts ?? []).map((contract) => contract.id === "CT-2"
        ? { ...contract, acceptance: [...contract.acceptance, { path: PATHS.javaPricing, anchors: ["AS-102"] }] }
        : contract),
    };
    const result = refreshRevisedSkeletons(repo.root, frozenPricing, "CT-2");
    expect(result.ok && result.value.bindingProblems).toEqual([
      { kind: "write-failed", path: PATHS.javaPricing, detail: "refused (frozen-path)" },
    ]);
    expect(result.ok && result.value.settlements.size).toBe(0);
    expect(repo.read(PATHS.javaPricing)).toBe(canonicalSkeletonOf(PATHS.javaPricing));
  });

  it("refuses, as a value, to refresh under a symlinked parent", () => {
    const repo = revisedJavaRepo();
    const directory = dirname(PATHS.javaPricing);
    const outside = join(repo.root, "outside");
    renameSync(join(repo.root, directory), outside);
    symlinkSync(outside, join(repo.root, directory));
    const result = refreshRevisedSkeletons(repo.root, loaded(repo), "CT-2");
    expect(result.ok && result.value.settlements.size).toBe(0);
    expect(result.ok && result.value.bindingProblems.map(({ kind }) => kind)).toEqual(["write-failed"]);
    expect(readFileSync(join(outside, "Pricing.java"), "utf8")).toBe(canonicalSkeletonOf(PATHS.javaPricing));
  });
});
