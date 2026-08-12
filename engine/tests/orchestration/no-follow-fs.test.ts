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

import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRunDirectory } from "../../src/orchestration/run-directory-handle";
import {
  ensureDirectoryNoFollow,
  listDirectoryNamesNoFollow,
  openDirectoryNoFollow,
  procFdChild,
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

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "loom-no-follow-"));
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
    const directoryFd = openDirectoryNoFollow(directory);
    try {
      const recovered = recoverStaleDirectoryLock(directoryFd, "changed.lock", (tombName) => {
        expect(listDirectoryNamesNoFollow(directoryFd)).toContain(tombName);
        writeFileSync(procFdChild(directoryFd, tombName), `${process.pid}:new-live-owner`);
      });

      expect(recovered).toBe(false);
      expect(readFileSync(join(directory, "changed.lock"), "utf-8")).toBe(`${process.pid}:new-live-owner`);
    } finally {
      closeSync(directoryFd);
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
  it("removeRunFileNoFollow unlinks the LINK, never the file it points at", () => {
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

  it("still removes a real regular file at the same path", () => {
    const root = workspace();
    const path = join(root, "run", "staged.json");
    writeRunFileNoFollow(path, "{}");

    removeRunFileNoFollow(path);

    expect(() => readRunFileNoFollow(path)).toThrow();
  });
});
