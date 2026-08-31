/**
 * Lock liveness at the anchored boundary.
 *
 * The State File lock and its recovery guard are mutual exclusion, not leases:
 * nothing expires them. Before the guard could be reclaimed, one SIGKILLed
 * recovery claimant poisoned the State File for every later process, and a lock
 * observed in the instant between creation and its owner token was treated as
 * corrupt rather than as a claim in flight. These are the two shapes that made
 * that permanent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAnchoredDirectory,
  listDirectoryNamesNoFollow,
  openDirectoryNoFollow,
  recoverStaleDirectoryLock,
  writeDirectoryFileExclusiveNoFollow,
  withAnchoredDirectoryHandleLock,
} from "../../src/orchestration/no-follow-fs";

/** A pid the kernel reports gone, so liveness is decided and not assumed. */
function deadPid(): number {
  for (let candidate = 4_194_303; candidate > 1_000_000; candidate -= 1) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("no provably dead pid available on this host");
}

describe("anchored lock liveness", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-lock-")));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stands down from a lock whose owner token has not landed yet", async () => {
    // An empty lock is a claim in flight, never a stale lock: recovery stands
    // down instead of deleting it, and the lock survives to be released.
    const anchored = openDirectoryNoFollow(dir);
    try {
      writeDirectoryFileExclusiveNoFollow(anchored, ".task_graph", "");
      expect(recoverStaleDirectoryLock(anchored, ".task_graph")).toBe(false);
      expect(listDirectoryNamesNoFollow(anchored)).toContain(".task_graph");
    } finally {
      closeAnchoredDirectory(anchored);
    }
  });

  it("reclaims an abandoned recovery guard before entering the protected critical section", async () => {
    const anchored = openDirectoryNoFollow(dir);
    try {
      writeDirectoryFileExclusiveNoFollow(anchored, ".task_graph.recovery", `${deadPid()}:1:abandon`);
      const entered = await withAnchoredDirectoryHandleLock(anchored, ".task_graph", () => {
        expect(listDirectoryNamesNoFollow(anchored)).toEqual([".task_graph"]);
        return "entered";
      });
      expect(entered).toBe("entered");
      expect(listDirectoryNamesNoFollow(anchored)).toEqual([]);
    } finally {
      closeAnchoredDirectory(anchored);
    }
  });

  it("does not delete a replacement live recovery guard after observing an abandoned one", async () => {
    const anchored = openDirectoryNoFollow(dir);
    const recoveryPath = join(dir, ".task_graph.recovery");
    const abandonedPid = deadPid();
    const replacementToken = `${process.pid}:2:replacementlive`;
    const originalKill = process.kill.bind(process);
    let replacementSurvived = false;
    let swapped = false;
    let cleanupQueued = false;
    let acknowledgeReplacement!: () => void;
    const replacementObserved = new Promise<void>((resolve) => { acknowledgeReplacement = resolve; });
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === abandonedPid && !swapped) {
        swapped = true;
        rmSync(recoveryPath, { force: true });
        writeFileSync(recoveryPath, replacementToken);
        const gone = new Error("gone") as NodeJS.ErrnoException;
        gone.code = "ESRCH";
        throw gone;
      }
      if (pid === process.pid && swapped && !cleanupQueued) {
        cleanupQueued = true;
        // The live-owner probe is the exact synchronization point after which
        // the replacement tomb is restored. The microtask runs before the
        // lock's retry timer, observes that restoration, then releases it.
        queueMicrotask(() => {
          try {
            replacementSurvived = readFileSync(recoveryPath, "utf8") === replacementToken;
          } catch {
            replacementSurvived = false;
          } finally {
            rmSync(recoveryPath, { force: true });
            acknowledgeReplacement();
          }
        });
      }
      return originalKill(pid, signal ?? 0);
    }) as typeof process.kill);
    try {
      writeDirectoryFileExclusiveNoFollow(anchored, ".task_graph.recovery", `${abandonedPid}:1:abandon`);
      const acquired = withAnchoredDirectoryHandleLock(anchored, ".task_graph", () => "entered");
      await replacementObserved;
      expect(await acquired).toBe("entered");
      expect(replacementSurvived).toBe(true);
    } finally {
      kill.mockRestore();
      closeAnchoredDirectory(anchored);
    }
  });

  it("never reclaims a malformed recovery guard based only on age", async () => {
    const anchored = openDirectoryNoFollow(dir);
    const recoveryPath = join(dir, ".task_graph.recovery");
    try {
      writeDirectoryFileExclusiveNoFollow(anchored, ".task_graph.recovery", "malformed-owner");
      utimesSync(recoveryPath, new Date(0), new Date(0));

      await expect(withAnchoredDirectoryHandleLock(anchored, ".task_graph", () => "entered"))
        .rejects.toThrow(/recovery guard has malformed owner token/);
      expect(readFileSync(recoveryPath, "utf8")).toBe("malformed-owner");
    } finally {
      closeAnchoredDirectory(anchored);
    }
  });

  it("surfaces unexpected process-liveness probe errors and removes its own guard", () => {
    const anchored = openDirectoryNoFollow(dir);
    const stalePid = deadPid();
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === stalePid) {
        const failure = new Error("liveness probe unavailable") as NodeJS.ErrnoException;
        failure.code = "EIO";
        throw failure;
      }
      return true;
    }) as typeof process.kill);
    try {
      writeDirectoryFileExclusiveNoFollow(anchored, ".task_graph", `${stalePid}:1:stale`);

      expect(() => recoverStaleDirectoryLock(anchored, ".task_graph"))
        .toThrow(/cannot determine whether lock owner pid.*liveness probe unavailable/i);
      expect(listDirectoryNamesNoFollow(anchored)).toEqual([".task_graph"]);
    } finally {
      kill.mockRestore();
      closeAnchoredDirectory(anchored);
    }
  });

  it("obeys a recovery guard whose claimant is still alive", async () => {
    const anchored = openDirectoryNoFollow(dir);
    try {
      writeDirectoryFileExclusiveNoFollow(anchored, ".task_graph.recovery", `${process.pid}:1:live`);
      await expect(withAnchoredDirectoryHandleLock(anchored, ".task_graph", () => "entered"))
        .rejects.toThrow("Could not acquire anchored lock");
      expect(readFileSync(join(dir, ".task_graph.recovery"), "utf-8")).toContain(String(process.pid));
    } finally {
      closeAnchoredDirectory(anchored);
    }
  });
});
