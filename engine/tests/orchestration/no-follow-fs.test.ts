/**
 * Symlink-attack coverage for the READ and REMOVE primitives.
 *
 * The write/publish side of `no-follow-fs` has real symlink tests; the read and
 * remove side had none, even though it is the same anchor-then-`O_NOFOLLOW`
 * dance re-implemented per primitive and it backs `readAuthority`,
 * `readContext`, `readCheckpoint`, and `readReceipt`. A planted symlink at a
 * run-artifact path is precisely the attack these functions exist to refuse, so
 * dropping the flag from any one of them must fail a test rather than silently
 * start following links out of the run directory.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRunDirectory } from "../../src/orchestration/run-directory-handle";
import {
  anchoredChildPath,
  closeAnchoredDirectory,
  ensureDirectoryNoFollow,
  ensureRelativeDirectoryNoFollow,
  ensureResolvedBaseDirectory,
  listDirectoryNamesNoFollow,
  openDirectoryNoFollow,
  readRunBytesNoFollow,
  readRunFileNoFollow,
  recoverStaleDirectoryLock,
  removeRunFileNoFollow,
  withAnchoredDirectoryLock,
  writeRunFileNoFollow,
} from "../../src/orchestration/no-follow-fs";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * A workspace rooted at the REAL temp path. Production resolves its configured
 * base once for the same reason (`ensureResolvedBaseDirectory`): on macOS
 * `tmpdir()` sits behind the system `/var` → `/private/var` symlink, and the
 * strict no-symlink rule these tests exercise applies BELOW the base, not to
 * the operator's own path to it. On Linux this is an identity.
 */
function workspace(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-no-follow-")));
  cleanup.push(root);
  mkdirSync(join(root, "run"), { recursive: true });
  return root;
}

/** The file an attacker wants read or deleted, outside the run directory. */
function secretOutsideTheRun(root: string): string {
  const secret = join(root, "outside-the-run.txt");
  writeFileSync(secret, "authority for another run", "utf-8");
  return secret;
}

describe("directory creation refuses symlinked ancestors", () => {
  it("fails before mkdir when the retained anchor cannot authorize descriptor-relative mutation", () => {
    const root = workspace();
    const run = join(root, "run");
    const realPathAnchor = { anchor: "real-path" as const, fd: -1, path: run };

    expect(() => ensureRelativeDirectoryNoFollow(realPathAnchor, run, join(run, "uncreated")))
      .toThrow(/descriptor-relative directory creation.*refusing unsafe pathname mutation/i);
    expect(() => readFileSync(join(run, "uncreated"))).toThrow();
  });

  it("does not create through a symlinked binding directory", () => {
    const root = workspace();
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "run", "bindings"));

    expect(() => ensureDirectoryNoFollow(join(root, "run", "bindings", "session")))
      .toThrow(/ELOOP|too many symbolic|ENOTDIR/i);
    expect(() => readFileSync(join(outside, "session"))).toThrow();
  });
});

describe("reads refuse to follow a planted symlink", () => {
  it("readRunFileNoFollow refuses a leaf symlink pointing outside the run", () => {
    const root = workspace();
    const secret = secretOutsideTheRun(root);
    symlinkSync(secret, join(root, "run", "authority.json"));

    expect(() => readRunFileNoFollow(join(root, "run", "authority.json"))).toThrow(/ELOOP|too many symbolic/i);
  });

  it("readRunBytesNoFollow refuses the same leaf symlink", () => {
    const root = workspace();
    const secret = secretOutsideTheRun(root);
    symlinkSync(secret, join(root, "run", "transcript.raw"));

    expect(() => readRunBytesNoFollow(join(root, "run", "transcript.raw"))).toThrow(/ELOOP|too many symbolic/i);
  });

  it("readRunFileNoFollow refuses a symlinked ANCESTOR, not only a symlinked leaf", () => {
    const root = workspace();
    const real = join(root, "elsewhere");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "receipt.json"), "{}", "utf-8");
    symlinkSync(real, join(root, "run", "receipts"));

    expect(() => readRunFileNoFollow(join(root, "run", "receipts", "receipt.json")))
      .toThrow(/ELOOP|too many symbolic|ENOTDIR/i);
  });

  it("still reads a real regular file at the same path", () => {
    const root = workspace();
    writeRunFileNoFollow(join(root, "run", "authority.json"), "{\"runId\":\"run.a\"}");

    expect(readRunFileNoFollow(join(root, "run", "authority.json"))).toBe("{\"runId\":\"run.a\"}");
    expect([...readRunBytesNoFollow(join(root, "run", "authority.json"))])
      .toEqual([...Buffer.from("{\"runId\":\"run.a\"}", "utf-8")]);
  });

  it("reports a missing file as ENOENT, which callers use to mean 'never written'", () => {
    const root = workspace();
    try {
      readRunFileNoFollow(join(root, "run", "absent.json"));
      throw new Error("expected the read to throw");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});

describe("anchored lock ownership", () => {
  it("recovers a lock whose recorded owner is provably dead", async () => {
    const root = workspace();
    const directory = join(root, "run");
    writeFileSync(join(directory, "stale.lock"), "999999999");
    let entered = false;

    await withAnchoredDirectoryLock(directory, "stale.lock", () => { entered = true; });

    expect(entered).toBe(true);
    expect(() => readFileSync(join(directory, "stale.lock"))).toThrow();
  });

  it("refuses stale recovery when the tombstone owner changes after rename", () => {
    const root = workspace();
    const directory = join(root, "run");
    writeFileSync(join(directory, "changed.lock"), "999999999");
    const anchored = openDirectoryNoFollow(directory);
    try {
      const recovered = recoverStaleDirectoryLock(anchored, "changed.lock", (tombName) => {
        expect(listDirectoryNamesNoFollow(anchored)).toContain(tombName);
        writeFileSync(anchoredChildPath(anchored, tombName), `${process.pid}:new-live-owner`);
      });

      expect(recovered).toBe(false);
      expect(readFileSync(join(directory, "changed.lock"), "utf-8")).toBe(`${process.pid}:new-live-owner`);
    } finally {
      closeAnchoredDirectory(anchored);
    }
  });

  it("preserves a lock with a malformed owner instead of treating it as proven dead", () => {
    const root = workspace();
    const directory = join(root, "run");
    const lockPath = join(directory, "partial.lock");
    writeFileSync(lockPath, "not-a-pid");
    const anchored = openDirectoryNoFollow(directory);
    try {
      expect(() => recoverStaleDirectoryLock(anchored, "partial.lock"))
        .toThrow(/malformed owner token/i);
      expect(readFileSync(lockPath, "utf-8")).toBe("not-a-pid");
    } finally {
      closeAnchoredDirectory(anchored);
    }
  });

  it("surfaces a corrupted lock instead of reporting false from the read", () => {
    const root = workspace();
    const directory = join(root, "run");
    // A directory occupying the lock name is a corrupted/attacked lock: the
    // owner read cannot complete (EISDIR). Recovery must name the cause rather
    // than collapsing it into "not recoverable" contention.
    mkdirSync(join(directory, "corrupted.lock"));
    const anchored = openDirectoryNoFollow(directory);
    try {
      expect(() => recoverStaleDirectoryLock(anchored, "corrupted.lock"))
        .toThrow(/cannot inspect lock corrupted\.lock/);
    } finally {
      closeAnchoredDirectory(anchored);
    }
  });

  it("surfaces recovery-guard cleanup corruption after otherwise successful recovery", () => {
    const root = workspace();
    const directory = join(root, "run");
    const lockName = "cleanup.lock";
    const recoveryPath = join(directory, `${lockName}.recovery`);
    writeFileSync(join(directory, lockName), "999999999");
    const anchored = openDirectoryNoFollow(directory);
    try {
      expect(() => recoverStaleDirectoryLock(anchored, lockName, () => {
        rmSync(recoveryPath, { force: true });
        symlinkSync(`${lockName}.recovery`, recoveryPath);
      })).toThrow(/cannot inspect recovery guard cleanup\.lock\.recovery/i);
    } finally {
      closeAnchoredDirectory(anchored);
    }
  });

  it("surfaces a release failure instead of reporting the protected operation as successful", async () => {
    const root = workspace();
    const directory = join(root, "run");
    const lockPath = join(directory, "release.lock");

    await expect(withAnchoredDirectoryLock(directory, "release.lock", () => {
      rmSync(lockPath);
      mkdirSync(lockPath);
    })).rejects.toThrow(/cannot release anchored lock release\.lock/i);
  });

  it("preserves both the operation and release failures", async () => {
    const root = workspace();
    const directory = join(root, "run");
    const lockPath = join(directory, "aggregate.lock");

    try {
      await withAnchoredDirectoryLock(directory, "aggregate.lock", () => {
        rmSync(lockPath);
        mkdirSync(lockPath);
        throw new Error("operation exploded");
      });
      throw new Error("expected the anchored operation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(String(aggregate.errors[0])).toContain("operation exploded");
      expect(String(aggregate.errors[1])).toContain("cannot release anchored lock aggregate.lock");
    }
  });

  it("never overlaps critical sections while the recorded owner is alive", async () => {
    const root = workspace();
    const directory = join(root, "run");
    let active = 0;
    let maxActive = 0;
    const critical = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      active -= 1;
    };

    await Promise.all([
      withAnchoredDirectoryLock(directory, "live.lock", critical),
      withAnchoredDirectoryLock(directory, "live.lock", critical),
      withAnchoredDirectoryLock(directory, "live.lock", critical),
    ]);

    expect(maxActive).toBe(1);
  });
});

describe("captured-attempt inspection fails closed", () => {
  it("reports an unreadable transcript slot instead of treating it as empty", () => {
    const root = workspace();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.capture-corrupt");
    mkdirSync(runDir, { recursive: true });
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const outside = join(root, "outside-transcript-slot");
    mkdirSync(outside);
    symlinkSync(outside, join(runDir, "transcripts", "slot-corrupt"));

    const captured = opened.value.readCapturedAttempts();

    expect(captured.ok).toBe(false);
    if (!captured.ok) expect(captured.error.message).toMatch(/slot-corrupt.*ELOOP|slot-corrupt.*ENOTDIR/i);
  });
});

describe("removal refuses to follow a planted symlink", () => {
  it.skipIf(process.platform === "darwin")("removeRunFileNoFollow unlinks the LINK, never the file it points at", () => {
    const root = workspace();
    const secret = secretOutsideTheRun(root);
    const link = join(root, "run", "checkpoint.json.staged");
    symlinkSync(secret, link);

    // `unlinkat` on a symlink removes the link itself — the point is that the
    // target survives, so a discarded staged file can never delete a real one.
    removeRunFileNoFollow(link);

    expect(readFileSync(secret, "utf-8")).toBe("authority for another run");
  });

  it("removeRunFileNoFollow refuses a path whose ANCESTOR is a symlink", () => {
    const root = workspace();
    const real = join(root, "elsewhere");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "staged.json"), "{}", "utf-8");
    symlinkSync(real, join(root, "run", "artifacts"));

    expect(() => removeRunFileNoFollow(join(root, "run", "artifacts", "staged.json")))
      .toThrow(/ELOOP|too many symbolic|ENOTDIR/i);
    // The file behind the symlinked ancestor is untouched.
    expect(readFileSync(join(real, "staged.json"), "utf-8")).toBe("{}");
  });

  it.skipIf(process.platform === "darwin")("still removes a real regular file at the same path", () => {
    const root = workspace();
    const path = join(root, "run", "staged.json");
    writeRunFileNoFollow(path, "{}");

    removeRunFileNoFollow(path);

    expect(() => readRunFileNoFollow(path)).toThrow();
  });

  it.runIf(process.platform === "darwin")("fails closed when descriptor-relative unlink is unavailable", () => {
    const root = workspace();
    const path = join(root, "run", "staged.json");
    writeRunFileNoFollow(path, "{}");

    expect(() => removeRunFileNoFollow(path)).toThrow(/descriptor-relative.*unavailable.*refusing unsafe unlink/i);
    expect(readRunFileNoFollow(path)).toBe("{}");
  });
});

/**
 * The two platforms reach the same guarantee by different means, and which
 * mechanism is in play is exactly the thing a future edit could silently
 * regress — a darwin-shaped change that quietly disabled Linux's descriptor
 * anchoring would still pass every symlink test above, because the refusals
 * would keep coming from the kernel either way.
 */
describe("platform anchoring", () => {
  it("anchors to a descriptor on Linux and to a proven real path on macOS", () => {
    const root = workspace();
    const anchored = openDirectoryNoFollow(join(root, "run"));
    try {
      if (process.platform === "darwin") {
        expect(anchored.anchor).toBe("real-path");
        expect(anchoredChildPath(anchored, "x")).toBe(join(root, "run", "x"));
      } else {
        expect(anchored.anchor).toBe("descriptor");
        expect(anchoredChildPath(anchored, "x")).toMatch(/^\/proc\/self\/fd\/\d+\/x$/);
      }
    } finally {
      closeAnchoredDirectory(anchored);
    }
  });
});

/**
 * The BASE is the one place a symlink is layout rather than attack: macOS
 * reaches every real run directory through `/tmp` → `/private/tmp`. Resolving
 * it once is what lets everything below it stay strict.
 */
describe("run base resolution", () => {
  it("leaves a symlink-free base exactly as given", () => {
    const root = workspace();
    const base = join(root, "claude-subagents");

    expect(ensureResolvedBaseDirectory(base)).toBe(base);
  });

  it("resolves a symlinked base to its real path rather than refusing it", () => {
    const root = workspace();
    const real = join(root, "real-base");
    mkdirSync(real);
    symlinkSync(real, join(root, "linked-base"));

    expect(ensureResolvedBaseDirectory(join(root, "linked-base"))).toBe(real);
  });

  it("still refuses a symlink planted BELOW the resolved base", () => {
    const root = workspace();
    const base = ensureResolvedBaseDirectory(join(root, "base"));
    const secret = secretOutsideTheRun(root);
    symlinkSync(secret, join(base, "authority.json"));

    expect(() => readRunFileNoFollow(join(base, "authority.json"))).toThrow(/ELOOP|too many symbolic/i);
  });
});
